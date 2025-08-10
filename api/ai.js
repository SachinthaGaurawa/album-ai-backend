// /api/ai.js  — Edge Runtime (one file, one default export)
export const config = { runtime: 'edge' }; // tells Vercel to run as Edge

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

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

async function askPerplexity({ question, context, signal }) {
  const r = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    signal,
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
      ]
    })
  });
  if (!r.ok) throw new Error(`Perplexity HTTP ${r.status}: ${await r.text().catch(()=> '')}`);
  const j = await r.json();
  return (j?.choices?.[0]?.message?.content ?? '').trim();
}

async function askOpenAI({ question, context, signal }) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: 'system', content: 'You are a concise technical assistant for a portfolio site. Only use the provided album context.' },
        { role: 'user', content: `Album context:\n${context}\n\nQuestion: ${question}` }
      ]
    })
  });
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${await r.text().catch(()=> '')}`);
  const j = await r.json();
  return (j?.choices?.[0]?.message?.content ?? '').trim();
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || undefined;
  const headers = corsHeaders(origin);

  // Preflight
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return Response.json({ error: 'Only POST supported' }, { status: 405, headers });

  try {
    const { mode, question, context, imageUrl } = await req.json().catch(()=> ({}));

    const hasPPLX = !!process.env.PPLX_API_KEY;
    const hasOAI  = !!process.env.OPENAI_API_KEY;
    if (!hasPPLX && !hasOAI) {
      return Response.json({ error: 'No provider keys configured.' }, { status: 500, headers });
    }

    if (mode === 'ask') {
      if (!question || !context) return Response.json({ error: 'Missing question/context' }, { status: 400, headers });

      // Try Perplexity → fallback OpenAI
      try {
        if (hasPPLX) {
          const ac = new AbortController(); const to = setTimeout(()=>ac.abort(), 30000);
          const answer = await askPerplexity({ question, context, signal: ac.signal }); clearTimeout(to);
          return Response.json({ answer, provider: 'perplexity' }, { headers });
        }
      } catch {}
      try {
        if (hasOAI) {
          const ac = new AbortController(); const to = setTimeout(()=>ac.abort(), 30000);
          const answer = await askOpenAI({ question, context, signal: ac.signal }); clearTimeout(to);
          return Response.json({ answer, provider: 'openai' }, { headers });
        }
      } catch {
        return Response.json({ error: 'All providers failed.' }, { status: 502, headers });
      }
      return Response.json({ error: 'No provider available.' }, { status: 500, headers });
    }

    if (mode === 'caption') {
      if (!imageUrl) return Response.json({ error: 'Missing imageUrl' }, { status: 400, headers });
      if (!hasOAI)   return Response.json({ error: 'OPENAI_API_KEY required for captions' }, { status: 500, headers });

      // Caption
      const capReq = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.2,
          max_tokens: 160,
          messages: [
            { role: 'system', content: 'Describe the image in one concise sentence. Avoid opinions; be specific.' },
            { role: 'user', content: [
              { type: 'text', text: 'Describe this image in one sentence.' },
              { type: 'image_url', image_url: { url: imageUrl } },
            ]},
          ],
        }),
      });
      if (!capReq.ok) {
        return Response.json({ error: `Vision HTTP ${capReq.status}: ${await capReq.text().catch(()=> '')}` }, { status: 502, headers });
      }
      const capJson  = await capReq.json();
      const caption  = (capJson?.choices?.[0]?.message?.content || '').trim();

      // Tags
      const tagReq = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
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
      if (!tagReq.ok) {
        return Response.json({ error: `Tags HTTP ${tagReq.status}: ${await tagReq.text().catch(()=> '')}` }, { status: 502, headers });
      }
      const tagJson = await tagReq.json();
      const tagLine = (tagJson?.choices?.[0]?.message?.content ?? '').trim();
      const tags    = tagLine.split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);

      return Response.json({ caption, tags }, { headers });
    }

    return Response.json({ error: 'Invalid mode. Use "ask" or "caption".' }, { status: 400, headers });
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'Upstream request timed out' : (err?.message || 'Server error');
    return Response.json({ error: msg }, { status: 500, headers });
  }
}
