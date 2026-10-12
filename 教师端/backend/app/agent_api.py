# -*- coding: utf-8 -*-
"""四板块数据共享 + Qoder 备课 Agent · HTTP API。

数据总线（学生提问 / 题目批改 / 学情分析 → 备课主板块汇总调用）：
    POST /api/databus/students          登记/更新学生（伪 ID）
    POST /api/databus/qa                提问记录上报（学生提问板块 / 批改摘要）
    POST /api/databus/grades            逐题批改上报（题目批改板块，教师确认后计入口径）
    POST /api/databus/correction        教师修正批改记录（教师权威覆盖）
    POST /api/databus/scores            考试成绩导入（学情分析板块）
    POST /api/databus/consume           手动触发事件消费（重放/兜底）
    GET  /api/databus/profile/{pid}     个体画像查询
    GET  /api/databus/class/{cid}/stats 班级学情统计
    GET  /api/databus/usage             四板块数据使用情况
    GET  /api/databus/audit             审计链查询与校验

备课 Agent（Qoder Agent SDK）：
    GET  /api/agent/status              引擎状态（sdk/pat/开关/当前引擎）
    POST /api/agent/lesson_prep         生成教案+PPT（自动落盘「备课产物/」）
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import workflow  # noqa: E402  （复用 export_results 的 docx/pptx 导出与质量门）

from . import databus, db
from .agent import qoder_agent

log = logging.getLogger("teacher-backend.agent-api")

api = APIRouter(prefix="/api")


# ---------------------------------------------------------------------------
# 请求模型
# ---------------------------------------------------------------------------
class StudentsIn(BaseModel):
    items: List[Dict[str, Any]] = Field(default_factory=list)


class QaIn(BaseModel):
    pseudoId: str
    subject: str
    kpIds: List[str] = Field(default_factory=list)
    questionDigest: str = ""
    depth: str = ""
    source: str = "student-qa"
    sessionRef: str = ""


class GradeIn(BaseModel):
    pseudoId: str
    subject: str
    teacherConfirmed: bool = True
    items: List[Dict[str, Any]] = Field(default_factory=list)


class CorrectionIn(BaseModel):
    gradeId: int
    score: Optional[float] = None
    errorType: Optional[str] = None
    comment: Optional[str] = None


class ScoresIn(BaseModel):
    classId: str
    subject: str
    examName: str = ""
    examDate: str = ""
    items: List[Dict[str, Any]] = Field(default_factory=list)


class LessonPrepIn(BaseModel):
    subject: str
    topic: str
    grade: str = ""
    classId: str = ""
    teacherInput: str = ""
    sessionId: int = 0
    export: bool = True


def _err(status: int, msg: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"ok": False, "error": msg})


# ---------------------------------------------------------------------------
# 数据总线
# ---------------------------------------------------------------------------
@api.post("/databus/students")
def api_students(body: StudentsIn) -> Dict[str, Any]:
    try:
        n = databus.ensure_students(body.items)
    except Exception as e:  # noqa: BLE001
        raise _err(400, str(e))
    return {"ok": True, "inserted": n, "total": len(databus.list_students())}


@api.post("/databus/qa")
def api_qa(body: QaIn) -> Dict[str, Any]:
    try:
        r = databus.save_qa(body.pseudoId, body.subject, body.kpIds,
                            body.questionDigest, body.depth, body.source, body.sessionRef)
    except ValueError as e:
        raise _err(400, str(e))
    return {"ok": True, **r}


@api.post("/databus/grades")
def api_grades(body: GradeIn) -> Dict[str, Any]:
    try:
        r = databus.save_grades(body.pseudoId, body.subject, body.items, body.teacherConfirmed)
    except ValueError as e:
        raise _err(400, str(e))
    return {"ok": True, **r}


@api.post("/databus/correction")
def api_correction(body: CorrectionIn) -> Dict[str, Any]:
    patch = {k: v for k, v in {
        "score": body.score, "errorType": body.errorType, "comment": body.comment,
    }.items() if v is not None}
    try:
        r = databus.correct_grade(body.gradeId, patch)
    except ValueError as e:
        raise _err(400, str(e))
    return {"ok": True, **r}


@api.post("/databus/scores")
def api_scores(body: ScoresIn) -> Dict[str, Any]:
    try:
        r = databus.import_scores(body.classId, body.subject, body.examName, body.examDate, body.items)
    except ValueError as e:
        raise _err(400, str(e))
    return {"ok": True, **r}


@api.post("/databus/consume")
def api_consume() -> Dict[str, Any]:
    return {"ok": True, **databus.consume_events()}


@api.get("/databus/profile/{pseudo_id}")
def api_profile(pseudo_id: str, subject: str = "", kp: str = "") -> Dict[str, Any]:
    try:
        return {"ok": True, **databus.query_profile(pseudo_id, subject=subject, kp_id=kp)}
    except ValueError as e:
        raise _err(400, str(e))


@api.get("/databus/class/{class_id}/stats")
def api_class_stats(class_id: str, subject: str = "") -> Dict[str, Any]:
    return {"ok": True, **databus.class_stats(class_id, subject)}


@api.get("/databus/usage")
def api_usage(classId: str = "", subject: str = "") -> Dict[str, Any]:
    return {"ok": True, **databus.data_usage(class_id=classId, subject=subject)}


@api.get("/databus/audit")
def api_audit(limit: int = 50) -> Dict[str, Any]:
    return {"ok": True, "entries": databus.audit_list(limit), "verify": databus.audit_verify()}


# ---------------------------------------------------------------------------
# 备课 Agent
# ---------------------------------------------------------------------------
@api.get("/agent/status")
def api_agent_status() -> Dict[str, Any]:
    return {"ok": True, **qoder_agent.engine_status()}


@api.post("/agent/lesson_prep")
async def api_lesson_prep(body: LessonPrepIn) -> Dict[str, Any]:
    if not body.subject or not body.topic:
        raise _err(400, "subject / topic 不能为空")
    req = {
        "subject": body.subject, "topic": body.topic, "grade": body.grade,
        "classId": body.classId, "teacherInput": body.teacherInput,
    }
    out = await qoder_agent.run_lesson_prep(req)
    result: Dict[str, Any] = {"ok": True, **out}
    quality = out.get("quality", {})
    reg = out.get("artifacts") or []
    teacher_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    if reg:
        # 新链路：Agent 通过 gen 工具生成（质量已由 gen_lesson_plan/gen_ppt 硬校验）
        arts = []
        for a in reg:
            p = os.path.join(teacher_root, a.get("relPath", "").replace("/", os.sep))
            if os.path.exists(p):
                db.add_artifact(body.sessionId, "qoder-lesson-prep", os.path.basename(p),
                                a.get("relPath", ""), os.path.splitext(p)[1].lstrip("."),
                                os.path.getsize(p))
            arts.append({"kind": a.get("kind"), "filename": os.path.basename(a.get("path", "")),
                         "relPath": a.get("relPath", ""), "size": a.get("size", 0),
                         "score": a.get("score"), "ok": a.get("ok")})
        result["artifacts"] = arts
        quality["pptPlanAligned"] = bool(quality.get("pptQualityOk"))
    else:
        # 旧链路兜底：Agent 直接输出全文 → 本地解析并复用 workflow.export_results
        plan = out.get("plan", "")
        required_sections = ["课标依据", "学情分析", "教学目标", "重难点", "教学过程",
                             "例题", "分层作业", "板书", "数据使用说明"]
        missing = [s for s in required_sections if s not in plan]
        quality["missingSections"] = quality.get("missingSections") or missing
        quality["structureOk"] = bool(quality.get("structureOk")) and not missing
        slides = out.get("slides", [])
        quality["pptPlanAligned"] = (quality.get("slideTitleHitRate") or 0) >= 0.8
        result["quality"] = quality
        if body.export and quality.get("structureOk"):
            stamp = time.strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:6]
            base = os.path.normpath(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                                 "..", "备课产物", f"Qoder备课_{stamp}"))
            quality_map = {
                "教案": {"score": 100 if quality["structureOk"] else 60,
                         "passed": quality["structureOk"], "issues": missing},
                "PPT课件": {"score": 100 if quality.get("slideCount", 0) >= 12 else 60,
                            "passed": quality.get("slideCount", 0) >= 12,
                            "issues": ([] if quality.get("slideCount", 0) >= 12
                                       else [f"页数不足 12 页（当前 {quality.get('slideCount')}）"])},
            }
            state = {
                "final": {"tasks": ["lesson_plan", "ppt"], "quality": quality_map},
                "lesson_plan": {"content": plan, "ok": True},
                "ppt": {"content": json.dumps(slides, ensure_ascii=False), "parsed": slides, "ok": True},
            }
            try:
                files = workflow.export_results(state, output_dir=base)
                arts = []
                for f in files:
                    if os.path.exists(f):
                        rel = os.path.relpath(f, teacher_root).replace("\\", "/")
                        db.add_artifact(body.sessionId, "qoder-lesson-prep", os.path.basename(f), rel,
                                        os.path.splitext(f)[1].lstrip("."), os.path.getsize(f))
                        arts.append({"kind": "file", "filename": os.path.basename(f),
                                     "relPath": rel, "size": os.path.getsize(f)})
                result["artifacts"] = arts
            except Exception as e:  # noqa: BLE001 —— 落盘失败不影响内容返回
                log.warning("备课产物落盘失败：%s", e)
                result["artifacts"] = []
                result["exportError"] = str(e)

    # 写备课记忆（供下次 memory_read）
    try:
        db.save_memory(body.sessionId, "prep", "note",
                       f"{body.subject}《{body.topic}》：引擎={out.get('engine')}，"
                       f"教案分={quality.get('lessonPlanScore', 0)}，"
                       f"PPT {quality.get('slideCount', 0)} 页（版式 {len(quality.get('layoutStats') or {})} 种）")
    except Exception:  # noqa: BLE001
        pass
    return result
