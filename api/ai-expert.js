// api/ai-expert.js — Edge Function (Groq → DeepInfra → Gemini) with KB + Retrieval
export const config = { runtime: 'edge' };

/* ───────────────────────────── CORS ───────────────────────────── */
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
      'Content-Type': 'application/json; charset=utf-8',
    };
  }
  // Not allowed → no ACAO header on purpose
  return {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

function withTimeout(ms = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(timer) };
}

/* ─────────────────────── Knowledge Base ───────────────────────
   IMPORTANT: This KB is the single source of truth the AI is allowed to use.
   Add/adjust facts here. The answerer is instructed to ONLY use this KB.
-----------------------------------------------------------------*/
const KB = {
  meta: {
    project: 'Album Expert KB',
    version: '2025-08-12',
    topics: ['aavss', 'sldataset'],
  },
  docs: [
    /* ========================= AAVSS ========================= */
    {
      id: 'aavss-overview',
      topic: 'aavss',
      title: 'AAVSS — Overview',
      text: [
        'AAVSS (Advanced Autonomous Vehicle Safety System) is a real-time safety and perception stack.',
        'Focus: on-road hazard awareness, driver alerts, and research prototyping.',
        'Core: multi-sensor fusion (LiDAR + mmWave radar + RGB cameras).',
        'Deployment target: embedded NVIDIA Jetson platform (Nano-class) with TensorRT optimizations.',
        'Goal latency: sub-100 ms end-to-end at 10–20 FPS depending on sensor load and model sizes.',
      ].join(' '),
    },
    {
      id: 'aavss-sensors',
      topic: 'aavss',
      title: 'AAVSS — Sensors & Roles',
      text: [
        'Sensors and roles:',
        '• LiDAR: 3D structure, range, obstacle shape, and ego-free-space estimation.',
        '• mmWave radar: range + radial velocity; robust in rain/fog; complements vision for tracking.',
        '• RGB camera(s): appearance cues, traffic lights/signs, lane markings, vulnerable road users.',
        'Typical placements: roof/bumper LiDAR; front/rear radar; forward camera at windshield height.',
        'Note: exact sensor brands/models are project-dependent; provide your SKUs here if you want the bot to name them.',
      ].join('\n'),
    },
    {
      id: 'aavss-sensor-details',
      topic: 'aavss',
      title: 'AAVSS — Sensor Practicals',
      text: [
        'Sampling hints:',
        '• Camera: 30 FPS (1080p/720p), auto-exposure locked for stability where possible.',
        '• Radar: 10–20 Hz object lists; raw Cube optional if DSP available.',
        '• LiDAR: 10–20 Hz spins; timestamped point clouds.',
        'Sync & timebase: PTP or PPS preferred; otherwise robust NTP + software sync.',
        'Calibration: camera intrinsics (OpenCV), camera–LiDAR extrinsics (chessboard/AprilTag board), radar extrinsics (mount geometry + track alignment).',
      ].join('\n'),
    },
    {
      id: 'aavss-fusion',
      topic: 'aavss',
      title: 'AAVSS — Fusion & Tracking',
      text: [
        'Fusion pipeline (typical):',
        '1) Per-sensor detection: vision detector (YOLO-class), lane segmentation (ENet/SegNet-class), radar object list, LiDAR clustering/ground removal.',
        '2) Association: nearest-neighbor or Hungarian with gating (position/velocity/appearance).',
        '3) Tracking: Kalman/UKF per-object with track lifecycle (birth, confirm, occlusion, delete).',
        '4) Late/object-level fusion output: unified obstacle list with confidence and kinematics.',
        '5) Free-space: LiDAR ground segmentation + camera semantics (optional) for drivable area.',
      ].join('\n'),
    },
    {
      id: 'aavss-safety-analytics',
      topic: 'aavss',
      title: 'AAVSS — Safety Analytics',
      text: [
        'Safety analytics:',
        '• Forward Collision Warning (FCW): time-to-collision thresholds and braking envelope.',
        '• Pedestrian & cyclist awareness: proactive alerts within configurable distance cones.',
        '• Blind-spot hints: side radar/camera occupancy.',
        '• Road surface & weather robustness: radar aids vision in rain/fog/night.',
        'UI: concise HUD prompts; audio haptics optional.',
      ].join('\n'),
    },
    {
      id: 'aavss-compute',
      topic: 'aavss',
      title: 'AAVSS — Compute & Optimization',
      text: [
        'Compute: NVIDIA Jetson Nano-class (Maxwell 128-core GPU) with 4 GB RAM.',
        'Optimizations: TensorRT FP16/INT8 where available, layer fusion, smaller backbones.',
        'Pipelines: zero-copy camera capture; ring-buffer LiDAR; batched radar lists; pinned memory.',
        'Budget: keep total GPU <80% and CPU <70% to leave headroom for bursts.',
      ].join('\n'),
    },
    {
      id: 'aavss-testing',
      topic: 'aavss',
      title: 'AAVSS — Testing & Metrics',
      text: [
        'Offline eval: mAP@50 for detectors, MOTA/MOTP for tracking, lane IoU/F1 for segmentation.',
        'Online eval: end-to-end latency, missed detection rate, false alert rate, alert lead time.',
        'Scenario coverage: day/night, rain, fog, urban congestion, rural roads, highways.',
      ].join('\n'),
    },
    {
      id: 'aavss-limitations',
      topic: 'aavss',
      title: 'AAVSS — Limitations & Roadmap',
      text: [
        'Known limitations (generic): heavy rain can degrade camera; LiDAR can saturate in snow; radar ghosting near metallic infrastructure.',
        'Roadmap (example): thermal camera night boost; radar-only fallback mode; improved ego-lane topology; HD map hooks.',
      ].join('\n'),
    },

    /* =================== Sri Lankan Dataset =================== */
    {
      id: 'sld-overview',
      topic: 'sldataset',
      title: 'Sri Lankan Autonomous Driving Dataset — Overview',
      text: [
        'Dataset theme: left-hand traffic, dense mixed fleets (tuk-tuks, buses, bikes), varied weather (sun, rain, fog), and narrow urban roads.',
        'Intended use: perception research (detection, tracking, lane, sign recognition) and domain adaptation for South Asian roads.',
      ].join(' '),
    },
    {
      id: 'sld-collection',
      topic: 'sldataset',
      title: 'Dataset — Collection & Modalities',
      text: [
        'Modalities (typical design): forward-facing RGB video (1080p/30), optional side cams, GPS/IMU metadata.',
        'Conditions: day, night, rain, fog; urban cores and suburban/rural connectors.',
        'Note: Replace with exact camera makes, resolutions, mount heights, and routes when finalized.',
      ].join('\n'),
    },
    {
      id: 'sld-annotations',
      topic: 'sldataset',
      title: 'Dataset — Annotations',
      text: [
        'Annotations (typical plan):',
        '• Object 2D boxes: vehicles, buses, tuk-tuks, trucks, bikes, pedestrians, animals.',
        '• Lane markings: polylines with type (dashed, solid) when available.',
        '• Traffic signs/lights: category and state (e.g., red/yellow/green).',
        '• Frame tags: weather, time-of-day, road type.',
        'Please fill in exact annotation specs and tooling (e.g., CVAT/Label Studio) when locked.',
      ].join('\n'),
    },
    {
      id: 'sld-splits-metrics',
      topic: 'sldataset',
      title: 'Dataset — Splits & Metrics',
      text: [
        'Recommended splits: train/val/test with route-level separation to minimize leakage.',
        'Metrics: mAP@50 for detection, class-wise F1, lane IoU/F1; publish per-condition breakdowns.',
      ].join('\n'),
    },
    {
      id: 'sld-distribution',
      topic: 'sldataset',
      title: 'Dataset — Distribution & License',
      text: [
        'Distribution: downloadable packages per city/condition; checksum manifests.',
        'License: research-friendly; contact maintainers for commercial terms.',
        'Citations: include BibTeX when public.',
      ].join('\n'),
    },
    {
      id: 'sld-uniques',
      topic: 'sldataset',
      title: 'Dataset — Sri Lanka Specifics',
      text: [
        'Distinctives: left-hand traffic, dense bus corridors, tuk-tuk behavior, frequent unprotected turns, zebra crossings without signals, occasional animal crossings.',
        'Signage/lingual: Sinhala/Tamil/English; ensure label taxonomy includes local sign classes.',
      ].join('\n'),
    },

    /* =================== Cross-topic Q&A helpers =================== */
    {
      id: 'qa-sensors-unknown-models',
      topic: 'aavss',
      title: 'Q&A — Sensor Models Policy',
      text: [
        'If asked for exact sensor brands/models and they are not listed in this KB, reply that the specific SKUs were not provided in the project notes.',
        'Offer to integrate them if the user shares the list (the bot can remember once KB is updated).',
      ].join(' '),
    },
    {
      id: 'qa-where-to-add-specifics',
      topic: 'all',
      title: 'Q&A — How to Add Specifics',
      text: [
        'To increase precision, add concrete facts (sensor SKUs, camera resolution, miles of data, label counts) into the KB docs above.',
        'The assistant will strictly answer from KB, preventing hallucinations.',
      ].join(' '),
    },
  ],
};

