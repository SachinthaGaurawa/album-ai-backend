// /api/ai-expert.js
// Vercel Serverless Function – Enhanced AI chat (multi-provider, with memory, images, follow-ups, etc.)

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  // Parse request body (handle both JSON and raw string)
  let body = {};
  try {
    body = JSON.parse(req.body || '{}');
  } catch {
    body = req.body || {};
  }

  const question = (body?.question || '').trim();
  const chatId   = (body?.chat_id || '').trim();  // an identifier for the user or session
  const options  = body?.options || {};

  if (!question) {
    res.status(400).json({ error: 'Missing "question" in request body.' });
    return;
  }

  // 0) Special command handling (e.g., image generation or browsing)
  // Detect if the user used a slash command like /gen or /browse
  const cmd = detectCommand(question);
  if (cmd) {
    if (cmd.kind === 'gen') {
      // Handle image generation command
      try {
        const imgAnswer = await handleImageIntent(req, cmd.prompt, options);
        // `handleImageIntent` returns { answer: (markdown with image), provider, model }
        res.status(200).json(imgAnswer);
        return;
      } catch (err) {
        console.error('[ai-expert] image command failed:', err?.message || err);
        const fallbackMsg = humanPrefix('image') +
          "I tried to create an image but ran into an issue. Could you try again later or rephrase the image request?";
        res.status(200).json({ answer: fallbackMsg, provider: 'image-fallback' });
        return;
      }
    }
    if (cmd.kind === 'browse') {
      // Handle web browsing command (placeholder implementation)
      // In a real scenario, you might call a search API here and format the results.
      const browseMsg = humanPrefix('text') + 
        "I’m sorry, but I cannot browse the web at the moment. " + 
        "I can answer questions based on my knowledge. Is there something specific you want to find?";
      res.status(200).json({ answer: browseMsg, provider: 'none' });
      return;
    }
  }

  // 1) If the user likely wants an image via natural language → call /api/img
  if (wantsImage(question)) {
    try {
      const imgAnswer = await handleImageIntent(req, question, options);
      res.status(200).json(imgAnswer);
      return;
    } catch (err) {
      console.error('[ai-expert] image intent failed:', err?.message || err);
      // Fall back to text explanation if image generation fails
      const friendly = humanPrefix('image') +
        "I attempted to generate an image but hit a snag. Maybe try phrasing the image request differently?";
      res.status(200).json({ answer: friendly, provider: 'image-fallback' });
      return;
    }
  }

  // 2) Build the message list for the LLM, including system prompt, context, and conversation history.
  const providerOrder = getProviderOrder();
  const sysPrompt = buildSystemPrompt(chatId);

  // Initialize messages with system role instructions
  const messages = [{ role: 'system', content: sysPrompt }];

  // 2a) Include relevant knowledge base context (RAG integration)
  let contextText = "";
  if (chatId) {
    try {
      // Embed the question and find relevant document chunks for this user (if any)
      const embedRes = await embed({
        model: deepinfraProvider.textEmbedding(EMBED_MODEL_ID),  // using embedding model via DeepInfra
        value: question
      });
      const qEmbedding = embedRes.embedding;
      const docChunks = await getRelevantDocs(chatId, qEmbedding, 3);
      if (docChunks.length > 0) {
        contextText = docChunks.join("\n---\n");
        // Add context as an assistant message (or system) before user question
        messages.push({
          role: 'system',
          content: "Relevant context:\n" + contextText
        });
      }
    } catch (err) {
      console.warn("Context retrieval failed or no docs:", err.message);
    }
  }

  // 2b) Include recent conversation history for context (memory)
  if (chatId) {
    try {
      const recentMessages = await getRecentMessages(chatId, 10);
      // Add each past message in chronological order
      for (const msg of recentMessages) {
        // Only include if content is not too long to avoid huge prompts (optional trimming can be done here)
        messages.push({ role: msg.role, content: msg.content });
      }
    } catch (err) {
      console.error("Failed to retrieve history:", err.message);
    }
  }

  // 2c) Finally, add the current user question as the last message
  messages.push({ role: 'user', content: question });

  // 3) Attempt to get an answer from the LLMs in the specified provider order
  const modelPrefs = {
    groq:      process.env.GROQ_MODEL      || 'llama-3.1-70b-versatile',
    deepinfra: process.env.DEEPINFRA_MODEL || 'meta-llama/Meta-Llama-3.1-70B-Instruct',
    gemini:    process.env.GEMINI_MODEL    || 'gemini-1.5-pro'
  };
  const genOpts = {
    max_tokens: +(process.env.AI_MAX_TOKENS || 1024),
    temperature: +(process.env.AI_TEMPERATURE || 0.3),
    timeoutMs: +(process.env.AI_REQUEST_TIMEOUT_MS || 30000)
  };

  let lastError = null;
  let finalAnswer = null;
  let usedProvider = null;
  let finishReason = null;
  let usageStats = null;

  for (const provider of providerOrder) {
    try {
      const out = await callLLM(provider, modelPrefs[provider], messages, genOpts);
      const rawText = out.text;
      // Polish the answer text: trim excessive whitespace or stray markdown artifacts
      const polished = polishAnswer(rawText);
      finalAnswer = polished;
      usedProvider = provider;
      finishReason = out.finish_reason;
      usageStats = out.usage || undefined;
      break;  // got a successful answer, break out of loop
    } catch (err) {
      lastError = err;
      console.warn(`[ai-expert] provider ${provider} failed:`, err?.message || err);
      // Try the next provider in order
    }
  }

  if (finalAnswer === null) {
    // If all providers failed to return an answer
    const sorry = humanPrefix() +
      "I’m having trouble reaching my AI brain right now. Please try again in a moment.";
    res.status(200).json({ answer: sorry, provider: 'none', error: lastError?.message || 'All providers failed' });
    return;
  }

  // 4) Append follow-up suggestions to the answer (to keep the conversation going)
  let followups = [];
  if (contextText.match(/AAVSS/i)) {
    followups = SKILL_META.followups("aavss");
  } else if (contextText.match(/dataset|annotation/i)) {
    followups = SKILL_META.followups("sldataset");
  } else {
    followups = SKILL_META.followups(null);
  }
  if (followups.length > 0) {
    finalAnswer += "\n\n**Follow-up questions:**\n" + followups.map(q => "- " + q).join("\n");
  }

  // 5) Save the conversation (user question and assistant answer) to the database for memory
  if (chatId) {
    try {
      await saveMessage(chatId, 'user', question);
      await saveMessage(chatId, 'assistant', finalAnswer);
    } catch (err) {
      console.error("Failed to save messages:", err.message);
      // Not critical to throw error to user; we proceed without failing the response
    }
  }

  // 6) Return the answer to the client
  res.status(200).json({
    answer: finalAnswer,
    provider: usedProvider,
    model: modelPrefs[usedProvider] || usedProvider,
    finish_reason: finishReason,
    usage: usageStats
  });
}

