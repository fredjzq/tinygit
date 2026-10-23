// status：比较「HEAD 树 / 索引 / 工作区」三者，报告差异。
//
// 三态比较是 Git 最容易讲不清的地方，这里显式列出三种状态来源：
//   HEAD tree  vs  index       → 已暂存的变更
//   index      vs  working     → 未暂存的变更

import path from "node:path";
import { readFile } from "node:fs/promises";
import { readIndex } from "../index-file.js";
import { readHeadRef, readRef } from "../refs.js";
import { readCommit } from "../commit.js";
import { flattenTree } from "../tree.js";
import { scanWorkingTree, readFileForBlob } from "../worktree.js";
import { hashObject } from "../objects.js";

export async function status(gitDir, rootDir) {
  const head = await readHeadRef(gitDir);
  let headFiles = new Map();
  if (head.oid) {
    const commitObj = await readCommit(gitDir, head.oid);
    headFiles = await flattenTree(gitDir, commitObj.tree);
  }

  const index = await readIndex(gitDir);
  const indexByPath = new Map(index.entries.map((e) => [e.path, e]));

  const staged = [];
  for (const [p, entry] of indexByPath) {
    const headEntry = headFiles.get(p);
    if (!headEntry || headEntry.oid !== entry.oid) staged.push({ path: p, kind: headEntry ? "modified" : "added" });
  }
  for (const p of headFiles.keys()) {
    if (!indexByPath.has(p)) staged.push({ path: p, kind: "deleted" });
  }

  const workFiles = await scanWorkingTree(rootDir);
  const workByPath = new Map(workFiles.map((f) => [f.path, f]));

  const unstaged = [];
  const untracked = [];
  for (const [p, file] of workByPath) {
    const entry = indexByPath.get(p);
    if (!entry) {
      untracked.push(p);
      continue;
    }
    const blob = await readFileForBlob(file.abs);
    // 只计算哈希，不写入对象库。
    // 用 writeObject 会让「跑一次 status」就往 .git 里塞入未跟踪文件的 blob，
    // 真 git 的 status 是纯只读操作。
    const oid = hashObject("blob", blob.content);
    if (oid !== entry.oid) unstaged.push({ path: p, kind: "modified" });
    else if (parseInt(blob.mode, 8) !== entry.mode) unstaged.push({ path: p, kind: "mode-changed" });
  }
  for (const p of indexByPath.keys()) {
    if (!workByPath.has(p)) unstaged.push({ path: p, kind: "deleted" });
  }

  // 合并状态：冲突期间用户需要知道「正在合并」，否则会困惑于
  // 为什么 status 只显示 modified 却提交出双亲。
  let merging = null;
  try {
    const mergeHeadOid = (await readFile(path.join(gitDir, "MERGE_HEAD"), "utf8")).trim();
    let branchName = null;
    try {
      const msg = await readFile(path.join(gitDir, "MERGE_MSG"), "utf8");
      const m = /Merge branch '([^']+)'/.exec(msg);
      if (m) branchName = m[1];
    } catch {}
    merging = { oid: mergeHeadOid, branch: branchName };
  } catch {
    // 不在合并中
  }

  // 冲突文件：工作区里含冲突标记的文件
  const conflicted = [];
  if (merging) {
    for (const [p, file] of workByPath) {
      if (!indexByPath.has(p)) continue;
      try {
        const content = await readFile(file.abs, "utf8");
        if (content.includes("<<<<<<<") && content.includes(">>>>>>>")) {
          conflicted.push(p);
        }
      } catch {}
    }
  }

  return { head, staged, unstaged, untracked: untracked.sort(), merging, conflicted };
}

export function formatStatus(result) {
  const out = [];
  if (result.head.oid) {
    out.push("On branch " + result.head.ref.replace(/^refs\/heads\//, ""));
  } else {
    out.push("On branch " + result.head.ref.replace(/^refs\/heads\//, "") + " (no commits yet)");
  }
  if (result.merging) {
    const target = result.merging.branch ? " '" + result.merging.branch + "'" : "";
    out.push("You have unmerged paths: merging" + target);
    if (result.conflicted.length > 0) {
      out.push("");
      out.push("Unmerged paths:");
      for (const p of result.conflicted) out.push("  ! " + p + "  (both modified)");
    }
    out.push("");
    out.push("解决冲突后运行: tinygit add <文件> 然后 tinygit commit -m \"消息\"");
  }

  const section = (title, items, sym) => {
    if (items.length === 0) return;
    out.push("");
    out.push(title);
    for (const it of items) out.push("  " + sym + " " + it.path + (it.kind !== "added" ? "  (" + it.kind + ")" : ""));
  };
  section("Changes to be committed:", result.staged, "+");
  section("Changes not staged for commit:", result.unstaged, "~");
  section("Untracked files:", result.untracked.map((p) => ({ path: p, kind: "new" })), "?");
  const hasConflict = Boolean(result.merging && result.conflicted.length > 0);
  if (!hasConflict && result.staged.length === 0 && result.unstaged.length === 0 && result.untracked.length === 0 && !result.merging) {
    out.push("");
    out.push("nothing to commit, working tree clean");
  }
  return out.join("\n") + "\n";
}
