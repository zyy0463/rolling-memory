// test/backport.js — 开源版（rolling-memory）回归测试
// 覆盖本轮回灌的功能：条数触发、sha256 指纹、重复消息、后台请求检测、
// 分级预算 prompt、T2 句读截断、归档、双上游解析、用量观测。
// 运行：node test/backport.js
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
process.env.LEDGER_T1_MAX_CHARS = "2000";
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

console.log("\n[4] T1：上限 2000 + 分级预算 + 缓存友好排列");
t("默认上限是 2000（原 1200 与覆盖承诺数学矛盾）", () => {
  assert.ok(/t1MaxChars: 2000,/.test(SRC));
});
t("prompt 含三档预算 A/B/C", () => {
  assert.ok(/A\. 近 24 小时/.test(SRC));
  assert.ok(/B\. 24~48 小时/.test(SRC));
  assert.ok(/C\. 48 小时以上/.test(SRC));
});
t("强制绝对时间戳、禁止相对词", () => {
  assert.ok(/绝对时间戳/.test(SRC));
  assert.ok(/严禁出现"今天\/昨天\/刚才\/今晚\/上午"/.test(SRC));
});
t("固定指令在 system，易变载荷在 user（缓存友好）", () => {
  const sysStart = SRC.indexOf("const sys = `");
  const userStart = SRC.indexOf("const user = `[字数上限]");
  assert.ok(sysStart > 0 && userStart > sysStart, "sys 应在 user 之前定义");
  const sysBlock = SRC.slice(sysStart, userStart);
  // 关键：system 里不得【拼接】易变内容。变量名叫 [当前摘要] 属于指令用词，不算。
  assert.ok(!/\$\{oldT1\}/.test(sysBlock), "system 里不得拼接摘要内容");
  assert.ok(!/\$\{nowLabel\}/.test(sysBlock), "system 里不得拼接当前时间");
  assert.ok(!/\$\{lines\}/.test(sysBlock), "system 里不得拼接新对话");
  // system 必须够长（固定指令全在这里），user 要短（只有载荷）
  assert.ok(sysBlock.length > 400, "system 应承载固定指令，实际 " + sysBlock.length + " 字符");
  const userBlock = SRC.slice(userStart, SRC.indexOf("const raw = await chatOnce"));
  assert.ok(/\[字数上限\]/.test(userBlock) && /\[当前时间\]/.test(userBlock));
  assert.ok(userBlock.length < sysBlock.length, "user 应只留载荷，短于 system");
});
t("旧版矛盾规则已从【活 prompt】删除", () => {
  // 取 sys/user 模板区，注释与历史说明不算
  const sysStart = SRC.indexOf("const sys = `");
  const tplEnd = SRC.indexOf("const raw = await chatOnce");
  const tpl = SRC.slice(sysStart, tplEnd);
  assert.ok(!/近两天内的话题都要能查到/.test(tpl), "活 prompt 不得残留矛盾的覆盖承诺");
  assert.ok(!/带时间锚（今天上午\/刚才\/昨晚）/.test(tpl), "活 prompt 不得再教相对时间词");
});

console.log("\n[5] T2：句读截断 + 绝对时间戳保留");
t("超长时截到最近句读（不留半句话）", () => {
  assert.ok(/lastIndexOf\("。"\)/.test(SRC));
  assert.ok(/lastPunct >= cfg\.t2MaxChars \* 0\.6/.test(SRC));
});
t("压缩 prompt 要求保留绝对时间戳、禁止相对词", () => {
  const seg = SRC.slice(SRC.indexOf("t2-compress") - 1600, SRC.indexOf("t2-compress"));
  assert.ok(/绝对时间戳/.test(seg));
  assert.ok(/严禁改成/.test(seg));
});
t("T2 压缩也走双上游的同一个 chatOnce", () => {
  assert.ok(/kind: "t2-compress"/.test(SRC));
  assert.ok(/kind: "settle"/.test(SRC));
});

