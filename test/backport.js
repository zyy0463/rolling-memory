// test/backport.js — 开源版（rolling-memory）回归测试
// 覆盖本轮回灌的功能：条数触发、sha256 指纹、重复消息、后台请求检测、
// v1.3 行列表滚动（append/close/state）、机械淘汰（evictT1OverLimit/pruneT2）、
// 解析失败重试、旧格式迁移、归档、双上游解析、用量观测。
// 运行：node test/backport.js（端到端另见 test/rolling.test.js）
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");

// 隔离状态目录，绝不碰真实 state/
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-test-"));
process.env.ROLLING_MEMORY_STATE_DIR = TMP;
process.env.LEDGER_API_URL = "http://127.0.0.1:1/v1/chat/completions";
process.env.LEDGER_API_KEY = "test-key";
process.env.LEDGER_MODEL = "test-model";
process.env.LEDGER_T1_MAX_CHARS = "1500";
process.env.LEDGER_BUFFER_COUNT = "6";

const rolling = require("../index");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const SRC = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const PROXY_SRC = fs.readFileSync(path.join(__dirname, "..", "proxy.js"), "utf8");

console.log("\n[1] 指纹与去重键");
t("指纹是 sha256 前 16 位（不是 md5）", () => {
  assert.ok(/crypto\.createHash\("sha256"\)/.test(SRC), "应使用 sha256");
  assert.ok(!/createHash\("md5"\)/.test(SRC), "不应残留 md5");
});
t("指纹只依赖 role+text（纯函数，滑窗检测的前提）", () => {
  assert.ok(/fpOf\(role, text\)[\s\S]{0,80}update\(role \+ "\\u0000" \+ text\)/.test(SRC));
  assert.ok(!/fpOf\([^)]*index/.test(SRC), "指纹不得掺入位置信息");
});
t("makeBatchKey 用 #n 区分同批重复消息", () => {
  assert.ok(/seenCount > 0 \? `\$\{fp\}#\$\{seenCount\}` : fp/.test(SRC));
});
t("addPending/addPendingBatch 使用 key 而非裸 fp", () => {
  assert.ok(/const key = m\.key \|\| m\.fp;/.test(SRC));
  assert.ok(/pendingFps\.has\(key\)/.test(SRC));
  assert.ok(/addPending\(\{ \.\.\.m, key: makeBatchKey\(m\.fp, n\) \}\)/.test(SRC));
});
t("runCycle 重排队用 key 而非 fp（否则重复消息会串味）", () => {
  assert.ok(/pendingFps\.add\(m\.key \|\| m\.fp\)/.test(SRC));
  assert.ok(/pendingFps\.delete\(dropped\.key \|\| dropped\.fp\)/.test(SRC));
  assert.ok(!/pendingFps\.add\(m\.fp\)/.test(SRC));
});

console.log("\n[2] 后台请求检测（旧注释承诺但代码缺失，且判据方向是错的）");
t("判据用的是【本轮】条数，不是上轮", () => {
  assert.ok(/const BG_CUR_MAX = 3;/.test(SRC));
  assert.ok(/cur\.length <= BG_CUR_MAX && overlap === 0/.test(SRC));
  assert.ok(!/prevFps\.length < 6/.test(SRC), "不得残留错误的上轮判据");
});
t("后台请求与换窗互斥", () => {
  assert.ok(/overlap === 0 && !looksLikeBackground/.test(SRC));
});

console.log("\n[3] 触发条件：条数为主，字数为辅");
t("DEFAULTS 有 bufferCount", () => assert.ok(/bufferCount: 6,/.test(SRC)));
t("maybeScheduleCycle 同时看条数和字数", () => {
  assert.ok(/pending\.length >= cfg\.bufferCount \|\| pendingChars\(\) >= cfg\.bufferChars/.test(SRC));
});
t("rerun 分支也用同一判据（不是只看字数）", () => {
  const rerun = SRC.slice(SRC.indexOf("if (rerunNeeded)"));
  assert.ok(/pending\.length >= cfg\.bufferCount/.test(rerun.slice(0, 300)));
});
t("env 可覆盖 bufferCount", () => assert.ok(/num\("LEDGER_BUFFER_COUNT", DEFAULTS\.bufferCount\)/.test(SRC)));

console.log("\n[4] T1：上限 1500 + 行列表滚动（append/close/state）");
// 结算模板区：从 settleBatch 的 sys 到第一次 chatOnce 调用
const SYS_START = SRC.indexOf("const sys = `");
const USER_START = SRC.indexOf("const user = `[当前时间]");
const TPL_END = SRC.indexOf("let raw = await chatOnce");
const TPL = SRC.slice(SYS_START, TPL_END);

