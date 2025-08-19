// api/ingest-pdf.js — Ingest a PDF by URL → chunk → persist to Vercel Blob
export const config = { runtime: "nodejs18.x" };

import { put, list } from "@vercel/blob";
import pdfParse from "pdf-parse";

/* ---------- tiny utils ---------- */
function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
}

// Convert GitHub “blob/…” → raw.githubusercontent.com/…
function toRawGitHub(u) {
  try {
    const url = new URL(u);
    if (url.hostname === "github.com" && url.pathname.includes("/blob/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      // /{user}/{repo}/blob/{sha}/{path...}
      const user = parts[0], repo = parts[1], sha = parts[3];
      const rest = parts.slice(4).join("/");
      return `https://raw.githubusercontent.com/${user}/${repo}/${sha}/${rest}`;
    }
    return u;
  } catch { return u; }
}

// Clean & chunk long text into overlapping slices
function chunkText(text, { maxChars = 1800, overlap = 200 } = {}) {
  const t = (text || "").replace(/\u0000/g, "").trim();
  if (t.length <= maxChars) return [t];
  const out = [];
  let i = 0;
  while (i < t.length) {
    const slice = t.slice(i, i + maxChars);
    out.push(slice);
    i += (maxChars - overlap);
  }
  return out;
}

// Load docs.json from Vercel Blob (if exists), otherwise {docs:[]}
async function loadStore() {
  const lst = await list({ prefix: "docs/" });
  const hit = lst.blobs.find(b => b.pathname === "docs/docs.json");
  if (!hit) return { docs: [] };
  try {
    const r = await fetch(hit.url);
    const j = await r.json();
    return j && Array.isArray(j.docs) ? j : { docs: [] };
  } catch { return { docs: [] }; }
}

// Save docs.json back to Blob (public, stable path)
async function saveStore(data) {
  const body = JSON.stringify(data, null, 2);
  const res = await put("docs/docs.json", body, {
    access: "public",
    contentType: "application/json; charset=utf-8",
    addRandomSuffix: false
  });
  return res.url; // public URL of the JSON
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  const origin = req.headers.origin || "*";
  if (req.method === "OPTIONS") { res.writeHead(204, cors(origin)); res.end(); return; }
  if (req.method !== "POST")    { res.writeHead(405, cors(origin)); res.end(JSON.stringify({ error:"Only POST allowed" })); return; }

  try {
    const { url, title = "", docId = "" } = req.body || {};
    if (!url || !docId) {
      res.writeHead(400, cors(origin));
      res.end(JSON.stringify({ error: "Missing url or docId" }));
      return;
    }

    const fetchUrl = toRawGitHub(url);
    const pdfRes = await fetch(fetchUrl);
    if (!pdfRes.ok) {
      res.writeHead(400, cors(origin));
      res.end(JSON.stringify({ error: `Failed to fetch PDF: HTTP ${pdfRes.status}` }));
      return;
    }

    const ab = await pdfRes.arrayBuffer();
    const buffer = Buffer.from(ab);
    const parsed = await pdfParse(buffer);

    // Basic chunking (you can tune sizes)
    const chunks = chunkText(parsed.text, { maxChars: 1800, overlap: 220 });

    // Load, replace any old entries with same docId, then save
    const store = await loadStore();
    const prefix = `${docId}::`;
    const filtered = (store.docs || []).filter(d => !String(d.id || "").startsWith(prefix));

    const now = new Date().toISOString();
    const items = chunks.map((text, i) => ({
      id: `${docId}::${i + 1}`,
      docId,
      title: title || parsed?.info?.Title || "Untitled PDF",
      text,
      page: i + 1,          // pseudo "page" (by chunk index)
      url: fetchUrl,
      addedAt: now
    }));

    const next = { docs: filtered.concat(items) };
    const jsonUrl = await saveStore(next);

    res.writeHead(200, cors(origin));
    res.end(JSON.stringify({
      ok: true,
      meta: {
        docId,
        title: title || parsed?.info?.Title || "",
        pagesDetected: parsed?.numpages || 0,
        chunks: items.length,
        storeUrl: jsonUrl
      },
      preview: parsed.text.slice(0, 600)
    }));
  } catch (err) {
    res.writeHead(500, cors(origin));
    res.end(JSON.stringify({ error: err?.message || "Server error" }));
  }
}