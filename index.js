// ============================================================
// rolling-memory/index.js — 两层滚动记忆（v1.3 起是真滚动）
//   Tier1 近期摘要：**有序话题行列表** + 状态节（一条一行，带绝对时间戳）
//   Tier2 远期梗概：**有序梗概行列表**（从 T1 最旧端滚下来的，带日期淘汰）
//
// 三件套接入（详见 README）：
//   rolling.init();
//   rolling.observeRequest(messages);           // 网关每次转发 LLM 前调用
//   rolling.injectBlocks() → [{role, content}]  // 组装消息时追加到末尾
//
// 【v1.3 为什么要改】旧实现是"整段重写 + 攒满清零"，不是滚动：
//   ① 结算每次让模型重写整段 T1（输出贵、内容易漂移）；
//   ② T1 一超限就把整段压成 T2 后清空——近 24h 的细节瞬间塌掉；
//   ③ T2 只有"被重写"一条更新路径，**没有淘汰**，很旧的梗概能一直活到几个月后；
//   ④ 待办只写不核，完成的事没人销项，一直挂着。
// 现在：结算只输出**新增行**（append）+ 已结束旧行的时间戳（close）+ 状态节（state）；
//   超限时从最旧端**机械摘行**（按字数摘到 ≤ 上限），交给一次小调用并入 T2；
//   T2 按**日期（默认 7 天）+ 字数**双淘汰，最旧的直接丢，不再永久保留。
//
// 兼容：summaries.json 仍写 t1/t2 两个**字符串镜像**（renderT1/renderT2 产物），
//   供 viewer.js 与 stats() 直接读；结构化的 t1_lines/t1_state/t2_lines 才是真源。
//   旧的 {t1,t2} 纯字符串格式会在 loadSummary() 里自动迁移，内容不丢。
//
// 【v1.4 人工编辑】新增三个原语：snapshot（只读视图）/ deleteRows（按条数或按行号删）/
//   editRows（改某一行内容）。viewer.js 的行尾小 × 与就地编辑就是调它们。
//   跨进程改动靠 .reload 标记 + mtime 兜底自动重读；落盘改 tmp + rename 原子替换，
//   避免另一个进程读到半截 JSON。
// 【v1.4 修复】T2 合并失败**不再把摘出的行放回 T1**——那正是"T1 只增不减、超限静默常驻"
//   的根因（线上四次 t2-merge 全因 thinking 烧满 max_tokens 返回空 → 行被退回 → 越滚越长）。
//   现在合并调用关掉 thinking（reasoning_effort: minimal），失败改走机械兜底并入。
//
// 【v1.5 压缩策略改版】T1 从"只看一个字数上限"改成"字数或行数两条任一触发"，并区分两种跨天压缩：
//   ① 白天：仍是机械摘行（从最旧端摘到目标字数内并入 T2）；
//   ② 跨天**首次**结算（一天一次，幂等键 last_repack_day 落盘）：
//      · 昨天那部分 > t1CompressTo → 「整压」：整体重压到 t1CompressTo，**结果留在 T1**
//        （保住昨天一整天的脉络，而不是被一行行摘进 T2 后细节掉光）；
//      · 昨天那部分没到 t1CompressTo 但行数 ≥ t1LightLines → 「轻整压」：合并到
//        t1LightCompressTo 留在 T1（主要目的是省行额；产出必须真的比原文行数少，否则视为不可用）。
//   两条路失败都走机械兜底（摘**非今天**的行进 T2），绝不保留原样。
//   新增四个可调项：t1MaxLines / t1CompressTo / t1LightLines / t1LightCompressTo。
//
// 【重要】本模块是"防失忆"的滑动摘要，不是记忆库，也不能代替记忆库。
//   它只保证窗口外近两天的对话还能被衔接上；更早的、需要精确检索的内容
//   请交给专门的外置记忆库。T2 是"噪声沉降池"：它的作用之一就是让远期
//   失效记忆自然滑出，所以不要指望 T2 能长期保留细节。
//
// 铁律：所有失败静默降级（console.log），绝不阻塞/拖慢主对话链路。
// ============================================================
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STATE_DIR = process.env.ROLLING_MEMORY_STATE_DIR || path.join(__dirname, "state");
const SUMMARY_FILE = path.join(STATE_DIR, "summaries.json");
const T1_ARCHIVE_DIR = path.join(STATE_DIR, "t1_archive");
const FAILED_BATCH_DIR = path.join(STATE_DIR, "failed_batches");
// 【v1.4】人工编辑后的"请重读"标记（跨进程：编辑方写完落一个，读取方看到就重读并清掉）
const RELOAD_FLAG = path.join(STATE_DIR, ".reload");
// 滑窗追踪上限。
const TRACK_MAX_MSGS = 120;

const DEFAULTS = {
  enabled: true,
  model: "",                // 结算用模型（必配，任何 OpenAI 兼容模型）
  apiBase: "",              // OpenAI 兼容 chat/completions 地址（必配）
  apiKey: "",               // 必配
  // 双上游支持：结算可以走与对话不同的上游。不带 _API_URL 时回落 LEDGER_/TARGET_ 别名。
  chatApiBase: "",          // 对话上游（仅用于日志/诊断，本模块不主动调它）
  chatApiKey: "",
  bufferCount: 6,           // 缓冲攒够多少"条"触发一次结算（主判据）
  bufferChars: 400,         // 字数兜底：单批超长时即使没到条数也结算（防抖）
  pendingMaxChars: 12000,   // 缓冲上限：结算连续失败时丢最旧，防内存膨胀
  t1MaxChars: 1500,         // T1（话题行 + 状态节）超过则动手压缩（v1.5 起是"两条触发"之一）
  t1MaxLines: 16,           // T1 行数达到这个值也触发压缩（v1.5 新增：短句多的时候只靠字数会拖太久）
  t1CompressTo: 1200,       // 压缩目标：摘行/跨天整压都收到这个字数以内（v1.5 新增）
  t1LightLines: 4,          // 非今天部分达到这么多行 → 跨天「轻整压」（v1.5 新增）
  t1LightCompressTo: 400,   // 轻整压目标：把"行"合并到这个字数内（v1.5 新增，昨天本来就不到 t1CompressTo 时用）
  t2MaxChars: 360,          // T2 封顶（v1.3：220→360，220 字装不下"能独立读懂"的短句，只会逼出电报体）
  t2MaxDays: 7,             // T2 日期淘汰：比这更旧的行直接丢，不再永久保留（v1.3 新增）
  minKeepT1: 3,             // T1 淘汰保底：至少留这么多行，防一次结算把 T1 摘空
  llmTimeoutMs: 60000,
  userLabel: "user",        // 结算摘要里"对方"的称呼
  assistantLabel: "assistant", // 结算摘要里"自己"的称呼
};

let cfg = { ...DEFAULTS };
let normalizeText = (c) => String(typeof c === "string" ? c : JSON.stringify(c ?? ""));
let getEnv = (key, fallback) => process.env[key] || fallback;

