#!/usr/bin/env node
/**
 * 教师智能体沙箱 · Node.js 服务器端 API 服务
 * ============================================================
 * 基于 Express 提供文档生成（docx/pptx/xlsx/pdf）、格式转换
 * （html-to-docx / html-to-pdf / docx-to-html）、Mermaid/LaTeX 渲染、
 * 图片处理（sharp）、网页抓取（axios+cheerio）、网页截图（puppeteer）、
 * 文件打包（archiver）等能力。
 *
 * 作为 Python sandbox_api.py（FastAPI, 端口 8000）的对等/补充运行时，
 * 默认监听端口 8001，提供 Node.js 生态特有的文档与渲染能力。
 *
 * 启动方式：
 *     node sandbox/node-sandbox.js
 * 或通过 package.json：
 *     npm run sandbox:start
 *
 * 对应目录结构（workspace 下）：
 *     workspace/
 *     ├── 教案/      .docx .pdf
 *     ├── 课件/      .pptx
 *     ├── 学案/      .docx
 *     ├── 量规/      .xlsx
 *     ├── 大单元/    .docx .pdf
 *     ├── 分层/      .docx
 *     ├── 试题/      .docx .pdf
 *     └── 临时/      图表等临时文件
 */

'use strict';

// ============================================================
// 1. Imports 与配置加载
// ============================================================

// ---- 核心 Node 模块 ----
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const { v4: uuidv4 } = require('uuid');

// ---- dotenv 环境变量 ----
try {
  require('dotenv').config();
} catch (e) {
  // dotenv 未安装时静默忽略
}

// ---- Express 框架 ----
const express = require('express');
const cors = require('cors');
const multer = require('multer');

// ---- 日志 ----
const winston = require('winston');

// ============================================================
// 2. 配置常量
// ============================================================

// 服务监听配置
const HOST = process.env.SANDBOX_HOST || '0.0.0.0';
const PORT = parseInt(process.env.SANDBOX_PORT || '8001', 10);

// 工作区根目录：sandbox/workspace/
const WORKSPACE_DIR = path.resolve(
  process.env.WORKSPACE_DIR || path.join(__dirname, 'workspace')
);

// 工作区子目录（与 Python sandbox_api.py / sandbox-config.json 对齐）
const DIRS = {
  '教案': path.join(WORKSPACE_DIR, '教案'),
  '课件': path.join(WORKSPACE_DIR, '课件'),
  '学案': path.join(WORKSPACE_DIR, '学案'),
  '量规': path.join(WORKSPACE_DIR, '量规'),
  '大单元': path.join(WORKSPACE_DIR, '大单元'),
  '分层': path.join(WORKSPACE_DIR, '分层'),
  '试题': path.join(WORKSPACE_DIR, '试题'),
  '临时': path.join(WORKSPACE_DIR, '临时'),
};

// 请求体大小限制（50MB）
const MAX_REQUEST_SIZE = '50mb';

// 主题色（对齐教师端 ink/jade/tan，与 Python sandbox_api.py 一致）
const THEME = {
  jade: '4F7A66',        // 竹青主色
  ink: '403A30',         // 暖墨色
  bg: 'FAF8F3',          // 米白背景
  tan: 'A8814E',         // 秋香赭点缀
  light_jade: 'E8F0EC',  // 浅竹青
};

// 中文字体优先级
const CN_FONTS = ['Microsoft YaHei', 'SimSun', 'Noto Sans CJK SC', 'WenQuanYi Micro Hei'];
const CN_FONT_PRIMARY = CN_FONTS[0];

// 文件下载基础 URL（运行时填充）
let BASE_URL = `http://localhost:${PORT}`;

// ============================================================
// 3. Winston 日志配置
// ============================================================

