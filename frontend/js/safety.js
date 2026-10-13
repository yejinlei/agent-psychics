/* ============================================================
   safety.js —— 合规层：危机硬拦截 + 引用校验
   ------------------------------------------------------------
   两层守门：
     1) detectCrisis(text)  —— 用户输入进 LLM 之前的硬拦截
        命中高危关键词 → 不发 LLM、直接弹危机卡 + 温和回复
        （不依赖 prompt 里的"提醒"，防止模型忽视）
     2) sanitizeCitations(text) —— LLM 回复流出后的净化
        抽出 [THYxxx] 等引用编号，逐个查 ontology，
        未命中的编号替换为 🔍（视觉上明示"这条已被删除"）

   设计原则：
     - 硬拦截：宁可漏网 1 次，不能误判 100 次"研究/学术"语境。
       所以先做"研究语气"过滤，再做关键词命中。
     - 引用校验：宁可让用户看到"🔍 引用未验证"，也不让幻觉编号
       混进导出记录或长期记忆。
   ============================================================ */

import { objectById } from './ontology.js';

/* ------------------------------------------------------------ */
/* 1. 危机硬拦截                                                  */
/* ------------------------------------------------------------ */

// 高危：明确的自杀/自伤意图，不含研究语气
const HIGH_RISK_PATTERNS = [
  // 中文：明确自杀意图
  /自杀/, /自尽/, /自缢/, /自刎/, /上吊/, /跳楼/, /跳河/,
  /烧炭/, /割腕/, /割手/, /自残/,
  /吃药自杀/, /喝农药/, /服毒/,
  /不想活了/, /不想再活/, /不想活下去/, /不想存在了/,
  /活着没意思/, /活着没意义/,
  /想死/, /想把自己/, /结束自己的生命/,
  // 具体方式
  /从.{1,10}(楼|河|桥)/, /拿刀/,
  // 英文
  /\bsuicid/i, /\bsuicide\b/i,
  /\bslash(es|ing|ed)?\b/i,
  /\bslash my\b/i,
  /\bpun(kt|ct) myself\b/i,
  /\bend (it|my life|this)\b/i,
  /\bkill myself\b/i,
  /\bwant to die\b/i,
  /\bwant(ed)? to (commit suicide|die)\b/i,
  /\bwish(es)? (i|I) (was|were) dead\b/,
  /\bwish(es)? to be dead\b/,
  /\bno reason to live\b/,
];

// 研究语气白名单：命中任一即视为"学术研究"而非危机
const RESEARCH_GUARD = [
  // 问知识类
  /自杀.{0,6}(是什么|率|统计|数据|定义|概念|理论)/,
  /自杀率/,
  // 学术/职业引用
  /案例研究/, /论文/, /文献/, /研究/, /学.{0,4}理论/, /临床/,
  // 明确他人/新闻
  /(新闻|报道).{0,10}自杀/, /自杀.{0,10}(新闻|报道)/,
];

/**
 * 危机检测。返回 { level, reason, keywords } 或 null。
 *   level='high'   → 强制拦截，不发 LLM
 *   level='medium' → 温和提示（附在回复尾部），仍走 LLM
 *   null           → 无危机信号
 */
export function detectCrisis(text) {
  const t = String(text || '');
  if (!t) return null;

  // 先做研究语气过滤：命中即认为非危机
  if (RESEARCH_GUARD.some(re => re.test(t))) return null;

  const hitHigh = HIGH_RISK_PATTERNS.map((re, i) => [re, t.match(re)?.[0] || null])
    .filter(([, m]) => m);
  if (hitHigh.length) {
    return {
      level: 'high',
      reason: '命中高危关键词',
      keywords: hitHigh.map(([, m]) => m),
    };
  }

  return null;
}

/* ------------------------------------------------------------ */
/* 2. 危机卡 HTML（供拦截时直接注入）                              */
/* ------------------------------------------------------------ */

const HOTLINES = [
  { name: '全国统一心理援助', phone: '12356', region: '中国大陆' },
  { name: '北京心理援助热线', phone: '010-82951332', region: '北京' },
  { name: '希望 24 热线',     phone: '400-161-9995', region: '全国' },
  { name: 'Samaritans',       phone: '2896-0000',    region: '香港' },
  { name: 'Samaritans UK',    phone: '116 123',      region: '英国' },
  { name: '988 Lifeline',     phone: '988',          region: '美国' },
];

