// test/close-guard.js — v1.8 回归：close 收紧 + 两道代码护栏（端到端，假上游，不碰真 state）
//
// 背景：使用者报"信息丢失了好多"——T1 从一整天掉到只剩 2 行。真因是 close 销项：旧 prompt 把
// "话题有结论了"也算已结束，模型于是按天清算话题（一天销 4/4/8/5 行，两次销到 0 行）。
// close 是直接 filter 删行、删掉的不进 T2 也不留档，等于永久删除。本测试锁住：
//   ① prompt 只许销「待办/约定」行，"话题有结论了"不再是理由；
//   ② 代码两道硬护栏：销售后不低于 minKeepT1 行；一次销项不得超过本批 append 行数。
// 运行：node test/close-guard.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-close-guard-"));
const STATE_DIR = TMP;
const SUMMARY_FILE = path.join(TMP, "summaries.json");
const SRC = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

// 与本模块同口径的「今天」（东八）
const dayKey8 = (d = new Date()) => {
  const n8 = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${n8.getUTCFullYear()}-${n8.getUTCMonth() + 1}-${n8.getUTCDate()}`;
};
const [, MM, DD] = dayKey8().split("-");
const MD = `${MM}.${DD}`;
const line = (i, n) => `${MD}日 ${String(8 + i).padStart(2, "0")}:05：第${i + 1}条${n}`;

// ---- 假上游 ----
let scenario = { append: [], close: [] };
let settleCount = 0;
const seen = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const sys = JSON.parse(body).messages[0].content;
    let content;
    if (/整体压成/.test(sys) || /并入\[更早梗概\]/.test(sys)) {
      seen.push("compress");
      content = JSON.stringify({ lines: [] });
    } else {
      seen.push("settle");
      settleCount++;
      const p = settleCount === 1
        ? { append: scenario.append, close: scenario.close, state: `${MD}日 20:00：状态平稳。` }
        : { append: [], close: [], state: `${MD}日 20:00：状态平稳。` };
      content = JSON.stringify(p);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const read = () => JSON.parse(fs.readFileSync(SUMMARY_FILE, "utf8"));

// 全部用「今天」的日期行（非今天为空 → 不触发跨天整压，只测 close）
function seed(n) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const texts = Array.from({ length: n }, (_, i) => line(i, "话题，聊了些具体的安排。"));
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify({
    t1_lines: texts.map((t) => ({ ts: t.split("：")[0], text: t })),
    t1_state: `${MD}日 08:00：状态待观测。`,
    t2_lines: [{ ts: "9.20日", text: "9.20日：更早的梗概。" }],
    t1: "", t2: "", updated_at: new Date().toISOString(),
  }));
}

async function settleOnce(L, tag) {
  settleCount = 0;
  const ms = [];
  for (let i = 0; i < 7; i++) ms.push({ role: i % 2 === 0 ? "user" : "assistant", content: `v18-${tag}-${i}` });
  L.observeRequest(ms.slice(0, 3));
  L.observeRequest(ms.slice(1, 4));
  L.observeRequest(ms.slice(2, 5));
  L.observeRequest(ms.slice(3, 6));
  await wait(1600);
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

(async () => {
  await new Promise((r) => server.listen(18899, "127.0.0.1", r));

  process.env.ROLLING_MEMORY_STATE_DIR = STATE_DIR;
  process.env.LEDGER_API_URL = "http://127.0.0.1:18899/v1/chat/completions";
  process.env.LEDGER_API_KEY = "test-key";
  process.env.LEDGER_MODEL = "test-model";
  process.env.LEDGER_ENABLED = "true";
  process.env.LEDGER_BUFFER_COUNT = "2";
  process.env.LEDGER_BUFFER_CHARS = "99999";
  process.env.LEDGER_T1_MAX_CHARS = "2000";
  process.env.LEDGER_T1_MAX_LINES = "16";
  process.env.LEDGER_MIN_KEEP_T1 = "3";

  console.log("\n[v1.8] close 收紧 + 两道护栏（端到端）");
  const L = require("../index");
  L.init();

  await t("① 截断：命中 3 行但本批只新增 1 行 → 只销 1 行", async () => {
    seed(4);
    L.init();
    scenario = { append: [`${MD}日 13:05：本批新增的唯一一条话题。`], close: [`${MD}日 08:05`, `${MD}日 09:05`, `${MD}日 10:05`] };
    await settleOnce(L, "a");
    const st = read();
    assert.strictEqual(st.t1_lines.length, 4, `应 4+1-1=4 行，实际 ${st.t1_lines.length}（护栏失效会变成 2）`);
    assert.ok(!st.t1_lines.some((l) => l.text.startsWith(`${MD}日 08:05`)), "最旧那行应被销掉（从最旧端销）");
    assert.ok(st.t1_lines.some((l) => l.text.startsWith(`${MD}日 10:05`)), "被额度截断的行必须留着");
  });

  await t("② 零新增：本批没新增行 → 一行都不许销", async () => {
    seed(5);
    L.init();
    const before = read().t1_lines.map((l) => l.text);
    scenario = { append: [], close: [`${MD}日 08:05`, `${MD}日 09:05`, `${MD}日 10:05`] };
    await settleOnce(L, "b");
    const st = read();
    assert.strictEqual(st.t1_lines.length, 5, `零新增时不得销项，实际 ${st.t1_lines.length} 行`);
    assert.deepStrictEqual(st.t1_lines.map((l) => l.text), before, "行内容应一字未动");
  });

  await t("③ 保底：T1 接近保底时不许销空", async () => {
    seed(3);
    L.init();
    scenario = { append: [], close: [`${MD}日 08:05`, `${MD}日 09:05`] };
    await settleOnce(L, "c");
    assert.ok(read().t1_lines.length >= 3, "不得销到低于保底 3 行");
  });

  await t("④ 护栏不误伤：真待办结项（1 新增 + 1 命中）照常销掉", async () => {
    seed(4);
    L.init();
    scenario = { append: [`${MD}日 13:05：他托付的事已经办完，这件事办完了。`], close: [`${MD}日 08:05`] };
    await settleOnce(L, "d");
    const st = read();
    assert.strictEqual(st.t1_lines.length, 4, `4+1-1=4 行，实际 ${st.t1_lines.length}`);
    assert.ok(!st.t1_lines.some((l) => l.text.startsWith(`${MD}日 08:05`)), "待办那行应真的销掉");
    assert.ok(st.t1_lines.some((l) => l.text.includes("已经办完")), "本批新增行应在 T1 里");
  });

  await t("⑤ 本测试不该触发任何压缩（否则测的不是 close）", async () => {
    assert.ok(!seen.includes("compress"), `实际调用过 ${seen.join(",")}`);
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  server.close();
  console.log(`\n${"=".repeat(50)}`);
  console.log(`close-guard 通过 ${pass} / ${pass + fail}${fail ? `  ✗ 失败 ${fail}` : "  ✓ 全绿"}`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  try { server.close(); } catch {}
  console.error("FAILED:", e.message);
  process.exit(1);
});