/* ───────────────────── Retrieval Utilities ───────────────────── */
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_/.:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreDoc(qTokens, doc) {
  const text = normalize(`${doc.title} ${doc.text}`);
  let score = 0;
  for (const t of qTokens) {
    if (!t) continue;
    if (text.includes(` ${t} `) || text.startsWith(t + ' ') || text.endsWith(' ' + t)) score += 3;
    else if (text.includes(t)) score += 1;
  }
  if (text.includes('aavss') || text.includes('autonomous vehicle safety')) score += 1;
  if (text.includes('dataset') || text.includes('sri lanka')) score += 1;
  return score;
}

function detectTopic(q) {
  const n = normalize(q);
  if (/(^|\s)(aavss|fusion|radar|lidar|lane|tracking|jetson|safety)(\s|$)/.test(n)) return 'aavss';
  if (/(^|\s)(dataset|data set|sri lanka|annotation|label|split|download|license)(\s|$)/.test(n)) return 'sldataset';
  return 'all';
}

// Topic-aware topK to prevent mixing
function topK(q, k = 8, topic = 'all') {
  const qTokens = normalize(q).split(' ');
  const pool = KB.docs.filter(d => {
    if (topic === 'aavss')     return d.topic === 'aavss' || d.topic === 'all';
    if (topic === 'sldataset') return d.topic === 'sldataset' || d.topic === 'all';
    return true;
  });
  const ranked = pool
    .map(d => ({ d, s: scoreDoc(qTokens, d) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map(x => x.d);

  if (ranked.length === 0) {
    if (topic === 'aavss')     return KB.docs.filter(d => d.id === 'aavss-overview');
    if (topic === 'sldataset') return KB.docs.filter(d => d.id === 'sld-overview');
    return KB.docs.filter(d => d.id === 'aavss-overview' || d.id === 'sld-overview');
  }
  return ranked;
}

function buildContext(q, topic = 'all') {
  const k = topK(q, 8, topic);
  const ctx = k.map((d, i) => `#${i + 1} ${d.title}\n${d.text}`).join('\n\n');
  const ids = k.map(d => d.id);
  return { ctx, ids };
}

/* ───────────────────── Providers (Text) ───────────────────── */
async function askGroq({ system, user, signal }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-70b-versatile',
      temperature: 0.2,
      max_tokens: 450,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
    }),
  });
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}: ${await r.text().catch(()=> '')}`);
  const j = await r.json();
  return (j?.choices?.[0]?.message?.content ?? '').trim();
}

async function askDeepInfra({ system, user, signal }) {
  const key = process.env.DEEPINFRA_API_KEY;
  if (!key) throw new Error('DEEPINFRA_API_KEY not set');
  const r = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
      temperature: 0.2,
      max_tokens: 450,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
    }),
  });
  if (!r.ok) throw new Error(`DeepInfra HTTP ${r.status}: ${await r.text().catch(()=> '')}`);
  const j = await r.json();
  return (j?.choices?.[0]?.message?.content ?? '').trim();
}

async function askGemini({ system, user, signal }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        { role: 'user', parts: [{ text: `${system}\n\n---\n\n${user}` }] }
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 450 },
    }),
  });
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${await r.text().catch(()=> '')}`);
  const j = await r.json();
  const text =
    j?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('').trim() ||
    j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
    '';
  return text;
}

