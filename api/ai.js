// api/ai.js — Edge Function (Groq + DeepInfra + Gemini)
// No Node runtime config required
export const config = { runtime: 'edge' };

/* -------------------- CORS -------------------- */
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

function corsHeaders(origin) {
  const o = (origin || '').replace(/\/+$/, '');
  if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(o)) {
    return {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Cache-Control': 'no-store',
    };
  }
  return { 'Cache-Control': 'no-store' };
}

function withTimeout(ms = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(t) };
}

/* --------------- Providers: Q&A (text) --------------- */
// 1) Groq (OpenAI-compatible)
async function askGroq({ question, context, signal }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.1-70b-versatile', // good quality, change if you prefer
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: 'system',
          content: 'You are a concise technical assistant for a portfolio site. Only use the provided album context. If unknown, say so briefly.' },
        { role: 'user',
          content: `Album context:\n${context}\n\nQuestion: ${question}\nAnswer in 2–6 sentences with concrete details if present.` }
      ]
    })
  });
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}: ${await r.text().catch(()=> '')}`);
  const j = await r.json();
  return (j?.choices?.[0]?.message?.content ?? '').trim();
}

// 2) DeepInfra (OpenAI-compatible)
async function askDeepInfra({ question, context, signal }) {
  const key = process.env.DEEPINFRA_API_KEY;
  if (!key) throw new Error('DEEPINFRA_API_KEY not set');
  const r = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'meta-llama/Meta-Llama-3.1-8B-Instruct', // or 70B if you want higher quality
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: 'system',
          content: 'You are a concise technical assistant for a portfolio site. Only use the provided album context.' },
        { role: 'user',
          content: `Album context:\n${context}\n\nQuestion: ${question}` }
      ]
    })
  });
  if (!r.ok) throw new Error(`DeepInfra HTTP ${r.status}: ${await r.text().catch(()=> '')}`);
  const j = await r.json();
  return (j?.choices?.[0]?.message?.content ?? '').trim();
}

// 3) Gemini (text-only fallback)
async function askGeminiText({ question, context, signal }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(key)}`;
  const prompt =
    'You are a concise technical assistant for a portfolio site. ' +
    'Only use the provided album context. If unknown, say so briefly.\n\n' +
    `Album context:\n${context}\n\nQuestion: ${question}\n` +
    'Answer in 2–6 sentences with concrete details if present.';
  const r = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 400 }
    })
  });
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${await r.text().catch(()=> '')}`);
  const j = await r.json();
  const text =
    j?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('').trim() ||
    j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
    '';
  return text;
}

/* --------------- Provider: Captions (vision) --------------- */
// Gemini requires image bytes (or file upload). We fetch the URL and inline as base64.
async function arrayBufferToBase64(ab) {
  // Edge Runtime supports btoa over strings; convert ArrayBuffer to binary string
  let binary = '';
  const bytes = new Uint8Array(ab);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function captionWithGemini({ imageUrl, signal }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');

  // Fetch image bytes
  const imgRes = await fetch(imageUrl, { signal });
  if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
  const mime = imgRes.headers.get('content-type') || 'image/jpeg';
  const bytes = await imgRes.arrayBuffer();
  const b64 = await arrayBufferToBase64(bytes);

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(key)}`;

  // 1) Caption
  const capBody = {
    contents: [{
      role: 'user',
      parts: [
        { text: 'Describe this image in one concise, specific sentence.' },
        { inline_data: { mime_type: mime, data: b64 } }
      ]
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 160 }
  };
  const capReq = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(capBody),
  });
  if (!capReq.ok) throw new Error(`Gemini Vision HTTP ${capReq.status}: ${await capReq.text().catch(()=> '')}`);
  const capJson = await capReq.json();
  const caption =
    capJson?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('').trim() ||
    capJson?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
    '';

  // 2) Tags from caption (text-only)
  const tagPrompt = `Caption: ${caption}\nReturn 3–6 comma-separated tags. Use short, concrete nouns/adjectives only. Return ONLY the tags.`;
  const tagReq = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: tagPrompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 60 }
    }),
  });
  if (!tagReq.ok) throw new Error(`Gemini Tags HTTP ${tagReq.status}: ${await tagReq.text().catch(()=> '')}`);
  const tagJson = await tagReq.json();
  const tagText =
    tagJson?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('').trim() ||
    tagJson?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
    '';
  const tags = tagText.split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);

  return { caption, tags };
}

/* -------------------- Handler -------------------- */
export default async function handler(req) {
  const origin = req.headers.get('origin') || undefined;
  const headers = corsHeaders(origin);

  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Only POST supported' }), { status: 405, headers });
  }

  try {
    const { mode, question, context, imageUrl } = await req.json().catch(() => ({}));

    const hasGroq = !!process.env.GROQ_API_KEY;
    const hasGem  = !!process.env.GEMINI_API_KEY;
    const hasDI   = !!process.env.DEEPINFRA_API_KEY;

    if (mode === 'ask') {
      if (!question || !context) {
        return new Response(JSON.stringify({ error: 'Missing question/context' }), { status: 400, headers });
      }
      if (String(question).length > 2000) {
        return new Response(JSON.stringify({ error: 'Question too long' }), { status: 413, headers });
      }

      // Try Groq → DeepInfra → Gemini
      // Each wrapped with its own timeout; we fall through on errors.
      if (hasGroq) {
        const t = withTimeout(30000);
        try {
          const answer = await askGroq({ question, context, signal: t.signal });
          t.clear();
          return new Response(JSON.stringify({ answer, provider: 'groq' }), { headers });
        } catch { t.clear(); /* fall through */ }
      }
      if (hasDI) {
        const t = withTimeout(30000);
        try {
          const answer = await askDeepInfra({ question, context, signal: t.signal });
          t.clear();
          return new Response(JSON.stringify({ answer, provider: 'deepinfra' }), { headers });
        } catch { t.clear(); /* fall through */ }
      }
      if (hasGem) {
        const t = withTimeout(30000);
        try {
          const answer = await askGeminiText({ question, context, signal: t.signal });
          t.clear();
          return new Response(JSON.stringify({ answer, provider: 'gemini' }), { headers });
        } catch { t.clear(); /* fall through */ }
      }

      return new Response(JSON.stringify({ error: 'No provider available or all providers failed.' }), { status: 502, headers });
    }

    if (mode === 'caption') {
      if (!imageUrl) {
        return new Response(JSON.stringify({ error: 'Missing imageUrl' }), { status: 400, headers });
      }
      if (!hasGem) {
        return new Response(JSON.stringify({ error: 'GEMINI_API_KEY required for captions' }), { status: 500, headers });
      }
      const t = withTimeout(30000);
      try {
        const data = await captionWithGemini({ imageUrl, signal: t.signal });
        t.clear();
        return new Response(JSON.stringify(data), { headers });
      } catch (err) {
        t.clear();
        const msg = err?.name === 'AbortError' ? 'Upstream request timed out' : (err?.message || 'Server error');
        return new Response(JSON.stringify({ error: msg }), { status: 502, headers });
      }
    }

    return new Response(JSON.stringify({ error: 'Invalid mode. Use "ask" or "caption".' }), { status: 400, headers });
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'Upstream request timed out' : (err?.message || 'Server error');
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers });
  }
}



{
  "name": "album-ai-backend",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=18.18.0"
  },
  "scripts": {
    "build": "echo \"Nothing to build (Edge Function)\"",
    "dev": "vercel dev",
    "start": "vercel dev"
  },
  "dependencies": {}
}

