// viewer.js — 迷你查看器：npm run view → http://127.0.0.1:8788
// 只读展示 T1/T2 当前内容、字数、待结算缓冲。想改记忆直接编辑 state/summaries.json。
const http = require("http");
const { loadDotEnv } = require("./env");
const rolling = require("./index");

const HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>rolling-memory 查看器</title>
<style>
 body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#222}
 h1{font-size:20px} .muted{color:#888;font-size:12px}
 .card{border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:12px 0}
 .card h2{font-size:14px;margin:0 0 8px}
 .bar{height:6px;background:#eee;border-radius:3px;overflow:hidden;margin:6px 0}
 .bar i{display:block;height:100%;background:#4a90d9}
 pre{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.7;margin:0;font-family:inherit}
</style></head><body>
<h1>rolling-memory 查看器 <span class="muted">每 5 秒自动刷新</span></h1>
<div class="muted" id="meta"></div>
<div class="card"><h2>T2 远期梗概 <span class="muted" id="t2n"></span></h2>
 <div class="bar"><i id="t2b"></i></div><pre id="t2">（空）</pre></div>
<div class="card"><h2>T1 近期摘要 <span class="muted" id="t1n"></span></h2>
 <div class="bar"><i id="t1b"></i></div><pre id="t1">（空）</pre></div>
<div class="card"><h2>结算流水线</h2><pre id="pipe"></pre></div>
<p class="muted">想人工修正记忆？直接编辑 state/summaries.json——模块每次结算前会重读它，改完即生效。</p>
<script>
async function tick(){
 try{
  const s=await (await fetch("/api/state")).json();
  document.getElementById("meta").textContent="模型: "+(s.model||"未配置")+" · 开关: "+(s.enabled?"开":"关")+" · 摘要更新于: "+(s.updated_at||"从未");
  const t2=document.getElementById("t2"),t1=document.getElementById("t1");
  t2.textContent=s.t2||"（空）"; t1.textContent=s.t1||"（空）";
  document.getElementById("t2n").textContent=s.t2Chars+"/"+s.t2MaxChars+" 字";
  document.getElementById("t1n").textContent=s.t1Chars+"/"+s.t1MaxChars+" 字";
  document.getElementById("t2b").style.width=Math.min(100,s.t2Chars/s.t2MaxChars*100)+"%";
  document.getElementById("t1b").style.width=Math.min(100,s.t1Chars/s.t1MaxChars*100)+"%";
  document.getElementById("pipe").textContent="待结算缓冲: "+s.pendingCount+" 条 / "+s.pendingChars+" 字（攒够阈值自动结算）";
 }catch(e){}
}
tick(); setInterval(tick,5000);
</script></body></html>`;

function start({ port } = {}) {
  const p = port || Number(process.env.VIEWER_PORT) || 8788;
  const server = http.createServer((req, res) => {
    if (req.url === "/api/state") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(rolling.stats()));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HTML);
  });
  server.listen(p, () => {
    console.log(`[rolling-memory] 查看器已启动: http://127.0.0.1:${p}`);
  });
  return server;
}

if (require.main === module) {
  loadDotEnv();
  rolling.init();
  start();
}
module.exports = { start };
