// ============================================================
// rolling-memory/index.js — 两层滚动记忆
//   Tier1 近期摘要：滑出对话窗口的消息逐批结算，详细（默认 ≤1200 字）
//   Tier2 远期梗概：T1 超长后自动压缩，事实骨架（默认 ≤220 字）
//
// 三件套接入（详见 README）：
//   rolling.init();
//   rolling.observeRequest(messages);           // 网关每次转发 LLM 前调用
//   rolling.injectBlocks() → [{role, content}]  // 组装消息时追加到末尾
//
// 铁律：所有失败静默降级（console.log），绝不阻塞/拖慢主对话链路。
// ============================================================
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STATE_DIR = process.env.ROLLING_MEMORY_STATE_DIR || path.join(__dirname, "state");
const SUMMARY_FILE = path.join(STATE_DIR, "summaries.json");

const DEFAULTS = {
  enabled: true,
  model: "",                // 结算用模型（必配，任何 OpenAI 兼容模型）
  apiBase: "",              // OpenAI 兼容 chat/completions 地址（必配）
  apiKey: "",               // 必配
  bufferChars: 400,         // 缓冲攒够多少字触发一次结算（防抖）
  pendingMaxChars: 12000,   // 缓冲上限：结算连续失败时丢最旧，防内存膨胀
  t1MaxChars: 1200,         // T1 超过则压缩进 T2
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

function fpOf(role, text) {
  return crypto.createHash("md5").update(role + "\u0000" + text).digest("hex").slice(0, 16);
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
    bufferChars: num("LEDGER_BUFFER_CHARS", DEFAULTS.bufferChars),
    pendingMaxChars: num("LEDGER_PENDING_MAX_CHARS", DEFAULTS.pendingMaxChars),
    t1MaxChars: num("LEDGER_T1_MAX_CHARS", DEFAULTS.t1MaxChars),
    t2MaxChars: num("LEDGER_T2_MAX_CHARS", DEFAULTS.t2MaxChars),
    llmTimeoutMs: num("LEDGER_LLM_TIMEOUT_MS", DEFAULTS.llmTimeoutMs),
    userLabel: getEnv("LEDGER_USER_LABEL", DEFAULTS.userLabel),
    assistantLabel: getEnv("LEDGER_ASSISTANT_LABEL", DEFAULTS.assistantLabel),
  };
  loadSummary();
  log(`已初始化（model=${cfg.model || "未配置"}，T1上限 ${cfg.t1MaxChars} 字，当前 T1=${summaryState.t1.length} 字 / T2=${summaryState.t2.length} 字）`);
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

    const isNewWindow = prevFps.length > 0 && overlap === 0;
    if (isNewWindow) {
      // 换窗：旧会话整体消失。已滑出攒在 pending 的部分先结算，
      // 最后一轮消息（还没机会滑出就换窗了）也并入缓冲，保住尾巴。
      for (const m of lastMsgs) addPending(m);
      if (pendingChars() > 0) scheduleCycle("window-flush");
    } else if (overlap > 0) {
      for (const m of lastMsgs.slice(0, lastMsgs.length - overlap)) addPending(m);
    }
    // overlap===0 且上轮消息很少（<6 条）：多半是标题生成等后台小请求，
    // 不当换窗处理，静默重置追踪即可，避免污染摘要。

    maybeScheduleCycle();

    lastMsgs = cur.slice(-120);
  } catch (e) {
    log("观察失败(忽略):", e.message);
  }
}

function pendingChars() {
  return pending.reduce((s, m) => s + m.text.length, 0);
}

function addPending(m) {
  if (pendingFps.has(m.fp)) return;
  pending.push({ role: m.role, text: m.text, fp: m.fp });
  pendingFps.add(m.fp);
  while (pendingChars() > cfg.pendingMaxChars && pending.length) {
    const dropped = pending.shift();
    pendingFps.delete(dropped.fp);
  }
}

function maybeScheduleCycle() {
  if (pendingChars() >= cfg.bufferChars) scheduleCycle("threshold");
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
    for (const m of batch) pendingFps.add(m.fp);
    while (pendingChars() > cfg.pendingMaxChars && pending.length) {
      const dropped = pending.shift();
      pendingFps.delete(dropped.fp);
    }
  }
  busy = false;
  if (rerunNeeded) {
    rerunNeeded = false;
    if (pendingChars() >= cfg.bufferChars) scheduleCycle("rerun");
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
  const sys = "你是记忆压缩器。直接输出更新后的摘要纯文本，不要解释、不要代码块围栏。";
  const user = `把[新对话]合并进[当前摘要]，输出更新后的完整摘要。
规则：分两节——
一、聊了什么：逐个话题一行，带时间锚（今天上午/刚才/昨晚等），窗口外近两天内的话题都要能查到；
二、${cfg.userLabel}的状态和心情：只留最新——体力、情绪、正在忙什么。
闲聊细节删，但话题名不能丢；总长≤${Math.min(1100, cfg.t1MaxChars)}字；[新对话]没有新信息就原样保留[当前摘要]。

[当前摘要]
${oldT1}

[新对话]
${lines.slice(0, 6000)}`;

  const newT1 = (await chatOnce(sys, user)).trim();
  if (newT1) { summaryState.t1 = newT1; summaryState.updated_at = new Date().toISOString(); }

  // T1 超长 → 压缩进 T2
  if (summaryState.t1.length > cfg.t1MaxChars) {
    try {
      const oldT2 = summaryState.t2 || "（无）";
      const comp = await chatOnce(
        "你是记忆压缩器。输出纯文本摘要，不要解释。",
        `把[近期摘要]压缩合并进[更早梗概]，输出新的[更早梗概]，≤${cfg.t2MaxChars}字。\n规则：情绪转折必须保留；带时间段（如"8月底"）；闲聊细节全删。\n\n[更早梗概]\n${oldT2}\n\n[近期摘要]\n${summaryState.t1}`
      );
      summaryState.t2 = comp.trim().slice(0, cfg.t2MaxChars + 60);
      summaryState.t1 = "";
      log("T1 已压缩进 T2");
    } catch (e) {
      log("T2 压缩失败(保留T1):", e.message);
    }
  }
  saveSummary();
  log(`结算完成（${reason}）：摘要 ${summaryState.t1.length}+${summaryState.t2.length} 字`);
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
// ========================
async function chatOnce(systemPrompt, userPrompt) {
  if (!cfg.apiBase || !cfg.apiKey || !cfg.model) {
    throw new Error("LEDGER_API_URL / LEDGER_API_KEY / LEDGER_MODEL 未配置");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("结算 LLM 超时")), cfg.llmTimeoutMs);
  try {
    const resp = await fetch(cfg.apiBase, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 4000, // 推理类模型 thinking 会先烧 token，预算小会返回 200 但内容为空
        temperature: 0.3,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("上游返回空内容");
    return content;
  } finally {
    clearTimeout(timer);
  }
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
    pendingCount: pending.length,
    pendingChars: pendingChars(),
  };
}

module.exports = { init, observeRequest, injectBlocks, stats };
