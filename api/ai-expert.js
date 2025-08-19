// ==========================================================
// AI Expert API (CommonJS) — Friendly, KB + PDF aware, no ESM
// Works on Vercel Node 18 without "type: module"
// ==========================================================

/** Run on Node runtime (so we can use fetch, Buffer, etc.) */
module.exports.config = { runtime: "nodejs18.x" };

/* ---------------- utilities ---------------- */
function corsHeaders(origin) {
  const ALLOWED = (process.env.CORS_ORIGINS || "")
    .split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
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

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"); }
  catch { return {}; }
}

function withTimeout(ms = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(timer) };
}

const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_/.:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/* ---------------- KB (includes owner facts) ---------------- */
const KB = {
  meta: { project: "Album Expert KB", version: "2025-08-19" },
  docs: [
    {
      id: "aavss-overview", topic: "aavss", title: "AAVSS — Overview",
      text: "AAVSS (Advanced Autonomous Vehicle Safety System) is a real-time safety & perception stack with multi-sensor fusion (LiDAR + mmWave radar + RGB cameras) on NVIDIA Jetson (Nano-class) with TensorRT. Latency target < ~100 ms at ~10–20 FPS (sensor/model dependent)."
    },
    {
      id: "aavss-sensors", topic: "aavss", title: "AAVSS — Sensors & Roles",
      text: "LiDAR → 3D structure/free-space; Radar → range + radial velocity (robust in rain/fog); RGB cameras → lanes, lights, signs, VRUs. Typical placements: roof/bumper LiDAR; front/rear radar; forward windshield camera."
    },
    {
      id: "sld-overview", topic: "sldataset", title: "Sri Lanka Dataset — Overview",
      text: "Open Sri Lankan driving scenarios (urban + rural; rain/fog/night). Includes annotations for lanes, traffic signs, and hazards. Visual examples are available."
    },
    {
      id: "owner", topic: "all", title: "Ownership & Authors",
      text: "Owner / concept lead: **Sachintha Gaurawa**. Portfolio covers AAVSS and the Sri Lankan driving dataset."
    },
    {
      id: "about-sachintha", topic: "all", title: "Who is Sachintha Gaurawa?",
      text: "Sachintha Gaurawa is the creator of this portfolio and the owner/concept lead behind AAVSS and the Sri Lankan driving dataset (embedded AI, multi-sensor fusion, applied perception)."
    },
  ],
};

/* ------------- read uploaded PDF chunks via /api/docs.json ------------- */
async function readDocsStore(req) {
  try {
    // Prefer explicit API_BASE, otherwise derive from the incoming request host
    const baseEnv = (process.env.API_BASE || "").trim().replace(/\/+$/, "");
    const base = baseEnv || `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;
    const r = await fetch(`${base}/api/docs.json`, { cache: "no-store" });
    const j = await r.json();
    return j && Array.isArray(j.docs) ? { docs: j.docs } : { docs: [] };
  } catch {
    return { docs: [] };
  }
}

/* ---------------- retrieval ---------------- */
function detectTopic(q) {
  const n = normalize(q);
  if (/(^|\s)(aavss|fusion|radar|lidar|lane|tracking|jetson|safety|adas|tensorrt)(\s|$)/.test(n)) return "aavss";
  if (/(^|\s)(dataset|data set|sri lanka|annotation|label|split|download|license|classes)(\s|$)/.test(n)) return "sldataset";
  return "all";
}

function score(text, toks) {
  const t = normalize(text);
  let s = 0;
  for (const k of toks) {
    if (!k) continue;
    if (t.includes(` ${k} `) || t.startsWith(k + " ") || t.endsWith(" " + k)) s += 3;
    else if (t.includes(k)) s += 1;
  }
  return s;
}

async function topK(req, q, k = 8, topic = "all") {
  const toks = normalize(q).split(" ");
  const kbPool = KB.docs.filter(d => topic === "all" ? true : (d.topic === topic || d.topic === "all"));
  const kbRanked = kbPool
    .map(d => ({ type: "kb", id: d.id, title: d.title, text: d.text, s: score(`${d.title} ${d.text}`, toks) }))
    .filter(x => x.s > 0);

  const store = await readDocsStore(req);
  const pdfRanked = (store.docs || [])
    .map(ch => ({ type: "pdf", id: ch.id, title: ch.title, text: ch.text, page: ch.page, url: ch.url, s: score(`${ch.title} ${ch.text}`, toks) }))
    .filter(x => x.s > 0);

  const all = kbRanked.concat(pdfRanked).sort((a, b) => b.s - a.s).slice(0, k);

  if (!all.length) {
    const ids = topic === "aavss"
      ? ["aavss-overview"]
      : topic === "sldataset"
      ? ["sld-overview"]
      : ["aavss-overview", "sld-overview"];
    return KB.docs.filter(d => ids.includes(d.id)).map(d => ({ type: "kb", id: d.id, title: d.title, text: d.text }));
  }
  return all;
}

async function buildContext(req, q, topic = "all") {
  const items = await topK(req, q, 8, topic);
  const ctx = items.map((d, i) => `#${i + 1} ${d.title}\n${d.text}`).join("\n\n");
  const ids = items.map(d =>
    d.type === "pdf" ? `pdf:${d.id}|${d.title}|page=${d.page}|${d.url}` : `kb:${d.id}|${d.title}`
  );
  return { ctx, ids };
}

/* ---------------- providers ---------------- */
async function askGroq({ system, user, signal }) {
  const key = process.env.GROQ_API_KEY; if (!key) throw new Error("GROQ_API_KEY not set");
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.1-70b-versatile",
      temperature: 0.2, max_tokens: 450,
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}: ${await r.text().catch(() => "")}`);
  const j = await r.json();
  return (j?.choices?.[0]?.message?.content ?? "").trim();
}

async function askDeepInfra({ system, user, signal }) {
  const key = process.env.DEEPINFRA_API_KEY; if (!key) throw new Error("DEEPINFRA_API_KEY not set");
  const r = await fetch("https://api.deepinfra.com/v1/openai/chat/completions", {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
      temperature: 0.2, max_tokens: 450,
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });
  if (!r.ok) throw new Error(`DeepInfra HTTP ${r.status}: ${await r.text().catch(() => "")}`);
  const j = await r.json();
  return (j?.choices?.[0]?.message?.content ?? "").trim();
}

async function askGemini({ system, user, signal }) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error("GEMINI_API_KEY not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `${system}\n\n---\n\n${user}` }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 450 }
    })
  });
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${await r.text().catch(() => "")}`);
  const j = await r.json();
  const text =
    j?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("").trim()
    || j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    || "";
  return text;
}

