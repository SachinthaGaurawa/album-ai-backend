// /api/img.js
// Best-ever image generation endpoint for Vercel (Node 18+ / Edge-compatible).
// Providers:
//   - deepinfra: primary T2I (FLUX / SDXL / others)
//   - fal:       optional T2I (great quality; requires FAL_KEY)
//   - gemini:    prompt booster (uses Gemini to refine the prompt; generation routed to deepinfra/fal)
//   - groq:      prompt booster (uses Groq LLM to refine the prompt; generation routed to deepinfra/fal)
//
// Returns chat-friendly JSON with emojis, caption, and alt text.
// No external deps; uses global fetch.

const PROVIDER_DEFAULT_MODEL = {
  deepinfra: "black-forest-labs/FLUX.1-dev", // great default
  fal: "fal-ai/flux/dev"
};

const SAFE_DEFAULTS = {
  size: "1024x1024",
  steps: 28,
  guidance: 7.0
};

function parseSize(s) {
  // Accept "1024x1024" or "1024"
  if (!s) return { w: 1024, h: 1024, label: "1024x1024" };
  const m = String(s).toLowerCase().match(/^(\d{2,4})(?:x(\d{2,4}))?$/);
  if (!m) return { w: 1024, h: 1024, label: "1024x1024" };
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2] || m[1], 10);
  const clamp = (v) => Math.max(256, Math.min(1536, v));
  const W = clamp(w);
  const H = clamp(h);
  return { w: W, h: H, label: `${W}x${H}` };
}

function okJson(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}
function errJson(res, message, status = 400, extra = {}) {
  return okJson(res, { ok: false, error: message, ...extra }, status);
}

async function readBody(req) {
  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    return Object.fromEntries(url.searchParams.entries());
  }
  try {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const raw = Buffer.concat(chunks).toString("utf8") || "{}";
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/* ----------------------------- PROMPT BOOSTERS ---------------------------- */

async function boostPromptWithGemini(rawPrompt, intent = "High-quality photorealistic T2I prompt") {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { prompt: rawPrompt, used: false, provider: null };
  try {
    // Google Generative Language API (text-only, safe for prompt shaping)
    const sys = `You rewrite user prompts into concise, vivid prompts for image generation. Keep nouns and critical details.`;
    const user = `Task: ${intent}\nUser prompt: ${rawPrompt}\nReturn only the improved prompt.`;

    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + key, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: sys }] },
          { role: "user", parts: [{ text: user }] }
        ]
      })
    });
    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (text) return { prompt: text, used: true, provider: "gemini" };
    return { prompt: rawPrompt, used: false, provider: null };
  } catch {
    return { prompt: rawPrompt, used: false, provider: null };
  }
}

async function boostPromptWithGroq(rawPrompt, intent = "High-quality photorealistic T2I prompt") {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { prompt: rawPrompt, used: false, provider: null };
  try {
    // Groq Chat Completions API (Llama-3.x)
    const model = "llama-3.1-8b-instant";
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You rewrite prompts into concise, vivid image prompts. Keep key nouns, style, lighting, camera hints. Avoid long paragraphs." },
          { role: "user", content: `Task: ${intent}\nUser prompt: ${rawPrompt}\nReturn only the improved prompt.` }
        ],
        temperature: 0.4,
        max_tokens: 160
      })
    });
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content?.trim();
    if (text) return { prompt: text, used: true, provider: "groq" };
    return { prompt: rawPrompt, used: false, provider: null };
  } catch {
    return { prompt: rawPrompt, used: false, provider: null };
  }
}

/* ----------------------------- PROVIDER: FAL ------------------------------ */

