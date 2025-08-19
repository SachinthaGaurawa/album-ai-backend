// api/delete-doc.js — remove a document (by docId) from the store
export const config = { runtime: "nodejs18.x" };

import { put, list } from "@vercel/blob";

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
}

async function loadStore() {
  const lst = await list({ prefix: "docs/" });
  const hit = lst.blobs.find(b => b.pathname === "docs/docs.json");
  if (!hit) return { docs: [] };
  const r = await fetch(hit.url);
  try { return await r.json(); } catch { return { docs: [] }; }
}

async function saveStore(data) {
  const body = JSON.stringify(data, null, 2);
  await put("docs/docs.json", body, {
    access: "public",
    contentType: "application/json; charset=utf-8",
    addRandomSuffix: false
  });
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "*";
  if (req.method === "OPTIONS") { res.writeHead(204, cors(origin)); res.end(); return; }
  if (req.method !== "POST")    { res.writeHead(405, cors(origin)); res.end(JSON.stringify({ error:"Only POST allowed" })); return; }

  try {
    const { docId } = req.body || {};
    if (!docId) {
      res.writeHead(400, cors(origin));
      res.end(JSON.stringify({ error: "Missing docId" }));
      return;
    }
    const store = await loadStore();
    const next = { docs: (store.docs || []).filter(d => d.docId !== docId) };
    await saveStore(next);
    res.writeHead(200, cors(origin));
    res.end(JSON.stringify({ ok: true, removedDocId: docId, remaining: next.docs.length }));
  } catch (e) {
    res.writeHead(500, cors(origin));
    res.end(JSON.stringify({ error: e?.message || "Server error" }));
  }
}