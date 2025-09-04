// api/ask.js – Answers a single question using the knowledge base (no chat memory, just RAG).
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { generateText, embed } from 'ai';
const { getRelevantDocs } = require('../db');

const deepinfraProvider = createDeepInfra({
  apiKey: process.env.DEEPINFRA_TOKEN
});
const CHAT_MODEL_ID = 'google/gemma-2-9b-it';       // same model as chat (can use a big model for best answer)
const EMBED_MODEL_ID = 'BAAI/bge-large-en-v1.5';    // embedding model

const SYSTEM_PROMPT = "You are a Q&A assistant. Answer the question based on the provided context. If you don't know, say you are unsure.";

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
    const embedRes = await embed({
      model: deepinfraProvider.textEmbedding(EMBED_MODEL_ID),
      value: question
    });
    const qEmbedding = embedRes.embedding;
    const relevantChunks = await getRelevantDocs(userId, qEmbedding, 3);
    if (relevantChunks.length > 0) {
      contextText = relevantChunks.join("\n---\n");
    }
    // Form the prompt for the model
    const messages = [];
    messages.push({ role: 'system', content: SYSTEM_PROMPT });
    if (contextText) {
      messages.push({ role: 'system', content: "Context:\n" + contextText });
    }
    messages.push({ role: 'user', content: question });
    // Get the answer (not streaming for single-turn Q&A)
    const response = await generateText({
      model: deepinfraProvider(CHAT_MODEL_ID),
      messages
    });
    const answer = response.text.trim();
    res.status(200).json({ answer });
  } catch (err) {
    console.error("Error in ask:", err);
    res.status(500).json({ error: "Failed to answer question: " + err.message });
  }
}
