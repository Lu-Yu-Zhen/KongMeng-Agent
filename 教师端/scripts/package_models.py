# -*- coding: utf-8 -*-
"""
模型离线包打包脚本
====================
将 rag_data/models 下的模型目录打包为离线安装包（zip + SHA256 校验和），
供 Electron 目标机离线分发。打包时记录 manifest（模型名/维度/文件大小/校验和）。
产物：rag_data/models-pack/rag-models-{version}.zip + .sha256
用法：
  python scripts/package_models.py [--version 1.0.0] [--out DIR]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import zipfile

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_BACKEND = os.path.join(_BASE, "backend")
for _p in (_BACKEND, _BASE):
    if _p not in sys.path:
        sys.path.insert(0, _p)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="打模型离线包")
    parser.add_argument("--version", default="1.0.0")
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    from app.rag import config

    models_dir = config.MODEL_DIR
    if not os.path.isdir(models_dir):
        print(f"无模型目录：{models_dir}，请先运行 export_onnx.py 或放置模型。")
        return 1
    model_names = [
        d for d in sorted(os.listdir(models_dir))
        if os.path.isdir(os.path.join(models_dir, d)) and os.path.exists(os.path.join(models_dir, d, "model.onnx"))
    ]
    if not model_names:
        print(f"未找到含 model.onnx 的模型目录：{models_dir}")
        return 1

    out_dir = args.out or os.path.join(config.DATA_ROOT, "models-pack")
    os.makedirs(out_dir, exist_ok=True)
    zip_path = os.path.join(out_dir, f"rag-models-{args.version}.zip")

    entries = []
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in model_names:
            root = os.path.join(models_dir, name)
            for cur, _dirs, files in os.walk(root):
                for fn in files:
                    full = os.path.join(cur, fn)
                    arc = os.path.relpath(full, models_dir)
                    zf.write(full, arc)
    sha = sha256_file(zip_path)

    manifest = {
        "version": args.version,
        "models": model_names,
        "zip": os.path.basename(zip_path),
        "sha256": sha,
        "size_bytes": os.path.getsize(zip_path),
    }
    manifest_path = zip_path + ".json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    with open(zip_path + ".sha256", "w", encoding="utf-8") as f:
        f.write(sha + "  " + os.path.basename(zip_path) + "\n")

    print("=== 模型离线包 ===")
    print(f"模型：{model_names}")
    print(f"包：{zip_path}（{manifest['size_bytes']/1024/1024:.1f} MB）")
    print(f"SHA256：{sha}")
    print(f"manifest：{manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())