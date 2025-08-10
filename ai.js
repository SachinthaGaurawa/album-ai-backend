// Vercel Serverless Function: /api/ai
// Handles both: mode = 'ask' (Perplexity/OpenAI chat) and mode = 'caption' (OpenAI vision)

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function corsHeaders(origin) {
  if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Cache-Control': 'no-store',
    };
  }
  return { 'Cache-Control': 'no-store' };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || undefined;
  const headers = corsHeaders(origin);

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.writeHead(204, headers).end();
  }

  if (req.method !== 'POST') {
    return res.writeHead(405, headers).end(JSON.stringify({ error: 'Only POST supported' }));
  }

  // Parse body
  let body = {};
  try { body = req.body ?? JSON.parse(req.rawBody?.toString() || '{}'); } catch {}
  const { mode, question, context, imageUrl } = body || {};

  const hasPPLX = !!process.env.PPLX_API_KEY;
  const hasOAI  = !!process.env.OPENAI_API_KEY;
  if (!hasPPLX && !hasOAI) {
    return res
      .writeHead(500, headers)
      .end(JSON.stringify({ error: 'No provider keys configured (PPLX_API_KEY and/or OPENAI_API_KEY).' }));
  }

  try {
    if (mode === 'ask') {
      if (!question || !context) {
        return res.writeHead(400, headers).end(JSON.stringify({ error: 'Missing question/context' }));
      }
      if (String(question).length > 2000) {
        return res.writeHead(413, headers).end(JSON.stringify({ error: 'Question too long' }));
      }

      // Try Perplexity first
      if (hasPPLX) {
        try {
          const ac = new AbortController();
          const to = setTimeout(() => ac.abort(), 30000);
          const r = await fetch('https://api.perplexity.ai/chat/completions', {
            method: 'POST',
            signal: ac.signal,
            headers: {
              'Authorization': `Bearer ${process.env.PPLX_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'sonar',
              temperature: 0.2,
              max_tokens: 400,
              messages: [
                { role: 'system',
                  content: 'You are a concise technical assistant for a portfolio site. Only use the provided album context. If unknown, say so briefly.' },
                { role: 'user',
                  content: `Album context:\n${context}\n\nQuestion: ${question}\nAnswer in 2–6 sentences with concrete details if present.` }
              ],
            }),
          });
          clearTimeout(to);
          if (!r.ok) throw new Error(`Perplexity HTTP ${r.status}: ${await r.text().catch(()=> '')}`);
          const j = await r.json();
          const answer = (j?.choices?.[0]?.message?.content ?? '').trim();
          return res.writeHead(200, headers).end(JSON.stringify({ answer, provider: 'perplexity' }));
        } catch {
          // fall through to OpenAI
        }
      }

      // Fallback OpenAI
      if (hasOAI) {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 30000);
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          signal: ac.signal,
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            temperature: 0.2,
            max_tokens: 400,
            messages: [
              { role: 'system',
                content: 'You are a concise technical assistant for a portfolio site. Only use the provided album context.' },
              { role: 'user',
                content: `Album context:\n${context}\n\nQuestion: ${question}` },
            ],
          }),
        });
        clearTimeout(to);
        if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${await r.text().catch(()=> '')}`);
        const j = await r.json();
        const answer = (j?.choices?.[0]?.message?.content ?? '').trim();
        return res.writeHead(200, headers).end(JSON.stringify({ answer, provider: 'openai' }));
      }

      return res.writeHead(502, headers).end(JSON.stringify({ error: 'All providers failed.' }));
    }

    if (mode === 'caption') {
      if (!imageUrl) {
        return res.writeHead(400, headers).end(JSON.stringify({ error: 'Missing imageUrl' }));
      }
      if (!hasOAI) {
        return res.writeHead(500, headers).end(JSON.stringify({ error: 'OPENAI_API_KEY required for captions' }));
      }

      // 1) Caption
      const ac1 = new AbortController();
      const to1 = setTimeout(() => ac1.abort(), 30000);
      const capReq = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: ac1.signal,
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.2,
          max_tokens: 160,
          messages: [
            { role: 'system', content: 'Describe the image in one concise sentence. Avoid opinions; be specific.' },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Describe this image in one sentence.' },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
        }),
      });
      clearTimeout(to1);
      if (!capReq.ok) {
        const txt = await capReq.text().catch(() => '');
        return res.writeHead(502, headers).end(JSON.stringify({ error: `Vision HTTP ${capReq.status}: ${txt}` }));
      }
      const capJson = await capReq.json();
      const caption = (capJson?.choices?.[0]?.message?.content || '').trim();

      // 2) Tags
      const ac2 = new AbortController();
      const to2 = setTimeout(() => ac2.abort(), 30000);
      const tagReq = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: ac2.signal,
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.1,
          max_tokens: 60,
          messages: [
            { role: 'system', content: 'Return 3–6 comma-separated tags. Use short, concrete nouns/adjectives only.' },
            { role: 'user', content: `Caption: ${caption}\nReturn only tags.` },
          ],
        }),
      });
      clearTimeout(to2);
      if (!tagReq.ok) {
        const txt = await tagReq.text().catch(() => '');
        return res.writeHead(502, headers).end(JSON.stringify({ error: `Tags HTTP ${tagReq.status}: ${txt}` }));
      }
      const tagJson = await tagReq.json();
      const tagLine = (tagJson?.choices?.[0]?.message?.content || '').trim();
      const tags = tagLine.split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);

      return res.writeHead(200, headers).end(JSON.stringify({ caption, tags }));
    }

    return res.writeHead(400, headers).end(JSON.stringify({ error: 'Invalid mode. Use "ask" or "caption".' }));
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'Upstream request timed out' : (err?.message || 'Server error');
    return res.writeHead(500, headers).end(JSON.stringify({ error: msg }));
  }
}
