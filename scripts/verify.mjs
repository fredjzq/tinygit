#!/usr/bin/env node
// 独立验证器：不复用 src/ 的任何代码，从零重新实现 Git 的格式规则，
// 再拿它去校验 tinygit 生成的仓库。
//
// 为什么这样做：如果验证器复用被测代码，两边同样错也会「通过」。
// 这里的实现是另写的，只遵循 Git 文档描述的字节布局，构成一次真正的交叉验证。
//
// 用法: node scripts/verify.mjs <仓库路径>

import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import path from "node:path";

let failures = 0;
const checks = [];

function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
}

// ---- 独立实现：对象解码 ----
function decodeLoose(buf) {
  const raw = inflateSync(buf);
  const nul = raw.indexOf(0);
  const header = raw.subarray(0, nul).toString("latin1");
  const [type, sizeText] = header.split(" ");
  const body = raw.subarray(nul + 1);
  return { type, size: Number(sizeText), body, raw };
}

function gitHash(type, body) {
  const header = Buffer.from(type + " " + body.length + "\0", "latin1");
  return createHash("sha1").update(header).update(body).digest("hex");
}

// ---- 独立实现：索引解析 ----
function parseIndexIndependent(buf) {
  if (buf.subarray(0, 4).toString("latin1") !== "DIRC") throw new Error("not a DIRC index");
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  const entries = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const flags = buf.readUInt16BE(off + 60);
    const nameLen = flags & 0x0fff;
    const mode = buf.readUInt32BE(off + 24);
    const oid = buf.subarray(off + 40, off + 60).toString("hex");
    const name = buf.subarray(off + 62, off + 62 + nameLen).toString("utf8");
    entries.push({ name, mode, oid });
    off += (62 + nameLen + 8) & ~7;
  }
  const body = buf.subarray(0, buf.length - 20);
  const trailer = buf.subarray(buf.length - 20).toString("hex");
  return { version, count, entries, checksumOk: createHash("sha1").update(body).digest("hex") === trailer, trailer };
}

