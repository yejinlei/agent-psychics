/* ============================================================
   agent.js —— Agent 抽象 + Orchestrator（编排者）
   ------------------------------------------------------------
   概念对齐 LangChain JS 生态的 Node 运行时库（nobel-kg 使用
   langgraph.js，deepagents.js 是其上层编排框架，二者同源）：

     LangChain JS                        本项目（浏览器原生）
     ──────────────────────────────      ──────────────────────────────
     createDeepAgent({model,             new Agent({id, name, role,
       tools, subagents, systemPrompt})         systemPrompt, handler})
     StateGraph 节点编排                 orchestrator + registry 手动路由
     agent.invoke({messages})            agent.run(ctx)
     subagents (task tool)               registry: psych.{id} / school.{id} / general
     tools: [tool({...schema})]          ontology.* + llm.chat
     middleware (planning/memory/...)    后续可扩展：todos / memory / skills
     streaming (typed events)            ui.onToken / ui.onRoute 回调

   两者都是 Node/Edge 运行时库。本仓库走"纯前端 ES Modules"路径，
   保留相同的抽象边界；若迁到 Vercel/Cloudflare Pages Functions，
   可直接把 handler 内部替换为 createDeepAgent 或 StateGraph，接口不变。
   ============================================================ */

export class Agent {
  constructor(spec) {
    if (!spec?.id || typeof spec.handler !== 'function') {
      throw new Error('Agent spec 需 id + handler');
    }
    this.id = spec.id;
    this.name = spec.name || spec.id;
    this.role = spec.role || 'agent';
    this.systemPrompt = spec.systemPrompt || '';
    this.handler = spec.handler;
  }

  async run(ctx) {
    return this.handler({ ...ctx, agent: this });
  }
}

/* ------------------------------------------------------------ */
/* Orchestrator —— 接收用户消息，路由到专家 Agent */
/* ------------------------------------------------------------ */

export async function orchestrator(ctx) {
  const { cfg, userText, history, ui, llm, ontology, registry } = ctx;

  // 1. 路由决策
  const decision = await decideRoute({ cfg, userText, history, llm, ontology });
  ui?.onRoute && ui.onRoute(decision);

  // 2. 解析目标
  const target = resolveTargetAgent(decision, registry);
  if (!target) {
    return {
      reply: '暂未识别到合适的专家。可以试试："什么是精神分析" / "帮我聊聊我的焦虑" / "弗洛伊德说了什么"。',
      meta: { routedTo: 'orchestrator', decision },
    };
  }

  // 3. 目标 Agent 回答
  const result = await target.run({ ...ctx, routeDecision: decision });
  result.meta = { ...result.meta, routedTo: target.id, decision };
  result.agent = target;
  return result;
}

/* ------------------------------------------------------------ */
/* 路由决策 */
/* ------------------------------------------------------------ */

async function decideRoute({ cfg, userText, history, llm, ontology }) {
  const text = String(userText || '');

  // LLM 路由
  if (cfg?.llm?.apiKey) {
    try {
      const { content } = await llm.chat({
        cfg,
        messages: [
          {
            role: 'system',
            content:
              '你是心理学 Agent 的路由器。根据用户输入，输出严格 JSON（不含 ```）：\n' +
              '{"intent":"learning|counseling|lookup|general",' +
              '"school_ids":["SCHxx"...],' +
              '"psychologist_ids":["PSYxxx"...],' +
              '"topics":[...],"reason":"一句话原因"}\n' +
              '编号规范：School=SCHxx(2位)、Psychologist=PSYxxx(3位)。不确定则空数组。',
          },
          ...(history || []).slice(-4).map(m => ({ role: m.role, content: m.content })),
          { role: 'user', content: text },
        ],
        temperature: 0,
      });
      const parsed = tryParseJson(content);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) {
      console.warn('[route] LLM 路由失败，回落规则：', e?.message);
    }
  }

  return ruleRoute(text);
}

function ruleRoute(text) {
  const t = String(text || '');
  const schools = [];
  const psychologists = [];
  let intent = 'general';

  if (/精神分析|精神决定|潜意识|弗洛伊德|荣格|客体关系|拉康/.test(t)) {
    schools.push('SCH01'); psychologists.push('PSY001', 'PSY002');
  }
  if (/行为主义|华生|斯金纳|巴甫洛夫|条件反射/.test(t)) {
    schools.push('SCH02'); psychologists.push('PSY003', 'PSY004', 'PSY005');
  }
  if (/人本主义|罗杰斯|马斯洛|自我实现|无条件积极/.test(t)) {
    schools.push('SCH03'); psychologists.push('PSY006', 'PSY007');
  }
  if (/认知行为|认知|贝克|艾利斯|CBT|思维模式|REBT/.test(t)) {
    schools.push('SCH04'); psychologists.push('PSY008', 'PSY009');
  }
  if (/存在主义|亚隆|意义|荒诞/.test(t)) {
    schools.push('SCH05'); psychologists.push('PSY010');
  }
  if (/家庭治疗|系统/.test(t)) schools.push('SCH07');
  if (/发展|埃里克森|依恋|皮亚杰|维果/.test(t)) {
    schools.push('SCH10'); psychologists.push('PSY011', 'PSY012', 'PSY013', 'PSY014');
  }
  if (/人格|大五|五因素/.test(t)) {
    schools.push('SCH11'); psychologists.push('PSY015', 'PSY016');
  }

  if (/焦虑|抑郁|悲伤|难过|失眠|崩溃|想死|自杀|自伤|痛苦|愤怒|嫉妒|依恋|想哭/.test(t)) {
    intent = 'counseling';
  } else if (/是什么|为什么|历史|发展|理论|学说|流派|学派|论文|著作|概念|思想/.test(t)) {
    intent = 'learning';
  } else if (/谁|哪位|是谁|哪个学派|哪个人/.test(t)) {
    intent = 'lookup';
  }

  return {
    intent,
    school_ids: [...new Set(schools)],
    psychologist_ids: [...new Set(psychologists)],
    topics: [],
    reason: '规则路由（LLM 未配置或失败）',
  };
}

function resolveTargetAgent(decision, registry) {
  for (const pid of decision.psychologist_ids || []) {
    const a = registry.get(`psych.${pid}`);
    if (a) return a;
  }
  for (const sid of decision.school_ids || []) {
    const a = registry.get(`school.${sid}`);
    if (a) return a;
  }
  return registry.get('general');
}

function tryParseJson(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const stripped = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(stripped); } catch { return null; }
}
