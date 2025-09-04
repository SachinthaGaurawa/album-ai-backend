// api/ingest-pdf.js – Accepts a PDF (via upload or URL), extracts text, splits into chunks, and stores in the knowledge base.
const pdfParse = require('pdf-parse');
const { pool, deleteDocument } = require('../db');
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { embed } from 'ai';

const deepinfraProvider = createDeepInfra({
  apiKey: process.env.DEEPINFRA_TOKEN
});
const EMBED_MODEL_ID = 'BAAI/bge-large-en-v1.5';  // embedding model (must match vector dimension in DB)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }
  try {
    const userId = req.query.userId || req.body?.userId || (req.headers['x-user-id'] || null);
    let pdfBuffer = null;
    let filename = null;
    // If content is sent directly in the request body (binary PDF data)
    if (req.headers['content-type'] && req.headers['content-type'].includes('application/pdf')) {
      // Read the raw PDF data from the request stream
      const chunks = [];
      for await (const chunk of req) { chunks.push(chunk); }
      pdfBuffer = Buffer.concat(chunks);
      // If filename is provided in query (from form), capture it
      if (req.query.filename) {
        filename = req.query.filename;
      }
    } else if (req.body?.file) {
      // If the PDF is base64-encoded or passed as `file` in JSON (less likely), handle that
      const data = req.body.file;
      // Assuming it's base64 string
      pdfBuffer = Buffer.from(data, 'base64');
      filename = req.body.filename || 'document.pdf';
    } else if (req.body?.url || req.query.url) {
      // If a URL to the PDF is provided, fetch it
      const pdfUrl = req.body.url || req.query.url;
      const fetchRes = await fetch(pdfUrl);
      if (!fetchRes.ok) throw new Error("Failed to fetch PDF from URL");
      pdfBuffer = Buffer.from(await fetchRes.arrayBuffer());
      filename = pdfUrl.split('/').pop() || 'document.pdf';
    } else {
      res.status(400).json({ error: "No PDF file or URL provided." });
      return;
    }

    // Parse PDF to extract text
    const data = await pdfParse(pdfBuffer);
    let text = data.text.trim();
    if (!text) {
      res.status(400).json({ error: "PDF contains no extractable text." });
      return;
    }
    // Optionally, limit size to avoid extremely large texts (could implement a cutoff or summarization for very large PDFs).
    if (text.length > 1000000) {  // if >1M characters, let's truncate for now (or you could split across multiple docs or summarize).
      text = text.slice(0, 1000000);
    }

    // Insert a new document record in the DB
    const docName = filename ? filename.replace(/\.pdf$/i, '') : `Document_${Date.now()}`;
    const docInsertRes = await pool.query(
      `INSERT INTO documents(user_id, name) VALUES($1, $2) RETURNING id`, 
      [userId, docName]
    );
    const docId = docInsertRes.rows[0].id;

    // Split text into chunks
    const CHUNK_SIZE = 1000;  // characters per chunk (should align with ~512 tokens as configured)
    const chunks = [];
    // Simple split by paragraphs for now:
    const paragraphs = text.split(/\n\s*\n/);
    for (let para of paragraphs) {
      para = para.trim();
      if (!para) continue;
      if (para.length <= CHUNK_SIZE) {
        chunks.push(para);
      } else {
        // Break long paragraph into smaller chunks
        for (let i = 0; i < para.length; i += CHUNK_SIZE) {
          const subText = para.slice(i, i + CHUNK_SIZE);
          chunks.push(subText);
        }
      }
    }

    // Embed each chunk and store in database
    for (const chunkText of chunks) {
      // Generate embedding vector for the chunk
      const embedRes = await embed({
        model: deepinfraProvider.textEmbedding(EMBED_MODEL_ID),
        value: chunkText
      });
      const vector = embedRes.embedding;
      // Prepare vector for SQL insert
      const vectorStr = '[' + vector.join(',') + ']';
      await pool.query(
        `INSERT INTO document_chunks(doc_id, user_id, content, embeddings) VALUES($1, $2, $3, $4::vector)`,
        [docId, userId, chunkText, vectorStr]
      );
    }

    res.status(200).json({ message: "Document ingested successfully.", documentId: docId });
  } catch (err) {
    console.error("Error ingesting PDF:", err);
    res.status(500).json({ error: "Failed to ingest PDF: " + err.message });
  }
}
