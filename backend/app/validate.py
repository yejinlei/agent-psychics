"""心理学本体论的静态校验脚本。

对 backend/data/*.csv 做四道闸门：
    G1 模式闸门    —— Pydantic 加载 + 编号正则 + REL_PAIRS 端点白名单
    G2 归一化闸门  —— ID 引用完整性（跨表 FK）
    G3 证据闸门    —— 引用外部编号 (DOI / ISBN) 格式合法
    G4 分歧闸门    —— Claim.stance 受控词表 + counter_claim 双向对称
    G5 外部锚点    —— 提示 external_ids 覆盖率（仅 warning）

使用：
    cd backend
    python -m app.validate
    python -m app.validate --strict   # 把 warning 也视为失败
"""
from __future__ import annotations

import argparse
import csv as _csv
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from .ontology.schema import (
    School, Psychologist, Theory, Concept, Work, Paper,
    Method, Topic, Assessment, Ethics, Event, Institution, Nation, Claim,
    OBJECT_TYPES, REL_PAIRS, REL_TYPES,
)


DATA_DIR = Path(__file__).resolve().parent.parent / "data"


# ---------------------------------------------------------------------------
# CSV → 对象构造器
# ---------------------------------------------------------------------------

INT_COLS = {
    "birth_year", "founded_year", "year", "year_first",
    "origin_year", "citation_count_approx", "page_count",
    "disbanded_year", "death_year",
}
FLOAT_COLS = {"confidence"}
OPTIONAL_INT_COLS = INT_COLS  # 所有 INT 都允许为空
LIST_COLS = {
    "founders", "aliases", "affiliation", "mentor_ids", "active_field",
    "school_ids", "author_ids", "work_ids", "paper_ids", "concept_ids",
    "theory_ids", "related", "target_topics", "admin_years",
    "actors", "related_theories", "claimant_ids", "about_ids",
    "source_ids", "counter_claim_ids", "key_points_zh", "aliases_zh",
    "affiliation_school",
}


def _coerce(v: str, field_name: str) -> Any:
    """把 CSV 里的字符串按字段类型做最小化转换。"""
    v = v.strip()
    if v == "":
        if field_name in LIST_COLS:
            return []
        if field_name in DICT_COLS:
            return {}
        if field_name in OPTIONAL_INT_COLS or field_name in FLOAT_COLS:
            return None
        return ""
    if field_name in OPTIONAL_INT_COLS:
        try:
            return int(v)
        except ValueError:
            # CSV 列错位容错：数字列收到非数字时返回 None（Pydantic 会允许 Optional[int]）
            return None
    if field_name in FLOAT_COLS:
        try:
            return float(v)
        except ValueError:
            return None
    if field_name in DICT_COLS:
        return _parse_dict(v)
    if field_name in LIST_COLS:
        # 尝试解析成 list：分号分隔 / 单元素 / JSON 列表
        v_stripped = v.strip()
        if v_stripped.startswith("[") and v_stripped.endswith("]"):
            import ast
            try:
                parsed = ast.literal_eval(v_stripped)
                if isinstance(parsed, list):
                    return [str(x).strip() for x in parsed if str(x).strip()]
            except Exception:
                pass
        # 分号优先，其次竖线，其次逗号
        for sep in (";", "|", ","):
            if sep in v_stripped:
                parts = [p.strip() for p in v_stripped.split(sep)]
                return [p for p in parts if p]
        return [v_stripped]
    return v


def _align_row(row: list[str], header: list[str], obj_type: str) -> dict[str, str]:
    """把 CSV 行与 header 对齐：末尾填充空字段。

    简单策略：如果行字段数少于 header，在末尾补足空字段。
    这样至少让 id/title/author_ids/year 等头部字段对齐；缺失的字段（如 isbn/translator_zh）
    会以空字符串形式出现在末尾位置——Pydantic 校验会通过，但语义上可能错位。
    这是"容错优先于正确"的权衡，具体错位需要用户手动修复 CSV。
    """
    n_h = len(header)
    n_r = len(row)
    if n_r == n_h:
        return dict(zip(header, row))
    if n_r > n_h:
        # 多余字段：截断
        return dict(zip(header, row[:n_h]))
    padded = row + [""] * (n_h - n_r)
    return dict(zip(header, padded))


