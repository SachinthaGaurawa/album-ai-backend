// api/ingest-pdf.js — Node serverless function (NOT edge)
import pdfParse from "pdf-parse";

/** Tell Vercel to run this as a Node function */
export const config = { runtime: "nodejs18.x" };

/** Simple permissive CORS (tighten origins if you like) */
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "*";

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, corsHeaders(origin));
    res.end(JSON.stringify({ error: "Only POST allowed" }));
    return;
  }

  try {
    const { url, title = "", docId = "" } = req.body || {};
    if (!url) {
      res.writeHead(400, corsHeaders(origin));
      res.end(JSON.stringify({ error: "Missing PDF URL" }));
      return;
    }

    // IMPORTANT: for GitHub PDFs use RAW links (raw.githubusercontent.com/…)
    const pdfRes = await fetch(url);
    if (!pdfRes.ok) {
      res.writeHead(400, corsHeaders(origin));
      res.end(JSON.stringify({ error: `Failed to fetch PDF: ${pdfRes.status}` }));
      return;
    }

    const arrayBuffer = await pdfRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const parsed = await pdfParse(buffer);
    const meta = {
      title: title || parsed?.info?.Title || "",
      pages: parsed?.numpages || 0,
      docId: docId || "",
    };

    // Here you would normally index `parsed.text` into your KB/vector store.
    // For now we just return a success payload with stats.
    res.writeHead(200, corsHeaders(origin));
    res.end(JSON.stringify({
      ok: true,
      meta,
      bytes: buffer.length,
      preview: parsed.text.slice(0, 600) // first 600 chars
    }));
  } catch (err) {
    res.writeHead(500, corsHeaders(origin));
    res.end(JSON.stringify({ error: err?.message || "Server error" }));
  }
}
