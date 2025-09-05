// pages/api/ask.js
export const config = { api: { bodyParser: true, responseLimit: false } };

import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const EMBED_MODEL = "BAAI/bge-large-en-v1.5";

async function embedText(text, signal) {
  const key = process.env.DEEPINFRA_API_KEY;
  if (!key) throw new Error("DEEPINFRA_API_KEY not set");
  const url = `https://api.deepinfra.com/v1/inference/${encodeURIComponent(EMBED_MODEL)}`;
  const r = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: [text] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `DeepInfra embed HTTP ${r.status}`);
  const vec =
    j?.data?.[0]?.embedding || j?.embeddings?.[0] || j?.output?.[0];
  if (!Array.isArray(vec)) throw new Error("Embedding not returned");
  return vec;
}

async function askGroq(model, messages, temperature = 0.3, max_tokens = 768, signal) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not set");
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens,
      stream: false,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Groq error ${r.status}`);
  return j.choices?.[0]?.message?.content || "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const userId   = (body.userId || body.user_id || "").trim();
    const question = (body.question || "").trim();
    if (!question) return res.status(400).json({ error: 'Missing "question"' });

    // 1) Embed question
    const qVec = await embedText(question);

    // 2) Similarity search (cosine distance)
    const vecStr = "[" + qVec.join(",") + "]";
    const topk = await pool.query(
      `SELECT content
         FROM document_chunks
        WHERE ($1::text = '' OR user_id = $1)
        ORDER BY embeddings <=> $2::vector   -- cosine distance
        LIMIT 5`,
      [userId, vecStr]
    );

    const context = topk.rows.map(r => r.content).join("\n---\n");
    const sys = [
      "You are a concise expert assistant.",
      "Use the provided CONTEXT if relevant; if not, answer from general knowledge and say so.",
      "Prefer bullet points and short paragraphs.",
    ].join("\n");

    const messages = [
      { role: "system", content: sys },
      { role: "system", content: "CONTEXT:\n" + (context || "(no matching context)") },
      { role: "user",   content: question },
    ];

    const model = process.env.GROQ_MODEL || "llama-3.1-70b-versatile";
    const answer = await askGroq(model, messages, +(process.env.AI_TEMPERATURE || 0.3), +(process.env.AI_MAX_TOKENS || 768));

    return res.status(200).json({
      ok: true,
      answer,
      usedContext: topk.rows.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
