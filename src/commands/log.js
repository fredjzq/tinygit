// log：沿 parent 链回溯提交历史。

import { readCommit } from "../commit.js";
import { readHeadRef } from "../refs.js";
import { flattenTree } from "../tree.js";

export async function log(gitDir, { limit = 20, oneline = false } = {}) {
  const head = await readHeadRef(gitDir);
  if (!head.oid) return [];

  const out = [];
  let oid = head.oid;
  const seen = new Set();
  while (oid && out.length < limit && !seen.has(oid)) {
    seen.add(oid);
    const c = await readCommit(gitDir, oid);
    out.push({ oid, ...c });
    oid = c.parents[0] ?? null;
  }
  return out;
}

export function formatLog(commits, { oneline = false } = {}) {
  if (commits.length === 0) return "";
  const lines = [];
  for (const c of commits) {
    if (oneline) {
      lines.push(c.oid.slice(0, 7) + " " + (c.message.split("\n")[0] ?? ""));
      continue;
    }
    lines.push("commit " + c.oid);
    if (c.parents.length > 1) lines.push("Merge: " + c.parents.map((p) => p.slice(0, 7)).join(" "));
    if (c.author) {
      lines.push("Author: " + c.author.name + " <" + c.author.email + ">");
      const d = new Date(c.author.timestamp * 1000).toISOString().replace("T", " ").slice(0, 19);
      lines.push("Date:   " + d + " (unix " + c.author.timestamp + ")");
    }
    lines.push("");
    for (const l of c.message.replace(/\n$/, "").split("\n")) lines.push("    " + l);
    lines.push("");
  }
  return lines.join("\n");
}

export async function countFilesInCommit(gitDir, treeOid) {
  const files = await flattenTree(gitDir, treeOid);
  return files.size;
}
