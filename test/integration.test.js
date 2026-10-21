// 端到端测试：真的建仓库、暂存、提交、读回。
//
// 这些测试跑在临时目录里，不碰项目自身。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";

// os.tmpdir() 依赖 TEMP/TMP 环境变量；若缺失会返回畸形路径。
// CI 或精简环境里必须兜底，否则整组测试直接崩。
const TMP_ROOT = (() => {
  try {
    const d = os.tmpdir();
    if (d && !d.includes("undefined")) return d;
  } catch {}
  return process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp";
})();
import path from "node:path";
import { initRepo } from "../src/repo.js";
import { add } from "../src/commands/add.js";
import { commit } from "../src/commands/commit.js";
import { status } from "../src/commands/status.js";
import { log } from "../src/commands/log.js";
import { readHeadRef } from "../src/refs.js";
import { createBranch, switchBranch } from "../src/commands/branch.js";
import { merge } from "../src/commands/merge.js";
import { readCommit } from "../src/commit.js";
import { flattenTree } from "../src/tree.js";
import { readObject } from "../src/objects.js";
import { hashObject } from "../src/objects.js";

async function withRepo(fn) {
  const dir = await mkdtemp(path.join(TMP_ROOT, "tinygit-test-"));
  try {
    const gitDir = await initRepo(dir);
    await fn({ dir, gitDir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("init creates a valid .git layout", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    assert.equal(gitDir, path.join(dir, ".git"));
    const head = await readFile(path.join(gitDir, "HEAD"), "utf8");
    assert.equal(head, "ref: refs/heads/main\n");
    assert.ok(await readFile(path.join(gitDir, "config"), "utf8"));
  });
});

test("add + commit produces a commit pointing at a tree", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "a.txt"), "hello\n");
    await add(gitDir, dir, ["."]);
    const r = await commit(gitDir, { message: "first\n" });
    assert.match(r.oid, /^[0-9a-f]{40}$/);

    const c = await readCommit(gitDir, r.oid);
    assert.match(c.tree, /^[0-9a-f]{40}$/);
    assert.equal(c.parents.length, 0);

    const files = await flattenTree(gitDir, c.tree);
    assert.ok(files.has("a.txt"));
    const blob = await readObject(gitDir, files.get("a.txt").oid);
    assert.equal(blob.content.toString("utf8"), "hello\n");
  });
});

test("blob stored in commit has the same oid as hash-object would give", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "x.txt"), "content");
    await add(gitDir, dir, ["."]);
    const r = await commit(gitDir, { message: "c" });
    const c = await readCommit(gitDir, r.oid);
    const files = await flattenTree(gitDir, c.tree);
    assert.equal(files.get("x.txt").oid, hashObject("blob", "content"));
  });
});

test("second commit has the first as parent", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "a.txt"), "1\n");
    await add(gitDir, dir, ["."]);
    const first = await commit(gitDir, { message: "one" });

    await writeFile(path.join(dir, "a.txt"), "2\n");
    await add(gitDir, dir, ["."]);
    const second = await commit(gitDir, { message: "two" });

    const c2 = await readCommit(gitDir, second.oid);
    assert.equal(c2.parents[0], first.oid);

    const c1 = await readCommit(gitDir, first.oid);
    assert.notEqual(c1.tree, c2.tree, "trees must differ when content differs");
  });
});

test("empty commit is rejected when nothing staged", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await assert.rejects(() => commit(gitDir, { message: "x" }), /nothing staged/);
  });
});

test("commit with no change is rejected", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "a.txt"), "same\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "one" });
    await add(gitDir, dir, ["."]);
    await assert.rejects(() => commit(gitDir, { message: "two" }), /nothing to commit/);
  });
});

test("nested directories produce nested trees", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await mkdir(path.join(dir, "src", "deep"), { recursive: true });
    await writeFile(path.join(dir, "src", "deep", "f.js"), "x");
    await writeFile(path.join(dir, "root.txt"), "r");
    await add(gitDir, dir, ["."]);
    const r = await commit(gitDir, { message: "nested" });
    const c = await readCommit(gitDir, r.oid);
    const files = await flattenTree(gitDir, c.tree);
    assert.ok(files.has("root.txt"));
    assert.ok(files.has("src/deep/f.js"));
  });
});

