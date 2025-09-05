// pages/api/ingest-pdf.js
// Ingest a PDF by upload (application/pdf) or by {url} JSON.
// Extract text, chunk, embed (DeepInfra), and store to Neon (pgvector).

export const config = {
  api: {
    bodyParser: false,      // <-- IMPORTANT: allow binary uploads (fixes “Invalid JSON body”)
    responseLimit: false,
  },
};

const pdfParse = require("pdf-parse");
const { Pool } = require("pg");

// Re-use your existing db.js if you already have one.
// Otherwise this Pool is safe to keep here.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ---------------- CORS ---------------- */
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
    "Content-Type": "application/json; charset=utf-8",
  };
}
function send(res, status, headers, obj) {
  try { res.writeHead(status, headers); } catch {}
  res.end(obj == null ? "" : JSON.stringify(obj));
}

/* ------------- DeepInfra Embeddings (REST) ------------- */
const EMBED_MODEL = "BAAI/bge-large-en-v1.5"; // 1024 dims
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

/* ---------------- Helpers ---------------- */
const CHUNK_SIZE = 1000; // chars
function splitIntoChunks(raw) {
  const paras = String(raw || "")
    .split(/\n\s*\n/)
    .map(s => s.trim())
    .filter(Boolean);
  const out = [];
  for (const p of paras) {
    if (p.length <= CHUNK_SIZE) out.push(p);
    else for (let i = 0; i < p.length; i += CHUNK_SIZE) out.push(p.slice(i, i + CHUNK_SIZE));
  }
  return out;
}

/* ---------------- Handler ---------------- */
export default async function handler(req, res) {
  const headers = corsHeaders(req.headers.origin || req.headers.Origin);
  if (req.method === "OPTIONS") return send(res, 204, headers, null);
  if (req.method !== "POST")    return send(res, 405, headers, { error: "Only POST allowed" });

  try {
    const userId =
      req.query.userId || req.headers["x-user-id"] || null;

    // 1) Read PDF: (a) raw upload with Content-Type: application/pdf
    //              (b) JSON body { url: "https://..." }  OR  { file: base64 }
    let pdfBuffer = null, filename = "document.pdf";

    const ct = req.headers["content-type"] || "";
    if (ct.includes("application/pdf")) {
      const bufs = [];
      for await (const ch of req) bufs.push(ch);
      pdfBuffer = Buffer.concat(bufs);
      if (req.query.filename) filename = String(req.query.filename);
    } else {
      // Read raw request into JSON safely
      let json = {};
      const bufs = [];
      for await (const ch of req) bufs.push(ch);
      const raw = Buffer.concat(bufs).toString("utf8");
      try { json = raw ? JSON.parse(raw) : {}; } catch { json = {}; }

      if (json.file) {
        pdfBuffer = Buffer.from(json.file, "base64");
        if (json.filename) filename = String(json.filename);
      } else if (json.url || req.query.url) {
        const pdfUrl = json.url || req.query.url;
        const fr = await fetch(pdfUrl);
        if (!fr.ok) throw new Error(`Failed to fetch PDF: ${fr.status}`);
        const ab = await fr.arrayBuffer();
        pdfBuffer = Buffer.from(ab);
        filename = (pdfUrl.split("/").pop() || filename).split("?")[0];
      }
    }

    if (!pdfBuffer) {
      return send(res, 400, headers, { error: "No PDF file or URL provided." });
    }

    // 2) Extract text
    const parsed = await pdfParse(pdfBuffer);
    let text = (parsed.text || "").trim();
    if (!text) return send(res, 400, headers, { error: "PDF contains no extractable text." });
    if (text.length > 1_000_000) text = text.slice(0, 1_000_000);

    // 3) Insert the document
    const docName = filename.replace(/\.pdf$/i, "");
    const ins = await pool.query(
      `INSERT INTO documents(user_id, name, created_at) VALUES ($1,$2,NOW()) RETURNING id`,
      [userId, docName]
    );
    const docId = ins.rows[0].id;

    // 4) Chunk, embed, store
    const chunks = splitIntoChunks(text);
    let stored = 0;

    for (const chunk of chunks) {
      if (!chunk || chunk.length < 20) continue;
      const vec = await embedText(chunk);
      const vecStr = "[" + vec.join(",") + "]";
      await pool.query(
        `INSERT INTO document_chunks(doc_id, user_id, content, embeddings)
         VALUES ($1,$2,$3,$4::vector)`,
        [docId, userId, chunk, vecStr]
      );
      stored++;
    }

    return send(res, 200, headers, {
      ok: true,
      documentId: docId,
      name: docName,
      chunks: stored,
      meta: { pages: parsed.numpages, bytes: pdfBuffer.length },
      preview: text.slice(0, 600),
    });
  } catch (err) {
    return send(res, 500, headers, { error: err?.message || "Server error" });
  }
}
