"""心理学本体论（Psychics Ontology）

设计参照 agent-history 的 ontology/schema.py：Pydantic Object Types + REL_PAIRS 端点白名单。
覆盖范围：历史所有主要流派 + 代表心理学家 + 经典著作/论文 + 核心概念 + 临床方法 + 伦理。

Object Types (14):
    School          学派 / 学校（结构主义、精神分析、CBT …）
    Psychologist    心理学家（人物，含生卒、国籍、学派归属）
    Theory          理论（依恋理论、社会学习理论 …）
    Concept         概念（无意识、认知重构 … 细粒度术语）
    Work            著作（书名、出版年、出版社）
    Paper           论文（期刊、卷期、DOI）
    Method          方法/技术（自由联想、认知重构、暴露疗法）
    Topic           应用领域（焦虑、抑郁、创伤、发展、人格）
    Assessment      评估工具（MMPI、BDI、SCL-90 …）
    Ethics          伦理规范（APA 2017、中国心理学会守则 …）
    Event           关键事件（1879 Wundt 实验室、1959 Chomsky 批判 …）
    Institution     机构（Weimar 实验室、Clark Institute …）
    Nation          国家/地区
    Claim           主张/论断（多视角分歧，G4 闸门）

Link Types 见 REL_TYPES；端点组合硬约束见 REL_PAIRS。
"""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Literal, Optional
from pydantic import BaseModel, Field


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# 治理基类：与 agent-history._Governed 同款，所有主对象继承
# ---------------------------------------------------------------------------
class _Governed(BaseModel):
    created_at: str = Field(default_factory=_now)
    updated_at: str = Field(default_factory=_now)
    version: int = 1
    # 外部权威锚点（G5）：wikidata / dbpedia / viaf / orcid / doi / wikipedia_zh
    external_ids: dict[str, str] = Field(default_factory=dict)
    # 知识来源层级：core=权威主干 | seed=内置种子 | book=挂载书 | llm=模型抽取
    provenance: str = "seed"


# ---------------------------------------------------------------------------
# 14 类 Object Types
# ---------------------------------------------------------------------------
class School(_Governed):
    """学派/学校（School of Thought）。"""
    id: str                     # S01..S99
    name_zh: str
    name_en: str
    founded_year: Optional[int] = None
    flourished_start: Optional[int] = None
    flourished_end: Optional[int] = None
    external_ids: dict[str, str] = Field(default_factory=dict)
    region: str = ""            # 欧洲/北美/英国/德国/奥地利…
    paradigm: str = ""          # 主流范式：唯物/唯心/建构/实证/人本/系统/生物
    founders: list[str] = Field(default_factory=list)   # [PSYxxx]
    one_liner_zh: str = ""
    stance_on_mind: str = ""    # 对"心"的立场：还原论/解释论/建构论/系统论
    stance_on_conduct: str = "" # 对"行为"的立场：决定论/自由意志/建构论


class Psychologist(_Governed):
    """心理学家（人物）。"""
    id: str                     # PSY001..PSY999
    name_zh: str
    name_en: str                # 原文/罗马化
    aliases: list[str] = Field(default_factory=list)  # 别名、简称、别译
    birth_year: int
    death_year: Optional[int] = None
    gender: str = "M"           # M / F / X
    nationality: str = ""
    region: str = ""
    affiliation: list[str] = Field(default_factory=list)  # [SCHxx]
    mentor_ids: list[str] = Field(default_factory=list)    # [PSYxxx]
    active_field: list[str] = Field(default_factory=list)  # [TOPxx]
    life_span_text: str = ""    # 精确文本（如 "1856-05-15 ~ 1939-09-23"）
    bio_zh: str = ""            # 生平简介（1-3 段）
    narrative: dict[str, str] = Field(default_factory=dict)  # 分面叙事：student/scholar/clinical 等
    external_ids: dict[str, str] = Field(default_factory=dict)  # 显式声明（继承自 _Governed）