export function crisisCardHtml({ reason, onMoreClickId = 'crisis-more-btn' }) {
  const hotlineHtml = HOTLINES.slice(0, 5).map(h =>
    `<span class="cw-hot">
       <b>${h.phone}</b>
       <small>${h.region}·${h.name}</small>
     </span>`
  ).join('');
  return `
    <div class="crisis-intervene">
      <div class="ci-header">
        <span class="ci-icon">🛟</span>
        <span class="ci-title">先停一下 — 我在这里</span>
      </div>
      <div class="ci-body">
        ${reason
          ? `<div class="ci-reason"><b>为什么我拦住了这条消息？</b>你提到的字句让我判断你可能处于紧急状态。系统级安全协议优先于任何对话。</div>`
          : ''}
        <div class="ci-msg">
          此刻最重要的一件事：<b>找一个真人陪你</b>。你打出去的电话会被认真听完，不会被打断。
        </div>
        <div class="ci-hotlines">${hotlineHtml}</div>
        <div class="ci-actions">
          <button id="${onMoreClickId}" class="ci-btn-primary">查看全球热线列表</button>
          <button class="ci-btn-secondary" id="${onMoreClickId}-dismiss">我暂时安全</button>
        </div>
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------ */
/* 3. 引用校验                                                    */
/* ------------------------------------------------------------ */

// 匹配 [XXXnnn] 形式的引用编号；覆盖 ontology.TABLES 里所有已知前缀
const CITATION_RE = /\[([A-Z]{2,4}\d{2,6})\]/g;

// 允许的引用前缀（跟 ontology.js 的 TABLES 保持一致）
const VALID_PREFIXES = new Set([
  'SCH', 'PSY', 'THY', 'CPT', 'WRK', 'PAP', 'MTH', 'ASM',
  'TOP', 'ETH', 'EVT', 'INS', 'CRS',
]);

/**
 * 校验并净化 LLM 回复中的引用编号。
 *
 * @param {string} text LLM 返回的原始 markdown 文本
 * @returns {{
 *   display: string,          // 净化后可显示文本
 *   valid:   string[],        // 本体中真实存在的编号
 *   invalid: string[],        // 幻觉编号（未命中的）
 *   total:   number,          // 出现过的独立编号数
 * }}
 */
export function sanitizeCitations(text) {
  const s = String(text || '');
  if (!s) return { display: s, valid: [], invalid: [], total: 0 };

  const seen = new Set();
  const invalid = new Set();
  const valid = new Set();
  let m;
  while ((m = CITATION_RE.exec(s)) !== null) {
    seen.add(m[1]);
  }
  if (!seen.size) return { display: s, valid: [], invalid: [], total: 0 };

  // 逐个查 ontology
  for (const id of seen) {
    // 过滤掉明显不在体系里的编号（比如 [ABC123] 之类）
    const prefix = id.replace(/\d+$/, '');
    if (!VALID_PREFIXES.has(prefix)) {
      invalid.add(id);
      continue;
    }
    const obj = objectById(id);
    if (obj && obj.row) valid.add(id);
    else invalid.add(id);
  }

  // 替换文本：无效编号 → 🔍 未验证（保留可辨识形）
  const display = s.replace(CITATION_RE, (raw, id) =>
    valid.has(id) ? `[${id}]` : `[🔍 ${id}]`
  );

  return {
    display,
    valid: [...valid],
    invalid: [...invalid],
    total: seen.size,
  };
}

/**
 * 生成一条"引用校验状态"徽章 HTML（可空）。
 * @returns {string} 空字符串表示无引用或全部有效
 */
export function citationBadgeHtml(sanitized) {
  if (!sanitized || sanitized.total === 0) return '';
  const { valid, invalid, total } = sanitized;
  if (invalid.length === 0) {
    return `<span class="cite-badge cite-badge-ok" title="所有引用编号在本体中存在">✓ ${valid.length}/${total} 引用已核验</span>`;
  }
  return `<span class="cite-badge cite-badge-warn" title="以下编号在本体中不存在：${invalid.join('、')}" >⚠ ${valid.length}/${total} 有效 · ${invalid.length} 已标记</span>`;
}
