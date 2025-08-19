// ==========================================================
// /api/ai-expert.js  — Text Q&A API (CommonJS for Vercel)
// RAG (KB + PDFs), skills plugin system, small-talk,
// follow-ups, command routing (/gen, /browse), provider fallback
// ==========================================================

exports.config = { runtime: "nodejs18.x" };

/* ----------------------- tiny utils ---------------------- */

function corsHeaders(origin) {
  const ALLOWED = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
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
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9\s\-_/.:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const TOK = (s) => normalize(s).split(" ").filter(Boolean);

/* ----------------------- personal facts ------------------ */

const OWNER = {
  fullName: "Sachintha Gaurawa",
  roles: ["Owner", "Concept designer", "Manufacturer"],
  projects: [
    "AAVSS (Advanced Autonomous Vehicle Safety System)",
    "Sri Lanka Autonomous Driving Dataset",
  ],
  tagline:
    "Engineer and creator focused on autonomous driving, embedded AI, and safety systems.",
};

/* ----------------------- built-in KB --------------------- */

const KB = {
  meta: { project: "Album Expert KB", version: "2025-08-19", topics: ["aavss", "sldataset", "about"] },
  docs: [
    {
      id: "aavss-overview",
      topic: "aavss",
      title: "AAVSS — Overview",
      text:
        "AAVSS (Advanced Autonomous Vehicle Safety System) is a real-time safety and perception stack. " +
        "Core: multi-sensor fusion (LiDAR + mmWave radar + RGB camera). " +
        "Embedded target: NVIDIA Jetson (Nano-class) with TensorRT optimizations. " +
        "Typical end-to-end latency sub-100 ms at 10–20 FPS depending on model sizes.",
    },
    {
      id: "aavss-sensors",
      topic: "aavss",
      title: "AAVSS — Sensors & Roles",
      text:
        "Roles:\n" +
        "• LiDAR → 3D structure, obstacle shape, drivable free-space.\n" +
        "• mmWave radar → range + radial velocity, robust in rain/fog, complements vision.\n" +
        "• RGB camera → traffic lights/signs, lane markings, and VRU detection.\n" +
        "Exact SKUs vary; add sensor models to docs.json or a PDF for precise answers.",
    },
    {
      id: "aavss-pipeline",
      topic: "aavss",
      title: "AAVSS — Fusion Pipeline (high level)",
      text:
        "Calibration → time-sync → per-sensor detection/feature extraction → object association " +
        "→ tracking → risk scoring/alerting. Safety analytics delivered via HUD/alerts.",
    },
    {
      id: "sld-overview",
      topic: "sldataset",
      title: "Sri Lanka Autonomous Driving Dataset — Overview",
      text:
        "Open driving dataset across Sri Lankan road scenarios (urban/rural; rain, fog, night). " +
        "Includes annotations for lanes, signs, and hazards. Add PDFs for specifics.",
    },
    {
      id: "about-owner",
      topic: "about",
      title: "Ownership & Concept",
      text:
        `Owner/Concept/Manufacturer: ${OWNER.fullName}. Roles: ${OWNER.roles.join(", ")}. ` +
        `Projects: ${OWNER.projects.join(", ")}.`,
    },
    {
      id: "about-whois",
      topic: "about",
      title: `Who is ${OWNER.fullName}?`,
      text: `${OWNER.fullName} — ${OWNER.tagline} Leads AAVSS & the Sri Lanka dataset.`,
    },
  ],
};

/* -------------------- docs.json (PDF chunks) --------------- */

async function readDocsStore() {
  try {
    const base = process.env.API_BASE || "https://album-ai-backend-new.vercel.app";
    const r = await fetch(`${base.replace(/\/+$/, "")}/api/docs.json`, { method: "GET" });
    const j = await r.json();
    return j && Array.isArray(j.docs) ? { docs: j.docs } : { docs: [] };
  } catch { return { docs: [] }; }
}

/* ----------------- retrieval & context --------------------- */

function scoreText(qTokens, text) {
  const t = normalize(text);
  let s = 0;
  for (const tok of qTokens) {
    if (!tok) continue;
    if (t.includes(` ${tok} `) || t.startsWith(tok + " ") || t.endsWith(" " + tok)) s += 3;
    else if (t.includes(tok)) s += 1;
  }
  return s;
}

function detectTopic(question) {
  const n = normalize(question);
  if (/(^|\s)(aavss|fusion|radar|lidar|jetson|adas|safety|tensorrt|hud|driver monitoring)(\s|$)/.test(n)) return "aavss";
  if (/(^|\s)(dataset|data set|sri lanka|annotation|label|split|download|license|classes|night driving)(\s|$)/.test(n)) return "sldataset";
  if (/(^|\s)(owner|manufactur|concept|who (is|are)|about|sachintha)(\s|$)/.test(n)) return "about";
  return "all";
}

async function topK(question, k = 8, topic = "all") {
  const qTok = TOK(question);

  const kbPool = topic === "all" ? KB.docs : KB.docs.filter((d) => d.topic === topic || d.topic === "all" || topic === "about");
  const kbRanked = kbPool
    .map((d) => ({ type: "kb", id: d.id, title: d.title, text: d.text, s: scoreText(qTok, `${d.title}\n${d.text}`) }))
    .filter((x) => x.s > 0);

  const store = await readDocsStore();
  const pdfRanked = (store.docs || [])
    .map((ch) => ({ type: "pdf", id: ch.id, title: ch.title, text: ch.text, page: ch.page, url: ch.url, s: scoreText(qTok, `${ch.title}\n${ch.text}`) }))
    .filter((x) => x.s > 0);

  const all = kbRanked.concat(pdfRanked).sort((a, b) => b.s - a.s).slice(0, k);

  if (!all.length) {
    if (topic === "aavss")     return KB.docs.filter((d) => d.id === "aavss-overview").map((d) => ({ type: "kb", ...d, s: 1 }));
    if (topic === "sldataset") return KB.docs.filter((d) => d.id === "sld-overview").map((d) => ({ type: "kb", ...d, s: 1 }));
    if (topic === "about")     return KB.docs.filter((d) => d.id === "about-owner").map((d) => ({ type: "kb", ...d, s: 1 }));
  }
  return all;
}

async function buildContext(question, topic) {
  const ranked = await topK(question, 8, topic);
  const ctx = ranked.map((d, i) => `#${i + 1} ${d.title}\n${d.text}`).join("\n\n");
  const ids = ranked.map((d) => (d.type === "pdf" ? `pdf:${d.id}|${d.title}|page=${d.page}|${d.url}` : `kb:${d.id}|${d.title}`));
  const maxUnit = Math.max(...ranked.map((r) => r.s), 1);
  const confidence = Math.min(1, ranked.length ? ranked.reduce((a, r) => a + r.s / maxUnit, 0) / ranked.length : 0);
  return { ctx, ids, confidence };
}

/* ------------------------ providers ----------------------- */

async function askGroq({ system, user, signal }) {
  const key = process.env.GROQ_API_KEY; if (!key) throw new Error("GROQ_API_KEY not set");
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.1-70b-versatile",
      temperature: 0.2, max_tokens: 450,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}`);
  const j = await r.json(); return (j?.choices?.[0]?.message?.content ?? "").trim();
}

async function askDeepInfra({ system, user, signal }) {
  const key = process.env.DEEPINFRA_API_KEY; if (!key) throw new Error("DEEPINFRA_API_KEY not set");
  const r = await fetch("https://api.deepinfra.com/v1/openai/chat/completions", {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
      temperature: 0.2, max_tokens: 450,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`DeepInfra HTTP ${r.status}`);
  const j = await r.json(); return (j?.choices?.[0]?.message?.content ?? "").trim();
}

async function askGemini({ system, user, signal }) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error("GEMINI_API_KEY not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `${system}\n\n---\n\n${user}` }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 450 },
    }),
  });
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}`);
  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("").trim()
            || j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  return text;
}

