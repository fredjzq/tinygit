// 工作区 / 索引 / HEAD 三者一致性测试。
//
// 这一组测试来自一次真实验收中发现的盲区：
// 原有的测试都只断言「命令返回了什么」，没有人检查
// 「执行完之后，磁盘上的文件和索引里的记录是否和 HEAD 对得上」。
//
// 结果就是三个 bug 一起躲过了 181 项测试：
//   1. 快进合并只移指针，不检出工作区
//   2. rebase 完成后工作区缺少新基点的文件
//   3. ls-tree HEAD 不支持提交引用
//
// 它们的共同特征是：命令的返回值完全正常，退出码是 0，
// 但仓库的实际状态是错的。所以这里专门断言三者一致。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initRepo } from "../src/repo.js";
import { add } from "../src/commands/add.js";
import { commit } from "../src/commands/commit.js";
import { createBranch, switchBranch } from "../src/commands/branch.js";
import { merge } from "../src/commands/merge.js";
import { rebase } from "../src/commands/rebase.js";
import { gc } from "../src/commands/gc.js";
import { status } from "../src/commands/status.js";
import { lsTree, catFile } from "../src/commands/inspect.js";
import { readIndex } from "../src/index-file.js";
import { readHeadRef } from "../src/refs.js";
import { readCommit } from "../src/commit.js";
import { flattenTree } from "../src/tree.js";

const TMP_ROOT = (() => {
  const t = os.tmpdir();
  if (!t || !path.isAbsolute(t)) return process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp";
  return t;
})();

