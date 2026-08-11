/*!
 * main.js - Electron 主进程
 * ------------------------------------------------------------------
 * 创建 BrowserWindow 加载教师端 index.html
 * 处理 IPC 通信：文档读写、列表、删除
 * 管理应用生命周期：启动时加载数据，退出时刷新写入
 */
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;

// 本地访问令牌：随机生成，注入后端（启用 X-Agent-Token 校验）并暴露给前端请求头，
// 防止教师浏览的其他网页跨站调用本机后端。仅本机进程内可见，外部网页拿不到。
const crypto = require('crypto');
if (!process.env.AGENT_API_TOKEN) {
  process.env.AGENT_API_TOKEN = crypto.randomBytes(24).toString('hex');
}

// 数据根目录：开发模式用项目内 data/，打包后用 userData/data/
// （userData 位于 %APPDATA%\教育智能体教师端，卸载重装/升级不丢失用户数据）
const dataRoot = isDev
  ? path.join(__dirname, '..', 'data')
  : path.join(app.getPath('userData'), 'data');

// 前端资源根目录（www）：打包后为 resources/www，开发模式为项目根。
// 外部 www 目录与 asar 分离，用户修改 index.html / js / css / skills / vendor 后重启即生效。
const wwwRoot = isDev
  ? path.join(__dirname, '..')
  : path.join(process.resourcesPath, 'www');

// 确保 5 个模块文件夹存在，并初始化数据库容器
const MODULES = ['备课', '学生学情分析', '学生提问', '智能组卷', '题目批改'];
for (const mod of MODULES) {
  const modDir = path.join(dataRoot, mod);
  fs.mkdirSync(modDir, { recursive: true });
  // 初始化键值数据库容器（store.json，初始为空对象）
  const storeFile = path.join(modDir, 'store.json');
  if (!fs.existsSync(storeFile)) {
    fs.writeFileSync(storeFile, '{}', 'utf-8');
  }
  // 初始化文档存储目录
  fs.mkdirSync(path.join(modDir, 'documents'), { recursive: true });
}

// 设置环境变量供 preload 读取
process.env.DATA_ROOT = dataRoot;
process.env.RESOURCE_ROOT = wwwRoot;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    icon: path.join(wwwRoot, '教育大模型logo.png'),
    title: '教育智能体·教师端',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
    }
  });

  // 优先加载外部 www/index.html（用户修改文件后重启即生效）；缺失时回退 asar 内置版本
  const externalIndex = path.join(wwwRoot, 'index.html');
  if (isDev || fs.existsSync(externalIndex)) {
    mainWindow.loadFile(externalIndex);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
  }

  // 外部链接在系统浏览器打开：严格限定 http/https 协议
  mainWindow.webContents.setWindowOpenHandler(function (details) {
    try {
      const u = new URL(details.url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        shell.openExternal(u.href);
      }
    } catch (e) { /* 非法 URL 忽略 */ }
    // 一律 deny：不在应用内新开窗口，也不放行 file:// 等其他协议
    return { action: 'deny' };
  });

  mainWindow.on('closed', function () { mainWindow = null; });
}

