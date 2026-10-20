// commit 对象：指向一棵 tree（整个项目快照）+ 零或多个父提交。
//
// 格式（严格按 Git 的序列化顺序，否则哈希对不上）：
//   tree <40 hex>\n
//   parent <40 hex>\n      (可重复，0..N 次)
//   author <name> <email> <unix秒> <±HHMM>\n
//   committer <name> <email> <unix秒> <±HHMM>\n
//   \n
//   <message>

import { readObject, writeObject } from "./objects.js";

export function formatTimezone(offsetMinutes) {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return sign + hh + mm;
}

export function localTimezoneOffset(date = new Date()) {
  // getTimezoneOffset 返回「UTC - 本地」的分钟数，Git 要的是相反的符号
  return -date.getTimezoneOffset();
}

export function formatIdentity(name, email, unixSeconds, offsetMinutes) {
  return name + " <" + email + "> " + unixSeconds + " " + formatTimezone(offsetMinutes);
}

export function serializeCommit({ tree, parents = [], author, committer, message }) {
  const lines = ["tree " + tree];
  for (const p of parents) lines.push("parent " + p);
  lines.push("author " + author);
  lines.push("committer " + committer);
  return lines.join("\n") + "\n\n" + message;
}

export function parseCommit(text) {
  const sep = text.indexOf("\n\n");
  const headerBlock = sep < 0 ? text : text.slice(0, sep);
  const message = sep < 0 ? "" : text.slice(sep + 2);
  const lines = headerBlock.split("\n");
  const commit = { tree: null, parents: [], author: null, committer: null, message, extra: {} };
  for (const line of lines) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === "tree") commit.tree = value;
    else if (key === "parent") commit.parents.push(value);
    else if (key === "author") commit.author = parseIdentity(value);
    else if (key === "committer") commit.committer = parseIdentity(value);
    else commit.extra[key] = value;
  }
  return commit;
}

export function parseIdentity(value) {
  // "Name <email> 1234567890 +0800"
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(value.trim());
  if (!m) return { raw: value, name: value, email: "", timestamp: 0, offset: 0 };
  const tz = m[4];
  const sign = tz[0] === "-" ? -1 : 1;
  return {
    raw: value,
    name: m[1],
    email: m[2],
    timestamp: Number(m[3]),
    offset: sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5))),
  };
}

export async function writeCommit(gitDir, commit) {
  const body = serializeCommit(commit);
  return writeObject(gitDir, "commit", body);
}

export async function readCommit(gitDir, oid) {
  const { type, text } = await (async () => {
    const obj = await readObject(gitDir, oid);
    return { type: obj.type, text: obj.content.toString("utf8") };
  })();
  if (type !== "commit") throw new Error("not a commit: " + oid + " (" + type + ")");
  return parseCommit(text);
}

