// test/sessions.js — v1.9 多会话隔离（端到端，假上游，不碰真 state、不碰真 LLM）
//
// 这个文件专门锁住 v1.9 要解决的那两件事（v1.8 实测出来的）：
//   ① 两个会话交替发请求时，两边的内容混进同一份摘要、消息被重复结算 2~4 次；
//   ② 换对话模型时客户端新开了会话，旧会话整个窗口被当"滑出"结算进来（串味）。
//
// 顺带锁住"换了不能坏"的部分：单会话滚动、默认会话的落盘位置（老用户零迁移）、
// 显式 sessionId 的精确落位、重启后还能认回原来的会话。
//
// 运行：node test/sessions.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-sessions-"));
const SUMMARY_FILE = path.join(TMP, "summaries.json");
const SESSION_DIR = path.join(TMP, "sessions");
process.env.ROLLING_MEMORY_STATE_DIR = TMP;

// ---- 假上游：记录每次结算"吞进了哪些消息"，用来查重复 ----
const swallowed = []; // 每条被送去结算的原文
let settleCalls = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = JSON.parse(body);
    const sys = (j.messages[0] && j.messages[0].content) || "";
    let content;
    if (/记忆压缩器/.test(sys)) {
      settleCalls++;
      const tail = (j.messages[1].content.split("[新对话]")[1] || "");
      const lines = tail.split("\n").map((s) => s.trim()).filter(Boolean);
      swallowed.push(...lines);
      content = JSON.stringify({
        append: lines.map((l, i) => `11.4日 1${i % 9}:00：${l.slice(0, 50)}`),
        state: "11.4日 13:00：状态。",
        close: [],
      });
    } else {
      content = JSON.stringify({ lines: [] });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
  });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const t1Of = (id) => {
  const f = id === "default" ? SUMMARY_FILE : path.join(SESSION_DIR, id + ".json");
  const j = readJson(f);
  return j ? (j.t1_lines || []).map((l) => l.text) : null;
};
function resetAll() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(TMP, { recursive: true });
  // 只删磁盘不够：会话表与全局变量还在内存里，会让下一个用例认领到上一个用例的会话
  if (global.__L) global.__L.reset();
  swallowed.length = 0;
  settleCalls = 0;
}