async function generateWithFal(opts) {
  // Docs: https://fal.ai/models (key required)
  const { prompt, width, height, steps, guidance, seed, model } = opts;
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY is not set");

  // Map model convenience names
  const route = model?.includes("sdxl")
    ? "https://fal.run/fal-ai/stable-diffusion-xl"
    : "https://fal.run/fal-ai/flux/dev";

  const r = await fetch(route, {
    method: "POST",
    headers: {
      "Authorization": `Key ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt,
      image_size: `${width}x${height}`,
      num_inference_steps: steps,
      guidance_scale: guidance,
      seed
    })
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`FAL error: ${r.status} ${t}`);
  }

  const j = await r.json();
  // Typical FAL outputs: { images:[{ url }], image:{url}, ... }
  const url =
    j?.images?.[0]?.url ||
    j?.image?.url ||
    j?.url ||
    j?.data?.[0]?.url;

  if (!url) throw new Error("FAL: No image URL returned");
  return { imageUrl: url, provider: "fal", modelUsed: model || "fal-ai/flux/dev" };
}

/* -------------------------- PROVIDER: DEEPINFRA --------------------------- */

async function generateWithDeepinfra(opts) {
  // Docs: https://deepinfra.com/docs/inference
  const { prompt, width, height, steps, guidance, seed, model } = opts;
  const key = process.env.DEEPINFRA_API_KEY;
  if (!key) throw new Error("DEEPINFRA_API_KEY is not set");

  const mdl = model || PROVIDER_DEFAULT_MODEL.deepinfra;
  const url = `https://api.deepinfra.com/v1/inference/${encodeURIComponent(mdl)}`;

  // DeepInfra commonly accepts SDXL/FLUX style params:
  const payload = {
    prompt,
    image_size: `${width}x${height}`,
    num_inference_steps: steps,
    guidance_scale: guidance
  };
  if (typeof seed === "number") payload.seed = seed;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`DeepInfra error: ${r.status} ${t}`);
  }

  const j = await r.json();

  // Handle several possible result shapes
  let urlOut =
    j?.images?.[0]?.url ||
    j?.images?.[0] ||
    j?.image?.url ||
    j?.image ||
    j?.output?.[0]?.url ||
    j?.output?.[0];

  // Some models may return base64. You can extend to upload to storage if needed.
  if (!urlOut) {
    // Attempt to find any http(s) URL in the payload:
    const maybe = JSON.stringify(j).match(/https?:\/\/[^"'\s]+/);
    if (maybe) urlOut = maybe[0];
  }

  if (!urlOut) throw new Error("DeepInfra: No image URL returned");
  return { imageUrl: urlOut, provider: "deepinfra", modelUsed: mdl };
}

/* --------------------------------- MAIN ---------------------------------- */

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return errJson(res, "Method not allowed", 405);
  }

  try {
    const q = await readBody(req);

    // Inputs
    const rawPrompt = (q.prompt || q.q || "").trim();
    if (!rawPrompt) return errJson(res, "Missing 'prompt'");

    const providerReq = (q.provider || "deepinfra").toLowerCase();
    const model = q.model || undefined;

    const { w, h, label } = parseSize(q.size || SAFE_DEFAULTS.size);
    const steps = Number.isFinite(+q.steps) ? Math.max(8, Math.min(60, +q.steps)) : SAFE_DEFAULTS.steps;
    const guidance = Number.isFinite(+q.guidance) ? Math.max(0, Math.min(20, +q.guidance)) : SAFE_DEFAULTS.guidance;
    const seed = q.seed !== undefined ? parseInt(q.seed, 10) : undefined;

    const wantChatMsg = q.chat === "1" || q.chat === 1 || String(q.chat || "").toLowerCase() === "true";

    // Optional: boost prompt for better composition/style
    let boosted = { prompt: rawPrompt, used: false, provider: null };
    let providerChainInfo = [];

    if (providerReq === "gemini") {
      boosted = await boostPromptWithGemini(rawPrompt);
      providerChainInfo.push("gemini:prompt-boost");
    } else if (providerReq === "groq") {
      boosted = await boostPromptWithGroq(rawPrompt);
      providerChainInfo.push("groq:prompt-boost");
    }

    // Choose actual generator (deepinfra preferred; fal if requested)
    let generator = providerReq;
    if (providerReq === "gemini" || providerReq === "groq") {
      // For image generation, route to deepinfra by default (or fal if user asked)
      generator = (q.route_to || "deepinfra").toLowerCase();
    }

    // Try primary provider, then fallback
    let out;
    const opts = {
      prompt: boosted.prompt,
      width: w,
      height: h,
      steps,
      guidance,
      seed,
      model
    };

    if (generator === "fal") {
      try {
        out = await generateWithFal(opts);
      } catch (e) {
        providerChainInfo.push("fal:fail");
        // Fallback to deepinfra if available
        out = await generateWithDeepinfra(opts);
        providerChainInfo.push("deepinfra:fallback");
      }
    } else {
      try {
        out = await generateWithDeepinfra(opts);
      } catch (e) {
        providerChainInfo.push("deepinfra:fail");
        // Fallback to FAL if configured
        if (process.env.FAL_KEY) {
          out = await generateWithFal(opts);
          providerChainInfo.push("fal:fallback");
        } else {
          throw e;
        }
      }
    }

    const finalProvider = out.provider;
    const finalModel = out.modelUsed || model || PROVIDER_DEFAULT_MODEL[finalProvider] || "unknown";

    // Friendly chat text + caption/alt
    const caption = rawPrompt;
    const alt = `${rawPrompt} (${label}, ${finalModel.includes("flux") ? "FLUX" : finalModel.includes("sdxl") ? "SDXL" : "AI"})`;

    const message = wantChatMsg
      ? `Here you go! ✨ I generated **${label}** with **${finalModel}**.\n\nNeed variations, upscaling, or different styles (cinematic, product, blueprint)?`
      : `Image generated (${label})`;

    const meta = {
      providerRequested: providerReq,
      providerUsed: finalProvider,
      modelRequested: model || null,
      modelUsed: finalModel,
      boosted: boosted.used ? true : false,
      boostProvider: boosted.provider || null,
      chain: providerChainInfo,
      width: w, height: h, steps, guidance, seed: seed ?? null
    };

    return okJson(res, {
      ok: true,
      imageUrl: out.imageUrl,
      alt,
      caption,
      message,
      meta
    });
  } catch (err) {
    const msg = (err && err.message) ? err.message : "Unknown error";
    return errJson(res, "Image generation failed: " + msg, 500);
  }
};
