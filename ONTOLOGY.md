# Psychics Ontology 使用文档

心理学本体论（Psychics Ontology）用于支撑本项目 Agent 的知识基础与对话。它覆盖：
- 历史所有主要心理学流派（32 个）
- 代表心理学家（78 位）
- 经典理论（68 个）、概念（200 个）
- 核心著作（120 部）、论文（100 篇）
- 临床方法（85 项）、评估工具（50 项）
- 应用主题（35 个）、伦理规范（24 条）
- 关键事件（50 个）、机构（50 个）、国家（69 个）
- 争议/分歧主张（Claim，动态增长）

合计约 1338 条一手对象。

---

## 1. 数据源（SSOT）

**唯一真相源是 CSV**：[`backend/data/*.csv`](backend/data/)。所有其他格式（Turtle、DuckDB、内存对象）都是从 CSV 派生。要修改数据，只改 CSV。

| CSV | Object Type | 编号前缀 | 主键示例 |
| --- | --- | --- | --- |
| schools.csv | School | `SCH` | SCH01 结构主义 |
| psychologists.csv | Psychologist | `PSY` | PSY001 威廉·冯特 |
| theories.csv | Theory | `THY` | THY001 结构主义理论 |
| concepts.csv | Concept | `CPT` | CPT001 内省 |
| works.csv | Work | `WRK` | WRK001 生理心理学原理 |
| papers.csv | Paper | `PAP` | PAP001 心理学实验史 |
| methods.csv | Method | `MTH` | MTH001 内省法 |
| topics.csv | Topic | `TOP` | TOP01 焦虑 |
| assessments.csv | Assessment | `ASM` | ASM001 MMPI |
| ethics.csv | Ethics | `ETH` | ETH01 APA 2017 伦理 |
| events.csv | Event | `EVT` | EVT001 1879 Wundt 实验室 |
| institutions.csv | Institution | `INS` | INS001 莱比锡实验心理学实验室 |
| nations.csv | Nation | `N` | N01 德国 |
| claims.csv | Claim | `CLM` | CLM001（多视角分歧） |

---

## 2. Object Types（14 类）

定义见 [`backend/app/ontology/schema.py`](backend/app/ontology/schema.py)。全部继承治理基类 `_Governed`（含 `created_at`/`updated_at`/`version`/`provenance`/`external_ids`）。

核心字段：

```python
class School(_Governed):
    id, name_zh, name_en, founded_year, flourished_start, flourished_end,
    region, paradigm, founders: [PSY], one_liner_zh,
    stance_on_mind, stance_on_conduct

class Psychologist(_Governed):
    id, name_zh, name_en, aliases, birth_year, death_year, gender,
    nationality, region, affiliation: [SCH], mentor_ids: [PSY],
    active_field: [TOP], life_span_text, bio_zh, narrative

class Theory(_Governed):
    id, name_zh, name_en, school_ids: [SCH], author_ids: [PSY], year,
    work_ids: [WRK], paper_ids: [PAP], concept_ids: [CPT],
    summary_zh, core_claim_zh, stance_on_mind, applicability

class Concept(_Governed):
    id, name_zh, name_en, kind, school_ids, theory_ids, author_ids,
    definition_zh, aliases_zh, example_zh, related: [CPT], origin_year

class Work(_Governed):
    id, title_zh, title_en, author_ids, year, publisher, edition, isbn,
    translator_zh, theory_ids, school_ids, language, page_count, note

class Paper(_Governed):
    id, title_zh, title_en, author_ids, year, journal, volume, issue,
    pages, doi, theory_ids, citation_count_approx, note

class Method(_Governed):
    id, name_zh, name_en, kind, school_ids, author_ids, year,
    target_topics, applicable_ages, description_zh, evidence_level

class Topic(_Governed):
    id, name_zh, name_en, category, parent_id, description_zh, related_theories

class Assessment(_Governed):
    id, name_zh, name_en, abbr, kind, author_ids, year, publisher,
    target_topics, admin_years, evidence_level, copyright_status, note

class Ethics(_Governed):
    id, name_zh, name_en, issuing_body, year, jurisdiction,
    supersedes, key_points_zh

class Event(_Governed):
    id, name_zh, name_en, year, place, actors, school_ids,
    significance_zh, related_theories

class Institution(_Governed):
    id, name_zh, name_en, kind, founded_year, disbanded_year,
    location, affiliation_school

class Nation(_Governed):
    id, name_zh, name_en, iso3, flag_region

class Claim(_Governed):       # G4 分歧闸门
    id, title_zh, text_zh, claimant_ids, claimant_kind,
    about_kind, about_ids, stance, year, source_ids,
    confidence, counter_claim_ids
```

