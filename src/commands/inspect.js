// cat-file / ls-tree：只读检视对象，用于调试与验证。

import { readObject } from "../objects.js";
import { parseTree } from "../tree.js";
import { parseCommit } from "../commit.js";

export async function catFile(gitDir, oid) {
  const obj = await readObject(gitDir, oid);
  return { type: obj.type, content: obj.content };
}

export async function lsTree(gitDir, oid) {
  const obj = await readObject(gitDir, oid);
  if (obj.type !== "tree") throw new Error("not a tree: " + oid);
  return parseTree(obj.content).map((e) => ({
    mode: e.mode.padStart(6, "0"),
    type: e.type,
    oid: e.oid,
    name: e.name,
  }));
}

export function formatLsTree(entries) {
  return entries.map((e) => e.mode + " " + e.type + " " + e.oid + "\t" + e.name).join("\n") + "\n";
}

export async function hashObjectFromString(gitDir, text) {
  const { writeObject } = await import("../objects.js");
  const oid = await writeObject(gitDir, "blob", Buffer.from(text, "utf8"));
  return oid;
}