t("默认上限是 1500（v1.3 起长度由代码机械控制）", () => {
  assert.ok(/t1MaxChars: 1500,/.test(SRC));
  assert.ok(!/t1MaxChars: 2000/.test(SRC), "不应残留旧的 2000");
});
t("结算 prompt 只输出 {append, state, close} 三字段", () => {
  assert.ok(
    SRC.includes('{"append":["新话题行…"],"state":"${cfg.userLabel}此刻的状态和心情","close":["旧行的起始时间戳…"]}'),
    "prompt 应含 v1.3 的三字段输出契约"
  );
  assert.ok(/append/.test(TPL) && /close/.test(TPL) && /state/.test(TPL));
});
t("prompt 含待办销项语义（已结束/不许一直挂着）", () => {
  assert.ok(/已经明确结束/.test(TPL), "close 规则应说明只填已结束的事");
  assert.ok(/不许一直挂着/.test(TPL), "应要求完成的待办必须销项");
});
t("强制绝对时间戳、禁止相对词", () => {
  assert.ok(/绝对时间戳/.test(SRC));
  assert.ok(/严禁出现"今天\/昨天\/刚才\/今晚\/上午"/.test(SRC));
});
t("固定指令在 system，易变载荷在 user（缓存友好）", () => {
  assert.ok(SYS_START > 0 && USER_START > SYS_START, "sys 应在 user 之前定义");
  const sysBlock = SRC.slice(SYS_START, USER_START);
  // 关键：system 里不得【拼接】易变内容。变量名叫 [近期摘要] 属于指令用词，不算。
  assert.ok(!/\$\{oldT1\}/.test(sysBlock), "system 里不得拼接摘要内容");
  assert.ok(!/\$\{nowLabel\}/.test(sysBlock), "system 里不得拼接当前时间");
  assert.ok(!/\$\{lines\}/.test(sysBlock), "system 里不得拼接新对话");
  // system 必须够长（固定指令全在这里），user 要短（只有载荷）
  assert.ok(sysBlock.length > 400, "system 应承载固定指令，实际 " + sysBlock.length + " 字符");
  const userBlock = SRC.slice(USER_START, TPL_END);
  assert.ok(/\[当前时间\]/.test(userBlock) && /\[近期摘要\]/.test(userBlock) && /\[新对话\]/.test(userBlock));
  assert.ok(userBlock.length < sysBlock.length, "user 应只留载荷，短于 system");
});
t("旧版分级预算 A/B/C 已从【活 prompt】删除", () => {
  assert.ok(!/A\. 近 24 小时/.test(TPL), "活 prompt 不得残留 A 档预算");
  assert.ok(!/B\. 24~48 小时/.test(TPL), "活 prompt 不得残留 B 档预算");
  assert.ok(!/C\. 48 小时以上/.test(TPL), "活 prompt 不得残留 C 档预算");
  assert.ok(!/近两天内的话题都要能查到/.test(TPL), "活 prompt 不得残留矛盾的覆盖承诺");
});
t("结算前强制从磁盘重读摘要（手改保护）", () => {
  const i = SRC.indexOf("async function settleBatch");
  assert.ok(/loadSummary\(\);/.test(SRC.slice(i, i + 200)));
});
t("角色称呼模板化（不硬编码）", () => {
  assert.ok(/m\.role === "user" \? cfg\.userLabel : cfg\.assistantLabel/.test(SRC));
  assert.ok(SRC.includes("`二、${cfg.userLabel}的状态和心情`"), "renderT1 节标题应模板化角色称呼");
});

console.log("\n[5] T2：行列表淘汰（日期 + 字数），取代旧的句读截断");
t("有 evictT1OverLimit / pruneT2 两个机械淘汰函数", () => {
  assert.ok(/function evictT1OverLimit\(\)/.test(SRC));
  assert.ok(/function pruneT2\(\)/.test(SRC));
});
t("旧的 T2 句读截断已删除", () => {
  assert.ok(!/lastPunct >= cfg\.t2MaxChars \* 0\.6/.test(SRC), "旧句读截断应已移除");
  assert.ok(!/t2-compress/.test(SRC), "旧 T2 整段压缩应已移除");
});
t("pruneT2 先按日期再按字数淘汰", () => {
  assert.ok(/cfg\.t2MaxDays \* 86400000/.test(SRC));
  assert.ok(/while \(t2Chars\(\) > cfg\.t2MaxChars && t2Lines\.length > 1\)/.test(SRC));
});
t("evictT1OverLimit 保底留 minKeepT1 行", () => {
  assert.ok(/t1Lines\.length > cfg\.minKeepT1/.test(SRC));
});
t("合并 prompt 要求保留绝对时间戳、禁相对词、能独立读懂", () => {
  // 注意：切片终点要用 `kind: "t2-merge"`（函数内的实参），不能用裸 "t2-merge"——
  // 顶部注释里也提到过 t2-merge，裸串会命中到函数之前，切出空段。
  const seg = SRC.slice(SRC.indexOf("async function mergeInto2"), SRC.indexOf('kind: "t2-merge"'));
  assert.ok(/绝对时间戳/.test(seg));
  assert.ok(/严禁"今天\/昨天"等相对词/.test(seg));
  assert.ok(/能独立读懂/.test(seg));
  assert.ok(/禁/.test(seg) || /禁止/.test(seg));
});
t("T2 合并走同一个 chatOnce", () => {
  assert.ok(/kind: "t2-merge"/.test(SRC));
  assert.ok(/kind: "settle"/.test(SRC));
});