/* ------------------------- Helper Functions & Providers ------------------------- */

// (Same helper functions as before: wantsImage, getBaseUrl, handleImageIntent, humanPrefix, polishAnswer, getProviderOrder, hasKey, callLLM, callGroq, callDeepInfra, callGemini – all mostly unchanged except as noted below)
 
function wantsImage(q) {
  const t = q.toLowerCase();
  const patterns = [
    /\b(draw|sketch|illustrate|paint)\b/,
    /\b(generate|make|create)\s+(an?\s+)?(image|picture|art|logo|poster|icon|photo)\b/,
    /\bimage\s+(please|plz|for me)\b/,
    /\b(show|send)\s+me\b.*\b(image|picture|photo|diagram)\b/
  ];
  return patterns.some(rx => rx.test(t));
}

function getBaseUrl(req) { /* ...unchanged... */ }

async function handleImageIntent(req, prompt, options) {
  const imgProvider = options?.imgProvider || 'deepinfra';
  const size = options?.size || '1024x1024';
  const url = new URL('/api/img', getBaseUrl(req));
  url.searchParams.set('provider', imgProvider);
  url.searchParams.set('size', size);
  url.searchParams.set('prompt', prompt);
  const r = await fetch(url.toString(), { method: 'GET', headers: { 'Content-Type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(j?.error || `Image API failed (${r.status})`);
  }
  const lead = humanPrefix('image') + "Here’s your image. Let me know if you want any changes or another style! ✨";
  const md = `${lead}\n\n![](${j.url})`;
  return { answer: md, provider: 'image', model: j.provider || imgProvider };
}

function humanPrefix(kind = 'text') {
  if (kind === 'image') return "All set! ";
  return "Sure — ";
}

function polishAnswer(s) {
  const t = String(s || '').trim();
  if (!t) return "I don’t have an answer for that yet — could you rephrase?";
  return t.replace(/\n{3,}/g, '\n\n').replace(/(^#+\s*$)/gm, '');
}

function getProviderOrder() {
  const raw = (process.env.AI_PROVIDER_ORDER || 'groq,deepinfra,gemini')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const allowed = ['groq','deepinfra','gemini'];
  const filtered = raw.filter(p => allowed.includes(p));
  return filtered.filter(p => hasKey(p));
}

function hasKey(provider) {
  if (provider === 'groq')      return !!process.env.GROQ_API_KEY;
  if (provider === 'deepinfra') return !!process.env.DEEPINFRA_API_KEY;
  if (provider === 'gemini')    return !!process.env.GEMINI_API_KEY;
  return false;
}

async function callLLM(provider, model, messages, opts) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), opts.timeoutMs || 30000);
  try {
    if (provider === 'groq') {
      return await callGroq(model, messages, opts, ctrl.signal);
    }
    if (provider === 'deepinfra') {
      return await callDeepInfra(model, messages, opts, ctrl.signal);
    }
    if (provider === 'gemini') {
      return await callGemini(model, messages, opts, ctrl.signal);
    }
    throw new Error(`Unknown provider: ${provider}`);
  } finally {
    clearTimeout(to);
  }
}

/** Convert messages to OpenAI format for compatible endpoints (Groq & DeepInfra) */
function asOpenAIMessages(messages) {
  return messages.map(m => ({ role: m.role, content: m.content }));
}

/* ------------------------------ GROQ Provider ------------------------------ */
async function callGroq(model, messages, opts, signal) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Missing GROQ_API_KEY');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: asOpenAIMessages(messages),
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.max_tokens ?? 1024,
      stream: false
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(j?.error?.message || `Groq error ${r.status}`);
  }
  const choice = j.choices?.[0];
  return {
    text: choice?.message?.content || '',
    finish_reason: choice?.finish_reason || '',
    usage: j.usage || undefined
  };
}

