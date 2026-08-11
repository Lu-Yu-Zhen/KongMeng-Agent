# -*- coding: utf-8 -*-
"""
配置与模型管理
==============
- 服务运行配置（host/port/provider 等）
- 模型配置：增删改查、默认模型、API Key 加密存储、注入 workflow.SETTINGS
安全：API Key 通过 security.encrypt 加密后存库，不落明文，也不依赖前端传输。
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

from . import db, security
import workflow  # noqa: E402  复用 workflow 的 SETTINGS 与 LLM 单例

HOST = os.getenv("AGENT_BACKEND_HOST", "127.0.0.1")
PORT = int(os.getenv("AGENT_BACKEND_PORT", "8767"))
DATA_ROOT = os.getenv("AGENT_DATA_ROOT", "")  # 教师端数据根目录（可选，由 Electron 注入）

# 本地访问令牌：由 Electron 主进程启动时随机生成并经环境变量注入。
# 设置后，除白名单外的接口都要求携带 X-Agent-Token 请求头，
# 防止教师浏览的任意网页跨站调用本机后端（盗刷 Key / 读取数据）。
AGENT_API_TOKEN = os.getenv("AGENT_API_TOKEN", "").strip()

# CORS 允许来源（逗号分隔）。默认仅允许本地来源（Electron file:// 的 Origin 为 "null"
# 以及本机 http 服务），不再使用 "*"。可用环境变量覆盖。
_cors_env = os.getenv("AGENT_CORS_ORIGINS", "").strip()
CORS_ORIGINS = (
    [o.strip() for o in _cors_env.split(",") if o.strip()]
    if _cors_env
    else ["null", "file://", "app://."]
)
# 允许本机任意端口的 http(s) 来源（开发调试 / 本地静态服务）
CORS_ORIGIN_REGEX = r"https?://(localhost|127\.0\.0\.1)(:\d+)?"


def _mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return key[:2] + "***"
    return key[:4] + "****" + key[-4:]


def public_model_cfg(row: Dict[str, Any]) -> Dict[str, Any]:
    """对外输出的模型配置（隐藏明文 Key，仅给掩码）。"""
    return {
        "name": row.get("name", ""),
        "provider": row.get("provider", "openai"),
        "model": row.get("model", ""),
        "base_url": row.get("base_url", ""),
        "endpoint": row.get("endpoint", ""),
        "api_key_masked": _mask_key(security.decrypt(row.get("api_key_enc", ""))),
        "has_api_key": bool(row.get("api_key_enc")),
        "is_default": bool(row.get("is_default")),
        "updated_at": row.get("updated_at"),
    }


def upsert_model(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """新增或更新模型配置。name 为唯一键；apiKey 传入明文，内部加密存储。"""
    name = str(cfg.get("name") or "").strip()
    if not name:
        raise ValueError("模型名称不能为空")
    api_key = str(cfg.get("apiKey") or "").strip()
    # 若未传新 Key 且库中已有，则保留原 Key
    enc = ""
    if api_key:
        enc = security.encrypt(api_key)
    else:
        existing = db.get_model(name)
        if existing:
            enc = existing.get("api_key_enc", "")
    is_default = bool(cfg.get("is_default", cfg.get("isDefault", False)))
    db.save_model(
        {
            "name": name,
            "provider": str(cfg.get("provider") or "openai"),
            "model": str(cfg.get("model") or ""),
            "base_url": str(cfg.get("base_url") or ""),
            "endpoint": str(cfg.get("endpoint") or ""),
            "api_key_enc": enc,
            # 先以非默认写入，随后原子切换，避免"先清后设"产生 0/2 个默认的中间态
            "is_default": False,
        }
    )
    if is_default:
        db.set_default_model(name)
    return public_model_cfg(db.get_model(name) or {})


def _normalize_base_url(raw: str) -> str:
    bu = str(raw or "").strip()
    if bu.endswith("/chat/completions"):
        bu = bu[: -len("/chat/completions")]
    return bu.rstrip("/")


def _build_candidates(default_row: Dict[str, Any]) -> list:
    """备用模型链：把已配置的其他模型（含 Key）作为回退候选，主模型在前。"""
    chain = []
    seen = set()
    ordered = [default_row] if default_row else []
    for r in db.list_models():
        if not default_row or r.get("name") != default_row.get("name"):
            ordered.append(r)
    for r in ordered:
        model = str(r.get("model") or r.get("name") or "").strip()
        key = security.decrypt(str(r.get("api_key_enc") or ""))
        if not model or not key:
            continue
        bu = _normalize_base_url(r.get("base_url") or r.get("endpoint") or "")
        cand = (model, key, bu)
        if cand not in seen:
            seen.add(cand)
            chain.append(cand)
    return chain


def apply_model_to_workflow(name: str = "") -> bool:
    """把指定（或默认）模型配置应用到 workflow.SETTINGS，供 LLM 调用。
    返回是否成功找到可用的非 mock 模型。全程持锁，防止并发改写全局配置。"""
    row = db.get_model(name) if name else db.get_default_model()
    with workflow._MODEL_LOCK:
        if not row:
            workflow.SETTINGS.provider = "mock"
            workflow.SETTINGS.llm_candidates = []
            workflow._LLM_INST = None
            return False
        api_key = security.decrypt(row.get("api_key_enc", ""))
        if not api_key:
            workflow.SETTINGS.provider = "mock"
            workflow.SETTINGS.llm_candidates = []
            workflow._LLM_INST = None
            return False
        base_url = _normalize_base_url(row.get("base_url") or row.get("endpoint") or "")
        workflow.SETTINGS.provider = "openai"
        workflow.SETTINGS.model = str(row.get("model") or row.get("name") or "qwen-plus")
        workflow.SETTINGS.api_key = api_key
        workflow.SETTINGS.base_url = base_url
        workflow.SETTINGS.llm_candidates = _build_candidates(row)
        workflow._LLM_INST = None
        return True


def apply_inline_model(model: Optional[Any]) -> None:
    """兼容旧前端：请求体直接携带 model 配置时，临时应用到 workflow。
    优先使用后端已配置的默认模型；若前端明确传了 Key，则用前端的。"""
    if not model:
        apply_model_to_workflow("")
        return
    cfg = model.model_dump() if hasattr(model, "model_dump") else dict(model)
    provider = str(cfg.get("provider") or "mock").lower()
    api_key = str(cfg.get("apiKey") or "").strip()
    if provider in ("mock", "") or not api_key:
        # 前端未传 Key → 回退后端默认模型
        apply_model_to_workflow("")
        return
    base_url = str(cfg.get("baseUrl") or "").strip()
    endpoint = str(cfg.get("endpoint") or "").strip()
    if not base_url and endpoint:
        base_url = endpoint
        if base_url.endswith("/chat/completions"):
            base_url = base_url[: -len("/chat/completions")]
        base_url = base_url.rstrip("/")
    with workflow._MODEL_LOCK:
        workflow.SETTINGS.provider = "openai"
        workflow.SETTINGS.model = str(cfg.get("model") or "qwen-plus")
        workflow.SETTINGS.api_key = api_key
        workflow.SETTINGS.base_url = base_url
        # 前端传的是临时模型，仍可注入已配置的其他模型作为回退
        workflow.SETTINGS.llm_candidates = _build_candidates(db.get_default_model() or {})
        workflow._LLM_INST = None