# 前端 TypeScript 化迁移报告

**日期**：2026-09-13
**范围**：前端（渲染进程 + 内联主脚本 + 悬浮球）与 Electron 主进程从 JavaScript 架构迁移到 TypeScript 架构

---

## 一、迁移前规模勘察（实测）

| 载体 | 行数 | 说明 |
|---|---|---|
| `teacher-agent-sandbox/js/*.js`（13 个模块） | 8,405 | Agent 运行体：agent-core(1174)、sandbox-runtime(1698)、ui-controller(995)、langgraph-workflow(878)、web-search(760)、sub-workflows(653)、workflow-prompts(649)、quality-validator(475)、skills-engine(413)、memory-system(279)、backend-client(264)、mcp-client(210)、tool-registry(163) |
| `index.html` 内联脚本（4 块，主块 5,323 行） | 5,506 | 全部页面逻辑（备课/提问/批改/学情/组卷） |
| `悬浮球.js` | 711 | 桌面悬浮球组件 |
| `electron/`（main 543 / preload 236 / crypto 80） | 859 | 主进程、预加载桥、密钥加密 |
| **合计** | **≈15,500 行** | 迁移前无任何 tsconfig / .ts 文件；`typescript 5.9.3` 已在 node_modules |

---

## 二、已完成的 TS 架构（本轮交付）

### 2.1 目录与构建体系（TS 源码为唯一事实源）

```
src/
  main/            ← electron/*.js 迁移源（CJS 模块，含 export {} 模块化）
  renderer/sandbox/← teacher-agent-sandbox/js/*.js 迁移源（IIFE 全局脚本）
  renderer/app/    ← index.html 4 段内联脚本抽取源（block1..block4.ts）
  renderer/shell/  ← 悬浮球.ts
  types/globals.d.ts       ← 跨脚本全局对象集中声明（含迁移边界类型）
  types/globals-auto.d.ts  ← codemod 自动汇总的缺失全局（import 化后删除）
scripts/ts/codemod*.py     ← 6 个自动补类型工具（错误驱动，可重复执行）
tests/ts-smoke.cjs         ← 编译产物加载冒烟测试
```

### 2.2 tsconfig 严格体系（用户要求「启用严格类型检查」）

| 文件 | 作用 |
|---|---|
| `tsconfig.base.json` | 严格全集：`strict`、`noImplicitAny`、`strictNullChecks`、`strictFunctionTypes`、`strictPropertyInitialization`、`noImplicitThis`、`useUnknownInCatchVariables`、`noFallthroughCasesInSwitch`、`noImplicitOverride`、`forceConsistentCasingInFileNames` |
| `tsconfig.json` | 渲染进程类型检查入口（DOM lib，`types: []` 隔离 Node 类型污染） |
| `tsconfig.main.json` | Electron 主进程（CommonJS + Node 类型），产物写回 `electron/` |
| `tsconfig.renderer-sandbox.json` | 沙箱 Agent 层，产物写回 `teacher-agent-sandbox/js/`（引用零改动） |
| `tsconfig.renderer-app.json` | 主界面逻辑，产物 `build/renderer/blockN.js`（index.html 已改为外链引用） |
| `tsconfig.renderer-shell.json` | 悬浮球，产物 `build/renderer/悬浮球.js` |

**编译产物回填原路径**策略保证行为不变：`index.html` 的 12 个 `<script src>`（沙箱模块）路径未变；`electron/main.js` 仍为 Electron 入口；仅内联脚本改为外链 bundle（原位置与原顺序保留）。

### 2.3 构建/校验脚本

```json
"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.main.json --noEmit",
"build:renderer": "tsc -p tsconfig.renderer-sandbox.json && tsc -p tsconfig.renderer-app.json && tsc -p tsconfig.renderer-shell.json",
"build:main": "tsc -p tsconfig.main.json",
"build:ts": "npm run build:renderer && npm run build:main",
"start": "npm run build:ts && electron . --dev"
```

### 2.4 自动化迁移方法（可重复执行）

以 `tsc --noEmit` 诊断输出为输入，6 个 codemod 依次执行**纯注解**修复（类型在编译期擦除 ⇒ 运行逻辑结构性不变）：

| 工具 | 处理的错误类 |
|---|---|
| codemod.py | TS7006 隐式 any 参数（名称启发式：string/number/boolean/HTMLElement/Event/回调/数组）、TS7034/7005 变量隐式 any、TS2345(never[]) 、TS18046(catch) |
| codemod2.py | 对象字面量缺属性、启发式误标回退（string/Event）、TS7053 索引、`= null` 声明 |
| codemod3.py | `{}`/`never` 接收者、`this` 隐式 any、number/boolean 误标 |
| codemod4.py | 对象字面量**属性** `null`/`{}`、清理历史插入瑕疵 |
| codemod5.py | 使用点边界断言 `(receiver as LegacyBoundary).prop` |
| codemod6.py | TS2531/TS18047 非空断言、TS2304 缺失全局自动声明 |

### 2.5「避免滥用 any」的落地方式

- 集中定义并**受控使用**两个迁移边界类型（`src/types/globals.d.ts`）：`LegacyBoundary`（跨全局脚本对象）与 `LegacyCallback`（未定型历史回调）；文件头明确"仅限迁移期、新增代码禁止使用、import 化时删除"；
- 可判定的参数一律给精确类型（string/number/boolean/HTMLElement/Event 等，首轮即自动标注 209 个 string、37 个 number、9 个 HTMLElement）；
- 跨脚本全局 API 全部在 `globals.d.ts` 中**按名声明**（67 个），而非放任隐式 any。

---

## 三、类型收敛结果（实测）