/* ---------------- prompts & UX polish ---------------- */
function isGreeting(q) { return /\b(hi|hello|hey|good (morning|afternoon|evening)|what'?s up)\b/i.test(q); }
function isThanks(q)   { return /\b(thanks?|thank you|cheers)\b/i.test(q); }
function isBye(q)      { return /\b(bye|goodbye|see you|later)\b/i.test(q); }

function followUpFor(topic) {
  if (topic === "aavss") return "Do you want a short sensor-fusion diagram or latency breakdown?";
  if (topic === "sldataset") return "Want sample label formats or recommended train/val/test splits?";
  return "Shall I show image examples or a quick summary of both projects?";
}

function systemPrompt(topic) {
  return [
    "You are a warm, expert assistant for an album/portfolio site.",
    "RULES: Use ONLY the provided KB text. If a fact (e.g., exact sensor SKU) is missing, say it's not specified and invite the user to add it.",
    "STYLE: Conversational, friendly, precise. Short Markdown paragraphs or bullets. Add tasteful emojis only when it improves clarity.",
    "USER CARE: If appropriate, end with ONE optional follow-up question to help them go deeper.",
    `Topic focus: ${topic}. Stick to one topic unless asked to compare.`,
  ].join(" ");
}

function userPrompt(question, ctx) {
  return [
    "KB:",
    '"""',
    ctx,
    '"""',
    "",
    `User question: ${question}`,
    "",
    "Instructions:",
    "- Answer ONLY from the KB above.",
    "- If data is missing, say so succinctly and invite the user to provide/ingest it.",
    "- Use bullets for lists. Keep it human and friendly.",
  ].join("\n");
}

/* ---------------- HTTP handler (CommonJS) ---------------- */
module.exports = async function handler(req, res) {
  const headers = corsHeaders(req.headers.origin || "*");

  if (req.method === "OPTIONS") { res.writeHead(204, headers); res.end(); return; }
  if (req.method !== "POST")    { res.writeHead(405, headers); res.end(JSON.stringify({ error: "Only POST supported" })); return; }

  try {
    const body = await readJson(req);
    const question = String(body?.question ?? body?.q ?? body?.text ?? "").trim();

    if (!question) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: "Missing question" }));
      return;
    }

    // Soft UX responses for small talk
    if (isGreeting(question)) {
      const tip = followUpFor("all");
      const ans = `Hey! 😊 I’m your friendly assistant for AAVSS and the Sri Lankan Driving Dataset. Ask me anything.\n\n*Tip:* ${tip}`;
      res.writeHead(200, headers);
      res.end(JSON.stringify({ answer: ans, provider: "ux", topic: "all", sources: [] }));
      return;
    }
    if (isThanks(question)) {
      const ans = "You’re welcome! If you’d like, I can show a mini summary or browse reference images.";
      res.writeHead(200, headers);
      res.end(JSON.stringify({ answer: ans, provider: "ux", topic: "all", sources: [] }));
      return;
    }
    if (isBye(question)) {
      const ans = "Goodbye! 👋 If you come back later, I can pick up from where you left off.";
      res.writeHead(200, headers);
      res.end(JSON.stringify({ answer: ans, provider: "ux", topic: "all", sources: [] }));
      return;
    }

    const topic = detectTopic(question);
    const { ctx, ids } = await buildContext(req, question, topic);

    const sys = systemPrompt(topic);
    const usr = userPrompt(question, ctx);

    // Provider fallback: Groq → DeepInfra → Gemini
    let answer = "", provider = "";
    const chain = [
      { name: "groq", fn: askGroq },
      { name: "deepinfra", fn: askDeepInfra },
      { name: "gemini", fn: askGemini },
    ];

    for (const p of chain) {
      try {
        const t = withTimeout(30_000);
        const out = await p.fn({ system: sys, user: usr, signal: t.signal });
        t.clear();
        if (out && out.trim()) { answer = out.trim(); provider = p.name; break; }
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

      answer   = `I couldn’t reach the AI providers just now. Here’s a brief KB digest:\n\n${stitched || "No KB matches found."}`;
      provider = "kb-fallback";
    }

    // Add a friendly, single follow-up question when helpful
    const follow = followUpFor(topic);
    const politeAns = `${String(answer).trim().replace(/\n{3,}/g, "\n\n")}\n\n*Would you like more?* ${follow}`;

    res.writeHead(200, headers);
    res.end(JSON.stringify({ answer: politeAns, provider, topic, sources: ids }));
  } catch (err) {
    const msg = err?.name === "AbortError" ? "Upstream request timed out" : (err?.message || "Server error");
    res.writeHead(500, headers);
    res.end(JSON.stringify({ error: msg }));
  }
};
