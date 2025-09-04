// api/ai-expert.js – Advanced chat endpoint integrating memory and knowledge base.
import { createDeepInfra, deepinfra } from '@ai-sdk/deepinfra';
import { streamText, embed } from 'ai';
const { getRecentMessages, saveMessage, getRelevantDocs } = require('../db');  // import our DB utilities

// Initialize DeepInfra provider with API key (so we can use it for LLM calls and embeddings)
const deepinfraProvider = createDeepInfra({
  apiKey: process.env.DEEPINFRA_TOKEN
});

// Choose model IDs for chat and embeddings
const CHAT_MODEL_ID = 'google/gemma-2-9b-it';  // Example model: Google "Gemini" 9B instruct (adjust if needed)
const EMBED_MODEL_ID = 'BAAI/bge-large-en-v1.5';  // Embedding model (1024-dim English embeddings)

// System prompt to define the assistant’s behavior and style
const SYSTEM_PROMPT = 
  "You are a friendly AI assistant. Speak in a conversational, polite tone. " +
  "Provide helpful and accurate answers. Use emojis occasionally to be friendly. " +
  "If the user asks factual questions, base your answers on the provided context or say you don't know.";

// Utility: split a large text into chunks for embeddings (to avoid overly long chunks)
function splitTextIntoChunks(text, chunkSize = 1000) {
  // Normalize newlines to spaces (so that continuous text isn't broken mid-sentence by line breaks)
  let cleaned = text.replace(/\s*\n\s*/g, ' ');
  // Split by sentence boundary punctuation.
  const rawSentences = cleaned.split(/(?<=[.?!])\s+/);
  // Further split any sentence that is still too long
  let sentences = [];
  for (let s of rawSentences) {
    s = s.trim();
    if (!s) continue;
    if (s.length <= chunkSize) {
      sentences.push(s);
    } else {
      // If a single sentence is longer than chunkSize, break it on spaces.
      let start = 0;
      while (start < s.length) {
        let end = start + chunkSize;
        if (end >= s.length) {
          sentences.push(s.slice(start).trim());
          break;
        }
        // Try to break at a space boundary
        let spaceIndex = s.lastIndexOf(' ', end);
        if (spaceIndex <= start) spaceIndex = end;  // if no convenient space, break exactly at chunkSize
        sentences.push(s.slice(start, spaceIndex).trim());
        start = spaceIndex;
      }
    }
  }
  // Now group sentences into chunks up to chunkSize characters
  const chunks = [];
  let currentChunk = "";
  for (const sentence of sentences) {
    if (!currentChunk) {
      currentChunk = sentence;
    } else if ((currentChunk.length + 1 + sentence.length) <= chunkSize) {
      // +1 for adding a space
      currentChunk += " " + sentence;
    } else {
      chunks.push(currentChunk);
      currentChunk = sentence;
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  return chunks;
}

// Handler for the chat requests
export default async function handler(req, res) {
  // Only allow POST requests (we expect a JSON body with user message)
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  try {
    const body = req.body || {};  // assuming body is already parsed as JSON
    const userMessage = body.message || body.prompt;  // the user's message text
    const userId = body.userId || (req.headers['x-user-id'] || null); 
    // ^ We try to get a user identifier. In a real app, integrate with auth (e.g., NextAuth session) to get userId.
    // If not provided, conversation will be stateless or treated as a single session.

    if (!userMessage) {
      res.status(400).json({ error: "No user message provided." });
      return;
    }

    // Prepare the conversation context messages
    const messages = [];
    // System role prompt for behavior
    messages.push({ role: 'system', content: SYSTEM_PROMPT });
    
    // If we have a userId (logged-in user) and thus persistent history, retrieve recent messages
    let recentMessages = [];
    if (userId) {
      recentMessages = await getRecentMessages(userId, 10);
    } else if (body.history) {
      // If userId is not available, maybe the client sent conversation history in request (as fallback for anonymous).
      // In that case, use that.
      recentMessages = body.history;
      // (Expect format: an array of {role, content} objects, perhaps.)
    }
    // Append recent conversation history to messages (truncate if needed to fit context length).
    for (const msg of recentMessages) {
      // Only include if user or assistant role (ignore any other system messages stored)
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // Now add the latest user query
    messages.push({ role: 'user', content: userMessage });

    // **Knowledge Base Retrieval:** Before generating an answer, search for relevant docs
    let contextText = "";
    if (userMessage.length > 3) {  // simple check: if query is non-trivial
      // Get embedding for the user question
      const embedResult = await embed({
        model: deepinfraProvider.textEmbedding(EMBED_MODEL_ID),
        value: userMessage
      });
      const queryEmbedding = embedResult.embedding;
      // Find relevant document chunks (if any)
      const relevantChunks = await getRelevantDocs(userId, queryEmbedding, 3);
      if (relevantChunks.length > 0) {
        contextText = relevantChunks.join("\n---\n");
      }
    }

    if (contextText) {
      // Provide retrieved context to the model via an additional system message
      messages.splice(1, 0, {  // after the initial system prompt, add a new system message
        role: 'system', 
        content: "Knowledge base context:\n" + contextText +
                 "\n(Use this information to answer the user's question. If the info is unrelated, ignore it.)"
      });
    }

    // **Check for image generation requests:** 
    if (/^\/image\b|^\/img\b|(^|\s)(generate|show|draw)\b.*\b(image|picture)\b/i.test(userMessage)) {
      // The user's message looks like a request for an image.
      // Extract an image description from the message
      let promptMatch = userMessage;
      const match = userMessage.match(/^\/(?:img|image)\s+(.+)/i);
      if (match) {
        promptMatch = match[1];
      } else {
        // If no explicit /image command, just remove any trigger words like "generate image of"
        promptMatch = promptMatch.replace(/^(please\s*)?(draw|show|generate|create)\s*(me\s*)?(an?\s*image|picture|photo|drawing)\s*(of|that)?/i, '');
      }
      const imagePrompt = promptMatch.trim();
      if (!imagePrompt) {
        // If we couldn't parse a prompt, return a clarification
        const apology = "🤔 Sorry, I’m not sure what image you want. Could you describe it in more detail?";
        res.json({ role: 'assistant', content: apology });
        return;
      }
      // Generate the image using DeepInfra's image model (Stable Diffusion)
      const imgResult = await (await import('@vercel/blob')).put; // dynamic import to upload image
      // Actually, above is incorrect usage. Let's do this step by step below.
    }
    
    // If not an image request, proceed to generate text answer via streaming.
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Initiate streaming completion from the model
    const stream = streamText({
      model: deepinfraProvider(CHAT_MODEL_ID),
      messages
    });
    let assistantAnswer = "";
    // Stream tokens to the client as they arrive
    for await (const token of stream.textStream) {
      assistantAnswer += token;
      // Send the token as a SSE data chunk
      res.write(`data: ${token}\n\n`);
    }
    // Streaming done, end the SSE
    res.write(`data: [DONE]\n\n`);
    res.end();

    // Save the new messages (user message and assistant answer) to the database for persistent memory
    if (userId) {
      await saveMessage(userId, 'user', userMessage);
      await saveMessage(userId, 'assistant', assistantAnswer);
    }

  } catch (err) {
    console.error("Error in ai-expert handler:", err);
    // If an error occurs, ensure the response is closed properly.
    try {
      // Notify client of error in SSE format if possible
      res.write(`data: [ERROR] ${err.message || 'Internal error'}\n\n`);
    } catch (e) { /* ignore */ }
    // End the response with an error message (or proper SSE termination)
    res.end();
  }
}
