# -*- coding: utf-8 -*-
"""TS 迁移 codemod v4：对象字面量属性类型 + 修复历史插入瑕疵
==============================================================
  R12 TS2339/TS2551/TS2322 针对 `this.X`/`X` 且错误类型为 'never'/'{}'/'null'
      → 定位字面量属性声明 `X: null,` / `X: {},` / `X: null` 并标注迁移边界类型
  R13 清理历史规则重复插入的 `!![` / `!!.` 产物
仅改类型注解，不改运行逻辑。
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

    # R13：先清理历史插入瑕疵
    for i, ln in enumerate(lines):
        if "!![" in ln:
            lines[i] = ln.replace("!![", "[")
            fixed += 1
            kinds["R13/清理 !![]"] += 1
        elif "!!." in ln:
            lines[i] = lines[i].replace("!!.", ".")
            fixed += 1
            kinds["R13/清理 !!."] += 1

    def annotate_prop(prop: str, line_idx: int, ann: str, kind: str) -> bool:
        nonlocal fixed
        key = (prop, ann)
        if key in touched:
            return False
        pat_null_empty = re.compile(rf"^(\s*){re.escape(prop)}\s*:\s*(null|\{{\}})\s*(,|$)")
        for i in range(line_idx, max(-1, line_idx - 600), -1):
            m = pat_null_empty.match(lines[i])
            if m and f"{prop}:" not in lines[i].split(":")[0] and " as " not in m.group(2):
                lines[i] = re.sub(rf"^(\s*{re.escape(prop)}\s*:\s*)(null|\{{\}})",
                                  lambda z, _a=ann: f"{z.group(1)}{z.group(2)} as {_a}", lines[i], count=1)
                touched.add(key)
                fixed += 1
                kinds[kind] += 1
                return True
        return False

    for ln, col, code, msg in sorted(items, key=lambda x: (x[0], x[1]), reverse=True):
        idx = ln - 1
        if idx < 0 or idx >= len(lines):
            continue
        line = lines[idx]
        seg = line[:col]
        m = re.search(r"(?:this\.)?([\w$]+)\s*\.\s*[\w$]+", seg)
        prop = m.group(1) if m else None
        if code in ("TS2339", "TS2551") and prop and ("on type 'never'" in msg or "on type '{}'" in msg
                                                     or "on type 'null'" in msg):
            any_t = "LegacyBoundary" if "on type 'never'" in msg or "on type 'null'" in msg else "LegacyBoundary"
            if annotate_prop(prop, idx, any_t, "R12/属性→LegacyBoundary"):
                continue
            # 属性可能声明为其他形如 `X: {}`（带内容）→ 尝试 Record
            annotate_prop(prop, idx, "Record<string, LegacyBoundary>", "R12/属性→Record")
            continue
        if code == "TS2322" and prop and ("not assignable to type 'null'" in msg):
            annotate_prop(prop, idx, "LegacyBoundary", "R12/null 属性")
            continue
        if code == "TS7053" and prop:
            annotate_prop(prop, idx, "Record<string, LegacyBoundary>", "R12/索引属性")
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
        print(f"[v4 round {rnd}] errors={len(errs)} codes={dict(Counter(e[3] for e in errs).most_common(8))}")
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
        print(f"[v4 round {rnd}] fixed={fixed} {dict(total.most_common(10))}")
        if fixed == 0:
            break
    final = run_tsc(args.config)
    print(f"最终剩余：{len(final)} 按码={dict(Counter(e[3] for e in final).most_common(10))}")
    with open(os.path.join(ROOT, "tests", "_codemod4_final.json"), "w", encoding="utf-8") as f:
        json.dump({"fixed": dict(total), "remaining": len(final),
                   "remainingByCode": dict(Counter(e[3] for e in final)),
                   "detail": [f"{e[0]}({e[1]},{e[2]}) {e[3]}: {e[4]}" for e in final[:300]]},
                  f, ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
