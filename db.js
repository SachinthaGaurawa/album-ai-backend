// /db.js – Database connection and helper functions
import pkg from 'pg';
const { Pool } = pkg;

// The pool is built on first use, not on import. Throwing at module scope took
// down every endpoint that merely imports this file whenever DATABASE_URL was
// unset, including the ones that never touch the database.
let _pool = null;
let _extensionChecked = false;

export function getPool() {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  _pool = new Pool({ connectionString });
  if (!_extensionChecked) {
    _extensionChecked = true;
    // Vector similarity search needs the extension; a missing grant must not
    // be fatal, so this stays a warning.
    _pool.query('CREATE EXTENSION IF NOT EXISTS vector;').catch(err => {
      console.warn('[db] pgvector extension not enabled:', err.message);
    });
  }
  return _pool;
}

// Retrieve recent conversation messages for memory
async function getRecentMessages(userId, limit = 10) {
  const res = await getPool().query(
    `SELECT role, content
     FROM messages
     WHERE user_id = $1
     ORDER BY timestamp DESC
     LIMIT $2`,
    [userId, limit]
  );
  // Return in chronological (oldest first) order:
  return res.rows.reverse();
}

// Save a message (user or assistant) into the conversation history
async function saveMessage(userId, role, content) {
  await getPool().query(
    `INSERT INTO messages(user_id, role, content, timestamp) VALUES($1, $2, $3, NOW())`,
    [userId, role, content]
  );
}

// List documents for a user (for UI or management)
async function listDocuments(userId) {
  if (!userId) {
    return [];
  }
  const res = await getPool().query(
    `SELECT id, name, created_at
     FROM documents
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return res.rows;
}

// Delete a document and its chunks (called by delete-doc.js)
async function deleteDocument(docId, userId) {
  await getPool().query(`DELETE FROM document_chunks WHERE doc_id = $1 AND user_id = $2`, [docId, userId]);
  await getPool().query(`DELETE FROM documents WHERE id = $1 AND user_id = $2`, [docId, userId]);
}

// Semantic search for relevant document chunks given a query embedding
async function getRelevantDocs(userId, embedding, topK = 3) {
  const embeddingStr = '[' + embedding.join(',') + ']';
  let query, params;
  if (userId) {
    query = `
      SELECT content
      FROM document_chunks
      WHERE user_id = $1
      ORDER BY embeddings <-> $2::vector
      LIMIT $3
    `;
    params = [userId, embeddingStr, topK];
  } else {
    // If no user specified, search across all docs (public)
    query = `
      SELECT content
      FROM document_chunks
      ORDER BY embeddings <-> $1::vector
      LIMIT $2
    `;
    params = [embeddingStr, topK];
  }
  const res = await getPool().query(query, params);
  return res.rows.map(r => r.content);
}

export {
  getRecentMessages,
  saveMessage,
  listDocuments,
  deleteDocument,
  getRelevantDocs
};

export default {
  getPool,
  getRecentMessages,
  saveMessage,
  listDocuments,
  deleteDocument,
  getRelevantDocs
};