/* --------------------------- DEEPINFRA Provider --------------------------- */
async function callDeepInfra(model, messages, opts, signal) {
  const apiKey = process.env.DEEPINFRA_API_KEY;
  if (!apiKey) throw new Error('Missing DEEPINFRA_API_KEY');
  const r = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', {
    method: 'POST', signal,
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: asOpenAIMessages(messages),
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.max_tokens ?? 1024,
      stream: false
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(j?.error?.message || `DeepInfra error ${r.status}`);
  }
  const choice = j.choices?.[0];
  return {
    text: choice?.message?.content || '',
    finish_reason: choice?.finish_reason || '',
    usage: j.usage || undefined
  };
}

/* ----------------------------- GEMINI Provider ---------------------------- */
async function callGemini(model, messages, opts, signal) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const contents = toGeminiContents(messages);
  const r = await fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: opts.temperature ?? 0.3,
        maxOutputTokens: opts.max_tokens ?? 1024
      }
      // Note: Google API may apply its own safety filters
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const errMsg = j?.error?.message || `Gemini error ${r.status}`;
    throw new Error(errMsg);
  }
  const text = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  return {
    text,
    finish_reason: j?.candidates?.[0]?.finishReason || '',
    usage: undefined
  };
}

function toGeminiContents(messages) {
  return messages.map(m => ({
    role: m.role === 'system' ? 'user' : (m.role || 'user'),
    parts: [{ text: m.content || '' }]
  }));
}

/* ------------------------- System Prompt Builder ------------------------- */
function buildSystemPrompt(chatId) {
  // System prompt remains concise and friendly, describing the assistant’s role and tone
  return [
    "You are a friendly, human-like expert assistant.",
    "Tone: warm, concise, and helpful. Use simple, clear language.",
    "Behaviors:",
    "- Answer thoroughly but in a compact form using paragraphs, bullet points, or tables as needed.",
    "- If the user is vague, ask a clarifying question politely.",
    "- If asked for images, you can generate or suggest them (the system can handle '/gen').",
    "- Use knowledge from the provided context (documents) if available; if unsure or not in context, say so.",
    "- If you aren’t sure or the question is outside your scope, admit it briefly and suggest a next step.",
    "- Avoid overusing emojis; use them only when they add clarity or warmth (1–3 at most).",
    `Session ID: ${chatId || 'anonymous'}.`
  ].join('\n');
}