/* ---------------------- prompting ------------------------- */

function systemPrompt(topic) {
  return [
    "You are a warm, helpful technical assistant for an album/portfolio site.",
    "Respond ONLY with facts found in the provided Knowledge Base (KB) below.",
    "If something isn't in the KB, say so briefly and invite the user to provide/ingest a PDF.",
    "Prefer short paragraphs and bullets. Use **bold** for key terms. Include friendly emojis sparingly.",
    `Topic focus: ${topic}. Stay on one topic unless the user asks to compare.`,
    "Offer 2–4 smart follow-up questions.",
  ].join(" ");
}

function userPrompt(question, ctx) {
  return [
    "KB:",
    '"""', ctx || "NO CONTEXT", '"""', "",
    `User question: ${question}`, "",
    "Instructions:",
    "- Use only KB facts. Do not invent specifics.",
    "- If unknown, say it's unspecified and suggest uploading/adding the detail.",
    "- Provide clear, practical guidance. Bullets preferred.",
  ].join("\n");
}

/* -------------------- skills (feature engine) -------------- */

const { matchSkill, buildSkillPrompt, detectCommand, SKILL_META } = require("./skills");

/* ----------------------- small talk ------------------------ */

function smallTalk(question) {
  const q = normalize(question);
  if (/^(hi|hey|hello|ayubowan|good (morning|evening|afternoon))\b/.test(q))
    return { type: "greet", reply:
      `Hi there! I'm your assistant 🤝  Ask about **AAVSS**, the **Sri Lanka dataset**, or upload a PDF for deeper answers.\n` +
      `I can also **generate images** (/gen …) or **browse references** (/browse …). What shall we do first?` };
  if (/^(thanks|thank you|cheers|appreciate)/.test(q))
    return { type: "thanks", reply: "You’re welcome! 😊  Want me to summarize something next?" };
  if (/^(bye|goodbye|see you|catch you)/.test(q))
    return { type: "bye", reply: "Goodbye! 👋 If you need me again, just open the assistant." };
  return null;
}

