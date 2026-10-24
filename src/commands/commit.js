// commit：从索引构建 tree，写 commit 对象，推进当前分支。

import { readIndex } from "../index-file.js";
import { writeTreeFromEntries } from "../tree.js";
import { writeCommit, readCommit, formatIdentity, localTimezoneOffset } from "../commit.js";
import { readHeadRef, updateHead } from "../refs.js";
import { readObject } from "../objects.js";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

export async function commit(gitDir, {
  message,
  author = { name: "tinygit", email: "tinygit@localhost" },
  allowEmpty = false,
  now = new Date(),
} = {}) {
  if (!message || !message.trim()) {
    throw new Error("commit: empty message (use -m)");
  }
  const index = await readIndex(gitDir);
  if (index.entries.length === 0 && !allowEmpty) {
    throw new Error("commit: nothing staged");
  }

  const tree = await writeTreeFromEntries(
    gitDir,
    // 索引里 mode 是十进制（33261 = 0o100755），不要先转八进制字符串，
    // 否则 tree.js 里的 parseInt 会把它当成八进制再解释一次。
    index.entries.map((e) => ({ path: e.path, oid: e.oid, mode: e.mode }))
  );

  const head = await readHeadRef(gitDir);
  const parents = head.oid ? [head.oid] : [];

  // 若存在 MERGE_HEAD，说明这是一次「解决冲突后的合并提交」。
  // 必须把被合并分支的提交加为第二个 parent，否则那个分支的历史会凭空消失，
  // 且之后 merge 会认为未合并而重复冲突。
  const mergeHeadPath = path.join(gitDir, "MERGE_HEAD");
  let mergeHead = null;
  try {
    mergeHead = (await readFile(mergeHeadPath, "utf8")).trim();
  } catch {
    // 不在合并中，正常提交
  }
  if (mergeHead && /^[0-9a-f]{40}$/.test(mergeHead) && !parents.includes(mergeHead)) {
    parents.push(mergeHead);
  }

  // 若存在 CHERRY_PICK_HEAD，说明这是「解决 cherry-pick 冲突后的提交」。
  // 与合并不同，它**只有一个 parent**（当前 HEAD），
  // 但**作者必须沿用被摘取提交的作者**——否则这段代码的真正作者就丢了。
  const cherryPickPath = path.join(gitDir, "CHERRY_PICK_HEAD");
  let cherryPickHead = null;
  try {
    cherryPickHead = (await readFile(cherryPickPath, "utf8")).trim();
  } catch {
    // 不在 cherry-pick 中
  }
  if (cherryPickHead && !/^[0-9a-f]{40}$/.test(cherryPickHead)) cherryPickHead = null;

  // 内容没变时拒绝产生空提交（与真 Git 行为一致）。
  // 合并提交允许 tree 与第一父提交相同（例如冲突解决方式是「保留 ours」）。
  if (!allowEmpty && parents.length === 1) {
    const parent = await readObject(gitDir, parents[0]);
    if (parent.type === "commit") {
      const text = parent.content.toString("utf8");
      const m = /^tree ([0-9a-f]{40})$/m.exec(text);
      if (m && m[1] === tree) {
        throw new Error("commit: nothing to commit, working tree clean");
      }
    }
  }

  const seconds = Math.floor(now.getTime() / 1000);
  const offset = localTimezoneOffset(now);
  const identity = formatIdentity(author.name, author.email, seconds, offset);

  // cherry-pick 时沿用原作者，但 committer 记为我们自己
  let authorIdentity = identity;
  if (cherryPickHead) {
    try {
      const source = await readCommit(gitDir, cherryPickHead);
      if (source.author?.name) {
        authorIdentity = formatIdentity(
          source.author.name,
          source.author.email,
          source.author.timestamp,
          source.author.offset
        );
      }
    } catch {
      // 来源提交读不到就退化为当前作者
    }
  }

  const oid = await writeCommit(gitDir, {
    tree,
    parents,
    author: authorIdentity,
    committer: identity,
    message: message.trimEnd() + "\n",
  });

  const ref = await updateHead(gitDir, oid);

  // 合并完成，清理状态文件
  if (mergeHead) {
    await rm(mergeHeadPath, { force: true });
    await rm(path.join(gitDir, "MERGE_MSG"), { force: true });
  }
  if (cherryPickHead) {
    await rm(cherryPickPath, { force: true });
  }

  return {
    oid, tree, parents, ref,
    merge: Boolean(mergeHead),
    cherryPick: cherryPickHead,
  };
}
