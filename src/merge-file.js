// 三路文件归并（diff3）。
//
// 输入三个版本：base（共同祖先）、ours、theirs。
// 输出：合并结果 + 冲突区间。
//
// 核心思路：
//   分别对 base→ours 和 base→theirs 求差异，
//   然后把两边的编辑叠加到 base 上。
//   两边修改不重叠 → 自动合并；
//   两边修改同一区域且内容不同 → 冲突。
//
// 这里用一个「分块对齐」的经典做法：
//   1. 计算 base→ours 的编辑脚本，得到 base 每个位置在 ours 的映射
//   2. 同理得到 theirs 的映射
//   3. 逐块比较：两边都没改 → 保留；一边改 → 采用；两边改且相同 → 采用；两边改且不同 → 冲突

import { myersDiff } from "./diff.js";

// 把编辑脚本转换成「一致性块」列表：
// 每个块是 { baseStart, baseEnd, otherLines }，表示 base[a,b) 对应 other 的若干行
export function toAlignment(baseLines, otherLines) {
  const ops = myersDiff(baseLines, otherLines);

  const blocks = [];
  let basePos = 0;
  let otherPos = 0;
  let equalRun = [];

  const flushEqual = () => {
    if (equalRun.length === 0) return;
    blocks.push({
      baseStart: basePos,
      baseEnd: basePos + equalRun.length,
      otherStart: otherPos,
      otherEnd: otherPos + equalRun.length,
      lines: equalRun.slice(),
      kind: "equal",
    });
    basePos += equalRun.length;
    otherPos += equalRun.length;
    equalRun = [];
  };

  // 收集连续的变更块
  let changeBase = [];
  let changeOther = [];
  const flushChange = () => {
    if (changeBase.length === 0 && changeOther.length === 0) return;
    blocks.push({
      baseStart: basePos,
      baseEnd: basePos + changeBase.length,
      otherStart: otherPos,
      otherEnd: otherPos + changeOther.length,
      lines: changeOther.slice(),
      baseLines: changeBase.slice(),
      kind: "change",
    });
    basePos += changeBase.length;
    otherPos += changeOther.length;
    changeBase = [];
    changeOther = [];
  };

  for (const op of ops) {
    if (op.op === " ") {
      flushChange();
      equalRun.push(op.line);
    } else if (op.op === "-") {
      flushEqual();
      changeBase.push(op.line);
    } else {
      flushEqual();
      changeOther.push(op.line);
    }
  }
  flushChange();
  flushEqual();
  return blocks;
}

// 核心：产出完整的分段序列。
// 每个分段是以下之一：
//   { kind: "same", lines }                        两边一致，直接采纳
//   { kind: "ours", lines }                        仅 ours 改动
//   { kind: "theirs", lines }                      仅 theirs 改动
//   { kind: "conflict", ours, theirs }             两边都改且不同
//
// merge3 与「带标记输出」都从它派生，避免两份逻辑不一致。
export function mergeSegments(baseLines, oursLines, theirsLines) {
  const oursBlocks = toAlignment(baseLines, oursLines);
  const theirsBlocks = toAlignment(baseLines, theirsLines);

  const oursChanges = oursBlocks.filter((b) => b.kind === "change");
  const theirsChanges = theirsBlocks.filter((b) => b.kind === "change");

  const events = [];
  for (const c of oursChanges) events.push({ side: "ours", ...c });
  for (const c of theirsChanges) events.push({ side: "theirs", ...c });
  events.sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);

  const segments = [];
  let cursor = 0;
  let i = 0;

  while (i < events.length) {
    // 收集一组在 base 坐标上重叠的变更。
    //
    // 难点：纯插入产生的变更块是**零宽**的，[baseStart, baseEnd) 中
    // baseStart === baseEnd。两个零宽块在同一位置时，用 baseStart < groupEnd
    // 判断（此时 groupEnd === baseStart）会漏判，导致两次插入被当成
    // 「各自独立」而都保留下来——结果就是两边内容同时出现，既不冲突也不正确。
    //
    // 正确判据：与当前组的「闭区间」有交叠，即
    //   next.baseStart <= groupEnd  （允许相邻/相接）
    // 这里 groupEnd 用 max，且零宽块必须能吸附到同起点的块。
    const group = [events[i]];
    let groupStart = events[i].baseStart;
    let groupEnd = events[i].baseEnd;
    let j = i + 1;
    while (j < events.length) {
      const next = events[j];
      // 零宽插入点落在 group 内（含端点）→ 同组
      const overlaps = next.baseStart < groupEnd
        || (next.baseStart === groupEnd && (next.baseEnd === next.baseStart || groupEnd === groupStart || next.baseStart === groupStart));
      if (!overlaps) break;
      group.push(next);
      groupEnd = Math.max(groupEnd, next.baseEnd);
      groupStart = Math.min(groupStart, next.baseStart);
      j += 1;
    }

    // groupStart 之前的 base 内容原样保留
    if (groupStart > cursor) {
      segments.push({ kind: "same", lines: baseLines.slice(cursor, groupStart) });
    }

    const oursGroup = group.filter((g) => g.side === "ours");
    const theirsGroup = group.filter((g) => g.side === "theirs");
    const oursOut = oursGroup.length ? oursGroup.flatMap((g) => g.lines) : null;
    const theirsOut = theirsGroup.length ? theirsGroup.flatMap((g) => g.lines) : null;

    if (oursGroup.length && theirsGroup.length) {
      const same = oursOut.length === theirsOut.length && oursOut.every((l, k) => l === theirsOut[k]);
      if (same) {
        segments.push({ kind: "same", lines: oursOut });
      } else {
        segments.push({ kind: "conflict", ours: oursOut, theirs: theirsOut, baseStart: groupStart, baseEnd: groupEnd });
      }
    } else if (oursGroup.length) {
      segments.push({ kind: "ours", lines: oursOut });
    } else {
      segments.push({ kind: "theirs", lines: theirsOut });
    }

    cursor = groupEnd;
    i = j;
  }

  if (cursor < baseLines.length) {
    segments.push({ kind: "same", lines: baseLines.slice(cursor) });
  }
  return segments;
}

// 三路归并：返回合并后的行，以及冲突列表
export function merge3(baseLines, oursLines, theirsLines) {
  const segments = mergeSegments(baseLines, oursLines, theirsLines);
  const merged = [];
  const conflicts = [];
  for (const seg of segments) {
    if (seg.kind === "conflict") {
      merged.push(...seg.ours);       // 默认保留 ours
      conflicts.push({
        baseStart: seg.baseStart,
        baseEnd: seg.baseEnd,
        ours: seg.ours,
        theirs: seg.theirs,
      });
    } else {
      merged.push(...seg.lines);
    }
  }
  return { merged, conflicts };
}

// 生成带冲突标记的完整文件内容
export function renderMergedFile(baseLines, oursLines, theirsLines, { oursLabel = "HEAD", theirsLabel = "branch" } = {}) {
  const segments = mergeSegments(baseLines, oursLines, theirsLines);
  const out = [];
  for (const seg of segments) {
    if (seg.kind === "conflict") {
      out.push("<<<<<<< " + oursLabel);
      out.push(...seg.ours);
      out.push("=======");
      out.push(...seg.theirs);
      out.push(">>>>>>> " + theirsLabel);
    } else {
      out.push(...seg.lines);
    }
  }
  return { lines: out, hasConflict: segments.some((s) => s.kind === "conflict") };
}

