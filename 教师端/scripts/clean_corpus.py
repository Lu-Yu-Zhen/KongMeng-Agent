# -*- coding: utf-8 -*-
"""
数据清洗与标注脚本
====================
从原始语料（raw/{学科}/*.txt 或 *.md）清洗归一，产出 rag_data/corpus/{学科}/*.txt。
清洗规则：
  - 去页眉页脚/行号/页脚页码
  - 合并断行（行尾无标点则并入下一行）
  - 公式 LaTeX 归一（全角转半角、统一 \frac → / 保留可读）
  - 去重（相似行）
  - 敏感过滤（占位符）
  - 输出清洗报告（清洗前后行数/去重数/异常告警）到 rag_data/logs/
用法：
  python scripts/clean_corpus.py [--subject 数学] [--input DIR] [--dry-run]
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys
import time

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_BACKEND = os.path.join(_BASE, "backend")
for _p in (_BACKEND, _BASE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

logging.basicConfig(level=logging.INFO, format="[clean] %(levelname)s %(message)s")
log = logging.getLogger("clean_corpus")

# 页眉页脚/页码/行号 模式
_PATTERNS = [
    re.compile(r"^\s*\d{1,4}\s*$"),                # 纯页码
    re.compile(r"^\s*第\s*\d+\s*页\s*$"),          # 第X页
    re.compile(r"^\s*[-—–]\s*\d+\s*[-—–]\s*$"),   # -- 页码 --
    re.compile(r"^\s*人教版.*?(必修|选择性必修|选修).*?\d*\s*$"),  # 页眉书名
    re.compile(r"^\s*(第|Unit|Lesson)\s*\d+\s*[课单元]\s*$"),     # 章节页眉
]
_SENSITIVE = re.compile(r"(\{\{[\w.]+\}\}|TODO|FIXME|占位|待录入|此处插入)", re.I)


def _full_to_half(s: str) -> str:
    """全角符号转半角（保留中文标点）。"""
    out = []
    for ch in s:
        code = ord(ch)
        if code == 0x3000:
            out.append(" ")
        elif 0xFF01 <= code <= 0xFF5E:
            out.append(chr(code - 0xFEE0))
        else:
            out.append(ch)
    return "".join(out)


def _normalize_formula(s: str) -> str:
    """公式文本做轻量归一：空格归一、\frac 转 /。"""
    s = re.sub(r"\\frac\{([^}]+)\}\{([^}]+)\}", r"\1/\2", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _is_noise(line: str) -> bool:
    """判断是否为噪声行。"""
    if len(line.strip()) <= 1:
        return True
    for p in _PATTERNS:
        if p.match(line):
            return True
    return False


def _merge_lines(lines: list) -> list:
    """合并断行：行尾无终止标点且下一行非空则并入。"""
    merged = []
    buf = ""
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if buf:
            if _ends_terminator(buf):
                merged.append(buf)
                buf = line
            else:
                buf += line
        else:
            buf = line
    if buf:
        merged.append(buf)
    return merged


def _ends_terminator(s: str) -> bool:
    return bool(re.search(r"[。！？；!?;：:.．…]$", s.strip()))


def clean_text(text: str) -> tuple:
    """清洗整段文本，返回 (清洗后各行, 统计)。"""
    stats = {"raw_lines": 0, "noise_removed": 0, "merged": 0, "deduped": 0, "sensitive": 0}
    lines = text.splitlines()
    stats["raw_lines"] = len(lines)

    # 1) 噪声行过滤 + 全角转半角
    kept = []
    for ln in lines:
        if _is_noise(ln):
            stats["noise_removed"] += 1
            continue
        kept.append(_full_to_half(ln))

    # 2) 合并断行
    merged_before = len(kept)
    merged = _merge_lines(kept)
    stats["merged"] = merged_before - len(merged)

    # 3) 公式归一 + 去重（保持顺序）
    seen = set()
    out = []
    for ln in merged:
        ln = _normalize_formula(ln)
        if re.search(r"[\u4e00-\u9fffA-Za-z0-9]", ln) is None:
            continue
        key = ln[:60]
        if not ln or key in seen:
            stats["deduped"] += 1
            continue
        seen.add(key)
        if _SENSITIVE.search(ln):
            stats["sensitive"] += 1
        out.append(ln)
    return out, stats


def clean_file(src: str, dst: str, dry_run: bool = False) -> dict:
    with open(src, "r", encoding="utf-8") as f:
        text = f.read()
    out, stats = clean_text(text)
    if not dry_run:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "w", encoding="utf-8") as f:
            f.write("\n".join(out) + "\n" if out else "")
    stats["src"] = src
    stats["dst"] = dst
    stats["out_lines"] = len(out)
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="清洗语料")
    parser.add_argument("--subject", default="", help="指定学科，缺省全科")
    parser.add_argument("--input", default="", help="原始语料根目录，缺省 rag_data/raw")
    parser.add_argument("--dry-run", action="store_true", help="仅预览报告，不写文件")
    args = parser.parse_args()

    from app.rag import config

    config.ensure_dirs()
    raw_root = args.input or os.path.join(config.DATA_ROOT, "raw")
    subjects = [args.subject] if args.subject else config.SUBJECTS

    report = {"files": [], "subjects": {}}
    for subject in subjects:
        src_dir = os.path.join(raw_root, subject)
        if not os.path.isdir(src_dir):
            log.warning("无原始语料目录：%s", src_dir)
            continue
        dst_dir = os.path.join(config.CORPUS_DIR, subject)
        subj_stats = []
        for fn in sorted(os.listdir(src_dir)):
            if not (fn.endswith(".txt") or fn.endswith(".md")):
                continue
            src = os.path.join(src_dir, fn)
            dst = os.path.join(dst_dir, os.path.splitext(fn)[0] + ".txt")
            st = clean_file(src, dst, args.dry_run)
            subj_stats.append(st)
            report["files"].append(st)
            log.info("%s → %s：%d行→%d行（噪声%d 去重%d）",
                     st["src"], st["dst"], st["raw_lines"], st["out_lines"],
                     st["noise_removed"], st["deduped"])
        report["subjects"][subject] = subj_stats

    # 清洗报告落盘
    if not args.dry_run:
        log_dir = config.LOG_DIR
        os.makedirs(log_dir, exist_ok=True)
        rep_path = os.path.join(log_dir, f"cleaning-report-{time.strftime('%Y%m%d-%H%M%S')}.json")
        with open(rep_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        log.info("清洗报告：%s", rep_path)

    total_raw = sum(s["raw_lines"] for s in report["files"])
    total_out = sum(s["out_lines"] for s in report["files"])
    print(f"\n=== 清洗汇总（{'dry-run' if args.dry_run else '已写入'}）===")
    print(f"学科：{list(report['subjects'].keys())}")
    print(f"文件数：{len(report['files'])}  原始行：{total_raw} → 输出行：{total_out}")
    return 0


if __name__ == "__main__":
    import json
    sys.exit(main())