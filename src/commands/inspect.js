// cat-file / ls-tree：只读检视对象，用于调试与验证。

import { readObject } from "../objects.js";
import { parseTree } from "../tree.js";
import { readHeadRef, readRef } from "../refs.js";
import { readCommit } from "../commit.js";

// 把用户输入解析成对象 oid。
//
// 没有这一步的话，ls-tree HEAD 会把字符串 "HEAD" 直接当 oid 去查，
// 报「object not found」——而 HEAD 是用户最常输入的东西。
export async function resolveObjectish(gitDir, ref) {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error("需要一个对象引用");
  }

  // 已是完整 oid
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;

  // HEAD（含 HEAD~n / HEAD^n 这类祖先引用）
  if (ref === "HEAD" || ref.startsWith("HEAD~") || ref.startsWith("HEAD^")) {
    const h = await readHeadRef(gitDir);
    if (!h.oid) throw new Error("当前分支还没有任何提交");
    return resolveAncestry(gitDir, h.oid, ref.slice(4));
  }

  // 分支名
  const asBranch = await readRef(gitDir, "refs/heads/" + ref);
  if (asBranch) return resolveAncestry(gitDir, asBranch, "");

  // 短 sha
  if (/^[0-9a-f]{4,39}$/.test(ref)) {
    const { listAllObjects } = await import("../objects.js");
    const all = await listAllObjects(gitDir);
    const matches = [...all].filter((oid) => oid.startsWith(ref));
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) throw new Error("找不到对象: " + ref);
    throw new Error("对象引用不明确（" + matches.length + " 个匹配）: " + ref);
  }

  throw new Error("无法解析的引用: " + ref);
}

// 处理 ~n（沿第一父链向上 n 代）与 ^n（第 n 个父提交）
async function resolveAncestry(gitDir, startOid, suffix) {
  if (!suffix) return startOid;
  let oid = startOid;

  const tilde = /^~(\d+)$/.exec(suffix);
  if (tilde) {
    const n = Number(tilde[1]);
    for (let i = 0; i < n; i += 1) {
      const c = await readCommit(gitDir, oid);
      if (c.parents.length === 0) throw new Error("提交没有父提交: " + oid.slice(0, 7));
      oid = c.parents[0];
    }
    return oid;
  }

  const caret = /^\^(\d*)$/.exec(suffix);
  if (caret) {
    const n = caret[1] === "" ? 1 : Number(caret[1]);
    const c = await readCommit(gitDir, oid);
    if (n === 0) return oid;
    if (c.parents.length < n) throw new Error("提交只有 " + c.parents.length + " 个父提交");
    return c.parents[n - 1];
  }

  throw new Error("不支持的后缀: " + suffix);
}

export async function catFile(gitDir, ref) {
  const oid = await resolveObjectish(gitDir, ref);
  const obj = await readObject(gitDir, oid);
  return { type: obj.type, content: obj.content, oid };
}

export async function lsTree(gitDir, ref) {
  const oid = await resolveObjectish(gitDir, ref);
  let obj = await readObject(gitDir, oid);

  // 传进来的常常是提交（HEAD、分支名）。真 git 的 ls-tree 也接受提交，
  // 自动取它的 tree —— 直接报 "not a tree" 对用户很不友好，
  // 因为「列出 HEAD 的树」是最自然的操作。
  if (obj.type === "commit") {
    const commit = await readCommit(gitDir, oid);
    const treeOid = commit.tree;
    obj = await readObject(gitDir, treeOid);
    if (obj.type !== "tree") throw new Error("提交的 tree 不是树对象: " + treeOid);
  } else if (obj.type !== "tree") {
    throw new Error("not a tree: " + oid + "（类型是 " + obj.type + "）");
  }
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
