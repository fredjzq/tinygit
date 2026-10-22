// status：比较「HEAD 树 / 索引 / 工作区」三者，报告差异。
//
// 三态比较是 Git 最容易讲不清的地方，这里显式列出三种状态来源：
//   HEAD tree  vs  index       → 已暂存的变更
//   index      vs  working     → 未暂存的变更

import path from "node:path";
import { readIndex } from "../index-file.js";
import { readHeadRef, readRef } from "../refs.js";
import { readCommit } from "../commit.js";
import { flattenTree } from "../tree.js";
import { scanWorkingTree, readFileForBlob } from "../worktree.js";
import { writeObject } from "../objects.js";

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
    const oid = await writeObject(gitDir, "blob", blob.content);
    if (oid !== entry.oid) unstaged.push({ path: p, kind: "modified" });
    else if (parseInt(blob.mode, 8) !== entry.mode) unstaged.push({ path: p, kind: "mode-changed" });
  }
  for (const p of indexByPath.keys()) {
    if (!workByPath.has(p)) unstaged.push({ path: p, kind: "deleted" });
  }

  return { head, staged, unstaged, untracked: untracked.sort() };
}

export function formatStatus(result) {
  const out = [];
  if (result.head.oid) {
    out.push("On branch " + result.head.ref.replace(/^refs\/heads\//, ""));
  } else {
    out.push("On branch " + result.head.ref.replace(/^refs\/heads\//, "") + " (no commits yet)");
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
  if (result.staged.length === 0 && result.unstaged.length === 0 && result.untracked.length === 0) {
    out.push("");
    out.push("nothing to commit, working tree clean");
  }
  return out.join("\n") + "\n";
}
