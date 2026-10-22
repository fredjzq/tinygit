// .gitignore 匹配。
//
// 只实现常见子集：注释、空行、目录结尾斜杠、前导斜杠锚定、
// 以及 * / ** 通配。不实现取反（!）的复杂交互——那需要完整的状态机，
// 且在实际仓库里用得很少。

import { readFile } from "node:fs/promises";
import path from "node:path";

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** 跨目录
        i += 1;
        if (glob[i + 1] === "/") i += 1;
        re += "(?:.*/)?" ;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export function compilePatterns(lines) {
  const rules = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let pattern = line;
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith("/");
    if (anchored) pattern = pattern.slice(1);
    rules.push({ source: line, dirOnly, anchored, re: globToRegExp(pattern) });
  }
  return rules;
}

export async function loadIgnoreRules(rootDir) {
  try {
    const text = await readFile(path.join(rootDir, ".gitignore"), "utf8");
    return compilePatterns(text.split(/\r?\n/));
  } catch {
    return [];
  }
}

export function isIgnored(relPath, isDir, rules) {
  const normalized = relPath.split(path.sep).join("/");
  const base = normalized.split("/").pop();
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) {
      // 目录规则也会命中该目录下的所有文件
      if (!normalized.startsWith(rule.source.replace(/^\//, "").replace(/\/$/, "") + "/")) continue;
      return true;
    }
    if (rule.anchored) {
      if (rule.re.test(normalized)) return true;
    } else {
      if (rule.re.test(normalized)) return true;
      if (rule.re.test(base)) return true;
    }
  }
  return false;
}