const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(__dirname, 'logs'));
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
  // 日志目录创建失败时忽略
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
      return `[${timestamp}] [${level.toUpperCase()}] ${stack || message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `[${timestamp}] ${level}: ${message}`;
        })
      ),
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'sandbox-error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'sandbox-combined.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
});

// ============================================================
// 4. 模块加载状态（延迟加载，记录可用性）
// ============================================================

const MODULE_STATUS = {};

/**
 * 安全地 require 一个可选模块，并记录其加载状态。
 * @param {string} name - 模块名称
 * @param {string} displayName - 显示名称（用于 /health）
 * @returns {*} 模块对象或 null
 */
function loadOptional(name, displayName) {
  try {
    const mod = require(name);
    MODULE_STATUS[displayName || name] = 'ok';
    return mod;
  } catch (e) {
    MODULE_STATUS[displayName || name] = 'missing';
    return null;
  }
}

// 延迟加载文档生成库
let docxLib = loadOptional('docx', 'docx');
let PptxGenJS = loadOptional('pptxgenjs', 'pptxgenjs');
let ExcelJS = loadOptional('exceljs', 'exceljs');
let PDFLib = loadOptional('pdf-lib', 'pdf-lib');
let MarkdownIt = loadOptional('markdown-it', 'markdown-it');
let archiver = loadOptional('archiver', 'archiver');
let sharp = loadOptional('sharp', 'sharp');
let mammoth = loadOptional('mammoth', 'mammoth');
let htmlToDocx = loadOptional('html-to-docx', 'html-to-docx');
let cheerio = loadOptional('cheerio', 'cheerio');
let axios = loadOptional('axios', 'axios');

// puppeteer / mermaid / node-latex 较重，首次使用时延迟加载
let _puppeteer = null;
let _mermaid = null;
let _nodeLatex = null;

async function getPuppeteer() {
  if (_puppeteer === null) {
    _puppeteer = loadOptional('puppeteer', 'puppeteer');
  }
  return _puppeteer;
}

async function getMermaid() {
  if (_mermaid === null) {
    _mermaid = loadOptional('@mermaid-js/mermaid-cli', 'mermaid') ||
               loadOptional('mermaid', 'mermaid');
  }
  return _mermaid;
}

async function getNodeLatex() {
  if (_nodeLatex === null) {
    _nodeLatex = loadOptional('node-latex', 'node-latex');
  }
  return _nodeLatex;
}

// markdown-it 实例（如可用）
const md = MarkdownIt ? new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
}) : null;

// ============================================================
// 5. 文件系统工具函数
// ============================================================

/**
 * 验证路径在 workspace 目录内，防止路径穿越攻击。
 * @param {string} relPath - 相对路径
 * @returns {string} 解析后的绝对路径
 * @throws {Error} 路径越权时抛出
 */
function validateWorkspacePath(relPath) {
  const workspaceResolved = path.resolve(WORKSPACE_DIR);
  const target = path.resolve(WORKSPACE_DIR, relPath);
  // 确保目标路径在 workspace 内（含 workspace 自身）
  if (target !== workspaceResolved && !target.startsWith(workspaceResolved + path.sep)) {
    const err = new Error(`路径越权：${relPath} 不在 workspace 目录内`);
    err.statusCode = 403;
    throw err;
  }
  return target;
}

/**
 * 生成安全的文件名（去除非法字符，追加后缀）。
 * @param {string} name - 原始文件名（不含后缀）
 * @param {string} ext - 扩展名（不含点，如 'docx'）
 * @returns {string} 安全的文件名
 */
function safeFilename(name, ext) {
  let safe = (name || '文档')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (!safe) safe = '文档';
  const cleanExt = ext.replace(/^\./, '').toLowerCase();
  if (!safe.toLowerCase().endsWith('.' + cleanExt)) {
    safe = `${safe}.${cleanExt}`;
  }
  return safe;
}

/**
 * 根据扩展名获取对应的工作区子目录。
 * @param {string} ext - 文件扩展名（如 'docx', 'pptx'）
 * @returns {string} 子目录键名
 */
function getDirByExt(ext) {
  const e = ext.replace(/^\./, '').toLowerCase();
  const map = {
    'docx': '教案',
    'pdf': '教案',
    'pptx': '课件',
    'xlsx': '量规',
    'png': '临时',
    'jpg': '临时',
    'jpeg': '临时',
    'svg': '临时',
    'zip': '临时',
    'html': '临时',
  };
  return map[e] || '临时';
}

/**
 * 构造文件下载 URL。
 * @param {string} relPath - 相对 workspace 的路径
 * @returns {string} 下载 URL
 */
function fileDownloadUrl(relPath) {
  const encoded = relPath.split(path.sep).map(encodeURIComponent).join('/');
  return `${BASE_URL}/files/${encoded}`;
}

/**
 * 确保工作区目录结构存在。
 */
function ensureWorkspaceDirs() {
  try {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  } catch (e) {
    // 忽略已存在
  }
  for (const [name, dirPath] of Object.entries(DIRS)) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
    } catch (e) {
      // 忽略已存在
    }
  }
}

/**
 * 获取文件大小（字节）。
 * @param {string} filePath - 文件绝对路径
 * @returns {number} 文件大小
 */
function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (e) {
    return 0;
  }
}

/**
 * MIME 类型映射。
 */
const MIME_TYPES = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip',
  '.json': 'application/json; charset=utf-8',
};

/**
 * 根据扩展名获取 MIME 类型。
 * @param {string} ext - 扩展名（含点或不含点）
 * @returns {string} MIME 类型
 */
function getMimeType(ext) {
  const e = ext.startsWith('.') ? ext.toLowerCase() : '.' + ext.toLowerCase();
  return MIME_TYPES[e] || 'application/octet-stream';
}

// ============================================================
// 6. Markdown 解析辅助函数
// ============================================================

/**
 * 将 Markdown 文本解析为结构化块列表。
 * 支持：# / ## 二级标题、### / #### 三级标题、- / * 无序列表、
 *       1. 有序列表、| 表格 |、普通段落。
 *
 * 与 Python sandbox_api.py 的 parse_markdown_to_blocks 对等。
 *
 * @param {string} content - Markdown 文本
 * @returns {Array} 结构化块数组
 */
function parseMarkdownToBlocks(content) {
  if (!content || !content.trim()) return [];

  const lines = content.split('\n');
  const blocks = [];
  let i = 0;

  // 正则定义
  const reH1 = /^#\s+(.+)/;
  const reH2 = /^##\s+(.+)/;
  const reH3 = /^###\s+(.+)/;
  const reH4 = /^####\s+(.+)/;
  const reUnordered = /^[-*]\s+/;
  const reOrdered = /^\d+\.\s+/;
  const reTableSeparator = /^\|[\s\-:|]+\|/;

  while (i < lines.length) {
    const line = lines[i].replace(/\r$/, '');

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 一级标题 # (作为 h2)
    let m = line.match(reH1);
    if (m) {
      blocks.push({ type: 'h2', text: m[1].trim() });
      i++;
      continue;
    }

    // 二级标题 ##
    m = line.match(reH2);
    if (m) {
      blocks.push({ type: 'h2', text: m[1].trim() });
      i++;
      continue;
    }

    // 三级标题 ###
    m = line.match(reH3);
    if (m) {
      blocks.push({ type: 'h3', text: m[1].trim() });
      i++;
      continue;
    }

    // 四级标题 #### (作为 h3)
    m = line.match(reH4);
    if (m) {
      blocks.push({ type: 'h3', text: m[1].trim() });
      i++;
      continue;
    }

    // 无序列表 - 或 *
    if (reUnordered.test(line)) {
      const items = [];
      while (i < lines.length && reUnordered.test(lines[i].replace(/\r$/, ''))) {
        items.push(lines[i].replace(/\r$/, '').replace(reUnordered, '').trim());
        i++;
      }
      blocks.push({ type: 'list', items, ordered: false });
      continue;
    }

    // 有序列表 1. 2.
    if (reOrdered.test(line)) {
      const items = [];
      while (i < lines.length && reOrdered.test(lines[i].replace(/\r$/, ''))) {
        items.push(lines[i].replace(/\r$/, '').replace(reOrdered, '').trim());
        i++;
      }
      blocks.push({ type: 'list', items, ordered: true });
      continue;
    }

    // 表格 | ... |
    const trimmedLine = line.trim();
    if (
      trimmedLine.startsWith('|') &&
      i + 1 < lines.length &&
      reTableSeparator.test(lines[i + 1].trim())
    ) {
      const tableRows = [trimmedLine];
      i++; // 跳过表头
      i++; // 跳过分隔行
      while (i < lines.length && lines[i].replace(/\r$/, '').trim().startsWith('|')) {
        tableRows.push(lines[i].replace(/\r$/, '').trim());
        i++;
      }
      blocks.push({ type: 'table', rows: tableRows });
      continue;
    }

    // 普通段落（连续非空行合并）
    const paraLines = [line.trim()];
    i++;
    while (i < lines.length) {
      const nextLine = lines[i].replace(/\r$/, '');
      if (!nextLine.trim()) break;
      if (reH1.test(nextLine) || reH2.test(nextLine) || reH3.test(nextLine) || reH4.test(nextLine)) break;
      if (reUnordered.test(nextLine)) break;
      if (reOrdered.test(nextLine)) break;
      if (nextLine.trim().startsWith('|')) break;
      paraLines.push(nextLine.trim());
      i++;
    }
    blocks.push({ type: 'text', text: paraLines.join(' ') });
  }

  return blocks;
}

/**
 * 解析 Markdown 表格行为二维数组。
 * @param {Array<string>} rows - 原始表格行（含 | 分隔）
 * @returns {{ headers: Array, data: Array<Array> }}
 */
function parseTableRows(rows) {
  const parseRow = (row) => {
    return row
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
  };
  if (!rows || rows.length === 0) return { headers: [], data: [] };
  const headers = parseRow(rows[0]);
  const data = rows.slice(1).map(parseRow);
  return { headers, data };
}

/**
 * 将解析后的块数组转换为 docx 库的 Paragraph / Table 元素数组。
 * @param {Array} blocks - parseMarkdownToBlocks 返回的块数组
 * @param {object} docx - docx 库模块
 * @returns {Array} docx 元素数组
 */
function blocksToDocxElements(blocks, docx) {
  const {
    Paragraph, TextRun, HeadingLevel, AlignmentType,
    Table, TableRow, TableCell, WidthType, BorderStyle,
  } = docx;

  const elements = [];

  for (const block of blocks) {
    if (block.type === 'h2') {
      elements.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 },
          children: [
            new TextRun({
              text: block.text,
              bold: true,
              size: 32, // 16pt
              color: THEME.jade,
              font: CN_FONT_PRIMARY,
            }),
          ],
        })
      );
    } else if (block.type === 'h3') {
      elements.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 100 },
          children: [
            new TextRun({
              text: block.text,
              bold: true,
              size: 26, // 13pt
              color: THEME.ink,
              font: CN_FONT_PRIMARY,
            }),
          ],
        })
      );
    } else if (block.type === 'list') {
      const prefix = block.ordered ? '' : '';
      block.items.forEach((item, idx) => {
        const bullet = block.ordered ? `${idx + 1}. ` : '\u2022  ';
        elements.push(
          new Paragraph({
            spacing: { after: 60 },
            indent: { left: 360 },
            children: [
              new TextRun({
                text: bullet + item,
                size: 24, // 12pt
                color: THEME.ink,
                font: CN_FONT_PRIMARY,
              }),
            ],
          })
        );
      });
    } else if (block.type === 'table') {
      const { headers, data } = parseTableRows(block.rows);
      const noBorder = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
      const tableRows = [];

      // 表头行
      tableRows.push(
        new TableRow({
          children: headers.map(
            (header) =>
              new TableCell({
                shading: { fill: THEME.jade },
                borders: {
                  top: noBorder, bottom: noBorder, left: noBorder, right: noBorder,
                },
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                      new TextRun({
                        text: header,
                        bold: true,
                        size: 22,
                        color: 'FFFFFF',
                        font: CN_FONT_PRIMARY,
                      }),
                    ],
                  }),
                ],
              })
          ),
        })
      );

      // 数据行（隔行变色）
      data.forEach((row, ri) => {
        const fillColor = ri % 2 === 0 ? THEME.light_jade : 'FFFFFF';
        // 补齐列数
        const cells = [...row];
        while (cells.length < headers.length) cells.push('');
        tableRows.push(
          new TableRow({
            children: cells.map(
              (cell) =>
                new TableCell({
                  shading: { fill: fillColor },
                  borders: {
                    top: noBorder, bottom: noBorder, left: noBorder, right: noBorder,
                  },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: cell,
                          size: 22,
                          color: THEME.ink,
                          font: CN_FONT_PRIMARY,
                        }),
                      ],
                    }),
                  ],
                })
            ),
          })
        );
      });

      elements.push(
        new Table({
          rows: tableRows,
          width: { size: 100, type: WidthType.PERCENTAGE },
        })
      );
    } else if (block.type === 'text') {
      elements.push(
        new Paragraph({
          spacing: { after: 120, line: 360 },
          children: [
            new TextRun({
              text: block.text,
              size: 24, // 12pt
              color: THEME.ink,
              font: CN_FONT_PRIMARY,
            }),
          ],
        })
      );
    }
  }

  return elements;
}

/**
 * 将 Markdown 内容渲染为 HTML（使用 markdown-it，降级为简易转换）。
 * @param {string} content - Markdown 文本
 * @returns {string} HTML 字符串
 */
function markdownToHtml(content) {
  if (md) {
    return md.render(content || '');
  }
  // 降级：简易转换
  let html = (content || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/\n\n/g, '</p><p>');
  return `<p>${html}</p>`;
}

// ============================================================
// 7. Express 应用初始化
// ============================================================

const app = express();

// ---- CORS 允许所有源 ----
app.use(cors({ origin: true, credentials: true }));

// ---- 请求体解析（限制 50MB） ----
app.use(express.json({ limit: MAX_REQUEST_SIZE }));
app.use(express.urlencoded({ extended: true, limit: MAX_REQUEST_SIZE }));

// ---- multer 文件上传配置（内存存储） ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// ---- 请求日志中间件 ----
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// ============================================================
// 8. API 路由
// ============================================================

// ---- 8.1 健康检查 ----
app.get('/health', (req, res) => {
  /**
   * 返回服务健康状态、Node.js 版本、已加载模块状态、workspace 路径。
   */
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    node_version: process.version,
    platform: `${os.platform()}/${os.arch()}`,
    modules_status: MODULE_STATUS,
    workspace: WORKSPACE_DIR,
    dirs: Object.keys(DIRS),
    port: PORT,
  });
});

// ---- 8.2 生成 Word 文档 (.docx) ----
app.post('/generate/docx', async (req, res) => {
  /**
   * 用 docx 库生成 Word 文档。
   * 解析 Markdown 内容（## 标题、- 列表、| 表格 |、段落），设置中文字体。
   *
   * 请求体：
   *   { title: string, content: string, filename?: string }
   */
  try {
    if (!docxLib) {
      return res.status(503).json({ ok: false, error: 'docx 模块未安装' });
    }
    const { title, content, filename } = req.body;
    if (!title) {
      return res.status(400).json({ ok: false, error: '缺少 title 参数' });
    }

    const {
      Document, Packer, Paragraph, TextRun, HeadingLevel,
      AlignmentType, PageOrientation, convertInchesToTwip,
    } = docxLib;

    // 解析 Markdown 为块
    const blocks = parseMarkdownToBlocks(content || '');
    const bodyElements = blocksToDocxElements(blocks, docxLib);

    // 标题段落
    const titlePara = new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
      children: [
        new TextRun({
          text: title,
          bold: true,
          size: 44, // 22pt
          color: THEME.jade,
          font: CN_FONT_PRIMARY,
        }),
      ],
    });

    // 分隔空段落
    const spacer = new Paragraph({ children: [] });

    // 创建文档
    const doc = new Document({
      styles: {
        default: {
          document: {
            run: {
              font: CN_FONT_PRIMARY,
              size: 24, // 12pt
              color: THEME.ink,
            },
          },
        },
      },
      sections: [
        {
          properties: {
            page: {
              margin: {
                top: convertInchesToTwip(1),
                bottom: convertInchesToTwip(1),
                left: convertInchesToTwip(1),
                right: convertInchesToTwip(1),
              },
            },
          },
          children: [titlePara, spacer, ...bodyElements],
        },
      ],
    });

    // 生成 Buffer
    const buffer = await Packer.toBuffer(doc);

    // 保存到 workspace
    const fname = safeFilename(filename || title, 'docx');
    const saveDir = DIRS['教案'];
    fs.mkdirSync(saveDir, { recursive: true });
    const savePath = path.join(saveDir, fname);
    fs.writeFileSync(savePath, buffer);

    const relPath = `教案/${fname}`;
    logger.info(`生成 Word 文档: ${relPath} (${buffer.length} bytes)`);

    res.json({
      ok: true,
      data: {
        filename: fname,
        path: relPath,
        url: fileDownloadUrl(relPath),
        size: buffer.length,
      },
    });
  } catch (err) {
    logger.error(`生成 Word 文档失败: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: `生成 Word 文档失败: ${err.message}` });
  }
});

