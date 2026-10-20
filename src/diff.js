// 文本 diff：Myers 算法的 O(ND) 实现，输出与常见 unified diff 一致的块。
//
// 为什么手写而不用现成库：这个项目零依赖，而 diff 是「提交前看清楚改了什么」
// 的核心能力，不能省。
//
// Myers 的思路：把编辑距离 d 从 0 递增，每一步沿对角线尽量延伸，
// 找到终点即得最短编辑脚本。复杂度 O((N+M)·D)，对代码 diff 通常远快于 LCS 的 O(NM)。

export function splitLines(text) {
  if (text === "") return [];
  const lines = text.split("\n");
  // 末尾换行不代表多一行空内容
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function myersDiff(a, b) {
  const N = a.length;
  const M = b.length;
  const MAX = N + M;
  const offset = MAX + 1;
  const v = new Int32Array(2 * MAX + 3);
  const trace = [];

  for (let d = 0; d <= MAX; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const idx = offset + k;
      let x;
      if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
        x = v[idx + 1];
      } else {
        x = v[idx - 1] + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x += 1; y += 1; }
      v[idx] = x;
      if (x >= N && y >= M) return backtrack(trace, a, b, offset);
    }
  }
  return [];
}

function backtrack(trace, a, b, offset) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const v = trace[d];
    const k = x - y;
    const idx = offset + k;
    let prevK;
    if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ op: " ", line: a[x - 1] });
      x -= 1; y -= 1;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ op: "+", line: b[y - 1], }), (y -= 1);
      else ops.push({ op: "-", line: a[x - 1] }), (x -= 1);
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ op: " ", line: a[x - 1] });
    x -= 1; y -= 1;
  }
  return ops.reverse();
}

export function hasChanges(ops) {
  return ops.some((o) => o.op !== " ");
}

// 把编辑脚本聚成 hunk，context 是每块前后保留的上下文行数
export function toHunks(ops, context = 3) {
  const hunks = [];
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i].op === " ") i += 1;
    if (i >= ops.length) break;
    let start = Math.max(0, i - context);
    let end = i;
    while (end < ops.length) {
      if (ops[end].op !== " ") {
        end += 1;
        continue;
      }
      let run = end;
      while (run < ops.length && ops[run].op === " ") run += 1;
      if (run - end > context * 2 || run >= ops.length) break;
      end = run;
    }
    const slice = ops.slice(start, end);
    hunks.push({ start, ops: slice });
    i = end;
  }
  return hunks;
}

export function formatUnified(aText, bText, { fromName = "a", toName = "b", context = 3 } = {}) {
  const a = splitLines(aText);
  const b = splitLines(bText);
  const ops = myersDiff(a, b);
  if (!hasChanges(ops)) return "";
  const hunks = toHunks(ops, context);
  const out = ["--- " + fromName, "+++ " + toName];

  let aLine = 0;
  let bLine = 0;
  let consumed = 0;
  for (const hunk of hunks) {
    for (; consumed < hunk.start; consumed += 1) {
      if (ops[consumed].op !== "+") aLine += 1;
      if (ops[consumed].op !== "-") bLine += 1;
    }
    let aCount = 0, bCount = 0;
    for (const o of hunk.ops) {
      if (o.op !== "+") aCount += 1;
      if (o.op !== "-") bCount += 1;
    }
    const aStart = aCount === 0 ? aLine : aLine + 1;
    const bStart = bCount === 0 ? bLine : bLine + 1;
    out.push("@@ -" + aStart + "," + aCount + " +" + bStart + "," + bCount + " @@");
    for (const o of hunk.ops) {
      out.push(o.op + o.line);
      if (o.op !== "+") aLine += 1;
      if (o.op !== "-") bLine += 1;
    }
    consumed += hunk.ops.length;
  }
  return out.join("\n") + (out.length ? "\n" : "");
}
