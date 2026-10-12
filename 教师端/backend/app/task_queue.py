# -*- coding: utf-8 -*-
"""
异步任务队列 + SSE 进度推送
==========================
工作流执行耗时较长（联网搜索 + 多产物生成），同步阻塞 + 前端超时十分脆弱。
本模块把任务放入后台线程执行，通过 asyncio 队列向 SSE 订阅者推送进度事件，
支持取消与超时，任务状态持久化到 SQLite。

进度事件约定（SSE data 为 JSON）：
  {"type":"progress","progress":0,"message":"..."}
  {"type":"stage","stage":"research","message":"..."}
  {"type":"product","product":"教案","status":"ok"}
  {"type":"done","result":{...}}
  {"type":"error","error":"..."}
  {"type":"cancel"}
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from . import db

# 任务注册表：task_id -> 执行器
_EXECUTORS: Dict[str, Callable[[str, Dict[str, Any], Any], Dict[str, Any]]] = {}
# 订阅者：task_id -> set[asyncio.Queue]
_SUBSCRIBERS: Dict[str, set] = {}
# 取消标记
_CANCEL_FLAGS: Dict[str, bool] = {}
_lock = threading.Lock()


class Task:
    """任务上下文：封装进度推送、取消检查、状态持久化。"""

    def __init__(self, task_id: str, session_id: int):
        self.id = task_id
        self.session_id = session_id
        self._cancelled = False

    def check_cancelled(self) -> bool:
        with _lock:
            return self._cancelled or _CANCEL_FLAGS.get(self.id, False)

    def cancel(self) -> None:
        with _lock:
            self._cancelled = True
            _CANCEL_FLAGS[self.id] = True

    def emit(self, event: Dict[str, Any]) -> None:
        """推送事件给所有订阅者，并持久化进度/状态。"""
        loop = _find_loop()
        if loop is not None:
            try:
                asyncio.run_coroutine_threadsafe(_broadcast(self.id, event), loop)
            except Exception:
                pass
        # 持久化关键字段
        if "progress" in event:
            db.update_task_status(self.id, "running", progress=event["progress"], message=event.get("message", ""))
        if event.get("type") == "stage":
            db.update_task_status(self.id, "running", message=event.get("message", ""))
        if event.get("type") == "product":
            db.update_task_status(self.id, "running", message=event.get("message", ""))


_loop_ref = None


def _find_loop():
    if _loop_ref is not None:
        return _loop_ref
    try:
        return asyncio.get_event_loop()
    except Exception:
        return None


def set_loop(loop) -> None:
    global _loop_ref
    _loop_ref = loop


async def _broadcast(task_id: str, event: Dict[str, Any]) -> None:
    subs = _SUBSCRIBERS.get(task_id)
    if not subs:
        return
    data = json.dumps(event, ensure_ascii=False)
    for q in list(subs):
        try:
            q.put_nowait(data)
        except Exception:
            subs.discard(q)


# 结果入库体积上限（字节）：超过则剔除最占空间的 state 原文，仅留摘要
_RESULT_MAX_BYTES = 1_000_000


def _safe_result(res: Any) -> Any:
    """保证结果可 JSON 序列化且体积可控，避免落库失败/撑爆 tasks 表。"""
    try:
        # 先整体尝试序列化；失败则逐键降级
        data = json.dumps(res, ensure_ascii=False)
        if len(data.encode("utf-8")) <= _RESULT_MAX_BYTES:
            return res
    except Exception:
        res = _downgrade(res)

    # 体积超限：优先移除最占空间的 state（产物原文），保留其余字段
    try:
        if isinstance(res, dict) and "state" in res:
            slim = dict(res)
            state = slim.get("state") or {}
            slim["state"] = {
                "tasks": state.get("tasks"),
                "globals": state.get("globals_"),
                "_truncated": True,
            }
            data = json.dumps(slim, ensure_ascii=False)
            if len(data.encode("utf-8")) <= _RESULT_MAX_BYTES:
                return slim
        # 仍超限：只保留关键元信息
        if isinstance(res, dict):
            return {
                "ok": res.get("ok"),
                "answer": str(res.get("answer") or "")[:2000],
                "products": res.get("products"),
                "artifacts": res.get("artifacts"),
                "sessionId": res.get("sessionId"),
                "_truncated": True,
            }
    except Exception:
        pass
    return _downgrade(res)


def _downgrade(res: Any) -> Any:
    """逐键剔除不可序列化内容。"""
    if isinstance(res, dict):
        out = {}
        for k, v in res.items():
            try:
                json.dumps(v, ensure_ascii=False)
                out[k] = v
            except Exception:
                out[k] = str(v)[:500]
        return out
    if isinstance(res, list):
        out = []
        for v in res:
            try:
                json.dumps(v, ensure_ascii=False)
                out.append(v)
            except Exception:
                out.append(str(v)[:500])
        return out
    try:
        json.dumps(res, ensure_ascii=False)
        return res
    except Exception:
        return str(res)[:500]


def register_executor(kind: str, fn: Callable[[str, Dict[str, Any], Any], Dict[str, Any]]) -> None:
    _EXECUTORS[kind] = fn


def submit(kind: str, session_id: int, payload: Dict[str, Any], timeout: int = 1800) -> str:
    """提交一个异步任务，返回 task_id。"""
    task_id = uuid.uuid4().hex[:12]
    db.save_task(
        {
            "id": task_id,
            "session_id": session_id,
            "kind": kind,
            "status": "pending",
            "progress": 0,
            "message": "已提交",
            "input": json.dumps(payload, ensure_ascii=False)[:20000],
            "created_at": time.time(),
        }
    )
    t = Task(task_id, session_id)
    t.emit({"type": "progress", "progress": 0, "message": "任务已提交"})

    def _worker():
        with _lock:
            _CANCEL_FLAGS[task_id] = False
        db.update_task_status(task_id, "running", progress=1, message="任务开始执行")
        fn_ref = _EXECUTORS.get(kind)
        res: Dict[str, Any] = {}
        try:
            if fn_ref is None:
                raise ValueError("未知任务类型: " + kind)
            res = fn_ref(task_id, payload, t)
            if t.check_cancelled():
                db.update_task_status(task_id, "cancelled", error="用户取消")
                t.emit({"type": "cancel"})
                return
            # 等待教师补充信息（追问）：不是"完成"，记为 awaiting_input
            if isinstance(res, dict) and res.get("pending"):
                db.update_task_status(task_id, "awaiting_input", progress=50, message="等待补充信息")
                t.emit({"type": "awaiting_input", "result": res})
                return
            res = _safe_result(res)
            db.update_task_status(task_id, "success", progress=100, message="完成", result=res)
            t.emit({"type": "done", "result": res})
        except InterruptedError:
            # 执行器响应取消而主动抛出：记为 cancelled 而非 failed
            db.update_task_status(task_id, "cancelled", error="用户取消")
            t.emit({"type": "cancel"})
        except Exception as e:
            db.update_task_status(task_id, "failed", error=str(e))
            t.emit({"type": "error", "error": str(e)})
        finally:
            with _lock:
                _CANCEL_FLAGS.pop(task_id, None)
                # 注意：不在此处立即移除 _SUBSCRIBERS[task_id]。
                # emit(done/error) 是异步入队，若此刻立即 pop，真正广播时订阅者已不存在，
                # 终态事件就会丢失（前端只能靠 15s 心跳兜底）。订阅清理交给订阅方 gen() 的
                # finally unsubscribe 负责，连接断开/收到终态后自然释放。

    th = threading.Thread(target=_worker, name="agent-task-" + task_id, daemon=True)
    th.start()
    # 超时保护：超出 timeout 秒强制标记失败（不杀线程，避免破坏状态）
    def _timeout_watch():
        wait = timeout
        while wait > 0 and not _task_done(task_id):
            time.sleep(1)
            wait -= 1
        if wait <= 0 and not _task_done(task_id):
            db.update_task_status(task_id, "failed", error="任务执行超时（%d 秒）" % timeout)
            publish(task_id, {"type": "error", "error": "任务执行超时"})

    threading.Thread(target=_timeout_watch, name="task-timeout-" + task_id, daemon=True).start()
    return task_id


def _task_done(task_id: str) -> bool:
    t = db.get_task(task_id)
    return bool(t and t.get("status") in ("success", "failed", "cancelled", "awaiting_input"))


def cancel(task_id: str) -> bool:
    """请求取消任务（由执行器在检查点响应）。"""
    t = db.get_task(task_id)
    if not t:
        return False
    if t.get("status") not in ("pending", "running"):
        return False
    with _lock:
        _CANCEL_FLAGS[task_id] = True
    publish(task_id, {"type": "cancel_requested", "message": "正在取消…"})
    return True


def publish(task_id: str, event: Dict[str, Any]) -> None:
    """外部向任务推送事件（线程安全）。"""
    loop = _find_loop()
    if loop is not None:
        try:
            asyncio.run_coroutine_threadsafe(_broadcast(task_id, event), loop)
        except Exception:
            pass


def subscribe(task_id: str) -> asyncio.Queue:
    """为 SSE 订阅者创建事件队列。"""
    q = asyncio.Queue()
    with _lock:
        _SUBSCRIBERS.setdefault(task_id, set()).add(q)
    return q


def unsubscribe(task_id: str, q: asyncio.Queue) -> None:
    with _lock:
        subs = _SUBSCRIBERS.get(task_id)
        if subs:
            subs.discard(q)
            if not subs:
                _SUBSCRIBERS.pop(task_id, None)