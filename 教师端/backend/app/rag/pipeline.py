# -*- coding: utf-8 -*-
"""
索引构建与生命周期管理（pipeline）
====================================
职责：
  1. 从知识树(rag_data/knowledge-tree/{学科}.json) + 清洗语料(corpus/{学科}/*.txt)
     读取知识点正文，调用 chunker 分块。
  2. 生成 embedding，写入 sqlite-vec 向量库；更新 BM25 倒排索引。
  3. 维护 manifest.json（版本/时间戳/维度/模型名/块数），支持断点续建与增量重建。
入口：rag.pipeline.build() / rag.pipeline.health() / rag.api_router。
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, List, Optional

from . import config, models, vector_store, bm25, chunker
from .schema import Chunk

log = logging.getLogger("teacher-backend.rag")


# ---------------------------------------------------------------------------
# 知识树读取
# ---------------------------------------------------------------------------
def load_knowledge_tree(subject: str) -> Dict[str, Any]:
    """读取某学科知识树 JSON。返回原始 dict。"""
    path = os.path.join(config.TREE_DIR, f"{subject}.json")
    if not os.path.exists(path):
        log.warning("知识树缺失：%s", path)
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def iter_knowledge_points(tree: Dict[str, Any]) -> List[Dict[str, Any]]:
    """深度遍历知识树，收集所有叶子知识点（含层级元数据）。"""
    nodes = tree.get("nodes", []) if isinstance(tree, dict) else tree
    out: List[Dict[str, Any]] = []
    _walk(nodes, 1, "", out)
    return out


def _walk(nodes: List[Dict[str, Any]], level: int, parent_id: str, out: List[Dict[str, Any]]) -> None:
    for n in nodes or []:
        nid = n.get("kp_id") or n.get("id") or ""
        node = dict(n)
        node["level"] = level
        node["parent_id"] = parent_id
        out.append(node)
        children = n.get("children") or []
        if children:
            _walk(children, level + 1, nid, out)


def flatten_kp_for_chunks(tree: Dict[str, Any]) -> List[Dict[str, Any]]:
    """把知识树叶子节点转成分块器所需的 kp 字典（含正文 text）。"""
    leaves: List[Dict[str, Any]] = []
    _walk_leaves(tree.get("nodes", []), 1, "", leaves)
    # 仅保留 level>=5 的叶子；若树深度不足 5，则取最深层
    max_level = max((l.get("level", 0) for l in leaves), default=0)
    return [l for l in leaves if l.get("level", 0) >= max(5, max_level)] or leaves


def _walk_leaves(nodes: List[Dict[str, Any]], level: int, parent_id: str, out: List[Dict[str, Any]]) -> None:
    for n in nodes or []:
        nid = n.get("kp_id") or n.get("id") or ""
        children = n.get("children") or []
        node = dict(n)
        node["level"] = level
        node["parent_id"] = parent_id
        if not children:
            out.append(node)
        else:
            _walk_leaves(children, level + 1, nid, out)


# ---------------------------------------------------------------------------
# 语料读取
# ---------------------------------------------------------------------------
def load_corpus(subject: str) -> List[Dict[str, Any]]:
    """读取清洗语料 corpus/{学科}/*.txt，返回文档列表（含元数据）。"""
    dir_path = os.path.join(config.CORPUS_DIR, subject)
    if not os.path.isdir(dir_path):
        return []
    docs: List[Dict[str, Any]] = []
    for fn in sorted(os.listdir(dir_path)):
        if not fn.endswith(".txt"):
            continue
        full = os.path.join(dir_path, fn)
        try:
            with open(full, "r", encoding="utf-8") as f:
                text = f.read()
        except Exception as e:
            log.warning("读语料失败 %s：%s", full, e)
            continue
        doc_id = os.path.splitext(fn)[0]
        meta = _parse_corpus_meta(fn)
        meta.update({"subject": subject, "doc_id": f"{subject}-{doc_id}", "file_name": fn})
        docs.append({"meta": meta, "text": text})
    return docs


def _parse_corpus_meta(fn: str) -> Dict[str, Any]:
    """从文件名解析标注（约定：{模块}_{章节}_{知识点}_{年级}.txt 或 {文档名}.txt）。"""
    base = os.path.splitext(fn)[0]
    parts = base.split("_")
    meta: Dict[str, Any] = {}
    if len(parts) >= 4:
        meta["module"] = parts[0]
        meta["chapter"] = parts[1]
        meta["section"] = parts[2]
        meta["grade"] = parts[3]
    meta["source"] = "corpus"
    return meta


# ---------------------------------------------------------------------------
# 读取已分块（断点续建）
# ---------------------------------------------------------------------------
def read_existing_chunks(subject: str) -> Dict[str, Chunk]:
    """读取已有分块文件 chunks/{学科}.jsonl，返回 {chunk_id: Chunk}。"""
    path = os.path.join(config.CHUNKS_DIR, f"{subject}.jsonl")
    out: Dict[str, Chunk] = {}
    if not os.path.exists(path):
        return out
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                c = Chunk(**json.loads(line))
                out[c.chunk_id] = c
            except Exception as e:
                log.warning("跳过坏块 %s：%s", line[:40], e)
    return out


def write_chunks(subject: str, chunks: List[Chunk]) -> None:
    os.makedirs(config.CHUNKS_DIR, exist_ok=True)
    path = os.path.join(config.CHUNKS_DIR, f"{subject}.jsonl")
    with open(path, "w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c.model_dump(), ensure_ascii=False) + "\n")


# ---------------------------------------------------------------------------
# manifest
# ---------------------------------------------------------------------------
def read_manifest() -> Dict[str, Any]:
    if os.path.exists(config.MANIFEST_PATH):
        try:
            with open(config.MANIFEST_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def write_manifest(block_stats: Dict[str, int], dimension: int, model: str) -> Dict[str, Any]:
    m = {
        "version": config.INDEX_VERSION,
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "dim": dimension,
        "embed_model": model,
        "rerank_model": config.RERANK_MODEL_NAME,
        "subjects": sorted(block_stats.keys()),
        "block_counts": block_stats,
        "total_chunks": sum(block_stats.values()),
    }
    os.makedirs(config.INDEX_DIR, exist_ok=True)
    with open(config.MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    return m


# ---------------------------------------------------------------------------
# 构建主流程
# ---------------------------------------------------------------------------
def build(subjects: Optional[List[str]] = None, force: bool = False,
          progress=None) -> Dict[str, Any]:
    """构建全库索引。progress: 可选回调 fn(stage: str, pct: int, msg: str)。

    断点续建：已存在于 chunks/{学科}.jsonl 的 chunk 若 force=False 则跳过 embedding 重算。
    """
    config.ensure_dirs()
    subjects = subjects or config.SUBJECTS
    embedder = models.get_embedder()
    store = vector_store.get_store()
    store.create(dim=config.EMBED_DIM)

    def emit(stage, pct, msg):
        if progress:
            try:
                progress(stage, pct, msg)
            except Exception:
                pass
        log.info("[%s] %s", stage, msg)

    total_blocks = 0
    block_stats: Dict[str, int] = {}
    all_chunks: List[Chunk] = []
    bm = bm25.get_index()

    for si, subject in enumerate(subjects):
        emit("tree", int(si / len(subjects) * 30), f"读取 {subject} 知识树与语料…")
        tree = load_knowledge_tree(subject)
        kps = flatten_kp_for_chunks(tree)
        corpus = load_corpus(subject)

        # 1) 分块（知识树叶子优先，语料为辅）
        subject_chunks: List[Chunk] = []
        idx = 0
        for kp in kps:
            kp = _decorate_kp(kp, subject)
            subject_chunks.extend(chunker.chunk_knowledge_point(kp, idx))
            idx += len(_rough_segs(kp.get("text", "")))
        for doc in corpus:
            subject_chunks.extend(chunker.chunk_document(doc["text"], doc["meta"]))

        # 2) 断点续建：跳过已存在且未变化的块
        existing = read_existing_chunks(subject) if not force else {}
        to_embed: List[Chunk] = []
        final_chunks: List[Chunk] = []
        for c in subject_chunks:
            old = existing.get(c.chunk_id)
            if old is not None and old.hash == c.hash and not force:
                final_chunks.append(old)
            else:
                to_embed.append(c)
                final_chunks.append(c)
        subject_chunks = final_chunks

        # 3) embedding
        if to_embed:
            emit("embed", 30 + int(si / len(subjects) * 40), f"向量化 {subject}（{len(to_embed)} 块）…")
            texts = [c.text for c in to_embed]
            vecs = embedder.embed_batch(texts)
            rows = []
            for c, v in zip(to_embed, vecs):
                rows.append(
                    {
                        "chunk_id": c.chunk_id, "embedding": v, "subject": c.subject,
                        "kp_id": c.kp_id, "knowledge_point": c.knowledge_point,
                        "module": c.module, "chapter": c.chapter, "section": c.section,
                        "chunk_type": c.chunk_type, "difficulty": c.difficulty,
                        "level": c.level, "source": c.source, "text": c.text,
                    }
                )
            store.upsert_many(rows)
        else:
            emit("embed", 30 + int(si / len(subjects) * 40), f"{subject} 无新增块，跳过向量化")

        # 4) 落盘分块 + 收集 BM25 文档
        write_chunks(subject, subject_chunks)
        all_chunks.extend(subject_chunks)
        block_stats[subject] = len(subject_chunks)
        total_blocks += len(subject_chunks)

    # 5) 重建 BM25 索引（全量，块量小可接受）
    emit("bm25", 80, "重建 BM25 倒排索引…")
    if all_chunks:
        bm_docs = [c.model_dump() for c in all_chunks]
        bm.add_docs(bm_docs)
        bm.save()

    # 6) manifest
    manifest = write_manifest(block_stats, config.EMBED_DIM, config.EMBED_MODEL_NAME)
    emit("done", 100, "构建完成")
    return {
        "ok": True,
        "manifest": manifest,
        "total_chunks": total_blocks,
        "embed_mock": embedder.mock,
    }


def _decorate_kp(kp: Dict[str, Any], subject: str) -> Dict[str, Any]:
    """补齐知识树叶子节点的分块所需字段。"""
    out = dict(kp)
    out.setdefault("subject", subject)
    out.setdefault("kp_id", kp.get("kp_id") or kp.get("id") or "")
    out.setdefault("name", kp.get("name") or kp.get("label") or "")
    out.setdefault("module", kp.get("module") or "")
    out.setdefault("chapter", kp.get("chapter") or "")
    out.setdefault("section", kp.get("section") or "")
    out.setdefault("grade", kp.get("grade") or "")
    out.setdefault("difficulty", int(kp.get("difficulty") or 0))
    out.setdefault("importance", int(kp.get("importance") or 0))
    out.setdefault("level_requirement", kp.get("level_requirement") or kp.get("level") or "")
    out.setdefault("text", kp.get("text") or kp.get("description") or "")
    out.setdefault("source", kp.get("source") or "")
    out.setdefault("page", kp.get("page") or "")
    out.setdefault("version", kp.get("version") or "")
    return out


def _rough_segs(text: str) -> List[str]:
    """粗略估算分块数（供 chunk_id 序号递进）。"""
    if not text:
        return []
    return [s for s in text.split("\n") if s.strip()]


# ---------------------------------------------------------------------------
# 健康检查 / 状态
# ---------------------------------------------------------------------------
def health() -> Dict[str, Any]:
    store = vector_store.get_store()
    bm = bm25.get_index()
    manifest = read_manifest()
    return {
        "embed_mock": models.get_embedder().mock,
        "embed_model": config.EMBED_MODEL_NAME,
        "embed_dim": config.EMBED_DIM,
        "rerank_enabled": config.RERANK_ENABLED,
        "vector_store": store.health(),
        "bm25_chunks": bm.count(),
        "manifest": manifest,
        "params": config.RetrievalParams().as_dict(),
    }


def status() -> Dict[str, Any]:
    """供 /rag/status 使用。"""
    return health()