class Theory(_Governed):
    """理论（可归属于多流派）。"""
    id: str                     # THY001..THY999
    name_zh: str
    name_en: str
    school_ids: list[str] = Field(default_factory=list)   # [SCHxx]
    author_ids: list[str] = Field(default_factory=list)   # [PSYxxx]
    year: Optional[int] = None
    work_ids: list[str] = Field(default_factory=list)     # [WRKxxx]
    paper_ids: list[str] = Field(default_factory=list)    # [PAPxxx]
    concept_ids: list[str] = Field(default_factory=list)  # [CPTxxx]
    summary_zh: str = ""
    core_claim_zh: str = ""     # 一句话核心命题
    stance_on_mind: str = ""
    applicability: str = ""     # 适用范围
    external_ids: dict[str, str] = Field(default_factory=dict)


class Concept(_Governed):
    """概念（细粒度术语，含英文对照）。"""
    id: str                     # CPT001..CPT999
    name_zh: str
    name_en: str
    kind: str = "心理概念"      # 心理概念|心理过程|心理结构|心理动力|临床术语|研究方法|发展里程碑
    school_ids: list[str] = Field(default_factory=list)
    theory_ids: list[str] = Field(default_factory=list)
    author_ids: list[str] = Field(default_factory=list)
    definition_zh: str = ""
    aliases_zh: list[str] = Field(default_factory=list)
    example_zh: str = ""
    related: list[str] = Field(default_factory=list)     # [CPTxxx]
    origin_year: Optional[int] = None
    external_ids: dict[str, str] = Field(default_factory=dict)


class Work(_Governed):
    """著作（书）。"""
    id: str                     # WRK001..WRK999
    title_zh: str
    title_en: str
    author_ids: list[str] = Field(default_factory=list)  # [PSYxxx]
    year: Optional[int] = None
    publisher: str = ""
    edition: str = ""
    isbn: str = ""
    translator_zh: str = ""
    theory_ids: list[str] = Field(default_factory=list)
    school_ids: list[str] = Field(default_factory=list)
    language: str = "en"        # en / zh / de / fr / ru
    page_count: Optional[int] = None
    note: str = ""
    external_ids: dict[str, str] = Field(default_factory=dict)


class Paper(_Governed):
    """论文。"""
    id: str                     # PAP001..PAP999
    title_zh: str
    title_en: str
    author_ids: list[str] = Field(default_factory=list)
    year: Optional[int] = None
    journal: str = ""
    volume: str = ""
    issue: str = ""
    pages: str = ""
    doi: str = ""
    theory_ids: list[str] = Field(default_factory=list)
    citation_count_approx: Optional[int] = None
    note: str = ""
    external_ids: dict[str, str] = Field(default_factory=dict)


class Method(_Governed):
    """方法/技术（心理评估法、治疗技术、研究方法）。"""
    id: str                     # MTH001..MTH999
    name_zh: str
    name_en: str
    kind: str = "治疗技术"      # 治疗技术|研究方法|评估方法|测量工具|量表
    school_ids: list[str] = Field(default_factory=list)
    author_ids: list[str] = Field(default_factory=list)
    year: Optional[int] = None
    target_topics: list[str] = Field(default_factory=list)  # [TOPxx]
    applicable_ages: str = ""
    description_zh: str = ""
    evidence_level: str = ""    # I:RCT | II:对照 | III:个案 | IV:专家经验


class Topic(_Governed):
    """应用/主题领域。"""
    id: str                     # TOP01..TOP99
    name_zh: str
    name_en: str
    category: str = ""          # 临床应用|应用领域|研究领域
    parent_id: Optional[str] = None
    description_zh: str = ""
    related_theories: list[str] = Field(default_factory=list)
    external_ids: dict[str, str] = Field(default_factory=dict)


class Assessment(_Governed):
    """评估工具/量表/测验。"""
    id: str                     # ASM001..ASM999
    name_zh: str
    name_en: str
    abbr: str = ""              # 缩写：MMPI / BDI / SCL-90
    kind: str = "量表"          # 量表|测验|访谈|观察|投射
    author_ids: list[str] = Field(default_factory=list)
    year: Optional[int] = None
    publisher: str = ""
    target_topics: list[str] = Field(default_factory=list)
    admin_years: list[str] = Field(default_factory=list)  # ["6-12", "13+"]
    evidence_level: str = ""
    copyright_status: str = "commercial"  # commercial | free | public_domain
    note: str = ""
    external_ids: dict[str, str] = Field(default_factory=dict)


