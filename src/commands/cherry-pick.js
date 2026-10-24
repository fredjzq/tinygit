// cherry-pick：把某个提交的改动「重放」到当前分支上。
//
// 核心认知：cherry-pick 不是「复制提交」，而是「把某个 diff 应用到别处」。
//
// 三方归并的三个输入是：
//
//   base   = 被摘取提交的**父提交**
//   ours   = 当前 HEAD
//   theirs = 被摘取提交
//
// 很多人误以为 base 是「两个分支的公共祖先」——那是 merge 的语义。
// 选错 base 会把整个历史差异当成冲突，功能直接不可用。
//
// 举例（把 feature 上的 F 摘到 main）：
//
//        B---C  main (HEAD, ours)
//       /
//   A--B---F  feature (theirs = F, base = F 的父 = B)
//
// 若把 base 当成 A（两者真实公共祖先），那 C 的所有改动都会被当作
// 「theirs 缺失」而回退，等于把 main 的工作扔掉。
//
// 冲突处理与 Git 一致：
//   - 不自动提交，写 CHERRY_PICK_HEAD 记录来源提交
//   - 用户在解决后执行 commit，commit 会据此带上原始作者信息
//   - CHERRY_PICK_HEAD 不写的话，「抄来」的提交会丢掉原作者，这在协作里是严重问题

import { readHeadRef, writeRef } from "../refs.js";
import { readCommit, writeCommit, formatIdentity, localTimezoneOffset } from "../commit.js";
import { flattenTree, writeTreeFromEntries } from "../tree.js";
import { mergeTreeStates, applyWorktree } from "../merge-trees.js";
import { writeIndex, readIndex, entryFromStat } from "../index-file.js";
import { writeFile, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

export const CHERRY_PICK_HEAD = "CHERRY_PICK_HEAD";

// 解析一个提交引用：支持短 sha、分支名、HEAD。
export async function resolveCommitRef(gitDir, ref) {
  const { readRef } = await import("../refs.js");

  if (ref === "HEAD") {
    const h = await readHeadRef(gitDir);
    if (!h.oid) throw new Error("当前分支还没有任何提交");
    return h.oid;
  }
  // 分支名
  const asBranch = await readRef(gitDir, "refs/heads/" + ref);
  if (asBranch) return asBranch;

  // 完整 sha
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;

  // 短 sha：遍历所有对象找到唯一匹配
  if (/^[0-9a-f]{4,39}$/.test(ref)) {
    const { listAllObjects, objectExists } = await import("../objects.js");
    const all = await listAllObjects(gitDir);
    const matches = [...all].filter((oid) => oid.startsWith(ref));
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) throw new Error("找不到提交: " + ref);
    throw new Error("提交引用不明确（" + matches.length + " 个匹配）: " + ref);
  }

  throw new Error("无法解析的提交引用: " + ref);
}

// 摘取单个提交。
//
// 返回 { result, oid?, conflicts?, sourceOid }
//   result = "picked"   已成功提交
//   result = "conflict" 有冲突，工作区已写入标记，等用户解决
//   result = "empty"    该提交的改动在当前分支上已存在（无需提交）
export async function cherryPick(gitDir, rootDir, ref, {
  author = null,
  message = null,
  now = new Date(),
  noCommit = false,
  recordSource = true,
} = {}) {
  const head = await readHeadRef(gitDir);
  if (!head.oid) throw new Error("cherry-pick: 当前分支还没有任何提交");

  const sourceOid = await resolveCommitRef(gitDir, ref);
  const source = await readCommit(gitDir, sourceOid);

  // 关键：base 是「被摘取提交的父提交」
  const baseOid = source.parents.length > 0 ? source.parents[0] : null;

  const baseFiles = baseOid ? await filesOfCommit(gitDir, baseOid) : new Map();
  const oursFiles = await filesOfCommit(gitDir, head.oid);
  const theirsFiles = await filesOfCommit(gitDir, sourceOid);

  const { mergedFiles, conflicts, worktree } = await mergeTreeStates(gitDir, {
    baseFiles,
    oursFiles,
    theirsFiles,
    oursLabel: "HEAD",
    theirsLabel: sourceOid.slice(0, 7) + " (" + (source.message ?? "").split("\n")[0] + ")",
  });
  await applyWorktree(rootDir, worktree);

  if (conflicts.length > 0) {
    // 记录来源提交，供解决冲突后的 commit 使用
    if (recordSource) {
      await writeFile(path.join(gitDir, CHERRY_PICK_HEAD), sourceOid + "\n");
    }
    return { result: "conflict", sourceOid, conflicts, baseOid };
  }

  // 结果与当前 HEAD 完全一致 → 该改动已经在当前分支上，不必产生空提交
  const oursTree = (await readCommit(gitDir, head.oid)).tree;
  const entries = [];
  for (const [p, entry] of mergedFiles) {
    const abs = path.join(rootDir, p);
    let st;
    try { st = await stat(abs); } catch { st = null; }
    entries.push(st
      ? entryFromStat(p, entry.oid, entry.mode, st)
      : { path: p, oid: entry.oid, mode: entry.mode, stage: 0, stat: emptyStat() });
  }
  await writeIndex(gitDir, { version: 2, entries });

  if (noCommit) {
    return { result: "merged-not-committed", sourceOid, baseOid };
  }

  const treeOid = await writeTreeFromEntries(
    gitDir,
    entries.map((e) => ({ path: e.path, oid: e.oid, mode: e.mode }))
  );

  if (treeOid === oursTree) {
    await rm(path.join(gitDir, CHERRY_PICK_HEAD), { force: true });
    return { result: "empty", sourceOid, baseOid, treeOid };
  }

  // 保留原始作者：这是 cherry-pick 的语义要求，
  // 否则「谁写的这段代码」这个信息就丢了。
  const seconds = Math.floor(now.getTime() / 1000);
  const committerIdentity = formatIdentity(author?.name ?? "tinygit", author?.email ?? "tinygit@localhost", seconds, localTimezoneOffset(now));
  const authorIdentity = source.author
    ? formatIdentity(source.author.name, source.author.email, source.author.timestamp, source.author.offset)
    : committerIdentity;

  // 默认沿用原始提交信息。
  // 不要加 "# " 前缀——那是 git 在编辑器里给用户的注释提示，
  // 不该进到最终的提交对象里。
  const commitMessage = message ? message : source.message;

  const newOid = await writeCommit(gitDir, {
    tree: treeOid,
    parents: [head.oid],
    author: authorIdentity,
    committer: committerIdentity,
    message: commitMessage,
  });

  await writeRef(gitDir, head.ref, newOid);
  await rm(path.join(gitDir, CHERRY_PICK_HEAD), { force: true });

  return { result: "picked", oid: newOid, sourceOid, baseOid, treeOid };
}

async function filesOfCommit(gitDir, commitOid) {
  const commit = await readCommit(gitDir, commitOid);
  return flattenTree(gitDir, commit.tree);
}

function emptyStat() {
  return { ctime: 0, ctimeNano: 0, mtime: 0, mtimeNano: 0, dev: 0, ino: 0, uid: 0, gid: 0, size: 0 };
}

// 读取待完成的 cherry-pick 状态（commit 命令会用到）
export async function readCherryPickHead(gitDir) {
  try {
    const text = (await readFile(path.join(gitDir, CHERRY_PICK_HEAD), "utf8")).trim();
    if (!/^[0-9a-f]{40}$/.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

export async function clearCherryPickState(gitDir) {
  await rm(path.join(gitDir, CHERRY_PICK_HEAD), { force: true });
}
