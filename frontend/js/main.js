/* ============================================================
   main.js —— 应用入口
   1. 加载本体 CSV
   2. 初始化 Agent 注册表
   3. 渲染左侧学习/研究面板
   4. 对话循环：用户输入（文字/语音）→ orchestrator → 专家 → 输出（文字/TTS）
   ============================================================ */

import { loadConfig, saveConfig, clearConfig, applyPreset, isLlmConfigured } from './config.js';
import { chat, testLlm } from './llm.js';
import { startRecording, transcribe, stopAudio } from './asr.js';
import { speak, stop as stopSpeak } from './tts.js';
import {
  loadOntology, search as ontSearch, objectById, psychologistsOfSchool, neighbors,
  listPsychologists, psychologistById, schoolById, listSchools,
} from './ontology.js';
import { orchestrator } from './agent.js';
import { bindCqItems, bindDialogs, setCfgRef, openInfoDialog, openCrisisList } from './tools.js';
import { initRegistry, get as agentGet } from './agents/registry.js';
import * as memory from './memory.js';
import * as ui from './ui.js';
import * as counselor from './counselor.js';
import { runConductor, CONDUCTOR_NAME, CONDUCTOR_EN } from './conductor.js';
import * as hlt from './hlt.js';
import { detectCrisis, crisisCardHtml, sanitizeCitations, citationBadgeHtml } from './safety.js';

let cfg = loadConfig();
let REGISTRY = null;
let busy = false;
let currentRecording = null;
// 当前锁定的心理学家 agent（null 时走默认编排者流程；也可能是 COUNSELOR_MODE 对象）
let lockedPsych = null;
// 编排者的对话历史（self 分支会用到；专家/counselor 分支不写）
let conductorHistory = [];
// 每个锁定 agent 独立的对话历史（切换 agent 时重置）
let lockedHistory = [];

// ========= Day1: 豆包式交互 - 打断 + 队列 =========
let activeTurn = null;      // {abort: AbortController, startedAt: number}
let inputQueue = [];        // 排队中的用户消息（默认上限 1 条）
let lastShell = null;       // 当前回合的 shell 引用（打断时标记"已停止"）
const MAX_QUEUE = 1;        // 队列深度上限，防止用户误连发

// ========= Day2: 记忆持久化 + @命令 =========
const K_CONDUCTOR_HIST = 'psychics.conductor_history.v1';
const K_LOCKED_AGENT   = 'psychics.locked_agent.v1';
const K_LOCKED_HIST    = 'psychics.locked_history_by_agent.v1';
// counselor 锁定态用一个不可序列化的 marker，restore 时重建
const COUNSELOR_MODE = { __isCounselor: true, id: 'counselor', name: '咨询师', role: 'conductor' };

function persistChatState() {
  try {
    localStorage.setItem(K_CONDUCTOR_HIST, JSON.stringify(conductorHistory));
    if (lockedPsych && lockedPsych.__isCounselor) {
      localStorage.setItem(K_LOCKED_AGENT, 'counselor');
    } else if (lockedPsych) {
      localStorage.setItem(K_LOCKED_AGENT, lockedPsych.id);
    } else {
      localStorage.removeItem(K_LOCKED_AGENT);
    }
    // 只持久化心理学家/学派 agent 的历史；咨询师历史由 counselor.case 自己管
    if (lockedPsych && !lockedPsych.__isCounselor) {
      localStorage.setItem(K_LOCKED_HIST, JSON.stringify(lockedHistory));
    } else {
      localStorage.removeItem(K_LOCKED_HIST);
    }
  } catch (_) {}
}

function restoreChatState() {
  try {
    const ch = localStorage.getItem(K_CONDUCTOR_HIST);
    if (ch) conductorHistory = JSON.parse(ch) || [];
    const lh = localStorage.getItem(K_LOCKED_HIST);
    if (lh) lockedHistory = JSON.parse(lh) || [];
    const la = localStorage.getItem(K_LOCKED_AGENT);
    if (la === 'counselor') {
      lockedPsych = COUNSELOR_MODE;
    } else if (la) {
      lockedPsych = REGISTRY?.get(la) || null;
    }
    if (lockedPsych) renderLockedChip(lockedPsych);
  } catch (e) { console.warn('[main] restoreChatState failed', e); }
}

/** 裁剪 + 持久化 conductorHistory（避免让 conductorHistory 局部引用被 slice 替换而脱钩） */
function trimAndPersistConductor() {
  if (conductorHistory.length > 20) {
    conductorHistory.splice(0, conductorHistory.length - 20);
  }
  persistChatState();
}

/** 裁剪 + 持久化 lockedHistory（同上） */
function trimAndPersistLocked() {
  if (lockedHistory.length > 20) {
    lockedHistory.splice(0, lockedHistory.length - 20);
  }
  persistChatState();
}

