// api/ai-expert.js — Edge Function (Groq → DeepInfra → Gemini) with KB + Topic-Aware Retrieval
export const config = { runtime: 'edge' };

/* ───────────────────────────── CORS ───────────────────────────── */
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

function corsHeaders(origin) {
  const o = (origin || '').replace(/\/+$/, '');
  const allow = (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(o));
  return {
    ...(allow ? { 'Access-Control-Allow-Origin': origin || '*' } : {}),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
}

function withTimeout(ms = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(timer) };
}

/* ─────────────────────── Knowledge Base ─────────────────────── */
const KB = {
  meta: { project: 'Album Expert KB', version: '2025-08-13', topics: ['aavss', 'sldataset'] },
  docs: [
    // ===== AAVSS =====
    { id:'aavss-overview', topic:'aavss', title:'AAVSS — Overview', text:[
      'AAVSS (Advanced Autonomous Vehicle Safety System) is a real-time safety and perception stack.',
      'Focus: on-road hazard awareness, driver alerts, and research prototyping.',
      'Core: multi-sensor fusion (LiDAR + mmWave radar + RGB cameras).',
      'Deployment target: embedded NVIDIA Jetson platform (Nano-class) with TensorRT optimizations.',
      'Goal latency: sub-100 ms end-to-end at 10–20 FPS depending on sensor load and model sizes.',
    ].join(' ') },
    { id:'aavss-sensors', topic:'aavss', title:'AAVSS — Sensors & Roles', text:[
      'Sensors and roles:',
      '• LiDAR: 3D structure, range, obstacle shape, and ego-free-space estimation.',
      '• mmWave radar: range + radial velocity; robust in rain/fog; complements vision for tracking.',
      '• RGB camera(s): appearance cues, traffic lights/signs, lane markings, vulnerable road users.',
      'Typical placements: roof/bumper LiDAR; front/rear radar; forward camera at windshield height.',
      'Note: exact sensor brands/models are project-dependent; provide your SKUs here if you want the bot to name them.',
    ].join('\n') },
    { id:'aavss-sensor-details', topic:'aavss', title:'AAVSS — Sensor Practicals', text:[
      'Sampling hints:',
      '• Camera: 30 FPS (1080p/720p), auto-exposure locked for stability where possible.',
      '• Radar: 10–20 Hz object lists; raw Cube optional if DSP available.',
      '• LiDAR: 10–20 Hz spins; timestamped point clouds.',
      'Sync & timebase: PTP or PPS preferred; otherwise robust NTP + software sync.',
      'Calibration: camera intrinsics (OpenCV), camera–LiDAR extrinsics (chessboard/AprilTag board), radar extrinsics (mount geometry + track alignment).',
    ].join('\n') },
    { id:'aavss-fusion', topic:'aavss', title:'AAVSS — Fusion & Tracking', text:[
      'Fusion pipeline (typical):',
      '1) Per-sensor detection: vision detector (YOLO-class), lane segmentation (ENet/SegNet-class), radar object list, LiDAR clustering/ground removal.',
      '2) Association: nearest-neighbor or Hungarian with gating (position/velocity/appearance).',
      '3) Tracking: Kalman/UKF per-object with track lifecycle (birth, confirm, occlusion, delete).',
      '4) Late/object-level fusion output: unified obstacle list with confidence and kinematics.',
      '5) Free-space: LiDAR ground segmentation + camera semantics (optional) for drivable area.',
    ].join('\n') },
    { id:'aavss-safety-analytics', topic:'aavss', title:'AAVSS — Safety Analytics', text:[
      'Safety analytics:',
      '• Forward Collision Warning (FCW): time-to-collision thresholds and braking envelope.',
      '• Pedestrian & cyclist awareness: proactive alerts within configurable distance cones.',
      '• Blind-spot hints: side radar/camera occupancy.',
      '• Road surface & weather robustness: radar aids vision in rain/fog/night.',
      'UI: concise HUD prompts; audio haptics optional.',
    ].join('\n') },
    { id:'aavss-compute', topic:'aavss', title:'AAVSS — Compute & Optimization', text:[
      'Compute: NVIDIA Jetson Nano-class (Maxwell 128-core GPU) with 4 GB RAM.',
      'Optimizations: TensorRT FP16/INT8 where available, layer fusion, smaller backbones.',
      'Pipelines: zero-copy camera capture; ring-buffer LiDAR; batched radar lists; pinned memory.',
      'Budget: keep total GPU <80% and CPU <70% to leave headroom for bursts.',
    ].join('\n') },
    { id:'aavss-testing', topic:'aavss', title:'AAVSS — Testing & Metrics', text:[
      'Offline eval: mAP@50 for detectors, MOTA/MOTP for tracking, lane IoU/F1 for segmentation.',
      'Online eval: end-to-end latency, missed detection rate, false alert rate, alert lead time.',
      'Scenario coverage: day/night, rain, fog, urban congestion, rural roads, highways.',
    ].join('\n') },
    { id:'aavss-limitations', topic:'aavss', title:'AAVSS — Limitations & Roadmap', text:[
      'Known limitations (generic): heavy rain can degrade camera; LiDAR can saturate in snow; radar ghosting near metallic infrastructure.',
      'Roadmap (example): thermal camera night boost; radar-only fallback mode; improved ego-lane topology; HD map hooks.',
    ].join('\n') },

    // ===== Sri Lankan Dataset =====
    { id:'sld-overview', topic:'sldataset', title:'Sri Lankan Autonomous Driving Dataset — Overview', text:[
      'Dataset theme: left-hand traffic, dense mixed fleets (tuk-tuks, buses, bikes), varied weather (sun, rain, fog), and narrow urban roads.',
      'Intended use: perception research (detection, tracking, lane, sign recognition) and domain adaptation for South Asian roads.',
    ].join(' ') },
    { id:'sld-collection', topic:'sldataset', title:'Dataset — Collection & Modalities', text:[
      'Modalities (typical design): forward-facing RGB video (1080p/30), optional side cams, GPS/IMU metadata.',
      'Conditions: day, night, rain, fog; urban cores and suburban/rural connectors.',
      'Note: Replace with exact camera makes, resolutions, mount heights, and routes when finalized.',
    ].join('\n') },
    { id:'sld-annotations', topic:'sldataset', title:'Dataset — Annotations', text:[
      'Annotations (typical plan):',
      '• Object 2D boxes: vehicles, buses, tuk-tuks, trucks, bikes, pedestrians, animals.',
      '• Lane markings: polylines with type (dashed, solid) when available.',
      '• Traffic signs/lights: category and state (e.g., red/yellow/green).',
      '• Frame tags: weather, time-of-day, road type.',
      'Please fill in exact annotation specs and tooling (e.g., CVAT/Label Studio) when locked.',
    ].join('\n') },
    { id:'sld-splits-metrics', topic:'sldataset', title:'Dataset — Splits & Metrics', text:[
      'Recommended splits: train/val/test with route-level separation to minimize leakage.',
      'Metrics: mAP@50 for detection, class-wise F1, lane IoU/F1; publish per-condition breakdowns.',
    ].join('\n') },
    { id:'sld-distribution', topic:'sldataset', title:'Dataset — Distribution & License', text:[
      'Distribution: downloadable packages per city/condition; checksum manifests.',
      'License: research-friendly; contact maintainers for commercial terms.',
      'Citations: include BibTeX when public.',
    ].join('\n') },
    { id:'sld-uniques', topic:'sldataset', title:'Dataset — Sri Lanka Specifics', text:[
      'Distinctives: left-hand traffic, dense bus corridors, tuk-tuk behavior, frequent unprotected turns, zebra crossings without signals, occasional animal crossings.',
      'Signage/lingual: Sinhala/Tamil/English; ensure label taxonomy includes local sign classes.',
    ].join('\n') },

    // ===== Cross-topic policy =====
    { id:'qa-sensors-unknown-models', topic:'aavss', title:'Q&A — Sensor Models Policy', text:[
      'If asked for exact sensor brands/models and they are not listed in this KB, reply that specific SKUs are not provided in the project notes.',
      'Offer to integrate them if the user shares the list.',
    ].join(' ') },
    { id:'qa-where-to-add-specifics', topic:'all', title:'Q&A — How to Add Specifics', text:[
      'To increase precision, add concrete facts (sensor SKUs, camera resolution, miles of data, label counts) into the KB docs above.',
      'The assistant will strictly answer from KB, preventing hallucinations.',
    ].join(' ') },
  ],
};

