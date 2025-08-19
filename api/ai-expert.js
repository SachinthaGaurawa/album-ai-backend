//==========================================================
// PRO AI CHAT — Text Q&A API (Node serverless)
// - Uses KB + dynamic PDF chunks from /api/docs.json
// - Provider fallback: Groq → DeepInfra → Gemini
// - Friendly small-talk, clarifications, follow-ups
//==========================================================

export const config = { runtime: "nodejs18.x" };

import fs from "fs";     // kept for compatibility (not used)
import path from "path";  // kept for compatibility (not used)

/* ──────────────────────────────────────────────────────────
   Helpers
   ────────────────────────────────────────────────────────── */

// Robust JSON body parse (serverless-safe)
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

// REPLACEMENT: Read docs.json via API (Vercel-friendly; no ephemeral FS)
async function readDocsStore() {
  try {
    // Same project route; ai-expert will fetch the JSON that /api/docs.json serves
    const base = process.env.API_BASE || "https://album-ai-backend-new.vercel.app";
    const r = await fetch(`${base.replace(/\/+$/,'')}/api/docs.json`);
    const j = await r.json();
    return j && Array.isArray(j.docs) ? { docs: j.docs } : { docs: [] };
  } catch {
    return { docs: [] };
  }
}

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

function withTimeout(ms = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(timer) };
}

const normalize = s =>
  (s || "").toLowerCase()
    .replace(/[^a-z0-9\s\-_/.:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/* ──────────────────────────────────────────────────────────
   Knowledge Base
   ────────────────────────────────────────────────────────── */
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
    // Add any other KB docs you already had here
  ],
};

/* ──────────────────────────────────────────────────────────
   Retrieval (KB + dynamic PDF chunks)
   ────────────────────────────────────────────────────────── */
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
  if (/^(hi|hello|hey|yo|good (morning|evening|afternoon)|how are you|what'?s up)\b/.test(n)) return "smalltalk";
  if (/(^|\s)(aavss|fusion|radar|lidar|lane|tracking|jetson|safety|adas|tensorrt)(\s|$)/.test(n)) return "aavss";
  if (/(^|\s)(dataset|data set|sri lanka|annotation|label|split|download|license|classes|night|rain)(\s|$)/.test(n)) return "sldataset";
  return "all";
}

async function topK(q, k = 8, topic = "all") {
  const qTokens = normalize(q).split(" ").filter(Boolean);

  // 1) KB
  const kbPool = KB.docs.filter(d => topic === "all" ? true : (d.topic === topic || d.topic === "all"));
  const kbRanked = kbPool.map(d => ({
    type: "kb", id: d.id, title: d.title, text: d.text, s: scoreDoc(qTokens, d)
  }));

  // 2) PDFs (dynamic, from /api/docs.json)
  const store = await readDocsStore();
  const pdfRanked = (store.docs || []).map(ch => ({
    type: "pdf", id: ch.id, title: ch.title, text: ch.text, page: ch.page, url: ch.url, s: scoreChunk(qTokens, ch)
  }));

  // Merge + sort
  const all = kbRanked.concat(pdfRanked).filter(x => x.s > 0).sort((a,b)=>b.s-a.s).slice(0, k);

  // Fallbacks
  if (!all.length) {
    if (topic === "aavss")
      return KB.docs.filter(d => d.id === "aavss-overview").map(d => ({ type:"kb", id:d.id, title:d.title, text:d.text }));
    if (topic === "sldataset")
      return KB.docs.filter(d => d.id === "sld-overview").map(d => ({ type:"kb", id:d.id, title:d.title, text:d.text }));
    return KB.docs
      .filter(d => d.id === "aavss-overview" || d.id === "sld-overview")
      .map(d => ({ type:"kb", id:d.id, title:d.title, text:d.text }));
  }
  return all;
}

async function buildContext(q, topic = "all") {
  const k = await topK(q, 8, topic);
  const ctx = k.map((d,i)=>`#${i+1} ${d.title}\n${d.text}`).join("\n\n");
  const ids = k.map(d => d.type === "pdf"
    ? `pdf:${d.id}|${d.title}|page=${d.page}|${d.url}`
    : `kb:${d.id}|${d.title}`
  );
  return { ctx, ids };
}

/* ──────────────────────────────────────────────────────────
   Providers
   ────────────────────────────────────────────────────────── */
async function askGroq({ system, user, signal }) {
  const key = process.env.GROQ_API_KEY; if (!key) throw new Error("GROQ_API_KEY not set");
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", signal,
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.1-70b-versatile",
      temperature: 0.2, max_tokens: 450,
      messages: [{ role:"system", content:system }, { role:"user", content:user }]
    })
  });
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}: ${await r.text().catch(()=> "")}`);
  const j = await r.json();
  return (j?.choices?.[0]?.message?.content ?? "").trim();
}

async function askDeepInfra({ system, user, signal }) {
  const key = process.env.DEEPINFRA_API_KEY; if (!key) throw new Error("DEEPINFRA_API_KEY not set");
  const r = await fetch("https://api.deepinfra.com/v1/openai/chat/completions", {
    method: "POST", signal,
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
      temperature: 0.2, max_tokens: 450,
      messages: [{ role:"system", content:system }, { role:"user", content:user }]
    })
  });
  if (!r.ok) throw new Error(`DeepInfra HTTP ${r.status}: ${await r.text().catch(()=> "")}`);
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
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${await r.text().catch(()=> "")}`);
  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("").trim()
           || j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  return text;
}

