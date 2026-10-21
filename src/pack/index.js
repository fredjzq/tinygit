// pack 子系统入口：统一「松散对象 / 打包对象」两种存储的读取。
//
// 真 Git 的仓库里，对象可能同时在松散区和 pack 里（松散对象优先），
// 也可能只在 pack 里（clone 之后的常态）。上层不应关心区别。

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { resolvePackObjects } from "./reader.js";
import { parseIdx, findOffset } from "./idx.js";
import { computeOid } from "./writer.js";

export { buildPack, buildIdx, computeOid, crc32 } from "./writer.js";
export { parsePack, parsePackHeader, readObjectHeader, resolvePackObjects, OBJ_TYPES } from "./reader.js";
export { parseIdx, findOffset, fanoutRange } from "./idx.js";
export { applyDelta } from "./delta.js";
export { readOffsetVarint, readSizeVarint, encodeOffsetVarint, encodeSizeVarint } from "./varint.js";

// 找出 .git/objects/pack 下所有 pack 文件对
export async function listPacks(gitDir) {
  const packDir = path.join(gitDir, "objects", "pack");
  let entries;
  try { entries = await readdir(packDir); } catch { return []; }
  const packs = [];
  for (const name of entries) {
    if (!name.endsWith(".idx")) continue;
    const base = name.slice(0, -4);
    const packPath = path.join(packDir, base + ".pack");
    const idxPath = path.join(packDir, base + ".idx");
    let packStat;
    try { packStat = await stat(packPath); } catch { continue; }
    packs.push({ base, idxPath, packPath, size: packStat.size });
  }
  return packs;
}

// 带缓存的 pack 读取器。解析一个 pack 要把所有对象解压，开销大，
// 所以整个进程生命周期内只解析一次。
export function createPackRepository(gitDir) {
  const cache = new Map();  // base -> resolved
  let allObjects = null;

  async function loadAll() {
    if (allObjects) return allObjects;
    const packs = await listPacks(gitDir);
    const merged = new Map();
    for (const p of packs) {
      const buf = await readFile(p.packPath);
      const resolved = resolvePackObjects(buf);
      cache.set(p.base, resolved);
      for (const [oid, obj] of resolved.byOid) {
        if (!merged.has(oid)) merged.set(oid, obj);
      }
    }
    allObjects = merged;
    return merged;
  }

  return {
    async has(oid) {
      const objs = await loadAll();
      return objs.has(oid);
    },
    async get(oid) {
      const objs = await loadAll();
      return objs.get(oid) ?? null;
    },
    async list() {
      const objs = await loadAll();
      return [...objs.keys()];
    },
    async packFiles() {
      return listPacks(gitDir);
    },
    async stats() {
      const packs = await listPacks(gitDir);
      const objs = await loadAll();
      const byType = {};
      for (const obj of objs.values()) byType[obj.type] = (byType[obj.type] ?? 0) + 1;
      return { packCount: packs.length, objectCount: objs.size, byType, totalBytes: packs.reduce((n, p) => n + p.size, 0) };
    },
  };
}
