# -*- coding: utf-8 -*-
"""TS 迁移 codemod：JavaScript → TypeScript 严格模式自动补类型
================================================================
原理：以 `tsc --noEmit` 的诊断输出为输入，按错误码做**纯注解插入**：
  - TS7006 隐式 any 参数 → 按参数名启发式补类型
  - TS7034/TS7005 变量隐式 any/any[] → 按诊断给出的类型标注声明
  - TS2345（never[] 累加）→ 数组字面量声明补 as LegacyBoundary[]
  - TS18046 catch 变量 unknown → catch (e: LegacyBoundary)
仅新增/修改类型注解，不改动任何运行逻辑；类型在编译期擦除，故运行时行为不变。

用法：
  python scripts/ts/codemod.py --config tsconfig.renderer-sandbox.json [--rounds 6]
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

# ---- 参数名 → 类型启发式（避免滥用 any：可判定的用精确类型） ----
EXACT: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^(e|err|error|ex|exc|exception)$"), "LegacyBoundary"),
    (re.compile(r"^(ev|evt|event)$"), "Event"),
    (re.compile(r"(^|_)(el|elem|element|node|container|box|wrap|panel|modal|dialog|menu|btn|button|input|textarea|select|canvas|svg|img|table|tbody|thead|tr|td|th|div|span|form|label|icon|card|list|ul|li)$", re.I), "HTMLElement"),
    (re.compile(r"(El|Element|Node)$"), "HTMLElement"),
    (re.compile(r"^(id|key|name|text|str|s|msg|message|cls|className|subject|topic|kind|type|path|url|uri|href|content|title|desc|prompt|code|val|value|html|md|markdown|sep|prefix|suffix|tag|role|mode|style|color|placeholder|reason|detail|summary|label|keyword|query|q|a|b)$"), "string"),
    (re.compile(r"^(i|j|k|n|m|idx|index|count|len|length|num|size|total|max|min|score|age|ts|time|timeout|delay|start|end|limit|top|depth|round|step|width|height|duration|elapsed|progress|retry|turns|rounds)$"), "number"),
    (re.compile(r"^(ok|flag|force|silent|verbose|enabled|visible|auto|is[A-Z]\w*|has[A-Z]\w*|should[A-Z]\w*|multi|multiSelect|single|first|last)$"), "boolean"),
    (re.compile(r"^(cb|callback|fn|func|handler|resolve|reject|done|next|pred|predicate|mapper|filterFn|reducer|onDone|onError|onProgress|onToken|onEvent|onChunk|onUpdate)$"), "LegacyCallback"),
    (re.compile(r"^(list|arr|array|items|rows|files|ids|keys|names|points|lines|parts|tokens|steps|tasks|models|products|results|hits|matches|records|entries|nodes|chunks|slides|options)$"), "LegacyBoundary[]"),
]


def pick_type(name: str) -> str:
    for rx, t in EXACT:
        if rx.search(name):
            return t
    return "LegacyBoundary"


def read_text(path: str) -> tuple[str, bool]:
    with open(path, "rb") as f:
        raw = f.read()
    bom = raw.startswith(b"\xef\xbb\xbf")
    return raw.decode("utf-8-sig"), bom


def write_text(path: str, text: str, bom: bool) -> None:
    data = text.encode("utf-8")
    if bom:
        data = b"\xef\xbb\xbf" + data
    with open(path, "wb") as f:
        f.write(data)


def run_tsc(config: str) -> list[tuple[str, int, int, str, str]]:
    proc = subprocess.run(
        [NODE, TSC, "-p", config, "--noEmit", "--pretty", "false"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    errs = []
    for line in out.splitlines():
        m = ERR_RE.match(line.strip())
        if m:
            errs.append((m.group(1), int(m.group(2)), int(m.group(3)), m.group(4), m.group(5)))
    return errs


def apply_fixes(errs: list[tuple[str, int, int, str, str]]) -> tuple[int, Counter]:
    """按文件分组应用修复，返回（修复条数, 各修复类型计数）。"""
    by_file: dict[str, list[tuple[int, int, str, str]]] = defaultdict(list)
    for f, ln, col, code, msg in errs:
        by_file[f].append((ln, col, code, msg))

    fixed = 0
    kinds: Counter = Counter()
    for rel, items in by_file.items():
        path = os.path.join(ROOT, rel.replace("/", os.sep))
        if not os.path.exists(path):
            continue
        text, bom = read_text(path)
        lines = text.split("\n")
        # 先处理「整文件级」修复
        file_flags = {code for _, _, code, _ in items}
        if "TS2345" in file_flags and any("never" in m for _, _, c, m in items if c == "TS2345"):
            new_lines = []
            for ln_text in lines:
                if re.search(r"(const|let|var)\s+[\w$]+\s*=\s*\[\];\s*$", ln_text):
                    ln_text = re.sub(r"=\s*\[\];\s*$", "= [] as LegacyBoundary[];", ln_text)
                    fixed += 1
                    kinds["TS2345/never[]"] += 1
                new_lines.append(ln_text)
            lines = new_lines
        if "TS18046" in file_flags:
            for i, ln_text in enumerate(lines):
                m = re.search(r"catch\s*\(\s*(\w+)\s*\)", ln_text)
                if m:
                    name = m.group(1)
                    if any(c == "TS18046" and mn.startswith(f"'{name}'") for _, _, c, mn in items):
                        lines[i] = ln_text.replace(m.group(0), f"catch ({name}: LegacyBoundary)")
                        fixed += 1
                        kinds["TS18046/catch"] += 1

        # 再处理「定位级」修复：按行列倒序，避免位移影响
        positional = [(ln, col, code, msg) for ln, col, code, msg in items if code in ("TS7006", "TS7034", "TS7005")]
        seen: set[tuple[int, int]] = set()
        for ln, col, code, msg in sorted(positional, key=lambda x: (x[0], x[1]), reverse=True):
            if (ln, col) in seen:
                continue
            seen.add((ln, col))
            idx = ln - 1
            if idx < 0 or idx >= len(lines):
                continue
            line = lines[idx]
            if code == "TS7006":
                m = re.search(r"Parameter '([^']+)' implicitly", msg)
                if not m:
                    continue
                pname = m.group(1)
                # 定位参数标识符（col 为 1-based）
                pos = col - 1
                seg = line[pos:]
                idm = re.match(r"([\w$]+)", seg)
                if not idm:
                    # col 可能指向 `.` 之类的边界，向前寻找最近的标识符
                    seg_left = line[:pos]
                    idm_l = re.search(r"([\w$]+)\s*$", seg_left)
                    if not idm_l:
                        continue
                    insert_at = idm_l.end()
                    line = line[:insert_at] + f": {pick_type(pname)}" + line[insert_at:]
                else:
                    insert_at = pos + idm.end()
                    line = line[:insert_at] + f": {pick_type(pname)}" + line[insert_at:]
                lines[idx] = line
                fixed += 1
                kinds[f"TS7006/{pick_type(pname)}"] += 1
            else:  # TS7034 / TS7005
                m = re.search(r"Variable '([^']+)' implicitly has (?:type )?'([^']+)'", msg)
                if not m:
                    continue
                vname, vtype = m.group(1), m.group(2)
                decl = re.search(rf"\b(let|var|const)\s+{re.escape(vname)}\b(?!\s*:)", line)
                if not decl:
                    continue
                insert_at = decl.end()
                lines[idx] = line[:insert_at] + f": {vtype}" + line[insert_at:]
                fixed += 1
                kinds[f"{code}/{vtype}"] += 1

        write_text(path, "\n".join(lines), bom)
    return fixed, kinds


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--rounds", type=int, default=6)
    args = ap.parse_args()

    total_stats: Counter = Counter()
    for rnd in range(1, args.rounds + 1):
        errs = run_tsc(args.config)
        codes = Counter(e[3] for e in errs)
        print(f"[round {rnd}] errors={len(errs)}  codes={dict(codes.most_common(8))}")
        if not errs:
            print("✅ 已无错误")
            break
        fixed, kinds = apply_fixes(errs)
        if fixed == 0:
            print(f"⚠️ 无可自动修复项，剩余 {len(errs)} 个错误需人工处理")
            break
        total_stats.update(kinds)
        print(f"[round {rnd}] auto-fixed={fixed}")
        print(json.dumps(dict(kinds.most_common(12)), ensure_ascii=False, indent=1))
    print("累计自动修复：", dict(total_stats.most_common(20)))
    final = run_tsc(args.config)
    print(f"最终剩余错误：{len(final)}")
    Counter(e[3] for e in final).most_common(10) and print("按码：", dict(Counter(e[3] for e in final).most_common(10)))
    with open(os.path.join(ROOT, "tests", "_codemod_final.json"), "w", encoding="utf-8") as f:
        json.dump({
            "fixed": dict(total_stats),
            "remaining": len(final),
            "remainingByCode": dict(Counter(e[3] for e in final)),
            "remainingDetail": [f"{e[0]}({e[1]},{e[2]}) {e[3]}: {e[4]}" for e in final[:200]],
        }, f, ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
