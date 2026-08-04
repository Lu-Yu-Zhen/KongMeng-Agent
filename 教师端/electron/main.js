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

  // 外部链接在系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(function (details) {
    if (details.url && details.url.indexOf('http') === 0) {
      shell.openExternal(details.url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', function () { mainWindow = null; });
}

app.whenReady().then(function () {
  createWindow();
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// 应用退出前刷新所有未写入数据
app.on('before-quit', function (event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault();
    mainWindow.webContents.executeJavaScript('if(window.electronAPI)window.electronAPI.flushData();').then(function () {
      app.exit(0);
    }).catch(function () {
      app.exit(0);
    });
  }
});

// ==================== IPC: 网络请求（绕过 CORS） ====================
// Electron 主进程不受同源策略限制，可自由发起 HTTP 请求
const https = require('https');
const http = require('http');
const { URL } = require('url');
const zlib = require('zlib');

ipcMain.handle('fetch-url', async function (event, args) {
  return new Promise(function (resolve) {
    try {
      const targetUrl = new URL(args.url);
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
        }, args.headers || {}),
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
        stream.on('data', function (chunk) { chunks.push(Buffer.from(chunk)); });
        stream.on('end', function () {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve({ ok: true, data: { content: body, status: res.statusCode, headers: res.headers } });
        });
        stream.on('error', function (e) {
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

ipcMain.handle('save-document', async function (event, args) {
  try {
    const dir = path.join(dataRoot, args.module, 'documents');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, args.filename);
    // args.data 是 ArrayBuffer（通过结构化克隆传输）
    const buffer = Buffer.from(args.data);
    fs.writeFileSync(filePath, buffer);
    // 保存元数据 sidecar
    if (args.meta) _writeMeta(args.module, args.filename, args.meta);
    return { ok: true, data: { path: filePath, size: buffer.length } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('load-document', async function (event, args) {
  try {
    const filePath = path.join(dataRoot, args.module, 'documents', args.filename);
    if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
    const buffer = fs.readFileSync(filePath);
    // 返回 ArrayBuffer 给渲染进程
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const meta = _readMeta(args.module, args.filename);
    return { ok: true, data: { buffer: arrayBuffer, size: buffer.length, meta: meta } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('list-documents', async function (event, args) {
  try {
    const dir = path.join(dataRoot, args.module, 'documents');
    if (!fs.existsSync(dir)) return { ok: true, data: { files: [] } };
    const files = fs.readdirSync(dir).filter(function (name) {
      // 排除 .meta.json 侧车文件
      return !name.endsWith('.meta.json');
    }).map(function (name) {
      const stat = fs.statSync(path.join(dir, name));
      const meta = _readMeta(args.module, name);
      return {
        name: name,
        path: (meta && meta.path) || (args.module + '/' + name),
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
    const filePath = path.join(dataRoot, args.module, 'documents', args.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    // 删除侧车元数据文件
    const metaPath = filePath + '.meta.json';
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
