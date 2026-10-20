// add：把工作区文件写入对象库并更新索引。

import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { writeObject } from "../objects.js";
import { entryFromStat, readIndex, writeIndex } from "../index-file.js";
import { scanWorkingTree, readFileForBlob } from "../worktree.js";

export async function add(gitDir, rootDir, patterns = []) {
  const index = await readIndex(gitDir);
  const byPath = new Map(index.entries.map((e) => [e.path, e]));

  let targets;
  if (patterns.length === 0 || patterns.includes(".") || patterns.includes("-A")) {
    targets = (await scanWorkingTree(rootDir)).map((f) => f.path);
  } else {
    targets = [];
    const all = await scanWorkingTree(rootDir);
    for (const pattern of patterns) {
      const normalized = pattern.replace(/^\.\//, "").replace(/\/$/, "");
      const matched = all.filter((f) => f.path === normalized || f.path.startsWith(normalized + "/"));
      if (matched.length === 0) {
        // 可能是通配符
        const { globToRegExp } = await import("../ignore.js");
        const re = globToRegExp(normalized);
        targets.push(...all.filter((f) => re.test(f.path) || re.test(f.path.split("/").pop())).map((f) => f.path));
      } else {
        targets.push(...matched.map((f) => f.path));
      }
    }
  }

  const added = [];
  for (const rel of new Set(targets)) {
    const abs = path.join(rootDir, rel);
    let blob;
    try { blob = await readFileForBlob(abs); } catch { continue; }
    const oid = await writeObject(gitDir, "blob", blob.content);
    const entry = entryFromStat(rel, oid, blob.mode, blob.stat);
    byPath.set(rel, entry);
    added.push({ path: rel, oid });
  }

  index.entries = [...byPath.values()];
  await writeIndex(gitDir, index);
  return added;
}

export async function removeFromIndex(gitDir, patterns) {
  const index = await readIndex(gitDir);
  const before = index.entries.length;
  index.entries = index.entries.filter((e) => !patterns.some((p) => e.path === p || e.path.startsWith(p + "/")));
  await writeIndex(gitDir, index);
  return before - index.entries.length;
}
