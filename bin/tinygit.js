#!/usr/bin/env node
// tinygit 命令行入口。
//
// 设计原则：错误信息要能指导修复，而不是只抛 stack trace。
// 所有「用户用错了」的情况都返回退出码 1，只有内部异常才是 2。

import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "../src/args.js";
import { initRepo } from "../src/repo.js";
import { requireRepo } from "../src/context.js";
import { log } from "../src/logger.js";

const USAGE = [
  "tinygit — 用纯 JavaScript 实现的 Git 子集",
  "",
  "用法: tinygit <命令> [选项]",
  "",
  "仓库:",
  "  init [目录]                 初始化仓库",
  "  status                      工作区状态",
  "  add <路径...>               暂存文件",
  "  rm <路径...>                从索引移除（保留工作区文件）",
  "  commit -m <消息>            提交",
  "  log [--oneline] [-n N]      提交历史",
  "",
  "检视:",
  "  diff [--staged] [<a> <b>]   显示差异",
  "  ls-tree <tree>              列出树内容",
  "  cat-file <对象>             输出对象内容",
  "  hash-object <文件>          计算（并写入）blob",
  "",
  "分支:",
  "  branch [-d <名>] [<名>]     列出/创建/删除分支",
  "  checkout <分支>             切换分支",
  "  merge <分支>                合并分支（快进/三方归并）",
  "",
  "packfile:",
  "  pack-info                   显示打包对象统计",
  "",
  "退出码: 0 成功 · 1 用法/前置条件错误 · 2 内部异常",
].join("\n");

