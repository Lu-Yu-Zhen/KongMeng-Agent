const { app, BrowserWindow, ipcMain, protocol, net, shell } = require('electron');
const path = require('path');
const url = require('url');
const fs = require('fs');

let mainWindow;
let dataRoot;

// 自定义协议名：以 app://app/ 承载 dataRoot 下的本地资源，
// 使页面与本地资源同源（知识图谱 fetch kg_data.json 等正常工作），
// 同时得以开启 webSecurity:true 获得完整同源策略保护
const APP_SCHEME = 'app';
const APP_HOST = 'app';

// 确定数据根目录
function getDataRoot() {
    // 判断是否为打包模式：app.isPackaged 在某些 Electron 版本中开发模式也返回 true
    // 额外检查 process.execPath 是否包含 node_modules（开发模式特征）
    var isDev = !app.isPackaged || process.execPath.indexOf('node_modules') > 0;

    if (!isDev) {
        // 打包模式：exe 所在目录
        return path.dirname(process.execPath);
    }
    // 开发模式：__dirname 即 main.js 所在目录（项目根目录）
    return __dirname;
}

// 将渲染进程传入的相对路径安全地解析到 dataRoot 内；
// 非字符串、空值、越权（.. / 绝对路径）一律拒绝，防止路径穿越读写全盘文件
function resolveInRoot(relPath) {
    if (typeof relPath !== 'string' || !relPath) return null;
    var full = path.resolve(dataRoot, relPath);
    var root = path.resolve(dataRoot);
    if (full !== root && !full.startsWith(root + path.sep)) return null;
    return full;
}

// 确保所有数据目录存在
function ensureDataDirs() {
    const dirs = [
        'user_data/account',
        'user_data/model',
        'user_data/textbook',
        'user_data/plugins',
        'user_data/rules/language_rules',
        'user_data/rules/memory',
        'user_data/rules/knowledge_base',
        'user_data/skills',
        'data/knowledge',
        'data/qa',
        'data/grading',
        'data/homework',
        'data/practice',
        'data/diagnosis'
    ];
    dirs.forEach(function(dir) {
        var fullPath = path.join(dataRoot, dir);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
        }
    });
    console.log('[Electron] dataRoot:', dataRoot);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1024,
        minHeight: 700,
        icon: path.join(dataRoot, 'logo.png'),
        title: 'KongMeng Student',
        webPreferences: {
            preload: path.join(app.getAppPath(), 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true
        }
    });

    // 经自定义协议加载页面（资源与页面同源，fetch 本地 JSON 正常工作，同时 webSecurity 完整生效）
    mainWindow.loadURL(APP_SCHEME + '://' + APP_HOST + '/index.html');
    mainWindow.setMenuBarVisibility(false);
    mainWindow.maximize();

    // 开发时打开开发者工具（注释掉以关闭）
    // mainWindow.webContents.openDevTools();
}

// 注册自定义协议：app://app/<相对路径> → dataRoot/<相对路径>
function registerAppProtocol() {
    protocol.handle(APP_SCHEME, function(request) {
        try {
            var pathname = decodeURIComponent(new URL(request.url).pathname);
            var rel = pathname.replace(/^\/+/, '');
            var filePath = resolveInRoot(rel);
            if (!filePath || !fs.existsSync(filePath)) {
                return new Response('Not Found', { status: 404 });
            }
            return net.fetch(url.pathToFileURL(filePath).toString());
        } catch (e) {
            console.error('[Electron Protocol] error:', request.url, e.message);
            return new Response('Bad Request', { status: 400 });
        }
    });
}

// 统一管控窗口导航与新窗口：禁止页面被导航到外部地址，外部链接交给系统浏览器
function guardWebContents() {
    app.on('web-contents-created', function(event, contents) {
        contents.on('will-navigate', function(e, navUrl) {
            var allowed = navUrl.startsWith(APP_SCHEME + '://' + APP_HOST + '/') || navUrl.startsWith('about:blank');
            if (!allowed) {
                e.preventDefault();
                shell.openExternal(navUrl).catch(function() {});
            }
        });
        contents.setWindowOpenHandler(function(details) {
            if (details.url === 'about:blank' || details.url.startsWith(APP_SCHEME + '://')) {
                return { action: 'allow' };
            }
            shell.openExternal(details.url).catch(function() {});
            return { action: 'deny' };
        });
    });
}

app.whenReady().then(function() {
    dataRoot = getDataRoot();
    ensureDataDirs();
    registerAppProtocol();
    guardWebContents();

    // ===== IPC: 同步读取文件 =====
    ipcMain.on('fs-read-sync', function(event, relPath) {
        try {
            var fullPath = resolveInRoot(relPath);
            if (!fullPath) { event.returnValue = null; return; }
            if (fs.existsSync(fullPath)) {
                event.returnValue = fs.readFileSync(fullPath, 'utf-8');
            } else {
                event.returnValue = null;
            }
        } catch(e) {
            console.error('[Electron FS] read error:', relPath, e.message);
            event.returnValue = null;
        }
    });

    // ===== IPC: 异步写入文件 =====
    ipcMain.handle('fs-write', function(event, relPath, content) {
        try {
            var fullPath = resolveInRoot(relPath);
            if (!fullPath) return false;
            var dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(fullPath, content, 'utf-8');
            return true;
        } catch(e) {
            console.error('[Electron FS] write error:', relPath, e.message);
            return false;
        }
    });

    // ===== IPC: 同步检查文件是否存在 =====
    ipcMain.on('fs-exists-sync', function(event, relPath) {
        try {
            var fullPath = resolveInRoot(relPath);
            event.returnValue = fullPath ? fs.existsSync(fullPath) : false;
        } catch(e) {
            event.returnValue = false;
        }
    });

    // ===== IPC: 获取数据根目录 =====
    ipcMain.on('get-data-root', function(event) {
        event.returnValue = dataRoot;
    });

    createWindow();

    app.on('activate', function() {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', function() {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
