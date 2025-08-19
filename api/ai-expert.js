//==========================================================
//PRO AI CHAT DOCK — now with IMAGE GENERATE + BROWSE + DOWNLOAD



// api/ai-expert.js — Text Q&A API (Node serverless)
// Node runtime so we can use fs/path to read your PDF store.
export const config = { runtime: "nodejs18.x" };

import fs from "fs";
import path from "path";

// Safely read JSON for Node/Vercel (sometimes req.body isn't parsed)
async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
  } catch {
    return {};
  }
}




/* ── tiny utils ─────────────────────────────────────────────── */
function readDocsStore() {
  try {
    const p = path.join(process.cwd(), "storage", "docs.json");
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return { docs: [] };
  }
}

function corsHeaders(origin) {
  const ALLOWED = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map(s => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const o = (origin || "").replace(/\/+$/, "");
  const allow = !origin || ALLOWED.length === 0 || ALLOWED.includes(o);
  return {
    ...(allow ? { "Access-Control-Allow-Origin": origin || "*" } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
}

function withTimeout(ms = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(timer) };
}

/* ── KB ─────────────────────────────────────────────────────── */
const KB = {
  meta: { project: "Album Expert KB", version: "2025-08-13", topics: ["aavss", "sldataset"] },
  docs: [
    { id: "aavss-overview", topic: "aavss", title: "AAVSS — Overview", text:
      "AAVSS (Advanced Autonomous Vehicle Safety System) is a real-time safety and perception stack. "
      + "Focus: on-road hazard awareness, driver alerts, and research prototyping. "
      + "Core: multi-sensor fusion (LiDAR + mmWave radar + RGB cameras). "
      + "Deployment target: embedded NVIDIA Jetson platform (Nano-class) with TensorRT optimizations. "
      + "Goal latency: sub-100 ms end-to-end at 10–20 FPS depending on sensor load and model sizes."
    },
    { id:"aavss-sensors", topic:"aavss", title:"AAVSS — Sensors & Roles", text:
      "Sensors and roles:\n• LiDAR: 3D structure, range, obstacle shape, and ego-free-space estimation.\n"
      + "• mmWave radar: range + radial velocity; robust in rain/fog; complements vision for tracking.\n"
      + "• RGB camera(s): appearance cues, traffic lights/signs, lane markings, vulnerable road users.\n"
      + "Typical placements: roof/bumper LiDAR; front/rear radar; forward camera at windshield height.\n"
      + "Note: exact sensor brands/models are project-dependent; provide your SKUs here if you want the bot to name them."
    },
    // … (keep the rest of your KB docs exactly as you have them)
  ],
};

/* ── retrieval ──────────────────────────────────────────────── */
const normalize = s => (s || "").toLowerCase().replace(/[^a-z0-9\s\-_/.:]/g, " ").replace(/\s+/g, " ").trim();

function scoreDoc(qTokens, doc) {
  const text = normalize(`${doc.title} ${doc.text}`);
  let score = 0;
  for (const t of qTokens) {
    if (!t) continue;
    if (text.includes(` ${t} `) || text.startsWith(t + " ") || text.endsWith(" " + t)) score += 3;
    else if (text.includes(t)) score += 1;
  }
  if (text.includes("aavss") || text.includes("autonomous vehicle safety")) score += 1;
  if (text.includes("dataset") || text.includes("sri lanka")) score += 1;
  return score;
}

function scoreChunk(qTokens, ch) {
  const text = normalize(`${ch.title} ${ch.text}`);
  let s = 0;
  for (const t of qTokens) {
    if (!t) continue;
    if (text.includes(` ${t} `) || text.startsWith(t + " ") || text.endsWith(" " + t)) s += 3;
    else if (text.includes(t)) s += 1;
  }
  return s;
}

function detectTopic(q) {
  const n = normalize(q);
  if (/(^|\s)(aavss|fusion|radar|lidar|lane|tracking|jetson|safety|adas|tensorrt)(\s|$)/.test(n)) return "aavss";
  if (/(^|\s)(dataset|data set|sri lanka|annotation|label|split|download|license|classes)(\s|$)/.test(n)) return "sldataset";
  return "all";
}

function topK(q, k = 8, topic = "all") {
  const qTokens = normalize(q).split(" ");
  const kbPool = KB.docs.filter(d => topic === "all" ? true : (d.topic === topic || d.topic === "all"));
  const kbRanked = kbPool.map(d => ({ type: "kb", id: d.id, title: d.title, text: d.text, s: scoreDoc(qTokens, d) }));

  const store = readDocsStore();
  const pdfRanked = (store.docs || []).map(ch => ({
    type: "pdf", id: ch.id, title: ch.title, text: ch.text, page: ch.page, url: ch.url, s: scoreChunk(qTokens, ch)
  }));

  const all = kbRanked.concat(pdfRanked).filter(x => x.s > 0).sort((a,b)=>b.s-a.s).slice(0, k);
  if (!all.length) {
    if (topic === "aavss")     return KB.docs.filter(d => d.id === "aavss-overview").map(d => ({ type:"kb", id:d.id, title:d.title, text:d.text }));
    if (topic === "sldataset") return KB.docs.filter(d => d.id === "sld-overview").map(d => ({ type:"kb", id:d.id, title:d.title, text:d.text }));
    return KB.docs.filter(d => d.id === "aavss-overview" || d.id === "sld-overview").map(d => ({ type:"kb", id:d.id, title:d.title, text:d.text }));
  }
  return all;
}


/* ── providers ──────────────────────────────────────────────── */
async function askGroq({ system, user, signal }) {
  const key = process.env.GROQ_API_KEY; if (!key) throw new Error("GROQ_API_KEY not set");
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", signal,
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "llama-3.1-70b-versatile", temperature: 0.2, max_tokens: 450,
      messages: [{ role:"system", content:system }, { role:"user", content:user }] })
  });
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}: ${await r.text().catch(()=> "")}`);
  const j = await r.json(); return (j?.choices?.[0]?.message?.content ?? "").trim();
}

async function askDeepInfra({ system, user, signal }) {
  const key = process.env.DEEPINFRA_API_KEY; if (!key) throw new Error("DEEPINFRA_API_KEY not set");
  const r = await fetch("https://api.deepinfra.com/v1/openai/chat/completions", {
    method: "POST", signal,
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "meta-llama/Meta-Llama-3.1-8B-Instruct", temperature: 0.2, max_tokens: 450,
      messages: [{ role:"system", content:system }, { role:"user", content:user }] })
  });
  if (!r.ok) throw new Error(`DeepInfra HTTP ${r.status}: ${await r.text().catch(()=> "")}`);
  const j = await r.json(); return (j?.choices?.[0]?.message?.content ?? "").trim();
}

async function askGemini({ system, user, signal }) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error("GEMINI_API_KEY not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: `${system}\n\n---\n\n${user}` }] }],
                           generationConfig: { temperature: 0.2, maxOutputTokens: 450 } })
  });
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${await r.text().catch(()=> "")}`);
  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("").trim()
           || j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  return text;
}

