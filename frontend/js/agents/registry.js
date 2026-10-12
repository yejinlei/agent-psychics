/* ============================================================
   registry.js —— Agent 注册表 + 模板工厂
   - general:        通用心理学专家（心理支持 + 学习引导）
   - school.{id}:    学派专家（如精神分析、CBT…）
   - psych.{id}:     具体心理学家专家（弗洛伊德、罗杰斯…）
   每个 Agent 都能查本体 + 调 LLM。
   ============================================================ */

import { Agent } from '../agent.js';
import { chat } from '../llm.js';
import { HLT_PROMPT_TAIL } from '../hlt.js';
import {
  loadOntology, objectById, psychologistById, schoolById,
  psychologistsOfSchool, neighbors, search, authorFootprint,
} from '../ontology.js';

/** 注册表：id → Agent 实例 */
const REGISTRY = new Map();

export function get(id) { return REGISTRY.get(id); }
export function all() { return [...REGISTRY.values()]; }
export function list() { return REGISTRY; }

export async function initRegistry() {
  await loadOntology();
  // 通用专家
  REGISTRY.set('general', new GeneralExpert());
  // 各学派专家
  for (const s of (await import('../ontology.js')).listSchools()) {
    REGISTRY.set(`school.${s.id}`, new SchoolExpert(s));
  }
  // 各心理学家专家
  for (const p of (await import('../ontology.js')).listPsychologists()) {
    REGISTRY.set(`psych.${p.id}`, new PsychologistExpert(p));
  }
  return REGISTRY;
}

/* ============================================================ */
/* 工具函数：把当前 ctx 转成可供 handler 使用的助手 */
/* ============================================================ */

function buildCtxHelper(ctx) {
  return {
    cfg: ctx.cfg,
    history: ctx.history,
    userText: ctx.userText,
    ui: ctx.ui,
    signal: ctx.signal,
    llm: { chat },
    ontology: {
      objectById, psychologistById, schoolById, psychologistsOfSchool, neighbors, search, authorFootprint,
    },
    registry: REGISTRY,
  };
}

/* ============================================================ */
/* 工具函数：让 LLM 基于本体片段回答 */
/* ============================================================ */

async function llmAnswer({ agent, cfg, userText, ontologySnippet, history = [], onDelta, onReasoning, signal }) {
  const messages = [
    { role: 'system', content: agent.systemPrompt },
    ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
    {
      role: 'system',
      content: '【知识快照，回答必须基于此，不可编造；凡引用具体对象用 [THYxxx]/[CPTxxx]/[WRKxxx]/[MTHxxx]/[ASMxxx]/[PAPxxx]/[SCHxx]/[PSYxxx] 格式标注】\n' + ontologySnippet,
    },
    { role: 'user', content: userText },
  ];
  return await chat({ cfg, messages, onDelta, onReasoning, temperature: 0.4, maxTokens: 4000, signal });
}

/* ============================================================ */
/* General Expert —— 通用心理学专家 */
/* ============================================================ */

class GeneralExpert extends Agent {
  constructor() {
    super({
      id: 'general',
      name: '通用心理学专家',
      role: 'general',
      systemPrompt:
        '你是"Psychics"心理 Agent 的通用专家，融合主流流派的核心观点，兼顾学术严谨与人文关怀。\n' +
        '原则：\n' +
        '1) 遇到自伤/自杀/急性危机，先做情绪稳定与安全评估，并明确建议寻求当地专业帮助或危机热线；\n' +
        '2) 明确区分"事实/流派观点/个人判断"，绝不将心理学概念当医学诊断；\n' +
        '3) 给出可执行建议时注明流派出处（如"人本主义视角…"）；\n' +
        '4) 用中文回答，术语首次出现给英文；\n' +
        '5) 结尾给一句温和的支持性话语。' +
        HLT_PROMPT_TAIL,
      handler: async (ctx) => {
      const { cfg, userText, history, ui, signal } = buildCtxHelper(ctx);
      const related = ctx.ontology.search(userText, { limit: 10 });
      const snippet = buildSnippet(related, 'general');
      const r = await llmAnswer({
        agent: this, cfg, userText,
        ontologySnippet: snippet, history, signal,
        onDelta: (d, full) => ui?.onToken?.(d, full),
        onReasoning: (d, full) => ui?.onReasoning?.(d, full),
      });
      return { reply: r.content, meta: { routedTo: 'general' } };
    },
    });
  }
}

/* ============================================================ */
/* School Expert —— 学派专家 */
/* ============================================================ */

