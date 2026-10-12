# -*- coding: utf-8 -*-
r"""教案生成脚本（孔孟智能体 · 备课 Agent 生成脚本）
=====================================================
职责：
  1) 教案 Markdown 质量硬校验（validate_lesson_plan）：
     - 十大板块齐备（课标依据/学情分析/教学目标/重难点/教学过程/例题与变式/
       分层作业/板书设计/教学反思/数据使用说明），另查「评价设计」加分项；
     - 篇幅 ≥3000 字；学情分析必须包含真实数据引用（百分数或"掌握率"）；
     - 教学过程各环节 ≥80 字；禁止占位性表述（"略""此处讲解""（占位）"等）。
  2) 渲染为 docx（复用 workflow._export_docx：中文字体＋标题样式＋md 转换），
     并产出逐项质量评分。

CLI：python lesson_plan_writer.py <plan.md> <out.docx>
"""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Any, Dict, List

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

REQUIRED_SECTIONS = {
    "课标依据": "课标依据与教材分析",
    "学情分析": "学情分析",
    "教学目标": "教学目标",
    "重难点": "教学重难点",
    "教学过程": "教学过程",
    "例题": "例题与变式",
    "分层作业": "分层作业",
    "板书": "板书设计",
    "反思": "教学反思",
    "数据使用说明": "数据使用说明",
}
PLACEHOLDERS = ("此处讲解", "（占位）", "TODO", "待补充", "略。")
ENVIRONMENT_RE = re.compile(r"环节[一二三四五]")

MIN_TOTAL = 3000
MIN_STAGE_CHARS = 80


def validate_lesson_plan(md: str) -> Dict[str, Any]:
    issues: List[str] = []
    if len(md) < MIN_TOTAL:
        issues.append(f"篇幅不足：{len(md)} 字 < {MIN_TOTAL} 字")
    for key, name in REQUIRED_SECTIONS.items():
        if key not in md:
            issues.append(f"缺少板块：{name}")
    # 学情分析须含真实数据引用
    m = re.search(r"##[^\n]*学情分析(.*?)(?=\n## )", md, flags=re.S)
    if m:
        seg = m.group(1)
        if ("%" not in seg) and ("掌握率" not in seg):
            issues.append("学情分析未引用真实数据（应含掌握率百分比）")
    # 教学过程环节充实度
    m2 = re.search(r"##[^\n]*教学过程(.*?)(?=\n## )", md, flags=re.S)
    if m2:
        seg = m2.group(1)
        stages = ENVIRONMENT_RE.split(seg)[1:]
        for i, st in enumerate(stages, 1):
            if len(st.strip()) < MIN_STAGE_CHARS:
                issues.append(f"教学过程第 {i} 环节内容单薄（< {MIN_STAGE_CHARS} 字）")
    for w in PLACEHOLDERS:
        if w in md:
            issues.append(f"含占位性表述「{w}」")
    score = 100
    score -= 12 * len([i for i in issues if i.startswith("缺少板块")])
    score -= 15 * len([i for i in issues if i.startswith("篇幅")])
    score -= 6 * len([i for i in issues if i.startswith("学情") or i.startswith("教学过程")])
    score -= 5 * len([i for i in issues if i.startswith("含占位")])
    score = max(score, 0)
    return {"ok": not issues, "issues": issues, "chars": len(md), "score": score,
            "sections": [k for k in REQUIRED_SECTIONS if k in md]}


def generate_lesson_plan(md: str, out_path: str) -> Dict[str, Any]:
    """校验并渲染 docx。返回质量统计；不达标抛 ValueError。"""
    quality = validate_lesson_plan(md)
    if not quality["ok"]:
        raise ValueError("教案质量校验未通过：" + "；".join(quality["issues"][:6]))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    import workflow  # noqa: E402

    if not workflow._export_docx(out_path, md):
        raise ValueError("docx 渲染失败（文件过小或写入异常）")
    quality["path"] = out_path
    quality["size"] = os.path.getsize(out_path)
    return quality


def main() -> None:
    if len(sys.argv) < 3:
        print("用法：python lesson_plan_writer.py <plan.md> <out.docx>")
        sys.exit(1)
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        md = f.read()
    q = generate_lesson_plan(md, sys.argv[2])
    print(json.dumps(q, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
