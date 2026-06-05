// Detect "an OpenAI-compatible model server running locally" so code-tree can write code directly
// without logging into any cloud LLM. Probe order: env override > Ollama(:11434) > generic OpenAI-compatible(:8000/:1234).
// Returns { baseURL, model, provider, models } or null. A null model means the server is running but has no model installed.
//
// Why these:
//   - Ollama is currently the most common "installed and ready, zero cloud login" local path; its OpenAI endpoint is at :11434/v1,
//     and its native listing is at /api/tags (returns { models:[{name}] }).
//   - vLLM / llama.cpp server / LM Studio all expose OpenAI-compatible /v1/models (returns { data:[{id}] }).

// When picking a model, prefer "one that writes code": names containing these keywords win.
const CODER_HINT = /(coder|code|qwen|deepseek|codellama|starcoder|granite|devstral|codestral|llama)/i;

async function getJson(url, ms = 1200) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function pickModel(names, prefer) {
  if (!names.length) return null;
  if (prefer && names.includes(prefer)) return prefer;
  return names.find((n) => CODER_HINT.test(n)) || names[0];
}

export async function detectLocalLLM({ preferModel } = {}) {
  // 0) env explicitly set → trust it, no probing
  const envUrl = process.env.CODETREE_LOCAL_URL;
  if (envUrl) {
    return {
      baseURL: envUrl.replace(/\/$/, ''),
      model: process.env.CODETREE_LOCAL_MODEL || preferModel || 'qwen2.5-coder',
      provider: 'env',
      models: [],
    };
  }

  // 0.5) Bragi-LLM proxy on :8080 (preferred when available).
  // Bragi is the on-device coder we ship with Code Tree. Its /v1/health returns { model: 'bragi-llm', upstream: 'up' }.
  // If Bragi is running, prefer it: smaller (805 MB), MBPP 92%, zero subscription.
  const bragiHealth = await getJson('http://localhost:8080/v1/health', 1500);
  if (bragiHealth && bragiHealth.model === 'bragi-llm' && bragiHealth.upstream === 'up') {
    return {
      baseURL: 'http://localhost:8080/v1',
      model: 'bragi-llm',
      provider: 'bragi',
      models: ['bragi-llm'],
    };
  }

  // 1) Ollama (the main path; timeout relaxed to 3s: at 1.2s a busy machine occasionally misses, making us wrongly conclude there's no local fallback)
  const tags = await getJson('http://localhost:11434/api/tags', 3000);
  if (tags && Array.isArray(tags.models)) {
    const names = tags.models.map((m) => m.name || m.model).filter(Boolean);
    return {
      baseURL: 'http://localhost:11434/v1',
      model: pickModel(names, preferModel), // null when no model is installed
      provider: 'ollama',
      models: names,
    };
  }

  // 2) generic OpenAI-compatible server (vLLM / llama.cpp / LM Studio / Bragi without health check)
  for (const base of ['http://localhost:8080/v1', 'http://localhost:8000/v1', 'http://localhost:1234/v1']) {
    const models = await getJson(base + '/models');
    const data = models && models.data;
    if (Array.isArray(data) && data.length) {
      const names = data.map((m) => m.id).filter(Boolean);
      return { baseURL: base, model: pickModel(names, preferModel), provider: 'openai-compat', models: names };
    }
  }

  return null;
}