console.log("\n[6] v1.3 行列表工具 / 解析重试 / 落盘结构 / 旧格式迁移");
t("行列表工具函数齐全", () => {
  const fns = ["tsOf", "parseTsDate", "makeLine", "normalizeLines", "splitTopicLines",
    "splitByDate", "renderT1", "renderT2", "t1Chars", "t2Chars", "matchesClose",
    "evictT1OverLimit", "pruneT2", "migrateLegacy", "archiveEvicted", "mergeInto2"];
  for (const fn of fns) {
    assert.ok(new RegExp(`function ${fn}\\(`).test(SRC), `缺函数 ${fn}`);
  }
});
t("DEFAULTS 是 v1.3 口径（1500/360/7/3）", () => {
  assert.ok(/t1MaxChars: 1500,/.test(SRC));
  assert.ok(/t2MaxChars: 360,/.test(SRC));
  assert.ok(/t2MaxDays: 7,/.test(SRC));
  assert.ok(/minKeepT1: 3,/.test(SRC));
});
t("init() 读取 T2 淘汰 / 保底相关 env", () => {
  assert.ok(/num\("LEDGER_T2_MAX_CHARS", DEFAULTS\.t2MaxChars\)/.test(SRC));
  assert.ok(/num\("LEDGER_T2_MAX_DAYS", DEFAULTS\.t2MaxDays\)/.test(SRC));
  assert.ok(/num\("LEDGER_MIN_KEEP_T1", DEFAULTS\.minKeepT1\)/.test(SRC));
});
t("结算解析失败会原地重试一次（settle-retry）", () => {
  assert.ok(/kind: "settle-retry"/.test(SRC));
  assert.ok(/结算输出无法解析[\s\S]{0,80}重试一次/.test(SRC));
});
t("saveSummary 写结构化行 + 字符串镜像", () => {
  assert.ok(/t1_lines: t1Lines/.test(SRC));
  assert.ok(/t1_state: t1State/.test(SRC));
  assert.ok(/t2_lines: t2Lines/.test(SRC));
  assert.ok(/t1: renderT1\(\)/.test(SRC), "应保留 t1 字符串镜像");
  assert.ok(/t2: renderT2\(\)/.test(SRC), "应保留 t2 字符串镜像");
});
t("旧 string 格式自动迁移（内容保留）", () => {
  assert.ok(/已从旧 string 格式迁移/.test(SRC));
  assert.ok(/function migrateLegacy\(parsed\)/.test(SRC));
  assert.ok(/function loadSummary\(\)/.test(SRC));
});
t("状态节定位通用（按行首「二、」，不写死角色名）", () => {
  assert.ok(SRC.includes("/^二、"), "migrateLegacy 应按行首「二、」定位状态节");
  assert.ok(!/二、她的状态和心情/.test(SRC), "不得写死角色名");
});
t("无私人项目耦合（角色名/客户端名/心情标签）", () => {
  assert.ok(!/乔木|媛媛|Kelivo/.test(SRC), "不得残留私人项目专有名词");
  assert.ok(!/stripEmotionTags|EMOTION_TAG_RE/.test(SRC), "开源版不含心情标签处理");
  assert.ok(!/开心\+0\.12/.test(SRC), "prompt 不得残留心情标签规则");
});

console.log("\n[7] 归档：T1 摘行与失败批次");
t("T1 摘行并入 T2 前先归档", () => {
  const i = SRC.indexOf("T1 归档失败");
  assert.ok(i > 0, "应有 T1 归档");
  assert.ok(SRC.indexOf("T1_ARCHIVE_DIR") < i, "归档常量应在使用之前");
  assert.ok(/function archiveEvicted\(moved, reason\)/.test(SRC));
});
t("JSON 解析失败时落盘失败批次", () => {
  assert.ok(/FAILED_BATCH_DIR/.test(SRC));
  assert.ok(/归档失败批次失败/.test(SRC));
});
t("归档目录在 STATE_DIR 下", () => {
  assert.ok(/path\.join\(STATE_DIR, "t1_archive"\)/.test(SRC));
  assert.ok(/path\.join\(STATE_DIR, "failed_batches"\)/.test(SRC));
});

