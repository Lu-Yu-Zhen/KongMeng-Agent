# -*- coding: utf-8 -*-
"""
索引构建入口（命令行）
========================
用法：
  python scripts/build_index.py [--subject 数学] [--force] [--all]
从知识树 + 清洗语料构建向量库(sqlite-vec) + BM25 索引，写 manifest。
复用 backend.app.rag.pipeline.build()。
"""
from __future__ import annotations

import argparse
import logging
import os
import sys

# 将教师端 backend 加入 sys.path
_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_BACKEND = os.path.join(_BASE, "backend")
for _p in (_BACKEND, _BASE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

logging.basicConfig(level=logging.INFO, format="[build_index] %(levelname)s %(message)s")
log = logging.getLogger("build_index")


def main() -> int:
    parser = argparse.ArgumentParser(description="构建 RAG 索引")
    parser.add_argument("--subject", default="", help="指定学科，缺省全科")
    parser.add_argument("--force", action="store_true", help="强制全量重建（忽略断点续建）")
    args = parser.parse_args()

    from app.rag import config, pipeline

    config.ensure_dirs()
    subjects = [args.subject] if args.subject else config.SUBJECTS

    def _p(stage, pct, msg):
        log.info("[%s | %3d%%] %s", stage, pct, msg)

    result = pipeline.build(subjects=subjects, force=args.force, progress=_p)
    print("\n=== 构建结果 ===")
    print(f"总块数：{result['total_chunks']}")
    print(f"embed_mock：{result['embed_mock']}")
    print(f"manifest：{result['manifest']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())