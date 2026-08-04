#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
教师备课智能体 · 沙箱初始化与校验脚本
====================================
功能：
  1. 按分类验证所有 Python 包（核心 / 推荐 / 可选 三级）
     - 核心包导入失败 → 报错退出（exit 1），沙箱不可用
     - 推荐包失败 → 仅打印警告，相关功能降级
     - 可选包失败 → 静默跳过，不记录错误
  2. 验证系统工具是否存在（pandoc / libreoffice / ffmpeg / tesseract / chromium 等）
     通过 shutil.which（等价 which / command -v）检查 PATH 中的二进制
  3. 创建工作区目录结构（教案/课件/学案/量规/大单元/分层/试题/临时）
  4. 预热关键库，缩短首次调用延迟
     python-docx / python-pptx / openpyxl / matplotlib(Agg) / jieba / sympy
  5. 输出 JSON 健康状态到 stdout（供容器编排 / 监控系统解析）
  6. 不再无限循环等待（API 服务由 sandbox_api.py 负责保持运行）

浏览器端由 sandbox-runtime.js 通过 Pyodide 等价实现，本脚本仅服务端使用。
可独立运行：python init-sandbox.py
"""
import sys
import os
import json
import time
import shutil
import importlib

WORKSPACE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "workspace")
ROOT_DIRS = ["教案", "课件", "学案", "量规", "大单元", "分层", "试题", "临时"]

# ================================================================
# Python 包清单：分为核心 / 推荐 / 可选 三级
# 结构：{ "PyPI 包名": "导入模块名" }
# ================================================================

# ---- 核心包：导入失败即判定沙箱不可用，退出码 1 ----
CORE_PACKAGES = {
    # 文档生成（备课核心产物）
    "python-pptx": "pptx",
    "python-docx": "docx",
    "openpyxl": "openpyxl",
    "xlsxwriter": "xlsxwriter",
    "reportlab": "reportlab",
    "jinja2": "jinja2",
    # 数据处理与分析
    "pandas": "pandas",
    "numpy": "numpy",
    "matplotlib": "matplotlib",
    "sympy": "sympy",
    # 中文分词与文本处理
    "jieba": "jieba",
    # 网络请求与解析
    "requests": "requests",
    "beautifulsoup4": "bs4",
    "lxml": "lxml",
    "Pillow": "PIL",
    # 配置与命令行
    "pyyaml": "yaml",
    "pydantic": "pydantic",
    "python-dotenv": "dotenv",
    "tqdm": "tqdm",
    "rich": "rich",
    "python-dateutil": "dateutil",
    # Web 框架（API 服务自身依赖，必须可用）
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
}

# ---- 推荐包：导入失败仅打印警告，不影响沙箱启动 ----
RECOMMENDED_PACKAGES = {
    # 文档生成扩展
    "docxtpl": "docxtpl",
    "fpdf2": "fpdf",
    "weasyprint": "weasyprint",
    "docx2pdf": "docx2pdf",
    # 数据处理与分析扩展
    "scipy": "scipy",
    "statsmodels": "statsmodels",
    "scikit-learn": "sklearn",
    # 可视化与图表
    "seaborn": "seaborn",
    "plotly": "plotly",
    "pyecharts": "pyecharts",
    "wordcloud": "wordcloud",
    "graphviz": "graphviz",
    "networkx": "networkx",
    # 文本处理与 NLP
    "markdown": "markdown",
    "markdown2": "markdown2",
    "regex": "regex",
    "pypinyin": "pypinyin",
    "zhon": "zhon",
    "nltk": "nltk",
    "spacy": "spacy",
    "language-tool-python": "language_tool",
    # PDF 读取与处理
    "pdfplumber": "pdfplumber",
    "pypdf": "pypdf",
    "PyPDF2": "PyPDF2",
    "camelot-py": "camelot",
    "pdf2image": "pdf2image",
    "img2pdf": "img2pdf",
    # 图片与多媒体
    "cairosvg": "cairosvg",
    "opencv-python-headless": "cv2",
    "qrcode": "qrcode",
    "imageio": "imageio",
    "moviepy": "moviepy",
    "pydub": "pydub",
    "gtts": "gtts",
    "pyttsx3": "pyttsx3",
    "SpeechRecognition": "speech_recognition",
    # 联网搜索与网络请求
    "httpx": "httpx",
    "aiohttp": "aiohttp",
    "duckduckgo-search": "duckduckgo_search",
    "feedparser": "feedparser",
    "playwright": "playwright",
    "selenium": "selenium",
    # AI/LLM 与智能体框架
    "openai": "openai",
    "langchain": "langchain",
    "langchain-community": "langchain_community",
    "langchain-openai": "langchain_openai",
    "langgraph": "langgraph",
    "llama-index": "llama_index",
    "chromadb": "chromadb",
    "faiss-cpu": "faiss",
    "sentence-transformers": "sentence_transformers",
    "tiktoken": "tiktoken",
    "dashscope": "dashscope",
    "zhipuai": "zhipuai",
    "anthropic": "anthropic",
    # 模板引擎与排版
    "pylatex": "pylatex",
    # 学科专用工具
    "manim": "manim",
    "rdkit": "rdkit",
    "music21": "music21",
    # 记忆与知识管理
    "redis": "redis",
    "joblib": "joblib",
    "sqlalchemy": "sqlalchemy",
    # 系统工具与安全
    "cryptography": "cryptography",
    "apscheduler": "apscheduler",
    "watchdog": "watchdog",
    "python-magic": "magic",
    "uuid6": "uuid6",
    # Web 框架扩展
    "python-multipart": "multipart",
    "websockets": "websockets",
}

# ---- 可选包：导入失败静默跳过（通常受平台/资源/模型大小限制）----
OPTIONAL_PACKAGES = {
    "hanlp": "hanlp",        # HanLP 模型较大，构建时可能跳过下载
}


# ================================================================
# 系统工具清单：校验 apt 安装的二进制是否可用
# 列表中工具只要有一个变体可用即视为通过（如 chromium / chromium-browser）
# ================================================================
SYSTEM_TOOLS = [
    # 文档转换
    "pandoc",
    "libreoffice",
    "soffice",            # libreoffice 别名
    "wkhtmltopdf",
    # PDF 处理
    "gs",                 # ghostscript
    "pdftotext",          # poppler-utils
    "pdfinfo",            # poppler-utils
    "qpdf",
    "mutool",
    # OCR
    "tesseract",
    # 音视频
    "ffmpeg",
    "ffprobe",
    "sox",
    "lame",
    # 图像处理
    "convert",            # imagemagick
    "optipng",
    "jpegoptim",
    "cwebp",              # libwebp
    # 图形与 UML
    "dot",                # graphviz
    "plantuml",
    # TeX 排版
    "xelatex",            # texlive-xetex
    "latexmk",
    # 浏览器
    "chromium",
    "chromium-browser",
    # 数据库与缓存
    "sqlite3",
    "redis-server",
    "redis-cli",
    # 压缩
    "zip",
    "7z",                 # p7zip-full
    # 网络与系统
    "curl",
    "wget",
    "openssl",
    "git",
    "supervisord",        # supervisor
    "nginx",
]


# ================================================================
# 工具函数
# ================================================================

def _try_import(module_name):
    """安全导入模块，返回 (success, error_message)"""
    try:
        importlib.import_module(module_name)
        return True, None
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def ensure_workspace():
    """创建工作区目录，返回已创建（或已存在）的目录路径列表"""
    created = []
    for d in ROOT_DIRS:
        path = os.path.join(WORKSPACE, d)
        os.makedirs(path, exist_ok=True)
        created.append(path)
    return created


def verify_packages():
    """分三级验证 Python 包

    Returns:
        dict: {
            "core":         {"ok": [...], "fail": [{"package","module","error"}, ...]},
            "recommended":  {"ok": [...], "fail": [...]},
            "optional":     {"ok": [...], "fail": [...]},  # 失败静默跳过，仅计数
        }
    """
    result = {
        "core":        {"ok": [], "fail": []},
        "recommended": {"ok": [], "fail": []},
        "optional":    {"ok": [], "fail": []},
    }

    # 核心包
    for pkg, mod in CORE_PACKAGES.items():
        ok, err = _try_import(mod)
        if ok:
            result["core"]["ok"].append(pkg)
        else:
            result["core"]["fail"].append({
                "package": pkg,
                "module": mod,
                "error": err,
            })

    # 推荐包
    for pkg, mod in RECOMMENDED_PACKAGES.items():
        ok, err = _try_import(mod)
        if ok:
            result["recommended"]["ok"].append(pkg)
        else:
            result["recommended"]["fail"].append({
                "package": pkg,
                "module": mod,
                "error": err,
            })

    # 可选包：失败静默跳过，不记录错误详情
    for pkg, mod in OPTIONAL_PACKAGES.items():
        ok, _ = _try_import(mod)
        if ok:
            result["optional"]["ok"].append(pkg)
        else:
            result["optional"]["fail"].append({"package": pkg})

    return result


def verify_system_tools():
    """验证系统工具是否可用（使用 shutil.which 等价 which / command -v）

    Returns:
        tuple: (ok_list, missing_list)
            ok_list = [{"tool": str, "path": str}, ...]
            missing_list = [tool_name, ...]
    """
    ok, missing = [], []
    for tool in SYSTEM_TOOLS:
        path = shutil.which(tool)
        if path:
            ok.append({"tool": tool, "path": path})
        else:
            missing.append(tool)
    return ok, missing


def warmup():
    """预热关键库，缩短首次调用延迟

    Returns:
        dict: {"ok": [...], "fail": [{"library": str, "error": str}, ...]}
    """
    warmup_result = {"ok": [], "fail": []}

    # python-docx：触发懒加载
    try:
        from docx import Document  # noqa: F401
        warmup_result["ok"].append("python-docx")
    except Exception as e:  # noqa: BLE001
        warmup_result["fail"].append({"library": "python-docx", "error": str(e)})

    # python-pptx：触发懒加载
    try:
        from pptx import Presentation  # noqa: F401
        warmup_result["ok"].append("python-pptx")
    except Exception as e:  # noqa: BLE001
        warmup_result["fail"].append({"library": "python-pptx", "error": str(e)})

    # openpyxl：触发懒加载
    try:
        from openpyxl import Workbook  # noqa: F401
        warmup_result["ok"].append("openpyxl")
    except Exception as e:  # noqa: BLE001
        warmup_result["fail"].append({"library": "openpyxl", "error": str(e)})

    # matplotlib：切换到 Agg 无显示后端并预加载 pyplot
    try:
        import matplotlib
        matplotlib.use("Agg")  # 无显示环境，避免 backend 报错
        import matplotlib.pyplot as plt  # noqa: F401
        warmup_result["ok"].append("matplotlib(Agg)")
    except Exception as e:  # noqa: BLE001
        warmup_result["fail"].append({"library": "matplotlib", "error": str(e)})

    # jieba：初始化分词器（加载默认词典）
    try:
        import jieba
        list(jieba.cut("初始化中文分词"))  # 强制完成词典加载
        warmup_result["ok"].append("jieba")
    except Exception as e:  # noqa: BLE001
        warmup_result["fail"].append({"library": "jieba", "error": str(e)})

    # sympy：初始化符号计算
    try:
        import sympy
        sympy.Symbol("x")  # 触发基础模块加载
        warmup_result["ok"].append("sympy")
    except Exception as e:  # noqa: BLE001
        warmup_result["fail"].append({"library": "sympy", "error": str(e)})

    return warmup_result


# ================================================================
# 健康状态构建
# ================================================================

def build_health_status():
    """构建 JSON 健康状态对象"""
    workspace_dirs = ensure_workspace()
    packages = verify_packages()
    tools_ok, tools_missing = verify_system_tools()
    warmup_result = warmup()

    # 核心包失败 → 视为 degraded，并由 main() 决定是否退出
    has_critical_failure = len(packages["core"]["fail"]) > 0

    status = {
        "status": "healthy" if not has_critical_failure else "degraded",
        "critical_failure": has_critical_failure,
        "timestamp": int(time.time()),
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "workspace": WORKSPACE,
        "workspace_dirs": workspace_dirs,
        "packages": {
            "core": {
                "ok_count": len(packages["core"]["ok"]),
                "fail_count": len(packages["core"]["fail"]),
                "failures": packages["core"]["fail"],
            },
            "recommended": {
                "ok_count": len(packages["recommended"]["ok"]),
                "fail_count": len(packages["recommended"]["fail"]),
                "failures": packages["recommended"]["fail"],
            },
            "optional": {
                "ok_count": len(packages["optional"]["ok"]),
                "fail_count": len(packages["optional"]["fail"]),
            },
        },
        "system_tools": {
            "ok_count": len(tools_ok),
            "missing": tools_missing,
        },
        "warmup": warmup_result,
    }
    return status


# ================================================================
# 主入口
# ================================================================

def main():
    # 日志输出到 stderr，stdout 仅保留 JSON 健康状态（便于编排系统解析）
    print("=" * 60, file=sys.stderr)
    print("教师备课智能体沙箱 · 初始化校验", file=sys.stderr)
    print("=" * 60, file=sys.stderr)

    status = build_health_status()

    # 推荐包失败 → 打印警告
    rec_fail_count = status["packages"]["recommended"]["fail_count"]
    if rec_fail_count > 0:
        print(
            f"[sandbox] WARNING: {rec_fail_count} 个推荐包导入失败，相关功能将降级",
            file=sys.stderr,
        )
        for item in status["packages"]["recommended"]["failures"]:
            print(f"  - {item['package']} ({item['module']}): {item['error']}",
                  file=sys.stderr)

    # 系统工具缺失 → 打印警告
    missing_tools = status["system_tools"]["missing"]
    if missing_tools:
        print(
            f"[sandbox] WARNING: {len(missing_tools)} 个系统工具未在 PATH 中: "
            f"{', '.join(missing_tools)}",
            file=sys.stderr,
        )

    # 输出 JSON 健康状态到 stdout
    print(json.dumps(status, ensure_ascii=False, indent=2))

    # 核心包失败 → 报错退出（exit 1）
    if status["critical_failure"]:
        print("[sandbox] ERROR: 核心包导入失败，沙箱不可用，退出", file=sys.stderr)
        for item in status["packages"]["core"]["failures"]:
            print(f"  - {item['package']} ({item['module']}): {item['error']}",
                  file=sys.stderr)
        sys.exit(1)

    print("[sandbox] init-sandbox done, handoff to sandbox_api.py", file=sys.stderr)
    # 不再无限循环等待
    # API 服务由 sandbox_api.py（uvicorn sandbox_api:app）负责保持运行


if __name__ == "__main__":
    main()
