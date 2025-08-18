// api/img.js — Edge Function (Image GENERATE + SEARCH with graceful fallbacks)
export const config = { runtime: 'edge' };

/* ─────────────── CORS ─────────────── */
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim().replace(/\/+$/,'')).filter(Boolean);
function corsHeaders(origin){
  const o=(origin||'').replace(/\/+$/,'');
  const allow = (!origin || ALLOWED_ORIGINS.length===0 || ALLOWED_ORIGINS.includes(o));
  return {
    ...(allow ? { 'Access-Control-Allow-Origin': origin || '*' } : {}),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
}

/* ─────────────── Helpers ─────────────── */
function pick(arr, n){ return arr.slice(0, Math.max(1, Math.min(n, arr.length))); }
function picsum(n=4, aspect='16:9'){
  const [w,h] = aspect==='9:16' ? [720,1280]
               : aspect==='1:1' ? [1024,1024]
               : aspect==='4:3' ? [1200,900] : [1600,900];
  return Array.from({length:n}, (_,i)=>({
    url:`https://picsum.photos/seed/${Date.now()}_${i}/${w}/${h}`,
    thumb:`https://picsum.photos/seed/${Date.now()}_${i}/${Math.round(w/3)}/${Math.round(h/3)}`,
    filename:`gen_${i+1}.jpg`
  }));
}

/* ─────────────── Providers (best-effort) ─────────────── */
async function genWithFAL({ prompt, n=2, aspect='16:9', realism='photo' }, { signal }){
  const key = process.env.FAL_KEY;
  if (!key) return null;

  // FAL FLUX endpoint (stable contract). You can switch to pro/dev variants by model path.
  // Docs: https://fal.ai (API requires Bearer key)
  const model = 'fal-ai/flux-pro';
  const [w,h] = aspect==='9:16' ? [720,1280]
               : aspect==='1:1' ? [1024,1024]
               : aspect==='4:3' ? [1200,900] : [1600,900];

  const r = await fetch(`https://fal.run/${model}`, {
    method: 'POST', signal,
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      image_size: { width: w, height: h },
      num_images: Math.max(1, Math.min(4, n)),
      // simple style hint
      extra: { style: realism || 'photo' }
    })
  });
  if (!r.ok) throw new Error(`FAL HTTP ${r.status}: ${await r.text().catch(()=> '')}`);
  const j = await r.json();
  // Normalize to {images:[{url, thumb, filename}], provider}
  const out = (j?.images || j?.output || j?.data || [])
    .map((x,i)=> ({ url: x.url || x, thumb: x.url || x, filename: `gen_${i+1}.jpg` }));
  return { images: out, provider: 'fal/flux' };
}

async function searchUnsplash({ query, n=8 }, { signal }){
  const key = process.env.UNSPLASH_KEY;
  if (!key) return null;
  const r = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${Math.max(1,Math.min(30,n))}`, {
    signal, headers: { 'Authorization': `Client-ID ${key}` }
  });
  if (!r.ok) throw new Error(`Unsplash HTTP ${r.status}: ${await r.text().catch(()=> '')}`);
  const j = await r.json();
  const items = (j?.results || []).map(x=>({
    url: x.urls?.full || x.urls?.regular,
    thumb: x.urls?.small || x.urls?.thumb,
    source: x.links?.html,
    author: x.user?.name || '',
    filename: `unsplash_${x.id}.jpg`
  }));
  return { images: pick(items, n), provider: 'unsplash' };
}

function withTimeout(ms=60_000){
  const ac = new AbortController(); const t = setTimeout(()=>ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(t) };
}

/* ─────────────── Handler ─────────────── */
export default async function handler(req){
  const origin = req.headers.get('origin') || undefined;
  const headers = corsHeaders(origin);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error:'Only POST' }), { status:405, headers });

  try{
    const body = await req.json().catch(()=> ({}));
    const mode = String(body?.mode || '').toLowerCase();

    if (mode === 'generate'){
      const prompt = (body?.prompt || '').toString().trim();
      const n = Math.max(1, Math.min(4, parseInt(body?.n,10) || 2));
      const aspect = String(body?.aspect || '16:9');
      const realism = String(body?.realism || 'photo');
      if (!prompt) return new Response(JSON.stringify({ error:'Missing prompt' }), { status:400, headers });

      const t = withTimeout(120_000);
      let out = null;
      try{ out = await genWithFAL({prompt,n,aspect,realism}, t); }catch(_e){ /* try fallback below */ }
      t.clear();

      if (out && out.images?.length){
        return new Response(JSON.stringify({ images: out.images, provider: out.provider, meta:{ aspect, realism }}), { headers });
      }
      // demo fallback
      return new Response(JSON.stringify({ images: picsum(n, aspect), provider: 'demo' }), { headers });
    }

    if (mode === 'search'){
      const query = (body?.query || '').toString().trim();
      const n = Math.max(1, Math.min(30, parseInt(body?.n,10) || 8));
      if (!query) return new Response(JSON.stringify({ error:'Missing query' }), { status:400, headers });

      const t = withTimeout(30_000);
      let out = null;
      try{ out = await searchUnsplash({query,n}, t); }catch(_e){ /* fall through */ }
      t.clear();

      if (out && out.images?.length){
        return new Response(JSON.stringify({ images: out.images, provider: out.provider }), { headers });
      }
      // demo fallback
      return new Response(JSON.stringify({ images: picsum(n, '16:9'), provider: 'demo' }), { headers });
    }

    return new Response(JSON.stringify({ error:'Unknown mode' }), { status:400, headers });
  }catch(err){
    const msg = err?.name === 'AbortError' ? 'Request timed out' : (err?.message || 'Server error');
    return new Response(JSON.stringify({ error: msg }), { status:500, headers });
  }
}