function systemPrompt(topic) {
  return [
    "You are a professional, friendly technical assistant for an album/portfolio site.",
    "Answer ONLY from the Knowledge Base (KB) provided below. Do not invent details.",
    "If the user asks for details not in the KB (e.g., exact sensor SKUs, label counts),",
    "say they’re not specified and invite the user to provide them so we can update the KB.",
    "Format using Markdown: short paragraphs, bullets for lists, and **bold** key terms.",
    `Topic focus: ${topic}. Keep to one topic unless user explicitly asks to compare.`,
  ].join(" ");
}

function userPrompt(question, ctx) {
  return [
    "KB:",
    '"""', ctx, '"""', "",
    `User question: ${question}`, "",
    "Instructions:",
    "- Use only KB facts. If unknown, say so briefly and suggest adding the info.",
    "- Prefer specific, actionable guidance (pipelines, calibration, metrics, safety).",
    "- Maintain a friendly, confident, human tone. No speculation.",
  ].join("\n");
}

/* ── HTTP handler (Node style) ──────────────────────────────── */
export default async function handler(req, res) {
  const origin  = req.headers.origin || "*";
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") { res.writeHead(204, headers); res.end(); return; }
  if (req.method !== "POST")    { res.writeHead(405, headers); res.end(JSON.stringify({ error: "Only POST supported" })); return; }

  try {
    // 🔧 NEW: robust body parsing
    const body = await readJson(req);
    const rawQ = (body?.question ?? body?.q ?? body?.text ?? "").toString();
    const question = rawQ.trim();

    if (!question) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: "Missing question" }));
      return;
    }

    // Build KB+PDF context
    const topic       = detectTopic(question);
    const { ctx, ids } = buildContext(question, topic);

    const sys = systemPrompt(topic);
    const usr = userPrompt(question, ctx);

    // Provider fallback: Groq → DeepInfra → Gemini
    let answer = "", provider = "";
    const providers = [
      { name: "groq",      fn: askGroq },
      { name: "deepinfra", fn: askDeepInfra },
      { name: "gemini",    fn: askGemini },
    ];

    for (const p of providers) {
      try {
        const t = withTimeout(30_000);
        answer   = await p.fn({ system: sys, user: usr, signal: t.signal });
        t.clear();
        provider = p.name;
        if (answer) break;
      } catch { /* try next */ }
    }

    // Final fallback: stitched KB if all providers fail
    if (!answer) {
      const stitched = ids.map((id, i) => {
        const [kind, rest] = id.split(":");
        if (kind === "kb") {
          const kbId = rest.split("|")[0];
          const d = KB.docs.find(x => x.id === kbId);
          return d ? `(${i + 1}) ${d.title}\n${d.text}` : "";
        }
        if (kind === "pdf") {
          const title = rest.split("|")[0];
          return `(${i + 1}) ${title} (from PDF)`;
        }
        return "";
      }).filter(Boolean).join("\n\n");

      answer   = ["I couldn’t reach the AI providers just now. Here’s a concise KB summary:", "", stitched || "No KB matches found."].join("\n");
      provider = "kb-fallback";
    }

    answer = answer.trim().replace(/\n{3,}/g, "\n\n");

    res.writeHead(200, headers);
    res.end(JSON.stringify({ answer, provider, topic, sources: ids }));
  } catch (err) {
    const msg = err?.name === "AbortError" ? "Upstream request timed out" : (err?.message || "Server error");
    res.writeHead(500, headers);
    res.end(JSON.stringify({ error: msg }));
  }
}























