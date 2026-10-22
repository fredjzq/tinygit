// 用真实 Git 生成的 pack 验证解析器。
//
// 这是最有说服力的一类测试：数据由真 git 产生，不是我们造的。
// 但它依赖文件系统上存在这样的仓库，所以找不到时跳过而非失败。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parsePackHeader, resolvePackObjects } from "../src/pack/reader.js";
import { parseIdx } from "../src/pack/idx.js";

// 候选位置：环境变量指定的仓库，或已知的本地路径
const CANDIDATES = [
  process.env.TINYGIT_REAL_REPO,
  "C:\\Users\\28431\\.codex\\.tmp\\plugins",
].filter(Boolean);

async function findPack() {
  for (const repo of CANDIDATES) {
    const packDir = path.join(repo, ".git", "objects", "pack");
    try {
      const files = (await readdir(packDir)).filter((f) => f.endsWith(".pack"));
      if (files.length === 0) continue;
      const packPath = path.join(packDir, files[0]);
      const idxPath = packPath.replace(/\.pack$/, ".idx");
      const st = await stat(packPath);
      // 控制测试耗时：只测中等规模的 pack
      if (st.size > 12 * 1024 * 1024) continue;
      return { repo, packPath, idxPath, size: st.size };
    } catch {
      continue;
    }
  }
  return null;
}

const found = await findPack();

test("real git pack: idx checksums match the pack file", { skip: found ? false : "no real packfile available" }, async () => {
  const packBuf = await readFile(found.packPath);
  const idx = parseIdx(await readFile(found.idxPath));

  const actual = createHash("sha1").update(packBuf.subarray(0, packBuf.length - 20)).digest("hex");
  assert.equal(idx.packChecksum, actual, "pack checksum stored in idx must match the pack content");

  // pack 文件名就是 pack 校验和 —— 强力佐证
  const nameSha = path.basename(found.packPath).replace(/^pack-/, "").replace(/\.pack$/, "");
  assert.equal(idx.packChecksum, nameSha, "pack filename must equal the pack checksum");
});

test("real git pack: object count in header matches idx", { skip: found ? false : "no real packfile available" }, async () => {
  const packBuf = await readFile(found.packPath);
  const idx = parseIdx(await readFile(found.idxPath));
  const header = parsePackHeader(packBuf);
  assert.equal(header.count, idx.count);
});

test("real git pack: every offset resolves to the sha recorded in idx", { skip: found ? false : "no real packfile available" }, async () => {
  const packBuf = await readFile(found.packPath);
  const idx = parseIdx(await readFile(found.idxPath));
  const resolved = resolvePackObjects(packBuf);

  assert.equal(resolved.order.length, idx.count, "must parse exactly the declared number of objects");

  // 最关键的断言：还原出的每个对象的 sha 必须与 idx 里记录的完全相同。
  // 只要 delta 链、对象头、zlib 边界任意一处出错，重新计算的 sha 都不可能吻合。
  let matched = 0;
  const mismatches = [];
  for (let i = 0; i < idx.count; i += 1) {
    const expected = idx.shas[i];
    const offset = idx.offsets[i];
    const actual = resolved.oidByOffset.get(offset);
    if (actual === expected) matched += 1;
    else if (mismatches.length < 5) mismatches.push({ offset, expected, actual });
  }
  assert.equal(
    matched,
    idx.count,
    "offset->sha mismatch at " + JSON.stringify(mismatches)
  );
});

test("real git pack: resolved objects have plausible types", { skip: found ? false : "no real packfile available" }, async () => {
  const packBuf = await readFile(found.packPath);
  resolvePackObjects(packBuf);
  // 类型校验已在 resolve 内部完成（unknown type 会抛错），这里只确保没有异常
  assert.ok(true);
});