let counter = 0;
async function newRepo(tag = "consistency") {
  counter += 1;
  const dir = await mkdtemp(path.join(TMP_ROOT, "tinygit-" + tag + "-" + counter + "-"));
  const gitDir = await initRepo(dir);
  return {
    dir,
    gitDir,
    async write(rel, content) {
      const abs = path.join(dir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    },
    async listFiles() {
      const out = [];
      async function walk(d, prefix = "") {
        for (const e of await readdir(d, { withFileTypes: true })) {
          if (e.name === ".git") continue;
          const rel = prefix ? prefix + "/" + e.name : e.name;
          if (e.isDirectory()) await walk(path.join(d, e.name), rel);
          else out.push(rel);
        }
      }
      await walk(dir);
      return out.sort();
    },
    async commitAll(msg, opts = {}) {
      await add(gitDir, dir, ["."]);
      return commit(gitDir, { message: msg, ...opts });
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// 断言三者一致：HEAD tree 的文件集合 == 索引路径集合 == 磁盘文件集合
async function assertConsistent(r, label) {
  const head = await readHeadRef(r.gitDir);
  const commitObj = await readCommit(r.gitDir, head.oid);
  const treeFiles = [...(await flattenTree(r.gitDir, commitObj.tree)).keys()].sort();

  const index = await readIndex(r.gitDir);
  const indexFiles = index.entries.map((e) => e.path).sort();

  const diskFiles = await r.listFiles();

  assert.deepEqual(indexFiles, treeFiles, label + "：索引应与 HEAD tree 一致");
  assert.deepEqual(diskFiles, treeFiles, label + "：磁盘文件应与 HEAD tree 一致");

  // status 必须是干净的
  const st = await status(r.gitDir, r.dir);
  assert.equal(st.staged.length, 0, label + "：不应有已暂存变化");
  assert.equal(st.unstaged.length, 0, label + "：不应有未暂存变化");
  assert.equal(st.untracked.length, 0, label + "：不应有未跟踪文件");
}

test("一致性: 快进合并必须检出工作区并更新索引", async () => {
  const r = await newRepo("ff-merge");
  try {
    await r.write("a.txt", "a\n");
    await r.commitAll("A");
    await createBranch(r.gitDir, "feature");
    await switchBranch(r.gitDir, r.dir, "feature");
    await r.write("f.txt", "feature\n");
    await r.commitAll("F");
    await switchBranch(r.gitDir, r.dir, "main");

    const res = await merge(r.gitDir, r.dir, "feature");
    assert.equal(res.result, "fast-forward");

    // 这是关键：只移指针的话 f.txt 不在磁盘上，索引也没有它
    await assertConsistent(r, "快进合并后");
    assert.equal(await readFile(path.join(r.dir, "f.txt"), "utf8"), "feature\n");
  } finally {
    await r.cleanup();
  }
});

test("一致性: 真合并后工作区、索引、HEAD 三者一致", async () => {
  const r = await newRepo("true-merge");
  try {
    await r.write("a.txt", "a\n");
    await r.commitAll("A");
    await createBranch(r.gitDir, "feature");
    await switchBranch(r.gitDir, r.dir, "feature");
    await r.write("f.txt", "feature\n");
    await r.commitAll("F");
    await switchBranch(r.gitDir, r.dir, "main");
    await r.write("m.txt", "main\n");
    await r.commitAll("M");

    const res = await merge(r.gitDir, r.dir, "feature");
    assert.equal(res.result, "merged");
    await assertConsistent(r, "真合并后");

    // 两边的文件都要在
    const files = await r.listFiles();
    for (const f of ["a.txt", "f.txt", "m.txt"]) {
      assert.ok(files.includes(f), f + " 应存在");
    }
  } finally {
    await r.cleanup();
  }
});

test("一致性: rebase 后必须检出新基点的文件", async () => {
  const r = await newRepo("rb-consistency");
  try {
    await r.write("a.txt", "a\n");
    await r.commitAll("A");
    await createBranch(r.gitDir, "topic");
    await switchBranch(r.gitDir, r.dir, "topic");
    await r.write("t.txt", "topic\n");
    await r.commitAll("T");
    await switchBranch(r.gitDir, r.dir, "main");
    // main 上新增一个文件，rebase 后它必须出现在磁盘上
    await r.write("m2.txt", "main2\n");
    await r.commitAll("M2");
    await switchBranch(r.gitDir, r.dir, "topic");

    const res = await rebase(r.gitDir, r.dir, "main");
    assert.equal(res.result, "rebased");

    // 只重放 topic 的提交的话，m2.txt 不会出现在磁盘上
    await assertConsistent(r, "rebase 后");
    const files = await r.listFiles();
    assert.ok(files.includes("m2.txt"), "新基点的文件必须被检出");
    assert.ok(files.includes("t.txt"), "重放的提交内容必须在");
  } finally {
    await r.cleanup();
  }
});

test("一致性: gc 之后仓库仍然一致", async () => {
  const r = await newRepo("gc-consistency");
  try {
    await r.write("a.txt", "a\n");
    await r.commitAll("A");
    await r.write("b.txt", "b\n");
    await r.commitAll("B");

    await assertConsistent(r, "gc 前");
    const res = await gc(r.gitDir);
    assert.ok(res.packed > 0, "应有对象被打包");
    await assertConsistent(r, "gc 后");

    // 打包后对象仍能读出
    const head = await readHeadRef(r.gitDir);
    const obj = await catFile(r.gitDir, head.oid);
    assert.equal(obj.type, "commit");
  } finally {
    await r.cleanup();
  }
});

test("检视: ls-tree 接受 HEAD、分支名、HEAD~n", async () => {
  const r = await newRepo("ls-tree");
  try {
    await r.write("a.txt", "a\n");
    await r.commitAll("A");
    await r.write("b.txt", "b\n");
    await r.commitAll("B");

    // HEAD 是提交，ls-tree 应自动取它的 tree，而不是报 not a tree
    const head = await lsTree(r.gitDir, "HEAD");
    const names = head.map((e) => e.name).sort();
    assert.deepEqual(names, ["a.txt", "b.txt"]);

    const byBranch = await lsTree(r.gitDir, "main");
    assert.deepEqual(byBranch.map((e) => e.name).sort(), ["a.txt", "b.txt"]);

    // HEAD~1 只有 a.txt
    const prev = await lsTree(r.gitDir, "HEAD~1");
    assert.deepEqual(prev.map((e) => e.name), ["a.txt"]);
  } finally {
    await r.cleanup();
  }
});

test("检视: cat-file 接受 HEAD 与分支名", async () => {
  const r = await newRepo("cat-file");
  try {
    await r.write("a.txt", "a\n");
    const c = await r.commitAll("A");

    for (const ref of ["HEAD", "main"]) {
      const obj = await catFile(r.gitDir, ref);
      assert.equal(obj.type, "commit", ref + " 应解析到提交");
      assert.ok(obj.content.toString("utf8").includes("A"), ref + " 的内容应含提交信息");
    }

    const full = await catFile(r.gitDir, c.oid);
    assert.equal(full.oid, c.oid);
  } finally {
    await r.cleanup();
  }
});

test("检视: 不存在的引用给出明确错误", async () => {
  const r = await newRepo("bad-ref");
  try {
    await r.write("a.txt", "a\n");
    await r.commitAll("A");
    await assert.rejects(() => lsTree(r.gitDir, "no-such-branch"), /无法解析的引用/);
    await assert.rejects(() => catFile(r.gitDir, "deadbeef"), /找不到对象/);
  } finally {
    await r.cleanup();
  }
});
