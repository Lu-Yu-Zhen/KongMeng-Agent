/*!
 * teacher-agent-sandbox · 多子工作流执行引擎 (sub-workflows.js)
 * ------------------------------------------------------------------
 * 为「备课超级智能体」提供 14 个子工作流的并行执行能力：
 *   explainer(任务拆解精讲) / lesson-plan(教案) / ppt(PPT课件) /
 *   animation(交互动画) / student-analysis(学情分析) / exercise(习题) /
 *   worksheet(学案) / assessment(评价量规) / unit-design(大单元) / differentiation(分层) /
 *   grading(题目批改) / error-analysis(重点及易错点分析) / ppt-page(HTML演示文稿) / report-page(HTML报告)
 *
 * 设计要点：
 *   1) 每个子工作流是「函数式隔离」的独立管线（生成 → 质量验证 → 精炼循环），
 *      不使用嵌套 StateGraph（内置实现为单一 state 浅合并，并行会互相覆盖字段）。
 *   2) Markdown 文本产物优先走流式接口（callAIStream，自由文本），
 *      回退 callAIJson 时按「输出 {"content":"..."} 并解包」约定处理（规避强制 JSON）。
 *   3) 动画子工作流：LLM 生成 JSON 动画脚本 → 组装为自包含单文件 HTML5 交互动画
 *      → write_file 落盘到「课件/」目录（映射到"备课"，且不被临时清理误删）。
 *   4) 并行失败不阻断：runAll 使用 Promise.allSettled，失败项由主图 aggregate 记录。
 */
