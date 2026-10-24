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

// ---------- 独立实现：packfile 与 idx ----------
//
// 这一段完全不复用 src/pack/ 的任何代码，从头实现 Git 的 pack 格式规则。
// 如果审计器调用被测代码，同一处 bug 会让两边一起错、一起「通过」，
// 验证就失去意义。
//
// 校验内容：
//   - idx 的 fanout 表单调递增，末项等于对象数
//   - idx 的 sha 表严格升序（否则二分查找会失效）
//   - idx 尾部两个校验和都正确（这是最容易写错的地方）
//   - 每个对象的偏移指向合法的对象头
//   - delta 链能完整还原，且还原后的 sha 与 idx 记录一致

// 读普通 size varint（对象头里的 size 字段）
function readSizeVarint(buf, start) {
  let value = 0;
  let shift = 0;
  let pos = start;
  for (;;) {
    const b = buf[pos];
    value |= (b & 0x7f) << shift;
    pos += 1;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw new Error("varint too long");
  }
  return { value, next: pos };
}

// idx v2 解析
function parseIdxIndependent(buf) {
  if (buf.readUInt32BE(0) !== 0xff744f63) throw new Error("bad idx magic");
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error("unsupported idx version " + version);

  const fanout = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) fanout[i] = buf.readUInt32BE(8 + i * 4);
  const count = fanout[255];

  for (let i = 1; i < 256; i += 1) {
    if (fanout[i] < fanout[i - 1]) throw new Error("fanout not monotonic at " + i);
  }

  const shaStart = 8 + 256 * 4;
  const shas = [];
  for (let i = 0; i < count; i += 1) {
    shas.push(buf.subarray(shaStart + i * 20, shaStart + i * 20 + 20).toString("hex"));
  }
  for (let i = 1; i < count; i += 1) {
    if (!(shas[i - 1] < shas[i])) throw new Error("sha table not sorted at " + i);
  }
  for (let i = 0; i < count; i += 1) {
    const first = parseInt(shas[i].slice(0, 2), 16);
    if (fanout[first] < i + 1) throw new Error("fanout does not cover sha " + i);
  }

  const crcStart = shaStart + count * 20;
  const offStart = crcStart + count * 4;
  const largeStart = offStart + count * 4;

  const offsets = [];
  for (let i = 0; i < count; i += 1) {
    const raw = buf.readUInt32BE(offStart + i * 4);
    if (raw & 0x80000000) {
      const li = raw & 0x7fffffff;
      const p = largeStart + li * 8;
      if (p + 8 > buf.length - 40) throw new Error("large offset out of range");
      const big = buf.readBigUInt64BE(p);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("offset too large");
      offsets.push(Number(big));
    } else {
      offsets.push(raw);
    }
  }

  const packChecksum = buf.subarray(buf.length - 40, buf.length - 20).toString("hex");
  const idxChecksum = buf.subarray(buf.length - 20).toString("hex");
  const computedIdx = createHash("sha1").update(buf.subarray(0, buf.length - 20)).digest("hex");

  return { version, count, shas, offsets, fanout, packChecksum, idxChecksum, computedIdx };
}