/* ==========================================================
   PRO AI CHAT DOCK — now with IMAGE GENERATE + BROWSE + DOWNLOAD
   (Non-destructive: adds to your site; keeps all existing features)
   ========================================================== */
(function ProAiChatDock(){
  /* ---------- tiny helpers ---------- */
  const $ = (s,p=document)=>p.querySelector(s);
  const clamp = (v,min,max)=>Math.max(min,Math.min(max,v));
  const md = (t)=> (typeof mdToHtml === 'function' ? mdToHtml(t) : (t||''));
  const API_IMG = `${API_BASE}/api/img`;   // new endpoint provided below

  /* ---------- styles ---------- */
  const css = `
  #aiFab{
    position: fixed; right: 18px; bottom: 18px; z-index: 9999;
    width: 54px; height: 54px; border-radius: 999px; border:1px solid rgba(150,190,255,.25);
    display:flex; align-items:center; justify-content:center; cursor:pointer;
    font-size:22px; user-select:none; backdrop-filter: blur(6px);
    transition: transform .12s ease, box-shadow .2s ease, background .2s ease;
    box-shadow: 0 12px 26px rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.06);
    background: linear-gradient(180deg, #0e1420, #0b111a);
    color:#E7F0FF;
  }
  body.is-light #aiFab{
    background: linear-gradient(180deg, #F3F7FF, #EDF3FF);
    color:#1F3B63; border-color:#86aef2;
    box-shadow: 0 10px 22px rgba(0,0,0,.15), inset 0 0 0 1px rgba(255,255,255,.85);
  }
  #aiFab:hover{ transform: translateY(-2px); }

  #aiDock{
    position: fixed; right: 16px; bottom: 84px; z-index: 9999;
    width: min(760px, 94vw); max-height: min(78vh, 820px);
    border-radius: 16px; overflow: hidden; display:none; flex-direction: column;
    border:1px solid rgba(150,190,255,.25);
    background: rgba(12,16,24,.96);
    box-shadow: 0 18px 38px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,255,255,.06);
    backdrop-filter: blur(10px);
  }
  body.is-light #aiDock{
    background: rgba(250,252,255,.96);
    border-color:#86aef2; box-shadow: 0 12px 28px rgba(0,0,0,.12), inset 0 0 0 1px rgba(255,255,255,.85);
  }

  .ai-head{
    display:flex; align-items:center; gap:.75rem; padding:12px 14px;
    border-bottom:1px solid rgba(150,190,255,.18);
  }
  .ai-head .title{
    font-family:'Orbitron',system-ui; font-weight:700; letter-spacing:.02em;
    display:flex; align-items:center; gap:.5rem;
  }
  .ai-head .title .dot{ width:8px; height:8px; border-radius:999px; background:#8dd17a; box-shadow:0 0 8px #8dd17a; }
  .ai-head .actions{ margin-left:auto; display:flex; gap:.4rem; }
  .ai-btn{
    border:1px solid rgba(150,190,255,.22); background:transparent; color:inherit;
    padding:6px 10px; border-radius:10px; font-size:.9rem; cursor:pointer;
  }

  .ai-body{ display:flex; flex-direction:column; gap:10px; padding:12px 14px; overflow:auto; min-height:220px; }
  .ai-msg{ max-width:92%; border:1px solid rgba(255,255,255,.08); border-radius:14px; padding:10px 12px; line-height:1.5; }
  .ai-msg.user{ margin-left:auto; background:rgba(120,170,255,.12); }
  .ai-msg.bot { background:#0e1a24; color:#e9f2f9; }
  body.is-light .ai-msg.bot { background:#f0f5ff; color:#1b2b45; border-color:rgba(0,0,0,.06); }
  .ai-msg .imggrid{ display:grid; grid-template-columns: repeat(auto-fill, minmax(160px,1fr)); gap:10px; margin-top:10px; }
  .ai-card{
    position:relative; border-radius:12px; overflow:hidden; border:1px solid rgba(255,255,255,.08);
  }
  .ai-card img{ width:100%; height:160px; object-fit:cover; display:block; }
  .ai-card .bar{
    position:absolute; left:0; right:0; bottom:0; display:flex; gap:6px; padding:6px;
    background:linear-gradient(180deg, rgba(0,0,0,.00), rgba(0,0,0,.55));
  }
  .ai-mini{ border:1px solid rgba(255,255,255,.45); background:rgba(0,0,0,.35); color:#fff;
            padding:4px 8px; border-radius:999px; font-size:.78rem; cursor:pointer; }
  body.is-light .ai-mini{ background:rgba(255,255,255,.75); color:#1b2b45; border-color:rgba(0,0,0,.15); }

  .ai-suggest{ display:flex; flex-wrap:wrap; gap:8px; padding:0 14px 10px; }
  .ai-chip{ border:1px dashed rgba(150,190,255,.35); padding:6px 10px; border-radius:999px; cursor:pointer; }
  body.is-light .ai-chip{ border-color:#86aef2; }

  .ai-input{
    display:grid; grid-template-columns: 1fr auto auto; gap:8px; padding:12px 14px; border-top:1px solid rgba(150,190,255,.18);
  }
  .ai-input input{
    width:100%; border-radius:12px; border:1px solid rgba(150,190,255,.22);
    background: transparent; color: inherit; padding:10px 12px; outline:none;
  }
  .ai-send, .ai-mic{
    border:1px solid rgba(150,190,255,.22); background:transparent; color:inherit; padding:8px 12px; border-radius:12px; cursor:pointer;
  }
  .ai-mic.rec{ box-shadow:0 0 0 3px rgba(255,0,0,.25) inset; }
  @media (max-width: 520px){
    #aiDock{ right:10px; left:10px; width:auto; bottom:76px; }
  }`;
  const style = document.createElement('style'); style.id = 'pro-ai-dock-css'; style.textContent = css;
  document.head.appendChild(style);

  /* ---------- structure ---------- */
  const fab = document.createElement('button');
  fab.id = 'aiFab'; fab.type = 'button'; fab.title = 'Open assistant'; fab.innerHTML = '🤖';
  document.body.appendChild(fab);

  const dock = document.createElement('section'); dock.id = 'aiDock'; dock.setAttribute('aria-live','polite');
  dock.innerHTML = `
    <div class="ai-head">
      <div class="title"><span class="dot"></span><span>Assistant</span></div>
      <div class="actions">
        <button class="ai-btn" id="aiGenBtn" title="Generate images">Generate</button>
        <button class="ai-btn" id="aiBrowseBtn" title="Browse images">Browse</button>
        <button class="ai-btn" id="aiClear">Clear</button>
        <button class="ai-btn" id="aiMin">Minimize</button>
      </div>
    </div>
    <div class="ai-body" id="aiBody"></div>
    <div class="ai-suggest" id="aiSuggest"></div>
    <div class="ai-input">
      <input id="aiInput" type="text" placeholder="Ask anything… (e.g., What is AAVSS?  or  /gen a rainy highway at night)">
      <button class="ai-mic" id="aiMic" title="Voice"></button>
      <button class="ai-send" id="aiSend">Send</button>
    </div>`;
  document.body.appendChild(dock);

  const bodyEl = $('#aiBody', dock);
  const sugEl  = $('#aiSuggest', dock);
  const inp    = $('#aiInput', dock);
  const micBtn = $('#aiMic', dock);
  const send   = $('#aiSend', dock);
  const clearB = $('#aiClear', dock);
  const minB   = $('#aiMin', dock);
  const genB   = $('#aiGenBtn', dock);
  const browseB= $('#aiBrowseBtn', dock);

  /* ---------- local session memory ---------- */
  const MEMKEY = 'aiDockHistory';
  function loadHistory(){ try{ return JSON.parse(sessionStorage.getItem(MEMKEY)||'[]'); }catch{ return []; } }
  function saveHistory(h){ try{ sessionStorage.setItem(MEMKEY, JSON.stringify(h.slice(-24))); }catch{} }
  let history = loadHistory();

  /* ---------- render helpers ---------- */
  function appendMsg(role, text, {html=false, images=[]}={}){
    const el = document.createElement('div');
    el.className = `ai-msg ${role}`;
    el.innerHTML = html ? text : md(text);
    if (images && images.length){
      const grid = document.createElement('div'); grid.className='imggrid';
      images.forEach((img)=> grid.appendChild(makeImgCard(img)));
      el.appendChild(grid);
    }
    bodyEl.appendChild(el); bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  function makeImgCard(img){
    // img: { url, thumb?, source?, filename? }
    const card = document.createElement('div'); card.className='ai-card';
    const im = new Image();
    im.src = img.thumb || img.url; im.loading='lazy'; card.appendChild(im);
    const bar = document.createElement('div'); bar.className='bar';
    const open = document.createElement('button'); open.className='ai-mini'; open.textContent='Open';
    const dl = document.createElement('button'); dl.className='ai-mini'; dl.textContent='Download';
    open.onclick = ()=> window.open(img.url, '_blank', 'noopener');
    dl.onclick = ()=> downloadImage(img.url, img.filename || 'image.jpg');
    bar.appendChild(open); bar.appendChild(dl);
    card.appendChild(bar);
    return card;
  }
  async function downloadImage(url, filename){
    try{
      const r = await fetch(url, { mode: 'cors' });
      const b = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = filename || 'image.jpg';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=> URL.revokeObjectURL(a.href), 1500);
    }catch{
      // Fallback: open in new tab
      window.open(url, '_blank', 'noopener');
    }
  }

  function showGreeting(){
    if (history.length) return;
    appendMsg('bot', `Hey! I’m your album assistant.  
Ask about **AAVSS**, the **Sri Lankan dataset**, or say **/gen** to create images.  
Try: **/browse rainy highway** to fetch reference photos.`);
    showSuggestions('general');
  }
  function showSuggestions(topic='general'){
    const base = [
      {t:'Overview', q:'Give me a quick overview.'},
      {t:'How it works?', q:'How does it work end-to-end?'},
      {t:'Specs', q:'Share the main specs.'},
      {t:'Generate image', q:'/gen photoreal car on a rainy Colombo street, night, headlights reflections'},
      {t:'Browse images', q:'/browse rainy highway night'}
    ];
    const aav = [
      {t:'Sensors', q:'What sensors are used and why?'},
      {t:'Fusion',  q:'Explain the fusion pipeline.'},
      {t:'Safety',  q:'What safety analytics do you run?'},
      {t:'Generate image', q:'/gen driver monitoring HUD alert, photoreal cockpit'}
    ];
    const dset = [
      {t:'License', q:'What license and distribution do you use?'},
      {t:'Annotations', q:'What are the annotation types & metrics?'},
      {t:'Night driving', q:'How is the dataset for night driving?'},
      {t:'Browse images', q:'/browse sri lanka urban rain driving'}
    ];
    const list = topic==='aavss' ? aav : topic==='sldataset' ? dset : base;
    sugEl.innerHTML = '';
    list.forEach(({t,q})=>{
      const b=document.createElement('button'); b.className='ai-chip'; b.textContent=t;
      b.onclick=()=>{ inp.value=q; send.click(); }; sugEl.appendChild(b);
    });
  }

  function detectSmallTalk(q){
    return /\b(hi|hello|hey|how are you|what's up|good (morning|evening)|thanks?|bye)\b/i.test(q);
  }
  function detectTopicLocal(q){
    const s=q.toLowerCase();
    const aHits = /(aavss|fusion|radar|lidar|lane|tracking|jetson|adas|safety|tensorrt)/.test(s);
    const dHits = /(dataset|data set|sri lanka|annotation|label|split|download|license|classes|night driving)/.test(s);
    if (aHits && !dHits) return 'aavss';
    if (dHits && !aHits) return 'sldataset';
    return 'general';
  }
  function albumImages(max=8){
    if (!window.currentAlbum || !Array.isArray(currentAlbum.media)) return [];
    return currentAlbum.media.filter(m=>m.type==='image').slice(0,max).map(m=>({url:m.src, thumb:m.src}));
  }

  /* ---------- backend calls ---------- */
  async function apiImgGenerate({prompt, n=2, aspect='16:9', realism='photo', seed=null}){
    const r = await fetch(API_IMG, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ mode:'generate', prompt, n, aspect, realism, seed })
    });
    const j = await r.json().catch(()=> ({}));
    if (!r.ok) throw new Error(j.error || 'Generation failed');
    // returns { images:[{url, thumb?, filename?}], provider, meta }
    return j;
  }
  async function apiImgSearch({query, n=8}){
    const r = await fetch(API_IMG, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ mode:'search', query, n })
    });
    const j = await r.json().catch(()=> ({}));
    if (!r.ok) throw new Error(j.error || 'Search failed');
    // returns { images:[{url, thumb, source, author}], provider }
    return j;
  }

  /* ---------- routes ---------- */
  function isGenCommand(q){ return /^\/?gen\b/i.test(q) || /^generate\b/i.test(q); }
  function isBrowseCommand(q){ return /^\/?browse\b/i.test(q) || /^(find|search)\b.+(image|photo)/i.test(q); }

  async function route(q){
    // render user
    appendMsg('user', q); history.push({role:'user', content:q}); saveHistory(history);

    try{
      if (isGenCommand(q)) {
        const prompt = q.replace(/^\/?gen(?:erate)?\s*/i,'').trim() || await promptForGen();
        if (!prompt) return;
        await doGenerateFlow(prompt);
        return;
      }
      if (isBrowseCommand(q)) {
        const query = q.replace(/^\/?browse\s*/i,'').trim() || q.replace(/^(find|search)\s*/i,'').trim();
        await doBrowseFlow(query);
        return;
      }

      // not image-specific → text Q&A
      const topic = detectTopicLocal(q);
      let answer = '';
      try{
        if (detectSmallTalk(q)) {
          const ctx = typeof buildAlbumContext === 'function' ? buildAlbumContext(window.currentAlbum || null) : '';
          answer = await aiAsk(q, ctx);
        } else {
          const recent = history.slice(-6);
          const prefix = recent.length
            ? 'Previous context:\n' + recent.map(m=>`${m.role==="user"?"Q":"A"}: ${m.content}`).join('\n') + '\n---\n'
            : '';
          answer = await expertAsk(prefix + q);
        }
      }catch(_){
        const ctx = typeof buildAlbumContext === 'function' ? buildAlbumContext(window.currentAlbum || null) : '';
        answer = await aiAsk(q, ctx);
      }
      appendMsg('bot', answer);
      history.push({role:'assistant', content:answer}); saveHistory(history);
      showSuggestions(topic);

      if (/show (me )?images/i.test(q)) {
        const imgs = albumImages(8);
        if (imgs.length) appendMsg('bot', 'Here are a few images from this album:', {images: imgs});
      }
    }catch(err){
      appendMsg('bot', `Sorry — ${err.message || 'something went wrong.'}`);
    }
  }

  /* ---------- image flows ---------- */
  async function promptForGen(){
    // inline mini form bubble
    const id = 'genform_'+Date.now();
    const html = `
      <div>
        <div style="font-weight:700;margin-bottom:6px">Generate photoreal image</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">
          <input id="${id}_prompt" placeholder="Describe the image (e.g., rainy highway at night, reflections)">
          <select id="${id}_aspect" title="Aspect">
            <option value="1:1">1:1</option>
            <option value="16:9" selected>16:9</option>
            <option value="9:16">9:16</option>
            <option value="4:3">4:3</option>
          </select>
          <select id="${id}_n" title="Count">
            <option>1</option><option selected>2</option><option>3</option><option>4</option>
          </select>
          <select id="${id}_realism" title="Style">
            <option value="photo" selected>Photoreal</option>
            <option value="cinematic">Cinematic</option>
            <option value="studio">Studio</option>
          </select>
        </div>
        <button class="ai-mini" id="${id}_go">Generate</button>
      </div>`;
    appendMsg('bot', html, {html:true});
    const go = document.getElementById(`${id}_go`);
    return new Promise(resolve=>{
      go.onclick = ()=>{
        const prompt = (document.getElementById(`${id}_prompt`).value||'').trim();
        const aspect = document.getElementById(`${id}_aspect`).value;
        const n = clamp(parseInt(document.getElementById(`${id}_n`).value,10)||2,1,4);
        const realism = document.getElementById(`${id}_realism`).value;
        if (!prompt){ resolve(''); return; }
        // stash structured command back into input history
        history.push({role:'user', content:`/gen ${prompt} [${aspect}, ${n}, ${realism}]`}); saveHistory(history);
        resolve(JSON.stringify({prompt, aspect, n, realism}));
      };
    }).then(v=>{
      try{ const o = JSON.parse(v); return `${o.prompt}|||${o.aspect}|||${o.n}|||${o.realism}`; }catch{ return v; }
    });
  }

  async function doGenerateFlow(promptOrPacked){
    let prompt = promptOrPacked, aspect='16:9', n=2, realism='photo';
    if (promptOrPacked.includes('|||')) {
      const [p,a,c,r] = promptOrPacked.split('|||'); prompt=p; aspect=a; n=parseInt(c,10)||2; realism=r||'photo';
    }
    appendMsg('bot', `Generating **${prompt}** …`);
    const res = await apiImgGenerate({prompt, n, aspect, realism});
    if (!res?.images?.length){ appendMsg('bot','No images returned.'); return; }
    appendMsg('bot', `Here you go${res.provider ? ` _(provider: ${res.provider})_` : ''}:`, {images: res.images});
  }

  async function doBrowseFlow(query){
    const q = (query||'').trim(); if (!q){ appendMsg('bot','What should I search?'); return; }
    appendMsg('bot', `Searching images for **${q}** …`);
    const res = await apiImgSearch({query:q, n: 12});
    if (!res?.images?.length){ appendMsg('bot','No results. Try a different query.'); return; }
    appendMsg('bot', `Top matches${res.provider ? ` _(source: ${res.provider})_` : ''}:`, {images: res.images});
  }

  /* ---------- voice input ---------- */
  let rec=null, recActive=false;
  function setupMic(){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR){ micBtn.style.display='none'; return; }
    rec = new SR(); rec.lang = 'en-US'; rec.continuous=false; rec.interimResults=false;
    rec.onresult = (e)=> {
      const txt = (e.results?.[0]?.[0]?.transcript || '').trim();
      if (txt){ inp.value = txt; send.click(); }
    };
    rec.onend = ()=> { recActive=false; micBtn.classList.remove('rec'); };
  }
  setupMic();

  /* ---------- wiring ---------- */
  function openDock(){ dock.style.display='flex'; setTimeout(()=>inp.focus(), 10); showGreeting(); }
  function closeDock(){ dock.style.display='none'; }
  fab.addEventListener('click', openDock);
  minB.addEventListener('click', closeDock);
  clearB.addEventListener('click', ()=>{
    history = []; saveHistory(history); bodyEl.innerHTML=''; sugEl.innerHTML=''; showGreeting();
  });
  send.addEventListener('click', ()=>{ const q=(inp.value||'').trim(); if(!q) return; inp.value=''; route(q); });
  inp.addEventListener('keydown', (e)=> { if (e.key==='Enter') send.click(); });
  micBtn.addEventListener('click', ()=>{
    if (!rec) return;
    try{
      if (!recActive){ recActive=true; micBtn.classList.add('rec'); rec.start(); }
      else { rec.stop(); recActive=false; micBtn.classList.remove('rec'); }
    }catch(_){}
  });

  genB.addEventListener('click', async ()=> {
    const packed = await promptForGen();
    if (packed) await doGenerateFlow(packed);
  });
  browseB.addEventListener('click', async ()=>{
    const q = (prompt('Browse images for…', 'rainy highway night')||'').trim();
    if (q) await doBrowseFlow(q);
  });

})();















  // 1) KB docs (existing)
  const kbPool = KB.docs.filter(d => topic==='all' ? true : (d.topic === topic || d.topic === 'all'));
  const kbRanked = kbPool.map(d => ({ type:'kb', id:d.id, title:d.title, text:d.text, s: scoreDoc(qTokens, d) }));

  // 2) PDF chunks (dynamic)
  const store = readDocsStore();
  const pdfRanked = (store.docs || []).map(ch => ({
    type:'pdf',
    id: ch.id,
    title: ch.title,
    text: ch.text,
    page: ch.page,
    url: ch.url,
    s: scoreChunk(qTokens, ch)
  }));

  // Merge + sort
  const all = kbRanked.concat(pdfRanked).filter(x => x.s > 0).sort((a,b)=>b.s-a.s).slice(0, k);

  // Fallback to KB overview if nothing
  if (!all.length) {
    if (topic === 'aavss')     return KB.docs.filter(d => d.id === 'aavss-overview').map(d => ({ type:'kb', id:d.id, title:d.title, text:d.text }));
    if (topic === 'sldataset') return KB.docs.filter(d => d.id === 'sld-overview').map(d => ({ type:'kb', id:d.id, title:d.title, text:d.text }));
    const f = KB.docs.filter(d => d.id === 'aavss-overview' || d.id === 'sld-overview');
    return f.map(d => ({ type:'kb', id:d.id, title:d.title, text:d.text }));
  }
  return all;
}

function buildContext(q, topic='all'){
  const k = topK(q, 8, topic);
  const ctx = k.map((d,i)=>`#${i+1} ${d.title}\n${d.text}`).join('\n\n');
  // ID format: keep both; include page+url when from pdf so you can show citations
  const ids = k.map(d => d.type === 'pdf'
    ? `pdf:${d.id}|${d.title}|page=${d.page}|${d.url}`
    : `kb:${d.id}|${d.title}`
  );
  return { ctx, ids };
}
