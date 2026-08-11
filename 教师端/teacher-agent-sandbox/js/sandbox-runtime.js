/*!
 * teacher-agent-sandbox · 沙箱运行时 (sandbox-runtime.js)
 * ------------------------------------------------------------------
 * 提供智能体"动手"能力：代码执行 + 文档生成 + 虚拟文件系统。
 * 1) Python 执行：Pyodide (WASM) 懒加载，真实运行备课所需的 Python 包
 * 2) 文档生成：PPT(PptxGenJS) / Word(docx) / Excel(SheetJS) / PDF(jsPDF)
 * 3) 虚拟文件系统：IndexedDB 持久化，目录结构对齐 sandbox-config.json
 * 所有产物注册为"任务产物"，供 UI 下载。
 * 参考 TRAE Work / QoderWork 的沙箱模型：隔离、可观测、产物可下载。
 */
(function (global) {
  'use strict';

  const DB_NAME = 'teacher_agent_fs';
  const DB_VERSION = 2; // v2: 新增 libs 仓库（缓存当场下载的依赖库，离线可复用）
  const STORE = 'files';
  const LIB_STORE = 'libs';
  const ROOT_DIRS = ['教案', '课件', '学案', '量规', '大单元', '分层', '试题', '临时'];
  const CONFIG = { pyodideUrl: 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js', lazyLoad: true, execTimeoutMs: 15000 };

  // ---------------- 依赖库多源下载清单 ----------------
  // 每个库提供多个 CDN 镜像，全部失败时走"当场下载"通道
  // （Electron 主进程原生 HTTP / 浏览器 fetch），下载后 eval 并缓存到 IndexedDB
  const LIB_SOURCES = {
    pptx: {
      label: 'PptxGenJS（PPT 生成）',
      global: function () { return global.PptxGenJS || global.pptxgen; },
      urls: [
        'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.min.js',
        'https://fastly.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.min.js',
        'https://unpkg.com/pptxgenjs@3.12.0/dist/pptxgen.bundle.min.js',
      ],
    },
    docx: {
      label: 'docx（Word 生成）',
      global: function () { return global.docx; },
      urls: [
        'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js',
        'https://fastly.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js',
        'https://unpkg.com/docx@8.5.0/build/index.umd.min.js',
      ],
    },
    xlsx: {
      label: 'SheetJS（Excel 生成）',
      global: function () { return global.XLSX; },
      urls: [
        'https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js',
        'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
        'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js',
      ],
    },
    pdf: {
      label: 'jsPDF（PDF 生成）',
      global: function () { return global.jspdf; },
      urls: [
        'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
        'https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js',
      ],
    },
    pyodide: {
      label: 'Pyodide（Python 运行时）',
      global: function () { return global.loadPyodide; },
      urls: [
        'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js',
        'https://unpkg.com/pyodide@0.26.2/pyodide.js',
      ],
    },
  };

  // ---------------- 服务器端沙箱配置 ----------------
  const SERVER_CONFIG = {
    baseUrl: 'http://localhost:8000',
    healthPath: '/health',
    timeoutMs: 60000,
    maxRetries: 2,
    retryDelayMs: 1000,
    // 需要服务器的关键词（出现这些词时优先走服务器）
    serverKeywords: ['matplotlib', 'weasyprint', 'reportlab', 'scikit-learn', 'sklearn', 'manim', 'opencv', 'cv2', 'moviepy', 'pydub', 'pdfplumber', 'camelot', 'tesseract', 'pandoc', 'libreoffice', 'weasyprint', 'cairo', 'tex', 'latex', 'pyecharts', 'seaborn', 'plotly', 'wordcloud', 'graphviz', 'rdkit', 'music21', 'sympy.*integrate', 'scipy.*integrate'],
  };

  // ---------------- IndexedDB 虚拟文件系统 ----------------
  function _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'path' });
        }
        if (!db.objectStoreNames.contains(LIB_STORE)) {
          db.createObjectStore(LIB_STORE, { keyPath: 'name' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }
  let _dbP = null;
  function db() { if (!_dbP) _dbP = _openDB(); return _dbP; }

  function _tx(mode) {
    return db().then((d) => d.transaction(STORE, mode).objectStore(STORE));
  }
  function _txLib(mode) {
    return db().then((d) => d.transaction(LIB_STORE, mode).objectStore(LIB_STORE));
  }

  function _normalize(path) {
    path = String(path || '').replace(/^\/+/, '');
    if (!path) path = '临时/untitled';
    if (path.indexOf('/') < 0) path = '临时/' + path;
    return path;
  }

  const Sandbox = {
    ready: false,
    pyodide: null,
    pyLoading: false,
    libsLoaded: { pptx: false, docx: false, xlsx: false, pdf: false },
    // 本任务期间写入"临时/"目录的文件路径（任务结束后自动清理）
    taskTempFiles: [],
    // 服务器端沙箱状态
    serverAvailable: false,
    serverChecked: false,
    _toolResultCache: new Map(),

    /** 初始化：确保目录、登记工具、检查服务器 */
    async init() {
      try {
        for (const d of ROOT_DIRS) { await this.mkdir(d); }
        this.ready = true;
        // 异步检查服务器可用性（不阻塞初始化）
        this._checkServerAsync();
        this._registerTools();
      } catch (e) { console.warn('[sandbox] init warn', e); this.ready = true; }
      return this;
    },

    /* ============ 服务器端沙箱 ============ */
    /** 异步检查服务器是否可用（不阻塞主线程） */
    async _checkServerAsync() {
      try {
        const ok = await this.checkServer();
        if (ok) console.log('[sandbox] 服务器端沙箱已连接');
      } catch (e) { /* 静默 */ }
    },

    /** 检查服务器端沙箱是否可用 */
    async checkServer() {
      if (this.serverChecked) return this.serverAvailable;
      this.serverChecked = true;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(SERVER_CONFIG.baseUrl + SERVER_CONFIG.healthPath, { signal: ctrl.signal });
        clearTimeout(timer);
        if (r.ok) {
          const data = await r.json();
          this.serverAvailable = (data.status === 'healthy' || data.status === 'degraded');
        }
      } catch (e) { this.serverAvailable = false; }
      return this.serverAvailable;
    },

    /** 调用服务器端 API */
    async _serverCall(endpoint, body, opts) {
      opts = opts || {};
      const url = SERVER_CONFIG.baseUrl + endpoint;
      let lastErr;
      for (let attempt = 0; attempt <= SERVER_CONFIG.maxRetries; attempt++) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || SERVER_CONFIG.timeoutMs);
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          if (!r.ok) {
            const errText = await r.text().catch(() => '');
            lastErr = '服务器返回 ' + r.status + ': ' + errText.slice(0, 200);
            if (r.status >= 500 && attempt < SERVER_CONFIG.maxRetries) {
              await new Promise((r2) => setTimeout(r2, SERVER_CONFIG.retryDelayMs));
              continue;
            }
            return { ok: false, error: lastErr };
          }
          const data = await r.json();
          return { ok: true, data };
        } catch (e) {
          lastErr = (e && e.name === 'AbortError') ? '请求超时' : (e.message || String(e));
          if (attempt < SERVER_CONFIG.maxRetries) {
            await new Promise((r2) => setTimeout(r2, SERVER_CONFIG.retryDelayMs));
            continue;
          }
        }
      }
      return { ok: false, error: lastErr || '服务器请求失败' };
    },

    /** 从服务器下载文件并写入虚拟文件系统 */
    async _downloadServerFile(serverPath, vfsPath, previewText) {
      try {
        const r = await fetch(SERVER_CONFIG.baseUrl + '/files/' + encodeURIComponent(serverPath));
        if (!r.ok) return { ok: false, error: '下载失败: ' + r.status };
        const blob = await r.blob();
        await this.writeFile(vfsPath, blob, { type: blob.type, previewText });
        return { ok: true, data: { path: vfsPath, size: blob.size } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** 判断 Python 代码是否应该走服务器端执行 */
    _shouldUseServerForPython(code) {
      if (!this.serverAvailable) return false;
      const codeLower = (code || '').toLowerCase();
      // 如果代码引用了服务器关键词，优先走服务器
      for (const kw of SERVER_CONFIG.serverKeywords) {
        if (codeLower.indexOf(kw.toLowerCase()) >= 0) return true;
      }
      // 代码超过 500 行，走服务器（Pyodide 可能太慢）
      const lineCount = (code || '').split('\n').length;
      if (lineCount > 500) return true;
      return false;
    },

    /** 服务器端执行 Python 代码 */
    async serverRunPython(code, opts) {
      opts = opts || {};
      const r = await this._serverCall('/execute', { code, packages: opts.packages || [], timeout: opts.timeoutSec || 30 });
      if (!r.ok) return r;
      const d = r.data;
      // 如果服务器生成了文件，下载到本地虚拟文件系统
      if (d.files && d.files.length) {
        for (const f of d.files) {
          await this._downloadServerFile(f.path, f.path, null);
        }
      }
      return { ok: true, data: { stdout: d.stdout || '', stderr: d.stderr || '', result: d.result || '' } };
    },

    /** 服务器端生成 Word(.docx) */
    async serverGenWord(opts) {
      const r = await this._serverCall('/generate/docx', { title: opts.title || '文档', content: opts.content || '', filename: opts.filename });
      if (!r.ok) return r;
      const d = r.data;
      const filename = this._safeFilename(d.filename || opts.filename || opts.title || '文档', 'docx');
      const dlR = await this._downloadServerFile(d.path || ('教案/' + filename), '教案/' + filename, opts.content);
      return dlR.ok ? { ok: true, data: { path: '教案/' + filename, filename } } : dlR;
    },

    /** 服务器端生成 PPT(.pptx) */
    async serverGenPPT(opts) {
      const r = await this._serverCall('/generate/pptx', { filename: opts.filename, slides: opts.slides || [] });
      if (!r.ok) return r;
      const d = r.data;
      const filename = this._safeFilename(d.filename || opts.filename || '课件', 'pptx');
      const previewText = (opts.slides || []).map((s, i) => '## ' + (s.title || ('第' + (i + 1) + '页')) + (s.bullets ? '\n' + s.bullets.map((b) => '- ' + b).join('\n') : '')).join('\n\n---\n\n');
      const dlR = await this._downloadServerFile(d.path || ('课件/' + filename), '课件/' + filename, previewText);
      return dlR.ok ? { ok: true, data: { path: '课件/' + filename, filename, slides: (opts.slides || []).length } } : dlR;
    },

    /** 服务器端生成 Excel(.xlsx) */
    async serverGenExcel(opts) {
      const r = await this._serverCall('/generate/xlsx', { filename: opts.filename, rows: opts.rows || [], sheetName: opts.sheetName, dir: opts.dir });
      if (!r.ok) return r;
      const d = r.data;
      const filename = this._safeFilename(d.filename || opts.filename || '表格', 'xlsx');
      const dir = opts.dir || '量规';
      const rows = opts.rows || [];
      let previewText = '';
      if (rows.length) {
        const lines = rows.map((row) => '| ' + (row || []).map((c) => String(c == null ? '' : c).replace(/\|/g, '\\|')).join(' | ') + ' |');
        if (lines.length >= 2) lines.splice(1, 0, '| ' + Array(rows[0].length).fill('---').join(' | ') + ' |');
        previewText = lines.join('\n');
      }
      const dlR = await this._downloadServerFile(d.path || (dir + '/' + filename), dir + '/' + filename, previewText);
      return dlR.ok ? { ok: true, data: { path: dir + '/' + filename, filename } } : dlR;
    },

    /** 服务器端生成 PDF(.pdf) */
    async serverGenPDF(opts) {
      const r = await this._serverCall('/generate/pdf', { filename: opts.filename, content: opts.content || opts.text || '', title: opts.title });
      if (!r.ok) return r;
      const d = r.data;
      const filename = this._safeFilename(d.filename || opts.filename || '文档', 'pdf');
      const dlR = await this._downloadServerFile(d.path || ('教案/' + filename), '教案/' + filename, opts.content || opts.text || '');
      return dlR.ok ? { ok: true, data: { path: '教案/' + filename, filename } } : dlR;
    },

    /** 服务器端文档格式转换 */
    async serverConvert(opts) {
      return await this._serverCall('/convert', opts);
    },

    /** 服务器端 OCR */
    async serverOCR(imageBase64, lang) {
      return await this._serverCall('/ocr', { image: imageBase64, lang: lang || 'chi_sim' });
    },

    /** 服务器端生成图表 */
    async serverGenChart(opts) {
      const r = await this._serverCall('/analyze/chart', opts);
      if (!r.ok) return r;
      const d = r.data;
      const filename = this._safeFilename(opts.filename || '图表', 'png');
      const dlR = await this._downloadServerFile(d.path || ('临时/' + filename), '临时/' + filename, opts.title || '图表');
      return dlR.ok ? { ok: true, data: { path: '临时/' + filename, filename } } : dlR;
    },

    /* ============ 虚拟文件系统 ============ */
    /** 判断是否运行在 Electron 桌面环境 */
    _isElectron() {
      return !!(global.electronAPI && global.electronAPI.isElectron);
    },

    /** 将虚拟路径拆分为 vdir + filename */
    _splitPath(fullPath) {
      const parts = String(fullPath).split('/');
      return { vdir: parts[0], filename: parts.slice(1).join('/') || 'untitled' };
    },

    async mkdir(path) {
      path = _normalize(path);
      // 目录以虚拟记录表示
      const dir = path.split('/')[0];
      if (ROOT_DIRS.indexOf(dir) < 0 && path !== dir) { /* 允许子目录 */ }
      return { ok: true, data: { path } };
    },

    async writeFile(path, content, meta) {
      path = _normalize(path);
      // 追踪本任务写入"临时/"目录的文件（任务结束后统一清理）
      if (path.indexOf('临时/') === 0 && this.taskTempFiles.indexOf(path) < 0) {
        this.taskTempFiles.push(path);
      }
      const isBlob = content instanceof Blob;
      const type = isBlob ? (content.type || 'application/octet-stream') : ((meta && meta.type) || 'text/plain');
      const size = isBlob ? content.size : (content ? content.length : 0);
      const previewText = isBlob ? (meta && meta.previewText ? String(meta.previewText) : null) : String(content);

      // ---- Electron 桌面模式：使用 IPC 文件存储 ----
      if (this._isElectron()) {
        return await this._writeFileElectron(path, content, meta, type, size, previewText);
      }

      // ---- 浏览器模式：IndexedDB ----
      const rec = {
        path, dir: path.split('/')[0],
        type: type,
        content: previewText,
        blob: isBlob ? content : null,
        size: size,
        createdAt: Date.now(), meta: meta || {},
      };
      let persisted = true;
      try {
        const store = await _tx('readwrite');
        await new Promise((res, rej) => {
          const r = store.put(rec);
          r.onsuccess = res; r.onerror = () => rej(r.error);
        });
      } catch (e) {
        // IndexedDB 写入失败（配额满/隐私模式等）：内存兜底本会话可用，并标记 volatile
        persisted = false;
        if (!this._memFiles) this._memFiles = new Map();
        this._memFiles.set(path, rec);
        console.warn('[sandbox] IndexedDB 写入失败，文件仅存于内存（刷新后丢失），请尽快下载：', e && e.message);
      }
      // 通知 UI 新增产物
      if (global.AgentSandboxUI && global.AgentSandboxUI.onArtifact) {
        global.AgentSandboxUI.onArtifact({ path, type: rec.type, size: rec.size });
      }
      if (global.AgentMemory && global.AgentMemory.addArtifact) global.AgentMemory.addArtifact(path);
      return { ok: true, volatile: !persisted, data: { path, size: rec.size } };
    },

    /** Electron 模式写入文件 */
    async _writeFileElectron(path, content, meta, type, size, previewText) {
      const { vdir, filename } = this._splitPath(path);
      const loc = global.electronAPI.getDocumentPath(vdir, filename);

      // 内容转 ArrayBuffer
      let arrayBuffer;
      if (content instanceof Blob) {
        arrayBuffer = await content.arrayBuffer();
      } else {
        arrayBuffer = new TextEncoder().encode(String(content || '')).buffer;
      }

      // 元数据
      const metaObj = {
        path: path, dir: vdir, type: type,
        content: previewText, size: size,
        createdAt: Date.now(), meta: meta || {},
      };

      const result = await global.electronAPI.saveDocument(loc.module, loc.filename, arrayBuffer, metaObj);
      if (!result.ok) return result;

      // 通知 UI 新增产物
      if (global.AgentSandboxUI && global.AgentSandboxUI.onArtifact) {
        global.AgentSandboxUI.onArtifact({ path, type, size });
      }
      if (global.AgentMemory && global.AgentMemory.addArtifact) global.AgentMemory.addArtifact(path);
      return { ok: true, data: { path, size } };
    },

    async readFile(path) {
      path = _normalize(path);

      // ---- Electron 桌面模式 ----
      if (this._isElectron()) {
        return await this._readFileElectron(path);
      }

      // ---- 浏览器模式 ----
      try {
        const store = await _tx('readonly');
        const rec = await new Promise((res, rej) => {
          const r = store.get(path); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
        if (!rec) return { ok: false, error: '文件不存在: ' + path };
        return { ok: true, data: { path, content: rec.content, blob: rec.blob, type: rec.type, size: rec.size } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Electron 模式读取文件 */
    async _readFileElectron(path) {
      const { vdir, filename } = this._splitPath(path);
      const loc = global.electronAPI.getDocumentPath(vdir, filename);

      const result = await global.electronAPI.loadDocument(loc.module, loc.filename);
      if (!result.ok) return result;

      const data = result.data;
      const meta = data.meta || {};
      const type = meta.type || 'application/octet-stream';
      const arrayBuffer = data.buffer;

      // 重建 Blob 和文本内容
      const blob = new Blob([arrayBuffer], { type: type });
      const content = meta.content || null;

      return { ok: true, data: { path, content: content, blob: blob, type: type, size: data.size } };
    },

    async listDir(path) {
      path = String(path || '').replace(/^\/+/, '');
      // 裸顶层目录名（如"临时"）原样保留；_normalize 是文件路径逻辑，
      // 会把"临时"误补成"临时/临时"，导致列目录永远为空
      if (path && path.indexOf('/') < 0 && ROOT_DIRS.indexOf(path) < 0) {
        path = '临时/' + path;
      }

      // ---- Electron 桌面模式 ----
      if (this._isElectron()) {
        return await this._listDirElectron(path);
      }

      // ---- 浏览器模式 ----
      try {
        const store = await _tx('readonly');
        const all = await new Promise((res, rej) => {
          const r = store.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
        });
        const items = all.filter((f) => !path || f.path === path || f.path.startsWith(path + '/') || (path && f.dir === path.split('/')[0]));
        return { ok: true, data: { path: path || '/', files: items.map((f) => ({ path: f.path, type: f.type, size: f.size, createdAt: f.createdAt })) } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Electron 模式列出目录 */
    async _listDirElectron(path) {
      // 无路径：列出所有模块的文档
      if (!path) {
        const ALL_MODULES = ['备课', '学生学情分析', '学生提问', '智能组卷', '题目批改'];
        const allFiles = [];
        for (const mod of ALL_MODULES) {
          const r = await global.electronAPI.listDocuments(mod);
          if (r.ok && r.data.files) allFiles.push.apply(allFiles, r.data.files);
        }
        return { ok: true, data: { path: '/', files: allFiles.map((f) => ({ path: f.path, type: f.type, size: f.size, createdAt: f.createdAt })) } };
      }

      // 有路径：根据 vdir 定位模块
      const vdir = path.split('/')[0];
      const loc = global.electronAPI.getDocumentPath(vdir, '');
      const result = await global.electronAPI.listDocuments(loc.module);
      if (!result.ok) return result;

      // 注意：备课模块物理上同时存放 教案/课件/学案/量规/大单元/分层/临时 的文件，
      // 必须按虚拟路径前缀精确过滤，不能因"只指定了顶层目录"就返回整个模块的文件
      const files = (result.data.files || []).filter((f) => {
        return f.path === path || f.path.indexOf(path + '/') === 0;
      }).map((f) => ({ path: f.path, type: f.type, size: f.size, createdAt: f.createdAt }));

      return { ok: true, data: { path, files } };
    },

    async deleteFile(path) {
      path = _normalize(path);

      // ---- Electron 桌面模式 ----
      if (this._isElectron()) {
        return await this._deleteFileElectron(path);
      }

      // ---- 浏览器模式 ----
      try {
        const store = await _tx('readwrite');
        await new Promise((res, rej) => { const r = store.delete(path); r.onsuccess = res; r.onerror = () => rej(r.error); });
        return { ok: true };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Electron 模式删除文件 */
    async _deleteFileElectron(path) {
      const { vdir, filename } = this._splitPath(path);
      const loc = global.electronAPI.getDocumentPath(vdir, filename);
      return await global.electronAPI.deleteDocument(loc.module, loc.filename);
    },

    /** 触发浏览器下载某个虚拟文件 */
    async download(path, filename) {
      const r = await this.readFile(path);
      if (!r.ok) return r;
      const blob = r.data.blob || new Blob([r.data.content || ''], { type: r.data.type || 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename || path.split('/').pop();
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { ok: true, data: { path, filename: a.download } };
    },

    /* ============ 任务级临时文件管理 ============ */
    /** 任务开始时调用：重置临时文件追踪列表 */
    beginTask() {
      this.taskTempFiles = [];
    },

    /**
     * 任务结束后清理临时文件。
     * 仅删除"本任务期间写入 临时/ 目录"的文件；
     * keepPaths 中的路径（如最终回答仍引用的文件）会被保留。
     * 删除的同时同步移除产物面板与历史记录中的对应条目。
     */
    async cleanupTempFiles(keepPaths) {
      const keep = Array.isArray(keepPaths) ? keepPaths : [];
      const pending = this.taskTempFiles.slice();
      this.taskTempFiles = [];
      const removed = [], kept = [];
      for (const p of pending) {
        if (keep.indexOf(p) >= 0) { kept.push(p); continue; }
        try {
          const r = await this.deleteFile(p);
          if (r.ok) {
            removed.push(p);
            // 同步移除产物面板条目（文件已不存在，避免留下无法下载的僵尸条目）
            if (global.AgentSandboxUI && global.AgentSandboxUI.removeArtifact) {
              global.AgentSandboxUI.removeArtifact(p);
            }
          } else {
            kept.push(p); // 删除失败则保留，不冒险
          }
        } catch (e) { kept.push(p); }
      }
      if (removed.length) {
        console.log('[sandbox] 任务结束，已清理 ' + removed.length + ' 个临时文件：' + removed.join('、'));
      }
      return { ok: true, removed: removed, kept: kept };
    },

    /* ============ 库懒加载（多 CDN 兜底 + 当场下载） ============ */
    _loadScript(src, check) {
      if (check && check()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = resolve; s.onerror = () => reject(new Error('加载失败: ' + src));
        document.head.appendChild(s);
      });
    },

    /** 从 IndexedDB libs 仓库读取已缓存的库脚本 */
    async _libCacheGet(name) {
      try {
        const store = await _txLib('readonly');
        const rec = await new Promise((res, rej) => {
          const r = store.get(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
        return rec ? rec.text : null;
      } catch (e) { return null; }
    },
    /** 库脚本下载成功后写入 IndexedDB 缓存（下次离线可直接复用） */
    async _libCachePut(name, text) {
      try {
        const store = await _txLib('readwrite');
        await new Promise((res, rej) => {
          const r = store.put({ name: name, text: text, at: Date.now() });
          r.onsuccess = res; r.onerror = () => rej(r.error);
        });
      } catch (e) { /* 缓存失败不影响本次使用 */ }
    },

    /** 当场下载库脚本文本：Electron 走主进程原生 HTTP（无 CORS 限制），浏览器走 fetch */
    async _downloadLibText(url) {
      if (this._isElectron() && global.electronAPI.fetchUrl) {
        try {
          const r = await global.electronAPI.fetchUrl(url, { timeout: 25000 });
          if (r.ok && r.data && r.data.content && r.data.status >= 200 && r.data.status < 300) {
            return r.data.content;
          }
        } catch (e) { /* 继续尝试下一镜像 */ }
        return null;
      }
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (r.ok) return await r.text();
      } catch (e) { /* 继续尝试下一镜像 */ }
      return null;
    },

    /** 库名 → 本地 vendor 相对路径（不存在返回 null） */
    _libLocalPath(name) {
      const map = {
        pptx: 'teacher-agent-sandbox/vendor/pptxgenjs/pptxgen.bundle.min.js',
        docx: 'teacher-agent-sandbox/vendor/docx/index.umd.min.js',
        xlsx: 'teacher-agent-sandbox/vendor/xlsx/xlsx.full.min.js',
        pdf: 'teacher-agent-sandbox/vendor/jspdf/jspdf.umd.min.js',
      };
      return map[name] || null;
    },

    /** 读取本地资源文本：Electron 走 IPC（www 目录），浏览器走 fetch 相对路径 */
    async _readResourceText(rel) {
      if (this._isElectron() && global.electronAPI && global.electronAPI.readResource) {
        try {
          const r = await global.electronAPI.readResource(rel);
          // preload 返回 {ok, data:{content}}；兼容旧的 {ok, content} 形状
          if (r && r.ok) {
            if (r.data && typeof r.data.content === 'string') return r.data.content;
            if (typeof r.content === 'string') return r.content;
          }
          return null;
        } catch (e) { return null; }
      }
      try {
        const resp = await fetch(rel);
        return resp.ok ? await resp.text() : null;
      } catch (e) { return null; }
    },

    /** 资源 URL：Electron 下返回 www 目录的 file:// 绝对路径（blob 窗口可用），浏览器回退 CDN */
    _vendorUrl(localRel, cdnUrl) {
      try {
        if (this._isElectron() && global.electronAPI && global.electronAPI.resourceRoot) {
          var base = String(global.electronAPI.resourceRoot).replace(/\\/g, '/');
          if (base.charAt(base.length - 1) !== '/') base += '/';
          return 'file://' + base + localRel;
        }
      } catch (e) { /* 回退 */ }
      return cdnUrl;
    },

    /**
     * 确保依赖库可用（四级加载链）：
     *   1) 全局已存在（主 HTML 已加载）→ 直接返回
     *   2) IndexedDB 缓存命中（上次当场下载过）→ eval 复用，离线可用
     *   3) 依次尝试多个 CDN 镜像的 <script> 标签加载
     *   4) 当场下载：Electron 主进程原生 HTTP / 浏览器 fetch 拉取脚本文本 → eval → 写入缓存
     * 返回库的全局对象，全部失败返回 null。
     */
    async _ensureLib(name) {
      const spec = LIB_SOURCES[name];
      if (!spec) return null;
      if (spec.global()) return spec.global();
      // 1.5) 本地 vendor 文件优先（桌面应用离线可用；修改 vendor 文件即生效）
      const localRel = this._libLocalPath(name);
      if (localRel) {
        const text = await this._readResourceText(localRel);
        if (text) {
          try {
            (0, eval)(text);
            if (spec.global()) { console.log('[sandbox] 库 ' + name + ' 从本地 vendor 加载'); return spec.global(); }
          } catch (e) { console.warn('[sandbox] 本地库 ' + name + ' 执行失败，走下载链', e); }
        }
      }
      // 2) 本地缓存（曾经当场下载过，离线也能用）
      const cached = await this._libCacheGet(name);
      if (cached) {
        try {
          (0, eval)(cached);
          if (spec.global()) { console.log('[sandbox] 库 ' + name + ' 从本地缓存恢复'); return spec.global(); }
        } catch (e) { console.warn('[sandbox] 缓存的库 ' + name + ' 执行失败，重新下载', e); }
      }
      // 3) 多 CDN 镜像逐个尝试
      for (const url of spec.urls) {
        try {
          await this._loadScript(url, spec.global);
          if (spec.global()) return spec.global();
        } catch (e) { /* 尝试下一镜像 */ }
      }
      // 4) 当场下载（绕过 CDN script 标签加载失败的场景）
      for (const url of spec.urls) {
        const text = await this._downloadLibText(url);
        if (!text) continue;
        try {
          (0, eval)(text);
          if (spec.global()) {
            console.log('[sandbox] 库 ' + name + ' 已当场下载并启用（来源：' + url + '）');
            this._libCachePut(name, text);
            return spec.global();
          }
        } catch (e) { console.warn('[sandbox] 库 ' + name + ' 下载后执行失败', e); }
      }
      console.warn('[sandbox] 库 ' + name + ' 所有下载通道均失败');
      return null;
    },

    async loadPptx() {
      if (global.PptxGenJS || global.pptxgen) { this.libsLoaded.pptx = true; return global.PptxGenJS || global.pptxgen; }
      const lib = await this._ensureLib('pptx');
      this.libsLoaded.pptx = !!lib;
      return lib;
    },
    async loadDocx() {
      if (global.docx) { this.libsLoaded.docx = true; return global.docx; }
      const lib = await this._ensureLib('docx');
      this.libsLoaded.docx = !!lib;
      return lib;
    },
    async loadXlsx() {
      if (global.XLSX) { this.libsLoaded.xlsx = true; return global.XLSX; }
      // 主 HTML 的 XLSX CDN 加载失败时，走多镜像 + 当场下载兜底
      const lib = await this._ensureLib('xlsx');
      this.libsLoaded.xlsx = !!lib;
      return lib;
    },
    async loadPdf() {
      if (global.jspdf) { this.libsLoaded.pdf = true; return global.jspdf; }
      const lib = await this._ensureLib('pdf');
      this.libsLoaded.pdf = !!lib;
      return lib;
    },

    /* ============ Pyodide Python 执行 ============ */
    async loadPython() {
      if (this.pyodide) return this.pyodide;
      if (this.pyLoading) {
        // 等待已存在的加载
        while (this.pyLoading) await new Promise((r) => setTimeout(r, 100));
        return this.pyodide;
      }
      this.pyLoading = true;
      try {
        // 多 CDN 镜像逐个尝试加载 Pyodide loader（jsdelivr → unpkg）
        let indexURL = null;
        for (const url of LIB_SOURCES.pyodide.urls) {
          try {
            await this._loadScript(url, () => global.loadPyodide);
            if (global.loadPyodide) { indexURL = url.replace(/pyodide\.js.*$/, ''); break; }
          } catch (e) { /* 尝试下一镜像 */ }
        }
        if (!global.loadPyodide) {
          console.warn('[sandbox] Pyodide 加载器所有镜像均下载失败，Python 执行不可用');
          return null;
        }
        const py = await global.loadPyodide({ indexURL: indexURL });
        // 预载入备课常用纯 Python 包（numpy/pandas 等较大，按需 micropip 安装）
        try { await py.loadPackage(['micropip']); } catch (e) { /* ignore */ }
        this.pyodide = py;
        return py;
      } catch (e) {
        console.warn('[sandbox] Pyodide 加载失败，Python 执行降级', e);
        return null;
      } finally {
        this.pyLoading = false;
      }
    },

    /** 执行 Python 代码：智能路由（服务器优先 → Pyodide 降级） */
    async runPython(code, opts) {
      opts = opts || {};
      // 智能路由：需要服务器级能力的代码走服务器
      if (this._shouldUseServerForPython(code)) {
        const sr = await this.serverRunPython(code, { packages: opts.packages, timeoutSec: opts.timeoutSec || 30 });
        if (sr.ok) return sr;
        // 服务器失败，降级到 Pyodide
        console.warn('[sandbox] 服务器执行失败，降级到 Pyodide:', sr.error);
      }
      // Pyodide 浏览器端执行
      const py = await this.loadPython();
      if (!py) {
        // Pyodide 也不可用，最后尝试服务器（即使不包含关键词）
        if (this.serverAvailable) {
          return await this.serverRunPython(code, opts);
        }
        return { ok: false, error: 'Python 环境不可用（Pyodide 加载失败且服务器未连接）。', degraded: true };
      }
      if (opts.packages && opts.packages.length) {
        try {
          const micropip = py.pyimport('micropip');
          for (const p of opts.packages) { try { await micropip.install(p); } catch (e) { /* 单包失败跳过 */ } }
        } catch (e) { /* ignore */ }
      }
      let stdout = '', stderr = '';
      py.setStdout({ batched: (s) => { stdout += s + '\n'; } });
      py.setStderr({ batched: (s) => { stderr += s + '\n'; } });
      try {
        const result = await Promise.race([
          py.runPythonAsync(code),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Python 执行超时(' + CONFIG.execTimeoutMs + 'ms)')), CONFIG.execTimeoutMs)),
        ]);
        let resultStr = '';
        try { if (result && result.toString) resultStr = result.toString(); } catch (e) { /* ignore */ }
        return { ok: true, data: { stdout: stdout.trim(), stderr: stderr.trim(), result: resultStr } };
      } catch (e) {
        // Pyodide 执行失败，尝试服务器兜底
        if (this.serverAvailable && !this._shouldUseServerForPython(code)) {
          const sr = await this.serverRunPython(code, opts);
          if (sr.ok) return sr;
        }
        return { ok: false, error: (e && e.message) || String(e), stderr: stderr.trim() };
      }
    },

    /* ============ 文档生成 ============ */

    /** 生成 PPT 课件（服务器优先 → 浏览器降级） */
    async genPPT(opts) {
      opts = opts || {};
      // 服务器优先：生成更高质量的 PPT
      if (this.serverAvailable) {
        const sr = await this.serverGenPPT(opts);
        if (sr.ok) return sr;
        console.warn('[sandbox] 服务器 PPT 生成失败，降级浏览器:', sr.error);
      }
      const PptxGenJS = await this.loadPptx();
      if (!PptxGenJS) return { ok: false, error: 'PPT 库加载失败（可调用 download_library 工具当场下载 pptx 库后重试）' };
      const pptx = new PptxGenJS();
      pptx.defineLayout({ name: 'CUS', width: 13.33, height: 7.5 });
      pptx.layout = 'CUS';
      // 主题色（对齐教师端 ink/jade）
      const JADE = '4F7A66', INK = '403A30', BG = 'FAF8F3', TAN = 'A8814E';
      const slides = opts.slides || [];
      const self = this;
      slides.forEach((s) => {
        // LaTeX → Unicode（消除文档中的公式乱码）
        if (s.title) s.title = self._latexToUnicode(s.title);
        if (s.subtitle) s.subtitle = self._latexToUnicode(s.subtitle);
        if (s.bullets) s.bullets = s.bullets.map(function (b) { return self._latexToUnicode(b); });
        if (s.content) s.content = self._latexToUnicode(s.content);
        if (s.left) { if (s.left.title) s.left.title = self._latexToUnicode(s.left.title); if (s.left.bullets) s.left.bullets = s.left.bullets.map(function (b) { return self._latexToUnicode(b); }); if (s.left.content) s.left.content = self._latexToUnicode(s.left.content); }
        if (s.right) { if (s.right.title) s.right.title = self._latexToUnicode(s.right.title); if (s.right.bullets) s.right.bullets = s.right.bullets.map(function (b) { return self._latexToUnicode(b); }); if (s.right.content) s.right.content = self._latexToUnicode(s.right.content); }
        if (s.headers) s.headers = s.headers.map(function (h) { return self._latexToUnicode(String(h)); });
        if (s.rows) s.rows = s.rows.map(function (r) { return r.map(function (c) { return self._latexToUnicode(String(c == null ? '' : c)); }); });
        const slide = pptx.addSlide();
        slide.background = { color: BG };
        if (s.type === 'cover' || s.type === 'title') {
          slide.background = { color: INK };
          slide.addText(s.title || '课件', { x: 0.5, y: 2.2, w: 12, h: 1.2, fontSize: 40, color: 'FFFFFF', bold: true, align: 'center', fontFace: 'Microsoft YaHei' });
          if (s.subtitle) slide.addText(s.subtitle, { x: 0.5, y: 3.7, w: 12, h: 0.8, fontSize: 20, color: 'D9D2C5', align: 'center', fontFace: 'Microsoft YaHei' });
          slide.addShape(pptx.ShapeType.rect, { x: 5.6, y: 4.8, w: 2.1, h: 0.06, fill: { color: TAN } });
        } else if (s.type === 'summary' || s.type === 'end') {
          // 小结/作业页：带底部强调色带，正文聚焦
          slide.addText(s.title || '', { x: 0.5, y: 0.3, w: 12, h: 0.8, fontSize: 30, color: JADE, bold: true, fontFace: 'Microsoft YaHei' });
          slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 1.15, w: 1.6, h: 0.05, fill: { color: TAN } });
          if (s.bullets) {
            const rows = s.bullets.map((b) => ({ text: b, options: { bullet: { code: '2713' }, fontSize: 20, color: INK, fontFace: 'Microsoft YaHei', breakLine: true } }));
            slide.addText(rows, { x: 0.6, y: 1.5, w: 12, h: 5.2, valign: 'top' });
          }
          slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 6.9, w: 12.3, h: 0.12, fill: { color: s.type === 'end' ? TAN : JADE } });
        } else if (s.type === 'chart') {
          // 图表页：用 canvas 渲染简单图表并嵌入，实现图文并茂
          slide.addText(s.title || '图表', { x: 0.5, y: 0.3, w: 12, h: 0.8, fontSize: 28, color: JADE, bold: true, fontFace: 'Microsoft YaHei' });
          slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 1.15, w: 1.6, h: 0.05, fill: { color: TAN } });
          if (s.bullets && s.bullets.length) slide.addText(s.bullets[0], { x: 0.6, y: 1.3, w: 12, h: 0.6, fontSize: 15, color: INK, fontFace: 'Microsoft YaHei' });
          try {
            const dataUrl = self._pptChartDataUrl(s.chartType || 'bar', s.chartLabels, s.chartValues, s.title);
            if (dataUrl) slide.addImage({ data: dataUrl, x: 1.2, y: 2.0, w: 10.9, h: 4.6 });
          } catch (e) { /* 图表失败则不嵌图，保留标题 */ }
        } else if (s.type === 'table') {
          // 表格幻灯片：headers + rows
          slide.addText(s.title || '', { x: 0.5, y: 0.3, w: 12, h: 0.8, fontSize: 28, color: JADE, bold: true, fontFace: 'Microsoft YaHei' });
          slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 1.15, w: 1.6, h: 0.05, fill: { color: TAN } });
          if (s.headers && s.rows) {
            const tableRows = [s.headers.map((h) => ({ text: String(h), options: { bold: true, color: 'FFFFFF', fill: { color: JADE }, align: 'center', fontFace: 'Microsoft YaHei', fontSize: 14 } }))];
            s.rows.forEach((r) => {
              tableRows.push(r.map((c) => ({ text: String(c == null ? '' : c), options: { color: INK, fontFace: 'Microsoft YaHei', fontSize: 13 } })));
            });
            slide.addTable(tableRows, { x: 0.5, y: 1.4, w: 12.3, colW: s.colWidths || Array(s.headers.length).fill(12.3 / s.headers.length), border: { type: 'solid', color: 'D5C9B0', pt: 1 } });
          }
        } else if (s.type === 'compare') {
          // 左右分栏对照：left {title, content/bullets} + right {title, content/bullets}
          slide.addText(s.title || '', { x: 0.5, y: 0.3, w: 12, h: 0.7, fontSize: 26, color: JADE, bold: true, fontFace: 'Microsoft YaHei' });
          slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 1.0, w: 1.6, h: 0.05, fill: { color: TAN } });
          // 左栏
          const left = s.left || {};
          slide.addText(left.title || '左栏', { x: 0.5, y: 1.2, w: 5.8, h: 0.5, fontSize: 20, color: JADE, bold: true, fontFace: 'Microsoft YaHei' });
          if (left.bullets) {
            const lrows = left.bullets.map((b) => ({ text: b, options: { bullet: { code: '2022' }, fontSize: 15, color: INK, fontFace: 'Microsoft YaHei', breakLine: true } }));
            slide.addText(lrows, { x: 0.6, y: 1.8, w: 5.6, h: 5.2, valign: 'top' });
          } else if (left.content) {
            slide.addText(left.content, { x: 0.6, y: 1.8, w: 5.6, h: 5.2, fontSize: 15, color: INK, fontFace: 'Microsoft YaHei', valign: 'top' });
          }
          // 分隔线
          slide.addShape(pptx.ShapeType.line, { x: 6.5, y: 1.3, w: 0.02, h: 5.5, line: { color: TAN, width: 1 } });
          // 右栏
          const right = s.right || {};
          slide.addText(right.title || '右栏', { x: 6.8, y: 1.2, w: 5.8, h: 0.5, fontSize: 20, color: TAN, bold: true, fontFace: 'Microsoft YaHei' });
          if (right.bullets) {
            const rrows = right.bullets.map((b) => ({ text: b, options: { bullet: { code: '2022' }, fontSize: 15, color: INK, fontFace: 'Microsoft YaHei', breakLine: true } }));
            slide.addText(rrows, { x: 6.9, y: 1.8, w: 5.6, h: 5.2, valign: 'top' });
          } else if (right.content) {
            slide.addText(right.content, { x: 6.9, y: 1.8, w: 5.6, h: 5.2, fontSize: 15, color: INK, fontFace: 'Microsoft YaHei', valign: 'top' });
          }
        } else if (s.type === 'image') {
          // 图片幻灯片
          slide.addText(s.title || '', { x: 0.5, y: 0.3, w: 12, h: 0.8, fontSize: 28, color: JADE, bold: true, fontFace: 'Microsoft YaHei' });
          if (s.image) {
            try { slide.addImage({ data: s.image, x: 1.5, y: 1.4, w: 10, h: 5.4 }); } catch (e) { /* 图片添加失败 */ }
          } else if (s.imagePath) {
            slide.addImage({ path: s.imagePath, x: 1.5, y: 1.4, w: 10, h: 5.4 });
          }
        } else {
          // 默认 content 类型
          slide.addText(s.title || '', { x: 0.5, y: 0.3, w: 12, h: 0.8, fontSize: 28, color: JADE, bold: true, fontFace: 'Microsoft YaHei' });
          slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 1.15, w: 1.6, h: 0.05, fill: { color: TAN } });
          if (s.bullets) {
            const rows = s.bullets.map((b) => ({ text: b, options: { bullet: { code: '2022' }, fontSize: 18, color: INK, fontFace: 'Microsoft YaHei', breakLine: true } }));
            slide.addText(rows, { x: 0.6, y: 1.4, w: 12, h: 5.6, valign: 'top' });
          }
          if (s.content) slide.addText(s.content, { x: 0.6, y: 1.4, w: 12, h: 5.6, fontSize: 16, color: INK, fontFace: 'Microsoft YaHei', valign: 'top' });
        }
      });
      const blob = await pptx.write({ outputType: 'blob' });
      const filename = this._safeFilename(opts.filename || '课件', 'pptx');
      const filePath = this._buildPath('课件', opts.filename || '课件', 'pptx');
      // 预览用 Markdown 摘要
      const previewText = slides.map((s, i) => {
        let md = '## ' + (s.title || ('第' + (i + 1) + '页'));
        if (s.subtitle) md += '\n\n' + s.subtitle;
        if (s.bullets && s.bullets.length) md += '\n\n' + s.bullets.map((b) => '- ' + b).join('\n');
        if (s.content) md += '\n\n' + s.content;
        if (s.type === 'table' && s.headers) md += '\n\n| ' + s.headers.join(' | ') + ' |\n|' + s.headers.map(() => '---').join('|') + '|\n' + (s.rows || []).map((r) => '| ' + r.join(' | ') + ' |').join('\n');
        if (s.type === 'compare') md += '\n\n**左：' + (s.left ? s.left.title : '') + '**\n' + (s.left && s.left.bullets ? s.left.bullets.map((b) => '- ' + b).join('\n') : '') + '\n\n**右：' + (s.right ? s.right.title : '') + '**\n' + (s.right && s.right.bullets ? s.right.bullets.map((b) => '- ' + b).join('\n') : '');
        return md;
      }).join('\n\n---\n\n');
      await this.writeFile(filePath, blob, { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', previewText });
      return { ok: true, data: { path: filePath, filename, slides: slides.length } };
    },

    /** 用离屏 canvas 渲染简单图表（bar/line/pie），返回 PNG dataURL，供 PPT 图文并茂嵌入 */
    _pptChartDataUrl(type, labels, values, title) {
      try {
        const W = 1200, H = 560;
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const ctx = cv.getContext('2d');
        if (!ctx) return null;
        const JADE = '#4F7A66', TAN = '#A8814E', INK = '#403A30', LIGHT = '#F3EEE4';
        ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = INK; ctx.font = 'bold 34px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(title || '数据图表', W / 2, 52);
        const labs = (labels && labels.length) ? labels : ['基础', '提升', '拓展'];
        const vals = (values && values.length) ? values.map(Number) : [35, 45, 20];
        const t = String(type || 'bar').toLowerCase();
        if (t === 'pie') {
          const total = vals.reduce(function (a, b) { return a + (isFinite(b) ? +b : 0); }, 0) || 1;
          const colors = [JADE, TAN, '#8FAE9B', '#C9B18A', '#5B7A6B'];
          let ang = -Math.PI / 2;
          const cx = W / 2, cy = H / 2 + 20, r = 190;
          vals.forEach(function (v, i) {
            const a = (v / total) * Math.PI * 2;
            ctx.beginPath(); ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, r, ang, ang + a);
            ctx.closePath();
            ctx.fillStyle = colors[i % colors.length]; ctx.fill();
            ang += a;
          });
          ctx.fillStyle = '#FFFFFF'; ctx.beginPath(); ctx.arc(cx, cy, 90, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = INK; ctx.font = '28px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center';
          ctx.fillText('占比分布', cx, cy + 10);
          // 图例
          let ly = H - 120;
          labs.forEach(function (lb, i) {
            ctx.fillStyle = colors[i % colors.length];
            ctx.fillRect(W / 2 - 200, ly, 26, 26);
            ctx.fillStyle = INK; ctx.textAlign = 'left';
            ctx.fillText(String(lb) + '  ' + vals[i] + '%', W / 2 - 160, ly + 24);
            ly += 44;
          });
        } else {
          const padL = 90, padB = 90, padT = 90, padR = 40;
          const max = Math.max.apply(null, vals.map(Math.abs).concat([1]));
          const plotW = W - padL - padR, plotH = H - padT - padB;
          // 网格
          ctx.strokeStyle = '#E4E0D6'; ctx.lineWidth = 2;
          for (let g = 0; g <= 4; g++) {
            const y = padT + (plotH / 4) * g;
            ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
          }
          // 轴线
          ctx.strokeStyle = '#B8B0A2'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, H - padB); ctx.lineTo(W - padR, H - padB); ctx.stroke();
          if (t === 'bar') {
            const bw = plotW / Math.max(labs.length, 1) * 0.55;
            const step = plotW / Math.max(labs.length, 1);
            vals.forEach(function (v, i) {
              const h = (Math.abs(v) / max) * plotH;
              const x = padL + step * i + (step - bw) / 2;
              const y = H - padB - h;
              ctx.fillStyle = i % 2 ? TAN : JADE;
              ctx.fillRect(x, y, bw, h);
              ctx.fillStyle = INK; ctx.font = '26px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center';
              ctx.fillText(String(v), x + bw / 2, y - 12);
              ctx.fillText(String(labs[i] || ''), x + bw / 2, H - padB + 34);
            });
          } else {
            // line
            const step = plotW / (Math.max(vals.length, 1) - 1 || 1);
            ctx.strokeStyle = JADE; ctx.lineWidth = 5; ctx.lineJoin = 'round';
            ctx.beginPath();
            vals.forEach(function (v, i) {
              const x = padL + step * i;
              const y = H - padB - (Math.abs(v) / max) * plotH;
              if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            });
            ctx.stroke();
            vals.forEach(function (v, i) {
              const x = padL + step * i;
              const y = H - padB - (Math.abs(v) / max) * plotH;
              ctx.fillStyle = '#FFFFFF'; ctx.strokeStyle = JADE; ctx.lineWidth = 3;
              ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
              ctx.fillStyle = INK; ctx.font = '26px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center';
              ctx.fillText(String(v), x, y - 18);
              ctx.fillText(String((labs && labs[i]) || ''), x, H - padB + 34);
            });
          }
        }
        return cv.toDataURL('image/png');
      } catch (e) { console.warn('[sandbox] PPT 图表渲染失败', e); return null; }
    },

    /** 生成 Word 文档(.docx)：服务器优先 → 浏览器降级 */
    async genWord(opts) {
      opts = opts || {};
      // 服务器优先：用 python-docx 生成更完整的 .docx
      if (this.serverAvailable) {
        const sr = await this.serverGenWord(opts);
        if (sr.ok) return sr;
        console.warn('[sandbox] 服务器 Word 生成失败，降级浏览器:', sr.error);
      }
      const title = opts.title || '文档';
      const blocks = this._parseContentToBlocks(opts.content, opts.blocks, title, opts.meta);
      const docxLib = await this.loadDocx();
      let blob, ext;
      if (docxLib) {
        blob = await this._blocksToDocxBlob(blocks, docxLib, title);
        ext = 'docx';
      } else {
        const html = this._blocksToHTML(blocks);
        blob = new Blob(['\ufeff', html], { type: 'application/msword' });
        ext = 'doc';
      }
      const filename = this._safeFilename(opts.filename || title, ext);
      const filePath = this._buildPath('教案', opts.filename || title, ext);
      const previewText = typeof opts.content === 'string' ? opts.content : (opts.title || title) + '\n\n' + (Array.isArray(opts.blocks) ? opts.blocks.map((b) => b.text || (b.items || []).join('\n')).join('\n') : '');
      const mimeType = ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/msword';
      await this.writeFile(filePath, blob, { type: mimeType, previewText });
      return { ok: true, data: { path: filePath, filename, blocks: blocks.length, format: ext } };
    },

    /** 将 blocks 转为 docx Blob（docx 库 v8.x API） */
    async _blocksToDocxBlob(blocks, docxLib, title) {
      const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle } = docxLib;
      const self = this;
      const children = [];
      children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE, spacing: { after: 240 } }));
      // 将内联 Markdown runs 转为 docx TextRun 数组
      function runsToDocx(runs, baseSize) {
        return runs.map(function (r) {
          return new TextRun({
            text: r.text,
            font: r.font || 'Microsoft YaHei',
            size: baseSize || 24,
            bold: !!r.bold,
            italics: !!r.italics,
            strike: !!r.strike,
            color: r.color || undefined,
          });
        });
      }
      blocks.forEach(function (b) {
        if (b.type === 'h2') {
          children.push(new Paragraph({ text: self._latexToUnicode(b.text || ''), heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } }));
        } else if (b.type === 'h3') {
          children.push(new Paragraph({ text: self._latexToUnicode(b.text || ''), heading: HeadingLevel.HEADING_3, spacing: { before: 180, after: 100 } }));
        } else if (b.type === 'list') {
          (b.items || []).forEach(function (item) {
            var runs = self._parseInlineMarkdown(item);
            var docxRuns = [new TextRun({ text: '\u2022 ', font: 'Microsoft YaHei', size: 24 })];
            docxRuns = docxRuns.concat(runsToDocx(runs, 24));
            children.push(new Paragraph({ children: docxRuns, spacing: { after: 60 } }));
          });
        } else if (b.type === 'html' && (b.text || '').startsWith('<table')) {
          var table = self._htmlTableToDocx(b.text, docxLib);
          if (table) children.push(table);
        } else {
          var text = b.text || (typeof b === 'string' ? b : '');
          var runs = self._parseInlineMarkdown(text);
          children.push(new Paragraph({ children: runsToDocx(runs, 24), spacing: { after: 120 } }));
        }
      });
      const doc = new Document({
        styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 24 } } } },
        sections: [{ properties: {}, children: children.length ? children : [new Paragraph({ text: title })] }],
      });
      return await Packer.toBlob(doc);
    },

    /** HTML 表格字符串转 docx Table */
    _htmlTableToDocx(html, docxLib) {
      const self = this;
      const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, BorderStyle } = docxLib;
      try {
        const trs = [];
        const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let m;
        while ((m = trRe.exec(html)) !== null) trs.push(m[1]);
        if (!trs.length) return null;
        const rows = trs.map((tr) => {
          const cells = [];
          const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
          let cm;
          while ((cm = tdRe.exec(tr)) !== null) cells.push(self._latexToUnicode(cm[1].replace(/<[^>]+>/g, '').trim()));
          return cells;
        }).filter((r) => r.length);
        if (!rows.length) return null;
        const colCount = Math.max.apply(null, rows.map((r) => r.length));
        const bStyle = { style: BorderStyle.SINGLE, size: 1, color: '999999' };
        const docxRows = rows.map((cells, ri) => {
          const tcs = [];
          for (let ci = 0; ci < colCount; ci++) {
            tcs.push(new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: cells[ci] || '', font: 'Microsoft YaHei', size: 22, bold: ri === 0 })] })],
              borders: { top: bStyle, bottom: bStyle, left: bStyle, right: bStyle },
              shading: ri === 0 ? { fill: 'F3EEE4' } : undefined,
            }));
          }
          return new TableRow({ children: tcs });
        });
        return new Table({ rows: docxRows, width: { size: 100, type: WidthType.PERCENTAGE } });
      } catch (e) { console.warn('[sandbox] HTML 表格转 docx 失败', e); return null; }
    },

    /** 将 Markdown 文本解析为结构化 blocks（自动识别标题、列表、段落） */
    _parseContentToBlocks(content, blocks, title, meta) {
      // 如果有 blocks 且是数组，直接用
      if (Array.isArray(blocks) && blocks.length > 0) return blocks;
      // 如果有 content 字符串，解析 Markdown
      if (typeof content === 'string' && content.trim()) {
        const lines = content.split('\n');
        const result = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          // Markdown 标题：### H3, ## H2, # H1
          const h1 = line.match(/^#\s+(.+)/);
          const h2 = line.match(/^##\s+(.+)/);
          const h3 = line.match(/^###\s+(.+)/);
          if (h2) { result.push({ type: 'h2', text: h2[1].trim() }); continue; }
          if (h3) { result.push({ type: 'h3', text: h3[1].trim() }); continue; }
          if (h1) { result.push({ type: 'h2', text: h1[1].trim() }); continue; }
          // 无序列表：- 或 * 开头
          if (line.match(/^[-*]\s+/)) {
            // 收集连续的列表项
            const items = [];
            while (i < lines.length && lines[i].trim().match(/^[-*]\s+/)) {
              items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
              i++;
            }
            i--; // 回退一行（for 循环会 i++）
            result.push({ type: 'list', items });
            continue;
          }
          // 有序列表：1. 2. 开头
          if (line.match(/^\d+\.\s+/)) {
            const items = [];
            while (i < lines.length && lines[i].trim().match(/^\d+\.\s+/)) {
              items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
              i++;
            }
            i--;
            result.push({ type: 'list', items });
            continue;
          }
          // 表格行：| ... |
          if (line.startsWith('|') && i + 1 < lines.length && lines[i + 1].trim().match(/^\|[\s-:|]+\|/)) {
            // 收集表格 HTML
            const tableRows = [];
            while (i < lines.length && lines[i].trim().startsWith('|')) {
              tableRows.push(lines[i].trim());
              i++;
            }
            i--;
            const html = this._markdownTableToHTML(tableRows);
            result.push({ type: 'html', text: html });
            continue;
          }
          // 普通段落
          result.push({ type: 'text', text: line });
        }
        return result;
      }
      // 都没有，返回空
      return [];
    },

    /** 解析内联 Markdown 标记为 TextRun 参数数组
     * 支持：**粗体**、*斜体*、`行内代码`、~~删除线~~
     * 返回 [{text, bold, italics, strike, font, color}, ...]
     */
    /**
     * LaTeX 公式 → Unicode 可读文本（用于 Word/PPT 文档，消除乱码）
     * 将 $...$ / $$...$$ / \[...\] / \(...\) 内的 LaTeX 转为 Unicode 数学符号
     */
    _latexToUnicode(text) {
      if (!text) return text;
      var s = String(text);
      var GREEK = { alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ε',zeta:'ζ',eta:'η',theta:'θ',iota:'ι',kappa:'κ',lambda:'λ',mu:'μ',nu:'ν',xi:'ξ',pi:'π',rho:'ρ',sigma:'σ',tau:'τ',upsilon:'υ',phi:'φ',chi:'χ',psi:'ψ',omega:'ω',Gamma:'Γ',Delta:'Δ',Theta:'Θ',Lambda:'Λ',Xi:'Ξ',Pi:'Π',Sigma:'Σ',Phi:'Φ',Psi:'Ψ',Omega:'Ω',varepsilon:'ε',varphi:'φ',varpi:'ϖ',varrho:'ϱ',varsigma:'ς',vartheta:'ϑ' };
      var SYM = { times:'×',cdot:'·',div:'÷',pm:'±',mp:'∓',leq:'≤',le:'≤',geq:'≥',ge:'≥',neq:'≠',ne:'≠',approx:'≈',equiv:'≡',sim:'∼',simeq:'≃',propto:'∝',infty:'∞',partial:'∂',nabla:'∇',forall:'∀',exists:'∃',in:'∈',notin:'∉',subset:'⊂',supset:'⊃',subseteq:'⊆',supseteq:'⊇',cup:'∪',cap:'∩',emptyset:'∅',varnothing:'∅',wedge:'∧',vee:'∨',neg:'¬',oplus:'⊕',otimes:'⊗',odot:'⊙',star:'⋆',circ:'∘',bullet:'•',ldots:'…',cdots:'⋯',vdots:'⋮',ddots:'⋱',to:'→',rightarrow:'→',leftarrow:'←',Rightarrow:'⇒',Leftarrow:'⇐',leftrightarrow:'↔',Leftrightarrow:'⇔',mapsto:'↦',uparrow:'↑',downarrow:'↓',angle:'∠',triangle:'△',square:'□',diamond:'◇',perp:'⊥',parallel:'∥',degree:'°',prime:'′',hbar:'ℏ',ell:'ℓ',Re:'ℜ',Im:'ℑ',aleph:'ℵ',quad:' ',qquad:'  ',text:' ',mathrm:' ',mathbf:' ',mathit:' ',mathsf:' ',mathcal:' ',mathbb:' ',displaystyle:'',textstyle:'',scriptstyle:'' };
      var SUP = { '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻','=':'⁼','(':'⁽',')':'⁾',n:'ⁿ',i:'ⁱ',x:'ˣ',y:'ʸ' };
      var SUB = { '0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉','+':'₊','-':'₋','=':'₌','(':'₍',')':'₎',a:'ₐ',e:'ₑ',h:'ₕ',i:'ᵢ',j:'ⱼ',k:'ₖ',l:'ₗ',m:'ₘ',n:'ₙ',o:'ₒ',p:'ₚ',r:'ᵣ',s:'ₛ',t:'ₜ',u:'ᵤ',v:'ᵥ',x:'ₓ' };
      function conv(math) {
        var r = math;
        // \frac{a}{b} → a/b
        r = r.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, function (_, a, b) { return (a.length <= 3 ? a : '(' + a + ')') + '/' + (b.length <= 3 ? b : '(' + b + ')'); });
        // \sqrt{x} → √x
        r = r.replace(/\\sqrt\{([^{}]*)\}/g, '√$1');
        r = r.replace(/\\sqrt\[([^\]]*)\]\{([^{}]*)\}/g, '$1√$2');
        // \text{...} / \mathrm{...} → 内容
        r = r.replace(/\\(?:text|mathrm|mathbf|mathit|mathsf|mathcal|mathbb)\{([^{}]*)\}/g, '$1');
        // 上标 ^{...} 或 ^x
        r = r.replace(/\^\{([^{}]*)\}/g, function (_, c) { var out = ''; for (var i = 0; i < c.length; i++) out += (SUP[c[i]] || c[i]); return out; });
        r = r.replace(/\^([A-Za-z0-9])/g, function (_, c) { return SUP[c] || ('^' + c); });
        // 下标 _{...} 或 _x
        r = r.replace(/_\{([^{}]*)\}/g, function (_, c) { var out = ''; for (var i = 0; i < c.length; i++) out += (SUB[c[i]] || c[i]); return out; });
        r = r.replace(/_([A-Za-z0-9])/g, function (_, c) { return SUB[c] || ('_' + c); });
        // \left \right 定界符（仅匹配后跟定界符的情况，不破坏 \rightarrow 等命令）
        r = r.replace(/\\left(?=[(\[{|.\\])/g, '').replace(/\\right(?=[)\]}|.\\])/g, '');
        r = r.replace(/\\[|]/g, '‖');
        // 希腊字母
        Object.keys(GREEK).forEach(function (k) { r = r.replace(new RegExp('\\\\' + k + '(?![A-Za-z])', 'g'), GREEK[k]); });
        // 符号
        Object.keys(SYM).forEach(function (k) { r = r.replace(new RegExp('\\\\' + k + '(?![A-Za-z])', 'g'), SYM[k]); });
        // 清理残余
        r = r.replace(/\\[,;!]/g, ' ').replace(/\\ /g, ' ');
        r = r.replace(/\\\\/g, '\n');
        r = r.replace(/[{}]/g, '');
        r = r.replace(/\\[A-Za-z]+/g, '');
        r = r.replace(/\s+/g, ' ').trim();
        return r;
      }
      // 块级 $$...$$ 和 \[...\]
      s = s.replace(/\$\$([\s\S]*?)\$\$/g, function (_, f) { return conv(f.trim()); });
      s = s.replace(/\\\[([\s\S]*?)\\\]/g, function (_, f) { return conv(f.trim()); });
      // 行内 $...$ 和 \(...\)
      s = s.replace(/\$([^\$\n]+?)\$/g, function (_, f) { return conv(f.trim()); });
      s = s.replace(/\\\(([\s\S]*?)\\\)/g, function (_, f) { return conv(f.trim()); });
      return s;
    },

    _parseInlineMarkdown(text) {
      if (!text) return [{ text: '' }];
      var s = this._latexToUnicode(String(text));
      var runs = [];
      var regex = /(\*\*(.+?)\*\*|\*([^*]+?)\*|`([^`]+?)`|~~([^~]+?)~~)/g;
      var lastIndex = 0;
      var m;
      while ((m = regex.exec(s)) !== null) {
        if (m.index > lastIndex) {
          runs.push({ text: s.slice(lastIndex, m.index) });
        }
        if (m[2] != null) {
          runs.push({ text: m[2], bold: true });
        } else if (m[3] != null) {
          runs.push({ text: m[3], italics: true });
        } else if (m[4] != null) {
          runs.push({ text: m[4], font: 'Consolas', color: 'C7254E' });
        } else if (m[5] != null) {
          runs.push({ text: m[5], strike: true });
        }
        lastIndex = m.index + m[0].length;
      }
      if (lastIndex < s.length) {
        runs.push({ text: s.slice(lastIndex) });
      }
      return runs.length ? runs : [{ text: s }];
    },

    /** 将 blocks 转为 HTML（用于 Word .doc 生成） */
    _blocksToHTML(blocks) {
      var self = this;
      let html = '<html><head><meta charset="utf-8"></head><body style="font-family:"Microsoft YaHei","SimSun",sans-serif;line-height:1.8;color:#1a1a1a;">';
      blocks.forEach(function (b) {
        if (b.type === 'h2') html += '<h2 style="color:#345042;font-size:18px;margin:16px 0 8px;">' + self._inlineMdToHTML(b.text || '') + '</h2>';
        else if (b.type === 'h3') html += '<h3 style="color:#2d5f4e;font-size:15px;margin:12px 0 6px;">' + self._inlineMdToHTML(b.text || '') + '</h3>';
        else if (b.type === 'list') html += '<ul style="margin:4px 0 8px 20px;">' + (b.items || []).map(function (i) { return '<li style="margin:2px 0;">' + self._inlineMdToHTML(i) + '</li>'; }).join('') + '</ul>';
        else if (b.type === 'html') html += b.text || '';
        else html += '<p style="margin:4px 0;">' + self._inlineMdToHTML(b.text || (typeof b === 'string' ? b : '')) + '</p>';
      });
      html += '</body></html>';
      return html;
    },

    /** 将内联 Markdown 标记转为 HTML 标签（先转义再还原格式标签） */
    _inlineMdToHTML(text) {
      var s = this._escapeHTML(text);
      s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      s = s.replace(/\*([^*]+?)\*/g, '<i>$1</i>');
      s = s.replace(/`([^`]+?)`/g, '<code>$1</code>');
      s = s.replace(/~~([^~]+?)~~/g, '<del>$1</del>');
      return s;
    },

    /** Markdown 表格转 HTML 表格 */
    _markdownTableToHTML(rows) {
      if (!rows || rows.length < 2) return '';
      const parseRow = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const headers = parseRow(rows[0]);
      let html = '<table style="border-collapse:collapse;width:100%;margin:8px 0;">';
      html += '<tr>' + headers.map((h) => '<th style="border:1px solid #999;padding:6px 10px;background:#f3eee4;font-weight:600;">' + this._escapeHTML(h) + '</th>').join('') + '</tr>';
      for (let i = 2; i < rows.length; i++) { // 跳过分隔行
        const cells = parseRow(rows[i]);
        html += '<tr>' + cells.map((c) => '<td style="border:1px solid #ddd;padding:6px 10px;">' + this._escapeHTML(c) + '</td>').join('') + '</tr>';
      }
      html += '</table>';
      return html;
    },

    _escapeHTML(s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },

    /** 安全文件名：去除已有后缀，添加指定后缀 */
    /** HTML 转义（_escapeHTML 别名，两种写法在文件内均有引用） */
    _escapeHtml(s) {
      return this._escapeHTML(s);
    },

    /** 简易 Markdown → HTML 转换（支持标题/列表/表格/段落/代码块，保留 LaTeX 公式原样） */
    _markdownToHtml(md) {
      if (!md) return '';
      const lines = String(md).split('\n');
      let html = '';
      let inList = false;
      let inCode = false;
      let codeBuf = [];
      let tableBuf = [];
      let inTable = false;
      const flushList = () => { if (inList) { html += '</ul>'; inList = false; } };
      const flushTable = () => {
        if (inTable && tableBuf.length) {
          html += '<table>';
          tableBuf.forEach((row, ri) => {
            html += '<tr>' + row.map((c) => '<' + (ri === 0 ? 'th' : 'td') + '>' + c + '</' + (ri === 0 ? 'th' : 'td') + '>').join('') + '</tr>';
          });
          html += '</table>';
          tableBuf = [];
          inTable = false;
        }
      };
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // 代码块
        if (line.match(/^```/)) {
          if (inCode) { html += '<pre><code>' + this._escapeHtml(codeBuf.join('\n')) + '</code></pre>'; codeBuf = []; inCode = false; }
          else { flushList(); flushTable(); inCode = true; }
          continue;
        }
        if (inCode) { codeBuf.push(line); continue; }
        // 分隔线
        if (line.match(/^---+$/)) { flushList(); flushTable(); html += '<hr>'; continue; }
        // 标题
        const h3 = line.match(/^###\s+(.+)/);
        const h2 = line.match(/^##\s+(.+)/);
        const h1 = line.match(/^#\s+(.+)/);
        if (h1) { flushList(); flushTable(); html += '<h1>' + h1[1].trim() + '</h1>'; continue; }
        if (h2) { flushList(); flushTable(); html += '<h2>' + h2[1].trim() + '</h2>'; continue; }
        if (h3) { flushList(); flushTable(); html += '<h3>' + h3[1].trim() + '</h3>'; continue; }
        // 表格
        if (line.match(/^\|.*\|$/)) {
          flushList();
          const cells = line.split('|').slice(1, -1).map((c) => c.trim());
          // 跳过分隔行 |---|---|
          if (cells.every((c) => c.match(/^[-:]+$/))) continue;
          inTable = true;
          tableBuf.push(cells.map((c) => this._escapeHtml(c)));
          continue;
        } else if (inTable) { flushTable(); }
        // 列表
        if (line.match(/^[-*]\s+/)) {
          if (!inList) { html += '<ul>'; inList = true; }
          html += '<li>' + this._escapeHtml(line.replace(/^[-*]\s+/, '').trim()) + '</li>';
          continue;
        } else if (inList) { flushList(); }
        // 空行
        if (!line.trim()) { flushList(); flushTable(); continue; }
        // 普通段落（保留 $...$ 和 $$...$$ 公式原样，KaTeX 会渲染）
        html += '<p>' + this._escapeHtml(line.trim()) + '</p>';
      }
      flushList(); flushTable();
      if (inCode && codeBuf.length) html += '<pre><code>' + this._escapeHtml(codeBuf.join('\n')) + '</code></pre>';
      return html;
    },

    _safeFilename(name, ext) {
      let s = String(name || '文档').trim();
      // 去除可能已有的目录前缀（如"教案/xxx"）和后缀
      s = s.replace(/^(教案|课件|学案|量规|大单元|分层|试题|临时)\//, '');
      // 去除已有的任意后缀
      s = s.replace(/\.(docx?|pptx?|xlsx?|pdf|md|txt|html?|csv)$/i, '');
      // 去除非法字符
      s = s.replace(/[\\/:*?"<>|]/g, '_');
      return s + '.' + ext;
    },

    /** 构建虚拟文件路径，避免目录前缀重复 */
    _buildPath(dir, filename, ext) {
      const safe = this._safeFilename(filename, ext);
      // 如果 filename 已包含目录（如"教案/xxx"），先提取纯文件名
      const parts = safe.split('/');
      const justName = parts[parts.length - 1];
      return dir + '/' + justName;
    },

    /** 生成 Excel（服务器优先 → SheetJS 降级） */
    async genExcel(opts) {
      opts = opts || {};
      if (this.serverAvailable) {
        const sr = await this.serverGenExcel(opts);
        if (sr.ok) return sr;
        console.warn('[sandbox] 服务器 Excel 生成失败，降级浏览器:', sr.error);
      }
      const XLSX = await this.loadXlsx();
      if (!XLSX) return { ok: false, error: 'SheetJS 加载失败（可调用 download_library 工具当场下载 xlsx 库后重试）' };
      const ws = XLSX.utils.aoa_to_sheet(opts.rows || []);
      // 列宽自适应
      const cols = (opts.rows && opts.rows.length ? opts.rows[0].length : 0);
      ws['!cols'] = Array.from({ length: cols }, () => ({ wch: 18 }));
      if (opts.freezeFirstRow) ws['!freeze'] = { xSplit: '0', ySplit: '1', topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, opts.sheetName || 'Sheet1');
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const filename = this._safeFilename(opts.filename || '表格', 'xlsx');
      const dir = opts.dir || '量规';
      const filePath = this._buildPath(dir, opts.filename || '表格', 'xlsx');
      // 预览用 Markdown 表格
      const rows = opts.rows || [];
      let previewText = '';
      if (rows.length) {
        const lines = rows.map((r) => '| ' + (r || []).map((c) => String(c == null ? '' : c).replace(/\|/g, '\\|')).join(' | ') + ' |');
        if (lines.length >= 2) lines.splice(1, 0, '| ' + Array(rows[0].length).fill('---').join(' | ') + ' |');
        previewText = lines.join('\n');
      }
      await this.writeFile(filePath, blob, { type: blob.type, previewText });
      return { ok: true, data: { path: filePath, filename } };
    },

    /** 生成 PDF（服务器优先 → jsPDF 降级） */
    async genPDF(opts) {
      opts = opts || {};
      if (this.serverAvailable) {
        const sr = await this.serverGenPDF(opts);
        if (sr.ok) return sr;
        console.warn('[sandbox] 服务器 PDF 生成失败，降级浏览器:', sr.error);
      }
      const jsPDF = await this.loadPdf();
      if (!jsPDF) return { ok: false, error: 'jsPDF 加载失败（可调用 download_library 工具当场下载 pdf 库后重试）' };
      const PDF = jsPDF.jsPDF || jsPDF;
      // jsPDF 默认无中文字体，采用 HTML 内容 + 浏览器打印的方案更可靠
      // 这里提供纯文本 PDF 生成（英文/数字），中文内容走 printHTML
      const doc = new PDF({ unit: 'pt', format: 'a4' });
      const lines = (opts.text || '').split('\n');
      let y = 50;
      doc.setFontSize(opts.fontSize || 12);
      lines.forEach((ln) => {
        if (y > 800) { doc.addPage(); y = 50; }
        doc.text(ln, 40, y); y += opts.lineHeight || 18;
      });
      const blob = doc.output('blob');
      const filename = this._safeFilename(opts.filename || '文档', 'pdf');
      const filePath = this._buildPath('教案', opts.filename || '文档', 'pdf');
      const previewText = opts.text || '';
      await this.writeFile(filePath, blob, { type: 'application/pdf', previewText });
      return { ok: true, data: { path: filePath, filename } };
    },

    /** 用 HTML 渲染并触发浏览器打印为 PDF（中文友好，复用现有导出逻辑风格）。
     *  改进：同时将 HTML 保存到虚拟文件系统，使产物面板可展示和下载。
     *  数学公式用 KaTeX 渲染，支持 $...$ 和 $$...$$ 语法。
     */
    async printHTML(html, title, opts) {
      opts = opts || {};
      const fullTitle = title || '文档';
      const katexCss = this._vendorUrl('teacher-agent-sandbox/vendor/katex/katex.min.css', 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css');
      const katexJs = this._vendorUrl('teacher-agent-sandbox/vendor/katex/katex.min.js', 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js');
      const katexAuto = this._vendorUrl('teacher-agent-sandbox/vendor/katex/auto-render.min.js', 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js');
      // 构建完整 HTML 文档
      const fullHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + fullTitle + '</title>'
        + '<link rel="stylesheet" href="' + katexCss + '">'
        + '<style>body{font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif;line-height:1.8;color:#1a1a1a;max-width:820px;margin:0 auto;padding:40px;}'
        + 'h1{color:#345042;border-bottom:2px solid #5e9882;padding-bottom:8px;}h2{color:#2d5f4e;}h3{color:#3d5f50;}'
        + 'table{border-collapse:collapse;width:100%;}th,td{border:1px solid #ddd;padding:8px;}th{background:#f3eee4;}'
        + 'code{background:#f5f5f5;padding:2px 6px;border-radius:3px;}pre{background:#f5f5f5;padding:12px;border-radius:8px;overflow-x:auto;}'
        + '.bar{position:fixed;top:16px;right:16px;}.bar button{background:#4f7a66;color:#fff;border:none;padding:8px 20px;border-radius:8px;cursor:pointer;}'
        + '@media print{.bar{display:none;}}</style></head><body>'
        + '<div class="bar"><button onclick="window.print()">打印/保存PDF</button></div>'
        + '<div id="c">' + html + '</div>'
        + '<script src="' + katexJs + '"><\/script>'
        + '<script src="' + katexAuto + '"><\/script>'
        + '<script>renderMathInElement(document.getElementById("c"),{delimiters:[{left:"$$",right:"$$",display:true},{left:"$",right:"$",display:false}],throwOnError:false});<\/script>'
        + '</body></html>';

      // 保存到虚拟文件系统（使产物面板可展示和下载）
      const filePath = this._buildPath('教案', fullTitle, 'html');
      const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
      // 预览用原始 Markdown（如果传入的是 Markdown 转 HTML 的内容，这里存原始 html 的文本形式）
      const previewText = html.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      await this.writeFile(filePath, blob, { type: 'text/html;charset=utf-8', previewText });

      // 如果不需要打开打印窗口（如纯保存模式），直接返回
      if (opts.saveOnly) {
        return { ok: true, data: { path: filePath, filename: filePath.split('/').pop(), title: fullTitle, mode: 'save' } };
      }

      // 打开打印窗口
      const w = window.open('', '_blank');
      if (!w) {
        // 弹窗被拦截，但文件已保存
        return { ok: true, data: { path: filePath, filename: filePath.split('/').pop(), title: fullTitle, mode: 'save', note: '弹窗被拦截，文件已保存到产物面板，可点击预览' } };
      }
      w.document.write(fullHtml);
      w.document.close();
      return { ok: true, data: { path: filePath, filename: filePath.split('/').pop(), title: fullTitle, mode: 'print' } };
    },

    /**
     * 浏览器端图表生成（Chart.js 4.x 全局已加载）
     * 在离屏 canvas 渲染图表 → 导出 PNG dataURL → 保存到虚拟文件系统
     * 返回 { ok, data: { path, filename, dataUrl } }，dataUrl 可直接嵌入 PPT image 幻灯片
     */
    async _genChartBrowser(opts) {
      var ChartLib = global.Chart;
      if (!ChartLib) return { ok: false, error: 'Chart.js 未加载，无法在浏览器端生成图表' };
      var type = opts.type || 'bar';
      var data = opts.data || {};
      var title = opts.title || '';
      var canvas = document.createElement('canvas');
      var W = 900, H = 560;
      canvas.width = W; canvas.height = H;
      canvas.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
      document.body.appendChild(canvas);
      var COLORS = ['#4F7A66', '#A8814E', '#5B8C7A', '#C4956A', '#3D5F50', '#8B6F47', '#6DA58C', '#D4A574', '#2E4A3E', '#B8956E'];
      var chartType = type;
      if (type === 'scatter') chartType = 'scatter';
      var datasets = [];
      if (data.datasets && Array.isArray(data.datasets)) {
        datasets = data.datasets.map(function (ds, i) {
          var o = Object.assign({}, ds);
          o.borderColor = o.borderColor || COLORS[i % COLORS.length];
          o.backgroundColor = o.backgroundColor || (type === 'pie' || type === 'radar' ? COLORS.map(function (c) { return c + 'CC'; }) : COLORS[i % COLORS.length] + '99');
          if (type === 'bar' || type === 'line') { o.backgroundColor = o.backgroundColor || COLORS[i % COLORS.length] + '99'; }
          return o;
        });
      } else if (data.values && Array.isArray(data.values)) {
        datasets = [{ label: data.label || title || '数据', data: data.values, backgroundColor: type === 'pie' ? COLORS.slice(0, data.values.length).map(function (c) { return c + 'CC'; }) : COLORS[0] + '99', borderColor: COLORS[0], borderWidth: 1 }];
      }
      var chartData = { labels: data.labels || [], datasets: datasets };
      var options = {
        responsive: false,
        animation: false,
        devicePixelRatio: 2,
        plugins: {
          title: title ? { display: true, text: title, font: { size: 20, family: 'Microsoft YaHei' }, color: '#403A30' } : { display: false },
          legend: { labels: { font: { family: 'Microsoft YaHei', size: 13 }, color: '#403A30' } },
        },
        scales: (type === 'pie' || type === 'radar' || type === 'doughnut') ? {} : {
          x: { ticks: { font: { family: 'Microsoft YaHei', size: 12 }, color: '#666' }, grid: { color: '#eee' } },
          y: { ticks: { font: { family: 'Microsoft YaHei', size: 12 }, color: '#666' }, grid: { color: '#eee' } },
        },
      };
      try {
        var chart = new ChartLib(canvas, { type: chartType, data: chartData, options: options });
        chart.render();
        var dataUrl = canvas.toDataURL('image/png');
        chart.destroy();
        document.body.removeChild(canvas);
        // 保存 PNG 到虚拟文件系统
        var filename = this._safeFilename(opts.filename || title || '图表', 'png');
        var filePath = this._buildPath('临时', opts.filename || title || '图表', 'png');
        var b64 = dataUrl.split(',')[1];
        var bin = atob(b64);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        var blob = new Blob([arr], { type: 'image/png' });
        await this.writeFile(filePath, blob, { type: 'image/png' });
        return { ok: true, data: { path: filePath, filename: filename, dataUrl: dataUrl, width: W, height: H } };
      } catch (e) {
        try { document.body.removeChild(canvas); } catch (_) {}
        return { ok: false, error: '图表生成失败: ' + (e.message || String(e)) };
      }
    },

    /* ============ 工具注册 ============ */
    _registerTools() {
      const T = global.AgentTools;
      if (!T) return;
      const self = this;
      T.register('run_python', {
        category: 'sandbox',
        description: '在沙箱中执行 Python 代码（Pyodide），返回 stdout/stderr/result。可选安装 micropip 包',
        timeout: 30000,
        parameters: { type: 'object', properties: { code: { type: 'string' }, packages: { type: 'array', items: { type: 'string' } } }, required: ['code'] },
        handler: async (a) => self.runPython(a.code, { packages: a.packages }),
      });
      T.register('gen_ppt', {
        category: 'document',
        description: '生成 PPT 课件(.pptx)，传入 slides 数组（每项含 type/title/subtitle/bullets/content）',
        parameters: { type: 'object', properties: { filename: { type: 'string' }, slides: { type: 'array' } }, required: ['slides'] },
        handler: async (a) => self.genPPT(a),
      });
      T.register('gen_word', {
        category: 'document',
        description: '生成 Word 文档(.docx)。传入 content(Markdown 字符串，推荐) 或 blocks(结构化数组)。自动解析标题/列表/表格，生成真正的 .docx 格式',
        parameters: { type: 'object', properties: { filename: { type: 'string' }, title: { type: 'string' }, meta: { type: 'string' }, content: { type: 'string', description: 'Markdown 格式的文档正文，推荐用此参数' }, blocks: { type: 'array', description: '结构化块，每项含 type(h2/h3/list/text/html) 和 text/items' } }, required: ['title'] },
        handler: async (a) => self.genWord(a),
      });
      T.register('gen_excel', {
        category: 'document',
        description: '生成 Excel(.xlsx)，传入 rows(二维数组)、sheetName、freezeFirstRow',
        parameters: { type: 'object', properties: { filename: { type: 'string' }, rows: { type: 'array' }, sheetName: { type: 'string' }, dir: { type: 'string' } }, required: ['rows'] },
        handler: async (a) => self.genExcel(a),
      });
      T.register('gen_pdf', {
        category: 'document',
        description: '生成 PDF（纯文本，jsPDF）。中文富文本请用 print_html 打印为 PDF',
        parameters: { type: 'object', properties: { filename: { type: 'string' }, text: { type: 'string' } }, required: ['text'] },
        handler: async (a) => self.genPDF(a),
      });
      T.register('print_html', {
        category: 'document',
        description: '渲染 HTML 并保存为 .html 文件（支持 LaTeX 公式用 KaTeX 渲染、表格、代码高亮）。同时打开打印窗口。推荐用于含数学公式的试卷/教案。支持 $...$ 和 $$...$$ 公式语法',
        parameters: {
          type: 'object',
          properties: {
            html: { type: 'string', description: 'HTML 内容（可含 LaTeX 公式 $...$/$$...$$、表格、列表等）' },
            title: { type: 'string', description: '文档标题（也是文件名）' },
            content: { type: 'string', description: 'Markdown 内容（可选，传入时自动转为 HTML，与 html 二选一）' },
            saveOnly: { type: 'boolean', description: '仅保存不打开打印窗口（默认 false）' },
          },
          required: ['title'],
        },
        handler: async (a) => {
          let html = a.html;
          if (!html && a.content) {
            html = self._markdownToHtml(a.content);
          }
          if (!html) html = '<p>' + self._escapeHtml(a.title || '') + '</p>';
          return await self.printHTML(html, a.title, { saveOnly: a.saveOnly });
        },
      });
      T.register('write_file', {
        category: 'file',
        description: '向沙箱虚拟文件系统写入文件（content 为文本或 Blob）',
        parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        handler: async (a) => self.writeFile(a.path, a.content),
      });
      T.register('read_file', {
        category: 'file',
        description: '读取沙箱虚拟文件系统中的文件',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        handler: async (a) => self.readFile(a.path),
      });
      T.register('list_files', {
        category: 'file',
        description: '列出沙箱文件系统目录',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        handler: async (a) => self.listDir(a.path),
      });
      T.register('download_file', {
        category: 'file',
        description: '下载沙箱中的文件到本地',
        parameters: { type: 'object', properties: { path: { type: 'string' }, filename: { type: 'string' } }, required: ['path'] },
        handler: async (a) => self.download(a.path, a.filename),
      });
      T.register('convert_document', {
        category: 'document',
        description: '文档格式转换（需服务器端沙箱）。支持 md↔docx↔html↔pdf, pptx→pdf, xlsx→pdf 等',
        parameters: { type: 'object', properties: { from_format: { type: 'string' }, to_format: { type: 'string' }, file_content: { type: 'string', description: 'base64编码的文件内容' }, filename: { type: 'string' } }, required: ['from_format', 'to_format', 'file_content', 'filename'] },
        handler: async (a) => self.serverAvailable ? self.serverConvert(a) : { ok: false, error: '文档格式转换需要服务器端沙箱支持' },
      });
      T.register('ocr', {
        category: 'utility',
        description: 'OCR文字识别（需服务器端沙箱）。支持中文(chi_sim)和英文(eng)',
        parameters: { type: 'object', properties: { image: { type: 'string', description: 'base64编码的图片' }, lang: { type: 'string', description: '语言: chi_sim(中文) 或 eng(英文)' } }, required: ['image'] },
        handler: async (a) => self.serverAvailable ? self.serverOCR(a.image, a.lang) : { ok: false, error: 'OCR需要服务器端沙箱支持' },
      });
      T.register('generate_chart', {
        category: 'document',
        description: '生成图表并保存为PNG（服务器优先，无服务器时用浏览器端 Chart.js 渲染）。支持 bar/line/pie/radar/scatter 类型。返回 dataUrl 可嵌入 gen_ppt 的 image 幻灯片',
        parameters: { type: 'object', properties: { type: { type: 'string', description: '图表类型: bar/line/pie/radar/scatter' }, data: { type: 'object', description: '图表数据 {labels:[], datasets:[{label,data:[]}]}' }, title: { type: 'string' }, filename: { type: 'string' } }, required: ['type', 'data'] },
        handler: async (a) => {
          if (self.serverAvailable) {
            var sr = await self.serverGenChart(a);
            if (sr.ok) return sr;
          }
          return await self._genChartBrowser(a);
        },
      });
      T.register('download_library', {
        category: 'sandbox',
        description: '当场下载沙箱缺失的依赖库（多CDN镜像+应用原生下载通道，下载后缓存到本地，离线可复用）。当 gen_ppt/gen_word/gen_excel/gen_pdf/run_python 报告库缺失时，先调用本工具下载对应库再重试',
        parameters: { type: 'object', properties: { library: { type: 'string', description: '库名称：pptx(PPT) / docx(Word) / xlsx(Excel) / pdf(PDF) / python(Pyodide运行时)' } }, required: ['library'] },
        handler: async (a) => {
          const name = String(a.library || '').toLowerCase();
          const alias = { pptx: 'pptx', ppt: 'pptx', docx: 'docx', word: 'docx', xlsx: 'xlsx', excel: 'xlsx', sheetjs: 'xlsx', pdf: 'pdf', python: 'pyodide', pyodide: 'pyodide' };
          const key = alias[name];
          if (!key) return { ok: false, error: '未知库名：' + name + '（可选：pptx / docx / xlsx / pdf / python）' };
          if (key === 'pyodide') {
            const py = await self.loadPython();
            return py ? { ok: true, data: { library: 'python', status: 'ready', message: 'Pyodide Python 运行时已就绪' } }
                      : { ok: false, error: 'Pyodide 下载失败，请检查网络连接' };
          }
          const loader = { pptx: 'loadPptx', docx: 'loadDocx', xlsx: 'loadXlsx', pdf: 'loadPdf' }[key];
          const lib = await self[loader]();
          return lib ? { ok: true, data: { library: key, status: 'ready', message: LIB_SOURCES[key].label + ' 已就绪，可继续生成文档' } }
                     : { ok: false, error: LIB_SOURCES[key].label + ' 所有下载通道均失败，请检查网络连接' };
        },
      });
      T.register('check_sandbox', {
        category: 'utility',
        description: '检查沙箱环境状态：运行模式、服务器是否可用、各依赖库是否就绪、临时文件数量。缺库时可调用 download_library 当场下载',
        parameters: { type: 'object', properties: {} },
        handler: async () => ({
          ok: true,
          data: {
            mode: self._isElectron() ? 'electron-desktop（本地文件存储）' : 'browser（IndexedDB 存储）',
            serverAvailable: self.serverAvailable,
            pyodideReady: !!self.pyodide,
            libsLoaded: self.libsLoaded,
            libStatus: {
              pptx: !!(global.PptxGenJS || global.pptxgen),
              docx: !!global.docx,
              xlsx: !!global.XLSX,
              pdf: !!global.jspdf,
              python: !!self.pyodide,
            },
            downloadChannel: self._isElectron() ? 'Electron 主进程原生下载（不受 CORS 限制）+ 多CDN镜像' : '浏览器 fetch + 多CDN镜像',
            tempFilesInTask: self.taskTempFiles.length,
            hint: '若某库状态为 false，调用 download_library 工具即可当场下载启用',
          },
        }),
      });
    },

    /** 沙箱状态（供 UI 展示） */
    status() {
      return {
        ready: this.ready,
        filesystem: this._isElectron() ? 'electron-local-files' : 'indexeddb',
        python: this.pyodide ? 'ready' : (this.pyLoading ? 'loading' : 'idle'),
        libs: this.libsLoaded,
        rootDirs: ROOT_DIRS,
      };
    },
  };

  global.AgentSandbox = Sandbox;
})(window);
