# agent-psychics · 心理学本体论

覆盖历史各主要流派的心理学知识图谱，用于训练/支撑一个「心理学 Agent」——既能做知识教学（学习心理学），也能做来访式支持（帮助有心理困扰的人）。

## 设计原则

**CSV 是唯一人工维护源；DuckDB/Parquet/OWL/SHACL 都是派生物；本体定义在 `backend/app/ontology/`。**

```
L0 (人工维护)     backend/data/*.csv                        ← 只改这里
     │
     │  python backend/scripts/rebuild_all.py
     ▼
L1 (派生物)       backend/dist/*.parquet                    (RAG / 前端用)
                  backend/dist/ontology.ttl                 (RDF/本体交换)
                  backend/dist/ontology.owl                 (OWL 类/关系目录)
                  backend/dist/shapes.ttl                   (SHACL 校验)
                  backend/dist/psychics.duckdb              (本地分析)
     │
     ▼
L2 (消费者)       Agent 工具层 / 前端 / SPARQL 端点           ← 只读派生物
```

## 目录

```
agent-psychics/
├── README.md                       本文件
├── ONTOLOGY.md                    本体使用文档（Object Types、五闸门、查询示例）
├── backend/                       L0 数据 + Python 治理工具（不入运行时）
│   ├── app/
│   │   ├── ontology/              Pydantic schema + SHACL + REL_PAIRS
│   │   ├── validate.py            五闸门校验（G1..G5）
│   │   └── rebuild_all.py         CSV → TTL + DuckDB + Markdown 报告
│   ├── data/*.csv                 ★ L0 唯一人工维护源
│   ├── data/ttl/                  (派生) Turtle 输出
│   ├── data/report/               (派生) 重建报告
│   ├── .env.example               后端配置模板
│   └── requirements.txt
└── frontend/                      ★ 纯前端运行时代码（GH Pages 部署）
    ├── index.html                 对话 UI
    ├── css/style.css
    ├── js/
    │   ├── main.js                入口：加载本体→初始化 Agent→对话循环
    │   ├── config.js              localStorage 多 provider 配置（参考 nobel-kg）
    │   ├── llm.js                 OpenAI 兼容 Chat/Stream（fetch）
    │   ├── asr.js                 MediaRecorder → OpenAI whisper-1
    │   ├── tts.js                 OpenAI TTS + 浏览器 SpeechSynthesis 兜底
    │   ├── ontology.js            纯 JS CSV 解析 + 对象索引（fetch ../backend/data/*.csv）
    │   ├── agent.js               Agent 抽象 + Orchestrator（路由）
    │   ├── ui.js                  对话界面渲染
    │   └── agents/registry.js     General / School.{id} / Psych.{id} 专家工厂
    └── package.json               静态托管；peerDeps 声明 deepagents 迁移路径
```

## 快速开始

