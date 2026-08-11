# -*- coding: utf-8 -*-
"""
数据持久化层（SQLite）
======================
统一存储：会话、对话记忆、长期学情记忆、任务、产物历史、模型配置。
数据库文件位于：backend/data/agent.db（与教师端 data 目录分离，便于独立管理）。

线程安全：SQLite 连接默认每线程一个，配合写锁序列化，满足本地单机低频并发。
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from typing import Any, Dict, List, Optional

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(_BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "agent.db")

# 产物落盘目录（相对教师端根目录）：备课产物资源包
ARTIFACT_ROOT = os.path.join(os.path.dirname(_BASE_DIR), "备课产物")

_lock = threading.Lock()
_local = threading.local()


def _conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        _local.conn = conn
    return conn


def init_db() -> None:
    """建表（幂等）。"""
    with _lock:
        conn = _conn()
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS models (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                provider TEXT NOT NULL DEFAULT 'openai',
                model TEXT NOT NULL DEFAULT '',
                base_url TEXT NOT NULL DEFAULT '',
                endpoint TEXT NOT NULL DEFAULT '',
                api_key_enc TEXT NOT NULL DEFAULT '',
                is_default INTEGER NOT NULL DEFAULT 0,
                updated_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                topic TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                model_name TEXT NOT NULL DEFAULT '',
                meta TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL DEFAULT 0,
                scope TEXT NOT NULL DEFAULT 'session',
                kind TEXT NOT NULL DEFAULT 'fact',
                content TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, kind);

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                session_id INTEGER NOT NULL DEFAULT 0,
                kind TEXT NOT NULL DEFAULT 'workflow',
                status TEXT NOT NULL DEFAULT 'pending',
                progress INTEGER NOT NULL DEFAULT 0,
                message TEXT NOT NULL DEFAULT '',
                input TEXT NOT NULL DEFAULT '',
                result TEXT NOT NULL DEFAULT '',
                error TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                started_at REAL,
                finished_at REAL
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, created_at);

            CREATE TABLE IF NOT EXISTS artifacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL DEFAULT 0,
                task_id TEXT NOT NULL DEFAULT '',
                filename TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                ext TEXT NOT NULL DEFAULT '',
                size INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at);
            """
        )
        conn.commit()


def _now() -> float:
    return time.time()


# ---------------------------------------------------------------------------
# 模型配置
# ---------------------------------------------------------------------------
def save_model(cfg: Dict[str, Any]) -> None:
    conn = _conn()
    with _lock:
        conn.execute(
            """INSERT INTO models(name, provider, model, base_url, endpoint, api_key_enc, is_default, updated_at)
               VALUES(?,?,?,?,?,?,?,?)
               ON CONFLICT(name) DO UPDATE SET provider=excluded.provider, model=excluded.model,
                 base_url=excluded.base_url, endpoint=excluded.endpoint,
                 api_key_enc=excluded.api_key_enc, is_default=excluded.is_default, updated_at=excluded.updated_at""",
            (
                cfg.get("name", ""),
                cfg.get("provider", "openai"),
                cfg.get("model", ""),
                cfg.get("base_url", ""),
                cfg.get("endpoint", ""),
                cfg.get("api_key_enc", ""),
                1 if cfg.get("is_default") else 0,
                _now(),
            ),
        )
        conn.commit()


def list_models() -> List[Dict[str, Any]]:
    conn = _conn()
    with _lock:
        rows = conn.execute("SELECT * FROM models ORDER BY is_default DESC, id ASC").fetchall()
    return [dict(r) for r in rows]


def get_model(name: str) -> Optional[Dict[str, Any]]:
    conn = _conn()
    with _lock:
        row = conn.execute("SELECT * FROM models WHERE name=?", (name,)).fetchone()
    return dict(row) if row else None


def get_default_model() -> Optional[Dict[str, Any]]:
    conn = _conn()
    with _lock:
        row = conn.execute("SELECT * FROM models WHERE is_default=1 ORDER BY id ASC LIMIT 1").fetchone()
    if row:
        return dict(row)
    with _lock:
        row = conn.execute("SELECT * FROM models ORDER BY id ASC LIMIT 1").fetchone()
    return dict(row) if row else None