/* ───────────────────── Retrieval Utilities ───────────────────── */
function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s\-_/.:]/g, ' ').replace(/\s+/g, ' ').trim();
}
function scoreDoc(qTokens, doc) {
  const text = normalize(`${doc.title} ${doc.text}`); let score = 0;
  for (const t of qTokens) {
    if (!t) continue;
    if (text.includes(` ${t} `) || text.startsWith(t + ' ') || text.endsWith(' ' + t)) score += 3;
    else if (text.includes(t)) score += 1;
  }
  if (text.includes('aavss') || text.includes('autonomous vehicle safety')) score += 1;
  if (text.includes('dataset') || text.includes('sri lanka')) score += 1;
  return score;
}
function detectTopic(q) {
  const n = normalize(q);
  if (/(^|\s)(aavss|fusion|radar|lidar|lane|tracking|jetson|safety|adas|tensorrt)(\s|$)/.test(n)) return 'aavss';
  if (/(^|\s)(dataset|data set|sri lanka|annotation|label|split|download|license|classes)(\s|$)/.test(n)) return 'sldataset';
  return 'all';
}
function topK(q, k = 8, topic = 'all') {
  const qTokens = normalize(q).split(' ');
  const pool = KB.docs.filter(d => topic==='all' ? true : (d.topic === topic || d.topic === 'all'));
  const ranked = pool.map(d => ({ d, s: scoreDoc(qTokens, d) }))
    .filter(x => x.s > 0).sort((a,b)=>b.s-a.s).slice(0,k).map(x=>x.d);

  if (ranked.length === 0) {
    if (topic === 'aavss')     return KB.docs.filter(d => d.id === 'aavss-overview');
    if (topic === 'sldataset') return KB.docs.filter(d => d.id === 'sld-overview');
    return KB.docs.filter(d => d.id === 'aavss-overview' || d.id === 'sld-overview');
  }
  return ranked;
}
function buildContext(q, topic='all'){
  const k = topK(q, 8, topic);
  const ctx = k.map((d,i)=>`#${i+1} ${d.title}\n${d.text}`).join('\n\n');
  const ids = k.map(d=>d.id);
  return { ctx, ids };
}

