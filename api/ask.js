// api/ask.js — RAG: retrieve relevant chunks then answer with DeepInfra chat (no streaming).
export const config = { runtime: "nodejs18.x" };

const { getRelevantDocs } = require("../db");

/* CORS */
function corsHeaders(origin) {
  const allowed = (process.env.CORS_ORIGINS || "")
    .split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
  const o = (origin || "").replace(/\/+$/, "");
  const ok = !origin || allowed.length === 0 || allowed.includes(o);
  return {
    ...(ok ? { "Access-Control-Allow-Origin": origin || "*" } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  };
}
function send(res, status, headers, obj) { res.writeHead(status, headers); res.end(JSON.stringify(obj)); }

const EMBED_MODEL = "BAAI/bge-large-en-v1.5";
const CHAT_MODEL  = "meta-llama/Meta-Llama-3.1-70B-Instruct";

/* DeepInfra helpers */
async function embedQuery(q, signal){
  const key = process.env.DEEPINFRA_API_KEY;
  if (!key) throw new Error("DEEPINFRA_API_KEY not set");
  const url = "https://api.deepinfra.com/v1/inference/" + encodeURIComponent(EMBED_MODEL);
  const r = await fetch(url, {
    method: "POST", signal,
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: [q] })
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j?.error || `DeepInfra embed HTTP ${r.status}`);
  const vec = j?.data?.[0]?.embedding || j?.embeddings?.[0] || j?.output?.[0];
  if (!Array.isArray(vec)) throw new Error("Embedding not returned");
  return vec;
}

async function answerWithDeepInfra(question, context, signal){
  const key = process.env.DEEPINFRA_API_KEY;
  if (!key) throw new Error("DEEPINFRA_API_KEY not set");
  const url = "https://api.deepinfra.com/v1/openai/chat/completions";
  const messages = [
    { role: "system", content: "You are a warm, concise expert. Use ONLY the provided context. If unknown, say so briefly." },
    { role: "system", content: "Context:\n" + (context || "NO CONTEXT") },
    { role: "user",   content: question }
  ];
  const r = await fetch(url, {
    method: "POST", signal,
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: CHAT_MODEL, messages, temperature: 0.3, max_tokens: 500 })
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j?.error?.message || `DeepInfra chat HTTP ${r.status}`);
  return (j?.choices?.[0]?.message?.content || "").trim();
}

module.exports = async (req, res) => {
  const headers = corsHeaders(req.headers.origin || req.headers.Origin);
  if (req.method === "OPTIONS") return send(res, 204, headers, null);

  let question, userId;
  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    question = url.searchParams.get("q") || "";
    userId   = url.searchParams.get("userId") || null;
  } else if (req.method === "POST") {
    try {
      const chunks = []; for await (const ch of req) chunks.push(ch);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      question = body.question || body.q || "";
      userId   = body.userId || null;
    } catch { question = ""; userId = null; }
  } else {
    return send(res, 405, headers, { error: "Method Not Allowed" });
  }

  if (!question) return send(res, 400, headers, { error: "No question provided." });

  try {
    // Embed query → retrieve 3 best chunks
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 30000);
    const qVec = await embedQuery(question, ac.signal);
    const chunks = await getRelevantDocs(userId, qVec, 3);
    const ctx = (chunks || []).join("\n---\n");

    // Answer with DI chat
    const ans = await answerWithDeepInfra(question, ctx, ac.signal);
    clearTimeout(timeout);

    return send(res, 200, headers, { answer: ans, provider: "deepinfra", context_used: chunks.length });
  } catch (err) {
    return send(res, 500, headers, { error: err?.message || "Failed to answer." });
  }
};
