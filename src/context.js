// 定位当前仓库；找不到时给出可操作的提示。

import { findGitDir } from "./repo.js";

export async function requireRepo(cwd) {
  const gitDir = await findGitDir(cwd);
  if (!gitDir) {
    throw new Error("不在 tinygit 仓库内（或其父目录）。先运行: tinygit init")
  }
  return { gitDir, rootDir: gitDir.replace(/[\\/]\.git$/, "") };
}
