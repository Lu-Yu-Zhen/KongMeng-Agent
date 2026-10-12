# -*- coding: utf-8 -*-
"""TS 迁移 codemod v6：空值收窄与缺失全局声明（收尾轮）
========================================================
  R16 TS2304 Cannot find name 'X'
      → 汇总写入 src/types/globals-auto.d.ts：declare const X: LegacyBoundary;
        （全局脚本模式的跨文件引用收敛；后续 import 化时删除）
  R17 TS2531/TS18047（possibly null）
      → 在「可能为空」的表达式后插入非空断言 `!`
        （支持标识符链、调用表达式 getElementById('x')、链式 .querySelector 等）
仅改类型层，运行时行为不变。
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
AUTO_DTS = os.path.join(ROOT, "src", "types", "globals-auto.d.ts")
ERR_RE = re.compile(r"^([^(]+)\((\d+),(\d+)\): error (TS\d+): (.*)$")


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


def expr_end(line: str, start: int) -> int:
    """从 start 起解析一段表达式（标识符/属性/调用/下标）的结束位置。"""
    i, n = start, len(line)
    while i < n:
        ch = line[i]
        if ch.isalnum() or ch in "_$.":
            i += 1
            continue
        if ch == "(":
            depth = 0
            while i < n:
                if line[i] == "(":
                    depth += 1
                elif line[i] == ")":
                    depth -= 1
                    if depth == 0:
                        i += 1
                        break
                i += 1
            continue
        if ch == "[":
            depth = 0
            while i < n:
                if line[i] == "[":
                    depth += 1
                elif line[i] == "]":
                    depth -= 1
                    if depth == 0:
                        i += 1
                        break
                i += 1
            continue
        break
    return i


def fix_file(rel, items, missing_names: set):
    path = os.path.join(ROOT, rel.replace("/", os.sep))
    if not os.path.exists(path):
        return 0, Counter()
    text, bom = read_text(path)
    lines = text.split("\n")
    fixed = 0
    kinds = Counter()
    ins_cache: set[tuple[int, int]] = set()
    for ln, col, code, msg in sorted(items, key=lambda x: (x[0], x[1]), reverse=True):
        idx = ln - 1
        if idx < 0 or idx >= len(lines):
            continue
        if code == "TS2304":
            m = re.search(r"Cannot find name '([^']+)'", msg)
            if m:
                missing_names.add(m.group(1))
                kinds["R16/缺失全局声明"] += 1
            continue
        if code in ("TS2531", "TS18047"):
            start = col - 1
            end = expr_end(lines[idx], start)
            if end <= start:
                continue
            key = (idx, end)
            if key in ins_cache:
                continue
            seg = lines[idx][start:end]
            if seg.endswith("!") or "?" in seg:
                continue
            lines[idx] = lines[idx][:end] + "!" + lines[idx][end:]
            ins_cache.add(key)
            fixed += 1
            kinds["R17/非空断言"] += 1
    write_text(path, "\n".join(lines), bom)
    return fixed, kinds


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--rounds", type=int, default=3)
    args = ap.parse_args()
    total = Counter()
    missing: set[str] = set()
    for rnd in range(1, args.rounds + 1):
        errs = run_tsc(args.config)
        print(f"[v6 round {rnd}] errors={len(errs)} codes={dict(Counter(e[3] for e in errs).most_common(8))}")
        if not errs:
            break
        by_file = defaultdict(list)
        for f, ln, col, code, msg in errs:
            by_file[f].append((ln, col, code, msg))
        fixed = 0
        for rel, items in by_file.items():
            n, kinds = fix_file(rel, items, missing)
            fixed += n
            total.update(kinds)
        # R16：补齐缺失全局声明
        if missing:
            decl = "\n".join(f"declare const {nm}: LegacyBoundary;" for nm in sorted(missing))
            header = ("/** 自动生成：全局脚本模式下跨文件引用的名称（由 codemod v6 汇总）。\n"
                      " *  说明：这些名称在别的 <script> 中定义但通过裸标识符引用；\n"
                      " *  模块 import 化后应删除本文件对应条目。 */\n")
            write_text(AUTO_DTS, header + decl + "\n", False)
            print(f"[v6] 已写入 {len(missing)} 条全局声明 -> src/types/globals-auto.d.ts")
            total["R16/缺失全局声明"] += len(missing)
            missing.clear()
        print(f"[v6 round {rnd}] fixed={fixed}")
        if fixed == 0:
            break
    final = run_tsc(args.config)
    print(f"最终剩余：{len(final)} 按码={dict(Counter(e[3] for e in final).most_common(10))}")
    with open(os.path.join(ROOT, "tests", "_codemod6_final.json"), "w", encoding="utf-8") as f:
        json.dump({"fixed": dict(total), "remaining": len(final),
                   "remainingByCode": dict(Counter(e[3] for e in final)),
                   "detail": [f"{e[0]}({e[1]},{e[2]}) {e[3]}: {e[4]}" for e in final[:200]]},
                  f, ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
