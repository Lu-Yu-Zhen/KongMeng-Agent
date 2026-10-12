# -*- coding: utf-8 -*-
"""
会话与记忆服务
==============
- 会话生命周期管理（创建/续接/删除）
- 对话记忆落库：把一次工作流执行收进 messages
- 长期记忆：学情/偏好等跨会话事实，支持检索注入
"""
from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

from . import db


def ensure_session(session_id: Optional[int], topic: str = "", model_name: str = "") -> int:
    """确保会话存在；无则新建。返回会话 id。"""
    if session_id:
        s = db.get_session(session_id)
        if s:
            if topic:
                db.update_session(session_id, topic=topic)
            return session_id
    return db.create_session(topic=topic, model_name=model_name)


def history_for(session_id: int, limit: int = 40) -> List[Dict[str, str]]:
    """取会话对话历史，格式化为 workflow 需要的 [{role, content}]。"""
    msgs = db.get_messages(session_id, limit=limit)
    out = []
    for m in msgs:
        role = "assistant" if m.get("role") == "assistant" else "user"
        out.append({"role": role, "content": m.get("content", "")})
    return out


def record_turn(session_id: int, user_input: str, assistant_reply: str) -> None:
    """记录一轮人机对话。"""
    if user_input:
        db.add_message(session_id, "user", user_input)
    if assistant_reply:
        db.add_message(session_id, "assistant", assistant_reply[:200000])


def save_student_facts(session_id: int, facts: List[Dict[str, Any]]) -> None:
    """保存学情事实（scope='student'，kind 如 weak_point / preference / score）。"""
    for f in facts or []:
        content = f.get("content") or f.get("text") or ""
        if not content:
            continue
        db.save_memory(session_id, scope=f.get("scope", "student"), kind=f.get("kind", "fact"), content=str(content))


def memory_context(session_id: int, keyword: str = "") -> str:
    """把相关记忆拼成注入上下文的文本，供 workflow 使用。"""
    rows = []
    if keyword:
        rows = db.search_memories(keyword, limit=15)
    else:
        rows = db.get_memories(session_id=session_id, scope="student", kind="fact")[:15]
    if not rows:
        return ""
    lines = []
    for r in rows:
        lines.append("- " + str(r.get("content", "")))
    return "已知学情/偏好：\n" + "\n".join(lines)


def summarize_memories(session_id: int) -> List[Dict[str, Any]]:
    rows = db.get_memories(session_id=session_id)
    return [dict(r) for r in rows]