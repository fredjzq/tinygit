// 仓库布局与 .git 目录的初始化。
//
// 与真 Git 一致的目录结构：
//   .git/HEAD              当前分支符号引用
//   .git/config            最小配置
//   .git/objects/          松散对象（aa/bbbb...，即 sha 前两位做目录）
//   .git/refs/heads/       分支
//   .git/index             暂存区（二进制）

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

export async function findGitDir(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, ".git");
    try {
      const st = await readFile(path.join(candidate, "HEAD"));
      void st;
      return candidate;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

export async function initRepo(targetDir, { defaultBranch = "main", force = false } = {}) {
  const gitDir = path.join(targetDir, ".git");
  const already = await readFile(path.join(gitDir, "HEAD"), "utf8").then(() => true, () => false);
  if (already && !force) {
    throw new Error("repository already exists: " + path.relative(process.cwd(), gitDir) || ".git");
  }

  await mkdir(path.join(gitDir, "objects"), { recursive: true });
  await mkdir(path.join(gitDir, "refs", "heads"), { recursive: true });
  await mkdir(path.join(gitDir, "refs", "tags"), { recursive: true });
  await mkdir(path.join(gitDir, "info"), { recursive: true });

  await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/" + defaultBranch + "\n");
  await writeFile(
    path.join(gitDir, "config"),
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n" +
      "[init]\n\tdefaultBranch = " + defaultBranch + "\n"
  );
  await writeFile(path.join(gitDir, "description"), "tinygit repository\n");
  return gitDir;
}