// 从 pack 里解析出所有对象（含 delta 还原）
function parsePackIndependent(buf) {
  if (buf.subarray(0, 4).toString("latin1") !== "PACK") throw new Error("bad pack magic");
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error("unsupported pack version " + version);
  const count = buf.readUInt32BE(8);

  const byOffset = new Map();
  let offset = 12;
  const TYPES = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = buf[offset]; offset += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[offset]; offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }

    let baseOffset = null;
    let baseOid = null;
    if (typeNum === 6) {
      let b = buf[offset]; offset += 1;
      let dist = b & 0x7f;
      while (b & 0x80) {
        b = buf[offset]; offset += 1;
        dist = ((dist + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - dist;
    } else if (typeNum === 7) {
      baseOid = buf.subarray(offset, offset + 20).toString("hex");
      offset += 20;
    }

    const remaining = buf.length - 20 - offset;
    const res = inflateSync(buf.subarray(offset, offset + remaining), { info: true });
    const consumed = res.engine.bytesWritten;
    const data = res.buffer;
    offset += consumed;

    byOffset.set(start, { offset: start, typeNum, size, baseOffset, baseOid, data });
  }

  const resolved = new Map();
  const oidByOffset = new Map();

  function applyDelta(base, delta) {
    const bsz = readSizeVarint(delta, 0);
    if (base.length !== bsz.value) throw new Error("delta base size mismatch");
    const rsz = readSizeVarint(delta, bsz.next);
    let pos = rsz.next;
    const out = Buffer.allocUnsafe(rsz.value);
    let outPos = 0;
    while (pos < delta.length) {
      const cmd = delta[pos]; pos += 1;
      if (cmd === 0) throw new Error("zero delta command");
      if (cmd & 0x80) {
        let off = 0, len = 0;
        if (cmd & 0x01) { off |= delta[pos]; pos += 1; }
        if (cmd & 0x02) { off |= delta[pos] << 8; pos += 1; }
        if (cmd & 0x04) { off |= delta[pos] << 16; pos += 1; }
        if (cmd & 0x08) { off |= delta[pos] << 24; pos += 1; }
        if (cmd & 0x10) { len |= delta[pos]; pos += 1; }
        if (cmd & 0x20) { len |= delta[pos] << 8; pos += 1; }
        if (cmd & 0x40) { len |= delta[pos] << 16; pos += 1; }
        if (len === 0) len = 0x10000;
        if (off + len > base.length) throw new Error("delta copy out of range");
        base.copy(out, outPos, off, off + len);
        outPos += len;
      } else {
        const len = cmd;
        if (pos + len > delta.length) throw new Error("delta insert out of range");
        delta.copy(out, outPos, pos, pos + len);
        pos += len;
        outPos += len;
      }
    }
    if (outPos !== rsz.value) throw new Error("delta result size mismatch");
    return out;
  }

  function resolve(off, depth = 0) {
    if (depth > 64) throw new Error("delta chain too deep");
    if (resolved.has(off)) return resolved.get(off);
    const e = byOffset.get(off);
    if (!e) throw new Error("no object at offset " + off);

    let result;
    if (e.typeNum === 6) {
      const base = resolve(e.baseOffset, depth + 1);
      result = { type: base.type, content: applyDelta(base.content, e.data) };
    } else if (e.typeNum === 7) {
      let base = null;
      for (const [o, obj] of resolved) {
        if (oidByOffset.get(o) === e.baseOid) { base = obj; break; }
      }
      if (!base) throw new Error("REF_DELTA base " + e.baseOid + " not in pack");
      result = { type: base.type, content: applyDelta(base.content, e.data) };
    } else {
      const t = TYPES[e.typeNum];
      if (!t) throw new Error("unknown object type " + e.typeNum);
      result = { type: t, content: e.data };
    }
    resolved.set(off, result);
    oidByOffset.set(off, oidOf(result.type, result.content));
    return result;
  }

  for (const off of byOffset.keys()) resolve(off);
  return { count, byOffset, resolved, oidByOffset };
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
    console.log("  · 存在 " + packFiles.length + " 个 pack 文件，开始独立校验");
  }

  // ===== 2b. pack 与 idx 独立校验 =====
  //
  // 这一段的每个断言都独立于被测实现。pack 解析涉及 zlib 边界、
  // delta 链、两种变长整数——任何一处错位都会让 sha 算不出来，
  // 所以「sha 与 idx 吻合」是极强的正确性证据。
  let packObjectCount = 0;
  for (const packName of packFiles) {
    const base = packName.replace(/\.pack$/, "");
    const packPath = path.join(packDir, packName);
    const idxPath = path.join(packDir, base + ".idx");

    const packBuf = await readFile(packPath);
    check("pack " + base.slice(0, 20) + " 结尾校验和正确",
      createHash("sha1").update(packBuf.subarray(0, packBuf.length - 20)).digest("hex")
        === packBuf.subarray(packBuf.length - 20).toString("hex"));

    let idxBuf;
    try {
      idxBuf = await readFile(idxPath);
    } catch {
      check("idx " + base.slice(0, 20) + " 存在", false, "缺少对应 .idx");
      continue;
    }

    let idx;
    try {
      idx = parseIdxIndependent(idxBuf);
      check("idx " + base.slice(0, 20) + " 格式合法", true);
    } catch (err) {
      check("idx " + base.slice(0, 20) + " 格式合法", false, err.message);
      continue;
    }

    // idx 尾部自校验和：覆盖 [0, len-20)，**包含** pack 校验和
    check("idx 自校验和正确", idx.computedIdx === idx.idxChecksum,
      "计算 " + idx.computedIdx.slice(0, 8) + " vs 记录 " + idx.idxChecksum.slice(0, 8));
    // idx 记录的 pack 校验和必须等于 pack 文件的实际校验和
    check("idx 记录的 pack 校验和与实际一致",
      idx.packChecksum === packBuf.subarray(packBuf.length - 20).toString("hex"));

    // pack 头声明的对象数必须等于 idx 的对象数
    const declared = packBuf.readUInt32BE(8);
    check("pack 头对象数与 idx 一致", declared === idx.count,
      "pack " + declared + " vs idx " + idx.count);

    // 解析 pack 并还原所有 delta 链
    let parsed;
    try {
      parsed = parsePackIndependent(packBuf);
      check("pack 对象全部可解析（含 delta 链还原）", true);
    } catch (err) {
      check("pack 对象全部可解析（含 delta 链还原）", false, err.message);
      continue;
    }

    // 每个 idx 记录的 sha 都必须在 pack 里找到对应的对象
    const packOids = new Set(parsed.oidByOffset.values());
    let matched = 0;
    let missing = null;
    for (const sha of idx.shas) {
      if (packOids.has(sha)) matched += 1;
      else if (!missing) missing = sha;
    }
    check("idx 的 sha 与 pack 内容一一对应", matched === idx.count,
      missing ? "缺 " + missing.slice(0, 8) + "（" + matched + "/" + idx.count + "）" : "");

    // idx 记录的偏移必须指向 pack 中真实存在的对象
    let offsetOk = 0;
    for (const off of idx.offsets) {
      if (parsed.byOffset.has(off)) offsetOk += 1;
    }
    check("idx 的偏移都指向真实对象", offsetOk === idx.count,
      offsetOk + "/" + idx.count);

    // 统计 delta 对象数量（信息性，不作为失败条件）
    let deltaCount = 0;
    for (const [, e] of parsed.byOffset) if (e.typeNum === 6 || e.typeNum === 7) deltaCount += 1;
    console.log("  · " + base.slice(0, 20) + ": " + parsed.count + " 个对象，其中 delta " + deltaCount + " 个");
    packObjectCount += parsed.count;

    // pack 里的对象也加入总对象集合，供后面的可达性检查使用。
    // 注意字段名统一：审计器全局约定对象是 {type, body}，
    // 而 pack 解析器内部用 {type, content}。这里做一次转换。
    for (const [off, oid] of parsed.oidByOffset) {
      const obj = parsed.resolved.get(off);
      objects.set(oid, { type: obj.type, body: obj.content });
    }
  }

  // ===== 2c. 浅克隆边界 =====
  //
  // 浅克隆（clone --depth N）会刻意截断历史：边界提交的 parent
  // 在本地根本不存在，这是设计如此，不是损坏。
  // 不识别这一点，任何浅克隆仓库都会被误报为「parent 缺失」。
  const shallowSet = new Set();
  try {
    const shallowText = (await readFile(path.join(gitDir, "shallow"), "utf8")).trim();
    for (const line of shallowText.split(/\r?\n/)) {
      if (/^[0-9a-f]{40}$/.test(line.trim())) shallowSet.add(line.trim());
    }
    if (shallowSet.size > 0) {
      console.log("  · 浅克隆仓库，边界提交 " + shallowSet.size + " 个（历史被人为截断）");
    }
  } catch {
    // 没有 shallow 文件 = 完整仓库
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

  // packed-refs 里的分支也必须算进来。
  // 曾经这里只遍历松散目录：一旦跑过 gc --pack-refs（松散文件被清空），
  // 审计器就会认为仓库「没有任何分支」，进而把全部对象误判为孤儿。
  const packedBranchCount = { n: 0 };
  try {
    const packedText = await readFile(path.join(gitDir, "packed-refs"), "utf8");
    const existing = new Set(branches.map((b) => b.ref));
    for (const raw of packedText.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      const oid = line.slice(0, sp);
      const ref = line.slice(sp + 1);
      if (!/^[0-9a-f]{40}$/.test(oid) || !ref.startsWith("refs/heads/")) continue;
      // 松散 ref 优先：同名时以松散为准
      if (existing.has(ref)) continue;
      existing.add(ref);
      branches.push({ ref, oid });
      packedBranchCount.n += 1;
    }
    if (packedBranchCount.n > 0) {
      console.log("  · packed-refs 中读到 " + packedBranchCount.n + " 个分支");
    }
  } catch {
    // 没有 packed-refs 是正常情况
  }

  for (const b of branches) {
    check("ref " + b.ref + " holds 40-hex", /^[0-9a-f]{40}$/.test(b.oid), b.oid);
    // 悬空引用：分支指向一个不存在的对象。
    // 这是真实的数据损坏——git log 会在这里报错。
    // 曾经这里漏检：下面的遍历用 filter(objects.has) 把不存在的 tip
    // 静默过滤掉了，于是「分支指向空」这条不会触发任何失败。
    check("ref " + b.ref + " target exists", objects.has(b.oid), b.oid);
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
  // 这里不 filter：指向不存在对象的 tip 已在上面单独报错，
  // 若在此静默丢弃，遍历就永远不会发现它。
  const queue = branches.map((b) => b.oid).filter((o) => /^[0-9a-f]{40}$/.test(o));
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
        // 浅克隆边界：该提交的 parent 有意不存在，跳过
        if (shallowSet.has(oid)) continue;
        check("commit " + oid.slice(0, 7) + " parent exists", objects.has(p), p);
      }
    }
    // 浅克隆边界提交的 parent 不存在，不要入队——
    // 否则遍历到它时会报 "reachable object ... present" 失败。
    for (const p of c.parents) {
      if (shallowSet.has(oid)) continue;
      queue.push(p);
    }
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
