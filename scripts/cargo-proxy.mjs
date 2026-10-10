/**
 * 本机 cargo 依赖代理。
 *
 * 背景：本机 Windows 原生 TLS（schannel）不可用 —— cargo / curl.exe 访问 HTTPS 时报
 * `SEC_E_NO_CREDENTIALS`，而 Node 自带 OpenSSL 可以正常出站。
 *
 * 做法：在本机起一个**纯 HTTP** 的 crates 镜像代理，让 cargo 全程只与本机 127.0.0.1 通信
 * （明文 HTTP 不触发 schannel），由 Node 负责与上游镜像的 HTTPS 通信。
 *
 * 上游选择（已实测）：
 *   - rsproxy.cn：index 与 crate 下载都可用（dl 形如 /api/v1/crates/{crate}/{version}/download）
 *   - static.crates.io：官方 crate 文件（同样的 path 形式），作为回退
 *   - 清华 / 中科大：只镜像 index，其 config.json 的 dl 指向别处，因此仅用作 index 回退
 *
 * 用法：
 *   node scripts/cargo-proxy.mjs            # 默认端口 8787
 *   node scripts/cargo-proxy.mjs --port 8899
 *
 * 然后在 .cargo/config.toml 中：
 *   [source.crates-io]
 *   replace-with = "localproxy"
 *   [source.localproxy]
 *   registry = "sparse+http://127.0.0.1:8787/index/"
 */

import http from "node:http";
import process from "node:process";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8787;

/** index 上游（按顺序尝试） */
const INDEX_UPSTREAMS = [
  "https://rsproxy.cn/index/",
  "https://mirrors.ustc.edu.cn/crates.io-index/",
  "https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/",
];

/** crate 文件上游（路径均为 {crate}/{version}/download） */
const CRATE_UPSTREAMS = [
  "https://rsproxy.cn/api/v1/crates/",
  "https://static.crates.io/crates/",
];

const stats = { index: 0, crates: 0, bytes: 0, errors: 0, upstreamFails: 0 };

async function fetchUpstream(upstreams, rest, label) {
  let lastErr;
  for (const base of upstreams) {
    const url = base + rest;
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "user-agent": "cargo-local-proxy/1.0" },
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} from ${url}`);
        stats.upstreamFails += 1;
        continue;
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      stats.upstreamFails += 1;
    }
  }
  throw new Error(`${label} 所有上游均失败: ${lastErr?.message ?? "unknown"}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = decodeURIComponent(url.pathname);

  try {
    // sparse index 的 config.json：把 dl 指回本代理
    if (path === "/index/config.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ dl: `http://127.0.0.1:${PORT}/dl`, api: null }));
      return;
    }

    if (path.startsWith("/index/")) {
      const body = await fetchUpstream(INDEX_UPSTREAMS, path.slice("/index/".length), "index");
      stats.index += 1;
      stats.bytes += body.length;
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": body.length });
      res.end(body);
      return;
    }

    if (path.startsWith("/dl/")) {
      const body = await fetchUpstream(CRATE_UPSTREAMS, path.slice("/dl/".length), "crate");
      stats.crates += 1;
      stats.bytes += body.length;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
      res.end(body);
      return;
    }

    if (path === "/stats") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(stats));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (err) {
    stats.errors += 1;
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`proxy error: ${err.message}`);
    if (stats.errors <= 10 || stats.errors % 100 === 0) {
      console.error(`[proxy] ${path} -> ${err.message}`);
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`cargo 本地代理已启动: http://127.0.0.1:${PORT}/index/`);
  console.log(`  index 上游: ${INDEX_UPSTREAMS.join(" | ")}`);
  console.log(`  crate 上游: ${CRATE_UPSTREAMS.join(" | ")}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n[proxy] 统计: ${JSON.stringify(stats)}`);
    server.close(() => process.exit(0));
  });
}