/** 解析行首/文本中的 @命令：@counselor / @<人名> / @<学派名>。返回 {agent|null, text} */
function parseInlineAtMention(rawText) {
  const t = String(rawText || '').trim();
  if (!t) return null;

  // 1) @counselor / @咨询师 / @心理咨询 / @咨询
  if (/^@(counselor|咨询师|心理咨询|咨询)(?:\s|$)/i.test(t)) {
    const m = t.match(/^@(?:counselor|咨询师|心理咨询|咨询)\s*/i);
    return { agent: COUNSELOR_MODE, text: t.slice(m[0].length), mode: 'counselor' };
  }

  // 2) 尝试匹配心理学家名（中文名或英文名）
  const m = t.match(/^@([^\s,，。！？!?：:（(]{1,40})\s*(.*)$/);
  if (!m) return null;
  const token = m[1];
  const rest = (m[2] || '').trim();

  const p = listPsychologists().find(x =>
    (x.name_zh || '').includes(token) || (x.name_en || '').toLowerCase().includes(token.toLowerCase())
  );
  if (p) return { agent: REGISTRY.get(`psych.${p.id}`), text: rest || '你好，我们聊聊。', mode: 'psych', targetId: p.id };

  const s = listSchools().find(x =>
    (x.name_zh || '').includes(token) || (x.name_en || '').toLowerCase().includes(token.toLowerCase())
  );
  if (s) return { agent: REGISTRY.get(`school.${s.id}`), text: rest || '你好，我们聊聊。', mode: 'school', targetId: s.id };

  return null;
}

init();

async function init() {
  // 1. 加载本体
  const t0 = performance.now();
  await loadOntology();
  const dt = (performance.now() - t0).toFixed(0);
  console.log(`[main] 本体加载完成，${dt}ms`);

  // 2. 初始化 Agent 注册表
  REGISTRY = await initRegistry();
  console.log(`[main] 注册 ${REGISTRY.size} 个 Agent`);

  // 3. UI 绑定 + 学习面板
  bindUI();
  renderLearningPanel();
  // 3b. 咨询工具入口（.cq-item）+ 弹窗按钮
  setCfgRef(cfg);
  bindCqItems();
  bindDialogs();

  // 4. 状态显示
  updateStatus();

  // 5. 载入/初始化咨询案例 + 恢复历史消息
  const caseObj = counselor.getCurrentCaseOrNew();
  renderStageBar(caseObj);
  renderCaseHistory(caseObj);

  // 6. 恢复对话持久化状态（conductorHistory / lockedPsych / lockedHistory）
  restoreChatState();

  // 7. 设置弹窗默认值
  syncConfigForm();

  // 8. 首次访问：自动弹出免责声明
  const K_DISCLAIMER_SEEN = 'psychics.disclaimer_seen.v1';
  try {
    if (!localStorage.getItem(K_DISCLAIMER_SEEN)) {
      setTimeout(() => {
        openInfoDialog();
        localStorage.setItem(K_DISCLAIMER_SEEN, new Date().toISOString());
      }, 600);
    }
  } catch (_) {}
}

/* ============================================================ */
/* UI 绑定 */
/* ============================================================ */

function bindUI() {
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('btn-send');
  const micBtn = document.getElementById('btn-mic');
  const settingsBtn = document.getElementById('btn-settings');
  const dlg = document.getElementById('dlg-settings');

  // 发送 / 停止（豆包式：busy 时按钮变停止按钮）
  sendBtn.onclick = () => {
    if (busy && activeTurn) stopCurrentTurn();
    else submit();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    // Esc 关闭 @ popover
    if (e.key === 'Escape') closeMentionPopover();
    // 用户手动输入 @ 打开 popover
    if (e.key === '@') {
      const pop = document.getElementById('mention-popover');
      if (pop && pop.hasAttribute('hidden')) setTimeout(() => toggleMentionPopover(true), 0);
    }
  });

  // @ popover
  document.getElementById('btn-mention')?.addEventListener('click', () => toggleMentionPopover());
  document.getElementById('btn-mp-close')?.addEventListener('click', () => closeMentionPopover());
  const mpFilter = document.getElementById('mp-filter');
  if (mpFilter) {
    let timer = null;
    mpFilter.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => renderMentionList(mpFilter.value.trim()), 150);
    });
  }
  // 点击 popover 外部关闭
  document.addEventListener('mousedown', (e) => {
    const pop = document.getElementById('mention-popover');
    if (!pop || pop.hasAttribute('hidden')) return;
    const chip = document.getElementById('mention-chip');
    const btn = document.getElementById('btn-mention');
    if (pop.contains(e.target)) return;
    if (chip && chip.contains(e.target)) return;
    if (btn && btn.contains(e.target)) return;
    closeMentionPopover();
  });

  // 语音输入（icon-btn 内是 SVG，不用 textContent）
  micBtn.onclick = async () => {
    if (busy) return;
    if (currentRecording) {
      try {
        await currentRecording.stop();
        const blob = currentRecording.getBlob();
        currentRecording = null;
        micBtn.classList.remove('recording');
        await handleTranscription(blob);
      } catch (e) {
        alert('录音失败：' + (e?.message || e));
      }
    } else {
      try {
        currentRecording = await startRecording();
        micBtn.classList.add('recording');
      } catch (e) {
        alert('无法访问麦克风：' + (e?.message || e));
      }
    }
  };

  // 朗读开关
  document.getElementById('chk-tts').onchange = () => { if (!ui.isTtsOn()) stopSpeak(); };

  // 设置
  settingsBtn.onclick = () => { syncConfigForm(); dlg.showModal?.() || dlg.setAttribute('open', ''); };
  document.getElementById('btn-save-cfg').onclick = () => {
    cfg = readConfigForm(); saveConfig(cfg); setCfgRef(cfg); updateStatus(); dlg.close?.();
  };
  document.getElementById('btn-clear-cfg').onclick = () => {
    clearConfig(); cfg = loadConfig(); setCfgRef(cfg); syncConfigForm(); updateStatus();
  };
  document.getElementById('btn-test-llm').onclick = async () => {
    const testCfg = readConfigForm();
    const btn = document.getElementById('btn-test-llm');
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.textContent = '测试中…';
    try {
      const r = await testLlm(testCfg);
      alert(r.ok ? `成功：${r.reply.slice(0, 200)}` : `失败：${r.error}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  };

  // 预设按钮（新版 HTML：.preset-grid > .preset-btn）
  document.querySelectorAll('.preset-btn').forEach(b => {
    b.onclick = () => {
      const p = applyPreset(b.dataset.preset);
      document.getElementById('cfg-llm-base').value = p.baseUrl || '';
      document.getElementById('cfg-llm-model').value = p.model || '';
    };
  });

  ui.setSpeakHandler(async ({ text, stop }) => {
    if (stop) { stopSpeak(); return; }
    await speak({ cfg, text });
  });

  // 新对话 / 导出
  document.getElementById('btn-new-session')?.addEventListener('click', () => {
    if (confirm('新建一次咨询？当前案例的对话历史将保留在"导出"中可备份，但界面会重置为开场。')) {
      localStorage.removeItem('psychics.current_case.v1');
      localStorage.removeItem('psychics.sessions.v1');
      localStorage.removeItem('psychics.current_session.v1');
      location.reload();
    }
  });
  document.getElementById('btn-reset-case')?.addEventListener('click', () => {
    const c = counselor.getCurrentCase();
    if (!c) return;
    if (confirm('把当前咨询回到"建立关系"阶段重新来过？（消息历史会保留）')) {
      counselor.resetToIntake();
      // 清空消息显示，重新渲染开场
      const messagesEl = document.getElementById('messages');
      if (messagesEl) messagesEl.innerHTML = '';
      const fresh = counselor.getCurrentCase();
      renderStageBar(fresh);
      renderCaseHistory(fresh);
    }
  });
  document.getElementById('btn-export-sessions')?.addEventListener('click', () => {
    const data = {
      exportedAt: new Date().toISOString(),
      cases: counselor.listCases(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `psychics-cases-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
  });

  // 学习面板 mode-switch + sub-tabs
  // study: explore / schools / people / guide
  // counsel: help / team
  const PANEL_MODES = {
    study:   { title: '学习 / 研究',   desc: '探索心理学本体 · 覆盖 <b>32</b> 学派 · <b>78</b> 心理学家', defaultPane: 'explore',
               banner: '探索模式：我可以帮你理解概念、比较流派、追溯谱系。',
               tabs: [
                 { id: 'explore', icon: '🔍', label: '探索' },
                 { id: 'schools', icon: '🧩', label: '学派' },
                 { id: 'people',  icon: '🎭', label: '人物' },
                 { id: 'guide',   icon: '📖', label: '指南' },
               ]},
    counsel: { title: '咨询 / 求助',   desc: '15 种咨询场景 · <b>4</b> 种高性价比首推 · <b>7</b> 种团队隐喻', defaultPane: 'help',
               banner: '陪伴模式：我不会给你做诊断，只做信息提供和转介。',
               tabs: [
                 { id: 'help',  icon: '💬', label: '求助' },
                 { id: 'team',  icon: '👥', label: '团队' },
               ]},
  };
  let panelMode = 'study';
  const titleText = document.getElementById('panel-title-text');
  const descText  = document.getElementById('panel-desc-text');
  const subTabsEl = document.getElementById('sub-tabs');
  const panelEl   = document.getElementById('learn-panel');
  const bannerEl  = document.getElementById('mode-banner');
  const bannerTextEl = document.getElementById('mode-banner-text');

  function renderSubTabs(mode) {
    const cfg = PANEL_MODES[mode];
    if (!cfg) return;
    subTabsEl.innerHTML = '';
    cfg.tabs.forEach(t => {
      const b = document.createElement('button');
      b.className = 'ptab';
      b.dataset.tab = t.id;
      b.textContent = `${t.icon} ${t.label}`;
      b.onclick = () => switchPane(mode, t.id);
      subTabsEl.appendChild(b);
    });
  }

  function switchPane(mode, paneId) {
    // 更新 sub-tabs 高亮
    subTabsEl.querySelectorAll('.ptab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === paneId));
    // 更新 pane 可见性
    document.querySelectorAll('.panel-tab-pane').forEach(p => {
      const on = p.dataset.mode === mode && p.dataset.pane === paneId;
      p.classList.toggle('active', on);
      p.style.display = on ? '' : 'none';
    });
  }

  function switchMode(mode) {
    if (!PANEL_MODES[mode]) return;
    panelMode = mode;
    // 更新一级按钮高亮
    document.querySelectorAll('.mode-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === mode));
    // 更新标题与描述
    if (titleText) titleText.textContent = PANEL_MODES[mode].title;
    if (descText) descText.innerHTML = PANEL_MODES[mode].desc;
    // 更新微提示条文案
    if (bannerTextEl && PANEL_MODES[mode].banner) bannerTextEl.textContent = PANEL_MODES[mode].banner;
    // 学习/咨询模式切换 data-mode，供 CSS 分色
    if (panelEl) panelEl.dataset.mode = mode;
    document.documentElement.dataset.panelMode = mode;
    // 渲染 sub-tabs 并默认选中
    renderSubTabs(mode);
    switchPane(mode, PANEL_MODES[mode].defaultPane);
  }

  document.querySelectorAll('.mode-tab').forEach(b => {
    b.onclick = () => switchMode(b.dataset.mode);
  });
  // 初始化
  switchMode('study');

  // 学派搜索
  const searchSchool = document.getElementById('learn-search-school');
  if (searchSchool) {
    let timer = null;
    searchSchool.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => renderSearchResults('learn-results-school', searchSchool.value.trim(), 'school'), 200);
    });
    renderSearchResults('learn-results-school', '', 'school');
  }
  // 人物搜索
  const searchPsy = document.getElementById('learn-search-psy');
  if (searchPsy) {
    let timer = null;
    searchPsy.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => renderSearchResults('learn-results-psy', searchPsy.value.trim(), 'psych'), 200);
    });
    renderSearchResults('learn-results-psy', '', 'psych');
  }

  // 建议提问按钮（.sugg 内文字在 .sugg-text 中）
  function bindSuggButtons() {
    document.querySelectorAll('.suggestions .sugg').forEach(b => {
      if (b.dataset._bound) return;
      b.dataset._bound = '1';
      b.onclick = () => {
        const text = b.querySelector('.sugg-text')?.textContent || b.textContent;
        document.getElementById('input').value = text.trim();
        document.getElementById('input').focus();
      };
    });
  }
  bindSuggButtons();

  // 快速导航：填充输入框并切换到 explore
  document.querySelectorAll('.quick-links a[data-q]').forEach(a => {
    a.onclick = (e) => {
      e.preventDefault();
      document.getElementById('input').value = a.dataset.q;
      document.getElementById('input').focus();
    };
  });
}