// ---- 8.3 生成 PPT 课件 (.pptx) ----
app.post('/generate/pptx', async (req, res) => {
  /**
   * 用 pptxgenjs 生成 PPT。
   * 16:9 布局，主题色 jade=#4F7A66, ink=#403A30, bg=#FAF8F3。
   * 支持 cover（封面页）/ content（内容页）两种幻灯片类型。
   *
   * 请求体：
   *   {
   *     slides: [
   *       { type: 'cover', title: '', subtitle: '' },
   *       { type: 'content', title: '', bullets: [], content: '' }
   *     ],
   *     filename?: string
   *   }
   */
  try {
    if (!PptxGenJS) {
      return res.status(503).json({ ok: false, error: 'pptxgenjs 模块未安装' });
    }
    const { slides, filename } = req.body;
    if (!slides || !Array.isArray(slides) || slides.length === 0) {
      return res.status(400).json({ ok: false, error: '缺少 slides 参数或为空' });
    }

    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 });
    pptx.layout = 'WIDE';

    // 主题色
    const colorJade = THEME.jade;
    const colorInk = THEME.ink;
    const colorBg = THEME.bg;
    const colorTan = THEME.tan;

    for (const slideInfo of slides) {
      const slideType = slideInfo.type || 'content';
      const slideTitle = slideInfo.title || '';
      const subtitle = slideInfo.subtitle || '';
      const bullets = slideInfo.bullets || [];
      const content = slideInfo.content || '';

      const slide = pptx.addSlide();
      slide.background = { color: colorBg };

      if (slideType === 'cover') {
        // 封面页
        slide.addText(slideTitle, {
          x: 0.5, y: 2.4, w: 12.3, h: 1.2,
          fontSize: 40, bold: true, color: colorJade,
          fontFace: CN_FONT_PRIMARY, align: 'center',
        });
        if (subtitle) {
          slide.addText(subtitle, {
            x: 0.5, y: 3.8, w: 12.3, h: 0.8,
            fontSize: 20, color: colorInk,
            fontFace: CN_FONT_PRIMARY, align: 'center',
          });
        }
        // 装饰线
        slide.addShape(pptx.ShapeType.rect, {
          x: 5.6, y: 4.8, w: 2.1, h: 0.06,
          fill: { color: colorTan }, line: { color: colorTan },
        });
      } else {
        // 内容页
        slide.addText(slideTitle, {
          x: 0.5, y: 0.3, w: 12.3, h: 0.8,
          fontSize: 28, bold: true, color: colorJade,
          fontFace: CN_FONT_PRIMARY, align: 'left',
        });
        // 标题下装饰线
        slide.addShape(pptx.ShapeType.rect, {
          x: 0.5, y: 1.15, w: 1.6, h: 0.05,
          fill: { color: colorTan }, line: { color: colorTan },
        });

        // 项目符号列表
        if (bullets && bullets.length > 0) {
          const bulletText = bullets.map((b) => `\u2022  ${b}`).join('\n');
          slide.addText(bulletText, {
            x: 0.6, y: 1.4, w: 12.1, h: bullets.length > 5 ? 5.6 : undefined,
            fontSize: 18, color: colorInk,
            fontFace: CN_FONT_PRIMARY, align: 'left',
            lineSpacingMultiple: 1.4, valign: 'top',
          });
        }

        // 纯文本内容
        if (content) {
          const yOffset = bullets.length > 0 ? 1.4 + bullets.length * 0.5 : 1.4;
          slide.addText(content, {
            x: 0.6, y: yOffset, w: 12.1,
            fontSize: 16, color: colorInk,
            fontFace: CN_FONT_PRIMARY, align: 'left',
            valign: 'top',
          });
        }
      }
    }

    // 生成 Buffer
    const buffer = await pptx.write({ outputType: 'nodebuffer' });

    // 保存
    const fname = safeFilename(filename || '课件', 'pptx');
    const saveDir = DIRS['课件'];
    fs.mkdirSync(saveDir, { recursive: true });
    const savePath = path.join(saveDir, fname);
    fs.writeFileSync(savePath, buffer);

    const relPath = `课件/${fname}`;
    logger.info(`生成 PPT 课件: ${relPath} (${buffer.length} bytes, ${slides.length} 页)`);

    res.json({
      ok: true,
      data: {
        filename: fname,
        path: relPath,
        url: fileDownloadUrl(relPath),
        size: buffer.length,
        slides: slides.length,
      },
    });
  } catch (err) {
    logger.error(`生成 PPT 课件失败: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: `生成 PPT 课件失败: ${err.message}` });
  }
});

// ---- 8.4 生成 Excel 表格 (.xlsx) ----
app.post('/generate/xlsx', async (req, res) => {
  /**
   * 用 exceljs 生成 Excel。
   * 列宽自适应，表头加粗，隔行变色，冻结首行。
   *
   * 请求体：
   *   { rows: [[...], ...], filename?: string, sheetName?: string, dir?: string }
   */
  try {
    if (!ExcelJS) {
      return res.status(503).json({ ok: false, error: 'exceljs 模块未安装' });
    }
    const { rows, filename, sheetName, dir } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ ok: false, error: '缺少 rows 参数或为空' });
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheetName || 'Sheet1');

    // 边框样式
    const thinBorder = {
      top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      right: { style: 'thin', color: { argb: 'FFCCCCCC' } },
    };

    // 写入数据
    rows.forEach((row, ri) => {
      const excelRow = ws.addRow(row);
      excelRow.eachCell((cell, ci) => {
        cell.border = thinBorder;
        cell.font = { name: CN_FONT_PRIMARY, size: 11, color: { argb: 'FF' + THEME.ink } };
        cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };

        if (ri === 0) {
          // 表头
          cell.font = { name: CN_FONT_PRIMARY, size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
          cell.fill = {
            type: 'pattern', pattern: 'solid',
            fgColor: { argb: 'FF' + THEME.jade },
          };
          cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        } else if (ri % 2 === 0) {
          // 隔行变色
          cell.fill = {
            type: 'pattern', pattern: 'solid',
            fgColor: { argb: 'FF' + THEME.light_jade },
          };
        }
      });
    });

    // 列宽自适应（中文字符算 2 个宽度）
    const colCount = rows[0].length;
    for (let ci = 1; ci <= colCount; ci++) {
      let maxLen = 0;
      for (let ri = 0; ri < rows.length; ri++) {
        const val = rows[ri][ci - 1];
        if (val !== null && val !== undefined) {
          const valStr = String(val);
          let length = 0;
          for (const ch of valStr) {
            length += ch.charCodeAt(0) > 127 ? 2 : 1;
          }
          if (length > maxLen) maxLen = length;
        }
      }
      const col = ws.getColumn(ci);
      col.width = Math.max(8, Math.min(maxLen + 4, 50));
    }

    // 冻结首行
    if (rows.length > 1) {
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    }

    // 行高
    ws.getRow(1).height = 28;
    for (let ri = 2; ri <= rows.length; ri++) {
      ws.getRow(ri).height = 22;
    }

    // 生成 Buffer
    const buffer = await wb.xlsx.writeBuffer();

    // 保存
    const fname = safeFilename(filename || '表格', 'xlsx');
    const relDirName = dir || '量规';
    const saveDir = DIRS[relDirName] || DIRS['量规'];
    fs.mkdirSync(saveDir, { recursive: true });
    const savePath = path.join(saveDir, fname);
    fs.writeFileSync(savePath, Buffer.from(buffer));

    const relPath = `${relDirName}/${fname}`;
    logger.info(`生成 Excel: ${relPath} (${buffer.length} bytes, ${rows.length} 行)`);

    res.json({
      ok: true,
      data: {
        filename: fname,
        path: relPath,
        url: fileDownloadUrl(relPath),
        size: buffer.length,
        rows: rows.length,
      },
    });
  } catch (err) {
    logger.error(`生成 Excel 失败: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: `生成 Excel 失败: ${err.message}` });
  }
});