---

## 3. 五闸门反幻觉机制

参见 [`backend/app/validate.py`](backend/app/validate.py)。所有对象在进入 Agent 记忆前必须过这五关：

| 闸门 | 名称 | 作用 | 实现 |
| --- | --- | --- | --- |
| **G1** | 模式闸门 | Pydantic 类型、编号正则、字段端点白名单 | `schema.py` + `validate_ids` + `validate_pair_whitelist` |
| **G2** | 归一化闸门 | 跨表引用完整性（FK 不悬空） | `validate_refs` |
| **G3** | 证据闸门 | 外部权威编号（DOI / ISBN / Wikidata Q）格式合法 | `validate_external_ids`（当前预留） |
| **G4** | 分歧闸门 | `Claim.stance` 受控词表；`counter_claim` 双向对称 | `validate_counter_symmetry`（Claim 表增长后启用） |
| **G5** | 外部锚点 | `external_ids` 覆盖率提示（Wikidata/DBpedia/DOI/ORCID） | 覆盖率 < 30% 时 WARN |

**关键约束**：任何字段名若表示外键，必须能在 [`schema.py`](backend/app/ontology/schema.py) 的 `REL_PAIRS` 端点白名单里找到对应组合。未在白名单的 `(source_type, target_type)` 会阻断进入 Agent。

---

## 4. SHACL 形状

见 [`backend/app/ontology/shapes.ttl`](backend/app/ontology/shapes.ttl)（599 行 Turtle）。为每个 Object Type 定义 `NodeShape`：
- 主键 pattern（如 `^SCH[0-9]{2}$`）
- 必需属性（`shacl:requiredProperty`）
- 受控词表（`shacl:in`）：如 `Concept.kind ∈ {心理概念, 心理过程, 心理结构, ...}`
- 属性路径与 Pydantic 字段名严格 snake_case 一致

未来若接入 Protégé / Jena / RDFlib 校验，可直接加载本文件。

---

## 5. 数据管线

```
     CSV (SSOT)
       │
       ▼
   validate.py       ← 五闸门
       │
       ▼
   rebuild_all.py    ← Pydantic 加载 + TTL 序列化 + DuckDB 写入 + 报告
       │
       ├── data/ttl/ontology.ttl     (406 KB)
       ├── data/duckdb/ontology.duckdb
       └── data/report/rebuild_report.md
```

### 5.1 校验

```bash
cd backend
python -m app.validate              # 输出五闸门报告
python -m app.validate --strict     # 警告也视为失败
```

### 5.2 重建

```bash
cd backend
python -m app.rebuild_all           # CSV → TTL + DuckDB + 报告
python -m app.rebuild_all --clean   # 清空 output 后重建
python -m app.rebuild_all --strict  # 严格模式
```

**依赖**：`pydantic>=2.11`；如需 DuckDB：`pip install duckdb`。

---

## 6. 查询示例

### 6.1 内存（Pydantic 对象）

```python
from app.validate import Dataset
ds = Dataset(); ds.load()

# 找精神分析相关的理论
psycho = next(s for s in ds.schools if s.id == "SCH03")
related_theories = [t for t in ds.theories if "SCH03" in t.school_ids]

# 找弗洛伊德的著作
freud = next(p for p in ds.psychologists if p.id == "PSY008")
works = [w for w in ds.works if "PSY008" in w.author_ids]
```

