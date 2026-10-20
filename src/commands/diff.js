// diff：比较「索引/HEAD」与工作区，或两个提交之间。

import { readIndex } from "../index-file.js";
import { readHeadRef } from "../refs.js";
import { readCommit } from "../commit.js";
import { flattenTree } from "../tree.js";
import { readObject } from "../objects.js";
import { scanWorkingTree, readFileForBlob } from "../worktree.js";
import { formatUnified } from "../diff.js";

async function treeOfRef(gitDir, rev) {
  if (!rev) {
    const head = await readHeadRef(gitDir);
    if (!head.oid) return new Map();
    const c = await readCommit(gitDir, head.oid);
    return flattenTree(gitDir, c.tree);
  }
  const c = await readCommit(gitDir, rev);
  return flattenTree(gitDir, c.tree);
}

async function textOfBlob(gitDir, oid) {
  if (!oid) return "";
  const { content } = await readObject(gitDir, oid);
  // 二进制文件直接跳过 diff，避免输出乱码
  if (content.includes(0)) return null;
  return content.toString("utf8");
}

export async function diffWorktree(gitDir, rootDir) {
  const headFiles = await treeOfRef(gitDir);
  const workFiles = await scanWorkingTree(rootDir);
  const workByPath = new Map(workFiles.map((f) => [f.path, f]));

  const results = [];
  for (const [p, file] of workByPath) {
    const blob = await readFileForBlob(file.abs);
    if (blob.content.includes(0)) continue;
    const before = headFiles.has(p) ? await textOfBlob(gitDir, headFiles.get(p).oid) : "";
    const after = blob.content.toString("utf8");
    if (before === after) continue;
    const patch = formatUnified(before ?? "", after, { fromName: "a/" + p, toName: "b/" + p });
    if (patch) results.push(patch);
  }
  return results;
}

export async function diffCommits(gitDir, revA, revB) {
  const aFiles = await treeOfRef(gitDir, revA);
  const bFiles = await treeOfRef(gitDir, revB);
  const paths = new Set([...aFiles.keys(), ...bFiles.keys()]);
  const results = [];
  for (const p of [...paths].sort()) {
    const before = aFiles.has(p) ? await textOfBlob(gitDir, aFiles.get(p).oid) : "";
    const after = bFiles.has(p) ? await textOfBlob(gitDir, bFiles.get(p).oid) : "";
    if (before === null || after === null || before === after) continue;
    const patch = formatUnified(before, after, { fromName: "a/" + p, toName: "b/" + p });
    if (patch) results.push(patch);
  }
  return results;
}

export async function diffStaged(gitDir) {
  const headFiles = await treeOfRef(gitDir);
  const index = await readIndex(gitDir);
  const results = [];
  for (const entry of index.entries) {
    const before = headFiles.has(entry.path) ? await textOfBlob(gitDir, headFiles.get(entry.path).oid) : "";
    const after = await textOfBlob(gitDir, entry.oid);
    if (before === null || after === null || before === after) continue;
    const patch = formatUnified(before, after, { fromName: "a/" + entry.path, toName: "b/" + entry.path });
    if (patch) results.push(patch);
  }
  return results;
}
