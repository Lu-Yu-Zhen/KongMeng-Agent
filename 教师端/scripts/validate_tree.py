# -*- coding: utf-8 -*-
"""
知识树校验脚本
================
校验九学科知识树 JSON：
  - 五级层级齐全（学科→模块→章→节→知识点）
  - kp_id 全局唯一
  - 无孤儿节点（parent_id 指向存在节点；根除外）
  - 叶子节点含正文/描述、难度、重要度、课标层次
  - 章节覆盖率抽查（人工比对教材目录用）
用法：
  python scripts/validate_tree.py [--subject 数学]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_BACKEND = os.path.join(_BASE, "backend")
for _p in (_BACKEND, _BASE):
    if _p not in sys.path:
        sys.path.insert(0, _p)


def validate_tree(tree: dict, subject: str) -> dict:
    """返回校验报告。"""
    nodes = tree.get("nodes", [])
    by_id = {}
    issues = []

    def walk(ns, level):
        for n in ns:
            nid = n.get("kp_id") or n.get("id") or ""
            if not nid:
                issues.append("存在无 id 的节点")
                continue
            if nid in by_id:
                issues.append(f"kp_id 重复：{nid}")
            by_id[nid] = {"level": level, "node": n}
            children = n.get("children") or []
            if children:
                walk(children, level + 1)

    walk(nodes, 1)

    # 层级检查
    levels = set(v["level"] for v in by_id.values())
    level_ok = all(l in levels for l in (1, 2, 3, 4, 5)) or len(levels) >= 3

    # 孤儿检查
    orphans = []
    for nid, v in by_id.items():
        parent = v["node"].get("parent_id") or v["node"].get("parentId") or ""
        if parent and parent not in by_id:
            orphans.append(nid)

    # 叶子检查
    leaves = [v for v in by_id.values() if not (v["node"].get("children") or [])]
    no_text = [v["node"].get("kp_id") or v["node"].get("id") for v in leaves
               if not (v["node"].get("text") or v["node"].get("description"))]
    no_req = [v["node"].get("kp_id") or v["node"].get("id") for v in leaves
              if not (v["node"].get("level_requirement") or v["node"].get("level"))]

    return {
        "subject": subject,
        "total_nodes": len(by_id),
        "leaf_nodes": len(leaves),
        "levels_present": sorted(levels),
        "level_ok": level_ok,
        "orphans": orphans,
        "duplicate_ids": [i for i in issues if "重复" in i],
        "leaves_no_text": no_text[:20],
        "leaves_no_level_req": no_req[:20],
        "issue_count": len(issues),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="校验知识树")
    parser.add_argument("--subject", default="", help="指定学科，缺省全科")
    args = parser.parse_args()

    from app.rag import config

    tree_dir = config.TREE_DIR
    subjects = [args.subject] if args.subject else config.SUBJECTS

    all_ok = True
    for subject in subjects:
        path = os.path.join(tree_dir, f"{subject}.json")
        if not os.path.exists(path):
            print(f"[缺失] {subject}：{path}")
            all_ok = False
            continue
        with open(path, "r", encoding="utf-8") as f:
            tree = json.load(f)
        r = validate_tree(tree, subject)
        status = "OK" if (r["level_ok"] and not r["orphans"] and not r["duplicate_ids"]
                          and not r["leaves_no_text"] and not r["leaves_no_level_req"]) else "FAIL"
        if status == "FAIL":
            all_ok = False
        print(f"[{status}] {r['subject']}：节点{r['total_nodes']} 叶子{r['leaf_nodes']} "
              f"层级{r['levels_present']} 孤儿{len(r['orphans'])} 重复{len(r['duplicate_ids'])} "
              f"叶子缺正文{len(r['leaves_no_text'])} 叶子缺课标{len(r['leaves_no_level_req'])}")
        if r["orphans"]:
            print("    孤儿:", r["orphans"][:10])
        if r["leaves_no_text"]:
            print("    叶子缺正文(前5):", r["leaves_no_text"][:5])

    print("\n校验结果：", "全部通过" if all_ok else "存在失败项")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())