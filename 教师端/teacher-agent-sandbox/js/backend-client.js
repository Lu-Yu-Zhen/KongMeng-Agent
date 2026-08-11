/*!
 * teacher-agent-sandbox · 后端桥接客户端 (backend-client.js)
 * ------------------------------------------------------------------
 * 前后端分离的客户端侧桥接：探测本地 Python 后端（backend/server.py），
 * Agent 模式优先走后端（意图路由 + 多轮追问 + 内容生成 + 产物落盘），
 * 后端不可用时前端降级到原有 JS 工作流（LangGraph/ReAct，保留不动）。
 *
 * 后端默认地址：http://127.0.0.1:8767
 * 能力：
 *   1) 兼容旧版同步接口（runWorkflow / continueWorkflow / exportWorkflow）
 *   2) 新增异步任务 + SSE 进度推送（submitWorkflowAsync / watchTask）
 *   3) 会话管理（createSession / listSessions / sessionDetail）
 *   4) 模型配置同步（saveModel / listModels / activateModel）
 *   5) 统计 / 记忆 / 知识库 查询
 */
(function (global) {
  'use strict';

  var BACKEND_URL = (function () {
    var u = (typeof global.AgentBackendOpts !== 'undefined' && global.AgentBackendOpts && global.AgentBackendOpts.baseUrl) || '';
    return u || 'http://127.0.0.1:8767';
  })();

  var _checked = false;
  var _available = false;
  var _checking = null;

  // 本地访问令牌：Electron 主进程注入 window.__AGENT_BACKEND_TOKEN__。
  // 后端启用 X-Agent-Token 校验时，所有请求需携带此令牌（浏览器模式为空则不带）。
  function _authHeaders() {
    var t = '';
    try { t = (typeof window !== 'undefined' && window.__AGENT_BACKEND_TOKEN__) || ''; } catch (e) { /* 忽略 */ }
    return t ? { 'X-Agent-Token': t } : {};
  }

  var BackendClient = {
    baseUrl: BACKEND_URL,

    /** 探测后端是否可用（缓存结果，5 秒超时） */
    async checkAvailable(force) {
      if (_checked && !force) return _available;
      if (_checking) return _checking;
      _checking = (async function () {
        try {
          var ctrl = new AbortController();
          var timer = setTimeout(function () { ctrl.abort(); }, 3000);
          var resp = await fetch(BACKEND_URL + '/api/health', { signal: ctrl.signal, headers: _authHeaders() });
          clearTimeout(timer);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          var data = await resp.json();
          _available = !!(data && data.ok);
        } catch (e) {
          _available = false;
        }
        // 只缓存成功结果：失败时保持 _checked=false，下次自动重探，
        // 避免"启动时后端未就绪则整个会话都不再尝试"（后端恢复后可切回）
        _checked = _available;
        _checking = null;
        return _available;
      })();
      return _checking;
    },

    /** 强制重新探测（如用户手动启动后端后） */
    reset() { _checked = false; _available = false; },

    /** 组装模型配置：从教师端已配置的模型取 endpoint/apiKey */
    buildModelCfg() {
      var cfg = { provider: 'mock', model: '', apiKey: '', baseUrl: '', endpoint: '' };
      try {
        var model = (typeof global.getSelectedChatModel === 'function') ? global.getSelectedChatModel() : '';
        if (!model) return cfg;
        var mc = (typeof global.MODEL_CONFIG !== 'undefined') ? (global.MODEL_CONFIG[model] || null) : null;
        var apiKey = (typeof global.getChatApiKey === 'function') ? global.getChatApiKey(model) : '';
        if (!mc) return cfg;
        cfg.provider = (mc.type === 'openai' || mc.type === 'openai_compat') ? 'openai' : 'openai';
        cfg.model = mc.model || model;
        cfg.apiKey = apiKey || '';
        cfg.endpoint = mc.endpoint || '';
        cfg.baseUrl = mc.baseUrl || '';
      } catch (e) { /* 忽略 */ }
      return cfg;
    },

    /* ==================== 兼容旧版同步接口 ==================== */

    async runWorkflow(inputText, history) {
      return await this._post('/api/workflow/run', { input: inputText, history: history || [], model: this.buildModelCfg() });
    },

    async continueWorkflow(inputText, history, answers, state) {
      return await this._post('/api/workflow/continue', {
        input: inputText, history: history || [], answers: answers || {}, state: state || null, model: this.buildModelCfg(),
      });
    },

    async exportWorkflow(inputText, history) {
      return await this._post('/api/workflow/export', { input: inputText, history: history || [], model: this.buildModelCfg() });
    },

    /* ==================== 异步任务 + SSE 进度 ==================== */

    /**
     * 提交异步工作流任务，返回 { ok, taskId }。
     * 后端在后台线程执行完整链路（意图→生成→导出→落盘），可取消。
     */
    async submitWorkflowAsync(inputText, opts) {
      opts = opts || {};
      return await this._post('/api/tasks/workflow', {
        input: inputText,
        history: opts.history || [],
        sessionId: opts.sessionId || 0,
        topic: opts.topic || '',
        memoryKeyword: opts.memoryKeyword || '',
        model: this.buildModelCfg(),
      });
    },

    async getTaskStatus(taskId) {
      return await this._get('/api/tasks/' + taskId);
    },

    async listTasks(sessionId) {
      return await this._get('/api/tasks?session_id=' + (sessionId || 0));
    },

    async cancelTask(taskId) {
      return await this._post('/api/tasks/' + taskId + '/cancel', {});
    },

    /**
     * 订阅任务 SSE 进度流。onEvent 回调收到解析后的事件对象。
     * 返回一个 stop() 函数用于中断订阅。
     * 空闲超时按"最近一次事件"计算，长任务（教案/课件生成）期间持续有进度事件时不会误断。
     */
    watchTask(taskId, onEvent) {
      var ctrl = new AbortController();
      var stopped = false;
      var timer = null;
      var IDLE_TIMEOUT = 900000; // 900 秒：任务生成期间无任何事件且后端无心跳才断开
      function kickTimer() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { if (!stopped) { try { ctrl.abort(); } catch (e) {} } }, IDLE_TIMEOUT);
      }
      (async function () {
        try {
          var resp = await fetch(BACKEND_URL + '/api/tasks/' + taskId + '/events', { signal: ctrl.signal, headers: _authHeaders() });
          if (!resp.ok || !resp.body) { onEvent && onEvent({ type: 'error', error: 'SSE HTTP ' + resp.status }); return; }
          var reader = resp.body.getReader();
          var decoder = new TextDecoder('utf-8');
          var buf = '';
          function onChunk() {
            // 每收到一段数据就重置空闲计时器（后端每 15s 有心跳，长任务不会误断）
            try { kickTimer(); } catch (e) {}
          }
          kickTimer();
          while (!stopped) {
            try {
              var chunk = await reader.read();
              if (chunk.done) break;
              buf += decoder.decode(chunk.value || new Uint8Array(0), { stream: true });
              onChunk();
              // 按 \n\n 分割 SSE 事件
              var parts = buf.split('\n\n');
              buf = parts.pop();
              for (var i = 0; i < parts.length; i++) {
                var lines = parts[i].split('\n');
                for (var j = 0; j < lines.length; j++) {
                  var line = lines[j];
                  if (line.indexOf('data:') !== 0) continue;
                  var data = line.slice(5).trim();
                  if (!data) continue;
                  try { onEvent && onEvent(JSON.parse(data)); } catch (e) { /* 忽略坏事件 */ }
                }
              }
            } catch (e) {
              if (!stopped) onEvent && onEvent({ type: 'error', error: e.message || String(e) });
              break;
            }
          }
        } catch (e) {
          if (!stopped) onEvent && onEvent({ type: 'error', error: e.message || String(e) });
        }
      })();
      return function stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        try { ctrl.abort(); } catch (e) {}
      };
    },

    /* ==================== 会话管理 ==================== */

    async createSession(topic, modelName) {
      return await this._post('/api/sessions', { topic: topic || '', modelName: modelName || '' });
    },

    async listSessions() {
      return await this._get('/api/sessions');
    },

    async sessionDetail(sessionId) {
      return await this._get('/api/sessions/' + sessionId);
    },

    async deleteSession(sessionId) {
      return await this._del('/api/sessions/' + sessionId);
    },

    /* ==================== 模型配置同步 ==================== */

    async listModels() {
      return await this._get('/api/models');
    },

    async saveModel(cfg) {
      return await this._post('/api/models', cfg);
    },

    async activateModel(name) {
      return await this._post('/api/models/' + encodeURIComponent(name) + '/activate', {});
    },

    async deleteModel(name) {
      return await this._del('/api/models/' + encodeURIComponent(name));
    },

    /* ==================== 记忆 / 统计 / 知识库 ==================== */

    async writeMemory(payload) {
      return await this._post('/api/memories', payload);
    },

    async listMemories(sessionId, scope, keyword) {
      var q = [];
      if (sessionId) q.push('session_id=' + sessionId);
      if (scope) q.push('scope=' + encodeURIComponent(scope));
      if (keyword) q.push('keyword=' + encodeURIComponent(keyword));
      return await this._get('/api/memories?' + q.join('&'));
    },

    async getStats() {
      return await this._get('/api/stats');
    },

    async kbRetrieve(subject, topic) {
      return await this._get('/api/kb/retrieve?subject=' + encodeURIComponent(subject || '') + '&topic=' + encodeURIComponent(topic || ''));
    },

    /* ==================== 底层 HTTP ==================== */

    async _get(path) {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 30000);
      try {
        var resp = await fetch(BACKEND_URL + path, { signal: ctrl.signal, headers: _authHeaders() });
        clearTimeout(timer);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return await resp.json();
      } catch (e) {
        clearTimeout(timer);
        return { ok: false, error: e.message || String(e) };
      }
    },

    async _del(path) {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 30000);
      try {
        var resp = await fetch(BACKEND_URL + path, { method: 'DELETE', signal: ctrl.signal, headers: _authHeaders() });
        clearTimeout(timer);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return await resp.json();
      } catch (e) {
        clearTimeout(timer);
        return { ok: false, error: e.message || String(e) };
      }
    },

    async _post(path, body) {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 180000);
      try {
        var resp = await fetch(BACKEND_URL + path, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, _authHeaders()),
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return await resp.json();
      } catch (e) {
        clearTimeout(timer);
        return { ok: false, error: e.message || String(e) };
      }
    },
  };

  global.AgentBackend = BackendClient;
})(window);