function syncConfigForm() {
  document.getElementById('cfg-llm-base').value = cfg.llm.baseUrl || '';
  document.getElementById('cfg-llm-key').value = cfg.llm.apiKey || '';
  document.getElementById('cfg-llm-model').value = cfg.llm.model || '';
  document.getElementById('cfg-llm-temp').value = cfg.llm.temperature ?? 0.4;
  if (document.getElementById('cfg-llm-think')) {
    document.getElementById('cfg-llm-think').value = String(cfg.llm.enableThinking ? 1 : 0);
  }
  document.getElementById('cfg-asr-provider').value = cfg.asr.provider || 'openai';
  document.getElementById('cfg-asr-model').value = cfg.asr.model || '';
  document.getElementById('cfg-asr-key').value = cfg.asr.apiKey || '';
  document.getElementById('cfg-asr-base').value = cfg.asr.baseUrl || '';
  document.getElementById('cfg-tts-provider').value = cfg.tts.provider || 'openai';
  document.getElementById('cfg-tts-model').value = cfg.tts.model || '';
  document.getElementById('cfg-tts-voice').value = cfg.tts.voice || '';
  document.getElementById('cfg-tts-base').value = cfg.tts.baseUrl || '';
}

function readConfigForm() {
  return {
    llm: {
      baseUrl: document.getElementById('cfg-llm-base').value.trim(),
      apiKey: document.getElementById('cfg-llm-key').value.trim(),
      model: document.getElementById('cfg-llm-model').value.trim(),
      temperature: parseFloat(document.getElementById('cfg-llm-temp').value) || 0.4,
      enableThinking: document.getElementById('cfg-llm-think')
        ? document.getElementById('cfg-llm-think').value === '1'
        : false,
    },
    asr: {
      provider: document.getElementById('cfg-asr-provider').value,
      model: document.getElementById('cfg-asr-model').value.trim(),
      apiKey: document.getElementById('cfg-asr-key').value.trim(),
      baseUrl: document.getElementById('cfg-asr-base').value.trim(),
    },
    tts: {
      provider: document.getElementById('cfg-tts-provider').value,
      model: document.getElementById('cfg-tts-model').value.trim(),
      voice: document.getElementById('cfg-tts-voice').value.trim(),
      baseUrl: document.getElementById('cfg-tts-base').value.trim(),
    },
    backendUrl: '',
  };
}

function updateStatus() {
  if (isLlmConfigured(cfg)) ui.setStatus(`LLM: ${cfg.llm.model}`, true);
  else ui.setStatus('未配置模型 · 点击设置', false);
}

/* ============================================================ */
/* 左侧学习/研究面板 */
/* ============================================================ */

function renderLearningPanel() {
  const el = document.getElementById('learn-panel');
  if (!el) return;
  renderLearnStats();
}

function renderLearnStats() {
  const el = document.getElementById('learn-stats');
  if (!el) return;
  const schools = REGISTRY ? [...REGISTRY.values()].filter(a => a.id.startsWith('school.')).length : 0;
  const psychs = REGISTRY ? [...REGISTRY.values()].filter(a => a.id.startsWith('psych.')).length : 0;
  const nSchools = el.querySelector('[data-stat="schools"]');
  const nPsychs = el.querySelector('[data-stat="psychs"]');
  if (nSchools) nSchools.textContent = schools;
  if (nPsychs) nPsychs.textContent = psychs;
}