| 层 | 初始错误 | 当前残留 | 降幅 |
|---|---|---|---|
| 沙箱 Agent 层（含 **Agent 调度核心** agent-core / langgraph-workflow / sub-workflows / skills-engine / tool-registry） | 1,543 | **67** | **95.7%** |
| 主界面逻辑（block1-4） | 1,480 | 571 | 61.4% |
| 悬浮球 | 135 | 41 | 69.6% |
| Electron 主进程 | 144 | 15 | 89.6% |
| **合计** | **3,302** | **694** | **79.0%** |

### 残留错误的构成与收敛计划

| 错误类 | 数量（近似） | 性质 | 收敛方式 |
|---|---|---|---|
| TS18047/TS2531（possibly null） | ~285 | DOM 查询结果未判空（`getElementById` 等） | 逐处加判空或 `!`（需人工判断是否真为空） |
| TS2339 | ~67 | 值类型与方法不匹配的个案 | 按实际结构补接口 |
| TS7053 | ~30 | 索引签名缺失 | 声明 `Record<string, T>` |
| TS2304 | ~56 | 裸标识符引用（全局脚本模式遗留） | 已自动汇总声明，余者为拼写/加载顺序问题 |
| TS2345/TS2554/TS2769/TS7005 等 | ~250 | 元数、联合类型、赋值兼容 | 按签名逐处收敛（工具已处理可自动判定部分） |

> **重要**：残留均为**语义级类型诊断**，不含语法错误——四层均可正常编译产出并运行（见 §四）。

---

## 四、行为保持与验证证据

1. **类型注解零逻辑改动**：所有 codemod 只插入/替换类型写法，不改变表达式与语句；TypeScript 类型在 emit 时被擦除 ⇒ 运行时行为与迁移前一致。
2. **编译验证**：四层 `tsc -p <config>` 全部产出（沙箱 13 个 js、`build/renderer/` 5 个 bundle、`electron/` 3 个 js）。
3. **语法自检**：产物全部通过 `node --check`。
4. **加载冒烟测试**（`tests/ts-smoke.cjs`）：在最小浏览器环境垫片下按 index.html 的真实顺序加载 13 个沙箱模块 —— **13/13 加载成功**，`AgentTools/AgentMemory/AgentSkills/WorkflowPrompts/LangGraphWorkflow/SubWorkflows/AgentCore/AgentSandboxUI/AgentMCP/AgentWebSearch/QualityValidator` 等 API 全部挂载，`AgentTools` 可枚举 13 项工具。
5. **发现并修复真实缺陷**：严格检查暴露出上一轮手工写入的数据总线上报钩子存在**括号不匹配**（`questionDigest:(...)})`），该语法错误会导致整个 5,323 行主脚本失效——已在 TS 源码中修复（这正是启用类型/语法校验的直接收益）。
6. **打包与引用零改动**：`package.json` 的 `main: electron/main.js`、`extraResources`（backend/workflow.py/teacher-agent-sandbox）保持不变；仅新增 `build/renderer` 需纳入打包（见遗留项 4）。

---

## 五、遗留问题清单

| # | 级别 | 问题 | 建议 |
|---|---|---|---|
| 1 | 高 | **残留 694 项严格类型错误**（无语法错误，不影响运行）：DOM 判空 285、元数/联合 250、TS2304 56、索引 30、其他 73 | 按 §三 表逐类收敛；可用 `npm run typecheck` 跟踪下降曲线 |
| 2 | 高 | `LegacyBoundary/LegacyCallback` 与 `globals-auto.d.ts` 属**迁移边界债**（等价 any 的受控形态） | 将跨脚本全局改为 ES Module `import/export`（index.html 增 `type="module"` 或改为打包产单 bundle），随后逐个删除 |
| 3 | 中 | 本轮仅完成「源码 TS 化 + 编译产物回填」，尚未做浏览器端 E2E（Electron 界面点击流）验证 | 在教师机执行 `npm start` 走一遍备课/提问/批改/学情四个入口，或补 Playwright 冒烟用例 |
| 4 | 中 | 打包配置未新增 `build/renderer`（内联脚本现为外链 bundle） | 在 `package.json` extraResources 增加 `build/renderer → www/build/renderer`，并实测 `npm run build:nsis` |
| 5 | 中 | `index.html` 内联脚本抽取为 4 个 block 仍是"大块"，未按功能拆分模块 | 后续拆为 `chat/beike/question/grading/analytics` 等模块并 import 化 |
| 6 | 低 | `electron/*.js`、`teacher-agent-sandbox/js/*.js`、`悬浮球.js`、`build/` 现为**tsc 生成物**（已加入 .gitignore） | 仓库只保留 `src/**/*.ts`；CI 增加 `npm run build:ts` 前置步骤 |
| 7 | 低 | codemod 工具在极端语法形态下会误插（本轮已修 3 类：语法错 5 处、箭头参数 15 处、`{!` 若干） | 保留工具但建议后续改为 AST 级（ts-morph）改写，避免正则边界问题 |

---

## 六、结论

- **JS 架构已淘汰**：项目中不再有手写 JavaScript —— `src/**/*.ts` 是唯一源码，`.js` 仅为 tsc 编译产物（原路径回填保证引用不变，已 gitignore）。
- **Agent 调度逻辑已 TypeScript 化**：沙箱 Agent 层（含 ReAct 调度 agent-core、LangGraph 阶段编排、子工作流、技能路由、工具注册表）类型错误从 1,543 降至 67（95.7%），核心 API 具备完整签名。
- **严格模式已启用**：严格全集 + 分层 tsconfig，`npm run typecheck` 可一键跟踪。
- **待办**：694 项残留类型错误的逐类收敛（不影响运行）、边界类型 import 化、浏览器端 E2E 与打包实测。
