/* ============================================================
   asr.js —— 浏览器录音 → OpenAI whisper-1 转写
   MediaRecorder 采集 webm/opus，POST 到 {base}/audio/transcriptions
   ============================================================ */

let mediaRecorder = null;
let chunks = [];
let audioStream = null;
let audioCtx = null;

/** 开始录音；返回 {stop, getBlob, isRecording} */
export async function startRecording({ mimeType = 'audio/webm;codecs=opus', autoMaxMs = 60000 } = {}) {
  if (mediaRecorder && mediaRecorder.state === 'recording') return { isRecording: true };

  audioStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  // 简单电平检测（用于 UI 动画，可选）
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  chunks = [];
  mediaRecorder = new MediaRecorder(audioStream, { mimeType });
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  mediaRecorder.start();

  let autoTimer = null;
  if (autoMaxMs) {
    autoTimer = setTimeout(() => { try { mediaRecorder.stop(); } catch {} }, autoMaxMs);
  }

  return {
    isRecording: true,
    stop: () => {
      clearTimeout(autoTimer);
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        return new Promise((resolve) => {
          mediaRecorder.onstop = () => resolve();
          mediaRecorder.stop();
        });
      }
      resolve();
    },
    getBlob: () => new Blob(chunks, { type: mimeType }),
  };
}

export async function stopRecording() {
  await startRecording(); // 已 recording 时立即返回
}

export function stopAudio() {
  audioStream?.getTracks().forEach(t => t.stop());
  audioStream = null;
  audioCtx?.close?.();
  audioCtx = null;
}

/** 转写音频 blob 为文本 */
export async function transcribe({ cfg, blob, onProgress }) {
  const a = effectiveAsrConfig(cfg);
  if (a.provider === 'none' || !a.apiKey) {
    throw new Error('ASR 未配置（provider=none 或缺少 apiKey）');
  }

  const form = new FormData();
  form.append('file', blob, 'audio.webm');
  form.append('model', a.model);
  form.append('language', 'zh');
  form.append('response_format', 'json');

  onProgress && onProgress('transcribing');

  const resp = await fetch(`${a.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${a.apiKey}` },
    body: form,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`ASR ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  onProgress && onProgress('done');
  return data.text || '';
}

function effectiveAsrConfig(cfg) {
  const llmBase = (cfg.llm?.baseUrl || '').replace(/\/$/, '');
  const llmKey = cfg.llm?.apiKey || '';
  return {
    baseUrl: (cfg.asr?.baseUrl || llmBase).replace(/\/$/, ''),
    apiKey: cfg.asr?.apiKey || llmKey,
    model: cfg.asr?.model || 'whisper-1',
    provider: cfg.asr?.provider || 'openai',
  };
}
