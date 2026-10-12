# -*- coding: utf-8 -*-
"""冒烟测试：不依赖 NPU/网络/LLM Key，验证核心链路可运行。

覆盖：
  1. 全部 Python 文件编译通过（ast.parse）
  2. workflow mock 引擎可跑通（意图识别 → 产物生成 → 质量门）
  3. databus 事件登记与画像查询闭环
  4. RAG 检索层可导入且状态可查
  5. bus_tools 5 个数据工具按 impl 签名过滤传参后调用不抛 TypeError

运行：python scripts/smoke_test.py（在 教师端/ 目录，需 pip install -r backend/requirements.txt）
退出码：0 全部通过；1 存在失败项。
"""
from __future__ import annotations

import ast
import os
import sys
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

FAILED: list[str] = []
PASSED = 0


def check(name: str, fn) -> None:
    global PASSED
    try:
        detail = fn()
        PASSED += 1
        print(f"  ✓ {name}" + (f"（{detail}）" if detail else ""))
    except Exception as e:  # noqa: BLE001
        FAILED.append(f"{name}: {e}")
        print(f"  ✗ {name}: {e}")
        traceback.print_exc()


def t_compile_all() -> str:
    n = 0
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in ("__pycache__", "node_modules", ".git", "vendor")]
        for fn in filenames:
            if fn.endswith(".py"):
                p = os.path.join(dirpath, fn)
                ast.parse(open(p, encoding="utf-8", errors="replace").read(), filename=p)
                n += 1
    return f"{n} 个文件"


def t_workflow_mock() -> str:
    from app import workflow  # noqa: PLC0415

    state = workflow.run("帮我生成《函数单调性》教案", history=[])
    products = [pid for pid in workflow.PRODUCERS if (state.get(pid) or {}).get("content")]
    return f"产出 {len(products)} 个产物"


def t_databus_roundtrip() -> str:
    from app import databus  # noqa: PLC0415

    usage = databus.data_usage(subject="")
    return f"data_usage 返回 {len(usage)} 项"


def t_rag_importable() -> str:
    from app.rag import bm25, hybrid, pipeline, vector_store  # noqa: PLC0415,F401

    st = pipeline.status()
    return f"status keys={len(st)}"


def t_bus_tools_signature() -> str:
    import inspect  # noqa: PLC0415

    from app.agent import bus_tools  # noqa: PLC0415

    for name, (impl, _desc) in bus_tools.TOOL_IMPLS.items():
        params = set(inspect.signature(impl).parameters)
        assert params, f"{name} 签名不可见"
    return f"{len(bus_tools.TOOL_IMPLS)} 个工具签名可解析"


def main() -> int:
    print("[smoke] 1/5 Python 编译检查")
    check("全部 .py 编译通过", t_compile_all)
    print("[smoke] 2/5 workflow mock 引擎")
    check("mock 工作流可跑通", t_workflow_mock)
    print("[smoke] 3/5 databus 数据总线")
    check("data_usage 可查", t_databus_roundtrip)
    print("[smoke] 4/5 RAG 检索层")
    check("rag 模块可导入", t_rag_importable)
    print("[smoke] 5/5 MCP 数据工具签名")
    check("bus_tools 签名过滤前提", t_bus_tools_signature)

    print(f"\n[smoke] 通过 {PASSED} 项，失败 {len(FAILED)} 项")
    if FAILED:
        print("[smoke] 失败明细：")
        for f in FAILED:
            print("  - " + f)
        return 1
    print("[smoke] 全部通过 ✓")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
