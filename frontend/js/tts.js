/* ============================================================
   tts.js —— OpenAI TTS（主） + 浏览器 SpeechSynthesis（兜底）
   ============================================================ */

let currentAudio = null;

/** 朗读文本；返回停止函数 */
export async function speak({ cfg, text, onProgress }) {
  if (!text) return () => {};
  const t = effectiveTtsConfig(cfg);
  stop();

  // 1) 浏览器兜底
  if (t.provider === 'browser' || !t.apiKey) {
    return speakWithBrowser(text, onProgress);
  }

  // 2) OpenAI TTS
  try {
    const audio = await synthesizeOpenAI({ cfg: t, text });
    playAudio(audio);
    return () => stop();
  } catch (e) {
    // 失败兜底到浏览器 TTS
    try { return speakWithBrowser(text, onProgress); } catch { return () => {}; }
  }
}

function effectiveTtsConfig(cfg) {
  const llmBase = (cfg.llm?.baseUrl || '').replace(/\/$/, '');
  const llmKey = cfg.llm?.apiKey || '';
  return {
    baseUrl: (cfg.tts?.baseUrl || llmBase).replace(/\/$/, ''),
    apiKey: cfg.tts?.apiKey || llmKey,
    model: cfg.tts?.model || 'tts-1',
    voice: cfg.tts?.voice || 'alloy',
    provider: cfg.tts?.provider || 'openai',
  };
}

async function synthesizeOpenAI({ cfg, text }) {
  const body = {
    model: cfg.model,
    voice: cfg.voice,
    input: text.slice(0, 4000),
    speed: 1.0,
  };
  const resp = await fetch(`${cfg.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`TTS ${resp.status}: ${t.slice(0, 200)}`);
  }
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}

function playAudio(url) {
  stop();
  const audio = new Audio(url);
  currentAudio = audio;
  audio.play().catch(() => { /* user gesture 缺失时静默 */ });
  audio.onended = () => { if (currentAudio === audio) currentAudio = null; };
}

function speakWithBrowser(text, onProgress) {
  if (!('speechSynthesis' in window)) throw new Error('SpeechSynthesis 不支持');
  const u = new SpeechSynthesisUtterance(text.slice(0, 4000));
  u.lang = 'zh-CN';
  u.rate = 1.0;
  u.pitch = 1.0;
  onProgress && onProgress('speaking');
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
  return () => window.speechSynthesis.cancel();
}

export function stop() {
  if (currentAudio) {
    try { currentAudio.pause(); currentAudio.src = ''; } catch {}
    currentAudio = null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}
