// pages/api/docs.json.js
import { Pool } from "pg";
export const config = { api: { bodyParser: true } };

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const userId = req.query.userId || null;

  try {
    const docs = await pool.query(
      `SELECT d.id, d.name, d.created_at,
              COALESCE(c.cnt,0) AS chunks
       FROM documents d
       LEFT JOIN (
         SELECT doc_id, COUNT(*)::int AS cnt
         FROM document_chunks GROUP BY doc_id
       ) c ON c.doc_id = d.id
       WHERE ($1::text IS NULL OR d.user_id = $1)
       ORDER BY d.id DESC
       LIMIT 100`,
      [userId]
    );
    res.status(200).json({ ok: true, rows: docs.rows });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Server error" });
  }
}
