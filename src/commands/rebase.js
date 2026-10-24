// rebase：把当前分支的提交「搬」到另一个基点上。
//
// 本质是批量 cherry-pick：找出「当前分支独有」的提交，逐个重放到新基点。
//
// 关键步骤：
//   1. 计算 base = 两个分支的最近公共祖先
//   2. 列出 current..base 之间的提交（当前分支独有），**按拓扑序从旧到新**
//   3. 把 HEAD 指到新基点（detach 到 onch）
//   4. 逐个 cherry-pick
//   5. 全部成功 → 把分支引用移到新 HEAD
//
// 最容易出错的三点：
//
//   · 提交顺序必须是「从旧到新」。反了的话，后面的提交会依赖前面的
//     改动却不存在，冲突率飙升。
//
//   · 中途冲突必须能恢复。真 git 把状态写进 .git/rebase-merge/，
//     然后停下等用户处理。只把状态放内存里，进程一退就全丢了，
//     用户解决冲突后无法继续。
//
//   · 分支引用在 rebase 期间不能移动。HEAD 暂时 detach 到新基点，
//     成功后才把 refs/heads/<branch> 指过去。中途移动的话，
//     一旦失败用户就找不到原来的位置了（真 git 靠 ORIG_HEAD 兜底）。

import { readHeadRef, readRef, writeRef, setHeadSymref } from "../refs.js";
import { readCommit, writeCommit, formatIdentity, localTimezoneOffset } from "../commit.js";
import { findMergeBase, isAncestor } from "../merge-base.js";
import { cherryPick } from "./cherry-pick.js";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const REBASE_DIR = "rebase-merge";

function rebasePaths(gitDir) {
  const dir = path.join(gitDir, REBASE_DIR);
  return {
    dir,
    headName: path.join(dir, "head-name"),      // 原分支引用，如 refs/heads/feature
    onto: path.join(dir, "onto"),                // 新基点 oid
    origHead: path.join(dir, "orig-head"),       // rebase 前的 HEAD oid
    todo: path.join(dir, "todo"),                // 待重放的提交（每行一个 oid）
    done: path.join(dir, "done"),                // 已完成的数量
    current: path.join(dir, "current"),          // 正在处理的提交
  };
}

// 列出 from 独有、不属于 onto 历史的提交，按「从旧到新」排序。
export async function commitsToReplay(gitDir, fromOid, ontoOid) {
  const stop = new Set();

  // 收集 onto 侧的全部祖先
  async function markAncestors(oid, out, guard = new Set()) {
    if (!oid || guard.has(oid)) return;
    guard.add(oid);
    out.add(oid);
    let c;
    try { c = await readCommit(gitDir, oid); } catch { return; }
    for (const p of c.parents) await markAncestors(p, out, guard);
  }
  await markAncestors(ontoOid, stop);

  // 从 from 侧向上遍历，遇到 stop 就停
  const picked = [];
  const seen = new Set();
  async function walk(oid) {
    if (!oid || stop.has(oid) || seen.has(oid)) return;
    seen.add(oid);
    const c = await readCommit(gitDir, oid);
    for (const p of c.parents) await walk(p);
    // 后序：父提交先入列，保证「从旧到新」
    picked.push(oid);
  }
  await walk(fromOid);
  return picked;
}

