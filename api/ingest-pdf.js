// api/ingest-pdf.js  — Node runtime (NOT edge)
export const config = { runtime: 'nodejs18.x' };

import fetch from 'node-fetch';
import { readFile } from 'fs/promises';
import path from 'path';
import fs from 'fs';
import pdf from 'pdf-parse'; // npm i pdf-parse

// Storage file (simple, portable). For prod, use Vercel KV or Blob.
const STORE = path.join(process.cwd(), 'storage', 'docs.json');

// Ensure storage folder
fs.mkdirSync(path.dirname(STORE), { recursive: true });

function chunkText(text, { size = 1100, overlap = 150 } = {}) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + size);
    const chunk = text.slice(i, end);
    out.push(chunk.trim());
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return out.filter(Boolean);
}

async function loadPDF(buf) {
  const data = await pdf(buf, { pagerender: (p) => p.getTextContent().then(tc => tc.items.map(i=>i.str).join(' ')) });
  // pdf-parse gives one big text; page text is in data.text with \n\n between pages.
  const pages = String(data.text || '').split(/\n\s*\n/g); // rough page split
  return pages.map((t, idx) => ({ page: idx + 1, text: t.trim() })).filter(p => p.text);
}

function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf-8')); } catch { return { docs: [] }; }
}
function writeStore(obj) {
  fs.writeFileSync(STORE, JSON.stringify(obj, null, 2), 'utf-8');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = await (async () => {
      try { return JSON.parse(req.body || '{}'); } catch { return {}; }
    })();

    const { url, title, docId } = body || {};
    if (!url || !title || !docId) return res.status(400).json({ error: 'Missing url, title, docId' });

    const r = await fetch(url);
    if (!r.ok) return res.status(400).json({ error: `Fetch failed: ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());

    const pages = await loadPDF(buf);

    // Build chunks
    const chunks = [];
    for (const p of pages) {
      const cs = chunkText(p.text);
      cs.forEach((c, i) => {
        chunks.push({
          id: `${docId}-p${p.page}-c${i + 1}`,
          docId,
          title,
          page: p.page,
          text: c,
          url,        // source PDF
        });
      });
    }

    // Persist
    const store = readStore();
    // Remove old entries for docId then add new
    store.docs = (store.docs || []).filter(d => d.docId !== docId).concat(chunks);
    writeStore(store);

    res.json({ ok: true, chunks: chunks.length });
  } catch (e) {
    res.status(500).json({ error: e.message || 'server error' });
  }
}
