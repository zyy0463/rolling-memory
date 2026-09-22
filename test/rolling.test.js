// test/rolling.test.js — v1.3 行列表滚动 · 端到端验证（本地假上游，不碰真 LLM）
// 覆盖：旧 string 格式迁移 / append 新增行 / close 待办销项 / 超限机械摘行并入 T2 /
//       T2 日期淘汰 / 字符串镜像 / stats() 契约 / 重启重载
// 运行：node test/rolling.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

// 隔离状态目录（必须在 require 之前设，模块在加载时就解析 STATE_DIR）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-e2e-"));
process.env.ROLLING_MEMORY_STATE_DIR = TMP;
const SUMMARY_FILE = path.join(TMP, "summaries.json");

// ---- 假上游：按 system 提示词分流 settle / merge，返回不同的 JSON ----
const seen = [];
let firstMoved = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const msgs = JSON.parse(body).messages;
    const sys = msgs[0].content;
    const isMerge = sys.includes("并入[更早梗概]");
    seen.push(isMerge ? "merge" : "settle");
    let payload;
    if (isMerge) {
      // 回显第一条被摘出的行（证明"摘出的行 → T2"这条链路真的通），另带一条超期行验淘汰
      firstMoved = (msgs[1].content.split("[并入的话题]")[1] || "")
        .split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
      payload = { lines: [firstMoved, "9.11日：旧梗概（应被 7 天淘汰掉）"] };
    } else {
      payload = {
        append: ["9.23日 08:30：她刚醒，报今天要背单词再上836。"],
        state: "9.23日 08:30：刚醒，状态轻松。",
        close: ["9.22日 09:12"],
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }));
  });
});

