// /api/ingest-pdf.js – Handles PDF upload/URL ingestion into the knowledge base
const pdfParse = require('pdf-parse');
const { pool, deleteDocument } = require('../db');
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { embed } from 'ai';

const deepinfraProvider = createDeepInfra({
  apiKey: process.env.DEEPINFRA_API_KEY  // use API_KEY for consistency
});
const EMBED_MODEL_ID = 'BAAI/bge-large-en-v1.5';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }
  try {
    const userId = req.query.userId || req.body?.userId || (req.headers['x-user-id'] || null);
    let pdfBuffer = null;
    let filename = null;
    if (req.headers['content-type']?.includes('application/pdf')) {
      // PDF binary data directly in request
      const chunks = [];
      for await (const chunk of req) { chunks.push(chunk); }
      pdfBuffer = Buffer.concat(chunks);
      if (req.query.filename) {
        filename = req.query.filename;
      }
    } else if (req.body?.file) {
      // If PDF is base64-encoded in JSON
      const data = req.body.file;
      pdfBuffer = Buffer.from(data, 'base64');
      filename = req.body.filename || 'document.pdf';
    } else if (req.body?.url || req.query.url) {
      // Fetch PDF from URL
      const pdfUrl = req.body.url || req.query.url;
      const fetchRes = await fetch(pdfUrl);
      if (!fetchRes.ok) throw new Error("Failed to fetch PDF from URL");
      pdfBuffer = Buffer.from(await fetchRes.arrayBuffer());
      filename = pdfUrl.split('/').pop() || 'document.pdf';
    } else {
      res.status(400).json({ error: "No PDF file or URL provided." });
      return;
    }

    // Extract text from PDF
    const data = await pdfParse(pdfBuffer);
    let text = data.text.trim();
    if (!text) {
      res.status(400).json({ error: "PDF contains no extractable text." });
      return;
    }
    if (text.length > 1000000) {
      text = text.slice(0, 1000000);  // truncate extremely large text for now
    }

    // Insert a new document record
    const docName = filename ? filename.replace(/\.pdf$/i, '') : `Document_${Date.now()}`;
    const docInsertRes = await pool.query(
      `INSERT INTO documents(user_id, name) VALUES($1, $2) RETURNING id`, 
      [userId, docName]
    );
    const docId = docInsertRes.rows[0].id;

    // Split text into chunks for embedding
    const CHUNK_SIZE = 1000;
    const chunks = [];
    const paragraphs = text.split(/\n\s*\n/);
    for (let para of paragraphs) {
      para = para.trim();
      if (!para) continue;
      if (para.length <= CHUNK_SIZE) {
        chunks.push(para);
      } else {
        // further split large paragraphs
        for (let i = 0; i < para.length; i += CHUNK_SIZE) {
          const subText = para.slice(i, i + CHUNK_SIZE);
          chunks.push(subText);
        }
      }
    }

    // Embed each chunk and store in DB
    for (const chunkText of chunks) {
      const embedRes = await embed({
        model: deepinfraProvider.textEmbedding(EMBED_MODEL_ID),
        value: chunkText
      });
      const vector = embedRes.embedding;
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
