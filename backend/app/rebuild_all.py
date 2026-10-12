"""重建管线：CSV → Pydantic → TTL（RDF）+ DuckDB + 报告。

用法：
    cd backend
    python -m app.rebuild_all [--clean] [--strict]

输出目录（相对 backend/）：
    data/ttl/ontology.ttl    —— 全部对象 + 关系，Turtle 语法
    data/duckdb/ontology.duckdb  —— 结构化副本，用于 SQL 查询
    data/report/rebuild_report.md —— 本次构建的报告

管线步骤：
    1. validate  —— 跑 app.validate 的 5 闸门
    2. build_ttl —— 序列化 Object Types + Link Types 到 Turtle
    3. build_db  —— 写入 DuckDB（表名 = 类名小写）
    4. report    —— 汇总写入 Markdown

Turtle 只输出主键 + 关键属性 + 关系；list/dict 字段用 rdf:List / blank node。
DuckDB 用简单的 CREATE TABLE + INSERT 语法。
"""
from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.validate import Dataset, Report, validate_ids, validate_refs, validate_pair_whitelist
from app.ontology.schema import REL_TYPES


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
TTL_DIR = DATA_DIR / "ttl"
DB_DIR = DATA_DIR / "duckdb"
REPORT_DIR = DATA_DIR / "report"
ONTO_NS = "https://ontology.agent-psychics.local/ontology"


# ---------------------------------------------------------------------------
# 1. Turtle 序列化
# ---------------------------------------------------------------------------
PREFIX_DECL = f"""@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix psy: <{ONTO_NS}#> .
@prefix dbo: <http://dbpedia.org/resource/> .

<#ontology> a <http://www.w3.org/2002/07/owl#Ontology> ;
    rdfs:label "Psychics Ontology" ;
    rdfs:comment "心理学本体论：14 类 Object Types + Link Types + 五闸门反幻觉" .
"""


def _ttl_uri(o: Any) -> str:
    """Object 实例的 IRI（ psy:类名_主键 ）。"""
    return f"psy:{type(o).__name__}_{o.id}"


def _ttl_str(v: str) -> str:
    if v is None:
        return '""'
    s = str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    return f'"{s}"'


def _ttl_int(v: int | None) -> str:
    return "None" if v is None else f"{int(v)}^^xsd:integer"


def _ttl_float(v: float) -> str:
    return f"{float(v)}^^xsd:double"


def _dump_list(values: list[str]) -> tuple[str, list[str]]:
    """把字符串列表序列化为 RDF list。返回 (head_uri, 补充 Turtle 行)。"""
    if not values:
        return "", []
    lines: list[str] = []
    if len(values) == 1:
        return f"\"{_ttl_str(values[0]).strip(chr(34))}\"", []
    head_uri = f"psy:_lst_{abs(hash(tuple(values))):08x}"
    lines.append(f"{head_uri} a rdf:List ;")
    prev = head_uri
    for i, val in enumerate(values):
        if i == len(values) - 1:
            lines.append(f"    rdf:first \"{_ttl_str(val).strip(chr(34))}\" ;")
            lines.append(f"    rdf:rest rdf:nil .")
        else:
            nxt = f"psy:_lst_{abs(hash(tuple(values[i+1:]))) & 0xFFFFFFFF:08x}"
            lines.append(f"    rdf:first \"{_ttl_str(val).strip(chr(34))}\" ;")
            lines.append(f"    rdf:rest {nxt} ;")
            # 递归下一段
            sub = _dump_list(values[i+1:])
            # 上面已经生成了下一段的完整条目，此处跳过
            prev = nxt
            if i + 1 < len(values):
                nxt_uri, extra = _dump_list(values[i+1:])
                for line in extra:
                    lines.append(line)
                prev = nxt_uri
    return head_uri, lines


