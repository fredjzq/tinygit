# 变更日志

## 1.2.0

这一版补上了「让对象真正可维护」的完整链路：写 delta、打包、清理、引用打包。
之前能读 delta pack，但自己生成的 pack 是整存，同一文件的历史版本被重复存了很多遍。

### 新增

- **delta 编码器**（\`src/pack/delta-writer.js\`）
  固定块滚动哈希建索引 + 最长匹配延伸。50 个版本的代码文件缩减 87.8%，
  2.8 MB 大文件的历史缩减 96.4%。每个编码结果都先用 \`applyDelta\` 还原校验，
  不一致就放弃 delta 退回整存。
- **pack 写入支持 OFS_DELTA**（\`src/pack/writer.js\`）
  候选按长度接近度选取并限制数量；收益超过 50% 就停止尝试其它候选。
- **\`gc\` 命令**（\`src/commands/gc.js\`）
  两阶段流程：先从分支/HEAD/索引标记可达对象，写 pack 成功后才删松散文件。
  不可达对象保留（本项目无 reflog，激进清理风险大于收益）。
- **\`packed-refs\` 支持**（\`src/packed-refs.js\`）
  引用合并为单文件，松散 ref 优先于打包记录。\`gc --pack-refs\` 触发。
- **审计器新增独立 pack 校验**（\`scripts/audit.mjs\`）
  完全不复用 \`src/pack/\` 代码，从头实现 idx/pack 解析。真实仓库 18,341 项检查通过。

### 修复

- **\`readObject\` 遇到 pack 对象时全部失败**
  pack 解析器已实现且有单元测试，但没接进 \`readObject\`。
  结果：单元测试全绿，任何 clone 下来的仓库所有命令都报
  \`object not found (packed objects are not supported)\`。
  现在松散 → pack 回退，并按「文件名 + 大小 + mtime」做缓存失效。
- **pack 解析慢 10 倍**
  原先不知道 zlib 流有多长，用「截断输入必然解压失败」做二分，
  每个对象约 20 次 \`inflate\`。改用 \`inflateSync(buf, { info: true })\`
  的 \`engine.bytesWritten\` 直接拿到消耗字节数。
  3513 对象的 7.6 MB pack：**1144 ms → 100 ms**。
- **\`branch -d\` 静默失效且可能删错**
  \`-d\` 被解析成布尔标志，\`String(flags.d)\` 变成 \`"true"\`，
  于是报 \`branch not found: true\`，真正要删的分支根本没动。
  改为从位置参数取分支名。
- **删除已打包的分支会复活**
  只删了松散 ref 文件，\`packed-refs\` 里的记录还在。
  现在 \`deleteRef\` 同时处理两处。
- **审计器漏检悬空引用**
  分支指向不存在的提交时没报错——遍历队列用 \`filter(objects.has)\`
  把非法 tip 静默丢弃了。现在单独检查每个 ref 的目标是否存在。
- **审计器误报浅克隆仓库**
  \`clone --depth\` 的边界提交其 parent 有意不存在，现在读 \`.git/shallow\` 并跳过。

### 测试

- 新增 \`test/pack-delta-writer.test.js\`（11 项）：每个用例都做 delta→apply 往返校验
- 新增 \`test/gc-packed-refs.test.js\`（9 项）：含「gc 不能丢已暂存对象」
  「删除打包分支不能复活」「dry-run 不产生副作用」
- 总计 **148 项测试**

## 1.1.1

全面检查维护：修掉 5 个真实缺陷，其中 2 个会导致数据错误。

### 严重缺陷（会丢数据）

**1. 解决合并冲突后，被合并分支的历史消失**

冲突时没有写 ``MERGE_HEAD``，``commit`` 也就不知道正处于合并状态，
于是解决冲突后的提交只有 **1 个 parent**。后果：

- 被合并分支的提交从提交图里彻底丢失（实测可达提交从 4 降到 3）
- 之后再次 merge 会重复报冲突，因为 git 认为从未合并过

修复：冲突时写 ``MERGE_HEAD`` / ``MERGE_MSG``，``commit`` 读取它并写入第二个 parent，成功后清理。

**2. `status` 会往对象库写东西**

为了比较内容是否变化，``status`` 调用了 ``writeObject`` —— 这会真正落盘。
结果是「只跑一次 ``status``」就往 ``.git/objects`` 塞入所有未跟踪文件的 blob，
违背 git 语义（``git status`` 是纯只读操作），对大文件尤其浪费。

修复：改用 ``hashObject``（只算哈希不落盘）。

### 功能缺陷

**3. `log` 只沿 first-parent 遍历**

合并后只显示一侧历史，另一分支的提交完全不出现。真 git 会遍历所有 parent。

修复：改为提交图遍历 + 拓扑序排序。顺带解决了「同一秒创建的提交排序错乱」问题
（只按时间戳排序会退化成插入顺序，可能把父提交排到子提交前面）。

**4. `verifyIdxChecksum` 在 ESM 模块里用 ``require()``**

调用即抛 ``ReferenceError: require is not defined``。修复为顶部 ``import``。

**5. idx 自校验和覆盖范围错误**

上一版认为覆盖 ``[0, len-40)``（不含 pack 校验和），**实际是 ``[0, len-20)``（包含）**。
用真实 git 的 3,513 对象 idx 文件实测确认：末尾 40 字节中，前 20 是 pack 校验和，
后 20 是「包含前 20 字节」的 sha1。已同步修正 ``writer.js``，现在自己生成的 idx 与真 git 语义一致。

### 新增：pack 读取真正接入

pack 解析器此前只存在于独立测试里，**``readObject`` 并未使用它**，
导致所有命令遇到打包对象都报 ``packed objects are not supported`` —— 
单元测试全绿，真实使用全废。

现在 ``readObject`` / ``objectExists`` 都会回退到 pack，
并新增 ``listAllObjects`` 统一列出松散 + 打包对象。pack 读取器带签名缓存，
pack 文件变化（fetch / gc / 测试改目录）时自动重建。

### 新增命令

- ``tinygit rm <路径...>``：从索引移除（此前 ``removeFromIndex`` 有实现但无入口）
- ``tinygit status`` 在合并冲突期间会显示 Unmerged paths 与解决提示

### 死代码清理

删除 5 个未被引用的导出：``resolveHead``（与 readHeadRef 重复）、``commitExists``、
``fileStatSafe``、``countFilesInCommit``、``hashObjectFromString``。
``merge.js`` 改用 ``canFastForward``，消除重复的祖先判断。

### 新增审计工具

``scripts/audit.mjs``：独立审计器，**不复用任何 src/ 代码**，从头实现 Git 读取规则。
覆盖对象内容寻址、tree mode 合法性、tree 排序、提交图可达性、索引校验和、
索引与工作区一致性、孤儿对象检测等 112~129 项检查。

审计器自身经过反面测试：篡改对象 / 篡改索引 / 造孤儿 / 写坏指针，四种损坏全部被检出。

### 测试

从 110 项增至 **128 项**，新增覆盖：

- 打包仓库端到端（10 项）：命令能否读 pack、缓存失效、松散与打包共存
- 合并冲突解决后双亲正确性（2 项）
- ``log`` 遍历全部 parent、拓扑序、limit（3 项）
- ``status`` 无副作用（1 项）
- idx 校验和语义（2 项）

## 1.1.0

难度提升：从「只读写松散对象」升级到「能读真 Git 的打包仓库」，并支持三方合并。

### packfile 读取（新增）

- `.idx` v2 解析：fanout 表、sha 表、CRC32 表、偏移表、大偏移表
- 用 fanout 表把查找缩到首字节区间，再二分定位
- pack 对象头解析：类型 / 大小变长编码，支持 OFS_DELTA 与 REF_DELTA
- **delta 应用算法**：复制指令的按需字段、插入指令、长度 0 表示 65536 的特例
- **delta 链递归还原**：base 本身是 delta 时递归解析，深度上限 64
- **zlib 流边界定位**：利用「截断必然解压失败」二分出压缩流精确长度
- `pack-info` 命令：统计打包对象数量与类型分布

### packfile 写入（新增）

- `buildPack`：生成 `PACK` 头、对象头、zlib 数据、尾部校验和
- `buildIdx`：生成 v2 索引，按 sha 排序并构建 fanout 表
- CRC32 实现（与 zlib 定义一致）
- 写入能力使**闭环测试**成为可能：自己写 pack 再自己读回验证

### 三方合并（新增）

- `merge-base`：在提交 DAG 上求最近公共祖先
- `merge-file`：diff3 三路归并，`mergeSegments` 统一分段模型
- `merge` 命令：快进 / 已最新 / 真合并 / 冲突 四种结果
- 合并提交带两个 parent，消息为 `Merge branch 'x' into y`
- 冲突时写 Git 格式标记（`<<<<<<< `/`=======`/`>>>>>>>`），不自动提交

### 已修复

- **idx 尾部校验和顺序写反**：正确顺序是先 pack 校验和、再 idx 自校验和。
  靠「pack 文件名 = pack 校验和」交叉验证发现
- **idx 自校验和覆盖范围**：只覆盖索引主体，不含 pack 校验和。实测真文件确认
- **merge base 判据写反**：把「candidate 是 X 的祖先」错写成「X 是 candidate 的祖先」，
  导致分支点非根提交时退化到根提交，进而产生假冲突（两边改不同文件却报冲突）
- **零宽区间重叠漏判**：纯插入产生的块 `[start, end)` 中 `start === end`，
  同位置的两个插入未被判为冲突，导致两边内容同时出现

### 测试

- 从 47 项增至 **110 项**
- 新增：varint 双编码往返、delta 应用（含 65536 特例）、pack 写读闭环、
  idx fanout / 查找 / 校验和、**真实 Git pack 解析（3,513 个对象全部 sha 吻合）**、
  三方归并 12 种边界、merge base 7 种情形、merge 命令端到端 7 种场景

### 已知限制

- 只写完整对象，不生成 delta（能读 delta）
- 不支持 thin pack 与多 pack 索引（midx）
- 合并不识别文件改名

## 1.0.0

首个可用版本。

### 对象层

- 内容寻址存储：blob / tree / commit 三种对象的编解码
- 头部格式 `"<type> <size>\0"` + zlib 压缩，哈希覆盖头部与内容
- 松散对象按 sha 前两位分目录存放，已存在则跳过写入（幂等）

### 树

- tree 序列化与解析，条目含 mode / name / 二进制 sha
- **按 Git 规则排序**：目录名视为带尾部斜杠，用 `Buffer.compare` 做字节序比较
- 从扁平路径列表递归构建嵌套 tree
- tree 扁平化为 `path -> {mode, oid}` 映射

### 索引

- 二进制索引格式（v2）：DIRC 签名、条目计数、62 字节固定头 + 路径 + 8 字节对齐填充
- 末尾 20 字节 SHA-1 校验和
- 读写与排序

### 提交

- commit 序列化：tree / parent / author / committer / message
- 时区格式化为 `±HHMM`
- 沿 parent 链回溯历史
- 无变更时拒绝产生空提交

### 引用

- HEAD 符号引用解析，带深度上限防循环
- 分支的创建 / 列举 / 删除
- 分离头指针支持

### 差异

- Myers O(ND) 最短编辑脚本算法
- 反向回溯还原具体操作序列
- 按上下文聚合成 hunk，输出 unified diff 格式
- 二进制文件（含 NUL 字节）自动跳过

### 命令行

- `init` / `status` / `add` / `commit` / `log`
- `diff` / `ls-tree` / `cat-file` / `hash-object`
- `branch` / `checkout`
- 退出码约定：0 成功 / 1 用法错误 / 2 内部异常

### 验证

- 42 项测试（41 通过 + 1 项按平台跳过）
- 独立重写的格式验证器，`scripts/verify.mjs`，21 项检查不复用被测代码
- 端到端演示脚本 `scripts/demo.mjs`

### 已修复

- mode 规范化时把十进制 `st_mode` 当八进制解析，导致可执行位丢失
- `os.tmpdir()` 在缺少 `TEMP` 环境变量时返回畸形路径，测试加兜底
- 可执行位测试在 Windows 上必然失败（NTFS 无 POSIX 权限位），改为平台感知跳过
- demo 用 7 位短 oid 调用 `cat-file` 导致失败，改用完整 log 输出解析

### 已知限制

- 不支持 packfile（只能读松散对象）
- 不支持 merge / rebase / cherry-pick / stash / tag / remote
- `.gitignore` 不支持取反规则和嵌套文件
- 不支持索引 v4 与扩展段
