// merge：把另一个分支合并进当前分支。
//
// 三种情况：
//   1. 快进（fast-forward）：目标分支是当前分支的后代，直接移动指针
//   2. 已经是最新：目标分支已是当前分支的祖先，什么都不做
//   3. 真合并：需要三方归并，可能产生冲突
//
// 冲突时不提交，把冲突内容写进工作区并留标记，与 Git 行为一致。
//
// 三方归并的实际逻辑在 ../merge-trees.js 里，与 cherry-pick / rebase 共用。
// 这里只负责「选择哪三个提交作为 base / ours / theirs」以及提交的生成。

import { readHeadRef, readRef, writeRef, updateHead } from "../refs.js";
import { readCommit, writeCommit, formatIdentity, localTimezoneOffset } from "../commit.js";
import { flattenTree, writeTreeFromEntries } from "../tree.js";
import { findMergeBase, isAncestor, canFastForward } from "../merge-base.js";
import { mergeTreeStates, applyWorktree } from "../merge-trees.js";
import { writeIndex, entryFromStat } from "../index-file.js";
import { writeFile, stat, rm } from "node:fs/promises";
import path from "node:path";

export async function merge(gitDir, rootDir, branchName, {
  author = { name: "tinygit", email: "tinygit@localhost" },
  message = null,
  now = new Date(),
  noCommit = false,
} = {}) {
  const head = await readHeadRef(gitDir);
  if (!head.oid) throw new Error("merge: 当前分支还没有任何提交");

  const targetRef = "refs/heads/" + branchName;
  const targetOid = await readRef(gitDir, targetRef);
  if (!targetOid) throw new Error("merge: 分支不存在: " + branchName);

  const currentBranch = head.ref.replace(/^refs\/heads\//, "");

  // 情况 1：目标已包含在当前分支中
  if (await isAncestor(gitDir, targetOid, head.oid)) {
    return { result: "up-to-date", branch: branchName };
  }

  // 情况 2：快进（当前 HEAD 是目标分支的祖先）
  if (await canFastForward(gitDir, head.oid, targetOid)) {
    await updateHead(gitDir, targetOid);
    return { result: "fast-forward", branch: branchName, oid: targetOid };
  }

  // 情况 3：真合并
  const baseOid = await findMergeBase(gitDir, head.oid, targetOid);
  if (!baseOid) throw new Error("merge: 两个分支没有共同历史，无法合并");

  const baseFiles = await filesOfCommit(gitDir, baseOid);
  const oursFiles = await filesOfCommit(gitDir, head.oid);
  const theirsFiles = await filesOfCommit(gitDir, targetOid);

  const { mergedFiles, conflicts, worktree } = await mergeTreeStates(gitDir, {
    baseFiles,
    oursFiles,
    theirsFiles,
    oursLabel: currentBranch,
    theirsLabel: branchName,
  });
  await applyWorktree(rootDir, worktree);

  if (conflicts.length > 0) {
    // 留下「正在合并」的状态，与真 git 一致：
    //   MERGE_HEAD 记录被合并分支的提交
    //   MERGE_MSG  记录建议的提交信息
    // 用户解决冲突后执行 commit，commit 会据此写入第二个 parent。
    // 少了这一步，解决冲突后的提交只有一个 parent，被合并分支的历史会凭空消失。
    await writeFile(path.join(gitDir, "MERGE_HEAD"), targetOid + "\n");
    await writeFile(
      path.join(gitDir, "MERGE_MSG"),
      "Merge branch '" + branchName + "' into " + currentBranch + "\n"
    );
    return { result: "conflict", branch: branchName, conflicts, baseOid };
  }

  // 成功合并没有冲突，确保不残留合并状态
  await rm(path.join(gitDir, "MERGE_HEAD"), { force: true });
  await rm(path.join(gitDir, "MERGE_MSG"), { force: true });

  // 重建索引与 tree
  const entries = [];
  for (const [p, entry] of mergedFiles) {
    const abs = path.join(rootDir, p);
    const st = await stat(abs);
    entries.push(entryFromStat(p, entry.oid, entry.mode, st));
  }
  await writeIndex(gitDir, { version: 2, entries });

  if (noCommit) {
    return { result: "merged-not-committed", branch: branchName, baseOid };
  }

  const treeOid = await writeTreeFromEntries(
    gitDir,
    entries.map((e) => ({ path: e.path, oid: e.oid, mode: e.mode }))
  );

  const seconds = Math.floor(now.getTime() / 1000);
  const identity = formatIdentity(author.name, author.email, seconds, localTimezoneOffset(now));
  const commitMessage = message
    ? message
    : "Merge branch '" + branchName + "' into " + currentBranch + "\n";

  const newOid = await writeCommit(gitDir, {
    tree: treeOid,
    parents: [head.oid, targetOid],
    author: identity,
    committer: identity,
    message: commitMessage.trimEnd() + "\n",
  });

  await writeRef(gitDir, head.ref, newOid);
  return { result: "merged", branch: branchName, oid: newOid, baseOid, treeOid };
}

async function filesOfCommit(gitDir, commitOid) {
  const commit = await readCommit(gitDir, commitOid);
  return flattenTree(gitDir, commit.tree);
}
