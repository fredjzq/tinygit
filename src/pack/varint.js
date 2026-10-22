// packfile 里的两种变长整数编码。它们规则不同，混用是常见错误来源。

// ---- 类型 1：OFS_DELTA 的对象偏移（相对偏移）----
//
// 编码方式：每字节低 7 位是数据，高位表示「还有后续」。
// 但**偏移量不是简单的位拼接**，有一个 +1 的累加修正：
//
//   byte0 = buf[i]; off = byte0 & 0x7f;
//   while (byte0 & 0x80) {
//     byte0 = buf[++i];
//     off = ((off + 1) << 7) | (byte0 & 0x7f);
//   }
//
// 那个 +1 让「续字节」和「终止字节」的编码空间不重叠，
// 从而保证同一偏移只有唯一编码（否则可有前导零，不唯一）。
// 漏掉 +1 会导致偏移算错，进而读到完全错误的 base 对象。
export function readOffsetVarint(buf, start) {
  let i = start;
  let byte = buf[i];
  let value = byte & 0x7f;
  let consumed = 1;
  while (byte & 0x80) {
    byte = buf[++i];
    consumed += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, next: start + consumed };
}

export function encodeOffsetVarint(distance) {
  // 反向构造：先取出最低 7 位，再不断回推
  const bytes = [distance & 0x7f];
  let remaining = distance >>> 7;
  while (remaining > 0) {
    remaining -= 1;
    bytes.push(0x80 | (remaining & 0x7f));
    remaining >>>= 7;
  }
  return Buffer.from(bytes.reverse());
}

// ---- 类型 2：delta 头部（base 大小 / result 大小）----
//
// 与上面不同：这里没有 +1 修正，是标准的「续位拼接」，
// 每字节低 7 位有效、高位表示继续。
export function readSizeVarint(buf, start) {
  let i = start;
  let value = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[i];
    i += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value, next: i };
}

export function encodeSizeVarint(value) {
  const bytes = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v > 0) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0);
  return Buffer.from(bytes);
}
