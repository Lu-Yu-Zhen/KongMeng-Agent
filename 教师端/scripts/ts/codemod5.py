# -*- coding: utf-8 -*-
"""TS 迁移 codemod v5：使用点边界断言（最后一轮自动化）
==========================================================
针对剩余 TS2339 / TS7053 / TS7006 / TS18047 / TS2531：
在错误所在表达式的**接收者**上插入 `as LegacyBoundary` 边界断言：
    foo.bar.baz   →  (foo.bar as LegacyBoundary).baz
仅改类型（编译期擦除），不改运行逻辑。同时统计残差供人工收敛。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NODE = r"C:\Users\晖\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
TSC = os.path.join(ROOT, "node_modules", "typescript", "bin", "tsc")
ERR_RE = re.compile(r"^([^(]+)\((\d+),(\d+)\): error (TS\d+): (.*)$")
TARGET_CODES = {"TS2339", "TS7053", "TS7006", "TS18047", "TS2531"}


def run_tsc(config: str):
    p = subprocess.run([NODE, TSC, "-p", config, "--noEmit", "--pretty", "false"],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    errs = []
    for line in ((p.stdout or "") + (p.stderr or "")).splitlines():
        m = ERR_RE.match(line.strip())
        if m:
            errs.append((m.group(1), int(m.group(2)), int(m.group(3)), m.group(4), m.group(5)))
    return errs


def read_text(path):
    raw = open(path, "rb").read()
    return raw.decode("utf-8-sig"), raw.startswith(b"\xef\xbb\xbf")


def write_text(path, text, bom):
    data = text.encode("utf-8")
    open(path, "wb").write((b"\xef\xbb\xbf" + data) if bom else data)


def wrap_receiver(line: str, col: int) -> tuple[str, bool]:
    """把错误列之前的接收者表达式用 as LegacyBoundary 包裹。"""
    before, after = line[:col], line[col:]
    # 接收者：链式标识符（可能含 this.）
    m = re.search(r"((?:this\.)?[\w$]+(?:\.[\w$]+)*(?:\[[^\]]+\])*)\s*\.\s*([\w$]+)\s*$", before)
    if not m:
        return line, False
    start = m.start(1)
    # 若已包裹则跳过
    if before[:start].rstrip().endswith("(") and re.match(r"^\s*as\s+LegacyBoundary", m.group(1) + after[:40]):
        return line, False
    recv = m.group(1)
    new_before = before[:start] + f"({recv} as LegacyBoundary)"
    rest = before[m.end(1):]
    return new_before + rest + after, True


def fix_file(rel, items):
    path = os.path.join(ROOT, rel.replace("/", os.sep))
    if not os.path.exists(path):
        return 0, Counter()
    text, bom = read_text(path)
    lines = text.split("\n")
    fixed = 0
    kinds = Counter()
    for ln, col, code, msg in sorted(items, key=lambda x: (x[0], x[1]), reverse=True):
        if code not in TARGET_CODES:
            continue
        idx = ln - 1
        if idx < 0 or idx >= len(lines):
            continue
        new_line, ok = wrap_receiver(lines[idx], col)
        if ok:
            lines[idx] = new_line
            fixed += 1
            kinds[f"{code}/使用点断言"] += 1
    write_text(path, "\n".join(lines), bom)
    return fixed, kinds


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--rounds", type=int, default=4)
    args = ap.parse_args()
    total = Counter()
    for rnd in range(1, args.rounds + 1):
        errs = run_tsc(args.config)
        print(f"[v5 round {rnd}] errors={len(errs)} codes={dict(Counter(e[3] for e in errs).most_common(10))}")
        if not errs:
            print("✅ 无错误")
            break
        by_file = defaultdict(list)
        for f, ln, col, code, msg in errs:
            by_file[f].append((ln, col, code, msg))
        fixed = 0
        for rel, items in by_file.items():
            n, kinds = fix_file(rel, items)
            fixed += n
            total.update(kinds)
        print(f"[v5 round {rnd}] fixed={fixed} {dict(total.most_common(8))}")
        if fixed == 0:
            break
    final = run_tsc(args.config)
    print(f"最终剩余：{len(final)} 按码={dict(Counter(e[3] for e in final).most_common(10))}")
    with open(os.path.join(ROOT, "tests", "_codemod5_final.json"), "w", encoding="utf-8") as f:
        json.dump({"fixed": dict(total), "remaining": len(final),
                   "remainingByCode": dict(Counter(e[3] for e in final)),
                   "detail": [f"{e[0]}({e[1]},{e[2]}) {e[3]}: {e[4]}" for e in final[:300]]},
                  f, ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