/* ──────────────────────────────────────────────────────────
   Persona, prompts, friendliness, follow-ups
   ────────────────────────────────────────────────────────── */
const BRAND = {
  ownerName: "Sachintha Gaurawa",
  ownerShort: "Sachintha",
  productName: "Album AI",
  projectOwnerQ: [
    "who is sachintha", "sachintha gaurawa", "who owns this", "who made this",
    "who is the owner", "who is the manufacturer", "who is the concept"
  ],
};

const SMALLTALK = {
  hi: ["Hey there! 👋", "Hi! 😊", "Hello! 🙌"],
  howAreYou: ["I’m doing great — ready to help. How can I assist today?", "All good here! What would you like to explore?"],
  helpOpeners: [
    "Want a quick overview of AAVSS or the Sri Lankan dataset?",
    "Shall I pull some reference photos or generate a concept image?",
    "Would you like details about sensors, fusion, or safety analytics?"
  ]
};

function looksLikeOwnerQuestion(q) {
  const n = normalize(q);
  return BRAND.projectOwnerQ.some(key => n.includes(key));
}

function smallTalkAnswer(q) {
  const n = normalize(q);
  if (/^(hi|hello|hey|yo)\b/.test(n)) {
    const a = SMALLTALK.hi[ Math.floor(Math.random()*SMALLTALK.hi.length) ];
    const b = SMALLTALK.helpOpeners[ Math.floor(Math.random()*SMALLTALK.helpOpeners.length) ];
    return `${a} ${b}`;
  }
  if (/how are you|how's it going|how are u/.test(n)) {
    const a = SMALLTALK.howAreYou[ Math.floor(Math.random()*SMALLTALK.howAreYou.length) ];
    return `${a}`;
  }
  return "Hi! 👋 What would you like to explore — AAVSS, the Sri Lankan dataset, or should I generate some images?";
}

function aboutOwnerAnswer() {
  return [
    `**${BRAND.ownerName}** is the creator and driving force behind **${BRAND.productName}** — concept, design, and implementation.`,
    "This project showcases autonomous-vehicle safety R&D (AAVSS) and a Sri Lankan driving dataset with rich scenarios.",
    "If you'd like, I can share a quick overview, sensor roles, or dataset highlights. Want me to do that?"
  ].join("\n\n");
}

