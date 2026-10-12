# -*- coding: utf-8 -*-
"""TS 迁移 codemod v3：第三轮结构类错误修复
================================================
  R8  TS2339/TS2551 on '{}' / 'never' → 该变量声明标注 LegacyBoundary
  R9  TS2339/TS2551 on 'number'/'boolean' → 启发式误标回退为 LegacyBoundary
  R10 TS2683 'this' 隐式 any → 在所属函数参数表首位插入 `this: LegacyBoundary`
  R11 TS7053 索引错误 → 接收者声明标注 Record<string, LegacyBoundary>
仅改类型注解，不改运行逻辑。用法：python scripts/ts/codemod3.py --config tsconfig.renderer-sandbox.json
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


def fix_file(rel, items):
    path = os.path.join(ROOT, rel.replace("/", os.sep))
    if not os.path.exists(path):
        return 0, Counter()
    text, bom = read_text(path)
    lines = text.split("\n")
    fixed = 0
    kinds = Counter()
    touched = set()

    def annotate(idx: int, ann: str, kind: str) -> bool:
        nonlocal fixed
        if (idx, ann) in touched:
            return False
        m = re.match(r"^(\s*)(var|let|const)\s+([\w$]+)", lines[idx])
        if not m:
            return False
        name = m.group(3)
        if re.match(rf"^\s*(var|let|const)\s+{re.escape(name)}\s*:", lines[idx]):
            return False
        lines[idx] = re.sub(rf"^(\s*)(var|let|const)\s+{re.escape(name)}",
                            lambda z, _a=ann, _n=name: f"{z.group(1)}{z.group(2)} {_n}: {_a}",
                            lines[idx], count=1)
        touched.add((idx, ann))
        fixed += 1
        kinds[kind] += 1
        return True

    def find_decl(name: str, line_idx: int, pattern: str):
        for i in range(line_idx, max(-1, line_idx - 500), -1):
            if re.search(pattern.format(n=re.escape(name)), lines[i]):
                return i
        return None

    for ln, col, code, msg in sorted(items, key=lambda x: (x[0], x[1]), reverse=True):
        idx = ln - 1
        if idx < 0 or idx >= len(lines):
            continue
        line = lines[idx]
        seg_before = line[:col]
        recv_m = re.search(r"([\w$]+)\s*\.\s*[\w$]+\s*$", seg_before)
        recv = recv_m.group(1) if recv_m else None

        if code in ("TS2339", "TS2551"):
            if recv and ("on type '{}'" in msg or "on type 'never'" in msg
                         or "on type '{}'." in msg or msg.rstrip().endswith("type '{}'.")):
                i = find_decl(recv, idx, r"^\s*(var|let|const)\s+{n}\s*=")
                if i is not None:
                    annotate(i, "LegacyBoundary", "R8/{}→LegacyBoundary")
                continue
            if recv and ("on type 'number'" in msg or "on type 'boolean'" in msg):
                wrong = "number" if "on type 'number'" in msg else "boolean"
                i = find_decl(recv, idx, r"\b{n}\s*:\s*" + wrong + r"\b")
                if i is not None:
                    lines[i] = re.sub(rf"(\b{re.escape(recv)}\s*:\s*){wrong}\b", r"\1LegacyBoundary", lines[i], count=1)
                    fixed += 1
                    kinds[f"R9/{wrong}→LegacyBoundary"] += 1
                continue
        if code == "TS2683":
            for i in range(idx, max(-1, idx - 30), -1):
                m = re.search(r"(function\s+[\w$]*\s*\(|^\s*[\w$]+\s*\(|=>\s*\{)", lines[i])
                if m:
                    pos = i
                    mm = re.search(r"\(([^()]*)\)", lines[pos])
                    if mm and "this:" not in mm.group(1):
                        insert_at = mm.start(1)
                        lines[pos] = lines[pos][:insert_at] + "this: LegacyBoundary, " + lines[pos][insert_at:]
                        fixed += 1
                        kinds["R10/this 注解"] += 1
                    break
            continue
        if code == "TS7053" and recv:
            i = find_decl(recv, idx, r"^\s*(var|let|const)\s+{n}\s*=")
            if i is not None:
                annotate(i, "Record<string, LegacyBoundary>", "R11/索引签名")
            continue
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
        print(f"[v3 round {rnd}] errors={len(errs)} codes={dict(Counter(e[3] for e in errs).most_common(8))}")
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
        print(f"[v3 round {rnd}] fixed={fixed} {dict(total.most_common(10))}")
        if fixed == 0:
            break
    final = run_tsc(args.config)
    print(f"最终剩余：{len(final)} 按码={dict(Counter(e[3] for e in final).most_common(10))}")
    with open(os.path.join(ROOT, "tests", "_codemod3_final.json"), "w", encoding="utf-8") as f:
        json.dump({"fixed": dict(total), "remaining": len(final),
                   "remainingByCode": dict(Counter(e[3] for e in final)),
                   "detail": [f"{e[0]}({e[1]},{e[2]}) {e[3]}: {e[4]}" for e in final[:300]]},
                  f, ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
