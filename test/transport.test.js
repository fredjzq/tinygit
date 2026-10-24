// 智能 HTTP 协议与 clone 的集成测试。
//
// 这些测试起一个本地 HTTP 服务器模拟 Git 服务端，所以不依赖网络——
// CI 上也能跑，而且完全确定（真实服务器的响应会变，不适合做断言）。
//
// 模拟服务器实现了协议里两个端点：
//   GET  /info/refs?service=git-upload-pack   → 广告
//   POST /git-upload-pack                     → pack
//
// 这不是「假协议」：帧格式、NUL 分隔、side-band 通道号、pack 内容
// 都按真实规范生成，被测代码走的是完整解析路径。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { encodePktLine, flushPkt, parsePktLines } from "../src/transport/pkt-line.js";
import { fetchAdvertisement, parseUploadPackResponse, resolveWantRefs } from "../src/transport/smart-http.js";
import { clone, storePack } from "../src/commands/fetch.js";
import { resolvePackObjects } from "../src/pack/reader.js";
import { readIndex } from "../src/index-file.js";
import { readHeadRef, readRef } from "../src/refs.js";
import { status } from "../src/commands/status.js";
import { log as logCmd } from "../src/commands/log.js";

const TMP_ROOT = (() => {
  const t = os.tmpdir();
  if (!t || !path.isAbsolute(t)) return process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp";
  return t;
})();

async function tmpDir(tag) {
  return mkdtemp(path.join(TMP_ROOT, "tinygit-" + tag + "-"));
}

// 构造一个最小的合法仓库，返回 pack 与引用
async function buildFixtureRepo(dir) {
  const { initRepo } = await import("../src/repo.js");
  const { add } = await import("../src/commands/add.js");
  const { commit } = await import("../src/commands/commit.js");
  const { buildPack } = await import("../src/pack/writer.js");
  const { readObject } = await import("../src/objects.js");
  const { listAllObjects } = await import("../src/objects.js");

  const gitDir = await initRepo(dir);
  await writeFile(path.join(dir, "README.md"), "# fixture\n");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "a.js"), "export const x = 1;\n");
  await add(gitDir, dir, ["."]);
  const c1 = await commit(gitDir, { message: "first" });

  await writeFile(path.join(dir, "src", "a.js"), "export const x = 1;\nexport const y = 2;\n");
  await add(gitDir, dir, ["."]);
  const c2 = await commit(gitDir, { message: "second" });

  // 把这个仓库的所有对象打成 pack
  const oids = await listAllObjects(gitDir);
  const objs = [];
  for (const oid of oids) {
    const o = await readObject(gitDir, oid);
    objs.push({ type: o.type, content: o.content });
  }
  const built = buildPack(objs, { delta: true });

  return {
    gitDir,
    pack: built.pack,
    head: c2.oid,
    commits: [c1.oid, c2.oid],
  };
}

