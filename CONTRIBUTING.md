# 贡献指南（CONTRIBUTING）

感谢你愿意参与 **孔孟大模型 · 教育智能体** 的开源共创！本指南帮助你快速上手：如何提交 Bug 反馈、功能建议、代码，以及如何与项目约定保持一致。无论你是开发者、设计师、教师还是学生，这里都欢迎你。

---

## 目录

1. [行为准则](#行为准则)
2. [我能贡献什么？](#我能贡献什么)
3. [工作流程总览](#工作流程总览)
4. [Fork 与本地开发](#fork-与本地开发)
5. [提交信息规范](#提交信息规范)
6. [代码规范](#代码规范)
7. [提交 Pull Request](#提交-pull-request)
8. [处理 Review 反馈](#处理-review-反馈)
9. [分支与版本约定](#分支与版本约定)
10. [常见问题](#常见问题)

---

## 行为准则

- **友善沟通**：对事不对人，尊重不同身份（教师、学生、设计师、开发者）的视角。
- **乐于分享**：好的想法、诚实的反馈，比完美的代码更珍贵。
- **尊重版权**：不提交未经授权的第三方素材（图片、字体、题目等）。
- **保护隐私**：不提交任何真实学生、教师、学校的隐私数据到仓库。

## 我能贡献什么？

### 开发与设计
- **UI / 前端**：统一学生端、教师端的视觉风格、组件库与主题。
- **前端架构**：重构重复代码、抽取公共组件、优化加载性能。
- **后端能力**：完善沙箱服务（`teacher-agent-sandbox`）、MCP 工具、知识图谱与记忆系统。
- **智能体能力**：优化技能集（`skills/`）、提示词（`prompts/`）与工作流编排。

### 教育资源
- 完善九大学科知识图谱（`学生端/textbooks/`）。
- 补充高质量题库、教案、学情分析报告模板。

### 反馈与建议
- 通过 **Issue** 报告你发现的 Bug、体验问题，或提出新功能设想。
- 哪怕只是说一句"哪个功能不好用、为什么"，也是宝贵贡献。

---

## 工作流程总览

```
main 分支（稳定）
   │
   ├── 你 Fork 到自己的 GitHub 账号
   │
   ├── 在你的账号创建分支：feature/xxx 或 fix/xxx
   │
   ├── 本地开发、提交（遵循提交规范）
   │
   └── 向本仓库 main 发起 Pull Request
```

**核心原则**：主仓库的 `main` 分支保持稳定，所有改动通过 **Pull Request** 合并，不直接向 `main` 推送。

---

## Fork 与本地开发

### 1. Fork 仓库

点击项目页面右上角 **Fork** 按钮，将仓库复制到你的 GitHub 账号。

### 2. 克隆到本地

```bash
git clone https://github.com/<你的用户名>/KongMeng-Agent.git
cd KongMeng-Agent
```

### 3. 添加上游仓库（保持同步）

```bash
git remote add upstream https://github.com/Lu-Yu-Zhen/KongMeng-Agent.git
git fetch upstream
```

### 4. 创建特性分支

**不要直接在你的 `main` 上改代码**，始终新建分支：

```bash
git checkout -b feature/我的新功能   # 或 fix/修复的问题
git checkout -b main
git pull upstream main   # 同步最新代码
git checkout -b feature/xxx
```

### 5. 本地运行

按 `README.md` 的「快速开始」操作：

```bash
# 学生端
cd 学生端
npm install
npm start

# 教师端（沙箱服务可选）
cd 教师端
npm install
npm start
```

---

## 提交信息规范

本项目采用 **Conventional Commits（约定式提交）** 规范，便于生成变更日志与追溯。

### 格式

```
<type>(<scope>): <subject>
```

- `<type>`：提交类型（必填）
- `<scope>`：影响范围（可选，如 `学生端`、`教师端`、`sandbox`、`skills`）
- `<subject>`：简短描述（尽量使用中文，简洁明了）

### 常用 type

| type | 含义 | 示例 |
|------|------|------|
| `feat` | 新功能 | `feat(学生端): 新增口语练习模块` |
| `fix` | 修复 Bug | `fix(教师端): 修复教案导出乱码问题` |
| `docs` | 文档变更 | `docs: 补充 CONTRIBUTING 指南` |
| `style` | 格式/样式（不影响逻辑） | `style(学生端): 统一按钮圆角样式` |
| `refactor` | 重构（不改变功能） | `refactor(sandbox): 抽取公共工具函数` |
| `perf` | 性能优化 | `perf(教师端): 优化知识图谱加载速度` |
| `test` | 测试相关 | `test: 补充学情分析单元测试` |
| `chore` | 构建/依赖/杂项 | `chore: 升级 electron-builder 版本` |

### 示例

```bash
# 好
git commit -m "feat(学生端): 新增作业拍照上传功能"
git commit -m "fix(教师端): 修复组卷时题目重复的问题"
git commit -m "docs: 更新二进制资源说明"

# 避免
git commit -m "update"
git commit -m "改了一些东西"
git commit -m "fix bug"
```

---

## 代码规范

### 通用
- **编码**：所有文件使用 UTF-8 编码（无 BOM），保证中文显示正常。
- **缩进**：统一使用 4 个空格（与现有代码一致）。
- **引号**：字符串使用单引号 `'` 或双引号 `"` 均可，但**同一文件内保持一致**。
- **命名**：
  - 变量、函数：`camelCase`（如 `getDataRoot`）
  - 常量：`UPPER_SNAKE_CASE`（如 `MAX_RETRY`）
  - 类：`PascalCase`
  - 文件名：`kebab-case`（如 `knowledge-graph.html`）
- **注释**：涉及复杂逻辑处请添加中文注释，说明"为什么"而非"是什么"。

### JavaScript / Node.js（学生端、教师端主进程）
- 遵循 ES6+ 语法，避免过时写法。
- 全局变量需谨慎，避免污染 `window`。
- 文件读写等异步操作：优先使用 `async/await`，避免回调地狱。

### HTML / CSS
- 语义化标签（`header`、`main`、`section` 等），提高可读性。
- 样式尽量集中管理，避免大量内联样式，便于主题统一。
- 中文文本使用 `font-family` 同时声明中文字体（如 `Microsoft YaHei`）。

### Python（沙箱脚本）
- 遵循 PEP 8。
- 使用 `def` 函数封装，避免脚本成为"面条代码"。

### 提交范围
- **不要提交**：`node_modules/`、`dist/`、`dist-installer/`、运行时数据（`data/`、`sandbox/workspace` 等）、日志文件。这些已在 `.gitignore` 中排除。
- **不要提交**：任何 API Key、Token、口令等敏感信息。

---

## 提交 Pull Request

### 1. 推送分支到你的远程仓库

```bash
git push origin feature/xxx
```

### 2. 创建 Pull Request

在 GitHub 上点击 **New Pull Request**，选择：

- `base repository: Lu-Yu-Zhen/KongMeng-Agent`，`base: main`
- `head repository: 你的仓库`，`compare: feature/xxx`

### 3. PR 描述模板

在 PR 描述中请说明：

- **改了什么**：本 PR 实现的功能或修复的问题。
- **为什么**：背景与动机。
- **如何验证**：本地如何运行、测试过哪些场景。
- **关联 Issue**：如果有，用 `Closes #123` 关联。

示例：

```markdown
## 改动说明
- 学生端新增「口语练习」模块，支持录音与回放。
- 抽取了音频播放公共组件，供其他模块复用。

## 为什么
学习口语是高频需求，之前缺少对应功能。

## 验证方式
- 本地 `npm start` 启动，完成录音→回放→保存全流程。
- 已检查录音文件在 `data/practice/` 下正确落盘。

Closes #12
```

---

## 处理 Review 反馈

- 维护者（或社区成员）会在 PR 上给出 Review 意见。
- 收到修改意见后，在**同一分支**继续提交并推送即可，PR 会自动更新：

```bash
git add .
git commit -m "fix: 根据 review 意见调整录音组件"
git push origin feature/xxx
```

- 保持 PR 聚焦单一主题，避免一次 PR 混入多个无关改动。
- 若 PR 长期无人响应，可 @ 维护者或在 Issue 区提醒。

---

## 分支与版本约定

- **`main`**：稳定主干，所有合并到 `main` 的改动需通过 PR 与 Review。
- **功能分支**：`feature/<描述>`，用于新功能开发。
- **修复分支**：`fix/<描述>`，用于 Bug 修复。
- **文档分支**：`docs/<描述>`，用于文档更新。

当项目进入正式发布阶段后，会另行引入 `release/<版本>` 分支与 `v1.x` 标签，届时会更新本指南。

---

## 常见问题

**Q：我不会写代码，能参与吗？**
当然可以。你可以通过 Issue 反馈需求、建议，或帮助完善知识图谱、教案模板、文档等非代码内容。

**Q：学生端和教师端都要改，怎么提交？**
可以在同一个 PR 中修改两端，但请在提交信息中分别标注 scope（如 `feat(学生端)`、`feat(教师端)`），或拆成多个 PR 更清晰。

**Q：本地跑不起来怎么办？**
先确认环境满足 `README.md` 要求（Node.js ≥ 18）。Electron 下载较慢可配置镜像（见各端 `.npmrc`）。仍无法解决请提 Issue，附上你的系统版本与报错信息。

**Q：我提交的代码里有敏感信息怎么办？**
立即停止推送，并联系维护者处理。**切勿**把真实 API Key、Token 提交到仓库。若已推送到你的 fork，请删掉该分支并重新创建。

---

再次感谢你的参与！每一份贡献，都会让这个教育智能体更贴近真实的教学与学习。有问题随时在 Issue 区提出，我们一起把它做得更好。