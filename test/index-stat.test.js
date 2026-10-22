// 索引与真实文件的一致性。
//
// 真 git 的 status 做「racy git」优化：对比索引里缓存的 mtime/size 与文件实际值，
// 一致就跳过内容比较。如果这里写错，git 会把干净文件误报为 modified，
// 用户看到的就是「刚提交完就显示有改动」。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, stat, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initRepo } from "../src/repo.js";
import { add } from "../src/commands/add.js";
import { readIndex } from "../src/index-file.js";

const TMP_ROOT = (() => {
  try {
    const d = os.tmpdir();
    if (d && !d.includes("undefined")) return d;
  } catch {}
  return process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp";
})();

async function withRepo(fn) {
  const dir = await mkdtemp(path.join(TMP_ROOT, "tinygit-stat-"));
  try {
    const gitDir = await initRepo(dir);
    await fn({ dir, gitDir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("index caches the real file size", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    const file = path.join(dir, "a.txt");
    await writeFile(file, "hello world\n");  // 12 字节
    await add(gitDir, dir, ["."]);
    const idx = await readIndex(gitDir);
    const entry = idx.entries.find((e) => e.path === "a.txt");
    assert.equal(entry.stat.size, 12);
  });
});

test("index caches a plausible mtime", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    const file = path.join(dir, "a.txt");
    await writeFile(file, "x");
    const before = Math.floor((await stat(file)).mtimeMs / 1000);
    await add(gitDir, dir, ["."]);
    const idx = await readIndex(gitDir);
    const entry = idx.entries.find((e) => e.path === "a.txt");
    const after = Math.floor((await stat(file)).mtimeMs / 1000);
    // 允许 1 秒误差（u32 秒级精度，跨秒边界时 before/after 可能不同）
    assert.ok(Math.abs(entry.stat.mtime - before) <= 1, "mtime " + entry.stat.mtime + " vs " + before);
    assert.ok(Math.abs(entry.stat.mtime - after) <= 1);
  });
});

test("index mode is full st_mode so git can round-trip it", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    const file = path.join(dir, "a.txt");
    await writeFile(file, "x");
    await add(gitDir, dir, ["."]);
    const idx = await readIndex(gitDir);
    const entry = idx.entries.find((e) => e.path === "a.txt");
    // 普通文件必须是 100644（十进制 33188）
    assert.equal(entry.mode, 0o100644);
  });
});

test("staged file unchanged on disk keeps the same blob oid", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    const file = path.join(dir, "a.txt");
    await writeFile(file, "stable\n");
    await add(gitDir, dir, ["."]);
    const first = (await readIndex(gitDir)).entries[0].oid;
    await add(gitDir, dir, ["."]);  // 再暂存一次
    const second = (await readIndex(gitDir)).entries[0].oid;
    assert.equal(first, second, "re-adding identical content must not change the oid");
  });
});

test("index entry order is byte-sorted, matching git", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    for (const name of ["z.txt", "a.txt", "m.txt"]) {
      await writeFile(path.join(dir, name), name);
    }
    await add(gitDir, dir, ["."]);
    const idx = await readIndex(gitDir);
    assert.deepEqual(idx.entries.map((e) => e.path), ["a.txt", "m.txt", "z.txt"]);
  });
});
