/*!
 * teacher-agent-sandbox · MCP 协议客户端 (mcp-client.js)
 * ------------------------------------------------------------------
 * 加载 mcp/mcp-config.json，发现并调用 MCP 服务器工具。
 * 运行模式：
 *   - 服务端模式：通过 WebSocket/HTTP 桥接真实 MCP server（stdio）
 *   - 浏览器模式（默认）：无后端时，启用内置模拟实现，保证教学工具可用
 * 内置教学工具：教材检索、题库组卷、学情读取，使用本地数据兜底。
 */
(function (global) {
  'use strict';

  // 内嵌配置（离线兜底，与 mcp/mcp-config.json 一致）
  const FALLBACK_CONFIG = {
    servers: {
      filesystem: { tools: ['read_file', 'write_file', 'list_directory', 'create_directory'], enabled: true, autoStart: true },
      fetch: { tools: ['fetch'], enabled: true, autoStart: true },
      'textbook-knowledge': { tools: ['search_textbook', 'get_chapter', 'get_example', 'list_versions'], enabled: true, autoStart: false },
      'exam-bank': { tools: ['search_questions', 'compose_paper', 'check_duplicate'], enabled: true, autoStart: false },
      'learning-analytics': { tools: ['get_class_summary', 'get_student_detail', 'get_weak_points', 'get_trend'], enabled: true, autoStart: false },
    },
  };

  const STATUS = {}; // server -> {connected, mode}
  const TOOL_OWNER = {}; // toolName -> serverName

  const MCPClient = {
    config: null,
    bridgeUrl: null, // WebSocket/HTTP 桥接地址（服务端模式）

    /** 初始化：加载配置、连接服务器 */
    async init(opts) {
      opts = opts || {};
      this.bridgeUrl = opts.bridgeUrl || localStorage.getItem('teacher_agent_mcp_bridge') || '';
      this.config = await this._loadConfig(opts.configPath || 'teacher-agent-sandbox/mcp/mcp-config.json');
      this._registerBuiltins();
      return this.listServers();
    },

    async _loadConfig(path) {
      // 优先 fetch 外部配置（http 环境可用）
      try {
        const r = await fetch(path, { cache: 'no-cache' });
        if (r.ok) return (await r.json());
      } catch (e) { /* file:// 或离线，用兜底 */ }
      return FALLBACK_CONFIG;
    },

    listServers() {
      if (!this.config || !this.config.servers) return [];
      return Object.keys(this.config.servers).map((name) => {
        const s = this.config.servers[name];
        STATUS[name] = STATUS[name] || { connected: !!this.bridgeUrl || s.autoStart, mode: this.bridgeUrl ? 'bridge' : 'builtin' };
        return { name, description: s.description, tools: s.tools, enabled: s.enabled, status: STATUS[name] };
      });
    },

    /** 列出所有可用工具（含来源服务器） */
    listTools() {
      const out = [];
      this.listServers().forEach((s) => {
        if (!s.enabled) return;
        (s.tools || []).forEach((t) => out.push({ name: t, server: s.name, status: s.status }));
      });
      return out;
    },

    /** 调用某工具（浏览器内置实现，或经桥接转发） */
    async callTool(toolName, args) {
      args = args || {};
      // 桥接模式：转发到后端 MCP 桥
      if (this.bridgeUrl && TOOL_OWNER[toolName] !== '__builtin__') {
        return this._callViaBridge(toolName, args);
      }
      // 内置实现
      const fn = this._builtins[toolName];
      if (!fn) return { ok: false, error: '工具未实现或未连接: ' + toolName };
      try {
        const r = await fn(args);
        return r || { ok: false, error: '工具无返回' };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    },

    async _callViaBridge(toolName, args) {
      try {
        const r = await fetch(this.bridgeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: toolName, args }),
        });
        if (!r.ok) return { ok: false, error: '桥接错误 ' + r.status };
        return await r.json();
      } catch (e) {
        return { ok: false, error: '桥接不可达: ' + e.message };
      }
    },

    /** 配置桥接地址（服务端模式） */
    setBridge(url) {
      this.bridgeUrl = url;
      localStorage.setItem('teacher_agent_mcp_bridge', url || '');
    },

    /* ============ 浏览器内置教学工具实现 ============ */
    _builtins: {},

    _registerBuiltins() {
      const self = this;

      // ---- 文件系统（委托沙箱虚拟 FS）----
      function _fs() { return global.AgentSandbox; }
      this._builtins.read_file = async (a) => { const f = _fs(); if (!f) return { ok: false, error: '沙箱未就绪' }; return f.readFile(a.path); };
      this._builtins.write_file = async (a) => { const f = _fs(); if (!f) return { ok: false, error: '沙箱未就绪' }; return f.writeFile(a.path, a.content); };
      this._builtins.list_directory = async (a) => { const f = _fs(); if (!f) return { ok: false, error: '沙箱未就绪' }; return f.listDir(a.path); };
      this._builtins.create_directory = async (a) => { const f = _fs(); if (!f) return { ok: false, error: '沙箱未就绪' }; return f.mkdir(a.path); };

      // ---- 网页抓取（委托 web-search）----
      this._builtins.fetch = async (a) => { if (!global.AgentWebSearch) return { ok: false, error: '搜索模块未就绪' }; return global.AgentWebSearch.fetchPage(a.url); };

      // ---- 教材知识库 ----
      this._builtins.list_versions = async () => ({
        ok: true,
        data: {
          versions: [
            { id: 'renjiao', name: '人教版', subjects: ['化学', '历史', '地理', '政治', '数学(A版)', '物理', '生物', '英语', '语文'] },
            { id: 'beishida', name: '北师大版', subjects: ['数学'] },
            { id: 'lujiao', name: '鲁教版', subjects: ['地理'] },
            { id: 'luke', name: '鲁科版', subjects: ['化学', '物理'] },
          ],
          note: '教材 PDF 位于 学生端/教材 目录，可由后端 PDF 解析服务检索全文',
        },
      });
      this._builtins.search_textbook = async (a) => ({
        ok: true,
        data: {
          query: a.keyword || a.query,
          matches: [
            { subject: a.subject || '通用', chapter: '相关章节', snippet: '（浏览器模式返回索引提示，部署后端后将返回精确页码与原文）教材 PDF 解析需服务端支持' },
          ],
          tip: '在服务端模式下，textbook-knowledge MCP 会通过 pdfplumber 解析 学生端/教材 下的 PDF，返回章节与例题原文',
        },
      });
      this._builtins.get_chapter = async (a) => ({
        ok: true,
        data: { subject: a.subject, chapter: a.chapter, content: '章节内容需服务端 PDF 解析，浏览器模式提供结构占位' },
      });
      this._builtins.get_example = async (a) => ({
        ok: true,
        data: { subject: a.subject, topic: a.topic, examples: [], note: '部署后端 exam-bank 后将返回教材例题原文' },
      });

      // ---- 题库 ----
      this._builtins.search_questions = async (a) => ({
        ok: true,
        data: {
          subject: a.subject, topic: a.topic || a.knowledge, difficulty: a.difficulty || '中等',
          questions: [],
          note: '题库数据存储于 memory/exam-bank.json，浏览器模式返回空，建议通过智能体内容生成能力即时命题',
        },
      });
      this._builtins.compose_paper = async (a) => ({
        ok: true,
        data: { paperTitle: a.title || '同步练习', count: a.count || 10, questions: [], note: '建议使用 exam 技能由智能体现场命题' },
      });
      this._builtins.check_duplicate = async (a) => ({ ok: true, data: { duplicated: false, similarity: 0, note: '查重需服务端向量库' } });

      // ---- 学情分析（读取记忆中的班级学情）----
      this._builtins.get_class_summary = async (a) => {
        const mem = global.AgentMemory;
        if (!mem) return { ok: false, error: '记忆模块未就绪' };
        const profiles = mem.classProfile();
        if (!profiles || !profiles.length) return { ok: true, data: { summary: '尚无导入的班级学情数据，可使用「导入学情数据」功能录入', classes: [] } };
        return { ok: true, data: { classes: profiles, summary: '已读取 ' + profiles.length + ' 个班级学情' } };
      };
      this._builtins.get_weak_points = async (a) => {
        const mem = global.AgentMemory;
        if (!mem) return { ok: false, error: '记忆模块未就绪' };
        const c = a.classId ? mem.classProfile(a.classId) : (mem.classProfile() || [])[0];
        if (!c) return { ok: true, data: { weakPoints: [], note: '无班级学情，请先导入' } };
        return { ok: true, data: { classId: c.classId, weakPoints: c.weakPoints || [], avgScore: c.avgScore } };
      };
      this._builtins.get_student_detail = async () => ({ ok: true, data: { note: '为保护隐私，学生明细仅在服务端脱敏后返回' } });
      this._builtins.get_trend = async (a) => {
        const mem = global.AgentMemory;
        const eps = mem ? mem.episodic().filter((e) => e.subject === a.subject) : [];
        return { ok: true, data: { recentTasks: eps.slice(0, 5), note: '基于情景记忆的备课趋势' } };
      };

      // 登记所有权
      Object.keys(this._builtins).forEach((k) => { TOOL_OWNER[k] = '__builtin__'; });
    },
  };

  // 注册到工具中心
  if (global.AgentTools) {
    global.AgentTools.register('mcp_call', {
      category: 'mcp',
      description: '调用 MCP 服务器工具（教材检索/题库/学情/文件/抓取）',
      parameters: {
        type: 'object',
        properties: { tool: { type: 'string', description: 'MCP 工具名' }, args: { type: 'object', description: '工具参数' },
        },
        required: ['tool'],
      },
      handler: async (a) => MCPClient.callTool(a.tool, a.args || {}),
    });

    // 直接注册常用 MCP 工具，便于 LLM 发现和调用
    const commonMcpTools = [
      { name: 'search_textbook', desc: '检索教材章节内容（通过教材知识库MCP）', cat: 'mcp', params: { subject: 'string', keyword: 'string' }, req: ['keyword'] },
      { name: 'search_questions', desc: '从题库检索试题（按学科/知识点/难度）', cat: 'mcp', params: { subject: 'string', topic: 'string', difficulty: 'string' }, req: [] },
      { name: 'compose_paper', desc: '智能组卷（按题量/分值/难度自动组卷）', cat: 'mcp', params: { title: 'string', count: 'number', subject: 'string' }, req: [] },
      { name: 'get_class_summary', desc: '获取班级学情摘要', cat: 'mcp', params: { classId: 'string' }, req: [] },
      { name: 'get_weak_points', desc: '获取班级薄弱知识点', cat: 'mcp', params: { classId: 'string', subject: 'string' }, req: [] },
    ];
    commonMcpTools.forEach((t) => {
      const props = {};
      (t.params ? Object.keys(t.params) : []).forEach((k) => { props[k] = { type: t.params[k] }; });
      global.AgentTools.register(t.name, {
        category: t.cat,
        description: t.desc,
        parameters: { type: 'object', properties: props, required: t.req },
        handler: async (a) => MCPClient.callTool(t.name, a),
      });
    });
  }

  global.AgentMCP = MCPClient;
})(window);
