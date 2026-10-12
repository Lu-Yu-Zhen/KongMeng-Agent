# 04 分块与元数据 Schema

## 分块策略（`backend/app/rag/chunker.py`）

以**知识树叶子（知识点）为原子单元**分块，保证每一块语义完整、可溯源到具体知识点：

- **最小块**：单个知识点正文（`kp.text`）。
- **过长块**：基于段落贪心聚合，超过 `CHUNK_MAX_TOKENS`（默认 1024）时切分，相邻块保留 `CHUNK_OVERLAP_CHARS`（默认 80）字符重叠，避免截断语义。
- **块类型自动标注**（`_classify_chunk`）：
  - `definition`：概念/定义/性质/公式定理
  - `formula`：含公式、推导、证明
  - `example`：例题/变式/真题
  - `method`：方法/技巧/步骤/易错提醒
  - `exam_requirement`：课标/考纲/学业要求
- **语料文档**（`chunk_document`）：真题/资料类整文按段落聚合，整题不拆散（保证一题一例完整）。
- token 估算：中文按字、英文按词。

## 元数据 Schema（`schema.Chunk`）

每个分块携带完整结构化元数据（对齐课标五级 + 高考题型）：

| 字段 | 说明 | 来源 |
|---|---|---|
| `chunk_id` | 分块唯一 id | `{学科}-{kp_id}-{序号}` |
| `kp_id` | 归属知识点编码 | 知识树 |
| `subject / grade / book` | 学科/年级/册次 | 知识树 |
| `module / chapter / section` | 模块/章/节（课标五级主干） | 知识树 |
| `knowledge_point` | 知识点名 | 知识树叶子 |
| `chunk_type` | definition/formula/example/method/exam_requirement | 自动分类 |
| `difficulty / importance` | 难度/重要度 1~5 | 知识树标注 |
| `exam_type` | 关联高考题型 | 知识树标注 |
| `level` | 课标层次 了解/理解/掌握/应用 | 知识树 |
| `source / page / version` | 来源/页码/版本 | 知识树/语料 |
| `hash` | 内容指纹（断点续建用） | sha1(text) 前16位 |
| `text` | 分块正文 | — |

## 索引构建（`pipeline.build` + `scripts/build_index.py`）

流程：读取知识树 → 收集叶子 `text` → chunker 分块 → 与 `corpus` 语料分块合并 → **断点续建**（hash 未变则跳过 embedding）→ 向量化写入 sqlite-vec → 重建 BM25 → 写 `manifest.json`。

断点续建规则：
- `force=False`（默认）：已存在且 `hash` 未变的块跳过 embedding 重算，仅增量。
- `force=True`：全量重建。

产出：
- `rag_data/chunks/{学科}.jsonl`：分块落盘
- `rag_data/index/kb_vec.sqlite`：sqlite-vec 向量库（vec0 虚拟表）
- `rag_data/index/bm25_index.pkl`：BM25 倒排索引
- `rag_data/index/manifest.json`：版本/时间戳/维度/模型名/分科块数

`manifest.json` 示例：
```json
{
  "version": "1.0.0",
  "built_at": "2026-08-09T17:01:34",
  "dim": 1024,
  "embed_model": "bge-large-zh-v1.5",
  "rerank_model": "bge-reranker-v2-m3",
  "subjects": ["语文","数学", ...],
  "block_counts": {"语文": 96, "数学": 143, ...},
  "total_chunks": 1103
}
```

## 校验（`scripts/validate_tree.py`）

构建前先校验九科知识树：五级层级齐全、`kp_id` 全局唯一、无孤儿节点、叶子含正文/难度/重要度/课标层次。不合格则构建失败，防止脏数据入库。

## 用法

```bat
:: 校验知识树
python scripts\validate_tree.py
:: 构建全科索引（断点续建）
python scripts\build_index.py
:: 强制全量重建
python scripts\build_index.py --force
```