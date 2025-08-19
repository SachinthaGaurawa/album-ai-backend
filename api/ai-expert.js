// api/ai-expert.js  (CommonJS version) — Text Q&A over KB + uploaded PDFs

// Make this a Node.js function (so we can use AbortController/timeouts, etc.)
module.exports.config = { runtime: "nodejs18.x" };

/* --------------------------- tiny utils --------------------------- */
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

// Some platforms don’t parse req.body for us — handle both cases
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

/* ---------------------------- KB docs ---------------------------- */
/* Add project/owner facts here so the assistant can answer friendly
   questions (hello/thanks/bye/ownership/who is Sachintha, etc.)     */
const KB = {
  meta: { project: "Album Expert KB", version: "2025-08-19" },
  docs: [
    {
      id: "aavss-overview",
      topic: "aavss",
      title: "AAVSS — Overview",
      text:
        "AAVSS (Advanced Autonomous Vehicle Safety System) is a real-time safety & perception stack. " +
        "Focus: road-hazard awareness, driver alerts, research prototyping. " +
        "Core: multi-sensor fusion (LiDAR + mmWave radar + RGB cameras). " +
        "Target: NVIDIA Jetson (Nano-class) with TensorRT optimizations. " +
        "Latency target: sub-100 ms end-to-end at ~10–20 FPS, sensor/model dependent.",
    },
    {
      id: "aavss-sensors",
      topic: "aavss",
      title: "AAVSS — Sensors & Roles",
      text:
        "LiDAR → 3D structure/range/free-space; Radar → range + radial velocity (robust in rain/fog); " +
        "RGB Cameras → appearance: traffic lights/signs, lanes, VRUs. " +
        "Typical placements: roof/bumper LiDAR; front/rear radar; forward camera at windshield height.",
    },
    {
      id: "sld-overview",
      topic: "sldataset",
      title: "Sri Lanka Autonomous Driving Dataset — Overview",
      text:
        "Open set of Sri Lankan driving scenarios (urban & rural) across weather/time (rain, fog, night). " +
        "Includes annotations for lanes, signs, hazards; visual examples available.",
    },
    /* ——— Owner / author facts you asked for ——— */
    {
      id: "owner",
      topic: "all",
      title: "Ownership & Authors",
      text:
        "Owner / concept lead: **Sachintha Gaurawa** (Electrical & Electronic Engineering). " +
        "Project scope includes AAVSS and the Sri Lanka driving dataset initiative. " +
        "If asked: the work shown on this site is owned and curated by Sachintha Gaurawa.",
    },
    {
      id: "about-sachintha",
      topic: "all",
      title: "Who is Sachintha Gaurawa?",
      text:
        "Sachintha Gaurawa is the creator/maintainer of this portfolio, and the owner/concept lead " +
        "behind AAVSS and the Sri Lankan driving dataset. Focus areas: embedded AI, sensor fusion, " +
        "and applied perception for driver safety.",
    },
  ],
};

/* ----------------- PDF chunk store (from /api/docs.json) ----------------- */
// We read the docs store via HTTP so it works on Vercel (no local FS reads).
async function readDocsStore(req) {
  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;
    const baseEnv = (process.env.API_BASE || "").trim().replace(/\/+$/, "");
    const base = baseEnv || `${proto}://${host}`;
    const r = await fetch(`${base}/api/docs.json`, { cache: "no-store" });
    const j = await r.json();
    return j && Array.isArray(j.docs) ? { docs: j.docs } : { docs: [] };
  } catch {
    return { docs: [] };
  }
}

/* --------------------- retrieval & ranking ---------------------- */
function detectTopic(q) {
  const n = normalize(q);
  if (/(^|\s)(aavss|fusion|radar|lidar|lane|tracking|jetson|safety|adas|tensorrt)(\s|$)/.test(n)) return "aavss";
  if (/(^|\s)(dataset|data set|sri lanka|annotation|label|split|download|license|classes)(\s|$)/.test(n))
    return "sldataset";
  return "all";
}

function score(text, tokens) {
  const t = normalize(text);
  let s = 0;
  for (const tok of tokens) {
    if (!tok) continue;
    if (t.includes(` ${tok} `) || t.startsWith(tok + " ") || t.endsWith(" " + tok)) s += 3;
    else if (t.includes(tok)) s += 1;
  }
  return s;
}

async function topK(req, q, k = 8, topic = "all") {
  const tokens = normalize(q).split(" ");

  // 1) KB
  const kbPool = KB.docs.filter((d) => (topic === "all" ? true : d.topic === topic || d.topic === "all"));
  const kbRanked = kbPool
    .map((d) => ({
      type: "kb",
      id: d.id,
      title: d.title,
      text: d.text,
      s: score(`${d.title} ${d.text}`, tokens),
    }))
    .filter((x) => x.s > 0);

  // 2) PDF chunks
  const store = await readDocsStore(req);
  const pdfRanked = (store.docs || [])
    .map((ch) => ({
      type: "pdf",
      id: ch.id,
      title: ch.title,
      text: ch.text,
      page: ch.page,
      url: ch.url,
      s: score(`${ch.title} ${ch.text}`, tokens),
    }))
    .filter((x) => x.s > 0);

  const all = kbRanked.concat(pdfRanked).sort((a, b) => b.s - a.s).slice(0, k);

  // Fallback overview if we got nothing
  if (!all.length) {
    const ids =
      topic === "aavss"
        ? ["aavss-overview"]
        : topic === "sldataset"
        ? ["sld-overview"]
        : ["aavss-overview", "sld-overview"];
    return KB.docs.filter((d) => ids.includes(d.id)).map((d) => ({ type: "kb", id: d.id, title: d.title, text: d.text }));
  }
  return all;
}