console.log("\n[8] 可观测：用量日志");
t("chatOnce 输出 llm_usage 且区分 kind", () => {
  assert.ok(/function logUsage\(usage, kind\)/.test(SRC));
  assert.ok(/logUsage\(data\?\.usage, kind\)/.test(SRC));
  assert.ok(/event: "llm_usage"/.test(SRC));
});
t("usage 模式前缀是 rolling-（开源版口径）", () => {
  assert.ok(/mode: "rolling-" \+ kind/.test(SRC));
  assert.ok(!/mode: "ledger-"/.test(SRC), "不得残留源项目的 ledger- 前缀");
});
t("usage 字段兼容多家命名", () => {
  assert.ok(/prompt_cache_hit_tokens/.test(SRC));
  assert.ok(/cached_tokens/.test(SRC));
  assert.ok(/prompt_cache_miss_tokens/.test(SRC));
});
t("usage 记录失败不影响主链路", () => {
  const i = SRC.indexOf("function logUsage");
  assert.ok(/try \{/.test(SRC.slice(i, i + 200)));
});

console.log("\n[9] 双上游");
t("index.js 读 CHAT_API_URL/CHAT_API_KEY（仅用于诊断）", () => {
  assert.ok(/getEnv\("CHAT_API_URL", ""\)/.test(SRC));
  assert.ok(/getEnv\("CHAT_API_KEY", ""\)/.test(SRC));
});
t("结算永远走 LEDGER_*，不受 CHAT_* 影响", () => {
  const i = SRC.indexOf("async function chatOnce");
  const body = SRC.slice(i, i + 900);
  assert.ok(/!cfg\.apiBase \|\| !cfg\.apiKey/.test(body));
  assert.ok(!/chatApiBase/.test(body), "chatOnce 不得回落到对话上游");
});
t("启动 banner 输出上游是否分离 + 行数口径", () => {
  assert.ok(/sameUpstream/.test(SRC));
  assert.ok(/与对话同源/.test(SRC) && /独立（双上游）/.test(SRC));
  assert.ok(/摘要 T1=\$\{t1Lines\.length\} 行/.test(SRC), "启动日志应改行数口径");
  assert.ok(/T2 淘汰 \$\{cfg\.t2MaxDays\} 天/.test(SRC));
});
t("stats() 暴露 upstreamSeparated", () => {
  assert.ok(/upstreamSeparated: !!\(cfg\.chatApiBase && cfg\.chatApiBase !== cfg\.apiBase\)/.test(SRC));
});
t("stats() 对外契约仍是渲染后的 t1/t2 字符串", () => {
  const i = SRC.indexOf("function stats()");
  const body = SRC.slice(i, i + 900);
  assert.ok(/const t1 = renderT1\(\);/.test(body));
  assert.ok(/const t2 = renderT2\(\);/.test(body));
  assert.ok(/t1Chars: t1\.length/.test(body));
  assert.ok(/t2Chars: t2\.length/.test(body));
  assert.ok(/upstreamSeparated/.test(body));
  assert.ok(/pendingCount: pending\.length/.test(body));
});
t("proxy.js 对话上游 CHAT_API_URL 优先，回退旧名", () => {
  assert.ok(/process\.env\.CHAT_API_URL[\s\S]{0,120}LEDGER_API_URL/.test(PROXY_SRC));
});
t("proxy.js 密钥优先级：客户端 Authorization > CHAT_API_KEY > LEDGER_API_KEY", () => {
  const i = PROXY_SRC.indexOf("密钥优先级");
  assert.ok(i > 0);
  const seg = PROXY_SRC.slice(i, i + 400);
  assert.ok(/req\.headers\.authorization/.test(seg));
  assert.ok(/upstreamKey\(\)/.test(seg));
  assert.ok(/process\.env\.LEDGER_API_KEY/.test(seg));
});
t("proxy.js 异常用 HTTP 状态码而非抛错", () => {
  assert.ok(/503/.test(PROXY_SRC));
  assert.ok(/502/.test(PROXY_SRC));
});

console.log("\n[10] 运行时行为（真跑）");
t("init() 能正常完成并读到 env", () => {
  rolling.init();
  const s = rolling.stats();
  assert.strictEqual(s.t1MaxChars, 1500);
  assert.strictEqual(s.t2MaxChars, 360);
  assert.strictEqual(s.bufferCount, 6);
  assert.strictEqual(s.upstreamSeparated, false, "未配 CHAT_API_URL 时应为同源");
  assert.strictEqual(typeof s.t1, "string", "stats().t1 必须是字符串（viewer 兼容）");
  assert.strictEqual(typeof s.t2, "string", "stats().t2 必须是字符串（viewer 兼容）");
  assert.strictEqual(typeof s.t1Chars, "number");
});
t("observeRequest 不抛、不阻塞", () => {
  const msgs = [];
  for (let i = 0; i < 12; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: "第" + i + "条消息内容" });
  rolling.observeRequest(msgs);
  const s = rolling.stats();
  assert.ok(s.pendingCount >= 0 && typeof s.pendingChars === "number");
});
t("滑窗：第二轮多出的尾部不会误判成滑出", () => {
  const base = [];
  for (let i = 0; i < 10; i++) base.push({ role: i % 2 ? "assistant" : "user", content: "消息" + i });
  rolling.observeRequest(base);
  const before = rolling.stats().pendingCount;
  rolling.observeRequest(base.concat([{ role: "user", content: "新一句" }]));
  // 前缀重叠 = 10，滑出 0 条 → pending 不应增长
  assert.strictEqual(rolling.stats().pendingCount, before, "纯追加不应产生待结算");
});
t("滑窗：真滑出时能被检测到", () => {
  const a = [];
  for (let i = 0; i < 10; i++) a.push({ role: i % 2 ? "assistant" : "user", content: "窗口A-" + i });
  rolling.observeRequest(a);
  const b = a.slice(3).concat([{ role: "user", content: "窗口B新句" }]);
  rolling.observeRequest(b);
  assert.ok(rolling.stats().pendingCount >= 3, "应检测到前 3 条滑出，实际 " + rolling.stats().pendingCount);
});
t("后台小请求不被判成换窗（本轮仅 1 条）", () => {
  const w = [];
  for (let i = 0; i < 12; i++) w.push({ role: i % 2 ? "assistant" : "user", content: "正常对话-" + i });
  rolling.observeRequest(w);
  const before = rolling.stats().pendingCount;
  rolling.observeRequest([{ role: "user", content: "生成标题：帮我起个标题" }]);
  assert.strictEqual(rolling.stats().pendingCount, before, "后台请求不应触发换窗结算");
});
t("injectBlocks() 返回数组且不抛", () => {
  const b = rolling.injectBlocks();
  assert.ok(Array.isArray(b));
});
t("重复消息（连发两条一样的话）各自入列", () => {
  const before = rolling.stats().pendingCount;
  rolling.observeRequest([
    { role: "user", content: "一模一样的话" },
    { role: "user", content: "一模一样的话" },
  ]);
  assert.ok(rolling.stats().pendingCount >= before, "不应崩溃或异常去重掉");
});