class Ethics(_Governed):
    """伦理规范/守则。"""
    id: str                     # ETH01..ETH99
    name_zh: str
    name_en: str
    issuing_body: str = ""      # APA / 中国心理学会 / BPS / WPA / ICF
    year: Optional[int] = None
    jurisdiction: str = ""
    supersedes: Optional[str] = None
    key_points_zh: list[str] = Field(default_factory=list)


class Event(_Governed):
    """关键事件（学科史脉络）。"""
    id: str                     # EVT001..EVT999
    name_zh: str
    name_en: str
    year: Optional[int] = None
    place: str = ""
    actors: list[str] = Field(default_factory=list)  # [PSYxxx]
    school_ids: list[str] = Field(default_factory=list)
    significance_zh: str = ""
    related_theories: list[str] = Field(default_factory=list)


class Institution(_Governed):
    """机构（实验室、研究所、协会、学会）。"""
    id: str                     # INS001..INS999
    name_zh: str
    name_en: str
    kind: str = "实验室"        # 实验室|研究所|协会|学会|期刊|学院
    founded_year: Optional[int] = None
    disbanded_year: Optional[int] = None
    location: str = ""
    affiliation_school: list[str] = Field(default_factory=list)
    external_ids: dict[str, str] = Field(default_factory=dict)


class Nation(_Governed):
    """国家/地区（用于地理分布统计）。"""
    id: str                     # N01..N99
    name_zh: str
    name_en: str
    iso3: str = ""              # CHN / USA / GBR
    flag_region: str = ""       # 欧洲|北美|东亚|大洋洲|中东


class Claim(_Governed):
    """主张/论断（G4 分歧闸门：多视角并列，不覆盖）。

    用于记录同一议题（理论/概念/事件）下的对立方观点。
    """
    id: str                     # CLM001..CLM999
    title_zh: str
    text_zh: str = ""
    claimant_ids: list[str] = Field(default_factory=list)  # [PSYxxx] or [WKPxxx]
    claimant_kind: str = "person"  # person / book / paper / school
    about_kind: str = "theory"     # theory / concept / event / school / claim
    about_ids: list[str] = Field(default_factory=list)
    stance: str = "评论"         # 肯定|否定|存疑|调和|评论|批评|支持
    year: Optional[int] = None
    source_ids: list[str] = Field(default_factory=list)
    confidence: float = 0.0
    counter_claim_ids: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Link Types 目录（文档层）
# ---------------------------------------------------------------------------
class RelType(BaseModel):
    rel: str
    src: str
    dst: str
    inverse: Optional[str] = None
    transitive: bool = False
    desc: str = ""


def _R(rel: str, src: str, dst: str, inverse: Optional[str] = None,
       transitive: bool = False, desc: str = "") -> RelType:
    return RelType(rel=rel, src=src, dst=dst, inverse=inverse,
                   transitive=transitive, desc=desc)