test("status reports untracked then staged then clean", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "a.txt"), "a\n");
    let s = await status(gitDir, dir);
    assert.deepEqual(s.untracked, ["a.txt"]);
    assert.equal(s.staged.length, 0);

    await add(gitDir, dir, ["."]);
    s = await status(gitDir, dir);
    assert.equal(s.staged.length, 1);
    assert.equal(s.staged[0].path, "a.txt");
    assert.equal(s.staged[0].kind, "added");

    await commit(gitDir, { message: "c" });
    s = await status(gitDir, dir);
    assert.equal(s.staged.length, 0);
    assert.equal(s.unstaged.length, 0);
    assert.equal(s.untracked.length, 0);
  });
});

test("log walks the parent chain newest first", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    for (const n of [1, 2, 3]) {
      await writeFile(path.join(dir, "f.txt"), "v" + n + "\n");
      await add(gitDir, dir, ["."]);
      await commit(gitDir, { message: "commit " + n });
    }
    const commits = await log(gitDir, { limit: 10 });
    assert.equal(commits.length, 3);
    assert.equal(commits[0].message.trim(), "commit 3");
    assert.equal(commits[2].message.trim(), "commit 1");
  });
});

test("log traverses ALL parents, not just the first", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "f.txt"), "a\nb\nc\n");
    await add(gitDir, dir, ["."]);
    const c0 = await commit(gitDir, { message: "base" });

    await createBranch(gitDir, "feature");
    await writeFile(path.join(dir, "f.txt"), "a\nM\nc\n");
    await add(gitDir, dir, ["."]);
    const cm = await commit(gitDir, { message: "main-change" });

    await switchBranch(gitDir, dir, "feature");
    await writeFile(path.join(dir, "f.txt"), "a\nF\nc\n");
    await add(gitDir, dir, ["."]);
    const cfeat = await commit(gitDir, { message: "feature-change" });
    await switchBranch(gitDir, dir, "main");

    await merge(gitDir, dir, "feature");
    await writeFile(path.join(dir, "f.txt"), "a\nOK\nc\n");
    await add(gitDir, dir, ["."]);
    const cres = await commit(gitDir, { message: "resolved" });

    const commits = await log(gitDir, { limit: 20 });

    // 两个分支的提交都必须出现。
    // 早期实现只跟 parents[0]，feature 一侧的提交会整体消失。
    const oids = commits.map((c) => c.oid);
    assert.ok(oids.includes(c0.oid), "base must appear");
    assert.ok(oids.includes(cm.oid), "main-side commit must appear");
    assert.ok(oids.includes(cfeat.oid), "feature-side commit must appear");
    assert.ok(oids.includes(cres.oid), "merge commit must appear");
    assert.equal(commits.length, 4);
  });
});

test("log orders commits so parents never precede their children", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "f.txt"), "1\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "one" });
    for (const n of [2, 3, 4]) {
      await writeFile(path.join(dir, "f.txt"), "v" + n + "\n");
      await add(gitDir, dir, ["."]);
      await commit(gitDir, { message: "commit " + n });
    }

    const commits = await log(gitDir, { limit: 10 });
    const position = new Map(commits.map((c, i) => [c.oid, i]));

    // 对任意提交，其所有父提交都必须排在它后面（索引更大）
    for (const c of commits) {
      for (const p of c.parents) {
        if (!position.has(p)) continue;
        assert.ok(
          position.get(p) > position.get(c.oid),
          "parent " + p.slice(0, 7) + " must come after child " + c.oid.slice(0, 7)
        );
      }
    }
    assert.equal(commits[0].message.trim(), "commit 4", "newest first");
  });
});

