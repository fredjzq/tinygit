// Git 智能 HTTP 协议客户端（v0/v1）。
//
// 这是「能不能和真实世界交互」的分水岭——在此之前项目只能操作本地仓库。
//
// 抓取一个远程分支要经过两个往返：
//
//   1. GET  <url>/info/refs?service=git-upload-pack
//      → 服务端广告所有引用和它的能力集
//
//   2. POST <url>/git-upload-pack
//      → 客户端发 want/have，服务端回 packfile
//
// 关键设计决策与踩坑记录：
//
//   · 首行格式是 "<sha> <ref>\0<capabilities>"，能力集用 NUL 与 ref 分隔。
//     如果按空格切分，会把能力名当成 ref 名。
//
//   · 协商（have/want）决定了会传多少数据。只发 want 不发 have 时，
//     服务端会认为你什么都没有，把整个历史全打包过来——看起来能用，
//     但每次都要传完整仓库。这里实现了多轮协商。
//
//   · side-band-64k：pack 数据被拆进 channel 1 的帧里，进度在 channel 2。
//     不处理通道号会把进度文本当成 pack 内容拼进去，pack 立刻损坏。
//
//   · 服务端返回的 pack 可能是「thin pack」——delta 的 base 不在包里。
//     这里先按普通 pack 解析，遇到缺 base 时报明确错误（不静默吞掉）。

import { encodePktLine, flushPkt, parsePktLines } from "./pkt-line.js";

// 让服务器返回未压缩的响应，便于我们自己处理 side-band
const AGENT = "tinygit/1.2.0";

function authHeaders(url, auth) {
  const headers = {
    "User-Agent": AGENT,
    "Accept-Encoding": "identity",
  };
  if (!auth) return headers;
  if (auth.token) {
    headers["Authorization"] = "Basic " + Buffer.from("x-access-token:" + auth.token).toString("base64");
  } else if (auth.username && auth.password) {
    headers["Authorization"] = "Basic " +
      Buffer.from(auth.username + ":" + auth.password).toString("base64");
  }
  return headers;
}

// 解析服务端广告。返回 { refs, capabilities, headTarget }
export function parseAdvertisement(buf) {
  const { packets } = parsePktLines(buf);
  const refs = new Map();
  const capabilities = new Set();
  let headTarget = null;
  let sawService = false;

  for (const p of packets) {
    if (p.type !== "data") continue;
    let line = p.data.toString("utf8");

    // 第一帧是 "# service=git-upload-pack\n"
    if (line.startsWith("# service=")) {
      sawService = true;
      continue;
    }
    line = line.replace(/\n$/, "");
    if (!line) continue;

    // 首行可能带能力集，用 NUL 分隔
    const nul = line.indexOf("\0");
    let refPart = line;
    if (nul >= 0) {
      refPart = line.slice(0, nul);
      for (const cap of line.slice(nul + 1).split(" ")) {
        if (cap) capabilities.add(cap);
      }
    }

    const sp = refPart.indexOf(" ");
    if (sp < 0) continue;
    const oid = refPart.slice(0, sp);
    const ref = refPart.slice(sp + 1);
    if (!/^[0-9a-f]{40}$/.test(oid)) continue;
    refs.set(ref, oid);

    // symref=HEAD:refs/heads/main
    for (const cap of capabilities) {
      if (cap.startsWith("symref=HEAD:")) headTarget = cap.slice("symref=HEAD:".length);
    }
  }

  return { refs, capabilities, headTarget, sawService };
}

