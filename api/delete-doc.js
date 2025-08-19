// api/delete-doc.js — Admin-only: remove a document's chunks from storage/docs.json
export const config = { runtime: "nodejs18.x" };

import fs from "fs";
import path from "path";

/* ── CORS (match your other endpoints) ─────────────────────── */
function corsHeaders(origin) {
  const ALLOWED = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map(s => s.trim().replace(/\/+$/, ""))
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

/* ── tiny fs utils ─────────────────────────────────────────── */
const STORE_DIR  = path.join(process.cwd(), "storage");
const STORE_PATH = path.join(STORE_DIR, "docs.json");

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return { docs: [] };
  }
}
function writeStore(obj) {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2), "utf-8");
}

/* ── handler ───────────────────────────────────────────────── */
export default async function handler(req, res) {
  const origin = req.headers.origin || "*";
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") { res.writeHead(204, headers); res.end(); return; }
  if (req.method !== "POST")    { res.writeHead(405, headers); res.end(JSON.stringify({ error: "Only POST allowed" })); return; }

  // Simple admin auth: require Authorization: Bearer <ADMIN_TOKEN>
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    res.writeHead(401, headers);
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  try {
    const { docId, url } = req.body || {};
    if (!docId && !url) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: "Provide docId or url to delete" }));
      return;
    }

    const store = readStore();
    const before = store.docs.length;

    const keep = store.docs.filter(ch => {
      if (docId && ch.docId === docId) return false;
      if (url && ch.url === url) return false;
      return true;
    });

    const removed = before - keep.length;
    writeStore({ docs: keep });

    res.writeHead(200, headers);
    res.end(JSON.stringify({
      ok: true,
      removed,
      remaining: keep.length,
      by: docId ? { docId } : { url }
    }));
  } catch (err) {
    res.writeHead(500, headers);
    res.end(JSON.stringify({ error: err?.message || "Server error" }));
  }
}