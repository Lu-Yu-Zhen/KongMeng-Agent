/*!
 * 悬浮球（孔孟大模型 AI 助手）
 * ------------------------------------------------------------------
 * 自包含的悬浮球模块，适用于孔孟大模型 学生端 / 教师端 两个应用。
 * 功能：
 *   1. 悬浮球悬浮于窗口边缘，鼠标左键点击打开/关闭聊天窗口；
 *   2. 聊天窗口 AI 可读取「当前页面全部内容 + 本端 data 文件夹数据」作为上下文；
 *   3. 聊天窗口大小可通过右下角拖拽手柄自由调整；
 *   4. 悬浮球右键打开设置面板（开关、吸附位置、自动隐藏、上下文开关、重置等）；
 *   5. 拖动悬浮球到屏幕边缘（碰到边缘）自动隐藏到边上，露出箭头，鼠标移上去即可重新显示；
 *   6. 悬浮球 logo 使用孔孟大模型 logo。
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
        snapSide: 'right',   // 悬浮球吸附边：left | right
        autoHide: true,      // 拖到边缘是否自动隐藏
        includePage: true,   // 聊天时是否携带当前页面上下文
        includeData: true,   // 聊天时是否携带本地 data 数据上下文
        width: 420,
        height: 560,
        x: null,             // 悬浮球水平位置（相对视口，null 表示吸附边）
        y: null              // 悬浮球垂直位置（相对视口，null 表示中部）
      };

      var settings = loadSettings();
      var ball = null, chat = null, settingsPanel = null, edge = null;
      var isChatOpen = false;
      var isHidden = false;     // 是否已隐藏到边缘（仅显示箭头）
      var isDragging = false;
      var isResizing = false;
      var messages = [];        // 当前会话消息
      var busy = false;

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
        '#km-float-ball{position:fixed;width:54px;height:54px;border-radius:50%;cursor:grab;box-shadow:0 4px 16px rgba(0,0,0,.28);user-select:none;-webkit-user-select:none;overflow:hidden;background:#fff;border:2px solid #fff;transition:transform .08s;}' +
        '#km-float-ball:active{cursor:grabbing;}' +
        '#km-float-ball img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;}' +
        '#km-float-ball:hover{transform:scale(1.06);}' +
        '#km-float-edge{position:fixed;width:16px;top:0;bottom:0;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:2147483001;background:rgba(30,64,175,.08);}' +
        '#km-float-edge .km-edge-icon{width:16px;height:44px;border-radius:0 8px 8px 0;background:linear-gradient(180deg,#1d4ed8,#3b82f6);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.25);}' +
        '#km-float-edge:hover .km-edge-icon{background:linear-gradient(180deg,#1e40af,#2563eb);}' +
        '#km-float-chat{position:fixed;display:none;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.25);overflow:hidden;z-index:2147483002;border:1px solid #e5e7eb;}' +
        '#km-float-chat.km-open{display:flex;}' +
        '.km-chat-header{display:flex;align-items:center;gap:8px;padding:8px 12px;background:linear-gradient(90deg,#1d4ed8,#3b82f6);color:#fff;flex:none;}' +
        '.km-chat-header img{width:26px;height:26px;border-radius:50%;object-fit:cover;background:#fff;}' +
        '.km-chat-header .km-chat-title{font-size:14px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.km-chat-header .km-chat-btn{background:rgba(255,255,255,.18);border:none;color:#fff;border-radius:6px;cursor:pointer;font-size:12px;padding:3px 7px;line-height:1;}' +
        '.km-chat-header .km-chat-btn:hover{background:rgba(255,255,255,.32);}' +
        '.km-chat-header .km-chat-btn.km-on{background:#22c55e;}' +
        '.km-chat-ctx{flex:none;padding:4px 12px;background:#f0f9ff;border-bottom:1px solid #e0f2fe;font-size:11px;color:#0369a1;display:flex;align-items:center;gap:6px;}' +
        '.km-chat-body{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;background:#f8fafc;}' +
        '.km-msg{max-width:88%;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;}' +
        '.km-msg-user{align-self:flex-end;background:#1d4ed8;color:#fff;border-bottom-right-radius:3px;}' +
        '.km-msg-ai{align-self:flex-start;background:#fff;color:#111827;border:1px solid #e5e7eb;border-bottom-left-radius:3px;}' +
        '.km-msg-err{align-self:flex-start;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:10px;}' +
        '.km-msg-loading{align-self:flex-start;background:#fff;color:#6b7280;border:1px solid #e5e7eb;border-radius:10px;font-size:13px;padding:8px 12px;}' +
        '.km-chat-input{flex:none;display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff;align-items:flex-end;}' +
        '.km-chat-input textarea{flex:1;resize:none;border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;outline:none;min-height:38px;max-height:120px;line-height:1.5;}' +
        '.km-chat-input textarea:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.15);}' +
        '.km-chat-input .km-send{flex:none;background:#1d4ed8;color:#fff;border:none;border-radius:8px;padding:9px 16px;font-size:13px;cursor:pointer;}' +
        '.km-chat-input .km-send:hover{background:#1e40af;}' +
        '.km-chat-input .km-send:disabled{background:#93c5fd;cursor:not-allowed;}' +
        '#km-float-chat .km-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;z-index:5;}' +
        '#km-float-chat .km-resize::after{content:"";position:absolute;right:3px;bottom:3px;width:8px;height:8px;border-right:2px solid #9ca3af;border-bottom:2px solid #9ca3af;}' +
        '#km-float-settings{position:fixed;display:none;background:#fff;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.3);z-index:2147483003;width:230px;overflow:hidden;border:1px solid #e5e7eb;}' +
        '#km-float-settings.km-open{display:block;}' +
        '.km-settings-title{display:flex;align-items:center;gap:8px;padding:10px 12px;background:linear-gradient(90deg,#1d4ed8,#3b82f6);color:#fff;font-size:13px;font-weight:600;}' +
        '.km-settings-title img{width:22px;height:22px;border-radius:50%;object-fit:cover;background:#fff;}' +
        '.km-settings-body{padding:8px 12px 12px;}' +
        '.km-settings-row{display:flex;align-items:center;justify-content:space-between;padding:7px 0;font-size:13px;color:#111827;border-bottom:1px solid #f3f4f6;}' +
        '.km-settings-row:last-child{border-bottom:none;}' +
        '.km-settings-row .km-label{display:flex;align-items:center;gap:6px;}' +
        '.km-settings-row .km-label i{color:#3b82f6;font-size:12px;width:14px;text-align:center;}' +
        '.km-settings-switch{position:relative;width:36px;height:20px;background:#d1d5db;border-radius:10px;cursor:pointer;transition:background .2s;flex:none;}' +
        '.km-settings-switch.km-on{background:#3b82f6;}' +
        '.km-settings-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:left .2s;}' +
        '.km-settings-switch.km-on::after{left:18px;}' +
        '.km-settings-seg{display:flex;border:1px solid #d1d5db;border-radius:6px;overflow:hidden;flex:none;}' +
        '.km-settings-seg button{border:none;background:#fff;padding:4px 10px;font-size:12px;cursor:pointer;color:#374151;}' +
        '.km-settings-seg button.km-on{background:#3b82f6;color:#fff;}' +
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

      // 边缘箭头（隐藏时显示）
      edge = document.createElement('div');
      edge.id = 'km-float-edge';
      edge.style.display = 'none';
      edge.innerHTML = '<div class="km-edge-icon"><i class="fa-solid fa-angle-left"></i></div>';
      root.appendChild(edge);

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
          '<div class="km-settings-row"><span class="km-label"><i class="fa-solid fa-left-right"></i> 吸附位置</span>' +
            '<div class="km-settings-seg" data-key="snapSide"><button data-val="left">左</button><button data-val="right">右</button></div></div>' +
          '<div class="km-settings-row"><span class="km-label"><i class="fa-solid fa-arrows-up-down"></i> 拖到边缘自动隐藏</span><div class="km-settings-switch km-on" data-key="autoHide"></div></div>' +
          '<div class="km-settings-row"><span class="km-label"><i class="fa-solid fa-file-lines"></i> 携带页面上下文</span><div class="km-settings-switch km-on" data-key="includePage"></div></div>' +
          '<div class="km-settings-row"><span class="km-label"><i class="fa-solid fa-database"></i> 携带本地数据</span><div class="km-settings-switch km-on" data-key="includeData"></div></div>' +
          '<button class="km-settings-btn" id="km-settings-reset"><i class="fa-solid fa-rotate-left"></i> 重置位置与大小</button>' +
          '<button class="km-settings-btn km-danger" id="km-settings-hide"><i class="fa-solid fa-eye-slash"></i> 隐藏悬浮球</button>' +
        '</div>';
      root.appendChild(settingsPanel);

      document.body.appendChild(root);

      // ==================== 位置与布局 ====================
      function applyBallPosition() {
        if (settings.x !== null && settings.y !== null) {
          ball.style.left = Math.max(0, Math.min(settings.x, (window.innerWidth - 54))) + 'px';
          ball.style.top = Math.max(0, Math.min(settings.y, (window.innerHeight - 54))) + 'px';
          ball.style.right = 'auto';
        } else {
          if (settings.snapSide === 'left') {
            ball.style.left = '12px';
            ball.style.right = 'auto';
          } else {
            ball.style.right = '12px';
            ball.style.left = 'auto';
          }
          ball.style.top = ((window.innerHeight - 54) / 2) + 'px';
        }
      }

      function positionChatWindow() {
        var cw = settings.width, ch = settings.height;
        var bw = 54, bh = 54;
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

      function showBall() {
        isHidden = false;
        ball.style.display = 'block';
        edge.style.display = 'none';
        applyBallPosition();
      }

      function hideToEdge() {
        if (!settings.autoHide) return;
        isHidden = true;
        closeChat();
        ball.style.display = 'none';
        edge.style.display = 'flex';
        edge.style.left = 'auto';
        edge.style.right = 'auto';
        edge.style.top = Math.max(0, Math.min(ball.offsetTop, window.innerHeight - 44)) + 'px';
        edge.style.bottom = 'auto';
        if (settings.snapSide === 'left') {
          edge.style.left = '0px';
          edge.style.right = 'auto';
          edge.querySelector('.km-edge-icon').innerHTML = '<i class="fa-solid fa-angle-right"></i>';
        } else {
          edge.style.right = '0px';
          edge.style.left = 'auto';
          edge.querySelector('.km-edge-icon').innerHTML = '<i class="fa-solid fa-angle-left"></i>';
        }
      }

      function toggleChat() {
        if (isChatOpen) {
          closeChat();
        } else {
          openChat();
        }
      }

      function openChat() {
        if (isHidden) showBall();
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
          nx = Math.max(0, Math.min(nx, window.innerWidth - 54));
          ny = Math.max(0, Math.min(ny, window.innerHeight - 54));
          ball.style.left = nx + 'px';
          ball.style.top = ny + 'px';
          ball.style.right = 'auto';
          if (isChatOpen) positionChatWindow();
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
          // 拖动结束：记录位置；若靠近屏幕边缘则隐藏
          settings.x = ball.offsetLeft;
          settings.y = ball.offsetTop;
          saveSettings();
          var r = ball.getBoundingClientRect();
          var vw = window.innerWidth;
          var nearLeft = r.left <= 2;
          var nearRight = r.right >= vw - 2;
          if (nearLeft || nearRight) {
            settings.snapSide = nearLeft ? 'left' : 'right';
            settings.x = null;
            settings.y = null;
            saveSettings();
            hideToEdge();
          }
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      ball.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openSettings(e.clientX, e.clientY);
      });

      // 边缘箭头：移入显示悬浮球
      edge.addEventListener('mouseenter', function () {
        showBall();
      });
      edge.addEventListener('click', function () {
        showBall();
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
      function openSettings(x, y) {
        settingsPanel.style.display = 'block';
        settingsPanel.classList.add('km-open');
        // 刷新控件状态
        refreshSettingsUI();
        // 定位，避免超出视口
        var pw = 230, ph = settingsPanel.offsetHeight || 320;
        var px = x, py = y;
        if (px + pw > window.innerWidth - 4) px = window.innerWidth - pw - 4;
        if (py + ph > window.innerHeight - 4) py = window.innerHeight - ph - 4;
        if (px < 4) px = 4;
        if (py < 4) py = 4;
        settingsPanel.style.left = px + 'px';
        settingsPanel.style.top = py + 'px';
      }
      function closeSettings() {
        settingsPanel.style.display = 'none';
        settingsPanel.classList.remove('km-open');
      }

      function refreshSettingsUI() {
        var switches = settingsPanel.querySelectorAll('.km-settings-switch');
        switches.forEach(function (el) {
          var key = el.getAttribute('data-key');
          var on = settings[key] === true;
          el.classList.toggle('km-on', on);
          el.innerHTML = '';
        });
        // 重新渲染开关轨道
        settingsPanel.querySelectorAll('.km-settings-switch').forEach(function (el) {
          var key = el.getAttribute('data-key');
          var on = settings[key] === true;
          el.classList.toggle('km-on', on);
        });
        // 吸附位置 seg
        var seg = settingsPanel.querySelector('.km-settings-seg[data-key="snapSide"]');
        if (seg) {
          seg.querySelectorAll('button').forEach(function (btn) {
            btn.classList.toggle('km-on', btn.getAttribute('data-val') === settings.snapSide);
          });
        }
      }

      function bindSettingsSwitches() {
        settingsPanel.querySelectorAll('.km-settings-switch').forEach(function (el) {
          el.addEventListener('click', function () {
            var key = el.getAttribute('data-key');
            settings[key] = !settings[key];
            el.classList.toggle('km-on', settings[key]);
            saveSettings();
            if (key === 'enabled' && !settings.enabled) {
              // 关闭悬浮球：隐藏，箭头也隐藏，并提供重新启用入口
              hideBallCompletely();
              showTinyReenable();
            } else if (key === 'enabled' && settings.enabled) {
              showBall();
            }
          });
        });
        settingsPanel.querySelectorAll('.km-settings-seg[data-key="snapSide"] button').forEach(function (btn) {
          btn.addEventListener('click', function () {
            settings.snapSide = btn.getAttribute('data-val');
            settings.x = null;
            settings.y = null;
            saveSettings();
            refreshSettingsUI();
            showBall();
          });
        });
      }

      function hideBallCompletely() {
        closeChat();
        closeSettings();
        ball.style.display = 'none';
        edge.style.display = 'none';
      }

      document.getElementById('km-settings-reset').addEventListener('click', function () {
        settings.width = DEFAULTS.width;
        settings.height = DEFAULTS.height;
        settings.x = null;
        settings.y = null;
        settings.snapSide = DEFAULTS.snapSide;
        saveSettings();
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
        tiny.style.cssText = 'position:fixed;right:10px;bottom:10px;width:22px;height:22px;border-radius:50%;background:#1d4ed8;color:#fff;font-size:12px;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2147483004;box-shadow:0 2px 8px rgba(0,0,0,.3);';
        document.body.appendChild(tiny);
        tiny.addEventListener('click', function () {
          settings.enabled = true;
          saveSettings();
          tiny.remove();
          refreshSettingsUI();
          showBall();
        });
      }

      // 点击空白处关闭设置面板
      document.addEventListener('mousedown', function (e) {
        if (settingsPanel.classList.contains('km-open') &&
            !settingsPanel.contains(e.target) &&
            !ball.contains(e.target)) {
          closeSettings();
        }
      });

      // 窗口尺寸变化时重新定位
      window.addEventListener('resize', function () {
        if (isChatOpen) positionChatWindow();
        if (settings.x === null) applyBallPosition();
      });

      // ==================== 初始化 ====================
      bindSettingsSwitches();
      refreshSettingsUI();
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