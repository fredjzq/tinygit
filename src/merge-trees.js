// 三方 tree 归并：把「base / ours / theirs」三份文件映射合成一份。
//
// 为什么单独抽出来：merge、cherry-pick、rebase 都需要同一套逻辑，
// 只是三者传入的 base 不同：
//
//   merge        base = 两个分支的最近公共祖先
//   cherry-pick  base = 被摘取提交的父提交
//   rebase       逐个提交做 cherry-pick
//
// 如果各写一遍，三处的冲突判定迟早会不一致——比如某一处把二进制文件
// 当文本处理，就会在别处产生乱码。这里只实现一次，三处共用。
//
// 归并规则（与 Git 一致）：
//   1. 三方相同 → 取该内容
//   2. 只有一方相对 base 有变化 → 取变化方
//   3. 两方都变且相同 → 取该内容
//   4. 两方都变且不同 → 文本做三路归并，冲突时写标记；二进制直接冲突
//   5. 一方删除、一方修改 → 冲突

import { readObject, writeObject } from "./objects.js";
import { merge3, renderMergedFile } from "./merge-file.js";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";

// 把 blob 读成文本，二进制返回 null
async function textOf(gitDir, oid) {
  const { content } = await readObject(gitDir, oid);
  // NUL 字节是「二进制」的实用判据，与 git 的启发式一致
  if (content.includes(0)) return null;
  return content.toString("utf8");
}

function splitLines(text) {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function writeWorktreeFile(rootDir, rel, content) {
  const abs = path.join(rootDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function removeWorktreeFile(rootDir, rel) {
  try { await unlink(path.join(rootDir, rel)); } catch {}
}

// 归并三份文件映射。
//
// baseFiles / oursFiles / theirsFiles: Map<path, {mode, oid}>
// 返回 {
//   mergedFiles: Map<path, {mode, oid}>,   // 无冲突的最终结果
//   conflicts:   [{path, regions?, binary?}],
//   worktree:    [{path, content}| {path, remove:true}],  // 需要同步到工作区的动作
// }
export async function mergeTreeStates(gitDir, {
  baseFiles,
  oursFiles,
  theirsFiles,
  oursLabel = "HEAD",
  theirsLabel = "theirs",
}) {
  const allPaths = new Set([
    ...baseFiles.keys(),
    ...oursFiles.keys(),
    ...theirsFiles.keys(),
  ]);

  const mergedFiles = new Map();
  const conflicts = [];
  const worktree = [];

  for (const p of [...allPaths].sort()) {
    const baseEntry = baseFiles.get(p);
    const oursEntry = oursFiles.get(p);
    const theirsEntry = theirsFiles.get(p);

    const baseOid = baseEntry?.oid ?? null;
    const oursOid = oursEntry?.oid ?? null;
    const theirsOid = theirsEntry?.oid ?? null;

    // 规则 1：三方完全相同
    if (baseOid === oursOid && oursOid === theirsOid) {
      if (oursOid) mergedFiles.set(p, oursEntry);
      continue;
    }

    // 规则 2a：theirs 没变 → 保留 ours
    if (theirsOid === baseOid) {
      if (oursOid) mergedFiles.set(p, oursEntry);
      else worktree.push({ path: p, remove: true });
      continue;
    }
    // 规则 2b：ours 没变 → 采用 theirs
    if (oursOid === baseOid) {
      if (theirsOid) {
        mergedFiles.set(p, theirsEntry);
        const t = await textOf(gitDir, theirsOid);
        worktree.push({ path: p, content: t, binary: t === null, oid: theirsOid });
      } else {
        worktree.push({ path: p, remove: true });
      }
      continue;
    }

    // 规则 3：两边都改且改得一样
    if (oursOid === theirsOid) {
      mergedFiles.set(p, oursEntry);
      continue;
    }

    // 规则 4/5：两边都改且不同。
    // 有一边被删除（oid 为 null）时无法做文本归并 → 冲突
    if (!oursOid || !theirsOid) {
      conflicts.push({
        path: p,
        reason: !oursOid ? "被我们删除但对方修改" : "被对方删除但我们修改",
      });
      continue;
    }

    const baseText = baseOid ? await textOf(gitDir, baseOid) : "";
    const oursText = await textOf(gitDir, oursOid);
    const theirsText = await textOf(gitDir, theirsOid);

    // 二进制：不做文本归并
    if (baseText === null || oursText === null || theirsText === null) {
      conflicts.push({ path: p, binary: true, reason: "二进制内容双方都修改" });
      continue;
    }

    const { merged, conflicts: fileConflicts } = merge3(
      splitLines(baseText),
      splitLines(oursText),
      splitLines(theirsText)
    );

    if (fileConflicts.length === 0) {
      const content = merged.length ? merged.join("\n") + "\n" : "";
      const oid = await writeObject(gitDir, "blob", Buffer.from(content, "utf8"));
      mergedFiles.set(p, { mode: oursEntry.mode, oid });
      worktree.push({ path: p, content });
    } else {
      const rendered = renderMergedFile(
        splitLines(baseText),
        splitLines(oursText),
        splitLines(theirsText),
        { oursLabel, theirsLabel }
      );
      const content = rendered.lines.join("\n") + "\n";
      worktree.push({ path: p, content });
      conflicts.push({ path: p, regions: fileConflicts.length, content });
    }
  }

  return { mergedFiles, conflicts, worktree };
}

// 把归并结果同步到工作区。
// 冲突文件也要写出来（带标记），否则用户看不到要解决什么。
export async function applyWorktree(rootDir, worktree) {
  for (const action of worktree) {
    if (action.remove) await removeWorktreeFile(rootDir, action.path);
    else await writeWorktreeFile(rootDir, action.path, action.content);
  }
}
