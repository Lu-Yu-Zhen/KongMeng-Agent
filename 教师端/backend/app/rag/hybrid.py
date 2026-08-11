# -*- coding: utf-8 -*-
"""
混合检索编排（核心链路）
==========================
请求 → 学科识别 + 查询改写 → 向量召回(sqlite-vec) + 关键词召回(BM25)
     → RRF 融合 → 重排(bge-reranker) → 沿知识树补全父/子节点上下文 → 组装 prompt。
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional

from . import config, models, vector_store, bm25
from .schema import RetrievalHit, RetrievalResult

log = logging.getLogger("teacher-backend.rag")

# 学科识别关键词（用于学科自动路由）
_SUBJECT_KEYWORDS: Dict[str, List[str]] = {
    "语文": ["文言文", "虚词", "实词", "古诗", "诗词", "作文", "阅读理解", "病句", "散文", "小说", "名著", "语文"],
    "数学": ["函数", "导数", "解析几何", "数列", "三角函数", "立体几何", "概率", "统计", "向量", "不等式", "数学"],
    "英语": ["词汇", "语法", "完形", "阅读理解", "书面表达", "作文", "听力", "reading", "grammar", "vocabulary", "english", "英语"],
    "物理": ["力学", "牛顿", "电磁", "电场", "磁场", "电路", "光学", "热学", "原子", "动量", "物理"],
    "化学": ["化学", "反应", "氧化还原", "有机", "无机", "元素", "酸碱", "电解", "化学键", "物质"],
    "生物": ["细胞", "基因", "遗传", "DNA", "蛋白质", "光合作用", "呼吸", "生态", "免疫", "神经", "生物"],
    "历史": ["历史", "朝代", "战争", "革命", "改革", "朝代", "古代", "近代", "史料", "中华文明"],
    "地理": ["地理", "气候", "地形", "洋流", "大气", "人口", "城市化", "区域", "地球", "经纬"],
    "思想政治": ["政治", "哲学", "经济", "中国特色社会主义", "法治", "文化", "意识", "矛盾", "价值观"],
}


def route_subject(query: str, explicit: str = "") -> str:
    """学科自动路由：优先显式指定，否则按关键词命中次数。"""
    if explicit:
        for s in config.SUBJECTS:
            if explicit == s or explicit in (config.SUBJECT_EN.get(s, ""), s):
                return s
    best, best_score = "", 0
    for subj, kws in _SUBJECT_KEYWORDS.items():
        score = sum(1 for kw in kws if kw and kw.lower() in query.lower())
        if kw_subj_hit(query, subj):
            score += 2
        if score > best_score:
            best, best_score = subj, score
    if best_score == 0:
        return ""  # 无法判定
    return best


def kw_subj_hit(query: str, subj_zh: str) -> bool:
    return subj_zh in query


def rewrite_query(query: str, subject: str, history: Optional[List[Dict[str, str]]] = None) -> str:
    """查询改写：合并多轮上下文中的主题词，并补充独立变量名（简化版，离线无 LLM）。"""
    q = query.strip()
    # 去省略代词：把"它/该/上述/此"替换为主题词（若上一轮出现）
    if history:
        last_tokens = " ".join(h.get("content", "") for h in history[-2:])
        for pat in ("它", "该", "此", "上述", "这个", "那个"):
            if pat in q and last_tokens:
                # 取上一轮最长名词短语片段作为指代对象
                cand = max(last_tokens.split(), key=len) if last_tokens.split() else ""
                q = q.replace(pat, cand)
    return q


def _rrf(docs_by_retriever: List[List[Dict[str, Any]]], k: int) -> List[Dict[str, Any]]:
    """Reciprocal Rank Fusion。"""
    scores: Dict[str, float] = {}
    meta: Dict[str, Dict[str, Any]] = {}
    for rank_list in docs_by_retriever:
        for rank, d in enumerate(rank_list):
            cid = d.get("chunk_id")
            if not cid:
                continue
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank + 1)
            meta.setdefault(cid, d)
    fused = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    out = []
    for cid, s in fused:
        d = dict(meta[cid])
        d["score"] = s
        out.append(d)
    return out


def _tree_context(hit: Dict[str, Any]) -> str:
    """沿知识树补齐父/子节点上下文（模块/章/节）。"""
    parts = []
    if hit.get("module"):
        parts.append(hit["module"])
    if hit.get("chapter"):
        parts.append(hit["chapter"])
    if hit.get("section"):
        parts.append(hit["section"])
    if hit.get("knowledge_point"):
        parts.append(hit["knowledge_point"])
    return "/".join(parts)


def search(query: str, subject: str = "", top_n: Optional[int] = None,
           history: Optional[List[Dict[str, str]]] = None) -> RetrievalResult:
    """主导入：混合检索。"""
    result = RetrievalResult(query=query)
    q = (query or "").strip()
    if not q:
        return result

    routed = route_subject(q, subject)
    result.routed_subject = routed
    filtered_subject = routed if (config.SUBJECT_FILTER and routed) else None
    result.query_rewritten = rewrite_query(q, routed, history)
    q2 = result.query_rewritten

    # 1) 向量召回（mock 向量无语义，跳过，避免污染 RRF 融合）
    embedder = models.get_embedder()
    store = vector_store.get_store()
    vec_hits: List[Dict[str, Any]] = []
    if not embedder.mock:
        try:
            v = embedder.embed(q2)
            vec_hits = store.knn(v, k=config.VECTOR_TOP_K, subject=filtered_subject)
        except Exception as e:  # pragma: no cover
            log.warning("向量召回失败：%s", e)
            result.degraded = True
            embedder.reset_onnx()  # 疑似模型损坏，重置以便下次重载
    else:
        log.debug("mock 向量模式：跳过向量召回，仅用关键词召回")

    # 2) 关键词召回
    bm = bm25.get_index()
    bm_hits: List[Dict[str, Any]] = []
    try:
        bm_hits = bm.search(q2, top_k=config.BM25_TOP_K, subject=filtered_subject)
    except Exception as e:  # pragma: no cover
        log.warning("BM25 召回失败：%s", e)
        result.degraded = True

    if not vec_hits and not bm_hits:
        return result

    # 3) RRF 融合（仅融合实际命中的召回器）
    retrievers: List[List[Dict[str, Any]]] = []
    if vec_hits:
        retrievers.append(vec_hits)
    if bm_hits:
        retrievers.append(bm_hits)
    fused = _rrf(retrievers, config.RRF_K)[: config.FUSE_TOP_N]

    # 4) 重排
    from . import reranker as _rerank_mod
    reranked = _rerank_mod.rerank(q2, fused)
    result.rerank_used = any("rerank_score" in h for h in reranked)

    # 5) 组装命中与上下文
    n = top_n or config.RERANK_TOP_N
    for h in reranked[:n]:
        score = h.get("rerank_score", h.get("score", 0.0)) if result.rerank_used else h.get("score", 0.0)
        if score < config.MIN_SCORE:
            break
        ctx = _tree_context(h)
        hit = RetrievalHit(
            chunk_id=h.get("chunk_id", ""),
            kp_id=h.get("kp_id", ""),
            subject=h.get("subject", ""),
            knowledge_point=h.get("knowledge_point", ""),
            module=h.get("module", ""),
            chapter=h.get("chapter", ""),
            section=h.get("section", ""),
            chunk_type=h.get("chunk_type", ""),
            difficulty=int(h.get("difficulty", 0)),
            level=h.get("level", ""),
            source=h.get("source", ""),
            text=h.get("text", ""),
            score=float(score),
            rerank_score=float(h.get("rerank_score", 0.0)),
        )
        result.hits.append(hit)
        if hit.source:
            result.sources.append(hit.source)

    # 6) 上下文组装（供 LLM 注入）
    lines = [f"学科：{result.routed_subject or '未识别'}"]
    for h in result.hits[: n]:
        lines.append(f"- [{h.knowledge_point or h.kp_id}]（难度{h.difficulty}/来源{h.source or '未知'}）：{h.text[:200]}")
    result.context = "\n".join(lines) if result.hits else "（未检索到高置信知识块，请降低难度或补充上下文）"
    return result


def health() -> Dict[str, Any]:
    """各组件就绪状态。"""
    store = vector_store.get_store()
    si = store.health()
    bm = bm25.get_index()
    embedder = models.get_embedder()
    return {
        "embed_mock": embedder.mock,
        "embed_model": config.EMBED_MODEL_NAME,
        "embed_dim": config.EMBED_DIM,
        "rerank_enabled": config.RERANK_ENABLED,
        "vector_store": si,
        "bm25_chunks": bm.count(),
        "params": config.RetrievalParams().as_dict(),
    }