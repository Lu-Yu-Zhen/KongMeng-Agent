#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
教学PPT大纲生成脚本
====================
功能：根据学科、年级、课题、课件类型、页数等参数，
      自动生成PPT页面大纲（每页标题、内容要点、视觉建议）。
      支持新授课、复习课、公开课、微课、说课五种课件类型。
      输出为Markdown格式的大纲文档。

用法：
    python generate_ppt_outline.py --subject 高中物理 --grade 高一 --topic "牛顿第二定律" --type 新授课 --pages 16

依赖：Python 3.6+，仅需标准库，无需安装第三方包。

作者：教学PPT制作技能
版本：1.0
"""

import argparse
import sys
from datetime import datetime


# ============================================================
# 课件类型模板定义
# 每种课件类型对应一组页面结构模板，包含页面类型、标题、内容要点和视觉建议
# ============================================================

# 课件类型中文名映射
COURSE_TYPES = {
    "新授课": "新授课",
    "复习课": "复习课",
    "公开课": "公开课",
    "微课": "微课",
    "说课": "说课",
}

# 各学科推荐的视觉元素关键词
SUBJECT_VISUAL_HINTS = {
    "语文": "古风插图、水墨背景、课文配图、意境图",
    "数学": "动态几何图形、函数图像、解题步骤分解图、公式截图",
    "英语": "实物图片、对话气泡、情境对话场景图、词汇配图",
    "物理": "实验装置图、受力分析图、物理过程动画截图、实验照片",
    "化学": "化学方程式、分子结构3D模型、实验视频截图、反应流程图",
    "生物": "生物结构图、生态照片、显微图像、生命过程图解",
    "历史": "朝代时间轴、历史人物画像、历史地图、史料图片",
    "地理": "地形图、气候数据图、地理现象模拟图、区域地图",
}

# 各学科推荐配色主色调
SUBJECT_COLORS = {
    "语文": "#8B4513（赭色）",
    "数学": "#2E5090（理科蓝）",
    "英语": "#D2691E（活力橙）",
    "物理": "#1E3A5F（深蓝）",
    "化学": "#2E8B57（化学绿）",
    "生物": "#556B2F（自然绿）",
    "历史": "#800020（历史红）",
    "地理": "#4682B4（地理蓝）",
}


# ============================================================
# 页面模板定义
# 每个模板是一个字典，包含 type(页面类型)、title(标题模板)、
# content(内容要点列表)、visual(视觉建议)
# ============================================================

# 新授课模板（标准16页）
TEMPLATE_NEW_LESSON = [
    {
        "type": "封面",
        "title": "{topic}",
        "content": ["课题名称", "学科与年级", "教师姓名", "日期"],
        "visual": "全屏背景图（与课题相关），标题居中或偏左，副信息在底部",
    },
    {
        "type": "学习目标",
        "title": "学习目标",
        "content": [
            "知识与技能目标（1-2条）",
            "过程与方法目标（1-2条）",
            "情感态度与价值观目标（1条）",
            "使用行为动词，目标可测量、可达成",
        ],
        "visual": "目标条目用编号图标（1/2/3），配简洁侧边图，整体简洁清晰",
    },
    {
        "type": "情境导入",
        "title": "情境导入",
        "content": [
            "生活实例/故事/视频/问题情境引入",
            "提出核心问题，激发学生兴趣",
            "点明本节课要解决的问题",
        ],
        "visual": "大幅情境图片或视频截图，问题以气泡或醒目文字呈现",
    },
    {
        "type": "新知讲解",
        "title": "新知讲解（一）：{first_concept}",
        "content": [
            "第一个核心知识点",
            "概念定义与关键特征",
            "配图/示意图辅助理解",
        ],
        "visual": "图文左右布局或上图下文，关键术语高亮显示",
    },
    {
        "type": "新知讲解",
        "title": "新知讲解（二）：{second_concept}",
        "content": [
            "第二个核心知识点",
            "与前知知识的关联",
            "典型示例说明",
        ],
        "visual": "对比表格或流程图，突出知识间的逻辑关系",
    },
    {
        "type": "新知讲解",
        "title": "新知讲解（三）：{third_concept}",
        "content": [
            "第三个核心知识点",
            "深化拓展",
            "易错点提示",
        ],
        "visual": "思维导图局部或结构图，易错点用警示色标注",
    },
    {
        "type": "新知讲解",
        "title": "新知讲解（四）：知识梳理",
        "content": [
            "知识点间的逻辑关系",
            "核心公式/定理/结论",
            "适用条件与范围",
        ],
        "visual": "知识结构图或思维导图，连接线体现逻辑",
    },
    {
        "type": "典型例题",
        "title": "典型例题（一）：基础应用",
        "content": [
            "例题题目（完整呈现）",
            "解题思路分析",
            "分步解答过程",
            "答案与结论",
        ],
        "visual": "题目在上，解析在下，解题步骤用动画逐步展示",
    },
    {
        "type": "典型例题",
        "title": "典型例题（二）：进阶应用",
        "content": [
            "综合应用例题",
            "多种解法对比（如适用）",
            "方法归纳与总结",
        ],
        "visual": "双栏对比布局，方法总结用卡片样式呈现",
    },
    {
        "type": "课堂练习",
        "title": "课堂练习：基础巩固",
        "content": [
            "2-3道基础练习题",
            "选择题/填空题/简答题",
            "可设计互动答题",
        ],
        "visual": "选项卡片A/B/C/D，正确答案用动画延迟高亮显示",
    },
    {
        "type": "课堂练习",
        "title": "课堂练习：能力提升",
        "content": [
            "1-2道提高题",
            "综合应用所学知识",
            "展示学生常见思路",
        ],
        "visual": "分层设计，难度递进，易错点用标注框提示",
    },
    {
        "type": "知识小结",
        "title": "知识小结",
        "content": [
            "本节课核心知识点回顾",
            "知识结构图/思维导图",
            "重点强调内容",
        ],
        "visual": "思维导图全景图，核心节点用主色标注",
    },
    {
        "type": "拓展延伸",
        "title": "拓展延伸",
        "content": [
            "知识在实际中的应用",
            "学科前沿介绍",
            "跨学科联系",
        ],
        "visual": "实际应用场景图片，拓展阅读二维码或链接",
    },
    {
        "type": "作业布置",
        "title": "作业布置",
        "content": [
            "基础作业（必做）：教材习题",
            "提升作业（选做）：拓展练习",
            "实践/探究作业（选做）",
        ],
        "visual": "分层作业卡片，不同难度用不同颜色区分",
    },
    {
        "type": "结尾页",
        "title": "谢谢！",
        "content": ["感谢语", "下节课预告", "鼓励性话语"],
        "visual": "简洁结尾，与封面风格呼应，可加下节课预告",
    },
]

# 复习课模板（标准12页）
TEMPLATE_REVIEW = [
    {
        "type": "封面",
        "title": "{topic}——复习课",
        "content": ["复习课题名称", "复习范围说明", "教师姓名", "日期"],
        "visual": "简洁学术风格背景，标题醒目",
    },
    {
        "type": "复习目标",
        "title": "复习目标",
        "content": [
            "知识梳理目标",
            "重点突破目标",
            "能力提升目标",
        ],
        "visual": "目标列表配编号图标，简洁清晰",
    },
    {
        "type": "知识梳理",
        "title": "知识网络梳理",
        "content": [
            "本章/本单元知识结构图",
            "核心概念之间的关系",
            "重点知识标注",
        ],
        "visual": "大幅思维导图或知识结构图，分支用不同颜色区分",
    },
    {
        "type": "重点回顾",
        "title": "重点回顾（一）：{first_concept}",
        "content": [
            "核心概念复习",
            "公式/定理/结论",
            "注意事项与易错点",
        ],
        "visual": "要点卡片式布局，易错点用警示色框标注",
    },
    {
        "type": "重点回顾",
        "title": "重点回顾（二）：{second_concept}",
        "content": [
            "核心概念复习",
            "典型例题回顾",
            "方法总结",
        ],
        "visual": "左文右图或上图下文，方法总结用高亮框",
    },
    {
        "type": "重点回顾",
        "title": "重点回顾（三）：{third_concept}",
        "content": [
            "核心概念复习",
            "知识拓展与深化",
            "与其他章节的联系",
        ],
        "visual": "对比表格呈现异同，关联线连接相关知识点",
    },
    {
        "type": "典型例题",
        "title": "典型例题（一）：基础题型",
        "content": [
            "高频考点例题",
            "解题思路与方法",
            "分步解答",
        ],
        "visual": "题目与解析分区域，关键步骤用箭头指示",
    },
    {
        "type": "典型例题",
        "title": "典型例题（二）：综合题型",
        "content": [
            "综合应用例题",
            "多知识点结合",
            "解题策略分析",
        ],
        "visual": "解题流程图，标注各步骤对应的考点",
    },
    {
        "type": "典型例题",
        "title": "典型例题（三）：易错题型",
        "content": [
            "常见错误分析",
            "正确解法对比",
            "避错策略",
        ],
        "visual": "正误对比双栏，错误用红色叉号，正确用绿色对号",
    },
    {
        "type": "课堂练习",
        "title": "复习检测",
        "content": [
            "综合练习题（5-8题）",
            "限时完成",
            "即时反馈与讲解",
        ],
        "visual": "选择题为主，选项卡片化，倒计时提示",
    },
    {
        "type": "知识小结",
        "title": "复习总结",
        "content": [
            "复习要点提炼",
            "方法与技巧总结",
            "考前提醒",
        ],
        "visual": "总结表格或清单，关键信息用主色高亮",
    },
    {
        "type": "结尾页",
        "title": "加油！",
        "content": ["鼓励语", "后续复习建议", "答疑方式说明"],
        "visual": "积极向上的背景图，简洁有力",
    },
]

# 公开课模板（标准18页，含更丰富的互动与设计）
TEMPLATE_PUBLIC_CLASS = [
    {
        "type": "封面",
        "title": "{topic}",
        "content": ["课题名称（醒目）", "学科与年级", "教师姓名与单位", "公开课标识", "日期"],
        "visual": "精美设计封面，高质量背景图，整体风格统一，可加装饰元素",
    },
    {
        "type": "学习目标",
        "title": "学习目标",
        "content": [
            "三维目标清晰呈现",
            "目标与核心素养关联",
            "可测量的行为目标",
        ],
        "visual": "精心设计的目标卡片，配图标，排版美观",
    },
    {
        "type": "情境导入",
        "title": "情境导入",
        "content": [
            "精心设计的导入情境",
            "视频/动画/实物展示",
            "悬念式提问",
        ],
        "visual": "高质量视频或动画，全屏展示，过渡自然",
    },
    {
        "type": "前置知识",
        "title": "知识回顾",
        "content": [
            "回顾已有相关知识",
            "为新课做铺垫",
            "激活学生已有认知",
        ],
        "visual": "简洁知识图谱，关键词呈现，快速过渡",
    },
    {
        "type": "新知讲解",
        "title": "新知探究（一）：{first_concept}",
        "content": [
            "探究活动设计",
            "学生活动引导",
            "发现式学习",
        ],
        "visual": "探究活动步骤图，学生活动指引清晰",
    },
    {
        "type": "新知讲解",
        "title": "新知探究（二）：{second_concept}",
        "content": [
            "核心概念建构",
            "多媒体辅助演示",
            "师生互动设计",
        ],
        "visual": "动画/模拟演示，互动式问题设计",
    },
    {
        "type": "新知讲解",
        "title": "新知探究（三）：{third_concept}",
        "content": [
            "概念深化与拓展",
            "知识应用举例",
            "思维提升",
        ],
        "visual": "分层呈现，由浅入深，配高质量图示",
    },
    {
        "type": "新知讲解",
        "title": "新知探究（四）：知识建构",
        "content": [
            "知识体系构建",
            "学生总结引导",
            "教师点评提升",
        ],
        "visual": "师生共建思维导图，逐步展开",
    },
    {
        "type": "典型例题",
        "title": "典型例题（一）",
        "content": [
            "精选典型例题",
            "多种方法解题",
            "方法对比与优化",
        ],
        "visual": "分步动画展示，方法卡片对比",
    },
    {
        "type": "典型例题",
        "title": "典型例题（二）",
        "content": [
            "变式训练",
            "一题多解",
            "思维拓展",
        ],
        "visual": "变式题逐步呈现，解题思路流程图",
    },
    {
        "type": "互动活动",
        "title": "课堂活动",
        "content": [
            "小组讨论/合作探究",
            "活动要求与时间",
            "成果展示方式",
        ],
        "visual": "活动指引卡片，计时器动画，小组分工表",
    },
    {
        "type": "课堂练习",
        "title": "课堂练习",
        "content": [
            "分层练习设计",
            "即时反馈机制",
            "学情诊断",
        ],
        "visual": "答题卡设计，互动反馈动画",
    },
    {
        "type": "拓展延伸",
        "title": "拓展延伸",
        "content": [
            "知识拓展",
            "实际应用",
            "学科前沿",
        ],
        "visual": "高质量拓展素材，开阔视野",
    },
    {
        "type": "课堂总结",
        "title": "课堂总结",
        "content": [
            "学生自主总结",
            "教师补充提升",
            "知识体系完善",
        ],
        "visual": "完整思维导图，核心节点高亮",
    },
    {
        "type": "作业布置",
        "title": "作业布置",
        "content": [
            "分层作业",
            "实践性/探究性作业",
            "拓展阅读推荐",
        ],
        "visual": "分层作业卡片，二维码链接拓展资源",
    },
    {
        "type": "板书设计",
        "title": "板书设计",
        "content": ["板书结构展示", "重点内容标注"],
        "visual": "板书示意图，与课件内容呼应",
    },
    {
        "type": "教学反思",
        "title": "教学反思（备注）",
        "content": ["设计理念说明", "预期效果分析", "改进方向"],
        "visual": "简洁文字说明，供教师参考",
    },
    {
        "type": "结尾页",
        "title": "感谢聆听！",
        "content": ["感谢语", "欢迎指导", "联系方式（可选）"],
        "visual": "与封面呼应的精美结尾设计",
    },
]

# 微课模板（标准8页，短小精悍）
TEMPLATE_MICRO = [
    {
        "type": "封面",
        "title": "{topic}",
        "content": ["微课课题", "学科与年级", "时长说明（5-10分钟）"],
        "visual": "简洁明了，突出主题，单色背景",
    },
    {
        "type": "学习目标",
        "title": "学习目标",
        "content": ["1-2个核心目标", "聚焦单一知识点"],
        "visual": "极简设计，目标一目了然",
    },
    {
        "type": "情境导入",
        "title": "问题引入",
        "content": ["快速情境引入", "直奔主题", "提出核心问题"],
        "visual": "一张关键图片或动画，快速进入主题",
    },
    {
        "type": "新知讲解",
        "title": "核心讲解",
        "content": [
            "单一知识点深入讲解",
            "步骤清晰，逻辑严密",
            "配图/动画辅助理解",
        ],
        "visual": "图文结合，动画逐步展示关键步骤",
    },
    {
        "type": "新知讲解",
        "title": "深入分析",
        "content": [
            "重点/难点突破",
            "典型示例",
            "关键提示",
        ],
        "visual": "聚焦关键内容，标注重点，配图精准",
    },
    {
        "type": "典型例题",
        "title": "例题演示",
        "content": ["典型例题", "分步解答", "方法点拨"],
        "visual": "解题步骤动画展示，重点步骤高亮",
    },
    {
        "type": "知识小结",
        "title": "知识小结",
        "content": ["核心要点回顾", "方法总结", "记忆口诀（可选）"],
        "visual": "简洁要点列表，核心词高亮",
    },
    {
        "type": "结尾页",
        "title": "感谢观看",
        "content": ["感谢语", "配套练习说明（可选）"],
        "visual": "简洁结尾，可附二维码",
    },
]

# 说课模板（标准14页）
TEMPLATE_LECTURE = [
    {
        "type": "封面",
        "title": "{topic}——说课",
        "content": ["说课课题", "学科与年级", "说课人姓名", "单位", "日期"],
        "visual": "正式学术风格，标题醒目",
    },
    {
        "type": "说课总览",
        "title": "说课提纲",
        "content": [
            "说教材",
            "说学情",
            "说教法与学法",
            "说教学过程",
            "说板书设计",
        ],
        "visual": "说课流程图，五部分结构清晰呈现",
    },
    {
        "type": "说教材",
        "title": "一、说教材",
        "content": [
            "教材地位与作用",
            "教学重点",
            "教学难点",
            "课时安排",
        ],
        "visual": "教材分析图，重难点用不同颜色标注",
    },
    {
        "type": "说学情",
        "title": "二、说学情",
        "content": [
            "学生已有知识基础",
            "学生认知特点",
            "可能存在的困难",
        ],
        "visual": "学情分析表或雷达图",
    },
    {
        "type": "说教法学法",
        "title": "三、说教法与学法",
        "content": [
            "教法选择与依据",
            "学法指导",
            "教学手段（多媒体等）",
        ],
        "visual": "教法学法对应关系图",
    },
    {
        "type": "说教学过程",
        "title": "四、说教学过程（一）：导入与新知",
        "content": [
            "导入环节设计（2-3分钟）",
            "新知讲解环节（15-20分钟）",
            "各环节设计意图",
        ],
        "visual": "教学流程图，标注时间与设计意图",
    },
    {
        "type": "说教学过程",
        "title": "四、说教学过程（二）：例题与练习",
        "content": [
            "例题讲解环节（8-10分钟）",
            "课堂练习环节（5-8分钟）",
            "各环节设计意图",
        ],
        "visual": "教学流程图续，例题与练习设计说明",
    },
    {
        "type": "说教学过程",
        "title": "四、说教学过程（三）：小结与作业",
        "content": [
            "课堂小结环节（2-3分钟）",
            "作业布置环节",
            "各环节设计意图",
        ],
        "visual": "教学流程图续，总结与作业设计",
    },
    {
        "type": "说教学过程",
        "title": "四、说教学过程（四）：教学亮点",
        "content": [
            "本课教学亮点",
            "创新设计",
            "预期教学效果",
        ],
        "visual": "亮点卡片展示，图标辅助",
    },
    {
        "type": "说板书设计",
        "title": "五、说板书设计",
        "content": ["板书结构图", "板书设计意图"],
        "visual": "板书设计示意图",
    },
    {
        "type": "说教学评价",
        "title": "六、教学评价设计",
        "content": ["评价方式", "评价标准", "过程性评价设计"],
        "visual": "评价表格或评价流程图",
    },
    {
        "type": "说教学反思",
        "title": "七、教学反思",
        "content": ["预设的教学反思", "可能的改进方向", "教学创新点"],
        "visual": "简洁文字说明，分点呈现",
    },
    {
        "type": "说课总结",
        "title": "说课总结",
        "content": ["整体设计理念", "教学特色", "致谢"],
        "visual": "总结要点，设计理念图示",
    },
    {
        "type": "结尾页",
        "title": "感谢指导！",
        "content": ["感谢语", "欢迎批评指正", "联系方式（可选）"],
        "visual": "与封面呼应的正式结尾",
    },
]


# ============================================================
# 模板选择函数
# ============================================================

def get_template(course_type):
    """根据课件类型返回对应模板"""
    templates = {
        "新授课": TEMPLATE_NEW_LESSON,
        "复习课": TEMPLATE_REVIEW,
        "公开课": TEMPLATE_PUBLIC_CLASS,
        "微课": TEMPLATE_MICRO,
        "说课": TEMPLATE_LECTURE,
    }
    return templates.get(course_type, TEMPLATE_NEW_LESSON)


def get_template_page_count(course_type):
    """获取各课件类型的标准页数"""
    counts = {
        "新授课": 15,
        "复习课": 12,
        "公开课": 18,
        "微课": 8,
        "说课": 14,
    }
    return counts.get(course_type, 15)


def match_subject(subject):
    """
    从完整学科名称中提取学科关键词，用于查找学科配色与视觉建议。
    
    例如：
        "高中物理" -> "物理"
        "初中数学" -> "数学"
        "小学语文" -> "语文"
        "物理"     -> "物理"
    
    返回匹配到的学科名称，如未匹配则返回原字符串。
    """
    subjects = ["语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理"]
    for s in subjects:
        if s in subject:
            return s
    return subject


# ============================================================
# 大纲生成核心函数
# ============================================================

def generate_outline(subject, grade, topic, course_type, pages):
    """
    生成PPT大纲文档
    
    参数：
        subject: 学科（如：高中物理）
        grade: 年级（如：高一）
        topic: 课题名称（如：牛顿第二定律）
        course_type: 课件类型（新授课/复习课/公开课/微课/说课）
        pages: 页数
    
    返回：
        Markdown格式的大纲文档字符串
    """
    template = get_template(course_type)
    standard_pages = get_template_page_count(course_type)
    
    # 生成概念占位符
    first_concept = "核心概念一"
    second_concept = "核心概念二"
    third_concept = "核心概念三"
    
    # 根据页数调整模板
    # 如果用户指定的页数与标准页数不同，进行适当调整
    if pages != len(template):
        template = adjust_template_length(template, pages, course_type)
    
    # 获取学科视觉建议（通过match_subject匹配学科关键词）
    subject_key = match_subject(subject)
    visual_hint = SUBJECT_VISUAL_HINTS.get(subject_key, "与课题相关的高质量图片、图表")
    color_hint = SUBJECT_COLORS.get(subject_key, "与学科特色匹配的主题色")
    
    # 构建Markdown文档
    md_lines = []
    
    # 文档头部
    md_lines.append(f"# 教学PPT大纲：{topic}")
    md_lines.append("")
    md_lines.append("## 课件基本信息")
    md_lines.append("")
    md_lines.append(f"| 项目 | 内容 |")
    md_lines.append(f"|------|------|")
    md_lines.append(f"| 学科 | {subject} |")
    md_lines.append(f"| 年级 | {grade} |")
    md_lines.append(f"| 课题 | {topic} |")
    md_lines.append(f"| 课件类型 | {course_type} |")
    md_lines.append(f"| 页数 | {pages}页 |")
    md_lines.append(f"| 生成时间 | {datetime.now().strftime('%Y-%m-%d %H:%M')} |")
    md_lines.append("")
    
    # 整体设计建议
    md_lines.append("## 整体设计建议")
    md_lines.append("")
    md_lines.append(f"- **学科视觉元素**：{visual_hint}")
    md_lines.append(f"- **推荐主色调**：{color_hint}")
    md_lines.append(f"- **课件类型说明**：本课件为{course_type}，共{pages}页")
    md_lines.append(f"- **页面比例**：16:9（宽屏）")
    md_lines.append(f"- **字体建议**：标题用思源黑体/微软雅黑加粗（36-44pt），正文用思源宋体/微软雅黑（24-28pt）")
    md_lines.append("")
    md_lines.append("---")
    md_lines.append("")
    
    # 各页面大纲
    md_lines.append("## 页面大纲详情")
    md_lines.append("")
    
    for i, page in enumerate(template, 1):
        # 填充标题模板中的占位符
        page_title = page["title"].format(
            topic=topic,
            first_concept=first_concept,
            second_concept=second_concept,
            third_concept=third_concept,
        )
        
        md_lines.append(f"### P{i}：{page_title}")
        md_lines.append("")
        md_lines.append(f"**页面类型**：{page['type']}")
        md_lines.append("")
        md_lines.append("**内容要点**：")
        md_lines.append("")
        for item in page["content"]:
            md_lines.append(f"- {item}")
        md_lines.append("")
        md_lines.append(f"**视觉建议**：{page['visual']}")
        md_lines.append("")
        
        # 为特定页面添加额外设计提示
        if page["type"] == "新知讲解":
            md_lines.append(f"*提示：结合{subject}学科特色，可使用{visual_hint}辅助讲解*")
            md_lines.append("")
        elif page["type"] == "典型例题":
            md_lines.append("*提示：解题步骤建议用动画逐步展示，便于学生跟随思路*")
            md_lines.append("")
        elif page["type"] == "课堂练习":
            md_lines.append("*提示：可设计互动答题，正确答案用动画延迟显示*")
            md_lines.append("")
        elif page["type"] == "知识小结":
            md_lines.append("*提示：建议使用思维导图或知识结构图，突出知识间的逻辑关系*")
            md_lines.append("")
        
        md_lines.append("---")
        md_lines.append("")
    
    # 质量检查清单
    md_lines.append("## 质量检查清单")
    md_lines.append("")
    md_lines.append("完成课件后，请逐项检查：")
    md_lines.append("")
    md_lines.append("- [ ] 封面信息完整（课题、学科、教师）")
    md_lines.append("- [ ] 学习目标明确可读")
    md_lines.append("- [ ] 每页文字量适中（不超过6行）")
    md_lines.append("- [ ] 图文搭配合理（图文比例≥1:1）")
    md_lines.append(f"- [ ] 配色统一协调（主色调：{color_hint}）")
    md_lines.append("- [ ] 字体大小符合规范（标题36-44pt，正文24-28pt）")
    md_lines.append("- [ ] 动画使用克制得当（仅用于逻辑呈现）")
    md_lines.append("- [ ] 例题解析步骤清晰")
    md_lines.append("- [ ] 课堂练习有互动设计")
    md_lines.append("- [ ] 知识小结完整")
    md_lines.append("- [ ] 作业布置分层")
    md_lines.append(f"- [ ] 总页数与课时匹配（当前：{pages}页）")
    md_lines.append("")
    
    # 页脚
    md_lines.append("---")
    md_lines.append("")
    md_lines.append("*本大纲由「教学PPT制作」技能的大纲生成脚本自动生成，可根据实际教学需求灵活调整。*")
    
    return "\n".join(md_lines)


def adjust_template_length(template, target_pages, course_type):
    """
    根据目标页数调整模板长度
    
    策略：
    - 如果目标页数 > 模板页数：在"新知讲解"和"课堂练习"部分增加页面
    - 如果目标页数 < 模板页数：合并或删减部分页面
    """
    current_pages = len(template)
    
    if target_pages == current_pages:
        return template
    
    adjusted = list(template)  # 复制模板
    
    if target_pages > current_pages:
        # 需要增加页面
        diff = target_pages - current_pages
        # 在"新知讲解"后插入额外的讲解页或练习页
        extra_pages = []
        for j in range(diff):
            extra_pages.append({
                "type": "新知讲解" if j % 2 == 0 else "课堂练习",
                "title": f"{'拓展讲解' if j % 2 == 0 else '巩固练习'}（{j // 2 + 1}）",
                "content": [
                    "补充知识点或练习",
                    "结合学科特色设计内容",
                    "与前后内容衔接",
                ],
                "visual": "图文结合，保持整体风格统一",
            })
        
        # 找到"新知讲解"区块后插入
        insert_pos = 0
        for i, page in enumerate(adjusted):
            if page["type"] not in ["封面", "学习目标", "复习目标", "情境导入", "说课总览", "学习目标", "知识回顾"]:
                insert_pos = i
                break
        
        # 将额外页面分散插入
        for k, extra in enumerate(extra_pages):
            insert_index = min(insert_pos + 2 + k * 2, len(adjusted))
            adjusted.insert(insert_index, extra)
    
    elif target_pages < current_pages:
        # 需要减少页面
        diff = current_pages - target_pages
        # 优先删减"拓展延伸""教学反思"等非核心页面
        removable_types = ["拓展延伸", "教学反思", "说教学评价", "板书设计", "说板书设计", "前置知识"]
        
        removed = 0
        for rt in removable_types:
            if removed >= diff:
                break
            for i in range(len(adjusted) - 1, -1, -1):
                if removed >= diff:
                    break
                if adjusted[i]["type"] == rt:
                    adjusted.pop(i)
                    removed += 1
        
        # 如果还不够，合并"新知讲解"页面
        while removed < diff:
            for i in range(len(adjusted) - 1, -1, -1):
                if removed >= diff:
                    break
                if adjusted[i]["type"] == "新知讲解":
                    adjusted.pop(i)
                    removed += 1
            # 防止死循环
            if all(p["type"] != "新知讲解" for p in adjusted):
                break
    
    return adjusted


# ============================================================
# 命令行参数解析
# ============================================================

def parse_args():
    """解析命令行参数"""
    parser = argparse.ArgumentParser(
        description="教学PPT大纲生成工具 - 根据学科、课题等信息生成PPT页面大纲",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用示例：
  # 生成高中物理新授课大纲（16页）
  python generate_ppt_outline.py --subject 高中物理 --grade 高一 --topic "牛顿第二定律" --type 新授课 --pages 16

  # 生成初中数学复习课大纲（12页），并保存到文件
  python generate_ppt_outline.py --subject 初中数学 --grade 初三 --topic "二次函数" --type 复习课 --pages 12 --output 大纲.md

  # 生成小学语文微课大纲（8页）
  python generate_ppt_outline.py --subject 小学语文 --grade 五年级 --topic "古诗赏析" --type 微课 --pages 8

支持的课件类型：新授课、复习课、公开课、微课、说课
支持的学科：语文、数学、英语、物理、化学、生物、历史、地理（其他学科也可使用，将使用通用视觉建议）
        """,
    )
    parser.add_argument(
        "--subject", "-s",
        required=True,
        help="学科（如：高中物理、初中数学、小学语文）",
    )
    parser.add_argument(
        "--grade", "-g",
        required=True,
        help="年级（如：高一、初三、五年级）",
    )
    parser.add_argument(
        "--topic", "-t",
        required=True,
        help="课题名称（如：牛顿第二定律、二次函数）",
    )
    parser.add_argument(
        "--type", "-y",
        required=True,
        choices=["新授课", "复习课", "公开课", "微课", "说课"],
        help="课件类型：新授课/复习课/公开课/微课/说课",
    )
    parser.add_argument(
        "--pages", "-p",
        type=int,
        default=None,
        help="页数（不指定则使用该课件类型的标准页数）",
    )
    parser.add_argument(
        "--output", "-o",
        default=None,
        help="输出文件路径（不指定则输出到标准输出）",
    )
    return parser.parse_args()