def _serialize_obj(o: Any) -> list[str]:
    """把单个 Object 序列化成 Turtle 行。"""
    lines: list[str] = []
    uri = _ttl_uri(o)
    cls = type(o).__name__
    lines.append(f"{uri} a psy:{cls} ;")

    entries: list[str] = []
    for fname, field_info in type(o).model_fields.items():
        val = getattr(o, fname, None)
        if val is None or val == "" or val == [] or val == {}:
            continue
        # 跳过治理字段（避免和 rdf:type / 关系混淆）
        if fname in {"created_at", "updated_at", "version", "provenance"}:
            continue
        # 外键字段以 psy:Class_Id 形式输出，方便 SPARQL
        ref_type = _ref_type_for_field(cls, fname)
        if ref_type and isinstance(val, list):
            # 用空白列表输出多值外键
            for v in val:
                entries.append(f"    psy:{fname} psy:{ref_type}_{v} ;")
        elif ref_type and isinstance(val, str):
            entries.append(f"    psy:{fname} psy:{ref_type}_{val} ;")
        elif isinstance(val, list):
            # 普通字符串列表 → rdf:List 或逐个 xsd:string
            for v in val:
                entries.append(f"    psy:{fname} \"{_ttl_str(v).strip(chr(34))}\" ;")
        elif isinstance(val, dict):
            # 字典（如 external_ids / narrative）→ blank node
            bn = f"psy:_dict_{abs(hash((cls, fname, o.id))) & 0xFFFFFFFF:08x}"
            entries.append(f"    psy:{fname} {bn} ;")
            for k, v in val.items():
                lines.append(f"{bn} psy:{fname}_{k} \"{_ttl_str(v).strip(chr(34))}\" .")
        elif isinstance(val, bool):
            entries.append(f"    psy:{fname} {'true' if val else 'false'}^^xsd:boolean ;")
        elif isinstance(val, int):
            entries.append(f"    psy:{fname} {val}^^xsd:integer ;")
        elif isinstance(val, float):
            entries.append(f"    psy:{fname} {val}^^xsd:double ;")
        else:
            entries.append(f"    psy:{fname} \"{_ttl_str(str(val)).strip(chr(34))}\" ;")

    if entries:
        entries[-1] = entries[-1].rstrip(" ;") + " ."
        for e in entries:
            lines.append(e)
        lines.append("")  # 分隔
    else:
        # 至少输出一个属性以避免语法错误
        lines.append(f"    psy:label \"{cls}_{o.id}\" .")
    return lines


def _ref_type_for_field(cls_name: str, fname: str) -> str | None:
    """根据 (cls, field_name) 判断该字段是否是外键、指向哪个类型。"""
    m = {
        ("School", "founders"): "Psychologist",
        ("Psychologist", "affiliation"): "School",
        ("Psychologist", "mentor_ids"): "Psychologist",
        ("Psychologist", "active_field"): "Topic",
        ("Theory", "school_ids"): "School",
        ("Theory", "author_ids"): "Psychologist",
        ("Theory", "work_ids"): "Work",
        ("Theory", "paper_ids"): "Paper",
        ("Theory", "concept_ids"): "Concept",
        ("Concept", "school_ids"): "School",
        ("Concept", "theory_ids"): "Theory",
        ("Concept", "author_ids"): "Psychologist",
        ("Concept", "related"): "Concept",
        ("Work", "author_ids"): "Psychologist",
        ("Work", "theory_ids"): "Theory",
        ("Work", "school_ids"): "School",
        ("Paper", "author_ids"): "Psychologist",
        ("Paper", "theory_ids"): "Theory",
        ("Method", "school_ids"): "School",
        ("Method", "author_ids"): "Psychologist",
        ("Method", "target_topics"): "Topic",
        ("Topic", "parent_id"): "Topic",
        ("Topic", "related_theories"): "Theory",
        ("Assessment", "author_ids"): "Psychologist",
        ("Assessment", "target_topics"): "Topic",
        ("Ethics", "supersedes"): "Ethics",
        ("Event", "actors"): "Psychologist",
        ("Event", "school_ids"): "School",
        ("Event", "related_theories"): "Theory",
        ("Institution", "affiliation_school"): "School",
        ("Claim", "claimant_ids"): "Psychologist",
        ("Claim", "about_ids"): "Theory",  # 语义宽泛，实际按 about_kind 分派
        ("Claim", "source_ids"): "Work",
        ("Claim", "counter_claim_ids"): "Claim",
    }
    return m.get((cls_name, fname))