function followupsFor(topic) {
  if (topic === "aavss") {
    return [
      "Show the sensor roles",
      "Explain the fusion pipeline",
      "What’s the target latency?",
      "Any safety alert examples?",
      "Generate a cockpit HUD alert image"
    ];
  }
  if (topic === "sldataset") {
    return [
      "What license do you use?",
      "What annotation types are included?",
      "How’s night/rain coverage?",
      "Suggest a train/val/test split",
      "Browse rainy-night driving photos"
    ];
  }
  return [
    "Give me a quick overview",
    "How does it work end-to-end?",
    "Generate a rainy highway image",
    "Browse reference photos",
    "Show sensors vs. dataset differences"
  ];
}

function systemPrompt(topic) {
  return [
    "You are a professional, friendly technical assistant for an album/portfolio site.",
    "Answer ONLY from the KB/context provided. If unknown, say it's not specified and invite the user to add it.",
    "Use clear, concise paragraphs and bullet lists. Keep answers helpful and human.",
    `Topic focus: ${topic}. Prefer a single topic unless the user asks to compare.`,
  ].join(" ");
}

function userPrompt(question, ctx) {
  return [
    "KB CONTEXT:",
    '"""', ctx, '"""', "",
    `User question: ${question}`, "",
    "Instructions:",
    "- Use only KB/context facts. If missing, say so and suggest adding the info.",
    "- Prefer concrete guidance (pipelines, calibration, metrics, safety).",
    "- Keep a friendly tone. Avoid speculation.",
  ].join("\n");
}

/* ──────────────────────────────────────────────────────────
   HTTP handler
   ────────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  const origin  = req.headers.origin || "*";
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") { res.writeHead(204, headers); res.end(); return; }
  if (req.method !== "POST")    { res.writeHead(405, headers); res.end(JSON.stringify({ error: "Only POST supported" })); return; }

  try {
    const body = await readJson(req);
    const rawQ = (body?.question ?? body?.q ?? body?.text ?? "").toString();
    const question = rawQ.trim();

    if (!question) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: "Missing question" }));
      return;
    }

    // Owner / concept questions (fast path)
    if (looksLikeOwnerQuestion(question)) {
      const answer = aboutOwnerAnswer();
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        answer,
        provider: "owner-facts",
        topic: "about",
        sources: [],
        followups: ["Show project overview", "Sensors & fusion", "Dataset highlights", "Generate an example image"]
      }));
      return;
    }

    // Small-talk (friendly + suggest next steps)
    const topicDetected = detectTopic(question);
    if (topicDetected === "smalltalk") {
      const answer = smallTalkAnswer(question);
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        answer,
        provider: "smalltalk",
        topic: "smalltalk",
        sources: [],
        followups: followupsFor("all")
      }));
      return;
    }

    // Build KB+PDF context
    const topic = topicDetected;
    const { ctx, ids } = await buildContext(question, topic);

    // If user is too vague, gently clarify
    if (!ctx || ctx.trim().length === 0) {
      const answer = "Could you tell me if you’re asking about **AAVSS** or the **Sri Lankan dataset**? I’ll keep it concise. 🙂";
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        answer,
        provider: "clarify",
        topic: "all",
        sources: [],
        followups: ["AAVSS overview", "Dataset overview", "Generate an example image", "Browse reference photos"]
      }));
      return;
    }

    const sys = systemPrompt(topic);
    const usr = userPrompt(question, ctx);

    // Providers fallback
    let answer = "", provider = "";
    const providers = [
      { name: "groq",      fn: askGroq },
      { name: "deepinfra", fn: askDeepInfra },
      { name: "gemini",    fn: askGemini },
    ];
    for (const p of providers) {
      try {
        const t = withTimeout(30_000);
        answer = await p.fn({ system: sys, user: usr, signal: t.signal });
        t.clear(); provider = p.name;
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

    // Friendly post-processing
    answer = answer.trim().replace(/\n{3,}/g, "\n\n");

    res.writeHead(200, headers);
    res.end(JSON.stringify({
      answer,
      provider,
      topic,
      sources: ids,
      followups: followupsFor(topic)
    }));
  } catch (err) {
    const msg = err?.name === "AbortError" ? "Upstream request timed out" : (err?.message || "Server error");
    res.writeHead(500, headers);
    res.end(JSON.stringify({ error: msg }));
  }
}