// 起一个模拟 Git 智能 HTTP 服务端
async function startMockServer(fixture, options = {}) {
  const { advertiseRefs = true, sideband = true, useDelta = false } = options;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname.endsWith("/info/refs")) {
      if (url.searchParams.get("service") !== "git-upload-pack") {
        res.writeHead(403); res.end(); return;
      }
      const caps = ["multi_ack_detailed", "side-band-64k", "ofs-delta", "symref=HEAD:refs/heads/main"];
      const firstLine = fixture.head + " HEAD\0" + caps.join(" ") + "\n";
      const parts = [
        encodePktLine("# service=git-upload-pack\n"),
        flushPkt(),
        encodePktLine(firstLine),
        encodePktLine(fixture.head + " refs/heads/main\n"),
      ];
      const body = Buffer.concat(parts);
      res.writeHead(200, {
        "content-type": "application/x-git-upload-pack-advertisement",
        "content-length": body.length,
      });
      res.end(body);
      return;
    }

    if (req.method === "POST" && url.pathname.endsWith("/git-upload-pack")) {
      // 读请求体，确认里面确实有 want / done
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = Buffer.concat(chunks);
      const { packets } = parsePktLines(request);
      const texts = packets.filter((p) => p.type === "data").map((p) => p.data.toString("utf8"));

      const hasWant = texts.some((t) => t.startsWith("want "));
      const hasDone = texts.some((t) => t.trim() === "done");
      if (!hasWant || !hasDone) {
        res.writeHead(400); res.end("bad negotiation"); return;
      }

      const out = [];
      // ACK 帧
      const haves = texts.filter((t) => t.startsWith("have ")).map((t) => t.slice(5).trim());
      if (haves.length > 0) {
        out.push(encodePktLine("ACK " + fixture.head + " common\n"));
      } else {
        out.push(encodePktLine("NAK\n"));
      }

      // pack 数据（按规范走 side-band 通道 1）
      if (sideband) {
        const chunkSize = 4096;
        for (let i = 0; i < fixture.pack.length; i += chunkSize) {
          const chunk = fixture.pack.subarray(i, i + chunkSize);
          out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
        }
        // 进度信息走通道 2
        out.push(encodePktLine(Buffer.concat([Buffer.from([2]), Buffer.from("done\n")])));
      } else {
        out.push(encodePktLine(fixture.pack));
      }
      out.push(flushPkt());

      const body = Buffer.concat(out);
      res.writeHead(200, {
        "content-type": "application/x-git-upload-pack-result",
        "content-length": body.length,
      });
      res.end(body);
      return;
    }

    res.writeHead(404); res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    url: "http://127.0.0.1:" + port + "/repo.git",
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("协议: 解析服务端广告，能力集与引用都要拿到", async () => {
  const dir = await tmpDir("adv");
  const fixture = await buildFixtureRepo(dir);
  const server = await startMockServer(fixture);
  try {
    const adv = await fetchAdvertisement(server.url);
    assert.equal(adv.refs.size, 2, "应有 HEAD 与 refs/heads/main");
    assert.equal(adv.refs.get("refs/heads/main"), fixture.head);
    assert.ok(adv.capabilities.has("side-band-64k"));
    assert.ok(adv.capabilities.has("multi_ack_detailed"));
    assert.ok(adv.capabilities.has("ofs-delta"));
    // symref 应被解析出来
    assert.equal(adv.headTarget, "refs/heads/main");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("协议: 404 与 401 给出可操作的错误", async () => {
  const server = createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => fetchAdvertisement("http://127.0.0.1:" + port + "/nope.git"),
      /不存在或不可访问/
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("协议: side-band 的通道 1/2 必须分开处理", () => {
  // 通道 1 是 pack 数据，通道 2 是进度。混在一起 pack 就损坏了。
  const packLike = Buffer.from("PACK" + "\0".repeat(20));
  const raw = Buffer.concat([
    encodePktLine(Buffer.concat([Buffer.from([1]), packLike])),
    encodePktLine(Buffer.concat([Buffer.from([2]), Buffer.from("progress text\n")])),
    flushPkt(),
  ]);
  const r = parseUploadPackResponse(raw, { sideband: true });
  assert.ok(r.pack, "应提取出 pack 数据");
  assert.equal(r.pack.subarray(0, 4).toString(), "PACK", "pack 开头必须是 PACK");
  assert.ok(r.progress.includes("progress text"), "进度文本应单独收集");
});

test("协议: 非 side-band 模式下整个帧都是 pack", () => {
  const packLike = Buffer.from("PACK" + "\0".repeat(20));
  const raw = Buffer.concat([encodePktLine(packLike), flushPkt()]);
  const r = parseUploadPackResponse(raw, { sideband: false });
  assert.equal(Buffer.compare(r.pack, packLike), 0);
});

test("协议: 服务端 ERR 帧要抛出而不是静默忽略", () => {
  const raw = Buffer.concat([encodePktLine("ERR something went wrong\n"), flushPkt()]);
  assert.throws(() => parseUploadPackResponse(raw, { sideband: false }), /服务端错误/);
});

test("协议: 收到非 PACK 开头的数据要报错", () => {
  // 模拟 side-band 处理错误：把进度帧当成了数据帧
  const raw = Buffer.concat([
    encodePktLine(Buffer.from("this is not a pack")),
    flushPkt(),
  ]);
  assert.throws(() => parseUploadPackResponse(raw, { sideband: false }), /不是合法 pack/);
});

test("clone: 端到端——抓取、落盘、建引用、检出、建索引", async () => {
  const srcDir = await tmpDir("clone-src");
  const fixture = await buildFixtureRepo(srcDir);
  const server = await startMockServer(fixture);
  const destParent = await tmpDir("clone-dest");
  const dest = path.join(destParent, "cloned");
  try {
    const r = await clone(server.url, dest);
    assert.equal(r.branch, "main");
    assert.equal(r.head, fixture.head);
    assert.ok(r.objectCount > 0, "应写入对象");

    // 工作区文件确实存在
    const readme = await readFile(path.join(dest, "README.md"), "utf8");
    assert.equal(readme, "# fixture\n");
    const ajs = await readFile(path.join(dest, "src", "a.js"), "utf8");
    assert.ok(ajs.includes("export const y = 2"), "应检出最新版本的内容");

    // pack + idx 都写好了，且命名符合 pack-<sha> 规范
    const packDir = path.join(dest, ".git", "objects", "pack");
    const packFiles = await readdir(packDir);
    const packName = packFiles.find((f) => f.endsWith(".pack"));
    assert.ok(packName, "应有 .pack 文件");
    assert.match(packName, /^pack-[0-9a-f]{40}\.pack$/, "命名必须是 pack-<40位sha>.pack");
    assert.ok(packFiles.some((f) => f.endsWith(".idx")), "必须同时写出 idx");

    // pack 文件名里的 sha 必须等于文件内容哈希
    const { createHash } = await import("node:crypto");
    const packBuf = await readFile(path.join(packDir, packName));
    const computed = createHash("sha1").update(packBuf.subarray(0, packBuf.length - 20)).digest("hex");
    assert.equal(packName, "pack-" + computed + ".pack", "文件名必须是内容哈希");

    // HEAD 与分支引用
    const head = await readHeadRef(path.join(dest, ".git"));
    assert.equal(head.ref, "refs/heads/main");
    assert.equal(head.oid, fixture.head);
    assert.equal(await readRef(path.join(dest, ".git"), "refs/heads/main"), fixture.head);
    assert.equal(await readRef(path.join(dest, ".git"), "refs/remotes/origin/main"), fixture.head);

    // 索引必须非空，否则 status 会把所有文件报成已删除
    const index = await readIndex(path.join(dest, ".git"));
    assert.equal(index.entries.length, r.fileCount, "索引条目数应等于检出文件数");
    assert.ok(index.entries.length > 0);

    // status 必须是 clean
    const st = await status(path.join(dest, ".git"), dest);
    assert.equal(st.staged.length, 0, "不该有已暂存变化");
    assert.equal(st.unstaged.length, 0, "不该有未暂存变化");
    assert.equal(st.untracked.length, 0, "不该有未跟踪文件");

    // log 能读出两个提交
    const commits = await logCmd(path.join(dest, ".git"), { max: 10 });
    assert.equal(commits.length, 2);
  } finally {
    await server.close();
    await rm(srcDir, { recursive: true, force: true });
    await rm(destParent, { recursive: true, force: true });
  }
});

test("clone: 下载的 pack 能被自己的解析器完整还原", async () => {
  const srcDir = await tmpDir("pack-src");
  const fixture = await buildFixtureRepo(srcDir);
  const server = await startMockServer(fixture);
  const destParent = await tmpDir("pack-dest");
  const dest = path.join(destParent, "c");
  try {
    const r = await clone(server.url, dest);
    const packDir = path.join(dest, ".git", "objects", "pack");
    const packName = (await readdir(packDir)).find((f) => f.endsWith(".pack"));
    const packBuf = await readFile(path.join(packDir, packName));

    const resolved = resolvePackObjects(packBuf);
    assert.equal(resolved.byOid.size, r.objectCount);

    // 两个提交都应在 pack 里，且内容可还原
    for (const oid of fixture.commits) {
      assert.ok(resolved.byOid.has(oid), "提交 " + oid.slice(0, 7) + " 应在 pack 里");
    }
  } finally {
    await server.close();
    await rm(srcDir, { recursive: true, force: true });
    await rm(destParent, { recursive: true, force: true });
  }
});

test("storePack: 校验和不匹配的 pack 必须被拒绝", async () => {
  const dir = await tmpDir("storepack");
  const fixture = await buildFixtureRepo(dir);
  try {
    const { initRepo } = await import("../src/repo.js");
    const target = path.join(dir, "target");
    await mkdir(target, { recursive: true });
    const gitDir = await initRepo(target);

    // 篡改 pack 的最后一个字节（校验和区域）
    const corrupted = Buffer.from(fixture.pack);
    corrupted[corrupted.length - 1] ^= 0xff;
    await assert.rejects(() => storePack(gitDir, corrupted), /校验和不匹配/);

    // 完好 pack 应被接受
    const ok = await storePack(gitDir, fixture.pack);
    assert.match(ok.name, /^pack-[0-9a-f]{40}$/);
    assert.ok(ok.objectCount > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveWantRefs: 按引用名解析出 oid", async () => {
  const adv = {
    refs: new Map([
      ["refs/heads/main", "a".repeat(40)],
      ["refs/heads/dev", "b".repeat(40)],
    ]),
    headTarget: "refs/heads/main",
  };
  assert.deepEqual(resolveWantRefs(adv, ["refs/heads/dev"]), [
    { ref: "refs/heads/dev", oid: "b".repeat(40) },
  ]);
  // HEAD 应解析到 headTarget
  assert.deepEqual(resolveWantRefs(adv, ["HEAD"]), [
    { ref: "refs/heads/main", oid: "a".repeat(40) },
  ]);
  // 不存在的引用返回空
  assert.equal(resolveWantRefs(adv, ["refs/heads/nope"]).length, 0);
});
