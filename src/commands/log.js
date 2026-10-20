// log：遍历提交 DAG 输出历史。
//
// 不能只沿 parent[0] 走。合并提交有两个 parent，只跟第一个会让
// 被合并分支的提交从历史里消失 —— 看起来像数据丢了，实际是遍历不全。
// 真 git 的 log 默认遍历所有 parent，这里保持一致：
// 用按提交时间排序的优先队列，逐个弹出并展开其全部 parent。

import { readCommit } from "../commit.js";
import { readHeadRef } from "../refs.js";

export async function log(gitDir, { limit = 20 } = {}) {
  const head = await readHeadRef(gitDir);
  if (!head.oid) return [];

  // 先收集提交图（限制规模，避免超大仓库把内存吃满）
  const commits = new Map();
  const pending = [head.oid];
  while (pending.length > 0 && commits.size < 5000) {
    const oid = pending.pop();
    if (commits.has(oid)) continue;
    let c;
    try {
      c = await readCommit(gitDir, oid);
    } catch {
      continue;   // 残缺仓库里的悬空 parent
    }
    commits.set(oid, c);
    for (const p of c.parents) if (!commits.has(p)) pending.push(p);
  }

  // 用「优先队列」遍历：始终保持「所有提交都排在它的父提交之前」。
  //
  // 约束来自图本身：一个提交只有当它的所有子提交都已输出后才能输出
  // （否则父提交会跑到子提交前面）。
  //
  // 实现：childCount[oid] = 有多少个子提交尚未输出。
  // 只有 childCount 归零的提交才可以进入候选。从 HEAD 开始，
  // HEAD 没有子提交，childCount 天然为 0。
  const childCount = new Map();
  const parentsOf = new Map();
  for (const oid of commits.keys()) childCount.set(oid, 0);
  for (const [oid, c] of commits) {
    const live = c.parents.filter((p) => commits.has(p));
    parentsOf.set(oid, live);
    for (const p of live) childCount.set(p, childCount.get(p) + 1);
  }

  const ready = [];
  for (const [oid, n] of childCount) if (n === 0) ready.push(oid);

  const order = [];
  const done = new Set();
  while (ready.length > 0 && order.length < limit) {
    // 同层按时间倒序：更新的分支优先展示
    ready.sort((a, b) => (commits.get(b).author?.timestamp ?? 0) - (commits.get(a).author?.timestamp ?? 0));
    const oid = ready.shift();
    if (done.has(oid)) continue;
    done.add(oid);
    order.push(oid);

    for (const p of parentsOf.get(oid) ?? []) {
      const left = childCount.get(p) - 1;
      childCount.set(p, left);
      if (left === 0) ready.push(p);
    }
  }

  // 防御：图里有环（不该发生）时把剩余提交按时间补上
  if (order.length < limit) {
    const rest = [...commits.keys()]
      .filter((o) => !done.has(o))
      .sort((a, b) => (commits.get(b).author?.timestamp ?? 0) - (commits.get(a).author?.timestamp ?? 0));
    for (const oid of rest) {
      if (order.length >= limit) break;
      order.push(oid);
    }
  }

  return order.map((oid) => ({ oid, ...commits.get(oid) }));
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