// ---- 8.5 生成 PDF 文档 (.pdf) ----
app.post('/generate/pdf', async (req, res) => {
  /**
   * 用 pdf-lib 生成 PDF。
   * 解析 Markdown 内容，绘制文本（支持中文需嵌入字体，降级为英文渲染）。
   *
   * 请求体：
   *   { title: string, content: string, filename?: string }
   */
  try {
    if (!PDFLib) {
      return res.status(503).json({ ok: false, error: 'pdf-lib 模块未安装' });
    }
    const { title, content, filename } = req.body;
    if (!title) {
      return res.status(400).json({ ok: false, error: '缺少 title 参数' });
    }

    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // 主题色（rgb 0-1）
    const colorJade = rgb(0x4f / 255, 0x7a / 255, 0x66 / 255);
    const colorInk = rgb(0x40 / 255, 0x3a / 255, 0x30 / 255);

    // A4 尺寸
    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const margin = 50;
    const maxWidth = pageWidth - margin * 2;
    let page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    // 标题
    const titleSize = 22;
    const titleWidth = fontBold.widthOfTextAtSize(title, titleSize);
    page.drawText(title, {
      x: (pageWidth - titleWidth) / 2,
      y: y,
      size: titleSize,
      font: fontBold,
      color: colorJade,
    });
    y -= titleSize + 20;

    // 解析 Markdown 为块
    const blocks = parseMarkdownToBlocks(content || '');

    for (const block of blocks) {
      if (block.type === 'h2') {
        if (y < margin + 30) {
          page = pdfDoc.addPage([pageWidth, pageHeight]);
          y = pageHeight - margin;
        }
        y -= 10;
        page.drawText(block.text, {
          x: margin, y, size: 16, font: fontBold, color: colorJade,
        });
        y -= 24;
      } else if (block.type === 'h3') {
        if (y < margin + 25) {
          page = pdfDoc.addPage([pageWidth, pageHeight]);
          y = pageHeight - margin;
        }
        y -= 5;
        page.drawText(block.text, {
          x: margin, y, size: 13, font: fontBold, color: colorInk,
        });
        y -= 20;
      } else if (block.type === 'list') {
        for (const item of block.items) {
          if (y < margin + 15) {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
          }
          const bullet = block.ordered ? '' : '\u2022 ';
          page.drawText(`${bullet}${item}`, {
            x: margin + 20, y, size: 12, font, color: colorInk,
          });
          y -= 18;
        }
      } else if (block.type === 'text') {
        // 简单文本换行
        const words = block.text.split('');
        let line = '';
        for (const ch of words) {
          const testLine = line + ch;
          if (font.widthOfTextAtSize(testLine, 12) > maxWidth) {
            if (y < margin + 15) {
              page = pdfDoc.addPage([pageWidth, pageHeight]);
              y = pageHeight - margin;
            }
            page.drawText(line, { x: margin, y, size: 12, font, color: colorInk });
            y -= 18;
            line = ch;
          } else {
            line = testLine;
          }
        }
        if (line) {
          if (y < margin + 15) {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
          }
          page.drawText(line, { x: margin, y, size: 12, font, color: colorInk });
          y -= 18;
        }
      }
      y -= 5;
    }

    const buffer = await pdfDoc.save();

    // 保存
    const fname = safeFilename(filename || title, 'pdf');
    const saveDir = DIRS['教案'];
    fs.mkdirSync(saveDir, { recursive: true });
    const savePath = path.join(saveDir, fname);
    fs.writeFileSync(savePath, buffer);

    const relPath = `教案/${fname}`;
    logger.info(`生成 PDF: ${relPath} (${buffer.length} bytes)`);

    res.json({
      ok: true,
      data: {
        filename: fname,
        path: relPath,
        url: fileDownloadUrl(relPath),
        size: buffer.length,
      },
    });
  } catch (err) {
    logger.error(`生成 PDF 失败: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: `生成 PDF 失败: ${err.message}` });
  }
});

// ---- 8.6 Markdown 转 Word (.docx) ----
app.post('/convert/md-to-docx', async (req, res) => {
  /**
   * 用 html-to-docx 将 Markdown 转 Word。
   * 先将 Markdown 渲染为 HTML，再转换为 docx。
   *
   * 请求体：
   *   { content: string, title?: string, filename?: string }
   */
  try {
    if (!htmlToDocx) {
      return res.status(503).json({ ok: false, error: 'html-to-docx 模块未安装' });
    }
    const { content, title, filename } = req.body;
    if (!content) {
      return res.status(400).json({ ok: false, error: '缺少 content 参数' });
    }

    const html = markdownToHtml(content);
    const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">` +
      `<style>body{font-family:'${CN_FONT_PRIMARY}',sans-serif;}</style>` +
      `</head><body><h1>${title || '文档'}</h1>${html}</body></html>`;

    const buffer = await htmlToDocx(fullHtml);

    // 保存
    const fname = safeFilename(filename || title || '文档', 'docx');
    const saveDir = DIRS['教案'];
    fs.mkdirSync(saveDir, { recursive: true });
    const savePath = path.join(saveDir, fname);
    fs.writeFileSync(savePath, buffer);

    const relPath = `教案/${fname}`;
    logger.info(`Markdown 转 Word: ${relPath} (${buffer.length} bytes)`);

    res.json({
      ok: true,
      data: {
        filename: fname,
        path: relPath,
        url: fileDownloadUrl(relPath),
        size: buffer.length,
      },
    });
  } catch (err) {
    logger.error(`Markdown 转 Word 失败: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: `Markdown 转 Word 失败: ${err.message}` });
  }
});

// ---- 8.7 HTML 转 PDF ----
app.post('/convert/html-to-pdf', async (req, res) => {
  /**
   * 用 puppeteer 将 HTML 渲染为 PDF（无头浏览器）。
   *
   * 请求体：
   *   { html: string, url?: string, filename?: string, options?: object }
   */
  try {
    const puppeteer = await getPuppeteer();
    if (!puppeteer) {
      return res.status(503).json({ ok: false, error: 'puppeteer 模块未安装' });
    }
    const { html, url: pageUrl, filename, options } = req.body;
    if (!html && !pageUrl) {
      return res.status(400).json({ ok: false, error: '缺少 html 或 url 参数' });
    }

    const launchOpts = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const browser = await puppeteer.launch(launchOpts);
    try {
      const page = await browser.newPage();
      if (pageUrl) {
        await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      } else {
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
      }
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '1cm', bottom: '1cm', left: '1cm', right: '1cm' },
        ...options,
      });

      // 保存
      const fname = safeFilename(filename || '文档', 'pdf');
      const saveDir = DIRS['临时'];
      fs.mkdirSync(saveDir, { recursive: true });
      const savePath = path.join(saveDir, fname);
      fs.writeFileSync(savePath, pdfBuffer);

      const relPath = `临时/${fname}`;
      logger.info(`HTML 转 PDF: ${relPath} (${pdfBuffer.length} bytes)`);

      res.json({
        ok: true,
        data: {
          filename: fname,
          path: relPath,
          url: fileDownloadUrl(relPath),
          size: pdfBuffer.length,
        },
      });
    } finally {
      await browser.close();
    }
  } catch (err) {
    logger.error(`HTML 转 PDF 失败: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: `HTML 转 PDF 失败: ${err.message}` });
  }
});

