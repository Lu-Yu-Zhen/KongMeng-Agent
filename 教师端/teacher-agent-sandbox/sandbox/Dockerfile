# ============================================================
# 教师备课智能体 · 沙箱容器定义 (全栈版 v2.0)
# ------------------------------------------------------------
# 用途: 在服务端部署时提供 Python + Node.js 全栈执行环境
# 架构: 多阶段构建 - 基础系统层 → Python层 → Node.js层 → LaTeX层 → 应用层
# 服务: FastAPI(8000) + Node.js沙箱(8001) + Redis + MCP服务器集群
# 暴露端口: 8000 (FastAPI Python沙箱) / 8001 (Node.js沙箱)
# 健康检查: curl http://localhost:8000/health
# 入口: entrypoint.sh → supervisord
# ============================================================

# ----------------------------------------------------------------
# 阶段 1: 基础系统层 (system-base)
# 安装系统工具、中文字体、浏览器引擎、数据库、Node.js 20.x 运行时
# ----------------------------------------------------------------
FROM python:3.11-slim AS system-base

LABEL maintainer="百舸教育智能体"
LABEL description="Teacher agent full-stack sandbox: Python + Node.js + Browser + LaTeX + DB"
LABEL version="2.0"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    # ---- 浏览器自动化路径 ----
    CHROME_BIN=/usr/bin/chromium \
    CHROMIUM_BIN=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_CACHE_DIR=/usr/local/share/puppeteer \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # ---- Node.js ----
    NODE_VERSION=20 \
    NPM_CONFIG_LOGLEVEL=warn

# 安装系统依赖(分类清晰、注释完整)
RUN apt-get update && apt-get install -y --no-install-recommends \
    # ---- 中文字体与基础运行库 ----
    fonts-noto-cjk \
    fonts-wqy-zenhei \
    fonts-wqy-microhei \
    fonts-arphic-uming \
    fonts-arphic-ukai \
    fontconfig \
    libxml2-dev libxslt1-dev \
    libgl1-mesa-glx libglib2.0-0 \
    libmagic1 libcairo2 \
    libpango-1.0-0 libpangoft2-1.0-0 \
    libgdk-pixbuf2.0-0 libffi-dev \
    # ---- 文档转换 ----
    pandoc libreoffice libreoffice-impress wkhtmltopdf \
    # ---- PDF 处理 ----
    ghostscript poppler-utils qpdf mutool \
    # ---- OCR(含中英文语言包) ----
    tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-chi-tra tesseract-ocr-eng \
    # ---- 音视频处理 ----
    ffmpeg sox lame \
    # ---- 图像处理 ----
    imagemagick optipng jpegoptim libwebp-dev \
    # ---- 图形与 UML ----
    graphviz plantuml \
    # ---- TeX 排版 (apt 基础包,tlmgr 补充扩展宏包) ----
    texlive-xetex texlive-lang-chinese \
    texlive-latex-extra texlive-fonts-recommended \
    texlive-science texlive-pictures \
    texlive-bibtex-extra texlive-pstricks \
    texlive-base texlive-latex-base \
    latexmk \
    # ---- 浏览器自动化 (playwright / selenium 共用) ----
    chromium \
    # ---- 数据库与缓存 ----
    sqlite3 \
    redis-server \
    postgresql postgresql-contrib libpq-dev \
    # ---- 压缩与网络工具 ----
    zip p7zip-full \
    curl wget openssl git ca-certificates gnupg \
    # ---- 进程管理 ----
    supervisor \
    # ---- Node.js 安装辅助 ----
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# 安装 Node.js 20.x (NodeSource 官方源)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && echo "[node] Node.js $(node --version) / npm $(npm --version) 安装完成"

# 刷新字体缓存(确保中文字体可用)
RUN fc-cache -fv

# 预装 MCP 服务器(全局安装,避免运行时 npx 联网下载)
RUN npm install -g --no-fund --no-audit \
        @modelcontextprotocol/server-filesystem \
        @modelcontextprotocol/server-fetch \
        @modelcontextprotocol/server-memory \
        @modelcontextprotocol/server-time \
        @modelcontextprotocol/server-sequential-thinking \
    2>/dev/null \
    && echo "[mcp] MCP 服务器全局预装完成" \
    || echo "[mcp] 警告: 部分 MCP 服务器预装失败,运行时将由 npx -y 自动下载"

# ----------------------------------------------------------------
# 阶段 2: Python 依赖层 (python-layer)
# 安装 Python pip 包 + Playwright 浏览器
# ----------------------------------------------------------------
FROM system-base AS python-layer

WORKDIR /sandbox

COPY sandbox/requirements.txt .
RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
    && pip install --no-cache-dir -r requirements.txt

