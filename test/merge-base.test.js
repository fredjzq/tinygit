// 最近公共祖先。这里曾经写反过一次判据，产生过假冲突，故重点覆盖。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initRepo } from "../src/repo.js";
import { add } from "../src/commands/add.js";
import { commit } from "../src/commands/commit.js";
import { createBranch, switchBranch } from "../src/commands/branch.js";
import { findMergeBase, isAncestor, ancestorMap } from "../src/merge-base.js";

const TMP_ROOT = (() => {
  try {
    const d = os.tmpdir();
    if (d && !d.includes("undefined")) return d;
  } catch {}
  return process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp";
})();

async function withRepo(fn) {
  const dir = await mkdtemp(path.join(TMP_ROOT, "tinygit-mb-"));
  try {
    const gitDir = await initRepo(dir);
    await fn({ dir, gitDir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeCommit(dir, gitDir, file, content, message) {
  const abs = path.join(dir, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
  await add(gitDir, dir, ["."]);
  return commit(gitDir, { message });
}

test("same commit is its own merge base", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    const c = await makeCommit(dir, gitDir, "a.txt", "1\n", "one");
    const mb = await findMergeBase(gitDir, c.oid, c.oid);
    assert.equal(mb, c.oid);
  });
});

test("linear history: parent is the merge base of child", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    const c1 = await makeCommit(dir, gitDir, "a.txt", "1\n", "one");
    const c2 = await makeCommit(dir, gitDir, "a.txt", "2\n", "two");
    assert.equal(await findMergeBase(gitDir, c1.oid, c2.oid), c1.oid);
    assert.equal(await findMergeBase(gitDir, c2.oid, c1.oid), c1.oid);
  });
});

test("diverged branches: base is the branch point, not an earlier commit", async () => {
  // 这个用例正是之前判据写反时会失败的情形：
  // 分支点在 c2，但 c1 也是公共祖先。错误实现会返回 c1。
  await withRepo(async ({ dir, gitDir }) => {
    const c1 = await makeCommit(dir, gitDir, "a.txt", "1\n", "c1");
    const c2 = await makeCommit(dir, gitDir, "a.txt", "2\n", "c2");

    await createBranch(gitDir, "feature");
    await switchBranch(gitDir, dir, "feature");
    const cf = await makeCommit(dir, gitDir, "b.txt", "feat\n", "cf");

    await switchBranch(gitDir, dir, "main");
    const cm = await makeCommit(dir, gitDir, "c.txt", "main\n", "cm");

    const mb = await findMergeBase(gitDir, cm.oid, cf.oid);
    assert.equal(mb, c2.oid, "must be the branch point c2, not the earlier c1");
    assert.notEqual(mb, c1.oid, "must not fall back to the root commit");
  });
});

test("symmetry: order of arguments does not matter", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await makeCommit(dir, gitDir, "a.txt", "1\n", "c1");
    await makeCommit(dir, gitDir, "a.txt", "2\n", "c2");
    await createBranch(gitDir, "f");
    await switchBranch(gitDir, dir, "f");
    const cf = await makeCommit(dir, gitDir, "b.txt", "x\n", "cf");
    await switchBranch(gitDir, dir, "main");
    const cm = await makeCommit(dir, gitDir, "c.txt", "y\n", "cm");

    const ab = await findMergeBase(gitDir, cm.oid, cf.oid);
    const ba = await findMergeBase(gitDir, cf.oid, cm.oid);
    assert.equal(ab, ba);
  });
});

test("unrelated histories have no merge base", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    const c1 = await makeCommit(dir, gitDir, "a.txt", "1\n", "one");
    // 造一个孤立的提交：直接写一个没有 parent 的 commit
    const { writeCommit, formatIdentity } = await import("../src/commit.js");
    const { writeTreeFromEntries } = await import("../src/tree.js");
    const { writeObject } = await import("../src/objects.js");
    const blob = await writeObject(gitDir, "blob", Buffer.from("orphan\n"));
    const tree = await writeTreeFromEntries(gitDir, [{ path: "o.txt", oid: blob, mode: "100644" }]);
    const ident = formatIdentity("x", "x@y", 1700000000, 0);
    const orphan = await writeCommit(gitDir, { tree, parents: [], author: ident, committer: ident, message: "orphan\n" });

    const mb = await findMergeBase(gitDir, c1.oid, orphan);
    assert.equal(mb, null);
  });
});

test("isAncestor reflects the commit graph", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    const c1 = await makeCommit(dir, gitDir, "a.txt", "1\n", "one");
    const c2 = await makeCommit(dir, gitDir, "a.txt", "2\n", "two");
    assert.equal(await isAncestor(gitDir, c1.oid, c2.oid), true);
    assert.equal(await isAncestor(gitDir, c2.oid, c1.oid), false);
    assert.equal(await isAncestor(gitDir, c1.oid, c1.oid), true, "a commit is its own ancestor");
  });
});

test("ancestorMap includes the start commit at depth 0", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    const c1 = await makeCommit(dir, gitDir, "a.txt", "1\n", "one");
    const c2 = await makeCommit(dir, gitDir, "a.txt", "2\n", "two");
    const m = await ancestorMap(gitDir, c2.oid);
    assert.equal(m.get(c2.oid), 0);
    assert.equal(m.get(c1.oid), 1);
  });
});

test("merge base of ancestor and descendant is the ancestor", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    const c1 = await makeCommit(dir, gitDir, "a.txt", "1\n", "one");
    const c2 = await makeCommit(dir, gitDir, "a.txt", "2\n", "two");
    const c3 = await makeCommit(dir, gitDir, "a.txt", "3\n", "three");
    assert.equal(await findMergeBase(gitDir, c3.oid, c1.oid), c1.oid);
    assert.equal(await findMergeBase(gitDir, c1.oid, c3.oid), c1.oid);
    assert.equal(await findMergeBase(gitDir, c3.oid, c2.oid), c2.oid);
  });
});
