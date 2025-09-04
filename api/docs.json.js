// api/docs.json.js – Returns the list of documents (knowledge base entries) for the user.
const { listDocuments } = require('../db');

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).send('Method Not Allowed');
    return;
  }
  try {
    const userId = req.query.userId || (req.headers['x-user-id'] || null);
    if (!userId) {
      // If no user specified, we could either return all public docs or an error.
      // For now, require authentication.
      return res.status(401).json({ error: "Unauthorized" });
    }
    const docs = await listDocuments(userId);
    res.status(200).json({ documents: docs });
  } catch (err) {
    console.error("Error fetching docs list:", err);
    res.status(500).json({ error: "Failed to list documents: " + err.message });
  }
}
