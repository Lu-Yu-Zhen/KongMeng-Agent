/*!
 * teacher-agent-sandbox · 工具注册中心 (tool-registry.js)
 * ------------------------------------------------------------------
 * 智能体所有可调用工具的统一注册、描述与分发入口。
 * 采用 JSON Schema 描述参数，便于 LLM function-calling / ReAct 解析。
 * 每个工具：{ name, category, description, parameters, handler }
 *   - handler: async (args, ctx) => { ok, data, error }
 * 工具实际 handler 由各能力模块（sandbox/mcp/web/memory/skills）在加载时注册，
 * 本文件只做"目录"与"调度"，保持解耦。
 */
(function (global) {
  'use strict';

  const REGISTRY = new Map();
  const CALL_LOG = []; // 最近调用记录，供 UI 展示与调试

  const ToolRegistry = {
    /** 注册一个工具（若同名已存在则覆盖） */
    register(name, spec) {
      if (!name || typeof name !== 'string') throw new Error('工具名非法');
      const def = Object.assign({ name, category: 'general' }, spec, {
        handler: spec.handler || (async () => ({ ok: false, error: '工具未实现' })),
      });
      REGISTRY.set(name, def);
      return def;
    },

    /** 批量注册 */
    registerAll(obj) {
      Object.keys(obj).forEach((k) => this.register(k, obj[k]));
    },

    /** 取消注册 */
    unregister(name) { return REGISTRY.delete(name); },

    /** 查询单个工具定义 */
    get(name) { return REGISTRY.get(name); },

    /** 是否存在 */
    has(name) { return REGISTRY.has(name); },

    /** 按类别列出 */
    listByCategory(cat) {
      const out = [];
      REGISTRY.forEach((t) => { if (t.category === cat) out.push(t); });
      return out;
    },

    /** 全部工具（含 handler，内部用） */
    list() { return Array.from(REGISTRY.values()); },

    /** 导出给 LLM 的工具清单（不含 handler，含 JSON Schema 参数描述） */
    schemasForLLM() {
      return this.list().map((t) => ({
        name: t.name,
        category: t.category,
        description: t.description,
        parameters: t.parameters || { type: 'object', properties: {} },
      }));
    },

    /** 生成供系统提示词注入的工具说明文本 */
    describeForPrompt() {
      const cats = {};
      this.list().forEach((t) => {
        (cats[t.category] = cats[t.category] || []).push(t);
      });
      let out = '# 可用工具列表\n\n';
      Object.keys(cats).forEach((c) => {
        out += '## ' + c + '\n';
        cats[c].forEach((t) => {
          const props = (t.parameters && t.parameters.properties) || {};
          const required = (t.parameters && t.parameters.required) || [];
          const params = Object.keys(props).map((p) =>
            p + (required.indexOf(p) >= 0 ? '(必填)' : '') + ':' + (props[p].type || 'any')
          ).join(', ');
          out += '- ' + t.name + '：' + t.description + (params ? ' 参数{' + params + '}' : '') + '\n';
        });
        out += '\n';
      });
      return out;
    },

    /** 调度执行工具（带日志、超时、错误兜底） */
    async invoke(name, args, ctx) {
      const tool = REGISTRY.get(name);
      ctx = ctx || {};
      const rec = { name, args, t: Date.now(), status: 'running' };
      CALL_LOG.unshift(rec);
      if (CALL_LOG.length > 50) CALL_LOG.pop();
      if (!tool) {
        rec.status = 'failed'; rec.error = '未知工具: ' + name;
        return { ok: false, error: '未知工具: ' + name };
      }
      try {
        const timeout = (ctx.timeout || tool.timeout || 30000);
        const p = Promise.resolve(tool.handler(args || {}, ctx));
        const raced = await Promise.race([
          p,
          new Promise((_, rej) => setTimeout(() => rej(new Error('工具执行超时(' + timeout + 'ms)')), timeout)),
        ]);
        rec.status = raced && raced.ok ? 'ok' : 'failed';
        rec.result = raced;
        return raced || { ok: false, error: '工具无返回' };
      } catch (e) {
        rec.status = 'failed'; rec.error = e && e.message || String(e);
        return { ok: false, error: rec.error };
      }
    },

    /** 最近调用日志 */
    recentLog(n) { return CALL_LOG.slice(0, n || 20); },

    /** 重置（测试用） */
    _reset() { REGISTRY.clear(); CALL_LOG.length = 0; },
  };

  /* ----------------------------------------------------------
   * 内置基础工具：纯逻辑、不依赖外部能力模块
   * ---------------------------------------------------------- */
  // 计算器：安全表达式求值（仅允许数字与运算符）
  ToolRegistry.register('calc', {
    category: 'utility',
    description: '安全算术计算器，支持 + - * / ^ % () 与常用函数 sin/cos/sqrt/log/abs/round',
    timeout: 5000,
    parameters: {
      type: 'object',
      properties: { expr: { type: 'string', description: '数学表达式，如 3.14*8^2' } },
      required: ['expr'],
    },
    handler: async (a) => {
      const e = String(a.expr || '').replace(/\s+/g, '');
      if (!/^[-+*/().%^\d,a-z]+$/i.test(e)) return { ok: false, error: '表达式含非法字符' };
      try {
        const fn = new Function('sin,cos,tan,sqrt,log,abs,round,floor,ceil,pow,min,max,PI,E',
          'return (' + e.replace(/\^/g, '**') + ')');
        const r = fn(Math.sin, Math.cos, Math.tan, Math.sqrt, Math.log, Math.abs,
          Math.round, Math.floor, Math.ceil, Math.pow, Math.min, Math.max, Math.PI, Math.E);
        if (typeof r !== 'number' || !isFinite(r)) return { ok: false, error: '计算结果无效' };
        return { ok: true, data: { expr: a.expr, result: r } };
      } catch (err) { return { ok: false, error: '计算错误: ' + err.message }; }
    },
  });

  // 文本统计
  ToolRegistry.register('text_stats', {
    category: 'utility',
    description: '统计文本的字符数、词数、段落数、预估阅读时长',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async (a) => {
      const t = String(a.text || '');
      const chars = t.length;
      const cn = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
      const en = (t.match(/[a-zA-Z]+/g) || []).length;
      const paras = t.split(/\n\s*\n/).filter(Boolean).length;
      const readMin = Math.max(1, Math.round(cn / 400 + en / 200));
      return { ok: true, data: { chars, cnChars: cn, enWords: en, paragraphs: paras, readMinutes: readMin } };
    },
  });

  // 时间/日期
  ToolRegistry.register('now', {
    category: 'utility',
    description: '获取当前时间（北京时间）与格式化',
    parameters: { type: 'object', properties: { format: { type: 'string' } } },
    handler: async (a) => {
      const d = new Date();
      const fmt = (a.format || 'YYYY-MM-DD HH:mm:ss')
        .replace('YYYY', d.getFullYear())
        .replace('MM', String(d.getMonth() + 1).padStart(2, '0'))
        .replace('DD', String(d.getDate()).padStart(2, '0'))
        .replace('HH', String(d.getHours()).padStart(2, '0'))
        .replace('mm', String(d.getMinutes()).padStart(2, '0'))
        .replace('ss', String(d.getSeconds()).padStart(2, '0'));
      return { ok: true, data: { iso: d.toISOString(), formatted: fmt, weekday: '周' + '日一二三四五六'[d.getDay()] } };
    },
  });

  global.AgentTools = ToolRegistry;
})(window);
