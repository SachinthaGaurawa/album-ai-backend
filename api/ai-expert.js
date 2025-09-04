// /api/ai-expert.js
// Vercel Serverless Function (Node.js runtime)
// Input:  POST { question: string, chat_id?: string, options?: {...} }
// Output: 200 JSON { answer, provider, model, usage?, finish_reason? }  OR 4xx/5xx { error }
//
// Features:
// - Multi-provider LLM routing: GROQ -> DEEPINFRA -> GEMINI (configurable)
// - Human-friendly style & light guardrails
// - Image intent detection -> calls /api/img and returns Markdown with inline image
// - Timeouts, retries, and good error surfacing
//
// ENV you can set on Vercel (all optional except the API keys you want to use):
//  GROQ_API_KEY,           GROQ_MODEL (default: "llama-3.1-70b-versatile")
//  DEEPINFRA_API_KEY,      DEEPINFRA_MODEL (default: "meta-llama/Meta-Llama-3.1-70B-Instruct")
//  GEMINI_API_KEY,         GEMINI_MODEL (default: "gemini-1.5-pro")
//  AI_PROVIDER_ORDER (CSV e.g. "groq,deepinfra,gemini")
//  AI_MAX_TOKENS (default 1024) , AI_TEMPERATURE (default 0.3)
//  AI_REQUEST_TIMEOUT_MS (default 30000)
//
// NOTE: This endpoint returns a single string answer (no streaming) to match your app.js.

export default async function handler(req, res) {
  // Only POST
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  // Basic parse
  let body = {};
  try {
    body = JSON.parse(req.body || '{}');
  } catch {
    body = req.body || {};
  }

  const question = (body?.question || '').trim();
  const chatId   = (body?.chat_id || '').trim(); // future: persist memory by chatId (db not required here)
  const options  = body?.options || {};

  if (!question) {
    res.status(400).json({ error: 'Missing "question" in request body.' });
    return;
  }

  // 1) If the user likely wants an image → call /api/img and return markdown with the image
  if (wantsImage(question)) {
    try {
      const imgAnswer = await handleImageIntent(req, question, options);
      res.status(200).json(imgAnswer);
      return;
    } catch (err) {
      console.error('[ai-expert] image intent failed:', err?.message || err);
      // Fall back to text explanation
      // (We still produce a friendly answer instead of throwing)
      const friendly = humanPrefix('image') +
        "I tried to create an image but ran into an issue. Could you try again or phrase the image idea a bit differently?";
      res.status(200).json({ answer: friendly, provider: 'image-fallback' });
      return;
    }
  }

  // 2) Otherwise → normal text LLM with multi-provider fallback
  const providerOrder = getProviderOrder();
  const sysPrompt = buildSystemPrompt(chatId);

  // classic single-turn prompt; you can expand to messages if you store chat history later
  const messages = [
    { role: 'system', content: sysPrompt },
    { role: 'user',   content: question }
  ];

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

  for (const provider of providerOrder) {
    try {
      const out = await callLLM(provider, modelPrefs[provider], messages, genOpts);
      // slight post-process: trim & ensure friendly tone with tiny add-on
      const finalText = polishAnswer(out.text);
      res.status(200).json({
        answer: finalText,
        provider,
        model: modelPrefs[provider],
        finish_reason: out.finish_reason,
        usage: out.usage || undefined
      });
      return;
    } catch (err) {
      lastError = err;
      console.warn(`[ai-expert] provider ${provider} failed:`, err?.message || err);
      // tries next provider automatically
    }
  }

  // If all providers failed
  const sorry = humanPrefix() +
    "I’m having a temporary issue reaching my AI providers. Please try again in a moment.";
  res.status(200).json({ answer: sorry, provider: 'none', error: lastError?.message || 'all providers failed' });
}

/* ------------------------- helpers & providers ------------------------- */

/** Quick heuristic for image intent (feel free to extend these regexes) */
function wantsImage(q) {
  const t = q.toLowerCase();
  const patterns = [
    /\b(draw|sketch|illustrate|paint)\b/,
    /\b(generate|make|create)\s+(an?\s+)?(image|picture|art|logo|poster|icon|photo)\b/,
    /\bimage\s+(please|plz|for me)\b/,
    /\bshow me\b.*\b(image|picture|poster|logo|icon)\b/,
  ];
  return patterns.some(rx => rx.test(t));
}

/** Build absolute base URL to call sibling endpoints like /api/img */
function getBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https');
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

