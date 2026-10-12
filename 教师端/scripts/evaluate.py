# -*- coding: utf-8 -*-
"""
QA 评测脚本
=============
读取 tests/rag/qa/{九科}.json（每科50条），批量跑混合检索，输出：
  - 每科 Recall@5、MRR@5、负例误召回率
  - 全科汇总 + 回归基线
  - 生成 eval-report.md
用法：
  python scripts/evaluate.py [--subject 数学] [--top-k 5] [--report out.md]
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_BACKEND = os.path.join(_BASE, "backend")
for _p in (_BACKEND, _BASE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

logging.basicConfig(level=logging.WARNING)
log = logging.getLogger("evaluate")


def load_qa(subject: str) -> list:
    path = os.path.join(_BASE, "tests", "rag", "qa", f"{subject}.json")
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, list) else data.get("items", [])


def evaluate_subject(subject: str, top_k: int) -> dict:
    from app.rag import hybrid

    items = load_qa(subject)
    if not items:
        return {"subject": subject, "items": 0, "recall": 0.0, "mrr": 0.0, "neg_false": 0.0}

    recall_hits = 0
    mrr_sum = 0.0
    neg_total = 0
    neg_false = 0
    for it in items:
        q = it.get("query", "")
        expect = it.get("expected_kp", "") or it.get("kp_id", "")
        is_neg = bool(it.get("negative", False))
        r = hybrid.search(q, subject=it.get("subject", subject), top_n=top_k)
        hit_kps = {h.kp_id for h in r.hits}

        if is_neg:
            neg_total += 1
            # 负例期望：应召回低；若命中了明确标注的 kp 则算误召回
            if expect and expect in hit_kps:
                neg_false += 1
            continue

        if expect:
            if expect in hit_kps:
                recall_hits += 1
            for rank, h in enumerate(r.hits):
                if h.kp_id == expect:
                    mrr_sum += 1.0 / (rank + 1)
                    break

    n = max(1, sum(1 for it in items if not it.get("negative", False)))
    recall = recall_hits / n
    mrr = mrr_sum / n
    neg_false_rate = (neg_false / neg_total) if neg_total else 0.0
    return {
        "subject": subject,
        "items": len(items),
        "positive": n,
        "negatives": neg_total,
        "recall": round(recall, 3),
        "mrr": round(mrr, 3),
        "neg_false": round(neg_false_rate, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="RAG QA 评测")
    parser.add_argument("--subject", default="", help="指定学科，缺省全科")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--report", default=os.path.join(_BASE, "docs", "rag", "eval-report.md"))
    args = parser.parse_args()

    from app.rag import config

    subjects = [args.subject] if args.subject else config.SUBJECTS
    results = [evaluate_subject(s, args.top_k) for s in subjects]

    pos_total = sum(r["positive"] for r in results)
    recall_total = sum(r["recall"] * r["positive"] for r in results) / max(1, pos_total)
    mrr_total = sum(r["mrr"] * r["positive"] for r in results) / max(1, pos_total)
    neg_total = sum(r["negatives"] for r in results)
    neg_false_total = sum(r["neg_false"] * r["negatives"] for r in results) / max(1, neg_total)

    # 指标门槛
    gate = {"recall": 0.8, "mrr": 0.75, "neg_false": 0.10}
    passed = recall_total >= gate["recall"] and mrr_total >= gate["mrr"] and neg_false_total <= gate["neg_false"]

    os.makedirs(os.path.dirname(args.report), exist_ok=True)
    lines = [
        "# RAG 检索评测报告",
        "",
        f"- 评测时间：{__import__('time').strftime('%Y-%m-%d %H:%M:%S')}",
        f"- top_k：{args.top_k}",
        f"- 指标门槛：Recall@{args.top_k}≥{gate['recall']}、MRR@{args.top_k}≥{gate['mrr']}、负例误召回≤{gate['neg_false']}",
        f"- 结论：{'通过' if passed else '未达标（需回填迭代）'}",
        "",
        "| 学科 | 题数 | 正例 | 负例 | Recall | MRR | 负例误召回 |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in results:
        lines.append(
            f"| {r['subject']} | {r['items']} | {r['positive']} | {r['negatives']} | "
            f"{r['recall']:.3f} | {r['mrr']:.3f} | {r['neg_false']:.3f} |"
        )
    lines.append(
        f"| **全科** | {sum(r['items'] for r in results)} | {pos_total} | {neg_total} | "
        f"**{recall_total:.3f}** | **{mrr_total:.3f}** | **{neg_false_total:.3f}** |"
    )
    lines.append("")
    lines.append("> 说明：mock embedding（hash 分段）无语义区分度，主要验证链路与 BM25 关键词召回；")
    lines.append("> 配置真实 ONNX embedding + reranker 后语义召回显著提升，应达到门槛。")

    with open(args.report, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print("\n=== 评测结果 ===")
    for r in results:
        print(f"{r['subject']}: Recall={r['recall']:.3f} MRR={r['mrr']:.3f} 负例误召回={r['neg_false']:.3f}")
    print(f"全科: Recall={recall_total:.3f} MRR={mrr_total:.3f} 负例误召回={neg_false_total:.3f} → {'通过' if passed else '未达标'}")
    print(f"报告: {args.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())