# -*- coding: utf-8 -*-
"""
模型导出脚本（sentence-transformers → ONNX + int8 量化）
==========================================================
将 HuggingFace 模型导出为 ONNX 并可选 int8 量化，产出部署所需：
  {model_dir}/model.onnx
  {model_dir}/tokenizer.json
  {model_dir}/config.json
用法（需联网 + 已安装 transformers/optimum/onnxruntime）：
  python scripts/export_onnx.py --model bge-large-zh-v1.5 [--quantize]
注意：本脚本可在有网环境预执行，产物随离线包分发；桌面目标机无需运行本脚本。
"""
from __future__ import annotations

import argparse
import os
import sys

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_BACKEND = os.path.join(_BASE, "backend")
for _p in (_BACKEND, _BASE):
    if _p not in sys.path:
        sys.path.insert(0, _p)


HF_MODELS = {
    "bge-large-zh-v1.5": "BAAI/bge-large-zh-v1.5",
    "bge-base-zh-v1.5": "BAAI/bge-base-zh-v1.5",
    "bge-small-zh-v1.5": "BAAI/bge-small-zh-v1.5",
    "bge-reranker-v2-m3": "BAAI/bge-reranker-v2-m3",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="导出 ONNX 模型")
    parser.add_argument("--model", required=True, choices=list(HF_MODELS.keys()))
    parser.add_argument("--quantize", action="store_true", help="int8 量化")
    parser.add_argument("--out", default="", help="输出模型目录，缺省 rag_data/models/{model}")
    args = parser.parse_args()

    from app.rag import config

    out_dir = args.out or os.path.join(config.MODEL_DIR, args.model)
    os.makedirs(out_dir, exist_ok=True)
    hf_id = HF_MODELS[args.model]

    try:
        from transformers import AutoModel, AutoTokenizer
        from optimum.onnxruntime import ORTModelForFeatureExtraction
    except ImportError:
        print("需要安装：pip install transformers optimum onnxruntime")
        return 1

    print(f"加载 HF 模型 {hf_id} …")
    if "reranker" in args.model:
        # Cross-Encoder：用 AutoModelForSequenceClassification
        from transformers import AutoModelForSequenceClassification

        model = AutoModelForSequenceClassification.from_pretrained(hf_id, trust_remote_code=True)
        tok = AutoTokenizer.from_pretrained(hf_id)
        if args.quantize:
            from optimum.onnxruntime import ORTModelForSequenceClassification, ORTQuantizer

            m = ORTModelForSequenceClassification.from_pretrained(
                hf_id, export=True, trust_remote_code=True
            )
            m.save_pretrained(out_dir)
        else:
            model.save_pretrained(out_dir)
        tok.save_pretrained(out_dir)
    else:
        if args.quantize:
            m = ORTModelForFeatureExtraction.from_pretrained(hf_id, export=True, trust_remote_code=True)
            m.save_pretrained(out_dir)
        else:
            model = AutoModel.from_pretrained(hf_id, trust_remote_code=True)
            model.save_pretrained(out_dir)
            tok = AutoTokenizer.from_pretrained(hf_id)
            tok.save_pretrained(out_dir)

    print(f"导出完成：{out_dir}")
    print("提示：ONNX 模型/分词器/配置已就绪，可打包为离线安装包。")
    return 0


if __name__ == "__main__":
    sys.exit(main())