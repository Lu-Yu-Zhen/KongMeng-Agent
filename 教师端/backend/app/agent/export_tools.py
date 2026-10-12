# -*- coding: utf-8 -*-
"""产物生成 MCP 工具（Qoder Agent SDK · 进程内 server：kongmeng-export）
=======================================================================
把「教案生成」「PPT 生成」以 tool() 封装给备课 Agent：
  - gen_lesson_plan(markdown, topic...) → 质量硬校验（十大板块/≥3000 字/数据引用/
    环节充实度/占位词）→ docx 落盘「备课产物/」→ 返回路径+质量评分；
  - gen_ppt(slidesJson, topic...)       → 质量硬校验（≥12 页/每页要点字数/总结提炼/
    版式多样性≥6 种/图表页·案例页必备/单一版式≤50%）→ 多版式渲染 pptx。

校验失败时返回 isError=True + 具体问题清单 —— Agent 在 SDK 循环内能看到失败
原因并自行修正后重试（质量要求内建于工具层，而非仅靠提示词约束）。

生成的文件登记到 EXPORT_REGISTRY（进程内会话级），由 /api/agent/lesson_prep
在 Agent 运行结束后取走并登记产物历史。
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from typing import Any, Dict, List

from .scripts import lesson_plan_writer, ppt_generator

MCP_EXPORT_SERVER_NAME = "kongmeng-export"

_TEACHER_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))  # backend/app/agent → 项目根（孔孟智能体）
ARTIFACT_ROOT = os.path.join(_TEACHER_ROOT, "备课产物")

_lock = threading.Lock()
_current_dir: Dict[str, str] = {}


def _export_dir() -> str:
    """本次会话的产物目录（首个生成调用时创建）。"""
    with _lock:
        if "dir" not in _current_dir:
            stamp = time.strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:6]
            d = os.path.join(ARTIFACT_ROOT, f"Qoder备课_{stamp}")
            os.makedirs(d, exist_ok=True)
            _current_dir["dir"] = d
        return _current_dir["dir"]


def reset_registry() -> None:
    with _lock:
        _current_dir.clear()


EXPORT_REGISTRY: List[Dict[str, Any]] = []


def _register(kind: str, quality: Dict[str, Any]) -> None:
    EXPORT_REGISTRY.append({"kind": kind, **{k: v for k, v in quality.items() if k != "path"},
                            "path": quality.get("path", ""), "relPath": _rel(quality.get("path", ""))})


def _rel(p: str) -> str:
    try:
        return os.path.relpath(p, _TEACHER_ROOT).replace("\\", "/")
    except Exception:
        return p


def generate_lesson_plan_tool(markdown: str, topic: str = "") -> Dict[str, Any]:
    """教案生成核心（工具 handler 与 mock 引擎共用）。不达标抛 ValueError。"""
    path = os.path.join(_export_dir(), "教案.docx")
    quality = lesson_plan_writer.generate_lesson_plan(markdown, path)
    quality["topic"] = topic
    _register("lesson_plan", quality)
    return quality


def generate_ppt_tool(slides: List[Dict[str, Any]], meta: Dict[str, Any]) -> Dict[str, Any]:
    """PPT 生成核心。不达标抛 ValueError。"""
    path = os.path.join(_export_dir(), "PPT课件.pptx")
    quality = ppt_generator.generate_ppt(slides, path, meta)
    _register("ppt", quality)
    return quality


# ---------------------------------------------------------------------------
# SDK tool 封装（进程内 MCP）
# ---------------------------------------------------------------------------
def tool_full_names() -> List[str]:
    return [
        f"mcp__{MCP_EXPORT_SERVER_NAME}__gen_lesson_plan",
        f"mcp__{MCP_EXPORT_SERVER_NAME}__gen_ppt",
    ]


def build_sdk_mcp_server() -> Any:
    from mcp.types import ToolAnnotations
    from qoder_agent_sdk import create_sdk_mcp_server, tool

    lesson_schema = {
        "type": "object",
        "properties": {
            "markdown": {"type": "string",
                         "description": "完整教案 Markdown（必须包含：课标依据/学情分析(含掌握率数据引用)/教学目标/教学重难点/教学过程(每环节≥80字)/例题与变式/分层作业/板书设计/教学反思/数据使用说明；全文≥3000字，禁止『略』等占位表述）"},
            "topic": {"type": "string", "description": "课题名"},
        },
        "required": ["markdown"],
    }
    ppt_schema = {
        "type": "object",
        "properties": {
            "slidesJson": {"type": "string",
                           "description": "PPT 页面 JSON 数组字符串。每页字段：layout(title|toc|concept|case|chart|twocolumn|table|summary|end)、title、points(要点数组，每个内容页≥2条且合计≥60字)、box(概念页定义框)、caseText(案例页题干≥40字)、plotSpec({kind:function|bar|line,expr,range,labels,values})、chartData({labels,values,title})、table({headers,rows≥3})、summary(总结提炼≥15字，concept/case/summary 页必填)。要求≥12页、版式≥6种、必须含 chart 页与 case 页与(分栏或表格)页"},
            "subject": {"type": "string"},
            "grade": {"type": "string"},
        },
        "required": ["slidesJson"],
    }

    def _ok(payload: Dict[str, Any]) -> Dict[str, Any]:
        return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]}

    def _fail(msg: str) -> Dict[str, Any]:
        return {"isError": True,
                "content": [{"type": "text", "text": json.dumps({"error": msg}, ensure_ascii=False)}]}

    @tool("gen_lesson_plan",
          "把完整教案 Markdown 渲染为 docx。会先做质量硬校验（十大板块齐备、≥3000字、学情分析引用掌握率数据、每环节≥80字、无占位表述）；校验失败会返回具体问题清单，请修正后重试。",
          lesson_schema,
          ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False))
    async def _gen_lesson(args):  # noqa: ANN202
        try:
            q = generate_lesson_plan_tool(str(args.get("markdown") or ""), str(args.get("topic") or ""))
            return _ok({"ok": True, **q})
        except ValueError as e:
            return _fail(str(e))
        except Exception as e:  # noqa: BLE001
            return _fail(f"生成异常：{e}")

    @tool("gen_ppt",
          "把 PPT 页面 JSON 渲染为多版式 pptx（标题/目录/概念/图文案例/图表/分栏/表格/总结/结束九种版式）。会先做质量硬校验（≥12页、每内容页要点≥2条且≥60字、总结提炼≥15字、版式≥6种、单一版式≤50%、必含图表页+案例页+分栏或表格页、禁占位词）；失败返回问题清单，请充实内容后重试。",
          ppt_schema,
          ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False))
    async def _gen_ppt(args):  # noqa: ANN202
        try:
            raw = str(args.get("slidesJson") or "").strip()
            raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            slides = json.loads(raw)
            meta = {"subject": str(args.get("subject") or ""), "grade": str(args.get("grade") or ""),
                    "topic": ""}
            q = generate_ppt_tool(slides, meta)
            return _ok({"ok": True, **q})
        except json.JSONDecodeError as e:
            return _fail(f"slidesJson 不是合法 JSON：{e}")
        except ValueError as e:
            return _fail(str(e))
        except Exception as e:  # noqa: BLE001
            return _fail(f"生成异常：{e}")

    return create_sdk_mcp_server(name=MCP_EXPORT_SERVER_NAME, version="1.0.0",
                                 tools=[_gen_lesson, _gen_ppt])
