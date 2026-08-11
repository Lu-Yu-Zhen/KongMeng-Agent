# -*- coding: utf-8 -*-
"""
BM25 关键词检索（jieba 分词 + rank_bm25）
==========================================
弥补向量检索对专有名词 / 公式符号 / 精确术语的召回不足，与向量检索做 RRF 混合。
全流程纯 CPU、常驻内存小，适合本地桌面离线部署。
"""
from __future__ import annotations

import logging
import os
import pickle
from typing import Any, Dict, List, Optional

from . import config

log = logging.getLogger("teacher-backend.rag")

try:
    import jieba
    from rank_bm25 import BM25Okapi

    _BM25_OK = True
except Exception as e:  # pragma: no cover
    _BM25_OK = False
    log.warning("jieba/rank_bm25 不可用：%s", e)


def tokenize(text: str) -> List[str]:
    """中文分词。未知词拆分到 unigram 兜底，保证公式/英文也能命中。"""
    if not _BM25_OK:
        return list(text)
    toks = [t.strip() for t in jieba.cut(text, cut_all=False) if t and t.strip()]
    out = []
    for t in toks:
        if len(t) == 1 and t.isascii() and t.lower() not in ("a", "b", "c", "x", "y", "z"):
            out.append(t.lower())
        else:
            out.append(t)
    return out


class BM25Index:
    """BM25 倒排索引（可序列化到 pickle）。"""

    def __init__(self):
        self.doc_ids: List[str] = []
        self.doc_meta: List[Dict[str, Any]] = []
        self.corpus: List[List[str]] = []
        self.bm25: Optional[BM25Okapi] = None

    def add_docs(self, docs: List[Dict[str, Any]]) -> None:
        """docs 需含 chunk_id / text / 元数据。"""
        for d in docs:
            self.doc_ids.append(d["chunk_id"])
            self.doc_meta.append(d)
            self.corpus.append(tokenize(d.get("text", "")))
        if self.corpus:
            self.bm25 = BM25Okapi(self.corpus)

    def search(self, query: str, top_k: int = 30, subject: Optional[str] = None) -> List[Dict[str, Any]]:
        if self.bm25 is None or not query:
            return []
        q = tokenize(query)
        if not q:
            return []
        scores = self.bm25.get_scores(q)
        ranked = list(range(len(scores)))
        ranked.sort(key=lambda i: scores[i], reverse=True)
        out = []
        for i in ranked[: top_k * 3]:
            meta = self.doc_meta[i]
            if subject and meta.get("subject") != subject:
                continue
            hit = dict(meta)
            hit["bm25_score"] = float(scores[i])
            out.append(hit)
            if len(out) >= top_k:
                break
        return out

    def save(self, path: str = "") -> str:
        path = path or config.BM25_INDEX_PATH
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            pickle.dump({"doc_ids": self.doc_ids, "doc_meta": self.doc_meta, "corpus": self.corpus}, f)
        return path

    def load(self, path: str = "") -> bool:
        path = path or config.BM25_INDEX_PATH
        if not os.path.exists(path):
            return False
        with open(path, "rb") as f:
            data = pickle.load(f)
        self.doc_ids = data["doc_ids"]
        self.doc_meta = data["doc_meta"]
        self.corpus = data["corpus"]
        if self.corpus:
            self.bm25 = BM25Okapi(self.corpus)
        return True

    def count(self) -> int:
        return len(self.doc_ids)


# 全局单例
_INDEX: Optional[BM25Index] = None


def get_index() -> BM25Index:
    global _INDEX
    if _INDEX is None:
        _INDEX = BM25Index()
        try:
            if not _INDEX.load():
                log.info("BM25 索引文件不存在，等待构建（%s）", config.BM25_INDEX_PATH)
        except Exception as e:  # pragma: no cover
            log.warning("BM25 索引加载失败：%s", e)
    return _INDEX


def reset() -> None:
    global _INDEX
    _INDEX = None