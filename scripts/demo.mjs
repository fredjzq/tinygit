#!/usr/bin/env node
// 演示脚本：在临时目录里完整走一遍 tinygit 的工作流，并打印每一步的真实输出。
// 用途是让人在一分钟内看懂这个工具到底做了什么。

import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);
const root = process.cwd();
const demo = path.join(root, ".demo-repo");

async function tinygit(args, cwd = demo) {
  try {
    const { stdout } = await exec(process.execPath, [path.join(root, "bin", "tinygit.js"), ...args], {
      cwd, timeout: 60000, maxBuffer: 1e7,
    });
    return stdout.trim();
  } catch (err) {
    return "  (exit " + err.code + ") " + ((err.stdout ?? "") + (err.stderr ?? "")).trim();
  }
}

function step(n, title) {
  console.log("\n" + "─".repeat(64));
  console.log("步骤 " + n + ": " + title);
  console.log("─".repeat(64));
}

async function main() {
  await rm(demo, { recursive: true, force: true });
  await mkdir(demo, { recursive: true });

  step(1, "初始化仓库");
  console.log(await tinygit(["init"]));

  step(2, "写入几个文件");
  await writeFile(path.join(demo, "README.md"), "# 演示仓库\n\n由 tinygit 创建。\n");
  await mkdir(path.join(demo, "src"), { recursive: true });
  await writeFile(path.join(demo, "src", "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  await writeFile(path.join(demo, ".gitignore"), "*.log\n");
  await writeFile(path.join(demo, "debug.log"), "不该被提交\n");
  console.log("  写入 README.md / src/math.js / debug.log / .gitignore");

  step(3, "查看状态（应该看到 untracked）");
  console.log(await tinygit(["status"]));

  step(4, "暂存（.gitignore 应让 debug.log 被跳过）");
  console.log(await tinygit(["add", "."]));

  step(5, "查看已暂存状态");
  console.log(await tinygit(["status"]));

  step(6, "第一次提交");
  console.log(await tinygit(["commit", "-m", "初始提交：建立仓库骨架"]));

  step(7, "修改文件后再提交一次");
  await writeFile(path.join(demo, "src", "math.js"), "export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n");
  console.log(await tinygit(["diff"]));
  await tinygit(["add", "."]);
  console.log(await tinygit(["commit", "-m", "新增 mul 函数"]));

  step(8, "提交历史");
  console.log(await tinygit(["log"]));

  step(9, "分支");
  console.log(await tinygit(["branch", "feature"]));
  console.log(await tinygit(["branch"]));

  step(10, "对象检视：读出一棵 tree");
  // 注意：--oneline 只输出 7 位短 oid，cat-file 需要完整 40 位，
  // 所以这里用完整 log 输出解析。
  const logOut = await tinygit(["log", "-n", "1"]);
  const headOid = /^commit ([0-9a-f]{40})$/m.exec(logOut)?.[1];
  console.log("  HEAD commit: " + headOid);
  const catCommit = await tinygit(["cat-file", headOid]);
  const treeOid = /^tree ([0-9a-f]{40})$/m.exec(catCommit)?.[1];
  console.log("  该提交的 tree: " + treeOid);
  console.log(await tinygit(["ls-tree", treeOid]));

  step(11, "独立验证器：从零重写 Git 格式规则来校验这个仓库");
  const { stdout: verifyOut } = await exec(process.execPath, [path.join(root, "scripts", "verify.mjs"), demo], {
    timeout: 60000, maxBuffer: 1e7,
  });
  console.log(verifyOut.trim());

  step(12, "清理");
  await rm(demo, { recursive: true, force: true });
  console.log("  已删除临时演示仓库");
  console.log("\n演示完成。\n");
}

main().catch(async (err) => {
  console.error("demo failed:", err);
  await rm(demo, { recursive: true, force: true }).catch(() => {});
  process.exitCode = 1;
});