def set_default_model(name: str) -> None:
    """原子地把指定模型设为默认：单事务内先清除全部默认位再置位，
    避免"先清后设"两步之间崩溃/并发导致 0 个或 2 个默认模型。"""
    conn = _conn()
    with _lock:
        try:
            conn.execute("UPDATE models SET is_default=0")
            conn.execute("UPDATE models SET is_default=1, updated_at=? WHERE name=?", (_now(), name))
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def cleanup_stale_tasks() -> int:
    """服务启动时把遗留的非终态任务标记为失败（进程重启会中断后台线程），
    避免脏任务永远停在 pending/running、SSE 订阅无限心跳。返回清理条数。"""
    conn = _conn()
    with _lock:
        cur = conn.execute(
            "UPDATE tasks SET status='failed', error=?, finished_at=? "
            "WHERE status IN ('pending','running','awaiting_input')",
            ("服务重启导致任务中断，请重新发起", _now()),
        )
        conn.commit()
        return cur.rowcount or 0


def delete_model(name: str) -> None:
    conn = _conn()
    with _lock:
        conn.execute("DELETE FROM models WHERE name=?", (name,))
        conn.commit()


# ---------------------------------------------------------------------------
# 会话
# ---------------------------------------------------------------------------
def create_session(topic: str = "", model_name: str = "") -> int:
    conn = _conn()
    with _lock:
        cur = conn.execute(
            "INSERT INTO sessions(topic, created_at, updated_at, model_name) VALUES(?,?,?,?)",
            (topic, _now(), _now(), model_name),
        )
        conn.commit()
        return int(cur.lastrowid)


def update_session(session_id: int, topic: str = "") -> None:
    conn = _conn()
    with _lock:
        conn.execute("UPDATE sessions SET updated_at=?, topic=? WHERE id=?", (_now(), topic, session_id))
        conn.commit()


