# 孔孟大模型 · 教育智能体（KongMeng-Agent）

> 面向中小学教育的 AI 智能体双端应用，基于 Electron 构建，涵盖**学生端**（学习助手）与**教师端**（备课助手）。

本项目为**开源共创**项目，欢迎共同开发各端应用、设计 UI 与前后端架构。你可以 `fork` 后提交 `Pull Request`，或通过 `Issue` 提出功能建议与 Bug 反馈。

## 项目结构

```
KongMeng-Agent/
├── 学生端/                  # 学生端桌面应用（KongMeng-Student）
│   ├── index.html           # 前端页面（UI + 交互逻辑）
│   ├── main.js              # Electron 主进程
│   ├── preload.js           # 预加载脚本（安全桥接）
│   ├── package.json         # 依赖与构建配置
│   ├── start-app.bat        # 启动已构建的桌面应用
│   ├── rebuild.bat          # 重新构建桌面应用
│   ├── sync-and-start.bat   # 同步资源并启动
│   ├── textbooks/           # 学科知识图谱（9 学科 graphml + 可视化）
│   ├── data/                # 运行时业务数据（学习记录、诊断、作业等）
│   └── user_data/           # 用户配置（模型、账号、规则、技能等）
└── 教师端/                  # 教师端桌面应用（教育智能体教师端）
    ├── index.html           # 前端页面（UI + 交互逻辑）
    ├── electron/            # Electron 主进程 / 预加载 / 加密
    │   ├── main.js
    │   ├── preload.js
    │   └── crypto.js
    ├── teacher-agent-sandbox/  # 智能体核心（备课沙箱）
    │   ├── js/              # 前端智能体内核（工作流、工具、记忆、技能引擎）
    │   ├── skills/          # 教师技能集（教案编写、PPT制作、学情分析等）
    │   ├── prompts/         # 系统提示词
    │   ├── sandbox/         # 沙箱服务（Python + Node.js + Docker）
    │   ├── mcp/             # MCP 服务器配置
    │   ├── nginx/           # 反向代理配置
    │   ├── vendor/          # 前端依赖库（Chart.js / KaTeX / PDF.js 等）
    │   └── docker-compose.yml  # 沙箱环境编排
    └── package.json         # 依赖与构建配置
```

## 功能特性

### 学生端（KongMeng-Student）
- 知识讲解、题目解答、题目批改、练习强化、作业上交、学习诊断六大模块
- 内置 9 大学科知识图谱（语文、数学、英语、物理、化学、生物、政治、历史、地理）
- 本地化的学习记录与诊断报告

### 教师端（教育智能体教师端）
- 教案编写、教学 PPT 制作、学生学情分析、智能组卷、题目批改、重点及易错点分析
- 基于 LangGraph 的备课工作流，支持工具调用、记忆系统与技能引擎
- Docker 沙箱环境，支持 Python + Node.js 代码执行与文档生成

## 快速开始

### 环境要求
- Node.js ≥ 18（教师端沙箱建议 ≥ 20）
- npm（或使用 `npm` 镜像加速，见各端 `.npmrc`）

### 学生端
```bash
cd 学生端
npm install        # 安装依赖（Electron 下载较慢，可配置镜像）
npm start          # 启动桌面应用
# 或直接双击 start-app.bat / rebuild.bat
```

### 教师端
```bash
cd 教师端
npm install        # 安装依赖
npm start          # 启动桌面应用（开发模式）
# 沙箱服务（可选）：cd teacher-agent-sandbox && docker compose up -d
```

## 参与贡献

详细的贡献流程、提交规范与代码规范，请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 快速开始
1. `Fork` 本仓库并克隆到本地
2. 创建特性分支：`git checkout -b feature/xxx`
3. 提交更改：`git commit -m "feat: 描述"`（遵循 Conventional Commits）
4. 推送分支并创建 `Pull Request`

### 建议的协作方向
- **UI 设计**：统一两端的视觉风格、组件库与主题
- **前端架构**：重构重复代码、抽取公共组件、优化加载性能
- **后端能力**：完善沙箱服务、MCP 工具、知识图谱与记忆系统
- **智能体能力**：优化技能集、提示词与工作流编排

### 注意
1、目前只有高中版本，若有其他学段的想法，都可以参与进来一起完成；
2、可能有些功能还不完善，也欢迎大家提交Issues或者Pull requests

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。
