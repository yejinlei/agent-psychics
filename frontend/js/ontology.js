/* ============================================================
   ontology.js —— 纯前端本体索引
   直接 fetch `../backend/data/*.csv`，用纯 JS CSV 解析器解析，
   构建对象图 + 名称索引。GH Pages 部署时可把 CSV 复制到站点根目录。
   ============================================================ */

const DATA_BASE = '../backend/data';
const TABLES = [
  { key: 'schools',       file: 'schools.csv',       idPrefix: 'SCH' },
  { key: 'psychologists', file: 'psychologists.csv', idPrefix: 'PSY' },
  { key: 'theories',      file: 'theories.csv',      idPrefix: 'THY' },
  { key: 'concepts',      file: 'concepts.csv',      idPrefix: 'CPT' },
  { key: 'works',         file: 'works.csv',         idPrefix: 'WRK' },
  { key: 'papers',        file: 'papers.csv',        idPrefix: 'PAP' },
  { key: 'methods',       file: 'methods.csv',       idPrefix: 'MTH' },
  { key: 'assessments',   file: 'assessments.csv',   idPrefix: 'ASM' },
  { key: 'topics',        file: 'topics.csv',        idPrefix: 'TOP' },
  { key: 'ethics',        file: 'ethics.csv',        idPrefix: 'ETH' },
  { key: 'events',        file: 'events.csv',        idPrefix: 'EVT' },
  { key: 'institutions',  file: 'institutions.csv',  idPrefix: 'INS' },
  { key: 'nations',       file: 'nations.csv',       idPrefix: 'N' },
];

let _DB = null;   // {schools:[], psychologists:[], ...}
let _BY_ID = null; // Map<id, {type, row}>
let _NAME_IDX = null;

export function loadOntology() {
  if (_DB) return _DB;
  return init();
}

