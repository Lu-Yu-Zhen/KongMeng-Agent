/*!
 * 悬浮球（孔孟大模型 AI 助手）
 * ------------------------------------------------------------------
 * 自包含的悬浮球模块，适用于孔孟大模型 学生端 / 教师端 两个应用。
 * 功能：
 *   1. 悬浮球悬浮于窗口边缘，鼠标左键点击打开/关闭聊天窗口；
 *   2. 聊天窗口 AI 可读取「当前页面全部内容 + 本端 data 文件夹数据」作为上下文；
 *   3. 聊天窗口大小可通过右下角拖拽手柄自由调整；
 *   4. 悬浮球右键打开设置面板（开关、大小、上下文开关、重置等）；
 *   5. 悬浮球颜色跟随应用所选主题色；
 *   6. 悬浮球 logo 使用孔孟大模型 logo。
 *   7. 设置页与聊天页互斥，只能同时打开一个；点击面板外部任意处即关闭。
 *
 * 依赖：应用已暴露的全局变量 MODEL_CONFIG / getSelectedChatModel() / getChatApiKey()。
 * 独立运行，不依赖框架，样式内嵌，直接 <script src="./悬浮球.js"></script> 引入即可。
 */
(function () {
  'use strict';

  // 页面尚未就绪时延迟初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    try {
      var CONFIG = window.KM_FLOAT_CONFIG || {};
      var LOGO = CONFIG.logo || 'logo.png';
      var STORAGE_KEY = 'km_floating_agent_settings';

      var DEFAULTS = {
        enabled: true,
        includePage: true,   // 聊天时是否携带当前页面上下文
        includeData: true,   // 聊天时是否携带本地 data 数据上下文
        width: 420,          // 聊天窗口宽度
        height: 560,         // 聊天窗口高度
        ballSize: 54,        // 悬浮球大小（直径 px）
        x: null,             // 悬浮球水平位置（相对视口，null 表示靠右居中）
        y: null              // 悬浮球垂直位置（相对视口，null 表示靠右居中）
      };

      var settings = loadSettings();
      var ball = null, chat = null, settingsPanel = null;
      var isChatOpen = false;
      var isDragging = false;
      var isResizing = false;
      var messages = [];        // 当前会话消息
      var busy = false;
      var ballSize = settings.ballSize || DEFAULTS.ballSize;

      // ==================== 主题色 ====================
      // 从应用的主题变量中读取主色（教师端 --accent，学生端 --brand-500）
      function getThemeAccent() {
        var cs = getComputedStyle(document.documentElement);
        var candidates = ['--accent', '--brand-500', '--jade500'];
        for (var i = 0; i < candidates.length; i++) {
          var v = cs.getPropertyValue(candidates[i]).trim();
          if (v) return v;
        }
        return '#1d4ed8';
      }
      function hexToRgb(hex) {
        hex = String(hex).replace('#', '');
        if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
        var n = parseInt(hex, 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
      }
      function toHex(v) {
        v = Math.max(0, Math.min(255, Math.round(v)));
        return (v < 16 ? '0' : '') + v.toString(16);
      }
      function lighten(hex, pct) {
        var c = hexToRgb(hex);
        return '#' + toHex(c.r + (255 - c.r) * pct) + toHex(c.g + (255 - c.g) * pct) + toHex(c.b + (255 - c.b) * pct);
      }
      function darken(hex, pct) {
        var c = hexToRgb(hex);
        return '#' + toHex(c.r * (1 - pct)) + toHex(c.g * (1 - pct)) + toHex(c.b * (1 - pct));
      }
      var ACCENT = getThemeAccent();
      var ACCENT_DARK = darken(ACCENT, 0.18);
      var ACCENT_LIGHT = lighten(ACCENT, 0.35);
      var ACCENT_RGB = (hexToRgb(ACCENT).r) + ',' + (hexToRgb(ACCENT).g) + ',' + (hexToRgb(ACCENT).b);
      var ACCENT_SOFT = 'rgba(' + ACCENT_RGB + ',0.08)';

      // 将主题色应用到悬浮球根节点，主题切换时重新应用
      function applyThemeColors() {
        ACCENT = getThemeAccent();
        ACCENT_DARK = darken(ACCENT, 0.18);
        ACCENT_LIGHT = lighten(ACCENT, 0.35);
        ACCENT_RGB = (hexToRgb(ACCENT).r) + ',' + (hexToRgb(ACCENT).g) + ',' + (hexToRgb(ACCENT).b);
        ACCENT_SOFT = 'rgba(' + ACCENT_RGB + ',0.08)';
        root.style.setProperty('--km-a', ACCENT);
        root.style.setProperty('--km-a-dark', ACCENT_DARK);
        root.style.setProperty('--km-a-light', ACCENT_LIGHT);
        root.style.setProperty('--km-a-rgb', ACCENT_RGB);
        root.style.setProperty('--km-a-soft', ACCENT_SOFT);
        var tiny = document.getElementById('km-float-reenable');
        if (tiny) tiny.style.background = ACCENT;
      }

      // ==================== 设置持久化 ====================
      function loadSettings() {
        var s = {};
        try {
          s = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
        } catch (e) { /* 忽略 */ }
        var out = {};
        for (var k in DEFAULTS) out[k] = DEFAULTS[k];
        for (var k2 in s) if (s[k2] !== undefined && s[k2] !== null) out[k2] = s[k2];
        return out;
      }
      function saveSettings() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* 忽略 */ }
      }

      // ==================== 环境检测 ====================
      function detectEnd() {
        var api = window.electronAPI;
        if (api && api.isElectron) {
          if (typeof api.readFileSync === 'function') return 'student';
          return 'teacher';
        }
        return 'browser';
      }

      // ==================== 构建上下文 ====================
      // 读取当前页面全部可见内容
      function buildPageContext() {
        var text = '';
        try {
          text = document.body ? (document.body.innerText || document.body.textContent || '') : '';
          text = text.replace(/\s+/g, ' ').trim();
        } catch (e) { text = ''; }
        if (text.length > 25000) text = text.substring(0, 25000);
        return text;
      }

      // 读取本端 data 文件夹数据作为上下文
      function buildDataContext() {
        var lines = [];
        var end = detectEnd();
        // 排除敏感键（API Key / token 等），防止密钥随上下文外发给第三方模型
        function isSensitiveKey(key) {
          var k = String(key || '').toLowerCase();
          if (k === 'ai_teacher_chat_models') return true; // 存放各家模型 API Key
          if (/(key|token|secret|password|credential|authorization)/.test(k)) return true;
          return false;
        }
        try {
          if (end === 'student') {
            // 学生端：data 文件夹下各 json 文件
            var files = [
              'data/knowledge/history.json',
              'data/qa/history.json',
              'data/grading/history.json',
              'data/homework/homework.json',
              'data/practice/history.json',
              'data/diagnosis/diagnosis.json'
            ];
            for (var i = 0; i < files.length; i++) {
              try {
                if (window.electronAPI.existsSync(files[i])) {
                  var raw = window.electronAPI.readFileSync(files[i]);
                  if (raw) lines.push('【' + files[i] + '】\n' + String(raw).slice(0, 4000));
                }
              } catch (e) { /* 忽略单个文件 */ }
            }
          } else if (end === 'teacher') {
            // 教师端：localStorage 已被 preload 覆写为文件存储（store.json 按模块落盘）
            var keys = [];
            for (var k = 0; k < localStorage.length; k++) {
              var key = localStorage.key(k);
              if (key) keys.push(key);
            }
            keys.forEach(function (key) {
              if (isSensitiveKey(key)) return;
              try {
                var v = localStorage.getItem(key);
                if (v && typeof v === 'string' && v.length) {
                  lines.push('【' + key + '】\n' + v.slice(0, 2000));
                }
              } catch (e) { /* 忽略 */ }
            });
          } else {
            // 浏览器模式：退化为读取 localStorage
            var keys2 = [];
            for (var k2 = 0; k2 < localStorage.length; k2++) {
              var key2 = localStorage.key(k2);
              if (key2) keys2.push(key2);
            }
            keys2.forEach(function (key) {
              if (isSensitiveKey(key)) return;
              try {
                var v2 = localStorage.getItem(key);
                if (v2 && typeof v2 === 'string' && v2.length) lines.push('【' + key + '】\n' + v2.slice(0, 1500));
              } catch (e) { /* 忽略 */ }
            });
          }
        } catch (e) { /* 忽略 */ }
        return lines.join('\n\n');
      }

      // 组装系统提示词
      function buildSystemPrompt() {
        var parts = [];
        parts.push('你是孔孟大模型，负责帮助用户在当前教育智能体应用内解答问题。请用中文简洁、准确地回答。');
        if (settings.includePage) {
          var page = buildPageContext();
          if (page) {
            parts.push('\n\n【当前页面内容】\n' + page);
          }
        }
        if (settings.includeData) {
          var data = buildDataContext();
          if (data) {
            parts.push('\n\n【本地数据（data 文件夹）】\n' + data);
          }
        }
        parts.push('\n\n请基于以上上下文回答用户问题；若上下文不足，请如实说明。');
        return parts.join('');
      }

      // ==================== AI 调用（兼容 OpenAI 协议） ====================
      function getModelInfo() {
        var model = (typeof getSelectedChatModel === 'function') ? getSelectedChatModel() : '';
        var cfg = (typeof MODEL_CONFIG !== 'undefined') ? (MODEL_CONFIG[model] || null) : null;
        var apiKey = (typeof getChatApiKey === 'function') ? getChatApiKey(model) : '';
        return { model: model, cfg: cfg, apiKey: apiKey };
      }

      async function aiChat(userText) {
        var info = getModelInfo();
        if (!info.model || !info.cfg) {
          throw new Error('请先在应用「设置」中配置并选择一个 AI 模型，悬浮球将使用该模型作答。');
        }
        if (!info.apiKey) {
          throw new Error('请先在应用「设置」中为「' + info.cfg.name + '」配置 API Key。');
        }
        var sys = buildSystemPrompt();
        var msgs = [{ role: 'system', content: sys }];
        // 携带最近几轮对话
        messages.slice(-10).forEach(function (m) {
          msgs.push({ role: m.role, content: m.content });
        });
        msgs.push({ role: 'user', content: userText });

        var resp = await fetch(info.cfg.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + info.apiKey
          },
          body: JSON.stringify({
            model: info.cfg.model,
            messages: msgs,
            temperature: 0.5
          })
        });
        if (!resp.ok) {
          var errText = await resp.text();
          throw new Error('AI 请求失败 (' + resp.status + '): ' + errText);
        }
        var data = await resp.json();
        var content = data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content : '';
        return content || '';
      }

      // ==================== 样式 ====================
      var CSS = '' +
        '#km-float-root{position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;font-family:"Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;}' +
        '#km-float-ball{position:fixed;border-radius:50%;cursor:grab;box-shadow:0 4px 16px rgba(0,0,0,.28);user-select:none;-webkit-user-select:none;overflow:hidden;background:#fff;border:2px solid var(--km-a);transition:transform .08s;}' +
        '#km-float-ball:active{cursor:grabbing;}' +
        '#km-float-ball img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;}' +
        '#km-float-ball:hover{transform:scale(1.06);}' +
        '#km-float-chat{position:fixed;display:none;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.25);overflow:hidden;z-index:2147483002;border:1px solid #e5e7eb;}' +
        '#km-float-chat.km-open{display:flex;}' +
        '.km-chat-header{display:flex;align-items:center;gap:8px;padding:8px 12px;background:linear-gradient(90deg,var(--km-a-dark),var(--km-a));color:#fff;flex:none;}' +
        '.km-chat-header img{width:26px;height:26px;border-radius:50%;object-fit:cover;background:#fff;}' +
        '.km-chat-header .km-chat-title{font-size:14px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.km-chat-header .km-chat-btn{background:rgba(255,255,255,.18);border:none;color:#fff;border-radius:6px;cursor:pointer;font-size:12px;padding:3px 7px;line-height:1;}' +
        '.km-chat-header .km-chat-btn:hover{background:rgba(255,255,255,.32);}' +
        '.km-chat-header .km-chat-btn.km-on{background:#22c55e;}' +
        '.km-chat-ctx{flex:none;padding:4px 12px;background:var(--km-a-soft);border-bottom:1px solid rgba(var(--km-a-rgb),.18);font-size:11px;color:var(--km-a-dark);display:flex;align-items:center;gap:6px;}' +
        '.km-chat-body{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;background:#f8fafc;}' +
        '.km-msg{max-width:88%;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;}' +
        '.km-msg-user{align-self:flex-end;background:var(--km-a);color:#fff;border-bottom-right-radius:3px;}' +
        '.km-msg-ai{align-self:flex-start;background:#fff;color:#111827;border:1px solid #e5e7eb;border-bottom-left-radius:3px;}' +
        '.km-msg-err{align-self:flex-start;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:10px;}' +
        '.km-msg-loading{align-self:flex-start;background:#fff;color:#6b7280;border:1px solid #e5e7eb;border-radius:10px;font-size:13px;padding:8px 12px;}' +
        '.km-chat-input{flex:none;display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff;align-items:flex-end;}' +
        '.km-chat-input textarea{flex:1;resize:none;border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box;height:38px;min-height:38px;max-height:120px;line-height:1.5;}' +
        '.km-chat-input textarea:focus{border-color:var(--km-a);box-shadow:0 0 0 2px rgba(var(--km-a-rgb),.15);}' +
        '.km-chat-input .km-send{flex:none;background:var(--km-a);color:#fff;border:none;border-radius:8px;box-sizing:border-box;height:38px;padding:0 16px;font-size:13px;cursor:pointer;}' +
        '.km-chat-input .km-send:hover{background:var(--km-a-dark);}' +
        '.km-chat-input .km-send:disabled{background:var(--km-a-light);cursor:not-allowed;}' +
        '#km-float-chat .km-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;z-index:5;}' +
        '#km-float-chat .km-resize::after{content:"";position:absolute;right:3px;bottom:3px;width:8px;height:8px;border-right:2px solid #9ca3af;border-bottom:2px solid #9ca3af;}' +
        '#km-float-settings{position:fixed;display:none;background:#fff;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.3);z-index:2147483003;width:244px;overflow:hidden;border:1px solid #e5e7eb;}' +
        '#km-float-settings.km-open{display:block;}' +
        '.km-settings-title{display:flex;align-items:center;gap:8px;padding:10px 12px;background:linear-gradient(90deg,var(--km-a-dark),var(--km-a));color:#fff;font-size:13px;font-weight:600;}' +
        '.km-settings-title img{width:22px;height:22px;border-radius:50%;object-fit:cover;background:#fff;}' +
        '.km-settings-body{padding:8px 12px 12px;}' +
        '.km-settings-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;font-size:13px;color:#111827;border-bottom:1px solid #f3f4f6;}' +
        '.km-settings-row:last-child{border-bottom:none;}' +
        '.km-settings-row .km-label{display:flex;align-items:center;gap:6px;}' +
        '.km-settings-row .km-label i{color:var(--km-a);font-size:12px;width:14px;text-align:center;}' +
        '.km-settings-switch{position:relative;width:36px;height:20px;background:#d1d5db;border-radius:10px;cursor:pointer;transition:background .2s;flex:none;}' +
        '.km-settings-switch.km-on{background:var(--km-a);}' +
        '.km-settings-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:left .2s;}' +
        '.km-settings-switch.km-on::after{left:18px;}' +
        '.km-settings-range{flex:none;width:116px;cursor:pointer;accent-color:var(--km-a);}' +
        '.km-settings-btn{width:100%;margin-top:8px;padding:7px;border:1px solid #d1d5db;background:#fff;border-radius:6px;font-size:12px;color:#374151;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;}' +
        '.km-settings-btn:hover{background:#f9fafb;}' +
        '.km-settings-btn.km-danger{color:#dc2626;border-color:#fecaca;}' +
        '.km-settings-btn.km-danger:hover{background:#fef2f2;}';

      var styleEl = document.createElement('style');
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);

      // ==================== 创建 DOM ====================
      var root = document.createElement('div');
      root.id = 'km-float-root';

      // 悬浮球
      ball = document.createElement('div');
      ball.id = 'km-float-ball';
      ball.title = '孔孟大模型 AI 助手（左键对话，右键设置）';
      var ballImg = document.createElement('img');
      ballImg.src = LOGO;
      ballImg.alt = '孔孟大模型';
      ball.appendChild(ballImg);
      root.appendChild(ball);

      // 聊天窗口
      chat = document.createElement('div');
      chat.id = 'km-float-chat';
      chat.innerHTML =
        '<div class="km-chat-header">' +
          '<img src="' + LOGO + '" alt="孔孟大模型">' +
          '<div class="km-chat-title">孔孟大模型 · AI 助手</div>' +
          '<button class="km-chat-btn" id="km-ctx-info" title="已读取当前页面与本地数据作为上下文"><i class="fa-solid fa-circle-info"></i></button>' +
          '<button class="km-chat-btn" id="km-chat-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>' +
        '</div>' +
        '<div class="km-chat-ctx" id="km-chat-ctx">' +
          '<i class="fa-solid fa-book-open"></i><span>已读取当前页面与本地数据作为上下文</span>' +
        '</div>' +
        '<div class="km-chat-body" id="km-chat-body"></div>' +
        '<div class="km-chat-input">' +
          '<textarea id="km-chat-input" placeholder="在此输入问题，回车发送…"></textarea>' +
          '<button class="km-send" id="km-chat-send"><i class="fa-solid fa-paper-plane"></i> 发送</button>' +
        '</div>' +
        '<div class="km-resize" id="km-chat-resize"></div>';
      root.appendChild(chat);

      // 设置面板
      settingsPanel = document.createElement('div');
      settingsPanel.id = 'km-float-settings';
      settingsPanel.innerHTML =
        '<div class="km-settings-title"><img src="' + LOGO + '" alt="孔孟大模型"> 悬浮球设置</div>' +
        '<div class="km-settings-body">' +
          '<div class="km-settings-row"><span class="km-label"><i class="fa-solid fa-toggle-on"></i> 悬浮球开关</span><div class="km-settings-switch km-on" data-key="enabled"></div></div>' +
          '<div class="km-settings-row"><span class="km-label"><i class="fa-solid fa-expand"></i> 悬浮球大小</span><input type="range" class="km-settings-range" id="km-settings-size" min="40" max="90" step="1"></div>' +
          '<div class="km-settings-row"><span class="km-label"><i class="fa-solid fa-file-lines"></i> 携带页面上下文</span><div class="km-settings-switch km-on" data-key="includePage"></div></div>' +
          '<div class="km-settings-row"><span class="km-label"><i class="fa-solid fa-database"></i> 携带本地数据</span><div class="km-settings-switch km-on" data-key="includeData"></div></div>' +
          '<button class="km-settings-btn" id="km-settings-reset"><i class="fa-solid fa-rotate-left"></i> 重置位置与大小</button>' +
          '<button class="km-settings-btn km-danger" id="km-settings-hide"><i class="fa-solid fa-eye-slash"></i> 隐藏悬浮球</button>' +
        '</div>';
      root.appendChild(settingsPanel);

      document.body.appendChild(root);

      // 应用主题色并监听主题切换，实现实时同步
      applyThemeColors();
      if (window.MutationObserver) {
        var themeObserver = new MutationObserver(function () {
          applyThemeColors();
        });
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      }

      // ==================== 位置与布局 ====================
      function applyBallSize() {
        ball.style.width = ballSize + 'px';
        ball.style.height = ballSize + 'px';
        applyBallPosition();
      }

      function applyBallPosition() {
        if (settings.x !== null && settings.y !== null) {
          ball.style.left = Math.max(0, Math.min(settings.x, (window.innerWidth - ballSize))) + 'px';
          ball.style.top = Math.max(0, Math.min(settings.y, (window.innerHeight - ballSize))) + 'px';
          ball.style.right = 'auto';
        } else {
          ball.style.right = '12px';
          ball.style.left = 'auto';
          ball.style.top = ((window.innerHeight - ballSize) / 2) + 'px';
        }
      }

      function positionChatWindow() {
        var cw = settings.width, ch = settings.height;
        var bw = ballSize, bh = ballSize;
        var bx = ball.offsetLeft, by = ball.offsetTop;
        var gap = 10;
        var x, y;
        if (bx + bw / 2 < window.innerWidth / 2) {
          // 悬浮球在左侧，聊天窗向右展开
          x = bx + bw + gap;
        } else {
          x = bx - cw - gap;
        }
        // 垂直居中对齐悬浮球
        y = by + bh / 2 - ch / 2;
        // 边界钳制
        if (x < 6) x = 6;
        if (x + cw > window.innerWidth - 6) x = window.innerWidth - cw - 6;
        if (y < 6) y = 6;
        if (y + ch > window.innerHeight - 6) y = window.innerHeight - ch - 6;
        chat.style.width = cw + 'px';
        chat.style.height = ch + 'px';
        chat.style.left = x + 'px';
        chat.style.top = y + 'px';
      }

      // 设置面板跟随悬浮球移动，且不遮挡悬浮球
      function positionSettingsWindow() {
        var pw = 244, ph = settingsPanel.offsetHeight || 320;
        var bw = ballSize, bh = ballSize;
        var bx = ball.offsetLeft, by = ball.offsetTop;
        var gap = 10;
        var x, y;
        if (bx + bw / 2 < window.innerWidth / 2) {
          x = bx + bw + gap;
        } else {
          x = bx - pw - gap;
        }
        y = by + bh / 2 - ph / 2;
        if (x < 6) x = 6;
        if (x + pw > window.innerWidth - 6) x = window.innerWidth - pw - 6;
        if (y < 6) y = 6;
        if (y + ph > window.innerHeight - 6) y = window.innerHeight - ph - 6;
        settingsPanel.style.left = x + 'px';
        settingsPanel.style.top = y + 'px';
      }

      function showBall() {
        ball.style.display = 'block';
        applyBallPosition();
      }

      function toggleChat() {
        if (isChatOpen) {
          closeChat();
        } else {
          openChat();
        }
      }

      function openChat() {
        closeSettings();
        isChatOpen = true;
        positionChatWindow();
        chat.style.display = 'flex';
        chat.classList.add('km-open');
        var body = document.getElementById('km-chat-body');
        if (body && body.children.length === 0) {
          addMsg('ai', '你好，我是孔孟大模型 AI 助手。我已读取当前页面及本地数据作为上下文，请问有什么可以帮你？');
        }
        var input = document.getElementById('km-chat-input');
        if (input) setTimeout(function () { input.focus(); }, 50);
      }

      function closeChat() {
        isChatOpen = false;
        chat.style.display = 'none';
        chat.classList.remove('km-open');
      }

      function addMsg(role, text) {
        var body = document.getElementById('km-chat-body');
        if (!body) return;
        var div = document.createElement('div');
        div.className = 'km-msg km-msg-' + role;
        div.textContent = text;
        body.appendChild(div);
        body.scrollTop = body.scrollHeight;
        return div;
      }

      // ==================== 发送消息 ====================
      async function send() {
        var input = document.getElementById('km-chat-input');
        var text = input.value.trim();
        if (!text || busy) return;
        input.value = '';
        messages.push({ role: 'user', content: text });
        addMsg('user', text);
        busy = true;
        var sendBtn = document.getElementById('km-chat-send');
        if (sendBtn) sendBtn.disabled = true;
        var loading = addMsg('loading', '孔孟大模型 思考中…');
        try {
          var reply = await aiChat(text);
          messages.push({ role: 'assistant', content: reply });
          if (loading) loading.remove();
          addMsg('ai', reply || '（无回复）');
        } catch (e) {
          if (loading) loading.remove();
          addMsg('err', '出错：' + e.message);
        } finally {
          busy = false;
          if (sendBtn) sendBtn.disabled = false;
          input.focus();
        }
      }

      // ==================== 事件绑定 ====================
      // 悬浮球：左键切换聊天，右键设置
      ball.addEventListener('mousedown', function (e) {
        if (e.button === 2) return; // 右键交给 contextmenu
        e.preventDefault();
        if (isDragging) return;
        isDragging = true;
        var startX = e.clientX, startY = e.clientY;
        var origLeft = ball.offsetLeft, origTop = ball.offsetTop;
        var moved = false;

        function onMove(ev) {
          if (!isDragging) return;
          var dx = ev.clientX - startX, dy = ev.clientY - startY;
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
          var nx = origLeft + dx, ny = origTop + dy;
          nx = Math.max(0, Math.min(nx, window.innerWidth - ballSize));
          ny = Math.max(0, Math.min(ny, window.innerHeight - ballSize));
          ball.style.left = nx + 'px';
          ball.style.top = ny + 'px';
          ball.style.right = 'auto';
          if (isChatOpen) positionChatWindow();
          if (settingsPanel.classList.contains('km-open')) positionSettingsWindow();
        }

        function onUp(ev) {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          isDragging = false;
          if (!moved) {
            // 未拖动 → 视为点击，切换聊天
            toggleChat();
            return;
          }
          // 拖动结束：记录位置（拖到边缘不再自动隐藏，仅由开关控制）
          settings.x = ball.offsetLeft;
          settings.y = ball.offsetTop;
          saveSettings();
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      ball.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openSettings();
      });

      // 聊天窗口关闭
      document.getElementById('km-chat-close').addEventListener('click', function () {
        closeChat();
      });
      // 上下文信息提示
      document.getElementById('km-ctx-info').addEventListener('click', function () {
        addMsg('ai', '当前会携带：\n' +
          (settings.includePage ? '· 当前页面全部内容 ✓' : '· 当前页面内容 ✗') + '\n' +
          (settings.includeData ? '· 本端 data 文件夹数据 ✓' : '· 本端 data 文件夹数据 ✗') + '\n\n可在悬浮球右键「设置」中调整。');
      });

      // 聊天输入
      var inputEl = document.getElementById('km-chat-input');
      inputEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      });
      document.getElementById('km-chat-send').addEventListener('click', send);

      // 窗口大小调整
      var resizeHandle = document.getElementById('km-chat-resize');
      resizeHandle.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        isResizing = true;
        var startX = e.clientX, startY = e.clientY;
        var startW = settings.width, startH = settings.height;

        function onResize(ev) {
          if (!isResizing) return;
          var nw = startW + (ev.clientX - startX);
          var nh = startH + (ev.clientY - startY);
          nw = Math.max(300, Math.min(nw, window.innerWidth - 40));
          nh = Math.max(320, Math.min(nh, window.innerHeight - 40));
          settings.width = nw;
          settings.height = nh;
          positionChatWindow();
        }
        function onUpResize() {
          document.removeEventListener('mousemove', onResize);
          document.removeEventListener('mouseup', onUpResize);
          isResizing = false;
          saveSettings();
        }
        document.addEventListener('mousemove', onResize);
        document.addEventListener('mouseup', onUpResize);
      });

      // 设置面板
      function openSettings() {
        closeChat();
        refreshSettingsUI();
        settingsPanel.style.display = 'block';
        settingsPanel.classList.add('km-open');
        positionSettingsWindow();
      }
      function closeSettings() {
        settingsPanel.style.display = 'none';
        settingsPanel.classList.remove('km-open');
      }

      function refreshSettingsUI() {
        settingsPanel.querySelectorAll('.km-settings-switch').forEach(function (el) {
          var key = el.getAttribute('data-key');
          var on = settings[key] === true;
          el.classList.toggle('km-on', on);
        });
        var sizeRange = document.getElementById('km-settings-size');
        if (sizeRange) sizeRange.value = ballSize;
      }

      function bindSettingsSwitches() {
        settingsPanel.querySelectorAll('.km-settings-switch').forEach(function (el) {
          el.addEventListener('click', function () {
            var key = el.getAttribute('data-key');
            settings[key] = !settings[key];
            el.classList.toggle('km-on', settings[key]);
            saveSettings();
            if (key === 'enabled' && !settings.enabled) {
              // 关闭悬浮球：隐藏，并提供重新启用入口
              hideBallCompletely();
              showTinyReenable();
            } else if (key === 'enabled' && settings.enabled) {
              showBall();
            }
          });
        });
        // 悬浮球大小滑动条
        var sizeRange = document.getElementById('km-settings-size');
        if (sizeRange) {
          sizeRange.addEventListener('input', function () {
            ballSize = parseInt(sizeRange.value, 10) || DEFAULTS.ballSize;
            settings.ballSize = ballSize;
            saveSettings();
            applyBallSize();
            if (isChatOpen) positionChatWindow();
            if (settingsPanel.classList.contains('km-open')) positionSettingsWindow();
          });
        }
      }

      function hideBallCompletely() {
        closeChat();
        closeSettings();
        ball.style.display = 'none';
      }

      document.getElementById('km-settings-reset').addEventListener('click', function () {
        settings.width = DEFAULTS.width;
        settings.height = DEFAULTS.height;
        settings.x = null;
        settings.y = null;
        ballSize = DEFAULTS.ballSize;
        settings.ballSize = DEFAULTS.ballSize;
        saveSettings();
        applyBallSize();
        showBall();
        closeSettings();
      });

      document.getElementById('km-settings-hide').addEventListener('click', function () {
        settings.enabled = false;
        saveSettings();
        hideBallCompletely();
        // 重新启用入口：点击页面右下角小图标
        showTinyReenable();
      });

      // 关闭悬浮球后，提供一个微型入口便于重新启用
      function showTinyReenable() {
        var tiny = document.createElement('div');
        tiny.id = 'km-float-reenable';
        tiny.textContent = '●';
        tiny.setAttribute('title', '点击重新开启悬浮球');
        tiny.style.cssText = 'position:fixed;right:10px;bottom:10px;width:22px;height:22px;border-radius:50%;background:' + ACCENT + ';color:#fff;font-size:12px;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2147483004;box-shadow:0 2px 8px rgba(0,0,0,.3);';
        document.body.appendChild(tiny);
        tiny.addEventListener('click', function () {
          settings.enabled = true;
          saveSettings();
          tiny.remove();
          refreshSettingsUI();
          showBall();
        });
      }

      // 点击面板外部任意处关闭已打开的面板（设置与聊天互斥，各自外部点击关闭）
      document.addEventListener('mousedown', function (e) {
        if (settingsPanel.classList.contains('km-open') &&
            !settingsPanel.contains(e.target) &&
            !ball.contains(e.target)) {
          closeSettings();
        }
        if (chat.classList.contains('km-open') &&
            !chat.contains(e.target) &&
            !ball.contains(e.target)) {
          closeChat();
        }
      });

      // 窗口尺寸变化时重新定位
      window.addEventListener('resize', function () {
        if (isChatOpen) positionChatWindow();
        if (settingsPanel.classList.contains('km-open')) positionSettingsWindow();
        if (settings.x === null) applyBallPosition();
      });

      // ==================== 初始化 ====================
      bindSettingsSwitches();
      refreshSettingsUI();
      applyBallSize();
      if (settings.enabled) {
        showBall();
      } else {
        hideBallCompletely();
        showTinyReenable();
      }

      // 暴露控制接口（便于调试与扩展）
      window.KMFloat = {
        openChat: openChat,
        closeChat: closeChat,
        showBall: showBall,
        hide: hideBallCompletely,
        getSettings: function () { return JSON.parse(JSON.stringify(settings)); }
      };
    } catch (e) {
      console.error('[悬浮球] 初始化失败:', e);
    }
  }
})();