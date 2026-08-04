const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的文件系统 API 给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
    isElectron: true,

    // 同步读取文件（返回字符串或 null）
    readFileSync: function(relPath) {
        return ipcRenderer.sendSync('fs-read-sync', relPath);
    },

    // 异步写入文件（返回 Promise<boolean>）
    writeFile: function(relPath, content) {
        return ipcRenderer.invoke('fs-write', relPath, content);
    },

    // 同步检查文件是否存在
    existsSync: function(relPath) {
        return ipcRenderer.sendSync('fs-exists-sync', relPath);
    },

    // 获取数据根目录路径
    getDataRoot: function() {
        return ipcRenderer.sendSync('get-data-root');
    }
});