// ==================== 本地 Python 后端（前后端分离） ====================
// 应用启动时自动拉起 backend/server.py（http://127.0.0.1:8767）。
// 前端 Agent 模式优先走后端；后端未启动/启动失败时自动降级到前端内置工作流，
// 不影响任何功能。Python 环境缺失时静默跳过（可通过 AGENT_PYTHON 指定解释器）。
let backendProc = null;
let backendLogPath = '';
function startBackend() {
  if (backendProc) return;
  try {
    // 开发模式：项目根 backend/；打包后：resources/backend/
    const backendDir = isDev
      ? path.join(__dirname, '..', 'backend')
      : path.join(process.resourcesPath, 'backend');
    const serverPy = path.join(backendDir, 'server.py');
    if (!fs.existsSync(serverPy)) {
      console.log('[backend] 未找到 backend/server.py，跳过自动启动');
      return;
    }
    // 解释器候选：环境变量 > python > python3 > py -3 > 常见安装路径
    const candidates = [];
    if (process.env.AGENT_PYTHON) candidates.push({ cmd: process.env.AGENT_PYTHON, args: [] });
    candidates.push(
      { cmd: 'python', args: [] },
      { cmd: 'python3', args: [] },
      { cmd: 'py', args: ['-3'] },
      { cmd: 'D:\\Python\\Python312\\python.exe', args: [] },
      { cmd: 'C:\\Python312\\python.exe', args: [] },
      { cmd: 'C:\\Python310\\python.exe', args: [] }
    );
    // 去重
    const seen = {};
    const uniq = candidates.filter(function (c) {
      const k = c.cmd + '|' + c.args.join(' ');
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });

    backendLogPath = path.join(backendDir, 'backend.log');
    const { spawn } = require('child_process');
    const fsLog = function (msg) {
      try { fs.appendFileSync(backendLogPath, '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch (e) { /* 忽略 */ }
    };
    fsLog('尝试启动后端，server=' + serverPy);

    let attemptIdx = 0;
    let depsInstallAttempted = false;

    // 用候选解释器拉起 server.py
    function spawnServer(c) {
      const args = c.args.concat(['-B', serverPy]);
      fsLog('启动: ' + c.cmd + ' ' + args.join(' '));
      let proc;
      try {
        proc = spawn(c.cmd, args, {
          cwd: backendDir,
          windowsHide: true,
          env: Object.assign({}, process.env, {
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
            AGENT_API_TOKEN: process.env.AGENT_API_TOKEN,
          }),
        });
      } catch (e) {
        fsLog('spawn 异常: ' + e.message);
        tryNext();
        return;
      }
      // 就绪窗口：1.5 秒内非正常退出则尝试下一个解释器候选
      let settled = false;
      proc.stderr.on('data', function (d) { fsLog('stderr: ' + String(d).slice(0, 500)); });
      proc.stdout.on('data', function (d) { fsLog('stdout: ' + String(d).slice(0, 500)); });
      proc.on('error', function (e) {
        fsLog('启动失败: ' + e.message);
        if (!settled) { settled = true; tryNext(); }
      });
      proc.on('exit', function (code) {
        fsLog('进程退出 code=' + code);
        if (backendProc === proc) backendProc = null;
        // 就绪前异常退出（且非主动 kill）→ 回退到下一个解释器候选
        if (!settled && code !== 0 && !proc.killed) {
          fsLog('后端就绪前异常退出，尝试下一解释器候选');
          settled = true;
          tryNext();
        }
      });
      backendProc = proc;
      console.log('[backend] 已尝试启动本地智能体后端：' + c.cmd);
      // 给后端 1.5 秒确认存活（若立即退出则尝试下一候选）
      setTimeout(function () {
        settled = true;
        if (proc.exitCode === null && !proc.killed) {
          console.log('[backend] 后端已就绪（http://127.0.0.1:8767）');
        }
      }, 1500);
    }

    function tryNext() {
      if (attemptIdx >= uniq.length) {
        console.warn('[backend] 未找到可用的 Python 解释器，前端将使用内置工作流');
        fsLog('全部解释器尝试失败');
        backendProc = null;
        return;
      }
      const c = uniq[attemptIdx++];
      // 依赖预检：探测 fastapi/uvicorn 是否可导入
      const { execFile } = require('child_process');
      const probeArgs = c.args.concat(['-c', 'import fastapi, uvicorn']);
      execFile(c.cmd, probeArgs, { cwd: backendDir, timeout: 20000 }, function (err) {
        if (!err) { spawnServer(c); return; }
        // 解释器本身不存在 → 直接试下一候选
        if (err && (err.code === 'ENOENT' || /ENOENT/.test(String(err)))) {
          fsLog('解释器不可用: ' + c.cmd);
          tryNext();
          return;
        }
        // 依赖缺失 → 自动安装一次后重试当前候选
        if (!depsInstallAttempted) {
          depsInstallAttempted = true;
          fsLog('后端依赖缺失，尝试自动安装: ' + c.cmd + ' -m pip install -r requirements.txt');
          console.log('[backend] 检测到后端依赖缺失，正在自动安装（可能需要一些时间）…');
          const pipArgs = c.args.concat(['-m', 'pip', 'install', '-r', path.join(backendDir, 'requirements.txt')]);
          const pip = spawn(c.cmd, pipArgs, { cwd: backendDir, windowsHide: true });
          pip.stderr.on('data', function (d) { fsLog('pip: ' + String(d).slice(0, 300)); });
          pip.stdout.on('data', function (d) { fsLog('pip: ' + String(d).slice(0, 300)); });
          pip.on('exit', function () { spawnServer(c); });
          pip.on('error', function () { spawnServer(c); });
          return;
        }
        // 已尝试过安装仍失败 → 试下一候选
        fsLog('依赖安装后仍不可用: ' + c.cmd);
        tryNext();
      });
    }

    // 端口预检：8767 已有兼容后端在运行则直接复用，避免重复 spawn 争抢端口
    const httpPre = require('http');
    const prePort = parseInt(process.env.AGENT_BACKEND_PORT || '8767', 10);
    const preReq = httpPre.get({ host: '127.0.0.1', port: prePort, path: '/api/health', timeout: 2000 }, function (res) {
      if (res.statusCode === 200) {
        console.log('[backend] 检测到已在运行的后端（:' + prePort + '），直接复用');
        fsLog('检测到已在运行的后端，直接复用');
        return;
      }
      tryNext();
    });
    preReq.on('timeout', function () { preReq.destroy(); });
    preReq.on('error', function () { tryNext(); });
  } catch (e) {
    console.warn('[backend] 后端启动异常（忽略，前端降级内置工作流）:', e.message);
  }
}

function stopBackend() {
  if (backendProc) {
    try { backendProc.kill(); } catch (e) { /* 忽略 */ }
    backendProc = null;
  }
}

// 单实例锁：防止双开导致 8767 端口争抢与双写 store.json 互相覆盖
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(function () {
    // 启动本地 Python 后端（失败不影响使用）
    startBackend();
    createWindow();
    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// 应用退出前刷新所有未写入数据
app.on('before-quit', function (event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault();
    let exited = false;
    const finish = function () {
      if (exited) return;
      exited = true;
      stopBackend();
      app.exit(0);
    };
    // 渲染进程卡死时的兜底：4 秒后强制退出，避免应用无法退出
    setTimeout(finish, 4000);
    mainWindow.webContents.executeJavaScript('if(window.electronAPI)window.electronAPI.flushData();')
      .then(finish)
      .catch(finish);
  } else {
    stopBackend();
  }
});

// ==================== IPC: 网络请求（绕过 CORS） ====================
// Electron 主进程不受同源策略限制，可自由发起 HTTP 请求
const https = require('https');
const http = require('http');
const { URL } = require('url');
const zlib = require('zlib');

// ==================== fetch-url 安全辅助 ====================
// 该通道用于抓取公网网页（联网搜索）。为防止被用作 SSRF/内网探测，
// 拒绝回环/私网/链路本地/云元数据等地址；响应体设大小上限防内存撑爆。
const FETCH_MAX_BYTES = 20 * 1024 * 1024; // 20MB

function _isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const ip = h.replace(/^\[|\]$/g, ''); // 去掉 IPv6 方括号
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1' || ip === '::') return true;
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (a === 127) return true;                       // 回环
    if (a === 10) return true;                        // 私网
    if (a === 192 && b === 168) return true;          // 私网
    if (a === 172 && b >= 16 && b <= 31) return true; // 私网
    if (a === 169 && b === 254) return true;          // 链路本地/云元数据
    if (a === 0) return true;
  }
  return false;
}

// 剥离调用方注入的敏感请求头，避免被用来伪造鉴权/Cookie
function _sanitizeHeaders(headers) {
  const BLOCK = ['authorization', 'cookie', 'set-cookie', 'host', 'proxy-authorization', 'x-api-key', 'origin', 'referer'];
  const out = {};
  if (headers && typeof headers === 'object') {
    for (const k of Object.keys(headers)) {
      if (BLOCK.indexOf(k.toLowerCase()) >= 0) continue;
      out[k] = headers[k];
    }
  }
  return out;
}

ipcMain.handle('fetch-url', async function (event, args) {
  return new Promise(function (resolve) {
    try {
      const targetUrl = new URL(args.url);
      // 仅允许 http/https，且拒绝内网/回环/元数据地址
      if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        resolve({ ok: false, error: '仅支持 http/https 协议' });
        return;
      }
      if (_isBlockedHost(targetUrl.hostname)) {
        resolve({ ok: false, error: '禁止访问本机/内网地址' });
        return;
      }
      const lib = targetUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: 'GET',
        headers: Object.assign({
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'Cache-Control': 'max-age=0',
        }, _sanitizeHeaders(args.headers)),
        timeout: args.timeout || 15000,
      };

      const req = lib.request(options, function (res) {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, targetUrl).href;
          if (args.maxRedirect === undefined || args.maxRedirect > 0) {
            resolve({ ok: true, data: { redirect: redirectUrl } });
            return;
          }
        }
        // 根据 content-encoding 解压响应体（搜索引擎普遍启用 gzip/br 压缩）
        const encoding = (res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (encoding === 'gzip') {
          stream = res.pipe(zlib.createGunzip());
        } else if (encoding === 'deflate') {
          stream = res.pipe(zlib.createInflate());
        } else if (encoding === 'br') {
          stream = res.pipe(zlib.createBrotliDecompress());
        }
        const chunks = [];
        let totalBytes = 0;
        let aborted = false;
        stream.on('data', function (chunk) {
          if (aborted) return;
          totalBytes += chunk.length;
          if (totalBytes > FETCH_MAX_BYTES) {
            aborted = true;
            try { req.destroy(); } catch (e) { /* 忽略 */ }
            resolve({ ok: false, error: '响应体过大，已中断（>' + (FETCH_MAX_BYTES / 1024 / 1024) + 'MB）' });
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        stream.on('end', function () {
          if (aborted) return;
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve({ ok: true, data: { content: body, status: res.statusCode, headers: res.headers } });
        });
        stream.on('error', function (e) {
          if (aborted) return;
          resolve({ ok: false, error: '响应解压失败: ' + e.message });
        });
      });

      req.on('error', function (e) {
        resolve({ ok: false, error: e.message });
      });

      req.on('timeout', function () {
        req.destroy();
        resolve({ ok: false, error: '请求超时' });
      });

      req.end();
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
});

// ==================== IPC: 文档操作 ====================

// 文档元数据存取辅助（sidecar .meta.json 文件）
function _metaPath(module, filename) {
  return path.join(dataRoot, module, 'documents', filename + '.meta.json');
}

function _readMeta(module, filename) {
  const mp = _metaPath(module, filename);
  try {
    if (fs.existsSync(mp)) return JSON.parse(fs.readFileSync(mp, 'utf-8'));
  } catch (e) { /* 损坏则忽略 */ }
  return null;
}

function _writeMeta(module, filename, meta) {
  const mp = _metaPath(module, filename);
  try {
    fs.writeFileSync(mp, JSON.stringify(meta, null, 2), 'utf-8');
  } catch (e) { /* 写入失败不阻断 */ }
}

// ==================== 文档路径安全校验（防路径穿越） ====================
// 渲染进程不可信：module 必须在白名单内，filename 只允许纯文件名，
// 且解析后的绝对路径必须仍位于该模块的 documents 目录内。
function _safeModule(module) {
  return MODULES.indexOf(module) >= 0 ? module : null;
}

function _safeFilename(filename) {
  if (typeof filename !== 'string' || !filename) return null;
  // 只取文件名部分，杜绝任何目录分隔符 / 相对跳转
  const base = path.basename(filename);
  if (!base || base === '.' || base === '..') return null;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(base)) return null;
  return base;
}

// 返回 { module, filename, dir, filePath }；任一校验失败返回 null
function _safeDocPath(module, filename) {
  const mod = _safeModule(module);
  const name = _safeFilename(filename);
  if (!mod || !name) return null;
  const dir = path.join(dataRoot, mod, 'documents');
  const filePath = path.resolve(dir, name);
  // 双重保险：resolve 之后仍必须落在 documents 目录内
  if (!filePath.startsWith(path.resolve(dir) + path.sep)) return null;
  return { module: mod, filename: name, dir: dir, filePath: filePath };
}

ipcMain.handle('save-document', async function (event, args) {
  try {
    const loc = _safeDocPath(args && args.module, args && args.filename);
    if (!loc) return { ok: false, error: '非法的模块或文件名' };
    fs.mkdirSync(loc.dir, { recursive: true });
    // args.data 是 ArrayBuffer（通过结构化克隆传输）
    const buffer = Buffer.from(args.data);
    fs.writeFileSync(loc.filePath, buffer);
    // 保存元数据 sidecar
    if (args.meta) _writeMeta(loc.module, loc.filename, args.meta);
    return { ok: true, data: { path: loc.filePath, size: buffer.length } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('load-document', async function (event, args) {
  try {
    const loc = _safeDocPath(args && args.module, args && args.filename);
    if (!loc) return { ok: false, error: '非法的模块或文件名' };
    if (!fs.existsSync(loc.filePath)) return { ok: false, error: '文件不存在' };
    const buffer = fs.readFileSync(loc.filePath);
    // 返回 ArrayBuffer 给渲染进程
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const meta = _readMeta(loc.module, loc.filename);
    return { ok: true, data: { buffer: arrayBuffer, size: buffer.length, meta: meta } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('list-documents', async function (event, args) {
  try {
    const mod = _safeModule(args && args.module);
    if (!mod) return { ok: false, error: '非法的模块名' };
    const dir = path.join(dataRoot, mod, 'documents');
    if (!fs.existsSync(dir)) return { ok: true, data: { files: [] } };
    const files = fs.readdirSync(dir).filter(function (name) {
      // 排除 .meta.json 侧车文件
      return !name.endsWith('.meta.json');
    }).map(function (name) {
      const stat = fs.statSync(path.join(dir, name));
      const meta = _readMeta(mod, name);
      return {
        name: name,
        path: (meta && meta.path) || (mod + '/' + name),
        type: (meta && meta.type) || 'application/octet-stream',
        size: stat.size,
        createdAt: (meta && meta.createdAt) || stat.mtimeMs,
        meta: meta || {}
      };
    });
    return { ok: true, data: { files: files } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('delete-document', async function (event, args) {
  try {
    const loc = _safeDocPath(args && args.module, args && args.filename);
    if (!loc) return { ok: false, error: '非法的模块或文件名' };
    if (fs.existsSync(loc.filePath)) fs.unlinkSync(loc.filePath);
    // 删除侧车元数据文件
    const metaPath = loc.filePath + '.meta.json';
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ==================== IPC: 读取前端资源（www 目录） ====================
// 供技能 SKILL.md / vendor 库等离线加载使用。仅允许读取 www 目录内的文件（防路径穿越）。
ipcMain.handle('read-resource', async function (event, args) {
  try {
    const rel = String(args && args.relPath || '');
    // 规范化并校验：禁止绝对路径、禁止 .. 跳出 www 根
    const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = norm.split('/');
    if (parts.indexOf('..') >= 0 || norm.indexOf(':') >= 0) {
      return { ok: false, error: '非法路径' };
    }
    const filePath = path.join(wwwRoot, norm);
    // 确保解析后的路径仍在 wwwRoot 内
    if (!filePath.startsWith(path.resolve(wwwRoot))) {
      return { ok: false, error: '路径越界' };
    }
    if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + rel };
    const content = fs.readFileSync(filePath, 'utf-8');
    return { ok: true, data: { content: content, path: filePath } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