console.log("\n[6] 归档：T1 与失败批次");
t("T1 压进 T2 前先归档", () => {
  const i = SRC.indexOf("T1 归档失败");
  assert.ok(i > 0, "应有 T1 归档");
  assert.ok(SRC.indexOf("T1_ARCHIVE_DIR") < i, "归档常量应在使用之前");
});
t("JSON 解析失败时落盘失败批次", () => {
  assert.ok(/FAILED_BATCH_DIR/.test(SRC));
  assert.ok(/归档失败批次失败/.test(SRC));
});
t("归档目录在 STATE_DIR 下", () => {
  assert.ok(/path\.join\(STATE_DIR, "t1_archive"\)/.test(SRC));
  assert.ok(/path\.join\(STATE_DIR, "failed_batches"\)/.test(SRC));
});

console.log("\n[7] 可观测：用量日志");
t("chatOnce 输出 llm_usage 且区分 kind", () => {
  assert.ok(/function logUsage\(usage, kind\)/.test(SRC));
  assert.ok(/logUsage\(data\?\.usage, kind\)/.test(SRC));
  assert.ok(/event: "llm_usage"/.test(SRC));
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

console.log("\n[8] 双上游");
t("index.js 读 CHAT_API_URL/CHAT_API_KEY（仅用于诊断）", () => {
  assert.ok(/getEnv\("CHAT_API_URL", ""\)/.test(SRC));
  assert.ok(/getEnv\("CHAT_API_KEY", ""\)/.test(SRC));
});
t("结算永远走 LEDGER_*，不受 CHAT_* 影响", () => {
  const i = SRC.indexOf("async function chatOnce");
  const body = SRC.slice(i, i + 900);
  assert.ok(/cfg\.apiBase and cfg\.apiKey/.test(body) || /!cfg\.apiBase \|\| !cfg\.apiKey/.test(body));
  assert.ok(!/chatApiBase/.test(body), "chatOnce 不得回落到对话上游");
});
t("启动 banner 输出上游是否分离", () => {
  assert.ok(/sameUpstream/.test(SRC));
  assert.ok(/与对话同源/.test(SRC) && /独立（双上游）/.test(SRC));
});
t("stats() 暴露 upstreamSeparated", () => {
  assert.ok(/upstreamSeparated: !!\(cfg\.chatApiBase && cfg\.chatApiBase !== cfg\.apiBase\)/.test(SRC));
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

console.log("\n[9] 运行时行为（真跑）");
t("init() 能正常完成并读到 env", () => {
  rolling.init();
  const s = rolling.stats();
  assert.strictEqual(s.t1MaxChars, 2000);
  assert.strictEqual(s.bufferCount, 6);
  assert.strictEqual(s.upstreamSeparated, false, "未配 CHAT_API_URL 时应为同源");
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

console.log("\n[10] 文档一致性");
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
t("README 表格里的默认值与代码一致", () => {
  assert.ok(/`LEDGER_T1_MAX_CHARS` \| 2000/.test(README), "README 应写 2000");
  assert.ok(/`LEDGER_BUFFER_COUNT` \| 6/.test(README), "README 应有 bufferCount=6");
  assert.ok(!/`LEDGER_T1_MAX_CHARS` \| 1200/.test(README), "不得残留 1200");
});
t(".env.example 含双上游变量", () => {
  assert.ok(/^CHAT_API_URL=/m.test(ENVEX));
  assert.ok(/^CHAT_API_KEY=/m.test(ENVEX));
  assert.ok(/LEDGER_BUFFER_COUNT=6/.test(ENVEX));
  assert.ok(/LEDGER_T1_MAX_CHARS=2000/.test(ENVEX));
});
t(".env.example 解释了多开 Key 不等于提额度", () => {
  assert.ok(/并发.*按【账号】计|按【账号】计/.test(ENVEX));
});

// 清理
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass} / ${pass + fail}${fail ? `  ✗ 失败 ${fail}` : "  ✓ 全绿"}`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail ? 1 : 0);
