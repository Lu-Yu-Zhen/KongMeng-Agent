# -*- coding: utf-8 -*-
"""
工作流业务路由
==============
封装 workflow.py 的调用，形成完整智能体执行链路：
  意图路由 → 多轮追问 → 内容生成 → 质量校验 → 产物落盘 → 记忆/对话记录
支持：
  - 同步调用（兼容旧前端 /api/workflow/run、/continue、/export）
  - 异步任务（配合 task_queue，SSE 推送进度）
"""
from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

import workflow  # noqa: E402

from . import config, db, exporter, memory, task_queue


# ---------------------------------------------------------------------------
# 收集产物
# ---------------------------------------------------------------------------
_LLM_ERR_PREFIX = "[LLM_ERROR]"


def _is_llm_error(text: str) -> bool:
    """判断一段文本是否为 LLM 调用失败的回传（BaseLLM.invoke 捕获异常后返回）。"""
    return bool(text) and text.strip().startswith(_LLM_ERR_PREFIX)


def _llm_error_text(text: str) -> str:
    return text.strip()[len(_LLM_ERR_PREFIX):].strip() if _is_llm_error(text) else ""


def collect_products(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    products = []
    for pid, spec in workflow.PRODUCERS.items():
        res = state.get(pid) or {}
        content = res.get("content") or ""
        if not content or res.get("skipped"):
            continue
        # 过滤 LLM 调用失败产生的占位内容，绝不把错误字符串当产物落盘
        if _is_llm_error(content):
            continue
        # 质量门：未达标产物不进入交付清单（导出层同样拒绝落盘）
        if res.get("ok") is False:
            continue
        q = res.get("quality") or {}
        products.append(
            {
                "id": pid,
                "name": spec.get("name", pid),
                "domain": spec.get("domain", "teaching"),
                "export": spec.get("export", "md"),
                "content": content[:80000],
                "ok": res.get("ok", False),
                "rounds": res.get("rounds", 1),
                "qualityScore": q.get("score"),
                "qualityPassed": q.get("passed"),
            }
        )
    return products


def _apply_answers(state: Dict[str, Any], answers: Dict[str, Any]) -> List[Dict[str, str]]:
    if not answers:
        return []
    parts = []
    for k, v in answers.items():
        if v is None:
            continue
        if isinstance(v, list):
            parts.append(f"{k}：{'、'.join(str(x) for x in v)}")
        else:
            parts.append(f"{k}：{v}")
    if not parts:
        return []
    return [{"role": "user", "content": "补充：" + "；".join(parts)}]


def _serialize(state: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, v in state.items():
        if isinstance(v, dict):
            try:
                json.dumps(v)
                out[k] = v
            except Exception:
                out[k] = {"_nonSerializable": True}
        elif isinstance(v, list):
            try:
                json.dumps(v)
                out[k] = v
            except Exception:
                out[k] = []
        elif isinstance(v, (str, int, float, bool)) or v is None:
            out[k] = v
    return out


# ---------------------------------------------------------------------------
# 同步执行
# ---------------------------------------------------------------------------
def run_sync(input_text: str, history: List[Dict[str, Any]]) -> Dict[str, Any]:
    state = workflow.run(input_text, history=history or [])
    return _serialize(state)


def run_with_answers(input_text: str, history: List[Dict[str, Any]], answers: Dict[str, Any], state_prev: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    h = list(history or [])
    h.extend(_apply_answers(state_prev or {}, answers))
    state = workflow.run(input_text, history=h)
    return _serialize(state)


# ---------------------------------------------------------------------------
# 异步执行（供 task_queue 注册）
# ---------------------------------------------------------------------------
def _register_async_executor() -> None:
    task_queue.register_executor("workflow", _run_workflow_task)


def _run_workflow_task(task_id: str, payload: Dict[str, Any], task: task_queue.Task) -> Dict[str, Any]:
    """异步工作流执行器：完整链路 + 进度推送 + 记忆 + 产物落盘。"""
    input_text = str(payload.get("input") or "").strip()
    # 兼容两种键名：api 层写入的是驼峰 sessionId（此前只读 session_id 导致恒为 0、会话贯通失效）
    session_id = int(payload.get("session_id", payload.get("sessionId")) or 0)
    topic = str(payload.get("topic") or "")
    history = payload.get("history") or []
    mem_keyword = str(payload.get("memoryKeyword") or "") or str(input_text)[:20]

    # 确保会话存在
    dm = db.get_default_model()
    model_name = dm.get("name", "") if dm else ""
    session_id = memory.ensure_session(session_id, topic=topic, model_name=model_name)
    payload["session_id_effective"] = session_id

    # 记忆回注：前端未传 history 时用会话历史补齐多轮上下文；
    # 并注入检索到的学情/偏好（此前 history_for/memory_context 从未被调用，记忆只记不用）。
    if not history:
        try:
            history = memory.history_for(session_id, limit=20) or []
        except Exception:
            history = []
    try:
        mem_ctx = memory.memory_context(session_id, keyword=mem_keyword)
        if mem_ctx:
            history = [{"role": "user", "content": mem_ctx}] + list(history)
    except Exception:
        pass

    task.emit({"type": "stage", "stage": "intent", "progress": 5, "message": "意图识别与任务路由…"})
    state = workflow.run(input_text, history=history)

    # 追问循环
    max_clarify = 3
    round_no = 0
    while (
        state.get("pending_questions")
        and len(state.get("pending_questions", [])) > 0
        and round_no < max_clarify
    ):
        if task.check_cancelled():
            raise InterruptedError("任务已取消")
        round_no += 1
        task.emit({"type": "stage", "stage": "clarify", "progress": 10 + round_no * 5, "message": "需要教师补充关键信息…"})
        # 追问需要外部答案：中止异步，返回 pending 给前端，由前端调 continue
        return {
            "ok": True,
            "pending": True,
            "pendingQuestions": state.get("pending_questions"),
            "infoComplete": state.get("info_complete", False),
            "state": state,
            "sessionId": session_id,
        }

    if task.check_cancelled():
        raise InterruptedError("任务已取消")

    # 内容生成阶段
    task.emit({"type": "stage", "stage": "generate", "progress": 30, "message": "正在生成教学内容…"})
    products = collect_products(state)

    # 若所有产物都因"模型调用失败"或"质量不达标"而未产出，则明确失败（而非返回成功 + 空/垃圾产物）
    if not products:
        llm_errs = []
        quality_fails = []
        for pid, spec in workflow.PRODUCERS.items():
            res = state.get(pid) or {}
            content = res.get("content") or ""
            if _is_llm_error(content):
                reason = _llm_error_text(content)
                if reason and reason not in llm_errs:
                    llm_errs.append(reason)
            elif content and res.get("ok") is False and not res.get("skipped"):
                q = res.get("quality") or {}
                quality_fails.append(spec.get("name", pid) + "（" + str(q.get("score", 0)) + "分）")
        if llm_errs:
            raise RuntimeError("模型调用失败：" + "；".join(llm_errs[:3]) + "。请检查网络连接或更换模型后重试。")
        if quality_fails:
            raise RuntimeError("全部产物质量检测未达标，已拒绝交付：" + "、".join(quality_fails[:5]) + "。请调整需求描述或更换更强模型后重试。")

    # 产物落盘
    artifacts = []
    if products:
        task.emit({"type": "stage", "stage": "export", "progress": 85, "message": "正在导出文档…"})
        artifacts = exporter.export_workflow(state, session_id=session_id, task_id=task_id)
        task.emit({"type": "stage", "stage": "export", "progress": 92, "message": "文档已导出 " + str(len(artifacts)) + " 个"})

    # 最终回答
    final = state.get("final") or {}
    answer = final.get("summary") or ""
    if _is_llm_error(answer):
        answer = ""  # summary 也被模型失败污染时，改用兜底文案
    if not answer and products:
        answer = "已为您生成 " + str(len(products)) + " 个产物：" + "、".join(p["name"] for p in products) + "，请到产物区查看。"
    if not answer:
        answer = "工作流执行完成。"

    # 记录对话与学情记忆
    memory.record_turn(session_id, input_text, answer)
    parsed = state.get("parsed") or {}
    if parsed.get("student_tags"):
        memory.save_student_facts(
            session_id,
            [{"scope": "student", "kind": "tag", "content": "学生标签：" + "、".join(parsed["student_tags"])}],
        )

    task.emit({"type": "stage", "stage": "done", "progress": 100, "message": "完成"})

    return {
        "ok": True,
        "pending": False,
        "answer": answer,
        "products": products,
        "artifacts": artifacts,
        "tasks": state.get("tasks", []),
        "final": final,
        "sessionId": session_id,
        "state": state,
    }


# ---------------------------------------------------------------------------
# 异步导出（可选：前端用 base64 拉取单文件）
# ---------------------------------------------------------------------------
def _register_async_export() -> None:
    task_queue.register_executor("export", _run_export_task)


def _run_export_task(task_id: str, payload: Dict[str, Any], task: task_queue.Task) -> Dict[str, Any]:
    input_text = str(payload.get("input") or "").strip()
    history = payload.get("history") or []
    state = workflow.run(input_text, history=history)
    files = workflow.export_results(state)
    return {"ok": True, "files": files}


# 注册
_register_async_executor()
_register_async_export()