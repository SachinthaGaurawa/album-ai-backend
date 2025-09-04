// db.js – Database connection and helper functions for the AI chatbot.
const { Pool } = require('pg');

// Initialize a connection pool to Neon Postgres.
// The connection string is taken from environment (set by Vercel Postgres integration).
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error("Database connection string not set in environment.");
}
const pool = new Pool({
  connectionString,
  // You can enable SSL if needed (Neon requires SSL by default).
  // ssl: { rejectUnauthorized: false },
});

// (Optional) Ensure the pgvector extension is enabled for embeddings.
// This will run once at startup. If the DB user lacks permission, it may throw an error – 
// that's fine, the extension might already be installed.
pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`).catch(err => {
  console.warn("pgvector extension enable failed (might already be enabled or permission issue):", err.message);
});

// Helper: Fetch recent messages for a user (or conversation) for context
async function getRecentMessages(userId, limit = 10) {
  // Retrieves the last `limit` messages for the given user (both user and assistant roles).
  const res = await pool.query(
    `SELECT role, content 
     FROM messages 
     WHERE user_id = $1 
     ORDER BY timestamp DESC 
     LIMIT $2`,
    [userId, limit]
  );
  // We want them in chronological order (oldest first), so reverse the order we got (since we queried DESC).
  const rows = res.rows.reverse();
  return rows;
}

// Helper: Save a new message to the database.
async function saveMessage(userId, role, content) {
  // role is 'user' or 'assistant'.
  await pool.query(
    `INSERT INTO messages(user_id, role, content, timestamp) VALUES($1, $2, $3, NOW())`,
    [userId, role, content]
  );
}

// Helper: Get list of documents for a user (or public docs if userId is null).
async function listDocuments(userId) {
  if (!userId) {
    return []; // If no user, return empty or could return public docs if any (not implemented differently here).
  }
  const res = await pool.query(
    `SELECT id, name, created_at 
     FROM documents 
     WHERE user_id = $1 
     ORDER BY created_at DESC`,
    [userId]
  );
  return res.rows;
}

// Helper: Delete a document (and its chunks) by ID for a given user.
async function deleteDocument(docId, userId) {
  // We must delete associated chunks first (if no ON DELETE CASCADE constraint).
  await pool.query(`DELETE FROM document_chunks WHERE doc_id = $1 AND user_id = $2`, [docId, userId]);
  await pool.query(`DELETE FROM documents WHERE id = $1 AND user_id = $2`, [docId, userId]);
}

// Helper: Search the document embeddings for relevant chunks given a query embedding.
// Returns an array of content snippets (text of top matching chunks).
async function getRelevantDocs(userId, embedding, topK = 3) {
  // Convert the embedding array to the required vector literal string format for SQL.
  const embeddingStr = '[' + embedding.join(',') + ']';
  let query, params;
  if (userId) {
    // Search only documents for this user (or public docs as well, if needed).
    query = `
      SELECT content 
      FROM document_chunks 
      WHERE user_id = $1 
      ORDER BY embeddings <-> $2::vector 
      LIMIT $3
    `;
    params = [userId, embeddingStr, topK];
  } else {
    // If no user (e.g. public context), search all public documents (user_id is NULL or a designated public user).
    // Here, we'll search all entries regardless of user for simplicity (assuming public data).
    query = `
      SELECT content 
      FROM document_chunks 
      ORDER BY embeddings <-> $1::vector 
      LIMIT $2
    `;
    params = [embeddingStr, topK];
  }
  const res = await pool.query(query, params);
  return res.rows.map(r => r.content);
}

module.exports = { pool, getRecentMessages, saveMessage, listDocuments, deleteDocument, getRelevantDocs };
