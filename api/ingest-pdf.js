// api/ingest-pdf.js
import fetch from "node-fetch";
import pdfParse from "pdf-parse";

export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { url, title, docId } = await req.json();

    if (!url) {
      return new Response(JSON.stringify({ error: "Missing PDF URL" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // fetch the PDF
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch PDF: ${res.status}`);
    const buffer = await res.arrayBuffer();

    // parse PDF
    const data = await pdfParse(Buffer.from(buffer));

    // TODO: save this into your KB / DB
    // for now we just return the text
    return new Response(
      JSON.stringify({
        docId,
        title,
        url,
        text: data.text.slice(0, 2000), // return first 2k chars for demo
        status: "PDF ingested successfully",
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
