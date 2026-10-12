# -*- coding: utf-8 -*-
"""
产物落盘服务
============
后端直接调用 workflow.export_results 把产物写为真实文件（docx/xlsx/pptx/md），
落盘到「教师端/备课产物/」目录，并登记到 SQLite 产物历史。
前端不再需要 base64 回传，只需拿到相对路径后刷新展示。
"""
from __future__ import annotations

import os
import time
import uuid
from typing import Any, Dict, List, Optional

import workflow  # noqa: E402

from . import db

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 教师端根目录（backend 的上一级）
_TEACHER_ROOT = os.path.dirname(_BASE_DIR)
ARTIFACT_ROOT = os.path.join(_TEACHER_ROOT, "备课产物")


def export_workflow(state: Dict[str, Any], session_id: int = 0, task_id: str = "") -> List[Dict[str, Any]]:
    """把工作流状态导出为真实文件，登记历史，返回文件元数据列表。
    目录命名带随机后缀防同秒并发撞名；workflow.export_results 内部已做
    延迟建目录与空目录清理，此处不再预先建目录。"""
    stamp = time.strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:6]
    base = os.path.join(ARTIFACT_ROOT, "备课资源包_" + stamp)
    files = workflow.export_results(state, output_dir=base)
    out = []
    for f in files:
        if not os.path.exists(f):
            continue
        filename = os.path.basename(f)
        rel = os.path.relpath(f, _TEACHER_ROOT).replace("\\", "/")
        ext = os.path.splitext(filename)[1].lstrip(".") or "md"
        size = os.path.getsize(f)
        db.add_artifact(session_id, task_id, filename, rel, ext, size)
        out.append({"filename": filename, "relPath": rel, "ext": ext, "size": size})
    return out


def artifact_history(session_id: int = 0, limit: int = 100) -> List[Dict[str, Any]]:
    return db.list_artifacts(session_id=session_id, limit=limit)