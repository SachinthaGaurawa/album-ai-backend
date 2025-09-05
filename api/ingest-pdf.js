// /api/ai-expert.js
// Powerful multi-provider chat endpoint with CORS, image handoff, and safe optional RAG/memory.
// Environment: GROQ_API_KEY, DEEPINFRA_API_KEY, GEMINI_API_KEY (optional CORS_ORIGINS, AI_PROVIDER_ORDER, *_MODEL)

'use strict';

// Force Node runtime on Vercel (if supported in your project)
module.exports.config = { runtime: 'nodejs18.x' };

/* ─────────────── CORS ─────────────── */
function allowedOrigins() {
  return (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}
function corsHeaders(origin) {
  const list = allowedOrigins();
  const o = (origin || '').replace(/\/+$/, '');
  const ok = !origin || list.length === 0 || list.includes(o);
  return {
    ...(ok ? { 'Access-Control-Allow-Origin': origin || '*' } : {}),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
}
function send(res, status, headers, dataObj) {
  try { res.writeHead(status, headers); } catch (_) {}
  res.end(dataObj == null ? null : JSON.stringify(dataObj));
}

/* ─────────────── Utilities ─────────────── */
function baseUrl(req){
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
function humanPrefix(kind='text'){ return kind === 'image' ? 'All set! ' : 'Sure — '; }
function polishAnswer(s){
  const t = String(s || '').trim();
  if (!t) return 'I don’t have an answer for that yet — could you rephrase?';
  return t.replace(/\n{3,}/g, '\n\n').replace(/(^#+\s*$)/gm, '');
}
function wantsImage(q) {
  const t = String(q || '').toLowerCase();
  return [
    /\b(draw|sketch|illustrate|paint)\b/,
    /\b(generate|make|create)\s+(an?\s+)?(image|picture|art|logo|poster|icon|photo)\b/,
    /\bimage\s+(please|plz|for me)\b/,
    /\bshow me\b.*\b(image|picture|poster|logo|icon|photo|diagram)\b/,
    /^\/gen\b/
  ].some(rx => rx.test(t));
}
function detectCommand(raw){
  const q = String(raw || '').trim();
  const gen = q.match(/^\/?gen(?:erate)?\s+(.+)/i);
  if (gen) return { kind:'gen', prompt: gen[1].trim() };
  const br = q.match(/^\/?browse\s+(.+)/i);
  if (br)  return { kind:'browse', query: br[1].trim() };
  return null;
}
function buildSystemPrompt(chatId){
  return [
    'You are a friendly, human-like expert assistant.',
    'Tone: warm, concise, practical. Use simple, clear language.',
    'Behaviors:',
    '- Answer directly in short paragraphs or tight bullet points.',
    '- Ask one brief clarifying question if the user is vague.',
    '- Use any provided context faithfully; if unknown, say so.',
    '- If asked for visuals, suggest ideas; this app can generate them.',
    '- Use emojis sparingly when it truly adds warmth or clarity.',
    `Session: ${chatId || 'anonymous'}.`
  ].join('\n');
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
function getOrder() {
  const DEFAULT = ['groq','deepinfra','gemini'];
  const raw = (process.env.AI_PROVIDER_ORDER || DEFAULT.join(','))
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const allow = ['groq','deepinfra','gemini'];
  const hasKey = (p) =>
    (p==='groq'      && !!process.env.GROQ_API_KEY) ||
    (p==='deepinfra' && !!process.env.DEEPINFRA_API_KEY) ||
    (p==='gemini'    && !!process.env.GEMINI_API_KEY);
  return raw.filter(p => allow.includes(p)).filter(hasKey);
}

/* ─────────────── Optional DB/RAG hooks (safe if missing) ─────────────── */
let db = null; // expects ../db with: getRecentMessages, saveMessage, getRelevantDocs
try { db = require('../db'); } catch { /* optional */ }

async function tryRagContext({ question, userId }) {
  // If you don't have @ai-sdk/deepinfra or a vector pipeline, this returns '' and is skipped.
  try {
    if (!db?.getRelevantDocs || !process.env.DEEPINFRA_API_KEY) return '';
    const { createDeepInfra } = await import('@ai-sdk/deepinfra');
    const { embed } = await import('ai');

    const deepinfraProvider = createDeepInfra({ apiKey: process.env.DEEPINFRA_API_KEY });
    const EMBED_MODEL_ID = 'BAAI/bge-large-en-v1.5';

    const e = await embed({ model: deepinfraProvider.textEmbedding(EMBED_MODEL_ID), value: question });
    const chunks = await db.getRelevantDocs(userId, e.embedding, 3);
    return (chunks && chunks.length) ? chunks.join('\n---\n') : '';
  } catch (err) {
    console.warn('[ai-expert] RAG skipped:', err?.message || err);
    return '';
  }
}
async function tryLoadHistory(userId, n=10){
  try { return db?.getRecentMessages ? await db.getRecentMessages(userId, n) : []; }
  catch { return []; }
}
async function trySaveMsg(userId, role, content){
  try { if (db?.saveMessage) await db.saveMessage(userId, role, content); }
  catch { /* ignore */ }
}

/* ─────────────── Image handoff to /api/img ─────────────── */
async function handleImageIntent(req, prompt, options){
  const imgProvider = options?.imgProvider || 'deepinfra';
  const size = options?.size || '1024x1024';
  const url = new URL('/api/img', baseUrl(req));
  url.searchParams.set('provider', imgProvider);
  url.searchParams.set('size', size);
  url.searchParams.set('prompt', prompt);
  url.searchParams.set('chat', '1');

  const r = await fetch(url.toString(), { method: 'GET', headers: { 'Content-Type': 'application/json' } });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok || !j?.imageUrl) throw new Error(j?.error || `Image API failed (${r.status})`);

  const lead = humanPrefix('image') + 'Here’s your image. Want tweaks (style, mood, camera angle)? ✨';
  const md = `${lead}\n\n![](${j.imageUrl})`;
  return { answer: md, provider: j.meta?.providerUsed || 'image', model: j.meta?.modelUsed || 'image-gen' };
}

/* ─────────────── Providers ─────────────── */
async function callGroq(model, messages, opts, signal){
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('Missing GROQ_API_KEY');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', signal,
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
    method: 'POST', signal,
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
    method: 'POST', signal,
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

async function dispatch(provider, model, messages, opts){
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), opts.timeoutMs || 30000);
  try {
    if (provider === 'groq')      return await callGroq(model, messages, opts, ac.signal);
    if (provider === 'deepinfra') return await callDeepInfra(model, messages, opts, ac.signal);
    if (provider === 'gemini')    return await callGemini(model, messages, opts, ac.signal);
    throw new Error(`Unknown provider: ${provider}`);
  } finally { clearTimeout(t); }
}

/* ─────────────── Handler ─────────────── */
module.exports = async (req, res) => {
  const headers = corsHeaders(req.headers.origin || req.headers.Origin);

  if (req.method === 'OPTIONS') return send(res, 204, headers, null);
  if (req.method !== 'POST')    return send(res, 405, headers, { error: 'Method not allowed. Use POST.' });

  // parse body (string or pre-parsed object)
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
  catch { body = {}; }

  const question = (body?.question || '').trim();
  const chatId   = (body?.chat_id || '').trim();
  const options  = body?.options || {};
  if (!question) return send(res, 400, headers, { error: 'Missing "question".' });

  // Slash commands
  const cmd = detectCommand(question);
  if (cmd?.kind === 'gen') {
    try {
      const out = await handleImageIntent(req, cmd.prompt, options);
      return send(res, 200, headers, out);
    } catch (e) {
      const fallback = humanPrefix('image') +
        'I tried to create an image but hit a hiccup. Try again with a short, specific prompt?';
      return send(res, 200, headers, { answer: fallback, provider: 'image-fallback' });
    }
  }
  if (cmd?.kind === 'browse') {
    const msg = humanPrefix() + 'I can’t browse right now, but if you paste text or a link I can analyze it for you.';
    return send(res, 200, headers, { answer: msg, provider: 'none' });
  }

  // Natural-language image intent
  if (wantsImage(question)) {
    try {
      const out = await handleImageIntent(req, question, options);
      return send(res, 200, headers, out);
    } catch (e) {
      const fallback = humanPrefix('image') +
        'I tried to create an image but ran into a temporary issue. Please try again.';
      return send(res, 200, headers, { answer: fallback, provider: 'image-fallback' });
    }
  }

  // Build messages (system + optional KB + history + user)
  const sys = buildSystemPrompt(chatId);
  const messages = [{ role: 'system', content: sys }];

  // Optional RAG
  let contextText = '';
  if (chatId) {
    contextText = await tryRagContext({ question, userId: chatId });
    if (contextText) messages.push({ role: 'system', content: 'Relevant context:\n' + contextText });
  }

  // Optional memory
  if (chatId) {
    const history = await tryLoadHistory(chatId, 10);
    for (const m of history) {
      if (m?.role && m?.content) messages.push({ role: m.role, content: m.content });
    }
  }

  messages.push({ role: 'user', content: question });

  // Provider fallback
  const order = getOrder();
  if (order.length === 0) return send(res, 502, headers, { error: 'No provider API keys configured.' });

  const models = {
    groq:      process.env.GROQ_MODEL      || 'llama-3.1-70b-versatile',
    deepinfra: process.env.DEEPINFRA_MODEL || 'meta-llama/Meta-Llama-3.1-70B-Instruct',
    gemini:    process.env.GEMINI_MODEL    || 'gemini-1.5-pro'
  };
  const gen = {
    max_tokens:  +(process.env.AI_MAX_TOKENS || 1024),
    temperature: +(process.env.AI_TEMPERATURE || 0.3),
    timeoutMs:   +(process.env.AI_REQUEST_TIMEOUT_MS || 30000)
  };

  let lastErr = null;
  for (const p of order) {
    try {
      const out = await dispatch(p, models[p], messages, gen);
      let answer = polishAnswer(out.text);

      // Simple, topic-aware follow-ups
      const followups = [];
      if (/AAVSS/i.test(contextText)) {
        followups.push('Do you want calibration steps?', 'Show safety alert thresholds?', 'List recommended hardware profiles?', 'Need an integration checklist?');
      } else if (/(dataset|annotation)/i.test(contextText)) {
        followups.push('Do you want dataset splits?', 'Show annotation schema examples?', 'Summarize licensing/allowed use?', 'Suggest evaluation metrics?');
      } else {
        followups.push('Want a brief summary?', 'Need a checklist?', 'Generate an image (/gen …)?');
      }
      if (followups.length) {
        answer += '\n\n**Follow-up questions:**\n' + followups.map(q => '- ' + q).join('\n');
      }

      // Save memory (best-effort)
      if (chatId) {
        await trySaveMsg(chatId, 'user', question);
        await trySaveMsg(chatId, 'assistant', answer);
      }

      return send(res, 200, headers, {
        answer,
        provider: p,
        model: models[p],
        finish_reason: out.finish_reason,
        usage: out.usage
      });
    } catch (e) { lastErr = e; }
  }

  const sorry = humanPrefix() + 'I’m having trouble reaching my AI providers. Please try again shortly.';
  return send(res, 200, headers, { answer: sorry, provider: 'none', error: lastErr?.message || 'all providers failed' });
};
