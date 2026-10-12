/* ============================================================
   llm.js —— OpenAI 兼容 Chat Completion / Stream
   浏览器直连 fetch，兼容 OpenRouter / SiliconFlow / DeepSeek /
   SenseNova / 自建中转。

   SenseNova 6.8 Flash Lite 思考模式兼容：
   - 请求体加 `enable_thinking: false` 关闭 reasoning（可选）
   - 流式响应中区分 `delta.content` 与 `delta.reasoning`
   - 非流式响应 `message.reasoning` 字段被忽略，只取 `content`
   ============================================================ */

/**
 * @param {object} opts
 * @param {object} opts.cfg       loadConfig() 返回值
 * @param {Array}  opts.messages  OpenAI 消息数组
 * @param {Array} [opts.tools]    OpenAI function-calling tools
 * @param {function} [opts.onDelta] (delta, full) => void  仅流式
 * @param {function} [opts.onReasoning] (delta, full) => void  仅流式
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.temperature]
 * @param {string} [opts.model]
 * @param {boolean} [opts.enableThinking]  SenseNova 思考模式（默认 false）
 * @param {boolean} [opts.stream]  覆盖默认流式策略
 */
export async function chat(opts) {
  const { cfg, messages, tools, onDelta, onReasoning, signal,
          temperature, model, enableThinking, stream: streamOverride } = opts;
  const base = cfg.llm.baseUrl.replace(/\/$/, '');
  const apiKey = cfg.llm.apiKey;
  const modelId = model || cfg.llm.model;
  const useTools = Array.isArray(tools) && tools.length > 0;

  // 有 tools 时必须非流式；否则默认流式
  const stream = streamOverride ?? !useTools;

  // SenseNova 思考模型即使 enable_thinking:false 仍会消耗 reasoning，
  // 4000 才够长回复 + reasoning；其他模型 1024 一般够用。
  const defaultMax = /sensenova/i.test(modelId) ? 4000 : 1024;
  const body = {
    model: modelId,
    messages,
    temperature: temperature ?? cfg.llm.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? defaultMax,
    stream,
  };
  // SenseNova 思考模型：默认关闭 thinking，节省 token
  if (modelId.includes('sensenova')) {
    body.enable_thinking = !!enableThinking;
  }
  if (useTools) body.tools = tools;

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  // OpenRouter 流量归属头
  if (base.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = cfg.llm.referer || 'https://agent-psychics.local';
    headers['X-Title'] = cfg.llm.title || 'Psychics Ontology Agent';
  }

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  let resp;
  try {
    resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
    throw new Error('网络错误：' + (err?.message || 'unknown'));
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`LLM ${resp.status}: ${text.slice(0, 400)}`);
  }

  // -------- 非流式 --------
  if (!stream) {
    const data = await resp.json();
    const msg = data.choices?.[0]?.message || {};
    return {
      content: msg.content || '',
      reasoning: msg.reasoning || '',
      toolCalls: msg.tool_calls || [],
      raw: data,
    };
  }

  // -------- 流式 SSE --------
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let fullReasoning = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') {
        return { content: full, reasoning: fullReasoning, toolCalls: [], streamed: true };
      }
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      const delta = j.choices?.[0]?.delta;
      if (!delta) continue;
      // 分离 reasoning 与 content
      if (delta.reasoning) {
        fullReasoning += delta.reasoning;
        onReasoning && onReasoning(delta.reasoning, fullReasoning);
      }
      if (delta.content) {
        full += delta.content;
        onDelta && onDelta(delta.content, full);
      }
    }
  }
  return { content: full, reasoning: fullReasoning, toolCalls: [], streamed: true };
}

/** 测试模型是否可用（最小 prompt） */
export async function testLlm(cfg) {
  try {
    const r = await chat({
      cfg,
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Reply with exactly "OK".' },
        { role: 'user', content: 'ping' },
      ],
      temperature: 0,
      stream: false,
    });
    return { ok: true, reply: (r.content || r.reasoning || '').slice(0, 120) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