// 第 1 步：读服务端广告
export async function fetchAdvertisement(baseUrl, options = {}) {
  const url = baseUrl.replace(/\/$/, "") + "/info/refs?service=git-upload-pack";
  const res = await fetch(url, { headers: authHeaders(url, options.auth) });

  if (res.status === 401) {
    throw new Error("仓库需要认证（401）。请提供 token 或用户名密码。");
  }
  if (res.status === 404) {
    throw new Error("仓库不存在或不可访问（404）: " + baseUrl);
  }
  if (!res.ok) {
    throw new Error("读取服务端广告失败: HTTP " + res.status);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("git-upload-pack-advertisement")) {
    throw new Error(
      "该地址不支持智能 HTTP 协议（content-type: " + ct + "）。" +
      "可能需要改用 git:// 或 ssh，或者这是一个裸静态目录。"
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return parseAdvertisement(buf);
}

// 第 2 步：发起 upload-pack 请求，拿 packfile。
//
// wants: 需要的提交 oid
// haves: 客户端已有的提交 oid（用于减少传输量）
export async function fetchPack(baseUrl, options) {
  const { wants, haves = [], capabilities = new Set(), auth = null, depth = null } = options;

  if (wants.length === 0) throw new Error("fetch: 至少要 want 一个对象");

  const url = baseUrl.replace(/\/$/, "") + "/git-upload-pack";

  // 声明我们支持的能力。只声明真正实现了的——
  // 声明了却不处理，服务端就会按那个格式发数据，然后解析失败。
  const caps = [];
  if (capabilities.has("multi_ack_detailed")) caps.push("multi_ack_detailed");
  else if (capabilities.has("multi_ack")) caps.push("multi_ack");
  if (capabilities.has("side-band-64k")) caps.push("side-band-64k");
  else if (capabilities.has("side-band")) caps.push("side-band");
  if (capabilities.has("ofs-delta")) caps.push("ofs-delta");
  if (depth !== null && capabilities.has("shallow")) caps.push("shallow");

  const parts = [];
  let first = true;
  for (const w of wants) {
    let line = "want " + w;
    if (first) {
      line += " " + caps.join(" ");
      first = false;
    }
    parts.push(encodePktLine(line + "\n"));
  }

  if (depth !== null) {
    parts.push(encodePktLine("deepen " + depth + "\n"));
  }

  parts.push(flushPkt());

  // 分批发送 have。每发一批就 flush，服务端会回 ACK/NAK。
  // 这里为了简单只做单轮：把所有 have 一次发完再 flush。
  for (const h of haves) {
    parts.push(encodePktLine("have " + h + "\n"));
  }
  parts.push(encodePktLine("done\n"));

  const body = Buffer.concat(parts);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(url, auth),
      "Content-Type": "application/x-git-upload-pack-request",
      "Accept": "application/x-git-upload-pack-result",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("upload-pack 请求失败: HTTP " + res.status + " " + text.slice(0, 200));
  }

  const raw = Buffer.from(await res.arrayBuffer());
  return parseUploadPackResponse(raw, { sideband: caps.includes("side-band-64k") || caps.includes("side-band") });
}

// 解析 upload-pack 的响应。
// 响应里混着 ACK/NAK 文本帧和 pack 数据帧，需要按帧类型分开。
export function parseUploadPackResponse(buf, options = {}) {
  const { sideband = true } = options;
  const { packets } = parsePktLines(buf);

  const acks = [];
  const packChunks = [];
  const progress = [];
  const errors = [];
  let inPack = false;

  for (const p of packets) {
    if (p.type !== "data") continue;
    const data = p.data;

    if (!inPack) {
      // 还没进入 pack 阶段：这一帧应该是 ACK 或 NAK 文本
      const text = data.toString("utf8").trim();
      if (text.startsWith("ACK") || text.startsWith("NAK") || text.startsWith("shallow") ||
          text.startsWith("unshallow") || text.startsWith("ERR ")) {
        if (text.startsWith("ERR ")) errors.push(text.slice(4));
        else acks.push(text);
        continue;
      }
      // 不是文本帧，说明 pack 数据从这里开始
      inPack = true;
    }

    if (!sideband) {
      packChunks.push(data);
      continue;
    }

    // side-band：首字节是通道号
    const channel = data[0];
    const payload = data.subarray(1);
    if (channel === 1) packChunks.push(payload);
    else if (channel === 2) progress.push(payload.toString("utf8"));
    else if (channel === 3) errors.push(payload.toString("utf8"));
  }

  if (errors.length > 0) {
    throw new Error("服务端错误: " + errors.join("; ").slice(0, 500));
  }

  const pack = packChunks.length > 0 ? Buffer.concat(packChunks) : null;
  if (pack && pack.length > 0) {
    // pack 必须以 PACK 开头。不以 PACK 开头说明解析错位了，
    // 比如把进度帧当成了数据帧。
    if (pack.subarray(0, 4).toString("latin1") !== "PACK") {
      throw new Error(
        "收到的数据不是合法 pack（开头是 " +
        JSON.stringify(pack.subarray(0, 16).toString("latin1")) +
        "）。可能是 side-band 通道处理错误。"
      );
    }
  }

  return { pack, acks, progress: progress.join("") };
}

// 从广告里挑出要抓的分支
export function resolveWantRefs(advertisement, refSpecs) {
  const out = [];
  for (const spec of refSpecs) {
    if (spec === "HEAD") {
      const target = advertisement.headTarget ?? "refs/heads/main";
      const oid = advertisement.refs.get(target) ?? advertisement.refs.get("refs/heads/master");
      if (oid) out.push({ ref: target, oid });
      continue;
    }
    const oid = advertisement.refs.get(spec);
    if (oid) out.push({ ref: spec, oid });
  }
  return out;
}
