// 偵測「本機正在跑的 OpenAI 相容模型 server」，讓 code-tree 不必登入任何雲端 LLM
// 就能直接寫 code。探測順序：env 指定 > Ollama(:11434) > 通用 OpenAI 相容(:8000/:1234)。
// 回 { baseURL, model, provider, models } 或 null。model 為 null 代表 server 在跑但沒裝模型。
//
// 為什麼是這幾個：
//   - Ollama 是目前最普及的「裝了就有、零雲端登入」本機路徑，OpenAI 端點在 :11434/v1，
//     原生清單在 /api/tags（回 { models:[{name}] }）。
//   - vLLM / llama.cpp server / LM Studio 都吐 OpenAI 相容 /v1/models（回 { data:[{id}] }）。

// 挑模型時偏好「會寫 code 的」：名字含這些關鍵字的優先。
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
  // 0) env 明確指定 → 直接信，不探測
  const envUrl = process.env.CODETREE_LOCAL_URL;
  if (envUrl) {
    return {
      baseURL: envUrl.replace(/\/$/, ''),
      model: process.env.CODETREE_LOCAL_MODEL || preferModel || 'qwen2.5-coder',
      provider: 'env',
      models: [],
    };
  }

  // 1) Ollama（主路徑，timeout 放寬到 3s：機器忙時 1.2s 會偶發 miss，害我們誤判沒有本機可退）
  const tags = await getJson('http://localhost:11434/api/tags', 3000);
  if (tags && Array.isArray(tags.models)) {
    const names = tags.models.map((m) => m.name || m.model).filter(Boolean);
    return {
      baseURL: 'http://localhost:11434/v1',
      model: pickModel(names, preferModel), // 沒裝模型時為 null
      provider: 'ollama',
      models: names,
    };
  }

  // 2) 通用 OpenAI 相容 server（vLLM / llama.cpp / LM Studio）
  for (const base of ['http://localhost:8000/v1', 'http://localhost:1234/v1']) {
    const models = await getJson(base + '/models');
    const data = models && models.data;
    if (Array.isArray(data) && data.length) {
      const names = data.map((m) => m.id).filter(Boolean);
      return { baseURL: base, model: pickModel(names, preferModel), provider: 'openai-compat', models: names };
    }
  }

  return null;
}
