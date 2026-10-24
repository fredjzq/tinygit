// pkt-line：Git 传输层的帧格式。
//
// 每个帧是「4 位十六进制长度 + 载荷」，长度包含这 4 字节头本身：
//
//   001e# service=git-upload-pack\n     ← 长度 0x1e = 30
//   0000                                ← flush-pkt（长度为 0）
//   0001                                ← delim-pkt（协议 v2 用它分段）
//   0002                                ← response-end-pkt
//
// 载荷长度上限 65516，留出余量避免与特殊帧冲突。
//
// 三个特殊长度必须记住，写错一个就会让整个协商卡死：
//   0000 flush —— 表示「这一轮说完了」
//   0001 delim —— 协议 v2 的段落分隔
//   0002 response-end —— v2 的分轮结束

// 最大载荷：65516 字节（0x10000 - 4 字节头 - 16 字节余量）
export const MAX_PAYLOAD = 65516;

export function encodePktLine(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  if (buf.length > MAX_PAYLOAD) {
    throw new Error("pkt-line: payload too large (" + buf.length + " > " + MAX_PAYLOAD + ")");
  }
  // 长度是 4 位十六进制，且包含头本身
  const header = Buffer.from((buf.length + 4).toString(16).padStart(4, "0"), "latin1");
  return Buffer.concat([header, buf]);
}

export function flushPkt() {
  return Buffer.from("0000", "latin1");
}

export function delimPkt() {
  return Buffer.from("0001", "latin1");
}

// 解析一段数据里的所有 pkt-line。
// 返回 { packets, rest }，rest 是不完整的尾部（流式场景下需要保留）。
export function parsePktLines(buf, startOffset = 0) {
  const packets = [];
  let pos = startOffset;

  while (pos + 4 <= buf.length) {
    const header = buf.subarray(pos, pos + 4).toString("latin1");
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      throw new Error("pkt-line: invalid length header at " + pos + ": " + JSON.stringify(header));
    }
    const len = parseInt(header, 16);

    if (len === 0) {
      packets.push({ type: "flush", offset: pos });
      pos += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ type: "delim", offset: pos });
      pos += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ type: "response-end", offset: pos });
      pos += 4;
      continue;
    }
    if (len < 4) {
      throw new Error("pkt-line: invalid packet length " + len + " at " + pos);
    }
    if (pos + len > buf.length) {
      // 数据不完整：流式读取时这是正常情况
      return { packets, rest: buf.subarray(pos) };
    }

    packets.push({
      type: "data",
      data: buf.subarray(pos + 4, pos + len),
      length: len,
      offset: pos,
    });
    pos += len;
  }

  return { packets, rest: buf.subarray(pos) };
}

// side-band 复用：首字节是通道号
//   1 = 主数据（packfile 内容）
//   2 = 进度信息
//   3 = 错误
export function encodeSideband(channel, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const out = [];
  for (let i = 0; i < buf.length; i += MAX_PAYLOAD - 1) {
    const chunk = buf.subarray(i, i + MAX_PAYLOAD - 1);
    out.push(encodePktLine(Buffer.concat([Buffer.from([channel]), chunk])));
  }
  return Buffer.concat(out);
}
