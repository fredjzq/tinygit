// merge 命令的端到端测试：真的建仓库、造分支、合并。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initRepo } from "../src/repo.js";
import { add } from "../src/commands/add.js";
import { commit } from "../src/commands/commit.js";
import { merge } from "../src/commands/merge.js";
import { createBranch, switchBranch } from "../src/commands/branch.js";
import { readHeadRef, readRef } from "../src/refs.js";
import { readCommit } from "../src/commit.js";
import { flattenTree } from "../src/tree.js";
import { readObject } from "../src/objects.js";

const TMP_ROOT = (() => {
  try {
    const d = os.tmpdir();
    if (d && !d.includes("undefined")) return d;
  } catch {}
  return process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp";
})();

async function withRepo(fn) {
  const dir = await mkdtemp(path.join(TMP_ROOT, "tinygit-merge-"));
  try {
    const gitDir = await initRepo(dir);
    await fn({ dir, gitDir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

test("fast-forward merge moves the branch pointer", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await write(dir, "a.txt", "1\n");
    await add(gitDir, dir, ["."]);
    const base = await commit(gitDir, { message: "base" });

    await switchBranch(gitDir, dir, "main").catch(() => {});  // 已在 main
    await createBranch(gitDir, "feature");

    // 在 main 上提交
    await write(dir, "a.txt", "2\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "main change" });

    // 切到 feature（它指向 base），然后合并 main → 快进
    await switchBranch(gitDir, dir, "feature");
    const before = await readHeadRef(gitDir);
    assert.equal(before.oid, base.oid, "feature should start at base");

    const r = await merge(gitDir, dir, "main");
    assert.equal(r.result, "fast-forward");
    const after = await readHeadRef(gitDir);
    assert.notEqual(after.oid, before.oid);
  });
});

test("already up-to-date merge is a no-op", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await write(dir, "a.txt", "1\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "base" });

    await createBranch(gitDir, "old", null);
    // old 指向同一提交
    const r = await merge(gitDir, dir, "old");
    assert.equal(r.result, "up-to-date");
  });
});

test("real merge creates a commit with two parents", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await write(dir, "shared.txt", "line1\nline2\nline3\n");
    await write(dir, "ours.txt", "o\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "base" });

    await createBranch(gitDir, "feature");

    // main 上改一个文件
    await write(dir, "ours.txt", "o-main\n");
    await add(gitDir, dir, ["."]);
    const mainCommit = await commit(gitDir, { message: "main change" });

    // feature 上改另一个文件
    await switchBranch(gitDir, dir, "feature");
    await write(dir, "theirs.txt", "t-feature\n");
    await add(gitDir, dir, ["."]);
    const featCommit = await commit(gitDir, { message: "feature change" });

    // 回 main 合并 feature
    await switchBranch(gitDir, dir, "main");
    const r = await merge(gitDir, dir, "feature");
    assert.equal(r.result, "merged", "expected a real merge, got " + r.result);

    const mergeCommit = await readCommit(gitDir, r.oid);
    assert.equal(mergeCommit.parents.length, 2, "merge commit must have two parents");
    assert.ok(mergeCommit.parents.includes(mainCommit.oid));
    assert.ok(mergeCommit.parents.includes(featCommit.oid));

    // 两边新增的文件都应在结果 tree 里
    const files = await flattenTree(gitDir, mergeCommit.tree);
    assert.ok(files.has("ours.txt"));
    assert.ok(files.has("theirs.txt"));
    assert.ok(files.has("shared.txt"));
  });
});

test("merge combining edits to different parts of the same file", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    const original = "top\nmiddle\nbottom\n";
    await write(dir, "f.txt", original);
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "base" });

    await createBranch(gitDir, "feature");

    await write(dir, "f.txt", "TOP\nmiddle\nbottom\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "main edits top" });

    await switchBranch(gitDir, dir, "feature");
    await write(dir, "f.txt", "top\nmiddle\nBOTTOM\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "feature edits bottom" });

    await switchBranch(gitDir, dir, "main");
    const r = await merge(gitDir, dir, "feature");
    assert.equal(r.result, "merged");

    // 工作区文件应同时包含两处修改
    const content = await readFile(path.join(dir, "f.txt"), "utf8");
    assert.match(content, /^TOP$/m);
    assert.match(content, /^BOTTOM$/m);
    assert.match(content, /^middle$/m);
  });
});

