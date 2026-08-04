/*!
 * teacher-agent-sandbox · Skills 技能引擎 (skills-engine.js)
 * ------------------------------------------------------------------
 * 从 skills/ 各子文件夹 / SKILL.md 动态加载技能定义，提供：
 *   - 技能清单与元信息（名称、描述、触发词、工具、参数）
 *   - 技能文件夹路径（references/ assets/ scripts/ 按需加载）
 *   - 意图匹配（关键词加权）路由到合适技能
 *   - 技能执行（组装技能提示 + 工具调用建议）
 *   - 技能市场 UI 联动
 *
 * 技能定义来源：skills/ <文件夹名> / SKILL.md（YAML frontmatter + Markdown 正文）
 * 离线兜底：内嵌技能定义，fetch 失败时使用
 */
(function (global) {
  'use strict';

  // ---- 文件夹名 → 规范技能 ID 映射 ----
  var FOLDER_TO_ID = {
    '教案编写': 'lesson-plan',
    '教学PPT制作': 'ppt-generator',
    '题目批改': 'grading',
    '学生学情分析': 'student-analysis',
    '讲解题skill': 'knowledge-qa',
    '重点及易错点分析': 'error-analysis',
    'data-analysis': 'data-analysis',
    'ppt-page': 'ppt-page',
    'report-page': 'report-page',
  };

  // ---- 内嵌技能定义（离线兜底，与 SKILL.md frontmatter 一致） ----
  var EMBEDDED_SKILLS = [
    {
      id: 'lesson-plan', folder: '教案编写', name: '教案编写', icon: 'fa-feather-pointed', color: 'jade', priority: 'high',
      triggers: ['教案', '备课', '写教案', '教学设计', '生成教案', '课程教学方案', 'lesson plan'],
      desc: '生成结构化、规范化的教案文档。当用户要求编写教案、备课、设计课程教学方案或提及"教案"时调用此技能。',
      params: [{ key: 'subject', required: true }, { key: 'grade', required: true }, { key: 'topic', required: true }, { key: 'duration' }, { key: 'remark' }],
      tools: ['web_search', 'sandbox.write_file', 'sandbox.gen_word'],
      template: '请基于本节课题，生成一份完整、可直接使用的教案（正文不少于 3000 字），须含：①课标依据与教材分析②学情分析（结合班级学情记录，指出学生已有基础与可能困难）③教学目标(核心素养四维度，用可观察可测量的行为动词)④教学重点、教学难点(各附突破策略)⑤教学过程(导入/新知探究/例题精讲/变式训练/课堂小结，每环节写清教师活动(含具体提问话术)、学生活动(含预设回答)、设计意图与时间分配)⑥例题与变式(完整题干+逐行规范解答，LaTeX公式)⑦分层作业(基础/提升/拓展三层，给出具体题目)⑧板书设计⑨教学反思预设。内容须具体可操作，禁止空泛表述。',
      references: ['references/教案编写规范.md', 'references/课标目标维度参考.md'],
      assets: ['assets/教案模板.html', 'assets/教案模板.md'],
      scripts: ['scripts/generate_lesson_plan.py'],
    },
    {
      id: 'ppt-generator', folder: '教学PPT制作', name: '教学PPT制作', icon: 'fa-display', color: 'blue', priority: 'high',
      triggers: ['课件', 'ppt', '幻灯片', '上课用', '做课件', '教学演示文稿', 'slides'],
      desc: '制作结构清晰、视觉美观的教学演示文稿。当用户要求制作教学课件、教学PPT、演示文稿或提及"课件"时调用此技能。',
      params: [{ key: 'source', required: true }, { key: 'slideCount' }, { key: 'theme' }],
      tools: ['sandbox.gen_ppt'],
      template: '请基于本课题直接调用 gen_ppt 生成 .pptx 课件（不要只输出大纲，必须生成文件）。要求：≥12 页幻灯片（封面/学习目标/目录/6-8页知识讲授/例题页含完整解答步骤/课堂练习页/小结页/作业页）；每页 title 明确、bullets 写具体知识内容（定义、性质、解题步骤的原话），禁止"讲解XX知识点"这类占位表述；例题页给出完整题目与分步解答；贴合高中学情，先搜集课标与高考考法再组织内容。',
      references: ['references/PPT设计规范.md', 'references/学科课件设计指南.md'],
      assets: ['assets/PPT页面模板.html', 'assets/配色方案参考.json'],
      scripts: ['scripts/generate_ppt_outline.py'],
    },
    {
      id: 'grading', folder: '题目批改', name: '题目批改', icon: 'fa-pen-to-square', color: 'rose', priority: 'high',
      triggers: ['批改', '批改作业', '批改试卷', '批改题目', '阅卷', ' grading'],
      desc: '批改学生作业与试卷，给出评分与详细反馈。当用户要求批改作业、批改试卷、批改题目或提及"批改"时调用此技能。',
      params: [{ key: 'subject', required: true }, { key: 'grade' }, { key: 'taskType' }, { key: 'detailLevel' }],
      tools: ['sandbox.gen_word', 'sandbox.gen_pdf'],
      template: '请按题目批改技能规范执行批改：①确认学科年级、题目类型与数量、总分与分值分配②明确评分标准（客观题比对答案，主观题按得分点，作文分维度）③逐题批改，标注对错与得分④汇总评分，计算得分率⑤生成反馈（总体评价+主要问题+改进建议+鼓励评语）。错误标注分类：【知识错误】【方法错误】【计算错误】【格式错误】【审题错误】。',
      references: ['references/批改规范与评分标准.md', 'references/评语模板库.md'],
      assets: ['assets/批改报告模板.html', 'assets/批改报告模板.md'],
      scripts: ['scripts/grade_homework.py'],
    },
    {
      id: 'student-analysis', folder: '学生学情分析', name: '学生学情分析', icon: 'fa-chart-line', color: 'teal', priority: 'high',
      triggers: ['学情', '学情分析', '诊断学习', '学生分析报告', '成绩分析', '学情诊断'],
      desc: '分析学生学习情况，生成学情诊断报告与教学建议。当用户要求分析学情、诊断学习状况、生成学生分析报告或提及"学情"时调用此技能。',
      params: [{ key: 'target', required: true }, { key: 'dataSource' }, { key: 'subjectScope' }, { key: 'depth' }, { key: 'outputFormat' }],
      tools: ['web_search', 'sandbox.gen_word', 'sandbox.gen_pdf'],
      template: '请按学情分析标准流程执行：①确认分析对象（个体/班级/年级）与数据来源②数据采集与整理③多维度分析（成绩维度/知识维度/能力维度/题型维度/趋势维度/个体维度）④生成诊断报告（基本信息→成绩概览→知识掌握→能力水平→题型分析→薄弱点诊断→分层学生分析→教学建议）⑤输出针对性、可操作、分层性、发展性的教学建议。',
      references: ['references/学情分析维度详解.md', 'references/教学建议生成指南.md'],
      assets: ['assets/学情分析报告模板.html', 'assets/学情分析报告模板.md'],
      scripts: ['scripts/analyze_student.py'],
    },
    {
      id: 'knowledge-qa', folder: '讲解题skill', name: '高中全科知识解答', icon: 'fa-graduation-cap', color: 'indigo', priority: 'high',
      triggers: ['高中', '知识点', '讲解', '解题', '高考', '题目', '怎么解', '帮我理解', '为什么', '这道题', '这个概念', '公式', '文言文', '古诗', '作文', '函数', '三角', '数列', '立体几何', '解析几何', '阅读理解', '完形填空', '语法填空', '牛顿定律', '电磁感应', '化学方程式', '氧化还原', '细胞', '遗传', '光合作用', '生态'],
      desc: '高中全科知识解答与高考题型辅导。覆盖语数英物化生全科，紧扣教材不超纲，熟悉高考各类题型。',
      params: [{ key: 'subject', required: true }, { key: 'topic' }, { key: 'questionType' }],
      tools: ['web_search'],
      template: '请按知识解答流程执行：①判断科目与知识点②组织解答（概念讲解用教材定义+通俗解释，解题过程分步推导标注得分点，易错提醒常见误区和高考陷阱，拓展关联相关知识点）③巩固建议推荐同类题型练习。原则：紧扣教材不超纲、融会贯通关联跨学科、高考导向优先标准解法、因材施教调整深度。',
      references: ['references/subject-chinese.md', 'references/subject-math.md', 'references/subject-english.md', 'references/subject-physics.md', 'references/subject-chemistry.md', 'references/subject-biology.md', 'references/exam-techniques.md', 'references/answering-templates.md', 'references/textbook-index.md', 'references/style-guide.md'],
      assets: [],
      scripts: ['references/validator.py'],
      config: { max_tokens: 4096, temperature: 0.3, stream: true, default_publisher: '人教版', subjects: ['语文', '数学', '英语', '物理', '化学', '生物'], grade_level: '高中', exam_focus: '高考' },
    },
    {
      id: 'error-analysis', folder: '重点及易错点分析', name: '重点及易错点分析', icon: 'fa-triangle-exclamation', color: 'amber', priority: 'mid',
      triggers: ['易错', '重点', '难点', '考点分析', '易错点', '错题归因', '知识盘点', '错因分析'],
      desc: '分析学科知识的重点与易错点，生成结构化的分析报告。当用户要求分析重点难点、梳理易错知识点、进行考点分析或提及"易错"时调用此技能。',
      params: [{ key: 'subject', required: true }, { key: 'grade' }, { key: 'scope', required: true }, { key: 'purpose' }, { key: 'outputFormat' }],
      tools: ['web_search', 'sandbox.gen_word'],
      template: '请按重点及易错点分析流程执行：①确认学科年级、知识范围、分析目的②重点知识提炼（核心概念→重要技能→关键关系→思想方法）③易错点分析（每条含错误表现→错因分析→正确理解→典型错例→纠错策略→变式训练）④错因分类归总（概念混淆型/审题不清型/计算失误型/思维定式型/知识遗忘型/表达不规范型）⑤教学建议（优先级排序+教学策略+复习策略）。',
      references: ['references/各学科易错点汇总.md', 'references/错因分类体系.md'],
      assets: ['assets/分析报告模板.md', 'assets/易错点清单模板.html'],
      scripts: ['scripts/analyze_errors.py'],
    },
    {
      id: 'data-analysis', folder: 'data-analysis', name: '数据分析', icon: 'fa-table', color: 'slate', priority: 'mid',
      triggers: ['数据分析', 'excel分析', 'csv', '数据统计', '透视表', '数据探索', 'data analysis'],
      desc: '使用 DuckDB 对上传的 Excel/CSV 文件进行数据分析，支持 SQL 查询、统计摘要、结果导出。',
      params: [{ key: 'files', required: true }, { key: 'action', required: true }, { key: 'sql' }, { key: 'outputFile' }],
      tools: ['sandbox.run_script'],
      template: '请按数据分析流程执行：①检查文件结构（sheets、列名、类型、行数）②根据用户需求构造 SQL 查询③执行查询或生成统计摘要④解释结果并给出关键洞察⑤按需导出为 CSV/JSON/Markdown。',
      references: [],
      assets: [],
      scripts: ['scripts/analyze.py'],
    },
    {
      id: 'ppt-page', folder: 'ppt-page', name: 'PPT 页面生成', icon: 'fa-images', color: 'violet', priority: 'mid',
      triggers: ['html ppt', '网页ppt', 'slide cards', 'waterfall deck', '单文件html演示', 'ppt page'],
      desc: '创建单文件 HTML 演示文稿，呈垂直单列卡片流布局，支持字幕、全局间隙切换、全屏演示快捷键。',
      params: [{ key: 'title', required: true }, { key: 'style' }, { key: 'cardCount' }, { key: 'captionMode' }],
      tools: ['sandbox.write_file'],
      template: '请按 PPT Page 流程执行：①确认受众、语言、素材、卡片数、字幕模式②创建文件夹并复制 template.html③选择一种视觉风格预设④制定 Slide Plan（每卡片一行：Slide|Job|Content|Layout|Visual|Caption）⑤编写每张卡片的 HTML（article.deck-card > section.slide-frame + details.caption）⑥运行 validate-waterfall-deck.mjs 验证⑦输出 HTML 文件路径。',
      references: ['references/style-presets.md', 'references/design-system.md', 'references/layout-patterns.md', 'references/content-patterns.md', 'references/data-analysis-charts.md', 'references/illustration-system.md'],
      assets: ['assets/template.html', 'assets/style-gallery.html'],
      scripts: ['scripts/validate-waterfall-deck.mjs', 'scripts/export-waterfall-to-pptx.mjs', 'scripts/export-waterfall-to-pdf.mjs'],
    },
    {
      id: 'report-page', folder: 'report-page', name: '报告页面生成', icon: 'fa-file-lines', color: 'cyan', priority: 'mid',
      triggers: ['报告', '研究报告', '文档页面', 'memo', 'research note', 'report page', 'html报告'],
      desc: '创建源支持的的报告、文档、备忘录、研究笔记或数据解读页面，输出为可编辑的静态 HTML，支持 ECharts 图表。',
      params: [{ key: 'genre', required: true }, { key: 'title' }, { key: 'depth' }, { key: 'charts' }],
      tools: ['sandbox.write_file'],
      template: '请按 Report Page 流程执行：①推断读者、页面目的、深度、语气和内容类型②阅读 output-layout.md 创建文件夹③阅读 story-planning.md 起草页面骨架④检查输入数据和来源⑤阅读 page-structure.md 规划文档块⑥手写 index.html（首行必须是 <!-- Generated by Trae Work -->）⑦复制 doc.css/doc.js/echarts.min.js/mermaid.min.js⑧运行静态检查。',
      references: ['references/output-layout.md', 'references/story-planning.md', 'references/page-structure.md', 'references/media-and-diagrams.md', 'references/data-and-charts.md', 'references/chart-selection.md', 'references/visual-interactions.md'],
      assets: ['assets/doc.css', 'assets/doc.js', 'assets/echarts.min.js', 'assets/mermaid.min.js'],
      scripts: [],
    },
  ];

  // ---- YAML frontmatter 解析器（轻量级，仅解析 name + description） ----
  function parseFrontmatter(text) {
    if (!text) return null;
    var match = text.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    var yaml = match[1];
    var result = {};
    yaml.split('\n').forEach(function (line) {
      var m = line.match(/^(\w+):\s*"?(.*?)"?\s*$/);
      if (m) result[m[1]] = m[2];
    });
    return result;
  }

  // ---- 提取 SKILL.md 正文中的关键信息（触发词、使用说明等） ----
  function extractSkillMeta(text) {
    if (!text) return {};
    var meta = {};
    // 移除 frontmatter
    var body = text.replace(/^---\n[\s\S]*?\n---/, '').trim();
    meta.body = body;
    meta.bodyPreview = body.slice(0, 200);
    return meta;
  }

  var SkillsEngine = {
    skills: [],
    loaded: false,
    _skillBasePath: '',

    /** 初始化：从 skills/ 目录动态加载 SKILL.md，失败时用内嵌定义兜底 */
    async init() {
      this._skillBasePath = this._detectSkillBasePath();
      this.skills = EMBEDDED_SKILLS.map(function (s) {
        return Object.assign({}, s, { dynamic: false });
      });

      // 尝试从外部 SKILL.md 加载覆盖
      await this._loadFromFolders();
      // 合并用户自定义技能
      this._loadCustomSkills();
      this.loaded = true;
      this._enrichMarketplace();
      return this.skills;
    },

    /** 检测 skills 文件夹的基础路径 */
    _detectSkillBasePath() {
      // http 模式：相对于页面 URL
      if (typeof location !== 'undefined' && location.protocol === 'http:') {
        var base = location.pathname.replace(/\/[^/]*$/, '/');
        return base + 'teacher-agent-sandbox/skills/';
      }
      // file 模式或 Electron：使用相对路径
      return './teacher-agent-sandbox/skills/';
    },

    /** 从 skills/<文件夹>/SKILL.md 动态加载，覆盖内嵌定义 */
    async _loadFromFolders() {
      var folders = Object.keys(FOLDER_TO_ID);
      var loadTasks = folders.map(function (folder) {
        return this._loadOneSkill(folder).catch(function (e) {
          console.warn('[skills-engine] 加载 ' + folder + '/SKILL.md 失败，使用内嵌定义:', e.message);
          return null;
        });
      }.bind(this));
      await Promise.all(loadTasks);
    },

    /** 读取技能资源文件：Electron 走 IPC（www 目录，离线可靠），浏览器回退 fetch 相对路径 */
    async _readFile(relPath) {
      try {
        if (window.electronAPI && window.electronAPI.readResource) {
          var r = await window.electronAPI.readResource(relPath);
          if (r && r.ok && r.data && r.data.content) return r.data.content;
        }
      } catch (e) { /* 回退 fetch */ }
      try {
        var resp = await fetch(relPath);
        return resp.ok ? await resp.text() : '';
      } catch (e) { return ''; }
    },

    /** 加载单个技能的 SKILL.md 并覆盖内嵌定义 */
    async _loadOneSkill(folder) {
      var skillId = FOLDER_TO_ID[folder];
      if (!skillId) return null;
      var relPath = this._skillBasePath + folder + '/SKILL.md';
      var text = await this._readFile(relPath);
      if (!text) throw new Error('SKILL.md 读取失败: ' + folder);

      // 解析 frontmatter
      var fm = parseFrontmatter(text);
      if (!fm) throw new Error('SKILL.md 缺少 frontmatter');

      // 提取正文元信息
      var meta = extractSkillMeta(text);

      // 找到内嵌定义并覆盖
      var embedded = this.skills.find(function (s) { return s.id === skillId; });
      if (embedded) {
        if (fm.name) embedded.name = fm.name;
        if (fm.description) embedded.desc = fm.description;
        embedded.body = meta.body || '';
        embedded.bodyPreview = meta.bodyPreview || '';
        embedded.folder = folder;
        embedded.folderPath = this._skillBasePath + folder + '/';
        embedded.dynamic = true;
      }
      return skillId;
    },

    /** 从 localStorage 合并用户导入的自定义技能（去重：同 id 跳过） */
    _loadCustomSkills() {
      try {
        var raw = localStorage.getItem('teacher_agent_custom_skills');
        if (!raw) return;
        var list = JSON.parse(raw);
        if (!Array.isArray(list)) return;
        var self = this;
        list.forEach(function (s) {
          if (s && s.id && !self.get(s.id)) self.skills.push(s);
        });
      } catch (e) { /* 自定义技能损坏时忽略 */ }
    },

    /**
     * 添加一个自定义技能
     * @returns {{ok:boolean, error?:string, skill?:object}}
     */
    addCustomSkill(def) {
      if (!def || typeof def !== 'object') return { ok: false, error: '技能定义无效（应为 JSON 对象）' };
      var name = String(def.name || '').trim();
      if (!name) return { ok: false, error: '技能缺少 name 字段' };
      var template = String(def.template || def.desc || '').trim();
      if (!template) return { ok: false, error: '技能缺少 template / desc 字段' };
      var baseId = String(def.id || name).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'custom-skill';
      var id = baseId, n = 2;
      while (this.get(id)) { id = baseId + '-' + n; n++; }
      var skill = {
        id: id,
        name: name,
        icon: def.icon || 'fa-puzzle-piece',
        color: def.color || 'jade',
        priority: def.priority || 'mid',
        triggers: Array.isArray(def.triggers) && def.triggers.length ? def.triggers.map(String) : [name],
        desc: String(def.desc || template).slice(0, 120),
        params: Array.isArray(def.params) ? def.params : [],
        tools: Array.isArray(def.tools) ? def.tools : [],
        template: template,
        references: [],
        assets: [],
        scripts: [],
        custom: true,
      };
      this.skills.push(skill);
      try {
        var raw = localStorage.getItem('teacher_agent_custom_skills');
        var list = raw ? JSON.parse(raw) : [];
        var customs = (Array.isArray(list) ? list : []).filter(function (s) { return s && s.id !== skill.id; });
        customs.push(skill);
        localStorage.setItem('teacher_agent_custom_skills', JSON.stringify(customs));
      } catch (e) { return { ok: false, error: '技能已加载但持久化失败：' + (e.message || e) }; }
      this._enrichMarketplace();
      return { ok: true, skill: skill };
    },

    list() { return this.skills; },

    get(id) { return this.skills.find(function (s) { return s.id === id; }); },

    /** 根据文件夹名获取技能 */
    getByFolder(folder) { return this.skills.find(function (s) { return s.folder === folder; }); },

    /** 获取技能的参考文档路径列表（完整 URL） */
    getReferencePaths(skillId) {
      var s = this.get(skillId);
      if (!s || !s.references || !s.references.length) return [];
      var base = s.folderPath || '';
      return s.references.map(function (r) { return base + r; });
    },

    /** 获取技能的脚本路径列表（完整 URL） */
    getScriptPaths(skillId) {
      var s = this.get(skillId);
      if (!s || !s.scripts || !s.scripts.length) return [];
      var base = s.folderPath || '';
      return s.scripts.map(function (r) { return base + r; });
    },

    /** 获取技能的模板资源路径列表（完整 URL） */
    getAssetPaths(skillId) {
      var s = this.get(skillId);
      if (!s || !s.assets || !s.assets.length) return [];
      var base = s.folderPath || '';
      return s.assets.map(function (r) { return base + r; });
    },

    /** 异步加载技能的 SKILL.md 全文（供深度上下文注入） */
    async loadSkillBody(skillId) {
      var s = this.get(skillId);
      if (!s) return null;
      if (s.body) return s.body;
      if (!s.folderPath) return null;
      try {
        var text = await this._readFile(s.folderPath + 'SKILL.md');
        if (!text) return null;
        var meta = extractSkillMeta(text);
        s.body = meta.body || '';
        s.bodyPreview = meta.bodyPreview || '';
        return s.body;
      } catch (e) { return null; }
    },

    /** 异步加载技能的参考文档（按需加载，返回拼接文本） */
    async loadReferences(skillId, maxRefs) {
      var s = this.get(skillId);
      if (!s || !s.references || !s.references.length) return '';
      maxRefs = maxRefs || 3;
      var paths = this.getReferencePaths(skillId).slice(0, maxRefs);
      var results = await Promise.all(paths.map(function (p) {
        return this._readFile(p).catch(function () { return ''; });
      }.bind(this)));
      return results.filter(Boolean).join('\n\n---\n\n');
    },

    /** 意图匹配：返回最匹配的技能（按命中关键词加权） */
    match(query) {
      if (!query) return null;
      var q = String(query).toLowerCase();
      var best = null, bestScore = 0;
      this.skills.forEach(function (s) {
        var score = 0;
        (s.triggers || []).forEach(function (t) {
          if (q.indexOf(t.toLowerCase()) >= 0) score += t.length;
        });
        if (score > bestScore) { bestScore = score; best = s; }
      });
      return bestScore > 0 ? best : null;
    },

    /** 构造技能执行上下文：组装系统提示 + 参数提取建议 */
    buildSkillPrompt(skillId, userInput, ctx) {
      var s = this.get(skillId);
      if (!s) return null;
      ctx = ctx || {};
      var params = (s.params || []).map(function (p) { return p.key + (p.required ? '(必填)' : ''); }).join('、');
      var lines = [
        '【当前技能】' + s.name + '（' + s.id + '）',
        '【技能描述】' + s.desc,
        '【可用参数】' + params,
        '【建议工具】' + ((s.tools && s.tools.length) ? s.tools.join('、') : '无特定工具，按需使用'),
        '【技能模板】' + s.template,
      ];
      // 注入技能正文摘要（如果有）
      if (s.bodyPreview) lines.push('【技能规范摘要】' + s.bodyPreview);
      // 注入参考文档路径
      if (s.references && s.references.length) {
        lines.push('【参考文档】' + s.references.join('、'));
      }
      lines.push('');
      lines.push('请根据用户请求执行该技能。若需生成文档，请在内容就绪后调用对应文档生成工具(gen_word/gen_ppt/gen_excel)，并告知文件名。');
      if (ctx.subject) lines.push('已知学科：' + ctx.subject);
      if (ctx.grade) lines.push('已知年级：' + ctx.grade);
      lines.push('注：记忆已通过系统提示自动注入，无需手动调用记忆工具。');
      return lines.filter(Boolean).join('\n');
    },

    /** 将技能转为快捷指令文本（供现有 applyBeikeSkill 使用） */
    skillQuickText(skillId) {
      var s = this.get(skillId);
      return s ? s.template : '';
    },

    /** 联动技能市场 */
    _enrichMarketplace() {
      var marketData = this.skills.map(function (s) {
        return { id: s.id, name: s.name, desc: s.desc, icon: s.icon, color: s.color };
      });
      this._marketData = marketData;
      global.AgentSkillsMarket = marketData;
    },

    marketData() { return this._marketData || this.skills; },

    /** 导出技能清单供系统提示注入 */
    describeForPrompt() {
      var out = '# 可用技能(Skills)\n执行结构化任务时优先选用：\n';
      this.skills.forEach(function (s) {
        out += '- ' + s.id + '：' + s.name + '。' + s.desc + '\n  触发词：' + (s.triggers || []).join('、') + '\n';
      });
      return out;
    },
  };

  // 注册技能调用工具
  if (global.AgentTools) {
    global.AgentTools.register('use_skill', {
      category: 'skill',
      description: '调用指定技能并返回其执行提示与建议工具',
      parameters: { type: 'object', properties: { skillId: { type: 'string' }, userInput: { type: 'string' } }, required: ['skillId'] },
      handler: async function (a) {
        var s = SkillsEngine.get(a.skillId);
        if (!s) return { ok: false, error: '未知技能: ' + a.skillId };
        var prompt = SkillsEngine.buildSkillPrompt(a.skillId, a.userInput, {});
        return { ok: true, data: { skill: s, prompt: prompt } };
      },
    });
  }

  global.AgentSkills = SkillsEngine;
})(window);
