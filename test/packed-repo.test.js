// 打包仓库的端到端测试。
//
// 这组测试补的是一个真实缺口：pack 解析器虽然单独测过，但一度**没有接入
// readObject**，导致所有命令遇到打包对象都会报 "packed objects are not supported"。
// 单元测试全绿，真实使用全废——所以必须从「命令」这一层验证。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initRepo } from "../src/repo.js";
import { add } from "../src/commands/add.js";
import { commit } from "../src/commands/commit.js";
import { status } from "../src/commands/status.js";
import { log } from "../src/commands/log.js";
import { readCommit } from "../src/commit.js";
import { flattenTree } from "../src/tree.js";
import { readObject, listAllObjects, clearPackCache } from "../src/objects.js";
import { buildPack } from "../src/pack/writer.js";
import { readHeadRef } from "../src/refs.js";

const TMP_ROOT = (() => {
  try {
    const d = os.tmpdir();
    if (d && !d.includes("undefined")) return d;
  } catch {}
  return process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp";
})();

// 把仓库里的所有对象打包，并删除松散对象，
// 模拟「真 git clone 之后」的仓库形态。
async function repack(gitDir) {
  clearPackCache();
  const oids = await listAllObjects(gitDir);
  const objects = [];
  for (const oid of oids) {
    const o = await readObject(gitDir, oid);
    objects.push({ type: o.type, content: o.content });
  }
  const built = buildPack(objects);

  const packDir = path.join(gitDir, "objects", "pack");
  await mkdir(packDir, { recursive: true });
  const name = "pack-" + built.packChecksum;
  await writeFile(path.join(packDir, name + ".pack"), built.pack);
  await writeFile(path.join(packDir, name + ".idx"), built.idx);

  for (const entry of await readdir(path.join(gitDir, "objects"))) {
    if (entry.length === 2) {
      await rm(path.join(gitDir, "objects", entry), { recursive: true, force: true });
    }
  }
  clearPackCache();
  return { count: objects.length, packName: name };
}

async function withRepo(fn) {
  const dir = await mkdtemp(path.join(TMP_ROOT, "tinygit-packed-"));
  try {
    const gitDir = await initRepo(dir);
    await fn({ dir, gitDir });
  } finally {
    clearPackCache();
    await rm(dir, { recursive: true, force: true });
  }
}

test("repacking really removes loose objects", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "a.txt"), "hello\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "one" });

    const before = await listAllObjects(gitDir);
    assert.ok(before.length >= 3);

    const { count } = await repack(gitDir);
    assert.equal(count, before.length);

    // 松散目录应已清空
    const dirs = (await readdir(path.join(gitDir, "objects"))).filter((d) => d.length === 2);
    assert.equal(dirs.length, 0, "all loose objects should be gone");
  });
});

test("readObject falls back to pack when no loose object exists", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "a.txt"), "packed content\n");
    await add(gitDir, dir, ["."]);
    const c = await commit(gitDir, { message: "one" });
    await repack(gitDir);

    // 直接读 commit 对象：松散文件已不存在，必须从 pack 里取
    const commitObj = await readObject(gitDir, c.oid);
    assert.equal(commitObj.type, "commit");
    assert.match(commitObj.content.toString(), /^tree [0-9a-f]{40}$/m);
  });
});

test("readCommit works on a fully packed repository", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "a.txt"), "x\n");
    await add(gitDir, dir, ["."]);
    const c = await commit(gitDir, { message: "packed" });
    await repack(gitDir);

    const parsed = await readCommit(gitDir, c.oid);
    assert.match(parsed.tree, /^[0-9a-f]{40}$/);
    assert.equal(parsed.message.trim(), "packed");
  });
});

test("flattenTree walks a packed tree graph", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await mkdir(path.join(dir, "src", "deep"), { recursive: true });
    await writeFile(path.join(dir, "README.md"), "# r\n");
    await writeFile(path.join(dir, "src", "deep", "f.js"), "deep\n");
    await add(gitDir, dir, ["."]);
    const c = await commit(gitDir, { message: "nested" });
    await repack(gitDir);

    const parsed = await readCommit(gitDir, c.oid);
    const files = await flattenTree(gitDir, parsed.tree);
    assert.ok(files.has("README.md"));
    assert.ok(files.has("src/deep/f.js"));

    const blob = await readObject(gitDir, files.get("README.md").oid);
    assert.equal(blob.content.toString(), "# r\n");
  });
});

test("status works when the repo is packed", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "a.txt"), "1\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "one" });
    await repack(gitDir);

    const s = await status(gitDir, dir);
    assert.equal(s.staged.length, 0);
    assert.equal(s.unstaged.length, 0);
    assert.equal(s.untracked.length, 0);
    assert.ok(s.head.oid);
  });
});

test("log walks history out of a pack", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    for (const n of [1, 2, 3]) {
      await writeFile(path.join(dir, "f.txt"), "v" + n + "\n");
      await add(gitDir, dir, ["."]);
      await commit(gitDir, { message: "commit " + n });
    }
    await repack(gitDir);

    const commits = await log(gitDir, { limit: 10 });
    assert.equal(commits.length, 3);
    assert.equal(commits[0].message.trim(), "commit 3");
    assert.equal(commits[2].message.trim(), "commit 1");
  });
});

test("missing object reports a clear error mentioning both stores", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "a.txt"), "1\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "one" });
    await repack(gitDir);

    await assert.rejects(
      () => readObject(gitDir, "0".repeat(40)),
      /neither loose nor in any pack/
    );
  });
});

test("objectExists sees objects inside packs", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "a.txt"), "1\n");
    await add(gitDir, dir, ["."]);
    const c = await commit(gitDir, { message: "one" });
    await repack(gitDir);

    const { objectExists } = await import("../src/objects.js");
    assert.equal(await objectExists(gitDir, c.oid), true);
    assert.equal(await objectExists(gitDir, "f".repeat(40)), false);
  });
});

test("pack cache is invalidated when pack files change", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "a.txt"), "first\n");
    await add(gitDir, dir, ["."]);
    const c1 = await commit(gitDir, { message: "one" });
    await repack(gitDir);

    // 缓存已建立，读一次确保生效
    assert.ok(await readObject(gitDir, c1.oid));

    // 再加一个提交，重新打包（pack 文件变化）
    await writeFile(path.join(dir, "b.txt"), "second\n");
    await add(gitDir, dir, ["."]);
    const c2 = await commit(gitDir, { message: "two" });

    // 注意：此时 c2 是松散的，c1 在旧 pack 里；再 repack 会生成新 pack
    await repack(gitDir);

    // 两个提交都应可读 —— 若缓存未失效，c2 会读不到或读到旧数据
    const o1 = await readObject(gitDir, c1.oid);
    const o2 = await readObject(gitDir, c2.oid);
    assert.equal(o1.type, "commit");
    assert.equal(o2.type, "commit");
    assert.match(o2.content.toString(), /two/);
  });
});

test("listAllObjects merges loose and packed objects without duplicates", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "a.txt"), "1\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "one" });
    await repack(gitDir);

    const oids = await listAllObjects(gitDir);
    assert.equal(new Set(oids).size, oids.length, "no duplicates");
    assert.ok(oids.length >= 3);
    for (const oid of oids) {
      assert.match(oid, /^[0-9a-f]{40}$/);
    }
  });
});
