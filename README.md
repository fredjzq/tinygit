# tinygit

> v1.4.0 · 22 个命令 · 188 项测试 · 零依赖

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
| `rm <路径...>` | 从索引移除（保留工作区文件）|
| `merge <分支>` | 快进或三方归并，冲突时写标记文件 |
| `cherry-pick <提交>` | 把某个提交的改动重放到当前分支 |
| `rebase <分支>` | 把当前分支的提交搬到另一基点 |
| `rebase --continue` | 解决冲突后继续 rebase |
| `rebase --abort` | 放弃 rebase 并回到原位置 |
| `clone <url> [目录]` | 从远程仓库克隆（智能 HTTP 协议） |
| `fetch <url>` | 抓取远程更新，带 have/want 协商 |
| `gc [--dry-run]` | 打包松散对象（含 delta 压缩）并清理 |
| `gc --pack-refs` | 把分支引用写入 `packed-refs` |
| `pack-info` | 统计 `.git/objects/pack` 里的打包对象 |
| `checkout <分支>` | 切换分支并检出文件 |
| `ls-tree <引用>` | 列出树内容，接受 HEAD / 分支名 / HEAD~n |
| `cat-file <引用>` | 输出对象原始内容，接受 HEAD / 分支名 / 短 sha |
| `hash-object <文件>` | 计算并写入 blob |

## 实现要点

### cherry-pick 与 rebase

这两个命令容易写错的地方不是流程，而是**三方归并的 base 该选谁**。

merge 的 base 是「两个分支的最近公共祖先」。cherry-pick 的 base 是
**「被摘取提交的父提交」**。选错不会报错，只会让历史悄悄错掉：

```
        B---C  main (HEAD, ours)
       /
   A--B---F  feature（要摘取 F）
```

摘取 F 时，base 必须是 **B**（F 的父）。若误用 A（真实公共祖先），
C 的所有改动都会被当成「theirs 缺失」而回退——把 main 的工作扔掉，
且整个过程没有任何报错。

rebase 则是批量 cherry-pick：算出「当前分支独有」的提交，**按从旧到新**
逐个重放。顺序反了会让后面的提交依赖还不存在的改动，冲突率飙升。

**中断恢复**：rebase 中途冲突时状态必须落盘到 `.git/rebase-merge/`
（`todo` / `onto` / `head-name` / `orig-head` / `done`）。只放内存的话，
进程一退用户就无法继续。`rebase --continue` 有一个反直觉的点——

> 它**不能**重新执行 cherry-pick。用户已经手工把冲突改好了，
> 再跑一次三方归并会把工作区重新写成冲突标记，等于把用户的修改抹掉。
> 正确做法是直接用当前索引提交。

**cherry-pick 要保留原作者**。它虽然是「复制改动」，但「谁写的这段代码」
不能丢。提交时作者沿用原提交，committer 记为我们自己。

### 智能 HTTP 协议