test("log respects the limit on a merged history", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    for (const n of [1, 2, 3, 4, 5]) {
      await writeFile(path.join(dir, "f.txt"), "v" + n + "\n");
      await add(gitDir, dir, ["."]);
      await commit(gitDir, { message: "c" + n });
    }
    const commits = await log(gitDir, { limit: 2 });
    assert.equal(commits.length, 2);
  });
});

test("gitignore excludes matching files", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, ".gitignore"), "*.log\nnode_modules/\n");
    await writeFile(path.join(dir, "keep.txt"), "k");
    await writeFile(path.join(dir, "skip.log"), "s");
    await mkdir(path.join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", "x", "i.js"), "i");
    await add(gitDir, dir, ["."]);
    const r = await commit(gitDir, { message: "ignore" });
    const c = await readCommit(gitDir, r.oid);
    const files = await flattenTree(gitDir, c.tree);
    assert.ok(files.has("keep.txt"));
    assert.ok(files.has(".gitignore"));
    assert.ok(!files.has("skip.log"), "*.log should be ignored");
    assert.ok(!files.has("node_modules/x/i.js"), "node_modules should be ignored");
  });
});

// 注意：这个用例只能在 POSIX 上跑。
// Windows 的 NTFS 没有 POSIX 可执行位，chmod 0o755 之后 stat().mode 仍是 100666，
// 所以断言 100755 会必然失败——这是平台限制，不是实现缺陷。
const isPosix = process.platform !== "win32";

test("executable bit is preserved in tree mode", { skip: isPosix ? false : "NTFS has no POSIX exec bit" }, async () => {
  await withRepo(async ({ dir, gitDir }) => {
    const script = path.join(dir, "run.sh");
    await writeFile(script, "#!/bin/sh\necho hi\n");
    const { chmod } = await import("node:fs/promises");
    await chmod(script, 0o755);
    await add(gitDir, dir, ["."]);
    const r = await commit(gitDir, { message: "exec" });
    const c = await readCommit(gitDir, r.oid);
    const files = await flattenTree(gitDir, c.tree);
    assert.equal(parseInt(files.get("run.sh").mode, 8), 0o100755);
  });
});

test("status does not write objects (must be read-only)", async () => {
  const dir = await mkdtemp(path.join(TMP_ROOT, "tinygit-status-"));
  try {
    const gitDir = await initRepo(dir);
    await writeFile(path.join(dir, "tracked.txt"), "tracked\n");
    await add(gitDir, dir, ["."]);
    await commit(gitDir, { message: "init" });

    // 一个未跟踪文件：真 git 的 status 绝不会把它写进对象库。
    // 早期版本用 writeObject 算哈希，导致每跑一次 status 就往 .git 塞 blob。
    await writeFile(path.join(dir, "untracked.txt"), "u".repeat(50000));

    const { listAllObjects } = await import("../src/objects.js");
    const before = (await listAllObjects(gitDir)).length;
    await status(gitDir, dir);
    await status(gitDir, dir);
    const after = (await listAllObjects(gitDir)).length;

    assert.equal(after, before, "status must not create objects");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("plain file mode is 100644 on every platform", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "plain.txt"), "hi\n");
    await add(gitDir, dir, ["."]);
    const r = await commit(gitDir, { message: "plain" });
    const c = await readCommit(gitDir, r.oid);
    const files = await flattenTree(gitDir, c.tree);
    assert.equal(parseInt(files.get("plain.txt").mode, 8), 0o100644);
  });
});

test("HEAD stays a symref and the branch file holds the oid", async () => {
  await withRepo(async ({ dir, gitDir }) => {
    await writeFile(path.join(dir, "a.txt"), "a");
    await add(gitDir, dir, ["."]);
    const r = await commit(gitDir, { message: "c" });
    const head = await readHeadRef(gitDir);
    assert.equal(head.ref, "refs/heads/main");
    assert.equal(head.oid, r.oid);
    const branchFile = await readFile(path.join(gitDir, "refs", "heads", "main"), "utf8");
    assert.equal(branchFile.trim(), r.oid);
  });
});
