// api/ingest-pdf.js  — Ingest a PDF by upload or URL, chunk + embed via DeepInfra REST, store in Postgres.
// CommonJS, Node runtime.

export const config = { runtime: "nodejs18.x" };

const pdfParse = require("pdf-parse");
const { pool } = require("../db");

/* ---------- CORS ---------- */
function corsHeaders(origin) {
  const allowed = (process.env.CORS_ORIGINS || "")
    .split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
  const o = (origin || "").replace(/\/+$/, "");
  const ok = !origin || allowed.length === 0 || allowed.includes(o);
  return {
    ...(ok ? { "Access-Control-Allow-Origin": origin || "*" } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  };
}
function send(res, status, headers, obj) {
  res.writeHead(status, headers); res.end(JSON.stringify(obj));
}

/* ---------- DeepInfra Embeddings (REST) ---------- */
const EMBED_MODEL = "BAAI/bge-large-en-v1.5"; // 1024 dims
async function embedText(text, signal) {
  const key = process.env.DEEPINFRA_API_KEY;
  if (!key) throw new Error("DEEPINFRA_API_KEY not set");
  const url = "https://api.deepinfra.com/v1/inference/" + encodeURIComponent(EMBED_MODEL);

  const r = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: [text] }) // DeepInfra embedding APIs accept arrays on many models
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `DeepInfra embed HTTP ${r.status}`);
  // Normalize: expect nested arrays -> take first vector
  const vec = j?.data?.[0]?.embedding || j?.embeddings?.[0] || j?.output?.[0];
  if (!Array.isArray(vec)) throw new Error("Embedding not returned");
  return vec;
}

/* ---------- Helpers ---------- */
const CHUNK_SIZE = 1000; // ~750–800 tokens on average with English prose
function splitIntoChunks(raw) {
  const paras = String(raw || "").split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const p of paras) {
    if (p.length <= CHUNK_SIZE) out.push(p);
    else {
      for (let i = 0; i < p.length; i += CHUNK_SIZE) out.push(p.slice(i, i + CHUNK_SIZE));
    }
  }
  return out;
}

/* ---------- Handler ---------- */
module.exports = async (req, res) => {
  const headers = corsHeaders(req.headers.origin || req.headers.Origin);
  if (req.method === "OPTIONS") return send(res, 204, headers, null);
  if (req.method !== "POST")    return send(res, 405, headers, { error: "Only POST allowed" });

  try {
    const userId =
      req.query.userId || req.headers["x-user-id"] || (req.body && req.body.userId) || null;

    // 1) Read PDF (three modes: raw upload, base64 body, url)
    let pdfBuffer = null, filename = null;

    if ((req.headers["content-type"] || "").includes("application/pdf")) {
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      pdfBuffer = Buffer.concat(chunks);
      filename = req.query.filename || "document.pdf";
    } else {
      // Body may be JSON (read safely)
      let json = {};
      try {
        const chunks = []; for await (const ch of req) chunks.push(ch);
        json = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch { json = {}; }

      if (json.file) {
        pdfBuffer = Buffer.from(json.file, "base64");
        filename = json.filename || "document.pdf";
      } else if (json.url || req.query.url) {
        const pdfUrl = json.url || req.query.url;
        const fr = await fetch(pdfUrl);
        if (!fr.ok) throw new Error(`Failed to fetch PDF: ${fr.status}`);
        pdfBuffer = Buffer.from(await fr.arrayBuffer());
        filename = (pdfUrl.split("/").pop() || "document.pdf").split("?")[0];
      }
    }

    if (!pdfBuffer) return send(res, 400, headers, { error: "No PDF file or URL provided." });

    // 2) Extract text
    const data = await pdfParse(pdfBuffer);
    let text = (data.text || "").trim();
    if (!text) return send(res, 400, headers, { error: "PDF contains no extractable text." });
    if (text.length > 1_000_000) text = text.slice(0, 1_000_000);

    // 3) Insert document row
    const docName = filename ? filename.replace(/\.pdf$/i, "") : `Document_${Date.now()}`;
    const ins = await pool.query(
      `INSERT INTO documents(user_id, name) VALUES($1,$2) RETURNING id`,
      [userId, docName]
    );
    const docId = ins.rows[0].id;

    // 4) Chunk + embed + store
    const chunks = splitIntoChunks(text);
    for (const chunk of chunks) {
      // Avoid embedding empty or super short lines
      if (!chunk || chunk.length < 20) continue;
      const vec = await embedText(chunk);
      const vecStr = "[" + vec.join(",") + "]";
      await pool.query(
        `INSERT INTO document_chunks(doc_id, user_id, content, embeddings)
         VALUES($1,$2,$3,$4::vector)`,
        [docId, userId, chunk, vecStr]
      );
    }

    return send(res, 200, headers, { ok: true, documentId: docId, chunks: chunks.length, name: docName });
  } catch (err) {
    const msg = err?.message || "Server error";
    return send(res, 500, headers, { error: msg });
  }
};
