# -*- coding: utf-8 -*-
"""
分块与元数据 Schema
=====================
定义知识库的核心数据结构：知识树节点、文档、分块、检索命中。
与《普通高中课程标准（2017年版2020年修订）》对齐，标注学科/年级/册别/章节/知识点/难度/题型/来源。
"""
from __future__ import annotations

import hashlib
import time
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

# 难度等级（1-5）与课标层次
LEVEL_MAP = {"了解": "recognize", "理解": "understand", "掌握": "master", "应用": "apply"}


def sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


class KnowledgeNode(BaseModel):
    """知识树节点（五级：学科→模块→章→节→知识点）。"""

    kp_id: str = Field(..., description="全局唯一知识点编码，如 M1-C1-KP1")
    name: str = Field(..., description="节点名称")
    level: int = Field(..., ge=1, le=5, description="层级 1=学科 2=模块 3=章 4=节 5=知识点")
    parent_id: str = Field("", description="父节点 id，根节点为空")
    subject: str = Field("", description="学科")
    module: str = Field("", description="模块/册次")
    chapter: str = Field("", description="章")
    section: str = Field("", description="节")
    grade: str = Field("", description="年级（适配 3+1+2 / 3+3 学段）")
    difficulty: int = Field(0, ge=0, le=5, description="难度 1-5，0 未知")
    importance: int = Field(0, ge=0, le=5, description="重要度 1-5，0 未知")
    level_requirement: str = Field("", description="课标层次：了解/理解/掌握/应用")
    description: str = Field("", description="节点描述/内容要点")
    exam_type: str = Field("", description="关联题型")
    source: str = Field("", description="来源（教材册次/课标章节）")
    version: str = Field("", description="课标/考纲版本")
    exam_year: str = Field("", description="关联年份（真题）")


class DocumentRecord(BaseModel):
    """清洗后的文档记录。"""

    doc_id: str = Field("", description="文档唯一 id")
    subject: str = ""
    file_name: str = ""
    source: str = ""            # 来源标识（教材/课标/真题/教辅）
    source_url: str = ""
    version: str = ""
    status: str = "clean"       # raw / clean / annotated
    cleaned_at: str = ""
    meta: Dict[str, Any] = Field(default_factory=dict)


class Chunk(BaseModel):
    """分块（检索原子单元），携带完整结构化元数据。"""

    chunk_id: str = Field("", description="分块唯一 id")
    kp_id: str = Field("", description="归属知识点")
    subject: str = ""
    grade: str = ""
    book: str = ""
    module: str = ""
    chapter: str = ""
    section: str = ""
    knowledge_point: str = ""
    chunk_type: str = Field("definition", description="definition/formula/example/method/exam_requirement")
    difficulty: int = Field(0, ge=0, le=5)
    importance: int = Field(0, ge=0, le=5)
    exam_type: str = ""
    level: str = Field("", description="课标层次：了解/理解/掌握/应用")
    source: str = ""
    page: str = ""
    version: str = ""
    hash: str = ""
    created_at: str = ""
    text: str = Field("", description="分块正文")

    def compute_hash(self) -> str:
        self.hash = sha1(self.text)
        return self.hash


class RetrievalHit(BaseModel):
    """检索命中。"""

    chunk_id: str = ""
    kp_id: str = ""
    subject: str = ""
    knowledge_point: str = ""
    module: str = ""
    chapter: str = ""
    section: str = ""
    chunk_type: str = ""
    difficulty: int = 0
    level: str = ""
    source: str = ""
    text: str = ""
    score: float = 0.0
    rerank_score: float = 0.0


class RetrievalResult(BaseModel):
    """检索结果。"""

    query: str = ""
    subject: str = ""
    hits: List[RetrievalHit] = Field(default_factory=list)
    context: str = Field("", description="注入 LLM 的上下文（含知识树父链）")
    sources: List[str] = Field(default_factory=list, description="引用来源清单")
    routed_subject: str = ""
    query_rewritten: str = ""
    rerank_used: bool = False
    degraded: bool = False


def build_chunk_id(subject: str, kp_id: str, idx: int) -> str:
    return f"{subject}-{kp_id}-{idx}"


def now_str() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")