// ---- 8.8 Word 转 HTML ----
app.post('/convert/docx-to-html', async (req, res) => {
  /**
   * 用 mammoth 将 Word 转 HTML。
   *
   * 请求体：
   *   { file: string (base64), filename?: string }
   * 或使用 multipart/form-data 上传文件。
   */
  try {
    if (!mammoth) {
      return res.status(503).json({ ok: false, error: 'mammoth 模块未安装' });
    }

    let buffer;
    if (req.file) {
      // multipart 上传
      buffer = req.file.buffer;
    } else if (req.body.file) {
      // base64 编码
      buffer = Buffer.from(req.body.file, 'base64');
    } else {
      return res.status(400).json({ ok: false, error: '缺少 file 参数（base64）或上传文件' });
    }

    const result = await mammoth.convertToHtml({ buffer });
    const html = result.value;
    const messages = result.messages;

    logger.info(`Word 转 HTML: ${html.length} chars, ${messages.length} messages`);

    res.json({
      ok: true,
      data: {
        html,
        messages,
        length: html.length,
      },
    });
  } catch (err) {
    logger.error(`Word 转 HTML 失败: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: `Word 转 HTML 失败: ${err.message}` });
  }
});

// ---- 8.9 渲染 Mermaid 图 ----
app.post('/render/mermaid', async (req, res) => {
  /**
   * 将 Mermaid 语法渲染为 PNG/SVG 图。
   *
   * 请求体：
   *   { code: string, format?: 'png'|'svg', filename?: string }
   */
  try {
    const mermaid = await getMermaid();
    if (!mermaid) {
      return res.status(503).json({ ok: false, error: 'mermaid 模块未安装' });
    }
    const { code, format, filename } = req.body;
    if (!code) {
      return res.status(400).json({ ok: false, error: '缺少 code 参数' });
    }

    const outputFormat = (format || 'png').toLowerCase();
    const fname = safeFilename(filename || '图表', outputFormat);
    const saveDir = DIRS['临时'];
    fs.mkdirSync(saveDir, { recursive: true });
    const outputPath = path.join(saveDir, fname);

    // 临时输入文件
    const inputPath = path.join(saveDir, `_mermaid_input_${Date.now()}.mmd`);
    fs.writeFileSync(inputPath, code, 'utf-8');

    try {
      // 使用 mermaid-cli 的 render 函数
      const { run } = mermaid;
      await run(inputPath, outputPath, { outputFormat });

      const buffer = fs.readFileSync(outputPath);
      const relPath = `临时/${fname}`;
      logger.info(`渲染 Mermaid 图: ${relPath} (${buffer.length} bytes)`);

      res.json({
        ok: true,
        data: {
          filename: fname,
          path: relPath,
          url: fileDownloadUrl(relPath),
          size: buffer.length,
          format: outputFormat,
        },
      });
    } finally {
      // 清理临时输入文件
      try { fs.unlinkSync(inputPath); } catch (e) { /* 忽略 */ }
    }
  } catch (err) {
    logger.error(`渲染 Mermaid 图失败: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: `渲染 Mermaid 图失败: ${err.message}` });
  }
});

