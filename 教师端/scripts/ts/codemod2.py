# -*- coding: utf-8 -*-
"""TS 迁移 codemod v2：第二轮结构类错误修复
================================================
在 v1（参数/变量隐式 any）基础上，处理严格模式下集中出现的结构性错误：
  R1 TS2339/TS2551 on 对象字面量类型 → 给该字面量声明标注 LegacyBoundary（收敛迁移边界）
  R2 TS2339/TS2551 on 'string' → 将启发式误标的 `: string` 回退为 LegacyBoundary
  R3 TS2339/TS2551 on 'Event'  → 将启发式误标的 `: Event` 回退为 LegacyBoundary
  R4 TS7053 can't be used to index type '{...}'/'{}' → 该变量声明标注 Record<string, LegacyBoundary>
  R5 TS2322 ... not assignable to type 'null' → 将 `= null` 声明标注 LegacyBoundary
  R7 TS18047/TS2531 可能为 null → 在接收者后插入非空断言（仅当接收者非调用表达式时）

仅改类型注解，不改运行逻辑。用法：python scripts/ts/codemod2.py --config tsconfig.renderer-sandbox.json
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
DECL_RE = re.compile(r"^(\s*)(var|let|const)\s+([\w$]+)\s*(?::\s*[^=]+)?=\s*\{\s*$")


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


def collect_literals(lines):
    """收集顶层 `X = {` 字面量声明：(行号, 缩进, 变量名)。"""
    out = []
    for i, ln in enumerate(lines):
        m = DECL_RE.match(ln)
        if m:
            out.append((i, len(m.group(1)), m.group(3)))
    return out


def enclosing_literal(literals, line_idx):
    """选择错误行之前、缩进最小（最外层）且行号最大的字面量声明。"""
    cands = [x for x in literals if x[0] < line_idx]
    if not cands:
        return None
    min_indent = min(x[1] for x in cands)
    outer = [x for x in cands if x[1] == min_indent]
    return max(outer, key=lambda x: x[0])


def apply(text, path_bomless):
    lines = text.split("\n")
    literals = collect_literals(lines)
    return lines, literals


def fix_file(rel, items):
    path = os.path.join(ROOT, rel.replace("/", os.sep))
    if not os.path.exists(path):
        return 0, Counter()
    text, bom = read_text(path)
    lines = text.split("\n")
    literals = collect_literals(lines)
    fixed = 0
    kinds = Counter()
    done_decl = set()

    def annotate_decl(idx, ann, kind):
        nonlocal fixed
        key = (idx, ann)
        if key in done_decl:
            return
        m = DECL_RE.match(lines[idx])
        if not m:
            return
        head, name = m.group(1) + m.group(2) + " " + m.group(3), m.group(3)
        lines[idx] = re.sub(rf"^(\s*)(var|let|const)\s+{re.escape(name)}",
                            lambda mm: f"{mm.group(1)}{mm.group(2)} {name}: {ann}", lines[idx], count=1)
        done_decl.add(key)
        fixed += 1
        kinds[kind] += 1

    def revert_near(name, wrong, line_idx, kind):
        nonlocal fixed
        for i in range(min(line_idx, len(lines) - 1), max(-1, line_idx - 400), -1):
            if re.search(rf"\b{re.escape(name)}\s*:\s*{re.escape(wrong)}\b", lines[i]):
                lines[i] = re.sub(rf"(\b{re.escape(name)}\s*:\s*){re.escape(wrong)}\b",
                                  rf"\1LegacyBoundary", lines[i], count=1)
                fixed += 1
                kinds[kind] += 1
                return True
        return False

    for ln, col, code, msg in sorted(items, key=lambda x: (x[0], x[1]), reverse=True):
        idx = ln - 1
        if idx < 0 or idx >= len(lines):
            continue
        line = lines[idx]
        if code in ("TS2339", "TS2551"):
            if "on type 'string'" in msg:
                recv = re.search(r"([\w$]+)\s*\.\s*[\w$]+\s*$", line[:col])
                if recv and revert_near(recv.group(1), "string", idx, "R2/string→LegacyBoundary"):
                    continue
                continue
            if "on type 'Event'" in msg:
                recv = re.search(r"([\w$]+)\s*\.\s*[\w$]+\s*$", line[:col])
                if recv and revert_near(recv.group(1), "Event", idx, "R3/Event→LegacyBoundary"):
                    continue
                continue
            if "does not exist on type '{" in msg:
                recv = re.search(r"([\w$]+)\s*\.\s*[\w$]+\s*$", line[:col])
                rname = recv.group(1) if recv else "this"
                if rname == "this":
                    lit = enclosing_literal(literals, idx)
                else:
                    cands = [x for x in literals if x[2] == rname and x[0] < idx]
                    lit = max(cands, key=lambda x: x[0]) if cands else None
                if lit:
                    annotate_decl(lit[0], "LegacyBoundary", "R1/字面量→LegacyBoundary")
                continue
        if code == "TS7053":
            m = re.search(r"([\w$]+)\s*\[", line[max(0, col - 60):col + 80])
            rname = m.group(1) if m else None
            if rname:
                cands = [x for x in literals if x[2] == rname and x[0] < idx]
                if not cands:
                    # 可能是 `= {}` 声明：标注为 Record
                    empty_re = re.compile(r"^\s*(var|let|const)\s+" + re.escape(rname) + r"\s*=\s*\{\s*\}\s*;\s*$")
                    decl_re = re.compile(r"^(\s*)(var|let|const)\s+" + re.escape(rname))
                    for i in range(idx, max(-1, idx - 400), -1):
                        if empty_re.search(lines[i]):
                            lines[i] = decl_re.sub(
                                lambda z, _n=rname: f"{z.group(1)}{z.group(2)} {_n}: Record<string, LegacyBoundary>",
                                lines[i], count=1)
                            fixed += 1
                            kinds["R4/空对象→Record"] += 1
                            break
                else:
                    annotate_decl(max(cands, key=lambda x: x[0])[0], "Record<string, LegacyBoundary>", "R4/字面量→Record")
            continue
        if code == "TS2322" and "not assignable to type 'null'" in msg:
            m = re.search(r"([\w$]+)\s*=", line)
            if m:
                vname = m.group(1)
                for i in range(idx, max(-1, idx - 400), -1):
                    mm = re.search(rf"^(\s*)(var|let|const)\s+{re.escape(vname)}\s*=\s*null\s*;", lines[i])
                    if mm:
                        lines[i] = re.sub(rf"^(\s*)(var|let|const)\s+{re.escape(vname)}\s*=\s*null\s*;",
                                          lambda z: f"{z.group(1)}{z.group(2)} {vname}: LegacyBoundary = null;",
                                          lines[i], count=1)
                        fixed += 1
                        kinds["R5/null 声明→LegacyBoundary"] += 1
                        break
            continue
        if code in ("TS18047", "TS2531"):
            seg = line[col - 1:]
            m = re.match(r"([\w$]+(?:\.[\w$]+)*)", seg)
            if m and not seg[len(m.group(1)):].startswith("("):
                ins = col - 1 + m.end()
                lines[idx] = line[:ins] + "!" + line[ins:]
                fixed += 1
                kinds["R7/非空断言"] += 1
            continue
    write_text(path, "\n".join(lines), bom)
    return fixed, kinds


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--rounds", type=int, default=5)
    args = ap.parse_args()
    total = Counter()
    for rnd in range(1, args.rounds + 1):
        errs = run_tsc(args.config)
        print(f"[v2 round {rnd}] errors={len(errs)} codes={dict(Counter(e[3] for e in errs).most_common(8))}")
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
        print(f"[v2 round {rnd}] fixed={fixed} {dict(total.most_common(10))}")
        if fixed == 0:
            print("⚠️ 无可自动修复项")
            break
    final = run_tsc(args.config)
    print(f"最终剩余：{len(final)}  按码={dict(Counter(e[3] for e in final).most_common(10))}")
    with open(os.path.join(ROOT, "tests", "_codemod2_final.json"), "w", encoding="utf-8") as f:
        json.dump({"fixed": dict(total), "remaining": len(final),
                   "remainingByCode": dict(Counter(e[3] for e in final)),
                   "detail": [f"{e[0]}({e[1]},{e[2]}) {e[3]}: {e[4]}" for e in final[:300]]},
                  f, ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