class SchoolExpert extends Agent {
  constructor(schoolRow) {
    super({
      id: `school.${schoolRow.id}`,
      name: `${schoolRow.name_zh || schoolRow.name_en || schoolRow.id} 学派`,
      role: 'school',
      systemPrompt: buildSchoolPrompt(schoolRow),
      handler: async (ctx) => {
        const { cfg, userText, history, ui, signal } = buildCtxHelper(ctx);
        const members = psychologistsOfSchool(schoolRow.id);
        const theories = ctx.ontology.search(userText, { limit: 8 });
        const snippet = buildSnippet(theories, 'school', { schoolRow, members });
        const r = await llmAnswer({
          agent: this, cfg, userText,
          ontologySnippet: snippet, history, signal,
          onDelta: (d, full) => ui?.onToken?.(d, full),
          onReasoning: (d, full) => ui?.onReasoning?.(d, full),
        });
        return { reply: r.content, meta: { routedTo: this.id, school: schoolRow.id } };
      },
    });
  }
}

function buildSchoolPrompt(s) {
  const names = [s.name_zh, s.name_en].filter(Boolean).join(' / ');
  const range = s.flourished_start ? `${s.flourished_start}-${s.flourished_end || '?'}` : '';
  const founders = (s.founders || '').match(/PSY\d+/g) || [];
  return (
    `你是心理学中「${names}」学派的专家。\n` +
    `活跃时期：${range}\n` +
    `创始人：${founders.join(', ')}\n` +
    `代表著作/理论关键词：${(s.aliases || '').slice(0, 200)}\n\n` +
    `回答时：\n` +
    `1) 严格从该学派视角出发，不越界；\n` +
    `2) 引用具体理论/概念时给出中文名+英文术语；\n` +
    `3) 遇到跨学派问题，说明"本学派视角如下，其他流派可另询"；\n` +
    `4) 危机干预与安全评估优先。` +
    HLT_PROMPT_TAIL
  );
}

/* ============================================================ */
/* Psychologist Expert —— 具体心理学家专家 */
/* ================================================= */

class PsychologistExpert extends Agent {
  constructor(p) {
    super({
      id: `psych.${p.id}`,
      name: `${p.name_zh || p.name_en || p.id}`,
      role: 'psych',
      systemPrompt: buildPsychPrompt(p),
      handler: async (ctx) => {
        const { cfg, userText, history, ui, signal } = buildCtxHelper(ctx);
        // 3 跳创作足迹（替代旧的一跳 neighbors）
        const footprint = authorFootprint(p.id, { maxPer: 6 });
        // 同时用用户 query 再做一次关键词命中，避免遗漏跨领域关联
        const kwHits = ctx.ontology.search(userText, { limit: 6 });
        const snippet = buildFootprintSnippet(footprint, p, kwHits);
        const r = await llmAnswer({
          agent: this, cfg, userText,
          ontologySnippet: snippet, history, signal,
          onDelta: (d, full) => ui?.onToken?.(d, full),
          onReasoning: (d, full) => ui?.onReasoning?.(d, full),
        });
        return { reply: r.content, meta: { routedTo: this.id, psychologist: p.id } };
      },
    });
  }
}

function buildPsychPrompt(p) {
  const affIds = (p.affiliation || '').match(/SCH\d+/g) || [];
  const mentors = (p.mentor_ids || '').match(/PSY\d+/g) || [];
  const fields = (p.active_field || '').match(/TOP\d+/g) || [];

  // 把 SCH/PSY/TOP id 展平成"名字 (ID)"，避免模型看到裸 ID 一脸懵
  const affStr = affIds.map(id => {
    const s = schoolById(id);
    return s ? `${s.name_zh} (${id})` : id;
  }).join('、');
  const mentorStr = mentors.map(id => {
    const m = psychologistById(id);
    return m ? `${m.name_zh} (${id})` : id;
  }).join('、') || '（未记录）';
  const fieldStr = fields.join('、') || '（未记录）';

  return (
    `你正在模拟/解读心理学家「${p.name_zh}」(${p.name_en || ''}) 的思想。\n` +
    `生卒：${p.life_span_text || (p.birth_year ? `${p.birth_year}–${p.death_year || '?'}` : '?')}\n` +
    `学派归属：${affStr || '（未记录）'}\n` +
    `师承：${mentorStr}\n` +
    `研究领域：${fieldStr}\n` +
    `生平简介：${(p.bio_zh || '').slice(0, 400)}\n\n` +
    `【引用规范·必须严格遵守】\n` +
    `回答中若涉及任何具体理论/概念/著作/方法/量表/论文/学派，\n` +
    `必须在该对象中文名或术语后**紧跟**方括号形式的编号引用，格式为 [THY001]、[CPT015]、[WRK003]、[MTH008]、[ASM001]、[PAP012]、[SCH03]、[PSY008]。\n` +
    `示例：\n` +
    `  · 荣格提出的"集体无意识" [CPT030] 概念，源自《荣格全集》系列著作 [WRK015]。\n` +
    `  · 艾利斯理性情绪行为疗法 [MTH018] 建立在其 ABC 情绪理论 [THY041] 之上。\n` +
    `规则：\n` +
    `  1) 引用编号必须来自下方"知识快照"中真实存在的条目，**禁止编造不存在的编号**；\n` +
    `  2) 同一段落可多次引用不同对象；\n` +
    `  3) 若某条回答完全无引用可依托，说明知识快照信息不足，需诚实告知；\n` +
    `  4) 不要以"根据本体"或"参考知识库"这类元表述开头，直接以引用形式融入自然语句。\n\n` +
    `【回答原则】\n` +
    `1) 忠实于该心理学家的历史思想，不越出此人已知框架；\n` +
    `2) 涉及临床应用时提醒"该观点需结合现代循证"；\n` +
    `3) 危机/伦理问题优先，不因角色扮演而失守；\n` +
    `4) 用中文回答，术语首次出现给英文。` +
    HLT_PROMPT_TAIL
  );
}

