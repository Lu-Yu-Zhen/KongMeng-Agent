# -*- coding: utf-8 -*-
"""
模型管理与推理
================
提供 Embedder / Reranker 的懒加载封装。
生产：加载 ONNX int8 量化模型（bge-large-zh-v1.5 / bge-reranker-v2-m3）。
开发/无模型：提供确定性 mock 向量（hash 分段），保证离线链路可端到端自测。
"""
from __future__ import annotations

import hashlib
import logging
import os
from typing import Any, Dict, List, Optional

from . import config

log = logging.getLogger("teacher-backend.rag")


class Embedder:
    """文本向量化器。生产用 ONNX，否则退回确定性 mock 向量。"""

    def __init__(self, model_name: str = "", dim: int = 0, mock: bool = True):
        self.model_name = model_name or config.EMBED_MODEL_NAME
        self.dim = dim or config.EMBED_DIM
        self.mock = mock
        self._model: Optional[Any] = None
        self._tokenizer: Optional[Any] = None

    # ---- 加载 ----
    def _load_onnx(self) -> bool:
        """尝试加载 ONNX 模型。目录约定：{MODEL_DIR}/{model_name}/model.onnx + tokenizer.json。"""
        model_dir = os.path.join(config.MODEL_DIR, self.model_name)
        onnx_path = os.path.join(model_dir, "model.onnx")
        if not os.path.exists(onnx_path):
            log.warning("未找到 ONNX embedding 模型：%s，回退 mock 向量", onnx_path)
            return False
        try:
            import onnxruntime as ort
            from tokenizers import Tokenizer  # 可选依赖
            self._model = ort.InferenceSession(
                onnx_path, providers=["CPUExecutionProvider"]
            )
            tok_path = os.path.join(model_dir, "tokenizer.json")
            if os.path.exists(tok_path):
                self._tokenizer = Tokenizer.from_file(tok_path)
            self.mock = False
            log.info("已加载 ONNX embedding 模型：%s（dim=%d）", self.model_name, self.dim)
            return True
        except Exception as e:  # pragma: no cover
            log.warning("ONNX embedding 加载失败：%s，回退 mock", e)
            self._model = None
            self.mock = True
            return False

    def ensure_loaded(self) -> None:
        if self._model is None and not self.mock:
            self._load_onnx()

    # ---- 推理 ----
    def _mock_vec(self, text: str) -> List[float]:
        """确定性 mock 向量：对文本做 8 段 hash 拼接，归一化到 [0,1]。仅用于链路自测。"""
        vec = []
        for i in range(self.dim):
            h = hashlib.blake2b(text.encode("utf-8"), digest_size=8, salt=f"rag{i}".encode())
            v = int.from_bytes(h.digest()[:4], "little") / (2 ** 32)
            vec.append(v)
        # 显式归一化，避免量级差异
        norm = sum(x * x for x in vec) ** 0.5 or 1.0
        return [x / norm for x in vec]

    def _onnx_vec(self, text: str) -> List[float]:
        # 生产：tokenize -> 推理 -> 归一化
        if self._tokenizer is not None:
            enc = self._tokenizer.encode(text)
            ids = enc.ids[: config.EMBED_MAX_TOKENS]
            attn = [1] * len(ids)
        else:
            ids = [ord(c) % 1000 for c in text[: config.EMBED_MAX_TOKENS]]
            attn = [1] * len(ids)
        if not ids:
            ids, attn = [0], [0]
        out = self._model.run(None, {"input_ids": [ids], "attention_mask": [attn]})[0][0]
        # 平均池化 + L2 归一化
        vec = [float(x) for x in out[: self.dim]]
        norm = sum(x * x for x in vec) ** 0.5 or 1.0
        return [x / norm for x in vec]

    def embed(self, text: str) -> List[float]:
        text = (text or "").strip()
        if not text:
            return [0.0] * self.dim
        if self.mock:
            return self._mock_vec(text)
        try:
            self.ensure_loaded()
            return self._onnx_vec(text)
        except Exception as e:  # pragma: no cover
            log.warning("embedding 推理失败，回退 mock：%s", e)
            return self._mock_vec(text)

    def embed_batch(self, texts: List[str]) -> List[List[float]]:
        return [self.embed(t) for t in texts]

    def reset_onnx(self) -> None:
        """清除已加载的 ONNX 模型，下次调用时重新加载（用于模型损坏恢复）。"""
        self._model = None
        self._tokenizer = None


class Reranker:
    """重排器（Cross-Encoder）。生产用 ONNX bge-reranker，否则禁用重排。"""

    def __init__(self, enabled: bool = True):
        self.enabled = enabled and config.RERANK_ENABLED
        self._model: Optional[Any] = None
        self._tokenizer: Optional[Any] = None
        self._load_tried = False  # 已尝试加载（成功或失败均置 True），避免反复打日志

    def _load_onnx(self) -> bool:
        if self._load_tried:
            return self._model is not None
        model_dir = os.path.join(config.MODEL_DIR, config.RERANK_MODEL_NAME)
        onnx_path = os.path.join(model_dir, "model.onnx")
        if not os.path.exists(onnx_path):
            log.info("未找到 ONNX reranker 模型：%s，重排禁用", onnx_path)
            self._load_tried = True
            return False
        try:
            import onnxruntime as ort
            from tokenizers import Tokenizer
            self._model = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
            tok_path = os.path.join(model_dir, "tokenizer.json")
            if os.path.exists(tok_path):
                self._tokenizer = Tokenizer.from_file(tok_path)
            return True
        except Exception as e:  # pragma: no cover
            log.warning("ONNX reranker 加载失败，重排禁用：%s", e)
            self._model = None
            self._load_tried = True
            return False

    def ready(self) -> bool:
        if not self.enabled:
            return False
        if self._model is None:
            self._load_onnx()
        return self._model is not None

    def score(self, query: str, docs: List[str]) -> Optional[List[float]]:
        """返回与 docs 等长的重排分数（越高越相关）；不可用时返回 None。"""
        if not self.ready() or not docs:
            return None
        try:
            pairs = [(query, d[: config.RERANK_MAX_TOKENS]) for d in docs]
            # 简易 tokenize（生产应使用真实 tokenizer）
            q_ids = self._tokenizer.encode(query).ids if self._tokenizer else [ord(c) % 1000 for c in query]
            scores = []
            for _, d in pairs:
                d_ids = self._tokenizer.encode(d).ids if self._tokenizer else [ord(c) % 1000 for c in d]
                ids = (q_ids + d_ids)[: config.RERANK_MAX_TOKENS]
                attn = [1] * len(ids)
                logits = self._model.run(None, {"input_ids": [ids], "attention_mask": [attn]})[0][0]
                scores.append(float(logits[0]))
            return scores
        except Exception as e:  # pragma: no cover
            log.warning("rerank 推理失败：%s", e)
            return None


# 全局单例（懒加载）
_EMBEDDER: Optional[Embedder] = None
_RERANKER: Optional[Reranker] = None


def get_embedder() -> Embedder:
    global _EMBEDDER
    if _EMBEDDER is None:
        _EMBEDDER = Embedder(model_name=config.EMBED_MODEL_NAME, dim=config.EMBED_DIM, mock=config.EMBED_MOCK)
    return _EMBEDDER


def get_reranker() -> Reranker:
    global _RERANKER
    if _RERANKER is None:
        _RERANKER = Reranker(enabled=config.RERANK_ENABLED)
    return _RERANKER


def reset() -> None:
    """测试用：重置单例。"""
    global _EMBEDDER, _RERANKER
    _EMBEDDER = None
    _RERANKER = None