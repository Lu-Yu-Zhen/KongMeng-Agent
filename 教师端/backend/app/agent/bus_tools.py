# -*- coding: utf-8 -*-
"""学情数据总线 · 进程内 MCP 工具（只读）。

以 Qoder Agent SDK 的 tool() + create_sdk_mcp_server() 暴露给备课 Agent：
- 工具全名：mcp__kongmeng-data__<tool_name>（权限白名单按完整名收窄）；
- 全部标注 readOnlyHint=True（仅是元信息提示，真正的放行由 allowedTools + canUseTool 决定）；
- handler 内做 scope 裁剪（最小必要）：只返回聚合与伪 ID 画像，不返回任何
  真实姓名 / 联系方式等 L1 直接标识符。
"""
from __future__ import annotations

import inspect
import json
from typing import Any, Dict, List

from .. import databus, kb

MCP_SERVER_NAME = "kongmeng-data"


# ---------------------------------------------------------------------------
# 工具实现（同步核心逻辑，SDK 装饰器会包一层 async handler）
# ---------------------------------------------------------------------------
def _tool_query_data_usage(subject: str = "") -> Dict[str, Any]:
    """四板块数据登记情况总览（备课「数据使用说明」的依据）。"""
    return databus.data_usage(subject=str(subject or ""))


def _tool_query_class_stats(class_id: str, subject: str) -> Dict[str, Any]:
    """班级画像：知识点掌握率、薄弱/盲区清单、分层分布、近 30 天高频提问。"""
    return databus.class_stats(str(class_id or ""), str(subject or ""))


def _tool_query_student_profile(pseudo_id: str, subject: str = "") -> Dict[str, Any]:
    """个体画像（伪 ID 级）：各知识点掌握率/分层/提问频次/证据批改记录 ID。"""
    return databus.query_profile(str(pseudo_id or ""), subject=str(subject or ""))


def _tool_query_kb(subject: str, topic: str) -> Dict[str, Any]:
    """教材知识库检索（RAG 混合检索优先，空索引回退子串匹配）。"""
    r = kb.retrieve(subject=str(subject or ""), topic=str(topic or ""))
    # 精简返回：只保留备课需要的字段，控制上下文体积
    nodes = []
    for n in (r.get("matched_nodes") or [])[:8]:
        nodes.append({
            "kp_id": n.get("kp_id"),
            "subject": n.get("subject"),
            "knowledge_point": n.get("knowledge_point"),
            "chapter": n.get("chapter"),
            "section": n.get("section"),
            "difficulty": n.get("difficulty"),
            "text": (n.get("text") or "")[:300],
        })
    return {"engine": r.get("engine"), "matched_nodes": nodes, "count": len(nodes)}


def _tool_memory_read(scope: str = "lesson_prep", topic: str = "") -> Dict[str, Any]:
    """备课记忆读取（scope 裁剪：仅班级层薄弱摘要与近期备课备注，不含个体明文）。"""
    from .. import db

    notes = db.get_memories(scope="prep", kind="note")[:10] if scope == "lesson_prep" else []
    return {
        "scope": scope,
        "recentPrepNotes": [
            {"content": n.get("content", ""), "updatedAt": n.get("updated_at")} for n in notes
        ],
        "topic": topic,
    }


TOOL_IMPLS = {
    "query_data_usage": (_tool_query_data_usage, "查询四板块（提问/批改/成绩/画像）数据登记总览。生成任何内容前必须先调用。"),
    "query_class_stats": (_tool_query_class_stats, "查询班级学情统计：知识点掌握率、薄弱/盲区知识点、考试分层人数、近30天高频提问知识点。"),
    "query_student_profile": (_tool_query_student_profile, "按伪 ID 查询学生个体画像（各知识点掌握率、分层、提问频次）。仅在教师点名关注某学生时使用。"),
    "query_kb": (_tool_query_kb, "检索教材知识库：返回课题相关的知识点编码、章节、难度与要点摘录。"),
    "memory_read": (_tool_memory_read, "读取备课记忆（近期备注）。scope 固定传 lesson_prep。"),
}


def tool_full_names() -> List[str]:
    """全部工具的完整名（mcp__<server>__<tool>），用于权限白名单。"""
    return [f"mcp__{MCP_SERVER_NAME}__{name}" for name in TOOL_IMPLS]


def build_sdk_mcp_server() -> Any:
    """构建进程内 MCP server（Qoder Agent SDK）。SDK 缺失时抛 ImportError。"""
    from mcp.types import ToolAnnotations
    from qoder_agent_sdk import create_sdk_mcp_server, tool

    sdk_tools = []
    for name, (impl, desc) in TOOL_IMPLS.items():
        schema = {
            "type": "object",
            "properties": {
                "subject": {"type": "string", "description": "学科，如 数学/物理/英语"},
                "class_id": {"type": "string", "description": "班级 ID，如 G3-2"},
                "pseudo_id": {"type": "string", "description": "学生伪 ID，如 P1001"},
                "topic": {"type": "string", "description": "课题关键词"},
                "scope": {"type": "string", "description": "记忆范围，固定 lesson_prep"},
            },
            "required": [],
        }

        def _make_handler(fn):
            # 按 impl 真实签名过滤传参：各工具只声明自己需要的参数，
            # 避免把 subject/class_id/pseudo_id/topic/scope 全量传入导致 TypeError。
            try:
                _params = set(inspect.signature(fn).parameters)
            except (TypeError, ValueError):  # 签名不可见时不过滤，保持原行为
                _params = None

            async def _handler(args):
                try:
                    raw = {
                        "subject": str((args or {}).get("subject") or ""),
                        "class_id": str((args or {}).get("class_id") or ""),
                        "pseudo_id": str((args or {}).get("pseudo_id") or ""),
                        "topic": str((args or {}).get("topic") or ""),
                        "scope": str((args or {}).get("scope") or "lesson_prep"),
                    }
                    kwargs = raw if _params is None else {k: v for k, v in raw.items() if k in _params}
                    data = fn(**kwargs)
                    return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}]}
                except Exception as e:  # noqa: BLE001
                    return {
                        "isError": True,
                        "content": [{"type": "text", "text": json.dumps({"error": str(e)}, ensure_ascii=False)}],
                    }

            return _handler

        wrapped = tool(
            name,
            desc,
            schema,
            ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False),
        )(_make_handler(impl))
        sdk_tools.append(wrapped)

    return create_sdk_mcp_server(name=MCP_SERVER_NAME, version="1.0.0", tools=sdk_tools)
