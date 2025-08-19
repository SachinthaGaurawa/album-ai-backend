// CommonJS, Node 18 serverless function
const pdfParse = require("pdf-parse");

// Tell Vercel to run this as Node (not Edge)
module.exports.config = { runtime: "nodejs18.x" };

/* ---------- helpers ---------- */
function cors(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin,
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
      catch (e) { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function isLikelyPdf(res, url) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/pdf")) return true;
  // allow raw links where servers forget the header
  try { if (new URL(url).pathname.toLowerCase().endsWith(".pdf")) return true; } catch {}
  return false;
}

/* ---------- handler ---------- */
module.exports = async (req, res) => {
  const origin = req.headers.origin || "*";

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors(origin)); res.end(); return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, cors(origin));
    res.end(JSON.stringify({ error: "Only POST allowed" }));
    return;
  }

  try {
    const body = await readJson(req);
    const url   = String(body.url || "").trim();
    const title = String(body.title || "");
    const docId = String(body.docId || "");

    if (!url) {
      res.writeHead(400, cors(origin));
      res.end(JSON.stringify({ error: "Missing 'url' (PDF link) in JSON body" }));
      return;
    }

    // IMPORTANT: GitHub files must be the RAW URL.
    // Example:
    // https://raw.githubusercontent.com/<user>/<repo>/main/reports/AAVSS_Report.pdf
    console.log("[ingest] fetching:", url);
    const r = await fetch(url, { redirect: "follow" });

    if (!r.ok) {
      res.writeHead(400, cors(origin));
      res.end(JSON.stringify({ error: `Fetch failed: HTTP ${r.status}` }));
      return;
    }
    if (!isLikelyPdf(r, url)) {
      res.writeHead(400, cors(origin));
      res.end(JSON.stringify({
        error: "URL did not return a PDF",
        hint: "If this is a GitHub link, use the raw.githubusercontent.com URL."
      }));
      return;
    }

    const ab = await r.arrayBuffer();
    const buf = Buffer.from(ab);

    console.time("[ingest] pdf-parse");
    const parsed = await pdfParse(buf);
    console.timeEnd("[ingest] pdf-parse");

    const meta = {
      title: title || parsed?.info?.Title || "",
      pages: parsed?.numpages || 0,
      docId
    };

    // Here you would persist parsed.text to KV/DB; we return it partially.
    res.writeHead(200, cors(origin));
    res.end(JSON.stringify({
      ok: true,
      meta,
      bytes: buf.length,
      preview: (parsed.text || "").slice(0, 800)
    }));
  } catch (err) {
    console.error("[ingest] error:", err);
    res.writeHead(500, cors(origin));
    res.end(JSON.stringify({ error: err?.message || "Server error" }));
  }
};
