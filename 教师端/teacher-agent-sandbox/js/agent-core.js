/*!
 * teacher-agent-sandbox · 智能体核心引擎 (agent-core.js)
 * ------------------------------------------------------------------
 * 参考 TRAE Work / QoderWork 的智能体编排模型，实现 ReAct 循环：
 *   思考(thought) → 行动(action/tool) → 观察(observation) → 再思考...
 * 核心职责：
 *   1) 任务规划与意图识别（自动匹配 Skill）
 *   2) 多轮工具调用编排（限步、限次，防无效循环）
 *   3) 跨轮记忆（上下文窗口：上文 500K 字符，下文 150K 字符）
 *   4) 智能澄清：LLM 自主判断是否需要追问，以选择题形式呈现
 *   5) 记忆读写、联网搜索、沙箱执行的统一调度
 * 复用主 HTML 已有的 callAIJson / callAIStream 作为 LLM 调用引擎。
 */
(function (global) {
  'use strict';

  // 内嵌规则与系统提示（与 rules/RULES.md、prompts/system-prompt.md 一致，离线兜底）
  const AGENT_IDENTITY = '你是「孔孟教研智能体」，运行在教师备课沙箱环境中，具备 Skills/Tools/MCP/记忆/联网搜索能力，能自主规划并完成备课任务。';

  const REACT_INSTRUCTION = [
    '## 工作方式（ReAct 循环）',
    '第一步必须先 plan：将任务拆解为有序子任务列表。',
    '每一步你须输出严格 JSON（仅 JSON，无解释、无代码块标记）：',
    '```',
    '{"thought":"分析意图、判断当前信息是否充足、规划下一步","decision":"plan"或"tool"或"answer"或"clarify",',
    ' "plan":["子任务1","子任务2","子任务3"](仅 decision=plan 时，列出所有子任务),',
    ' "tool":"工具名(仅 decision=tool 时)","args":{"参数":"值"},',
    ' "tools":[{"tool":"工具名","args":{"参数":"值"}},...](可选: 当多个工具互不依赖时可批量调用，最多3个并行),',
    ' "answer":"最终给教师的回答(仅 decision=answer 时，用 Markdown，公式用 LaTeX)",',
    ' "clarify":{"reason":"为什么需要追问","questions":[{"q":"问题文本","options":["选项A","选项B","其他"],"multi":false}]}(仅 decision=clarify 时)',
    '```',
    '## 核心规则（必须严格遵守）',
    '### 1. 文档产物规则（最重要）',
    '- 生成教案/学案/课件/试卷/成绩表等文档时，必须调用对应的文档生成工具（gen_word/gen_ppt/gen_excel/gen_pdf），将完整内容通过 content 参数传入',
    '- answer 字段只能写简要总结（不超过 200 字），例如：「已为您生成《XXX》教案文档，包含教学目标、重难点、教学过程、板书设计和作业，请到任务产物区下载查看。」',
    '- 绝对禁止在 answer 中输出完整的教案/课件/试卷内容！answer 只做总结，文档内容必须通过工具生成可下载文件',
    '- 如果任务需要生成多个文档（如教案+学案+课件），分别调用多次文档生成工具，每次生成一个文件',
    '### 2. 备课任务标准流程（保证深度，禁止跳步）',
    '- 教案/课件/学案/试卷类任务必须按此流程执行：',
    '  ① decision=plan 拆解子任务（须含"资料搜集"子任务）',
    '  ② 资料搜集：用 web_search 搜索本课的【课程标准要求】和【近年高考真题/考法】（1-2 次搜索即可，如"高中数学 函数单调性 课程标准 核心素养"、"2025 高考 单调性 真题 考法"），将课标要求写入教学目标依据、将真题考法融入例题与练习',
    '  ③ 在 thought 中完整构思文档全文（不允许边写边想），然后 decision=tool 调用文档生成工具，content 一次性传入完整、详尽的全文',
    '  ④ 教师要求多个产物时，逐个生成（每个产物都要达到下方质量标准，不许因数量多而缩水）',
    '  ⑤ 全部生成成功后 decision=answer 总结（列出文件名+内容亮点+使用建议）',
    '- 若上下文中已有学生学情记录（学生提问/批改/考试成绩），必须据此调整：针对薄弱知识点设计强化环节、引用学生真实困惑作为教学起点',
    '### 3. 备课内容质量标准（生成内容必须达到以下深度，宁可长不可空）',
    '- 教案（gen_word content ≥ 3000 字）：课标依据与教材分析、学情分析（结合记忆中的班级学情）、教学目标（核心素养四维度+可观察可测量的行为动词）、教学重难点（含突破策略）、教学过程（≥5 个环节：情境导入/新知探究/例题精讲/变式训练/课堂小结，每个环节写清【教师活动】含具体提问话术、【学生活动】含预设回答、【设计意图】、时间分配）、例题与变式（完整题干+逐行规范解答，LaTeX 公式）、分层作业（基础/提升/拓展三层，给出具体题目）、板书设计（结构化呈现）、教学反思预设',
    '- 课件 PPT（gen_ppt slides ≥ 12 页）：封面/学习目标/目录/知识讲授页(6-8页，每页 bullets 写具体知识内容而非"讲解XX"这类空话)/例题页(含完整解答步骤)/课堂练习页/小结页/作业页；每页内容精炼但实质，禁止占位性文字；涉及数据对比、统计、函数图像等内容时，先用 generate_chart 生成图表（返回 dataUrl），再用 image 类型幻灯片嵌入（s.image=dataUrl），使课件图文并茂',
    '- 学案（gen_word content ≥ 2000 字）：学习目标、课前预习（含具体填空/思考题）、课堂探究问题链（3-4 个递进问题+引导材料）、当堂检测（5-8 题，附完整答案与解析）、课后巩固（分层）',
    '- 试卷/试题：每题含完整题干、选项、分值标注、详细解析（解题思路+易错点），难度按 易30%/中50%/难20% 分布，贴合高考命题风格',
    '- 评价量规（gen_excel rows）：≥4 个评价维度 × 4 等级（优秀/良好/合格/待改进）的具体行为描述，权重之和为 100%',
    '- 所有教学内容必须具体可操作：提问要写出问题原话，例题要给出完整题目与解答，活动要说明组织形式，禁止"此处讲解知识点""举例说明"等空泛表述',
    '### 4. 聊天回答规则',
    '- 日常对话、简单问答、不需要生成文件的任务：answer 中直接回答即可（专业问题也应给出有深度的回答，结合课标与教学实践）',
    '- 需要联网搜索信息的任务：先调用 web_search/web_research，然后基于搜索结果在 answer 中简要回答',
    '- answer 中不要重复列出搜索结果的链接（参考资料会自动展示在右侧栏）',
    '### 5. 执行规则',
    '- 首步 decision=plan，列出本任务的所有子任务（通常 3-6 个）',
    '- 然后逐个执行子任务：需要资料/生成文档/计算/搜索时 decision=tool',
    '- 当多个工具互不依赖（如同时搜索两个不同知识点）时，用 tools 数组批量调用以提高效率',
    '- 信息不足时 decision=clarify，以选择题形式提问（1-3个即可）',
    '- clarify 的每个问题须给出 2-5 个具体选项，最后一个选项固定为"其他"',
    '- 这是面向高中教师的智能体，不要每次都问年级/阶段等，能从上下文推断就直接执行',
    '- 不要在 answer 末尾附加追问选项（追问是 Chat 模式独有，Agent 模式不需要）',
    '- 单任务最多 22 步、工具最多 16 次，避免无效循环',
    '- 复杂备课任务推荐五阶段工作流：① 调研（web_search 搜课标/真题/教法学法）→ ② 构思（在 thought 中完整规划文档结构与内容要点）→ ③ 生成（调用文档工具，content 传入完整全文）→ ④ 自检（检查产物是否达到质量标准，内容是否充实、公式是否正确、环节是否完整）→ ⑤ 完善（若自检发现不足，重新生成更详尽的版本或补充遗漏环节）',
    '- 文档生成时优先用 content 参数传 Markdown 文本（而非 blocks 结构化数据），系统会自动解析标题/列表/表格/粗体/斜体等格式',
    '- 数学公式放心用 LaTeX 语法（如 $f(x)=x^2+2x+1$、$$\\frac{a}{b}$$），系统会自动转为可读的 Unicode 数学符号写入 Word/PPT，不会乱码',
    '- 生成教案/学案用 gen_word，生成课件用 gen_ppt，生成量规/成绩表用 gen_excel，生成试卷用 gen_pdf',
    '- 需要联网搜索时用 web_search（自动提取关键词，返回标题/摘要/链接/参考资料），需要深度搜索整合多网页内容时用 web_research（搜索+自动抓取Top3网页+整合摘要）',
    '- 搜索返回的 references 会自动展示在右侧参考资料栏（可点击打开），无需在 answer 中重复列出链接',
    '### 6. 收尾自检（decision=answer 前必须确认）',
    '- plan 中的子任务是否全部执行完毕？',
    '- 要求生成的文档是否都已调用工具且观察到成功返回（ok）？若有失败应重试或说明',
    '- 文档内容是否达到第 3 节质量标准？若内容过简须重新生成更详尽的版本',
    '- answer 中是否列出了生成的文件名与内容亮点？',
  ].join('\n');

  const LIMITS = { maxSteps: 22, maxToolCalls: 16, reflectionEvery: 4 };

  // 上下文窗口配置：上文 500K 字符，下文 150K 字符
  const CONTEXT_WINDOW = {
    prevLimit: 500000,   // 上文（历史对话）字符上限
    nextLimit: 150000,   // 下文（单次输出）字符上限
  };

  // 解析模型返回的 JSON（容错：剥离代码块、补全、智能括号匹配）
  function parseJSON(txt) {
    if (!txt) return null;
    let s = String(txt).trim();
    // 先尝试直接解析
    try { return JSON.parse(s); } catch (e) { /* 继续处理 */ }
    // 去除代码块标记
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    try { return JSON.parse(s); } catch (e) { /* 继续处理 */ }
    // 智能截取：从第一个 { 开始，用括号匹配找到对应的 }
    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"' && !escape) { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { /* 失败 */ }
    }
    // 最后尝试：截取第一个 { 到最后一个 }
    const i2 = s.indexOf('{'); const j2 = s.lastIndexOf('}');
    if (i2 >= 0 && j2 > i2) {
      try { return JSON.parse(s.slice(i2, j2 + 1)); } catch (e) { return null; }
    }
    return null;
  }

  // 粗略估算字符数（用于上下文窗口管理）
  function _charLen(s) {
    if (!s) return 0;
    return typeof s === 'string' ? s.length : JSON.stringify(s).length;
  }

  const AgentCore = {
    running: false,
    abort: false,
    // 跨轮对话记忆（同一会话内持久，切换会话时清空）
    _convoHistory: [],
    // 当前等待澄清的状态
    _pendingClarify: null,

    /** 清空对话记忆（新会话/清除聊天时调用） */
    resetMemory() {
      this._convoHistory = [];
      this._pendingClarify = null;
      // 清空工具结果缓存（新会话不复用旧缓存）
      if (this._toolCache) this._toolCache.clear();
    },

    /** 运行一个智能体任务 */
    async run(task, opts) {
      opts = opts || {};
      if (this.running) return { ok: false, error: '已有任务正在运行' };
      this.running = true; this.abort = false;
      // 同步检查服务器可用性（确保第一次任务也能正确路由）
      if (global.AgentSandbox && !global.AgentSandbox.serverChecked) {
        await global.AgentSandbox.checkServer();
      }
      const ui = global.AgentSandboxUI;
      const memory = global.AgentMemory;
      const tools = global.AgentTools;
      const skills = global.AgentSkills;

      const userInput = (typeof task === 'string' ? task : (task && task.text)) || '';
      const ctx = (typeof task === 'object' ? task : {}) || {};
      // 开启工作记忆
      if (memory) memory.startTask({ subject: ctx.subject, topic: ctx.topic, grade: ctx.grade, userIntent: userInput });
      // 暴露当前上下文给工具（如联网搜索注入学科/年级提高精准度）
      global.AgentCurrentCtx = { subject: ctx.subject || '', grade: ctx.grade || '', topic: ctx.topic || '' };
      // 重置临时文件追踪（本任务写入"临时/"的文件将在任务结束后自动清理）
      if (global.AgentSandbox && global.AgentSandbox.beginTask) global.AgentSandbox.beginTask();

      let result = null;
      try {
        // 优先使用 LangGraph 工作流（多阶段、带质量验证与精炼循环）
        if (global.LangGraphWorkflow && global.QualityValidator && global.WorkflowPrompts) {
          if (ui && ui.onStart) ui.onStart({ task: userInput, skill: null, mode: 'langgraph' });
          result = await this._runLangGraph(userInput, ctx, opts);
          // 如果 LangGraph 执行成功，直接返回
          if (result && result.ok) return result;
          // 如果 LangGraph 失败且未生成任何内容，降级到 ReAct 循环
          console.warn('[agent] LangGraph 工作流降级到 ReAct:', result && result.error);
          if (ui && ui.onThought) ui.onThought('LangGraph 工作流异常，切换到 ReAct 模式重试', 0);
          // 重置中止标志
          this.abort = false;
        }
        // ReAct 循环（兜底）
        result = await this._reactLoop(userInput, ctx, opts);
        return result;
      } catch (e) {
        if (ui && ui.onError) ui.onError(e);
        return { ok: false, error: (e && e.message) || String(e) };
      } finally {
        this.running = false;
        // 任务完成（含出错/中止）后清理临时文件：
        // 仅删除本任务写入"临时/"的文件；最终回答仍引用（路径或文件名）的保留
        try {
          const sb = global.AgentSandbox;
          if (sb && sb.cleanupTempFiles && sb.taskTempFiles && sb.taskTempFiles.length) {
            const ansText = (result && result.answer) ? String(result.answer) : '';
            const keep = sb.taskTempFiles.filter((p) => {
              if (!ansText) return false;
              const fname = p.split('/').pop();
              return ansText.indexOf(p) >= 0 || (fname && ansText.indexOf(fname) >= 0);
            });
            await sb.cleanupTempFiles(keep);
          }
        } catch (e) { console.warn('[agent] 临时文件清理失败（不影响任务结果）', e); }
      }
    },

    /**
     * LangGraph 工作流执行入口
     * 创建教学备课状态图并执行，返回结构化结果。
     * 工作流包含：分类→研究→分析→规划→生成→验证→精炼(条件)→文档化
     */
    async _runLangGraph(userInput, ctx, opts) {
      const ui = global.AgentSandboxUI;
      const memory = global.AgentMemory;
      const tools = global.AgentTools;
      const skills = global.AgentSkills;
      const sandbox = global.AgentSandbox;

      // LLM 调用桥接函数
      const callLLM = async (prompt, sysPrompt) => {
        if (typeof global.callAIJson !== 'function') {
          throw new Error('LLM 引擎未就绪(callAIJson 缺失)');
        }
        return await global.callAIJson(prompt, sysPrompt || '', global.AgentSandboxOpts && global.AgentSandboxOpts.modelOverride);
      };

      // 流式 LLM 调用桥接函数
      const callLLMStream = (typeof global.callAIStream === 'function') ? (async function* (prompt, sysPrompt) {
        for await (const chunk of global.callAIStream(prompt, sysPrompt || '', [], null, null)) {
          yield chunk;
        }
      }) : null;

      try {
        // 创建 LangGraph 工作流
        const { compiled } = await global.LangGraphWorkflow.createTeachingWorkflow({
          callLLM: callLLM,
          callLLMStream: callLLMStream,
          tools: tools,
          memory: memory,
          skills: skills,
          ui: ui,
          sandbox: sandbox,
          waitClarify: () => this.waitClarify(),
        });

        // 初始状态
        const initialState = {
          task: userInput,
          ctx: Object.assign({ topic: userInput }, ctx),
          convHistory: this._convoHistory.slice(),
          // 高级意图识别
          intent: null,
          clarifyCount: 0,
          // 路由与并行
          subIds: null,
          parallelResults: null,
          // 聚合与最终
          bundle: null,
          sharedStudentData: null,
          // 兼容字段
          classification: null,
          skillId: null,
          skillName: null,
          taskType: null,
          needsResearch: true,
          needsStudentData: true,
          researchData: null,
          searchReferences: null,
          documents: null,
          artifacts: null,
          finalAnswer: null,
          error: null,
        };

        // 执行工作流
        const finalState = await compiled.invoke(initialState, {
          maxSteps: 40,
          onStep: (node, state) => {
            if (this.abort) {
              throw new Error('任务已中止');
            }
          },
        });

        // 检查是否有错误
        if (finalState.error) {
          return { ok: false, error: finalState.error, step: 0, langgraph: true };
        }

        // 保存对话记忆
        const answer = finalState.finalAnswer || '';
        if (answer) {
          this._convoHistory.push({ role: 'user', content: userInput });
          this._convoHistory.push({ role: 'assistant', content: answer });
          this._saveMemory(this._convoHistory);
        }

        // 兼容多产物资源包：artifacts 优先取 bundle
        const artifacts = (finalState.bundle && finalState.bundle.artifacts) ? finalState.bundle.artifacts : (finalState.artifacts || []);
        const qualityScores = (finalState.bundle && finalState.bundle.qualityScores) ? finalState.bundle.qualityScores : null;
        const products = finalState.parallelResults ? Object.keys(finalState.parallelResults) : [];

        return {
          ok: true,
          answer: answer,
          step: 0,
          langgraph: true,
          artifacts: artifacts,
          documents: finalState.documents || [],
          bundle: finalState.bundle || null,
          products: products,
          qualityScores: qualityScores,
        };
      } catch (e) {
        // LangGraph 执行失败，返回错误信息供 run() 决定是否降级
        if (this.abort) {
          if (memory && memory.endTask) memory.endTask('failed', '用户中止', '');
          return { ok: false, error: '任务已中止', aborted: true };
        }
        return { ok: false, error: (e && e.message) || String(e), langgraph: true };
      }
    },

    /** 中止当前任务 */
    stop() { this.abort = true; },

    /** 构造系统提示（注入工具/技能/记忆/规则） */
    _buildSystemPrompt(ctx) {
      const tools = global.AgentTools;
      const skills = global.AgentSkills;
      const memory = global.AgentMemory;
      const parts = [AGENT_IDENTITY, REACT_INSTRUCTION];
      if (skills) parts.push(skills.describeForPrompt());
      if (tools) parts.push(tools.describeForPrompt());
      if (memory) {
        const mem = memory.contextForAgent(ctx.topic || ctx.text || '');
        if (mem) parts.push(mem);
      }
      parts.push('注：记忆已自动注入上方上下文，无需调用 memory.recall 工具。');
      parts.push('## 当前上下文\n' + (ctx.subject ? '学科：' + ctx.subject + '\n' : '') + (ctx.grade ? '年级：' + ctx.grade + '\n' : '') + (ctx.topic ? '课题：' + ctx.topic + '\n' : ''));
      return parts.join('\n\n');
    },

    /** ReAct 主循环 */
    async _reactLoop(userInput, ctx, opts) {
      const ui = global.AgentSandboxUI;
      const tools = global.AgentTools;
      const memory = global.AgentMemory;
      const skills = global.AgentSkills;

      // 自动匹配技能
      let activeSkill = null;
      if (skills) {
        activeSkill = skills.match(userInput);
        if (memory) memory.updateWorking({ activeSkill: activeSkill ? activeSkill.id : '' });
      }

      const sysPrompt = this._buildSystemPrompt(Object.assign({ text: userInput }, ctx));

      // 使用跨轮对话记忆作为会话历史基础（实现记忆功能）
      const convo = this._convoHistory.slice();

      // 追加本轮用户输入
      const firstUser = this._composeFirstUser(userInput, activeSkill, ctx);
      convo.push({ role: 'user', content: firstUser });

      if (ui && ui.onStart) ui.onStart({ task: userInput, skill: activeSkill });
      // 技能匹配步骤行（须在 onStart 创建运行卡片之后渲染）
      if (activeSkill && ui && ui.onSkillMatched) ui.onSkillMatched(activeSkill);

      let toolCalls = 0;
      let step = 0;
      let lastThought = '';

      while (step < LIMITS.maxSteps && !this.abort) {
        step++;
        if (ui && ui.onStep) ui.onStep(step);

        // 调用 LLM 决策（用 callAIJson，期望 JSON）
        // 传入经过上下文窗口裁剪的对话历史
        const trimmedConvo = this._trimContext(convo, sysPrompt);
        let raw = '';
        try {
          raw = await this._callLLM(sysPrompt, trimmedConvo);
        } catch (e) {
          if (ui && ui.onError) ui.onError(e);
          return { ok: false, error: 'LLM 调用失败: ' + (e.message || e), step };
        }

        const decision = parseJSON(raw);
        if (!decision) {
          // 模型未返回合法 JSON，将原文作为最终答案流式输出
          if (ui && ui.onAnswer) await ui.onAnswer(raw || '（未生成有效内容）', { streamed: true });
          this._saveMemory(convo);
          if (memory) memory.endTask('partial', raw, '');
          return { ok: true, answer: raw, step, degraded: true };
        }

        lastThought = decision.thought || '';
        if (ui && ui.onThought) ui.onThought(lastThought, step);

        // ---- 澄清决策：信息不足，向教师提问 ----
        if (decision.decision === 'clarify' && decision.clarify) {
          // 保存当前对话到记忆（含澄清请求）
          convo.push({ role: 'assistant', content: JSON.stringify({ thought: decision.thought, clarify: decision.clarify }) });
          this._pendingClarify = { convo, sysPrompt, ctx, questions: decision.clarify.questions || [], toolCalls, step };
          // 渲染澄清 UI（暂停 ReAct 循环，等待教师选择）
          if (ui && ui.onClarify) {
            await ui.onClarify(decision.clarify);
          } else {
            // 无 UI 回调时直接当作 answer 处理
            const fallback = decision.clarify.reason || '需要更多信息，请补充说明。';
            if (ui && ui.onAnswer) await ui.onAnswer(fallback, { streamed: true });
            this._saveMemory(convo);
            if (memory) memory.endTask('partial', fallback, '');
            return { ok: true, answer: fallback, step, clarify: true };
          }
          // 等待教师选择（onClarifyResolve 会被调用）
          const selections = await this._waitForClarify();
          if (this.abort) {
            if (memory) memory.endTask('failed', '用户中止', '');
            return { ok: false, error: '任务已中止', step, aborted: true };
          }
          // 将选择结果加入对话，继续循环
          const selText = selections.map((s, i) => {
            const q = (this._pendingClarify.questions[i] || {}).q || '问题' + (i + 1);
            return q + '：' + (Array.isArray(s) ? s.join('、') : s);
          }).join('\n');
          convo.push({ role: 'user', content: '教师选择：\n' + selText });
          this._pendingClarify = null;
          continue;
        }

        // ---- 规划决策：将任务拆解为子任务列表 ----
        if (decision.decision === 'plan' && Array.isArray(decision.plan)) {
          convo.push({ role: 'assistant', content: JSON.stringify({ thought: decision.thought, plan: decision.plan }) });
          // 将任务列表同步到右侧待办面板
          if (ui && ui.onPlan) ui.onPlan(decision.plan);
          continue;
        }

        // ---- 工具执行后：标记当前子任务完成 ----
        // （在工具调用分支中处理，见下方 onToolResult 之后）

        // ---- 最终回答 ----
        if (decision.decision === 'answer' || decision.answer != null) {
          let ans = decision.answer || '';
          // 自动检测：如果 answer 过长且像文档内容，自动转为可下载文档
          if (ans.length > 1500 && this._looksLikeDocument(ans) && tools && tools.has('gen_word')) {
            try {
              if (ui && ui.onToolCall) ui.onToolCall({ name: 'gen_word', args: { title: 'AI生成文档', content: ans }, step });
              const docR = await this._executeToolWithCache('gen_word', { title: 'AI生成文档', content: ans, filename: '教案_' + Date.now() + '.docx' }, tools);
              if (ui && ui.onToolResult) ui.onToolResult({ name: 'gen_word', ok: docR.ok, result: docR.data, error: docR.error, step });
              if (docR.ok) {
                ans = '已为您生成文档，包含完整内容，请到任务产物区下载查看。';
              }
            } catch (e) { /* 降级：直接显示原文 */ }
          }
          convo.push({ role: 'assistant', content: ans });
          this._saveMemory(convo);
          if (ui && ui.onAnswer) await ui.onAnswer(ans, { streamed: true });
          if (memory) memory.endTask('success', ans, '');
          return { ok: true, answer: ans, step, toolCalls };
        }

        // ---- 工具调用（支持批量并行） ----
        // 检查是否为批量工具调用（decision.tools 数组）
        const batchTools = Array.isArray(decision.tools) ? decision.tools.slice(0, 3) : [];
        const singleTool = decision.tool ? [{ tool: decision.tool, args: decision.args || {} }] : [];
        const toolList = batchTools.length ? batchTools : singleTool;

        if (!toolList.length) {
          convo.push({ role: 'assistant', content: JSON.stringify(decision) });
          convo.push({ role: 'user', content: '请给出 decision=answer 的最终回答，或指定要调用的 tool。' });
          continue;
        }
        if (toolCalls >= LIMITS.maxToolCalls) {
          if (ui && ui.onThought) ui.onThought('已达工具调用上限，直接汇总作答', step);
          convo.push({ role: 'user', content: '已达工具调用上限，请基于已有信息直接给出最终回答(decision=answer)。' });
          continue;
        }

        // 检查工具调用配额
        const remaining = LIMITS.maxToolCalls - toolCalls;
        const executable = toolList.slice(0, remaining);

        // 通知 UI 开始执行（批量时逐个通知）
        if (ui && ui.onToolCall) {
          for (const t of executable) {
            ui.onToolCall({ name: t.tool, args: t.args, step });
          }
        }

        // 执行工具（并行或串行）
        const observations = [];
        if (executable.length > 1) {
          // 并行执行多个独立工具
          const results = await Promise.allSettled(
            executable.map((t) => this._executeToolWithCache(t.tool, t.args, tools))
          );
          results.forEach((res, i) => {
            const t = executable[i];
            const ok = res.status === 'fulfilled' && res.value.ok;
            const obs = ok ? res.value.data : { error: res.status === 'fulfilled' ? res.value.error : (res.reason && res.reason.message) || '执行失败' };
            if (ui && ui.onToolResult) ui.onToolResult({ name: t.tool, ok, result: obs, error: ok ? null : obs.error, step });
            if (memory) memory.incToolCall();
            observations.push({ tool: t.tool, args: t.args, ok, obs });
            if (ui && ui.onSubtaskDone) ui.onSubtaskDone(t.tool);
          });
          toolCalls += executable.length;
        } else {
          // 单个工具执行
          const t = executable[0];
          const r = await this._executeToolWithCache(t.tool, t.args, tools);
          const ok = r.ok;
          const obs = ok ? r.data : { error: r.error };
          if (ui && ui.onToolResult) ui.onToolResult({ name: t.tool, ok, result: obs, error: r.error, step });
          if (memory) memory.incToolCall();
          toolCalls++;
          observations.push({ tool: t.tool, args: t.args, ok, obs });
          if (ui && ui.onSubtaskDone) ui.onSubtaskDone(t.tool);
        }

        // 将思考+动作+观察加入会话（压缩长观察）
        if (observations.length === 1) {
          const o = observations[0];
          convo.push({ role: 'assistant', content: JSON.stringify({ thought: decision.thought, tool: o.tool, args: o.args }) });
          const obsStr = this._compressObservation(o.obs);
          convo.push({ role: 'user', content: '<observation>\n' + obsStr + '\n</observation>\n请继续：给出下一步 thought 与 decision(tool 或 answer 或 clarify)。' });
        } else {
          // 批量观察
          const obsSummary = observations.map((o, i) => {
            const obsStr = this._compressObservation(o.obs, 1800);
            return '【工具' + (i + 1) + ': ' + o.tool + '】' + (o.ok ? '' : '(失败)') + '\n' + obsStr;
          }).join('\n\n');
          convo.push({ role: 'assistant', content: JSON.stringify({ thought: decision.thought, tools: observations.map((o) => ({ tool: o.tool, args: o.args })) }) });
          convo.push({ role: 'user', content: '<observations>\n' + obsSummary + '\n</observations>\n请继续：给出下一步 thought 与 decision(tool 或 answer 或 clarify)。' });
        }

        // 周期性反思提示
        if (step % LIMITS.reflectionEvery === 0) {
          convo.push({ role: 'user', content: '【反思检查点】已执行 ' + toolCalls + ' 次工具调用。请对照 plan 检查：子任务是否全部完成？要求的文档是否都已生成且内容达到质量标准？若未完成请继续执行（decision=tool），全部完成后再给出最终回答(decision=answer)。' });
        }
      }

      // 超出步数：强制收尾
      if (this.abort) {
        if (memory) memory.endTask('failed', '用户中止', '');
        return { ok: false, error: '任务已中止', step, aborted: true };
      }
      if (ui && ui.onThought) ui.onThought('已达步数上限，汇总当前结果', step);
      convo.push({ role: 'user', content: '已达步数上限，请立即基于已有信息给出最终回答(decision=answer)。' });
      const trimmedConvo2 = this._trimContext(convo, sysPrompt);
      let raw2 = '';
      try { raw2 = await this._callLLM(sysPrompt, trimmedConvo2); } catch (e) { raw2 = ''; }
      const d2 = parseJSON(raw2);
      const ans2 = (d2 && d2.answer) || raw2 || '由于步数限制，未能完整生成，请重试或缩小任务范围。';
      convo.push({ role: 'assistant', content: ans2 });
      this._saveMemory(convo);
      if (ui && ui.onAnswer) await ui.onAnswer(ans2, { streamed: true });
      if (memory) memory.endTask('partial', ans2, '');
      return { ok: true, answer: ans2, step, toolCalls, truncated: true };
    },

    /** 组装首条用户消息（含技能提示） */
    _composeFirstUser(userInput, skill, ctx) {
      let msg = '教师请求：' + userInput;
      if (ctx.subject) msg += '\n学科：' + ctx.subject;
      if (ctx.grade) msg += '\n年级：' + ctx.grade;
      if (ctx.topic) msg += '\n课题：' + ctx.topic;
      if (skill) {
        const prompt = global.AgentSkills.buildSkillPrompt(skill.id, userInput, ctx);
        msg += '\n\n' + prompt;
        msg += '\n（已为你预选技能「' + skill.name + '」，可据此规划）';
      }
      msg += '\n\n请开始：先输出 thought，然后 decision=plan 拆解子任务（备课类任务必须包含"资料搜集"子任务）。生成文档时须在 content 中一次性给出完整、详尽的全文（达到系统提示中的质量标准），禁止只写提纲或骨架。';
      return msg;
    },

    /** 上下文窗口裁剪：保留系统提示 + 最近对话，总计不超过上文限制 */
    _trimContext(convo, sysPrompt) {
      const sysLen = _charLen(sysPrompt);
      const budget = CONTEXT_WINDOW.prevLimit - sysLen - 2000; // 预留 2K 给本轮输出指令
      if (budget <= 0) return convo.slice(-2); // 极端情况只保留最后两条
      // 从后往前累积，超出预算则丢弃早期消息
      const kept = [];
      let used = 0;
      for (let i = convo.length - 1; i >= 0; i--) {
        const len = _charLen(convo[i].content);
        if (used + len > budget) break;
        kept.unshift(convo[i]);
        used += len;
      }
      return kept;
    },

    /** 保存对话记忆（跨轮持久化，截断到上下文窗口内） */
    _saveMemory(convo) {
      // 只保留最近 CONTEXT_WINDOW.prevLimit 字符的对话
      const sysPlaceholder = 2000; // 系统提示的预估长度
      const budget = CONTEXT_WINDOW.prevLimit - sysPlaceholder;
      const kept = [];
      let used = 0;
      for (let i = convo.length - 1; i >= 0; i--) {
        const len = _charLen(convo[i].content);
        if (used + len > budget) break;
        kept.unshift(convo[i]);
        used += len;
      }
      this._convoHistory = kept;
    },

    /* ============ 工具执行优化：缓存 + 观察压缩 ============ */
    _toolCache: new Map(),
    _toolCacheTTL: 300000, // 5 分钟

    /** 带缓存的工具执行（相同工具+参数在 TTL 内复用结果） */
    async _executeToolWithCache(name, args, tools) {
      // 不可缓存的操作（写文件/生成文档等有副作用的跳过缓存）
      const noCache = ['gen_word', 'gen_ppt', 'gen_excel', 'gen_pdf', 'write_file', 'download_file', 'convert_document', 'ocr', 'generate_chart', 'run_python'];
      const cacheable = noCache.indexOf(name) < 0;
      let cacheKey = '';
      if (cacheable) {
        cacheKey = name + ':' + JSON.stringify(args);
        const cached = this._toolCache.get(cacheKey);
        if (cached && (Date.now() - cached.t < this._toolCacheTTL)) {
          return cached.r;
        }
      }
      // 执行工具
      let r;
      if (tools && tools.has(name)) {
        // 按工具类型设置超时
        const toolTimeouts = {
          web_search: 40000,
          fetch_page: 20000,
          mcp_call: 30000,
          run_python: 30000,
          calc: 5000,
          text_stats: 5000,
          now: 3000,
          check_sandbox: 5000,
          ocr: 60000,
          convert_document: 60000,
        };
        const timeout = toolTimeouts[name] || 45000;
        r = await tools.invoke(name, args, { timeout });
      } else {
        r = { ok: false, error: '未知工具: ' + name };
      }
      if (cacheable && r.ok) {
        this._toolCache.set(cacheKey, { r, t: Date.now() });
        // 清理过期缓存
        if (this._toolCache.size > 50) {
          const now = Date.now();
          for (const [k, v] of this._toolCache) {
            if (now - v.t > this._toolCacheTTL) this._toolCache.delete(k);
          }
        }
      }
      return r;
    },

    /** 压缩观察结果（智能截断，保留关键信息） */
    _compressObservation(obs, maxLen) {
      maxLen = maxLen || 2500;
      let str = typeof obs === 'string' ? obs : JSON.stringify(obs, null, 2);
      if (str.length <= maxLen) return str;
      // 智能压缩：保留开头和结尾，中间用省略号
      const headLen = Math.floor(maxLen * 0.6);
      const tailLen = Math.floor(maxLen * 0.3);
      const head = str.slice(0, headLen);
      const tail = str.slice(-tailLen);
      const omitted = str.length - headLen - tailLen;
      return head + '\n...(省略 ' + omitted + ' 字符)...\n' + tail;
    },

    /** 检测文本是否像文档内容（而非简短回答） */
    _looksLikeDocument(text) {
      if (!text || text.length < 500) return false;
      // 检测：包含多个 Markdown 标题（## 或 ###）
      const headers = (text.match(/^#{1,3}\s+/gm) || []).length;
      if (headers >= 3) return true;
      // 检测：包含"教学目标"、"教学过程"、"重难点"等教案关键词
      const docKeywords = ['教学目标', '教学过程', '重难点', '板书设计', '课堂导入', '新授', '巩固练习', '作业布置', '教学反思'];
      const matchCount = docKeywords.filter(function (k) { return text.indexOf(k) >= 0; }).length;
      if (matchCount >= 2) return true;
      // 检测：超过 2000 字且包含多个列表项
      if (text.length > 2000 && (text.match(/^\s*[-•]\s/gm) || []).length >= 10) return true;
      return false;
    },

    /** 等待教师完成澄清选择（Promise 挂起，直到 onClarifyResolve 被调用） */
    _waitForClarify() {
      return new Promise((resolve) => {
        this._clarifyResolver = resolve;
      });
    },

    /** 公开的澄清等待方法（供 LangGraph disambiguate 节点注入 deps.waitClarify 使用） */
    waitClarify() {
      return this._waitForClarify();
    },

    /** UI 调用：教师已完成澄清选择 */
    onClarifyResolve(selections) {
      if (this._clarifyResolver) {
        this._clarifyResolver(selections);
        this._clarifyResolver = null;
      }
    },

    /** UI 调用：教师取消澄清（中止任务） */
    onClarifyCancel() {
      this.abort = true;
      if (this._clarifyResolver) {
        this._clarifyResolver([]);
        this._clarifyResolver = null;
      }
    },

    /** 调用 LLM（复用主 HTML 的 callAIJson，支持模型覆盖） */
    async _callLLM(sysPrompt, convo) {
      if (typeof global.callAIJson !== 'function') {
        throw new Error('LLM 引擎未就绪(callAIJson 缺失)，请确认沙箱脚本加载顺序');
      }
      // 将多角色会话压成单条 prompt（callAIJson 接受 system+单条 user）
      // 把历史拼入 user 消息以保持上下文（记忆）
      const historyText = convo.map((m) => {
        const tag = m.role === 'assistant' ? '【智能体】' : (m.role === 'tool' ? '【工具返回】' : '【教师/系统】');
        return tag + '：\n' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      }).join('\n\n');
      return await global.callAIJson(historyText, sysPrompt, global.AgentSandboxOpts && global.AgentSandboxOpts.modelOverride);
    },

    /** 一次性问答（无工具，纯对话，供简单场景） */
    async chat(prompt, sysPrompt, onChunk) {
      if (typeof global.callAIStream === 'function') {
        let acc = '';
        for await (const chunk of global.callAIStream(prompt, sysPrompt, [], null, null)) {
          if (chunk && !chunk.startsWith('\u0001')) { acc += chunk; if (onChunk) onChunk(chunk); }
        }
        return acc;
      }
      throw new Error('流式引擎未就绪(callAIStream 缺失)');
    },

    /** 获取上下文窗口配置（供 UI 展示） */
    getContextWindow() { return Object.assign({}, CONTEXT_WINDOW); },
  };

  global.AgentCore = AgentCore;
})(window);
