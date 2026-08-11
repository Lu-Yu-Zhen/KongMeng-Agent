/*!
 * preload.js - 文件存储层 + localStorage 覆写
 * ------------------------------------------------------------------
 * 在页面脚本执行前加载，将 localStorage 替换为文件存储：
 *   - 启动时：从 data/ 各模块文件夹读取 store.json 到内存
 *   - 运行时：getItem 同步读内存，setItem 触发防抖写文件
 *   - API Key 自动加密存储
 * 同时暴露 window.electronAPI 供沙箱文档操作使用。
 */
const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./crypto');

// 数据根目录（由 main.js 通过环境变量设置）
const dataRoot = process.env.DATA_ROOT || path.join(__dirname, '..', 'data');
// 前端资源根目录（打包后为 resources/www，开发模式为项目根；由 main.js 设置）
const resourceRoot = process.env.RESOURCE_ROOT || path.join(__dirname, '..');

// ==================== 模块映射 ====================

// localStorage key → 所属模块文件夹
const KEY_MODULE_MAP = {
  // ---- 备课模块 ----
  'ai_teacher_chat_models': '备课',
  'ai_teacher_chat_selected': '备课',
  'beike_history_records': '备课',
  'ai_teacher_textbook': '备课',
  'teacher_agent_mcp_bridge': '备课',
  'teacher_agent_search_config': '备课',
  'teacher_agent_memory': '备课',
  'teacher_agent_doc_index': '备课',
  'beike_search_enabled': '备课',
  'ps_skill_disabled': '备课',
  'ps_custom_skills': '备课',
  'ps_custom_plugins': '备课',
  'teacher_agent_custom_skills': '备课',
  'ai_teacher_rules_settings': '备课',
  'ai_teacher_knowledge_base': '备课',
  'ai_teacher_name': '备课',
  'ai_teacher_class': '备课',
  'ai_teacher_theme': '备课',
  // ---- 题目批改模块 ----
  'ai_teacher_grading_selected': '题目批改',
  'ai_teacher_grading_subject': '题目批改',
  'ai_teacher_grading_assignments': '题目批改',
  'ai_teacher_grading_history': '题目批改',
  // ---- 智能组卷模块 ----
  'ai_teacher_paper_selected': '智能组卷',
  'paper_search_enabled': '智能组卷',
  'ai_teacher_paper_history': '智能组卷',
  // ---- 学生学情分析模块 ----
  'ai_teacher_imported_exams': '学生学情分析',
};

function getModuleForKey(key) {
  if (key.indexOf('stuReport|') === 0) return '题目批改';
  return KEY_MODULE_MAP[key] || '备课';
}

// 需要 AES 加密的 key（含 API Key 的）
const ENCRYPTED_KEYS = ['ai_teacher_chat_models'];

const MODULES = ['备课', '学生学情分析', '学生提问', '智能组卷', '题目批改'];

// ==================== 内存存储 ====================
const memory = {};

function loadData() {
  for (const mod of MODULES) {
    const file = path.join(dataRoot, mod, 'store.json');
    if (fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        for (const k of Object.keys(data)) {
          const v = data[k];
          if (ENCRYPTED_KEYS.indexOf(k) >= 0) {
            try { memory[k] = decrypt(v, dataRoot); } catch (e) { memory[k] = v; }
          } else {
            memory[k] = v;
          }
        }
      } catch (e) { /* 损坏则跳过 */ }
    }
  }
}

loadData();

// ==================== 文件存储层 ====================
const fileStore = {
  getItem(key) {
    return memory[key] !== undefined ? memory[key] : null;
  },
  setItem(key, value) {
    memory[key] = String(value);
    scheduleWrite(key);
  },
  removeItem(key) {
    delete memory[key];
    scheduleWrite(key);
  },
  clear() {
    Object.keys(memory).forEach(function (k) { delete memory[k]; });
    for (const mod of MODULES) {
      const file = path.join(dataRoot, mod, 'store.json');
      try { fs.writeFileSync(file, '{}'); } catch (e) { /* */ }
    }
  },
  key(n) { return Object.keys(memory)[n]; },
  get length() { return Object.keys(memory).length; }
};

// ==================== 防抖写入 ====================
let writeQueue = new Set();
let writeTimer = null;

function scheduleWrite(key) {
  writeQueue.add(key);
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushWrites, 500);
}

function flushWrites() {
  if (writeQueue.size === 0) return;
  const byModule = {};
  for (const key of writeQueue) {
    const mod = getModuleForKey(key);
    if (!byModule[mod]) byModule[mod] = {};
    byModule[mod][key] = memory[key] !== undefined ? memory[key] : null;
  }
  for (const mod of Object.keys(byModule)) {
    const file = path.join(dataRoot, mod, 'store.json');
    try { fs.mkdirSync(path.join(dataRoot, mod), { recursive: true }); } catch (e) { /* */ }
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(file, 'utf-8') || '{}'); } catch (e) { /* */ }
    for (const k of Object.keys(byModule[mod])) {
      const v = byModule[mod][k];
      if (v === null) { delete existing[k]; }
      else {
        if (ENCRYPTED_KEYS.indexOf(k) >= 0) {
          existing[k] = encrypt(v, dataRoot);
        } else {
          existing[k] = v;
        }
      }
    }
    try { fs.writeFileSync(file, JSON.stringify(existing, null, 2), 'utf-8'); } catch (e) { /* */ }
  }
  writeQueue.clear();
  writeTimer = null;
}

