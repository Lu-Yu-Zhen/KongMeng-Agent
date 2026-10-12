# user_data 学生端数据目录

本目录用于保存学生端各设置选项产生的数据文件，与设置侧边栏的选项一一对应。数据以 JSON 文件形式保存，替换浏览器缓存（localStorage）。

## 目录结构

| 文件夹 | 对应设置项 | 保存内容 |
|--------|-----------|---------|
| `account/` | 账号 | 学生姓名、年级、班级（`account.json`） |
| `model/` | 模型 | 已配置模型与 API Key（加密保存）、各模块选中模型（`model.json`） |
| `textbook/` | 教材 | 地区、高考模式、选科、教材版本（`textbook.json`） |
| `plugins/` | 插件与技能 | 插件开关、白板开关、深度思考开关、主题（`plugins.json`） |
| `rules/language_rules/` | 规则与记忆 → 语言风格/输出规则 | 语言风格选择与自定义、输出规则（`language_rules.json`） |
| `rules/memory/` | 规则与记忆 → 上下文记忆 | 上下文记忆文本（含导入文档内容）（`memory.json`） |
| `rules/knowledge_base/` | 规则与记忆 → 知识库 | 知识库条目（手动输入 + 上传文档）（`knowledge_base.json`） |

## 说明

- 数据文件采用 JSON 格式，启动时自动加载到内存，修改时异步写盘。
- **API Key 安全**：`model.json` 中保存的 API Key 使用 Web Crypto API（AES-GCM）加密存储，文件中不会出现明文密钥。
- 知识库中上传的 docx / pdf / markdown / txt 文档，解析后的纯文本内容保存在 `rules/knowledge_base/knowledge_base.json` 中。
- 业务数据（历史记录、诊断、作业等）保存在 `data/` 目录对应模块文件夹下，见 `data/README.md`。
