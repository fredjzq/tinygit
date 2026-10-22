// tree 对象：目录快照。每条目是 "<mode> <name>\0<20字节二进制 sha>"
//
// 最容易出错的地方是**排序规则**：Git 比较条目时，把目录当成名字后接了 "/"。
// 所以 "foo.txt" 排在目录 "foo" 前面（'.' 0x2e < '/' 0x2f）。
// 排序错了会让同一个目录产生不同的 tree 哈希，真 Git 会认为仓库被改坏了。

import { readObject, writeObject } from "./objects.js";

const MODE_TREE = "40000";
const MODE_GITLINK = "160000";

export function treeEntryType(mode) {
  if (mode === MODE_TREE || mode === "040000") return "tree";
  if (mode === MODE_GITLINK) return "commit";
  return "blob";
}

export function parseTree(content) {
  const entries = [];
  let off = 0;
  while (off < content.length) {
    const space = content.indexOf(32, off);
    if (space < 0) throw new Error("corrupt tree: missing mode separator");
    const nul = content.indexOf(0, space);
    if (nul < 0) throw new Error("corrupt tree: missing name terminator");
    const mode = content.subarray(off, space).toString("latin1");
    const name = content.subarray(space + 1, nul).toString("utf8");
    const oid = content.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, name, oid, type: treeEntryType(mode) });
    off = nul + 21;
  }
  return entries;
}

// 排序键：目录名视为带尾部斜杠
function sortKey(entry) {
  return entry.type === "tree" ? entry.name + "/" : entry.name;
}

export function sortTreeEntries(entries) {
  entries.sort((a, b) => {
    const ka = Buffer.from(sortKey(a), "utf8");
    const kb = Buffer.from(sortKey(b), "utf8");
    return Buffer.compare(ka, kb);
  });
  return entries;
}

export function serializeTree(entries) {
  sortTreeEntries(entries);
  const parts = [];
  for (const entry of entries) {
    const mode = entry.type === "tree" ? MODE_TREE : entry.mode;
    parts.push(Buffer.from(mode + " " + entry.name + "\0", "utf8"));
    parts.push(Buffer.from(entry.oid, "hex"));
  }
  return Buffer.concat(parts);
}

// 从扁平的索引条目（path -> oid/mode）逐层构建 tree 对象。
export async function writeTreeFromEntries(gitDir, entries) {
  const root = { children: new Map() };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i];
      if (!node.children.has(seg)) {
        node.children.set(seg, { dir: true, children: new Map() });
      }
      node = node.children.get(seg);
    }
    node.children.set(parts[parts.length - 1], {
      dir: false,
      mode: padMode(entry.mode),
      oid: entry.oid,
    });
  }

  async function writeNode(node) {
    const list = [];
    for (const [name, child] of node.children) {
      if (child.dir) {
        const oid = await writeNode(child);
        list.push({ mode: MODE_TREE, name, oid, type: "tree" });
      } else {
        list.push({ mode: padMode(child.mode), name, oid: child.oid, type: "blob" });
      }
    }
    const content = serializeTree(list);
    return writeObject(gitDir, "tree", content);
  }

  return writeNode(root);
}

// 规范化文件 mode：Git 只区分 100644（普通）和 100755（可执行）
export function padMode(mode) {
  // 两种输入形式都要接受：
  //   - 数字：来自索引，是完整的 st_mode（33188 = 0o100644，33261 = 0o100755）
  //   - 字符串：来自 tree 解析，是八进制文本 "100644"
  // 关键区别：数字可能是完整的 st_mode（含文件类型位），也可能是纯权限位。
  if (typeof mode === "string") {
    const trimmed = mode.replace(/^0+/, "");
    if (trimmed === "40000") return MODE_TREE;
    if (trimmed === MODE_GITLINK) return MODE_GITLINK;
    return parseInt(trimmed, 8) & 0o111 ? "100755" : "100644";
  }
  if (mode === 0o40000) return MODE_TREE;
  if (mode === 0o160000) return MODE_GITLINK;
  // 完整 st_mode 里包含 S_IFREG(0o100000)；取出权限位后统一判断
  const perm = mode & 0o7777;
  return perm & 0o111 ? "100755" : "100644";
}

// 把 tree 展开成 path -> {mode, oid}
export async function flattenTree(gitDir, oid, prefix = "", out = new Map()) {
  if (!oid) return out;
  const { type, content } = await readObject(gitDir, oid);
  if (type !== "tree") throw new Error("expected a tree, got " + type);
  for (const entry of parseTree(content)) {
    const p = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.type === "tree") {
      await flattenTree(gitDir, entry.oid, p, out);
    } else {
      out.set(p, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}
