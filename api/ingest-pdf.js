// /api/ingest-pdf.js
// Ingest a PDF by upload or URL, chunk + embed via DeepInfra REST, store in Postgres.
// CommonJS, Node runtime.

'use strict';

module.exports.config = { runtime: 'nodejs18.x' };

const pdfParse = require('pdf-parse');
const { pool } = require('../db');

/* ---------------- CORS ---------------- */
function corsHeaders(origin) {
  const whitelist = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const o = (origin || '').replace(/\/+$/, '');
  const ok = !origin || whitelist.length === 0 || whitelist.includes(o);
  return {
    ...(ok ? { 'Access-Control-Allow-Origin': origin || '*' } : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  };
}
function send(res, status, headers, obj) {
  try { res.writeHead(status, headers); } catch (_) {}
  if (obj == null) return res.end();
  res.end(JSON.stringify(obj));
}

/* -------- DeepInfra Embeddings (REST) -------- */
const EMBED_MODEL = 'BAAI/bge-large-en-v1.5'; // 1024 dims

async function embedText(text, signal) {
  const key = process.env.DEEPINFRA_API_KEY;
  if (!key) throw new Error('DEEPINFRA_API_KEY not set');

  const url = 'https://api.deepinfra.com/v1/inference/' + encodeURIComponent(EMBED_MODEL);

  const r = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    // DeepInfra inference accepts array input for batch; we send [text]
    body: JSON.stringify({ input: [text] }),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // DeepInfra usually returns { error: "..." }
    throw new Error(j?.error || `DeepInfra embed HTTP ${r.status}`);
  }

  // Try common shapes from DeepInfra models
  // - { data: [ { embedding: [...] } ] }
  // - { embeddings: [ [...] ] }
  // - { output: [ [...] ] }
  const vec =
    j?.data?.[0]?.embedding ||
    j?.embeddings?.[0] ||
    j?.output?.[0];

  if (!Array.isArray(vec)) throw new Error('Embedding not returned');
  return vec;
}

/* ---------------- Helpers ---------------- */
const MAX_TEXT_CHARS = 1_000_000;
const CHUNK_SIZE = 1000; // ~750–800 tokens for English prose

function splitIntoChunks(raw) {
  const paras = String(raw || '')
    .split(/\n\s*\n/)
    .map(s => s.trim())
    .filter(Boolean);

  const out = [];
  for (const p of paras) {
    if (p.length <= CHUNK_SIZE) {
      out.push(p);
    } else {
      for (let i = 0; i < p.length; i += CHUNK_SIZE) {
        out.push(p.slice(i, i + CHUNK_SIZE));
      }
    }
  }
  return out;
}

async function readRequestBody(req) {
  const bufs = [];
  for await (const ch of req) bufs.push(ch);
  return Buffer.concat(bufs);
}

/* ---------------- Handler ---------------- */
module.exports = async (req, res) => {
  const headers = corsHeaders(req.headers.origin || req.headers.Origin);

  if (req.method === 'OPTIONS') return send(res, 204, headers, null);
  if (req.method !== 'POST')    return send(res, 405, headers, { error: 'Only POST allowed' });

  try {
    const urlUserId = req.query.userId;
    const headerUserId = req.headers['x-user-id'];
    let pdfBuffer = null;
    let filename = null;
    let userId = null;

    // If Content-Type is PDF, stream the raw body
    const ctype = (req.headers['content-type'] || '').toLowerCase();
    if (ctype.includes('application/pdf')) {
      pdfBuffer = await readRequestBody(req);
      filename = (req.query.filename || 'document.pdf').toString();
      userId = (urlUserId || headerUserId || null)?.toString() || null;
    } else {
      // Otherwise expect JSON body (may include { file: base64 } or { url } and optional userId)
      let json = {};
      try {
        const raw = await readRequestBody(req);
        json = JSON.parse(raw.toString('utf8') || '{}');
      } catch { json = {}; }

      userId = (urlUserId || headerUserId || json.userId || null)?.toString() || null;

      if (json.file) {
        pdfBuffer = Buffer.from(json.file, 'base64');
        filename = (json.filename || 'document.pdf').toString();
      } else if (json.url || req.query.url) {
        const pdfUrl = (json.url || req.query.url).toString();
        const fr = await fetch(pdfUrl);
        if (!fr.ok) throw new Error(`Failed to fetch PDF: ${fr.status}`);
        const ab = await fr.arrayBuffer();
        pdfBuffer = Buffer.from(ab);
        filename = (pdfUrl.split('/').pop() || 'document.pdf').split('?')[0];
      }
    }

    if (!pdfBuffer) {
      return send(res, 400, headers, { error: 'No PDF file or URL provided.' });
    }

    // 2) Extract text
    const parsed = await pdfParse(pdfBuffer);
    let text = (parsed.text || '').trim();
    if (!text) return send(res, 400, headers, { error: 'PDF contains no extractable text.' });
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);

    // 3) Insert document row
    const docName = (filename ? filename.replace(/\.pdf$/i, '') : `Document_${Date.now()}`).slice(0, 255);
    const ins = await pool.query(
      `INSERT INTO documents(user_id, name) VALUES($1,$2) RETURNING id`,
      [userId, docName]
    );
    const docId = ins.rows[0].id;

    // 4) Chunk + embed + store
    const chunks = splitIntoChunks(text);
    let stored = 0;

    for (const chunk of chunks) {
      if (!chunk || chunk.length < 20) continue; // skip tiny noise
      const vec = await embedText(chunk);
      const vecStr = '[' + vec.join(',') + ']'; // pgvector text format
      await pool.query(
        `INSERT INTO document_chunks(doc_id, user_id, content, embeddings)
         VALUES($1,$2,$3,$4::vector)`,
        [docId, userId, chunk, vecStr]
      );
      stored++;
    }

    return send(res, 200, headers, {
      ok: true,
      documentId: docId,
      name: docName,
      chunks: stored,
      pages: parsed.numpages || parsed.numpages === 0 ? parsed.numpages : undefined,
    });
  } catch (err) {
    return send(res, 500, headers, { error: err?.message || 'Server error' });
  }
};