// 构造某会话的第 n 轮：窗口只留最近 4 条（模拟"客户端窗口很小"这个前提场景）
const WIN = 4;
function turn(tag, n) {
  const msgs = [{ role: "system", content: "persona" }];
  for (let i = 1; i <= n; i++) msgs.push({ role: i % 2 ? "user" : "assistant", content: `${tag} 第${i}句` });
  return msgs.slice(-WIN);
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

(async () => {
  await new Promise((r) => server.listen(18901, "127.0.0.1", r));
  process.env.LEDGER_API_URL = "http://127.0.0.1:18901/v1/chat/completions";
  process.env.LEDGER_API_KEY = "k";
  process.env.LEDGER_MODEL = "deepseek-chat";
  process.env.LEDGER_ENABLED = "true";
  process.env.LEDGER_BUFFER_COUNT = "1";   // 一滑出就结算，方便断言
  process.env.LEDGER_BUFFER_CHARS = "99999";
  process.env.LEDGER_T1_MAX_CHARS = "9000"; // 不压缩，专心看串味
  process.env.LEDGER_T1_MAX_LINES = "999";

  const L = require("../index");
  global.__L = L;

  console.log("\n[v1.9] 多会话隔离");
  resetAll();
  L.init();

  // ---------- 1. 单会话：换对话模型（客户端保留历史）→ 必须无缝 ----------
  await t("① 同一会话里换对话模型：记忆连续、不重复", async () => {
    resetAll(); L.init();
    // 前 4 轮用 A 模型，后 4 轮用 B 模型——observeRequest 只看消息，模型名根本传不进来，
    // 这正是"换模型对记忆层透明"的根据。
    for (let n = 1; n <= 8; n++) {
      L.observeRequest(turn("单会话", n));
      await wait(50);
    }
    await wait(1500);
    const lines = t1Of("default") || [];
    assert.ok(lines.length > 0, `应有摘要行，实际 ${lines.length}`);
    assert.ok(lines.some((l) => /单会话/.test(l)), "摘要应包含这个会话的内容");
    const dup = swallowed.filter((s, i) => swallowed.indexOf(s) !== i);
    assert.strictEqual(dup.length, 0, `不应有重复结算，实际重复 ${dup.length} 条：${dup.slice(0, 3)}`);
    assert.ok(L.listSessions().length === 1, "只应有一个会话");
  });

  // ---------- 2. 两会话交替：各归各的，互不串味 ----------
  await t("② 两个会话交替 16 轮：内容不混、消息不重复（v1.8 在这里串成一条）", async () => {
    resetAll(); L.init();
    for (let n = 1; n <= 8; n++) {
      L.observeRequest(turn("甲会话", n));
      await wait(40);
      L.observeRequest(turn("乙会话", n));
      await wait(40);
    }
    await wait(2000);
    const ids = L.listSessions().map((s) => s.id);
    assert.ok(ids.length >= 2, `应识别出至少两个会话，实际 ${ids.length} 个：${ids.join(",")}`);

    // 逐会话检查：每个会话的摘要里不能出现对方的内容
    let sawA = false, sawB = false;
    for (const id of ids) {
      const lines = t1Of(id);
      if (!lines) continue;
      const joined = lines.join("\n");
      const hasA = /甲会话/.test(joined);
      const hasB = /乙会话/.test(joined);
      assert.ok(!(hasA && hasB), `会话 ${id} 里同时出现了甲乙两边的对话（串味）`);
      if (hasA) sawA = true;
      if (hasB) sawB = true;
    }
    assert.ok(sawA && sawB, "两个会话都应各自记下内容");

    // 重复结算：交叉污染的直接后果
    const dup = swallowed.filter((s, i) => swallowed.indexOf(s) !== i);
    assert.strictEqual(dup.length, 0, `不应重复结算，实际 ${dup.length} 条：${dup.slice(0, 3)}`);
  });

  // ---------- 3. 换模型时新开会话（新窗口 ≥4 条）：不吞旧窗口 ----------
  await t("③ 换模型新开会话（5 条）：旧会话不丢、新会话独立（v1.8 会把旧窗口吞进摘要）", async () => {
    resetAll(); L.init();
    for (let n = 1; n <= 6; n++) { L.observeRequest(turn("旧会话", n)); await wait(40); }
    await wait(1600);
    const before = L.snapshot("default");
    const beforeLines = (before.t1_lines || []).map((l) => l.text);
    assert.ok(beforeLines.length > 0, "旧会话应已有摘要");

    // 新会话：第一条请求就带 5 条（>4），零重合
    const fresh = [{ role: "system", content: "persona" }];
    for (let i = 1; i <= 5; i++) fresh.push({ role: i % 2 ? "user" : "assistant", content: `新会话 第${i}句` });
    L.observeRequest(fresh);
    await wait(400);
    // 补一轮：真实客户端一定带着历史发（否则模型接不上），所以补的这轮也要带前几条
    L.observeRequest([{ role: "system", content: "persona" },
      ...fresh.slice(-3), { role: "user", content: "新会话 第6句" }]);
    await wait(1600);

    const afterLines = (L.snapshot("default").t1_lines || []).map((l) => l.text);
    assert.deepStrictEqual(afterLines, beforeLines, "旧会话的摘要不应被新会话动过");
    const all = L.listSessions();
    assert.ok(all.length >= 2, `应多出一个会话，实际 ${all.length} 个`);
    const newOne = all.find((s) => s.id !== "default" && (t1Of(s.id) || []).some((l) => /新会话/.test(l)));
    assert.ok(newOne, "新会话应独立存在且记下了自己的内容");
    // 铁证：旧会话的内容一个字都不该出现在新会话里（v1.8 的串味就是这么来的）
    assert.ok(!(t1Of(newOne.id) || []).some((l) => /旧会话/.test(l)), "新会话里不该出现旧会话的内容");
  });

  // ---------- 4. 新会话首句只有 1 条：先挂起，不污染任何人 ----------
  await t("④ 只有 1 句的请求（标题生成/新会话首句）：不污染任何会话", async () => {
    resetAll(); L.init();
    for (let n = 1; n <= 5; n++) { L.observeRequest(turn("主会话", n)); await wait(40); }
    await wait(1500);
    const before = (L.snapshot("default").t1_lines || []).map((l) => l.text);
    const pendingBefore = L.stats().pendingCount;

    // 模拟标题生成：1 条消息、与上一轮零重合
    L.observeRequest([{ role: "system", content: "persona" }, { role: "user", content: "给这段对话起个标题" }]);
    await wait(800);

    const after = (L.snapshot("default").t1_lines || []).map((l) => l.text);
    assert.deepStrictEqual(after, before, "单句请求不应改动任何摘要");
    assert.strictEqual(L.stats().pendingCount, pendingBefore, "单句请求不应塞进待结算缓冲");
    assert.ok(L.listSessions().length === 1, `不应新建会话，实际 ${L.listSessions().length} 个`);
  });

  // ---------- 5. 显式 sessionId：精确落位 ----------
  await t("⑤ 显式 sessionId：落到指定会话，文件在 sessions/<id>.json", async () => {
    resetAll(); L.init();
    for (let n = 1; n <= 5; n++) {
      L.observeRequest(turn("指定房", n), { sessionId: "my-room" });
      await wait(40);
    }
    await wait(1500);
    assert.ok(fs.existsSync(path.join(SESSION_DIR, "my-room.json")), "应有 sessions/my-room.json");
    const lines = t1Of("my-room") || [];
    assert.ok(lines.length > 0 && lines.some((l) => /指定房/.test(l)), "内容应落到 my-room");
    assert.ok(!(t1Of("default") || []).length, "默认会话应保持为空（没被顺手写脏）");
    // 注入也要能取到它
    const blocks = L.injectBlocks({ sessionId: "my-room" });
    assert.ok(blocks.length === 1 && /指定房|滚动摘要/.test(blocks[0].content), "注入应能按会话取");
  });

  // ---------- 6. 默认会话必须仍落在 summaries.json（老用户零迁移） ----------
  await t("⑥ 默认会话仍写 summaries.json，老文件位置不变", async () => {
    resetAll(); L.init();
    for (let n = 1; n <= 5; n++) { L.observeRequest(turn("兼容", n)); await wait(40); }
    await wait(1500);
    assert.ok(fs.existsSync(SUMMARY_FILE), "summaries.json 必须还在");
    const j = readJson(SUMMARY_FILE);
    assert.ok(Array.isArray(j.t1_lines) && j.t1_lines.length > 0, "内容应写在 summaries.json 里");
    assert.strictEqual(j.session, "default", "应标明自己属于哪个会话");
    assert.ok(!fs.existsSync(path.join(SESSION_DIR, "default.json")), "默认会话不该额外生成 sessions/default.json");
  });

  // ---------- 7. 重启后认回原来的会话（不能因为重启就开新档） ----------
  await t("⑦ 重启后第一个请求认回原会话（冷启动按 updated_at 归一化）", async () => {
    resetAll(); L.init();
    for (let n = 1; n <= 6; n++) { L.observeRequest(turn("重启前", n)); await wait(40); }
    await wait(1600);
    const before = (L.snapshot("default").t1_lines || []).map((l) => l.text);
    assert.ok(before.length > 0, "前置：应有摘要");

    // 模拟进程重启：init 会重新读盘；这里再造一个"窗口与谁都零重合"的请求
    L.init();
    const fresh = [{ role: "system", content: "persona" }];
    for (let i = 1; i <= 5; i++) fresh.push({ role: i % 2 ? "user" : "assistant", content: `重启后 第${i}句` });
    L.observeRequest(fresh);
    await wait(400);
    L.observeRequest([{ role: "system", content: "persona" },
      ...fresh.slice(-3), { role: "user", content: "重启后 第6句" }]);
    await wait(1600);

    const after = (L.snapshot("default").t1_lines || []).map((l) => l.text);
    assert.ok(after.length > before.length, `应该续在原会话上（原来是 ${before.length} 行，现在 ${after.length} 行）`);
    assert.ok(L.listSessions().length === 1, `不该多出新会话，实际 ${L.listSessions().length} 个`);
  });

  // ---------- 8. 上限保护：会话不会无限涨 ----------
  await t("⑧ maxSessions 上限：超出时卸载最久未用的（不删文件）", async () => {
    resetAll();
    process.env.LEDGER_MAX_SESSIONS = "3";
    L.init();
    // 窗口固定 4 条——不截断窗口的话消息只增不减，永远不会有消息"滑出"，也就永远不会结算
    const mk = (tag, n) => {
      const m = [{ role: "system", content: "p" }];
      for (let i = 1; i <= n; i++) m.push({ role: i % 2 ? "user" : "assistant", content: `${tag} 第${i}句` });
      return [m[0], ...m.slice(1).slice(-4)];
    };
    for (let i = 0; i < 6; i++) {
      for (let n = 1; n <= 5; n++) {   // 第 5 轮开始滑出 → 触发结算 → 落盘
        L.observeRequest(mk(`房${i}`, n), { sessionId: `room-${i}` });
        await wait(25);
      }
    }
    await wait(2000);
    // prune 在 bind 时执行，这里再绑一个触发一次，把超出上限的挤出去
    L.bindSession("room-probe");
    assert.ok(L.stats().sessions <= 3, `内存里应不超过 3 个会话，实际 ${L.stats().sessions}`);
    const onDisk = fs.existsSync(SESSION_DIR) ? fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json")) : [];
    assert.ok(onDisk.length >= 6, `磁盘文件应全部保留（被卸载只是从内存走，文件不动），实际 ${onDisk.length} 个`);
    process.env.LEDGER_MAX_SESSIONS = "8";
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  server.close();
  console.log(`\n${"=".repeat(50)}`);
  console.log(`sessions 通过 ${pass} / ${pass + fail}${fail ? `  ✗ 失败 ${fail}` : "  ✓ 全绿"}`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  try { server.close(); } catch {}
  console.error("FAILED:", e);
  process.exit(1);
});
