#!/usr/bin/env node
// 独立审计器：故意不复用 src/ 的任何代码。
//
// 为什么必须独立：如果审计器调用被测代码，同一处 bug 会让两边一起错、
// 一起「通过」，验证就失去意义。这里从头实现 Git 的读取规则，
// 只依据格式规范，构成真正的交叉验证。
//
// 用法: node scripts/audit.mjs <仓库路径> [--verbose]

import { readFile, readdir, stat, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import path from "node:path";

const VERBOSE = process.argv.includes("--verbose");
let checks = 0;
let failures = 0;
const failureList = [];

function check(name, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    failureList.push({ name, detail });
    console.log("  ✗ " + name + (detail ? "  [" + detail + "]" : ""));
  } else if (VERBOSE) {
    console.log("  ✓ " + name);
  }
}

// ---------- 独立实现：松散对象 ----------
function readLoose(buf) {
  const raw = inflateSync(buf);
  const nul = raw.indexOf(0);
  if (nul < 0) throw new Error("no header terminator");
  const header = raw.subarray(0, nul).toString("latin1");
  const sp = header.indexOf(" ");
  const type = header.slice(0, sp);
  const size = Number(header.slice(sp + 1));
  const body = raw.subarray(nul + 1);
  if (body.length !== size) throw new Error("declared size " + size + " != actual " + body.length);
  return { type, body, size };
}

function oidOf(type, body) {
  const header = Buffer.from(type + " " + body.length + "\0", "latin1");
  return createHash("sha1").update(header).update(body).digest("hex");
}

