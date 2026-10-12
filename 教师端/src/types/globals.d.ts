/**
 * 全局声明（浏览器渲染进程）
 * ==================================================================
 * 本项目的多个 <script> 采用「IIFE + 挂载到 window」的全局脚本模式，
 * 模块之间通过 window 上的对象协作，无法用 import 建立类型连接。
 * 此文件集中声明这些全局形态，使 tsc 严格模式可以完整校验跨脚本调用。
 *
 * 迁移边界类型（LegacyBoundary / LegacyCallback）
 * ----------------------------------------------------------------
 * 用途：仅用于「尚未 import 化」的跨脚本全局对象与未定型的历史回调签名。
 * 约束：只允许出现在本文件与既有历史代码的批量标注中；**新增代码禁止使用**。
 * 收敛路径：模块 import 化（见 deliverables/typescript-migration-report 的后续阶段）
 * 时逐个替换为精确接口，最终删除本别名。
 */

/** 迁移边界类型：跨全局脚本的对象成员（等价 any，受控使用） */
type LegacyBoundary = any;
/** 迁移边界类型：未定型的历史回调签名 */
type LegacyCallback = (...args: any[]) => any;

/** 前端业务数据结构（迁移期宽松形态） */
interface BeikeHistoryRecord {
  id?: string | number;
  title?: string;
  input?: string;
  time?: string;
  [key: string]: LegacyBoundary;
}

interface Window {
  /* ---------- Electron 预加载注入 ---------- */
  /** 后端本地访问令牌（由主进程注入；浏览器直开时为空） */
  __AGENT_BACKEND_TOKEN__?: string;
  /** Electron 预加载桥（ipcRenderer/exposeInMainWorld 暴露的 API） */
  electronAPI?: LegacyBoundary;

  /* ---------- Agent 运行体（teacher-agent-sandbox/js） ---------- */
  AgentCore: LegacyBoundary;
  AgentSandbox: LegacyBoundary;
  AgentSandboxOpts?: LegacyBoundary;
  AgentSandboxUI: LegacyBoundary;
  AgentMemory: LegacyBoundary;
  AgentTools: LegacyBoundary;
  AgentSkills: LegacyBoundary;
  AgentSkillsMarket?: LegacyBoundary;
  AgentMCP: LegacyBoundary;
  AgentWebSearch: LegacyBoundary;
  AgentBackend: LegacyBoundary;
  AgentBackendOpts?: LegacyBoundary;
  AgentCurrentCtx?: LegacyBoundary;
  LangGraphWorkflow: LegacyBoundary;
  SubWorkflows: LegacyBoundary;
  WorkflowPrompts: LegacyBoundary;
  QualityValidator: LegacyBoundary;
  _realLangGraph?: LegacyBoundary;

  /* ---------- 主界面状态与工具（index.html 主脚本） ---------- */
  MODEL_CONFIG: LegacyBoundary;
  BEIKE_HISTORY_KEY: string;
  beikeHistory: BeikeHistoryRecord[];
  beikeArtifacts: LegacyBoundary[];
  beikeRefs: LegacyBoundary[];
  beikeTodos: LegacyBoundary[];
  beikeChatMode: string;
  beikeStreamAbortFlag: boolean;
  currentBeikeRecordId: LegacyBoundary;
  richAttachments: LegacyBoundary[];
  escapeHtml: (s: string) => string;
  renderMarkdown: (s: string) => string;
  renderMarkdownInline: (s: string) => string;
  appendMsg: (...args: LegacyBoundary[]) => LegacyBoundary;
  showToast: (msg: string) => void;
  showMsgActions?: (...args: LegacyBoundary[]) => LegacyBoundary;
  callAIStream: (...args: LegacyBoundary[]) => LegacyBoundary;
  callAIJson: (...args: LegacyBoundary[]) => LegacyBoundary;
  isPureChatMessage: (...args: LegacyBoundary[]) => boolean;
  extractTodosFromContent: (...args: LegacyBoundary[]) => LegacyBoundary;
  extractUrlsFromContent: (...args: LegacyBoundary[]) => LegacyBoundary;
  getSelectedChatModel: () => string;
  getChatApiKey: (model: string) => string;
  getConfiguredChatModels: () => LegacyBoundary[];
  getTeacherSubjectAndTextbook: () => LegacyBoundary;
  sendBeikeFollowup: (...args: LegacyBoundary[]) => LegacyBoundary;
  sendSuggest: (...args: LegacyBoundary[]) => LegacyBoundary;
  startPrepare: (...args: LegacyBoundary[]) => LegacyBoundary;
  clearBeikeChat: (...args: LegacyBoundary[]) => LegacyBoundary;
  closeBeikeSkills: (...args: LegacyBoundary[]) => LegacyBoundary;
  showBeikeRightPanel: (...args: LegacyBoundary[]) => LegacyBoundary;
  setBeikeMode: (...args: LegacyBoundary[]) => LegacyBoundary;
  setBeikeSendBtn: (...args: LegacyBoundary[]) => LegacyBoundary;
  renderBeikeSkillGrid: (...args: LegacyBoundary[]) => LegacyBoundary;
  renderBeikeTodos: (...args: LegacyBoundary[]) => LegacyBoundary;
  markBeikeSkillUsed: (...args: LegacyBoundary[]) => LegacyBoundary;
  saveBeikeSidebarState: (...args: LegacyBoundary[]) => LegacyBoundary;
  updateBeikeRefList: (...args: LegacyBoundary[]) => LegacyBoundary;
  getBeikeHistoryRecords: () => BeikeHistoryRecord[];
  saveBeikeHistoryRecord: (rec: BeikeHistoryRecord) => void;

  /* ---------- 第三方 CDN 库（由 index.html <script src> 引入） ---------- */
  Chart: LegacyBoundary;
  docx: LegacyBoundary;
  jspdf: LegacyBoundary;
  PptxGenJS: LegacyBoundary;
  pptxgen: LegacyBoundary;
  XLSX: LegacyBoundary;
  loadPyodide: (...args: LegacyBoundary[]) => LegacyBoundary;
}
