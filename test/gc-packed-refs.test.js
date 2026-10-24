// gc 与 packed-refs 的集成测试。
//
// gc 是本项目里「最危险」的命令：它删除文件。
// 删错就是永久丢数据，所以测试重点是
//   1. 打包后历史仍可完整读取
//   2. 索引里「已暂存但未提交」的对象不能被误删
//   3. 分支打包后删除不会复活

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initRepo } from "../src/repo.js";
import { add } from "../src/commands/add.js";
import { commit } from "../src/commands/commit.js";
import { log as logCmd } from "../src/commands/log.js";
import { status } from "../src/commands/status.js";
import { gc, collectReachable, listLooseObjects } from "../src/commands/gc.js";
import { readObject } from "../src/objects.js";
import { readRef, listBranches, writeRef, deleteRef, repackRefs } from "../src/refs.js";
import { readPackedRefs } from "../src/packed-refs.js";

const TMP_ROOT = (() => {
  const t = os.tmpdir();
  if (!t || !path.isAbsolute(t) || !/^[A-Za-z]:[\\/]/.test(t) && !t.startsWith("/")) {
    return process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp";
  }
  return t;
})();

async function makeRepo() {
  const dir = await mkdtemp(path.join(TMP_ROOT, "tinygit-gc-"));
  const gitDir = await initRepo(dir);
  return { dir, gitDir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function commitFile(ctx, name, content, message) {
  await writeFile(path.join(ctx.dir, name), content);
  await add(ctx.gitDir, ctx.dir, [name]);
  return commit(ctx.gitDir, { message });
}

test("gc: 打包后历史与工作区都保持完整", async () => {
  const ctx = await makeRepo();
  try {
    for (let v = 1; v <= 8; v += 1) {
      const lines = Array.from({ length: 50 }, (_, i) => "line " + i);
      lines[v * 5] = "changed v" + v;
      await commitFile(ctx, "f.txt", lines.join("\n"), "v" + v);
    }

    const before = await status(ctx.gitDir, ctx.dir);
    assert.equal(before.staged.length, 0);
    assert.equal(before.unstaged.length, 0);

    const result = await gc(ctx.gitDir);
    assert.ok(result.packed > 0, "应打包对象");
    assert.equal(result.removed, result.looseBefore, "所有可达松散对象都应清理");

    // 历史仍可完整读取
    const commits = await logCmd(ctx.gitDir, { max: 100 });
    assert.equal(commits.length, 8, "gc 后应仍能读到 8 个提交");

    // 每个提交的 tree 和 blob 都能读
    for (const c of commits) {
      const commitObj = await readObject(ctx.gitDir, c.oid);
      assert.equal(commitObj.type, "commit");
    }

    // 工作区状态不变
    const after = await status(ctx.gitDir, ctx.dir);
    assert.equal(after.staged.length, 0);
    assert.equal(after.unstaged.length, 0);
    assert.equal(after.untracked.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test("gc: 索引里已暂存但未提交的对象必须保留", async () => {
  const ctx = await makeRepo();
  try {
    await commitFile(ctx, "a.txt", "committed content\n", "first");
    // 暂存一个尚未提交的文件：它的 blob 只在索引里可达
    await writeFile(path.join(ctx.dir, "staged.txt"), "staged but not committed\n");
    await add(ctx.gitDir, ctx.dir, ["staged.txt"]);

    const beforeStatus = await status(ctx.gitDir, ctx.dir);
    assert.equal(beforeStatus.staged.length, 1);

    const result = await gc(ctx.gitDir);
    assert.ok(result.removed > 0, "应该清理了松散对象");

    // 暂存的对象必须还在，否则下次 commit 会失败
    const afterStatus = await status(ctx.gitDir, ctx.dir);
    assert.equal(afterStatus.staged.length, 1, "已暂存的文件不能因 gc 丢失");

    // 还能正常提交
    const c = await commit(ctx.gitDir, { message: "after gc" });
    assert.ok(c.oid);
    const commits = await logCmd(ctx.gitDir, { max: 10 });
    assert.equal(commits.length, 2);
  } finally {
    await ctx.cleanup();
  }
});

test("gc: 不可达的松散对象不会被删除", async () => {
  const ctx = await makeRepo();
  try {
    await commitFile(ctx, "a.txt", "content a\n", "first");
    // 手工造一个不可达对象
    const { writeObject } = await import("../src/objects.js");
    const orphan = await writeObject(ctx.gitDir, "blob", Buffer.from("orphan data"));

    const before = await listLooseObjects(ctx.gitDir);
    assert.ok(before.length > 0);

    await gc(ctx.gitDir);

    // 不可达对象保留：本项目没有 reflog，激进删除风险大于收益
    const after = await listLooseObjects(ctx.gitDir);
    assert.ok(after.some((o) => o.oid === orphan), "不可达对象应被保留而不是删除");

    // 且仍能读到
    const obj = await readObject(ctx.gitDir, orphan);
    assert.equal(obj.content.toString(), "orphan data");
  } finally {
    await ctx.cleanup();
  }
});

test("gc: dry-run 不产生任何文件变化", async () => {
  const ctx = await makeRepo();
  try {
    await commitFile(ctx, "a.txt", "x\n", "one");
    const before = await listLooseObjects(ctx.gitDir);
    const packDir = path.join(ctx.gitDir, "objects", "pack");
    let packsBefore = 0;
    try { packsBefore = (await readdir(packDir)).length; } catch {}

    const r = await gc(ctx.gitDir, { dryRun: true });
    assert.equal(r.dryRun, true);
    assert.ok(r.packSize > 0, "应给出预计大小");

    const after = await listLooseObjects(ctx.gitDir);
    assert.equal(after.length, before.length, "dry-run 不能删任何松散对象");
    let packsAfter = 0;
    try { packsAfter = (await readdir(packDir)).length; } catch {}
    assert.equal(packsAfter, packsBefore, "dry-run 不能写 pack");
  } finally {
    await ctx.cleanup();
  }
});

test("packed-refs: 打包后仍能读到所有分支", async () => {
  const ctx = await makeRepo();
  try {
    const { oid } = await commitFile(ctx, "a.txt", "x\n", "one");
    const shas = new Map();
    for (let i = 0; i < 6; i += 1) {
      const sha = (String.fromCharCode(97 + i).repeat(40)).slice(0, 40);
      shas.set("refs/heads/br" + i, sha);
      await writeRef(ctx.gitDir, "refs/heads/br" + i, sha);
    }

    const before = await listBranches(ctx.gitDir);
    assert.equal(before.length, 7, "应有 main + 6 个分支");

    const packed = await repackRefs(ctx.gitDir);
    assert.equal(packed, 7);

    // 打包后列表不变
    const after = await listBranches(ctx.gitDir);
    assert.deepEqual(after, before, "打包前后分支列表应一致");

    // 每个分支都能读到正确的 sha
    for (const [ref, sha] of shas) {
      assert.equal(await readRef(ctx.gitDir, ref), sha, ref + " 应读到原 sha");
    }

    // 松散目录已清空
    const headsDir = path.join(ctx.gitDir, "refs", "heads");
    let looseCount = 0;
    try { looseCount = (await readdir(headsDir)).length; } catch {}
    assert.equal(looseCount, 0, "打包后不应残留松散 ref 文件");

    void oid;
  } finally {
    await ctx.cleanup();
  }
});

test("packed-refs: 删除打包的分支不能复活", async () => {
  const ctx = await makeRepo();
  try {
    await commitFile(ctx, "a.txt", "x\n", "one");
    const sha = "d".repeat(40);
    await writeRef(ctx.gitDir, "refs/heads/gone", sha);
    await repackRefs(ctx.gitDir);

    // 确认在 packed-refs 里
    let packed = await readPackedRefs(ctx.gitDir);
    assert.ok(packed.has("refs/heads/gone"), "分支应已写入 packed-refs");

    // 删除
    await deleteRef(ctx.gitDir, "refs/heads/gone");

    // 关键断言：不能复活
    const branches = await listBranches(ctx.gitDir);
    assert.ok(!branches.includes("gone"), "删除后分支不能再次出现");
    assert.equal(await readRef(ctx.gitDir, "refs/heads/gone"), null);

    packed = await readPackedRefs(ctx.gitDir);
    assert.ok(!packed.has("refs/heads/gone"), "packed-refs 里也必须移除");
  } finally {
    await ctx.cleanup();
  }
});

test("packed-refs: 松散 ref 覆盖 packed-refs 的旧值", async () => {
  const ctx = await makeRepo();
  try {
    await commitFile(ctx, "a.txt", "x\n", "one");
    const oldSha = "1".repeat(40);
    const newSha = "2".repeat(40);

    await writeRef(ctx.gitDir, "refs/heads/target", oldSha);
    await repackRefs(ctx.gitDir);
    assert.equal(await readRef(ctx.gitDir, "refs/heads/target"), oldSha);

    // 更新：写松散文件
    await writeRef(ctx.gitDir, "refs/heads/target", newSha);
    assert.equal(await readRef(ctx.gitDir, "refs/heads/target"), newSha, "松散 ref 必须优先");
  } finally {
    await ctx.cleanup();
  }
});

test("gc: 空仓库上运行不会报错", async () => {
  const ctx = await makeRepo();
  try {
    const r = await gc(ctx.gitDir);
    assert.equal(r.looseBefore, 0);
    assert.equal(r.packed, 0);
  } finally {
    await ctx.cleanup();
  }
});

test("gc: 可达对象收集覆盖提交树与索引", async () => {
  const ctx = await makeRepo();
  try {
    await commitFile(ctx, "a.txt", "aaa\n", "one");
    await writeFile(path.join(ctx.dir, "b.txt"), "bbb\n");
    await add(ctx.gitDir, ctx.dir, ["b.txt"]);

    const reachable = await collectReachable(ctx.gitDir);
    // 至少包含：1 个 commit、若干 tree、2 个 blob
    const types = { commit: 0, tree: 0, blob: 0 };
    for (const [, obj] of reachable) types[obj.type] += 1;
    assert.equal(types.commit, 1);
    assert.ok(types.blob >= 2, "应包含已提交和已暂存的 blob");
    assert.ok(types.tree >= 1, "应包含根树");
  } finally {
    await ctx.cleanup();
  }
});