这是项目从「只能操作本地」到「能和真实世界交互」的分界线。
\`clone\` 一个真实仓库要经过两个往返：

1. \`GET /info/refs?service=git-upload-pack\` —— 服务端广告所有引用与能力集
2. \`POST /git-upload-pack\` —— 发 want/have 协商，服务端回 packfile

**帧格式（pkt-line）**：每帧是「4 位十六进制长度 + 载荷」，长度**包含 4 字节头本身**。
三个特殊长度：\`0000\` flush（本轮说完）、\`0001\` delim（v2 分段）、\`0002\` response-end。

**容易写错的三个地方**（每一条都会让协商静默失败）：

- 长度忘了加 4 —— 整个流错位，解析出乱码
- 首行按空格切分 —— 实际是 \`<sha> <ref>\0<capabilities>\`，能力集在 NUL 后面
- side-band 通道号没处理 —— 通道 1 是 pack 数据、通道 2 是进度文本，
  混在一起 pack 立刻损坏（开头不再是 \`PACK\`）

**协商为什么重要**：只发 want 不发 have 时，服务端认为你什么都没有，
每次都要传完整仓库。实测同一仓库：

| 场景 | 传输量 | 耗时 |
| --- | --- | --- |
| 不提供 have | 705 KB | 1477 ms |
| 提供 have（已是最新） | 0 KB | 86 ms |

**index 必须自己重建**：服务端只发 pack，不发 \`.idx\`。重建需要每个对象的偏移
与「对象头 + 压缩数据」的 CRC32。pack 文件名必须是内容哈希
（\`pack-<sha1(内容去掉尾部20字节)>.pack\`），否则真 git 判定损坏。

**检出后必须建索引**：空的索引会让 \`status\` 把刚检出的 171 个文件全报成「已删除」，
第一次 commit 又会把它们全当新增——工作区看着正常，仓库状态完全错了。

### packfile 与 delta 压缩

松散对象多了会拖慢一切：几千个文件仅目录遍历就很慢。\`gc\` 把它们打成 pack，
并且对相似对象（同一个文件的历史版本）只存增量。

delta 由「复制指令」和「插入指令」组成：

- 复制指令从 base 的某个位置搬一段过来，偏移和长度都是按需字段
- 插入指令后面跟字面数据

编码端用固定块（16 字节）滚动哈希为 base 建索引，在 target 上滑动找最长匹配。
匹配够长就发复制指令，否则累积成插入指令。收益不抵开销时坚决退回整存——
复制指令本身就有 1-8 字节的编码开销。

实测效果（同一文件的历史版本，这是 delta 最能发挥作用的场景）：

| 场景 | 整存 | delta | 缩减 |
| --- | --- | --- | --- |
| 50 个版本的代码文件 | 14.4 KB | 1.76 KB | 87.8% |
| 30 个版本的 2.8 MB 大文件 | 404 KB | 15 KB | 96.4% |

反例：一份 clone 下来的单次快照（每个文件只有最终版本），对象之间没有
版本关系，delta 收益接近 0。这是数据性质决定的，不是算法问题。

### 对象可达性与安全清理

\`gc\` 会删文件，删错就是永久丢数据。所以流程严格分两步：

1. 从**所有分支 + HEAD + 索引**出发，标记可达对象
2. 只把可达对象写进 pack，写成功后才删松散文件

顺序不能反：先删后写，中途失败就永久丢失。
索引里的对象必须算可达——「刚 add 还没 commit」的 blob 只存在于索引里。

不可达对象不做删除。本项目没有 reflog，激进清理的风险大于收益。

### packed-refs

每个分支一个文件时，1000 个分支就是 1000 个文件。\`gc --pack-refs\`
把它们合并进一个文本文件。

这里有一个容易踩的坑：**删除分支时两处都要删**。只删松散文件，
\`packed-refs\` 里的记录会让分支「复活」，用户会觉得删不掉。
而松散 ref 的优先级高于 packed-refs，所以更新分支只需写松散文件。

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

### packfile：能读真 Git 的打包仓库

真 Git clone 下来的仓库，对象几乎全在 `.git/objects/pack/*.pack` 里，
而且绝大多数是 **delta 压缩**——只存「相对另一个对象的差异」。

这意味着要处理四层叠加的复杂度：

1. **对象边界**：zlib 流没有长度前缀，且 Node 的 `inflateSync` 不返回消耗字节数。
   解法：zlib 流自带 adler32，截断必然失败，所以「能成功解压的最短前缀」就是流长度，对它二分。
2. **两种变长整数**：`OFS_DELTA` 的偏移编码有 `+1` 修正，`delta` 头部的大小编码没有。
3. **delta 指令流**：复制指令的偏移/长度是按需字段，且长度为 0 表示 65536。
4. **delta 链**：base 本身可能是 delta，递归解析到完整对象。

验证方式是用本机一个真实 Git 仓库的 pack（7.8 MB，**3,513 个对象**）跑：

```
声明对象数   : 3513
解析出对象   : 3513
偏移→sha 一致: 3513/3513  ✅
类型分布     : {commit:1, tree:1294, blob:2218}
```

第二行是决定性证据：**只要 delta 链、对象头、zlib 边界任意一处出错，重新计算的 sha 都不可能和 idx 里记录的吻合**。

细节与踩坑记录见 [docs/packfile-and-merge.md](docs/packfile-and-merge.md)。

### 三方合并

先求 merge base（最近公共祖先），再做 diff3 三路归并。

- `src/merge-base.js`：在提交 DAG 上求最近公共祖先
- `src/merge-file.js`：三路归并，`mergeSegments` 产出统一分段模型
- `src/commands/merge.js`：快进 / 已最新 / 真合并 / 冲突 四种结果

冲突时不自动提交，按 Git 格式写标记文件：

```
<<<<<<< main
OURS
=======
THEIRS
>>>>>>> feature
```

这一层踩到过一个真 bug：merge base 的「最近」判据写反，
导致分支点不是根提交时退化成根提交，进而**产生假冲突**（两边改不同文件却报冲突）。
详见 [docs/packfile-and-merge.md](docs/packfile-and-merge.md) 第二节。
## 验证方式

### 单元与集成测试

```bash
node --test
```

**188 项测试**，覆盖对象哈希常量、tree 排序、索引字节布局、diff 最短性、
pack 变长整数、delta 应用、pack 写入读取闭环、真实 pack 解析、三方归并、merge base。

### 独立审计器（`scripts/audit.mjs`）

故意**不复用任何 `src/` 代码**，从头实现 Git 的读取规则，
构成真正的交叉验证。如果审计器调用被测代码，同一处 bug 会让两边一起错、一起「通过」。

`bash`
node scripts/audit.mjs <仓库路径> --verbose
`

覆盖 112~129 项检查，包括对象内容寻址一致性、tree 条目 mode 合法性、
tree 排序、提交图可达性、索引校验和与排序、索引与工作区一致性、孤儿对象检测。

**审计器本身经过反面测试**：人为篡改对象内容 / 索引校验和 / 制造孤儿对象 / 
写坏分支指针，四种损坏全部被检出 —— 确认它不会永远返回「通过」。

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

- **写 delta**：能读 delta 压缩的 pack，但自己写 pack 时只写完整对象
- **rename 检测**：合并时不识别文件改名，会当成删除 + 新增
- **rebase / cherry-pick / stash / tag / remote**
- **thin pack**（`REF_DELTA` 的 base 在 pack 之外）与多 pack 索引
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
  merge-base.js       最近公共祖先（提交 DAG）
  merge-file.js       三路归并（mergeSegments 统一模型）
  pack/
    reader.js         pack 解析、delta 链还原、zlib 边界定位
    writer.js         pack + idx 构建
    idx.js            .idx v2 索引（fanout 表、二分查找）
    delta.js          delta 应用算法
    varint.js         两种变长整数编码
    index.js          pack 子系统统一入口
  commands/           各子命令实现
scripts/
  demo.mjs            端到端演示
  verify.mjs          独立格式验证器
test/                 188 项测试
```

## License

MIT
