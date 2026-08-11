# -*- coding: utf-8 -*-
"""
教师端智能体后端 · 应用包
====================
模块结构：
  config.py      配置与模型管理（API Key 加密存储）
  db.py          SQLite 持久化（会话/记忆/任务/产物/模型）
  security.py    API Key 加解密
  task_queue.py  异步任务队列 + SSE 进度 + 取消/超时
  memory.py      会话与记忆服务
  exporter.py    产物落盘服务
  kb.py          知识库检索服务
  router.py      工作流业务路由（封装 workflow.py 调用）
  api.py         全部 HTTP/SSE 端点
"""