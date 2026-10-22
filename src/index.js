// 公开 API。命令行是主要用法，但作为库调用同样可用。

export { hashObject, encodeObject, decodeObject, writeObject, readObject, readObjectText, objectPath, objectExists } from "./objects.js";
export { parseTree, serializeTree, sortTreeEntries, writeTreeFromEntries, flattenTree, padMode, treeEntryType } from "./tree.js";
export { readIndex, writeIndex, serializeIndex, parseIndex, emptyIndex, entryFromStat } from "./index-file.js";
export { serializeCommit, parseCommit, writeCommit, readCommit, formatIdentity, parseIdentity } from "./commit.js";
export { readHeadRef, readRef, writeRef, updateHead, listBranches, setHeadSymref } from "./refs.js";
export { myersDiff, formatUnified, splitLines, toHunks } from "./diff.js";
export { initRepo, findGitDir } from "./repo.js";
export { scanWorkingTree, readFileForBlob } from "./worktree.js";
export { compilePatterns, globToRegExp, isIgnored } from "./ignore.js";
