# -*- coding: utf-8 -*-
"""
分块器（Chunking）
====================
以知识树叶子（知识点）为原子单元切分，块内按 chunk_type 细分，
相邻块保留一定重叠，避免截断语义。真题类整题切分、不拆散题目。
"""
from __future__ import annotations

import hashlib
import re
import time
from typing import Any, Dict, List

from . import config
from .schema import Chunk, now_str


def _token_len(text: str) -> int:
    """粗略 token 估算：中文按字、英文按词。"""
    zh = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    en = len(re.findall(r"[A-Za-z0-9_]+", text))
    return zh + en


def _split_sentences(text: str) -> List[str]:
    parts = re.split(r"(?<=[。！？；!?;])\s*", text)
    return [p.strip() for p in parts if p.strip()]


def _split_paragraphs(text: str) -> List[str]:
    parts = re.split(r"\n+|(?<=[。！？])\s*", text)
    return [p.strip() for p in parts if p.strip()]


def _classify_chunk(text: str, kp_name: str) -> str:
    """依据内容特征标注 chunk_type。"""
    t = text
    if re.search(r"(=|≥|≤|±|Σ|∫|√|²|³|→|×|÷|公式|定理|推论|性质|定义\s*：|定义[:：])", t):
        if re.search(r"(公式|∴|因为|所以|证明|证毕|推导)", t):
            return "formula"
        return "definition"
    if re.search(r"(例\d*|例题|变式|例：|例:|【例|典例|真题|考点训练)", t):
        return "example"
    if re.search(r"(易错|提醒|注意|方法|技巧|步骤|解题思路|规律|口诀)", t):
        return "method"
    if re.search(r"(课标|要求掌握|要求理解|学业要求|考试要求|考查)", t):
        return "exam_requirement"
    if re.search(r"(概念|定义|含义|本质|实质|特点|分类|作用)", t):
        return "definition"
    return "definition"


def _greedy_chunk(text: str, max_tokens: int, overlap_chars: int) -> List[str]:
    """基于段落的贪心聚合 + 尾部重叠。"""
    paras = _split_paragraphs(text)
    chunks: List[str] = []
    buf = ""
    for p in paras:
        if not buf:
            buf = p
            continue
        if _token_len(buf + p) <= max_tokens:
            buf += p
        else:
            chunks.append(buf)
            # 重叠：取上一块末尾 overlap_chars 字符作为下一块开头
            buf = buf[-overlap_chars:] + p
    if buf:
        chunks.append(buf)
    return chunks


def chunk_knowledge_point(kp: Dict[str, Any], idx_start: int = 0) -> List[Chunk]:
    """将单个知识点正文切分为若干 Chunk。kp 需含 text 与层级元数据。"""
    text = (kp.get("text") or "").strip()
    if not text:
        return []
    type_hint = _classify_chunk(text, kp.get("name", ""))
    segs = _greedy_chunk(text, config.CHUNK_MAX_TOKENS, config.CHUNK_OVERLAP_CHARS)
    chunks: List[Chunk] = []
    for i, seg in enumerate(segs):
        c = Chunk(
            chunk_id=f"{kp.get('subject','')}-{kp.get('kp_id','')}-{idx_start+i}",
            kp_id=kp.get("kp_id", ""),
            subject=kp.get("subject", ""),
            grade=kp.get("grade", ""),
            book=kp.get("module", ""),
            module=kp.get("module", ""),
            chapter=kp.get("chapter", ""),
            section=kp.get("section", ""),
            knowledge_point=kp.get("name", ""),
            chunk_type=type_hint if i == 0 else _classify_chunk(seg, kp.get("name", "")),
            difficulty=int(kp.get("difficulty", 0)),
            importance=int(kp.get("importance", 0)),
            exam_type=kp.get("exam_type", ""),
            level=kp.get("level_requirement", ""),
            source=kp.get("source", ""),
            page=kp.get("page", ""),
            version=kp.get("version", ""),
            created_at=now_str(),
            text=seg,
        )
        c.hash = hashlib.sha1(seg.encode("utf-8")).hexdigest()[:16]
        chunks.append(c)
    return chunks


def chunk_document(text: str, meta: Dict[str, Any]) -> List[Chunk]:
    """整篇文章分块（真题/资料类）：按段落聚合，整题不拆散。"""
    if not text:
        return []
    segs = _greedy_chunk(text, config.CHUNK_MAX_TOKENS, config.CHUNK_OVERLAP_CHARS)
    subject = meta.get("subject", "")
    kp_id = meta.get("kp_id", meta.get("doc_id", "DOC"))
    chunks = []
    for i, seg in enumerate(segs):
        c = Chunk(
            chunk_id=f"{subject}-{kp_id}-D{i}",
            kp_id=kp_id,
            subject=subject,
            grade=meta.get("grade", ""),
            book=meta.get("book", ""),
            module=meta.get("module", ""),
            chapter=meta.get("chapter", ""),
            section=meta.get("section", ""),
            knowledge_point=meta.get("knowledge_point", ""),
            chunk_type=_classify_chunk(seg, meta.get("knowledge_point", "")),
            difficulty=int(meta.get("difficulty", 0)),
            importance=int(meta.get("importance", 0)),
            exam_type=meta.get("exam_type", ""),
            level=meta.get("level", ""),
            source=meta.get("source", ""),
            page=meta.get("page", ""),
            version=meta.get("version", ""),
            created_at=now_str(),
            text=seg,
        )
        c.hash = hashlib.sha1(seg.encode("utf-8")).hexdigest()[:16]
        chunks.append(c)
    return chunks