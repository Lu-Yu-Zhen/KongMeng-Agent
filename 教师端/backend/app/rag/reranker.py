# -*- coding: utf-8 -*-
"""
重排器薄封装
==============
基于 models.Reranker（Cross-Encoder），对融合后的候选块重排。
重排前对候选块截断至 RERANK_MAX_TOKENS，仅对 top-N 候选重排，控制 CPU 延迟。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from . import config
from .models import get_reranker


def rerank(query: str, hits: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """对 hits 重排。若重排器不可用，原样返回（retain 原顺序）。"""
    if not hits:
        return hits
    rk = get_reranker()
    docs = [h.get("text", "") or h.get("knowledge_point", "") for h in hits]
    scores = rk.score(query, docs)
    if scores is None:
        return hits
    for h, s in zip(hits, scores):
        h["rerank_score"] = float(s)
    hits.sort(key=lambda h: h.get("rerank_score", 0.0), reverse=True)
    return hits[: config.RERANK_TOP_N]