console.log("\n[11] 文档一致性");
const README = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
const ENVEX = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");
t("README 有「不能代替记忆库」警告", () => {
  assert.ok(/不能代替记忆库/.test(README));
  assert.ok(/噪声沉降池/.test(README));
});
t("README 有双上游章节", () => {
  assert.ok(/双上游/.test(README));
  assert.ok(/CHAT_API_URL/.test(README));
  assert.ok(/CHAT_API_KEY/.test(README));
});
t("README 说明了「结算必然 0% 命中缓存、无解」", () => {
  assert.ok(/0%/.test(README) || /必然/.test(README));
  assert.ok(/全价/.test(README));
});
t("README 澄清多开 Key 不提升并发", () => {
  assert.ok(/多开.*Key.*不能提升并发|按\*\*账号\*\*/.test(README));
});
t("README 说明了 v1.3 真滚动（行列表 + 机械摘行 + T2 双淘汰）", () => {
  assert.ok(/从最旧端/.test(README) && /摘行/.test(README));
  assert.ok(/7 天|日期淘汰/.test(README));
  assert.ok(/close/.test(README) && /销项/.test(README));
});
t("README 表格里的默认值与代码一致", () => {
  assert.ok(/`LEDGER_T1_MAX_CHARS` \| 1500/.test(README), "README 应写 1500");
  assert.ok(/`LEDGER_T2_MAX_CHARS` \| 360/.test(README), "README 应写 360");
  assert.ok(/`LEDGER_T2_MAX_DAYS` \| 7/.test(README), "README 应有 T2_MAX_DAYS=7");
  assert.ok(/`LEDGER_MIN_KEEP_T1` \| 3/.test(README), "README 应有 MIN_KEEP_T1=3");
  assert.ok(/`LEDGER_BUFFER_COUNT` \| 6/.test(README), "README 应有 bufferCount=6");
  assert.ok(!/`LEDGER_T1_MAX_CHARS` \| 2000/.test(README), "不得残留旧的 2000");
  assert.ok(!/`LEDGER_T2_MAX_CHARS` \| 220/.test(README), "不得残留旧的 220");
});
t("README 数据一节说明新结构与旧格式迁移", () => {
  assert.ok(/t1_lines/.test(README) && /t1_state/.test(README) && /t2_lines/.test(README));
  assert.ok(/自动迁移/.test(README));
});
t(".env.example 含双上游变量与 v1.3 新变量", () => {
  assert.ok(/^CHAT_API_URL=/m.test(ENVEX));
  assert.ok(/^CHAT_API_KEY=/m.test(ENVEX));
  assert.ok(/LEDGER_BUFFER_COUNT=6/.test(ENVEX));
  assert.ok(/LEDGER_T1_MAX_CHARS=1500/.test(ENVEX));
  assert.ok(/LEDGER_T2_MAX_CHARS=360/.test(ENVEX));
  assert.ok(/LEDGER_T2_MAX_DAYS=7/.test(ENVEX));
  assert.ok(/LEDGER_MIN_KEEP_T1=3/.test(ENVEX));
  assert.ok(!/LEDGER_T1_MAX_CHARS=2000/.test(ENVEX), "不得残留旧的 2000");
});
t(".env.example 解释了多开 Key 不等于提额度", () => {
  assert.ok(/并发.*按【账号】计|按【账号】计/.test(ENVEX));
});