/* ───────────────────── Prompt Construction ───────────────────── */
function systemPrompt(topic) {
  return [
    'You are a professional, friendly technical assistant for an album/portfolio site.',
    'Answer ONLY from the Knowledge Base (KB) provided below.',
    'If the user asks for details not in the KB (e.g., exact sensor SKUs, label counts),',
    "say they’re not specified and invite the user to provide them so we can update the KB.",
    'Be concise but concrete. Use short paragraphs and bullets when helpful.',
    `Topic focus: ${topic}.`,
  ].join(' ');
}

function userPrompt(question, ctx) {
  return [
    'KB:',
    '"""',
    ctx,
    '"""',
    '',
    `User question: ${question}`,
    '',
    'Instructions:',
    '- Use only KB facts. If unknown, say so briefly and suggest adding the info.',
    '- Prefer specific, actionable guidance (pipelines, calibration, metrics, safety).',
    '- Maintain a helpful, confident tone; no speculation.',
  ].join('\n');
}

/* ───────────────────────── Handler ───────────────────────── */
export default async function handler(req) {
  const origin = req.headers.get('origin') || undefined;
  const headers = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Only POST supported' }), { status: 405, headers });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const question = String(body?.question || '').trim();
    if (!question) {
      return new Response(JSON.stringify({ error: 'Missing question' }), { status: 400, headers });
    }

    // ── NEW: accept a client hint to pin the topic (from app.js)
    const userHint = String(body?.topicHint || '').trim().toLowerCase();
    const validHint = (userHint === 'aavss' || userHint === 'sldataset') ? userHint : '';

    // Topic detection and topic-aware retrieval (prevents AAVSS/Dataset mixing)
    const topic = validHint || detectTopic(question);
    const { ctx, ids } = buildContext(question, topic);

    const sys = systemPrompt(topic);
    const usr = userPrompt(question, ctx);

    // Provider fallback: Groq → DeepInfra → Gemini
    let answer = '';
    let provider = '';
    const providers = [
      { name: 'groq',      fn: askGroq },
      { name: 'deepinfra', fn: askDeepInfra },
      { name: 'gemini',    fn: askGemini },
    ];

    for (const p of providers) {
      try {
        const t = withTimeout(30_000);
        answer = await p.fn({ system: sys, user: usr, signal: t.signal });
        t.clear();
        provider = p.name;
        if (answer) break;
      } catch (_e) {
        // continue to next provider
      }
    }

    // Final fallback: stitched KB if all providers fail
    if (!answer) {
      const stitched = ids
        .map((id, i) => {
          const d = KB.docs.find(x => x.id === id);
          return d ? `(${i + 1}) ${d.title}\n${d.text}` : '';
        })
        .filter(Boolean)
        .join('\n\n');
      answer = [
        'I could not reach the AI providers right now, so here is a concise summary from the KB:',
        '',
        stitched || 'No KB matches found. Please refine your question.',
      ].join('\n');
      provider = 'kb-fallback';
    }

    // Gentle polish (no hallucination)
    answer = answer.trim().replace(/\n{3,}/g, '\n\n');

    return new Response(JSON.stringify({
      answer,
      provider,
      topic,
      sources: ids,
    }), { headers });
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'Upstream request timed out' : (err?.message || 'Server error');
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers });
  }
}
