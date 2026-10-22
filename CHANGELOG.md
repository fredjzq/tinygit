# 变更日志

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