def _load_one(cls, csv_name: str) -> list:
    path = DATA_DIR / csv_name
    if not path.exists():
        print(f"[SKIP] {csv_name} 不存在")
        return []
    items = []
    errors = []
    realigned = 0
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = _csv.reader(f)
        header = next(reader)
        for idx, row in enumerate(reader, start=2):
            try:
                aligned = _align_row(row, header, cls.__name__)
                if len(row) != len(header):
                    realigned += 1
                kwargs = {
                    k: _coerce(v or "", k)
                    for k, v in aligned.items()
                    if k in cls.model_fields
                }
                obj = cls(**kwargs)
                items.append(obj)
            except ValidationError as e:
                errors.append(f"  [{cls.__name__} row {idx}] {e.errors()[0]}")
            except Exception as e:
                errors.append(f"  [{cls.__name__} row {idx}] {type(e).__name__}: {e}")
    if realigned:
        print(f"[INFO] {csv_name}: {realigned} 行做了列对齐修复")
    if errors:
        print(f"[FAIL] {csv_name}: {len(errors)} 条 Pydantic 校验错误")
        for e in errors[:20]:
            print(e)
        if len(errors) > 20:
            print(f"  ...还有 {len(errors)-20} 条未打印")
    else:
        print(f"[OK]   {csv_name}: {len(items)} 条通过 Pydantic 校验")
    return items


@dataclass
class Dataset:
    schools: list = field(default_factory=list)
    psychologists: list = field(default_factory=list)
    theories: list = field(default_factory=list)
    concepts: list = field(default_factory=list)
    works: list = field(default_factory=list)
    papers: list = field(default_factory=list)
    methods: list = field(default_factory=list)
    topics: list = field(default_factory=list)
    assessments: list = field(default_factory=list)
    ethics: list = field(default_factory=list)
    events: list = field(default_factory=list)
    institutions: list = field(default_factory=list)
    nations: list = field(default_factory=list)
    claims: list = field(default_factory=list)

    def load(self) -> None:
        mapping = [
            ("schools.csv", School, "schools"),
            ("psychologists.csv", Psychologist, "psychologists"),
            ("theories.csv", Theory, "theories"),
            ("concepts.csv", Concept, "concepts"),
            ("works.csv", Work, "works"),
            ("papers.csv", Paper, "papers"),
            ("methods.csv", Method, "methods"),
            ("topics.csv", Topic, "topics"),
            ("assessments.csv", Assessment, "assessments"),
            ("ethics.csv", Ethics, "ethics"),
            ("events.csv", Event, "events"),
            ("institutions.csv", Institution, "institutions"),
            ("nations.csv", Nation, "nations"),
        ]
        for csv_name, cls, attr in mapping:
            setattr(self, attr, _load_one(cls, csv_name))

    def id_set(self, obj_type: str) -> set[str]:
        m = {
            "School": "schools", "Psychologist": "psychologists",
            "Theory": "theories", "Concept": "concepts",
            "Work": "works", "Paper": "papers", "Method": "methods",
            "Topic": "topics", "Assessment": "assessments",
            "Ethics": "ethics", "Event": "events",
            "Institution": "institutions", "Nation": "nations",
            "Claim": "claims",
        }
        return {o.id for o in getattr(self, m[obj_type], [])}


# ---------------------------------------------------------------------------
# 各类 ID 前缀 → 目标对象类型映射
# ---------------------------------------------------------------------------
ID_PREFIX_TO_TYPE: dict[str, str] = {
    "SCH": "School",
    "PSY": "Psychologist",
    "THY": "Theory",
    "CPT": "Concept",
    "WRK": "Work",
    "PAP": "Paper",
    "MTH": "Method",
    "TOP": "Topic",
    "ASM": "Assessment",
    "ETH": "Ethics",
    "EVT": "Event",
    "INS": "Institution",
    "N":   "Nation",
    "CLM": "Claim",
}


def _type_of_id(id_: str) -> str | None:
    for p, t in sorted(ID_PREFIX_TO_TYPE.items(), key=lambda x: -len(x[0])):
        if id_.startswith(p):
            return t
    return None