// ---- 8.10 渲染 LaTeX ----
app.post('/render/latex', async (req, res) => {
  /**
   * 用 node-latex 编译 LaTeX 为 PDF。
   *
   * 请求体：
   *   { code: string, filename?: string, engine?: 'xelatex'|'pdflatex' }
   */
  try {
    const nodeLatex = await getNodeLatex();
    if (!nodeLatex) {
      return res.status(503).json({ ok: false, error: 'node-latex 模块未安装' });
    }
    const { code, filename, engine } = req.body;
    if (!code) {
      return res.status(400).json({ ok: false, error: '缺少 code 参数' });
    }

    const latexEngine = engine || process.env.LATEX_ENGINE || 'xelatex';
    const pdfStream = nodeLatex(code, { cmd: latexEngine });

    const chunks = [];
    await new Promise((resolve, reject) => {
      pdfStream.on('data', (chunk) => chunks.push(chunk));
      pdfStream.on('end', resolve);
      pdfStream.on('error', reject);
    });
    const buffer = Buffer.concat(chunks);

    const fname = safeFilename(filename || '文档', 'pdf');
    const saveDir = DIRS['临时'];
    fs.mkdirSync(saveDir, { recursive: true });
    const savePath = path.join(saveDir, fname);
    fs.writeFileSync(savePath, buffer);

    const relPath = `临时/${fname}`;
    logger.info(`编译 LaTeX: ${relPath} (${buffer.length} bytes, ${latexEngine})`);

    res.json({
      ok: true,
      data: {
        filename: fname,
        path: relPath,
        url: fileDownloadUrl(relPath),
        size: buffer.length,
        engine: latexEngine,
      },
    });
  } catch (err) {
    logger.error(`编译 LaTeX 失败: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: `编译 LaTeX 失败: ${err.message}` });
  }
});

// ---- 8.11 图片处理 ----
app.post('/image/process', async (req, res) => {
  /**
   * 用 sharp 处理图片。
   * 支持 resize / crop / format convert / compress。
   *
   * 请求体：
   *   {
   *     file: string (base64) 或使用 multipart 上传,
   *     operations: {
   *       resize?: { width?, height?, fit? },
   *       format?: 'jpeg'|'png'|'webp'|'tiff',
   *       quality?: number (1-100),
   *       crop?: { left, top, width, height },
   *       rotate?: number,
   *       grayscale?: boolean,
   *       flatten?: { background }
   *     },
   *     filename?: string
   *   }
   */
  try {
    if (!sharp) {
      return res.status(503).json({ ok: false, error: 'sharp 模块未安装' });
    }

    let inputBuffer;
    if (req.file) {
      inputBuffer = req.file.buffer;
    } else if (req.body.file) {
      inputBuffer = Buffer.from(req.body.file, 'base64');
    } else {
      return res.status(400).json({ ok: false, error: '缺少 file 参数或上传文件' });
    }

    const operations = req.body.operations || {};
    let pipeline = sharp(inputBuffer);

    // 旋转
    if (operations.rotate) {
      pipeline = pipeline.rotate(operations.rotate);
    }

    // 裁剪
    if (operations.crop) {
      const { left, top, width, height } = operations.crop;
      pipeline = pipeline.extract({
        left: parseInt(left, 10) || 0,
        top: parseInt(top, 10) || 0,
        width: parseInt(width, 10) || 100,
        height: parseInt(height, 10) || 100,
      });
    }

    // 调整尺寸
    if (operations.resize) {
      const { width, height, fit } = operations.resize;
      pipeline = pipeline.resize({
        width: width ? parseInt(width, 10) : undefined,
        height: height ? parseInt(height, 10) : undefined,
        fit: fit || 'cover',
      });
    }

    // 灰度
    if (operations.grayscale) {
      pipeline = pipeline.grayscale();
    }

    // 背景填充
    if (operations.flatten) {
      pipeline = pipeline.flatten(operations.flatten);
    }

    // 格式转换 + 压缩
    const outputFormat = operations.format || 'png';
    const quality = operations.quality || 80;
    if (outputFormat === 'jpeg') {
      pipeline = pipeline.jpeg({ quality });
    } else if (outputFormat === 'png') {
      pipeline = pipeline.png({ quality });
    } else if (outputFormat === 'webp') {
      pipeline = pipeline.webp({ quality });
    } else if (outputFormat === 'tiff') {
      pipeline = pipeline.tiff({ quality });
    }

    const outputBuffer = await pipeline.toBuffer();

    const fname = safeFilename(req.body.filename || '图片', outputFormat);
    const saveDir = DIRS['临时'];
    fs.mkdirSync(saveDir, { recursive: true });
    const savePath = path.join(saveDir, fname);
    fs.writeFileSync(savePath, outputBuffer);

    const relPath = `临时/${fname}`;
    logger.info(`图片处理: ${relPath} (${inputBuffer.length} -> ${outputBuffer.length} bytes, ${outputFormat})`);

    res.json({
      ok: true,
      data: {
        filename: fname,
        path: relPath,
        url: fileDownloadUrl(relPath),
        size: outputBuffer.length,
        original_size: inputBuffer.length,
        format: outputFormat,
      },
    });
  } catch (err) {
    logger.error(`图片处理失败: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: `图片处理失败: ${err.message}` });
  }
});