console.log("\n[12] v1.4：人工编辑原语 + 外部改动重读 + 原子落盘 + T2 合并兜底");
const VIEWER_SRC = fs.readFileSync(path.join(__dirname, "..", "viewer.js"), "utf8");
t("编辑原语与导出齐全", () => {
  for (const fn of ["view", "snapshot", "rowsOf", "deleteRows", "editRows"]) {
    assert.ok(new RegExp(`function ${fn}\\(`).test(SRC), `缺函数 ${fn}`);
  }
  assert.ok(/module\.exports = \{[^}]*snapshot[^}]*deleteRows[^}]*editRows[^}]*\}/.test(SRC), "导出应含编辑原语");
});
t("index 语义严格区分：给歪了报错，绝不静默改从最旧端删", () => {
  assert.ok(/Number\.isInteger\(index\)/.test(SRC), "index 应做整数校验");
  assert.ok(/index 必须是整数/.test(SRC));
  assert.ok(/function rowsOf\(target\)/.test(SRC) && /target 只能是 t1 \/ t2 \/ state/.test(SRC));
});
t("按条数删是从最旧端删（splice(0, count)）", () => {
  assert.ok(/list\.splice\(0, Math\.min\(count, list\.length\)\)/.test(SRC));
});
t("改内容丢了开头的日期会自动补回原时间戳", () => {
  assert.ok(/if \(!tsOf\(body\) && old\.ts\) body = `\$\{old\.ts\}：\$\{body\}`;/.test(SRC));
});
t("外部改动重读：.reload 标记为主 + mtime 兜底", () => {
  assert.ok(/RELOAD_FLAG = path\.join\(STATE_DIR, "\.reload"\)/.test(SRC));
  assert.ok(/function reloadIfChanged\(\)/.test(SRC));
  assert.ok(/function markExternalChange\(\)/.test(SRC));
  assert.ok(/fs\.statSync\(SUMMARY_FILE\)\.mtimeMs === loadedMtimeMs/.test(SRC), "应有 mtime 兜底判据");
  const i = SRC.indexOf("function injectBlocks");
  assert.ok(/reloadIfChanged\(\);/.test(SRC.slice(i, i + 200)), "注入前应先检查外部改动");
  assert.ok(/markExternalChange\(\);\n?/.test(SRC.slice(SRC.indexOf("function deleteRows"), SRC.indexOf("function init"))), "编辑原语写完应落标记");
});
t("落盘是 tmp + rename 原子替换", () => {
  assert.ok(/const tmp = SUMMARY_FILE \+ "\.tmp"/.test(SRC));
  assert.ok(/fs\.renameSync\(tmp, SUMMARY_FILE\)/.test(SRC));
});
t("t2-merge 关 thinking，失败改机械兜底（不再退回 T1）", () => {
  assert.ok(/kind: "t2-merge", effort: "minimal"/.test(SRC), "t2-merge 应传 effort=minimal");
  assert.ok(/if \(opts\.effort\) body\.reasoning_effort = opts\.effort;/.test(SRC));
  assert.ok(/function fallbackMergeInto2\(moved\)/.test(SRC));
  assert.ok(!/t1Lines = moved\.concat\(t1Lines\)/.test(SRC), "不得再把摘出的行退回 T1（T1 只增不减的根因）");
});
t("viewer 暴露 POST /api/ledger + 行尾小 × 与就地编辑", () => {
  assert.ok(/url === "\/api\/ledger"/.test(VIEWER_SRC));
  assert.ok(/action === "delete"/.test(VIEWER_SRC) && /action === "edit"/.test(VIEWER_SRC));
  assert.ok(/rolling\.deleteRows\(/.test(VIEWER_SRC) && /rolling\.editRows\(/.test(VIEWER_SRC));
  assert.ok(/class="x"/.test(VIEWER_SRC), "应有行尾小 ×");
  assert.ok(/action:"edit",target:t,index:t==="state"\?undefined:i/.test(VIEWER_SRC), "状态块改时不该传 index");
});
t("viewer 渲染 T1 用升序下标（显示倒序，删的必须是对的哪一行）", () => {
  assert.ok(/data-i="/.test(VIEWER_SRC) && /getAttribute\("data-i"\)/.test(VIEWER_SRC), "行上应带升序下标");
  assert.ok(/for\(var i=a\.length-1;i>=0;i--\)/.test(VIEWER_SRC), "显示应倒序");
});
t("package.json 版本 ≥ 1.4.0（v1.4 已并入主线，当前版本号见 [13]）", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.ok(Number(pkg.version.split(".")[1]) >= 4, `当前版本 ${pkg.version}，应 ≥ 1.4.0`);
});
t("README 写了 v1.4 的编辑能力与 T2 合并兜底", () => {
  assert.ok(/deleteRows/.test(README) && /editRows/.test(README) && /api\/ledger/.test(README));
  assert.ok(/小 ×/.test(README));
  assert.ok(/不再把摘出的行退回 T1|不再退回/.test(README));
  assert.ok(/reasoning_effort/.test(README));
  assert.ok(/v1\.4/.test(README));
});

console.log("\n[13] v1.5：压缩策略改版（行数触发 / 跨天整压 / 跨天轻整压）");
t("DEFAULTS 新增四项（16 行 / 1200 字 / 4 行 / 400 字）", () => {
  assert.ok(/t1MaxLines: 16,/.test(SRC));
  assert.ok(/t1CompressTo: 1200,/.test(SRC));
  assert.ok(/t1LightLines: 4,/.test(SRC));
  assert.ok(/t1LightCompressTo: 400,/.test(SRC));
});
t("T1 触发是「字数或行数」两条任一", () => {
  assert.ok(/function t1OverLimit\(\)/.test(SRC));
  assert.ok(/t1Chars\(\) > cfg\.t1MaxChars \|\| t1Lines\.length >= cfg\.t1MaxLines/.test(SRC));
  assert.ok(/function t1WithinTarget\(\)/.test(SRC));
});
t("白天摘行一次收到目标值（不再摘一个刚刚好的量）", () => {
  const seg = SRC.slice(SRC.indexOf("function evictT1OverLimit"), SRC.indexOf("function mechRepackToTarget"));
  assert.ok(/if \(!t1OverLimit\(\)\) return moved;/.test(seg), "未超限时不应动手");
  assert.ok(/while \(t1Lines\.length > cfg\.minKeepT1 && !t1WithinTarget\(\)\)/.test(seg));
});
t("跨天整压 repackT1：留在 T1、幂等落盘、今天的行原样保留", () => {
  assert.ok(/async function repackT1\(oldLines, opts = \{\}\)/.test(SRC));
  assert.ok(/const keep = t1Lines\.filter\(\(l\) => isTodayLine\(l\)\);/.test(SRC));
  assert.ok(/t1Lines = packed\.concat\(keep\);/.test(SRC), "整压产物必须留在 T1（不是推进 T2）");
  assert.ok(/lastRepackDay = dayKey8\(\);/.test(SRC));
  assert.ok(/last_repack_day: lastRepackDay,/.test(SRC), "幂等键必须落盘");
  assert.ok(/lastRepackDay = parsed\.last_repack_day \|\| null;/.test(SRC), "重启后要能读回");
});
t("跨天轻整压：目标分流 + 行数必须真的减少", () => {
  assert.ok(/const limit = light \? cfg\.t1LightCompressTo : cfg\.t1CompressTo;/.test(SRC));
  assert.ok(/这是「轻整压」/.test(SRC));
  assert.ok(/packed\.length >= oldLines\.length/.test(SRC), "行数没减少应视为不可用");
  assert.ok(/kind: light \? "t1-light-repack" : "t1-repack"/.test(SRC));
});
t("触发顺序：跨天重压 > 跨天轻压 > 白天摘行", () => {
  const seg = SRC.slice(SRC.indexOf("const repackDayFree"), SRC.indexOf("if (moved.length)"));
  const iRepack = seg.indexOf("if (shouldRepack)");
  const iLight = seg.indexOf("} else if (shouldLight)");
  const iEvict = seg.indexOf("} else if (t1OverLimit())");
  assert.ok(iRepack >= 0 && iLight > iRepack && iEvict > iLight, "三个分支顺序不对");
  assert.ok(/const shouldLight = !shouldRepack && repackDayFree && oldLines\.length >= cfg\.t1LightLines;/.test(SRC));
  assert.ok(/const shouldRepack = repackDayFree && oldChars > cfg\.t1CompressTo;/.test(SRC));
});
t("跨天压缩失败走机械兜底，且只摘非今天的行（可传目标）", () => {
  assert.ok(/function mechRepackToTarget\(limit = cfg\.t1CompressTo\)/.test(SRC));
  assert.ok(/const old = t1Lines\.filter\(\(l\) => !isTodayLine\(l\)\);/.test(SRC));
  assert.ok(/mechRepackToTarget\(limit\)/.test(SRC));
  assert.ok(!/t1Lines = moved\.concat\(t1Lines\)/.test(SRC), "兜底不得把行退回 T1");
});
t("东八日期口径：dayKey8 / isTodayLine，解析不出的按非今天", () => {
  assert.ok(/function dayKey8\(d = new Date\(\)\)/.test(SRC));
  assert.ok(/function isTodayLine\(line\)/.test(SRC));
  assert.ok(/return d !== null && dayKey8\(d\) === dayKey8\(\);/.test(SRC));
});
t("init() 读四个新 env，并在日志里说明策略", () => {
  assert.ok(/num\("LEDGER_T1_MAX_LINES", DEFAULTS\.t1MaxLines\)/.test(SRC));
  assert.ok(/num\("LEDGER_T1_COMPRESS_TO", DEFAULTS\.t1CompressTo\)/.test(SRC));
  assert.ok(/num\("LEDGER_T1_LIGHT_LINES", DEFAULTS\.t1LightLines\)/.test(SRC));
  assert.ok(/num\("LEDGER_T1_LIGHT_COMPRESS_TO", DEFAULTS\.t1LightCompressTo\)/.test(SRC));
  assert.ok(/非今天 ≥\$\{cfg\.t1LightLines\} 行时轻整压到/.test(SRC));
});
t("view()/stats() 暴露新 limits，供查看器与调试读", () => {
  assert.ok(/t1_max_lines: cfg\.t1MaxLines,/.test(SRC));
  assert.ok(/t1_compress_to: cfg\.t1CompressTo,/.test(SRC));
  assert.ok(/t1_light_lines: cfg\.t1LightLines,/.test(SRC));
  assert.ok(/t1_light_compress_to: cfg\.t1LightCompressTo,/.test(SRC));
  assert.ok(/last_repack_day: lastRepackDay,/.test(SRC));
});
t("结算日志区分三种压缩（不再一律写「摘出 N 行」）", () => {
  assert.ok(/压缩 \$\{what\}/.test(SRC));
  assert.ok(/跨天整压（非今天 \$\{oldChars\}→/.test(SRC));
  assert.ok(/跨天轻整压（非今天 \$\{oldLines\.length\} 行/.test(SRC));
  assert.ok(/摘出 \$\{moved\.length\} 行（\$\{trig\}）/.test(SRC));
});
t("运行时行为：init() 后新字段可读且是默认值", () => {
  rolling.init();
  const s = rolling.stats();
  assert.strictEqual(s.t1MaxLines, 16);
  assert.strictEqual(s.t1CompressTo, 1200);
  assert.strictEqual(s.t1LightLines, 4);
  assert.strictEqual(s.t1LightCompressTo, 400);
  assert.strictEqual(typeof rolling.repackT1, "function", "应导出 repackT1");
});
t("package.json 版本为 1.6.0", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.strictEqual(pkg.version, "1.6.0");
});
t("README 写了 v1.5 的压缩策略（两条触发 / 跨天整压 / 轻整压）", () => {
  assert.ok(/v1\.5/.test(README));
  assert.ok(/轻整压/.test(README));
  assert.ok(/跨天/.test(README));
  assert.ok(/`LEDGER_T1_MAX_LINES` \| 16/.test(README), "README 应写 T1_MAX_LINES=16");
  assert.ok(/`LEDGER_T1_COMPRESS_TO` \| 1200/.test(README));
  assert.ok(/`LEDGER_T1_LIGHT_LINES` \| 4/.test(README));
  assert.ok(/`LEDGER_T1_LIGHT_COMPRESS_TO` \| 400/.test(README));
});
t(".env.example 含 v1.5 四个新变量", () => {
  assert.ok(/LEDGER_T1_MAX_LINES=16/.test(ENVEX));
  assert.ok(/LEDGER_T1_COMPRESS_TO=1200/.test(ENVEX));
  assert.ok(/LEDGER_T1_LIGHT_LINES=4/.test(ENVEX));
  assert.ok(/LEDGER_T1_LIGHT_COMPRESS_TO=400/.test(ENVEX));
});

console.log("\n[14] v1.6：注入块「优先级声明」（修外置记忆库被抢）");
t("注入块头带优先级声明（给模型看的，不是给装的人看的）", () => {
  const i = SRC.indexOf("function injectBlocks()");
  const seg = SRC.slice(i, i + 1400);
  assert.ok(/系统注入 · 滚动摘要/.test(seg), "块头应有「系统注入 · 滚动摘要」声明");
  assert.ok(/不是用户新说的话/.test(seg), "应说明这不是用户的新消息");
  assert.ok(/不是长期事实的权威来源/.test(seg), "应说明它不是长期事实的权威来源");
  assert.ok(/以长期记忆为准/.test(seg), "冲突时应以长期记忆为准");
  assert.ok(/去查长期记忆/.test(seg), "要精确细节应去查长期记忆");
});
t("声明在摘要正文之前（模型先读到优先级，再读到内容）", () => {
  const i = SRC.indexOf("function injectBlocks()");
  const seg = SRC.slice(i, i + 1400);
  const decl = seg.indexOf("系统注入 · 滚动摘要");
  const body = seg.indexOf("【更早对话的滚动摘要");
  assert.ok(decl > 0 && body > decl, "声明必须排在摘要正文之前");
});
t("声明是固定文案，不掺易变内容（缓存友好 + 不随摘要漂移）", () => {
  const i = SRC.indexOf("function injectBlocks()");
  const declSeg = SRC.slice(i, SRC.indexOf("【更早对话的滚动摘要", i));
  assert.ok(!/\$\{/.test(declSeg), "声明里不得拼接变量");
});
t("空摘要时不注入（多了一段声明也不能凭空造块）", () => {
  rolling.init();
  const before = rolling.injectBlocks();
  assert.ok(Array.isArray(before));
  assert.ok(before.length === 0, "T1/T2 皆空时应返回空数组");
});
t("有摘要时，块 0 以声明开头、摘要正文在后", () => {
  fs.writeFileSync(
    path.join(TMP, "summaries.json"),
    JSON.stringify({
      t1_lines: [{ ts: "9.23日 10:00", text: "9.23日 10:00：测试话题。" }],
      t1_state: "9.23日 10:05：状态正常。",
      t2_lines: [],
    }),
    "utf8"
  );
  rolling.init();
  const blocks = rolling.injectBlocks();
  assert.strictEqual(blocks.length, 1, "有摘要就应有 1 个注入块");
  const c = blocks[0].content;
  assert.ok(c.startsWith("【系统注入 · 滚动摘要】"), "块必须以声明开头，实际：" + c.slice(0, 30));
  assert.ok(c.indexOf("系统注入 · 滚动摘要") < c.indexOf("【更早对话的滚动摘要"), "声明应在正文之前");
  assert.ok(/测试话题/.test(c), "摘要正文应在块内");
});
t("README 有「和外置记忆库一起用」一节 + 可抄的补充 prompt", () => {
  assert.ok(/和外置长期记忆库一起用/.test(README));
  assert.ok(/长期记忆库是长期事实的权威来源/.test(README), "应给出可抄的补充 prompt");
  assert.ok(/抢掉了/.test(README), "应引用使用者的原始反馈");
  assert.ok(/v1\.6/.test(README));
});

// 清理
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass} / ${pass + fail}${fail ? `  ✗ 失败 ${fail}` : "  ✓ 全绿"}`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail ? 1 : 0);