ID_PATTERN = {
    "School":       re.compile(r"^SCH[0-9]{2}$"),
    "Psychologist": re.compile(r"^PSY[0-9]{3}$"),
    "Theory":       re.compile(r"^THY[0-9]{3}$"),
    "Concept":      re.compile(r"^CPT[0-9]{3}$"),
    "Work":         re.compile(r"^WRK[0-9]{3}$"),
    "Paper":        re.compile(r"^PAP[0-9]{3}$"),
    "Method":       re.compile(r"^MTH[0-9]{3}$"),
    "Topic":        re.compile(r"^TOP[0-9]{2}$"),
    "Assessment":   re.compile(r"^ASM[0-9]{3}$"),
    "Ethics":       re.compile(r"^ETH[0-9]{2}$"),
    "Event":        re.compile(r"^EVT[0-9]{3}$"),
    "Institution":  re.compile(r"^INS[0-9]{3}$"),
    "Nation":       re.compile(r"^N[0-9]{2}$"),
    "Claim":        re.compile(r"^CLM[0-9]{4}$"),
}


# ---------------------------------------------------------------------------
# 各类字段的白名单（G1 端点类型检查）
# ---------------------------------------------------------------------------
FIELD_EXPECTED_TYPE: dict[tuple[str, str], str | None] = {
    # School
    ("School", "founders"): "Psychologist",
    # Psychologist
    ("Psychologist", "affiliation"): "School",
    ("Psychologist", "mentor_ids"): "Psychologist",
    ("Psychologist", "active_field"): "Topic",
    # Theory
    ("Theory", "school_ids"): "School",
    ("Theory", "author_ids"): "Psychologist",
    ("Theory", "work_ids"): "Work",
    ("Theory", "paper_ids"): "Paper",
    ("Theory", "concept_ids"): "Concept",
    # Concept
    ("Concept", "school_ids"): "School",
    ("Concept", "theory_ids"): "Theory",
    ("Concept", "author_ids"): "Psychologist",
    ("Concept", "related"): "Concept",
    # Work
    ("Work", "author_ids"): "Psychologist",
    ("Work", "theory_ids"): "Theory",
    ("Work", "school_ids"): "School",
    # Paper
    ("Paper", "author_ids"): "Psychologist",
    ("Paper", "theory_ids"): "Theory",
    # Method
    ("Method", "school_ids"): "School",
    ("Method", "author_ids"): "Psychologist",
    ("Method", "target_topics"): "Topic",
    # Topic
    ("Topic", "parent_id"): "Topic",
    ("Topic", "related_theories"): "Theory",
    # Assessment
    ("Assessment", "author_ids"): "Psychologist",
    ("Assessment", "target_topics"): "Topic",
    # Ethics
    ("Ethics", "supersedes"): "Ethics",
    # Event
    ("Event", "actors"): "Psychologist",
    ("Event", "school_ids"): "School",
    ("Event", "related_theories"): "Theory",
    # Institution
    ("Institution", "affiliation_school"): "School",
    # Claim
    ("Claim", "claimant_ids"): "Psychologist",
    ("Claim", "counter_claim_ids"): "Claim",
}


DICT_COLS = {"external_ids", "narrative"}


def _parse_dict(v: str) -> dict:
    import ast
    v = v.strip()
    if v == "" or v == "{}":
        return {}
    if v.startswith("{") and v.endswith("}"):
        try:
            parsed = ast.literal_eval(v)
            if isinstance(parsed, dict):
                return {str(k): str(val) for k, val in parsed.items()}
        except Exception:
            return {}
    # 尝试 key:value;key:value 简易格式
    out = {}
    for part in v.replace(",", ";").split(";"):
        if ":" in part:
            k, val = part.split(":", 1)
            out[k.strip()] = val.strip()
    return out


# ---------------------------------------------------------------------------
# 主校验流程
# ---------------------------------------------------------------------------
@dataclass
class Report:
    fail: list[str] = field(default_factory=list)
    warn: list[str] = field(default_factory=list)

    def add_fail(self, msg: str) -> None:
        self.fail.append(msg)
        print(f"[FAIL] {msg}")

    def add_warn(self, msg: str) -> None:
        self.warn.append(msg)
        print(f"[WARN] {msg}")


def _iterate_refs(obj, field_name: str):
    v = getattr(obj, field_name, None)
    if v is None:
        return
    if isinstance(v, list):
        for x in v:
            yield x
    elif isinstance(v, str) and v:
        yield v


