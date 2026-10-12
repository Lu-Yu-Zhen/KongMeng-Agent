#!/bin/bash
# ============================================================
# 教师备课智能体 · 沙箱容器入口脚本
# ------------------------------------------------------------
# 功能:
#   1. 初始化工作区目录结构 (教案/课件/学案/量规/大单元/分层/试题/临时)
#   2. 初始化 SQLite 数据库 (如果 init-db.sql 存在)
#   3. 创建 node-sandbox.js 占位服务 (如果不存在)
#   4. 刷新字体缓存 (确保中文字体可用)
#   5. 验证 Python 环境 (init-sandbox.py)
#   6. 启动 supervisor 管理所有服务
#
# 入口: 由 Dockerfile ENTRYPOINT 调用
#   exec /sandbox/entrypoint.sh
# ============================================================
set -e

echo "[entrypoint] ============================================"
echo "[entrypoint] 教师智能体沙箱环境启动中..."
echo "[entrypoint] 时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "[entrypoint] 用户: $(whoami) / UID: $(id -u)"
echo "[entrypoint] ============================================"

# ----------------------------------------------------------------
# 1. 初始化目录结构
# ----------------------------------------------------------------
echo "[entrypoint] [1/6] 初始化工作区目录..."
mkdir -p /sandbox/workspace/{教案,课件,学案,量规,大单元,分层,试题,临时}
mkdir -p /sandbox/data /sandbox/logs

# 确保目录权限正确 (teacher 用户可读写)
chown -R teacher:teacher /sandbox/workspace /sandbox/data /sandbox/logs 2>/dev/null || true
chmod -R 755 /sandbox/workspace /sandbox/data /sandbox/logs

echo "[entrypoint]   工作区: /sandbox/workspace (8 个分类目录)"
echo "[entrypoint]   数据:   /sandbox/data"
echo "[entrypoint]   日志:   /sandbox/logs"

# ----------------------------------------------------------------
# 2. 初始化 SQLite 数据库 (如果 init-db.sql 存在)
# ----------------------------------------------------------------
echo "[entrypoint] [2/6] 初始化 SQLite 数据库..."
if [ -f /sandbox/init-db.sql ]; then
    if sqlite3 /sandbox/data/sandbox.db < /sandbox/init-db.sql; then
        echo "[entrypoint]   SQLite 数据库初始化完成: /sandbox/data/sandbox.db"
    else
        echo "[entrypoint]   警告: SQLite 数据库初始化失败,继续启动..."
    fi
else
    echo "[entrypoint]   未找到 init-db.sql,跳过 SQLite 初始化"
fi

# ----------------------------------------------------------------
# 3. 如果 node-sandbox.js 不存在,创建最小占位服务
#    (避免 supervisor 启动 node-sandbox 程序时失败)
# ----------------------------------------------------------------
echo "[entrypoint] [3/6] 检查 Node.js 沙箱入口..."
if [ ! -f /sandbox/node-sandbox.js ]; then
    echo "[entrypoint]   node-sandbox.js 不存在,创建最小占位服务..."
    cat > /sandbox/node-sandbox.js <<'NODEEOF'
/**
 * 教师智能体 Node.js 沙箱服务 (占位)
 * ------------------------------------
 * 此文件为 entrypoint.sh 自动生成的最小占位服务
 * 实际功能请替换为完整的 node-sandbox.js 实现
 *
 * 端点:
 *   GET /health  健康检查
 *   GET /        服务信息
 */
const http = require('http');
const PORT = process.env.PORT || 8001;

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            service: 'node-sandbox',
            timestamp: Date.now()
        }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'running',
        message: 'Node.js sandbox placeholder service',
        endpoints: ['/health'],
        timestamp: Date.now()
    }));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[node-sandbox] 占位服务监听端口 ${PORT}`);
});
NODEEOF
    chown teacher:teacher /sandbox/node-sandbox.js
    echo "[entrypoint]   占位服务已创建: /sandbox/node-sandbox.js"
else
    echo "[entrypoint]   node-sandbox.js 已存在,跳过创建"
fi

# ----------------------------------------------------------------
# 4. 刷新字体缓存 (确保中文字体可用)
# ----------------------------------------------------------------
echo "[entrypoint] [4/6] 刷新字体缓存..."
fc-cache -f >/dev/null 2>&1 || true
echo "[entrypoint]   字体缓存已刷新"

# ----------------------------------------------------------------
# 5. 验证 Python 环境 (init-sandbox.py,失败不阻塞启动)
# ----------------------------------------------------------------
echo "[entrypoint] [5/6] 验证 Python 环境..."
if python /sandbox/init-sandbox.py 2>/dev/null; then
    echo "[entrypoint]   Python 环境验证通过"
else
    echo "[entrypoint]   警告: Python 环境验证有警告,继续启动..."
fi

# ----------------------------------------------------------------
# 6. 启动 supervisor 管理所有服务
#    - python-sandbox   (FastAPI :8000)
#    - node-sandbox     (Node.js :8001)
#    - redis            (:6379)
#    - mcp-filesystem   (MCP 文件系统)
#    - mcp-fetch        (MCP 网络抓取)
#    - mcp-memory       (MCP 记忆)
#    - mcp-time         (MCP 时间)
#    - mcp-sequential-thinking (MCP 顺序思维)
# ----------------------------------------------------------------
echo "[entrypoint] [6/6] 启动服务集群 (supervisor)..."
echo "[entrypoint]   FastAPI Python 沙箱:  :8000"
echo "[entrypoint]   Node.js 沙箱:         :8001"
echo "[entrypoint]   Redis:                :6379"
echo "[entrypoint]   MCP 服务器集群:        filesystem/fetch/memory/time/thinking"
echo "[entrypoint] ============================================"
echo ""

# 使用 exec 替换当前进程,supervisor 成为 PID 1
exec /usr/bin/supervisord -c /sandbox/supervisord.conf
