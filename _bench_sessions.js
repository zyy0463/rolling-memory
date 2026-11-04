// 对比基准：同样的输入（两个会话交替 8 轮、窗口 4 条），
// 分别在 v1.8 行为（LEDGER_SESSION_ISOLATION=0）和 v1.9（隔离开）下跑，数出入。
// 用法：node _bench_sessions.js [on|off]
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const MODE = process.argv[2] === "off" ? "off" : "on";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
process.env.ROLLING_MEMORY_STATE_DIR = TMP;
process.env.LEDGER_SESSION_ISOLATION = MODE === "off" ? "0" : "1";
process.env.LEDGER_API_URL = "http://127.0.0.1:18908/v1/chat/completions";
process.env.LEDGER_API_KEY = "k";
process.env.LEDGER_MODEL = "deepseek-chat";
process.env.LEDGER_BUFFER_COUNT = "1";       // 一滑出就结算
process.env.LEDGER_BUFFER_CHARS = "99999";
process.env.LEDGER_T1_MAX_CHARS = "9000";    // 不压缩，只看串味
process.env.LEDGER_T1_MAX_LINES = "999";

const swallowed = [];
let batches = 0;
const server = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => b += c);
  req.on("end", () => {
    const j = JSON.parse(b);
    const sys = (j.messages[0] && j.messages[0].content) || "";
    let content;
    if (/记忆压缩器/.test(sys)) {
      batches++;
      const lines = (j.messages[1].content.split("[新对话]")[1] || "").split("\n").map((s) => s.trim()).filter(Boolean);
      swallowed.push(...lines);
      content = JSON.stringify({ append: lines.map((l, i) => `11.4日 1${i % 9}:00：${l.slice(0, 40)}`), state: "s", close: [] });
    } else content = JSON.stringify({ lines: [] });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = 4;
function turn(tag, n) {
  const m = [{ role: "system", content: "p" }];
  for (let i = 1; i <= n; i++) m.push({ role: i % 2 ? "user" : "assistant", content: `${tag} 第${i}句` });
  return m.slice(-WIN);
}
(async () => {
  await new Promise((r) => server.listen(18908, "127.0.0.1", r));
  const L = require("./index");
  L.init();
  for (let n = 1; n <= 8; n++) {
    L.observeRequest(turn("甲", n)); await wait(35);
    L.observeRequest(turn("乙", n)); await wait(35);
  }
  await wait(2500);

  const sessions = L.listSessions();
  let mixedSessions = 0, totalLines = 0;
  const per = [];
  for (const s of sessions) {
    const lines = (L.snapshot(s.id).t1_lines || []).map((x) => x.text);
    if (!lines.length) continue;
    const joined = lines.join("\n");
    const hasA = /甲/.test(joined), hasB = /乙/.test(joined);
    if (hasA && hasB) mixedSessions++;
    totalLines += lines.length;
    per.push({ id: s.id, lines: lines.length, hasA, hasB });
  }
  const dup = swallowed.length - new Set(swallowed).size;
  const out = {
    mode: MODE === "off" ? "v1.8（一份摘要）" : "v1.9（会话隔离）",
    settleBatches: batches,
    messagesSentToSettle: swallowed.length,
    duplicatedMessages: dup,
    sessions: sessions.length,
    sessionsMixingBoth: mixedSessions,   // 同时含甲乙的会话数 = 串味
    totalT1Lines: totalLines,
    detail: per,
  };
  console.log(JSON.stringify(out, null, 2));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  server.close(); process.exit(0);
})();
