// clone / fetch：从远程仓库抓取对象并落地为本地仓库。
//
// 这是本项目从「只能操作本地」到「能和真实世界交互」的分界线。
//
// 完整流程：
//   1. 读服务端广告，拿到引用列表与能力集
//   2. 发 want/have 协商，取回 packfile
//   3. 把 pack 与 idx 落盘（pack 以内容哈希命名）
//   4. 创建远程分支引用、设置 HEAD
//   5. clone 时把 HEAD 的 tree 检出到工作区
//
// 几个必须做对的地方：
//
//   · pack 必须以内容哈希命名：pack-<sha>.pack，sha 是「文件内容去掉尾部
//     20 字节」的 sha1。名字与内容不符，真 git 会认定损坏。
//
//   · idx 必须自己重建。服务端只发 pack，不发 idx。
//     重建需要每个对象的偏移与「对象头+压缩数据」的 CRC32。
//
//   · 引用分层：远程分支在 refs/remotes/<remote>/<branch>，
//     clone 时还要创建本地分支 refs/heads/<branch>。

import { mkdir, writeFile, rm, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { fetchAdvertisement, fetchPack, resolveWantRefs } from "../transport/smart-http.js";
import { resolvePackObjects, listPackEntries } from "../pack/reader.js";
import { buildIdx, crc32 } from "../pack/writer.js";
import { writeRef, setHeadSymref, deleteRef } from "../refs.js";
import { clearPackCache, readObject } from "../objects.js";
import { flattenTree } from "../tree.js";
import { readCommit } from "../commit.js";
import { writeIndex, entryFromStat, emptyIndex } from "../index-file.js";
import { initRepo } from "../repo.js";

// 把 pack 落盘，并从零重建 idx
export async function storePack(gitDir, packBuf) {
  if (packBuf.length < 32) throw new Error("收到的 pack 太短，不是合法 pack");

  // 尾部 20 字节是 sha1(前面全部内容)
  const body = packBuf.subarray(0, packBuf.length - 20);
  const computed = createHash("sha1").update(body).digest("hex");
  const trailer = packBuf.subarray(packBuf.length - 20).toString("hex");
  if (computed !== trailer) {
    throw new Error(
      "收到的 pack 校验和不匹配（计算 " + computed.slice(0, 8) +
      "，文件内 " + trailer.slice(0, 8) + "），数据可能已损坏"
    );
  }

  const packDir = path.join(gitDir, "objects", "pack");
  await mkdir(packDir, { recursive: true });
  const name = "pack-" + computed;
  await writeFile(path.join(packDir, name + ".pack"), packBuf);

  // 重建 idx：每个对象需要 (sha, offset, crc)
  const { entries } = listPackEntries(packBuf);
  const idxEntries = entries.map((e) => ({
    sha: e.oid,
    offset: e.offset,
    crc: crc32(e.bytes),
    type: "unknown",   // idx 不记录类型
    content: null,
  }));
  const idx = buildIdx(idxEntries, Buffer.from(computed, "hex"));
  await writeFile(path.join(packDir, name + ".idx"), idx);

  clearPackCache();
  return { sha: computed, name, objectCount: entries.length, packSize: packBuf.length };
}

// 删除已有的 pack（clone 时清理不完整状态）
async function clearPacks(gitDir) {
  const packDir = path.join(gitDir, "objects", "pack");
  try {
    for (const f of await readdir(packDir)) {
      await rm(path.join(packDir, f), { force: true });
    }
  } catch {}
  clearPackCache();
}

// 检出提交的 tree 到工作区，**并建立索引**。
//
// 索引不能是空的：status 靠它判断「文件是否被跟踪」。
// 空的索引会让 status 把刚检出的 171 个文件全报成「已删除」，
// 而且第一次 commit 会把它们全当成新增——工作区看起来正常，
// 但仓库状态完全错了。
async function checkoutFromPack(gitDir, rootDir, commitOid) {
  const commit = await readCommit(gitDir, commitOid);
  const files = await flattenTree(gitDir, commit.tree);

  const index = emptyIndex();
  for (const [rel, entry] of files) {
    const abs = path.join(rootDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    const { content } = await readObject(gitDir, entry.oid);
    await writeFile(abs, content);

    // 每个检出文件都要登记进索引，并带上磁盘 stat
    let st;
    try {
      st = await stat(abs);
    } catch {
      st = null;
    }
    const mode = typeof entry.mode === "number" ? entry.mode : parseInt(entry.mode, 8);
    if (st) {
      index.entries.push(entryFromStat(rel, entry.oid, mode, st));
    } else {
      // 无 stat 时仍要登记，否则文件等于没被跟踪
      index.entries.push({
        path: rel,
        oid: entry.oid,
        mode,
        stage: 0,
        stat: {
          ctime: 0, ctimeNano: 0, mtime: 0, mtimeNano: 0,
          dev: 0, ino: 0, uid: 0, gid: 0, size: content.length,
        },
      });
    }
  }

  // 索引条目必须按 path 排序（二进制格式要求）。
  // 用 Buffer 比较而不是 localeCompare：'.' 和 '/' 的顺序在两者下不同。
  index.entries.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  await writeIndex(gitDir, index);
  return files.size;
}

// 把广告里的分支挑出来，决定要建哪些引用
function pickBranches(refs) {
  const out = [];
  for (const [ref, oid] of refs) {
    if (ref.startsWith("refs/heads/")) {
      out.push({ branch: ref.slice("refs/heads/".length), ref, oid });
    }
  }
  return out;
}

// clone：初始化 + 抓取 + 检出
export async function clone(url, targetDir, options = {}) {
  const { branch = null, depth = null, auth = null, onProgress = null } = options;

  const say = (msg) => { if (onProgress) onProgress(msg); };

  say("读取远程引用...");
  const adv = await fetchAdvertisement(url, { auth });
  if (adv.refs.size === 0) throw new Error("远程仓库是空的（没有任何引用）");

  const branches = pickBranches(adv.refs);
  if (branches.length === 0) throw new Error("远程仓库没有分支");

  // 决定要 clone 哪个分支
  let target = branch;
  if (!target) {
    const headRef = adv.headTarget ?? "refs/heads/main";
    target = headRef.replace("refs/heads/", "");
    if (!branches.some((b) => b.branch === target)) target = branches[0].branch;
  }
  const chosen = branches.find((b) => b.branch === target);
  if (!chosen) throw new Error("远程没有分支: " + target);

  say("协商并下载对象（分支 " + target + "）...");
  const fetched = await fetchPack(url, {
    wants: [chosen.oid],
    haves: [],
    capabilities: adv.capabilities,
    depth,
    auth,
  });

  if (!fetched.pack) throw new Error("服务端没有返回 packfile");

  // 初始化仓库
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  const gitDir = await initRepo(targetDir);
  await clearPacks(gitDir);

  say("写入 pack 并重建索引（" + (fetched.pack.length / 1024).toFixed(0) + " KB）...");
  const stored = await storePack(gitDir, fetched.pack);

  const resolved = resolvePackObjects(fetched.pack);
  const types = { commit: 0, tree: 0, blob: 0, tag: 0 };
  for (const [, o] of resolved.byOid) types[o.type] = (types[o.type] ?? 0) + 1;

  say("创建引用...");
  for (const b of branches) {
    await writeRef(gitDir, "refs/remotes/origin/" + b.branch, b.oid);
    // 本地只建选中分支，其余留作远程分支
    if (b.branch === target) {
      await writeRef(gitDir, "refs/heads/" + target, b.oid);
    }
  }
  await setHeadSymref(gitDir, "refs/heads/" + target);

  say("检出工作区...");
  const fileCount = await checkoutFromPack(gitDir, targetDir, chosen.oid);

  return {
    gitDir,
    branch: target,
    head: chosen.oid,
    fileCount,
    packName: stored.name,
    packSize: stored.packSize,
    objectCount: resolved.byOid.size,
    types,
    remoteBranches: branches.map((b) => b.branch),
  };
}

// fetch：更新已有仓库的远程分支与对象
export async function fetch(gitDir, rootDir, url, options = {}) {
  const { remote = "origin", auth = null, onProgress = null } = options;
  const say = (msg) => { if (onProgress) onProgress(msg); };

  say("读取远程引用...");
  const adv = await fetchAdvertisement(url, { auth });
  const branches = pickBranches(adv.refs);
  if (branches.length === 0) throw new Error("远程仓库没有分支");

  // 收集本地已有的提交，用于协商时减少传输
  const haves = await collectLocalCommits(gitDir);
  say("本地已有 " + haves.length + " 个提交，参与协商");

  const wants = branches.map((b) => b.oid).filter((oid) => !haves.includes(oid));

  let stored = null;
  let objectCount = 0;
  if (wants.length > 0) {
    say("下载缺失对象...");
    const fetched = await fetchPack(url, {
      wants,
      haves,
      capabilities: adv.capabilities,
      auth,
    });
    if (fetched.pack) {
      stored = await storePack(gitDir, fetched.pack);
      const resolved = resolvePackObjects(fetched.pack);
      objectCount = resolved.byOid.size;
    }
  }

  // 更新远程分支引用
  let updated = 0;
  for (const b of branches) {
    const ref = "refs/remotes/" + remote + "/" + b.branch;
    await writeRef(gitDir, ref, b.oid);
    updated += 1;
  }

  return {
    remote,
    branches: updated,
    newObjects: objectCount,
    packName: stored?.name ?? null,
    packSize: stored?.packSize ?? 0,
    negotiated: wants.length === 0,
  };
}

// 收集本地所有可达提交 oid（协商用）
async function collectLocalCommits(gitDir) {
  const { execFile } = await import("node:child_process");
  void execFile;
  const seen = new Set();
  const out = [];

  const { listBranches, readRef } = await import("../refs.js");
  const branchNames = await listBranches(gitDir);
  const tips = [];
  for (const name of branchNames) {
    const oid = await readRef(gitDir, "refs/heads/" + name);
    if (oid) tips.push(oid);
    const remoteOid = await readRef(gitDir, "refs/remotes/origin/" + name);
    if (remoteOid) tips.push(remoteOid);
  }

  const { readCommit } = await import("../commit.js");
  async function walk(oid) {
    if (!oid || seen.has(oid)) return;
    seen.add(oid);
    out.push(oid);
    let c;
    try { c = await readCommit(gitDir, oid); } catch { return; }
    for (const p of c.parents) {
      if (!seen.has(p)) await walk(p);
    }
  }
  for (const t of tips) await walk(t);
  return out;
}
