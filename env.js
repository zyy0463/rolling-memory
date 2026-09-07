// env.js — 极简 .env 读取器（零依赖）
// 只加载当前不存在的键，不覆盖真实环境变量。
const fs = require("fs");
const path = require("path");

function loadDotEnv(dir) {
  const file = path.join(dir || __dirname, ".env");
  try {
    if (!fs.existsSync(file)) return;
    for (const line of String(fs.readFileSync(file, "utf8")).split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (e) { console.log("[rolling-memory] .env 读取失败(忽略):", e.message); }
}

module.exports = { loadDotEnv };
