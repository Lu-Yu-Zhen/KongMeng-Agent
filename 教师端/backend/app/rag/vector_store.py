# -*- coding: utf-8 -*-
"""
sqlite-vec 向量库封装
======================
基于 SQLite 的 vec0 虚拟表，与现有 db.py(SQLite) 技术栈统一、零依赖、离线可用。
支持：建表、批量写入、KNN 检索（按学科/知识点过滤）、增量删除与重建。
"""
from __future__ import annotations

import logging
import os
import sqlite3
from typing import Any, Dict, List, Optional

from . import config

log = logging.getLogger("teacher-backend.rag")

_LOADED = False


def _load_vec(con: sqlite3.Connection) -> None:
    """加载 sqlite-vec 扩展（首调用时尝试 import 并注册）。"""
    global _LOADED
    if not _LOADED:
        import sqlite_vec

        con.enable_load_extension(True)
        sqlite_vec.load(con)
        _LOADED = True


class VectorStore:
    """向量库封装（sqlite-vec）。"""

    def __init__(self, path: str = ""):
        self.path = path or config.VECTOR_DB_PATH
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self._con: Optional[sqlite3.Connection] = None

    # ---- 连接 ----
    def connect(self) -> sqlite3.Connection:
        if self._con is None:
            self._con = sqlite3.connect(self.path)
            _load_vec(self._con)
        return self._con

    def close(self) -> None:
        if self._con is not None:
            self._con.close()
            self._con = None

    # ---- 建表 ----
    def create(self, dim: Optional[int] = None) -> None:
        dim = dim or config.EMBED_DIM
        con = self.connect()
        con.execute(
            f"""
            CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
                chunk_id TEXT PRIMARY KEY,
                embedding float[{dim}],
                subject TEXT,
                kp_id TEXT,
                knowledge_point TEXT,
                module TEXT,
                chapter TEXT,
                section TEXT,
                chunk_type TEXT,
                difficulty INTEGER,
                level TEXT,
                source TEXT,
                text TEXT
            )
            """
        )
        con.commit()

    # ---------------- 写入 ----------------
    def upsert_many(self, rows: List[Dict[str, Any]]) -> int:
        """批量写入分块向量。rows 需含 chunk_id / embedding / 元数据字段。"""
        if not rows:
            return 0
        con = self.connect()
        # 先按主键删除，实现幂等增量
        ids = [r["chunk_id"] for r in rows]
        placeholders = ",".join("?" * len(ids))
        con.execute(f"DELETE FROM vec_chunks WHERE chunk_id IN ({placeholders})", ids)
        inserts = []
        for r in rows:
            emb = r.get("embedding") or []
            vec_sql = "[" + ",".join(repr(float(x)) for x in emb) + "]"
            inserts.append(
                (
                    r["chunk_id"],
                    vec_sql,
                    r.get("subject", ""),
                    r.get("kp_id", ""),
                    r.get("knowledge_point", ""),
                    r.get("module", ""),
                    r.get("chapter", ""),
                    r.get("section", ""),
                    r.get("chunk_type", ""),
                    int(r.get("difficulty", 0)),
                    r.get("level", ""),
                    r.get("source", ""),
                    r.get("text", ""),
                )
            )
        con.executemany(
            """
            INSERT INTO vec_chunks(chunk_id, embedding, subject, kp_id, knowledge_point,
                                    module, chapter, section, chunk_type, difficulty, level, source, text)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            inserts,
        )
        con.commit()
        return len(inserts)

    def delete_by_kp(self, kp_ids: List[str]) -> int:
        if not kp_ids:
            return 0
        con = self.connect()
        placeholders = ",".join("?" * len(kp_ids))
        cur = con.execute(f"DELETE FROM vec_chunks WHERE kp_id IN ({placeholders})", kp_ids)
        con.commit()
        return cur.rowcount

    def clear(self) -> None:
        con = self.connect()
        con.execute("DELETE FROM vec_chunks")
        con.commit()

    def count(self) -> int:
        con = self.connect()
        return con.execute("SELECT COUNT(*) FROM vec_chunks").fetchone()[0]

    # ---------------- KNN 检索 ----------------
    def knn(self, embedding: List[float], k: int = 10, subject: Optional[str] = None) -> List[Dict[str, Any]]:
        con = self.connect()
        vec_sql = "[" + ",".join(repr(float(x)) for x in embedding) + "]"
        k = max(1, min(int(k), 1000))
        cols = "chunk_id, kp_id, subject, knowledge_point, module, chapter, section, " \
               "chunk_type, difficulty, level, source, text, distance"
        if subject:
            sql = (
                f"SELECT {cols} FROM vec_chunks WHERE subject = ? AND embedding MATCH ? "
                f"AND k = ? ORDER BY distance"
            )
            rows = con.execute(sql, [subject, vec_sql, k]).fetchall()
        else:
            sql = f"SELECT {cols} FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance"
            rows = con.execute(sql, [vec_sql, k]).fetchall()
        col_names = ["chunk_id", "kp_id", "subject", "knowledge_point", "module", "chapter",
                     "section", "chunk_type", "difficulty", "level", "source", "text", "distance"]
        return [dict(zip(col_names, r)) for r in rows]

    def health(self) -> Dict[str, Any]:
        try:
            n = self.count()
            return {"ok": True, "chunks": n, "path": self.path}
        except Exception as e:
            return {"ok": False, "error": str(e)}


# 全局单例
_STORE: Optional[VectorStore] = None


def get_store() -> VectorStore:
    global _STORE
    if _STORE is None:
        _STORE = VectorStore()
    return _STORE


def reset() -> None:
    global _STORE
    if _STORE is not None:
        _STORE.close()
    _STORE = None