export async function rebase(gitDir, rootDir, ontoRef, {
  author = { name: "tinygit", email: "tinygit@localhost" },
  now = new Date(),
  abort = false,
  abortIfConflict = false,
} = {}) {
  const paths = rebasePaths(gitDir);

  if (abort) return rebaseAbort(gitDir, rootDir);
  if (await isRebaseInProgress(gitDir)) {
    const cont = await rebaseContinue(gitDir, rootDir, { author, now });
    if (cont) return cont;
    throw new Error("rebase: 有正在进行的 rebase，先解决冲突后执行 rebase --continue，或 rebase --abort 放弃");
  }

  const head = await readHeadRef(gitDir);
  if (!head.oid) throw new Error("rebase: 当前分支还没有任何提交");
  if (!head.ref.startsWith("refs/heads/")) {
    throw new Error("rebase: 当前处于 detached HEAD，无法 rebase");
  }

  // 解析新基点
  const { resolveCommitRef } = await import("./cherry-pick.js");
  const ontoOid = await resolveCommitRef(gitDir, ontoRef);

  // 已经在基点上，什么都不用做
  if (await isAncestor(gitDir, head.oid, ontoOid)) {
    await writeRef(gitDir, head.ref, ontoOid);
    return { result: "up-to-date", onto: ontoOid, replayed: 0, skipped: 0 };
  }

  const baseOid = await findMergeBase(gitDir, head.oid, ontoOid);
  if (!baseOid) throw new Error("rebase: 两个分支没有共同历史");

  const todo = await commitsToReplay(gitDir, head.oid, ontoOid);
  if (todo.length === 0) {
    return { result: "up-to-date", onto: ontoOid, replayed: 0, skipped: 0 };
  }

  // 记录状态：中途失败也能恢复
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.headName, head.ref + "\n");
  await writeFile(paths.onto, ontoOid + "\n");
  await writeFile(paths.origHead, head.oid + "\n");
  await writeFile(paths.todo, todo.join("\n") + "\n");
  await writeFile(paths.done, "0\n");

  // HEAD 暂时 detach 到新基点
  await writeRef(gitDir, "HEAD", ontoOid);

  return runTodo(gitDir, rootDir, { author, now, abortIfConflict });
}

// 依次执行 todo 里的提交
async function runTodo(gitDir, rootDir, { author, now, abortIfConflict }) {
  const paths = rebasePaths(gitDir);
  const todoText = (await readFile(paths.todo, "utf8")).trim();
  const todo = todoText ? todoText.split("\n").filter(Boolean) : [];
  const doneText = Number((await readFile(paths.done, "utf8")).trim() || "0");
  const done = Number.isFinite(doneText) ? doneText : 0;

  const results = [];
  let empty = 0;

  for (let i = done; i < todo.length; i += 1) {
    const oid = todo[i];
    await writeFile(paths.current, oid + "\n");

    const r = await cherryPick(gitDir, rootDir, oid, {
      author, now, recordSource: false,
    });

    if (r.result === "conflict") {
      // 保留 todo/done 状态，等用户解决后 rebase --continue
      await writeFile(paths.done, String(i) + "\n");
      if (abortIfConflict) {
        await rebaseAbort(gitDir, rootDir);
        throw new Error("rebase: 提交 " + oid.slice(0, 7) + " 产生冲突，已回滚");
      }
      return {
        result: "conflict",
        onto: (await readFile(paths.onto, "utf8")).trim(),
        current: oid,
        conflicts: r.conflicts,
        remaining: todo.length - i,
        replayed: results.length,
      };
    }

    if (r.result === "empty") {
      // 该提交的改动已存在，跳过（真 git 默认也是跳过）
      empty += 1;
      await writeFile(paths.done, String(i + 1) + "\n");
      continue;
    }

    results.push(r.oid);
    await writeFile(paths.done, String(i + 1) + "\n");
  }

  return finishRebase(gitDir, rootDir, { results, empty });
}

