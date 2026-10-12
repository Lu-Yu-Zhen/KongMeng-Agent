const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let dataRoot;

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
            webSecurity: false
        }
    });

    // 从数据根目录加载 HTML（支持外部修改同步更新）
    var htmlPath = path.join(dataRoot, 'index.html');
    mainWindow.loadFile(htmlPath);
    mainWindow.setMenuBarVisibility(false);
    mainWindow.maximize();

    // 开发时打开开发者工具（注释掉以关闭）
    // mainWindow.webContents.openDevTools();
}

app.whenReady().then(function() {
    dataRoot = getDataRoot();
    ensureDataDirs();

    // ===== IPC: 同步读取文件 =====
    ipcMain.on('fs-read-sync', function(event, relPath) {
        try {
            var fullPath = path.join(dataRoot, relPath);
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
            var fullPath = path.join(dataRoot, relPath);
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
            event.returnValue = fs.existsSync(path.join(dataRoot, relPath));
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
