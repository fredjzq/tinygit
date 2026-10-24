// cherry-pick 与 rebase 的测试。
//
// 这两个命令最容易出错的地方不是「正常情况能不能跑」，
// 而是「base 选得对不对」和「冲突后状态还在不在」。
// 所以测试重点放在这两处。
//
// 特别是 cherry-pick 的 base：必须是被摘取提交的**父提交**，
// 而不是两个分支的公共祖先。选错会把当前分支的改动整体回退，
// 而且不会报错——只是历史悄悄错了。测试对此专门断言。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initRepo } from "../src/repo.js";
import { add } from "../src/commands/add.js";
import { commit } from "../src/commands/commit.js";
import { createBranch, switchBranch } from "../src/commands/branch.js";
import { cherryPick, readCherryPickHead, clearCherryPickState, resolveCommitRef } from "../src/commands/cherry-pick.js";
import { rebase, rebaseContinue, rebaseAbort, isRebaseInProgress, commitsToReplay } from "../src/commands/rebase.js";
import { readCommit } from "../src/commit.js";
import { log as logCmd } from "../src/commands/log.js";
import { readHeadRef, readRef } from "../src/refs.js";
import { isAncestor } from "../src/merge-base.js";
import { flattenTree } from "../src/tree.js";

const TMP_ROOT = (() => {
  const t = os.tmpdir();
  if (!t || !path.isAbsolute(t)) return process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp";
  return t;
})();