// 全部完成后：把分支引用移到新位置，恢复 HEAD 为符号引用
async function finishRebase(gitDir, rootDir, { results, empty }) {
  const paths = rebasePaths(gitDir);
  const headName = (await readFile(paths.headName, "utf8")).trim();
  const origHead = (await readFile(paths.origHead, "utf8")).trim();
  const newHead = (await readFile(gitDir + "/HEAD", "utf8")).trim();

  // 把新基点的完整 tree 检出到工作区。
  //
  // cherry-pick 只处理「被重放提交涉及的路径」，新基点上新增/删除的文件
  // 完全没被碰过。不在这里整体重建工作区，就会出现「索引和 HEAD 都有
  // main2.txt，但磁盘上没有」——status 报删除，用户一脸困惑。
  const { restoreTree } = await import("./branch.js");
  await restoreTree(gitDir, rootDir, newHead);

  await writeRef(gitDir, headName, newHead);
  await setHeadSymref(gitDir, headName);
  // 记录原始位置，方便用户事后找回（真 git 也写 ORIG_HEAD）
  await writeFile(path.join(gitDir, "ORIG_HEAD"), origHead + "\n");

  await rm(paths.dir, { recursive: true, force: true });

  return {
    result: "rebased",
    head: newHead,
    branch: headName.replace(/^refs\/heads\//, ""),
    replayed: results.length,
    skipped: empty,
    origHead,
  };
}

export async function isRebaseInProgress(gitDir) {
  try {
    await readFile(path.join(gitDir, REBASE_DIR, "todo"), "utf8");
    return true;
  } catch {
    return false;
  }
}

// 解决冲突后继续。
//
// **绝不能重新执行 cherry-pick**：用户已经手工把冲突改好了，
// 再跑一次三方归并会把工作区重新写成冲突标记，等于把用户的修改抹掉。
//
// 正确做法是「直接用当前索引提交」，提交信息与作者沿用被中断的那个提交。
// 借道 commit 命令的 CHERRY_PICK_HEAD 机制即可复用作者沿用逻辑。
export async function rebaseContinue(gitDir, rootDir, { author, now } = {}) {
  const paths = rebasePaths(gitDir);
  if (!(await isRebaseInProgress(gitDir))) {
    throw new Error("rebase --continue: 没有正在进行的 rebase");
  }

  let current = null;
  try { current = (await readFile(paths.current, "utf8")).trim(); } catch {}
  if (!current) throw new Error("rebase --continue: 状态文件缺失（current）");

  const { readIndex } = await import("../index-file.js");
  const index = await readIndex(gitDir);
  if (index.entries.length === 0) {
    throw new Error("rebase --continue: 索引为空，请先 git add 解决后的文件");
  }

  const { commit: doCommit } = await import("./commit.js");
  const { readCommit } = await import("../commit.js");

  const source = await readCommit(gitDir, current);

  // 借道 CHERRY_PICK_HEAD：让 commit 自动沿用原作者
  await writeFile(path.join(gitDir, "CHERRY_PICK_HEAD"), current + "\n");

  let committed;
  try {
    committed = await doCommit(gitDir, {
      message: source.message,
      author: author ?? { name: "tinygit", email: "tinygit@localhost" },
      now: now ?? new Date(),
    });
  } catch (e) {
    // 解决结果与 parent 相同 → 该提交等于空提交，跳过（与 git 行为一致）
    if (/nothing to commit/.test(e.message)) {
      const { clearCherryPickState } = await import("./cherry-pick.js");
      await clearCherryPickState(gitDir);
      const doneNow = Number((await readFile(paths.done, "utf8")).trim() || "0");
      await writeFile(paths.done, String(doneNow + 1) + "\n");
      await rm(paths.current, { force: true });
      void committed;
      return runTodo(gitDir, rootDir, { author, now });
    }
    throw e;
  }

  const doneNow = Number((await readFile(paths.done, "utf8")).trim() || "0");
  await writeFile(paths.done, String(doneNow + 1) + "\n");
  await rm(paths.current, { force: true });

  return runTodo(gitDir, rootDir, { author, now });
}

// 放弃 rebase，回到原始位置
export async function rebaseAbort(gitDir, rootDir) {
  const paths = rebasePaths(gitDir);
  if (!(await isRebaseInProgress(gitDir))) {
    throw new Error("rebase --abort: 没有正在进行的 rebase");
  }

  const headName = (await readFile(paths.headName, "utf8")).trim();
  const origHead = (await readFile(paths.origHead, "utf8")).trim();

  // 分支引用指回原位置，HEAD 恢复为符号引用
  await writeRef(gitDir, headName, origHead);
  await setHeadSymref(gitDir, headName);

  // 工作区恢复到原提交
  const { restoreTree } = await import("./branch.js");
  await restoreTree(gitDir, rootDir, origHead);

  await rm(paths.dir, { recursive: true, force: true });
  return { result: "aborted", head: origHead, branch: headName.replace(/^refs\/heads\//, "") };
}