REL_TYPES: list[RelType] = [
    # ---- 人物 ↔ 组织/学派 ----
    _R("师从", "Psychologist", "Psychologist", inverse="导师",
       desc="学术师承（博士/博士后/访学/正式传承）"),
    _R("弟子", "Psychologist", "Psychologist", inverse="师从",
       desc="师从的反向"),
    _R("隶属学派", "Psychologist", "School", inverse="代表人物",
       desc="人物与学派的归属"),
    _R("创立", "Psychologist", "School", inverse="由...创立"),
    _R("参与", "Psychologist", "Institution", inverse="成员"),

    # ---- 理论 ----
    _R("提出", "Psychologist", "Theory", inverse="提出者"),
    _R("归属", "Theory", "School", inverse="下属理论", transitive=True),
    _R("继承自", "Theory", "Theory", inverse="被继承", transitive=True,
       desc="理论谱系上下游"),
    _R("批评", "Theory", "Theory", inverse="被批评",
       desc="理论间的批评对立"),
    _R("发展出", "Theory", "Theory", inverse="发展为",
       desc="理论演进（如精神分析→客体关系→自体心理学）"),
    _R("整合", "Theory", "Theory", inverse="被整合"),
    _R("包含", "Theory", "Concept", inverse="被包含于",
       desc="理论包含的核心概念"),

    # ---- 概念 ----
    _R("定义", "Concept", "Concept", inverse="被定义于"),
    _R("实例化", "Concept", "Concept", inverse="抽象为", transitive=True),
    _R("对立", "Concept", "Concept", inverse="对立"),
    _R("关联", "Concept", "Concept", inverse="关联"),

    # ---- 著作/论文 ----
    _R("著述", "Psychologist", "Work", inverse="作者"),
    _R("合作", "Psychologist", "Psychologist", inverse="合作"),
    _R("合著", "Psychologist", "Paper", inverse="作者"),
    _R("提出于", "Work", "Theory", inverse="提出于作品"),
    _R("论据", "Paper", "Theory", inverse="论据论文"),
    _R("引用", "Work", "Work", inverse="被引用"),

    # ---- 方法/临床 ----
    _R("采用方法", "School", "Method", inverse="应用于流派"),
    _R("针对", "Method", "Topic", inverse="针对方法"),
    _R("治疗", "Method", "Topic", inverse="被治疗"),
    _R("用于评估", "Assessment", "Topic", inverse="评估对象"),
    _R("依据伦理", "School", "Ethics", inverse="被遵循于"),

    # ---- 事件/机构 ----
    _R("发生", "Event", "Institution", inverse="举办"),
    _R("奠基", "Event", "School", inverse="由...奠基"),
    _R("参与", "Psychologist", "Event", inverse="参与者"),

    # ---- 人物 ↔ 理论/概念 ----
    _R("论述", "Psychologist", "Concept", inverse="被论述"),

    # ---- Claim（G4 分歧）----
    _R("主张", "Claim", "Theory", inverse="被主张"),
    _R("主张", "Claim", "Concept", inverse="被主张"),
    _R("主张", "Claim", "Event", inverse="被主张"),
    _R("反驳", "Claim", "Claim", inverse="被反驳"),
    _R("支持", "Claim", "Claim", inverse="被支持"),
]


# ---------------------------------------------------------------------------
# REL_PAIRS：端点组合硬约束（G1 模式闸门）
# ---------------------------------------------------------------------------
def _pairs_from_rel_types(rel_types: list[RelType]) -> set[tuple[str, str]]:
    pairs: set[tuple[str, str]] = set()
    for t in rel_types:
        pairs.add((t.src, t.dst))
        if t.inverse:
            pairs.add((t.dst, t.src))
    return pairs


REL_PAIRS: set[tuple[str, str]] = _pairs_from_rel_types(REL_TYPES)

# 补充文档层未列出的常用端点组合
REL_PAIRS |= {
    ("Psychologist", "Topic"),
    ("Psychologist", "Method"),
    ("Psychologist", "Assessment"),
    ("Psychologist", "Concept"),
    ("Psychologist", "Event"),
    ("Theory", "Method"),
    ("Theory", "Topic"),
    ("Concept", "Psychologist"),
    ("Concept", "School"),
    ("Work", "School"),
    ("Paper", "School"),
    ("Method", "Psychologist"),
    ("Method", "School"),
    ("Assessment", "Psychologist"),
    ("Institution", "School"),
    ("Institution", "Nation"),
    ("Nation", "Psychologist"),
    ("School", "Topic"),
    ("School", "Method"),
    ("School", "Ethics"),
    ("School", "Institution"),
    ("Work", "Work"),
    ("Paper", "Work"),
    # 自反 / 谱系
    ("Topic", "Topic"),
    ("Topic", "Theory"),
    ("Ethics", "Ethics"),
    ("Event", "Theory"),
    ("Event", "Psychologist"),
    ("Event", "School"),
    ("School", "School"),
    ("Concept", "Concept"),
    ("Psychologist", "Psychologist"),
    ("Claim", "Psychologist"),
    ("Claim", "Theory"),
    ("Claim", "Concept"),
    ("Claim", "Event"),
    ("Claim", "School"),
    ("Claim", "Claim"),
}


OBJECT_TYPES: list[str] = [
    "School", "Psychologist", "Theory", "Concept",
    "Work", "Paper", "Method", "Topic",
    "Assessment", "Ethics", "Event", "Institution",
    "Nation", "Claim",
]
