# 变更日志

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
