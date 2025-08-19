//==========================================================
// api/ai-expert.js — Expert Q&A API (Node/Vercel serverless)
//==========================================================

export const config = { runtime: "nodejs18.x" };

import fs from "fs";
import path from "path";

/* ── body parsing (robust on serverless) ─────────────────── */
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

/* ── docs store (pull from API so it works on Vercel) ────── */
async function readDocsStore() {
  // Prefer explicit env; else fall back to your deployed base
  const base =
    (process.env.API_BASE || "").replace(/\/+$/, "") ||
    "https://album-ai-backend-new.vercel.app";

  try {
    const r = await fetch(`${base}/api/docs.json`, { cache: "no-store" });
    if (!r.ok) throw new Error(`docs.json HTTP ${r.status}`);
    const j = await r.json();
    return j && Array.isArray(j.docs) ? { docs: j.docs } : { docs: [] };
  } catch {
    // Local fallback (helpful in dev if storage/docs.json exists)
    try {
      const p = path.join(process.cwd(), "storage", "docs.json");
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return { docs: [] };
    }
  }
}

/* ── CORS & timeout ──────────────────────────────────────── */
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

/* ── mini KB (extensible) ────────────────────────────────── */
const KB = {
  meta: { project: "Album Expert KB", version: "2025-08-19", topics: ["aavss", "sldataset"] },
  docs: [
    {
      id: "owner",
      topic: "all",
      title: "Owner & Creator",
      text:
        "The portfolio, AAVSS concept, and Sri Lankan dataset are created/owned by **Sachintha Gaurawa**. "
        + "If you need a short bio or contact info, ask and the assistant will provide it from the KB.",
    },
    {
      id: "sachintha-bio",
      topic: "all",
      title: "Who is Sachintha Gaurawa?",
      text:
        "Sachintha Gaurawa is the engineer behind the **Advanced Autonomous Vehicle Safety System (AAVSS)** and the "
        + "**Sri Lanka Autonomous Driving Dataset** showcased here. He leads concept/design, implementation and demos.",
    },
    {
      id: "aavss-overview",
      topic: "aavss",
      title: "AAVSS — Overview",
      text:
        "AAVSS (Advanced Autonomous Vehicle Safety System) is a real-time safety and perception stack. "
        + "Focus: on-road hazard awareness, driver alerts, and research prototyping. "
        + "Core: multi-sensor fusion (LiDAR + mmWave radar + RGB cameras). "
        + "Deployment target: embedded NVIDIA Jetson platform (Nano-class) with TensorRT optimizations. "
        + "Goal latency: sub-100 ms end-to-end at ~10–20 FPS depending on sensor load and model sizes.",
    },
    {
      id: "aavss-sensors",
      topic: "aavss",
      title: "AAVSS — Sensors & Roles",
      text:
        "Sensors and roles:\n"
        + "• LiDAR: 3D structure, range, obstacle shape, and ego-free-space estimation.\n"
        + "• mmWave radar: range + radial velocity; robust in rain/fog; complements vision for tracking.\n"
        + "• RGB camera(s): appearance cues, traffic lights/signs, lane markings, vulnerable road users.\n"
        + "Typical placements: roof/bumper LiDAR; front/rear radar; forward camera at windshield height.\n"
        + "Note: exact sensor brands/models are project-dependent; add your SKUs to the KB to answer with the exact models.",
    },
    {
      id: "sl-dataset-overview",
      topic: "sldataset",
      title: "Sri Lankan Driving Dataset — Overview",
      text:
        "Open dataset across Sri Lankan road scenarios (urban/rural; rain/fog/night). "
        + "Annotations include lanes, traffic signs and hazards. Visual examples are available. "
        + "License/splits/class counts: not specified in KB yet; add them to answer precisely.",
    },
  ],
};

/* ── retrieval ────────────────────────────────────────────── */
const normalize = s =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_/.:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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
  if (text.includes("sachintha")) score += 2;
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

/** FIXED: async so PDF chunks are actually used */
async function topK(q, k = 8, topic = "all") {
  const qTokens = normalize(q).split(" ").filter(Boolean);

  // 1) KB
  const kbPool = KB.docs.filter(d => topic === "all" ? true : (d.topic === topic || d.topic === "all"));
  const kbRanked = kbPool.map(d => ({
    type: "kb",
    id: d.id,
    title: d.title,
    text: d.text,
    s: scoreDoc(qTokens, d),
  }));

  // 2) PDF chunks from your uploaded docs.json
  const store = await readDocsStore();                 // ← the important await
  const pdfRanked = (store.docs || []).map(ch => ({
    type: "pdf",
    id: ch.id,
    title: ch.title,
    text: ch.text,
    page: ch.page,
    url: ch.url,
    s: scoreChunk(qTokens, ch),
  }));

  const all = kbRanked.concat(pdfRanked)
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k);

  // Friendly fallback if zero hits
  if (!all.length) {
    if (topic === "aavss")
      return KB.docs
        .filter(d => d.id === "aavss-overview")
        .map(d => ({ type: "kb", id: d.id, title: d.title, text: d.text }));
    if (topic === "sldataset")
      return KB.docs
        .filter(d => d.id === "sl-dataset-overview")
        .map(d => ({ type: "kb", id: d.id, title: d.title, text: d.text }));
    return KB.docs
      .filter(d => d.id === "aavss-overview" || d.id === "sl-dataset-overview")
      .map(d => ({ type: "kb", id: d.id, title: d.title, text: d.text }));
  }
  return all;
}