async function main(argv) {
  const { command, args, flags } = parseArgs(argv);

  if (!command || command === "help" || flags.help) {
    console.log(USAGE);
    return 0;
  }

  if (command === "version" || flags.version) {
    console.log("tinygit 1.0.0");
    return 0;
  }

  if (command === "init") {
    const target = path.resolve(args[0] ?? ".");
    const gitDir = await initRepo(target, {
      defaultBranch: flags.branch ?? "main",
      force: flags.force === true,
    });
    log.success("初始化仓库 " + path.relative(process.cwd(), gitDir));
    return 0;
  }

  const { gitDir, rootDir } = await requireRepo(process.cwd());

  switch (command) {
    case "status": {
      const { status, formatStatus } = await import("../src/commands/status.js");
      process.stdout.write(formatStatus(await status(gitDir, rootDir)));
      return 0;
    }
    case "add": {
      if (args.length === 0) throw new Error("add: 需要至少一个路径（或用 . 暂存全部）");
      const { add } = await import("../src/commands/add.js");
      const added = await add(gitDir, rootDir, args);
      log.success("暂存 " + added.length + " 个文件");
      return 0;
    }
    case "commit": {
      const { commit } = await import("../src/commands/commit.js");
      const message = flags.m ?? flags.message;
      if (!message) throw new Error("commit: 需要 -m <消息>");
      const result = await commit(gitDir, { message, allowEmpty: flags["allow-empty"] === true });
      log.success("[" + result.ref.replace(/^refs\/heads\//, "") + " " + result.oid.slice(0, 7) + "] " + message);
      return 0;
    }
    case "rm": {
      if (args.length === 0) throw new Error("rm: 需要至少一个路径");
      const { removeFromIndex } = await import("../src/commands/add.js");
      const n = await removeFromIndex(gitDir, args);
      if (n === 0) log.info("没有匹配的已暂存文件");
      else log.success("从索引移除 " + n + " 个文件（工作区文件保留）");
      return 0;
    }
    case "log": {
      const { log: readLog, formatLog } = await import("../src/commands/log.js");
      const commits = await readLog(gitDir, {
        limit: flags.n ? Number(flags.n) : 20,
        oneline: flags.oneline === true,
      });
      if (commits.length === 0) { console.log("暂无提交"); return 0; }
      process.stdout.write(formatLog(commits, { oneline: flags.oneline === true }));
      return 0;
    }
    case "diff": {
      const { diffWorktree, diffCommits, diffStaged } = await import("../src/commands/diff.js");
      let patches;
      if (flags.staged === true) patches = await diffStaged(gitDir);
      else if (args.length >= 2) patches = await diffCommits(gitDir, args[0], args[1]);
      else patches = await diffWorktree(gitDir, rootDir);
      if (patches.length === 0) { console.log("无差异"); return 0; }
      process.stdout.write(patches.join("\n"));
      return 0;
    }
    case "ls-tree": {
      if (!args[0]) throw new Error("ls-tree: 需要 tree 对象 id");
      const { lsTree, formatLsTree } = await import("../src/commands/inspect.js");
      process.stdout.write(formatLsTree(await lsTree(gitDir, args[0])));
      return 0;
    }
    case "cat-file": {
      if (!args[0]) throw new Error("cat-file: 需要对象 id");
      const { catFile } = await import("../src/commands/inspect.js");
      const obj = await catFile(gitDir, args[0]);
      process.stdout.write(obj.content);
      if (!obj.content.length || obj.content[obj.content.length - 1] !== 10) process.stdout.write("\n");
      return 0;
    }
    case "hash-object": {
      if (!args[0]) throw new Error("hash-object: 需要文件路径");
      const { readFile } = await import("node:fs/promises");
      const { writeObject } = await import("../src/objects.js");
      const buf = await readFile(path.resolve(args[0]));
      const oid = await writeObject(gitDir, "blob", buf);
      console.log(oid);
      return 0;
    }
    case "branch": {
      const { branchList, createBranch, deleteBranch } = await import("../src/commands/branch.js");
      if (flags.d) {
        await deleteBranch(gitDir, String(flags.d), { force: flags.D === true });
        log.success("删除分支 " + flags.d);
        return 0;
      }
      if (args[0]) {
        await createBranch(gitDir, args[0]);
        log.success("创建分支 " + args[0]);
        return 0;
      }
      const branches = await branchList(gitDir);
      if (branches.length === 0) { console.log("暂无分支"); return 0; }
      for (const b of branches) console.log((b.current ? "* " : "  ") + b.name);
      return 0;
    }
    case "checkout": {
      if (!args[0]) throw new Error("checkout: 需要分支名");
      const { switchBranch } = await import("../src/commands/branch.js");
      const r = await switchBranch(gitDir, rootDir, args[0]);
      log.success("切换到分支 " + args[0] + (r.created ? "（新建）" : ""));
      return 0;
    }
    case "merge": {
      if (!args[0]) throw new Error("merge: 需要分支名");
      const { merge } = await import("../src/commands/merge.js");
      const r = await merge(gitDir, rootDir, args[0], {
        message: flags.m ?? flags.message ?? null,
        noCommit: flags["no-commit"] === true,
      });
      if (r.result === "up-to-date") {
        console.log("已经是最新，无需合并（" + r.branch + " 已包含在当前分支中）");
      } else if (r.result === "fast-forward") {
        log.success("快进到 " + r.branch + " " + r.oid.slice(0, 7));
      } else if (r.result === "conflict") {
        log.error("合并产生冲突，需手工解决：");
        for (const c of r.conflicts) console.log("  ✗ " + c.path + (c.binary ? "（二进制）" : "  " + c.regions + " 处冲突"));
        console.log("\n解决后运行: tinygit add . && tinygit commit -m \"合并完成\"");
        return 1;
      } else if (r.result === "merged-not-committed") {
        log.success("合并完成（未提交）");
      } else {
        log.success("合并提交 " + r.oid.slice(0, 7) + "（合并基 " + (r.baseOid ?? "").slice(0, 7) + "）");
      }
      return 0;
    }
    case "pack-info": {
      const { createPackRepository } = await import("../src/pack/index.js");
      const repo = createPackRepository(gitDir);
      const stats = await repo.stats();
      console.log("pack 文件: " + stats.packCount);
      console.log("对象总数: " + stats.objectCount);
      console.log("类型分布: " + JSON.stringify(stats.byType));
      console.log("总字节  : " + stats.totalBytes);
      return 0;
    }
    default:
      throw new Error("未知命令: " + command + "（运行 tinygit help 查看用法）");
  }
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    const message = err?.message ?? String(err);
    log.error(message);
    process.exitCode = 1;
  });