// ---- 运行时状态（v1.3：结构化行列表才是真源）----
let t1Lines = [];                  // T1 话题行，**升序**（下标 0 = 最旧），新行 push 到尾部
let t1State = "";                  // T1 第 2 节「状态和心情」，每次结算整体重写，不参与淘汰
let t2Lines = [];                  // T2 梗概行，**升序**，从 T1 最旧端滚下来的
let updatedAt = null;
let summaryState = {};             // 最近一次落盘的完整对象（含 t1/t2 字符串镜像），仅用于观测
let loadedMtimeMs = 0;             // 上次读/写盘时 summaries.json 的 mtime（v1.4：外部改动检测）
let lastRepackDay = null;          // 【v1.5】上次「跨天整压/轻整压」发生在哪一天（东八，形如 2026-9-24），落盘
let lastMsgs = [];        // 上一请求的消息（内存，重启冷启动）
let pending = [];         // 滑出待结算缓冲 [{role, text, fp}]
let pendingFps = new Set();
let busy = false;
let rerunNeeded = false;

const log = (...a) => console.log("[rolling-memory]", ...a);

// 指纹：sha256 取前 16 hex。
// 必须只依赖 (role,text) 的纯函数——重叠检测靠"同一条消息在两轮里指纹相同"，
// 一旦掺入位置/序号这类会随窗口滑动变化的东西，整个滑窗检测就废了。
function fpOf(role, text) {
  return crypto.createHash("sha256").update(role + "\u0000" + text).digest("hex").slice(0, 16);
}

// pending 去重键：fp + 同批内序号。
// 只用 fp 时，"连发两条一模一样的话"第二次会被静默丢弃。
function makeBatchKey(fp, seenCount) {
  return seenCount > 0 ? `${fp}#${seenCount}` : fp;
}

// ========================
// 行列表工具（v1.3）
// ========================
// 行时间戳 = 第一个「：」之前的那截，形如 "9.22日 19:45—20:10" / "9.21日 白天" / "9.20及更早" / "9.11-20"。
// 拿不到就返回 null（该行不参与日期淘汰、也不能被 close 命中）。
function tsOf(text) {
  const t = String(text || "").trim();
  const m = /^(\d{1,2}\.\d{1,2}[^：]{0,20})：/.exec(t);
  if (m) return m[1].trim();
  // 兜底：没有「：」的碎片（迁移时的断句残留）也认开头的日期，否则它逃过日期淘汰
  const m2 = /^(\d{1,2}\.\d{1,2})/.exec(t);
  return m2 ? m2[1] : null;
}

// 行时间戳 → Date（东八区当天 0 点）。解析不出来返回 null。
// 跨年处理：月份比当前月大 1 以上，按上一年算。
function parseTsDate(ts) {
  const m = /(\d{1,2})\.(\d{1,2})/.exec(String(ts || ""));
  if (!m) return null;
  const month = Number(m[1]), day = Number(m[2]);
  if (!month || month > 12 || !day || day > 31) return null;
  const n8 = new Date(Date.now() + 8 * 3600 * 1000);
  let year = n8.getUTCFullYear();
  if (month > n8.getUTCMonth() + 2) year -= 1;
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - 8 * 3600 * 1000);
}