### 6.2 SPARQL（Turtle）

```sparql
PREFIX psy: <https://ontology.agent-psychics.local/ontology#>
SELECT ?title ?year WHERE {
  ?w a psy:Work ;
     psy:title_zh ?title ;
     psy:author_ids psy:Psychologist_PSY008 ;
     psy:year ?year .
}
```

### 6.3 SQL（DuckDB）

```sql
-- 查询所有精神病治疗相关方法
SELECT id, payload->>'name_zh' AS name, payload->>'evidence_level' AS evidence
FROM methods
WHERE payload->>'target_topics' LIKE '%TOP03%';
```

---

## 7. 反幻觉设计（G1-G5 与 Agent 集成）

Agent 在回答心理学问题时按以下顺序做证据校验：

1. **G1 模式**：候选答案涉及的 Object 类型必须存在于 `OBJECT_TYPES`；引用字段必须在 `FIELD_EXPECTED_TYPE` 白名单内。
2. **G2 引用**：回答中出现的 `PSY008` / `THY003` / `WRK001` 必须存在于对应 CSV；否则拒绝输出。
3. **G3 证据**：涉及定量结论（发生率、效应量、置信区间）必须有 `Paper.doi` 或 `external_ids.wikidata` 支撑。
4. **G4 分歧**：如涉及争议性主张（如"精神分析是否科学"），必须同时列出对立方的 Claim，不允许单边陈述。
5. **G5 外部锚点**：回答引用的核心对象若 `external_ids` 为空，需在末尾注明"该条目暂缺外部权威锚点"。

Agent 回答模板见下一节。

---

## 8. Agent 回答模板（占位）

```
[观点] xxxxx
[依据] 理论: THY003 精神分析理论 (Freud, 1899)
       著作: WRK003 梦的解析
       论文: PAP015 DOI:10.xxxx/yyyy
[分歧] Claim CLM001: 反对派观点（Hanson, 1945）
[外部锚点] Wikidata: Q42236 | DOI: 10.xxxx
```

---

## 9. 已知数据质量问题

当前 `python -m app.validate` 报告显示：

- **CSV 列错位**：`schools.csv`（13 行）、`works.csv`（50 行）、`papers.csv`（60 行）、`theories.csv`（68 行）部分行字段数少于 header 列数。validate.py 采用"末尾填空"策略容错，能加载全部对象，但语义上部分字段（如 `founders`）可能错位到 `one_liner_zh` 位置。
- **G1 端点类型错误 332 条**：主要由列错位引发。修复 CSV 后即可清零。
- **G2 悬空引用 6 条**：如 `School.SCH20.founders = PSY084` 但该 ID 未在 Psychologist 表中定义。需要补录或调整引用。
- **G5 外部锚点覆盖率 0%**：CSV 中 `external_ids` 列全部为空。建议后续为至少 30% 的核心对象补齐 Wikidata Q-ID / DOI。
- **Claim 表为空**：G4 分歧机制已就绪，等待第一批分歧主张录入。

修复路径：
1. 用 Excel 打开 CSV，逐行对齐列数
2. 补录缺失的 Psychologist（PSY079、PSY080 等）
3. 为 WRK/PAP 的 doi、wikidata 字段填值
4. 创建 `backend/data/claims.csv`，添加第一批对立观点

---

## 10. 目录结构

```
backend/
├── app/
│   ├── ontology/
│   │   ├── schema.py       # Pydantic Object Types + REL_PAIRS
│   │   ├── shapes.ttl      # SHACL NodeShapes
│   │   └── __init__.py
│   ├── validate.py         # 五闸门校验
│   ├── rebuild_all.py      # 数据管线
│   └── __init__.py
└── data/
    ├── schools.csv / psychologists.csv / ... / nations.csv   # SSOT
    ├── ttl/ontology.ttl          # 派生：RDF
    ├── duckdb/ontology.duckdb    # 派生：SQL
    └── report/rebuild_report.md  # 派生：构建报告
```