### A. Python 后端（数据治理，本地一次性运行）

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows；macOS/Unix: source .venv/bin/activate
python -m pip install -r requirements.txt
python -m app.validate          # 五闸门校验（G1..G5）
python -m app.rebuild_all       # 生成 data/ttl/ontology.ttl + DuckDB + 报告
```

### B. 前端（GH Pages 纯静态，无服务器）

前端直接 `fetch` 相对路径的 `../backend/data/*.csv`，把 CSV 打包进仓库即可运行。

```bash
cd frontend
npx serve -l 5173 .             # 本地预览（http://localhost:5173）
```

浏览器打开后：
1. 点右上角 **⚙ 设置**
2. 填 LLM Base URL / API Key / Model（预设：OpenRouter / SiliconFlow / DeepSeek / 自定义）
3. ASR/TTS 可复用同一 Key；或单独配 CosyVoice / DashScope
4. 配置保存在浏览器 localStorage，仅在你本地使用

### C. 部署到 GitHub Pages

```bash
cd frontend
npm install                       # 安装 gh-pages 脚本
npm run deploy                    # 推送到 gh-pages 分支
# 或手动把整个仓库（backend/data + frontend）推到 gh-pages 分支
```

Pages 站点设置：Source = `gh-pages` 分支 · Root。GH Pages 是纯静态托管，符合"无服务器"要求。

## 架构：多 Agent 编排

```
        ┌─────────────────────────────────────────────┐
        │           浏览器（GH Pages 静态站点）          │
        │                                             │
用户输入 ─┤ 文字 / 麦克风(MediaRecorder → ASR)           │
        │   │                                         │
        │   ▼                                         │
        │  orchestrator  ──►  路由决策 (LLM JSON)      │
        │     │         │                             │
        │     │  intent, school_ids, psych_ids         │
        │     ▼                                         │
        │  ┌──────────┬─────────────┬──────────────┐   │
        │  │ general  │ school.SCHx │ psych.PSYxxx │   │
        │  │ 通用专家  │ 学派专家    │ 心理学家专家  │   │
        │  └────┬─────┴──────┬──────┴──────┬───────┘   │
        │       └────────────┴──────────────┘           │
        │                    │                          │
        │         本体查询（ontology.js，CSV 索引）        │
        │                    │                          │
        │                    ▼                          │
        │              LLM (OpenAI 兼容)                │
        │                    │                          │
        │                    ▼                          │
        │       流式文字 + TTS 朗读（可切换）             │
        └─────────────────────────────────────────────┘
```

- **Orchestrator（编排者）** 用 LLM 生成严格 JSON 决策（`intent` + `school_ids` + `psychologist_ids`），失败则回落关键词规则
- **General / School / Psych 三类专家** 各自基于本体片段生成回答，学派/人物 prompt 严格锁定其视角
- **本体快照注入**：每次调用前用 `ontology.search()` + `neighbors()` 取一跳邻居，作为 system prompt 的"事实锚点"，防止幻觉

### deepagents / langgraph.js 迁移路径

本项目当前是浏览器原生 ES Modules，抽象边界与 LangChain 生态的 **Node 运行时库族**（[`deepagents`](https://docs.langchain.com/oss/javascript/deepagents/overview) 与 [`langgraph.js`](https://js.langchain.com/), nobel-kg 用的就是后者，二者同源）对齐：

| LangChain Node 生态 | 本项目（浏览器原生） |
|---|---|
| `createDeepAgent({model, tools, subagents})` | `new Agent({id, name, role, systemPrompt, handler})` |
| `StateGraph` / `langgraph.js` 节点编排 | `orchestrator` + `registry.get(...)` 手动路由 |
| `agent.invoke({messages})` | `agent.run(ctx)` |
| subagents (task tool) | `registry.get('school.SCH01')` / `psych.PSY001` |
| tools | `ontology.search` / `ontology.neighbors` / `llm.chat` |
| middleware (planning / memory / skills) | 预留扩展位（可在 handler 内串接） |
| streaming (typed events) | `ui.onToken` / `ui.onRoute` 回调 |

**当前路径（GH Pages 无服务器）**：浏览器原生 ES Modules 保留与 LangChain 生态相同的抽象边界。

**若迁到 Vercel / Cloudflare Pages Functions / Node 后端**：把每个专家 `handler` 内部替换为 `createDeepAgent(...)` 或 `StateGraph`，注册表与 UI 层接口保持不变。

## 设计原则

**CSV 是唯一人工维护源；TTL/Parquet/OWL/SHACL 都是派生物；本体定义在 `backend/app/ontology/`。**

```
L0 (人工维护)     backend/data/*.csv                        ← 只改这里
     │
     │  python backend/app/rebuild_all.py
     ▼
L1 (派生物)       backend/data/ttl/ontology.ttl             (RDF/本体交换)
                  backend/data/duckdb/ontology.duckdb       (本地分析，可选)
                  backend/data/report/rebuild_report.md     (重建报告)
                  backend/app/ontology/shapes.ttl           (SHACL 校验)
     │
     ▼
L2 (消费者)       frontend/js/ontology.js (fetch CSV)      ← 前端唯一入口
                  Agent 工具层 / SPARQL 端点（可选）         ← 只读派生物
```

## 反幻觉五闸门

| # | 闸门 | 落点 |
|---|---|---|
| G1 | **模式闸门** — 14 类 Object Type；关系端点必须在 `REL_PAIRS` 白名单内 | `schema.py` + `validate.py` |
| G2 | **归一化闸门** — 生卒年份、学派起止由 CSV 唯一维护，Agent 不得凭空生成 | CSV SSOT |
| G3 | **证据闸门** — 每条 Claim/理论必挂 `author_ids` + `work_ids/paper_ids`，检索无出处的答复标红 | `validate.py` |
| G4 | **分歧闸门** — 学派间批评/发展关系并列呈现，不取二选一 | `rel_theory` 边 |
| G5 | **外部锚点闸门** — `external_ids` 对齐 Wikidata / DBpedia / VIAF / ORCID / DOI | `schema.py` |

详见 `ONTOLOGY.md`。
