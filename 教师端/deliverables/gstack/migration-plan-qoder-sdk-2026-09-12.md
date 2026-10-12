# 孔孟智能体 × Qoder Agent SDK 迁移改造方案
## ——三大板块深耕（学生提问 / 题目批改 / 学生学情分析）与数据共享机制设计

**日期**：2026-09-12
**场景**：全流程交付（现状调查 → 产品设计 → 架构迁移 → 安全合规 → 质量发布）
**参与成员**：产品官（gstack-product-reviewer）＋ 调查员（gstack-investigator）＋ 安全卫士（gstack-security-officer）＋ 质量门神（gstack-qa-lead），主理人汇编
**参考文档**：Qoder Agent SDK 官方文档 https://docs.qoder.com/zh/cli/sdk/overview （overview / quick-start / how-it-works / tools / permissions / system-prompt 等子页均已核实）

---

## 📌 TL;DR（执行摘要）

- 整体结论：**🟡 有条件通过**。迁移路线成立且收益明确，但有 3 个阻塞项必须先落闸门：学生数据出域合规、渲染进程明文 Key 双轨泄漏、渲染层隔离关闭（contextIsolation:false）。
- 核心路线一句话：**Python SDK 单点集成进 FastAPI 后端**，用 `query()` 原生工具调用 / 权限体系 / 持久会话替换三套自研编排，RAG 与文档导出原地保留并封装为进程内 MCP 工具，PAT 走首启引导＋DPAPI 加密存储，四期渐进（P0→P4）每期可回滚。
- 三板块定位升级：学生提问＝「教师讲解助手」（三段式讲解稿＋深度自适应）、题目批改＝「逐题结构化批改＋教师复核」、学情分析＝「事件驱动实时画像」；三板块通过**学情数据总线（8 张表＋事件溯源＋单写者）**实现数据共享。
- 下一步：立即启动 P0（约 1 周）：backend 接入 `qoder-agent-sdk` 打通 `query()` 基线 + PAT 首启引导 + 数据出域脱敏网关，灰度开关并行保留旧链路。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| Go / No-Go | 🟡 条件 Go —— P0 安全闸门（脱敏网关＋PAT 化＋权限白名单）完成后方可进入 P1 |
| 严重度分布 | 🔴 3 ／ 🟠 5 ／ 🟡 3 ／ 🟢 1（详见 §2，含成员交叉评审补充项） |
| 关键行动项 | 10 条（详见 §✅ 行动清单） |
| 建议负责人 | 后端负责人（P0–P2 主体）／教研负责人（评测集与标注）／安全负责人（合规闸门）／QA（灰度与质量门） |
| 工期估算 | P0 1 周 → P1 2–3 周 → P2 2–3 周 → P3 3–4 周 → P4 1–2 周；每期结束应用整体可用 |

---

## 1. 各成员核心结论

### 🔍 产品官（三大板块功能与交互）
三板块均基于现有技能包升级而非重写：学生提问从「面向学生直接作答」重定位为「给教师的讲解助手」（标准解法／讲解话术／易错提醒三段式，基础/中等/拔尖三档深度一键切换）；题目批改主打逐题结构化批改＋教师逐题复核修正这一关键质检点，算分收敛到确定性工具不靠模型心算；学情分析由「整卷触发全量分析」改为批改/提问事件实时增量更新画像。三板块形成至少 3 条联动闭环（批改错因→画像→讲解深度自适应；提问频次→薄弱点证据链；学情→加严检查与分层推题）。明确 Not-Do：不做学生端直连答疑机器人、不替代正式网上阅卷、不自动发布成绩、不存学生真实姓名出域。

### 🔧 调查员（现状分析与迁移架构）
现状存在三套自研编排并存（后端 LangGraph／前端 langgraph-workflow.js／前端 ReAct 兜底），核心缺陷是**文本协议模拟 function calling、无权限分级、会话不可持久、记忆三处分裂、模型 Key 明文存 localStorage、MCP 工具大面积 mock**。选型结论：**Python SDK 单点集成进 FastAPI 后端**（Agent 重资产全在 Python、PAT 只需后端一处注入、复用已有解释器探测＋pip 基建、避免 Electron 第二运行时）。四期路线 P0 基线接入→P1 链路替换→P2 工具与记忆统一→P3 三板块深耕→P4 清理收敛，每期以开关回滚。Docker 沙箱在桌面部署默认缺席，退役后由 qodercli 本地执行＋权限收紧替代。

### 🛡️ 安全卫士（数据共享安全与合规）
最大风险是**学生（未成年人）学习数据出域至 Qoder 云端**（PIPL §28/§31 敏感个人信息），缓解优先级：校内私有化端点＞强制脱敏网关＞DPA 约定＞本地小模型兜底。设计了 L1 直接标识符／L2 学习行为／L3 聚合统计三级数据分级、板块×数据域访问控制矩阵（提问/批改板块禁读学生档案与成绩，画像单写者＝学情 Agent）、audit_log 哈希链审计，并将全部控制点映射到 SDK 机制（allowedTools 白名单按板块收窄、canUseTool 参数级校验、MCP tool policy、PreToolUse 审计）。P0 前置：分级字段＋脱敏网关＋审计表三项基础设施。

### ✅ 质量门神（验收、测试与发布）
三板块量化验收：答疑正确率≥90% 且幻觉率≤5%、批改分数一致率≥90% 且错因分类准确率≥85%、学情统计口径正确性 100%（零容错）。四层测试（工具单测／SDK 集成／10 条教师 E2E 场景／复用 450 条 RAG 评测集＋45 条负例守门），质量门升级为结构化 Schema 校验器（分数边界、错因枚举、citation 防幻觉硬门）。发布：TS 路线已否决故打包无第二运行时问题；PAT 首启引导→Windows 凭据管理器/DPAPI→子进程环境变量注入；三阶段灰度带晋级门槛与回退触发线；旧 workflow.py 链路保留为「引擎切换」开关，双包并行可 48h 内回滚。

---

## 2. 综合审查发现（去重合并，按严重度排序）