# ============================================================
# 主函数
# ============================================================

def main():
    """主函数：解析参数并生成大纲"""
    args = parse_args()
    
    # 确定页数
    if args.pages is None:
        pages = get_template_page_count(args.type)
        print(f"[信息] 未指定页数，使用{args.type}标准页数：{pages}页", file=sys.stderr)
    else:
        pages = args.pages
    
    # 页数合理性检查
    min_pages = {"微课": 5, "说课": 10, "复习课": 8, "新授课": 10, "公开课": 12}
    max_pages = {"微课": 12, "说课": 20, "复习课": 20, "新授课": 25, "公开课": 25}
    
    min_p = min_pages.get(args.type, 8)
    max_p = max_pages.get(args.type, 25)
    
    if pages < min_p or pages > max_p:
        print(
            f"[警告] {args.type}建议页数范围为 {min_p}-{max_p} 页，"
            f"当前设置为 {pages} 页，可能不太合理。",
            file=sys.stderr,
        )
    
    # 生成大纲
    print(f"[信息] 正在生成PPT大纲...", file=sys.stderr)
    print(f"  学科：{args.subject}", file=sys.stderr)
    print(f"  年级：{args.grade}", file=sys.stderr)
    print(f"  课题：{args.topic}", file=sys.stderr)
    print(f"  类型：{args.type}", file=sys.stderr)
    print(f"  页数：{pages}页", file=sys.stderr)
    print(f"", file=sys.stderr)
    
    outline = generate_outline(
        subject=args.subject,
        grade=args.grade,
        topic=args.topic,
        course_type=args.type,
        pages=pages,
    )
    
    # 输出结果
    if args.output:
        # 写入文件
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(outline)
        print(f"[完成] 大纲已保存到：{args.output}", file=sys.stderr)
    else:
        # 输出到标准输出
        print(outline)


if __name__ == "__main__":
    main()