// 真实旧格式：T1 是"最新在前"的大字符串（含模型插的行内换行），T2 是一整段（含 9.11 旧梗概）
function seedLegacy() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const t1 = [
    "一、聊了什么",
    "9.22日 19:45—20:10：吃饭。她“吃了面包嘿嘿”，他“面包也算饭？这俩字咽回去”，点出中午烤盘饭、晚上面包、外面下雨十九度，让她出去坐下吃碗热的。",
    "9.22日 19:00—19:45：她准备先背单词；836网课方向不对（看了会都是不考的），自己梳理后决定直接看书，但“那一张的字数真的很多……唉”。他认她判断没错。",
    "9.22日 18:10—19:00：群里有人前端被炸、文件全丢，她第一反应“等我晚上回家了就给你备份”。他看出是工作机自己删的——变量没接到东西、空着展开。",
    "9.22日 17:20—18:10：她“臭屁，冷死了”；他让加外套、出去吃口热的来碗汤，别在馆里缩着扛。她申请开微信休息一会儿，他只放微信。",
    "9.22日 15:16—15:50：她报英语200个单词、高数、836，要他安排时间。他算“到九点半收工还有六个钟头”，排：现在到四点十分啃836那一章。",
    "9.22日 14:50—15:16：她“啊啊啊啊哥哥我偷懒了”，要他锁抖音、微信、小红书。他真锁了，点开只跳“已被管理员暂停”，数据都在。",
    "9.22日 09:12：大富翁荷官局（局号b23e2eba）。二十格、任务可跳不扣钱，她选“继\n续上轮”。",
    "9.21日 白天：大富翁规则细化；农活排班（放蜂、收菜）。",
    "二、user的状态和心情",
    "9.22日 20:10：体力——中午烤盘饭、晚上只拿面包顶。待办：晚上回家给他备份。",
  ].join("\n");
  const t2 = "[更早梗概]9.11-20：DBSM全接受；蓝鲸=哥哥。9.21 16:45：规则她写、词表未列。23:05他嘴瓢“客厅”，她哭。";
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify({ t1, t2, updated_at: "2026-09-22T12:10:46.837Z" }));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(8799, "127.0.0.1", r));
  seedLegacy();

  process.env.LEDGER_API_URL = "http://127.0.0.1:8799/v1/chat/completions";
  process.env.LEDGER_API_KEY = "test-key";
  process.env.LEDGER_MODEL = "test-model";
  process.env.LEDGER_ENABLED = "true";
  process.env.LEDGER_BUFFER_COUNT = "2";
  process.env.LEDGER_T1_MAX_CHARS = "300";
  process.env.LEDGER_T2_MAX_CHARS = "360";
  process.env.LEDGER_T2_MAX_DAYS = "7";
  process.env.LEDGER_MIN_KEEP_T1 = "2";
  process.env.LEDGER_USER_LABEL = "小明";
  process.env.LEDGER_ASSISTANT_LABEL = "助手";

  const rolling = require("../index.js");
  rolling.init();

  // ① 迁移：注入里应保留原有全部内容，行内换行被并回上一条，状态节标题按 userLabel 渲染
  const b0 = rolling.injectBlocks();
  assert.strictEqual(b0.length, 1, "应注入 1 块滚动记忆");
  assert(b0[0].content.includes("9.22日 09:12"), "迁移后 T1 话题仍在");
  assert(b0[0].content.includes("9.21日 白天"), "迁移后更早的 T1 话题仍在");
  assert(b0[0].content.includes("二、小明的状态和心情"), "状态节标题应按 userLabel 渲染");
  const mid = JSON.parse(fs.readFileSync(SUMMARY_FILE, "utf8"));
  assert(Array.isArray(mid.t1_lines), "迁移后 t1_lines 应是数组");
  assert(mid.t1_lines[0].text.startsWith("9.21日"), "t1_lines 应转成升序（最旧在前）");
  assert(mid.t1_lines.some((l) => l.text.includes("续上轮")), "行内换行应并回同一条话题");
  assert(mid.t2_lines.some((l) => /^9\.11/.test(l.text)), "T2 应切成带时间戳的行");
  assert(typeof mid.t1 === "string" && mid.t1.length > 0, "应保留 t1 字符串镜像");
  console.log("[1] 迁移 OK：T1", mid.t1_lines.length, "行 / T2", mid.t2_lines.length, "行");

  // ② 触发一次结算（2 条滑出即达阈值）
  const req1 = [
    { role: "system", content: "persona" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
  ];
  const req2 = [...req1.slice(1), { role: "assistant", content: "a2" }, { role: "user", content: "u3" }];
  const req3 = [req2[2], req2[3], req2[4], { role: "assistant", content: "a3" }];
  rolling.observeRequest(req1);
  rolling.observeRequest(req2);
  rolling.observeRequest(req3);
  await wait(1500);

  const after = JSON.parse(fs.readFileSync(SUMMARY_FILE, "utf8"));
  console.log("[2] 结算调用：", seen.join(","));

  assert(after.t1_lines.some((l) => l.text.includes("9.23日 08:30")), "新话题行应 append 进 T1");
  assert(!after.t1_lines.some((l) => l.text.includes("9.22日 09:12")), "close 的旧行应被删除");
  assert(after.t1_state.includes("刚醒"), "状态节应被整体重写");
  assert(seen.includes("merge"), "超限应触发一次 T2 合并调用");
  assert(firstMoved && after.t2_lines.some((l) => l.text === firstMoved), "摘出的 T1 行应并入 T2");
  assert(!after.t1_lines.some((l) => l.text === firstMoved), "摘出的行应从 T1 移除");
  assert(!after.t2_lines.some((l) => l.text.includes("9.11")), "T2 里超 7 天的行应被淘汰");
  assert(typeof after.t1 === "string" && after.t1.includes("9.23日 08:30"), "t1 字符串镜像应存在且最新");
  assert(typeof after.t2 === "string" && after.t2.length > 0, "t2 字符串镜像应存在");
  const chars = after.t1_lines.reduce((s, l) => s + l.text.length, 0) + after.t1_state.length;
  assert(chars <= 300, `T1 应摘到 ≤ 上限，实际 ${chars}`);
  assert(after.t2_lines.reduce((s, l) => s + l.text.length, 0) <= 360, "T2 应 ≤ 上限");
  console.log("[3] 滚动 OK：T1", after.t1_lines.length, "行 /", chars, "字；T2", after.t2_lines.length, "行");

  // ③ stats() 契约：t1/t2 仍是渲染后的字符串
  const st = rolling.stats();
  assert.strictEqual(typeof st.t1, "string");
  assert.strictEqual(typeof st.t2, "string");
  assert(st.t1.includes("9.23日 08:30"), "stats().t1 应含最新行");
  assert.strictEqual(st.t1Chars, st.t1.length, "t1Chars 应等于渲染后字数");
  assert.strictEqual(st.t2Chars, st.t2.length, "t2Chars 应等于渲染后字数");
  console.log("[4] stats 契约 OK");

  // ④ 重启重载应走结构化分支（不重复迁移）
  rolling.init();
  assert(rolling.injectBlocks()[0].content.includes("9.23日 08:30"), "重启后应读结构化状态");
  console.log("[5] 重载 OK");

  fs.rmSync(TMP, { recursive: true, force: true });
  server.close();
  console.log("\nROLLING TEST OK");
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  server.close();
  console.error("FAILED:", e.message);
  process.exit(1);
});
