// 工作区扫描：把目录里的文件读成待暂存条目。

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isIgnored, loadIgnoreRules } from "./ignore.js";

const ALWAYS_IGNORE = new Set([".git", "node_modules"]);

export async function scanWorkingTree(rootDir, { respectIgnore = true } = {}) {
  const rules = respectIgnore ? await loadIgnoreRules(rootDir) : [];
  const files = [];

  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (ALWAYS_IGNORE.has(entry.name)) continue;
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (respectIgnore && isIgnored(rel, true, rules)) continue;
        await walk(abs, rel);
      } else if (entry.isFile()) {
        if (respectIgnore && isIgnored(rel, false, rules)) continue;
        files.push({ path: rel, abs });
      }
    }
  }

  await walk(rootDir, "");
  return files;
}

export async function readFileForBlob(abs) {
  const [buf, st] = await Promise.all([readFile(abs), stat(abs)]);
  const executable = (st.mode & 0o111) !== 0;
  return { content: buf, mode: executable ? "100755" : "100644", size: st.size, stat: st };
}

export async function fileStatSafe(abs) {
  try { return await stat(abs); } catch { return null; }
}