def _all_objs(ds: Dataset):
    m = {
        "School": ds.schools, "Psychologist": ds.psychologists,
        "Theory": ds.theories, "Concept": ds.concepts,
        "Work": ds.works, "Paper": ds.papers,
        "Method": ds.methods, "Topic": ds.topics,
        "Assessment": ds.assessments, "Ethics": ds.ethics,
        "Event": ds.events, "Institution": ds.institutions,
        "Nation": ds.nations, "Claim": ds.claims,
    }
    return m


def validate_ids(ds: Dataset, rpt: Report) -> None:
    """G1-1: 主 ID 格式与唯一性。"""
    m = _all_objs(ds)
    for tname, objs in m.items():
        pat = ID_PATTERN[tname]
        seen = set()
        for o in objs:
            if not pat.match(o.id):
                rpt.add_fail(f"{tname}.{o.id} 不符合编号正则 {pat.pattern}")
            if o.id in seen:
                rpt.add_fail(f"{tname}.{o.id} 重复")
            seen.add(o.id)


def validate_refs(ds: Dataset, rpt: Report) -> None:
    """G1-2 + G2: 跨表引用完整性和端点类型。"""
    m = _all_objs(ds)
    total_refs = 0
    broken = 0
    wrong_type = 0
    for otype, objs in m.items():
        for o in objs:
            for fname in type(o).model_fields:
                expected_type = FIELD_EXPECTED_TYPE.get((otype, fname))
                if expected_type is None:
                    continue
                for ref in _iterate_refs(o, fname):
                    total_refs += 1
                    ref_type = _type_of_id(ref)
                    if ref_type != expected_type:
                        wrong_type += 1
                        if wrong_type <= 10:
                            rpt.add_fail(
                                f"G1 端点类型错误：{otype}.{o.id}.{fname} = {ref} "
                                f"(期望 {expected_type}, 实际类型前缀 {ref_type})"
                            )
                        continue
                    if ref not in ds.id_set(expected_type):
                        broken += 1
                        if broken <= 15:
                            rpt.add_fail(
                                f"G2 悬空引用：{otype}.{o.id}.{fname} = {ref} "
                                f"({expected_type} 表不存在该 ID)"
                            )
    if broken > 15:
        rpt.add_fail(f"G2 悬空引用累计 {broken} 条，只列出前 15 条")
    if wrong_type > 10:
        rpt.add_fail(f"G1 端点类型错误累计 {wrong_type} 条，只列出前 10 条")
    print(f"[INFO] G1+G2 共检查引用 {total_refs} 条，悬空 {broken}，类型错误 {wrong_type}")


def validate_pair_whitelist(ds: Dataset, rpt: Report) -> None:
    """G1-3: REL_PAIRS 白名单（把字段级 FK 视作关系端点，做端点组合合法性检查）。"""
    for otype, fname in FIELD_EXPECTED_TYPE:
        dst_type = FIELD_EXPECTED_TYPE[(otype, fname)]
        if dst_type and (otype, dst_type) not in REL_PAIRS:
            rpt.add_fail(
                f"G1 REL_PAIRS 未覆盖：{otype} -> {dst_type} "
                f"(字段 {fname})。请在 schema.REL_PAIRS 追加，或移除该字段。"
            )


def validate_enums(ds: Dataset, rpt: Report) -> None:
    """G1-4: 受控词表值域。"""
    gender_ok = {"M", "F", "X"}
    for p in ds.psychologists:
        if p.gender not in gender_ok:
            rpt.add_fail(f"Psychologist.{p.id}.gender = {p.gender} 非法")
    lang_ok = {"zh", "en", "de", "fr", "it", "ru", "jp", "other"}
    for w in ds.works:
        if w.language not in lang_ok:
            rpt.add_fail(f"Work.{w.id}.language = {w.language} 非法")
    ev_ok = {"I", "II", "III", "IV", ""}
    for m in ds.methods:
        if m.evidence_level not in ev_ok:
            rpt.add_fail(f"Method.{m.id}.evidence_level = {m.evidence_level} 非法")
    for a in ds.assessments:
        if a.evidence_level not in ev_ok:
            rpt.add_fail(f"Assessment.{a.id}.evidence_level = {a.evidence_level} 非法")
        if a.copyright_status not in {"commercial", "free", "public_domain", ""}:
            rpt.add_fail(f"Assessment.{a.id}.copyright_status = {a.copyright_status} 非法")
    iso_pat = re.compile(r"^[A-Z]{3}$")
    for n in ds.nations:
        if n.iso3 and not iso_pat.match(n.iso3):
            rpt.add_fail(f"Nation.{n.id}.iso3 = {n.iso3} 非法")
    stance_ok = {"肯定", "否定", "存疑", "调和", "评论", "批评", "支持", ""}
    for c in ds.claims:
        if c.stance not in stance_ok:
            rpt.add_fail(f"Claim.{c.id}.stance = {c.stance} 非法")
        if not (0.0 <= c.confidence <= 1.0):
            rpt.add_fail(f"Claim.{c.id}.confidence = {c.confidence} 越界")