async function buildContext(q, topic = "all") {
  const k = await topK(q, 8, topic);
  const ctx = k.map((d, i) => `#${i + 1} ${d.title}\n${d.text}`).join("\n\n");
  const ids = k.map(d =>
    d.type === "pdf"
      ? `pdf:${d.id}|${d.title}|page=${d.page}|${d.url}`
      : `kb:${d.id}|${d.title}`
  );
  return { ctx, ids };
}

/* ── friendly follow-ups ──────────────────────────────────── */
function buildFollowups(topic = "all") {
  if (topic === "aavss") {
    return [
      "Want a quick diagram of the fusion pipeline?",
      "Shall I list candidate LiDAR/radar SKUs to consider?",
      "Need a deployment checklist for Jetson Nano?",
    ];
  }
  if (topic === "sldataset") {
    return [
      "Want a summary of night-driving coverage?",
      "Shall I draft recommended train/val/test splits?",
      "Need export formats or a label map template?",
    ];
  }
  return [
    "Interested in AAVSS sensors or the Sri Lankan dataset?",
    "Want me to generate a reference image for your idea?",
  ];
}

function formatAnswer(answer, topic) {
  const fups = buildFollowups(topic);
  const tail = fups.length ? `\n\n—\n🙂 **Anything else?** ${fups[0]}` : "";
  return `${answer}${tail}`;
}

/* ── providers ─────────────────────────────────────────────── */
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
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
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
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
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
    j?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("").trim() ||
    j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
    "";
  return text;
}

/* ── prompts ──────────────────────────────────────────────── */
function systemPrompt(topic) {
  return [
    "You are a warm, professional assistant for an album/portfolio site. Your style is human and helpful.",
    "Use ONLY the material provided in KB below (KB includes both built-in notes and extracted PDF chunks).",
    "If a detail isn’t in KB (e.g., an exact sensor SKU), say so briefly and invite the user to add it to the KB.",
    "Prefer clear, concise paragraphs and short bullet lists. Use tasteful emoji sparingly (none if the topic is formal).",
    "If the user greets or says thanks/bye, respond naturally first, then offer a helpful next step.",
    "After answering, ask ONE short follow-up that would help them go deeper.",
    `Topic focus: ${topic}. Keep to one topic unless they explicitly ask to compare.`,
  ].join("\n");
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
    "- Answer only from KB facts. If unknown, say it's not specified.",
    "- Keep it practical: pipelines, calibration, metrics, deployment, safety, or dataset details.",
    "- Be friendly and concise. No speculation.",
  ].join("\n");
}

/* ── HTTP handler ─────────────────────────────────────────── */
export default async function handler(req, res) {
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

    // Small-talk fast path (human vibe)
    const small = /^(hi|hey|hello|good\s*(morning|evening|afternoon)|thanks?|thank\s*you|bye)\b/i;
    if (small.test(question)) {
      const msg =
        /^thanks?/i.test(question) || /^thank you/i.test(question)
          ? "You're welcome! If you like, I can summarize your AAVSS or dataset next. 🙂"
          : /^bye/i.test(question)
          ? "Goodbye! If you want to continue later, I’ll be here. 👋"
          : "Hey there! I can help with **AAVSS** (sensors, fusion, Jetson deploy) or the **Sri Lankan dataset** (labels, splits, coverage). What would you like to explore first?";
      res.writeHead(200, headers);
      res.end(JSON.stringify({ answer: formatAnswer(msg, "all"), provider: "kb", topic: "all", sources: [] }));
      return;
    }

    // Build KB+PDF context
    const topic = detectTopic(question);
    const { ctx, ids } = await buildContext(question, topic);

    const sys = systemPrompt(topic);
    const usr = userPrompt(question, ctx);

    // Provider fallback: Groq → DeepInfra → Gemini
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

    // Final fallback: stitch KB if all providers fail
    if (!answer) {
      const stitched = ids
        .map((id, i) => {
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
        })
        .filter(Boolean)
        .join("\n\n");
      answer = ["I couldn’t reach the AI providers just now. Here’s a concise KB summary:", "", stitched || "No KB matches found."].join(
        "\n"
      );
      provider = "kb-fallback";
    }

    answer = formatAnswer(answer.trim().replace(/\n{3,}/g, "\n\n"), topic);

    res.writeHead(200, headers);
    res.end(JSON.stringify({ answer, provider, topic, sources: ids }));
  } catch (err) {
    const msg = err?.name === "AbortError" ? "Upstream request timed out" : err?.message || "Server error";
    res.writeHead(500, headers);
    res.end(JSON.stringify({ error: msg }));
  }
}