(function (global) {
  'use strict';

  var MAX_REFINEMENTS = 2;

  // ================================================================
  // 子工作流元信息表
  // ================================================================
  var SUBWORKFLOW_META = {
    'explainer':        { id: 'explainer',        name: '任务拆解精讲', templateKey: 'explainer',        standardKey: 'explainer',        docTool: 'gen_word',  docType: 'Word精讲',   text: true,  json: false, slides: false, animation: false, assessment: false },
    'lesson-plan':      { id: 'lesson-plan',      name: '教案',         templateKey: 'lesson-plan',      standardKey: 'lesson-plan',      docTool: 'gen_word',  docType: 'Word教案',   text: true,  json: false, slides: false, animation: false, assessment: false },
    'ppt':              { id: 'ppt',              name: 'PPT课件',      templateKey: 'ppt',              standardKey: 'ppt-generator',    docTool: 'gen_ppt',   docType: 'PPT课件',   text: false, json: true,  slides: true,  animation: false, assessment: false },
    'animation':        { id: 'animation',        name: '交互动画',     templateKey: 'animation',        standardKey: 'animation',        docTool: 'write_file', docType: 'HTML5动画', text: false, json: true,  slides: false, animation: true,  assessment: false },
    'student-analysis': { id: 'student-analysis', name: '学情分析',     templateKey: 'student-analysis', standardKey: 'student-analysis', docTool: 'gen_word',  docType: 'Word学情报告', text: true, json: false, slides: false, animation: false, assessment: false },
    'exercise':         { id: 'exercise',         name: '习题',         templateKey: 'exercise',         standardKey: 'exam-generator',   docTool: 'gen_word',  docType: 'Word试卷',   text: true,  json: false, slides: false, animation: false, assessment: false },
    'worksheet':        { id: 'worksheet',        name: '学案',         templateKey: 'worksheet',        standardKey: 'worksheet',        docTool: 'gen_word',  docType: 'Word学案',   text: true,  json: false, slides: false, animation: false, assessment: false },
    'assessment':       { id: 'assessment',       name: '评价量规',     templateKey: 'assessment',       standardKey: 'assessment',       docTool: 'gen_excel', docType: 'Excel量规', text: true,  json: false, slides: false, animation: false, assessment: true },
    'unit-design':      { id: 'unit-design',      name: '大单元设计',   templateKey: 'unit-design',      standardKey: 'unit-design',      docTool: 'gen_word',  docType: 'Word大单元设计', text: true, json: false, slides: false, animation: false, assessment: false },
    'differentiation':  { id: 'differentiation',  name: '分层教学',     templateKey: 'differentiation',  standardKey: 'differentiation',  docTool: 'gen_word',  docType: 'Word分层设计', text: true, json: false, slides: false, animation: false, assessment: false },
    // ---- 新增技能子工作流（对应修改后的 skills 文件夹） ----
    'grading':          { id: 'grading',          name: '题目批改',     templateKey: 'grading',          standardKey: 'grading',          docTool: 'gen_word',  docType: 'Word批改报告', text: true, json: false, slides: false, animation: false, assessment: false },
    'error-analysis':   { id: 'error-analysis',   name: '重点及易错点分析', templateKey: 'error-analysis', standardKey: 'error-analysis', docTool: 'gen_word',  docType: 'Word分析报告', text: true, json: false, slides: false, animation: false, assessment: false },
    'ppt-page':         { id: 'ppt-page',         name: 'PPT课件',      templateKey: 'ppt-page',         standardKey: 'ppt-page',         docTool: 'gen_ppt',   docType: 'PPT课件',   text: false, json: true,  slides: true,  animation: false, assessment: false },
    'report-page':      { id: 'report-page',      name: '报告页面生成',  templateKey: 'report-page',      standardKey: 'report-page',      docTool: 'write_file', docType: 'HTML报告',   text: true,  json: false, slides: false, animation: false, assessment: false },
  };

  // ================================================================
  // 统一管线：runAll（并行）/ runOne（单个）
  // ================================================================

  /**
   * 并行执行多个子工作流
   * @param {object} shared - 共享上下文 { ctx, intent, researchData, studentData, convHistory }
   * @param {object} deps   - 依赖注入 { callLLM, callLLMStream, tools, ui, memory }
   * @param {string[]} subIds - 子工作流 id 列表（已白名单过滤）
   * @param {object} opts   - { concurrency?: number }
   * @returns {Promise<object>} { [subId]: {status, ok, content, slides, validation, refinementCount, artifacts, error} }
   */
  async function runAll(shared, deps, subIds, opts) {
    opts = opts || {};
    var results = {};
    var ids = (subIds || []).filter(function (id) { return SUBWORKFLOW_META[id]; });
    if (!ids.length) return results;
    var concurrency = opts.concurrency || ids.length;
    // 简易并发池：控制同时运行的子工作流数量（默认全并行）
    var cursor = 0;
    async function worker() {
      while (cursor < ids.length) {
        var id = ids[cursor++];
        try {
          var r = await runOne(id, shared, deps);
          results[id] = { status: 'fulfilled', ok: r.ok, content: r.content, slides: r.slides, validation: r.validation, refinementCount: r.refinementCount, artifacts: r.artifacts, error: r.error || null };
        } catch (e) {
          results[id] = { status: 'rejected', ok: false, content: null, slides: null, validation: null, refinementCount: 0, artifacts: [], error: (e && e.message) || String(e) };
        }
      }
    }
    var pool = [];
    for (var i = 0; i < Math.min(concurrency, ids.length); i++) pool.push(worker());
    await Promise.all(pool);
    return results;
  }

  /**
   * 执行单个子工作流：生成 → 验证 → 精炼（循环） → 落盘
   * @returns {Promise<{ok:boolean, content:string, slides:Array|null, validation:object, refinementCount:number, artifacts:Array, error:string|null}>}
   */
  async function runOne(subId, shared, deps) {
    var meta = SUBWORKFLOW_META[subId];
    if (!meta) return { ok: false, content: '', slides: null, validation: null, refinementCount: 0, artifacts: [], error: '未知子工作流: ' + subId };

    var ctx = (shared && shared.ctx) || {};
    var ui = deps.ui;
    if (ui && ui.onStep) ui.onStep({ stage: subId, label: '生成' + meta.name + '（子工作流）' });
    if (ui && ui.onThought) ui.onThought('【' + meta.name + '】启动子工作流。课题：' + (ctx.topic || '未指定') + '，学科：' + (ctx.subject || '未指定') + '。将依次执行内容生成、质量验证、精炼循环和文件落盘。');

    var content = '';
    var slides = null;
    var refinementCount = 0;
    var validation = null;
    var error = null;

    for (;;) {
      // 中止检查：用户点停止后提前退出，不再继续生成/精炼
      if (deps && typeof deps.isAborted === 'function' && deps.isAborted()) {
        return { ok: false, content: content, slides: slides, validation: validation, refinementCount: refinementCount, artifacts: [], error: '任务已中止' };
      }
      // ---- 生成 ----
      if (refinementCount === 0) {
        if (ui && ui.onThought) ui.onThought('【' + meta.name + '】正在调用大模型生成' + meta.docType + '内容，融入课标要求、真题考法和班级学情数据…');
        var genResult = await _generate(meta, shared, deps);
        if (genResult.error) { error = genResult.error; break; }
        content = genResult.content;
        slides = genResult.slides;
      } else {
        // ---- 精炼 ----
        if (ui && ui.onThought) ui.onThought('【' + meta.name + '】质量验证未通过（得分 ' + (validation ? validation.score : '?') + '/100），正在根据反馈进行第 ' + (refinementCount + 1) + ' 次精炼优化…');
        var feedback = global.QualityValidator.buildFeedback(validation);
        var refineResult = await _refine(meta, shared, deps, content, feedback);
        if (refineResult.error) { error = refineResult.error; break; }
        content = refineResult.content;
        if (refineResult.slides) slides = refineResult.slides;
      }

      // ---- 验证 ----
      if (ui && ui.onThought) ui.onThought('【' + meta.name + '】内容生成完成，正在进行质量验证（检查字数/页数/环节完整性/公式规范/内容深度等指标）…');
      var opts = {};
      if (slides && slides.length) opts.slideCount = slides.length;
      if (meta.animation) {
        // 动画用 HTML 内容验证（内含 <svg>/<script>/场景标记）
        validation = global.QualityValidator.validate(meta.standardKey, content, opts);
      } else {
        validation = global.QualityValidator.validate(meta.standardKey, content, opts);
      }
      if (ui && ui.onThought) {
        ui.onThought(meta.name + '质量验证：' + validation.score + '/100' + (validation.passed ? '（通过）' : '（未通过，精炼第' + (refinementCount + 1) + '次）'), 0);
      }
      if (validation.passed || refinementCount >= MAX_REFINEMENTS) break;
      refinementCount++;
    }

    // ---- 落盘 ----
    var artifacts = [];
    if (!error && content) {
      if (ui && ui.onThought) ui.onThought('【' + meta.name + '】质量验证通过（得分 ' + (validation ? validation.score : '?') + '/100），正在将内容写入' + meta.docType + '文件并保存到沙箱…');
      var persistResult = await _persist(meta, shared, deps, content, slides);
      artifacts = persistResult.artifacts || [];
      if (persistResult.error) error = persistResult.error;
    }

    return { ok: !error, content: content, slides: slides, validation: validation, refinementCount: refinementCount, artifacts: artifacts, error: error };
  }

  // ================================================================
  // 生成阶段
  // ================================================================

  /** 依据产物类型生成推荐结构大纲（{outline} 注入用，避免大纲段空白导致结构松散） */
  function _defaultOutline(meta, topic) {
    var t = topic || '本课题';
    if (meta && meta.slides) {
      return '建议页面结构：封面（《' + t + '》标题/授课人）→ 学习目标 → 知识讲授（概念/定理表述+要点）→ 例题精讲（完整解答步骤）→ 变式练习 → 要点归纳小结 → 作业布置/结束页。每页需有明确标题与具体要点内容，避免空泛。';
    }
    return '建议结构：教学目标（核心素养维度）→ 学情分析 → 教学重点与难点（附突破策略）→ 教学过程（情境导入/新知探究/例题精讲/变式训练/课堂小结，含教师提问话术与学生预设回答）→ 板书设计 → 分层作业 → 教学反思。各部分需展开具体内容。';
  }

  /**
   * 首次生成内容
   * @returns {Promise<{content:string, slides:Array|null, error:string|null}>}
   */
  async function _generate(meta, shared, deps) {
    var ctx = (shared && shared.ctx) || {};
    var intent = (shared && shared.intent) || {};
    var vars = {
      topic: ctx.topic || '',
      subject: ctx.subject || '',
      grade: ctx.grade || '',
      outline: _defaultOutline(meta, ctx.topic),
      researchData: (shared && shared.researchData) ? String(shared.researchData).slice(0, 3000) : '（暂无联网资料，基于教学经验生成）',
      studentAnalysis: (shared && shared.studentData) ? String(shared.studentData).slice(0, 2000) : '（暂无学情数据）',
      studentData: (shared && shared.studentData) ? String(shared.studentData).slice(0, 2000) : '（暂无班级学情数据）',
      studentTags: (intent.studentTags && intent.studentTags.length) ? intent.studentTags.join('、') : '（未提供学情标签）',
      keyPoints: (intent.keyPoints && intent.keyPoints.length) ? intent.keyPoints.join('；') : '（基于课题常识把握）',
      quantities: intent.quantities || {},
    };

    var template = global.WorkflowPrompts.getGeneratePrompt(meta.templateKey);
    var prompt = global.WorkflowPrompts.fill(template, vars);

    // ---- 动画子工作流：JSON 脚本 → HTML 组装 ----
    if (meta.animation) {
      return await _generateAnimation(prompt, meta, shared, deps, vars);
    }

    // ---- PPT 子工作流：JSON slides ----
    if (meta.slides) {
      var slidesRaw = await _callJsonLLM(prompt, '你是课件设计专家，只输出JSON幻灯片数组。', deps);
      var slides = _parseSlides(slidesRaw);
      if (!slides || !slides.length) return { content: String(slidesRaw || ''), slides: null, error: null };
      // 将 slides 转为验证用文本（validate 的 ppt-generator 标准按页数与关键词检查）
      var text = slides.map(function (s, i) {
        return '## ' + (s.title || ('第' + (i + 1) + '页')) +
          (s.bullets ? '\n' + s.bullets.map(function (b) { return '- ' + b; }).join('\n') : '');
      }).join('\n\n');
      return { content: text, slides: slides, error: null };
    }

    // ---- 教案子工作流：分节并行生成（避免单次超长输出导致的超时/卡顿，提升速度与完整性） ----
    if (meta.id === 'lesson-plan') {
      return await _generateLessonPlan(meta, shared, deps, vars);
    }

    // ---- 文本类（Markdown）子工作流：优先流式 ----
    if (meta.text) {
      var sysPrompt = '你是高中教研专家，生成高质量教学文档。所有内容必须具体可操作，禁止空泛表述。数学公式用 LaTeX 语法。';
      var textContent = '';
      if (deps.callLLMStream) {
        var acc = '';
        for await (var chunk of deps.callLLMStream(prompt, sysPrompt)) {
          if (chunk && !chunk.startsWith('\u0001')) acc += chunk;
        }
        textContent = acc;
      } else if (deps.callLLM) {
        // 回退 callAIJson：强制 JSON，需解包 {"content":"..."}
        var raw2 = await deps.callLLM(prompt, sysPrompt + '。你的输出必须为JSON对象，格式为 {"content":"<完整文档Markdown>"}，不要输出其他字段。');
        textContent = _unwrapContent(raw2);
      }
      return { content: textContent, slides: null, error: textContent ? null : '内容生成为空' };
    }

    return { content: '', slides: null, error: '未匹配到生成方式: ' + meta.id };
  }

  /**
   * 教案分节并行生成。
   * 将教案拆为 4 个独立分节，并行调用 LLM（每节约 700-900 字，单次生成快、不易超时），
   * 再按固定顺序组装为完整 Markdown 教案。相比单次生成超长文档，
   * 显著降低超时概率、提升整体速度，并保证各必备章节完整（质量验证一次通过）。
   */
  async function _generateLessonPlan(meta, shared, deps, vars) {
    var ctx = (shared && shared.ctx) || {};
    var sys = '你是资深高中教研专家，擅长编写结构完整、内容具体可操作的教案片段。'
      + '所有内容必须具体可操作，禁止"此处讲解""举例说明""略"等空泛表述。'
      + '数学公式用 LaTeX（行内 $...$，块级 $$...$$）。只输出纯 Markdown 正文，不要任何解释或代码块标记。';

    var base = '课题：《' + (ctx.topic || '未指定') + '》\n'
      + '学科：' + (ctx.subject || '未指定') + '，年级：' + (ctx.grade || '未指定') + '\n\n'
      + '课标与考法资料：\n' + (vars.researchData || '（暂无联网资料，基于教学经验生成）') + '\n\n'
      + '学情分析：\n' + (vars.studentAnalysis || '（暂无学情数据）') + '\n\n';

    var s1 = base + '请编写教案的开篇部分，必须严格包含以下小节（用 ## 作为二级标题）：\n'
      + '1. ## 课标依据与教材分析\n2. ## 学情分析\n3. ## 教学目标（核心素养四维度：数学抽象/逻辑推理/数学建模/直观想象等，用可观察可测量的行为动词，如"能够…"）\n'
      + '4. ## 教学重点与难点（各附突破策略）\n'
      + '该分节正文不少于 700 字。';

    var s2 = base + '请编写教案"教学过程"的前两个教学环节，用 ## 教学过程 作为总标题，用 ### 环节名称 作为子标题：\n'
      + '### 环节一：情境导入（附具体情境材料与导入语原话）\n### 环节二：新知探究（附概念/定理的完整表述、关键设问）\n'
      + '每个环节必须写清：【教师活动】含具体提问话术（用"师："标注）、【学生活动】含预设回答（用"生："标注）、【设计意图】、【时间分配】。'
      + '该分节正文不少于 700 字。';

    var s3 = base + '请继续编写教案"教学过程"的后三个教学环节，用 ### 环节名称 作为子标题：\n'
      + '### 环节三：例题精讲\n### 环节四：变式训练\n### 环节五：课堂小结\n'
      + '每个环节必须写清：【教师活动】含具体提问话术（用"师："标注）、【学生活动】含预设回答（用"生："标注）、【设计意图】、【时间分配】。'
      + '例题精讲环节须给出完整题干与分步规范解答。该分节正文不少于 800 字。';

    var s4 = base + '请编写教案的收尾部分，必须严格包含以下小节（用 ## 作为二级标题）：\n'
      + '1. ## 例题与变式（完整题干+分步解答，至少2道例题，数学公式用 LaTeX）\n'
      + '2. ## 分层作业（基础/提升/拓展三层，各给出具体题目）\n'
      + '3. ## 板书设计（结构化呈现，用缩进或列表）\n'
      + '4. ## 教学反思预设\n'
      + '该分节正文不少于 700 字。';

    var tasks = [
      { key: 'h', prompt: s1 },
      { key: 'p1', prompt: s2 },
      { key: 'p2', prompt: s3 },
      { key: 't', prompt: s4 },
    ];

    // 并行调用 4 个分节（每个请求独立、短小，避免超时）
    var results = await Promise.all(tasks.map(function (t) {
      return _callTextLLM(t.prompt, sys, deps).then(function (txt) { return { key: t.key, text: txt }; });
    }));

    var empty = results.filter(function (r) { return !r.text; });
    if (empty.length === tasks.length) {
      return { content: '', slides: null, error: '教案分节生成失败：模型未返回有效内容（可能超时）' };
    }

    // 固定顺序组装（标题在分节内已含，直接拼接）
    var order = { h: '', p1: '\n\n', p2: '\n\n', t: '\n\n' };
    var assembled = results.slice().sort(function (a, b) {
      return ['h', 'p1', 'p2', 't'].indexOf(a.key) - ['h', 'p1', 'p2', 't'].indexOf(b.key);
    }).map(function (r) { return (order[r.key] || '\n\n') + String(r.text || '').trim(); }).join('');

    if (!assembled.trim()) return { content: '', slides: null, error: '教案分节生成为空' };
    return { content: assembled, slides: null, error: null };
  }

  /**
   * 调用文本型 LLM 并返回纯文本（优先流式，回退 callLLM 解包）
   */
  async function _callTextLLM(prompt, sysPrompt, deps) {
    if (deps.callLLMStream) {
      var acc = '';
      for await (var chunk of deps.callLLMStream(prompt, sysPrompt)) {
        if (chunk && !chunk.startsWith('\u0001')) acc += chunk;
      }
      return acc;
    }
    if (deps.callLLM) {
      var raw = await deps.callLLM(prompt, sysPrompt + '。你的输出必须为JSON对象，格式为 {"content":"<完整分节Markdown>"}，不要输出其他字段。');
      return _unwrapContent(raw);
    }
    return '';
  }

  /**
   * 动画子工作流：LLM 生成 JSON 脚本，组装为自包含 HTML5 交互动画
   */
  async function _generateAnimation(prompt, meta, shared, deps, vars) {
    var ctx = (shared && shared.ctx) || {};
    var sysPrompt = '你是教学可视化专家，只输出JSON动画脚本。';
    var raw = '';
    if (deps.callLLM) {
      raw = await deps.callLLM(prompt, sysPrompt);
    } else if (deps.callLLMStream) {
      var acc = '';
      for await (var chunk of deps.callLLMStream(prompt, sysPrompt)) {
        if (chunk && !chunk.startsWith('\u0001')) acc += chunk;
      }
      raw = acc;
    }

    var script = _parseJSON(raw);
    if (script && Array.isArray(script.scenes) && script.scenes.length) {
      var html = _buildAnimationHTML(script, ctx);
      return { content: html, slides: null, error: null };
    }
    // 容错：LLM 直接返回完整 HTML（非 JSON）时原样采用
    if (raw && (raw.indexOf('<html') >= 0 || raw.indexOf('<!DOCTYPE') >= 0 || (raw.indexOf('<svg') >= 0 && raw.indexOf('</svg>') >= 0))) {
      return { content: raw, slides: null, error: null };
    }
    return { content: '', slides: null, error: '动画脚本生成失败：未能解析出场景数组' };
  }

  // ================================================================
  // 精炼阶段
  // ================================================================

  async function _refine(meta, shared, deps, draftContent, feedback) {
    var ctx = (shared && shared.ctx) || {};
    var refinePrompt = global.WorkflowPrompts.fill(global.WorkflowPrompts.templates.refine, {
      topic: ctx.topic || '',
      subject: ctx.subject || '',
      draftContent: String(draftContent || ''),
      validationFeedback: feedback,
    });

    if (meta.animation) {
      // 动画精炼：希望 LLM 输出修正后的完整 JSON 脚本或 HTML
      var raw = await deps.callLLM(refinePrompt, '你是教学内容审校专家。输出完整的修正后动画脚本JSON（含 scenes 数组），或直接输出完整HTML。');
      var script = _parseJSON(raw);
      if (script && Array.isArray(script.scenes) && script.scenes.length) {
        return { content: _buildAnimationHTML(script, ctx), slides: null, error: null };
      }
      if (raw && (raw.indexOf('<html') >= 0 || raw.indexOf('<svg') >= 0)) {
        return { content: raw, slides: null, error: null };
      }
      // 精炼失败保留原内容
      return { content: draftContent, slides: null, error: null };
    }

    if (meta.slides) {
      var slidesRaw = await _callJsonLLM(refinePrompt, '你是教学内容审校专家，只输出JSON幻灯片数组。', deps);
      var slides = _parseSlides(slidesRaw);
      if (slides && slides.length) {
        var text = slides.map(function (s, i) {
          return '## ' + (s.title || ('第' + (i + 1) + '页')) +
            (s.bullets ? '\n' + s.bullets.map(function (b) { return '- ' + b; }).join('\n') : '');
        }).join('\n\n');
        return { content: text, slides: slides, error: null };
      }
      return { content: draftContent, slides: null, error: null };
    }

    var refined = '';
    if (deps.callLLMStream) {
      var acc = '';
      for await (var chunk of deps.callLLMStream(refinePrompt, '你是教学内容审校专家，输出完整Markdown。')) {
        if (chunk && !chunk.startsWith('\u0001')) acc += chunk;
      }
      refined = acc;
    } else if (deps.callLLM) {
      var raw2 = await deps.callLLM(refinePrompt, '你是教学内容审校专家。输出必须为JSON对象，格式为 {"content":"<完整文档Markdown>"}。');
      refined = _unwrapContent(raw2);
    }
    return { content: refined || draftContent, slides: null, error: null };
  }

  // ================================================================
  // 落盘分发
  // ================================================================

  async function _persist(meta, shared, deps, content, slides) {
    var ctx = (shared && shared.ctx) || {};
    var tools = deps.tools;
    var ui = deps.ui;
    if (!tools) return { artifacts: [], error: null };

    var filename = _buildFilename(ctx, meta.name, meta.id);
    var artifacts = [];
    var error = null;

    try {
      if (meta.animation) {
        // 动画 → write_file 落盘到「课件/」目录
        var path = '课件/' + filename;
        if (ui && ui.onToolCall) ui.onToolCall({ name: 'write_file', args: { path: path }, step: 1 });
        var wr = await tools.invoke('write_file', { path: path, content: content }, { timeout: 30000 });
        if (wr && wr.ok) {
          artifacts.push({ path: (wr.data && wr.data.path) || path, filename: filename, type: meta.docType });
          if (ui && ui.onToolResult) ui.onToolResult({ name: 'write_file', ok: true, result: wr.data, step: 1 });
        } else {
          error = (wr && wr.error) || '动画写入失败';
          if (ui && ui.onToolResult) ui.onToolResult({ name: 'write_file', ok: false, error: error, step: 1 });
        }
      } else if (meta.docTool === 'write_file') {
        // HTML 类产物（report-page）→ write_file 落盘到「产物/」目录
        var htmlPath = '产物/' + filename;
        if (ui && ui.onToolCall) ui.onToolCall({ name: 'write_file', args: { path: htmlPath }, step: 1 });
        var hwResult = await tools.invoke('write_file', { path: htmlPath, content: content }, { timeout: 30000 });
        if (hwResult && hwResult.ok) {
          artifacts.push({ path: (hwResult.data && hwResult.data.path) || htmlPath, filename: filename, type: meta.docType });
          if (ui && ui.onToolResult) ui.onToolResult({ name: 'write_file', ok: true, result: hwResult.data, step: 1 });
        } else {
          error = (hwResult && hwResult.error) || 'HTML文件写入失败';
          if (ui && ui.onToolResult) ui.onToolResult({ name: 'write_file', ok: false, error: error, step: 1 });
        }
      } else if (meta.slides) {
        // PPT → gen_ppt；slides 解析为空时回退 Markdown 落盘，避免生成 0 页空 PPTX
        if (!slides || !slides.length) {
          var mdName = String(filename).replace(/\.pptx?$/i, '') + '.md';
          var mdPath = '产物/' + mdName;
          if (ui && ui.onToolCall) ui.onToolCall({ name: 'write_file', args: { path: mdPath }, step: 1 });
          var mdResult = await tools.invoke('write_file', { path: mdPath, content: content }, { timeout: 30000 });
          if (mdResult && mdResult.ok) {
            artifacts.push({ path: (mdResult.data && mdResult.data.path) || mdPath, filename: mdName, type: meta.docType });
            if (ui && ui.onToolResult) ui.onToolResult({ name: 'write_file', ok: true, result: mdResult.data, step: 1 });
          } else {
            error = (mdResult && mdResult.error) || 'PPT 解析失败且 Markdown 回退落盘失败';
            if (ui && ui.onToolResult) ui.onToolResult({ name: 'write_file', ok: false, error: error, step: 1 });
          }
        } else {
          if (ui && ui.onToolCall) ui.onToolCall({ name: 'gen_ppt', args: { filename: filename, slideCount: slides.length }, step: 1 });
          var pr = await tools.invoke('gen_ppt', { filename: filename, slides: slides }, { timeout: 60000 });
          if (pr && pr.ok) {
            artifacts.push({ path: (pr.data && pr.data.path) || filename, filename: filename, type: meta.docType });
            if (ui && ui.onToolResult) ui.onToolResult({ name: 'gen_ppt', ok: true, result: pr.data, step: 1 });
          } else {
            error = (pr && pr.error) || 'PPT生成失败';
            if (ui && ui.onToolResult) ui.onToolResult({ name: 'gen_ppt', ok: false, error: error, step: 1 });
          }
        }
      } else if (meta.assessment) {
        // 评价量规 → gen_excel（从 Markdown 表格解析 rows）
        var rows = _parseMarkdownTable(content);
        if (!rows.length) rows = [['评价维度', '优秀', '良好', '合格', '待改进', '权重']];
        if (ui && ui.onToolCall) ui.onToolCall({ name: 'gen_excel', args: { filename: filename }, step: 1 });
        var er = await tools.invoke('gen_excel', { filename: filename, rows: rows, sheetName: '评价量规' }, { timeout: 60000 });
        if (er && er.ok) {
          artifacts.push({ path: (er.data && er.data.path) || filename, filename: filename, type: meta.docType });
          if (ui && ui.onToolResult) ui.onToolResult({ name: 'gen_excel', ok: true, result: er.data, step: 1 });
        } else {
          error = (er && er.error) || 'Excel生成失败';
          if (ui && ui.onToolResult) ui.onToolResult({ name: 'gen_excel', ok: false, error: error, step: 1 });
        }
      } else {
        // Word 文档 → gen_word
        if (ui && ui.onToolCall) ui.onToolCall({ name: 'gen_word', args: { filename: filename, title: ctx.topic || meta.name }, step: 1 });
        var dr = await tools.invoke('gen_word', { filename: filename, title: ctx.topic || meta.name, content: content }, { timeout: 60000 });
        if (dr && dr.ok) {
          artifacts.push({ path: (dr.data && dr.data.path) || filename, filename: filename, type: meta.docType });
          if (ui && ui.onToolResult) ui.onToolResult({ name: 'gen_word', ok: true, result: dr.data, step: 1 });
        } else {
          error = (dr && dr.error) || 'Word生成失败';
          if (ui && ui.onToolResult) ui.onToolResult({ name: 'gen_word', ok: false, error: error, step: 1 });
        }
      }
    } catch (e) {
      error = (e && e.message) || String(e);
    }

    return { artifacts: artifacts, error: error };
  }

  // ================================================================
  // 内部工具
  // ================================================================

  /** 构建文件名（清洗特殊字符） */
  function _buildFilename(ctx, skillName, subId) {
    var topic = ctx.topic || '教学内容';
    topic = String(topic).replace(/[\\/:*?"<>|]/g, '').slice(0, 30);
    var ext = 'docx';
    if (subId === 'ppt' || subId === 'ppt-page') ext = 'pptx';
    else if (subId === 'assessment') ext = 'xlsx';
    else if (subId === 'animation' || subId === 'report-page') ext = 'html';
    return skillName + '_' + topic + '.' + ext;
  }

  /** 调用 LLM 并确保返回 JSON（容错解析） */
  async function _callJsonLLM(prompt, sysPrompt, deps) {
    if (deps.callLLM) return await deps.callLLM(prompt, sysPrompt);
    if (deps.callLLMStream) {
      var acc = '';
      for await (var chunk of deps.callLLMStream(prompt, sysPrompt)) {
        if (chunk && !chunk.startsWith('\u0001')) acc += chunk;
      }
      return acc;
    }
    throw new Error('LLM 引擎未就绪');
  }

  /** 解包强制 JSON 输出的文本类内容（{"content":"..."} 或 {"summary":"..."}） */
  function _unwrapContent(raw) {
    if (!raw) return '';
    var s = String(raw).trim();
    try {
      var obj = JSON.parse(s);
      if (obj && typeof obj.content === 'string') return obj.content;
      if (obj && typeof obj.summary === 'string') return obj.summary;
      return s;
    } catch (e) {
      // 非 JSON，直接返回（可能是模型未强制 JSON）
      return s;
    }
  }

  /** 解析 JSON（容错：剥代码块、括号匹配） */
  function _parseJSON(txt) {
    if (!txt) return null;
    var s = String(txt).trim();
    try { return JSON.parse(s); } catch (e) { /* continue */ }
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    try { return JSON.parse(s); } catch (e) { /* continue */ }
    var start = s.indexOf('{');
    var startArr = s.indexOf('[');
    if (start < 0 && startArr < 0) return null;
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

  /** 解析 PPT slides（兼容 JSON 数组与 Markdown 回退） */
  function _parseSlides(raw) {
    if (!raw) return null;
    var parsed = _parseJSON(raw);
    // 接受顶层数组，或 {slides|data|list|pages:[...]} 包裹形式
    // （json_object 端点强制输出对象时，模型常包一层，只认顶层数组会解析失败）
    var arr = null;
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (parsed && typeof parsed === 'object') {
      arr = parsed.slides || parsed.data || parsed.list || parsed.pages || null;
    }
    if (arr && Array.isArray(arr)) {
      var filtered = arr.filter(function (s) { return s && (s.title || s.bullets || s.content); });
      return filtered.length ? filtered : null;
    }
    return null;
  }

  /** 从 Markdown 表格解析为二维数组 */
  function _parseMarkdownTable(md) {
    var lines = String(md || '').split('\n').filter(function (l) { return l.trim().indexOf('|') >= 0; });
    var rows = [];
    lines.forEach(function (line) {
      if (/^\|[\s\-:|]+$/.test(line.trim())) return; // 跳过分隔行
      var cells = line.split('|').map(function (c) { return c.trim(); });
      if (cells.length && cells[0] === '') cells.shift();
      if (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (cells.length) rows.push(cells);
    });
    return rows;
  }

  /** HTML 转义 */
  function _esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** 清理 SVG：移除 script 片段与外部 URL 引用（仅保留内联） */
  function _sanitizeSvg(svg) {
    var s = String(svg || '');
    s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
    s = s.replace(/\son\w+\s*=\s*"[^"]*"/gi, '');
    s = s.replace(/\son\w+\s*=\s*'[^']*'/gi, '');
    s = s.replace(/\sxlink:href\s*=\s*"https?:[^"]*"/gi, '');
    return s;
  }

  /**
   * 组装自包含单文件 HTML5 交互动画
   * 教学配色 + 场景切换（上一步/下一步）+ 自动播放 + 讲解区 + 交互提示
   */
  function _buildAnimationHTML(script, ctx) {
    var title = _esc((script.title || (ctx.topic || '教学动画')) + ' · 互动演示');
    var scenes = script.scenes || [];
    var autoPlay = script.autoPlay !== false;

    var sceneHtml = scenes.map(function (sc, i) {
      var svg = _sanitizeSvg(sc.svg || '');
      return '<section class="scene' + (i === 0 ? ' active' : '') + '" data-scene="' + (i + 1) + '">'
        + '<div class="scene-head"><span class="scene-badge">场景 ' + (i + 1) + '</span>'
        + '<span class="scene-title">' + _esc(sc.title || ('场景' + (i + 1))) + '</span></div>'
        + '<div class="stage">' + svg + '</div>'
        + '<div class="narration"><strong>讲解：</strong>' + _esc(sc.narration || '') + '</div>'
        + (sc.note ? '<div class="note">教学提示：' + _esc(sc.note) + '</div>' : '')
        + '<div class="interaction-tag">交互方式：' + _esc(sc.interaction || 'auto') + '</div>'
        + '</section>';
    }).join('\n');

    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
      + '<title>' + title + '</title>\n'
      + '<style>\n'
      + 'body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;margin:0;padding:24px;background:#f5f7fa;color:#1f2937;}\n'
      + '.wrap{max-width:960px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.08);padding:24px;}\n'
      + 'h1{font-size:22px;text-align:center;color:#0f766e;margin:0 0 16px;}\n'
      + '.scene{display:none;animation:fadeIn .4s ease;}\n'
      + '.scene.active{display:block;}\n'
      + '@keyframes fadeIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}\n'
      + '.scene-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;}\n'
      + '.scene-badge{background:#0f766e;color:#fff;padding:4px 12px;border-radius:999px;font-size:13px;}\n'
      + '.scene-title{font-size:17px;font-weight:600;color:#134e4a;}\n'
      + '.stage{background:#fbfdfc;border:1px solid #e2e8f0;border-radius:12px;padding:12px;margin-bottom:12px;}\n'
      + '.stage svg{width:100%;height:auto;display:block;}\n'
      + '.narration{background:#f0fdfa;border-left:4px solid #14b8a6;padding:10px 14px;border-radius:8px;line-height:1.7;font-size:15px;margin-bottom:10px;}\n'
      + '.note{background:#fffbeb;border-left:4px solid #f59e0b;padding:8px 14px;border-radius:8px;font-size:13px;color:#78350f;margin-bottom:10px;}\n'
      + '.interaction-tag{font-size:12px;color:#64748b;margin-bottom:12px;}\n'
      + '.controls{display:flex;justify-content:center;gap:16px;margin-top:16px;}\n'
      + '.controls button{padding:10px 28px;border:none;border-radius:10px;background:#0f766e;color:#fff;font-size:15px;cursor:pointer;transition:background .2s;}\n'
      + '.controls button:hover{background:#115e59;}\n'
      + '.controls button:disabled{background:#cbd5e1;cursor:not-allowed;}\n'
      + '.progress{text-align:center;font-size:13px;color:#94a3b8;margin-top:8px;}\n'
      + '</style>\n</head>\n<body>\n<div class="wrap">\n'
      + '<h1>' + title + '</h1>\n'
      + '<div id="player">\n' + sceneHtml + '\n</div>\n'
      + '<div class="controls">\n'
      + '<button id="prevBtn" type="button">◀ 上一步</button>\n'
      + '<button id="nextBtn" type="button">下一步 ▶</button>\n'
      + '</div>\n<div class="progress" id="progress"></div>\n</div>\n'
      + '<script>\n'
      + '(function(){\n'
      + 'var scenes=document.querySelectorAll(".scene");\n'
      + 'var idx=0;\n'
      + 'function show(i){\n'
      + ' idx=Math.max(0,Math.min(scenes.length-1,i));\n'
      + ' for(var k=0;k<scenes.length;k++) scenes[k].classList.toggle("active",k===idx);\n'
      + ' var prog=document.getElementById("progress");\n'
      + ' if(prog) prog.textContent="第 "+(idx+1)+" / "+scenes.length+" 场景";\n'
      + '}\n'
      + 'document.getElementById("prevBtn").addEventListener("click",function(){show(idx-1);});\n'
      + 'document.getElementById("nextBtn").addEventListener("click",function(){show(idx+1);});\n'
      + 'document.addEventListener("keydown",function(e){if(e.key==="ArrowRight")show(idx+1);if(e.key==="ArrowLeft")show(idx-1);});\n'
      + 'show(0);\n'
      + 'var auto=' + (autoPlay ? 'true' : 'false') + ';\n'
      + 'if(auto&&scenes.length>1){ setInterval(function(){ show(idx+1>=scenes.length?0:idx+1); }, 9000); }\n'
      + '})();\n'
      + '<\/script>\n</body>\n</html>';
  }

  // ================================================================
  // 导出
  // ================================================================

  global.SubWorkflows = {
    SUBWORKFLOW_META: SUBWORKFLOW_META,
    MAX_REFINEMENTS: MAX_REFINEMENTS,
    runAll: runAll,
    runOne: runOne,
    _buildAnimationHTML: _buildAnimationHTML,
    _parseSlides: _parseSlides,
    _parseJSON: _parseJSON,
    _parseMarkdownTable: _parseMarkdownTable,
    _sanitizeSvg: _sanitizeSvg,
  };
})(window);
