// proxy.js — 本地转发代理：给"没有网关"的用户用
// 用法：npm run proxy 后，把聊天客户端里的 API 地址改成
//       http://127.0.0.1:8787/v1/chat/completions（密钥原样不用动）
// 请求方向：客户端 → 本代理（滑窗观察 + 注入滚动摘要）→ 真实 LLM 接口
// 响应原样透传，流式 SSE 正常工作。
//
// ============================================================
// 【2026-09-20 双上游】对话与结算可以走不同的模型/厂商
// ------------------------------------------------------------
// 背景：很多人想「对话用贵的好模型（如 Grok / GPT / Claude），
//       总结用便宜的（如 DeepSeek）」——这恰恰是本模块最常见的用法。
// 但旧版 proxy.js 把 LEDGER_API_URL 同时当"对话上游"和"结算上游"，
// 导致两者被绑死：对话想走 Grok 就必须让结算也走 Grok（反之亦然）。
//
// 现行设计：
//   对话上游 = CHAT_API_URL   （客户端转发目标，可复用客户端自己的密钥）
//   结算上游 = LEDGER_API_URL （memory-ledger 内部调用，见 index.js）
// 两个变量各自独立；不填 CHAT_API_URL 时回退到 LEDGER_API_URL（向后兼容）。
// ============================================================
const http = require("http");
const https = require("https");
const { loadDotEnv } = require("./env");
const rolling = require("./index");

// 对话上游：CHAT_API_URL 优先，回退旧名（向后兼容）
function upstreamUrl() {
  return process.env.CHAT_API_URL
    || process.env.LEDGER_API_URL
    || process.env.TARGET_API_URL
    || "";
}

// 对话上游的密钥：CHAT_API_KEY 优先；不填则用客户端带来的 Authorization
function upstreamKey() {
  return process.env.CHAT_API_KEY || "";
}

function forward(req, res, bodyBuf) {
  const raw = upstreamUrl();
  let u;
  try { u = new URL(raw); } catch { u = null; }
  if (!u) {
    res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { message: "rolling-memory 代理未配置上游：请在 .env 里设置 LEDGER_API_URL" } }));
    return;
  }
  const mod = u.protocol === "https:" ? https : http;
  const headers = { "content-type": "application/json" };
  // 密钥优先级：客户端带来的 Authorization > CHAT_API_KEY > LEDGER_API_KEY
  // （客户端的密钥原样透传是默认行为——大多数客户端只需改地址、不用改密钥）
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  else if (upstreamKey()) headers.authorization = "Bearer " + upstreamKey();
  else if (process.env.LEDGER_API_KEY) headers.authorization = "Bearer " + process.env.LEDGER_API_KEY;
  const up = mod.request(
    {
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search, method: req.method, headers,
    },
    (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); }
  );
  up.on("error", (e) => {
    try {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { message: "rolling-memory 代理转发失败: " + e.message } }));
    } catch {}
  });
  if (bodyBuf) up.end(bodyBuf);
  else req.pipe(up);
}

function start({ port } = {}) {
  const listenPort = port || Number(process.env.PROXY_PORT) || 8787;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("rolling-memory 转发代理运行中\n"
        + "填到客户端的接口地址: http://127.0.0.1:" + listenPort + req.url + "\n"
        + "对话上游: " + (upstreamUrl() || "未配置（.env 里设 CHAT_API_URL）") + "\n"
        + "结算上游: " + (process.env.LEDGER_API_URL || "未配置（.env 里设 LEDGER_API_URL）") + "\n"
        + "查看记忆: npm run view\n");
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let bodyBuf = Buffer.concat(chunks);
      try {
        const body = JSON.parse(bodyBuf.toString("utf8"));
        if (Array.isArray(body.messages)) {
          rolling.observeRequest(body.messages);
          const blocks = rolling.injectBlocks();
          if (blocks.length) body.messages = [...body.messages, ...blocks];
          bodyBuf = Buffer.from(JSON.stringify(body), "utf8");
        }
      } catch (e) { console.log("[rolling-memory] 请求体非 JSON，原样透传:", e.message); }
      forward(req, res, bodyBuf);
    });
  });
  server.listen(listenPort, () => {
    console.log(`[rolling-memory] 转发代理已启动: http://127.0.0.1:${listenPort}/v1/chat/completions`);
    console.log(`[rolling-memory]   对话上游 → ${upstreamUrl() || "未配置（.env 里设 CHAT_API_URL）"}`);
    console.log(`[rolling-memory]   结算上游 → ${process.env.LEDGER_API_URL || "未配置（.env 里设 LEDGER_API_URL）"}`);
    console.log("[rolling-memory] 把客户端的 API 地址改成上面的地址即可，密钥不用动。查看记忆请运行 npm run view");
  });
  return server;
}

if (require.main === module) {
  loadDotEnv();
  rolling.init();
  start();
}
module.exports = { start };