// ---- 8.12 网页抓取 ----
app.post('/scrape', async (req, res) => {
  /**
   * 用 axios + cheerio 抓取网页内容并提取正文。
   *
   * 请求体：
   *   { url: string, selector?: string, extract?: 'text'|'html' }
   */
  try {
    if (!axios || !cheerio) {
      return res.status(503).json({ ok: false, error: 'axios 或 cheerio 模块未安装' });
    }
    const { url: targetUrl, selector, extract } = req.body;
    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: '缺少 url 参数' });
    }

    const response = await axios.get(targetUrl, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });

    const $ = cheerio.load(response.data);

    // 移除脚本和样式
    $('script, style, nav, footer, header, aside, iframe, noscript').remove();

    let result;
    const extractType = extract || 'text';

    if (selector) {
      // 使用指定选择器
      const elements = $(selector);
      if (extractType === 'html') {
        result = elements.map((_, el) => $(el).html()).get().join('\n');
      } else {
        result = elements.map((_, el) => $(el).text().trim()).get().join('\n');
      }
    } else {
      // 自动提取正文
      // 尝试常见的正文容器
      const articleSelectors = ['article', 'main', '.article', '.content', '.post-content', '#content'];
      let articleEl = null;
      for (const sel of articleSelectors) {
        if ($(sel).length > 0) {
          articleEl = $(sel).first();
          break;
        }
      }
      const target = articleEl || $('body');
      if (extractType === 'html') {
        result = target.html();
      } else {
        result = target.text().replace(/\s+/g, ' ').trim();
      }
    }

    // 提取标题
    const pageTitle = $('title').text().trim() || '';
    const pageDesc = $('meta[name="description"]').attr('content') || '';

    logger.info(`网页抓取: ${targetUrl} (${result.length} chars)`);

    res.json({
      ok: true,
      data: {
        url: targetUrl,
        title: pageTitle,
        description: pageDesc,
        content: result,
        length: result.length,
        extract_type: extractType,
        status_code: response.status,
      },
    });
  } catch (err) {
    logger.error(`网页抓取失败: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: `网页抓取失败: ${err.message}` });
  }
});

// ---- 8.13 网页截图 ----
app.post('/screenshot', async (req, res) => {
  /**
   * 用 puppeteer 对网页截图。
   *
   * 请求体：
   *   {
   *     url: string,
   *     format?: 'png'|'jpeg',
   *     width?: number, height?: number,
   *     fullPage?: boolean,
   *     filename?: string,
   *     waitSelector?: string,
   *     delay?: number (ms)
   *   }
   */
  try {
    const puppeteer = await getPuppeteer();
    if (!puppeteer) {
      return res.status(503).json({ ok: false, error: 'puppeteer 模块未安装' });
    }
    const {
      url: targetUrl, format, width, height,
      fullPage, filename, waitSelector, delay,
    } = req.body;
    if (!targetUrl) {
      return res.status(400).json({ ok: false, error: '缺少 url 参数' });
    }

    const launchOpts = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const browser = await puppeteer.launch(launchOpts);
    try {
      const page = await browser.newPage();
      await page.setViewport({
        width: width || 1920,
        height: height || 1080,
      });
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

      if (waitSelector) {
        await page.waitForSelector(waitSelector, { timeout: 10000 });
      }
      if (delay && delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }

      const screenshotFormat = (format || 'png').toLowerCase();
      const screenshotBuffer = await page.screenshot({
        type: screenshotFormat,
        fullPage: fullPage !== false,
        quality: screenshotFormat === 'jpeg' ? 85 : undefined,
      });

      const fname = safeFilename(filename || '截图', screenshotFormat);
      const saveDir = DIRS['临时'];
      fs.mkdirSync(saveDir, { recursive: true });
      const savePath = path.join(saveDir, fname);
      fs.writeFileSync(savePath, screenshotBuffer);

      const relPath = `临时/${fname}`;
      logger.info(`网页截图: ${relPath} (${screenshotBuffer.length} bytes, ${targetUrl})`);

      res.json({
        ok: true,
        data: {
          filename: fname,
          path: relPath,
          url: fileDownloadUrl(relPath),
          size: screenshotBuffer.length,
          format: screenshotFormat,
          source_url: targetUrl,
        },
      });
    } finally {
      await browser.close();
    }
  } catch (err) {
    logger.error(`网页截图失败: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: `网页截图失败: ${err.message}` });
  }
});