/* ============================================================ */
/* Snippet 构建：把命中对象渲染为可读 JSON-ish 文本 */
/* ============================================================ */

function buildSnippet(hits, mode, extra = {}) {
  const parts = [];
  if (extra.schoolRow) parts.push(renderRow(extra.schoolRow));
  if (extra.psychologist) parts.push(renderRow(extra.psychologist));
  if (extra.members) {
    parts.push('### 该学派成员（心理学家人物）');
    for (const m of extra.members.slice(0, 12)) parts.push(`- ${m.id}: ${m.name_zh} (${m.name_en}) — ${(m.bio_zh || '').slice(0, 120)}`);
  }
  if (extra.related) {
    parts.push('### 关联对象（一跳）');
    for (const r of extra.related.slice(0, 15)) {
      const o = objectById(r.id);
      if (o) parts.push(`- [${o.type}] ${o.row.id}: ${o.row.name_zh || o.row.title_zh || o.row.id} via ${r.via}`);
    }
  }
  if (hits?.length) {
    parts.push('### 命中对象');
    for (const h of hits) parts.push(renderRow(h.row, h.type));
  }
  if (!parts.length) {
    parts.push('（未从本体命中相关对象，请基于通识知识谨慎回答，并提示用户可查更明确的学派/人物）');
  }
  return parts.join('\n');
}

function renderRow(row, typeHint) {
  if (!row) return '';
  const keep = ['id', 'name_zh', 'name_en', 'title_zh', 'title_en', 'kind', 'school_ids', 'school_id', 'author_ids', 'work_ids', 'paper_ids', 'concept_ids', 'theories', 'flourished_start', 'flourished_end', 'founders', 'affiliation', 'bio_zh', 'summary_zh', 'narrative', 'year', 'year_first', 'origin_year', 'birth_year', 'death_year', 'life_span_text', 'aliases', 'mentor_ids', 'active_field', 'target_topics', 'topic_ids', 'method_ids', 'assessment_ids', 'citation_count_approx'];
  const pick = {};
  for (const k of keep) if (row[k] !== undefined && row[k] !== '') pick[k] = row[k];
  const prefix = typeHint ? `[${typeHint}] ` : '';
  return `${prefix}\`${pick.id || row.id}\`: ${JSON.stringify(pick).slice(0, 900)}`;
}

/* ============================================================
   buildFootprintSnippet —— 心理学家的"创作足迹"结构化快照
   把 authorFootprint() 的 8 组数据按角色/类型分节渲染，
   让模型一眼看清"这个人做了什么、说了什么、留下了什么"。
   ============================================================ */
