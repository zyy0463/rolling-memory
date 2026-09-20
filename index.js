// ============================================================
// rolling-memory/index.js — 两层滚动记忆
//   Tier1 近期摘要：滑出对话窗口的消息逐批结算，详细（默认 ≤2000 字）
//   Tier2 远期梗概：T1 超长后自动压缩，事实骨架（默认 ≤220 字）
//
// 三件套接入（详见 README）：
//   rolling.init();
//   rolling.observeRequest(messages);           // 网关每次转发 LLM 前调用
//   rolling.injectBlocks() → [{role, content}]  // 组装消息时追加到末尾
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
  t1MaxChars: 2000,         // T1 超过则压缩进 T2
  t2MaxChars: 220,          // T2 封顶
  llmTimeoutMs: 60000,
  userLabel: "user",        // 结算摘要里"对方"的称呼
  assistantLabel: "assistant", // 结算摘要里"自己"的称呼
};

let cfg = { ...DEFAULTS };
let normalizeText = (c) => String(typeof c === "string" ? c : JSON.stringify(c ?? ""));
let getEnv = (key, fallback) => process.env[key] || fallback;

// ---- 运行时状态 ----
let summaryState = { t1: "", t2: "", updated_at: null };
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

function loadSummary() {
  try {
    if (fs.existsSync(SUMMARY_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SUMMARY_FILE, "utf8"));
      summaryState = { t1: String(parsed.t1 || ""), t2: String(parsed.t2 || ""), updated_at: parsed.updated_at || null };
    }
  } catch (e) {
    log("摘要文件读取失败，用空状态启动:", e.message);
  }
}