/** Image flow → hit your /api/img and return markdown response */
async function handleImageIntent(req, question, options) {
  const imgProvider = options?.imgProvider || 'deepinfra'; // or 'groq','fal' if you wire them in /api/img.js
  const size = options?.size || '1024x1024';

  const url = new URL('/api/img', getBaseUrl(req));
  url.searchParams.set('provider', imgProvider);
  url.searchParams.set('size', size);
  url.searchParams.set('prompt', question);

  const r = await fetch(url.toString(), { method: 'GET', headers: { 'Content-Type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(j?.error || `Image API failed (${r.status})`);
  }

  // Build a friendly markdown answer with inline image
  const lead = humanPrefix('image') + "Here’s your image. If you want tweaks (style, colors, camera angle), tell me! ✨";
  const md = `${lead}\n\n![](${j.url})`;
  return { answer: md, provider: 'image', model: j.provider || imgProvider };
}

/** Friendly prefix (keeps answers warm & human) */
function humanPrefix(kind = 'text') {
  if (kind === 'image') {
    return "All set! ";
  }
  return "Sure — ";
}

/** Very light post-processing to keep answers tidy */
function polishAnswer(s) {
  const t = String(s || '').trim();
  if (!t) return "I don’t have an answer for that yet — could you rephrase?";
  // prevent overuse of markdown headings from some models
  return t.replace(/\n{3,}/g, '\n\n').replace(/(^#+\s*$)/gm, '');
}

/** Provider preference order */
function getProviderOrder() {
  const raw = (process.env.AI_PROVIDER_ORDER || 'groq,deepinfra,gemini')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  // Keep only known providers
  const allowed = ['groq','deepinfra','gemini'];
  const filtered = raw.filter(p => allowed.includes(p));

  // If API key is missing for a provider, drop it silently
  return filtered.filter(p => hasKey(p));
}

function hasKey(provider) {
  if (provider === 'groq')      return !!process.env.GROQ_API_KEY;
  if (provider === 'deepinfra') return !!process.env.DEEPINFRA_API_KEY;
  if (provider === 'gemini')    return !!process.env.GEMINI_API_KEY;
  return false;
}

/** Call an LLM provider with a unified interface */
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

/** Normalize OpenAI-style messages -> plain prompt for providers that accept "messages" */
function asOpenAIMessages(messages) {
  // we keep it as-is for OpenAI-compatible endpoints
  return messages.map(m => ({ role: m.role, content: m.content }));
}

/* ------------------------------ GROQ ------------------------------ */
// OpenAI-compatible chat API
async function callGroq(model, messages, opts, signal) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Missing GROQ_API_KEY');

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
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

/* --------------------------- DEEPINFRA --------------------------- */
// OpenAI-compatible chat API via DeepInfra
async function callDeepInfra(model, messages, opts, signal) {
  const apiKey = process.env.DEEPINFRA_API_KEY;
  if (!apiKey) throw new Error('Missing DEEPINFRA_API_KEY');

  const r = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
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

/* ----------------------------- GEMINI ---------------------------- */
// Google Generative Language API (Gemini 1.5+). Messages → "contents" format.
async function callGemini(model, messages, opts, signal) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const contents = toGeminiContents(messages);

  const r = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: opts.temperature ?? 0.3,
        maxOutputTokens: opts.max_tokens ?? 1024
      },
      // Safety settings: default allow; you can add stricter filters if you want
    })
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const errMsg = j?.error?.message || `Gemini error ${r.status}`;
    throw new Error(errMsg);
  }

  const text = (j?.candidates?.[0]?.content?.parts || [])
    .map(p => (p.text || ''))
    .join('');

  return {
    text,
    finish_reason: j?.candidates?.[0]?.finishReason || '',
    usage: undefined
  };
}

/** Convert OpenAI-style messages to Gemini contents */
function toGeminiContents(messages) {
  // Gemini expects an array of "contents"; each "content" has "role" and "parts"
  // We map system -> (as if a user preamble), then user/assistant alternate
  return messages.map(m => ({
    role: m.role === 'system' ? 'user' : (m.role || 'user'),
    parts: [{ text: m.content || '' }]
  }));
}

/* ------------------------- System Prompt ------------------------- */

function buildSystemPrompt(chatId) {
  // You can evolve this any time. The goal: warm, specific, concise & helpful.
  // Keep it short so tokens go to the answer, not the boilerplate.
  return [
    "You are a friendly, human-like expert assistant.",
    "Tone: warm, concise, practical. Use simple, clear language.",
    "Behaviors:",
    "- Answer directly in short paragraphs or tight bullet points.",
    "- When the user is vague, ask one short clarifying question.",
    "- If asked for images, you may propose ideas; the app will generate them.",
    "- If you aren’t sure, say so briefly and suggest the next best step.",
    "- Avoid overuse of emojis; sprinkle them when it *adds* clarity or warmth.",
    `Session: ${chatId || 'anonymous'}.`
  ].join('\n');
}