/* ───────────────────── Providers (Text) ───────────────────── */
async function askGroq({ system, user, signal }) {
  const key = process.env.GROQ_API_KEY; if (!key) throw new Error('GROQ_API_KEY not set');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-70b-versatile',
      temperature: 0.2, max_tokens: 450,
      messages: [{ role:'system', content:system }, { role:'user', content:user }],
    }),
  });
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}: ${await r.text().catch(()=> '')}`);
  const j = await r.json(); return (j?.choices?.[0]?.message?.content ?? '').trim();
}
async function askDeepInfra({ system, user, signal }) {
  const key = process.env.DEEPINFRA_API_KEY; if (!key) throw new Error('DEEPINFRA_API_KEY not set');
  const r = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', {
    method: 'POST', signal,
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
      temperature: 0.2, max_tokens: 450,
      messages: [{ role:'system', content:system }, { role:'user', content:user }],
    }),
  });
  if (!r.ok) throw new Error(`DeepInfra HTTP ${r.status}: ${await r.text().catch(()=> '')}`);
  const j = await r.json(); return (j?.choices?.[0]?.message?.content ?? '').trim();
}
async function askGemini({ system, user, signal }) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${system}\n\n---\n\n${user}` }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 450 },
    }),
  });
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${await r.text().catch(()=> '')}`);
  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('').trim() ||
               j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  return text;
}

/* ───────────────────── Prompt Construction ───────────────────── */
function systemPrompt(topic) {
  return [
    'You are a professional, friendly technical assistant for an album/portfolio site.',
    'Answer ONLY from the Knowledge Base (KB) provided below. Do not invent details.',
    'If the user asks for details not in the KB (e.g., exact sensor SKUs, label counts),',
    "say they’re not specified and invite the user to provide them so we can update the KB.",
    'Format using Markdown: short paragraphs, bullets for lists, and **bold** key terms.',
    `Topic focus: ${topic}. Keep to one topic unless user explicitly asks to compare.`,
  ].join(' ');
}
function userPrompt(question, ctx) {
  return [
    'KB:',
    '"""', ctx, '"""', '',
    `User question: ${question}`, '',
    'Instructions:',
    '- Use only KB facts. If unknown, say so briefly and suggest adding the info.',
    '- Prefer specific, actionable guidance (pipelines, calibration, metrics, safety).',
    '- Maintain a friendly, confident, human tone. No speculation.',
  ].join('\n');
}

/* ───────────────────────── Handler ───────────────────────── */
export default async function handler(req) {
  const origin = req.headers.get('origin') || undefined;
  const headers = corsHeaders(origin);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Only POST supported' }), { status: 405, headers });

  try {
    const body = await req.json().catch(() => ({}));
    const question = String(body?.question || '').trim();
    if (!question) return new Response(JSON.stringify({ error: 'Missing question' }), { status: 400, headers });

    // Topic detection and topic-aware retrieval (prevents AAVSS/Dataset mixing)
    const topic = detectTopic(question);
    const { ctx, ids } = buildContext(question, topic);

    const sys = systemPrompt(topic);
    const usr = userPrompt(question, ctx);

    // Provider fallback: Groq → DeepInfra → Gemini
    let answer = ''; let provider = '';
    const providers = [
      { name: 'groq',      fn: askGroq },
      { name: 'deepinfra', fn: askDeepInfra },
      { name: 'gemini',    fn: askGemini },
    ];
    for (const p of providers) {
      try {
        const t = withTimeout(30_000);
        answer = await p.fn({ system: sys, user: usr, signal: t.signal });
        t.clear(); provider = p.name;
        if (answer) break;
      } catch (_e) { /* try next */ }
    }

    // Final fallback: stitched KB if all providers fail
    if (!answer) {
      const stitched = ids.map((id, i) => {
        const d = KB.docs.find(x => x.id === id);
        return d ? `(${i + 1}) ${d.title}\n${d.text}` : '';
      }).filter(Boolean).join('\n\n');
      answer = [
        'I could not reach the AI providers right now, so here is a concise summary from the KB:',
        '', stitched || 'No KB matches found. Please refine your question.',
      ].join('\n');
      provider = 'kb-fallback';
    }

    // Gentle polish (no hallucination)
    answer = answer.trim().replace(/\n{3,}/g, '\n\n');

    return new Response(JSON.stringify({ answer, provider, topic, sources: ids }), { headers });
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'Upstream request timed out' : (err?.message || 'Server error');
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers });
  }
}





















/* ==========================================================
   PRO AI CHAT DOCK  —  powerful, friendly, theme-aware
   ========================================================== */
(function ProAiChatDock(){
  // ------- tiny helpers -------
  const $ = (s,p=document)=>p.querySelector(s);
  const md = (t)=> (typeof mdToHtml === 'function' ? mdToHtml(t) : (t||''));

  // ------- CSS (injected once) -------
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
    width: min(720px, 92vw); max-height: min(74vh, 760px);
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

  .ai-body{ display:flex; flex-direction:column; gap:10px; padding:12px 14px; overflow:auto; min-height:200px; }
  .ai-msg{ max-width:88%; border:1px solid rgba(255,255,255,.08); border-radius:14px; padding:10px 12px; line-height:1.5; }
  .ai-msg.user{ margin-left:auto; background:rgba(120,170,255,.12); }
  .ai-msg.bot { background:#0e1a24; color:#e9f2f9; }
  body.is-light .ai-msg.bot { background:#f0f5ff; color:#1b2b45; border-color:rgba(0,0,0,.06); }
  .ai-msg .imgrow{ display:grid; grid-template-columns: repeat(auto-fill, minmax(120px,1fr)); gap:8px; margin-top:8px; }
  .ai-msg .imgrow img{ width:100%; height:100px; object-fit:cover; border-radius:10px; }

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

  // ------- DOM (built once) -------
  const fab = document.createElement('button');
  fab.id = 'aiFab';
  fab.type = 'button';
  fab.title = 'Open assistant';
  fab.innerHTML = '🤖';
  document.body.appendChild(fab);

  const dock = document.createElement('section'); dock.id = 'aiDock'; dock.setAttribute('aria-live','polite');
  dock.innerHTML = `
    <div class="ai-head">
      <div class="title"><span class="dot"></span><span>Assistant</span></div>
      <div class="actions">
        <button class="ai-btn" id="aiClear">Clear</button>
        <button class="ai-btn" id="aiMin">Minimize</button>
      </div>
    </div>
    <div class="ai-body" id="aiBody"></div>
    <div class="ai-suggest" id="aiSuggest"></div>
    <div class="ai-input">
      <input id="aiInput" type="text" placeholder="Ask anything… (e.g., What is AAVSS?)">
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

  // ------- simple session memory -------
  const MEMKEY = 'aiDockHistory';
  function loadHistory(){ try{ return JSON.parse(sessionStorage.getItem(MEMKEY)||'[]'); }catch{ return []; } }
  function saveHistory(h){ try{ sessionStorage.setItem(MEMKEY, JSON.stringify(h.slice(-20))); }catch{} }
  let history = loadHistory();

  function appendMsg(role, text, {html=false, images=[]}={}){
    const el = document.createElement('div');
    el.className = `ai-msg ${role}`;
    const content = html ? text : md(text);
    el.innerHTML = content;
    if (images && images.length){
      const row = document.createElement('div'); row.className='imgrow';
      images.forEach(src=>{
        const img=new Image(); img.src = src; img.loading='lazy'; row.appendChild(img);
      });
      el.appendChild(row);
    }
    bodyEl.appendChild(el);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function showGreeting(){
    if (history.length) return;
    appendMsg('bot', `Hey! I'm your album assistant.  
Ask me about **AAVSS**, the **Sri Lankan dataset**, or anything you see here.  
I can also show images or drill into **Sensors**, **Fusion**, **Specs** and more.`);
    showSuggestions('general');
  }

  function showSuggestions(topic='general'){
    const base = [
      {t:'Overview', q:'Give me a quick overview.'},
      {t:'How it works?', q:'How does it work end-to-end?'},
      {t:'Specs', q:'Share the main specs.'},
    ];
    const aav = [
      {t:'Sensors', q:'What sensors are used and why?'},
      {t:'Fusion',  q:'Explain the fusion pipeline.'},
      {t:'Safety',  q:'What safety analytics do you run?'},
      {t:'Show images', q:'Show images from this album.'}
    ];
    const dset = [
      {t:'License', q:'What license and distribution do you use?'},
      {t:'Annotations', q:'What are the annotation types & metrics?'},
      {t:'Night driving', q:'How is the dataset for night driving?'},
      {t:'Show images', q:'Show images from this album.'}
    ];
    const list = topic==='aavss' ? aav : topic==='sldataset' ? dset : base.concat([{t:'Show images', q:'Show images from this album.'}]);

    sugEl.innerHTML = '';
    list.forEach(({t,q})=>{
      const b = document.createElement('button'); b.className='ai-chip'; b.textContent=t;
      b.addEventListener('click', ()=> { inp.value = q; send.click(); });
      sugEl.appendChild(b);
    });
  }

  function detectSmallTalk(q){
    return /\b(hi|hello|hey|how are you|what's up|good morning|good evening|thank(s| you)|bye)\b/i.test(q);
  }

  function detectTopicLocal(q){
    const s=q.toLowerCase();
    const aHits = /(aavss|fusion|radar|lidar|lane|tracking|jetson|adas|safety|tensorrt)/.test(s);
    const dHits = /(dataset|data set|sri lanka|annotation|label|split|download|license|classes|night driving)/.test(s);
    if (aHits && !dHits) return 'aavss';
    if (dHits && !aHits) return 'sldataset';
    return 'general';
  }

  function currentAlbumImages(max=6){
    if (!window.currentAlbum || !Array.isArray(currentAlbum.media)) return [];
    return currentAlbum.media.filter(m=>m.type==='image').slice(0,max).map(m=>m.src);
  }

  async function routeAsk(question){
    // 1) render user bubble
    appendMsg('user', question);
    history.push({role:'user', content:question}); saveHistory(history);

    // 2) decide provider
    const topic = detectTopicLocal(question);
    let answer = '';
    try{
      if (detectSmallTalk(question)) {
        // friendly small-talk via your generic /api/ai (use album context if available)
        const ctx = typeof buildAlbumContext === 'function' ? buildAlbumContext(window.currentAlbum || null) : '';
        answer = await aiAsk(question, ctx);
      } else {
        // technical Q&A via your expert endpoint (KB-grounded)
        // add a tiny local context of prior 3 turns to encourage continuity without breaking your server prompt
        const recent = history.slice(-6);
        const prefix = recent.length
          ? 'Previous context:\n' + recent.map(m=>`${m.role==="user"?"Q":"A"}: ${m.content}`).join('\n') + '\n---\n'
          : '';
        answer = await expertAsk(prefix + question);
      }
    } catch(err){
      try{
        // fallback to generic if expert fails
        const ctx = typeof buildAlbumContext === 'function' ? buildAlbumContext(window.currentAlbum || null) : '';
        answer = await aiAsk(question, ctx);
      }catch(e){
        answer = 'Sorry — I hit a temporary issue. Please try again.';
      }
    }

    // 3) render bot bubble
    appendMsg('bot', answer);
    history.push({role:'assistant', content:answer}); saveHistory(history);

    // 4) follow-up chips & proactive question
    showSuggestions(topic);
    if (topic === 'aavss') {
      const askRow = document.createElement('div');
      askRow.className='ai-msg bot';
      askRow.innerHTML = md('Would you like **sensor details** or a quick look at **fusion** next?');
      const rowChips = document.createElement('div'); rowChips.className='ai-suggest';
      ['Sensor details','Fusion pipeline','Show images'].forEach(t=>{
        const b=document.createElement('button'); b.className='ai-chip'; b.textContent=t;
        b.onclick = ()=> {
          inp.value = t === 'Sensor details' ? 'What sensors are used and why?'
                   : t === 'Fusion pipeline' ? 'Explain the fusion pipeline.' : 'Show images from this album.';
          send.click();
        };
        rowChips.appendChild(b);
      });
      askRow.appendChild(rowChips);
      bodyEl.appendChild(askRow);
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }

    // If the user asked to show images explicitly, show them
    if (/show (me )?images|show images from this album/i.test(question)) {
      const imgs = currentAlbumImages(8);
      if (imgs.length) appendMsg('bot', 'Here are a few images from this album:', {images: imgs});
      else appendMsg('bot', 'This album has no images to preview here.');
    }
  }

  // ------- voice input (if supported) -------
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

  // ------- wiring -------
  function openDock(){ dock.style.display='flex'; setTimeout(()=>inp.focus(), 10); showGreeting(); }
  function closeDock(){ dock.style.display='none'; }
  fab.addEventListener('click', openDock);
  minB.addEventListener('click', closeDock);

  clearB.addEventListener('click', ()=>{
    history = []; saveHistory(history);
    bodyEl.innerHTML=''; sugEl.innerHTML='';
    showGreeting();
  });

  send.addEventListener('click', ()=>{
    const q = (inp.value||'').trim(); if (!q) return;
    inp.value=''; routeAsk(q);
  });
  inp.addEventListener('keydown', (e)=> { if (e.key==='Enter') send.click(); });

  micBtn.addEventListener('click', ()=>{
    if (!rec) return;
    try{
      if (!recActive){ recActive=true; micBtn.classList.add('rec'); rec.start(); }
      else { rec.stop(); recActive=false; micBtn.classList.remove('rec'); }
    }catch(_){}
  });

  // show greeting on first load if user clicks FAB later
  // (we don't show dock automatically)
})();