| # | 严重度 | 类别 | 位置 | 问题描述 | 建议 | 来源 |
|---|--------|------|------|---------|------|------|
| 1 | 🔴 | 合规 | 全局 | 学生学习数据（提问/作答/画像）默认随任务上下文出域至 Qoder 模型服务，未成年人敏感个人信息未经脱敏与同意管控 | 出域统一经脱敏网关（伪 ID＋L1 拦截）；推进私有化端点/校内网关；签 DPA；断网/失败本地兜底 | 安全卫士 |
| 2 | 🔴 | 安全 | index.html L1240-1287 | 10 家模型 API Key 明文硬编码与 localStorage 缓存，渲染进程直连厂商 API——**双轨数据泄漏：浏览器直连与 Qoder 出域是两条均无缓解的出境路径** | 全量废弃，收敛为单一 PAT＋DPAPI 加密；渲染进程零 Key；LLM 调用统一经后端转发 | 调查员＋安全卫士 |
| 3 | 🔴 | 安全 | electron/main.js L62-69 | 渲染进程 `contextIsolation:false`＋`sandbox:false`：一旦 XSS 即可沿 IPC 通道触达后端 SQLite（agent.db/sandbox.db）与 localStorage 三处存储，数据外带链路成立 | 启用 contextIsolation＋preload 最小桥＋`sandbox:true`；IPC 通道按三板块白名单收窄——定为 **P0 第 0 项** | 安全卫士（交叉评审） |
| 4 | 🟠 | 架构 | agent-core.js L20-121 | 无原生工具调用协议：提示词约定 JSON＋四层容错解析模拟 function calling，工具 Schema 仅拼文本未下发 | SDK query() 原生 tool_use 消息与带 Schema 的 MCP 工具整体替换 | 调查员 |
| 5 | 🟠 | 架构 | agent-core.js L158-164 / index.html | 会话不可持久：内存数组存历史，换会话/换机即丢；后端 sessions 表未接入恢复 | SDK 持久会话 resume/fork/checkpoint | 调查员 |
| 6 | 🟠 | 安全 | 全局 | 工具执行无权限分级与审批，Agent 生成文档写入位置不受控 | allowedTools＋permissionMode＋canUseTool＋MCP tool policy＋hooks 审计 | 调查员＋安全卫士 |
| 7 | 🟠 | 功能 | mcp-client.js L135-189 | MCP 教学工具大面积 mock（教材检索返回占位文本、题库恒空），学情数据读取名存实亡 | 真实实现为进程内 MCP server（Python 后端承载） | 调查员 |
| 8 | 🟠 | 架构 | memory-system.js / backend db / memory-store.json | 记忆三处分裂、非结构化、无向量检索、多机不同步；**数据分散＝无单一事实源、无一致分级与加密水位** | 应用接管记忆：SQLite 结构化统一存储＋sensitivity 分级，localStorage 不得存 L2＋数据；MCP 工具读写 | 调查员＋安全卫士 |
| 9 | 🟠 | 质量 | workflow.py 质量门 | 现有加权评分门无法约束三板块的结构化输出（分数越界/错因枚举/引用真实性） | 升级分板块 JSON Schema 校验器＋citation 防幻觉硬门 | 质量门神 |
| 10 | 🟡 | 架构 | teacher-agent-sandbox/sandbox | Docker 沙箱（8000/8001）桌面部署缺席，文档生成离线不可用，依赖 CDN Pyodide | 退役沙箱：exporter 封装为 MCP 工具本地执行 | 调查员 |
| 11 | 🟡 | 架构 | 前端 JS vs 后端 Python | 意图路由/追问/编排双栈重复实现，行为不一致维护翻倍 | 收敛 Python 单点，前端 langgraph-workflow.js P4 退役 | 调查员 |
| 12 | 🟡 | 合规 | backend db | 学生数据明文落库、保留期无限、无审计日志 | sensitivity 分级字段＋分级保留期（原始 1 学期/统计 3 年）＋audit_log 哈希链 | 安全卫士 |
| 13 | 🟢 | 发布 | electron-builder | qodercli 二进制需 asarUnpack 排除，杀软误报风险待实测 | P0 冒烟验证双打包目标 | 质量门神 |

---

## 3. 迁移整体方案

### 3.1 现状架构关键事实（调查员代码实证）

```
UI 层  index.html（6000+ 行单文件，五板块页面＋callAIStream 直连 10 家模型 API）
        ＋ teacher-agent-sandbox/js/*（agent-core、langgraph-workflow、skills-engine、
          tool-registry、memory-system、mcp-client）
主进程  electron/main.js → 拉起 backend/server.py(127.0.0.1:8767)，随机 Token 注入
自研编排 三套并存：①workflow.py LangGraph ②前端 langgraph-workflow.js ③agent-core ReAct 兜底
后端    FastAPI：api.py(REST+SSE)→task_queue(线程池)→router→workflow.py；db/memory/security/exporter
RAG     rag/（chunker→sqlite-vec+BM25→hybrid+reranker），450 条评测集 Recall@5=0.970
沙箱    Docker(8000/8001) 文档生成——桌面部署默认缺席
```

三大板块调用链实证：**学生提问**（index.html `sendSqFollowup`→渲染进程直连模型 API→仅写 localStorage 洞察，**完全不经过后端**、无工具、无持久化）；**题目批改**（直连模型＋提示词批改，报告生成依赖缺席的沙箱）；**Agent 备课**（唯一走后端 8767 的链路）。

### 3.2 三大板块现状能力缺陷（对照 Qoder SDK，11 条精简）

1. 文本协议模拟工具调用（无原生 tool_use）——三板块全部受累
2. 无权限分级与审批（写位置不受控）
3. 会话不可持久/不可恢复（内存态）
4. 记忆非结构化且三处分裂（localStorage/SQLite/JSON 文件）
5. 模型管理硬编码 10 家＋Key 明文（SDK 仅需 1 个 PAT）
6. MCP 教学工具大面积 mock（学情数据读取缺失）
7. Skills 无子 Agent/无渐进上下文（单上下文单技能，无法并行隔离）
8. 无统一流式内容回传（后端 SSE 仅推进度，前端手写解析）
9. 沙箱链路脆弱（桌面缺席，离线文档生成不可用）
10. 双语言栈重复实现（JS/Python 各一遍）
11. 批改/学情支持图片但仅走 Chat 通道，Agent 链路无图片输入（SDK 原生支持）

### 3.3 SDK 语言选型：Python SDK 单点集成（结论已定）

| 候选 | 结论 | 理由 |
|------|------|------|
| **Python SDK（backend 集成）** | ✅ 采用 | Agent 重资产（workflow.py 提示词/校验器/质量门、RAG 全链路、SQLite 记忆与任务队列、exporter）全在 Python，原地承接；PAT 只需后端进程一处注入；main.js 已有解释器探测＋自动 pip 基建顺路复用；避免 Electron 打包 node_modules＋qodercli 第二运行时 |
| TypeScript SDK（Electron main） | ❌ 否决 | 需跨进程重写 Python 资产或桥接；打包体积＋100–200MB；PAT 暴露面扩大；形成第二运行时 |
| 混合 | ❌ 否决 | 三板块所需进程内 MCP 工具全部可由 Python 进程承载，无必要 |

集成形态：Electron 保持「壳＋IPC＋文档管理」；backend 新增 agent 模块封装 `query()` 多轮会话（`QoderSDKClient`），`stream_event` 映射为现有 SSE 推送前端。

### 3.4 新旧组件映射表

