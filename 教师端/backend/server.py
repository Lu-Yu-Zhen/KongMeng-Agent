# -*- coding: utf-8 -*-
"""
教师端 · 智能体后端服务（前后端分离）
==========================================
将 workflow.py（LangChain + LangGraph 工作流）封装为完整智能体后端：

  ‖ API 网关层   REST + SSE 进度推送、统一响应      ‖  app/api.py
  ‖ 任务编排层   异步任务队列、状态机、取消/超时      ‖  app/task_queue.py
  ‖ 会话记忆层   多会话、短期/长期记忆、学情          ‖  app/memory.py + db.py
  ‖ 模型管理层   多模型、API Key 加密存储、按需路由    ‖  app/config.py + security.py
  ‖ 产物落盘层   后端直接写「备课产物/」+ 历史记录     ‖  app/exporter.py
  ‖ 知识库层    教材知识图谱检索                     ‖  app/kb.py
  ‖ 持久化层     SQLite（会话/记忆/任务/产物/模型）    ‖  app/db.py

保留原 workflow.py 与前端 JS 工作流（teacher-agent-sandbox/js/）不动，
新旧工作流融合协作：前端 Agent 模式优先走后端，后端不可用时自动降级前端工作流。

启动：python backend/server.py  （默认 http://127.0.0.1:8767）
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time

# 将教师端根目录加入 sys.path，以便 import workflow.py
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BASE_DIR not in sys.path:
    sys.path.insert(0, _BASE_DIR)

logging.basicConfig(
    level=logging.INFO,
    format="[teacher-backend] %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend.log"), encoding="utf-8"),
    ],
)
log = logging.getLogger("teacher-backend")

try:
    import uvicorn
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse

    _FASTAPI_OK = True
except Exception as e:  # pragma: no cover
    _FASTAPI_OK = False
    log.error("FastAPI 未安装，请执行：pip install fastapi uvicorn pydantic（%s）", e)

from app import config, db, router, task_queue  # noqa: E402
from app.api import api  # noqa: E402


def create_app() -> FastAPI:
    if not _FASTAPI_OK:
        raise RuntimeError("FastAPI 未安装")

    # 初始化数据库
    db.init_db()

    # 清理上次进程遗留的非终态任务（重启会中断后台线程），避免脏任务卡死/SSE 无限心跳
    try:
        _stale = db.cleanup_stale_tasks()
        if _stale:
            log.info("已清理 %d 个重启前遗留的未完成任务", _stale)
    except Exception as e:
        log.warning("清理遗留任务失败（忽略）：%s", e)

    app = FastAPI(title="教师端智能体后端", version="2.0.0")
    # CORS 收敛：不再全开 "*"，仅允许本地来源（Electron file:// / 本机 http），
    # 防止任意外部网页跨域访问本机后端。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.CORS_ORIGINS,
        allow_origin_regex=config.CORS_ORIGIN_REGEX,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # 本地令牌守卫：Electron 启动时注入 AGENT_API_TOKEN 后启用，
    # 阻止其他网页（跨站）调用本机接口盗刷 Key / 读取数据。
    if config.AGENT_API_TOKEN:
        _TOKEN_WHITELIST = {"/", "/api/health", "/docs", "/openapi.json", "/redoc"}

        @app.middleware("http")
        async def _token_guard(request, call_next):
            path = request.url.path
            # 放行 CORS 预检与健康检查等只读入口
            if request.method == "OPTIONS" or path in _TOKEN_WHITELIST:
                return await call_next(request)
            supplied = request.headers.get("X-Agent-Token", "")
            if supplied != config.AGENT_API_TOKEN:
                return JSONResponse(status_code=401, content={"ok": False, "error": "unauthorized"})
            return await call_next(request)

        log.info("已启用本地访问令牌校验（X-Agent-Token）")

    # 注册路由
    app.include_router(api)

    # 挂载 RAG 检索层（只读）+ 异步构建执行器
    try:
        from app.rag import api_router as rag_api
        from app.rag import config as rag_config

        rag_config.ensure_dirs()
        app.include_router(rag_api.api)
        rag_api.register_async_build(task_queue)
        log.info("RAG 检索层已挂载：/rag/status、/rag/retrieve、/rag/subjects、POST /rag-build")
    except Exception as e:  # pragma: no cover
        log.warning("RAG 检索层挂载失败（忽略，服务继续）：%s", e)

    # 启动时把默认模型应用到 workflow（若已配置）
    try:
        config.apply_model_to_workflow("")
    except Exception as e:
        log.warning("应用默认模型失败（忽略，使用 Mock）：%s", e)

    @app.on_event("startup")
    async def _startup():
        # 绑定事件循环供 task_queue 跨线程推送 SSE
        task_queue.set_loop(asyncio.get_running_loop())
        log.info("智能体后端已就绪：http://%s:%d", config.HOST, config.PORT)

    @app.get("/")
    def root() -> dict:
        return {
            "service": "teacher-agent-backend",
            "version": "2.0.0",
            "docs": "/docs",
            "health": "/api/health",
            "routes": sorted([r.path for r in app.routes if hasattr(r, "path")]),
        }

    return app


def main() -> None:
    if not _FASTAPI_OK:
        log.error("FastAPI 未安装：pip install fastapi uvicorn pydantic")
        sys.exit(1)
    app = create_app()
    log.info("教师端智能体后端启动：http://%s:%d （Ctrl+C 停止）", config.HOST, config.PORT)
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="info")


if __name__ == "__main__":
    main()