async function init() {
  _DB = {}; _BY_ID = new Map(); _NAME_IDX = new Map();
  for (const t of TABLES) {
    try {
      const text = await fetch(`${DATA_BASE}/${t.file}`).then(r => r.ok ? r.text() : null);
      if (!text) { _DB[t.key] = []; continue; }
      const rows = parseCSV(text);
      _DB[t.key] = rows;
      for (const row of rows) {
        if (row.id) {
          _BY_ID.set(row.id, { type: t.key, row });
          for (const nameKey of ['name_zh', 'name_en', 'title_zh', 'title_en']) {
            if (row[nameKey]) {
              const k = normKey(row[nameKey]);
              if (!k) continue;
              if (!_NAME_IDX.has(k)) _NAME_IDX.set(k, []);
              _NAME_IDX.get(k).push(row.id);
            }
          }
          // aliases
          if (row.aliases) {
            for (const a of splitList(row.aliases)) {
              const k = normKey(a);
              if (!k) continue;
              if (!_NAME_IDX.has(k)) _NAME_IDX.set(k, []);
              _NAME_IDX.get(k).push(row.id);
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[ontology] 加载 ${t.file} 失败:`, e);
      _DB[t.key] = [];
    }
  }
  return _DB;
}

export function objectById(id) {
  return _BY_ID?.get(id) || null;
}

export function resolveByName(name) {
  const k = normKey(name);
  if (!k) return [];
  return _NAME_IDX?.get(k) || [];
}

export function search(query, { limit = 20, types = null } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const k = normKey(q);
  const results = [];
  const walk = (id) => {
    const obj = _BY_ID.get(id);
    if (!obj) return;
    if (types && !types.includes(obj.type)) return;
    const row = obj.row;
    const text = [row.name_zh, row.name_en, row.title_zh, row.title_en, row.kind, row.role_zh, row.school_ids, row.school_id].filter(Boolean).join(' ');
    if (normKey(text).includes(k) || normKey(text).includes(q)) {
      results.push(obj);
    }
  };
  for (const [id] of _BY_ID) walk(id);
  // 名称精确命中优先
  const exact = (results).filter(r => _NAME_IDX.get(k)?.includes(r.row.id));
  return [...exact, ...results.filter(r => !exact.includes(r))].slice(0, limit);
}

/** 展开对象的所有引用（一跳），返回 {type, id} 列表 */
export function neighbors(id, { depth = 1 } = {}) {
  const obj = _BY_ID.get(id);
  if (!obj) return [];
  const row = obj.row;
  const out = [];
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string' && /(ids|id|related|about_ids|target_topics|claimant_ids|counter_claim_ids)/.test(k)) {
      for (const ref of splitList(v)) {
        if (ref && _BY_ID.has(ref) && ref !== id) {
          out.push({ type: _BY_ID.get(ref).type, id: ref, via: k });
        }
      }
    }
  }
  return out;
}

export function schoolById(id) {
  const o = _BY_ID.get(id);
  return o?.type === 'schools' ? o.row : null;
}
export function psychologistById(id) {
  const o = _BY_ID.get(id);
  return o?.type === 'psychologists' ? o.row : null;
}

/* ============================================================
   authorFootprint(psyId) —— 心理学家"创作足迹" 3 跳图遍历
   ------------------------------------------------------------
   从 author_ids / affiliation 出发，沿语义强边收集：
     - works:              author_ids=psyId（1 跳）
     - theories:           author_ids=psyId（1 跳）
     - concepts:           该心理学家的 theory_ids → concept_ids（2 跳）
     - methods:            author_ids=psyId ∪ 理论的 theory_ids（2 跳）
     - assessments:        author_ids=psyId（1 跳）
     - papers:             author_ids=psyId（1 跳）
     - schools:            affiliation 直接引用 + 理论所属学派
   每类独立去重 + 截断，返回分组结构，供 buildSnippet 结构化渲染。
   ============================================================ */
export function authorFootprint(psyId, { maxPer = 5 } = {}) {
  const p = psychologistById(psyId);
  if (!p) return null;

  const works = (_DB?.works || []).filter(r => r.author_ids && splitList(r.author_ids).includes(psyId));
  const theories = (_DB?.theories || []).filter(r => r.author_ids && splitList(r.author_ids).includes(psyId));
  const theoryIds = theories.map(t => t.id);

  // concepts：作者直挂 author_ids，或挂在本人理论上
  const concepts = (_DB?.concepts || []).filter(r =>
    (r.author_ids && splitList(r.author_ids).includes(psyId)) ||
    (r.theory_ids && splitList(r.theory_ids).some(id => theoryIds.includes(id)))
  );

  // methods：作者直挂或挂在本人理论上
  const methods = (_DB?.methods || []).filter(r =>
    (r.author_ids && splitList(r.author_ids).includes(psyId)) ||
    (r.theory_ids && splitList(r.theory_ids).some(id => theoryIds.includes(id)))
  );

  const assessments = (_DB?.assessments || []).filter(r => r.author_ids && splitList(r.author_ids).includes(psyId));
  const papers = (_DB?.papers || []).filter(r => r.author_ids && splitList(r.author_ids).includes(psyId));

  // 学派：affiliation + 理论的 school_ids 合并
  const schoolSet = new Set();
  for (const id of splitList(p.affiliation)) if (/^SCH\d+/.test(id)) schoolSet.add(id);
  for (const t of theories) for (const id of splitList(t.school_ids)) if (/^SCH\d+/.test(id)) schoolSet.add(id);

  return {
    psychologist: p,
    works: works.slice(0, maxPer),
    theories: theories.slice(0, maxPer),
    concepts: concepts.slice(0, maxPer),
    methods: methods.slice(0, maxPer),
    assessments: assessments.slice(0, maxPer),
    papers: papers.slice(0, maxPer),
    schools: [...schoolSet].map(id => schoolById(id)).filter(Boolean),
  };
}

/** 列出所有学派/心理学家（用于路由） */
export function listSchools() { return _DB?.schools || []; }
export function listPsychologists() { return _DB?.psychologists || []; }

/** 按学派 id 找出所有相关心理学家 */
export function psychologistsOfSchool(schoolId) {
  return (_DB?.psychologists || []).filter(p => {
    const aff = splitList(p.affiliation || '');
    return aff.includes(schoolId) || (p.school_ids && splitList(p.school_ids).includes(schoolId));
  });
}

/* ------------------- 工具函数 ------------------- */

function normKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[\s·.．・\-—_()（）]/g, '');
}

function splitList(s) {
  if (!s) return [];
  const t = String(s).trim();
  if (t.startsWith('[') && t.endsWith(']')) {
    return t.slice(1, -1).split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return t.split(/[;,|]/).map(x => x.trim()).filter(Boolean);
}

/* ------------------- 纯 JS CSV 解析（支持 quoted fields） ------------------- */

function parseCSV(text) {
  // 去 BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  if (!rows.length) return [];
  const header = rows.shift();
  return rows
    .filter(r => r.some(x => x !== ''))
    .map(r => {
      const obj = {};
      header.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
      return obj;
    });
}
