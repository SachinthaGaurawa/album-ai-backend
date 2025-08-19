// api/docs.json.js — return the persisted docs store
export const config = { runtime: "nodejs18.x" };

import { list } from "@vercel/blob";

function headers() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
}

export default async function handler(_req, res) {
  try {
    const lst = await list({ prefix: "docs/" });
    const hit = lst.blobs.find(b => b.pathname === "docs/docs.json");
    if (!hit) {
      res.writeHead(200, headers());
      res.end(JSON.stringify({ docs: [] }));
      return;
    }
    const r = await fetch(hit.url);
    const j = await r.json();
    res.writeHead(200, headers());
    res.end(JSON.stringify(j && j.docs ? j : { docs: [] }));
  } catch (e) {
    res.writeHead(500, headers());
    res.end(JSON.stringify({ error: e?.message || "Server error" }));
  }
}