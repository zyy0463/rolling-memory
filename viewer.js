// viewer.js — 迷你查看器 + 记忆编辑：npm run view → http://127.0.0.1:8788
// 展示 T1/T2 当前内容、字数、待结算缓冲；每行一个小 × 直接删，点文字就地改。
// 改的是真源（默认会话 = state/summaries.json，其它会话 = state/sessions/<id>.json），
// 走 index.js 的 deleteRows/editRows 原子落盘，结算进程下一轮注入前会自动重读（.reload 标记），无需重启。
// 【v1.4】编辑接口就是 POST /api/ledger，字段与 index.js 的原语一一对应，脚本也能直接调。
// 【v1.9】顶部多了会话下拉：多会话隔离后，每个会话是一份独立记忆，可以分开看、分开改。
// 只监听本机、无鉴权——别把这个端口暴露到公网。
const http = require("http");
const { loadDotEnv } = require("./env");
const rolling = require("./index");

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>滚动记忆 · 看板</title>
<style>
  :root{
    --pink: rgb(224,170,162);
    --pink-soft: rgba(224,170,162,.12);
    --pink-line: rgba(224,170,162,.42);
    --ink: #3a3330; --ink-2: #6f6461; --ink-3: #a49a96;
    --bg: #fdfcfb; --card: #ffffff; --line: #efe9e6;
    --warn: #c8874f; --bad: #b5605a; --ok: #7d9a7a;
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);padding:22px 18px 60px;
    font:14px/1.65 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
  .wrap{max-width:1080px;margin:0 auto}
  header{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:18px}
  h1{font-size:19px;font-weight:600;letter-spacing:.02em;margin:0}
  .sub{color:var(--ink-3);font-size:12px}
  .spacer{flex:1}
  .badge{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;
    padding:4px 10px;border-radius:999px;background:var(--pink-soft);
    border:1px solid var(--pink-line);color:#9a6a63}
  .dot{width:6px;height:6px;border-radius:50%;background:var(--ok)}
  .dot.bad{background:var(--bad)}

  .cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:14px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;
    padding:14px 16px;box-shadow:0 1px 2px rgba(58,51,48,.03)}
  .card .k{font-size:11.5px;color:var(--ink-3);letter-spacing:.04em}
  .card .v{font-size:24px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}
  .card .v small{font-size:12px;font-weight:400;color:var(--ink-3);margin-left:3px}
  .bar{height:6px;border-radius:99px;background:#f3eeeb;overflow:hidden;margin-top:10px}
  .bar i{display:block;height:100%;border-radius:99px;
    background:linear-gradient(90deg,var(--pink),#e9c0b9);transition:width .35s}
  .bar.hard i{background:linear-gradient(90deg,#d9a06f,var(--bad))}
  .hint{font-size:11.5px;color:var(--ink-3);margin-top:7px}
  .hint.warn{color:var(--warn)}

  .grid{display:grid;grid-template-columns:minmax(0,320px) minmax(0,1fr);gap:14px;align-items:start}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:14px;
    padding:16px 18px;box-shadow:0 1px 2px rgba(58,51,48,.03);margin-bottom:14px}
  .panel h2{font-size:13px;font-weight:600;margin:0 0 12px;
    display:flex;align-items:center;gap:8px}
  .panel h2::before{content:"";width:3px;height:12px;border-radius:2px;background:var(--pink)}
  .panel h2 .tag{font-weight:400;font-size:11px;color:var(--ink-3);margin-left:auto;
    font-variant-numeric:tabular-nums}

  select{font:inherit;font-size:13px;padding:8px 10px;border:1px solid var(--line);
    border-radius:9px;background:#fffdfc;color:var(--ink);width:100%;max-width:100%}
  select:focus{outline:none;border-color:var(--pink-line);box-shadow:0 0 0 3px var(--pink-soft)}
  .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  button{font:inherit;font-size:12.5px;padding:8px 14px;border-radius:9px;cursor:pointer;
    border:1px solid var(--pink-line);background:#fff;color:#9a6a63;transition:.15s;white-space:nowrap}
  button:hover{background:var(--pink-soft)}
  button:active{transform:translateY(1px)}
  button.primary{background:var(--pink);border-color:var(--pink);color:#fff}
  button.primary:hover{background:#d99f97}
  button.ghost{border-color:var(--line);color:var(--ink-2)}

  .row{display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-bottom:1px solid #f7f2f0}
  .row:last-child{border-bottom:none}
  .row .txt{flex:1;font-size:13px;line-height:1.75;cursor:text;border-radius:6px;
    padding:2px 5px;white-space:pre-wrap;word-break:break-word}
  .row .txt:hover{background:var(--pink-soft)}
  .row .x{border:0;background:transparent;color:#d8d0cd;font-size:15px;line-height:1;cursor:pointer;
    padding:2px 6px;border-radius:6px}
  .row .x:hover{color:var(--bad);background:#fdeeee}
  .edit{width:100%;box-sizing:border-box;font:inherit;font-size:13px;line-height:1.65;
    padding:8px 10px;border:1px solid var(--pink-line);border-radius:9px;resize:vertical;background:#fffdfc}
  .edit:focus{outline:none;box-shadow:0 0 0 3px var(--pink-soft)}
  .acts{margin-top:6px;display:flex;gap:6px}
  .empty{color:var(--ink-3);font-size:12.5px;text-align:center;padding:18px 0}
  .toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,12px);
    background:rgba(58,51,48,.92);color:#fff;font-size:12.5px;padding:9px 18px;border-radius:99px;
    opacity:0;pointer-events:none;transition:.25s;z-index:9;max-width:88vw;text-align:center}
  .toast.on{opacity:1;transform:translate(-50%,0)}

  @media (max-width:820px){
    .cards{grid-template-columns:repeat(2,minmax(0,1fr))}
    .grid{grid-template-columns:minmax(0,1fr)}
    body{padding:16px 12px 50px}
  }
  @media (max-width:560px){
    header{align-items:flex-start;row-gap:6px}
    header .sub{order:3;width:100%;margin-left:0}
    header .badge{margin-left:auto}
    .card{padding:12px 13px}
    .card .v{font-size:21px}
  }
</style></head><body>
<div class="wrap">
  <header>
    <h1>滚动记忆</h1>
    <span class="sub">T1 恒定厚度 · 超限从最旧端摘行进 T2</span>
    <span class="spacer"></span>
    <span class="badge"><span class="dot" id="dot"></span><span id="modeText">连接中</span></span>
  </header>

  <section class="cards">
    <div class="card">
      <div class="k">T1 近期摘要</div>
      <div class="v"><span id="mT1">—</span><small>字</small></div>
      <div class="bar" id="t1BarWrap"><i id="t1Bar" style="width:0%"></i></div>
      <div class="hint" id="t1Hint">—</div>
    </div>
    <div class="card">
      <div class="k">T2 远期梗概</div>
      <div class="v"><span id="mT2">—</span><small>字</small></div>
      <div class="bar"><i id="t2Bar" style="width:0%"></i></div>
      <div class="hint" id="t2Hint">—</div>
    </div>
    <div class="card">
      <div class="k">待结算缓冲</div>
      <div class="v"><span id="mPend">—</span><small>条</small></div>
      <div class="hint" id="pendHint">—</div>
    </div>
    <div class="card">
      <div class="k">会话</div>
      <div class="v"><span id="mSess">—</span><small>个</small></div>
      <div class="hint" id="sessHint">—</div>
    </div>
  </section>

  <div class="grid">
    <div>
      <div class="panel">
        <h2>会话 <span class="tag">各自独立</span></h2>
        <select id="sess"><option value="">（加载中）</option></select>
        <div class="hint" style="margin-top:10px">
          换模型时新开了一个对话，这里会多一行。点开可以分别看、分别改，互不影响。
        </div>
        <div class="btns">
          <button class="ghost" id="btnRefresh">立即刷新</button>
        </div>
      </div>
      <div class="panel">
        <h2>结算流水线</h2>
        <div class="hint" id="pipe">—</div>
        <div class="hint" style="margin-top:10px">
          滑出窗口的消息先攒在这里，攒够阈值才调一次结算模型。<br>
          <b>T1</b> 超限时从最旧端机械摘行并入 <b>T2</b>；<b>T2</b> 按日期淘汰（默认 7 天）。
        </div>
      </div>
    </div>

    <div>
      <div class="panel">
        <h2>T1 近期摘要 <span class="tag" id="t1n">—</span></h2>
        <div id="t1"></div>
      </div>
      <div class="panel" id="statePanel" style="display:none">
        <h2>状态与心情 <span class="tag">点一下就地改</span></h2>
        <div id="stateBox"></div>
      </div>
      <div class="panel">
        <h2>T2 远期梗概 <span class="tag" id="t2n">—</span></h2>
        <div id="t2"></div>
      </div>
      <div class="hint">
        每行末尾的 × 删掉这一行；点文字就地改（换行会被压平、丢了开头的日期会自动补回原时间戳）。
        编辑中暂停自动刷新；改完立即落盘，结算进程下一轮自动重读。
      </div>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
var editing=false;
var cur=localStorage.getItem("rm_session")||"default";
var sessCount=0;

function esc(s){
  return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function fmt(n){ return (n==null||isNaN(n))?"—":Number(n).toLocaleString("zh-CN"); }
function toast(msg){
  var t=document.getElementById("toast");
  t.textContent=msg; t.classList.add("on");
  clearTimeout(t._h); t._h=setTimeout(function(){ t.classList.remove("on"); },1800);
}
function rowHtml(t,i,text){
  return '<div class="row" data-t="'+t+'" data-i="'+i+'">'
    +'<span class="txt" title="点一下就地改">'+esc(text)+'</span>'
    +(t==="state"?"":'<button class="x" title="删掉这一行">×</button>')
    +'</div>';
}
function linesHtml(t,arr){
  var h="",a=arr||[];
  for(var i=a.length-1;i>=0;i--) h+=rowHtml(t,i,a[i].text);
  return h||'<div class="empty">（空）</div>';
}
function qs(extra){
  var p="session="+encodeURIComponent(cur);
  return extra?p+"&"+extra:p;
}
async function api(payload){
  payload.sessionId=cur;
  var r=await fetch("/api/ledger",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
  var j={}; try{ j=await r.json(); }catch(e){}
  if(!r.ok||j.ok===false) throw new Error((j&&j.error)||("HTTP "+r.status));
  return j;
}
async function loadSessions(){
  try{
    var j=await (await fetch("/api/sessions")).json();
    var all=j.sessions||[];
    sessCount=all.length;
    var sel=document.getElementById("sess");
    var html="";
    for(var i=0;i<all.length;i++){
      var s=all[i];
      var label=(s.id==="default"?"默认会话":"自动 · "+s.id.slice(0,14))
        +(s.pending?" · 待结算 "+s.pending:"")
        +(s.updated_at?" · "+String(s.updated_at).replace("T"," ").slice(5,16):"");
      html+='<option value="'+esc(s.id)+'">'+esc(label)+'</option>';
    }
    if(!all.some(function(x){ return x.id===cur; })){
      html+='<option value="'+esc(cur)+'">'+esc(cur)+'（空）</option>';
    }
    sel.innerHTML=html||'<option value="default">默认会话</option>';
    sel.value=cur;
    document.getElementById("mSess").textContent=sessCount||"—";
    document.getElementById("sessHint").textContent=sessCount>1?("共 "+sessCount+" 份独立记忆"):"只有一份";
  }catch(e){}
}
async function tick(){
  if(editing) return;
  try{
    loadSessions();
    var s=await (await fetch("/api/state?"+qs())).json();

    var dot=document.getElementById("dot");
    var on=!!s.enabled;
    dot.className="dot"+(on?"":" bad");
    document.getElementById("modeText").textContent=on?"运行中":"已关闭";

    /* 字段名是 camelCase（stats() 给的），不是 snapshot() 的 t1_chars 那套；
       原页面写的 s.t1_max_chars 是不存在的键，所以上限一直显示成 undefined。 */
    var t1c=s.t1_chars||0, t1m=s.t1MaxChars||1500, t1l=s.t1MaxLines||16;
    var t2c=s.t2_chars||0, t2m=s.t2MaxChars||360;
    document.getElementById("mT1").textContent=fmt(t1c);
    document.getElementById("mT2").textContent=fmt(t2c);
    document.getElementById("mPend").textContent=fmt(s.pendingCount||0);
    var r1=Math.min(100,t1c/t1m*100);
    document.getElementById("t1Bar").style.width=r1+"%";
    document.getElementById("t1BarWrap").className="bar"+(r1>=90?" hard":"");
    document.getElementById("t1Hint").textContent=(s.t1_lines||[]).length+" / "+t1l+" 行 · 超 "+fmt(t1m)+" 字开始摘行";
    document.getElementById("t2Bar").style.width=Math.min(100,t2c/Math.max(t2m,1)*100)+"%";
    document.getElementById("t2Hint").textContent=(s.t2_lines||[]).length+" 行 · 上限 "+fmt(t2m)+" 字 · 7 天淘汰";
    var bc=s.bufferCount, bch=s.bufferChars;
    document.getElementById("pendHint").textContent=(s.pendingChars||0)+" 字 · 攒够 "+(bc==null?"—":bc)+" 条 / "+fmt(bch)+" 字结算";
    document.getElementById("pipe").textContent="待结算缓冲: "+(s.pendingCount||0)+" 条 / "+(s.pendingChars||0)+" 字（攒够 "+(bc==null?"—":bc)+" 条或 "+fmt(bch)+" 字自动结算）";
    document.getElementById("t1n").textContent=fmt(t1c)+" / "+fmt(t1m)+" 字";
    document.getElementById("t2n").textContent=fmt(t2c)+" 字";

    document.getElementById("t1").innerHTML=linesHtml("t1",s.t1_lines);
    document.getElementById("t2").innerHTML=linesHtml("t2",s.t2_lines);
    if(s.t1_state){
      document.getElementById("statePanel").style.display="";
      document.getElementById("stateBox").innerHTML=rowHtml("state","",s.t1_state);
    }else{
      document.getElementById("statePanel").style.display="none";
    }
    document.getElementById("modeText").title=s.model?("模型 "+s.model):"";
  }catch(e){
    document.getElementById("dot").className="dot bad";
    document.getElementById("modeText").textContent="连不上";
  }
}
function fail(e){ toast(String(e&&e.message||e)); }

document.getElementById("sess").addEventListener("change",function(ev){
  cur=ev.target.value||"default"; localStorage.setItem("rm_session",cur); editing=false; tick();
});
document.getElementById("btnRefresh").addEventListener("click",function(){ editing=false; tick(); toast("已刷新"); });
document.getElementById("t1").addEventListener("click",onClick);
document.getElementById("t2").addEventListener("click",onClick);
document.getElementById("stateBox").addEventListener("click",onClick);

async function onClick(ev){
  var row=ev.target.closest(".row"); if(!row) return;
  var t=row.getAttribute("data-t"), i=row.getAttribute("data-i");
  var span=row.querySelector(".txt"); if(!span) return;
  var text=span.textContent;
  if(ev.target.classList.contains("x")){
    if(!confirm("删掉这一行？\\n\\n"+text)) return;
    try{ await api({action:"delete",target:t,index:i}); }catch(e){ return fail(e); }
    toast("已删除"); tick(); return;
  }
  if(!ev.target.classList.contains("txt")) return;
  if(row.querySelector(".edit")) return;
  editing=true;
  row.innerHTML='<div style="flex:1"><textarea class="edit" rows="3"></textarea>'
    +'<div class="acts"><button class="primary" data-a="save">保存</button>'
    +'<button class="ghost" data-a="cancel">取消</button></div></div>';
  var ta=row.querySelector(".edit"); ta.value=text; ta.focus();
  row.querySelector('[data-a="cancel"]').onclick=function(){ editing=false; tick(); };
  row.querySelector('[data-a="save"]').onclick=async function(){
    try{ await api({action:"edit",target:t,index:t==="state"?undefined:i,text:ta.value}); }
    catch(e){ return fail(e); }
    editing=false; toast("已保存"); tick();
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
    const [url, queryStr] = (req.url || "").split("?");
    const q = new URLSearchParams(queryStr || "");
    const sid = q.get("session") || ""; // 空 = 用当前绑定的会话
    if (url === "/api/sessions") {
      sendJson(res, 200, { sessions: rolling.listSessions(), current: sid || null });
      return;
    }
    if (url === "/api/state") {
      // stats() 给运行态（模型/开关/缓冲），snapshot() 给行列表；后者覆盖同名字段
      // 不带 session 参数时固定看默认会话——不能用"当前绑定"，那是进程内的临时状态，
      // 多开两个页面就会互相把对方带跑。
      const useId = sid || rolling.DEFAULT_SESSION;
      const st = rolling.stats(useId);
      const sn = rolling.snapshot(useId);
      sendJson(res, 200, { ...st, ...sn });
      return;
    }
    if (url === "/api/ledger" && req.method === "POST") {
      const b = await readBody(req);
      if (!b) return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
      try {
        let view;
        if (b.action === "delete") view = rolling.deleteRows(b.target, { index: b.index, count: b.count, sessionId: b.sessionId });
        else if (b.action === "edit") view = rolling.editRows(b.target, b.index, b.text, b.sessionId);
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
