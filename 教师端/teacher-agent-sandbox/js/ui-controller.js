/*!
 * teacher-agent-sandbox · UI 交互控制器 (ui-controller.js)
 * ------------------------------------------------------------------
 * 将智能体执行过程（思考/工具调用/产物/最终答案）渲染到现有备课界面，
 * 并以最小侵入方式接入：
 *   1) 包装 sendBeikeFollowup：Agent 模式下走 AgentCore，Chat 模式走原逻辑
 *   2) 增强 renderBeikeSkillGrid：用 AgentSkills 市场数据
 *   3) 沙箱状态指示 & 产物下载 & 推荐追问
 * 不修改 HTML 其他部分（学生提问/批改等不受影响）。
 */
(function (global) {
  'use strict';

  // beikeChatMode 现在用 var 声明，可以直接通过 window 访问
  function _getMode() {
    return global.beikeChatMode || 'chat';
  }

  const SandboxUI = {
    ready: false,
    _origSend: null,
    _origRenderSkillGrid: null,
    artifacts: [],

    /** 初始化：等待依赖就绪后挂钩 */
    async init() {
      if (this.ready) return;
      // 等待主 HTML 的函数就绪（异步轮询，不阻塞 UI 线程）
      const ok = await this._waitFor(() => global.sendBeikeFollowup && global.appendMsg && global.renderMarkdown, 5000);
      if (!ok) { console.warn('[agent-ui] 主界面函数未就绪，延后挂钩'); return; }

      // 初始化各能力模块
      try {
        if (global.AgentSandbox) await global.AgentSandbox.init();
        if (global.AgentMCP) await global.AgentMCP.init();
        if (global.AgentSkills) await global.AgentSkills.init();
      } catch (e) { console.warn('[agent-ui] 模块初始化警告', e); }

      // 挂钩 sendBeikeFollowup：严格按模式分流
      //   Chat  模式 → 100% 走原始 API 聊天逻辑，不经过任何沙箱代码
      //   Agent 模式 → 走沙箱智能体执行（ReAct + 工具编排）
      this._origSend = global.sendBeikeFollowup;
      const self = this;
      global.sendBeikeFollowup = function () {
        if (_getMode() !== 'agent') {
          // Chat 模式：纯 API 聊天，完全保持原有行为
          return self._origSend.apply(global, arguments);
        }
        if (!global.AgentCore) {
          // Agent 模式但沙箱核心未就绪：降级到原始逻辑
          return self._origSend.apply(global, arguments);
        }
        if (global.AgentCore.running) {
          // 智能体正在执行：中止当前任务并开始新任务（不降级到 Chat）
          global.AgentCore.stop();
          setTimeout(function () { self.handleAgentSend(); }, 300);
          return;
        }
        self.handleAgentSend();
      };

      // 增强 startPrepare：同样按模式分流
      if (global.startPrepare && !global.startPrepare._hooked) {
        const origStart = global.startPrepare;
        global.startPrepare = function () {
          if (_getMode() !== 'agent' || !global.AgentCore) {
            return origStart.apply(global, arguments);
          }
          if (global.AgentCore.running) {
            global.AgentCore.stop();
            setTimeout(function () { self.handleAgentStartPrepare(); }, 300);
            return;
          }
          self.handleAgentStartPrepare();
        };
        global.startPrepare._hooked = true;
      }

      // 增强 renderBeikeSkillGrid（技能市场用沙箱技能）
      if (global.renderBeikeSkillGrid) {
        this._origRenderSkillGrid = global.renderBeikeSkillGrid;
        global.renderBeikeSkillGrid = function () { self.renderSkillMarket(); };
      }

      // 挂钩 clearBeikeChat：清除聊天时同步清空 Agent 对话记忆
      if (global.clearBeikeChat && !global.clearBeikeChat._hooked) {
        const origClear = global.clearBeikeChat;
        global.clearBeikeChat = function () {
          if (global.AgentCore) global.AgentCore.resetMemory();
          self._removeClarifyPanel();
          return origClear.apply(global, arguments);
        };
        global.clearBeikeChat._hooked = true;
      }

      // 注入沙箱状态条
      this.ready = true;
      console.log('[agent-ui] 沙箱智能体已就绪');
    },

    _waitFor(pred, timeout) {
      return new Promise((resolve) => {
        if (pred()) { resolve(true); return; }
        const start = Date.now();
        const timer = setInterval(() => {
          if (pred()) { clearInterval(timer); resolve(true); }
          else if (Date.now() - start > timeout) { clearInterval(timer); resolve(false); }
        }, 50);
      });
    },

    /* ============ 发送处理 ============ */
    handleAgentSend() {
      const inp = document.getElementById('beikeInput');
      const q = (inp && inp.value.trim()) || '';
      if (!q) return;
      // 模型/API Key 校验
      if (typeof global.getSelectedChatModel !== 'function' || !global.getSelectedChatModel() || !global.getChatApiKey(global.getSelectedChatModel())) {
        global.showToast('请先在输入框下方选择并配置智能体');
        return;
      }
      // 渲染用户消息
      global.appendMsg('beikeMessages', 'user', global.renderMarkdownInline ? global.renderMarkdownInline(q) : global.escapeHtml(q));
      inp.value = '';
      // 清空附件
      if (global.richAttachments && global.richAttachments.beike) global.richAttachments.beike = [];
      const ba = document.getElementById('beikeAttachments');
      if (ba) ba.innerHTML = '';
      inp.placeholder = '输入课题、追问或调整教案...';

      // 切换发送键为暂停键
      if (typeof global.setBeikeSendBtn === 'function') global.setBeikeSendBtn('pause');
      global.beikeStreamAbortFlag = false;

      // 构建上下文
      const ctx = this._buildContext(q);
      // 显示右侧面板
      if (typeof global.showBeikeRightPanel === 'function') global.showBeikeRightPanel();

      // 新对话时创建教案记录（与原逻辑一致）
      const isNewChat = !global.beikeHistory || global.beikeHistory.length === 0;
      if (isNewChat && typeof global.saveBeikeHistoryRecord === 'function') {
        global.saveBeikeHistoryRecord(q, (document.getElementById('beikeGrade') || {}).value || '',
          typeof global.getTeacherSubjectAndTextbook === 'function' ? global.getTeacherSubjectAndTextbook() : '',
          document.getElementById('beikeMessages').innerHTML, []);
      }

      // 运行智能体
      global.AgentCore.run(q, ctx).then((res) => {
        if (typeof global.setBeikeSendBtn === 'function') global.setBeikeSendBtn('send');
        if (res && res.ok && res.answer) {
          // 将 Agent 对话存入 beikeHistory，保证切换到 Chat 模式后上下文连续
          global.beikeHistory = global.beikeHistory || [];
          global.beikeHistory.push({ role: 'user', content: q });
          global.beikeHistory.push({ role: 'assistant', content: res.answer });
          // 更新教案记录
          this._updateRecord();
        }
        if (!res.ok && res.error) global.showToast(res.error);
      }).catch(() => {
        if (typeof global.setBeikeSendBtn === 'function') global.setBeikeSendBtn('send');
      });
    },

    handleAgentStartPrepare() {
      const subj = typeof global.getTeacherSubjectAndTextbook === 'function' ? global.getTeacherSubjectAndTextbook() : '';
      const grade = (document.getElementById('beikeGrade') || {}).value || '';
      const topic = ((document.getElementById('beikeTopic') || {}).value || '').trim();
      const dur = (document.getElementById('beikeDuration') || {}).value || '';
      const remark = (document.getElementById('beikeRemark') || {}).value || '';
      if (!topic) { global.showToast('请输入课题或章节'); return; }
      if (!global.getSelectedChatModel() || !global.getChatApiKey(global.getSelectedChatModel())) { global.showToast('请先选择并配置智能体'); return; }
      const q = '请为我生成完整教案：课题《' + topic + '》' + (remark ? '，要求：' + remark : '');
      global.appendMsg('beikeMessages', 'user', global.renderMarkdownInline ? global.renderMarkdownInline('**课题：' + topic + '**' + (remark ? '<br>' + remark : '')) : global.escapeHtml(topic));
      const ctx = { subject: subj, grade, topic, duration: dur, remark };
      if (typeof global.showBeikeRightPanel === 'function') global.showBeikeRightPanel();

      // 切换发送键为暂停键
      if (typeof global.setBeikeSendBtn === 'function') global.setBeikeSendBtn('pause');
      global.beikeStreamAbortFlag = false;

      // 新对话时创建教案记录（与 handleAgentSend 一致）
      const isNewChat = !global.beikeHistory || global.beikeHistory.length === 0;
      if (isNewChat && typeof global.saveBeikeHistoryRecord === 'function') {
        global.saveBeikeHistoryRecord(q, grade, subj, document.getElementById('beikeMessages').innerHTML, []);
      }

      // 运行智能体，完成后更新记录
      global.AgentCore.run(q, ctx).then((res) => {
        if (typeof global.setBeikeSendBtn === 'function') global.setBeikeSendBtn('send');
        if (res && res.ok && res.answer) {
          global.beikeHistory = global.beikeHistory || [];
          global.beikeHistory.push({ role: 'user', content: q });
          global.beikeHistory.push({ role: 'assistant', content: res.answer });
          this._updateRecord();
        }
        if (!res.ok && res.error) global.showToast(res.error);
      }).catch(() => {
        if (typeof global.setBeikeSendBtn === 'function') global.setBeikeSendBtn('send');
      });
    },

    _buildContext(q) {
      const ctx = {};
      try {
        if (typeof global.getTeacherSubjectAndTextbook === 'function') ctx.subject = global.getTeacherSubjectAndTextbook();
        const g = document.getElementById('beikeGrade'); if (g) ctx.grade = g.value;
        const t = document.getElementById('beikeTopic'); if (t && t.value) ctx.topic = t.value; else ctx.topic = q;
      } catch (e) { /* ignore */ }
      return ctx;
    },

    /* ============ 智能体回调渲染 ============ */
    _runCard: null,

    onStart(info) {
      const box = document.getElementById('beikeMessages');
      const inner = global.appendMsg('beikeMessages', 'assistant', '');
      inner.classList.add('agent-run');
      const skillBadge = info.skill ? '<span class="agent-skill-badge"><i class="fa-solid ' + info.skill.icon + '"></i> ' + info.skill.name + '</span>' : '';
      inner.innerHTML =
        '<div class="agent-run-head">'
        + '<span class="agent-status-dot"></span>'
        + '<span class="agent-status-text">智能体思考中…</span>'
        + skillBadge
        + '<span class="agent-step-badge">步骤 0</span>'
        + '</div>'
        + '<div class="agent-steps"></div>'
        + '<div class="agent-answer"></div>';
      box.scrollTop = box.scrollHeight;
      this._runCard = { inner, steps: inner.querySelector('.agent-steps'), answer: inner.querySelector('.agent-answer'), head: inner.querySelector('.agent-run-head') };
    },

    onStep(step) {
      if (!this._runCard) return;
      const badge = this._runCard.head.querySelector('.agent-step-badge');
      if (typeof step === 'object' && step !== null) {
        // 对象入参：{ stage, label }，创建可见的阶段步骤行 + 更新头部 badge
        const label = step.label || step.stage || '';
        if (badge) badge.textContent = label;
        // 创建阶段步骤行（实时显示，不等待完成）
        const stageIcon = this._stageIcon(step.stage);
        const div = document.createElement('div');
        div.className = 'agent-step-row fade-up stage';
        div.innerHTML =
          '<div class="agent-step-main">'
          + '<span class="agent-step-icon"><i class="fa-solid ' + stageIcon + '"></i></span>'
          + '<span class="agent-step-text">' + global.escapeHtml(label) + '</span>'
          + '<span class="agent-step-status stage-tag">阶段</span>'
          + '</div>';
        this._runCard.steps.appendChild(div);
        const box = document.getElementById('beikeMessages');
        if (box) box.scrollTop = box.scrollHeight;
      } else {
        if (badge) badge.textContent = '步骤 ' + step;
      }
    },

    onThought(text, step) {
      if (!this._runCard || !text) return;
      // 存储最近的思考内容，供工具调用详情引用
      this._lastThought = text;
      // 创建可见的思考步骤行（实时显示智能体推理过程，不等待完成）
      var displayText = String(text);
      // 截断显示：超过 80 字符截断，详情中看完整内容
      var shortText = displayText.length > 80 ? displayText.slice(0, 80) + '…' : displayText;
      var div = document.createElement('div');
      div.className = 'agent-step-row fade-up thinking';
      div.innerHTML =
        '<div class="agent-step-main">'
        + '<span class="agent-step-icon"><i class="fa-solid fa-brain"></i></span>'
        + '<span class="agent-step-text">' + global.escapeHtml(shortText) + '</span>'
        + '<span class="agent-step-status thinking">思考</span>'
        + '<button class="agent-step-toggle" onclick="window.AgentSandboxUI._toggleStepDetail(this)" title="查看详情"><i class="fa-solid fa-chevron-down"></i></button>'
        + '</div>'
        + '<div class="agent-step-detail">'
        + '<div class="agent-step-detail-section"><span class="agent-detail-label">思考过程</span><div class="agent-thought-detail">' + global.escapeHtml(displayText) + '</div></div>'
        + '</div>';
      this._runCard.steps.appendChild(div);
      const box = document.getElementById('beikeMessages');
      if (box) box.scrollTop = box.scrollHeight;
    },

    onToolCall(info) {
      if (!this._runCard) return;
      const div = document.createElement('div');
      div.className = 'agent-step-row fade-up executing';
      // 简洁展示：图标 + 动作描述 + 下拉按钮
      const actionDesc = this._toolActionDesc(info.name, info.args);
      div.innerHTML =
        '<div class="agent-step-main">'
        + '<span class="agent-step-icon"><i class="fa-solid ' + this._toolIcon(info.name) + '"></i></span>'
        + '<span class="agent-step-text">' + global.escapeHtml(actionDesc) + '</span>'
        + '<span class="agent-step-status running">执行中</span>'
        + '<button class="agent-step-toggle" onclick="window.AgentSandboxUI._toggleStepDetail(this)" title="查看详情"><i class="fa-solid fa-chevron-down"></i></button>'
        + '</div>'
        + '<div class="agent-step-detail">'
        + '<div class="agent-step-detail-section"><span class="agent-detail-label">思考</span><div class="agent-detail-text">' + global.escapeHtml(this._lastThought || '') + '</div></div>'
        + '<div class="agent-step-detail-section"><span class="agent-detail-label">工具</span><div class="agent-detail-text"><code>' + info.name + '</code></div></div>'
        + (info.args && Object.keys(info.args).length ? '<div class="agent-step-detail-section"><span class="agent-detail-label">参数</span><pre class="agent-detail-code">' + this._fmtArgs(info.args) + '</pre></div>' : '')
        + '<div class="agent-step-detail-section agent-step-result-wrap"><span class="agent-detail-label">结果</span><div class="agent-detail-result">等待执行...</div></div>'
        + '</div>';
      this._runCard.steps.appendChild(div);
      this._curStepDiv = div;
      const box = document.getElementById('beikeMessages');
      if (box) box.scrollTop = box.scrollHeight;
    },

    onToolResult(info) {
      if (!this._curStepDiv) return;
      // 移除执行中状态
      this._curStepDiv.classList.remove('executing');
      const status = this._curStepDiv.querySelector('.agent-step-status');
      const resWrap = this._curStepDiv.querySelector('.agent-detail-result');
      if (status) {
        status.textContent = info.ok ? '完成' : '失败';
        status.classList.remove('running');
        status.classList.add(info.ok ? 'ok' : 'fail');
      }
      if (resWrap) {
        const txt = info.ok ? this._fmtResult(info.result) : ('错误：' + (info.error || '未知错误'));
        resWrap.innerHTML = '<pre class="agent-detail-code">' + global.escapeHtml(txt) + '</pre>';
      }
      // 搜索结果中的参考资料自动收集到 UI 参考资料栏
      if (info.ok && info.result) {
        var refs = info.result.references;
        if (!refs && Array.isArray(info.result.results)) {
          // web_search 返回的 results 中提取 URL
          refs = info.result.results.filter(function (r) { return r.url; }).map(function (r) {
            return { title: r.title, url: r.url, source: r.source };
          });
        }
        if (Array.isArray(refs) && refs.length && typeof global.updateBeikeRefList === 'function') {
          var existing = global.beikeRefs || [];
          var existingUrls = existing.map(function (r) { return r.url; });
          var newRefs = refs.filter(function (r) { return r.url && existingUrls.indexOf(r.url) < 0; });
          if (newRefs.length) {
            global.beikeRefs = existing.concat(newRefs);
            global.updateBeikeRefList(global.beikeRefs);
            // 保存到历史记录
            if (typeof global.saveBeikeSidebarState === 'function') global.saveBeikeSidebarState();
          }
        }
      }
      const box = document.getElementById('beikeMessages');
      if (box) box.scrollTop = box.scrollHeight;
    },

    onSkillMatched(skill) {
      // 匹配到技能：渲染步骤行 + 下拉详情（技能说明/触发词/推荐工具）
      if (!this._runCard || !skill) return;
      const div = document.createElement('div');
      div.className = 'agent-step-row fade-up';
      div.innerHTML =
        '<div class="agent-step-main">'
        + '<span class="agent-step-icon"><i class="fa-solid ' + (skill.icon || 'fa-wand-magic-sparkles') + '"></i></span>'
        + '<span class="agent-step-text">匹配技能「' + global.escapeHtml(skill.name || skill.id || '') + '」</span>'
        + '<span class="agent-step-status ok">已匹配</span>'
        + '<button class="agent-step-toggle" onclick="window.AgentSandboxUI._toggleStepDetail(this)" title="查看详情"><i class="fa-solid fa-chevron-down"></i></button>'
        + '</div>'
        + '<div class="agent-step-detail">'
        + '<div class="agent-step-detail-section"><span class="agent-detail-label">技能</span><div class="agent-detail-text"><code>' + global.escapeHtml(skill.id || '') + '</code></div></div>'
        + (skill.desc ? '<div class="agent-step-detail-section"><span class="agent-detail-label">说明</span><div class="agent-detail-text">' + global.escapeHtml(skill.desc) + '</div></div>' : '')
        + (skill.triggers && skill.triggers.length ? '<div class="agent-step-detail-section"><span class="agent-detail-label">触发词</span><div class="agent-detail-text">' + skill.triggers.map((t) => global.escapeHtml(t)).join('、') + '</div></div>' : '')
        + (skill.tools && skill.tools.length ? '<div class="agent-step-detail-section"><span class="agent-detail-label">推荐工具</span><div class="agent-detail-text">' + skill.tools.map((t) => global.escapeHtml(t)).join('、') + '</div></div>' : '')
        + '</div>';
      this._runCard.steps.appendChild(div);
      const box = document.getElementById('beikeMessages');
      if (box) box.scrollTop = box.scrollHeight;
    },

    /* ============ 任务规划与待办同步 ============ */
    /** LLM 返回 plan 时：渲染规划步骤行 + 将子任务列表同步到右侧待办面板 */
    onPlan(planItems) {
      if (!Array.isArray(planItems) || !planItems.length) return;
      // 规划步骤行（下拉查看完整子任务列表）
      if (this._runCard) {
        const div = document.createElement('div');
        div.className = 'agent-step-row fade-up';
        div.innerHTML =
          '<div class="agent-step-main">'
          + '<span class="agent-step-icon"><i class="fa-solid fa-list-check"></i></span>'
          + '<span class="agent-step-text">任务规划 · 拆解为 ' + planItems.length + ' 个子任务</span>'
          + '<span class="agent-step-status ok">完成</span>'
          + '<button class="agent-step-toggle" onclick="window.AgentSandboxUI._toggleStepDetail(this)" title="查看详情"><i class="fa-solid fa-chevron-down"></i></button>'
          + '</div>'
          + '<div class="agent-step-detail">'
          + (this._lastThought ? '<div class="agent-step-detail-section"><span class="agent-detail-label">思考</span><div class="agent-detail-text">' + global.escapeHtml(this._lastThought) + '</div></div>' : '')
          + '<div class="agent-step-detail-section"><span class="agent-detail-label">子任务列表</span><div class="agent-detail-text">'
          + planItems.map((t, i) => (i + 1) + '. ' + global.escapeHtml(String(t))).join('<br>')
          + '</div></div>'
          + '</div>';
        this._runCard.steps.appendChild(div);
        const box = document.getElementById('beikeMessages');
        if (box) box.scrollTop = box.scrollHeight;
      }
      // 清空旧待办，填入新的子任务列表（全部未完成）
      global.beikeTodos = planItems.map((t) => ({ text: t, done: false }));
      this._planCursor = 0; // 当前执行到第几个子任务
      if (typeof global.renderBeikeTodos === 'function') global.renderBeikeTodos();
      if (typeof global.saveBeikeSidebarState === 'function') global.saveBeikeSidebarState();
    },

    /** 一个子任务完成：打勾当前项，推进游标 */
    onSubtaskDone(toolName) {
      if (!global.beikeTodos || !global.beikeTodos.length) return;
      // 找到第一个未完成的项，标记完成
      const idx = global.beikeTodos.findIndex((t) => !t.done);
      if (idx >= 0) {
        global.beikeTodos[idx].done = true;
        this._planCursor = idx + 1;
        if (typeof global.renderBeikeTodos === 'function') global.renderBeikeTodos();
        if (typeof global.saveBeikeSidebarState === 'function') global.saveBeikeSidebarState();
      }
    },

    /* ============ 澄清选择题 UI ============ */
    /** LLM 请求澄清时调用：在输入框上方渲染选择题面板 */
    async onClarify(clarifyData) {
      const reason = clarifyData.reason || '智能体需要确认几个关键信息';
      const questions = clarifyData.questions || [];
      if (!questions.length) return;

      // 移除已有面板
      this._removeClarifyPanel();

      // 创建面板
      const panel = document.createElement('div');
      panel.id = 'beikeClarifyPanel';
      panel.className = 'beike-clarify-panel';

      let html = '<div class="clarify-header"><i class="fa-solid fa-circle-question"></i>'
        + '<span class="clarify-reason">' + global.escapeHtml(reason) + '</span>'
        + '<button class="clarify-close" onclick="window.AgentSandboxUI.cancelClarify()" title="取消"><i class="fa-solid fa-xmark"></i></button></div>';
      html += '<div class="clarify-body">';
      questions.forEach((q, qi) => {
        const multi = q.multi === true;
        const opts = q.options || [];
        // 确保最后一个选项是"其他"
        if (opts.length === 0 || opts[opts.length - 1] !== '其他') opts.push('其他');
        html += '<div class="clarify-question" data-qi="' + qi + '" data-multi="' + multi + '">';
        html += '<div class="clarify-q-text">' + (qi + 1) + '. ' + global.escapeHtml(q.q || '') + '</div>';
        html += '<div class="clarify-options">';
        opts.forEach((opt, oi) => {
          const isOther = (oi === opts.length - 1);
          html += '<button class="clarify-option' + (isOther ? ' clarify-option-other' : '') + '" data-qi="' + qi + '" data-oi="' + oi + '" data-other="' + isOther + '" onclick="window.AgentSandboxUI.toggleClarifyOption(this,' + qi + ',' + oi + ',' + multi + ')">' + global.escapeHtml(opt) + '</button>';
        });
        html += '<input type="text" class="clarify-other-input hidden" data-qi="' + qi + '" placeholder="请输入..." oninput="window.AgentSandboxUI.onClarifyOtherInput(' + qi + ',this.value)">';
        html += '</div></div>';
      });
      html += '</div>';
      html += '<div class="clarify-footer"><button class="clarify-confirm" onclick="window.AgentSandboxUI.confirmClarify()">确认选择</button></div>';
      panel.innerHTML = html;

      // 插入到输入框卡片上方
      const inputArea = document.getElementById('beikeInputArea');
      const inputCard = document.getElementById('beikeInputCard');
      if (inputArea && inputCard) {
        inputArea.insertBefore(panel, inputCard);
      } else if (inputArea) {
        inputArea.appendChild(panel);
      }

      // 滚动到可见
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      // 记录选择状态与选项列表（每个问题按自身 multi 属性初始化）
      this._clarifySelections = questions.map((q) => (q.multi ? [] : null));
      this._clarifyOptions = questions.map((q) => {
        const opts = q.options || [];
        if (opts.length === 0 || opts[opts.length - 1] !== '其他') opts.push('其他');
        return opts;
      });
      this._clarifyOtherInputs = questions.map(() => '');
    },

    /** 切换选项选中状态 */
    toggleClarifyOption(btn, qi, oi, multi) {
      const panel = document.getElementById('beikeClarifyPanel');
      if (!panel) return;
      const isOther = btn.dataset.other === 'true';
      // 控制"其他"输入框显示
      const input = panel.querySelector('.clarify-other-input[data-qi="' + qi + '"]');
      if (isOther && input) {
        if (btn.classList.contains('selected')) {
          // 取消选择：隐藏输入框
          btn.classList.remove('selected');
          input.classList.add('hidden');
          this._clarifySelections[qi] = null;
          this._clarifyOtherInputs[qi] = '';
        } else {
          // 选中"其他"：显示输入框并聚焦
          if (!multi) {
            const siblings = panel.querySelectorAll('.clarify-option[data-qi="' + qi + '"]');
            siblings.forEach((s) => s.classList.remove('selected'));
            // 隐藏所有"其他"输入框
            panel.querySelectorAll('.clarify-other-input').forEach((inp) => inp.classList.add('hidden'));
          }
          btn.classList.add('selected');
          input.classList.remove('hidden');
          setTimeout(() => input.focus(), 50);
          this._clarifySelections[qi] = oi;
        }
        return;
      }
      if (multi) {
        // 多选：切换
        if (btn.classList.contains('selected')) {
          btn.classList.remove('selected');
          const arr = this._clarifySelections[qi] || [];
          const idx = arr.indexOf(oi);
          if (idx >= 0) arr.splice(idx, 1);
          this._clarifySelections[qi] = arr;
        } else {
          btn.classList.add('selected');
          if (!Array.isArray(this._clarifySelections[qi])) this._clarifySelections[qi] = [];
          this._clarifySelections[qi].push(oi);
        }
      } else {
        // 单选：取消同组其他选中，隐藏"其他"输入框
        const siblings = panel.querySelectorAll('.clarify-option[data-qi="' + qi + '"]');
        siblings.forEach((s) => s.classList.remove('selected'));
        btn.classList.add('selected');
        this._clarifySelections[qi] = oi;
        if (input) input.classList.add('hidden');
      }
    },

    /** "其他"选项输入框内容变化 */
    onClarifyOtherInput(qi, value) {
      this._clarifyOtherInputs[qi] = value;
    },

    /** 确认选择：将选项文本传回 AgentCore */
    confirmClarify() {
      const panel = document.getElementById('beikeClarifyPanel');
      if (!panel || !this._clarifySelections) return;
      const pending = global.AgentCore._pendingClarify;
      if (!pending) { this._removeClarifyPanel(); return; }
      // 将选择索引转为选项文本（处理"其他"选项的自由输入）
      const selections = this._clarifySelections.map((sel, qi) => {
        const opts = this._clarifyOptions[qi] || [];
        const isOther = (oi) => oi === opts.length - 1; // 最后一个为"其他"
        if (Array.isArray(sel)) {
          return sel.map((oi) => {
            if (isOther(oi)) {
              const txt = (this._clarifyOtherInputs[qi] || '').trim();
              return txt || '其他';
            }
            return opts[oi] || ('选项' + (oi + 1));
          });
        }
        if (sel != null) {
          if (isOther(sel)) {
            const txt = (this._clarifyOtherInputs[qi] || '').trim();
            return txt || '其他';
          }
          return opts[sel] || ('选项' + (sel + 1));
        }
        return null;
      });
      this._removeClarifyPanel();
      global.AgentCore.onClarifyResolve(selections);
    },

    /** 取消澄清 */
    cancelClarify() {
      this._removeClarifyPanel();
      global.AgentCore.onClarifyCancel();
    },

    /** 移除澄清面板 */
    _removeClarifyPanel() {
      const panel = document.getElementById('beikeClarifyPanel');
      if (panel) panel.remove();
      this._clarifySelections = null;
    },

    async onAnswer(text, opts) {
      if (!this._runCard) return;
      const ansBox = this._runCard.answer;
      const head = this._runCard.head;
      // 更新头部状态
      const dot = head.querySelector('.agent-status-dot');
      const txt = head.querySelector('.agent-status-text');
      if (dot) dot.classList.add('done');
      if (txt) txt.textContent = '已完成';

      // 模拟流式渲染（分块渐进显示，营造打字感）
      await this._streamRender(ansBox, text || '');

      // Agent 模式不渲染推荐追问（SUGGEST 是 Chat 独有）
      // 若 LLM 误带了 SUGGEST 标记，静默清除
      const cleanText = (text || '').replace(/<!--SUGGEST_START-->[\s\S]*?<!--SUGGEST_END-->/g, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
      if (cleanText !== text) {
        ansBox.innerHTML = global.renderMarkdown(cleanText);
      }

      // 显示操作按钮（流式输出完成后）
      if (typeof global.showMsgActions === 'function') {
        global.showMsgActions(this._runCard.inner);
      }

      // 提取待办
      if (typeof global.extractTodosFromContent === 'function') {
        const todos = global.extractTodosFromContent(text || '');
        if (todos.length && typeof global.renderBeikeTodos === 'function') { global.beikeTodos = todos; global.renderBeikeTodos(); }
      }
      // 提取参考链接
      if (typeof global.extractUrlsFromContent === 'function') {
        const refs = global.extractUrlsFromContent(text || '');
        if (refs.length && typeof global.updateBeikeRefList === 'function') {
          global.beikeRefs = (global.beikeRefs || []).concat(refs);
          global.updateBeikeRefList(global.beikeRefs);
        }
      }
      // 写入备课历史
      this._persistToHistory(text || '');
      // 保存所有状态到历史记录（待办、产物、参考信息）
      if (typeof global.saveBeikeSidebarState === 'function') global.saveBeikeSidebarState();
      const box = document.getElementById('beikeMessages');
      if (box) box.scrollTop = box.scrollHeight;
    },

    onError(e) {
      // 恢复发送按钮
      if (typeof global.setBeikeSendBtn === 'function') global.setBeikeSendBtn('send');
      if (!this._runCard) {
        global.appendMsg('beikeMessages', 'assistant', '<div class="agent-error">智能体出错：' + global.escapeHtml((e && e.message) || String(e)) + '</div>');
        return;
      }
      const head = this._runCard.head;
      const dot = head.querySelector('.agent-status-dot'); if (dot) dot.classList.add('fail');
      const txt = head.querySelector('.agent-status-text'); if (txt) txt.textContent = '执行出错';
      this._runCard.answer.innerHTML = '<div class="agent-error"><i class="fa-solid fa-triangle-exclamation"></i> ' + global.escapeHtml((e && e.message) || String(e)) + '</div>';
      // 显示操作按钮（即使出错也显示）
      if (typeof global.showMsgActions === 'function') {
        global.showMsgActions(this._runCard.inner);
      }
    },

    /** 产物回调：在右侧任务产物面板登记，点击区域预览，按钮下载 */
    onArtifact(art) {
      this.artifacts.unshift(art);
      this._renderArtifactList();
      // 同步到 beikeArtifacts 并保存到历史记录
      if (typeof global.beikeArtifacts !== 'undefined') {
        global.beikeArtifacts.unshift({ title: art.path.split('/').pop(), path: art.path, type: art.type, size: art.size });
      }
      if (typeof global.saveBeikeSidebarState === 'function') global.saveBeikeSidebarState();
      if (typeof global.showToast === 'function') global.showToast('已生成产物：' + art.path.split('/').pop());
    },

    /** 移除指定路径的产物条目（临时文件清理后同步调用，避免出现无法下载的僵尸条目） */
    removeArtifact(path) {
      let changed = false;
      this.artifacts = this.artifacts.filter((a) => a.path !== path);
      // 就地下线全局历史记录中的同名条目（beikeArtifacts 为 var 全局数组）
      if (Array.isArray(global.beikeArtifacts)) {
        for (let i = global.beikeArtifacts.length - 1; i >= 0; i--) {
          if (global.beikeArtifacts[i] && global.beikeArtifacts[i].path === path) {
            global.beikeArtifacts.splice(i, 1);
            changed = true;
          }
        }
      }
      this._renderArtifactList();
      if (changed && typeof global.saveBeikeSidebarState === 'function') global.saveBeikeSidebarState();
    },

    /** 渲染任务产物列表（onArtifact / removeArtifact 共用） */
    _renderArtifactList() {
      const list = document.getElementById('beikeArtifactList');
      if (!list) return;
      const self = this;
      list.innerHTML = '';
      this.artifacts.forEach((a, i) => {
        const item = document.createElement('div');
        item.className = 'agent-artifact-item fade-up';
        const icon = self._fileIcon(a.path);
        item.innerHTML =
          '<div class="agent-artifact-main">'
          + '<i class="fa-solid ' + icon + ' agent-artifact-icon"></i>'
          + '<div class="agent-artifact-meta">'
          + '<div class="agent-artifact-name">' + global.escapeHtml(a.path.split('/').pop()) + '</div>'
          + '<div class="agent-artifact-size">' + this._fmtSize(a.size) + '</div>'
          + '</div></div>'
          + '<button class="agent-artifact-dl" title="下载" onclick="event.stopPropagation();window.AgentSandboxUI.downloadArtifact(' + i + ')"><i class="fa-solid fa-download"></i></button>';
        item.onclick = function () { self.previewArtifact(i); };
        list.appendChild(item);
      });
    },

    /** 在线预览产物（弹窗）：根据格式选择最佳预览方式 */
    async previewArtifact(i) {
      const a = this.artifacts[i];
      if (!a || !global.AgentSandbox) return;
      const r = await global.AgentSandbox.readFile(a.path);
      if (!r.ok) { if (typeof global.showToast === 'function') global.showToast('预览失败：' + (r.error || '')); return; }
      const filename = a.path.split('/').pop();
      const ext = (a.path.split('.').pop() || '').toLowerCase();
      let body = '';
      // 二进制文档格式（.docx/.pptx/.xlsx）：不预览，直接提示下载
      var binaryDocs = ['docx', 'pptx', 'xlsx', 'doc', 'ppt', 'xls'];
      if (binaryDocs.indexOf(ext) >= 0) {
        body = '<div class="preview-binary"><i class="fa-solid ' + this._fileIcon(a.path) + '"></i>'
          + '<p>' + global.escapeHtml(filename) + '</p>'
          + '<p class="preview-hint">此为真正的 ' + ext.toUpperCase() + ' 格式文档，请下载后用 Office/WPS 打开查看</p>'
          + '<button class="preview-dl-btn" onclick="window.AgentSandboxUI.downloadArtifact(' + i + ')"><i class="fa-solid fa-download"></i> 下载文件</button></div>';
      } else if (['png', 'jpg', 'jpeg', 'gif', 'webp'].indexOf(ext) >= 0 && r.data.blob) {
        const url = URL.createObjectURL(r.data.blob);
        body = '<img src="' + url + '" class="preview-img" onload="this.dataset.url=\'' + url + '\'">';
      } else if (ext === 'html' && r.data.blob) {
        // HTML 文件：在 iframe 中渲染
        const url = URL.createObjectURL(r.data.blob);
        body = '<iframe src="' + url + '" class="preview-iframe" onload="this.dataset.url=\'' + url + '\'"></iframe>';
      } else if (ext === 'pdf' && r.data.blob) {
        // PDF 文件：浏览器内置预览
        const url = URL.createObjectURL(r.data.blob);
        body = '<iframe src="' + url + '" class="preview-iframe" onload="this.dataset.url=\'' + url + '\'"></iframe>';
      } else {
        // 文本格式（.md/.txt/.csv 等）：Markdown 渲染
        var textContent = r.data.content || '';
        if (textContent && textContent.trim()) {
          body = '<div class="preview-md">' + (global.renderMarkdown ? global.renderMarkdown(textContent) : '<pre>' + global.escapeHtml(textContent) + '</pre>') + '</div>';
        } else if (r.data.blob) {
          body = '<div class="preview-binary"><i class="fa-solid ' + this._fileIcon(a.path) + '"></i>'
            + '<p>' + global.escapeHtml(filename) + '</p>'
            + '<p class="preview-hint">此格式暂不支持在线预览，请点击下载</p>'
            + '<button class="preview-dl-btn" onclick="window.AgentSandboxUI.downloadArtifact(' + i + ')"><i class="fa-solid fa-download"></i> 下载文件</button></div>';
        } else {
          body = '<div class="preview-binary"><p>文件内容为空</p></div>';
        }
      }
      this._showPreviewModal(filename, body, ext);
    },

    /** 显示预览弹窗 */
    _showPreviewModal(title, body, ext) {
      // 移除已有弹窗
      this._closePreviewModal();
      const overlay = document.createElement('div');
      overlay.id = 'beikePreviewOverlay';
      overlay.className = 'preview-overlay';
      const icon = this._fileIcon('x.' + (ext || 'txt'));
      overlay.innerHTML =
        '<div class="preview-modal">'
        + '<div class="preview-modal-header">'
        + '<div class="preview-modal-title"><i class="fa-solid ' + icon + '"></i> ' + global.escapeHtml(title) + '</div>'
        + '<button class="preview-modal-close" onclick="window.AgentSandboxUI._closePreviewModal()"><i class="fa-solid fa-xmark"></i></button>'
        + '</div>'
        + '<div class="preview-modal-body">' + body + '</div>'
        + '</div>';
      overlay.onclick = (e) => { if (e.target === overlay) this._closePreviewModal(); };
      document.body.appendChild(overlay);
      // ESC 关闭
      this._escHandler = (e) => { if (e.key === 'Escape') this._closePreviewModal(); };
      document.addEventListener('keydown', this._escHandler);
    },

    _closePreviewModal() {
      const ov = document.getElementById('beikePreviewOverlay');
      if (ov) {
        // 释放图片和 iframe 的 Object URL
        const img = ov.querySelector('.preview-img');
        if (img && img.dataset.url) URL.revokeObjectURL(img.dataset.url);
        const iframe = ov.querySelector('.preview-iframe');
        if (iframe && iframe.dataset.url) URL.revokeObjectURL(iframe.dataset.url);
        ov.remove();
      }
      if (this._escHandler) { document.removeEventListener('keydown', this._escHandler); this._escHandler = null; }
    },

    async downloadArtifact(i) {
      const a = this.artifacts[i];
      if (!a || !global.AgentSandbox) return;
      const r = await global.AgentSandbox.download(a.path);
      if (!r.ok) global.showToast('下载失败：' + (r.error || ''));
    },

    /* ============ 渲染辅助 ============ */
    async _streamRender(box, text) {
      const renderFinal = () => {
        box.innerHTML = global.renderMarkdown(text);
        const m = document.getElementById('beikeMessages');
        if (m) m.scrollTop = m.scrollHeight;
      };
      box.innerHTML = '<span class="stream-cursor">正在生成</span>';
      // 后台/最小化时 rAF 会暂停、定时器被严格节流，直接渲染最终结果，避免 Agent 循环卡死
      if (document.hidden) { renderFinal(); return; }
      const chunkSize = 48; // 每帧字符数（增大以加快显示）
      let i = 0;
      await new Promise((resolve) => {
        const tick = () => {
          i += chunkSize;
          const partial = text.slice(0, i);
          // 流式过程中显示 cursor，完成后不再显示
          box.innerHTML = global.renderMarkdown(partial) + (i < text.length ? '<span class="stream-cursor"></span>' : '');
          const m = document.getElementById('beikeMessages');
          if (m) m.scrollTop = m.scrollHeight;
          // 用 setTimeout 而非 requestAnimationFrame：rAF 在窗口转后台时暂停会导致永久挂起，
          // setTimeout 即使被节流(后台约 1 次/秒)也仍会触发，保证流式渲染必然完成
          if (i < text.length) setTimeout(tick, 30);
          else resolve();
        };
        setTimeout(tick, 30);
      });
      // 最终渲染（确保无 cursor 残留）
      renderFinal();
    },

    _renderSuggest(box, list) {
      const wrap = document.createElement('div');
      wrap.className = 'suggest-chips mt-3 flex flex-wrap gap-2';
      list.forEach((s) => {
        const b = document.createElement('button');
        b.className = 'px-3 py-1.5 text-xs text-jade-700 bg-jade-50 hover:bg-jade-100 rounded-lg border border-jade-200 transition flex items-center gap-1.5';
        b.innerHTML = '<i class="fa-solid fa-arrow-turn-up text-[9px] text-jade-400 rotate-90"></i>' + global.escapeHtml(s);
        b.onclick = () => { if (global.sendSuggest) global.sendSuggest(s); };
        wrap.appendChild(b);
      });
      box.appendChild(wrap);
    },

    _fmtArgs(args) {
      try { return global.escapeHtml(JSON.stringify(args, null, 2)); } catch (e) { return ''; }
    },
    _fmtResult(r) {
      if (r == null) return '(无返回)';
      let s = (typeof r === 'string') ? r : JSON.stringify(r, null, 2);
      if (s.length > 1500) s = s.slice(0, 1500) + '\n...(已截断)';
      return s;
    },
    /** 下拉折叠/展开步骤详情 */
    _toggleStepDetail(btn) {
      const row = btn.closest('.agent-step-row');
      if (!row) return;
      const detail = row.querySelector('.agent-step-detail');
      if (!detail) return;
      const isOpen = detail.classList.toggle('open');
      btn.classList.toggle('open', isOpen);
      const icon = btn.querySelector('i');
      if (icon) icon.className = isOpen ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
    },
    /** 工具动作的简洁描述（而非裸工具名） */
    _toolActionDesc(name, args) {
      const map = {
        web_search: '搜索"' + (args.query || '') + '"',
        web_research: '深度搜索"' + (args.query || '') + '"',
        fetch_page: '抓取网页',
        run_python: '执行 Python 代码',
        gen_ppt: '生成课件 ' + (args.filename || ''),
        gen_word: '生成文档 ' + (args.filename || ''),
        gen_excel: '生成表格 ' + (args.filename || ''),
        gen_pdf: '生成 PDF',
        print_html: '渲染打印',
        write_file: '写入文件 ' + (args.path || ''),
        read_file: '读取文件 ' + (args.path || ''),
        list_files: '列出文件',
        download_file: '下载文件',
        mcp_call: '调用 ' + (args.tool || 'MCP工具'),
        use_skill: '使用技能',
        calc: '计算',
        text_stats: '统计文本',
        now: '获取时间',
      };
      return map[name] || name;
    },
    /** 工具对应的图标 */
    _toolIcon(name) {
      const map = {
        web_search: 'fa-magnifying-glass',
        web_research: 'fa-magnifying-glass-chart',
        fetch_page: 'fa-globe',
        run_python: 'fa-code',
        gen_ppt: 'fa-display',
        gen_word: 'fa-file-word',
        gen_excel: 'fa-file-excel',
        gen_pdf: 'fa-file-pdf',
        print_html: 'fa-print',
        write_file: 'fa-floppy-disk',
        read_file: 'fa-file-lines',
        list_files: 'fa-folder-open',
        download_file: 'fa-download',
        mcp_call: 'fa-plug',
        use_skill: 'fa-wand-magic-sparkles',
        calc: 'fa-calculator',
        text_stats: 'fa-chart-bar',
        now: 'fa-clock',
      };
      return map[name] || 'fa-gear';
    },
    /** 工作流阶段对应的图标 */
    _stageIcon(stage) {
      var map = {
        classify: 'fa-route',
        disambiguate: 'fa-circle-question',
        route: 'fa-diagram-project',
        parallel: 'fa-layer-group',
        aggregate: 'fa-cubes',
        finalize: 'fa-flag-checkered',
        chat: 'fa-comments',
        research: 'fa-magnifying-glass',
      };
      return map[stage] || 'fa-circle-dot';
    },
    _fmtSize(n) { if (!n) return '—'; if (n < 1024) return n + 'B'; if (n < 1048576) return (n / 1024).toFixed(1) + 'KB'; return (n / 1048576).toFixed(1) + 'MB'; },
    _fileIcon(path) {
      const ext = (path.split('.').pop() || '').toLowerCase();
      if (['pptx', 'ppt'].indexOf(ext) >= 0) return 'fa-display';
      if (['docx', 'doc'].indexOf(ext) >= 0) return 'fa-file-word';
      if (['xlsx', 'xls', 'csv'].indexOf(ext) >= 0) return 'fa-file-excel';
      if (['pdf'].indexOf(ext) >= 0) return 'fa-file-pdf';
      if (['png', 'jpg', 'jpeg', 'gif'].indexOf(ext) >= 0) return 'fa-image';
      return 'fa-file-lines';
    },

    /** 写入备课历史记录（兼容现有结构） */
    /** 更新当前教案记录的 msgsHTML 与 history（与原 sendBeikeFollowup 回调一致） */
    _updateRecord() {
      try {
        if (typeof global.getBeikeHistoryRecords !== 'function') return;
        if (typeof global.BEIKE_HISTORY_KEY === 'undefined') return;
        const recs = global.getBeikeHistoryRecords();
        const ridx = recs.findIndex(function (r) { return r.id === global.currentBeikeRecordId; });
        if (ridx >= 0) {
          recs[ridx].msgsHTML = document.getElementById('beikeMessages').innerHTML;
          recs[ridx].history = global.beikeHistory || [];
          localStorage.setItem(global.BEIKE_HISTORY_KEY, JSON.stringify(recs));
        }
      } catch (e) { /* ignore */ }
    },

    _persistToHistory(text) {
      this._updateRecord();
    },

    /* ============ 技能市场 ============ */
    renderSkillMarket() {
      const modal = document.getElementById('beikeSkillsModal');
      if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
      const grid = document.getElementById('beikeSkillGrid');
      if (!grid) return;
      const skills = (global.AgentSkills ? global.AgentSkills.marketData() : []) || [];
      grid.innerHTML = skills.map((s) =>
        '<div class="agent-skill-card border border-ink-100 rounded-xl p-4 hover:border-jade-300 hover:shadow-sm transition cursor-pointer group" onclick="window.AgentSandboxUI.applyMarketSkill(\'' + s.id + '\')">'
        + '<div class="flex items-center gap-2.5 mb-2">'
        + '<div class="w-9 h-9 bg-' + s.color + '-50 text-' + s.color + '-600 rounded-lg flex items-center justify-center"><i class="fa-solid ' + s.icon + ' text-sm"></i></div>'
        + '<div><div class="text-sm font-semibold text-ink-900">' + s.name + '</div>'
        + '<div class="text-[10px] text-jade-600">Skill · 沙箱技能</div></div></div>'
        + '<p class="text-xs text-ink-500 leading-relaxed mb-3">' + s.desc + '</p>'
        + '<button class="w-full py-1.5 text-[11px] text-jade-600 border border-jade-200 rounded-lg hover:bg-jade-50 transition">使用技能</button>'
        + '</div>'
      ).join('');
    },

    applyMarketSkill(skillId) {
      // 切到 Agent 模式并填入技能指令
      if (_getMode() !== 'agent' && typeof global.setBeikeMode === 'function') global.setBeikeMode('agent');
      const text = global.AgentSkills ? global.AgentSkills.skillQuickText(skillId) : '';
      const inp = document.getElementById('beikeInput');
      if (inp && text) { inp.value = text; inp.focus(); }
      if (typeof global.closeBeikeSkills === 'function') global.closeBeikeSkills();
      if (typeof global.showToast === 'function') global.showToast('已选择技能，点击发送由智能体执行');
    },

  };

  // 暴露并自启动
  global.AgentSandboxUI = SandboxUI;
  global.AgentSandboxOpts = global.AgentSandboxOpts || {};

  // DOM 就绪后初始化（兼容主 HTML 的 load 事件之后）
  if (document.readyState === 'complete') {
    SandboxUI.init();
  } else {
    window.addEventListener('load', function () { setTimeout(() => SandboxUI.init(), 300); });
  }
})(window);
