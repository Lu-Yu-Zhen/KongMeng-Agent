# -*- coding: utf-8 -*-
"""
RAG 检索层 API 路由
=====================
只读接口：
  GET  /rag/status        索引状态 / 块数 / 模型加载
  GET  /rag/retrieve      混合检索（subject / topic / top_n / session）
  GET  /rag/subjects      学科列表
  POST /rag/build         异步触发索引构建（复用 task_queue + SSE）
说明：本模块由 backend/server.py 显式 include（因 rag 依赖 app 之外的 workflow，
延迟 import 避免循环依赖）。若未挂载，则不注册任何路由。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from . import config, hybrid, pipeline

log = logging.getLogger("teacher-backend.rag")

api = APIRouter(prefix="/rag")

# 延迟注入的 task_queue（由 server.py 调用 set_task_queue 设置，避免循环依赖）
_TASK_QUEUE = None


class BuildRequest(BaseModel):
    subjects: Optional[list] = Field(default=None, description="学科列表，缺省全科")
    force: bool = Field(default=False, description="强制全量重建")


@api.get("/status")
def status() -> Dict[str, Any]:
    return {"ok": True, **pipeline.status()}


@api.get("/subjects")
def subjects() -> Dict[str, Any]:
    return {"ok": True, "subjects": config.SUBJECTS}


@api.get("/retrieve")
def retrieve(
    subject: str = Query("", description="学科指定（可选，自动路由）"),
    topic: str = Query("", description="检索主题/问题"),
    top_n: int = Query(8, ge=1, le=50, description="返回块数"),
    history: str = Query("", description="多轮上下文 JSON（可选）"),
) -> Dict[str, Any]:
    if not topic.strip():
        raise HTTPException(status_code=400, detail="topic 不能为空")
    hist = None
    if history:
        try:
            import json
            hist = json.loads(history)
        except Exception:
            hist = None
    try:
        r = hybrid.search(topic.strip(), subject=subject, top_n=top_n, history=hist)
        return {
            "ok": True,
            "query": r.query,
            "routed_subject": r.routed_subject,
            "query_rewritten": r.query_rewritten,
            "rerank_used": r.rerank_used,
            "degraded": r.degraded,
            "context": r.context,
            "sources": r.sources,
            "hits": [h.model_dump() for h in r.hits],
        }
    except Exception as e:  # pragma: no cover
        log.warning("rag/retrieve 异常：%s", e, exc_info=True)
        return {"ok": False, "error": str(e), "hits": []}


@api.post("/build")
def build(req: BuildRequest) -> Dict[str, Any]:
    """提交异步索引构建任务，返回 task_id（配合 /api/tasks/{id}/events 看进度）。"""
    if _TASK_QUEUE is None:
        raise HTTPException(status_code=503, detail="异步任务队列未就绪")
    payload = {"subjects": req.subjects or config.SUBJECTS, "force": req.force}
    task_id = _TASK_QUEUE.submit("rag_build", 0, payload, timeout=3600)
    return {"ok": True, "taskId": task_id}


def set_task_queue(task_queue) -> None:
    """由 server.py 注入 task_queue。"""
    global _TASK_QUEUE
    _TASK_QUEUE = task_queue


def register_async_build(task_queue) -> None:
    """注册异步构建执行器（供 server.py 调用，避免循环依赖）。"""
    set_task_queue(task_queue)
    task_queue.register_executor("rag_build", _run_build_task)


def _run_build_task(task_id: str, payload: Dict[str, Any], task) -> Dict[str, Any]:
    subjects = payload.get("subjects") or None
    force = bool(payload.get("force"))

    def _progress(stage: str, pct: int, msg: str):
        task.emit({"type": "stage", "stage": f"rag_{stage}", "progress": pct, "message": msg})

    try:
        result = pipeline.build(subjects=subjects, force=force, progress=_progress)
        return {"ok": True, "result": result}
    except Exception as e:
        log.error("rag 构建失败：%s", e, exc_info=True)
        return {"ok": False, "error": str(e)}


def build_submit(task_queue, subjects: Optional[list] = None, force: bool = False) -> str:
    """提交异步构建任务，返回 task_id。"""
    payload = {"subjects": subjects or config.SUBJECTS, "force": force}
    return task_queue.submit("rag_build", 0, payload, timeout=3600)