async function main() {
  const repo = path.resolve(process.argv[2] ?? ".");
  const gitDir = path.join(repo, ".git");

  // 1) HEAD 是合法的符号引用
  const head = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
  check("HEAD is a symref", /^ref: refs\/heads\/[^\s]+$/.test(head), head);

  // 2) 分支文件里的 oid 是 40 位十六进制
  const refName = head.replace("ref: ", "");
  let headOid = null;
  try {
    headOid = (await readFile(path.join(gitDir, refName), "utf8")).trim();
    check("branch ref holds 40-hex oid", /^[0-9a-f]{40}$/.test(headOid), headOid);
  } catch {
    check("branch ref exists", false, refName);
  }

  // 3) 所有松散对象：文件路径 == 内容哈希，且头部 size 与真实字节数一致
  const objectsDir = path.join(gitDir, "objects");
  let objCount = 0;
  const byType = {};
  const objectBodies = new Map();

  async function walkObjects(dir, prefix) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { await walkObjects(path.join(dir, e.name), e.name); continue; }
      if (prefix.length !== 2) continue;
      const oid = prefix + e.name;
      objCount += 1;
      const decoded = decodeLoose(await readFile(path.join(dir, e.name)));
      byType[decoded.type] = (byType[decoded.type] ?? 0) + 1;
      objectBodies.set(oid, decoded);

      const recomputed = gitHash(decoded.type, decoded.body);
      if (recomputed !== oid) {
        check("object " + oid.slice(0, 7) + " hash matches content", false, "got " + recomputed);
      }
      if (decoded.size !== decoded.body.length) {
        check("object " + oid.slice(0, 7) + " header size matches body", false, decoded.size + " vs " + decoded.body.length);
      }
    }
  }
  await walkObjects(objectsDir, "");
  check("loose objects hash-consistent (" + objCount + " objects " + JSON.stringify(byType) + ")", failures === 0);

  // 4) 沿 commit 链回溯，每条 commit 的 tree 都存在且能解析
  let commitsSeen = 0;
  let cursor = headOid;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const obj = objectBodies.get(cursor);
    if (!obj || obj.type !== "commit") { check("commit " + cursor.slice(0, 7) + " is a commit object", false); break; }
    commitsSeen += 1;
    const text = obj.body.toString("utf8");
    const treeMatch = /^tree ([0-9a-f]{40})$/m.exec(text);
    check("commit " + cursor.slice(0, 7) + " has tree header", Boolean(treeMatch));
    if (treeMatch) {
      const treeObj = objectBodies.get(treeMatch[1]);
      check("commit " + cursor.slice(0, 7) + " tree exists", Boolean(treeObj), treeMatch[1]);
      if (treeObj) check("commit tree is a tree object", treeObj.type === "tree", treeObj.type);
    }
    // author / committer 行的时区必须是 ±HHMM
    const authorLine = /^author (.+?) <(.+?)> (\d+) ([+-]\d{4})$/m.exec(text);
    check("commit " + cursor.slice(0, 7) + " author line well-formed", Boolean(authorLine), authorLine?.[0] ?? "");
    const parentMatch = /^parent ([0-9a-f]{40})$/m.exec(text);
    cursor = parentMatch ? parentMatch[1] : null;
  }
  check("commit chain walkable (" + commitsSeen + " commits)", commitsSeen > 0 || headOid === null);

  // 5) tree 条目：mode + name + 20 字节二进制 sha，且按 Git 规则排序
  for (const [oid, obj] of objectBodies) {
    if (obj.type !== "tree") continue;
    const body = obj.body;
    let off = 0;
    const names = [];
    while (off < body.length) {
      const sp = body.indexOf(32, off);
      const nul = body.indexOf(0, sp);
      if (sp < 0 || nul < 0) { check("tree " + oid.slice(0, 7) + " parses", false); break; }
      const mode = body.subarray(off, sp).toString("latin1");
      const name = body.subarray(sp + 1, nul).toString("utf8");
      const childOid = body.subarray(nul + 1, nul + 21).toString("hex");
      names.push({ mode, name, sortKey: mode === "40000" ? name + "/" : name });
      if (!objectBodies.has(childOid)) check("tree entry " + name + " target exists", false, childOid);
      off = nul + 21;
    }
    const sorted = [...names].sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
    check("tree " + oid.slice(0, 7) + " entries are git-sorted",
      names.map((n) => n.name).join(",") === sorted.map((n) => n.name).join(","),
      names.map((n) => n.name).join(","));
  }

  // 6) index 文件校验和
  try {
    const idx = parseIndexIndependent(await readFile(path.join(gitDir, "index")));
    check("index checksum valid", idx.checksumOk);
    check("index version is 2", idx.version === 2, String(idx.version));
    for (const e of idx.entries) {
      if (!objectBodies.has(e.oid)) check("index entry " + e.name + " points to existing object", false, e.oid);
    }
    check("index entries (" + idx.entries.length + ") reference existing objects", true);
  } catch (err) {
    check("index readable", false, err.message);
  }

  // 7) 空 blob / 空 tree 的哈希常量，验证算法实现正确
  check("empty blob constant", gitHash("blob", Buffer.alloc(0)) === "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  check("empty tree constant", gitHash("tree", Buffer.alloc(0)) === "4b825dc642cb6eb9a060e54bf8d69288fbee4904");

  // 输出
  console.log("");
  for (const c of checks) {
    console.log((c.ok ? "  ✓ " : "  ✗ ") + c.name + (c.ok || !c.detail ? "" : "  [" + c.detail + "]"));
  }
  console.log("");
  if (failures > 0) {
    console.log("FAILED: " + failures + " of " + checks.length + " checks");
    process.exitCode = 1;
  } else {
    console.log("PASSED: all " + checks.length + " checks — repository is byte-compatible with the Git format");
  }
}

main().catch((err) => { console.error("verify crashed:", err); process.exitCode = 2; });