// Import or require other modules (database, embedding, skill meta) at the top of file as needed:
// e.g., import { getRecentMessages, saveMessage, getRelevantDocs } from '../db';
//       import { createDeepInfra } from '@ai-sdk/deepinfra';
//       import { embed } from 'ai';
//       const { detectCommand, SKILL_META } = require('../api/skills');















// /api/ai-expert.js  — Node runtime (CommonJS)
// Friendly, multi-provider AI with CORS + image intent handoff.
// POST { question: string, chat_id?: string, options?: { imgProvider?, size? } }
// 200 { answer, provider, model, usage?, finish_reason? }

const DEFAULT_ORDER = ['groq', 'deepinfra', 'gemini'];

/* -------------------- CORS (match /api/ai.js) -------------------- */
function allowedOrigins() {
  return (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}
function buildCors(origin) {
  const list = allowedOrigins();
  const o = (origin || '').replace(/\/+$/, '');
  const ok = !origin || list.length === 0 || list.includes(o);
  return {
    ...(ok ? { 'Access-Control-Allow-Origin': origin || '*' } : {}),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

/* -------------------- HTTP helpers -------------------- */
function send(res, status, headers, dataObj) {
  try { res.writeHead(status, headers); } catch(_) {}
  res.end(JSON.stringify(dataObj));
}
function wantsImage(q) {
  const t = String(q || '').toLowerCase();
  return [
    /\b(draw|sketch|illustrate|paint)\b/,
    /\b(generate|make|create)\s+(an?\s+)?(image|picture|art|logo|poster|icon|photo)\b/,
    /\bimage\s+(please|plz|for me)\b/,
    /\bshow me\b.*\b(image|picture|poster|logo|icon)\b/,
    /^\/gen\b/
  ].some(rx => rx.test(t));
}
function humanPrefix(kind='text'){ return kind === 'image' ? 'All set! ' : 'Sure — '; }
function polishAnswer(s){
  const t = String(s || '').trim();
  if (!t) return 'I don’t have an answer for that yet — could you rephrase?';
  return t.replace(/\n{3,}/g, '\n\n').replace(/(^#+\s*$)/gm, '');
}
function getOrder() {
  const raw = (process.env.AI_PROVIDER_ORDER || DEFAULT_ORDER.join(','))
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const allow = ['groq','deepinfra','gemini'];
  const hasKey = (p) =>
    (p==='groq'      && !!process.env.GROQ_API_KEY) ||
    (p==='deepinfra' && !!process.env.DEEPINFRA_API_KEY) ||
    (p==='gemini'    && !!process.env.GEMINI_API_KEY);
  return raw.filter(p => allow.includes(p)).filter(hasKey);
}
function asOpenAIMessages(messages){
  return messages.map(m => ({ role: m.role, content: m.content }));
}
function toGeminiContents(messages){
  return messages.map(m => ({
    role: m.role === 'system' ? 'user' : (m.role || 'user'),
    parts: [{ text: m.content || '' }]
  }));
}
function buildSystemPrompt(chatId){
  return [
    'You are a friendly, human-like expert assistant.',
    'Tone: warm, concise, practical. Use simple, clear language.',
    'Behaviors:',
    '- Answer directly in short paragraphs or tight bullet points.',
    '- When the user is vague, ask one short clarifying question.',
    '- If asked for images, propose ideas; the app can generate them.',
    '- If unsure, say so briefly and suggest the next best step.',
    '- Use emojis sparingly where it *adds* warmth or clarity.',
    `Session: ${chatId || 'anonymous'}.`
  ].join('\n');
}

/* -------------------- Providers -------------------- */
async function callGroq(model, messages, opts, signal){
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('Missing GROQ_API_KEY');

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: asOpenAIMessages(messages),
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.max_tokens ?? 1024,
      stream: false
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Groq error ${r.status}`);
  const c = j.choices?.[0];
  return { text: c?.message?.content || '', finish_reason: c?.finish_reason || '', usage: j.usage };
}
async function callDeepInfra(model, messages, opts, signal){
  const key = process.env.DEEPINFRA_API_KEY;
  if (!key) throw new Error('Missing DEEPINFRA_API_KEY');

  const r = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: asOpenAIMessages(messages),
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.max_tokens ?? 1024,
      stream: false
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `DeepInfra error ${r.status}`);
  const c = j.choices?.[0];
  return { text: c?.message?.content || '', finish_reason: c?.finish_reason || '', usage: j.usage };
}
async function callGemini(model, messages, opts, signal){
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Missing GEMINI_API_KEY');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${key}`;
  const r = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: toGeminiContents(messages),
      generationConfig: { temperature: opts.temperature ?? 0.3, maxOutputTokens: opts.max_tokens ?? 1024 }
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Gemini error ${r.status}`);
  const txt = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  return { text: txt, finish_reason: j?.candidates?.[0]?.finishReason || '', usage: undefined };
}

/* -------------------- Image handoff -------------------- */
function baseUrl(req){
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
async function handleImageIntent(req, question, options){
  const imgProvider = options?.imgProvider || 'deepinfra';
  const size = options?.size || '1024x1024';
  const url = new URL('/api/img', baseUrl(req));
  url.searchParams.set('provider', imgProvider);
  url.searchParams.set('size', size);
  url.searchParams.set('prompt', question);
  url.searchParams.set('chat', '1');

  const r = await fetch(url.toString(), { method: 'GET', headers: { 'Content-Type': 'application/json' } });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok || !j?.imageUrl) throw new Error(j?.error || `Image API failed (${r.status})`);

  const lead = humanPrefix('image') + 'Here’s your image. Want tweaks (style, mood, camera angle)? ✨';
  const md = `${lead}\n\n![](${j.imageUrl})`;
  return { answer: md, provider: j.meta?.providerUsed || 'image', model: j.meta?.modelUsed || 'image-gen' };
}

/* -------------------- Dispatcher -------------------- */
async function callLLM(provider, model, messages, opts){
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), opts.timeoutMs || 30000);
  try {
    if (provider === 'groq')      return await callGroq(model, messages, opts, ac.signal);
    if (provider === 'deepinfra') return await callDeepInfra(model, messages, opts, ac.signal);
    if (provider === 'gemini')    return await callGemini(model, messages, opts, ac.signal);
    throw new Error(`Unknown provider: ${provider}`);
  } finally { clearTimeout(t); }
}

/* -------------------- Handler -------------------- */
module.exports = async (req, res) => {
  const headers = buildCors(req.headers.origin || req.headers.Origin);
  if (req.method === 'OPTIONS') return send(res, 204, headers, null);
  if (req.method !== 'POST')    return send(res, 405, headers, { error: 'Method not allowed. Use POST.' });

  // parse body
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
  catch { body = {}; }

  const question = (body?.question || '').trim();
  const chatId   = (body?.chat_id || '').trim();
  const options  = body?.options || {};
  if (!question) return send(res, 400, headers, { error: 'Missing "question".' });

  // Image route (so UI can just ask "make a poster of …")
  if (wantsImage(question)) {
    try {
      const img = await handleImageIntent(req, question, options);
      return send(res, 200, headers, img);
    } catch (e) {
      const fallback = humanPrefix('image') +
        'I tried to create an image but hit a hiccup. Try again with a short, specific prompt?';
      return send(res, 200, headers, { answer: fallback, provider: 'image-fallback' });
    }
  }

  // Text route
  const sys = buildSystemPrompt(chatId);
  const messages = [
    { role: 'system', content: sys },
    { role: 'user',   content: question }
  ];
  const models = {
    groq:      process.env.GROQ_MODEL      || 'llama-3.1-70b-versatile',
    deepinfra: process.env.DEEPINFRA_MODEL || 'meta-llama/Meta-Llama-3.1-70B-Instruct',
    gemini:    process.env.GEMINI_MODEL    || 'gemini-1.5-pro'
  };
  const gen = {
    max_tokens: +(process.env.AI_MAX_TOKENS || 1024),
    temperature: +(process.env.AI_TEMPERATURE || 0.3),
    timeoutMs: +(process.env.AI_REQUEST_TIMEOUT_MS || 30000)
  };

  let lastErr = null;
  const order = getOrder();
  if (order.length === 0) {
    return send(res, 502, headers, { error: 'No provider API keys configured.' });
  }

  for (const p of order) {
    try {
      const out = await callLLM(p, models[p], messages, gen);
      const text = polishAnswer(out.text);
      return send(res, 200, headers, {
        answer: text, provider: p, model: models[p],
        finish_reason: out.finish_reason, usage: out.usage
      });
    } catch (e) {
      lastErr = e;
      // continue to next provider
    }
  }

  const sorry = humanPrefix() + 'I’m having trouble reaching my AI providers. Please try again shortly.';
  return send(res, 200, headers, { answer: sorry, provider: 'none', error: lastErr?.message || 'all providers failed' });
};
