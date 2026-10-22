# tinygit

**用纯 JavaScript 从零实现的 Git 子集。** 零依赖，不调用 `git` 命令，直接按 Git 的磁盘格式读写仓库。

它创建出来的仓库，**一个真正的 Git 客户端可以直接打开** —— 对象哈希、tree 排序、索引校验和、commit 格式全部按规范实现，并由一个独立重写的验证器交叉校验。

## 它解决什么问题

大多数人对 Git 的理解停在「背命令」。真要说清「提交到底是什么」「为什么同样的文件不同历史会有不同哈希」「`.git/index` 里存了什么」，往往说不明白。

这个项目把这些概念**变成可读的代码**：

| 你可能想知道 | 对应文件 |
| --- | --- |
| 提交是怎么存的？ | [src/commit.js](src/commit.js) |
| 为什么内容相同哈希就相同？ | [src/objects.js](src/objects.js) |
| 目录结构怎么表示？排序为什么特殊？ | [src/tree.js](src/tree.js) |
| 暂存区到底是什么？ | [src/index-file.js](src/index-file.js) |
| `git diff` 的算法原理 | [src/diff.js](src/diff.js) |
| 分支只是个文件吗？ | [src/refs.js](src/refs.js) |

## 快速开始

```bash
node bin/tinygit.js init 我的仓库
cd 我的仓库
node ../bin/tinygit.js status
node ../bin/tinygit.js add .
node ../bin/tinygit.js commit -m "第一次提交"
node ../bin/tinygit.js log
```

或者直接看完整演示（会在临时目录走完全流程并自动清理）：

```bash
node scripts/demo.mjs
```

## 支持的命令

| 命令 | 说明 |
| --- | --- |
| `init [目录]` | 创建 `.git` 目录结构 |
| `status` | 三态比较：HEAD / 索引 / 工作区 |
| `add <路径...>` | 写入 blob 并更新索引，遵守 `.gitignore` |
| `commit -m <消息>` | 构建 tree、写 commit、推进分支 |
| `log [--oneline] [-n N]` | 沿 parent 链回溯历史 |
| `diff [--staged] [<a> <b>]` | Myers 算法，输出 unified diff |
| `branch [-d <名>] [<名>]` | 列出 / 创建 / 删除分支 |
| `checkout <分支>` | 切换分支并检出文件 |
| `ls-tree <tree>` | 列出树内容（输出格式与 git 一致） |
| `cat-file <对象>` | 输出对象原始内容 |
| `hash-object <文件>` | 计算并写入 blob |

## 实现要点

### 内容寻址

对象文件名 = `sha1("<type> <size>\0" + content)`。所以：

- 相同内容永远得到相同哈希，天然去重
- 改一个字，从该文件到根 tree 再到 commit，整条哈希链全部改变
- 校验和就是文件名本身，损坏能被发现

```js
hashObject("blob", "")   // e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
hashObject("tree", "")   // 4b825dc642cb6eb9a060e54bf8d69288fbee4904
```

### tree 排序的特殊规则

Git 比较 tree 条目时，把目录当作名字后接了 `/`。所以目录 `foo` 要排在文件 `foo.txt` **之后**（`'/'` 是 0x2f，`'.'` 是 0x2e）。

排序错了哈希就不对，真 Git 会认为仓库损坏。见 [src/tree.js](src/tree.js) 的 `sortKey`。

### 索引是二进制格式

`.git/index` 不是文本。签名 `DIRC`，每条目 62 字节固定头 + 路径 + 填充到 8 字节边界，末尾 20 字节是全文 SHA-1。字节布局错一位，真 Git 直接拒绝读取。

### diff 用 Myers 算法

不用 LCS 的 O(NM)，而是 O((N+M)·D) 的最短编辑脚本搜索。见 [src/diff.js](src/diff.js)。

## 验证方式

### 单元与集成测试

```bash
node --test
```

42 项测试，覆盖对象哈希常量、tree 排序、索引字节布局、diff 正确性，以及完整的 init→add→commit→log 流程。

### 独立验证器

```bash
node scripts/verify.mjs <仓库路径>
```

这个脚本**不复用 `src/` 的任何代码**，从零重新实现了一遍 Git 的格式规则，再用它校验 tinygit 生成的仓库。如果两边都用同一份有 bug 的实现，会一起错、一起「通过」；独立重写才能构成真正的交叉验证。

校验内容：

- 每个松散对象的文件路径 == 内容重算哈希
- 对象头部声明的 size == 实际字节数
- commit 的 tree 存在且确实是 tree 类型
- author/committer 行的时区格式是 `±HHMM`
- tree 条目按 Git 规则排序
- tree 里引用的子对象都存在
- 索引的 SHA-1 校验和正确
- 索引条目指向的对象都存在
- 空 blob / 空 tree 哈希等于公开常量

## 已知边界

这是**教学性质与工具性质并重**的实现，不是 Git 的完整替代。明确不支持：

- **packfile**：只读写松散对象。真 Git clone 下来的仓库几乎都是打包的，读不了
- **合并**：没有 `merge`，也没有三方合并和冲突标记
- **rebase / cherry-pick / stash / tag / remote**
- **`.gitignore` 的取反规则**（`!` 前缀）和嵌套 ignore 文件
- **索引 v4** 和扩展段（`TREE`、`REUC` 等）
- **Windows 上的可执行位**：NTFS 没有 POSIX 执行权限，`chmod` 后 `stat().mode` 不变，相关测试在该平台跳过

## 目录结构

```
bin/tinygit.js        命令行入口
src/
  objects.js          对象编解码与内容寻址存储
  tree.js             tree 序列化、排序、扁平化
  index-file.js       索引二进制格式
  commit.js           commit 序列化与解析
  refs.js             HEAD / 分支引用
  diff.js             Myers diff 与 unified 输出
  repo.js             仓库初始化与定位
  worktree.js         工作区扫描
  ignore.js           .gitignore 匹配
  args.js             参数解析
  commands/           各子命令实现
scripts/
  demo.mjs            端到端演示
  verify.mjs          独立格式验证器
test/                 42 项测试
```

## License

MIT
