# -*- coding: utf-8 -*-
"""
知识库检索服务（RAG 升级版）
==============================
原实现：复用 workflow.KnowledgeBase，对 kg_data.json 纯子串匹配（无向量、无分块、无语义）。
升级后：内部走 rag.hybrid.search()（向量 + BM25 混合检索 + 重排），
         保留原接口签名 retrieve(subject, topic) 与 session 上下文格式，向后兼容前端与工作流。

降级策略：
  - rag 索引为空 / 依赖缺失时，自动回退旧 KnowledgeBase 子串检索，保证服务可用。
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import workflow  # noqa: E402

from . import config

log = logging.getLogger("teacher-backend.kb")

_KB_SINGLETON = None
_RAG_AVAILABLE = None


def _rag_ok() -> bool:
    """确认 rag 检索层可导入且索引可用。"""
    global _RAG_AVAILABLE
    if _RAG_AVAILABLE is not None:
        return _RAG_AVAILABLE
    try:
        from .rag import hybrid, pipeline

        st = pipeline.status()
        n = (st.get("vector_store") or {}).get("chunks", 0)
        _RAG_AVAILABLE = bool(n > 0)
        if not _RAG_AVAILABLE:
            log.warning("RAG 索引为空（chunks=0），知识库检索回退旧子串匹配")
    except Exception as e:
        _RAG_AVAILABLE = False
        log.warning("RAG 检索层不可用，回退旧子串匹配：%s", e)
    return _RAG_AVAILABLE


def _get_kb():
    global _KB_SINGLETON
    if _KB_SINGLETON is None:
        _KB_SINGLETON = workflow.KnowledgeBase(path=config.DATA_ROOT or "")
    return _KB_SINGLETON


def retrieve(subject: str = "", topic: str = "") -> Dict[str, Any]:
    """检索指定学科/主题的知识信息。优先 RAG 混合检索，失败/空索引回退旧实现。"""
    # 1) RAG 优先
    if _rag_ok():
        try:
            from .rag import hybrid

            r = hybrid.search(topic or "", subject=subject, top_n=8)
            if r.hits:
                return {
                    "ok": True,
                    "engine": "rag",
                    "subject": r.routed_subject or subject,
                    "matched_nodes": [
                        {
                            "id": h.kp_id,
                            "kp_id": h.kp_id,
                            "subject": h.subject,
                            "knowledge_point": h.knowledge_point,
                            "module": h.module,
                            "chapter": h.chapter,
                            "section": h.section,
                            "chunk_type": h.chunk_type,
                            "difficulty": h.difficulty,
                            "level": h.level,
                            "score": h.score,
                            "source": h.source,
                            "text": h.text,
                            "content": h.text[:500],
                        }
                        for h in r.hits
                    ],
                    "session": r.context,
                    "sources": r.sources,
                    "routed_subject": r.routed_subject,
                    "query_rewritten": r.query_rewritten,
                    "rerank_used": r.rerank_used,
                }
        except Exception as e:
            log.warning("RAG 检索失败，回退旧实现：%s", e)

    # 2) 回退旧实现
    try:
        kb = _get_kb()
        old = kb.retrieve(subject or "", topic or "")
        if isinstance(old, dict):
            old["engine"] = "legacy"
        return old
    except Exception as e:
        return {"error": str(e), "matched_nodes": [], "session": "", "engine": "failed"}


def subjects_available() -> List[str]:
    try:
        if _rag_ok():
            from .rag import config as rag_config

            return list(rag_config.SUBJECTS)
        kb = _get_kb()
        return list(kb.data.keys()) if getattr(kb, "data", None) else []
    except Exception:
        return []


def reset_rag_cache() -> None:
    """测试/构建后重置 RAG 可用性缓存。"""
    global _RAG_AVAILABLE
    _RAG_AVAILABLE = None