| 现有组件 | Qoder SDK 方案 |
|---|---|
| skills-engine.js ＋ SKILL.md 技能包 | SDK Skills 目录渐进加载；三大板块技能包（讲解题/题目批改/学生学情分析）及 references/assets 整体保留迁移 |
| agent-core ReAct ＋ langgraph-workflow.js ＋ workflow.py 编排 | `query()` 多轮会话＋systemPrompt 完全替换；PRODUCERS 提示词/校验器转为 Skill 定义＋后处理校验 |
| tool-registry.js | Python 进程内 MCP server：`gen_word/gen_ppt/gen_excel/gen_pdf`（包 exporter）、`kb_retrieve`（包 rag.hybrid）、`memory_read/write`（包 db）、`web_search`、`kongmeng-data` 学情六工具（见 §5） |
| mcp-client.js mock 教学工具 | 退役；真实实现即上述进程内工具 |
| memory-system.js localStorage ＋ SQLite memories | 应用接管记忆：SQLite 结构化统一存储，MCP 工具读写＋systemPrompt 注入 |
| Docker sandbox（8000/8001） | 退役；qodercli 本地执行＋权限收紧（写入限「备课产物/」目录，deny 优先） |
| task_queue ＋ SSE | 保留 HTTP 任务外壳；SDK stream_event→SSE 事件 |
| 模型管理页（多 Key＋DPAPI 加密） | PAT 单一配置（沿用 security.py DPAPI 存储） |
| RAG（kb.py＋rag/*） | 保留独立服务，封装 `kb_retrieve` 工具供 Agent 调用 |
| exporter.py 落盘 | 保留，作为工具 handler 后端 |

### 3.5 PAT 分发与桌面场景策略

- **短中期（起步）**：首启引导——设置页输入 PAT → security.py DPAPI 加密存 SQLite（现成基建）→ 每次启动后端将 token 注入子进程环境变量 `QODER_PERSONAL_ACCESS_TOKEN`；不落明文、不进日志（fsLog 过滤）、不进渲染进程。
- **规模化演进**：学校/区域企业网关——PAT 只存校内服务器，后端经网关代理，教师机零 token。
- **辅助选项**：教研组统一环境变量脚本/MDM 下发；永不将 PAT 打包进安装包。

### 3.6 分期改造路线图（每期结束应用整体可用）

| 期 | 目标 | 主要改动 | 风险与回滚 |
|---|---|---|---|
| **P0 基线接入（约 1 周）** | query() 打通＋安全闸门 | **第 0 项：渲染层隔离修复（contextIsolation＋preload 最小桥＋sandbox:true，IPC 三板块白名单收窄）；渲染 Key 下线，Chat/提问/批改 LLM 调用统一经后端转发**；backend 新增 `/api/agent/query`；PAT 首启引导＋DPAPI 存储；`AGENT_USE_QODER` 灰度开关；**脱敏网关＋sensitivity/audit_log 表**（安全前置） | qodercli 杀软误报/首次下载；开关关闭即回旧链路 |
| **P1 Agent 链路替换（2–3 周）** | 编排收口 | systemPrompt 完全替换承担备课编排；canUseTool 写审批；PRODUCERS→Skill；stream_event→SSE 流式上屏 | `/api/workflow/run` 原样保留可切回 |
| **P2 工具与记忆统一（2–3 周）** | 工具真实化 | 进程内 MCP server（文档生成/记忆/RAG/搜索/kongmeng-data）；allowedTools＋tool policy 分级；记忆 localStorage→SQLite 一次性导入 | MCP 工具注册开关逐个放行 |
| **P3 三板块深耕（3–4 周）** | 板块升级 | 提问：resume＋拍照图片输入＋深度自适应；批改：子 Agent＋Schema 校验＋确定性算分；学情：事件驱动画像＋会商模式 | 依赖 P2 工具就绪；按板块独立灰度 |
| **P4 清理收敛（1–2 周）** | 退役旧件 | 退役 langgraph-workflow.js/ReAct/mcp-client mock/Docker 沙箱；模型管理页改 PAT 配置 | 双包并行安装目录，48h 内可回滚 |

### 3.7 保留 / 替换 / 废弃清单

| 保留 | 替换 | 废弃 |
|---|---|---|
| Electron 壳＋IPC 文档管理 | agent-core ReAct → query() 原生 tool_use | callAIStream 三分支协议适配＋明文 Key localStorage |
| workflow.py 提示词/校验器/质量门（转 Skill） | skills-engine 关键词路由 → SDK Skills＋子 Agent | mcp-client.js 全部 mock 教学工具 |
| backend RAG 全链路（封装 MCP 工具） | memory-system localStorage → SQLite 应用接管记忆 | Docker sandbox 8000/8001（打包场景） |
| security.py DPAPI 基建（改存 PAT） | task_queue 裸线程 → SDK 会话＋stream_event＋SSE 薄壳 | 前端 langgraph-workflow.js / sub-workflows.js |
| exporter 落盘＋「备课产物」目录约定 | 模型管理页（多 Key）→ PAT 单一配置 | parseJSON 四层容错文本协议解析 |
| 前端五板块 UI 与交互 | 内存态会话 → SDK resume/checkpoint 持久化 | backend-client 旧 /api/workflow/* 端点（P4 后） |

---

## 4. 三大板块功能范围与交互流程

### 4.0 SDK 能力映射总纲

- **systemPrompt（完全替换）**：system-prompt.md 改写为「教师端三板块」身份＋行为准则（不超纲、去标识化、澄清机制、宁可长不可空的质量观）；完全替换后同步收紧权限（官方要求）。
- **Skills 按名调用**：三个技能包结构整体保留，SKILL.md 描述改写为教师端场景，references 渐进加载。
- **进程内 MCP 工具**：统一 server `kongmeng-data`（学情六工具，见 §5）＋文档生成/检索/搜索工具。
- **canUseTool 审批**：所有写库、落盘导出需教师确认；只读查询自动放行。
- **子 Agent（options.agents）**：批改、学情重计算用独立上下文子 Agent，防长文档污染主会话。
- **图片输入**：学生作答/提问拍照直传；**持久会话 resume/fork**：跨天续聊、会商推演 fork 副本。

### 4.1 板块一：学生提问（教师答疑助手）

**P0 功能**：① 教师转发学生问题（文字/拍照），Agent 自动识别学科并调 knowledge-qa skill；② 产出「讲解参考稿」三段式：标准解法（分步＋得分点）/ 讲解话术与板书建议 / 易错提醒；③ 按学生层次输出三档讲解深度（基础/中等/拔尖），一键切换；④ 教师编辑后生成可发学生的「讲解卡」。
**升级点**：现 skill 面向学生直接作答 → 重定位为「给教师的讲解助手」，新增讲解话术与深度分级（落实原 skill「因材施教」原则）。
**P1**：结合学情自动选深度；自动附送同类高考真题。**P2**：课中实时投影简洁模式。
**Not-Do**：不做学生端直连答疑机器人；不做自动推送。
**交互流程（人机分工）**：答疑面板入口【人】→ 粘贴/拍照【人】→ query() 识别科目→skill 解答【机】→ 教师确认/改深度/编辑【人】→ 导出讲解卡（canUseTool 审批）＋ save_qa_record 留存（学科/知识点/深度/时间）【机＋人审】。

### 4.2 板块二：题目批改

**P0 功能**：① 输入题目＋标准答案＋分值（缺标准答案时 Agent 先拟评分细则供教师确认，沿用选择题式澄清机制）；② 学生作答拍照（图片输入）；③ 按题型逐点批改：客观题比对、主观题分步给分、作文分维度，沿用现有五类错误标注（知识/方法/计算/格式/审题）；④ 教师逐题可改分、改错因；⑤ 生成批改报告（复用 assets 模板）落盘。
**升级点**：grade_homework.py 计算逻辑封装为 MCP 工具 score_calculator——算分确定性不靠模型心算；批改规范与评分标准.md、评语模板库.md 保留为 skill references。
**P1**：全班同题批量批改＋共性问题聚合；作文批改增强。**P2**：手写识别结果可视化复核、学生错题本自动归集。
**Not-Do**：不替代正式网上阅卷系统；不自动向学生发布成绩。
**交互流程**：批改入口【人】→ 题目/答案/标准上传，缺项 Agent 选择题追问【机】→ 子 Agent 逐题批改（隔离上下文）【机】→ 逐题结果表（得分/扣分点/错误类型）→ **教师逐题复核修正【人，关键质检点】**→ 确认后 score_calculator 汇总、报告落盘、save_grade 写入错因（canUseTool 审批）【机＋人审】。

### 4.3 板块三：学生学情分析

**P0 功能**：① 三类数据源统一入库：批改记录、提问记录、成绩单导入（Excel/JSON）；② 个体画像（沿用现有六维框架：成绩/知识/能力/题型/趋势/分层，掌握率五级标准：优秀≥85%/良好70–84%/一般60–69%/薄弱40–59%/盲区<40%）与班级画像；③ 教学建议按四原则生成（针对性/可操作/分层/发展）；④ 报告落盘（Markdown/HTML 模板复用）。
**升级点**：analyze_student.py 封装为 profile_stats/query_profile MCP 工具，**Agent 只解读数据不手算**，杜绝计算幻觉；由「整卷触发全量分析」改为批改/提问事件实时增量更新画像。
**P1**：考前学情会商模式（一键输出薄弱知识点清单＋分层名单＋考点对策）。**P2**：成绩趋势预警、家校沟通简报。
**Not-Do**：不存储学生真实姓名等敏感数据出域（沿用 RULES 去标识化）；不做跨校外传。
**交互流程**：学情面板【人】→ 成绩批量导入/增量数据自动到达【人/机】→ profile_stats 计算【机】→ Agent 生成画像与建议【机】→ 教师审阅修正、标注采纳项【人】→ 报告落盘留存【机＋人审】。

### 4.4 三板块联动闭环

1. **批改→学情→答疑（讲解深度自适应）**：教师确认批改后错因实时入画像；下次该生同知识点提问时 query_profile 返回掌握率，讲解稿自动定深度（如「导数应用」掌握率<40% 则从教材定义讲起）。
2. **提问→学情（薄弱点证据链）**：save_qa_record 的知识点自动累计提问频次，作为薄弱证据进入会商报告，与批改错因交叉印证。
3. **学情→批改/推题（分层检查与作业）**：会商产出薄弱清单后，批改同知识点题目时 Agent 自动加严检查并重点标注；推题复用 exercise 子工作流生成分层作业。
4. **统一机制**：kongmeng-data 六工具＋持久会话上下文＋事件驱动增量更新，三板块共享同一画像数据源。

### 4.5 碎片化场景速写

- **课中 3 分钟**：拍照学生问题→深度自选→生成讲解卡投屏。
- **课后 10 分钟**：批量拍照作业→逐题快速确认（默认采纳 AI 判分，仅复核低置信项）。
- **考前 20 分钟**：一键会商→薄弱清单＋分层名单＋分层作业包。

---

## 5. 三板块与 Agent 数据共享机制（★核心设计）

> 本节为主理人基于产品官（工具与流程）、安全卫士（分级与矩阵）、调查员（存储与架构）三方产出的汇编设计。

### 5.1 设计原则

1. **单一数据源**：三板块共享同一「学情数据总线」（backend SQLite 新增 8 张表），杜绝现状三处记忆分裂。
2. **记录与画像分离**：板块只写「原始记录」，画像由学情 Agent 统一派生——任何板块不直接改画像。
3. **事件溯源**：跨板块更新一律通过事件表驱动，写路径可审计、可重放、可回滚。
4. **教师权威**：AI 产出均为「待确认」，教师确认才产生事件；教师修正永远覆盖 AI。
5. **隐私内建**：全链路以伪 ID 流转（L1 明文映射仅本地），分级字段随行，出域必经脱敏网关。

### 5.2 共享数据字段

**全局共享字段集**（三板块统一语义）：

| 字段 | 说明 | 级别 |
|---|---|---|
| `student_pseudo_id` | 学生伪 ID（如 P105），全总线主键；姓名/学号映射表仅本地保留 | L1 映射/L2 流转 |
| `class_id` / `grade` / `teacher_id` | 班级、年级、教师归属 | L1 |
| `subject` | 九科枚举 | L3 |
| `kp_id` | 知识点编码，**复用 RAG 九科知识树编码**（如 M1-C1-KP3），保证答疑/批改/学情同一口径 | L3 |
| `bloom_level` | 布鲁姆六层能力层级（识记/理解/应用/分析/综合/评价） | L3 |
| `error_type` | 五类错因枚举：知识/方法/计算/格式/审题（来自批改 skill） | L3 |
| `created_at / exam_date` | 时间戳（趋势分析必需） | L3 |
| `sensitivity` | 行级分级标记（L1/L2/L3），随行落库 | 治理字段 |

**数据表设计（backend SQLite，共 8 张）**：

| 表 | 关键字段 | 级别 | 写者 |
|---|---|---|---|
| `students` | student_pseudo_id PK, class_id, grade, created_at | L1 | 学情板块（导入） |
| `qa_records` | qa_id PK, student_pseudo_id, subject, kp_ids[], question_digest, depth, session_id, created_at | L2 | 提问 Agent（save_qa_record） |
| `grade_records` | grade_id PK, student_pseudo_id, question_id, subject, kp_id, score, full_score, error_type, comment, confidence, **teacher_confirmed**, created_at | L2 | 批改 Agent（save_grade，教师确认后） |
| `exam_scores` | exam_id, student_pseudo_id, subject, scores JSON, rank, exam_date | L2 | 学情板块（成绩导入） |
| `profile_events` | event_id PK（幂等键=板块＋记录ID）, event_type（qa_created/grade_confirmed/score_imported/**profile_corrected**）, ref_table, ref_id, payload_digest, status（pending/done/failed/dead）, retry_count, priority, created_at, consumed_at | 治理 | 三板块（生产）＋学情 Agent（消费） |
| `profiles` | (student_pseudo_id, subject, kp_id) 复合键, mastery, bloom_dim, question_type_stats, trend, evidence_ids[], tier, **version**, updated_at | L3 | **仅学情 Agent（单写者）** |
| `class_profiles` | class_id, subject, avg_score, weak_points[], tier_dist, version, updated_at | L3 | **仅学情 Agent（单写者）** |
| `audit_log` | id, who(teacher_id＋板块agent), when, tool_name, params_digest, data_level, outcome, **prev_hash**（哈希链防篡改） | 治理 | 写类工具 handler 自动落 |

**MCP 工具 × 表权限对应**（server 名 `kongmeng-data`）：

| 工具 | 读写 | 授权策略（MCP tool policy） | 可用板块 |
|---|---|---|---|
| `save_qa_record` | W：qa_records＋入队 qa_created | always_ask（讲解卡确认时写） | 提问 |
| `save_grade` | W：grade_records＋入队 grade_confirmed | always_ask（教师逐题复核后） | 批改 |
| `import_scores` | W：exam_scores＋入队 score_imported | always_ask | 学情 |
| `correct_profile` | W：入队 profile_corrected（高优先级） | always_ask | 学情 |
| `query_profile` | R：profiles（伪 ID 级） | always_allow | 提问/批改/学情 |
| `profile_stats` | R：聚合统计 | always_allow | 学情（批改联动只读） |
| `score_calculator` | 纯计算无状态 | always_allow | 批改 |

### 5.3 数据流向

```
【写路径】
提问板块 ──讲解卡确认──> save_qa_record ──> qa_records ＋ profile_events(qa_created)
批改板块 ──教师逐题复核──> save_grade ──> grade_records ＋ profile_events(grade_confirmed)
学情板块 ──成绩导入──> import_scores ──> exam_scores ＋ profile_events(score_imported)
教师修正 ────────> correct_profile ──> profile_events(profile_corrected, 高优先级)

【消费路径】（异步）
profile_events ──学情Agent 串行消费──> 确定性统计（analyze_student 逻辑）
              ──> 版本化更新 profiles / class_profiles（version+1, evidence_ids 回溯源记录）

【读路径】
提问板块 ──query_profile(student, kp)──> 讲解深度自适应
批改板块 ──query_profile(kp 掌握率)──> 同知识点加严检查/重点标注
学情板块 ──profile_stats 聚合──> 画像报告 / 考前会商
```

### 5.4 读写时序

| 时刻 | 动作 | 保证 |
|---|---|---|
| **T0 实时（同步事务）** | 板块写记录表＋入队事件（**同一 SQLite 事务**） | 「记录落库必留痕」——记录与事件原子一致 |
| **T1 准实时（异步）** | 学情 Agent 空闲时消费事件 → 增量重算受影响 (student, subject, kp) → profiles.version+1 | 秒级延迟；失败重试 3 次进 dead，教师端可见待办 |
| **T2 按需** | 报告/会商时 profile_stats 聚合读，不触发重算；报告标注「数据截至 version N / 时间 T」 | 报告内部自洽（快照语义） |
| **修正时序** | 教师修正事件 priority=high 插队，幂等重算 | 教师权威最终一致 |

**典型时序链（批改→学情→答疑闭环）**：
教师逐题确认 → T0 `save_grade`＋`grade_confirmed` 入队 → T1 学情 Agent 消费、更新「导数应用」掌握率 0.38 → 数日后该生提问相关题目 → T2 `query_profile` 返回掌握率<40% → 讲解稿自动从教材定义讲起（基础档）。

### 5.5 一致性处理（7 条机制）

1. **单写者原则**：`profiles/class_profiles` 仅学情 Agent 写；提问/批改板块无画像写工具（安全访问矩阵＋allowedTools 白名单双重 enforce）——从架构上消灭并发写冲突主源。
2. **事件溯源＋幂等**：`event_id` 唯一约束（板块＋记录 ID 天然幂等键）；消费可重放；事件失败重试 3 次 → dead 状态教师端可视，不静默丢弃。
3. **乐观锁**：`UPDATE profiles SET mastery=…, version=version+1 WHERE … AND version=?`；冲突则重读事件重算（SQLite WAL 模式下写锁天然串行，乐观锁兜底重放场景）。
4. **读一致性分级**：讲解深度/加严检查容忍秒级旧版本（读时携带 version 并在日志标注）；报告/会商以快照版本读，保证报告内数字自洽。
5. **教师权威覆盖**：`grade_records.teacher_confirmed=1` 才产生事件；AI 增量更新可被 `profile_corrected` 全量覆盖；所有画像更新携带 `evidence_ids` 可回溯到批改/提问记录（防幻觉篡改、可审计）。
6. **审计不可抵赖**：写类工具 handler 自动落 `audit_log`（哈希链 prev_hash）；PermissionDenied hook 同步告警。
7. **出域一致性**：事件 payload 只存 digest＋ref_id（明文留各记录表）；出域统一经脱敏网关（伪 ID＋L1 拦截＋L2 敏感词过滤），保证「本地全量、出域最小」。

### 5.6 与 Qoder SDK 机制的对应

| 数据共享需求 | SDK 承载机制 |
|---|---|
| 板块间数据隔离 | 每板块独立 Agent 会话＋独立 cwd；allowedTools 白名单仅挂该板块 MCP 工具集（批改 Agent 只见 `mcp__grading__*`，无档案读工具） |
| 参数级越权防护 | canUseTool 校验入参 student_pseudo_id 是否属该班级、剥离 L1 字段（updatedInput 改写入参）、跨域工具直接 deny |
| 写操作管控 | 写类工具 always_ask（教师确认）；档案类 always_deny；readOnlyHint/destructiveHint 全标注（不作为权限依据） |
| 审计 | PreToolUse hook 记录审计＋二次拦截（deny 优先）；PermissionDenied hook 告警 |
| 记忆注入最小必要 | `memory_read` 服务端裁剪：handler 签名携带 scope（板块）与 topic（当前知识点），提问/批改板块只返回伪 ID＋当前知识点摘要＋同学科近期洞察，**不注入全班画像**；裁剪在 handler 内实现，不依赖提示词约束 |
| 兜底 | settings.permissions.deny 静态规则＋defaultMode（禁 bypassPermissions，不设 allowDangerouslySkipPermissions） |

---

## 6. 安全与合规设计（摘要，威胁建模详见附录 C）

- **合规风险 Top5**：①学习数据出域 Qoder 云端（高，缓解见 §5.5-7 与行动项 2/10）；②无告知同意与最小必要控制（高，按板块会话裁剪记忆注入范围）；③敏感信息无分级落库（中，sensitivity 字段）；④保留期无限（中，原始 1 学期/统计 3 年/审计 1 年）；⑤XOR 弱混淆回退（低，仅涉 API Key）。
- **数据分级**：L1 直接标识符（禁止出域/禁进提示词，映射表学期末删）／L2 学习行为（本地可用，出域伪 ID＋过滤）／L3 聚合统计（可出域）。
- **STRIDE 摘要**：S 伪造教师身份→会话级教师凭证；T 诱导读全班画像→板块工具隔离＋脱敏网关＋prompt 注入测试（威胁链已更新为 XSS→IPC→三处存储，渲染隔离修复即 P0 第 0 项）；R 否认批改→审计哈希链＋教师确认回执；I 幻觉篡改掌握度→事件校验＋版本化＋evidence 可回溯；D 失控循环→单轮工具上限落到 SDK 侧＋canUseTool 限频＋本地兜底。

---

## 7. 验收标准、测试策略与发布方案（摘要，详见附录 D）

**验收指标（节选）**：答疑正确率≥90%（单科≥85%）、幻觉率≤5%、首字 P50≤2s；批改分数一致率≥90%（主观题±2 分带）、错因分类准确率≥85%、评语可用率≥85%；学情口径正确性 100% 零容错、覆盖完整率≥98%、建议采纳率≥60%。

**四层测试**：MCP 工具 handler 单测（覆盖率≥80%）→ SDK 集成测试（消息流断言，Mock 模式可离线跑 CI）→ 10 条教师 E2E 场景 → 复用 450 条 RAG 评测集＋45 条负例守门；评测标注教师三级参与（金标准出题→双人打标 Kappa<0.6 仲裁→每月 10% 对抗样本）。

**质量门升级**：现有「加权评分≥75＋≤3 轮重写」保留为通用层，三板块加装结构化 Schema 校验器（批改输出强制 JSON Schema：分数边界/错因枚举/评语≥20 字；答疑必须 citation 且在检索命中集合内防幻觉；学情数字由确定性代码计算后注入）。

**发布**：Python SDK 路线无第二运行时问题；PAT 首启引导→DPAPI→环境变量注入；三阶段灰度（单学科班级 2 周→3 学科 2–4 周→全校）带晋级门槛与回退触发线（幻觉率>8% 或错误率>5% 立即回退）；旧链路「引擎切换」开关＋双包并行安装目录，48h 内可回滚；上线后 usage 用量成本看板＋三板块指标周报。

---

## 8. 各板块改造要点与预期效果

| 板块 | 现状痛点 | 改造要点 | 预期效果（可量化） |
|---|---|---|---|
| **学生提问** | 渲染进程直连模型 API（明文 Key）、零工具零持久化、面向学生作答 | ①重定位教师讲解助手（三段式＋三档深度）②knowledge-qa skill 渐进加载 ③拍照图片输入 ④resume 持久会话 ⑤save_qa_record 留存＋query_profile 深度自适应 ⑥kb_retrieve 挂接 RAG | 正确率≥90%、幻觉率≤5%、首字 P50≤2s、多轮解决率≥80%；换机不丢历史；讲解深度因材施教 |
| **题目批改** | 提示词驱动批改、报告生成依赖缺席沙箱、输出无结构约束 | ①子 Agent 逐题批改（独立上下文）②批改 skill 规范保留 ③score_calculator 确定性算分 ④JSON Schema 强校验（分数/错因/评语）⑤教师逐题复核（canUseTool）⑥exporter 工具落盘报告 ⑦图片作答输入 | 分数一致率≥90%、错因分类准确率≥85%、评语可用率≥85%、客观题≤5s/主观题≤20s（P95）；离线可用 |
| **学情分析** | MCP 数据读取 mock 名存实亡、整卷静态分析、记忆分裂 | ①三类数据源统一入库 ②事件驱动实时增量画像（单写者）③profile_stats 确定性统计＋Agent 只解读 ④六维框架与报告模板保留 ⑤P1 考前会商模式 ⑥与批改/提问实时联动 | 口径正确性 100%、覆盖完整率≥98%、建议采纳率≥60%；画像秒级增量更新；三板块数据同源 |
| **平台层** | 三套编排、双栈重复、Key 明文、无权限无审计 | Python SDK 单点集成＋PAT 化＋原生工具调用＋权限分级＋持久会话＋流式统一＋审计哈希链 | 明文 Key 归零；编排收敛单点；P0–P4 每期可回滚；打包剔除 Docker 沙箱 |

---

## ✅ 行动清单

| # | 行动 | 负责方 | 紧急度 | 期望完成 |
|---|------|--------|--------|---------|
| 1 | P0：backend 接入 `qoder-agent-sdk`，新增 `/api/agent/query`，PAT 首启引导（DPAPI 存储）＋`AGENT_USE_QODER` 灰度开关 | 后端负责人 | P0 | 第 1 周 |
| 2 | P0 安全闸门（第 0 项优先）：渲染层隔离修复（contextIsolation＋preload＋sandbox:true＋IPC 白名单）；渲染 Key 下线、LLM 调用统一经后端转发；出域脱敏网关（伪 ID 映射＋L1 拦截）＋agent.db 增加 sensitivity/audit_log 表 | 安全＋后端 | P0 | 第 1 周 |
| 3 | P1：systemPrompt 完全替换（教师端三板块版）＋canUseTool 写审批＋stream_event→SSE 流式 | 后端 | P1 | 第 2–4 周 |
| 4 | P2：进程内 MCP server（kongmeng-data 六工具＋exporter/kb_retrieve/web_search）＋记忆迁移 SQLite；`memory_read` 实现服务端裁剪（scope 板块化注入，最小必要） | 后端 | P1 | 第 4–7 周 |
| 5 | P3 三板块深耕：提问持久会话＋图片输入；批改子 Agent＋Schema 校验；学情事件驱动画像＋会商模式 | 后端＋前端 | P2 | 第 7–11 周 |
| 6 | 评测集建设：每科 50 条金标准答疑题＋200 题批改标注集（教师双评＋仲裁） | 教研负责人 | P1 起并行 | 第 6 周 |
| 7 | CI 质量门：handler 单测＋Mock 集成测试＋三板块 Schema 校验器；真实模型每晚评测，指标环比下滑>5% 阻断合并 | QA | P1 起并行 | 持续 |
| 8 | 灰度发布：单学科班级 2 周→3 学科→全校，按晋级/回退门槛执行；旧链路引擎切换开关演练一次 | QA＋教研 | P2 起 | 第 8 周起 |
| 9 | P4 清理：退役 langgraph-workflow.js/ReAct/mock MCP/Docker 沙箱，模型管理页改 PAT 配置 | 后端 | P3 | 第 12–13 周 |
| 10 | 合规推进：与 Qoder 确认企业部署/DPA 条款，评估校内网关或私有化端点；输出教师/家长告知同意文案 | 安全＋商务 | P0 并行 | 第 4 周 |

---

## ⚠️ 待完善 / 已知局限

- Qoder 云端数据边界需商务/法务确认（DPA、私有化端点可用性、境内存储）；本方案给出缓解组合但未彻底消除出域，若合规要求「数据不出校」则必须落私有化端点或本地小模型兜底。
- qodercli 二进制随 SDK 分发的杀软误报、首启下载体验需在 P0 实测（双打包目标冒烟）。
- SDK 原生记忆仅 TypeScript 版；Python 路线采用「应用接管记忆」（已在本方案选型中明确）。
- 手写体 OCR 识别率对批改一致率的影响需在评测集（含 30 题图片题）中实测。
- SQLite 单机在全校多教师并发写画像场景的性能需压测；超限时演进 PostgreSQL（表结构设计已按可迁移性约束）。
- 评测标注需教师真实投入（每科 50 题＋200 题＋每月对抗样本），需教研排期保障。
- 批改板块 P1 的「全班同题批量批改」涉及逐题子 Agent 成本，需在灰度期结合 usage 看板校准预算。

---

## 📚 成员产出索引（原始产出全文见附录 A–D）

- 附录 A：产品官《三大板块功能范围与交互流程设计》
- 附录 B：调查员《现状代码深度分析＋Qoder Agent SDK 迁移架构方案》
- 附录 C：安全卫士《三板块数据共享机制·安全与合规设计》
- 附录 D：质量门神《验收标准、测试策略与发布方案》

---

## 附录 A · 产品官原始产出

### SDK 能力映射总纲
- systemPrompt（preset+append）：替换现 system-prompt.md 中 LangGraph 工作流描述为「教师端三板块」身份；RULES.md 全文迁入 append 层（不超纲、去标识化、澄清机制）。
- Skills 按名调用：讲解题/题目批改/学生学情分析三个技能包及其 references/assets 结构整体保留，SKILL.md 描述改造为教师端场景。
- 进程内 MCP 自定义工具（tool()+createSdkMcpServer，统一 server 名 kongmeng-data）：save_qa_record / save_grade / update_profile / query_profile / score_calculator / profile_stats。
- canUseTool 审批：所有写库、落盘导出操作需教师确认；只读查询自动放行。
- 子 Agent（options.agents）：批改、学情重计算用独立上下文子 Agent，防长文档污染主会话。
- 图片输入：学生作答/提问拍照直传。持久会话 resume/fork：三板块共享同班上下文；会商场景 fork 副本做推演。

### 板块一：学生提问（教师答疑助手）
P0：①教师转发学生问题（文字/拍照），Agent 自动识别学科并调 knowledge-qa skill；②产出「讲解参考稿」三段式：标准解法（分步+得分点）/ 讲解话术与板书建议 / 易错提醒；③按学生层次输出三种讲解深度（基础/中等/拔尖），教师一键切换；④教师可编辑后生成可发学生的「讲解卡」。
升级点：现 skill 面向学生直接作答 → 重定位为"给教师的讲解助手"，新增讲解话术与深度分级（落实原 skill"因材施教"原则）。
P1：结合学情自动选深度；同类高考真题自动附送。P2：课中实时投影简洁模式。
Not-Do：不做学生端直连答疑机器人；不做自动推送。
流程（人机分工）：答疑面板入口【人】→ 粘贴/拍照【人】→ query() 识别科目→skill 解答【机】→ 教师确认/改深度/编辑【人】→ 导出讲解卡（canUseTool 审批）+ save_qa_record 留存（学科/知识点/深度/时间）【机+人审】。

### 板块二：题目批改
P0：①输入：题目+标准答案+分值（缺标准答案时 Agent 先拟评分细则供教师确认，沿用选择题式澄清机制）；②学生作答拍照（图片输入）；③按题型逐点批改：客观题比对、主观题分步给分、作文分维度，沿用现有 5 类错误标注（知识/方法/计算/格式/审题）；④教师逐题可改分、改错因；⑤生成批改报告（复用 assets 模板）落盘。
升级点：grade_homework.py 计算逻辑封装为 MCP 工具 score_calculator，算分确定性不靠模型心算；批改规范与评分标准.md、评语模板库.md 保留为 skill references。
P1：全班同题批量批改+共性问题聚合；作文批改增强。P2：手写识别结果可视化复核、学生错题本自动归集。
Not-Do：不替代正式网上阅卷系统；不自动向学生发布成绩。
流程：批改入口【人】→ 题目/答案/标准上传，缺项 Agent 选择题追问【机】→ 子 Agent 逐题批改（隔离上下文）【机】→ 逐题结果表（得分/扣分点/错误类型）→ 教师逐题复核修正【人，关键质检点】→ 确认后 score_calculator 汇总、报告落盘、update_profile 写入错因（canUseTool 审批）【机+人审】。

### 板块三：学生学情分析
P0：①三类数据源统一入库：批改记录、提问记录、成绩单导入（Excel/JSON）；②个体画像（沿用六维：成绩/知识/能力/题型/趋势/分层）与班级画像；③教学建议按四原则生成（针对性/可操作/分层/发展）；④报告落盘（Markdown/HTML 模板复用）。
升级点：analyze_student.py 封装为 profile_stats/query_profile MCP 工具，Agent 只解读数据不手算，杜绝计算幻觉；由"整卷触发全量分析"改为批改/提问事件实时增量更新画像。
P1：考前学情会商模式（一键输出薄弱知识点清单+分层名单+考点对策）。P2：成绩趋势预警、家校沟通简报。
Not-Do：不存储学生真实姓名等敏感数据（沿用 RULES 去标识化）；不做跨校外传。
流程：学情面板【人】→ 成绩批量导入/增量数据自动到达【人/机】→ profile_stats 计算【机】→ Agent 生成画像与建议【机】→ 教师审阅修正、标注采纳项【人】→ 报告落盘留存【机+人审】。

### 三板块联动闭环
1. 批改→学情→答疑（讲解深度自适应）：批改错因实时写入画像；下次该生同知识点提问时，query_profile 返回掌握率，讲解稿自动定深度（如"导数应用"掌握率<40% 则从教材定义讲起）。
2. 提问→学情（薄弱点证据链）：save_qa_record 的知识点自动累计提问频次，作为薄弱证据进入会商报告，与批改错因交叉印证。
3. 学情→批改/推题（分层检查与作业）：会商产出薄弱清单后，批改同知识点题目时 Agent 自动加严检查并重点标注；推题走 exercise 子工作流生成分层作业（复用备课侧能力）。
4. 统一机制：kongmeng-data 四工具 + 持久会话上下文 + 事件驱动增量更新，三板块共享同一画像数据源。

### 碎片化场景速写
课中 3 分钟：拍照学生问题→深度自选→生成讲解卡投屏。课后 10 分钟：批量拍照作业→逐题快速确认（默认采纳 AI 判分，仅复核低置信项）。考前 20 分钟：一键会商→薄弱清单+分层名单+分层作业包。

---

## 附录 B · 调查员原始产出

### 一、现状架构梳理（分层）

```
┌─ UI 层（Electron 渲染进程，contextIsolation:false / sandbox:false）
│   index.html（约 6000+ 行单文件：Chat/Agent/学生提问/题目批改/学情分析/智能组卷全部页面逻辑
│   + callAIStream 直连 10 家模型 API）+ teacher-agent-sandbox/js/*（agent-core、langgraph-workflow、
│   skills-engine、tool-registry、memory-system、mcp-client、web-search、sandbox-runtime、backend-client）
├─ Electron 主进程 electron/main.js
│   拉起 backend/server.py（127.0.0.1:8767，多解释器候选+依赖自动 pip 安装）、随机 AGENT_API_TOKEN 注入、
│   IPC 文档读写/资源读取、fetch-url 代理（含 SSRF 防护）
├─ 自研 Agent 运行体（三套并存，互相降级）
│   ① 后端 workflow.py：LangChain+LangGraph，意图路由→追问→扇出并行→PRODUCERS 产物注册表（含校验器）→质量门
│   ② 前端 langgraph-workflow.js：多阶段工作流（JS 重复实现）
│   ③ 前端 agent-core.js ReAct 兜底：靠系统提示要求模型输出严格 JSON，parseJSON 容错解析
│   支撑件：skills-engine（SKILL.md+内嵌兜底，关键词加权 match() 意图路由）、tool-registry（内存注册表+JSON Schema）、
│   memory-system（localStorage 三层记忆+学生洞察）、mcp-client（浏览器内置 mock 兜底）
├─ 后端服务 backend/（FastAPI）
│   api.py（REST+SSE）→ task_queue.py（线程池+asyncio SSE 推送+取消/超时+SQLite 持久化）→ router.py → workflow.py
│   memory.py/db.py（SQLite：sessions/messages/memories/tasks/artifacts/models）
│   security.py（DPAPI→Fernet→派生密钥的 API Key 加密）；exporter.py（落盘「备课产物/」）
├─ RAG 层 backend/app/rag/：知识树+语料 → chunker → sqlite-vec 向量 + BM25 → hybrid 混合检索 + reranker；
│   kb.py 保留旧接口签名向后兼容（索引空时回退旧子串匹配）
└─ Docker 沙箱 teacher-agent-sandbox/（docker-compose：FastAPI:8000 + Node:8001 + Redis）
    gen_word/gen_ppt/gen_excel/gen_pdf 文档生成与代码执行；⚠ Electron 主进程不拉起它，桌面部署默认缺席
```

**调用链实证：**
- 学生提问：index.html sendSqFollowup(L4070) → 校验 localStorage 里的模型 Key → streamToBox→callAIStream(L2409) 渲染进程直连模型厂商 API（明文 Key 在 localStorage）→ 回答完成仅 AgentMemory.addInsight({type:'question'}) 写 localStorage。完全不经过后端：无工具调用、无会话持久化（sqHistory 内存数组）、换机即丢。
- 题目批改：index.html 批改模块（L4076 起）→ callAIStream 直连模型 + 批改提示词；生成报告需 gen_word/gen_pdf → 依赖 8000/8001 沙箱服务，缺席时降级 Pyodide（CDN 依赖，离线不可用）或失败。
- Agent 备课模式：agent-core.run → backend-client 检测 8767 → /api/tasks/workflow 异步任务 + SSE 进度 → router→workflow.py → exporter 落盘；后端不可用降级前端 LangGraph，再降级 ReAct。

### 二、三大板块现状能力缺陷清单（11 条，代码证据略述）

1. 无原生工具调用协议：agent-core.js L20-77 REACT_INSTRUCTION 靠提示词约定 JSON 文本，L88-121 parseJSON 四层容错——文本协议模拟 function calling；tool-registry 的 JSON Schema 仅用于拼接文本未下发模型。SDK 原生 tool_use 可整体消除。
2. 无权限分级与审批：工具执行无 canUseTool/permissionMode 概念；仅 main.js fetch-url 有 SSRF 防护。
3. 会话不可持久/不可恢复：agent-core.js L158 _convoHistory 内存数组、L164 resetMemory 清空；sqHistory/批改历史同样内存态。SDK resume/fork/checkpoint 直接解决。
4. 记忆非结构化且三处分裂：localStorage（600K 字符截断预算）+ backend SQLite memories + memory-store.json；检索为关键词×时间衰减，无向量；多机不同步。
5. 模型管理硬编码 + Key 明文：MODEL_CONFIG 硬编码 10 endpoint（L1240-1251），localStorage 明文 Key（L1286-1287 注释自认），callAIStream 三厂商特判（L2431-2463）。SDK 单 PAT 可整体废弃。
6. MCP 大面积 mock：mcp-client.js L135-189 教学工具返回占位文本；mcp-config.json 引用的 servers 只存在于 Docker 环境。学情板块数据读取名存实亡。
7. Skills 无子 Agent/无渐进上下文：skills-engine.js L361-373 关键词加权路由，L376-400 拼文本注入，单上下文单技能。
8. 无统一流式回传：task_queue.py L9-15 仅推进度事件；前端全靠手写 SSE 解析。
9. 沙箱链路脆弱：main.js 只拉起 8767；8000/8001 无自动启动；sandbox-config.json 引 Pyodide CDN。
10. 双语言栈重复实现：意图路由/追问/编排前端 JS 与后端 Python 各一遍。
11. 渲染进程 contextIsolation:false + sandbox:false（main.js L62-69）；图片仅走 Chat vision 通道，Agent 链路无图片输入。

### 三、迁移架构方案

a) SDK 语言选型：Python SDK（backend 集成）为主，不引入 TS SDK。理由：Agent 重资产全在 Python；PAT 只需后端一处注入；main.js 已有解释器探测+自动 pip 基建；避免 Electron 第二运行时；三板块进程内 MCP 工具全部可由 Python 承载。

b) 新旧组件映射表：（见正文 §3.4，一致）

c) PAT 分发：短中期首启引导→security.py DPAPI 加密存 SQLite→启动注入环境变量；规模化演进企业网关（PAT 只存校内服务器）；辅助 MDM 下发；永不打包进安装包。

d) 分期路线图：P0 基线接入（1 周）→P1 Agent 链路替换（2-3 周）→P2 工具与记忆统一（2-3 周）→P3 三板块深耕（3-4 周）→P4 清理收敛（1-2 周），每期结束应用整体可用、开关可回滚。

### 四、保留 / 替换 / 废弃清单
（见正文 §3.7，一致）

---

## 附录 C · 安全卫士原始产出

### 1. 现状数据资产盘点（已读代码核实）
存储清单：backend/data/agent.db（SQLite，WAL）：sessions/messages（师生对话全文，无脱敏）、memories（scope=student，kind=weak_point/preference/score，content 自由文本）、tasks（input/result 全量 JSON 含学习数据）、models（api_key_enc，DPAPI→Fernet→XOR 三级降级加密）、artifacts。teacher-agent-sandbox/sandbox.db：tasks、tool_calls（全量日志）、teacher_memory。memory-store.json：教师/班级画像，schema 声明"仅本地、不含学生真实姓名"但代码层无强制校验。RAG 仅课标/教材知识块，非个人数据。
现有安全措施：API Key 本机加密；X-Agent-Token；CORS 白名单；本地单机信任边界；RULES.md 软约束。
缺口：①学生数据明文落库无分级无保留期无删除流水线；②memories.content 自由文本无 schema；③无审计日志；④API 无教师身份鉴别（设备级 Token）；⑤无出域脱敏网关。

### 2. 合规风险清单
1.【高】学情/提问/作答出域至 Qoder 云端（PIPL §28、§31 敏感个人信息）。缓解：a) 私有化/本地模型端点首选；b) 出域强制经脱敏网关；c) DPA；d) 本地小模型兜底。
2.【高】无告知同意与最小必要控制：现有 API 全量注入记忆上下文（15 条学情），需按板块裁剪。
3.【中】敏感信息无分类分级落库：提问含学生自述隐私未过滤即入库。
4.【中】保留期无限：建议原始 1 学期、脱敏统计 3 年、审计 1 年。
5.【低】XOR 弱混淆回退：仅涉 API Key。

### 3. 共享数据分级方案
L1 直接标识符（姓名/学号/班级/联系方式）：禁止出域、禁进提示词；映射 P105→"学生05"仅本地。L2 学习行为数据（提问/作答/错因/评分）：本地可用；出域伪 ID+敏感词过滤；批改出域仅传题目+作答不传画像；原始留 1 学期。L3 聚合统计（掌握度/趋势/tierDist）：可出域；留 3 年。实现：sensitivity 字段 + data-gateway（脱敏→审计→放行）。

### 4. 访问控制矩阵
（见正文 §5.2/§5.6，映射机制五点：独立会话+独立 cwd、canUseTool 参数级校验、MCP tool policy 分级、PreToolUse/PermissionDenied 审计告警、settings deny 兜底+禁 bypassPermissions）

### 5. 数据一致性安全视角
并发写：单写者原则——画像仅学情 Agent 写，批改/提问只投递事件，SQLite WAL，事件表 version 乐观锁。越权写：PreToolUse 校验伪 ID 归属+板块权限；写入必须经服务端函数。不可抵赖：audit_log 哈希链（who/when/tool/params_digest/data_level/outcome/prev_hash）。

### 6. STRIDE 威胁建模
S 伪造：本地进程伪造教师身份→API Token 升级会话级教师凭证+Electron 主进程签名转发。T 窃取：恶意提示词诱导读全班画像出域→档案/画像工具对提问/批改板块 always_deny+脱敏网关+prompt 注入测试纳入 QA。R 否认：audit_log 哈希链+教师确认回执。I 篡改：事件→学情 Agent 校验→版本化更新；掌握度带来源批改 ID 可回溯。D 刷爆：单轮 16 次上限落 SDK 侧+canUseTool 限频+本地兜底。
P0 建议：先落"分级字段+脱敏网关+审计表"三项基础设施，再接 Qoder SDK 权限机制。

---

## 附录 D · 质量门神原始产出

### 一、验收标准
学生提问：答疑正确率≥90%（单科≥85%，每科 50 条金标准双人标注仲裁）；幻觉率≤5%（citation 核对+45 条负例误答率≤10%）；首字 P50≤2s/P95≤5s、完整 P95≤30s（SDK streaming 打点）；多轮追问解决率≥80%。
题目批改：分数一致率≥90%（主观题±2 分、选择 100%；200 题标注集含 30 图片题，双评+仲裁）；错因分类准确率≥85%（混淆矩阵按类报告）；评语可用率≥85%（编辑距离埋点）；逐题耗时客观≤5s/主观≤20s（P95）。
学情分析：口径正确性 100%（数值零容错，gradebook 夹具含缺考/0 分/满分边界 diff）；覆盖完整率≥98%（缺漏显式提示）；建议采纳率≥60%（条目唯一 ID 埋点）。

### 二、四层测试
a) MCP 工具 handler 单测（覆盖率≥80%，含异常输入/空成绩单/OCR 失败降级）；b) SDK 集成测试（消息流断言+usage，Mock 离线 CI+真实模型每晚；权限场景单列）；c) E2E 十条场景（跨学科负例/含图批改/学情周报 docx/追问链/九科回归/断网重试/PAT 引导/resume-fork/越权拦截/双产物导出）；d) RAG 评测集复用（450 条正例升级端到端答疑评测，45 条负例守门）；e) 教师三级标注流程（出题→双评 Kappa<0.6 仲裁→每月 10% 对抗样本）。

### 三、质量门升级
通用层保留（加权≥75+3 轮重写），三板块结构化校验器：答疑 citation 必须在检索命中集合内；批改强制 JSON Schema（score∈[0,满分]、错因枚举、评语≥20 字、总分精确一致）；学情数字确定性代码计算后注入。重写分型：Schema 类≤2 轮，质量类 3 轮，超限标记待人工复核。CI 门槛：RAG 三指标+单测+Schema 全绿+六场景 Mock；真实模型每晚，环比下滑>5% 阻断。

### 四、发布方案
a) 打包：SDK 运行时随包分发；asarUnpack 排除 qodercli 二进制；双打包目标实测冒烟；backend/workflow.py 仍走 extraResources；体积超基线 20% 告警。
b) PAT：首启检测缺失→引导 UI 校验→Windows 凭据管理器（safeStorage/main 进程）→子进程环境变量注入；禁止明文配置文件/打包内置/渲染进程持有。
c) 灰度：阶段 1 单学科单班 2 周（正确率≥85% 且零 P0 事故）→阶段 2 三学科 2-4 周（批改一致率≥88%）→阶段 3 全校；回退触发线：幻觉率>8% 或错误率>5% 立即回退。
d) 回滚：旧 workflow.py 链路保留为「引擎切换」开关；会话数据中立交换格式存 SQLite 双引擎可读；双包并行安装目录，48h 内 hotfix。
e) 监控：usage 按会话上报成本看板；错误率/超时/P95 按板块埋点；每周三板块指标周报联动灰度门槛；上报不含学生成绩原文。

---

> 本报告由软件工坊 AI 协作生成（主理人沽思航汇编，产品官/调查员/安全卫士/质量门神四成员独立产出），关键决策请由工程负责人复核。