function buildFootprintSnippet(fp, psychologist, kwHits) {
  if (!fp) {
    return buildSnippet(kwHits, 'psych', { psychologist });
  }

  const parts = [];

  // --- 头图：本人 ---
  parts.push(`### ${fp.psychologist.name_zh} (${fp.psychologist.name_en || fp.psychologist.id}) [${fp.psychologist.id}]`);
  const life = fp.psychologist.life_span_text || '?';
  const nat = [fp.psychologist.nationality, fp.psychologist.region].filter(Boolean).join('/');
  parts.push(`- 生卒: ${life}  |  国籍/地区: ${nat}`);
  if (fp.psychologist.bio_zh) parts.push(`- 生平: ${fp.psychologist.bio_zh.slice(0, 500)}`);

  // --- 学派 ---
  if (fp.schools?.length) {
    parts.push('');
    parts.push('### 所属学派');
    for (const s of fp.schools) {
      parts.push(`- [${s.id}] ${s.name_zh} (${s.name_en || ''}) — ${(s.one_liner_zh || '').slice(0, 120)}`);
    }
  }

  // --- 主要著作 ---
  if (fp.works?.length) {
    parts.push('');
    parts.push('### 主要著作（引用时标注 [WRKxxx]）');
    for (const w of fp.works) {
      const yr = w.year || '';
      parts.push(`- [${w.id}] 《${w.title_zh}》 ${w.title_en ? `(${w.title_en})` : ''} ${yr} — ${(w.note || '').slice(0, 140)}`);
    }
  }

  // --- 核心理论（最关键的引用来源）---
  if (fp.theories?.length) {
    parts.push('');
    parts.push('### 核心理论（引用时标注 [THYxxx]）');
    for (const t of fp.theories) {
      parts.push(`- [${t.id}] ${t.name_zh} ${t.name_en ? `(${t.name_en})` : ''} ${t.year || ''}`);
      if (t.summary_zh) parts.push(`  · 概要: ${t.summary_zh.slice(0, 260)}`);
      if (t.core_claim_zh) parts.push(`  · 核心主张: ${t.core_claim_zh.slice(0, 200)}`);
      if (t.applicability) parts.push(`  · 适用: ${t.applicability}`);
      if (t.stance_on_mind) parts.push(`  · 心灵立场: ${t.stance_on_mind}`);
    }
  }

  // --- 关键概念 ---
  if (fp.concepts?.length) {
    parts.push('');
    parts.push('### 关键概念（引用时标注 [CPTxxx]）');
    for (const c of fp.concepts) {
      parts.push(`- [${c.id}] ${c.name_zh} ${c.name_en ? `(${c.name_en})` : ''} — kind: ${c.kind || ''}`);
      if (c.definition_zh) parts.push(`  · 定义: ${c.definition_zh.slice(0, 240)}`);
      if (c.example_zh) parts.push(`  · 示例: ${c.example_zh.slice(0, 120)}`);
    }
  }

  // --- 治疗方法 ---
  if (fp.methods?.length) {
    parts.push('');
    parts.push('### 治疗方法/技术（引用时标注 [MTHxxx]）');
    for (const m of fp.methods) {
      parts.push(`- [${m.id}] ${m.name_zh} ${m.name_en ? `(${m.name_en})` : ''} ${m.year || ''} — kind: ${m.kind || ''}`);
      if (m.description_zh) parts.push(`  · 说明: ${m.description_zh.slice(0, 200)}`);
      if (m.applicable_ages) parts.push(`  · 适用年龄: ${m.applicable_ages}`);
      if (m.evidence_level) parts.push(`  · 证据等级: ${m.evidence_level}`);
    }
  }

  // --- 量表 / 论文（次要但常问到） ---
  if (fp.assessments?.length) {
    parts.push('');
    parts.push('### 量表/测评（引用时标注 [ASMxxx]）');
    for (const a of fp.assessments) {
      parts.push(`- [${a.id}] ${a.name_zh} ${a.abbr ? `(${a.abbr})` : ''} ${a.year || ''} — ${(a.note || '').slice(0, 120)}`);
    }
  }
  if (fp.papers?.length) {
    parts.push('');
    parts.push('### 代表论文（引用时标注 [PAPxxx]）');
    for (const pa of fp.papers.slice(0, 4)) {
      parts.push(`- [${pa.id}] 《${pa.title_zh}》 ${pa.year || ''} ${pa.journal ? `· ${pa.journal}` : ''}`);
    }
  }

  // --- 用户关键词命中（可能跨出本人范围）---
  if (kwHits?.length) {
    parts.push('');
    parts.push('### 用户问题命中的相关对象（可能是他人的，谨慎引用）');
    for (const h of kwHits) {
      const r = h.row;
      const label = r.name_zh || r.title_zh || r.id;
      const labelEn = r.name_en || r.title_en || '';
      parts.push(`- [${r.id}] ${label} ${labelEn ? `(${labelEn})` : ''} — ${(r.summary_zh || r.bio_zh || r.note || '').slice(0, 160)}`);
    }
  }

  if (!fp.works?.length && !fp.theories?.length && !fp.concepts?.length && !fp.methods?.length) {
    parts.push('');
    parts.push('（本体的创作足迹较薄，回答时可基于 bio_zh 谨慎展开，但仍须遵守引用规范）');
  }

  return parts.join('\n');
}
