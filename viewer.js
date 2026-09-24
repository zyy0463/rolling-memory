// viewer.js — 迷你查看器 + 记忆编辑：npm run view → http://127.0.0.1:8788
// 展示 T1/T2 当前内容、字数、待结算缓冲；每行一个小 × 直接删，点文字就地改。
// 改的是真源 state/summaries.json（走 index.js 的 deleteRows/editRows，原子落盘），
// 结算进程下一轮注入前会自动重读（.reload 标记），无需重启。
// 【v1.4】编辑接口就是 POST /api/ledger，字段与 index.js 的原语一一对应，脚本也能直接调。
// 只监听本机、无鉴权——别把这个端口暴露到公网。
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
 .row{display:flex;gap:6px;align-items:flex-start;padding:2px 0}
 .row .txt{flex:1;font-size:13px;line-height:1.7;cursor:text;border-radius:4px}
 .row .txt:hover{background:#f4f7fb}
 .row .x{border:0;background:transparent;color:#c8c8c8;font-size:15px;line-height:1;cursor:pointer;padding:1px 5px;border-radius:4px}
 .row .x:hover{color:#e05a5a;background:#fdeeee}
 .edit{width:100%;box-sizing:border-box;font:inherit;font-size:13px;line-height:1.6;padding:6px;border:1px solid #9bc;border-radius:6px;resize:vertical}
 .acts{margin-top:6px} .acts button{font-size:12px;margin-right:6px;padding:3px 10px;border-radius:6px;border:1px solid #9bc;background:#eef5fc;cursor:pointer}
 .err{color:#c0392b;font-size:12px;min-height:16px}
</style></head><body>
<h1>rolling-memory 查看器 <span class="muted">每 5 秒自动刷新</span></h1>
<div class="muted" id="meta"></div>
<div class="err" id="err"></div>
<div class="card"><h2>T2 远期梗概 <span class="muted" id="t2n"></span></h2>
 <div class="bar"><i id="t2b"></i></div><div id="t2"></div></div>
<div class="card"><h2>T1 近期摘要 <span class="muted" id="t1n"></span></h2>
 <div class="bar"><i id="t1b"></i></div><div id="t1"></div></div>
<div class="card"><h2>结算流水线</h2><pre id="pipe"></pre></div>
<p class="muted">每行末尾的 × 删掉这一行，点文字就地改（回车外的换行会被压平、丢了开头的日期会自动补回原时间戳）。编辑中不参与自动刷新；改完立即落盘，结算进程下一轮自动重读。</p>
<script>
var editing=false;
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function rowHtml(t,i,text){
 return '<div class="row" data-t="'+t+'" data-i="'+i+'"><span class="txt" title="点一下就地改">'+esc(text)+'</span>'
   +(t==="state"?"":'<button class="x" title="删掉这一行">×</button>')+'</div>';
}
function linesHtml(t,arr){
 var h="",a=arr||[];
 // T1/T2 内部都是升序（0=最旧），显示反过来（最新在前）；data-i 仍用升序下标，否则删错行
 for(var i=a.length-1;i>=0;i--) h+=rowHtml(t,i,a[i].text);
 return h||'<div class="muted">（空）</div>';
}
async function api(payload){
 var r=await fetch("/api/ledger",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
 var j={}; try{j=await r.json();}catch(e){}
 if(!r.ok||j.ok===false) throw new Error((j&&j.error)||("HTTP "+r.status));
 return j;
}
async function tick(){
 if(editing) return;
 try{
  var s=await (await fetch("/api/state")).json();
  document.getElementById("meta").textContent="模型: "+(s.model||"未配置")+" · 开关: "+(s.enabled?"开":"关")+" · 摘要更新于: "+(s.updated_at||"从未");
  document.getElementById("t2").innerHTML=linesHtml("t2",s.t2_lines);
  var t1=linesHtml("t1",s.t1_lines);
  if(s.t1_state) t1+='<div class="muted" style="margin-top:8px">状态与心情</div>'+rowHtml("state","",s.t1_state);
  document.getElementById("t1").innerHTML=t1;
  document.getElementById("t2n").textContent=s.t2_chars+"/"+s.t2_max_chars+" 字";
  document.getElementById("t1n").textContent=s.t1_chars+"/"+s.t1_max_chars+" 字";
  document.getElementById("t2b").style.width=Math.min(100,s.t2_chars/s.t2_max_chars*100)+"%";
  document.getElementById("t1b").style.width=Math.min(100,s.t1_chars/s.t1_max_chars*100)+"%";
  document.getElementById("pipe").textContent="待结算缓冲: "+s.pendingCount+" 条 / "+s.pendingChars+" 字（攒够阈值自动结算）";
  document.getElementById("err").textContent="";
 }catch(e){}
}
function fail(e){document.getElementById("err").textContent=String(e&&e.message||e);}
document.getElementById("t1").addEventListener("click",onClick);
document.getElementById("t2").addEventListener("click",onClick);
async function onClick(ev){
 var row=ev.target.closest(".row"); if(!row) return;
 var t=row.getAttribute("data-t"), i=row.getAttribute("data-i");
 var text=row.querySelector(".txt").textContent;
 if(ev.target.classList.contains("x")){
  if(!confirm("删掉这一行？\\n\\n"+text)) return;
  try{ await api({action:"delete",target:t,index:i}); }catch(e){ return fail(e); }
  tick(); return;
 }
 if(!ev.target.classList.contains("txt")) return;
 if(row.querySelector(".edit")) return;
 editing=true;
 row.innerHTML='<div style="flex:1"><textarea class="edit" rows="3"></textarea>'
  +'<div class="acts"><button data-a="save">保存</button><button data-a="cancel">取消</button></div></div>';
 var ta=row.querySelector(".edit"); ta.value=text; ta.focus();
 row.querySelector('[data-a="cancel"]').onclick=function(){ editing=false; tick(); };
 row.querySelector('[data-a="save"]').onclick=async function(){
  try{ await api({action:"edit",target:t,index:t==="state"?undefined:i,text:ta.value}); }
  catch(e){ return fail(e); }
  editing=false; tick();
 };
}
tick(); setInterval(tick,5000);
</script></body></html>`;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { resolve(null); }
    });
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function start({ port } = {}) {
  const p = port || Number(process.env.VIEWER_PORT) || 8788;
  const server = http.createServer(async (req, res) => {
    const url = (req.url || "").split("?")[0];
    if (url === "/api/state") {
      // stats() 给运行态（模型/开关/缓冲），snapshot() 给行列表；后者覆盖同名字段
      sendJson(res, 200, { ...rolling.stats(), ...rolling.snapshot() });
      return;
    }
    if (url === "/api/ledger" && req.method === "POST") {
      const b = await readBody(req);
      if (!b) return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
      try {
        let view;
        if (b.action === "delete") view = rolling.deleteRows(b.target, { index: b.index, count: b.count });
        else if (b.action === "edit") view = rolling.editRows(b.target, b.index, b.text);
        else return sendJson(res, 400, { ok: false, error: "action 只能是 delete / edit" });
        sendJson(res, 200, { ok: true, ...view });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
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