let counter = 0;
async function newRepo(tag = "cp") {
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
    async read(rel) {
      return readFile(path.join(dir, rel), "utf8");
    },
    async listTxt() {
      const out = [];
      async function walk(d, prefix = "") {
        for (const e of await readdir(d, { withFileTypes: true })) {
          if (e.name === ".git") continue;
          const rel = prefix ? prefix + "/" + e.name : e.name;
          if (e.isDirectory()) await walk(path.join(d, e.name), rel);
          else if (e.name.endsWith(".txt")) out.push(rel);
        }
      }
      await walk(dir);
      return out.sort();
    },
    async stageAll() {
      await add(gitDir, dir, ["."]);
    },
    async commitAll(msg, opts = {}) {
      await add(gitDir, dir, ["."]);
      return commit(gitDir, { message: msg, ...opts });
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("cherry-pick: base 必须是被摘取提交的父提交，不是公共祖先", async () => {
  const r = await newRepo("cp-base");
  try {
    //   A -> B -> C   main（当前）
    //         \-> F   feature
    await r.write("a.txt", "A\n");
    const A = await r.commitAll("A");
    await r.write("b.txt", "B\n");
    const B = await r.commitAll("B");
    await createBranch(r.gitDir, "feature");
    await switchBranch(r.gitDir, r.dir, "feature");
    await r.write("f.txt", "F\n");
    const F = await r.commitAll("F");
    await switchBranch(r.gitDir, r.dir, "main");
    await r.write("c.txt", "C\n");
    const C = await r.commitAll("C");

    const res = await cherryPick(r.gitDir, r.dir, F.oid);
    assert.equal(res.result, "picked");
    // 这是最核心的断言
    assert.equal(res.baseOid, B.oid, "base 必须是 F 的父提交 B");

    // C 的改动必须保留。若 base 被错当成 A，c.txt 会被当作「theirs 缺失」而删除。
    const files = await r.listTxt();
    assert.ok(files.includes("c.txt"), "当前分支的改动 c.txt 必须保留");
    assert.ok(files.includes("f.txt"), "被摘取的内容 f.txt 必须加入");
    assert.ok(files.includes("a.txt"));
    assert.ok(files.includes("b.txt"));
  } finally {
    await r.cleanup();
  }
});

test("cherry-pick: 保留原作者，但只产生单亲提交", async () => {
  const r = await newRepo("cp-author");
  try {
    await r.write("a.txt", "A\n");
    await r.commitAll("A");
    await createBranch(r.gitDir, "feature");
    await switchBranch(r.gitDir, r.dir, "feature");
    await r.write("f.txt", "F\n");
    const F = await r.commitAll("F", { author: { name: "Alice", email: "alice@example.com" } });
    await switchBranch(r.gitDir, r.dir, "main");
    await r.write("c.txt", "C\n");
    const C = await r.commitAll("C");

    const res = await cherryPick(r.gitDir, r.dir, F.oid);
    const nc = await readCommit(r.gitDir, res.oid);

    assert.equal(nc.author.name, "Alice", "原作者必须保留");
    assert.equal(nc.author.email, "alice@example.com");
    assert.equal(nc.parents.length, 1, "cherry-pick 产生的是普通提交，不是合并提交");
    assert.equal(nc.parents[0], C.oid, "parent 应是当前 HEAD");
    assert.equal(nc.message.trim(), "F", "提交信息不应被加上注释前缀");
  } finally {
    await r.cleanup();
  }
});

test("cherry-pick: 冲突时写 CHERRY_PICK_HEAD 并留下冲突标记", async () => {
  const r = await newRepo("cp-conflict");
  try {
    await r.write("shared.txt", "line1\nline2\nline3\n");
    await r.commitAll("base");
    await createBranch(r.gitDir, "feature");
    await switchBranch(r.gitDir, r.dir, "feature");
    await r.write("shared.txt", "line1\nFEATURE\nline3\n");
    const F = await r.commitAll("F");
    await switchBranch(r.gitDir, r.dir, "main");
    await r.write("shared.txt", "line1\nMAIN\nline3\n");
    await r.commitAll("M");

    const res = await cherryPick(r.gitDir, r.dir, F.oid);
    assert.equal(res.result, "conflict");
    assert.equal(res.conflicts.length, 1);

    const content = await r.read("shared.txt");
    assert.ok(content.includes("<<<<<<<"), "应写入冲突开始标记");
    assert.ok(content.includes("======="), "应写入分隔标记");
    assert.ok(content.includes(">>>>>>>"), "应写入冲突结束标记");
    assert.ok(content.includes("MAIN"), "ours 内容应在");
    assert.ok(content.includes("FEATURE"), "theirs 内容应在");

    // 状态记录是「解决冲突后能接着做完」的前提
    const cpHead = await readCherryPickHead(r.gitDir);
    assert.equal(cpHead, F.oid, "CHERRY_PICK_HEAD 应记录来源提交");

    await clearCherryPickState(r.gitDir);
    assert.equal(await readCherryPickHead(r.gitDir), null);
  } finally {
    await r.cleanup();
  }
});

test("cherry-pick: 改动已存在时返回 empty，不产生空提交", async () => {
  const r = await newRepo("cp-empty");
  try {
    await r.write("a.txt", "A\n");
    await r.commitAll("A");
    await createBranch(r.gitDir, "feature");
    await switchBranch(r.gitDir, r.dir, "feature");
    await r.write("f.txt", "F\n");
    const F = await r.commitAll("F");
    await switchBranch(r.gitDir, r.dir, "main");
    // 把同样的内容也提交到 main
    await r.write("f.txt", "F\n");
    await r.commitAll("F on main");

    const before = (await logCmd(r.gitDir, { max: 50 })).length;
    const res = await cherryPick(r.gitDir, r.dir, F.oid);
    const after = (await logCmd(r.gitDir, { max: 50 })).length;

    assert.equal(res.result, "empty");
    assert.equal(after, before, "不应产生新提交");
  } finally {
    await r.cleanup();
  }
});

test("cherry-pick: 支持短 sha 与分支名作为引用", async () => {
  const r = await newRepo("cp-ref");
  try {
    await r.write("a.txt", "A\n");
    await r.commitAll("A");
    await createBranch(r.gitDir, "feature");
    await switchBranch(r.gitDir, r.dir, "feature");
    await r.write("f.txt", "F\n");
    const F = await r.commitAll("F");
    await switchBranch(r.gitDir, r.dir, "main");
    await r.write("c.txt", "C\n");
    await r.commitAll("C");

    assert.equal(await resolveCommitRef(r.gitDir, F.oid.slice(0, 7)), F.oid, "短 sha 应能解析");
    assert.equal(await resolveCommitRef(r.gitDir, "feature"), F.oid, "分支名应能解析");

    const res = await cherryPick(r.gitDir, r.dir, "feature");
    assert.equal(res.result, "picked");
  } finally {
    await r.cleanup();
  }
});

test("rebase: 线性重放，历史变成一条直线", async () => {
  const r = await newRepo("rb-linear");
  try {
    //   A -> B        main
    //    \-> C -> D   feature（当前）
    await r.write("a.txt", "A\n");
    await r.commitAll("A");
    await r.write("b.txt", "B\n");
    const B = await r.commitAll("B");
    await createBranch(r.gitDir, "feature");
    await switchBranch(r.gitDir, r.dir, "feature");
    await r.write("c.txt", "C\n");
    await r.commitAll("C");
    await r.write("d.txt", "D\n");
    const D = await r.commitAll("D");

    const res = await rebase(r.gitDir, r.dir, "main");
    assert.equal(res.result, "rebased");
    assert.equal(res.replayed, 2, "C 和 D 都应被重放");

    const history = await logCmd(r.gitDir, { max: 20 });
    const msgs = history.map((c) => c.message.trim());
    assert.deepEqual(msgs, ["D", "C", "B", "A"], "历史应为线性且顺序正确");

    // B 必须是新 HEAD 的祖先（说明真的接到 main 后面了）
    const head = await readHeadRef(r.gitDir);
    assert.ok(await isAncestor(r.gitDir, B.oid, head.oid), "main 的 B 应成为祖先");

    // 全部文件都在
    const files = await r.listTxt();
    assert.deepEqual(files, ["a.txt", "b.txt", "c.txt", "d.txt"]);

    // HEAD 恢复为符号引用，分支引用指向新历史
    assert.equal(head.ref, "refs/heads/feature");
    assert.equal(await readRef(r.gitDir, "refs/heads/feature"), head.oid);

    // ORIG_HEAD 记录原位置（用户找回的兜底手段）
    const orig = (await readFile(path.join(r.dir, ".git", "ORIG_HEAD"), "utf8")).trim();
    assert.equal(orig, D.oid, "ORIG_HEAD 应记录 rebase 前的位置");

    // 状态清理干净
    assert.equal(await isRebaseInProgress(r.gitDir), false);
  } finally {
    await r.cleanup();
  }
});

test("rebase: 冲突时中断，状态落盘，可 abort 回滚", async () => {
  const r = await newRepo("rb-conflict");
  try {
    await r.write("shared.txt", "v1\n");
    await r.commitAll("base");
    await createBranch(r.gitDir, "feature");
    await switchBranch(r.gitDir, r.dir, "feature");
    await r.write("shared.txt", "FEATURE\n");
    await r.commitAll("F1");
    await r.write("extra.txt", "extra\n");
    const F2 = await r.commitAll("F2");
    await switchBranch(r.gitDir, r.dir, "main");
    await r.write("shared.txt", "MAIN\n");
    await r.commitAll("M");
    await switchBranch(r.gitDir, r.dir, "feature");

    const res = await rebase(r.gitDir, r.dir, "main");
    assert.equal(res.result, "conflict");
    assert.ok(res.conflicts.some((c) => c.path === "shared.txt"));

    // 关键：状态必须落盘，否则进程退出后无法恢复
    assert.equal(await isRebaseInProgress(r.gitDir), true);
    const rebaseDir = path.join(r.dir, ".git", "rebase-merge");
    const stateFiles = await readdir(rebaseDir);
    assert.ok(stateFiles.includes("todo"), "必须有 todo");
    assert.ok(stateFiles.includes("onto"), "必须有 onto");
    assert.ok(stateFiles.includes("head-name"), "必须有 head-name");
    assert.ok(stateFiles.includes("orig-head"), "必须有 orig-head");

    // abort 回到原位置
    const aborted = await rebaseAbort(r.gitDir, r.dir);
    assert.equal(aborted.result, "aborted");
    assert.equal(aborted.head, F2.oid, "应回到 rebase 前的 HEAD");

    const head = await readHeadRef(r.gitDir);
    assert.equal(head.ref, "refs/heads/feature", "HEAD 应恢复为分支引用");

    // 工作区内容也应恢复
    assert.equal((await r.read("shared.txt")).trim(), "FEATURE");
    assert.ok((await r.listTxt()).includes("extra.txt"));
    assert.equal(await isRebaseInProgress(r.gitDir), false);
  } finally {
    await r.cleanup();
  }
});

test("rebase: 解决冲突后 --continue 走完全程，且不覆盖用户的解决结果", async () => {
  const r = await newRepo("rb-continue");
  try {
    await r.write("shared.txt", "v1\n");
    await r.commitAll("base");
    await createBranch(r.gitDir, "feature");
    await switchBranch(r.gitDir, r.dir, "feature");
    await r.write("shared.txt", "FEATURE\n");
    const F1 = await r.commitAll("F1", { author: { name: "Bob", email: "bob@example.com" } });
    await r.write("extra.txt", "extra\n");
    await r.commitAll("F2");
    await switchBranch(r.gitDir, r.dir, "main");
    await r.write("shared.txt", "MAIN\n");
    const M = await r.commitAll("M");
    await switchBranch(r.gitDir, r.dir, "feature");

    const r1 = await rebase(r.gitDir, r.dir, "main");
    assert.equal(r1.result, "conflict");

    // 用户手工解决
    const resolved = "MAIN\nFEATURE\n";
    await r.write("shared.txt", resolved);
    await add(r.gitDir, r.dir, ["shared.txt"]);

    const r2 = await rebaseContinue(r.gitDir, r.dir);
    assert.equal(r2.result, "rebased", "continue 后应完成");

    // 最重要的断言：用户的解决结果不能被二次归并覆盖
    assert.equal(await r.read("shared.txt"), resolved, "用户解决的内容必须保留");
    assert.ok(!(await r.read("shared.txt")).includes("<<<<<<<"), "不应残留冲突标记");

    const history = await logCmd(r.gitDir, { max: 20 });
    assert.equal(history.length, 3, "应有 base + M + F1 + F2 压缩后的 3 个提交");
    assert.deepEqual(
      history.map((c) => c.message.trim()),
      ["F1", "M", "base"].filter((m) => m !== "F2"),
      "F2 是空提交应被跳过"
    );

    // F2 的文件改动仍要生效
    assert.ok((await r.listTxt()).includes("extra.txt"));

    // 原作者保留
    const replayedF1 = history.find((c) => c.message.trim() === "F1");
    const nc = await readCommit(r.gitDir, replayedF1.oid);
    assert.equal(nc.author.name, "Bob", "重放后应保留原作者");

    // 线性历史
    const head = await readHeadRef(r.gitDir);
    assert.ok(await isAncestor(r.gitDir, M.oid, head.oid));
    assert.equal(head.ref, "refs/heads/feature");
    assert.equal(await isRebaseInProgress(r.gitDir), false);
  } finally {
    await r.cleanup();
  }
});

test("rebase: 计算待重放提交时排除已在目标分支上的提交", async () => {
  const r = await newRepo("rb-todo");
  try {
    //   A -> B -> C   main
    //         \-> D   feature
    await r.write("a.txt", "A\n");
    await r.commitAll("A");
    await r.write("b.txt", "B\n");
    const B = await r.commitAll("B");
    await createBranch(r.gitDir, "feature");
    await switchBranch(r.gitDir, r.dir, "feature");
    await r.write("d.txt", "D\n");
    const D = await r.commitAll("D");
    await switchBranch(r.gitDir, r.dir, "main");
    await r.write("c.txt", "C\n");
    const C = await r.commitAll("C");

    const todo = await commitsToReplay(r.gitDir, D.oid, C.oid);
    assert.deepEqual(todo, [D.oid], "只有 D 需要重放，A 和 B 已在 main 上");

    // 顺序必须从旧到新
    await switchBranch(r.gitDir, r.dir, "feature");
    const r2 = await newRepo("rb-todo2");
    try {
      await r2.write("a.txt", "A\n");
      await r2.commitAll("A");
      await createBranch(r2.gitDir, "feature");
      await switchBranch(r2.gitDir, r2.dir, "feature");
      await r2.write("x.txt", "X\n");
      const X = await r2.commitAll("X");
      await r2.write("y.txt", "Y\n");
      const Y = await r2.commitAll("Y");
      await switchBranch(r2.gitDir, r2.dir, "main");
      await r2.write("m.txt", "M\n");
      await r2.commitAll("M");

      const order = await commitsToReplay(r2.gitDir, Y.oid, (await readHeadRef(r2.gitDir)).oid);
      assert.deepEqual(order, [X.oid, Y.oid], "必须从旧到新（X 在 Y 前）");
    } finally {
      await r2.cleanup();
    }
  } finally {
    await r.cleanup();
  }
});

test("rebase: 已在新基点之上时不做任何事", async () => {
  const r = await newRepo("rb-uptodate");
  try {
    await r.write("a.txt", "A\n");
    await r.commitAll("A");
    await createBranch(r.gitDir, "feature");
    await switchBranch(r.gitDir, r.dir, "feature");
    await r.write("f.txt", "F\n");
    await r.commitAll("F");
    // feature 直接 rebase 到 main（main 是 feature 的祖先）
    const res = await rebase(r.gitDir, r.dir, "main");
    // main 落后于 feature，rebase feature onto main 是 no-op
    assert.ok(["up-to-date", "rebased"].includes(res.result));
  } finally {
    await r.cleanup();
  }
});

test("checkout: 切换分支必须删除旧分支的已跟踪文件", async () => {
  const r = await newRepo("co-clean");
  try {
    await r.write("a.txt", "A\n");
    await r.commitAll("A");
    await createBranch(r.gitDir, "feature");
    await switchBranch(r.gitDir, r.dir, "feature");
    await r.write("f1.txt", "f1\n");
    await r.write("f2.txt", "f2\n");
    await r.commitAll("F");

    assert.deepEqual((await r.listTxt()).sort(), ["a.txt", "f1.txt", "f2.txt"]);

    await switchBranch(r.gitDir, r.dir, "main");
    const after = (await r.listTxt()).sort();
    assert.deepEqual(after, ["a.txt"], "旧分支的文件必须从工作区删除");

    // 不删除的话，下一次 add . 会把它们提交进 main
    await add(r.gitDir, r.dir, ["."]);
    await assert.rejects(
      () => commit(r.gitDir, { message: "should be empty" }),
      /nothing to commit/,
      "工作区应已干净，不应能提交出跨分支污染"
    );
  } finally {
    await r.cleanup();
  }
});

test("checkout: 未跟踪文件不能被误删", async () => {
  const r = await newRepo("co-untracked");
  try {
    await r.write("a.txt", "A\n");
    await r.commitAll("A");
    await createBranch(r.gitDir, "feature");
    // 未跟踪的私人文件
    await r.write("private.txt", "my notes\n");

    await switchBranch(r.gitDir, r.dir, "feature");
    const files = await r.listTxt();
    assert.ok(files.includes("private.txt"), "未跟踪文件必须保留");
  } finally {
    await r.cleanup();
  }
});
