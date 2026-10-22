// commit：从索引构建 tree，写 commit 对象，推进当前分支。

import { readIndex } from "../index-file.js";
import { writeTreeFromEntries } from "../tree.js";
import { writeCommit, formatIdentity, localTimezoneOffset } from "../commit.js";
import { readHeadRef, updateHead } from "../refs.js";
import { readObject } from "../objects.js";

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

  // 内容没变时拒绝产生空提交（与真 Git 行为一致）
  if (!allowEmpty && parents.length > 0) {
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

  const oid = await writeCommit(gitDir, {
    tree,
    parents,
    author: identity,
    committer: identity,
    message: message.trimEnd() + "\n",
  });

  const ref = await updateHead(gitDir, oid);
  return { oid, tree, parents, ref };
}