test("conflicting merge reports conflict and leaves markers", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await write(dir, "f.txt", "a\nb\nc\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "base" });

    await createBranch(gitDir, "feature");

    await write(dir, "f.txt", "a\nOURS\nc\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "main change" });

    await switchBranch(gitDir, dir, "feature");
    await write(dir, "f.txt", "a\nTHEIRS\nc\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "feature change" });

    await switchBranch(gitDir, dir, "main");
    const r = await merge(gitDir, dir, "feature");
    assert.equal(r.result, "conflict");
    assert.ok(r.conflicts.length > 0);
    assert.equal(r.conflicts[0].path, "f.txt");

    const content = await readFile(path.join(dir, "f.txt"), "utf8");
    assert.match(content, /^<<<<<<< main$/m);
    assert.match(content, /^=======$/m);
    assert.match(content, /^>>>>>>> feature$/m);
    assert.match(content, /OURS/);
    assert.match(content, /THEIRS/);
  });
});

test("resolving a conflict and committing keeps BOTH parents", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "f.txt"), "a\nb\nc\n");
    await add(gitDir, dir, ["."]);
    const c0 = await commit(gitDir, { message: "base" });

    await createBranch(gitDir, "feature");
    await writeFile(path.join(dir, "f.txt"), "a\nM\nc\n");
    await add(gitDir, dir, ["."]);
    const cm = await commit(gitDir, { message: "main change" });

    await switchBranch(gitDir, dir, "feature");
    await writeFile(path.join(dir, "f.txt"), "a\nF\nc\n");
    await add(gitDir, dir, ["."]);
    const cfeat = await commit(gitDir, { message: "feature change" });
    await switchBranch(gitDir, dir, "main");

    const r = await merge(gitDir, dir, "feature");
    assert.equal(r.result, "conflict");

    // 冲突时必须留下 MERGE_HEAD，否则后续 commit 不知道这是合并
    const mergeHead = await readFile(path.join(gitDir, "MERGE_HEAD"), "utf8");
    assert.equal(mergeHead.trim(), cfeat.oid);

    // 人工解决
    await writeFile(path.join(dir, "f.txt"), "a\nRESOLVED\nc\n");
    await add(gitDir, dir, ["."]);
    const resolved = await commit(gitDir, { message: "merge resolved" });

    // 关键断言：解决后的提交必须是双亲合并提交
    // （曾经只写 1 个 parent，导致 feature 分支历史凭空消失）
    const rc = await readCommit(gitDir, resolved.oid);
    assert.equal(rc.parents.length, 2);
    assert.deepEqual(new Set(rc.parents), new Set([cm.oid, cfeat.oid]));

    // 两个分支的历史都必须可达
    const seen = new Set();
    const stack = [resolved.oid];
    while (stack.length) {
      const oid = stack.pop();
      if (seen.has(oid)) continue;
      seen.add(oid);
      const c = await readCommit(gitDir, oid);
      stack.push(...c.parents);
    }
    assert.ok(seen.has(c0.oid), "base commit must remain reachable");
    assert.ok(seen.has(cm.oid), "main-side commit must remain reachable");
    assert.ok(seen.has(cfeat.oid), "feature-side commit must remain reachable");

    // 合并状态必须被清理
    await assert.rejects(
      () => readFile(path.join(gitDir, "MERGE_HEAD"), "utf8"),
      (err) => err.code === "ENOENT"
    );

    // 再次合并应为 up-to-date，而不是重复冲突
    const again = await merge(gitDir, dir, "feature");
    assert.equal(again.result, "up-to-date");
  });
});

test("a non-conflicting merge does not leave MERGE_HEAD behind", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "f.txt"), "1\n2\n3\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "base" });

    await createBranch(gitDir, "feature");
    await writeFile(path.join(dir, "head.txt"), "main side\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "main" });

    await switchBranch(gitDir, dir, "feature");
    await writeFile(path.join(dir, "tail.txt"), "feature side\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "feature" });
    await switchBranch(gitDir, dir, "main");

    const r = await merge(gitDir, dir, "feature");
    assert.equal(r.result, "merged");

    await assert.rejects(
      () => readFile(path.join(gitDir, "MERGE_HEAD"), "utf8"),
      (err) => err.code === "ENOENT"
    );
  });
});

test("merge base is the common ancestor, not the branch tip", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await write(dir, "a.txt", "1\n");
    await add(gitDir, dir, ["."]);
    const base = await commit(gitDir, { message: "base" });

    await createBranch(gitDir, "feature");

    await write(dir, "a.txt", "2\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "main 1" });

    await switchBranch(gitDir, dir, "feature");
    await write(dir, "b.txt", "x\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "feat 1" });

    await switchBranch(gitDir, dir, "main");
    const r = await merge(gitDir, dir, "feature");
    assert.equal(r.result, "merged");
    assert.equal(r.baseOid, base.oid, "merge base must be the common ancestor");
  });
});

test("merging a non-existent branch throws", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await write(dir, "a.txt", "1\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "base" });
    await assert.rejects(() => merge(gitDir, dir, "nope"), /分支不存在/);
  });
});