function renderSearchResults(containerId, query, kind) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!query) {
    el.innerHTML = `<div class="hint">输入关键词开始探索${kind === 'school' ? '学派' : '心理学家'}…</div>`;
    return;
  }
  let hits = ontSearch(query, { limit: 12 });
  // 按类型过滤（psych 优先匹配 psych. 前缀）
  if (kind === 'psych') hits = hits.filter(h => (h.row.id || '').startsWith('psych.')).slice(0, 12);
  else if (kind === 'school') hits = hits.filter(h => (h.row.id || '').startsWith('school.')).slice(0, 12);
  if (!hits.length) {
    el.innerHTML = `<div class="hint">未命中「${escapeHtml(query)}」。试试："焦虑"、"CBT"、"荣格"</div>`;
    return;
  }
  el.innerHTML = hits.map(h => {
    const r = h.row;
    const name = r.name_zh || r.title_zh || r.id;
    const sub = r.name_en || r.title_en || r.kind || '';
    const meta = r.bio_zh || r.summary_zh || r.narrative || '';
    return `
      <div class="result-item" data-id="${r.id}">
        <div class="ri-head">
          <span class="ri-type">${h.type}</span>
          <span class="ri-id">${r.id}</span>
        </div>
        <div class="ri-name">${escapeHtml(name)} ${sub ? `<span class="ri-sub">${escapeHtml(sub)}</span>` : ''}</div>
        ${meta ? `<div class="ri-desc">${escapeHtml(String(meta).slice(0, 100))}…</div>` : ''}
        <div class="ri-actions">
          <button class="btn-small" data-act="ask">💬 问 Agent</button>
          <button class="btn-small" data-act="detail">📖 详情</button>
        </div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.result-item').forEach(item => {
    const id = item.dataset.id;
    const obj = objectById(id);
    const row = obj?.row || {};
    item.querySelector('[data-act="ask"]').onclick = () => {
      const name = row.name_zh || row.title_zh || id;
      const q = `请详细讲讲「${name}」`;
      document.getElementById('input').value = q;
      document.getElementById('input').focus();
    };
    item.querySelector('[data-act="detail"]').onclick = () => showDetail(id);
  });
}

function showDetail(id) {
  const obj = objectById(id);
  if (!obj) return;
  const r = obj.row;
  const nb = neighbors(id).slice(0, 15);
  const content = Object.entries(r)
    .filter(([k, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `<tr><td><code>${k}</code></td><td>${escapeHtml(String(v).slice(0, 400))}</td></tr>`)
    .join('');
  const neighborHtml = nb.length
    ? nb.map(n => {
        const o = objectById(n.id);
        const nm = o ? (o.row.name_zh || o.row.title_zh || o.row.id) : n.id;
        return `<li><span class="nb-type">${o?.type}</span> <code>${n.id}</code> ${escapeHtml(nm)} <span class="nb-via">via ${n.via}</span></li>`;
      }).join('')
    : '<li>（无引用关系）</li>';
  const html = `
    <div class="detail-head">
      <span class="d-type">${obj.type}</span>
      <h2>${escapeHtml(r.name_zh || r.title_zh || r.id)}</h2>
      ${r.name_en || r.title_en ? `<div class="d-en">${escapeHtml(r.name_en || r.title_en)}</div>` : ''}
      <button class="btn-close" id="btn-close-detail">✕</button>
    </div>
    <div class="detail-section">
      <h3>字段</h3>
      <table class="kv">${content}</table>
    </div>
    <div class="detail-section">
      <h3>关联对象（一跳，共 ${nb.length} 条）</h3>
      <ul class="neighbors">${neighborHtml}</ul>
    </div>
    <div class="detail-actions">
      <button class="btn-small" id="btn-detail-ask">💬 让 Agent 讲解</button>
      <button class="btn-small" id="btn-detail-close">关闭</button>
    </div>
  `;
  const overlay = document.createElement('div');
  overlay.className = 'detail-overlay';
  overlay.innerHTML = `<div class="detail-modal">${html}</div>`;
  document.body.appendChild(overlay);
  document.getElementById('btn-close-detail').onclick = () => overlay.remove();
  document.getElementById('btn-detail-close').onclick = () => overlay.remove();
  document.getElementById('btn-detail-ask').onclick = () => {
    const name = r.name_zh || r.title_zh || r.id;
    document.getElementById('input').value = `请详细讲讲「${name}」（${r.id}），并给出相关理论/概念/著作`;
    document.getElementById('input').focus();
    overlay.remove();
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ============================================================ */
/* 提交 - 豆包式：可打断、可排队 */
/* ============================================================ */

async function submit() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text) return;

  // 正在生成中 → 优先打断，然后立刻发送新消息
  if (busy && activeTurn) stopCurrentTurn();

  // 命令系统：/reset /exit /new /help
  if (handleCommand(text)) return;

  // 【T0】危机硬拦截：命中高危关键词 → 不发 LLM、不路由、直接弹危机卡
  // 学术/研究语气会先被 safety.js 白名单过滤掉
  const crisis = detectCrisis(text);
  if (crisis && crisis.level === 'high') {
    input.value = '';
    ui.renderUser(text);
    renderCrisisIntervention(crisis);
    return;
  }

  // @ 命令解析：@counselor / @人名 / @学派名
  const mention = parseInlineAtMention(text);
  if (mention) {
    const target = mention.agent;
    const alreadyLocked = lockedPsych && (lockedPsych.id === target.id);
    if (!alreadyLocked) {
      // counselor marker 直接赋值，不走 registry
      if (target.__isCounselor) {
        lockedPsych = COUNSELOR_MODE;
        lockedHistory = [];
        renderLockedChip(COUNSELOR_MODE);
        persistChatState();
        const shell = ui.renderAgentShell({ agentName: 'Psychics · 咨询师', role: 'conductor' });
        ui.appendToBubble(shell, `👋 已进入咨询师模式。我会按 7 阶段流程陪你走一遍。输入 /exit 退出，/help 看帮助。`);
        ui.addSpeakButton(shell, shell.bubble.textContent);
      } else {
        lockToAgent(target.id);
      }
    }
    if (mention.text) {
      input.value = mention.text;
      return submit();
    }
    return;
  }

  input.value = '';
  await sendMessage(text);
}

/** 命令系统：命中返回 true 表示已处理，不再走 sendMessage */
function handleCommand(text) {
  if (!/^\//.test(text)) return false;
  const cmd = text.split(/\s+/)[0].toLowerCase();

  if (cmd === '/help') {
    const shell = ui.renderAgentShell({ agentName: `${CONDUCTOR_NAME} · 编排者`, role: 'conductor' });
    ui.appendToBubble(shell, [
      '**可用命令**',
      '',
      '· `/help` — 显示此帮助',
      '· `/exit` — 退出当前锁定的心理学家/咨询师',
      '· `/reset` — 咨询流程回到"建立关系"阶段',
      '· `/new` — 新建一次咨询（清空所有案例）',
      '',
      '**@ 召唤**',
      '',
      '· `@counselor` / `@咨询师` — 进入咨询师 7 阶段流程',
      '· `@弗洛伊德` / `@Freud` — 直接锁某位心理学家',
      '· `@CBT` / `@认知行为主义` — 直接锁某学派',
      '',
      '**小贴士**：锁定后所有回复由该 agent 给出，历史记录跨刷新保留。',
    ].join('\n'));
    ui.addSpeakButton(shell, shell.bubble.textContent);
    return true;
  }

  if (cmd === '/exit' || cmd === '/退出') {
    if (!lockedPsych) {
      const shell = ui.renderAgentShell({ agentName: `${CONDUCTOR_NAME} · 编排者`, role: 'conductor' });
      ui.appendToBubble(shell, '当前没有锁定任何 agent，我（知微）在等你。');
      return true;
    }
    unlockAgent();
    return true;
  }

  if (cmd === '/reset' || cmd === '/重置') {
    const c = counselor.getCurrentCase();
    if (!c) return false;
    counselor.resetToIntake();
    const fresh = counselor.getCurrentCase();
    renderStageBar(fresh);
    const shell = ui.renderAgentShell({ agentName: 'Psychics · 咨询师', role: 'conductor' });
    ui.appendToBubble(shell, '已回到"建立关系"阶段。我们重新开始。');
    ui.addSpeakButton(shell, shell.bubble.textContent);
    return true;
  }

  if (cmd === '/new' || cmd === '/新会话') {
    if (!confirm('新建一次咨询？会清空当前所有案例，且不可撤销。')) return true;
    localStorage.removeItem('psychics.current_case.v1');
    localStorage.removeItem('psychics.sessions.v1');
    localStorage.removeItem('psychics.current_session.v1');
    location.reload();
    return true;
  }

  return false;
}

/** 打断当前回合（保留已生成内容，标记 ⏹ 已停止） */
function stopCurrentTurn() {
  if (!activeTurn) return;
  if (lastShell) ui.markStopped(lastShell);
  try { activeTurn.abort.abort(); } catch (_) {}
  activeTurn = null;
  ui.setStopMode(false);
}

async function sendMessage(text) {
  if (busy) {
    // 若已有生成任务在跑，先把新消息入队（不打断，因为调用方决定）
    if (inputQueue.length >= MAX_QUEUE) {
      input.value = text;
      return;
    }
    inputQueue.push(text);
    ui.showQueue(inputQueue.length);
    return;
  }

  busy = true;
  ui.setStopMode(true);
  stopSpeak();

  const ac = new AbortController();
  activeTurn = { abort: ac, startedAt: Date.now() };

  ui.renderUser(text);

  if (!isLlmConfigured(cfg)) {
    const shell = ui.renderAgentShell({ agentName: `${CONDUCTOR_NAME} · 编排者`, role: 'conductor' });
    lastShell = shell;
    ui.appendToBubble(shell, '⚠ 请先在右上角"设置"里配置一个 LLM（SenseNova / OpenRouter / SiliconFlow / DeepSeek / 自建中转）。配置保存在本地。');
    ui.setSending(false);
    ui.setStopMode(false);
    busy = false;
    activeTurn = null;
    return;
  }

  // 已锁定心理学家/学派 → 直接路由到该 agent，不走编排者
  if (lockedPsych) {
    try {
      await sendMessageToAgent(lockedPsych, text, { signal: ac.signal });
    } catch (err) {
      if (isAbort(err)) ui.markStopped(lastShell);
      else if (lastShell) ui.appendToBubble(lastShell, `\n⚠ 出错：${err?.message || err}`);
    } finally {
      ui.setSending(false);
      ui.setStopMode(false);
      busy = false;
      activeTurn = null;
      await pumpQueue();
    }
    return;
  }

  // 特殊命令：/reset 或"重新开始咨询" → 回到 intake，并给一段新的开场白
  if (/^\/reset$/.test(text) || /^重新开始咨询$/.test(text)) {
    const fresh = counselor.resetToIntake();
    renderStageBar(fresh);
    const shell = ui.renderAgentShell({ agentName: `${CONDUCTOR_NAME} · 编排者`, role: 'conductor' });
    lastShell = shell;
    ui.appendToBubble(shell,
      '好的，我们重新开始。让我先自我介绍：\n\n' +
      `我是 **${CONDUCTOR_NAME}**，Psychics 的编排者。\n\n` +
      '我可以自己回答，也可以把话递给你真正需要的人：\n' +
      '· 想被陪伴/倾诉 → 咨询流程\n' +
      '· 想听某位心理学家/学派 → 我把话头递给 TA\n' +
      '· 想入门/对比 → 我直接答\n\n' +
      '遇到危机我第一时间给你热线：北京 **010-82951332** / 全国 **12355**。\n\n' +
      '那么，愿意告诉我你想怎么称呼自己吗？最近是什么让你决定来聊聊？'
    );
    ui.addSpeakButton(shell, shell.bubble.textContent);
    ui.setSending(false);
    ui.setStopMode(false);
    busy = false;
    activeTurn = null;
    await pumpQueue();
    return;
  }

  // 默认路径：走编排者（知微）
  try {
    await sendMessageViaConductor(text, { signal: ac.signal });
  } catch (err) {
    if (isAbort(err)) {
      if (lastShell) ui.markStopped(lastShell);
    } else if (lastShell) {
      ui.appendToBubble(lastShell, `\n⚠ 出错：${err?.message || err}`);
    }
  } finally {
    ui.setSending(false);
    ui.setStopMode(false);
    busy = false;
    activeTurn = null;
    await pumpQueue();
  }
}

/** 判断是不是用户主动打断 */
function isAbort(err) {
  return err?.name === 'AbortError' || err?.code === 20;
}

/** 前一条跑完自动处理下一条排队消息 */
async function pumpQueue() {
  ui.showQueue(inputQueue.length);
  while (inputQueue.length > 0) {
    const next = inputQueue.shift();
    ui.showQueue(inputQueue.length);
    await sendMessage(next);
  }
}

/**
 * 编排者流程：分类 → 分支。
 * 一个 bubble shell 承载"编排者手递短语" + "分支的回复"。
 */
async function sendMessageViaConductor(text, { signal } = {}) {
  // 用编排者头像做整个回合的 shell
  const shell = ui.renderAgentShell({ agentName: `${CONDUCTOR_NAME} · 编排者`, role: 'conductor' });
  lastShell = shell;
  let preface = '';
  let prefaceShown = false;
  let full = '';
  let reasoning = '';
  let contentStarted = false;
  let stageAdvanced = null;
  let risk = null;

  // 占位提示：用户立刻看到"思考中"，而不是空白气泡
  ui.appendToBubble(shell, '⋯ 思考中');

  const uiCtx = {
    onToken: (d, f) => {
      if (!contentStarted) {
        shell.bubble.textContent = prefaceShown ? preface + '\n\n' : '';
        contentStarted = true;
      }
      full = f;
      ui.appendToBubble(shell, d);
    },
    onReasoning: (_d, f) => {
      reasoning = f;
      if (!contentStarted && reasoning.length > 24) {
        shell.bubble.textContent = prefaceShown
          ? preface + '\n\n🧠 模型正在展开思考…'
          : '🧠 模型正在展开思考…';
      }
    },
    onHandoff: (line) => {
      // 编排者把话头递给某人：先给一句短话
      preface = line;
      prefaceShown = true;
      shell.bubble.textContent = line;
      ui.scrollBottom();
    },
    onRoute: (dec) => ui.showRouteBadge(dec),
  };

  try {
    const ctx = {
      cfg,
      userText: text,
      history: conductorHistory,
      ui: uiCtx,
      signal,
      ontology: {
        objectById, psychologistsOfSchool, neighbors, search: ontSearch,
        psychologistById, schoolById,
      },
      registry: REGISTRY,
      llm: { chat },
    };

    const result = await runConductor(ctx);
    const reply = result.reply || '';

    // 更新 shell 的头像/名字，让专家接管时的视觉归属更明确
    if (result.route === 'counselor') {
      shell.meta.textContent = 'Psychics · 咨询师 · ' + nowForMeta();
      shell.node.querySelector('.avatar').textContent = '咨';
    } else if (result.targetName && result.route !== 'self') {
      shell.meta.textContent = `${result.targetName} · ${nowForMeta()}`;
      shell.node.querySelector('.avatar').textContent = (result.targetName[0] || '?').toUpperCase();
    }

    // 兜底：把回复落到 bubble
    if (reply && !contentStarted) {
      shell.bubble.textContent = prefaceShown ? preface + '\n\n' : '';
      ui.appendToBubble(shell, reply);
      full = reply;
    } else if (reply && full !== reply) {
      const keepPreface = prefaceShown ? preface + '\n\n' : '';
      shell.bubble.textContent = keepPreface + reply;
      full = reply;
    }

    // 危机提示
    if (result.counselorResult) {
      stageAdvanced = result.counselorResult.meta?.stageAdvanced || null;
      risk = result.counselorResult.meta?.risk || null;
      if (result.case) renderStageBar(result.case);
      if (stageAdvanced) {
        const fromStage = counselor.getStage(stageAdvanced.from);
        const toStage = counselor.getStage(stageAdvanced.to);
        if (fromStage && toStage) {
          const tip = document.createElement('div');
          tip.className = 'stage-transition-tip';
          tip.innerHTML = `<span>${fromStage.icon} ${fromStage.label}</span> → <span>${toStage.icon} ${toStage.label}</span>`;
          shell.actions.appendChild(tip);
        }
      }
      if (risk === 'high') {
        const warn = document.createElement('div');
        warn.className = 'crisis-warning';
        warn.innerHTML = `
          <div class="cw-icon">⚠</div>
          <div class="cw-body">
            <div class="cw-title">请立刻寻求专业支持</div>
            <div class="cw-hotlines">
              <span>北京心理援助 <b>010-82951332</b></span>
              <span>全国统一心理援助 <b>12355</b></span>
              <span>希望 24 热线 <b>400-161-9995</b></span>
            </div>
          </div>
        `;
        shell.actions.appendChild(warn);
      }
    }

    // 兜底：气泡里没有可见回复
    if (!full) {
      const keepPreface = prefaceShown ? preface + '\n\n' : '';
      shell.bubble.textContent = keepPreface;
      if (reasoning) {
        ui.appendToBubble(shell,
          '🧠 模型本次只输出了推理过程，未产生可见回复。\n\n' +
          `常见原因：① 问题超出该分支范畴；② 知识快照里缺少对应条目；③ 模型把 4000 token 全用在思考上。\n\n` +
          '→ 换个更具体的问题，或用 @ 强制召唤特定专家。'
        );
      } else {
        ui.appendToBubble(shell,
          '⚠ 未收到模型回复。请检查：\n' +
          '· 设置 → 模型名/API Key 是否正确\n' +
          '· 网络是否可达 baseUrl\n' +
          '· 稍等片刻重试'
        );
      }
    }

    // 记录到 conductorHistory（保留 self / 专家回复；counselor 走自己独立 case）
    if (result.route === 'self' || result.route === 'counselor') {
      conductorHistory.push({ role: 'user', content: text });
      conductorHistory.push({ role: 'assistant', content: preface ? preface + '\n\n' + (full || reply) : (full || reply) });
    } else if (result.route && result.route.startsWith('psych.')) {
      // 专家回复也进 conductor 历史，让编排者下次能续上
      conductorHistory.push({ role: 'user', content: text });
      conductorHistory.push({ role: 'assistant', content: `（转 ${result.targetName}）${full || reply}` });
    }
    trimAndPersistConductor();

    ui.addSpeakButton(shell, (preface ? preface + '\n\n' : '') + (full || reply));

    // 【T0】引用校验：LLM 回复里的 [THYxxx] 等逐个查 ontology
    // 未命中的替换为 [🔍 THYxxx]，并在气泡下方挂一条状态徽章
    const prefaceFull = (preface ? preface + '\n\n' : '') + (full || reply);
    const sanitized = sanitizeCitations(prefaceFull);
    if (sanitized.total > 0 && sanitized.display !== prefaceFull) {
      shell.bubble.textContent = sanitized.display;
      // 回写已 push 到历史的最后一条 assistant 消息，避免污染下一轮上下文
      const last = conductorHistory[conductorHistory.length - 1];
      if (last && last.role === 'assistant') last.content = sanitized.display;
      trimAndPersistConductor();
    }
    const citeBadgeHtml = citationBadgeHtml(sanitized);
    if (citeBadgeHtml) {
      const badge = document.createElement('div');
      badge.className = 'cite-badge-row';
      badge.innerHTML = citeBadgeHtml;
      shell.actions.appendChild(badge);
    }

    // 路由徽章
    if (result.route === 'counselor') {
      const st = counselor.getStage(result.counselorResult?.case?.stage || 'intake');
      ui.showRouteBadge({
        intent: `咨询·${st.label}`,
        school_ids: result.counselorResult?.meta?.stageAdvanced ? [result.counselorResult.meta.stageAdvanced.to] : [],
        psychologist_ids: [],
        reason: risk ? `⚠ ${risk === 'high' ? '高风险' : '风险'}信号 · 已触发危机提示` : `${st.icon} ${st.label}`,
      });
    } else if (result.route && result.route.startsWith('psych.')) {
      ui.showRouteBadge({
        intent: 'direct',
        psychologist_ids: [result.route.replace('psych.', '')],
        reason: `知微 → ${result.targetName}`,
      });
    } else if (result.route && result.route.startsWith('school.')) {
      ui.showRouteBadge({
        intent: 'direct',
        school_ids: [result.route.replace('school.', '')],
        reason: `知微 → ${result.targetName}`,
      });
    } else {
      ui.showRouteBadge({ intent: result.route || 'self', reason: result.decision?.reason || '知微自答' });
    }

    if (ui.isTtsOn() && full) speak({ cfg, text: full });
  } catch (e) {
    console.error(e);
    const keepPreface = prefaceShown ? preface + '\n\n' : '';
    shell.bubble.textContent = keepPreface;
    ui.appendToBubble(shell, `⚠ 出错：${e?.message || e}`);
  }
}

function nowForMeta() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/* ============================================================ */
/* 咨询流程状态条 */
/* ============================================================ */

function renderStageBar(caseObj) {
  const track = document.getElementById('stage-track');
  const numEl = document.getElementById('stage-session-num');
  if (!track) return;

  const curIdx = counselor.STAGES.findIndex(s => s.id === caseObj.stage);
  if (numEl) numEl.textContent = `第 ${caseObj.sessionCount} 次`;

  track.innerHTML = counselor.STAGES.map((s, i) => {
    const status = i < curIdx ? 'done' : i === curIdx ? 'current' : 'todo';
    return `
      <div class="stage-step ${status}" title="${s.label}">
        <div class="step-dot">${status === 'done' ? '✓' : s.icon}</div>
        <div class="step-label">${s.label}</div>
      </div>
      ${i < counselor.STAGES.length - 1 ? `<div class="step-line ${i < curIdx ? 'done' : ''}"></div>` : ''}
    `;
  }).join('');

  // 危机状态色标
  const risk = caseObj.safety?.riskFlag;
  track.classList.toggle('risk-high', risk === 'high');
  track.classList.toggle('risk-medium', risk === 'medium');
}

function highlightCurrentStage(stageId) {
  const track = document.getElementById('stage-track');
  if (!track) return;
  track.querySelectorAll('.stage-step').forEach((el, i) => {
    const stage = counselor.STAGES[i];
    el.classList.toggle('current', stage.id === stageId);
    el.classList.toggle('done', counselor.STAGES.findIndex(s => s.id === stageId) > i);
  });
}

function renderCaseHistory(caseObj) {
  // 恢复历史消息
  if (caseObj.messages.length > 0) {
    for (const m of caseObj.messages) {
      if (m.role === 'user') {
        ui.renderUser(m.content);
      } else {
        const shell = ui.renderAgentShell({ agentName: 'Psychics · 咨询师' });
        ui.appendToBubble(shell, m.content);
      }
    }
    return;
  }

  // 首次见面：编排者「知微」开场白
  const shell = ui.renderAgentShell({ agentName: `${CONDUCTOR_NAME} · 编排者`, role: 'conductor' });
  const intro =
    `你好，我是 **${CONDUCTOR_NAME}**（${CONDUCTOR_EN}），Psychics 的编排者。🎭\n\n` +
    '我融汇各流派观点，能直接答你的入门/术语/对比类问题；一旦你问到具体心理学家或学派，我会把话头递给他们；' +
    '如果你想被听见、被陪伴，我会转交咨询流程。\n\n' +
    '你可以：\n' +
    '· 直接提问（我会看是否需要交给专家）\n' +
    '· 输入 `@` 或点击输入框旁的 `@` 按钮，强制召唤某位心理学家\n' +
    '· 说说你的感受 —— 我会切到咨询模式陪你\n\n' +
    '我记住一点：**遇到自伤/自杀念头**，我会立刻给你危机热线：北京 **010-82951332** / 全国 **12355**。\n\n' +
    '从哪儿聊起？';
  ui.appendToBubble(shell, intro);
  ui.addSpeakButton(shell, intro);
}

/* ============================================================ */
/* @ popover：召唤心理学家 */
/* ============================================================ */

/** 咨询师 7 阶段模式：与 counselor 案例直接对话 */
async function sendMessageToCounselor(text, { signal } = {}) {
  const shell = ui.renderAgentShell({ agentName: 'Psychics · 咨询师', role: 'conductor' });
  shell.node.querySelector('.avatar').textContent = '咨';
  lastShell = shell;
  let full = '';
  let reasoning = '';
  let contentStarted = false;

  ui.appendToBubble(shell, '⋯ 思考中');

  try {
    const result = await counselor.counselorReply({
      cfg,
      userText: text,
      signal,
      onDelta: (d, f) => {
        if (!contentStarted) { shell.bubble.textContent = ''; contentStarted = true; }
        full = f;
        ui.appendToBubble(shell, d);
      },
      onReasoning: (_d, f) => {
        reasoning = f;
        if (!contentStarted && reasoning.length > 24) {
          shell.bubble.textContent = '🧠 模型正在展开思考…';
        }
      },
    });

    const reply = result.reply || full || '';
    if (reply && !contentStarted) {
      ui.appendToBubble(shell, reply);
    }

    if (!full && !reply) {
      shell.bubble.textContent = '';
      ui.appendToBubble(shell, '⚠ 未收到回复。请稍后再试。');
    }

    // 阶段推进提示
    const adv = result.meta?.stageAdvanced;
    if (adv) {
      const fromStage = counselor.getStage(adv.from);
      const toStage = counselor.getStage(adv.to);
      if (fromStage && toStage) {
        const tip = document.createElement('div');
        tip.className = 'stage-transition-tip';
        tip.innerHTML = `<span>${fromStage.icon} ${fromStage.label}</span> → <span>${toStage.icon} ${toStage.label}</span>`;
        shell.actions.appendChild(tip);
      }
      renderStageBar(result.case);
    }

    // 危机提示
    if (result.meta?.risk === 'high') {
      const warn = document.createElement('div');
      warn.className = 'crisis-warning';
      warn.innerHTML = `
        <div class="cw-icon">⚠</div>
        <div class="cw-body">
          <div class="cw-title">请立刻寻求专业支持</div>
          <div class="cw-hotlines">
            <span>北京心理援助 <b>010-82951332</b></span>
            <span>全国统一心理援助 <b>12355</b></span>
            <span>希望 24 热线 <b>400-161-9995</b></span>
          </div>
        </div>
      `;
      shell.actions.appendChild(warn);
    }

    ui.addSpeakButton(shell, reply);
    if (ui.isTtsOn() && reply) speak({ cfg, text: reply });
  } catch (e) {
    console.error(e);
    shell.bubble.textContent = '';
    ui.appendToBubble(shell, `⚠ 出错：${e?.message || e}`);
  }
}

async function sendMessageToAgent(agent, text, { signal } = {}) {
  // COUNSELOR_MODE marker：走 counselor 7 阶段流程
  if (agent.__isCounselor) {
    return sendMessageToCounselor(text, { signal });
  }

  const shell = ui.renderAgentShell({ agentName: agent.name, role: agent.role });
  lastShell = shell;
  let full = '';
  let reasoning = '';
  let contentStarted = false;

  // 记录用户消息到 lockedHistory（下一次调用时作为上下文）
  lockedHistory.push({ role: 'user', content: text });

  // 占位提示：用户立刻看到"正在思考"，而不是空白气泡
  ui.appendToBubble(shell, '⋯ 思考中');

  const uiCtx = {
    onToken: (d, f) => {
      if (!contentStarted) { shell.bubble.textContent = ''; contentStarted = true; }
      full = f;
      ui.appendToBubble(shell, d);
    },
    onReasoning: (_d, f) => {
      reasoning = f;
      if (!contentStarted && reasoning.length > 24) {
        shell.bubble.textContent = '🧠 模型正在展开思考…（SenseNova 思考模式）';
      }
    },
    onRoute: (dec) => ui.showRouteBadge(dec),
  };

  try {
    const ctx = {
      cfg,
      userText: text,
      history: lockedHistory.slice(0, -1),
      ui: uiCtx,
      signal,
      ontology: {
        objectById, psychologistsOfSchool, neighbors, search: ontSearch,
        psychologistById, schoolById,
      },
      registry: REGISTRY,
      llm: { chat },
    };
    const result = await agent.run(ctx);
    const reply = result.reply || result.content || '';

    if (reply && !contentStarted) {
      shell.bubble.textContent = '';
      ui.appendToBubble(shell, reply);
      full = reply;
    } else if (reply && full !== reply) {
      shell.bubble.textContent = reply;
      full = reply;
    }

    if (!full) {
      shell.bubble.textContent = '';
      if (reasoning) {
        ui.appendToBubble(shell,
          '🧠 模型本次只输出了推理过程，未产生可见回复。\n\n' +
          `常见原因：① 问题超出该心理学家已知范畴；② 知识快照里缺少对应条目；③ 模型把 4000 token 全用在思考上。\n\n` +
          `→ 换个更具体/更贴近其思想的问题（例如"讲讲 ${agent.name} 提出的核心概念"），或点击输入框旁 ✕ 切换到咨询师模式。`
        );
      } else {
        ui.appendToBubble(shell,
          '⚠ 未收到模型回复。请检查：\n' +
          '· 设置 → 模型名/API Key 是否正确\n' +
          '· 网络是否可达 baseUrl\n' +
          '· 稍等片刻重试'
        );
      }
    }

    lockedHistory.push({ role: 'assistant', content: full || reply });
    trimAndPersistLocked();

    ui.addSpeakButton(shell, full || reply);
    ui.showRouteBadge({
      intent: 'direct',
      school_ids: agent.role === 'school' ? [agent.id.replace('school.', '')] : [],
      psychologist_ids: agent.role === 'psych' ? [agent.id.replace('psych.', '')] : [],
      reason: `直接与 ${agent.name} 对话`,
    });

    // 【T0】引用校验：LLM 回复里的 [THYxxx] 等逐个查 ontology
    const sanitized = sanitizeCitations(full || reply);
    if (sanitized.total > 0 && sanitized.display !== (full || reply)) {
      if (full !== sanitized.display) {
        full = sanitized.display;
        shell.bubble.textContent = sanitized.display;
        if (lockedHistory.length) lockedHistory[lockedHistory.length - 1].content = sanitized.display;
        trimAndPersistLocked();
      }
    }
    const citeBadgeHtml = citationBadgeHtml(sanitized);
    if (citeBadgeHtml) {
      const badge = document.createElement('div');
      badge.className = 'cite-badge-row';
      badge.innerHTML = citeBadgeHtml;
      shell.actions.appendChild(badge);
    }

    // HLT 交接拦截：agent 声明"不擅长"并给出候选 → 弹候选卡
    const hltResult = hlt.detectAndStrip(full || reply);
    if (hltResult.ids && hltResult.ids.length) {
      // 剥离 marker，刷新气泡文本
      if (full !== hltResult.display) {
        full = hltResult.display;
        if (shell.bubble) shell.bubble.textContent = hltResult.display;
        // 同步覆盖写入历史，避免 marker 泄漏到下一轮上下文
        if (lockedHistory.length) {
          lockedHistory[lockedHistory.length - 1].content = hltResult.display;
          trimAndPersistLocked();
        }
      }
      const userTextSnapshot = text;
      hlt.renderHandoffCard({
        currentAgentName: agent.name,
        ids: hltResult.ids,
        onSwitchTo: (agentId) => {
          lockToAgent(agentId);
          // 自动重发原问题给新锁定的 agent
          setTimeout(() => sendMessage(userTextSnapshot), 60);
        },
        onDismiss: () => {},
      });
    }

    if (ui.isTtsOn() && full) speak({ cfg, text: full });
  } catch (e) {
    console.error(e);
    shell.bubble.textContent = '';
    ui.appendToBubble(shell, `⚠ 出错：${e?.message || e}`);
  }
}

function toggleMentionPopover(open) {
  const pop = document.getElementById('mention-popover');
  if (!pop) return;
  const wantOpen = open ?? pop.hasAttribute('hidden');
  if (wantOpen) {
    pop.removeAttribute('hidden');
    renderMentionList('');
    const f = document.getElementById('mp-filter');
    if (f) setTimeout(() => f.focus(), 20);
  } else {
    pop.setAttribute('hidden', '');
  }
}

function closeMentionPopover() {
  const pop = document.getElementById('mention-popover');
  if (pop) pop.setAttribute('hidden', '');
}

function renderMentionList(query) {
  const list = document.getElementById('mp-list');
  const count = document.getElementById('mp-count');
  if (!list) return;

  let items;
  if (!query) {
    // 默认列出所有心理学家（按 id 排序），但只取前 100 避免卡顿
    items = listPsychologists().map(p => ({ kind: 'psych', row: p }));
  } else {
    // 关键词搜索：优先心理学家，其次学派
    const hitPsych = ontSearch(query, { limit: 20 })
      .filter(h => h.row.id && /^PSY/i.test(h.row.id));
    const hitSchool = ontSearch(query, { limit: 12 })
      .filter(h => h.row.id && /^SCH/i.test(h.row.id));
    items = [
      ...hitPsych.map(h => ({ kind: 'psych', row: h.row, hit: h })),
      ...hitSchool.map(h => ({ kind: 'school', row: h.row, hit: h })),
    ];
  }

  if (count) count.textContent = `${items.length}`;

  if (!items.length) {
    list.innerHTML = `<div class="mp-item empty">未找到匹配的心理学家或学派，试试"弗洛伊德"、"荣格"、"CBT"、"精神分析"…</div>`;
    return;
  }

  list.innerHTML = items.map((it, i) => {
    const row = it.row;
    const name = row.name_zh || row.title_zh || row.id;
    const nameEn = row.name_en || row.title_en || '';
    const lifeOrRange = row.life_span_text
      || (row.flourished_start ? `${row.flourished_start}-${row.flourished_end || '?'}` : '');
    const bio = (row.bio_zh || row.summary_zh || '').slice(0, 90);
    const schoolName = it.kind === 'psych'
      ? affiliationName(row.affiliation || row.school_ids)
      : (row.aliases || '').slice(0, 30);
    const sub = lifeOrRange ? `${lifeOrRange}${bio ? ' · ' + bio : ''}` : bio;
    const tag = it.kind === 'school' ? '学派' : '人物';
    const initials = (name[0] || '?').toUpperCase();
    return `
      <div class="mp-item" data-idx="${i}" data-id="${escapeAttr(row.id)}" data-kind="${it.kind}">
        <div class="mp-avatar">${escapeHtml(initials)}</div>
        <div class="mp-main">
          <div class="mp-name">${escapeHtml(name)} ${nameEn ? `<span class="mp-en">${escapeHtml(nameEn)}</span>` : ''}</div>
          ${sub ? `<div class="mp-sub">${escapeHtml(sub)}</div>` : ''}
          ${schoolName ? `<div class="mp-sub">${escapeHtml(schoolName)}</div>` : ''}
        </div>
        <span class="mp-tag">${tag}</span>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.mp-item[data-idx]').forEach(el => {
    el.onclick = () => {
      const id = el.dataset.id;
      const kind = el.dataset.kind;
      lockToAgent(kind === 'school' ? `school.${id}` : `psych.${id}`);
      closeMentionPopover();
    };
  });
}

