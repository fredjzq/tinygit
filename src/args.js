// 极简参数解析：支持 --flag、--key value、-k value、位置参数。
//
// 为什么不用现成的：零依赖是硬约束，而需求本身很小，
// 手写反而更可控（例如 -m "带空格的消息"）。

const SHORT_WITH_VALUE = new Set(["m", "n"]);

export function parseArgs(argv) {
  const out = { command: null, args: [], flags: {} };
  const list = [...argv];

  // 第一个参数如果是选项（--version、--help）而不是命令，
  // 不能把它当命令名——否则 tinygit --version 会被当成
  // 「执行名为 --version 的命令」，报错说不在仓库内。
  out.command = list.length > 0 && !list[0].startsWith("-") ? list.shift() : null;

  while (list.length > 0) {
    const token = list.shift();
    if (token === "--") { out.args.push(...list); break; }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        out.flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (list.length > 0 && !list[0].startsWith("-")) {
        out.flags[body] = list.shift();
      } else {
        out.flags[body] = true;
      }
      continue;
    }
    if (/^-[A-Za-z]$/.test(token)) {
      const key = token.slice(1);
      if (SHORT_WITH_VALUE.has(key) && list.length > 0) {
        out.flags[key] = list.shift();
      } else {
        out.flags[key] = true;
      }
      continue;
    }
    out.args.push(token);
  }
  return out;
}