// ---- 8.14 下载 workspace 内文件 ----
app.get('/files/:path(*)', (req, res) => {
  /**
   * 下载 workspace 内文件。
   * 路径参数为相对 workspace 的路径，支持子目录。
   */
  try {
    const relPath = req.params.path || '';
    const filePath = validateWorkspacePath(relPath);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: `文件不存在: ${relPath}` });
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return res.status(400).json({ ok: false, error: `路径不是文件: ${relPath}` });
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeType = getMimeType(ext);
    const filename = path.basename(filePath);

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    logger.info(`下载文件: ${relPath} (${stat.size} bytes)`);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    logger.error(`下载文件失败: ${err.message}`);
    res.status(statusCode).json({ ok: false, error: err.message });
  }
});

// ---- 8.15 列出 workspace 文件 ----
app.get('/files', (req, res) => {
  /**
   * 列出 workspace 内所有文件，按子目录分组。
   */
  try {
    const filesByDir = {};
    let totalSize = 0;
    let totalFiles = 0;

    for (const [dirName, dirPath] of Object.entries(DIRS)) {
      filesByDir[dirName] = [];
      if (fs.existsSync(dirPath)) {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            const fullPath = path.join(dirPath, entry.name);
            const stat = fs.statSync(fullPath);
            const relPath = `${dirName}/${entry.name}`;
            filesByDir[dirName].push({
              name: entry.name,
              path: relPath,
              url: fileDownloadUrl(relPath),
              size: stat.size,
              modified: stat.mtime.toISOString(),
              ext: path.extname(entry.name).toLowerCase(),
            });
            totalSize += stat.size;
            totalFiles++;
          }
        }
      }
    }

    res.json({
      ok: true,
      data: {
        workspace: WORKSPACE_DIR,
        dirs: filesByDir,
        total_files: totalFiles,
        total_size: totalSize,
      },
    });
  } catch (err) {
    logger.error(`列出文件失败: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: `列出文件失败: ${err.message}` });
  }
});

// ---- 8.16 打包文件为 ZIP ----
app.post('/archive/zip', async (req, res) => {
  /**
   * 用 archiver 将多文件打包为 zip。
   *
   * 请求体：
   *   {
   *     files: [
   *       { path: '教案/xxx.docx', name?: '自定义名.docx' },
   *       ...
   *     ],
   *     filename?: string
   *   }
   */
  try {
    if (!archiver) {
      return res.status(503).json({ ok: false, error: 'archiver 模块未安装' });
    }
    const { files, filename } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ ok: false, error: '缺少 files 参数或为空' });
    }

    const fname = safeFilename(filename || '归档', 'zip');
    const saveDir = DIRS['临时'];
    fs.mkdirSync(saveDir, { recursive: true });
    const savePath = path.join(saveDir, fname);
    const output = fs.createWriteStream(savePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    const archiveFinished = new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
    });

    archive.pipe(output);

    for (const fileInfo of files) {
      const filePath = validateWorkspacePath(fileInfo.path);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const entryName = fileInfo.name || path.basename(fileInfo.path);
        archive.file(filePath, { name: entryName });
      }
    }

    await archive.finalize();
    await archiveFinished;

    const stat = fs.statSync(savePath);
    const relPath = `临时/${fname}`;
    logger.info(`打包 ZIP: ${relPath} (${stat.size} bytes, ${files.length} files)`);

    res.json({
      ok: true,
      data: {
        filename: fname,
        path: relPath,
        url: fileDownloadUrl(relPath),
        size: stat.size,
        file_count: files.length,
      },
    });
  } catch (err) {
    logger.error(`打包 ZIP 失败: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: `打包 ZIP 失败: ${err.message}` });
  }
});

// ============================================================
// 9. 错误处理中间件
// ============================================================

// 404 处理
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: `路径不存在: ${req.method} ${req.originalUrl}`,
  });
});

// 全局错误处理
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  logger.error(`未捕获错误: ${err.stack || err.message}`);
  res.status(statusCode).json({
    ok: false,
    error: err.message || '服务器内部错误',
  });
});

// ============================================================
// 10. 启动监听
// ============================================================

/**
 * 启动 Express 服务器。
 */
function startServer() {
  // 确保工作区目录存在
  ensureWorkspaceDirs();

  const server = app.listen(PORT, HOST, () => {
    BASE_URL = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
    logger.info('='.repeat(60));
    logger.info(`教师智能体沙箱 (Node.js) 已启动`);
    logger.info(`监听地址: http://${HOST}:${PORT}`);
    logger.info(`工作区: ${WORKSPACE_DIR}`);
    logger.info(`Node.js 版本: ${process.version}`);
    logger.info(`已加载模块: ${Object.entries(MODULE_STATUS)
      .map(([k, v]) => `${k}=${v}`).join(', ')}`);
    logger.info('='.repeat(60));
    logger.info(`可用端点:`);
    logger.info(`  GET  /health              - 健康检查`);
    logger.info(`  POST /generate/docx       - 生成 Word 文档`);
    logger.info(`  POST /generate/pptx       - 生成 PPT 课件`);
    logger.info(`  POST /generate/xlsx       - 生成 Excel 表格`);
    logger.info(`  POST /generate/pdf        - 生成 PDF 文档`);
    logger.info(`  POST /convert/md-to-docx  - Markdown 转 Word`);
    logger.info(`  POST /convert/html-to-pdf - HTML 转 PDF`);
    logger.info(`  POST /convert/docx-to-html- Word 转 HTML`);
    logger.info(`  POST /render/mermaid      - 渲染 Mermaid 图`);
    logger.info(`  POST /render/latex        - 编译 LaTeX`);
    logger.info(`  POST /image/process       - 图片处理`);
    logger.info(`  POST /scrape              - 网页抓取`);
    logger.info(`  POST /screenshot          - 网页截图`);
    logger.info(`  GET  /files               - 列出文件`);
    logger.info(`  GET  /files/:path         - 下载文件`);
    logger.info(`  POST /archive/zip         - 打包 ZIP`);
    logger.info('='.repeat(60));
  });

  // 优雅关闭
  function gracefulShutdown(signal) {
    logger.info(`${signal} 收到，正在关闭服务器...`);
    server.close(() => {
      logger.info('服务器已关闭');
      process.exit(0);
    });
    // 5 秒后强制退出
    setTimeout(() => {
      logger.error('强制退出');
      process.exit(1);
    }, 5000);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // 未捕获异常处理
  process.on('uncaughtException', (err) => {
    logger.error(`未捕获异常: ${err.stack || err.message}`);
  });
  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`未处理的 Promise 拒绝: ${reason}`);
  });

  return server;
}

// 启动服务（直接运行时）
if (require.main === module) {
  startServer();
}

// 导出模块（供测试或外部调用）
module.exports = {
  app,
  startServer,
  parseMarkdownToBlocks,
  blocksToDocxElements,
  parseTableRows,
  markdownToHtml,
  validateWorkspacePath,
  safeFilename,
  getDirByExt,
  fileDownloadUrl,
  getMimeType,
  THEME,
  DIRS,
  WORKSPACE_DIR,
  MODULE_STATUS,
};
