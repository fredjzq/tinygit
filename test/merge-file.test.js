// 三路文件归并。这是 merge 的核心，边界情况必须逐个覆盖。

import { test } from "node:test";
import assert from "node:assert/strict";
import { merge3, mergeSegments, renderMergedFile } from "../src/merge-file.js";

const L = (s) => (s === "" ? [] : s.split("\n"));

test("no change on either side keeps the base", () => {
  const r = merge3(L("a\nb\nc"), L("a\nb\nc"), L("a\nb\nc"));
  assert.deepEqual(r.merged, ["a", "b", "c"]);
  assert.equal(r.conflicts.length, 0);
});

test("only ours changed", () => {
  const r = merge3(L("a\nb\nc"), L("a\nX\nc"), L("a\nb\nc"));
  assert.deepEqual(r.merged, ["a", "X", "c"]);
  assert.equal(r.conflicts.length, 0);
});

test("only theirs changed", () => {
  const r = merge3(L("a\nb\nc"), L("a\nb\nc"), L("a\nY\nc"));
  assert.deepEqual(r.merged, ["a", "Y", "c"]);
  assert.equal(r.conflicts.length, 0);
});

test("different regions merge cleanly", () => {
  const r = merge3(L("a\nb\nc\nd\ne"), L("A\nb\nc\nd\ne"), L("a\nb\nc\nd\nE"));
  assert.deepEqual(r.merged, ["A", "b", "c", "d", "E"]);
  assert.equal(r.conflicts.length, 0);
});

test("identical changes on both sides merge without conflict", () => {
  const r = merge3(L("a\nb\nc"), L("a\nZ\nc"), L("a\nZ\nc"));
  assert.deepEqual(r.merged, ["a", "Z", "c"]);
  assert.equal(r.conflicts.length, 0);
});

test("conflicting changes are reported", () => {
  const r = merge3(L("a\nb\nc"), L("a\nX\nc"), L("a\nY\nc"));
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0].ours, ["X"]);
  assert.deepEqual(r.conflicts[0].theirs, ["Y"]);
  // 默认策略：merge3 保留 ours
  assert.deepEqual(r.merged, ["a", "X", "c"]);
});

test("ours deletes, theirs keeps", () => {
  const r = merge3(L("a\nb\nc"), L("a\nc"), L("a\nb\nc"));
  assert.deepEqual(r.merged, ["a", "c"]);
  assert.equal(r.conflicts.length, 0);
});

test("ours inserts, theirs unchanged", () => {
  const r = merge3(L("a\nc"), L("a\nb\nc"), L("a\nc"));
  assert.deepEqual(r.merged, ["a", "b", "c"]);
  assert.equal(r.conflicts.length, 0);
});

test("both sides insert different lines at the same place produce conflict", () => {
  const r = merge3(L("a\nb"), L("a\nX\nb"), L("a\nY\nb"));
  assert.equal(r.conflicts.length, 1);
});

test("appending different content at end conflicts", () => {
  const r = merge3(L("a"), L("a\nours"), L("a\ntheirs"));
  assert.ok(r.conflicts.length >= 1);
});

test("empty base with both sides adding identical content", () => {
  const r = merge3([], L("x"), L("x"));
  assert.deepEqual(r.merged, ["x"]);
  assert.equal(r.conflicts.length, 0);
});

test("empty base with different additions conflicts", () => {
  const r = merge3([], L("x"), L("y"));
  assert.ok(r.conflicts.length >= 1);
});

test("multiple independent changes on both sides all apply", () => {
  const base = L("1\n2\n3\n4\n5\n6\n7\n8\n9");
  const ours = L("1x\n2\n3\n4\n5\n6\n7\n8\n9");
  const theirs = L("1\n2\n3\n4\n5\n6\n7\n8\n9x");
  const r = merge3(base, ours, theirs);
  assert.deepEqual(r.merged, ["1x", "2", "3", "4", "5", "6", "7", "8", "9x"]);
  assert.equal(r.conflicts.length, 0);
});

test("segments cover the whole output without gaps", () => {
  const base = L("a\nb\nc\nd");
  const ours = L("a\nB\nc\nd");
  const theirs = L("a\nb\nc\nD");
  const segs = mergeSegments(base, ours, theirs);
  const joined = segs.flatMap((s) => (s.kind === "conflict" ? s.ours : s.lines));
  assert.deepEqual(joined, ["a", "B", "c", "D"]);
});

test("rendered file uses git conflict markers", () => {
  const r = renderMergedFile(L("a\nb\nc"), L("a\nX\nc"), L("a\nY\nc"), {
    oursLabel: "main", theirsLabel: "feature",
  });
  assert.equal(r.hasConflict, true);
  const text = r.lines.join("\n");
  assert.match(text, /^<<<<<<< main$/m);
  assert.match(text, /^=======$/m);
  assert.match(text, /^>>>>>>> feature$/m);
  // X 在 ======= 之前，Y 在之后
  const idxOurs = r.lines.indexOf("X");
  const idxSep = r.lines.indexOf("=======");
  const idxTheirs = r.lines.indexOf("Y");
  assert.ok(idxOurs < idxSep && idxSep < idxTheirs, "ours must come before separator, theirs after");
});

test("rendered file without conflict has no markers", () => {
  const r = renderMergedFile(L("a\nb"), L("a\nB"), L("a\nb"));
  assert.equal(r.hasConflict, false);
  assert.ok(!r.lines.some((l) => l.startsWith("<<<<<<<")));
});

test("rendered file preserves surrounding context", () => {
  const r = renderMergedFile(L("top\na\nmid\nb\nbottom"), L("top\nA\nmid\nb\nbottom"), L("top\na\nmid\nB\nbottom"));
  const text = r.lines.join("\n");
  assert.match(text, /^top$/m);
  assert.match(text, /^mid$/m);
  assert.match(text, /^bottom$/m);
});
