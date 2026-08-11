/*!
 * teacher-agent-sandbox · LangGraph 工作流引擎 (langgraph-workflow.js)
 * ------------------------------------------------------------------
 * 基于 LangGraph StateGraph 模式构建教学备课多阶段工作流，解决：
 *   1) 工作流不完善 —— 用状态图替代自由 ReAct 循环，每阶段职责明确
 *   2) 生成产物过于简单 —— 加入质量验证节点 + 条件精炼循环
 *
 * 工作流图结构：
 *   START → classify → research → analyze → plan → generate → validate
 *                                                                │
 *                                                        ┌───────┴───────┐
 *                                                       pass             fail
 *                                                        │               │
 *                                                   finalize          refine → generate
 *                                                        │               (max 2 loops)
 *                                                       END
 *
 * LangGraph 集成策略：
 *   - 优先通过动态 import 加载 @langchain/langgraph（CDN）
 *   - 加载失败时使用内置 StateGraph 兼容实现（离线可用）
 *   - 两种模式 API 一致，调用方无感知
 *
 * 参考：
 *   - LangGraph.js: https://github.com/langchain-ai/langgraphjs
 *   - LangChain.js: https://github.com/langchain-ai/langchainjs
 */
(function (global) {
  'use strict';

  // ================================================================
  // 内置 StateGraph 兼容实现（离线兜底，API 对齐 @langchain/langgraph）
  // ================================================================

  /**
   * 状态图节点
   * @typedef {function(state:object, config?:object): Promise<object>} GraphNode
   */

  /**
   * 条件路由函数
   * @typedef {function(state:object): string} ConditionalRouter
   */

  /**
   * StateGraph —— LangGraph StateGraph 的浏览器兼容实现
   * 支持：addNode / addEdge / addConditionalEdges / compile / invoke
   */
  function StateGraph(stateSchema) {
    this._schema = stateSchema || {};
    this._nodes = new Map();
    this._edges = new Map(); // node -> {type:'direct'|'conditional', target|routers}
    this._entry = null;
    this._exits = new Set(); // 支持多个终点（addConditionalEdges 场景）
  }

  StateGraph.prototype.addNode = function (name, fn) {
    if (typeof fn !== 'function') throw new Error('节点处理函数必须是函数: ' + name);
    this._nodes.set(name, fn);
    return this;
  };

  StateGraph.prototype.addEdge = function (from, to) {
    if (!this._edges.has(from)) this._edges.set(from, []);
    this._edges.get(from).push({ type: 'direct', target: to });
    return this;
  };

  StateGraph.prototype.addConditionalEdges = function (from, router, mapping) {
    if (typeof router !== 'function') throw new Error('路由函数必须是函数: ' + from);
    if (!this._edges.has(from)) this._edges.set(from, []);
    this._edges.get(from).push({ type: 'conditional', router: router, mapping: mapping || {} });
    return this;
  };

  StateGraph.prototype.setEntryPoint = function (name) {
    this._entry = name;
    return this;
  };

  StateGraph.prototype.setFinishPoint = function (name) {
    this._exits.add(name);
    return this;
  };

  StateGraph.prototype.compile = function () {
    var self = this;
    return {
      _graph: self,
      /**
       * 执行状态图
       * @param {object} initialState - 初始状态
       * @param {object} config - 配置 { onStep?: (node, state) => void, maxSteps?: number }
       * @returns {Promise<object>} 最终状态
       */
      invoke: async function (initialState, config) {
        config = config || {};
        var maxSteps = config.maxSteps || 30;
        var state = Object.assign({}, initialState);
        var current = self._entry;
        var stepCount = 0;

        while (current && current !== '__END__' && stepCount < maxSteps) {
          stepCount++;
          var nodeFn = self._nodes.get(current);
          if (!nodeFn) {
            throw new Error('未找到节点: ' + current);
          }
          // 执行节点
          var update = await nodeFn(state, config);
          if (update && typeof update === 'object') {
            // 合并状态更新（LangGraph reducer 语义：浅合并）
            Object.keys(update).forEach(function (k) {
              state[k] = update[k];
            });
          }
          // 回调：通知调用方当前执行的节点
          if (config.onStep) {
            try { config.onStep(current, state); } catch (e) { /* ignore */ }
          }
          // 查找下一节点
          var edges = self._edges.get(current);
          if (!edges || edges.length === 0) {
            // 无出边，检查是否为终点
            if (self._exits.has(current)) break;
            throw new Error('节点无出边且非终点: ' + current);
          }
          var nextNode = null;
          for (var i = 0; i < edges.length; i++) {
            var edge = edges[i];
            if (edge.type === 'direct') {
              nextNode = edge.target;
              break;
            } else if (edge.type === 'conditional') {
              var routeKey = edge.router(state);
              nextNode = edge.mapping[routeKey] || routeKey;
              break;
            }
          }
          current = nextNode;
        }
        return state;
      },
    };
  };

  // ================================================================
  // LangGraph 动态加载（尝试 CDN，失败则用内置实现）
  // ================================================================

  var _langGraphLoaded = null;
  var _useRealLangGraph = false;

  /**
   * 尝试加载真实的 @langchain/langgraph
   * 使用动态 import 从 esm.sh CDN 加载
   * @returns {Promise<boolean>} 是否成功加载
   */
  async function tryLoadLangGraph() {
    // 刻意不从 CDN 加载真实 @langchain/langgraph：真库 StateGraph 的 API（Annotation/reducer）
    // 与本文件自研的 invoke(initialState, {maxSteps, onStep}) 约定及 {channels:WORKFLOW_STATE}
    // schema 不兼容，加载成功反而会使工作流抛错失效（"在线坏、离线好"）。
    // 统一锁定内置实现；接入真 LangGraph 需按 Annotation/reducer 重写（后续专项）。
    _langGraphLoaded = false;
    _useRealLangGraph = false;
    return false;
  }

  /**
   * 获取 StateGraph 类（优先用真实的，否则用内置的）
   */
  function getStateGraphClass() {
    if (_useRealLangGraph && global._realLangGraph && global._realLangGraph.StateGraph) {
      return global._realLangGraph.StateGraph;
    }
    return StateGraph;
  }

  // ================================================================
  // 工作流状态定义（LangGraph State Schema）
  // ================================================================

  var WORKFLOW_STATE = {
    // 输入
    task: null,              // 用户原始请求
    ctx: null,               // { subject, grade, topic }
    convHistory: null,       // 跨轮对话历史
    // 高级意图识别（classify 产出）
    intent: null,            // { products[], quantities{}, studentTags[], subject, grade, topic,
                             //   needsResearch, needsStudentData, confidence, missingInfo[] }
    // 兼容字段（单产物旧路径仍可用）
    classification: null,    // 意图分类结果（LLM 原始返回）
    skillId: null,           // 匹配的技能ID
    skillName: null,         // 技能名称
    taskType: null,          // document | chat
    needsResearch: true,     // 是否需要联网搜索
    needsStudentData: true,  // 是否需要读取学情记忆
    // 共享资料（parallel 内准备一次，供全部子工作流复用）
    researchData: null,      // 搜索结果整合
    searchReferences: null,  // 参考资料 URL 列表
    sharedStudentData: null, // 学情记忆摘要
    // 澄清
    clarifyCount: 0,         // 澄清追问次数
    // 路由与并行
    subIds: null,            // ['explainer','lesson-plan','ppt','animation','student-analysis','exercise',...]
    parallelResults: null,   // { [subId]: { status, ok, content, slides, validation, refinementCount, artifacts, error } }
    // 聚合与最终
    bundle: null,            // { artifacts[], qualityScores{}, failed[], summary, totalScore }
    documents: null,         // 生成的文档列表
    artifacts: null,         // 产物列表
    finalAnswer: null,       // 最终回答
    error: null,             // 错误信息
  };

  // ================================================================
  // 工作流节点实现
  // ================================================================

  var MAX_REFINEMENTS = 2; // 最大精炼次数

  /**
   * 创建 LangGraph 教学备课工作流
   * @param {object} deps - 依赖注入
   *   - callLLM: async (prompt, systemPrompt?) => string  LLM调用
   *   - callLLMStream: async function*(prompt, systemPrompt?)  流式LLM调用
   *   - tools: AgentTools 工具注册中心
   *   - memory: AgentMemory 记忆系统
   *   - skills: AgentSkills 技能引擎
   *   - ui: AgentSandboxUI UI控制器
   *   - sandbox: AgentSandbox 沙箱运行时
   * @returns {Promise<{compiled: object, graph: object}>} 编译后的工作流
   */
  async function createTeachingWorkflow(deps) {
    var callLLM = deps.callLLM;
    var callLLMStream = deps.callLLMStream;
    var tools = deps.tools;
    var memory = deps.memory;
    var skills = deps.skills;
    var ui = deps.ui;
    var sandbox = deps.sandbox;
    var waitClarify = deps.waitClarify; // 澄清等待：() => Promise<selections[]>

    // 确保 LangGraph 已加载
    await tryLoadLangGraph();
    var StateGraphClass = getStateGraphClass();

    // 创建状态图
    var graph = new StateGraphClass({ channels: WORKFLOW_STATE });

    // ---- 节点1: classify（高级意图识别：多产物/数量/学情标签） ----
    graph.addNode('classify', async function (state) {
      var userInput = state.task || '';
      var ctx = state.ctx || {};

      if (ui && ui.onStep) ui.onStep({ stage: 'classify', label: '高级意图识别与任务路由' });
      if (ui && ui.onThought) ui.onThought('正在分析您的请求「' + (userInput.length > 40 ? userInput.slice(0, 40) + '…' : userInput) + '」，识别教学意图、判断需要生成哪些产物（教案/课件/学案/试卷等），并评估是否需要联网搜索课标真题和读取班级学情数据。');

      // 先用技能引擎匹配（降级用）
      var matchedSkill = skills ? skills.match(userInput) : null;

      // 用 LLM 做高级意图识别（解析多产物、数量、学情标签）
      var classifyPrompt = global.WorkflowPrompts.fill(global.WorkflowPrompts.templates.classify, {
        userInput: userInput,
        subject: ctx.subject || '',
        grade: ctx.grade || '',
        topic: ctx.topic || '',
      });

      var intent = null;
      try {
        // 失败重试一次，避免单次 LLM 抖动就降级到技能匹配、吞掉多产物需求
        var raw = null;
        for (var attempt = 0; attempt < 2; attempt++) {
          try {
            raw = await callLLM(classifyPrompt, '你是高级意图识别器，只输出JSON。');
            if (raw) break;
          } catch (ee) {
            if (attempt === 1) throw ee;
          }
        }
        var result = _parseJSON(raw);
        if (result) {
          intent = {
            products: Array.isArray(result.products) ? result.products : [],
            quantities: result.quantities || {},
            studentTags: Array.isArray(result.studentTags) ? result.studentTags : [],
            subject: result.subject || ctx.subject || '',
            grade: result.grade || ctx.grade || '',
            topic: result.topic || ctx.topic || userInput,
            needsResearch: result.needsResearch !== false,
            needsStudentData: result.needsStudentData !== false,
            confidence: typeof result.confidence === 'number' ? result.confidence : 60,
            missingInfo: Array.isArray(result.missingInfo) ? result.missingInfo : [],
            priority: result.priority || 'mid',
          };
        }
      } catch (e) {
        console.warn('[workflow] classify LLM 失败，降级到技能匹配', e);
      }

      // 降级：LLM 失败时用技能匹配生成单产物意图
      if (!intent) {
        if (matchedSkill) {
          intent = {
            products: [_mapSkillToSub(matchedSkill.id)],
            quantities: {},
            studentTags: [],
            subject: ctx.subject || '',
            grade: ctx.grade || '',
            topic: ctx.topic || userInput,
            needsResearch: true,
            needsStudentData: true,
            confidence: 70,
            missingInfo: [],
            priority: 'mid',
          };
        } else {
          // 日常问答
          intent = {
            products: [],
            quantities: {},
            studentTags: [],
            subject: ctx.subject || '',
            grade: ctx.grade || '',
            topic: userInput,
            needsResearch: false,
            needsStudentData: false,
            confidence: 80,
            missingInfo: [],
            priority: 'low',
          };
        }
      }

      // 派生任务类型：products 非空 → document；否则 chat
      var taskType = (intent.products && intent.products.length) ? 'document' : 'chat';
      var skillName = _describeProducts(intent.products);

      if (ui && ui.onSkillMatched && matchedSkill) ui.onSkillMatched(matchedSkill);
      if (ui && ui.onPlan) ui.onPlan([
        '意图识别：' + (taskType === 'document' ? ('并行生成 ' + intent.products.length + ' 个产物：' + skillName) : '日常问答'),
        intent.needsResearch ? '联网搜课标与真题' : '跳过联网搜索',
        intent.needsStudentData ? '读取学情记忆' : '跳过学情分析',
        '子工作流并行执行（各自质量验证与精炼）',
        '结果聚合与资源包输出',
      ]);

      return {
        intent: intent,
        classification: intent,
        taskType: taskType,
        skillId: intent.products.length ? intent.products[0] : null,
        skillName: skillName,
        needsResearch: intent.needsResearch,
        needsStudentData: intent.needsStudentData,
        ctx: Object.assign({}, ctx, {
          topic: intent.topic || ctx.topic || userInput,
          subject: intent.subject || ctx.subject,
          grade: intent.grade || ctx.grade,
        }),
      };
    });

    // ---- 节点2: disambiguate（信息补全：澄清追问） ----
    graph.addNode('disambiguate', async function (state) {
      var ctx = state.ctx || {};
      var intent = state.intent || {};
      if (ui && ui.onStep) ui.onStep({ stage: 'disambiguate', label: '信息补全（澄清追问）' });
      if (ui && ui.onThought) ui.onThought('检测到关键信息不足（缺失：' + ((intent.missingInfo || []).join('、') || '课题') + '），需要向您确认以确保生成内容精准匹配您的需求。正在生成澄清问题…');

      var missingInfo = (intent.missingInfo && intent.missingInfo.length) ? intent.missingInfo : ['topic'];

      // LLM 生成澄清问题（选择题形式）
      var clarifyData = null;
      try {
        var disPrompt = global.WorkflowPrompts.fill(global.WorkflowPrompts.templates.disambiguate, {
          userInput: state.task || '',
          missingInfo: missingInfo.join('、'),
        });
        var raw = await callLLM(disPrompt, '你是需求澄清专家，只输出JSON。');
        clarifyData = _parseJSON(raw);
      } catch (e) {
        console.warn('[workflow] disambiguate LLM 失败，使用默认澄清', e);
      }

      var questions = (clarifyData && clarifyData.questions) || [];
      if (!questions.length) {
        questions = [{
          q: '请问本次备课的课题（章节/知识点）是？',
          options: [ctx.topic || '按我输入的请求生成', '由你根据教材体系推荐', '其他'],
          multi: false,
        }];
      }

      var resolved = null;
      if (ui && ui.onClarify) {
        await ui.onClarify({
          reason: (clarifyData && clarifyData.reason) || '需要补充关键信息以完成备课',
          questions: questions,
        });
        if (waitClarify) resolved = await waitClarify();
      }

      // 回填：按缺失字段顺序填充选择结果
      var newCtx = Object.assign({}, ctx);
      var newIntent = Object.assign({}, intent, { missingInfo: [] });
      if (resolved && resolved.answers && Array.isArray(resolved.answers)) {
        missingInfo.forEach(function (field, idx) {
          var ans = resolved.answers[idx];
          if (ans == null) return;
          var v = (typeof ans === 'object') ? (ans.value || '') : ans;
          if (!v) return;
          if (field === 'topic') { newCtx.topic = v; newIntent.topic = v; }
          else if (field === 'subject') { newCtx.subject = v; newIntent.subject = v; }
          else if (field === 'grade') { newCtx.grade = v; newIntent.grade = v; }
        });
      }

      if (ui && ui.onSubtaskDone) ui.onSubtaskDone('disambiguate');

      return {
        ctx: newCtx,
        intent: newIntent,
        clarifyCount: (state.clarifyCount || 0) + 1,
      };
    });

    // ---- 节点3: route（任务路由：决策子工作流清单） ----
    graph.addNode('route', async function (state) {
      var ctx = state.ctx || {};
      var intent = state.intent || {};
      if (ui && ui.onStep) ui.onStep({ stage: 'route', label: '任务路由与子工作流调度' });
      if (ui && ui.onThought) ui.onThought('根据意图识别结果，确定需要并行执行的子工作流清单。识别到 ' + ((intent.products || []).length) + ' 个产物需求，正在分配子工作流执行管线…');

      // 子工作流白名单
      var WHITELIST = ['explainer', 'lesson-plan', 'ppt', 'animation', 'student-analysis', 'exercise', 'worksheet', 'assessment', 'unit-design', 'differentiation', 'grading', 'error-analysis', 'ppt-page', 'report-page'];

      var subIds = [];
      if (intent.products && intent.products.length) {
        // 白名单过滤 + 去重
        intent.products.forEach(function (p) {
          if (WHITELIST.indexOf(p) >= 0 && subIds.indexOf(p) < 0) subIds.push(p);
        });
      }
      if (!subIds.length) {
        // 默认单产物：教案
        subIds = ['lesson-plan'];
      }

      if (ui && ui.onPlan) {
        var names = subIds.map(function (id) { return _SUB_NAME[id] || id; });
        ui.onPlan(['并行执行子工作流：' + names.join(' / ')]);
      }

      return { subIds: subIds, taskType: 'document' };
    });

    // ---- 节点5: parallel（共享资料准备 + 子工作流并行执行） ----
    graph.addNode('parallel', async function (state) {
      var ctx = state.ctx || {};
      var intent = state.intent || {};
      var subIds = state.subIds || ['lesson-plan'];

      if (ui && ui.onStep) ui.onStep({ stage: 'parallel', label: '并行生成 ' + subIds.length + ' 个产物' });

      // ========== 第 1 步：共享资料准备（仅一次，供全部子工作流复用） ==========
      var researchData = state.researchData || '';
      var searchReferences = state.searchReferences || null;
      var sharedStudentData = state.sharedStudentData || '';

      // 联网搜课标与真题（needsResearch 且尚未准备）
      if (state.needsResearch && !researchData) {
        if (ui && ui.onThought) ui.onThought('正在联网搜索本课题的课程标准要求和近年高考真题考法，为内容生成提供权威依据…');
        researchData = await _prepareResearch(ctx, state, deps, ui, callLLM, tools);
      }
      if (!researchData) researchData = '（暂无联网资料，基于教学经验生成内容）';

      // 读取学情记忆（needsStudentData 且尚未准备）
      if (state.needsStudentData && !sharedStudentData) {
        if (ui && ui.onThought) ui.onThought('正在读取班级学情记忆数据（学生提问记录、作业批改记录、考试成绩等），以便在生成内容时针对薄弱知识点进行强化设计…');
        try {
          if (memory && memory.contextForAgent) {
            sharedStudentData = memory.contextForAgent(ctx.topic || state.task || '') || '';
          }
        } catch (e) { /* ignore */ }
      }
      if (!sharedStudentData) sharedStudentData = '（暂无班级学情数据，基于通用学情生成内容）';

      if (ui && ui.onSubtaskDone) ui.onSubtaskDone('research');

      // ========== 第 2 步：子工作流并行执行 ==========
      var subNames = subIds.map(function (id) { return _SUB_NAME[id] || id; }).join('、');
      if (ui && ui.onThought) ui.onThought('共享资料准备完毕。现在启动 ' + subIds.length + ' 个子工作流并行执行：' + subNames + '。每个子工作流将独立完成「内容生成 → 质量验证 → 精炼循环 → 文件落盘」全流程。');

      if (!global.SubWorkflows) {
        return { error: '子工作流引擎未加载（sub-workflows.js 缺失）' };
      }

      var shared = {
        ctx: ctx,
        intent: intent,
        researchData: researchData,
        searchReferences: searchReferences,
        studentData: sharedStudentData,
        convHistory: state.convHistory || [],
      };

      var parallelResults = {};
      try {
        parallelResults = await global.SubWorkflows.runAll(shared, deps, subIds, { concurrency: subIds.length });
      } catch (e) {
        console.warn('[workflow] parallel 执行异常', e);
        parallelResults = {};
        subIds.forEach(function (id) {
          parallelResults[id] = { status: 'rejected', ok: false, content: null, slides: null, validation: null, refinementCount: 0, artifacts: [], error: (e && e.message) || String(e) };
        });
      }

      if (ui && ui.onSubtaskDone) ui.onSubtaskDone('parallel');

      return {
        researchData: researchData,
        searchReferences: searchReferences,
        sharedStudentData: sharedStudentData,
        parallelResults: parallelResults,
      };
    });

    // ---- 节点6: aggregate（结果聚合：汇总产物/评分/失败项） ----
    graph.addNode('aggregate', async function (state) {
      if (ui && ui.onStep) ui.onStep({ stage: 'aggregate', label: '结果聚合与资源包组装' });
      if (ui && ui.onThought) ui.onThought('所有子工作流执行完毕。正在汇总各产物的生成结果、质量评分和失败项，组装完整的备课资源包…');

      var parallelResults = state.parallelResults || {};
      var artifacts = [];
      var documents = [];
      var qualityScores = {};
      var failed = [];
      var summaryLines = [];

      Object.keys(parallelResults).forEach(function (subId) {
        var r = parallelResults[subId];
        var meta = (global.SubWorkflows && global.SubWorkflows.SUBWORKFLOW_META) ? global.SubWorkflows.SUBWORKFLOW_META[subId] : null;
        var name = (meta && meta.name) || subId;
        if (r && r.status === 'fulfilled' && r.ok) {
          // 成功：展平产物
          (r.artifacts || []).forEach(function (a) {
            artifacts.push(a);
            documents.push({ tool: meta ? meta.docTool : 'gen_word', filename: a.filename, path: a.path, ok: true });
          });
          var score = (r.validation && r.validation.score) != null ? r.validation.score : 0;
          qualityScores[subId] = score;
          summaryLines.push('- ' + name + '：' + (score > 0 ? score + '/100' : '已生成'));
        } else {
          // 失败：记录失败项（不阻断整体）
          failed.push({ subId: subId, name: name, error: (r && r.error) || '未知错误' });
          summaryLines.push('- ' + name + '：生成失败（' + ((r && r.error) || '未知错误') + '）');
        }
      });

      // 总评分：成功项最低分（保守）
      var scores = Object.keys(qualityScores).map(function (k) { return qualityScores[k]; });
      var totalScore = scores.length ? Math.min.apply(null, scores) : 0;

      var bundle = {
        artifacts: artifacts,
        qualityScores: qualityScores,
        failed: failed,
        summary: summaryLines.join('\n') || '（无产物）',
        totalScore: totalScore,
      };

      return { bundle: bundle, artifacts: artifacts, documents: documents };
    });

    // ---- 节点7: finalize（资源包总览输出 + 记忆） ----
    graph.addNode('finalize', async function (state) {
      var ctx = state.ctx || {};
      if (ui && ui.onStep) ui.onStep({ stage: 'finalize', label: '资源包总览输出' });
      if (ui && ui.onThought) ui.onThought('资源包组装完成，正在生成最终总结报告，列出所有生成的文件、质量评分和使用建议…');

      var bundle = state.bundle || { artifacts: [], qualityScores: {}, failed: [], summary: '', totalScore: 0 };
      var artifactsText = (bundle.artifacts && bundle.artifacts.length)
        ? bundle.artifacts.map(function (a) { return '- ' + a.filename + '（' + a.type + '）'; }).join('\n')
        : '（无产物）';
      var scoresText = Object.keys(bundle.qualityScores).map(function (k) {
        return k + ': ' + bundle.qualityScores[k] + '/100';
      }).join('；') || '（无）';
      var failedText = (bundle.failed && bundle.failed.length)
        ? bundle.failed.map(function (f) { return f.name + '（' + f.error + '）'; }).join('；')
        : '（无）';

      var finalAnswer = '';
      var summaryText = '';
      try {
        var finalizePrompt = global.WorkflowPrompts.fill(global.WorkflowPrompts.templates.finalize_bundle, {
          topic: ctx.topic || '',
          artifacts: artifactsText,
          qualityScores: scoresText,
          failed: failedText,
        });
        var raw = await callLLM(finalizePrompt, '你是智能体助手，只输出JSON。');
        var parsed = _parseJSON(raw);
        if (parsed && parsed.summary) {
          summaryText = parsed.summary;
          finalAnswer = summaryText;
        } else {
          summaryText = String(raw || '');
          finalAnswer = summaryText;
        }
      } catch (e) {
        console.warn('[workflow] finalize_bundle LLM 失败，降级手动总结', e);
        summaryText = bundle.summary || '备课资源包生成完成。';
        finalAnswer = '备课资源包已生成：\n\n' + artifactsText + '\n\n' + summaryText;
      }

      if (ui && ui.onAnswer) await ui.onAnswer(finalAnswer, { streamed: false });

      // 保存记忆
      if (memory && memory.endTask) {
        memory.endTask('success', finalAnswer, (bundle.artifacts || []).map(function (a) { return a.path; }).join(','));
      }

      return {
        bundle: bundle,
        documents: state.documents || [],
        artifacts: bundle.artifacts || [],
        finalAnswer: finalAnswer,
      };
    });

    // ---- 节点8: chat_answer（日常问答，非文档任务） ----
    graph.addNode('chat_answer', async function (state) {
      if (ui && ui.onStep) ui.onStep({ stage: 'chat', label: '回答问题' });
      if (ui && ui.onThought) ui.onThought('本次请求为日常问答，无需生成文档。正在结合教学经验和课标知识，为您生成专业、有深度的回答…');

      var answer = '';
      try {
        if (callLLMStream) {
          var acc = '';
          for await (var chunk of callLLMStream(state.task, '你是高中教研专家，专业回答教师问题。')) {
            if (chunk && !chunk.startsWith('\u0001')) acc += chunk;
          }
          answer = acc;
        } else {
          answer = await callLLM(state.task, '你是高中教研专家，专业回答教师问题。');
        }
      } catch (e) {
        answer = '抱歉，回答生成失败：' + (e.message || e);
      }

      if (ui && ui.onAnswer) await ui.onAnswer(answer, { streamed: false });
      if (memory && memory.endTask) memory.endTask('success', answer, '');

      return { finalAnswer: answer };
    });

    // ================================================================
    // 边与条件路由
    // ================================================================

    graph.setEntryPoint('classify');

    // classify → chat_answer（日常问答）/ disambiguate（信息不足）/ route（信息齐备）
    graph.addConditionalEdges('classify', function (state) {
      var intent = state.intent || {};
      if (state.taskType === 'chat' || !intent.products || !intent.products.length) return 'chat_answer';
      // 关键信息缺失且未澄清过 → 澄清追问
      var missing = intent.missingInfo || [];
      var hasCriticalMissing = missing.some(function (f) { return ['subject', 'grade', 'topic'].indexOf(f) >= 0; });
      if (hasCriticalMissing && (state.clarifyCount || 0) < 1) return 'disambiguate';
      return 'route';
    }, {
      'chat_answer': 'chat_answer',
      'disambiguate': 'disambiguate',
      'route': 'route',
    });

    // disambiguate → route（澄清后回路由重估）
    graph.addEdge('disambiguate', 'route');

    // route → parallel（文档任务）
    graph.addConditionalEdges('route', function (state) {
      if (state.taskType === 'chat') return 'chat_answer';
      return 'parallel';
    }, {
      'chat_answer': 'chat_answer',
      'parallel': 'parallel',
    });

    // parallel → aggregate → finalize → END
    graph.addEdge('parallel', 'aggregate');
    graph.addEdge('aggregate', 'finalize');

    // finalize → END
    graph.setFinishPoint('finalize');

    // chat_answer → END
    graph.setFinishPoint('chat_answer');

    // 编译
    var compiled = graph.compile();
    return { compiled: compiled, graph: graph };
  }

  // ================================================================
  // 辅助函数
  // ================================================================

  /** 解析 JSON（容错） */
  function _parseJSON(txt) {
    if (!txt) return null;
    var s = String(txt).trim();
    try { return JSON.parse(s); } catch (e) { /* continue */ }
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    try { return JSON.parse(s); } catch (e) { /* continue */ }
    var start = s.indexOf('{');
    var startArr = s.indexOf('[');
    if (start < 0 && startArr < 0) return null;
    // 尝试对象
    if (start >= 0 && (startArr < 0 || start < startArr)) {
      var depth = 0, inStr = false, esc = false, end = -1;
      for (var i = start; i < s.length; i++) {
        var c = s[i];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"' && !esc) { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > start) { try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { } }
    }
    // 尝试数组
    if (startArr >= 0) {
      var depthA = 0, inStrA = false, escA = false, endA = -1;
      for (var j = startArr; j < s.length; j++) {
        var cA = s[j];
        if (escA) { escA = false; continue; }
        if (cA === '\\') { escA = true; continue; }
        if (cA === '"' && !escA) { inStrA = !inStrA; continue; }
        if (inStrA) continue;
        if (cA === '[') depthA++;
        else if (cA === ']') { depthA--; if (depthA === 0) { endA = j; break; } }
      }
      if (endA > startArr) { try { return JSON.parse(s.slice(startArr, endA + 1)); } catch (e) { } }
    }
    return null;
  }

  // 子工作流中文名映射
  var _SUB_NAME = {
    'explainer': '任务拆解精讲',
    'lesson-plan': '教案',
    'ppt': 'PPT课件',
    'animation': '交互动画',
    'student-analysis': '学情分析',
    'exercise': '习题',
    'worksheet': '学案',
    'assessment': '评价量规',
    'unit-design': '大单元设计',
    'differentiation': '分层教学',
    // 新增技能
    'grading': '题目批改',
    'error-analysis': '重点及易错点分析',
    'ppt-page': 'PPT页面生成',
    'report-page': '报告页面生成',
  };

  /** 技能 id → 子工作流 id 映射（降级用） */
  function _mapSkillToSub(skillId) {
    var map = {
      'lesson-plan': 'lesson-plan',
      'ppt-generator': 'ppt',
      'worksheet': 'worksheet',
      'exam-generator': 'exercise',
      'assessment': 'assessment',
      'unit-design': 'unit-design',
      'differentiation': 'differentiation',
      // 新增技能映射
      'grading': 'grading',
      'error-analysis': 'error-analysis',
      'ppt-page': 'ppt-page',
      'report-page': 'report-page',
    };
    return map[skillId] || 'lesson-plan';
  }

  /** 产物 id 列表 → 中文描述 */
  function _describeProducts(products) {
    if (!products || !products.length) return '日常问答';
    return products.map(function (p) { return _SUB_NAME[p] || p; }).join('、');
  }

  /**
   * 共享资料准备：联网搜课标/真题并整合（供 parallel 节点调用一次）
   * @returns {Promise<string>} 整合后的资料文本
   */
  async function _prepareResearch(ctx, state, deps, ui, callLLM, tools) {
    var researchPrompt = global.WorkflowPrompts.fill(global.WorkflowPrompts.templates.research, {
      topic: ctx.topic || '',
      subject: ctx.subject || '',
      grade: ctx.grade || '',
      skillName: _describeProducts((state.intent && state.intent.products) || []),
    });

    var searchQueries = [];
    var focusAreas = [];
    try {
      var raw = await callLLM(researchPrompt, '你是资料搜集专家，只输出JSON。');
      var result = _parseJSON(raw);
      if (result) {
        searchQueries = result.searchQueries || [];
        focusAreas = result.focusAreas || [];
      }
    } catch (e) {
      console.warn('[workflow] research LLM 失败', e);
    }

    if (!searchQueries.length) {
      searchQueries = [
        (ctx.subject || '') + ' ' + (ctx.topic || '') + ' 课程标准 核心素养',
        (ctx.subject || '') + ' ' + (ctx.topic || '') + ' 高考真题 考法',
      ];
    }
    if (ui && ui.onThought) ui.onThought('已规划 ' + searchQueries.length + ' 个搜索方向：' + searchQueries.map(function(q) { return '「' + q + '」'; }).join('、') + '。正在依次执行搜索…');

    var allResults = [];
    if (tools && tools.has && tools.has('web_search')) {
      for (var i = 0; i < searchQueries.length && i < 3; i++) {
        if (ui && ui.onToolCall) ui.onToolCall({ name: 'web_search', args: { query: searchQueries[i] }, step: i + 1 });
        try {
          var r = await tools.invoke('web_search', { query: searchQueries[i] }, { timeout: 40000 });
          if (r.ok && r.data) {
            var results = r.data.results || r.data || [];
            if (Array.isArray(results)) allResults = allResults.concat(results);
            if (ui && ui.onToolResult) ui.onToolResult({ name: 'web_search', ok: true, result: r.data, step: i + 1 });
          } else {
            if (ui && ui.onToolResult) ui.onToolResult({ name: 'web_search', ok: false, error: r.error, step: i + 1 });
          }
        } catch (e) {
          console.warn('[workflow] search failed', e);
        }
      }
    }

    var data = '';
    if (allResults.length) {
      data = allResults.slice(0, 8).map(function (res, i) {
        return '【' + (i + 1) + '】' + (res.title || '') + '\n' + (res.snippet || res.summary || res.content || '').slice(0, 500);
      }).join('\n\n');
    } else {
      data = '（联网搜索未返回结果，请基于教学经验生成内容）';
    }
    if (focusAreas.length) {
      data = '## 需要关注的方向\n' + focusAreas.join('\n') + '\n\n## 搜索结果\n' + data;
    }
    return data;
  }

  /** 根据技能获取文档生成工具名 */
  function _getDocTool(skillId) {
    var map = {
      'lesson-plan': 'gen_word',
      'ppt-generator': 'gen_ppt',
      'worksheet': 'gen_word',
      'exam-generator': 'gen_word',
      'assessment': 'gen_excel',
      'unit-design': 'gen_word',
      'differentiation': 'gen_word',
      // 新增技能文档工具
      'grading': 'gen_word',
      'error-analysis': 'gen_word',
      'ppt-page': 'gen_ppt',
      'report-page': 'write_file',
    };
    return map[skillId] || 'gen_word';
  }

  /** 根据技能获取文档类型描述 */
  function _getDocType(skillId) {
    var map = {
      'lesson-plan': 'Word教案',
      'ppt-generator': 'PPT课件',
      'worksheet': 'Word学案',
      'exam-generator': 'Word试卷',
      'assessment': 'Excel量规',
      'unit-design': 'Word大单元设计',
      'differentiation': 'Word分层设计',
      // 新增技能文档类型
      'grading': 'Word批改报告',
      'error-analysis': 'Word分析报告',
      'ppt-page': 'PPT课件',
      'report-page': 'HTML报告',
    };
    return map[skillId] || '文档';
  }

  /** 构建文件名 */
  function _buildFilename(ctx, skillName, skillId) {
    var topic = ctx.topic || '教学内容';
    // 清理课题中的特殊字符
    topic = String(topic).replace(/[\\/:*?"<>|]/g, '').slice(0, 30);
    var ext = 'docx';
    if (skillId === 'ppt-generator' || skillId === 'ppt-page') ext = 'pptx';
    else if (skillId === 'assessment') ext = 'xlsx';
    else if (skillId === 'report-page') ext = 'html';
    return skillName + '_' + topic + '.' + ext;
  }

  /** 构建文档工具参数 */
  function _buildDocArgs(skillId, filename, content, slides, ctx) {
    if (skillId === 'ppt-generator') {
      // PPT 用 slides 数组
      var slideArr = slides;
      if (!slideArr) {
        // 尝试从 content 解析
        var parsed = _parseJSON(content);
        slideArr = (parsed && Array.isArray(parsed)) ? parsed : [];
      }
      // 如果解析失败，构造一个单页 PPT 兜底
      if (!slideArr.length) {
        slideArr = [{
          type: 'content',
          title: ctx.topic || '课件',
          bullets: content.split('\n').filter(Boolean).slice(0, 8),
        }];
      }
      return { filename: filename, slides: slideArr };
    }
    if (skillId === 'assessment') {
      // Excel 量规：从 Markdown 表格解析为 rows
      var rows = _parseMarkdownTable(content);
      if (!rows.length) {
        rows = [['评价维度', '优秀', '良好', '合格', '待改进', '权重']];
      }
      return { filename: filename, rows: rows, sheetName: '评价量规' };
    }
    // Word 文档
    return {
      filename: filename,
      title: ctx.topic || (skillId === 'lesson-plan' ? '教案' : '文档'),
      content: content,
    };
  }

  /** 从 Markdown 表格解析为二维数组 */
  function _parseMarkdownTable(md) {
    var lines = String(md || '').split('\n').filter(function (l) { return l.trim().indexOf('|') >= 0; });
    var rows = [];
    lines.forEach(function (line, idx) {
      // 跳过分隔行（|---|---|）
      if (/^\|[\s\-:|]+$/.test(line.trim())) return;
      var cells = line.split('|').map(function (c) { return c.trim(); });
      // 去掉首尾空元素
      if (cells.length && cells[0] === '') cells.shift();
      if (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (cells.length) rows.push(cells);
    });
    return rows;
  }

  // ================================================================
  // 导出
  // ================================================================

  global.LangGraphWorkflow = {
    StateGraph: StateGraph,
    createTeachingWorkflow: createTeachingWorkflow,
    tryLoadLangGraph: tryLoadLangGraph,
    isUsingRealLangGraph: function () { return _useRealLangGraph; },
    WORKFLOW_STATE: WORKFLOW_STATE,
    MAX_REFINEMENTS: MAX_REFINEMENTS,
    _parseJSON: _parseJSON,
    _parseMarkdownTable: _parseMarkdownTable,
  };
})(window);