// 【v1.5】东八「今天」的键（形如 2026-9-24）。parseTsDate 返回的是当地 0 点，
// 加 8h 后按 getUTC* 读即回到原年月日，与 tsOf 的解析口径一致。
function dayKey8(d = new Date()) {
  const n8 = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${n8.getUTCFullYear()}-${n8.getUTCMonth() + 1}-${n8.getUTCDate()}`;
}

// 【v1.5】这一行是不是「今天」的。时间戳解析不出来（迁移残留的碎片）按"不是今天"处理——
// 它无法被确认属于今天，就不该享受"今天的行原样保留"的豁免。
function isTodayLine(line) {
  const d = parseTsDate(line && line.ts);
  return d !== null && dayKey8(d) === dayKey8();
}

function makeLine(text) {
  const t = String(text || "").trim();
  return t ? { ts: tsOf(t), text: t } : null;
}

function normalizeLines(arr) {
  const out = [];
  for (const it of Array.isArray(arr) ? arr : []) {
    const l = makeLine(typeof it === "string" ? it : (it && it.text) || "");
    if (l) out.push(l);
  }
  return out;
}

// 把一整段（含模型自己插的换行）切成话题行：以日期开头的行是新行，其余续行并回上一条。
// 背景：模型偶尔会在话题中间换行（"才爽完又\n催我"），纯按 \n 拆会把一条话题拆成两半。
function splitTopicLines(text) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (/^[一二三四五六]、/.test(l)) continue;              // 节标题
    if (/^\d{1,2}\.\d{1,2}/.test(l) || out.length === 0) out.push(l);
    else out[out.length - 1] += l;
  }
  return out.map((t) => ({ ts: tsOf(t), text: t }));
}

// T2 是一整段（无换行），按日期起点切：每个 "M.D" 之前断开；不以日期开头的碎片并回上一条。
function splitByDate(text) {
  const s = String(text || "").trim();
  if (!s) return [];
  const parts = s.split(/(?=\d{1,2}\.\d{1,2})/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    // 只有"日期 + 冒号"才算新行；否则是上一句的断句残留（如"9.22暴风后收菜。"），并回上一条
    if (/^\d{1,2}\.\d{1,2}[^：]{0,20}：/.test(p) || out.length === 0) out.push({ ts: tsOf(p), text: p });
    else out[out.length - 1].text += p;
  }
  return out;
}

// 渲染：T1 保持"最新在前"（与原样式一致），T2 按升序（越往下越新）
function renderT1() {
  const out = [];
  if (t1Lines.length) {
    out.push("一、聊了什么");
    for (let i = t1Lines.length - 1; i >= 0; i--) out.push(t1Lines[i].text);
  }
  if (t1State) { out.push(`二、${cfg.userLabel}的状态和心情`); out.push(t1State); }
  return out.join("\n");
}
function renderT2() { return t2Lines.map((l) => l.text).join("\n"); }

function t1Chars() {
  return t1Lines.reduce((s, l) => s + l.text.length, 0) + (t1State ? t1State.length : 0);
}
function t2Chars() { return t2Lines.reduce((s, l) => s + l.text.length, 0); }

// close 命中：忽略空白后按前缀互相比（模型给的 "9.22日 19:45" 要能命中行的 "9.22日 19:45—20:10"）
function matchesClose(line, closeList) {
  const norm = (s) => String(s || "").replace(/\s+/g, "");
  const t = norm(line.ts);
  if (!t) return false;
  return (closeList || []).some((c) => {
    const k = norm(c);
    return k && (t.startsWith(k) || k.startsWith(t));
  });
}

// 【v1.5】是否该压缩 T1：字数超 t1MaxChars **或** 行数达 t1MaxLines（两条任一即触发）。
function t1OverLimit() {
  return t1Chars() > cfg.t1MaxChars || t1Lines.length >= cfg.t1MaxLines;
}

// 【v1.5】是否已经压到位：字数 ≤ t1CompressTo **且** 行数 < t1MaxLines。
// 两个条件都要（只看字数的话，16 行短句凑到 900 字仍会因行数触发出手）。
function t1WithinTarget() {
  return t1Chars() <= cfg.t1CompressTo && t1Lines.length < cfg.t1MaxLines;
}

// 超限淘汰（白天那条路）：从最旧端摘行，摘到「既 ≤ t1CompressTo 又 < t1MaxLines」为止
// （保底留 minKeepT1 行）。v1.5 之前是摘到 ≤ t1MaxChars，一次只挪一个"刚刚好"的量，
// 结果每来一条新行就又超限、又摘一次；现在一次收到目标值，少折腾。
function evictT1OverLimit() {
  const moved = [];
  if (!t1OverLimit()) return moved;
  while (t1Lines.length > cfg.minKeepT1 && !t1WithinTarget()) {
    moved.push(t1Lines.shift());
  }
  return moved;
}

// 【v1.5】跨天压缩失败时的机械兜底：从最旧端摘**非今天**的行，直到这部分 ≤ limit。
// 为什么只摘非今天的行：跨天压缩的语义就是"昨天的整体收敛、今天的原样保留"，
// 兜底也不能把今天的行摘掉（否则一天的连续性当场断）。保底同样留 minKeepT1 行。
function mechRepackToTarget(limit = cfg.t1CompressTo) {
  const moved = [];
  for (;;) {
    if (t1Lines.length <= cfg.minKeepT1) break;
    const old = t1Lines.filter((l) => !isTodayLine(l));
    if (!old.length) break;
    const chars = old.reduce((s, l) => s + l.text.length, 0);
    if (chars <= limit) break;
    moved.push(t1Lines.splice(t1Lines.indexOf(old[0]), 1)[0]);
  }
  return moved;
}

// T2 双淘汰：先按日期丢过期行，再按字数丢最旧行
function pruneT2() {
  const cutoff = Date.now() - cfg.t2MaxDays * 86400000;
  const kept = t2Lines.filter((l) => {
    const d = parseTsDate(l.ts);
    return d === null ? true : d.getTime() >= cutoff;
  });
  const byAge = t2Lines.length - kept.length;
  t2Lines = kept;
  let byChars = 0;
  while (t2Chars() > cfg.t2MaxChars && t2Lines.length > 1) { t2Lines.shift(); byChars++; }
  if (byAge || byChars) {
    log(`T2 淘汰：日期过期 ${byAge} 条 / 超字数 ${byChars} 条，余 ${t2Lines.length} 条 ${t2Chars()} 字`);
  }
}

// 旧 string 格式（{t1,t2} 两个大字符串）→ 行列表。保留全部内容，只做结构转换。
// 状态节的定位是**通用**的：找第一个以「二、」开头的行（标题文案随 userLabel 变化，不能写死）。
function migrateLegacy(parsed) {
  const t1str = String(parsed.t1 || "");
  const t2str = String(parsed.t2 || "").replace(/^\[更早梗概\]/, "");
  let state = "";
  let topicsPart = t1str;
  const m = /^二、.*$/m.exec(t1str);
  if (m) {
    topicsPart = t1str.slice(0, m.index);
    state = t1str.slice(m.index + m[0].length).trim();
  }
  // 原文件是"最新在前"，转成升序
  const t1 = splitTopicLines(topicsPart).reverse();
  return { t1_lines: t1, t1_state: state, t2_lines: splitByDate(t2str) };
}

function touchMtime() {
  try { loadedMtimeMs = fs.statSync(SUMMARY_FILE).mtimeMs; } catch { loadedMtimeMs = 0; }
}

function loadSummary() {
  try {
    if (!fs.existsSync(SUMMARY_FILE)) { loadedMtimeMs = 0; return; }
    const parsed = JSON.parse(fs.readFileSync(SUMMARY_FILE, "utf8"));
    if (Array.isArray(parsed.t1_lines) || Array.isArray(parsed.t2_lines)) {
      t1Lines = normalizeLines(parsed.t1_lines);
      t2Lines = normalizeLines(parsed.t2_lines);
      t1State = String(parsed.t1_state || "");
      updatedAt = parsed.updated_at || null;
      lastRepackDay = parsed.last_repack_day || null; // 【v1.5】
      summaryState = parsed;
    } else {
      // 【v1.3 迁移】旧格式一次性转结构，立刻落盘（不压缩、不清空，内容全保留）
      const mig = migrateLegacy(parsed);
      t1Lines = mig.t1_lines;
      t1State = mig.t1_state;
      t2Lines = mig.t2_lines;
      updatedAt = parsed.updated_at || null;
      log(`已从旧 string 格式迁移：T1 ${t1Lines.length} 条 / T2 ${t2Lines.length} 条（内容保留，未压缩）`);
      saveSummary();
    }
    touchMtime();
  } catch (e) {
    log("摘要文件读取失败，用空状态启动:", e.message);
  }
}

// 【v1.4】外部改动自动重读：viewer（另一个进程）直接改 summaries.json 后，
// 本进程内存里还是旧态 → 注入的仍是旧的。三条判据按可靠性排序：
//   ① 标记文件（可靠）：编辑原语写完顺手落一个 .reload，读到就重读并清掉；
//   ② mtime（兜底）：手工在服务器上直接改文件（不经接口）也能被捞到；
//   ③ 结算前 loadSummary()：兜住"刚好卡在重读之前"的窗口。
// 为什么不能只靠 mtime：NTFS/Node 的 mtimeMs 只有 ~1ms 粒度，同一毫秒内的两次写入
// 时间戳完全相同（实测过），"改完立刻读"会静默读到旧态——正是这个功能最常走的路径。
function reloadIfChanged() {
  try {
    if (fs.existsSync(RELOAD_FLAG)) {
      try { fs.unlinkSync(RELOAD_FLAG); } catch { /* 清不掉也无妨，下次再试 */ }
      log("检测到外部改动标记，重读摘要");
      loadSummary();
      return true;
    }
    if (!fs.existsSync(SUMMARY_FILE)) return false;
    if (fs.statSync(SUMMARY_FILE).mtimeMs === loadedMtimeMs) return false;
    log("检测到 summaries.json 的 mtime 变化，重读摘要");
    loadSummary();
    return true;
  } catch (e) {
    log("外部改动重读失败(忽略):", e.message);
    return false;
  }
}

function markExternalChange() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(RELOAD_FLAG, String(Date.now()));
  } catch (e) { log("写重读标记失败(忽略):", e.message); }
}

function saveSummary() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // 字符串镜像 t1/t2 供 viewer.js 与 stats() 直接读，格式与旧版一致
    summaryState = {
      t1_lines: t1Lines,
      t1_state: t1State,
      t2_lines: t2Lines,
      t1: renderT1(),
      t2: renderT2(),
      last_repack_day: lastRepackDay, // 【v1.5】跨天压缩的幂等键，必须落盘（否则重启后会重复压、烧钱）
      updated_at: updatedAt,
    };
    // 【v1.4】改成 tmp + rename 原子替换：viewer 与本进程都可能改这个文件，
    // 直接 writeFileSync 有被另一个进程读到半截 JSON 的风险（读到就静默回旧态）。
    const tmp = SUMMARY_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(summaryState, null, 1));
    fs.renameSync(tmp, SUMMARY_FILE);
    touchMtime();
  } catch (e) { log("摘要保存失败(忽略):", e.message); }
}

// ========================
// 人工编辑原语（v1.4）
//   需求：「滚动记忆做个接口，能按条数删，还能改具体内容」+ 查看器每行一个小 ×。
//   调用方：viewer.js 的 POST /api/ledger（也可以由使用者自己的面板/网关直接 require 调用），
//   改的就是真源 summaries.json。
//   下标语义：一律**升序**（0 = 最旧），与内部存储一致；T1 渲染时「最新在前」是显示层的事，
//   调用方要自己翻，否则删错行。
//   改完立刻落盘（原子替换）；另一个进程靠 reloadIfChanged() 自动重读，不需要通知。
// ========================
function view() {
  return {
    t1: renderT1(),
    t2: renderT2(),
    t1_lines: t1Lines.map((l) => ({ ts: l.ts, text: l.text })),
    t2_lines: t2Lines.map((l) => ({ ts: l.ts, text: l.text })),
    t1_state: t1State,
    t1_chars: t1Chars(),
    t2_chars: t2Chars(),
    last_repack_day: lastRepackDay, // 【v1.5】
    limits: {
      t1_max_chars: cfg.t1MaxChars,
      t1_max_lines: cfg.t1MaxLines,               // 【v1.5】
      t1_compress_to: cfg.t1CompressTo,           // 【v1.5】
      t1_light_lines: cfg.t1LightLines,           // 【v1.5】
      t1_light_compress_to: cfg.t1LightCompressTo, // 【v1.5】
      t2_max_chars: cfg.t2MaxChars,
      t2_max_days: cfg.t2MaxDays,
    },
    updated_at: updatedAt,
  };
}

// 只读快照：先重读磁盘（另一个进程可能刚改过），再回视图
function snapshot() {
  loadSummary();
  return view();
}

function rowsOf(target) {
  const t = String(target || "t1").trim().toLowerCase();
  if (t === "t1") return t1Lines;
  if (t === "t2") return t2Lines;
  if (t === "state") return null;
  throw new Error("target 只能是 t1 / t2 / state");
}

// 删：给了 index 删那一行（查看器的小 × 走这条）；没给就按 count 从**最旧端**删（默认 1 条）。
function deleteRows(target, opts = {}) {
  loadSummary();
  const t = String(target || "t1").trim().toLowerCase();
  // index 是"删哪一行"，与"从最旧端删几条"必须严格区分：给了但给歪了（"abc"）要报错，
  // 绝不能落进 count 分支去删最旧的行——那是静默删错。
  const hasIndex = opts.index !== undefined && opts.index !== null && opts.index !== "";
  const index = hasIndex ? Number(opts.index) : null;
  if (index !== null && !Number.isInteger(index)) throw new Error(`index 必须是整数（收到 ${JSON.stringify(opts.index)}）`);
  const count = Math.max(1, Math.min(Number(opts.count) || 1, 999));
  let removed = [];
  if (t === "state") {
    if (!t1State) throw new Error(`「${cfg.userLabel}的状态和心情」本来就是空的`);
    removed = [t1State];
    t1State = "";
  } else {
    const list = rowsOf(t);
    if (!list.length) throw new Error(`${t.toUpperCase()} 没有可删的行`);
    if (index !== null) {
      if (index < 0 || index >= list.length) throw new Error(`行号 ${index} 超出范围（共 ${list.length} 行，下标从 0 起）`);
      removed = list.splice(index, 1);
    } else {
      removed = list.splice(0, Math.min(count, list.length));
    }
  }
  updatedAt = new Date().toISOString();
  saveSummary();
  markExternalChange(); // 通知另一个进程重读（它的内存态靠这个才知道变了）
  log(`人工删除：${t} ${removed.length} 条 → ${removed.map((r) => (typeof r === "string" ? r : r.text)).join(" | ").slice(0, 120)}`);
  return view();
}

// 改：整条替换。行内不换行（一行一条话题）；若改完丢了开头的日期，用原时间戳补回去——
// 时间戳是 tsOf() 从正文现算的，丢了这行就再匹配不上 close、也逃过 T2 日期淘汰。
function editRows(target, index, text) {
  loadSummary();
  const t = String(target || "t1").trim().toLowerCase();
  let body = String(text == null ? "" : text).trim().replace(/\s*\n+\s*/g, " ");
  if (!body) throw new Error("内容不能为空（想删就用小 ×）");
  if (t === "state") {
    t1State = body;
  } else {
    const list = rowsOf(t);
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new Error(`行号 ${index} 超出范围（共 ${list.length} 行，下标从 0 起）`);
    const old = list[i];
    if (!tsOf(body) && old.ts) body = `${old.ts}：${body}`;
    list[i] = makeLine(body);
  }
  updatedAt = new Date().toISOString();
  saveSummary();
  markExternalChange();
  log(`人工编辑：${t}${index == null ? "" : "[" + index + "]"} → ${body.slice(0, 120)}`);
  return view();
}

// ========================
// 初始化（网关启动时调用一次）
// ========================
function init(opts = {}) {
  if (typeof opts.normalizeText === "function") normalizeText = opts.normalizeText;
  if (typeof opts.getEnv === "function") getEnv = opts.getEnv;
  const num = (key, dft) => {
    const v = Number(getEnv(key, ""));
    return Number.isFinite(v) && v > 0 ? v : dft;
  };
  cfg = {
    ...DEFAULTS,
    enabled: String(getEnv("LEDGER_ENABLED", "true")).trim().toLowerCase() !== "false",
    // TARGET_API_URL/TARGET_API_KEY 为兼容别名，方便已有网关直接套用
    apiBase: getEnv("LEDGER_API_URL", "") || getEnv("TARGET_API_URL", ""),
    apiKey: getEnv("LEDGER_API_KEY", "") || getEnv("TARGET_API_KEY", ""),
    model: getEnv("LEDGER_MODEL", ""),
    // 对话上游（只读，用于双上游诊断输出；本模块不调用）
    chatApiBase: getEnv("CHAT_API_URL", ""),
    chatApiKey: getEnv("CHAT_API_KEY", ""),
    bufferCount: num("LEDGER_BUFFER_COUNT", DEFAULTS.bufferCount),
    bufferChars: num("LEDGER_BUFFER_CHARS", DEFAULTS.bufferChars),
    pendingMaxChars: num("LEDGER_PENDING_MAX_CHARS", DEFAULTS.pendingMaxChars),
    t1MaxChars: num("LEDGER_T1_MAX_CHARS", DEFAULTS.t1MaxChars),
    // 【v1.5】T1 压缩策略四项：行数触发 + 压缩目标 + 跨天轻整压的两项
    t1MaxLines: num("LEDGER_T1_MAX_LINES", DEFAULTS.t1MaxLines),
    t1CompressTo: num("LEDGER_T1_COMPRESS_TO", DEFAULTS.t1CompressTo),
    t1LightLines: num("LEDGER_T1_LIGHT_LINES", DEFAULTS.t1LightLines),
    t1LightCompressTo: num("LEDGER_T1_LIGHT_COMPRESS_TO", DEFAULTS.t1LightCompressTo),
    // 以下三项 DEFAULTS 里有定义、旧版 init() 却漏读，导致 .env 配了也不生效。v1.3 补齐。
    t2MaxChars: num("LEDGER_T2_MAX_CHARS", DEFAULTS.t2MaxChars),
    t2MaxDays: num("LEDGER_T2_MAX_DAYS", DEFAULTS.t2MaxDays),
    minKeepT1: num("LEDGER_MIN_KEEP_T1", DEFAULTS.minKeepT1),
    llmTimeoutMs: num("LEDGER_LLM_TIMEOUT_MS", DEFAULTS.llmTimeoutMs),
    userLabel: getEnv("LEDGER_USER_LABEL", DEFAULTS.userLabel),
    assistantLabel: getEnv("LEDGER_ASSISTANT_LABEL", DEFAULTS.assistantLabel),
  };
  // 【v1.5】压缩目标不得高于触发线：t1CompressTo 配得比 t1MaxChars 大时，
  // "摘到目标内"永远摘不到（摘完仍超限），会变成每轮都摘一次却始终超限的静默故障。
  // 默认值本身是自洽的（1200 < 1500），这里只是防手配歪。
  if (cfg.t1CompressTo > cfg.t1MaxChars) cfg.t1CompressTo = cfg.t1MaxChars;
  loadSummary();
  const sameUpstream = !cfg.chatApiBase || cfg.chatApiBase === cfg.apiBase;
  log(
    `已初始化（结算 model=${cfg.model || "未配置"}，T1 压到 ${cfg.t1CompressTo} 字（超 ${cfg.t1MaxChars} 字或 ${cfg.t1MaxLines} 行触发），` +
    `非今天 ≥${cfg.t1LightLines} 行时轻整压到 ${cfg.t1LightCompressTo} 字，` +
    `摘要 T1=${t1Lines.length} 行/${t1Chars()} 字 / T2=${t2Lines.length} 行/${t2Chars()} 字，T2 淘汰 ${cfg.t2MaxDays} 天，` +
    `触发=${cfg.bufferCount} 条/${cfg.bufferChars} 字，上游=${sameUpstream ? "与对话同源" : "独立（双上游）"}）`
  );
}

// ========================
// 请求观察：滑窗检测 → 缓冲
// messages: 客户端实际发给 LLM 的消息数组（system/tool 消息自动跳过）
// ========================
function observeRequest(messages) {
  if (!cfg.enabled) return;
  try {
    const cur = [];
    for (const m of messages || []) {
      if (!m || m.role === "system" || m.role === "developer" || m.role === "tool") continue;
      const text = normalizeText(m.content).trim();
      if (!text) continue;
      cur.push({ role: m.role, text, fp: fpOf(m.role, text) });
    }

    // 指纹重叠：cur 的前缀 == 上一请求的后缀 → 重叠部分之外的前段就是滑出的
    const curFps = cur.map((m) => m.fp);
    let overlap = 0;
    const prevFps = lastMsgs.map((m) => m.fp);
    if (prevFps.length) {
      const maxK = Math.min(prevFps.length, curFps.length);
      for (let k = maxK; k > 0; k--) {
        let ok = true;
        for (let i = 0; i < k; i++) {
          if (prevFps[prevFps.length - k + i] !== curFps[i]) { ok = false; break; }
        }
        if (ok) { overlap = k; break; }
      }
    }

    // 【2026-09-20】后台小请求判断（旧版注释承诺但代码缺失，且判据方向是错的）。
    // 病症：标题生成这类后台小请求与上一轮无一重合时，会被直接判成换窗，
    //      把上一轮全部消息倒进 pending 并可能立刻触发结算 → 摘要被污染。
    // 判据经真实日志实测校正：后台请求的特征是【本轮极少】
    //   （实测 title 生成请求 total=1，正常对话 total=17~24），
    // 而不是旧注释写的"上轮 <6 条"——那样写实战里永远不成立，等于没修。
    const BG_CUR_MAX = 3;
    const looksLikeBackground =
      prevFps.length > 0 && cur.length > 0 && cur.length <= BG_CUR_MAX && overlap === 0;
    const isNewWindow = prevFps.length > 0 && overlap === 0 && !looksLikeBackground;

    if (looksLikeBackground) {
      log(`检测到后台小请求（本轮仅 ${cur.length} 条、与上轮无重合），跳过换窗处理`);
    }

    if (isNewWindow) {
      // 换窗：旧会话整体消失。已滑出攒在 pending 的部分先结算，
      // 最后一轮消息（还没机会滑出就换窗了）也并入缓冲，保住尾巴。
      addPendingBatch(lastMsgs);
      if (pendingChars() > 0) scheduleCycle("window-flush");
    } else if (overlap > 0) {
      addPendingBatch(lastMsgs.slice(0, lastMsgs.length - overlap));
    }

    maybeScheduleCycle();

    // 截断隐患显式化：当前小窗口下冗余，但若客户端窗口放大，
    // 这里会静默切成后半段并破坏「前缀匹配」前提，且换窗时被截掉的部分永久丢失。
    if (cur.length > TRACK_MAX_MSGS) {
      log(`注意：本轮消息 ${cur.length} 条超过追踪上限 ${TRACK_MAX_MSGS}，已截断（换窗时前段会丢）`);
    }
    lastMsgs = cur.slice(-TRACK_MAX_MSGS);
  } catch (e) {
    log("观察失败(忽略):", e.message);
  }
}

function pendingChars() {
  return pending.reduce((s, m) => s + m.text.length, 0);
}

function addPendingBatch(list) {
  const seen = new Map();
  for (const m of list) {
    const n = seen.get(m.fp) || 0;
    seen.set(m.fp, n + 1);
    addPending({ ...m, key: makeBatchKey(m.fp, n) });
  }
}

function addPending(m) {
  // 内容完全相同的重复消息各自入列（用 fp#n 区分），
  // 但同一轮的重复观察仍只进一次（seenCount 由调用方按本轮出现次序给出）。
  const key = m.key || m.fp;
  if (pendingFps.has(key)) return;
  pending.push({ role: m.role, text: m.text, fp: m.fp, key });
  pendingFps.add(key);
  // 上限保护：结算一直失败时丢最旧，防缓冲无限膨胀
  while (pendingChars() > cfg.pendingMaxChars && pending.length) {
    const dropped = pending.shift();
    pendingFps.delete(dropped.key || dropped.fp);
  }
}

function maybeScheduleCycle() {
  // 条数为主（bufferCount），字数只作超长兜底（bufferChars）
  if (pending.length >= cfg.bufferCount || pendingChars() >= cfg.bufferChars) scheduleCycle("threshold");
}

function scheduleCycle(reason) {
  if (busy) { rerunNeeded = true; return; }
  busy = true;
  setImmediate(() => {
    runCycle(reason).catch((e) => log("结算异常(忽略):", e.message));
  });
}

async function runCycle(reason) {
  const batch = pending;
  pending = [];
  pendingFps = new Set();
  try {
    await settleBatch(batch, reason);
  } catch (e) {
    log(`结算失败（${e.message}），消息重新排队`);
    for (const m of batch.slice().reverse()) pending.unshift(m);
    for (const m of batch) pendingFps.add(m.key || m.fp);
    while (pendingChars() > cfg.pendingMaxChars && pending.length) {
      const dropped = pending.shift();
      pendingFps.delete(dropped.key || dropped.fp);
    }
  }
  busy = false;
  if (rerunNeeded) {
    rerunNeeded = false;
    if (pending.length >= cfg.bufferCount || pendingChars() >= cfg.bufferChars) scheduleCycle("rerun");
  }
}

// ========================
// 结算（v1.3 行列表版）：一次 LLM 调用产出 {append, state, close}
//   ① append：本批新话题行，push 进 T1 尾部（升序）
//   ② close ：[近期摘要]里**已结束**的旧行时间戳，按 ts 前缀删行（待办销项）
//   ③ state ：第 2 节整体重写（短，不参与淘汰）
//   ④ T1 超限 → 从最旧端机械摘行 → 一次小调用并入 T2（不再整段重写/清空）
//   ⑤ T2 双淘汰：日期过期（t2MaxDays）+ 超字数
// 结算前强制从磁盘重读摘要：外部手改 T1/T2 不会被内存旧态覆盖。
// ========================
async function settleBatch(batch, reason) {
  if (!batch.length) return;
  loadSummary(); // 手改保护
  const lines = batch
    .map((m) => `${m.role === "user" ? cfg.userLabel : cfg.assistantLabel}：${m.text.slice(0, 400)}`)
    .join("\n");
  const t1Text = renderT1() || "（暂无，这是本会话第一批）";
  // 东八区当前时刻（结算锚点）
  const n8 = new Date(Date.now() + 8 * 3600 * 1000);
  const nowLabel = `${n8.getUTCFullYear()}年${n8.getUTCMonth() + 1}月${n8.getUTCDate()}日 ${String(n8.getUTCHours()).padStart(2, "0")}:${String(n8.getUTCMinutes()).padStart(2, "0")}`;

  // 【2026-09-20 缓存优化】固定指令全进 system（静态、可命中前缀缓存），user 只留易变载荷。
  // 【v1.3】模型只输出**新增行**（不再重写整段 T1）→ 输出 token 大幅下降，
  //   且不再有"重写导致旧内容漂移/丢失"的问题。旧版的分级预算（A/B/C 档）那套规则随之删除——
  //   长度控制改由代码机械摘行（evictT1OverLimit），模型可以放心把每条写足。
  const sys = `你是记忆压缩器。只输出严格 JSON，不要任何解释或代码块围栏。

任务：把[新对话]里值得留下的内容写成新话题行，并标出[近期摘要]里已经结束的旧行。

输出 JSON：
{"append":["新话题行…"],"state":"${cfg.userLabel}此刻的状态和心情","close":["旧行的起始时间戳…"]}

规则：
1. append：每条一行，开头必须是绝对时间戳（格式如 9.23日 09:10；按[当前时间]回推换算相对时间词），严禁出现"今天/昨天/刚才/今晚/上午"等相对词。一行一个话题，行内不要换行。关键动作、原话、数字量词（"第五轮""气过两回""九点半"）都要写足，每条 40~90 字。约定、待办、没聊完的话头也写成话题行。没有值得记的新内容就输出空数组。
2. 不要重复[近期摘要]里已经写过的事——只有真的新发生、有新进展才开新行。
3. close：只填[近期摘要]里**已经明确结束**的事（待办做完了、约定履行了、话题有结论了），填那一行的起始时间戳（照抄[近期摘要]里该行开头的时间戳，如 9.22日 19:45）。没结束的不要填，拿不准就不填。待办一旦完成必须 close 掉，不许一直挂着。
4. state：只留最新——体力、情绪、正在忙什么（有没有不舒服、在学习还是在玩、心情如何），开头带检查时刻的时间戳。`;

  const user = `[当前时间] ${nowLabel}

[近期摘要]
${t1Text}

[新对话]
${lines.slice(0, 6000)}`;

  let raw = await chatOnce(sys, user, { forceJson: true, kind: "settle" });
  let parsed = extractJson(raw);
  if (!parsed) {
    // 【v1.3】解析失败与上游故障性质不同：这批消息最可能就此永久消失（runCycle 已清空 pending，
    // 返回值被忽略）。先原地重试一次（同样的输入，成本可接受），仍失败才归档落盘。
    log(`结算输出无法解析（${reason}），重试一次…`);
    try {
      raw = await chatOnce(sys, user, { forceJson: true, kind: "settle-retry" });
      parsed = extractJson(raw);
    } catch (e) { log("结算重试失败:", e.message); }
  }
  if (!parsed) {
    try {
      fs.mkdirSync(FAILED_BATCH_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(FAILED_BATCH_DIR, `${Date.now()}.json`),
        JSON.stringify({ reason, raw: String(raw).slice(0, 4000), batch }, null, 1)
      );
    } catch (e2) { log("归档失败批次失败(忽略):", e2.message); }
    log(`结算输出无法解析（${reason}），重试后仍失败，原文已归档到 failed_batches（${batch.length} 条消息）`);
    return;
  }

  // ① append：新话题行直接进 T1 尾部
  const appended = normalizeLines(parsed.append);
  for (const l of appended) t1Lines.push(l);

  // ② close：待办销项 / 已结束话题删行
  const closeList = (Array.isArray(parsed.close) ? parsed.close : []).map((c) => String(c || "").trim()).filter(Boolean);
  let closed = 0;
  if (closeList.length) {
    const before = t1Lines.length;
    t1Lines = t1Lines.filter((l) => !matchesClose(l, closeList));
    closed = before - t1Lines.length;
    if (closed) log(`已销项 ${closed} 行（close: ${closeList.join(" / ")}）`);
    else log(`close 未命中任何行（close: ${closeList.join(" / ")}）`);
  }

  // ③ state：整体重写
  const newState = String(parsed.state || "").trim();
  if (newState) t1State = newState;

  updatedAt = new Date().toISOString();
  saveSummary(); // 先落盘：即便下面的 T2 合并失败，append/close 也不丢

  // ④ T1 压缩：**跨天整压优先**——新的一天第一次结算，把「非今天」的行整体压到 ≤t1CompressTo
  //    留在 T1（保住昨天一整天的脉络 + 今天照常累积）。一天只做一次（lastRepackDay 幂等）。
  //    这里**不看超限**：若只看超限，昨天攒到 1600 字（没到 2000）就永远等不到整压，
  //    只会在白天被一行行摘进 T2——那正是"一整天连续性丢掉"的根。非今天部分已经比目标还短
  //    时不重压，免得白花一次调用；但行数 ≥t1LightLines 时改走「轻整压」（合并到更小的目标，
  //    主要目的是省行额，免得被白天的行数规则一行行摘进 T2）。
  const oldLines = t1Lines.filter((l) => !isTodayLine(l));
  const oldChars = oldLines.reduce((s, l) => s + l.text.length, 0);
  const todayKey = dayKey8();
  // 触发缘由必须在动手之前取——摘完行再看就看不出这次是「字数」还是「条数」触发的了
  const trigByChars = t1Chars() > cfg.t1MaxChars;
  const trigByLines = t1Lines.length >= cfg.t1MaxLines;
  const trig = trigByChars && trigByLines ? "字数+条数"
    : trigByChars ? `字数 ${t1Chars()}>${cfg.t1MaxChars}`
      : trigByLines ? `条数 ${t1Lines.length}≥${cfg.t1MaxLines}` : "";
  const repackDayFree = oldLines.length > 0 && lastRepackDay !== todayKey;
  const shouldRepack = repackDayFree && oldChars > cfg.t1CompressTo;
  const shouldLight = !shouldRepack && repackDayFree && oldLines.length >= cfg.t1LightLines;
  let moved = [];
  let what = "未超限";
  if (shouldRepack) {
    moved = await repackT1(oldLines);
    what = `跨天整压（非今天 ${oldChars}→${cfg.t1CompressTo} 字）`;
  } else if (shouldLight) {
    moved = await repackT1(oldLines, { light: true });
    what = `跨天轻整压（非今天 ${oldLines.length} 行 ${oldChars}→${cfg.t1LightCompressTo} 字）`;
  } else if (t1OverLimit()) {
    moved = evictT1OverLimit();
    what = `摘出 ${moved.length} 行（${trig}）`;
  }
  if (moved.length) {
    archiveEvicted(moved, reason);
    try {
      await mergeInto2(moved);
    } catch (e) {
      // 【v1.4 根因修复】合并失败**不再把行放回 T1**——那正是"T1 只增不减、超限静默常驻"的根因：
      // 线上四次 t2-merge 全部因 thinking 烧满 max_tokens 返回空 → 行被放回 → T1 越滚越长。
      // 现在改走机械兜底：代码自己按行拼接 + 按字数淘汰，内容不丢（细节另有 t1_archive 归档）。
      log(`T2 合并失败（${e.message}），改走机械兜底并入（不再退回 T1）`);
      fallbackMergeInto2(moved);
    }
  }

  // ⑤ T2 双淘汰
  pruneT2();

  if (t1OverLimit()) {
    log(`[WARN] T1 仍超限（${t1Chars()} 字 / ${t1Lines.length} 行，目标 ${cfg.t1CompressTo} 字 / ${cfg.t1MaxLines - 1} 行，保底留 ${cfg.minKeepT1} 行）`);
  }

  saveSummary();
  log(`结算完成（${reason}）：新增 ${appended.length} 行 / 销项 ${closed} 行 / 压缩 ${what}；T1 ${t1Lines.length} 行 ${t1Chars()} 字，T2 ${t2Lines.length} 行 ${t2Chars()} 字`);
}

// 摘出的行先归档：T2 只剩骨架，摘走的细节只活在归档里（任何时候能回溯）
function archiveEvicted(moved, reason) {
  try {
    fs.mkdirSync(T1_ARCHIVE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(T1_ARCHIVE_DIR, `${Date.now()}.json`),
      JSON.stringify({ moved: moved.map((l) => l.text), t2_before: renderT2(), at: new Date().toISOString(), reason }, null, 1)
    );
  } catch (e) { log("T1 归档失败(忽略):", e.message); }
}

// 把摘出的旧行压缩并入 T2。一次小调用：输入只有这几行 + 现有 T2，**不是整段 T1**。
// v1.3 起 T2 要求"能独立读懂"（禁电报体），上限同步 220→360 字。
async function mergeInto2(moved) {
  const c8 = new Date(Date.now() + 8 * 3600 * 1000);
  const cLabel = `${c8.getUTCFullYear()}年${c8.getUTCMonth() + 1}月${c8.getUTCDate()}日 ${String(c8.getUTCHours()).padStart(2, "0")}:${String(c8.getUTCMinutes()).padStart(2, "0")}`;
  const sys = `你是记忆压缩器。只输出严格 JSON，不要任何解释或代码块围栏。
把[并入的话题]压缩后并入[更早梗概]，输出 JSON：
{"lines":["…"]}
规则：
1. 每条一行，开头带绝对时间戳（如 9.21日 16:45；更久远的可简化到 9.11日），严禁"今天/昨天"等相对词。
2. 每条必须**能独立读懂**：写清是谁、什么事、什么结论，禁止只堆关键词——不要出现"词表未列""规则他写"这种没有主语的悬空指代。
3. 闲聊细节全删，只留事实骨架与情绪转折。
4. 总长不超过[字数上限]；越旧的信息越简，刚并入的这几条可以稍详细。`;
  const user = `[字数上限] ${cfg.t2MaxChars}字

[当前时间] ${cLabel}

[更早梗概]
${renderT2() || "（无）"}

[并入的话题]
${moved.map((l) => l.text).join("\n")}`;
  const raw = await chatOnce(sys, user, { forceJson: true, kind: "t2-merge", effort: "minimal" });
  const parsed = extractJson(raw);
  if (!parsed || !Array.isArray(parsed.lines)) throw new Error("T2 合并输出无法解析");
  const merged = normalizeLines(parsed.lines);
  if (!merged.length) throw new Error("T2 合并输出为空");
  // 摘出的行已从 T1 删除，与 T2 不再重叠 → 整体替换；日期/字数淘汰由 pruneT2() 统一做
  t2Lines = merged;
  log(`T2 已并入 ${moved.length} 行 → ${t2Lines.length} 行 ${t2Chars()} 字`);
}

// 【v1.4】机械兜底：模型拿不回来时，代码自己把摘出的行原样接到 T2 尾部，
// 超字数由 pruneT2 从最旧端丢——宁可"梗概不那么精炼"，也不能让行退回去把 T1 顶爆。
function fallbackMergeInto2(moved) {
  const add = normalizeLines(moved);
  t2Lines = t2Lines.concat(add);
  pruneT2();
  if (t2Chars() > cfg.t2MaxChars && t2Lines.length) {
    // 只剩 1 行时 pruneT2 保底不删（length > 1 才删），这里硬截一下，别让上限失真
    const last = t2Lines[t2Lines.length - 1];
    last.text = last.text.slice(0, cfg.t2MaxChars);
  }
  log(`T2 机械兜底并入 ${add.length} 行 → ${t2Lines.length} 行 ${t2Chars()} 字`);
}

// 【v1.5】跨天整压：新的一天第一次压缩，把「非今天」的行整体重压到 ≤ limit，
// **结果留在 T1**（不是推进 T2）——这样 T1 里既有昨天一整天的收敛梗概，又保留今天的连续性。
//   幂等：靠落盘的 lastRepackDay 判定「今天已经压过」。**绝不能**用"T1 最旧行是不是今天"
//         来判定——整压产物的时间戳仍是非今天，那样每轮结算都会再压一次（烧钱 + 越压越薄）。
//   失败：必须机械兜底（mechRepackToTarget 摘进 T2），绝不保留原样。
//   opts.light：轻整压。昨天那部分没到 t1CompressTo（无料可重压）但行数多时走这条，
//   目标改成 t1LightCompressTo，重点是**把多行并成更少的行**；产出行数没减少就视为不可用。
// 返回：兜底时摘进 T2 的行（交给调用方并入 T2）；压缩成功返回空数组。
async function repackT1(oldLines, opts = {}) {
  const light = !!opts.light;
  const limit = light ? cfg.t1LightCompressTo : cfg.t1CompressTo;
  const keep = t1Lines.filter((l) => isTodayLine(l)); // 今天的行原样保留
  const oldChars = oldLines.reduce((s, l) => s + l.text.length, 0);
  const c8 = new Date(Date.now() + 8 * 3600 * 1000);
  const cLabel = `${c8.getUTCFullYear()}年${c8.getUTCMonth() + 1}月${c8.getUTCDate()}日 ${String(c8.getUTCHours()).padStart(2, "0")}:${String(c8.getUTCMinutes()).padStart(2, "0")}`;
  const sys = `你是记忆压缩器。只输出严格 JSON，不要任何解释或代码块围栏。
把[要压缩的话题]整体压成更精简的话题行${light ? "（这是「轻整压」：主要目的是**减少行数**——同一天里挨着的话题并成一行）" : ""}，输出 JSON：
{"lines":["话题行…"]}
规则：
1. 每条一行，开头必须是绝对时间戳（照抄原行开头的时间戳；同一天的可以合并成一行，保留该天最早的时间戳）。严禁"今天/昨天/刚才"等相对词。
2. 这是**近期记忆**，要保住一整天的脉络：按时间顺序保留关键动作、原话、数字量词、以及还没结束的话头和待办。宁可少写细节，也不能丢掉"这一天发生过什么"的顺序。
3. 删掉寒暄、重复和无关闲话，只留事实骨架与情绪转折；行内不要换行。
4. 总字数不超过[字数上限]；越早的段落越简，靠后（离现在近）的可以稍详细。${light ? "\n5. 原文本来就不长，别硬砍内容：**优先合并**（把 8 行并成 2~3 行），该留的事实照留。" : ""}`;
  const user = `[字数上限] ${limit}字（原文 ${oldChars} 字${oldChars > limit ? "，压到上限内" : "，**已在上限内，不要再删信息，只需合并行**"}）

[当前时间] ${cLabel}

[要压缩的话题]
${oldLines.map((l) => l.text).join("\n")}`;

  let parsed = null;
  try {
    const raw = await chatOnce(sys, user, { forceJson: true, kind: light ? "t1-light-repack" : "t1-repack", effort: "minimal" });
    parsed = extractJson(raw);
  } catch (e) {
    log(`${light ? "跨天轻整压" : "跨天整压"}调用失败（${e.message}）`);
  }
  let packed = parsed && Array.isArray(parsed.lines) ? normalizeLines(parsed.lines) : [];
  // 轻整压的产出必须真的"合并掉了行数"，否则白压一场：行数没减少就按不可用处理（走兜底）。
  if (packed.length && light && packed.length >= oldLines.length) {
    log(`跨天轻整压产出 ${packed.length} 行，没比原文 ${oldLines.length} 行少，视为不可用`);
    packed = [];
  }
  if (!packed.length) {
    const moved = mechRepackToTarget(limit);
    lastRepackDay = dayKey8();
    saveSummary();
    log(`${light ? "跨天轻整压" : "跨天整压"}未拿到可用输出，机械兜底：把最旧的 ${moved.length} 行摘进 T2，非今天部分收到 ${limit} 字内`);
    return moved;
  }
  t1Lines = packed.concat(keep); // 压缩产物都在前面（更旧），今天的行接在后面，升序不变
  lastRepackDay = dayKey8();
  updatedAt = new Date().toISOString();
  saveSummary();
  log(`${light ? "跨天轻整压" : "跨天整压"}完成：非今天 ${oldLines.length} 行 ${oldChars} 字 → ${packed.length} 行 ${packed.reduce((s, l) => s + l.text.length, 0)} 字（今天的 ${keep.length} 行原样保留）`);
  return [];
}

function extractJson(raw) {
  try {
    let s = String(raw).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    const obj = JSON.parse(s);
    return obj && typeof obj === "object" ? obj : null;
  } catch { return null; }
}

// ========================
// 注入：网关在每次请求消息末尾 push（同步、无重 IO、永不抛）
// 摘要来自内存态（行列表渲染）。
// ========================
function injectBlocks() {
  if (!cfg.enabled) return [];
  reloadIfChanged(); // 【v1.4】外部（查看器的编辑按钮）改过 summaries.json 就重读，改完下一轮即生效
  const blocks = [];
  try {
    const t1 = renderT1();
    const t2 = renderT2();
    if (t1 || t2) {
      let s = "【更早对话的滚动摘要（供衔接上下文，这些不在当前窗口里）】\n";
      if (t2) s += `〔更早梗概〕${t2}\n`;
      if (t1) s += `〔近期摘要〕${t1}`;
      blocks.push({ role: "system", content: s.trim() });
    }
  } catch (e) { log("组装摘要块失败(忽略):", e.message); }
  return blocks;
}

// ========================
// 上游 LLM 调用（OpenAI 兼容 chat/completions）
//
// 【双上游】结算链路与对话链路可以不同源：
//   对话：CHAT_API_URL  + CHAT_API_KEY  + 对话模型（如 Grok）
//   结算：LEDGER_API_URL + LEDGER_API_KEY + 结算模型（如 DeepSeek）
// 本模块只负责【结算】一侧，永远用 LEDGER_* 三件套。
// 分开的理由：结算 prompt 每轮全新（[近期摘要]+[新对话]），前缀缓存几乎不可能命中，
//   全价计费；而对话链路能命中缓存。把两者绑在同一个上游时，结算会拉低整条链路的
//   缓存命中率观感，也会让"换性价比模型"和"换对话模型"互相绑架。
// 注意：多数厂商的并发/限流按【账号】计，多开 Key 不提升额度；双上游的意义是
//   解耦模型选择与计费口径，不是突破并发。
// ========================
async function chatOnce(systemPrompt, userPrompt, opts = {}) {
  if (!cfg.apiBase || !cfg.apiKey || !cfg.model) {
    throw new Error("LEDGER_API_URL / LEDGER_API_KEY / LEDGER_MODEL 未配置");
  }
  const kind = opts.kind || "settle";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("结算 LLM 超时")), cfg.llmTimeoutMs);
  try {
    const body = {
      model: cfg.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 4000, // 推理类模型 thinking 会先烧 token，预算小会返回 200 但内容为空
      temperature: 0.3,
      stream: false,
    };
    if (opts.forceJson) body.response_format = { type: "json_object" };
    // 【v1.4】reasoning_effort：官方上游实测接受 minimal/low/medium/high 四档。
    // t2-merge 传 minimal——它是纯机械压缩，不需要思考，而实测 thinking 会烧满 max_tokens
    // 把 content 挤成空（线上四次 t2-merge 全部 completion=8192 / reasoning=8192 → 内容空）。
    // 不传就保持上游默认，老上游不认这个字段也无妨（有的会直接忽略）。
    if (opts.effort) body.reasoning_effort = opts.effort;
    const resp = await fetch(cfg.apiBase, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    logUsage(data?.usage, kind);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("上游返回空内容");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

// 用量观测：结算成本的唯一可见来源。
// 没有这行日志时，"结算到底花了多少钱/有没有命中缓存"只能靠猜。
// 各家 usage 字段名不统一，这里做兼容取值，取不到就记 null（不影响主链路）。
function logUsage(usage, kind) {
  try {
    if (!usage) return;
    const hit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const miss = usage.prompt_cache_miss_tokens
      ?? (usage.prompt_tokens != null ? usage.prompt_tokens - hit : null);
    console.log(JSON.stringify({
      event: "llm_usage",
      mode: "rolling-" + kind,
      model: cfg.model,
      prompt_tokens: usage.prompt_tokens ?? null,
      cache_hit: hit,
      cache_miss: miss,
      completion_tokens: usage.completion_tokens ?? null,
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    }));
  } catch (e) { log("usage 记录失败(忽略):", e.message); }
}

// ========================
// 运行状态（供查看器/调试）：只读内存态，无 IO、永不抛
// t1/t2 返回**渲染后的字符串**（行列表镜像），保持对外契约不变。
// ========================
function stats() {
  // t1/t2 返回**渲染后的字符串**（行列表镜像），t1Chars/t2Chars 是这两个字符串的长度，
  // 对外契约与旧版一致（viewer.js 直接读这几个字段）。
  const t1 = renderT1();
  const t2 = renderT2();
  return {
    enabled: cfg.enabled,
    model: cfg.model,
    t1,
    t2,
    updated_at: updatedAt,
    t1Chars: t1.length,
    t2Chars: t2.length,
    t1MaxChars: cfg.t1MaxChars,
    t1MaxLines: cfg.t1MaxLines,                 // 【v1.5】
    t1CompressTo: cfg.t1CompressTo,             // 【v1.5】
    t1LightLines: cfg.t1LightLines,             // 【v1.5】
    t1LightCompressTo: cfg.t1LightCompressTo,   // 【v1.5】
    lastRepackDay,                              // 【v1.5】
    t2MaxChars: cfg.t2MaxChars,
    bufferCount: cfg.bufferCount,
    bufferChars: cfg.bufferChars,
    upstreamSeparated: !!(cfg.chatApiBase && cfg.chatApiBase !== cfg.apiBase),
    pendingCount: pending.length,
    pendingChars: pendingChars(),
  };
}

module.exports = { init, observeRequest, injectBlocks, stats, snapshot, deleteRows, editRows, reloadIfChanged, repackT1 };