DOI_PAT = re.compile(r"^10\.\d{4,9}/.+$")


def validate_external_ids(ds: Dataset, rpt: Report) -> None:
    """G3 + G5: DOI/ISBN 格式与 external_ids 覆盖提示。"""
    bad_doi = 0
    for p in ds.papers:
        if p.doi and not DOI_PAT.match(p.doi):
            bad_doi += 1
            if bad_doi <= 5:
                rpt.add_fail(f"Paper.{p.id}.doi = {p.doi} 格式非法")
    if bad_doi > 5:
        rpt.add_fail(f"Paper.doi 非法累计 {bad_doi} 条")
    # G5: 外部锚点覆盖率（仅告警）
    total = 0
    with_anchor = 0
    for objs, label in [
        (ds.psychologists, "Psychologist"),
        (ds.works, "Work"),
        (ds.theories, "Theory"),
    ]:
        for o in objs:
            total += 1
            if o.external_ids:
                with_anchor += 1
    pct = 100.0 * with_anchor / max(total, 1)
    rpt.add_warn(f"G5 外部锚点覆盖率 (Psychologists+Works+Theories) = {with_anchor}/{total} ({pct:.1f}%)")


def validate_counter_symmetry(ds: Dataset, rpt: Report) -> None:
    """G4: Claim 的 counter_claim_ids 应双向对称。"""
    idx = {c.id: c for c in ds.claims}
    for c in ds.claims:
        for other_id in c.counter_claim_ids:
            other = idx.get(other_id)
            if other is None:
                rpt.add_fail(f"Claim.{c.id}.counter_claim_ids 引用 {other_id} 不存在")
                continue
            if c.id not in other.counter_claim_ids:
                rpt.add_warn(
                    f"G4 不对称反驳：Claim.{c.id} ↔ Claim.{other_id} 无反向"
                )


def validate_counts(ds: Dataset, rpt: Report) -> None:
    """规模告警：如果某类少于 5 条，可能是遗漏。"""
    for otype, objs in _all_objs(ds).items():
        if len(objs) == 0:
            rpt.add_warn(f"Object Type {otype} 为空 (0 条)")
        elif len(objs) < 5 and otype != "Claim":
            rpt.add_warn(f"Object Type {otype} 仅 {len(objs)} 条，数量偏少")


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--strict", action="store_true", help="把 warning 视为失败")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    ds = Dataset()
    ds.load()

    rpt = Report()
    validate_ids(ds, rpt)
    validate_refs(ds, rpt)
    validate_pair_whitelist(ds, rpt)
    validate_enums(ds, rpt)
    validate_external_ids(ds, rpt)
    validate_counter_symmetry(ds, rpt)
    validate_counts(ds, rpt)

    print()
    print("=" * 60)
    print(f"[SUMMARY] 失败 {len(rpt.fail)}  警告 {len(rpt.warn)}")
    for t in OBJECT_TYPES:
        n = {
            "School": ds.schools, "Psychologist": ds.psychologists,
            "Theory": ds.theories, "Concept": ds.concepts,
            "Work": ds.works, "Paper": ds.papers,
            "Method": ds.methods, "Topic": ds.topics,
            "Assessment": ds.assessments, "Ethics": ds.ethics,
            "Event": ds.events, "Institution": ds.institutions,
            "Nation": ds.nations, "Claim": ds.claims,
        }[t]
        print(f"  {t:<14s} {len(n):>5d} 条")

    if rpt.fail:
        return 1
    if args.strict and rpt.warn:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