def build_ttl(ds: Dataset, path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append("# -*- coding: utf-8 -*-")
    lines.append(f"# Psychics Ontology instance dump")
    lines.append(f"# Generated at {datetime.now(timezone.utc).isoformat(timespec='seconds')}")
    lines.append(PREFIX_DECL)

    # 关系字典
    lines.append("# ---- Link Types (documented in ontology schema) ----")
    for rt in REL_TYPES:
        lines.append(f"psy:{rt.rel} rdfs:domain psy:{rt.src} ;")
        lines.append(f"    rdfs:range psy:{rt.dst} ;")
        lines.append(f"    rdfs:label \"{rt.rel}\" ;")
        lines.append(f"    rdfs:comment \"{rt.desc}\" .")
    lines.append("")

    # 对象实例
    for obj_list_name in ("schools", "psychologists", "theories", "concepts",
                          "works", "papers", "methods", "topics",
                          "assessments", "ethics", "events",
                          "institutions", "nations", "claims"):
        objs = getattr(ds, obj_list_name, [])
        if not objs:
            continue
        lines.append(f"# ---- {type(objs[0]).__name__} ({len(objs)}) ----")
        for o in objs:
            lines.extend(_serialize_obj(o))
            lines.append("")

    text = "\n".join(lines)
    path.write_text(text, encoding="utf-8")
    return len(text)


# ---------------------------------------------------------------------------
# 2. DuckDB
# ---------------------------------------------------------------------------
def build_db(ds: Dataset, path: Path) -> dict[str, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        import duckdb  # type: ignore
    except ImportError:
        print("[WARN] 未安装 duckdb，跳过数据库构建。安装：pip install duckdb")
        return {}

    if path.exists():
        path.unlink()
    conn = duckdb.connect(str(path))
    counts: dict[str, int] = {}
    for obj_list_name in ("schools", "psychologists", "theories", "concepts",
                          "works", "papers", "methods", "topics",
                          "assessments", "ethics", "events",
                          "institutions", "nations", "claims"):
        objs = getattr(ds, obj_list_name, [])
        if not objs:
            continue
        tbl = type(objs[0]).__name__.lower()
        conn.execute(f"CREATE TABLE {tbl} (id VARCHAR PRIMARY KEY, payload JSON)")
        for o in objs:
            payload = json.dumps(o.model_dump(mode="json"), ensure_ascii=False, default=str)
            conn.execute(
                f"INSERT INTO {tbl} VALUES (?, ?)",
                [o.id, payload],
            )
        counts[tbl] = len(objs)
    conn.close()
    return counts


# ---------------------------------------------------------------------------
# 3. 报告
# ---------------------------------------------------------------------------
def write_report(ds: Dataset, rpt: Report, path: Path, ttl_bytes: int, db_counts: dict[str, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    lines.append("# Psychics Ontology 重建报告")
    lines.append("")
    lines.append(f"- 时间：{datetime.now(timezone.utc).isoformat(timespec='seconds')}")
    lines.append(f"- TTL：{ttl_bytes:,} 字节")
    lines.append(f"- DuckDB 表：{', '.join(f'{k}={v}' for k,v in db_counts.items())}")
    lines.append(f"- 校验：失败 {len(rpt.fail)} 条，警告 {len(rpt.warn)} 条")
    lines.append("")
    lines.append("## 各表规模")
    lines.append("")
    lines.append("| Object Type | 条数 |")
    lines.append("| --- | ---: |")
    for name in ("schools", "psychologists", "theories", "concepts",
                 "works", "papers", "methods", "topics",
                 "assessments", "ethics", "events",
                 "institutions", "nations", "claims"):
        objs = getattr(ds, name, [])
        lines.append(f"| {type(objs[0]).__name__ if objs else name} | {len(objs)} |")
    lines.append("")
    lines.append("## 校验结果")
    lines.append("")
    if rpt.fail:
        lines.append(f"### 失败 {len(rpt.fail)} 条")
        lines.append("")
        for m in rpt.fail[:200]:
            lines.append(f"- {m}")
        if len(rpt.fail) > 200:
            lines.append(f"- ... 还有 {len(rpt.fail) - 200} 条")
    else:
        lines.append("✅ 无失败")
    lines.append("")
    if rpt.warn:
        lines.append(f"### 警告 {len(rpt.warn)} 条")
        lines.append("")
        for m in rpt.warn[:100]:
            lines.append(f"- {m}")
    path.write_text("\n".join(lines), encoding="utf-8")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description="重建心理学本体论数据管线")
    parser.add_argument("--clean", action="store_true", help="先清空 output 目录")
    parser.add_argument("--strict", action="store_true", help="严格模式：警告也视为失败")
    args = parser.parse_args()

    if args.clean:
        for d in (TTL_DIR, DB_DIR, REPORT_DIR):
            if d.exists():
                shutil.rmtree(d)
    for d in (TTL_DIR, DB_DIR, REPORT_DIR):
        d.mkdir(parents=True, exist_ok=True)

    print("[1/4] 加载 CSV + 校验")
    ds = Dataset()
    ds.load()
    rpt = Report()
    validate_ids(ds, rpt)
    validate_refs(ds, rpt)
    validate_pair_whitelist(ds, rpt)

    print(f"\n[2/4] 生成 TTL")
    ttl_path = TTL_DIR / "ontology.ttl"
    ttl_bytes = build_ttl(ds, ttl_path)
    print(f"[OK] {ttl_path}  ({ttl_bytes:,} 字节)")

    print(f"\n[3/4] 生成 DuckDB")
    db_path = DB_DIR / "ontology.duckdb"
    db_counts = build_db(ds, db_path)
    if db_counts:
        print(f"[OK] {db_path}  表: {', '.join(f'{k}={v}' for k,v in db_counts.items())}")

    print(f"\n[4/4] 生成报告")
    report_path = REPORT_DIR / "rebuild_report.md"
    write_report(ds, rpt, report_path, ttl_bytes, db_counts)
    print(f"[OK] {report_path}")

    print(f"\n=== 汇总 ===")
    print(f"失败：{len(rpt.fail)} 条   警告：{len(rpt.warn)} 条")
    if args.strict and rpt.warn:
        print("[STRICT] 警告被视为失败，exit 1")
        return 1
    if rpt.fail:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