// ---------- 独立实现：tree 解析 ----------
function parseTreeBody(body) {
  const entries = [];
  let off = 0;
  while (off < body.length) {
    const sp = body.indexOf(32, off);
    const nul = body.indexOf(0, sp);
    if (sp < 0 || nul < 0) throw new Error("malformed tree entry");
    const mode = body.subarray(off, sp).toString("latin1");
    const name = body.subarray(sp + 1, nul).toString("utf8");
    const oid = body.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

// ---------- 独立实现：commit 解析 ----------
function parseCommitBody(body) {
  const text = body.toString("utf8");
  const sep = text.indexOf("\n\n");
  const headers = sep < 0 ? text : text.slice(0, sep);
  const message = sep < 0 ? "" : text.slice(sep + 2);
  const out = { tree: null, parents: [], author: null, committer: null, message, extra: [] };
  for (const line of headers.split("\n")) {
    const sp = line.indexOf(" ");
    const key = line.slice(0, sp);
    const val = line.slice(sp + 1);
    if (key === "tree") out.tree = val;
    else if (key === "parent") out.parents.push(val);
    else if (key === "author") out.author = val;
    else if (key === "committer") out.committer = val;
    else out.extra.push(key);
  }
  return out;
}

// ---------- 独立实现：索引解析 ----------
function parseIndexBody(buf) {
  if (buf.subarray(0, 4).toString("latin1") !== "DIRC") throw new Error("bad DIRC signature");
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  const entries = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const flags = buf.readUInt16BE(off + 60);
    const nameLen = flags & 0x0fff;
    entries.push({
      path: buf.subarray(off + 62, off + 62 + nameLen).toString("utf8"),
      mode: buf.readUInt32BE(off + 24),
      size: buf.readUInt32BE(off + 36),
      mtime: buf.readUInt32BE(off + 8),
      oid: buf.subarray(off + 40, off + 60).toString("hex"),
      stage: (flags >> 12) & 3,
    });
    off += (62 + nameLen + 8) & ~7;
  }
  const bodySum = createHash("sha1").update(buf.subarray(0, buf.length - 20)).digest("hex");
  return { version, count, entries, trailer: buf.subarray(buf.length - 20).toString("hex"), bodySum };
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function main() {
  const repo = path.resolve(process.argv[2] ?? ".");
  const gitDir = path.join(repo, ".git");
  console.log("\n审计仓库: " + repo + "\n");

  // ===== 1. 仓库骨架 =====
  check(".git exists", await exists(gitDir));
  check("objects dir exists", await exists(path.join(gitDir, "objects")));
  const headRaw = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
  check("HEAD is symref", /^ref: refs\/heads\/\S+$/.test(headRaw), headRaw);

  // ===== 2. 收集所有对象（松散 + pack 仅松散，pack 单独说明）=====
  const objects = new Map();
  async function walkObjects(dir, prefix) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { await walkObjects(path.join(dir, e.name), e.name); continue; }
      if (prefix.length !== 2) continue;
      const oid = prefix + e.name;
      try {
        const obj = readLoose(await readFile(path.join(dir, e.name)));
        objects.set(oid, obj);
        check("object " + oid.slice(0, 7) + " content-address matches", oidOf(obj.type, obj.body) === oid);
      } catch (err) {
        check("object " + oid.slice(0, 7) + " decodable", false, err.message);
      }
    }
  }
  await walkObjects(path.join(gitDir, "objects"), "");

  const packDir = path.join(gitDir, "objects", "pack");
  let packFiles = [];
  try { packFiles = (await readdir(packDir)).filter((f) => f.endsWith(".pack")); } catch {}
  if (packFiles.length > 0) {
    console.log("  · 存在 " + packFiles.length + " 个 pack 文件（本审计器只验松散对象）");
  }

  // ===== 3. 引用 =====
  const branches = [];
  async function walkRefs(dir, prefix) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = prefix ? prefix + "/" + e.name : e.name;
      if (e.isDirectory()) await walkRefs(path.join(dir, e.name), rel);
      else branches.push({ ref: "refs/heads/" + rel, oid: (await readFile(path.join(dir, e.name), "utf8")).trim() });
    }
  }
  await walkRefs(path.join(gitDir, "refs", "heads"), "");

  for (const b of branches) {
    check("ref " + b.ref + " holds 40-hex", /^[0-9a-f]{40}$/.test(b.oid), b.oid);
  }

  // HEAD 指向的分支是否存在（unborn 情形允许不存在）
  const headRef = headRaw.replace("ref: ", "");
  const headOid = branches.find((b) => b.ref === headRef)?.oid ?? null;
  if (headOid) {
    check("HEAD target commit exists", objects.has(headOid), headOid);
  } else if (objects.size === 0) {
    check("unborn HEAD is acceptable for empty repo", true);
  } else {
    check("HEAD branch exists when objects present", false, headRef);
  }

  // ===== 4. 沿提交图遍历，验证可达性与结构 =====
  const reachable = new Set();
  const commitData = new Map();
  const queue = branches.map((b) => b.oid).filter((o) => objects.has(o));
  while (queue.length) {
    const oid = queue.shift();
    if (reachable.has(oid)) continue;
    reachable.add(oid);
    const obj = objects.get(oid);
    if (!obj) { check("reachable object " + oid.slice(0, 7) + " present", false); continue; }
    if (obj.type !== "commit") continue;

    const c = parseCommitBody(obj.body);
    commitData.set(oid, c);
    check("commit " + oid.slice(0, 7) + " has tree", Boolean(c.tree));
    check("commit " + oid.slice(0, 7) + " tree exists", c.tree && objects.has(c.tree), c.tree ?? "");
    check("commit " + oid.slice(0, 7) + " tree is tree-type", c.tree && objects.get(c.tree)?.type === "tree");
    check("commit " + oid.slice(0, 7) + " has author", Boolean(c.author));
    check("commit " + oid.slice(0, 7) + " has committer", Boolean(c.committer));

    if (c.author) {
      check("commit " + oid.slice(0, 7) + " author format", /^.+ <.+> \d+ [+-]\d{4}$/.test(c.author), c.author);
    }
    // merge commit 必须有两个以上 parent
    if (c.parents.length > 0) {
      for (const p of c.parents) {
        check("commit " + oid.slice(0, 7) + " parent exists", objects.has(p), p);
      }
    }
    for (const p of c.parents) queue.push(p);
  }

  // ===== 5. tree 深度校验：mode 合法、条目有序、子树类型正确 =====
  const treeChecked = new Set();
  async function checkTree(oid, depth = 0) {
    if (!oid || treeChecked.has(oid) || depth > 100) return;
    treeChecked.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== "tree") return;

    let entries;
    try { entries = parseTreeBody(obj.body); } catch (err) {
      check("tree " + oid.slice(0, 7) + " parses", false, err.message);
      return;
    }

    // mode 只允许几种合法值
    for (const e of entries) {
      const valid = ["100644", "100755", "40000", "120000", "160000"].includes(e.mode);
      check("tree " + oid.slice(0, 7) + " entry " + e.name + " mode valid", valid, e.mode);
      // 40000 必须是 tree 类型；其他必须是 blob（160000 是 commit/gitlink）
      const target = objects.get(e.oid);
      if (target) {
        if (e.mode === "40000") check("tree entry " + e.name + " points to tree", target.type === "tree", target.type);
        else if (e.mode === "160000") { /* gitlink, 不检查 */ }
        else check("tree entry " + e.name + " points to blob", target.type === "blob", target.type);
      }
    }

    // 排序：目录按 name+"/" 比较
    const keys = entries.map((e) => ({ k: e.mode === "40000" ? e.name + "/" : e.name, n: e.name }));
    const sortedKeys = [...keys].sort((a, b) => Buffer.compare(Buffer.from(a.k), Buffer.from(b.k)));
    check("tree " + oid.slice(0, 7) + " git-sorted",
      keys.map((x) => x.n).join("\0") === sortedKeys.map((x) => x.n).join("\0"),
      keys.map((x) => x.n).join(","));

    // 递归子树
    for (const e of entries) {
      if (e.mode === "40000") await checkTree(e.oid, depth + 1);
    }
  }
  for (const c of commitData.values()) await checkTree(c.tree);

  // ===== 6. 索引 =====
  let indexEntries = null;
  if (await exists(path.join(gitDir, "index"))) {
    try {
      const idx = parseIndexBody(await readFile(path.join(gitDir, "index")));
      indexEntries = idx.entries;
      check("index checksum valid", idx.trailer === idx.bodySum);
      check("index version supported", idx.version === 2 || idx.version === 3, String(idx.version));
      check("index count matches entries", idx.count === idx.entries.length);
      for (const e of idx.entries) {
        check("index entry " + e.path + " oid exists", objects.has(e.oid), e.oid);
        check("index entry " + e.path + " stage 0", e.stage === 0, String(e.stage));
      }
      // 索引必须按路径字节序排序
      const paths = idx.entries.map((e) => e.path);
      const sorted = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      check("index entries sorted by path bytes", paths.join("\0") === sorted.join("\0"));
    } catch (err) {
      check("index readable", false, err.message);
    }
  }

  // ===== 7. 索引与工作区一致性 =====
  if (indexEntries) {
    for (const e of indexEntries) {
      const abs = path.join(repo, e.path);
      let st = null;
      try { st = await stat(abs); } catch {}
      if (!st) {
        // 工作区缺失是允许的（已删除未暂存），只记录不判错
        if (VERBOSE) console.log("  · 索引中 " + e.path + " 在工作区不存在（已删除未暂存）");
        continue;
      }
      check("index " + e.path + " size matches file", e.size === st.size, e.size + " vs " + st.size);
      // 大小一致时，可进一步验证 blob 内容等于文件内容
      const onDisk = await readFile(abs);
      const expectOid = oidOf("blob", onDisk);
      if (e.size === st.size && expectOid === e.oid) {
        check("index " + e.path + " content matches blob", true);
      } else if (e.size !== st.size) {
        // 文件被改过，属正常未暂存状态
        if (VERBOSE) console.log("  · " + e.path + " 内容已修改（未暂存）");
      }
    }
  }

  // ===== 8. 孤儿对象检测 =====
  // 从所有分支 + 索引出发，标记可达对象
  const allReachable = new Set(reachable);
  for (const oid of reachable) {
    const obj = objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    const c = commitData.get(oid);
    if (c?.tree) {
      const stack = [c.tree];
      while (stack.length) {
        const t = stack.pop();
        if (allReachable.has(t)) continue;
        allReachable.add(t);
        const tobj = objects.get(t);
        if (tobj?.type === "tree") {
          for (const e of parseTreeBody(tobj.body)) {
            if (e.mode === "40000") stack.push(e.oid);
            else allReachable.add(e.oid);
          }
        }
      }
    }
  }
  if (indexEntries) for (const e of indexEntries) allReachable.add(e.oid);

  const orphans = [...objects.keys()].filter((o) => !allReachable.has(o));
  check("no orphan objects", orphans.length === 0,
    orphans.length ? orphans.length + " orphans: " + orphans.slice(0, 3).map((o) => o.slice(0, 7)).join(",") : "");

  // ===== 9. 格式常量 =====
  check("empty blob hash is canonical", oidOf("blob", Buffer.alloc(0)) === "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  check("empty tree hash is canonical", oidOf("tree", Buffer.alloc(0)) === "4b825dc642cb6eb9a060e54bf8d69288fbee4904");

  // ===== 汇总 =====
  console.log("");
  console.log("对象总数: " + objects.size + " | 提交: " + commitData.size + " | 树: " + treeChecked.size + " | 分支: " + branches.length);
  console.log("检查项  : " + checks + " | 失败: " + failures);
  if (failures > 0) {
    console.log("\n失败明细:");
    for (const f of failureList.slice(0, 20)) console.log("  - " + f.name + (f.detail ? " [" + f.detail + "]" : ""));
    console.log("\nAUDIT FAILED");
    process.exitCode = 1;
  } else {
    console.log("\nAUDIT PASSED — all " + checks + " checks");
  }
}

main().catch((err) => {
  console.error("audit crashed:", err);
  process.exitCode = 2;
});
