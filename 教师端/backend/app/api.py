# -*- coding: utf-8 -*-
"""
HTTP / SSE API 层
=================
接口清单：
  兼容旧版（前端 backend-client.js 依赖）：
    GET  /api/health
    POST /api/workflow/run
    POST /api/workflow/continue
    POST /api/workflow/export
  新增能力：
    —— 任务（异步 + SSE 进度）
    POST   /api/tasks/workflow         提交异步工作流任务
    GET    /api/tasks/{id}             查询任务状态
    GET    /api/tasks/{id}/events      SSE 进度流
    POST   /api/tasks/{id}/cancel      取消任务
    GET    /api/tasks                  任务列表
    —— 会话
    POST   /api/sessions               创建会话
    GET    /api/sessions               会话列表
    GET    /api/sessions/{id}          会话详情（含消息、记忆）
    DELETE /api/sessions/{id}          删除会话
    —— 模型配置（加密存储，不再依赖前端明文传 Key）
    GET    /api/models
    POST   /api/models
    DELETE /api/models/{name}
    POST   /api/models/{name}/activate 设为默认
    —— 产物
    GET    /api/artifacts              产物历史
    GET    /api/artifacts/{id}/download 下载单文件
    —— 记忆
    POST   /api/memories               写入长期记忆
    GET    /api/memories               列出记忆
    —— 知识库
    GET    /api/kb/retrieve            检索
    GET    /api/kb/subjects            学科列表
    —— 统计
    GET    /api/stats
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import config, db, exporter, kb, memory, router, task_queue

log = logging.getLogger("teacher-backend.api")

# 服务启动时间（stats.startedAt 用；此前误用 DB 文件 mtime，每次写入都会变）
_SERVICE_STARTED_AT = time.time()

api = APIRouter(prefix="/api")

# ---------------------------------------------------------------------------
# 请求模型
# ---------------------------------------------------------------------------
class ModelCfg(BaseModel):
    provider: str = "mock"
    model: str = "qwen-plus"
    apiKey: str = ""
    baseUrl: str = ""
    endpoint: str = ""


class RunRequest(BaseModel):
    input: str = Field(..., description="教师原始需求")
    history: List[Dict[str, Any]] = Field(default_factory=list)
    model: Optional[ModelCfg] = Field(default=None)


class ContinueRequest(RunRequest):
    answers: Dict[str, Any] = Field(default_factory=dict)
    state: Optional[Dict[str, Any]] = Field(default=None)


class TaskWorkflowRequest(BaseModel):
    input: str = Field(..., description="教师原始需求")
    history: List[Dict[str, Any]] = Field(default_factory=list)
    sessionId: Optional[int] = Field(default=None)
    topic: str = Field(default="")
    memoryKeyword: str = Field(default="")
    model: Optional[ModelCfg] = Field(default=None)


class SessionCreateRequest(BaseModel):
    topic: str = Field(default="")
    modelName: str = Field(default="")


class ModelSaveRequest(BaseModel):
    name: str = Field(..., description="唯一名称")
    provider: str = Field(default="openai")
    model: str = Field(default="")
    baseUrl: str = Field(default="")
    endpoint: str = Field(default="")
    apiKey: str = Field(default="")
    isDefault: bool = Field(default=False)


class MemoryWriteRequest(BaseModel):
    sessionId: int = Field(default=0)
    scope: str = Field(default="student")
    kind: str = Field(default="fact")
    content: str = Field(..., description="记忆内容")
    items: List[Dict[str, Any]] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# 健康检查
# ---------------------------------------------------------------------------
@api.get("/health")
def health() -> Dict[str, Any]:
    wf = _wf()
    return {
        "ok": True,
        "service": "teacher-agent-backend",
        "version": "2.0.0",
        "langgraph": wf.LANGGRAPH_AVAILABLE if wf else False,
        "langchain": wf.LANGCHAIN_AVAILABLE if wf else False,
        "provider": wf.SETTINGS.provider if wf else "mock",
        "producers": list(wf.PRODUCERS.keys()) if wf else [],
        "models": len(db.list_models()),
        "sessions": len(db.list_sessions(limit=1000)),
        "db": db.DB_PATH,
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def _wf():
    try:
        import workflow
        return workflow
    except Exception:
        return None


# ---------------------------------------------------------------------------
# 兼容旧版：/api/workflow/*
# ---------------------------------------------------------------------------
@api.post("/workflow/run")
def workflow_run(req: RunRequest) -> Dict[str, Any]:
    try:
        config.apply_inline_model(req.model)
        if not req.input.strip():
            raise HTTPException(status_code=400, detail="input 不能为空")
        state = router.run_sync(req.input.strip(), req.history or [])
        return {
            "ok": True,
            "pendingQuestions": state.get("pending_questions", []),
            "infoComplete": state.get("info_complete", False),
            "parsed": state.get("parsed"),
            "tasks": state.get("tasks", []),
            "products": router.collect_products(state),
            "final": state.get("final"),
            "errors": state.get("errors", []),
            "state": state,
        }
    except HTTPException:
        raise
    except Exception as e:
        log.warning("workflow_run 执行异常：%s", e, exc_info=True)
        return {"ok": False, "error": str(e)}


@api.post("/workflow/continue")
def workflow_continue(req: ContinueRequest) -> Dict[str, Any]:
    try:
        config.apply_inline_model(req.model)
        state = router.run_with_answers(req.input.strip(), req.history or [], req.answers or {}, req.state or {})
        return {
            "ok": True,
            "pendingQuestions": state.get("pending_questions", []),
            "infoComplete": state.get("info_complete", False),
            "parsed": state.get("parsed"),
            "tasks": state.get("tasks", []),
            "products": router.collect_products(state),
            "final": state.get("final"),
            "errors": state.get("errors", []),
            "state": state,
        }
    except Exception as e:
        log.warning("workflow_continue 执行异常：%s", e, exc_info=True)
        return {"ok": False, "error": str(e)}


@api.post("/workflow/export")
def workflow_export(req: RunRequest) -> Dict[str, Any]:
    try:
        config.apply_inline_model(req.model)
        if not req.input.strip():
            raise HTTPException(status_code=400, detail="input 不能为空")
        state = router.run_sync(req.input.strip(), req.history or [])
        if not state.get("final") and not state.get("tasks"):
            return {"ok": True, "files": [], "message": "无产物可导出"}
        files = exporter.export_workflow(state)
        payload = []
        for f in files:
            full = os.path.join(exporter._TEACHER_ROOT, f["relPath"])
            try:
                with open(full, "rb") as fh:
                    raw = fh.read()
                payload.append(
                    {
                        "filename": f["filename"],
                        "size": len(raw),
                        "relPath": f["relPath"],
                        "data": base64.b64encode(raw).decode("ascii"),
                    }
                )
            except Exception as fe:
                log.warning("读取导出文件失败 %s：%s", full, fe)
        return {"ok": True, "files": payload}
    except HTTPException:
        raise
    except Exception as e:
        log.warning("workflow_export 执行异常：%s", e, exc_info=True)
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------------------
# 任务（异步 + SSE）
# ---------------------------------------------------------------------------
@api.post("/tasks/workflow")
def task_workflow(req: TaskWorkflowRequest) -> Dict[str, Any]:
    config.apply_inline_model(req.model)
    if not req.input.strip():
        raise HTTPException(status_code=400, detail="input 不能为空")
    payload = {
        "input": req.input.strip(),
        "history": req.history or [],
        "sessionId": req.sessionId or 0,
        "topic": req.topic or "",
        "memoryKeyword": req.memoryKeyword or "",
    }
    task_id = task_queue.submit("workflow", req.sessionId or 0, payload, timeout=1800)
    return {"ok": True, "taskId": task_id}


@api.get("/tasks/{task_id}")
def task_status(task_id: str) -> Dict[str, Any]:
    t = db.get_task(task_id)
    if not t:
        raise HTTPException(status_code=404, detail="任务不存在")
    return {"ok": True, "task": t}


@api.get("/tasks")
def task_list(session_id: int = Query(0, description="按会话过滤")) -> Dict[str, Any]:
    return {"ok": True, "tasks": db.list_tasks(session_id=session_id, limit=100)}


@api.post("/tasks/{task_id}/cancel")
def task_cancel(task_id: str) -> Dict[str, Any]:
    ok = task_queue.cancel(task_id)
    return {"ok": ok, "cancelled": ok}


@api.get("/tasks/{task_id}/events")
async def task_events(task_id: str):
    """SSE 进度流。"""
    if not await asyncio.to_thread(db.get_task, task_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    q = task_queue.subscribe(task_id)

    async def gen():
        try:
            # 先推送当前状态
            t = await asyncio.to_thread(db.get_task, task_id)
            if t:
                yield "data: " + json.dumps(
                    {"type": "status", "status": t.get("status"), "progress": t.get("progress"), "message": t.get("message")},
                    ensure_ascii=False,
                ) + "\n\n"
            while True:
                try:
                    data = await asyncio.wait_for(q.get(), timeout=15)
                    yield "data: " + data + "\n\n"
                    try:
                        evt = json.loads(data)
                        if evt.get("type") in ("done", "error", "cancel", "awaiting_input"):
                            break
                    except Exception:
                        pass
                except asyncio.TimeoutError:
                    # 心跳，保持连接
                    yield ": ping\n\n"
                    # 若任务已终态则退出（查库放线程，避免阻塞事件循环）
                    t = await asyncio.to_thread(db.get_task, task_id)
                    if t and t.get("status") in ("success", "failed", "cancelled", "awaiting_input"):
                        yield "data: " + json.dumps({"type": "status", "status": t.get("status")}, ensure_ascii=False) + "\n\n"
                        break
        finally:
            task_queue.unsubscribe(task_id, q)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------
# 会话
# ---------------------------------------------------------------------------
@api.post("/sessions")
def session_create(req: SessionCreateRequest) -> Dict[str, Any]:
    sid = db.create_session(topic=req.topic or "", model_name=req.modelName or "")
    return {"ok": True, "sessionId": sid, "session": db.get_session(sid)}


@api.get("/sessions")
def session_list() -> Dict[str, Any]:
    return {"ok": True, "sessions": db.list_sessions(limit=100)}


@api.get("/sessions/{session_id}")
def session_detail(session_id: int) -> Dict[str, Any]:
    s = db.get_session(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="会话不存在")
    return {
        "ok": True,
        "session": s,
        "messages": db.get_messages(session_id, limit=200),
        "memories": db.get_memories(session_id=session_id),
        "artifacts": db.list_artifacts(session_id=session_id, limit=100),
    }


@api.delete("/sessions/{session_id}")
def session_delete(session_id: int) -> Dict[str, Any]:
    if not db.get_session(session_id):
        raise HTTPException(status_code=404, detail="会话不存在")
    db.delete_session(session_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# 模型配置（加密存储）
# ---------------------------------------------------------------------------
@api.get("/models")
def model_list() -> Dict[str, Any]:
    return {"ok": True, "models": [config.public_model_cfg(r) for r in db.list_models()]}


@api.post("/models")
def model_save(req: ModelSaveRequest) -> Dict[str, Any]:
    try:
        cfg = config.upsert_model(
            {
                "name": req.name,
                "provider": req.provider,
                "model": req.model,
                "baseUrl": req.baseUrl,
                "endpoint": req.endpoint,
                "apiKey": req.apiKey,
                "isDefault": req.isDefault,
            }
        )
        if req.isDefault:
            config.apply_model_to_workflow(req.name)
        return {"ok": True, "model": cfg}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        return {"ok": False, "error": str(e)}


@api.post("/models/{name}/activate")
def model_activate(name: str) -> Dict[str, Any]:
    row = db.get_model(name)
    if not row:
        raise HTTPException(status_code=404, detail="模型不存在")
    db.set_default_model(name)
    ok = config.apply_model_to_workflow(name)
    return {"ok": True, "activated": name, "usingRealModel": ok}


@api.delete("/models/{name}")
def model_delete(name: str) -> Dict[str, Any]:
    db.delete_model(name)
    return {"ok": True}


# ---------------------------------------------------------------------------
# 产物
# ---------------------------------------------------------------------------
@api.get("/artifacts")
def artifact_list(session_id: int = Query(0)) -> Dict[str, Any]:
    return {"ok": True, "artifacts": exporter.artifact_history(session_id=session_id, limit=200)}


@api.get("/artifacts/{artifact_id}/download")
def artifact_download(artifact_id: int):
    rows = db.list_artifacts(limit=100000)
    row = next((r for r in rows if r["id"] == artifact_id), None)
    if not row:
        raise HTTPException(status_code=404, detail="产物不存在")
    full = os.path.join(exporter._TEACHER_ROOT, row["rel_path"])
    if not os.path.exists(full):
        raise HTTPException(status_code=404, detail="文件不存在")
    with open(full, "rb") as fh:
        data = fh.read()
    return JSONResponse(
        {"ok": True, "filename": row["filename"], "size": len(data), "data": base64.b64encode(data).decode("ascii")}
    )


# ---------------------------------------------------------------------------
# 记忆
# ---------------------------------------------------------------------------
@api.post("/memories")
def memory_write(req: MemoryWriteRequest) -> Dict[str, Any]:
    if req.items:
        memory.save_student_facts(req.sessionId, req.items)
    elif req.content:
        db.save_memory(req.sessionId, scope=req.scope or "student", kind=req.kind or "fact", content=req.content)
    return {"ok": True}


@api.get("/memories")
def memory_list(session_id: int = Query(0), scope: str = Query(""), keyword: str = Query("")) -> Dict[str, Any]:
    if keyword:
        rows = db.search_memories(keyword, limit=50)
    else:
        rows = db.get_memories(session_id=session_id, scope=scope)
    return {"ok": True, "memories": rows}


# ---------------------------------------------------------------------------
# 知识库
# ---------------------------------------------------------------------------
@api.get("/kb/retrieve")
def kb_retrieve(subject: str = Query(""), topic: str = Query("")) -> Dict[str, Any]:
    return {"ok": True, "data": kb.retrieve(subject, topic)}


@api.get("/kb/subjects")
def kb_subjects() -> Dict[str, Any]:
    return {"ok": True, "subjects": kb.subjects_available()}


# ---------------------------------------------------------------------------
# 统计
# ---------------------------------------------------------------------------
@api.get("/stats")
def stats() -> Dict[str, Any]:
    sessions = db.list_sessions(limit=100000)
    tasks = db.list_tasks(limit=100000)
    artifacts = db.list_artifacts(limit=100000)
    by_status: Dict[str, int] = {}
    for t in tasks:
        s = t.get("status") or "unknown"
        by_status[s] = by_status.get(s, 0) + 1
    return {
        "ok": True,
        "stats": {
            "sessions": len(sessions),
            # 仅对前若干个会话取样统计，避免 N+1 全量查询拖慢接口
            "messages": sum(len(db.get_messages(s["id"], limit=1000)) for s in sessions[:20]),
            "tasks": len(tasks),
            "taskStatus": by_status,
            "artifacts": len(artifacts),
            "models": len(db.list_models()),
            "startedAt": _SERVICE_STARTED_AT,
        },
    }