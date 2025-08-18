// /api/ingest-pdf.js
import pdfParse from "pdf-parse";

export const config = { runtime: "nodejs18.x" };

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "*";

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors(origin)); res.end(); return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, cors(origin));
    res.end(JSON.stringify({ error: "Only POST allowed" })); return;
  }

  try {
    const { url, title = "", docId = "" } = await readJson(req);
    if (!url) {
      res.writeHead(400, cors(origin));
      res.end(JSON.stringify({ error: "Missing PDF URL" })); return;
    }

    const r = await fetch(url);
    if (!r.ok) {
      res.writeHead(400, cors(origin));
      res.end(JSON.stringify({ error: `Failed to fetch PDF: ${r.status}` })); return;
    }

    const buffer = Buffer.from(await r.arrayBuffer());
    const parsed = await pdfParse(buffer);

    res.writeHead(200, cors(origin));
    res.end(JSON.stringify({
      ok: true,
      meta: {
        title: title || parsed?.info?.Title || "",
        pages: parsed?.numpages || 0,
        docId
      },
      bytes: buffer.length,
      preview: (parsed.text || "").slice(0, 600)
    }));
  } catch (e) {
    res.writeHead(500, cors(origin));
    res.end(JSON.stringify({ error: e?.message || "Server error" }));
  }
}