def list_sessions(limit: int = 50) -> List[Dict[str, Any]]:
    conn = _conn()
    with _lock:
        rows = conn.execute(
            "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


def get_session(session_id: int) -> Optional[Dict[str, Any]]:
    conn = _conn()
    with _lock:
        row = conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    return dict(row) if row else None


def delete_session(session_id: int) -> None:
    conn = _conn()
    with _lock:
        conn.execute("DELETE FROM sessions WHERE id=?", (session_id,))
        conn.execute("DELETE FROM messages WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM memories WHERE session_id=?", (session_id,))
        # 级联删除任务与产物记录，避免遗留孤儿数据
        conn.execute("DELETE FROM tasks WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM artifacts WHERE session_id=?", (session_id,))
        conn.commit()


# ---------------------------------------------------------------------------
# 对话记忆
# ---------------------------------------------------------------------------
def add_message(session_id: int, role: str, content: str) -> None:
    conn = _conn()
    with _lock:
        conn.execute(
            "INSERT INTO messages(session_id, role, content, created_at) VALUES(?,?,?,?)",
            (session_id, role, content, _now()),
        )
        conn.commit()


def get_messages(session_id: int, limit: int = 100) -> List[Dict[str, Any]]:
    conn = _conn()
    with _lock:
        rows = conn.execute(
            "SELECT * FROM messages WHERE session_id=? ORDER BY id DESC LIMIT ?",
            (session_id, limit),
        ).fetchall()
    msgs = [dict(r) for r in rows]
    msgs.reverse()
    return msgs


# ---------------------------------------------------------------------------
# 长期记忆（学情 / 偏好）
# ---------------------------------------------------------------------------
def save_memory(session_id: int, scope: str, kind: str, content: str) -> None:
    conn = _conn()
    with _lock:
        conn.execute(
            """INSERT INTO memories(session_id, scope, kind, content, created_at, updated_at)
               VALUES(?,?,?,?,?,?)""",
            (session_id, scope, kind, content, _now(), _now()),
        )
        conn.commit()


def get_memories(session_id: int = 0, scope: str = "", kind: str = "") -> List[Dict[str, Any]]:
    conn = _conn()
    sql = "SELECT * FROM memories WHERE 1=1"
    args: List[Any] = []
    if session_id:
        sql += " AND session_id=?"
        args.append(session_id)
    if scope:
        sql += " AND scope=?"
        args.append(scope)
    if kind:
        sql += " AND kind=?"
        args.append(kind)
    sql += " ORDER BY id DESC LIMIT 200"
    with _lock:
        rows = conn.execute(sql, args).fetchall()
    return [dict(r) for r in rows]


def search_memories(keyword: str, limit: int = 20) -> List[Dict[str, Any]]:
    conn = _conn()
    with _lock:
        rows = conn.execute(
            "SELECT * FROM memories WHERE content LIKE ? ORDER BY id DESC LIMIT ?",
            ("%" + keyword + "%", limit),
        ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# 任务
# ---------------------------------------------------------------------------
def save_task(task: Dict[str, Any]) -> None:
    conn = _conn()
    with _lock:
        conn.execute(
            """INSERT OR REPLACE INTO tasks
               (id, session_id, kind, status, progress, message, input, result, error,
                created_at, started_at, finished_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                task.get("id", ""),
                task.get("session_id", 0),
                task.get("kind", "workflow"),
                task.get("status", "pending"),
                task.get("progress", 0),
                task.get("message", ""),
                task.get("input", ""),
                task.get("result", ""),
                task.get("error", ""),
                task.get("created_at", _now()),
                task.get("started_at"),
                task.get("finished_at"),
            ),
        )
        conn.commit()


def get_task(task_id: str) -> Optional[Dict[str, Any]]:
    conn = _conn()
    with _lock:
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    # result / error 为 JSON 字符串，反序列化
    for k in ("result", "error"):
        try:
            d[k] = json.loads(d[k]) if d[k] else None
        except Exception:
            pass
    return d


def list_tasks(session_id: int = 0, limit: int = 50) -> List[Dict[str, Any]]:
    conn = _conn()
    with _lock:
        if session_id:
            rows = conn.execute(
                "SELECT * FROM tasks WHERE session_id=? ORDER BY created_at DESC LIMIT ?",
                (session_id, limit),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        for k in ("result", "error"):
            try:
                d[k] = json.loads(d[k]) if d[k] else None
            except Exception:
                pass
        out.append(d)
    return out


def update_task_status(task_id: str, status: str, progress: int = None, message: str = None, result: Any = None, error: Any = None) -> None:
    conn = _conn()
    sets = []
    args: List[Any] = []
    if status is not None:
        sets.append("status=?")
        args.append(status)
    if progress is not None:
        sets.append("progress=?")
        args.append(progress)
    if message is not None:
        sets.append("message=?")
        args.append(message)
    if result is not None:
        sets.append("result=?")
        args.append(json.dumps(result, ensure_ascii=False))
    if error is not None:
        sets.append("error=?")
        args.append(json.dumps(error, ensure_ascii=False))
    if status in ("running",) and sets:
        # 仅在首次进入 running 时记录开始时间，避免进度更新反复刷新导致耗时失真
        sets.append("started_at=COALESCE(started_at, ?)")
        args.append(_now())
    if status in ("success", "failed", "cancelled"):
        sets.append("finished_at=?")
        args.append(_now())
    if not sets:
        return
    args.append(task_id)
    # 终态迁移守卫：只允许从非终态（pending/running）进入终态，
    # 防止超时/取消已置 failed/cancelled 后，worker 又把它覆盖回 success（任务"复活"）。
    terminal_guard = ""
    if status in ("success", "failed", "cancelled"):
        terminal_guard = " AND status IN ('pending','running')"
    with _lock:
        conn.execute("UPDATE tasks SET " + ", ".join(sets) + " WHERE id=?" + terminal_guard, args)
        conn.commit()


# ---------------------------------------------------------------------------
# 产物历史
# ---------------------------------------------------------------------------
def add_artifact(session_id: int, task_id: str, filename: str, rel_path: str, ext: str, size: int) -> None:
    conn = _conn()
    with _lock:
        conn.execute(
            "INSERT INTO artifacts(session_id, task_id, filename, rel_path, ext, size, created_at) VALUES(?,?,?,?,?,?,?)",
            (session_id, task_id, filename, rel_path, ext, size, _now()),
        )
        conn.commit()


def list_artifacts(session_id: int = 0, limit: int = 100) -> List[Dict[str, Any]]:
    conn = _conn()
    with _lock:
        if session_id:
            rows = conn.execute(
                "SELECT * FROM artifacts WHERE session_id=? ORDER BY id DESC LIMIT ?",
                (session_id, limit),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM artifacts ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]