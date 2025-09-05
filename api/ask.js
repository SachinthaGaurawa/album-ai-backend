// /api/ask.js – Single-turn Q&A using the knowledge base (no chat memory)
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { generateText, embed } from 'ai';
const { getRelevantDocs } = require('../db');

const deepinfraProvider = createDeepInfra({
  apiKey: process.env.DEEPINFRA_API_KEY  // ensure we're using the correct env var
});
const CHAT_MODEL_ID = 'google/gemma-2-9b-it';       // model for answering
const EMBED_MODEL_ID = 'BAAI/bge-large-en-v1.5';    // embedding model for retrieval

const SYSTEM_PROMPT = 
  "You are a Q&A assistant. Answer the question based on the provided context. " +
  "If the answer is not in the context, say you are unsure.";

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }
  try {
    const question = req.query.q || req.body?.question || req.body?.q;
    const userId = req.body?.userId || req.query.userId || null;
    if (!question) {
      res.status(400).json({ error: "No question provided." });
      return;
    }
    // Retrieve relevant context from documents
    let contextText = "";
    // Generate embedding for the question
    const embedRes = await embed({
      model: deepinfraProvider.textEmbedding(EMBED_MODEL_ID),
      value: question
    });
    const qEmbedding = embedRes.embedding;
    const relevantChunks = await getRelevantDocs(userId, qEmbedding, 3);
    if (relevantChunks.length > 0) {
      contextText = relevantChunks.join("\n---\n");
    }
    // Form the prompt with system and user messages
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];
    if (contextText) {
      messages.push({ role: 'system', content: "Context:\n" + contextText });
    }
    messages.push({ role: 'user', content: question });
    // Generate the answer (single-turn, not streaming)
    const response = await generateText({
      model: deepinfraProvider(CHAT_MODEL_ID),
      messages
    });
    const answer = response.text.trim();
    res.status(200).json({ answer });
  } catch (err) {
    console.error("Error in /api/ask:", err);
    res.status(500).json({ error: "Failed to answer question: " + err.message });
  }
}