async function buildContext(req, q, topic = "all") {
  const items = await topK(req, q, 8, topic);
  const ctx = items.map((d, i) => `#${i + 1} ${d.title}\n${d.text}`).join("\n\n");
  const ids = items.map((d) =>
    d.type === "pdf" ? `pdf:${d.id}|${d.title}|page=${d.page}|${d.url}` : `kb:${d.id}|${d.title}`
  );
  return { ctx, ids };
}

/* ---------------- AI providers (fallback chain) ---------------- */
async function askGroq({ system, user, signal }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not set");
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.1-70b-versatile",
      temperature: 0.2,
      max_tokens: 450,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}: ${await r.text().catch(() => "")}`);
  const j = await r.json();
  return (j?.choices?.[0]?.message?.content ?? "").trim();
}

async function askDeepInfra({ system, user, signal }) {
  const key = process.env.DEEPINFRA_API_KEY;
  if (!key) throw new Error("DEEPINFRA_API_KEY not set");
  const r = await fetch("https://api.deepinfra.com/v1/openai/chat/completions", {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
      temperature: 0.2,
      max_tokens: 450,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`DeepInfra HTTP ${r.status}: ${await r.text().catch(() => "")}`);
  const j = await r.json();
  return (j?.choices?.[0]?.message?.content ?? "").trim();
}

async function askGemini({ system, user, signal }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(
    key
  )}`;
  const r = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `${system}\n\n---\n\n${user}` }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 450 },
    }),
  });
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${await r.text().catch(() => "")}`);
  const j = await r.json();
  const text =
    j?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("").trim() ||
    j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
    "";
  return text;
}

/* ----------------- prompts (friendlier tone) ------------------ */
function systemPrompt(topic) {
  return [
    "You are a warm, professional technical assistant for an album/portfolio site.",
    "Be brief, human, and helpful. Use Markdown with short paragraphs or bullets.",
    "Ground every answer strictly in the provided Knowledge Base (KB) context.",
    "If the KB does not include a detail (e.g., a specific sensor SKU), say it's not specified and invite the user to add it.",
    "If the user greets you, respond naturally first, then offer help.",
    "When it helps, end with ONE short follow-up question to guide them. Keep it optional and not pushy.",
    `Topic focus: ${topic}. Stay on this unless the user clearly asks to compare topics.`,
  ].join(" ");
}

function userPrompt(question, ctx) {
  return [
    "KB Context:",
    '"""',
    ctx,
    '"""',
    "",
    `User: ${question}`,
    "",
    "Answer using only the KB. If unknown, say so briefly and suggest adding the info.",
    "Be concise and conversational. Prefer concrete, actionable guidance.",
  ].join("\n");
}

/* ------------------------- HTTP handler ------------------------ */
module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "*";
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, headers);
    res.end(JSON.stringify({ error: "Only POST supported" }));
    return;
  }

  try {
    const body = await readJson(req);
    const rawQ = (body?.question ?? body?.q ?? body?.text ?? "").toString();
    const question = rawQ.trim();
    if (!question) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: "Missing question" }));
      return;
    }

    const topic = detectTopic(question);
    const { ctx, ids } = await buildContext(req, question, topic);

    const sys = systemPrompt(topic);
    const usr = userPrompt(question, ctx);

    let answer = "",
      provider = "";
    const providers = [
      { name: "groq", fn: askGroq },
      { name: "deepinfra", fn: askDeepInfra },
      { name: "gemini", fn: askGemini },
    ];

    for (const p of providers) {
      try {
        const t = withTimeout(30_000);
        answer = await p.fn({ system: sys, user: usr, signal: t.signal });
        t.clear();
        provider = p.name;
        if (answer) break;
      } catch {
        /* try next */
      }
    }

    if (!answer) {
      // KB-only stitched fallback so the user still gets something useful
      const stitched = ids
        .map((id, i) => {
          const [kind, rest] = id.split(":");
          if (kind === "kb") {
            const kbId = rest.split("|")[0];
            const d = KB.docs.find((x) => x.id === kbId);
            return d ? `(${i + 1}) ${d.title}\n${d.text}` : "";
          }
          if (kind === "pdf") {
            const title = rest.split("|")[0];
            return `(${i + 1}) ${title} (from PDF)`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n\n");

      answer = [
        "I couldn’t reach the AI providers just now. Here’s a concise KB summary:",
        "",
        stitched || "No KB matches found.",
      ].join("\n");
      provider = "kb-fallback";
    }

    answer = answer.trim().replace(/\n{3,}/g, "\n\n");
    res.writeHead(200, headers);
    res.end(JSON.stringify({ answer, provider, topic, sources: ids }));
  } catch (err) {
    const msg = err?.name === "AbortError" ? "Upstream request timed out" : err?.message || "Server error";
    res.writeHead(500, headers);
    res.end(JSON.stringify({ error: msg }));
  }
};
