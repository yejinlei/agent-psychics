/* ============================================================
   config.js —— 浏览器 localStorage 配置层
   参考 nobel-kg（langgraph.js 生态）的多 provider 策略，
   Key 只保存在用户本地。
   ============================================================ */

const KEY = 'psychics.cfg.v1';

const DEFAULTS = {
  llm: {
    baseUrl: 'https://token.sensenova.cn/v1',
    apiKey: '',
    model: 'sensenova-6.8-flash-lite',
    temperature: 0.4,
    enableThinking: false,
    referer: 'https://agent-psychics.local',
    title: 'Psychics Ontology Agent',
  },
  asr: {
    provider: 'openai',
    model: 'whisper-1',
    apiKey: '',
    baseUrl: '',
  },
  tts: {
    provider: 'openai', // openai | browser | none
    model: 'tts-1',
    voice: 'alloy',
    apiKey: '',
    baseUrl: '',
  },
  // 后端 Python API（可选，本地开发时用；GH Pages 上留空则直读 CSV）
  backendUrl: '',
};

const PRESETS = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
  },
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  sensenova: {
    baseUrl: 'https://token.sensenova.cn/v1',
    model: 'sensenova-6.8-flash-lite',
  },
  custom: {},
};

export function loadConfig() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return {
      llm: { ...DEFAULTS.llm, ...parsed.llm },
      asr: { ...DEFAULTS.asr, ...parsed.asr },
      tts: { ...DEFAULTS.tts, ...parsed.tts },
      backendUrl: parsed.backendUrl || '',
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(cfg) {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}

export function clearConfig() {
  localStorage.removeItem(KEY);
}

export function applyPreset(name) {
  const p = PRESETS[name] || {};
  return p;
}

export function effectiveAsr(cfg) {
  return {
    baseUrl: (cfg.asr.baseUrl || cfg.llm.baseUrl).replace(/\/$/, ''),
    apiKey: cfg.asr.apiKey || cfg.llm.apiKey,
    model: cfg.asr.model || 'whisper-1',
    provider: cfg.asr.provider || 'openai',
  };
}

export function effectiveTts(cfg) {
  return {
    baseUrl: (cfg.tts.baseUrl || cfg.llm.baseUrl).replace(/\/$/, ''),
    apiKey: cfg.tts.apiKey || cfg.llm.apiKey,
    model: cfg.tts.model || 'tts-1',
    voice: cfg.tts.voice || 'alloy',
    provider: cfg.tts.provider || 'openai',
  };
}

export function isLlmConfigured(cfg) {
  return !!(cfg.llm.apiKey && cfg.llm.baseUrl && cfg.llm.model);
}
