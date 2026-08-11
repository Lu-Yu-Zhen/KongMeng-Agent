/*!
 * teacher-agent-sandbox · 质量验证器 (quality-validator.js)
 * ------------------------------------------------------------------
 * 对智能体生成的备课产物进行结构化质量检查，解决"生成产物过于简单"问题。
 * 检查维度：
 *   1) 字数门槛（教案≥3000字 / 学案≥2000字 / 课件≥12页 / 试卷≥完整结构）
 *   2) 必备章节完整性（教学目标 / 教学过程 / 重难点 / 板书设计 等）
 *   3) 占位符检测（"略"、"此处讲解"、"举例说明" 等空泛表述）
 *   4) 内容深度评分（教师活动话术 / 学生活动预设 / 设计意图 / 时间分配）
 *   5) 公式与例题规范性（LaTeX 公式 / 完整题干 / 逐行解答）
 * 返回结构化验证结果，供 LangGraph 工作流的 validate 节点与 refine 节点使用。
 */
(function (global) {
  'use strict';

  // ---- 各产物类型的质量标准定义 ----
  var STANDARDS = {
    'lesson-plan': {
      name: '教案',
      minChars: 3000,
      requiredSections: [
        { key: '课标', patterns: ['课标', '课程标准', '核心素养', '教材分析'], weight: 10, label: '课标依据与教材分析' },
        { key: '学情', patterns: ['学情分析', '学情', '已有基础', '可能困难'], weight: 10, label: '学情分析' },
        { key: '目标', patterns: ['教学目标', '学习目标', '素养目标'], weight: 10, label: '教学目标' },
        { key: '重难点', patterns: ['教学重点', '教学难点', '重难点', '重点', '难点'], weight: 10, label: '教学重难点' },
        { key: '过程', patterns: ['教学过程', '教学环节', '导入', '新知探究', '新授'], weight: 15, label: '教学过程' },
        { key: '教师活动', patterns: ['教师活动', '教师提问', '提问话术', '师：'], weight: 10, label: '教师活动（含提问话术）' },
        { key: '学生活动', patterns: ['学生活动', '预设回答', '生：'], weight: 10, label: '学生活动（含预设回答）' },
        { key: '设计意图', patterns: ['设计意图', '设计理念', '设计目的'], weight: 5, label: '设计意图' },
        { key: '时间', patterns: ['时间分配', '分钟', '时间安排'], weight: 5, label: '时间分配' },
        { key: '例题', patterns: ['例题', '变式', '典例'], weight: 5, label: '例题与变式' },
        { key: '作业', patterns: ['作业', '分层作业', '课后作业', '基础题', '提升题', '拓展题'], weight: 5, label: '分层作业' },
        { key: '板书', patterns: ['板书', '板书设计'], weight: 3, label: '板书设计' },
        { key: '反思', patterns: ['教学反思', '反思预设', '反思'], weight: 2, label: '教学反思预设' },
      ],
      placeholderPatterns: ['此处讲解', '略', '以此类推', '...（省略）', '（待补充）', 'TODO', '占位'],
      depthChecks: [
        { name: '教学环节数量', test: function (t) { return (t.match(/环节[一二三四五六七八\d]|第[一二三四五六七八\d]+[环步]/g) || []).length; }, min: 5, label: '教学过程至少5个环节' },
        { name: '提问话术数量', test: function (t) { return (t.match(/师：|教师[：:]/g) || []).length; }, min: 3, label: '至少3处教师提问话术' },
        { name: '学生预设回答', test: function (t) { return (t.match(/生：|预设[：:]/g) || []).length; }, min: 2, label: '至少2处学生预设回答' },
      ],
    },
    'ppt-generator': {
      name: 'PPT课件',
      minChars: 0, // 按页数检查
      minSlides: 12,
      requiredSections: [
        { key: '封面', patterns: ['封面', '课题', '学科'], weight: 5, label: '封面页' },
        { key: '目标', patterns: ['学习目标', '教学目标', '目标'], weight: 10, label: '学习目标页' },
        { key: '目录', patterns: ['目录', 'contents', '概览'], weight: 5, label: '目录页' },
        { key: '知识讲授', patterns: ['定义', '概念', '性质', '定理', '公式', '原理', '规律'], weight: 15, label: '知识讲授页（6-8页）' },
        { key: '例题', patterns: ['例题', '例', '解析', '解答', '解'], weight: 10, label: '例题页（含完整解答）' },
        { key: '练习', patterns: ['练习', '课堂练习', '随堂', '检测'], weight: 10, label: '课堂练习页' },
        { key: '小结', patterns: ['小结', '总结', '归纳'], weight: 5, label: '小结页' },
        { key: '作业', patterns: ['作业', '课后', '巩固'], weight: 5, label: '作业页' },
      ],
      placeholderPatterns: ['讲解XX', '介绍XX', '此处展示', '详见', '略', '待补充', '占位文字'],
      depthChecks: [],
    },
    'worksheet': {
      name: '学案',
      minChars: 2000,
      requiredSections: [
        { key: '目标', patterns: ['学习目标', '学习目的'], weight: 15, label: '学习目标' },
        { key: '预习', patterns: ['课前预习', '预习', '课前准备'], weight: 20, label: '课前预习（含填空/思考题）' },
        { key: '探究', patterns: ['课堂探究', '探究问题', '问题链', '探究'], weight: 20, label: '课堂探究问题链' },
        { key: '检测', patterns: ['当堂检测', '课堂检测', '检测', '随堂'], weight: 20, label: '当堂检测' },
        { key: '巩固', patterns: ['课后巩固', '巩固', '课后作业', '分层'], weight: 15, label: '课后巩固（分层）' },
        { key: '答案', patterns: ['答案', '解析', '参考答案'], weight: 10, label: '参考答案与解析' },
      ],
      placeholderPatterns: ['略', '此处省略', '待补充', '以此类推'],
      depthChecks: [
        { name: '探究问题数量', test: function (t) { return (t.match(/问题[一二三四五六\d]|探究[一二三四五六\d]|第[一二三四五六\d]+问/g) || []).length; }, min: 3, label: '至少3个递进探究问题' },
        { name: '检测题数量', test: function (t) { return (t.match(/题|^\d+[\.．、]/gm) || []).length; }, min: 5, label: '至少5道当堂检测题' },
      ],
    },
    'exam-generator': {
      name: '试卷',
      minChars: 1500,
      requiredSections: [
        { key: '选择题', patterns: ['选择题', '单选', '多项选择'], weight: 15, label: '选择题' },
        { key: '填空题', patterns: ['填空题', '填空'], weight: 10, label: '填空题' },
        { key: '解答题', patterns: ['解答题', '计算题', '证明题', '综合题'], weight: 15, label: '解答题' },
        { key: '分值', patterns: ['分值', '满分', '总分', '得分', '每题'], weight: 10, label: '分值标注' },
        { key: '答案', patterns: ['答案', '解析', '参考答案'], weight: 15, label: '答案与解析' },
        { key: '易错点', patterns: ['易错', '注意', '误区', '陷阱'], weight: 10, label: '易错点提示' },
      ],
      placeholderPatterns: ['略', '以此类推', '待补充', '（答案略）'],
      depthChecks: [
        { name: '题目总数', test: function (t) { return (t.match(/^\d+[\.．、]/gm) || []).length; }, min: 10, label: '至少10道题目' },
        { name: '解析数量', test: function (t) { return (t.match(/解析[：:]|【解析】|分析[：:]/g) || []).length; }, min: 5, label: '至少5道题有详细解析' },
      ],
    },
    'assessment': {
      name: '评价量规',
      minChars: 500,
      requiredSections: [
        { key: '维度', patterns: ['维度', '评价维度', '评价指标'], weight: 20, label: '评价维度' },
        { key: '等级', patterns: ['优秀', '良好', '合格', '待改进'], weight: 20, label: '四等级描述' },
        { key: '权重', patterns: ['权重', '分值', '占比'], weight: 15, label: '权重分配' },
        { key: '行为描述', patterns: ['能够', '可以', '表现出', '行为'], weight: 15, label: '具体行为描述' },
      ],
      placeholderPatterns: ['略', '待补充', '同上', '参照'],
      depthChecks: [
        { name: '维度数量', test: function (t) { return (t.match(/维度[一二三四五六\d]|评价指标[一二三四五六\d]/g) || []).length; }, min: 4, label: '至少4个评价维度' },
      ],
    },
    'unit-design': {
      name: '大单元设计',
      minChars: 2500,
      requiredSections: [
        { key: '大概念', patterns: ['大概念', '核心概念', '基本问题', '本质问题'], weight: 15, label: '大概念与基本问题' },
        { key: '目标', patterns: ['单元目标', '学习目标', '单元学习目标'], weight: 15, label: '单元学习目标' },
        { key: '评估', patterns: ['评估任务', '表现性任务', '核心评估'], weight: 15, label: '核心评估任务' },
        { key: '活动', patterns: ['学习活动', '活动序列', 'WHERETO', '活动设计'], weight: 15, label: '学习活动序列' },
        { key: '课时', patterns: ['课时安排', '课时分配', '课时', '第\d+课时'], weight: 10, label: '课时安排表' },
        { key: '反思', patterns: ['反思', '单元反思', '评价反思'], weight: 5, label: '单元反思' },
      ],
      placeholderPatterns: ['略', '待补充', '同上', '参照', '以此类推'],
      depthChecks: [],
    },
    'differentiation': {
      name: '分层教学',
      minChars: 2000,
      requiredSections: [
        { key: '学情画像', patterns: ['学情画像', '班级学情', '学生层次', '学情分析'], weight: 15, label: '班级学情画像' },
        { key: 'A层', patterns: ['A层', '基础层', '基础巩固', '基础'], weight: 15, label: 'A层（基础巩固）' },
        { key: 'B层', patterns: ['B层', '中层', '能力提升', '提升'], weight: 15, label: 'B层（能力提升）' },
        { key: 'C层', patterns: ['C层', '拓展层', '挑战拓展', '拓展'], weight: 15, label: 'C层（挑战拓展）' },
        { key: '活动', patterns: ['课堂活动', '并行活动', '活动安排'], weight: 10, label: '课堂并行活动' },
        { key: '评价', patterns: ['评价', '辅导策略', '评价策略'], weight: 10, label: '辅导与评价策略' },
      ],
      placeholderPatterns: ['略', '待补充', '同上', '参照'],
      depthChecks: [],
    },
    'explainer': {
      name: '任务拆解精讲',
      minChars: 1500,
      requiredSections: [
        { key: '任务目标', patterns: ['任务目标', '学习任务目标', '任务目的', '目标'], weight: 15, label: '学习任务目标' },
        { key: '前置知识', patterns: ['前置知识', '已有知识', '知识诊断', '前置诊断'], weight: 15, label: '前置知识诊断' },
        { key: '任务拆解', patterns: ['任务链', '任务拆解', '任务1', '任务一', '任务[一二三]', '拆解'], weight: 20, label: '任务链拆解（≥3个递进任务）' },
        { key: '精讲', patterns: ['精讲', '重难点', '讲解', '逐字稿', '推导'], weight: 20, label: '重难点精讲' },
        { key: '易错点', patterns: ['易错', '误区', '注意'], weight: 10, label: '易错点警示' },
        { key: '检测', patterns: ['检测', '反馈', '练习'], weight: 10, label: '检测与反馈' },
      ],
      placeholderPatterns: ['略', '待补充', '同上', '以此类推'],
      depthChecks: [
        { name: '任务数量', test: function (t) { return (t.match(/任务[一二三四五六七八\d]/g) || []).length; }, min: 3, label: '至少3个递进任务' },
      ],
    },
    'animation': {
      name: '交互动画',
      minChars: 800,
      requireLatex: false, // 动画为可视化 HTML，公式用 Unicode 文本即可
      requiredSections: [
        { key: 'SVG画面', patterns: ['<svg', '<canvas'], weight: 25, label: 'SVG/Canvas 画面' },
        { key: '交互脚本', patterns: ['<script', 'onclick', 'addEventListener', 'function'], weight: 20, label: '交互脚本' },
        { key: '场景标记', patterns: ['scene', '场景', 'data-scene'], weight: 15, label: '场景标记' },
        { key: '讲解文本', patterns: ['narration', '讲解', '说明'], weight: 15, label: '讲解文本' },
      ],
      placeholderPatterns: ['此处放图', '占位图', '略', '待补充'],
      depthChecks: [
        { name: '场景数量', test: function (t) { return (t.match(/"title"\s*:\s*"场景|data-scene|id="scene/gi) || []).length; }, min: 3, label: '至少3个场景' },
      ],
    },
    'student-analysis': {
      name: '学情分析报告',
      minChars: 800,
      requireLatex: false, // 学情报告为文本分析型文档，不强制公式
      requiredSections: [
        { key: '掌握情况', patterns: ['掌握情况', '整体掌握', '整体情况'], weight: 20, label: '班级整体掌握情况' },
        { key: '易错点', patterns: ['易错', '高频', '薄弱'], weight: 20, label: '高频易错点预判' },
        { key: '分层策略', patterns: ['分层', '基础层', '提升层', '拓展层'], weight: 25, label: '分层教学策略' },
        { key: '辅导', patterns: ['学困生', '辅导', '帮扶'], weight: 15, label: '学困生辅导方案' },
        { key: '拓展', patterns: ['优生', '拓展', '拔高'], weight: 10, label: '优生拓展方向' },
        { key: '建议', patterns: ['建议', '调整'], weight: 10, label: '教学建议' },
      ],
      placeholderPatterns: ['略', '待补充', '同上'],
      depthChecks: [],
    },
    'grading': {
      name: '批改报告',
      minChars: 1500,
      requireLatex: false,
      requiredSections: [
        { key: '批改信息', patterns: ['批改信息', '学科', '年级', '题目类型', '总分'], weight: 10, label: '批改信息' },
        { key: '评分标准', patterns: ['评分标准', '评分细则', '得分点'], weight: 15, label: '评分标准' },
        { key: '逐题批改', patterns: ['题号', '满分', '得分', '批改'], weight: 20, label: '逐题批改详情' },
        { key: '错误标注', patterns: ['知识错误', '方法错误', '计算错误', '格式错误', '审题错误'], weight: 15, label: '错误分类标注' },
        { key: '汇总评分', patterns: ['汇总', '总分', '得分率'], weight: 10, label: '汇总评分' },
        { key: '错误统计', patterns: ['错误统计', '错误类型', '错误分布'], weight: 10, label: '错误统计' },
        { key: '总体评价', patterns: ['总体评价', '整体表现', '成绩等级'], weight: 5, label: '总体评价' },
        { key: '改进建议', patterns: ['改进建议', '改进', '建议'], weight: 10, label: '改进建议' },
        { key: '评语', patterns: ['评语', '鼓励', '继续保持'], weight: 5, label: '鼓励性评语' },
      ],
      placeholderPatterns: ['略', '待补充', '同上', '以此类推'],
      depthChecks: [
        { name: '逐题批改数量', test: function (t) { return (t.match(/题[号]?\s*[:：]?\s*\d|第\s*\d+\s*题/g) || []).length; }, min: 3, label: '至少3道题的逐题批改详情' },
        { name: '错误标注数量', test: function (t) { return (t.match(/【知识错误】|【方法错误】|【计算错误】|【格式错误】|【审题错误】/g) || []).length; }, min: 1, label: '至少1处错误分类标注' },
      ],
    },
    'error-analysis': {
      name: '重点及易错点分析报告',
      minChars: 2000,
      requireLatex: false,
      requiredSections: [
        { key: '概述', patterns: ['分析概述', '学科', '知识范围', '分析目的'], weight: 5, label: '分析概述' },
        { key: '知识结构', patterns: ['知识结构', '知识结构图', '整体结构'], weight: 10, label: '知识结构图' },
        { key: '重点知识', patterns: ['重点知识', '核心概念', '重要技能', '关键关系'], weight: 20, label: '重点知识分析' },
        { key: '易错点', patterns: ['易错点', '错误表现', '错因分析', '纠错策略'], weight: 25, label: '易错点分析' },
        { key: '错例', patterns: ['典型错例', '错例', '错误示例'], weight: 10, label: '典型错例' },
        { key: '变式训练', patterns: ['变式训练', '变式', '针对性练习'], weight: 10, label: '变式训练' },
        { key: '错因分类', patterns: ['错因分类', '概念混淆', '审题不清', '计算失误', '思维定式'], weight: 10, label: '错因分类汇总' },
        { key: '教学建议', patterns: ['教学建议', '教学策略', '复习策略', '教学优先级'], weight: 10, label: '教学建议' },
      ],
      placeholderPatterns: ['略', '待补充', '同上', '以此类推', '参照'],
      depthChecks: [
        { name: '易错点数量', test: function (t) { return (t.match(/易错点\s*\d|【易错点/g) || []).length; }, min: 5, label: '至少5个易错点' },
        { name: '错例数量', test: function (t) { return (t.match(/典型错例|错例/g) || []).length; }, min: 3, label: '至少3个典型错例' },
      ],
    },
    'ppt-page': {
      name: 'PPT课件（pptx）',
      minChars: 0,
      minSlides: 12,
      requireLatex: false,
      requiredSections: [
        { key: '封面', patterns: ['封面', '课题', '学科'], weight: 5, label: '封面页' },
        { key: '目标', patterns: ['学习目标', '教学目标', '目标'], weight: 10, label: '学习目标页' },
        { key: '目录', patterns: ['目录', 'contents', '概览'], weight: 5, label: '目录页' },
        { key: '知识讲授', patterns: ['定义', '概念', '性质', '定理', '公式', '原理', '规律'], weight: 15, label: '知识讲授页（6-8页）' },
        { key: '例题', patterns: ['例题', '例', '解析', '解答', '解'], weight: 10, label: '例题页（含完整解答）' },
        { key: '练习', patterns: ['练习', '课堂练习', '随堂', '检测'], weight: 10, label: '课堂练习页' },
        { key: '小结', patterns: ['小结', '总结', '归纳'], weight: 5, label: '小结页' },
        { key: '作业', patterns: ['作业', '课后', '巩固'], weight: 5, label: '作业页' },
      ],
      placeholderPatterns: ['讲解XX', '介绍XX', '此处展示', '详见', '略', '待补充', '占位文字', 'placeholder'],
      depthChecks: [],
    },
    'report-page': {
      name: 'HTML报告页面',
      minChars: 1500,
      requireLatex: false,
      requiredSections: [
        { key: 'HTML结构', patterns: ['<!DOCTYPE', '<html', '<head', '<body'], weight: 15, label: '完整HTML结构' },
        { key: '文档块', patterns: ['doc-block', 'doc-callout', 'doc-metrics', 'doc-chart', 'doc-table', 'doc-diagram', 'doc-note'], weight: 20, label: '文档块组件' },
        { key: '来源', patterns: ['doc-sources', '来源', '参考'], weight: 10, label: '来源标注' },
        { key: '目录', patterns: ['目录', 'toc', 'table-of-contents'], weight: 10, label: '侧边目录' },
        { key: '叙事主线', patterns: ['概述', '背景', '分析', '结论', '建议'], weight: 15, label: '叙事主线' },
        { key: '内容深度', patterns: ['数据', '统计', '分析', '对比', '趋势'], weight: 15, label: '内容深度（数据/分析）' },
      ],
      placeholderPatterns: ['占位文字', '待补充', '示例内容', 'placeholder', 'Lorem ipsum', '略'],
      depthChecks: [
        { name: '文档块数量', test: function (t) { return (t.match(/class="[^"]*doc-(block|callout|metrics|chart|table|diagram|note|sources)/g) || []).length; }, min: 3, label: '至少3个文档块' },
      ],
    },
  };

  // ---- 通用占位符检测 ----
  var GENERIC_PLACEHOLDERS = [
    '此处讲解', '此处介绍', '此处说明', '此处省略',
    '以此类推', '...（省略）', '（待补充）', '(待补充)', '待补充', 'TODO', '占位', 'placeholder',
    '详见教材', '参考课本',
    // 常见未替换占位符（此前漏检，导致空壳产物拿高分通过）
    '202X', '20XX', '____', '[教师姓名]', '（填写', '(填写', '待填写',
  ];

  // 占位符形状正则（难以穷举为固定字符串的模式）
  var PLACEHOLDER_REGEXES = [
    { re: /X{2,}/, label: 'XX 占位' },      // "XX门课程"等未替换占位
    { re: /_{3,}/, label: '下划线填空线' },   // "____（填写…）"
  ];

  /**
   * 验证生成内容的质量
   * @param {string} skillId - 技能ID
   * @param {string} content - 生成的内容（Markdown文本）
   * @param {object} opts - 额外选项 { slideCount: PPT页数 }
   * @returns {{passed:boolean, score:number, issues:string[], suggestions:string[], details:object}}
   */
  function validate(skillId, content, opts) {
    opts = opts || {};
    var standard = STANDARDS[skillId];
    if (!standard) {
      // 未知技能类型，做通用检查
      return _genericCheck(content);
    }

    var text = String(content || '');
    var charCount = text.length;
    var issues = [];
    var suggestions = [];
    var details = {};
    var totalWeight = 0;
    var earnedWeight = 0;

    // 1) 字数/页数检查
    if (standard.minChars > 0) {
      details.minChars = { required: standard.minChars, actual: charCount };
      if (charCount < standard.minChars) {
        issues.push('字数不足：当前 ' + charCount + ' 字，要求至少 ' + standard.minChars + ' 字');
        suggestions.push('扩充内容：补充教学过程中的教师提问话术、学生预设回答、设计意图、时间分配等细节，使正文达到 ' + standard.minChars + ' 字以上');
      } else {
        earnedWeight += 10;
      }
      totalWeight += 10;
    }
    if (standard.minSlides > 0) {
      var slides = opts.slideCount || _countSlides(text);
      details.minSlides = { required: standard.minSlides, actual: slides };
      if (slides < standard.minSlides) {
        issues.push('幻灯片页数不足：当前 ' + slides + ' 页，要求至少 ' + standard.minSlides + ' 页');
        suggestions.push('增加知识讲授页（6-8页，每页写具体知识内容）、例题页（含完整解答步骤）、课堂练习页等');
      } else {
        earnedWeight += 10;
      }
      totalWeight += 10;
    }

    // 2) 必备章节完整性检查
    details.sections = [];
    standard.requiredSections.forEach(function (sec) {
      var found = sec.patterns.some(function (p) { return text.indexOf(p) >= 0; });
      details.sections.push({ key: sec.key, label: sec.label, found: found, weight: sec.weight });
      totalWeight += sec.weight;
      if (found) {
        earnedWeight += sec.weight;
      } else {
        issues.push('缺少必备章节：' + sec.label);
        suggestions.push('补充「' + sec.label + '」部分，确保内容结构完整');
      }
    });

    // 3) 占位符检测
    var allPlaceholders = (standard.placeholderPatterns || []).concat(GENERIC_PLACEHOLDERS);
    var foundPlaceholders = [];
    allPlaceholders.forEach(function (p) {
      if (_hasPlaceholder(text, p)) {
        foundPlaceholders.push(p);
      }
    });
    PLACEHOLDER_REGEXES.forEach(function (pr) {
      if (pr.re.test(text)) foundPlaceholders.push(pr.label);
    });
    details.placeholders = { found: foundPlaceholders };
    if (foundPlaceholders.length > 0) {
      issues.push('检测到空泛/占位表述：' + foundPlaceholders.slice(0, 5).join('、'));
      suggestions.push('将占位表述替换为具体内容：写出实际问题、具体解答步骤、可操作的活动指令');
      earnedWeight -= Math.min(15, foundPlaceholders.length * 3);
    } else {
      earnedWeight += 5;
    }
    totalWeight += 5;

    // 4) 内容深度检查
    details.depthChecks = [];
    if (standard.depthChecks && standard.depthChecks.length) {
      standard.depthChecks.forEach(function (dc) {
        var count = dc.test(text);
        var passed = count >= dc.min;
        details.depthChecks.push({ name: dc.name, count: count, min: dc.min, passed: passed, label: dc.label });
        totalWeight += 5;
        if (passed) {
          earnedWeight += 5;
        } else {
          issues.push(dc.label + '：当前 ' + count + '，要求至少 ' + dc.min);
          suggestions.push('增加' + dc.name + '，确保内容深度达标');
        }
      });
    }

    // 5) LaTeX公式检查（理科类；标准可配置 requireLatex:false 跳过）
    var hasLaTeX = /\$[^$]+\$/.test(text);
    var hasMathContext = /公式|定理|函数|方程|计算|证明|推导|积分|导数|向量/.test(text);
    details.formula = { hasLaTeX: hasLaTeX, hasMathContext: hasMathContext };
    if (standard.requireLatex !== false && hasMathContext && !hasLaTeX) {
      issues.push('内容涉及数学/公式但未使用 LaTeX 语法标注');
      suggestions.push('数学公式使用 LaTeX 语法（如 $f(x)=x^2+2x+1$），系统会自动转为可读符号');
    }

    // 计算总分
    var score = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;
    if (score < 0) score = 0;
    if (score > 100) score = 100;

    var passed = issues.length === 0 && score >= 75;

    return {
      passed: passed,
      score: score,
      issues: issues,
      suggestions: suggestions,
      details: details,
    };
  }

  /** 通用质量检查（未知技能类型） */
  function _genericCheck(content) {
    var text = String(content || '');
    var issues = [];
    var suggestions = [];
    var placeholders = GENERIC_PLACEHOLDERS.filter(function (p) {
      return _hasPlaceholder(text, p);
    });
    PLACEHOLDER_REGEXES.forEach(function (pr) {
      if (pr.re.test(text)) placeholders.push(pr.label);
    });
    if (placeholders.length > 0) {
      issues.push('检测到空泛/占位表述：' + placeholders.slice(0, 5).join('、'));
      suggestions.push('将占位表述替换为具体内容');
    }
    if (text.length < 500) {
      issues.push('内容过短：当前 ' + text.length + ' 字');
      suggestions.push('扩充内容，确保信息充分');
    }
    return {
      passed: issues.length === 0,
      score: issues.length === 0 ? 100 : 50,
      issues: issues,
      suggestions: suggestions,
      details: { charCount: text.length, placeholders: placeholders },
    };
  }

  /**
   * 占位符匹配：多字模式直接 indexOf；
   * 单字模式（如"略"）要求独立成词（前后非汉字），避免误报"策略""忽略"等正常词汇。
   */
  function _hasPlaceholder(text, p) {
    if (!p) return false;
    if (p.length >= 2) return text.indexOf(p) >= 0;
    var esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp('(^|[^\\u4e00-\\u9fa5])' + esc + '([^\\u4e00-\\u9fa5]|$)');
    return re.test(text);
  }

  /** 粗略统计PPT幻灯片页数 */
  function _countSlides(text) {
    // 统计 ## 标题或"第X页"标记
    var headers = (text.match(/^#{1,2}\s+/gm) || []).length;
    var pageMarkers = (text.match(/第[一二三四五六七八九十\d]+页|slide\s*\d+/gi) || []).length;
    return Math.max(headers, pageMarkers);
  }

  /**
   * 生成给LLM的验证反馈（用于refine节点的提示词）
   * @param {object} validationResult - validate() 的返回值
   * @returns {string} 结构化的反馈文本
   */
  function buildFeedback(validationResult) {
    if (!validationResult) return '';
    var v = validationResult;
    var lines = [];
    lines.push('## 质量验证结果');
    lines.push('总评分：' + v.score + '/100' + (v.passed ? '（通过）' : '（未通过）'));
    if (v.issues && v.issues.length) {
      lines.push('');
      lines.push('### 存在的问题：');
      v.issues.forEach(function (issue, i) {
        lines.push((i + 1) + '. ' + issue);
      });
    }
    if (v.suggestions && v.suggestions.length) {
      lines.push('');
      lines.push('### 改进建议：');
      v.suggestions.forEach(function (sug, i) {
        lines.push((i + 1) + '. ' + sug);
      });
    }
    if (v.details && v.details.sections) {
      lines.push('');
      lines.push('### 章节完整性：');
      v.details.sections.forEach(function (sec) {
        lines.push((sec.found ? '✓' : '✗') + ' ' + sec.label);
      });
    }
    if (v.details && v.details.depthChecks && v.details.depthChecks.length) {
      lines.push('');
      lines.push('### 深度检查：');
      v.details.depthChecks.forEach(function (dc) {
        lines.push((dc.passed ? '✓' : '✗') + ' ' + dc.label + '（当前' + dc.count + '，要求≥' + dc.min + '）');
      });
    }
    return lines.join('\n');
  }

  global.QualityValidator = {
    STANDARDS: STANDARDS,
    validate: validate,
    buildFeedback: buildFeedback,
  };
})(window);