# 安装 Playwright Chromium (Python 端,与 Node 端共享 /ms-playwright 路径)
RUN mkdir -p /ms-playwright \
    && playwright install chromium 2>/dev/null \
    && chmod -R 755 /ms-playwright \
    && echo "[python] Playwright Chromium 安装完成" \
    || echo "[python] 警告: Playwright Chromium 安装失败,将使用系统 chromium"

# ----------------------------------------------------------------
# 阶段 3: Node.js 依赖层 (node-layer)
# 安装 Node.js npm 包: puppeteer / playwright / express / MCP SDK 等
# ----------------------------------------------------------------
FROM python-layer AS node-layer

WORKDIR /sandbox

# 复制 package.json (package-lock.json 可选,不存在则跳过)
COPY package.json ./
COPY package-lock.json* ./

# 安装 npm 依赖: 有 lockfile 用 ci (确定性构建),否则用 install
RUN if [ -f package-lock.json ]; then \
        npm ci --production --no-fund --no-audit; \
    else \
        npm install --production --no-fund --no-audit; \
    fi \
    && echo "[node] npm 依赖安装完成"

# 安装 Puppeteer Chromium (单独下载,与系统 chromium 并存作为备份)
# PUPPETEER_EXECUTABLE_PATH 指向系统 chromium,代码可通过 executablePath() 切换到此处
RUN mkdir -p /usr/local/share/puppeteer \
    && npx --yes puppeteer browsers install chrome 2>/dev/null \
    && chmod -R 755 /usr/local/share/puppeteer \
    && echo "[node] Puppeteer Chromium 下载完成" \
    || echo "[node] 警告: Puppeteer Chromium 下载失败,将使用系统 /usr/bin/chromium"

# 安装 Playwright Chromium (Node 端,与 Python 端共享 /ms-playwright)
RUN npx --yes playwright install chromium 2>/dev/null \
    && chmod -R 755 /ms-playwright \
    && echo "[node] Playwright Chromium (Node) 安装完成" \
    || echo "[node] 警告: Playwright Chromium (Node) 安装失败,将使用系统 chromium"

# ----------------------------------------------------------------
# 阶段 4: LaTeX 宏包扩展层 (latex-layer)
# 使用 tlmgr 在 texlive apt 基础上安装额外宏包 (ctex/minted/pgfplots 等)
# ----------------------------------------------------------------
FROM node-layer AS latex-layer

WORKDIR /sandbox

# 复制并执行 LaTeX 宏包安装脚本
COPY sandbox/install-latex-packages.sh /tmp/install-latex-packages.sh
RUN chmod +x /tmp/install-latex-packages.sh \
    && /tmp/install-latex-packages.sh \
    && rm -f /tmp/install-latex-packages.sh

# LaTeX 字体安装后再刷新一次字体缓存
RUN fc-cache -fv

# ----------------------------------------------------------------
# 阶段 5: 应用层 (app)
# 复制应用代码,创建工作区与数据目录,配置非 root 用户
# ----------------------------------------------------------------
FROM latex-layer AS app

WORKDIR /sandbox

# 创建工作区 (8 个分类目录) 与数据/日志目录
RUN mkdir -p \
        workspace/教案 workspace/课件 workspace/学案 \
        workspace/量规 workspace/大单元 workspace/分层 workspace/试题 workspace/临时 \
        data logs \
    && chmod -R 755 workspace data logs

# 复制应用代码 (仅 COPY 一定存在的文件,可选文件由 entrypoint.sh 处理)
COPY sandbox/init-sandbox.py .
COPY sandbox/sandbox_api.py .
COPY sandbox/supervisord.conf .
COPY sandbox/entrypoint.sh .
COPY sandbox/node-sandbox.js .
COPY sandbox/fonts.conf /etc/fonts/local.conf
COPY sandbox/init-db.sql ./

# 设置脚本可执行权限
RUN chmod +x entrypoint.sh init-sandbox.py

# 创建非 root 用户 teacher,并赋权访问所有沙箱目录
RUN useradd -m -d /home/teacher -s /bin/bash teacher \
    && chown -R teacher:teacher /sandbox \
    && mkdir -p /home/teacher/.cache /home/teacher/.config \
    && chown -R teacher:teacher /home/teacher

# 让 teacher 用户可访问浏览器缓存目录 (供 puppeteer / playwright 调用)
RUN chmod -R 777 /ms-playwright /usr/local/share/puppeteer 2>/dev/null || true

# 暴露服务端口: 8000 (FastAPI) / 8001 (Node.js 沙箱)
EXPOSE 8000 8001

# 健康检查 (检查 FastAPI /health 端点)
HEALTHCHECK --interval=60s --timeout=10s --retries=3 --start-period=60s \
    CMD curl -fsS http://localhost:8000/health || exit 1

# 默认入口: 通过 entrypoint.sh 启动 supervisor 管理所有服务
ENTRYPOINT ["/sandbox/entrypoint.sh"]
