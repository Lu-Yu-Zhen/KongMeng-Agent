# -*- coding: utf-8 -*-
"""
RAG 配置与参数管理
====================
集中管理 RAG 检索链路的所有参数，支持环境变量覆盖，便于部署与调试。
所有路径默认落在教师端 rag_data 目录下，可由 Electron 注入 RAG_DATA_ROOT / RAG_MODEL_DIR 覆盖。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Dict, List


def _env(key: str, default: str) -> str:
    return os.getenv(key, default).strip()


# 数据根目录：清洗语料/分块/索引/知识树/日志
# 默认定位到教师端根目录下的 rag_data（backend/app/rag/config.py → 向上4级到教师端）
_TEACHER_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DATA_ROOT = _env("RAG_DATA_ROOT", os.path.join(_TEACHER_ROOT, "rag_data"))
# 模型目录：ONNX embedding / reranker（独立离线分发，不随主包）
MODEL_DIR = _env("RAG_MODEL_DIR", os.path.join(DATA_ROOT, "models"))

# 子目录
CORPUS_DIR = os.path.join(DATA_ROOT, "corpus")            # 清洗后文本 corpus/{学科}/*.txt
CHUNKS_DIR = os.path.join(DATA_ROOT, "chunks")            # 分块 chunks/{学科}.jsonl
INDEX_DIR = os.path.join(DATA_ROOT, "index")              # 向量库 / BM25 / manifest
TREE_DIR = os.path.join(DATA_ROOT, "knowledge-tree")      # 九学科知识树 {学科}.json
LOG_DIR = os.path.join(DATA_ROOT, "logs")

VECTOR_DB_PATH = os.path.join(INDEX_DIR, "kb_vec.sqlite")  # sqlite-vec 向量库
BM25_INDEX_PATH = os.path.join(INDEX_DIR, "bm25_index.pkl")
MANIFEST_PATH = os.path.join(INDEX_DIR, "manifest.json")

# 学科规范名（与知识树文件名一致）
SUBJECTS: List[str] = ["语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理", "思想政治"]
SUBJECT_EN = {
    "语文": "chinese", "数学": "math", "英语": "english", "物理": "physics",
    "化学": "chemistry", "生物": "biology", "历史": "history",
    "地理": "geography", "思想政治": "politics",
}

# ---------------- Embedding ----------------
# 生产环境建议 bge-large-zh-v1.5（1024 维，ONNX int8 量化）；可降级 base(768) / small(512)
EMBED_MODEL_NAME = _env("RAG_EMBED_MODEL", "bge-large-zh-v1.5")
EMBED_DIM = int(_env("RAG_EMBED_DIM", "1024"))
EMBED_MAX_TOKENS = int(_env("RAG_EMBED_MAX_TOKENS", "512"))
# 开发/无模型环境回退：确定性 hash 向量（仅用于链路自测，生产必须配置真实 ONNX 模型）
EMBED_MOCK = _env("RAG_EMBED_MOCK", "1") in ("1", "true", "yes")

# ---------------- Reranker ----------------
RERANK_MODEL_NAME = _env("RAG_RERANK_MODEL", "bge-reranker-v2-m3")
RERANK_MAX_TOKENS = int(_env("RAG_RERANK_MAX_TOKENS", "512"))  # cross-encoder 序列长度上限
RERANK_ENABLED = _env("RAG_RERANK_ENABLED", "1") in ("1", "true", "yes")

# ---------------- 检索链路参数 ----------------
VECTOR_TOP_K = int(_env("RAG_VECTOR_TOP_K", "50"))      # 向量召回
BM25_TOP_K = int(_env("RAG_BM25_TOP_K", "30"))          # 关键词召回
RRF_K = int(_env("RAG_RRF_K", "60"))                    # RRF 融合常数
FUSE_TOP_N = int(_env("RAG_FUSE_TOP_N", "20"))          # 融合后候选数
RERANK_TOP_N = int(_env("RAG_RERANK_TOP_N", "8"))       # 重排后最终块数
MIN_SCORE = float(_env("RAG_MIN_SCORE", "0.0"))         # 最低置信阈值（低于则返回空态）
SUBJECT_FILTER = _env("RAG_SUBJECT_FILTER", "1") in ("1", "true", "yes")  # 是否按学科过滤

# ---------------- 分块参数 ----------------
CHUNK_MIN_TOKENS = int(_env("RAG_CHUNK_MIN_TOKENS", "256"))
CHUNK_MAX_TOKENS = int(_env("RAG_CHUNK_MAX_TOKENS", "1024"))
CHUNK_OVERLAP_CHARS = int(_env("RAG_CHUNK_OVERLAP_CHARS", "80"))  # 相邻块重叠字符数

# ---------------- 索引 ----------------
INDEX_VERSION = "1.0.0"


def ensure_dirs() -> None:
    """确保所有数据目录存在。"""
    for d in (DATA_ROOT, MODEL_DIR, CORPUS_DIR, CHUNKS_DIR, INDEX_DIR, TREE_DIR, LOG_DIR):
        os.makedirs(d, exist_ok=True)


@dataclass
class RetrievalParams:
    """检索链路参数快照（供 /rag/status 与调试输出）。"""

    vector_top_k: int = VECTOR_TOP_K
    bm25_top_k: int = BM25_TOP_K
    rrf_k: int = RRF_K
    fuse_top_n: int = FUSE_TOP_N
    rerank_top_n: int = RERANK_TOP_N
    rerank_enabled: bool = RERANK_ENABLED
    subject_filter: bool = SUBJECT_FILTER
    min_score: float = MIN_SCORE
    embed_mock: bool = EMBED_MOCK
    embed_model: str = EMBED_MODEL_NAME
    embed_dim: int = EMBED_DIM

    def as_dict(self) -> Dict:
        return {k: v for k, v in self.__dict__.items()}