function affiliationName(affStr) {
  if (!affStr) return '';
  const ids = String(affStr).match(/SCH\d+/g) || [];
  const names = ids.map(id => {
    const s = schoolById(id);
    return s ? (s.name_zh || s.name_en || id) : id;
  });
  return names.join(' · ');
}

function lockToAgent(agentId) {
  const a = agentGet(agentId);
  if (!a) { alert('未找到 agent：' + agentId); return; }
  lockedPsych = a;
  lockedHistory = [];
  renderLockedChip(a);
  persistChatState();
  // 提示气泡
  const shell = ui.renderAgentShell({ agentName: a.name, role: a.role });
  const intro = `👋 你好，我是 **${a.name}**（${a.id}）。${a.role === 'psych' ? '接下来我会从我的思想视角回答你的问题。' : '接下来我会从这个学派的视角回答你的问题。'}\n\n可以直接向我提问。如果想恢复默认咨询师流程，点击输入框旁的 ✕ 关闭我即可。`;
  ui.appendToBubble(shell, intro);
  ui.addSpeakButton(shell, intro);
  ui.showRouteBadge({
    intent: 'direct',
    school_ids: a.role === 'school' ? [a.id.replace('school.', '')] : [],
    psychologist_ids: a.role === 'psych' ? [a.id.replace('psych.', '')] : [],
    reason: `已锁定：${a.name}`,
  });
}