// ==================== 覆写 localStorage ====================
// Electron 的 localStorage 是只读属性，需要用 Proxy 或直接替换方法
try {
  // 方法1：尝试用 Object.defineProperty 覆写整个 localStorage
  Object.defineProperty(window, 'localStorage', {
    value: fileStore,
    writable: false,
    configurable: true,  // 必须为 true 才能覆写已有属性
  });
  // 验证覆写是否成功
  if (window.localStorage !== fileStore) {
    throw new Error('override check failed');
  }
  console.log('[preload] localStorage 覆写成功（Object.defineProperty）');
} catch (e) {
  // 方法2：替换 localStorage 的方法（保留原型链）
  try {
    const origLS = window.localStorage;
    origLS.getItem = fileStore.getItem.bind(fileStore);
    origLS.setItem = fileStore.setItem.bind(fileStore);
    origLS.removeItem = fileStore.removeItem.bind(fileStore);
    origLS.clear = fileStore.clear.bind(fileStore);
    origLS.key = fileStore.key.bind(fileStore);
    Object.defineProperty(origLS, 'length', {
      get: function () { return Object.keys(memory).length; },
      configurable: true,
    });
    console.log('[preload] localStorage 方法替换成功');
  } catch (e2) {
    // 方法3：用 Proxy 拦截
    try {
      const proxy = new Proxy(fileStore, {
        get: function (t, p) { return t[p] !== undefined ? t[p] : null; }
      });
      Object.defineProperty(window, 'localStorage', {
        value: proxy,
        configurable: true,
      });
      console.log('[preload] localStorage Proxy 拦截成功');
    } catch (e3) {
      console.warn('[preload] localStorage 覆写失败，使用浏览器存储', e3.message);
    }
  }
}

// ==================== 暴露 electronAPI ====================
// 本地访问令牌：后端启用 X-Agent-Token 校验时，前端请求需携带此令牌。
// 令牌由主进程随机生成并经环境变量注入，仅本机渲染进程可见。
try {
  window.__AGENT_BACKEND_TOKEN__ = process.env.AGENT_API_TOKEN || '';
} catch (e) {
  window.__AGENT_BACKEND_TOKEN__ = '';
}

window.electronAPI = {
  isElectron: true,
  dataRoot: dataRoot,
  resourceRoot: resourceRoot,

  // 读取前端资源文件（www 目录内，供技能 SKILL.md / vendor 库离线加载）
  async readResource(relPath) {
    return await ipcRenderer.invoke('read-resource', { relPath: relPath });
  },

  // 文档操作
  async saveDocument(module, filename, arrayBuffer, meta) {
    return await ipcRenderer.invoke('save-document', { module: module, filename: filename, data: arrayBuffer, meta: meta || null });
  },
  async loadDocument(module, filename) {
    return await ipcRenderer.invoke('load-document', { module: module, filename: filename });
  },
  async listDocuments(module) {
    return await ipcRenderer.invoke('list-documents', { module: module });
  },
  async deleteDocument(module, filename) {
    return await ipcRenderer.invoke('delete-document', { module: module, filename: filename });
  },

  // 数据刷新
  flushData() {
    if (writeTimer) { clearTimeout(writeTimer); }
    flushWrites();
  },

  // 路径转换辅助
  getDocumentPath(vdir, filename) {
    const VDIR_MODULE_MAP = {
      '\u6559\u6848': '\u5907\u8BFE', '\u8BFE\u4EF6': '\u5907\u8BFE', '\u5B66\u6848': '\u5907\u8BFE',
      '\u91CF\u89C4': '\u5907\u8BFE', '\u5927\u5355\u5143': '\u5907\u8BFE', '\u5206\u5C42': '\u5907\u8BFE',
      '\u4E34\u65F6': '\u5907\u8BFE', '\u8BD5\u9898': '\u667A\u80FD\u7EC4\u5377',
    };
    const mod = VDIR_MODULE_MAP[vdir] || '\u5907\u8BFE';
    return { module: mod, filename: filename };
  },

  // 网络请求（绕过 CORS，由主进程发起）
  async fetchUrl(url, opts) {
    return await ipcRenderer.invoke('fetch-url', { url: url, timeout: (opts || {}).timeout || 15000, maxRedirect: 3, headers: (opts || {}).headers || null });
  },
};

// 页面卸载前同步刷新
window.addEventListener('beforeunload', function () {
  flushWrites();
});