function saveSummary() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summaryState, null, 1));
  } catch (e) { log("摘要保存失败(忽略):", e.message); }
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
    t2MaxChars: num("LEDGER_T2_MAX_CHARS", DEFAULTS.t2MaxChars),
    llmTimeoutMs: num("LEDGER_LLM_TIMEOUT_MS", DEFAULTS.llmTimeoutMs),
    userLabel: getEnv("LEDGER_USER_LABEL", DEFAULTS.userLabel),
    assistantLabel: getEnv("LEDGER_ASSISTANT_LABEL", DEFAULTS.assistantLabel),
  };
  loadSummary();
  const sameUpstream = !cfg.chatApiBase || cfg.chatApiBase === cfg.apiBase;
  log(
    `已初始化（结算 model=${cfg.model || "未配置"}，T1上限 ${cfg.t1MaxChars} 字，` +
    `触发=${cfg.bufferCount} 条/${cfg.bufferChars} 字，上游=${sameUpstream ? "与对话同源" : "独立（双上游）"}，` +
    `当前 T1=${summaryState.t1.length} 字 / T2=${summaryState.t2.length} 字）`
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
// 结算：一次 LLM 调用产出新 T1；T1 超长再压 T2
// 结算前强制从磁盘重读摘要：外部手改 T1/T2 不会被内存旧态覆盖。
// ========================
async function settleBatch(batch, reason) {
  if (!batch.length) return;
  loadSummary(); // 手改保护
  const lines = batch
    .map((m) => `${m.role === "user" ? cfg.userLabel : cfg.assistantLabel}：${m.text.slice(0, 400)}`)
    .join("\n");
  const oldT1 = summaryState.t1 || "（暂无，这是本会话第一批）";
  // 东八区当前时刻（结算锚点）
  const n8 = new Date(Date.now() + 8 * 3600 * 1000);
  const nowLabel = `${n8.getUTCFullYear()}年${n8.getUTCMonth() + 1}月${n8.getUTCDate()}日 ${String(n8.getUTCHours()).padStart(2, "0")}:${String(n8.getUTCMinutes()).padStart(2, "0")}`;

  // 【2026-09-20 两处结构性改进】
  //
  // ① 绝对时间戳：旧规则要求"带时间锚（今天上午/刚才/昨晚）"——相对词是提示词自己教的，
  //    而相对词几天后读起来会误导成最近发生（今天=每天滚动，语义漂移）。
  //    现改为强制绝对时间戳（如 9.11日 23:05），并注入[当前时间]锚点供换算。
  //
  // ② 分级预算取代"覆盖承诺"：旧规则写"近两天内的话题都要能查到"+字数上限，
  //    数学上矛盾——两天约 30 个话题，扣掉时间戳后每个话题只剩约 27 字，
  //    结果 LLM 被迫牺牲深度保数量，每条总结都很短、细节全丢。
  //    现按远近分三档分配预算，并明确"A 档优先保证"。
  //
  // ③ 缓存友好排列：固定指令全部放 system（约 900 字，每轮静态、可稳定命中前缀缓存），
  //    user 只留易变载荷（字数上限/当前时间/摘要/新对话）。
  //    旧排列把可变内容紧跟系统提示，前缀很快就断，固定部分几乎全部 miss。
  const sys = `你是记忆压缩器。只输出严格 JSON，不要任何解释或代码块围栏。

把用户消息里的[新对话]合并进[当前摘要]，输出 JSON：
{"summary":"更新后的近期摘要"}
summary 规则：分两节——
一、聊了什么：按时间倒序逐个话题一行，每条开头必须带绝对时间戳（格式如 9.11日 23:05；按[当前时间]回推换算[当前摘要]里的相对时间词）；严禁出现"今天/昨天/刚才/今晚/上午"等相对词——相对词几天后读起来会误导成最近发生。约定、待办、没聊完的话头也要以话题行写进这一节。
【长度预算——按距[当前时间]的远近分三档，严格照此分配】
  A. 近 24 小时：最多 12 个话题，每条约 60~90 字。要写足——关键动作、原话、数字量词（"第五轮""气过两回""九点"）都不能丢，这是最常需要衔接的部分。
  B. 24~48 小时：最多 8 个话题，每条约 20~30 字。只留话题名 + 结果，细节可删。
  C. 48 小时以上：合并成 1~2 行，只写时段 + 主线（如"9.16 前后：主要在弄课程设计"）。
  话题数超过对应档位上限时，合并同类项，不要新开行。
二、${cfg.userLabel}的状态和心情：只留最新——体力、情绪、正在忙什么，这一节开头也带检查时刻的时间戳。
总长不得超过[字数上限]指定的字数；A 档预算优先保证，不够时压缩 B/C 档，绝不要为了塞话题数把 A 档写短；[新对话]没有新信息就原样保留[当前摘要]（但时间戳规则仍要执行）。`;

  const user = `[字数上限] ${cfg.t1MaxChars}字

[当前时间] ${nowLabel}

[当前摘要]
${oldT1}

[新对话]
${lines.slice(0, 6000)}`;

  const raw = await chatOnce(sys, user, { forceJson: true, kind: "settle" });
  const parsed = extractJson(raw);
  if (!parsed) {
    // 解析失败 = 这批消息永久消失。设计上「不返还避免重复消耗」成立，
    // 但解析失败与上游故障性质不同——前者最可能丢内容，故落盘供人工捞。
    try {
      fs.mkdirSync(FAILED_BATCH_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(FAILED_BATCH_DIR, `${Date.now()}.json`),
        JSON.stringify({ reason, raw: String(raw).slice(0, 4000), batch }, null, 1)
      );
    } catch (e2) { log("归档失败批次失败(忽略):", e2.message); }
    log(`结算输出无法解析（${reason}），原文已归档到 failed_batches（${batch.length} 条消息）`);
    return;
  }

  const newT1 = String(parsed.summary || "").trim();
  if (newT1) { summaryState.t1 = newT1; summaryState.updated_at = new Date().toISOString(); }

  // T1 超长 → 压缩进 T2
  if (summaryState.t1.length > cfg.t1MaxChars) {
    // 压缩前归档：T1 一旦清空，近两天的详细话题就只活在 T2 的字数上限里，内容不可逆。
    try {
      fs.mkdirSync(T1_ARCHIVE_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(T1_ARCHIVE_DIR, `${Date.now()}.json`),
        JSON.stringify({
          t1: summaryState.t1,
          t2_before: summaryState.t2,
          at: new Date().toISOString(),
          reason,
        }, null, 1)
      );
    } catch (e2) { log("T1 归档失败(忽略):", e2.message); }

    try {
      const oldT2 = summaryState.t2 || "（无）";
      const c8 = new Date(Date.now() + 8 * 3600 * 1000);
      const cLabel = `${c8.getUTCFullYear()}年${c8.getUTCMonth() + 1}月${c8.getUTCDate()}日 ${String(c8.getUTCHours()).padStart(2, "0")}:${String(c8.getUTCMinutes()).padStart(2, "0")}`;
      const comp = await chatOnce(
        `你是记忆压缩器。只输出纯文本摘要，不要 JSON、不要解释、不要代码块围栏。

把用户消息里的[近期摘要]压缩合并进[更早梗概]，输出新的[更早梗概]。

规则（固定，不要因为输入变化而改写这些规则本身）：
一、不超过[字数上限]指定的字数。超了就砍最早、最琐碎的话题，不要砍时间戳。
二、情绪转折必须保留——哪天对方明显难过、生气、或者关系上发生了转向，那一条不能删。
三、每条话题前的绝对时间戳（如 9.11日 23:05）必须保留；较久远的可简化到 M.D日；
    严禁改成"今天/昨天/前天"这类相对词，相对词过几天读会误导成最近发生。
四、闲聊细节、重复的寒暄、过程中的试错全部删掉，只留结论和事实骨架。
五、按时间倒序输出，一条话题一行。`,
        `[字数上限] ${cfg.t2MaxChars}字

[当前时间] ${cLabel}

[更早梗概]
${oldT2}

[近期摘要]
${summaryState.t1}`,
        { kind: "t2-compress" }
      );
      // 超长时截到最近句读，避免静默切在句子中间（半句话的摘要比稍长的摘要糟糕得多）
      const full = comp.trim();
      const hardMax = cfg.t2MaxChars + 60;
      if (full.length > hardMax) {
        const cut = full.slice(0, hardMax);
        const lastPunct = Math.max(
          cut.lastIndexOf("。"), cut.lastIndexOf("；"),
          cut.lastIndexOf("！"), cut.lastIndexOf("？"), cut.lastIndexOf("\n")
        );
        summaryState.t2 = lastPunct >= cfg.t2MaxChars * 0.6 ? cut.slice(0, lastPunct + 1) : cut;
        log(`T2 超长已截断（${full.length} → ${summaryState.t2.length} 字）`);
      } else {
        summaryState.t2 = full;
      }
      summaryState.t1 = "";
      log("T1 已压缩进 T2");
    } catch (e) {
      log("T2 压缩失败(保留T1):", e.message);
    }
  }
  saveSummary();
  log(`结算完成（${reason}）：摘要 ${summaryState.t1.length}+${summaryState.t2.length} 字`);
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
// ========================
function injectBlocks() {
  if (!cfg.enabled) return [];
  const blocks = [];
  try {
    if (summaryState.t1 || summaryState.t2) {
      let s = "【更早对话的滚动摘要（供衔接上下文，这些不在当前窗口里）】\n";
      if (summaryState.t2) s += `〔更早梗概〕${summaryState.t2}\n`;
      if (summaryState.t1) s += `〔近期摘要〕${summaryState.t1}`;
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
// 分开的理由：结算 prompt 每轮全新（[当前摘要]+[新对话]），前缀缓存几乎不可能命中，
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
// ========================
function stats() {
  return {
    enabled: cfg.enabled,
    model: cfg.model,
    t1: summaryState.t1,
    t2: summaryState.t2,
    updated_at: summaryState.updated_at,
    t1Chars: summaryState.t1.length,
    t2Chars: summaryState.t2.length,
    t1MaxChars: cfg.t1MaxChars,
    t2MaxChars: cfg.t2MaxChars,
    bufferCount: cfg.bufferCount,
    bufferChars: cfg.bufferChars,
    upstreamSeparated: !!(cfg.chatApiBase && cfg.chatApiBase !== cfg.apiBase),
    pendingCount: pending.length,
    pendingChars: pendingChars(),
  };
}

module.exports = { init, observeRequest, injectBlocks, stats };