function unlockAgent() {
  lockedPsych = null;
  lockedHistory = [];
  renderLockedChip(null);
  document.getElementById('btn-mention')?.classList.remove('active-mention');
  persistChatState();
}

function renderLockedChip(agent) {
  const chip = document.getElementById('mention-chip');
  const btn = document.getElementById('btn-mention');
  if (!chip) return;
  if (!agent) {
    chip.setAttribute('hidden', '');
    chip.innerHTML = '';
    btn?.classList.remove('active-mention');
    return;
  }
  const initials = (agent.name[0] || '?').toUpperCase();
  chip.removeAttribute('hidden');
  chip.innerHTML = `
    <span class="mc-icon">${escapeHtml(initials)}</span>
    <span>🎤 当前对话者：</span>
    <span class="mc-name">${escapeHtml(agent.name)}</span>
    <span class="mc-school">(${agent.id})</span>
    <button class="mc-x" id="btn-unlock" title="恢复默认咨询师流程">✕</button>
  `;
  document.getElementById('btn-unlock').onclick = () => unlockAgent();
  btn?.classList.add('active-mention');
}

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/"/g, '&quot;');
}

/* ============================================================ */
/* 危机硬拦截：本地渲染，不走 LLM                                */
/* ============================================================ */

function renderCrisisIntervention(crisis) {
  const shell = ui.renderAgentShell({ agentName: `${CONDUCTOR_NAME} · 编排者`, role: 'conductor' });
  lastShell = shell;
  // 让气泡本身变成红卡容器，而不是套在普通气泡里
  shell.bubble.className = 'bubble crisis-intervene';
  shell.bubble.innerHTML = crisisCardHtml({ reason: crisis.reason, onMoreClickId: 'crisis-more-btn' });
  document.getElementById('crisis-more-btn')?.addEventListener('click', () => {
    try { openCrisisList(); } catch (_) {}
  });
  document.getElementById('crisis-more-btn-dismiss')?.addEventListener('click', () => {
    shell.bubble.className = 'bubble';
    shell.bubble.textContent = '好的。如果你之后需要，我随时在。';
    ui.addSpeakButton(shell, '好的。如果你之后需要，我随时在。');
  });
  ui.addSpeakButton(shell,
    '先停一下。我这里有一条危机支持卡片。请先看下面这几个热线号码。'
  );
}

/* ============================================================ */
/* 语音转写 */
/* ============================================================ */

async function handleTranscription(blob) {
  if (!blob || blob.size === 0) return;
  const input = document.getElementById('input');
  input.value = '转写中…';
  try {
    const text = await transcribe({ cfg, blob });
    input.value = text;
    input.focus();
  } catch (e) {
    input.value = '';
    alert('ASR 失败：' + (e?.message || e) + '\n\nTip: 若使用 OpenAI Whisper，需在设置里配置 apiKey 或复用 LLM Key。');
  } finally {
    stopAudio();
  }
}