/* -------------------- HTTP handler (CJS) -------------------- */

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "*";
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") { res.writeHead(204, headers); res.end(); return; }
  if (req.method !== "POST")    { res.writeHead(405, headers); res.end(JSON.stringify({ error: "Only POST supported" })); return; }

  try {
    const body = await readJson(req);
    const rawQ = (body?.question ?? body?.q ?? body?.text ?? "").toString();
    const question = rawQ.trim();

    if (!question) { res.writeHead(400, headers); res.end(JSON.stringify({ error: "Missing question" })); return; }

    // Slash commands → let UI handle image gen / browse
    const cmd = detectCommand(question);
    if (cmd) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        answer: cmd.kind === "gen"
          ? `Preparing to generate images for: **${cmd.prompt}**`
          : `Searching images for: **${cmd.query}**`,
        intent: cmd.kind === "gen" ? "image_generate" : "image_browse",
        payload: cmd,
        provider: "command",
        topic: "general",
        sources: [],
        followups: cmd.kind === "gen"
          ? ["Want a cinematic or studio style?", "Change aspect ratio (1:1, 16:9, 9:16)?"]
          : ["Filter to night/rain?", "Limit to Sri Lanka?"],
      }));
      return;
    }

    // Small talk
    const st = smallTalk(question);
    if (st) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ answer: st.reply, provider: "smalltalk", topic: "general", sources: [], followups: ["Ask about AAVSS", "Ask about the Dataset", "Generate an image (/gen …)"] }));
      return;
    }

    // Retrieval
    const topic = detectTopic(question);
    const { ctx, ids, confidence } = await buildContext(question, topic);

    if (!ctx || ctx.length < 20 || confidence < 0.15) {
      const choices = [
        { id: "aavss", label: "AAVSS (vehicle safety system)" },
        { id: "sldataset", label: "Sri Lankan Driving Dataset" },
        { id: "about", label: "About/Ownership" },
      ];
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        answer: "I can help best if I know the topic. Which would you like to talk about? (AAVSS, Dataset, or About) 🙂",
        provider: "clarify", topic: "general", sources: [], followups: choices.map((c)=>`Switch to ${c.label}?`), choices
      }));
      return;
    }

    // Skill matching
    const skill = matchSkill(question);
    const sys = systemPrompt(topic);
    const usr = skill
      ? buildSkillPrompt({ question, ctx, topic, owner: OWNER, skill })
      : userPrompt(question, ctx);

    // Provider cascade
    let answer = "", provider = "";
    const providers = [];
    if (process.env.GROQ_API_KEY)       providers.push({ name: "groq",      fn: askGroq });
    if (process.env.DEEPINFRA_API_KEY)  providers.push({ name: "deepinfra", fn: askDeepInfra });
    if (process.env.GEMINI_API_KEY)     providers.push({ name: "gemini",    fn: askGemini });

    for (const p of providers) {
      try { const t = withTimeout(30_000); answer = await p.fn({ system: sys, user: usr, signal: t.signal }); t.clear(); if (answer) { provider = p.name; break; } }
      catch { /* try next */ }
    }

    if (!answer) {
      const stitched = ids.map((id, i) => {
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
      }).filter(Boolean).join("\n\n");

      answer = "I couldn’t reach the AI providers just now. Here’s a concise KB summary:\n\n" + (stitched || "No KB matches found.");
      provider = "kb-fallback";
    }

    answer = (answer || "").trim().replace(/\n{3,}/g, "\n\n");

    res.writeHead(200, headers);
    res.end(JSON.stringify({
      answer, provider, topic, confidence, sources: ids,
      followups: SKILL_META.followups(topic),
      skill: skill ? skill.id : null
    }));
  } catch (err) {
    const msg = err?.name === "AbortError" ? "Upstream request timed out" : err?.message || "Server error";
    res.writeHead(500, headers);
    res.end(JSON.stringify({ error: msg }));
  }
};
