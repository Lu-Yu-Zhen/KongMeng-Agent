#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
教案生成脚本
================================================
功能说明：
    根据输入的学科、年级、课题、课型、课时、教材版本等参数，
    自动生成包含九大模块的标准教案文档（Markdown 格式）。

九大模块结构：
    基本信息 → 教材分析 → 学情分析 → 教学目标 → 重难点
    → 教学准备 → 教学过程 → 板书设计 → 教学反思

使用方式：
    方式一（命令行传参）：
        python generate_lesson_plan.py --subject 数学 --grade 八年级 \
            --topic 勾股定理 --type 新授课 --duration 40 --version 人教版

    方式二（交互式输入）：
        python generate_lesson_plan.py --interactive

    方式三（默认参数，快速预览）：
        python generate_lesson_plan.py

输出文件：
    默认输出到当前目录下，文件名为 "课题_教案.md"。
    可通过 --output 参数指定输出路径。

作者：教案编写技能
日期：2026-07-12
================================================
"""

import argparse
import os
import sys
from datetime import datetime


# ============================================================
# 第一部分：默认配置与常量
# ============================================================

# 默认参数（交互模式或未指定参数时使用）
DEFAULT_CONFIG = {
    "subject": "语文",
    "grade": "高三",
    "topic": "示例课题",
    "lesson_type": "新授课",
    "duration": 45,
    "version": "人教版",
    "author": "",
    "date": datetime.now().strftime("%Y-%m-%d"),
}

# 支持的课型列表
LESSON_TYPES = ["新授课", "复习课", "实验课", "习题课"]

# 各课型对应的教学过程环节模板
LESSON_PROCESSES = {
    "新授课": [
        ("导入新课", 5, "情境创设，激发兴趣，引出课题"),
        ("新知探究", 18, "分层次呈现新知识，教师引导与学生探究相结合"),
        ("巩固练习", 10, "基础题面向全体，提高题分层拓展"),
        ("课堂小结", 4, "师生共同梳理知识脉络"),
        ("布置作业", 3, "基础作业与拓展作业分层布置"),
    ],
    "复习课": [
        ("知识梳理", 8, "构建知识网络，形成系统认知"),
        ("典型例题", 15, "精选例题，讲练结合，突破易错点"),
        ("分组练习", 10, "学生独立完成或小组合作完成精选习题"),
        ("交流讲评", 5, "学生展示，教师点评，查漏补缺"),
        ("总结提升", 2, "归纳方法，提炼规律"),
    ],
    "实验课": [
        ("导入与目标说明", 3, "明确实验目的与安全注意事项"),
        ("实验原理讲解", 7, "讲解实验原理、方法与操作要点"),
        ("分组实验操作", 18, "学生分组实验，教师巡回指导"),
        ("数据记录与处理", 7, "记录实验数据，进行分析处理"),
        ("汇报与总结", 5, "各组汇报实验结果，师生共同总结"),
    ],
    "习题课": [
        ("错题分析", 8, "分析典型错误，查找知识漏洞"),
        ("分类讲解", 15, "按知识点或题型分类讲解重点习题"),
        ("变式训练", 10, "同类变式练习，巩固方法"),
        ("归纳方法", 4, "总结解题思路与技巧"),
        ("拓展提升", 3, "挑战性题目，拓展思维"),
    ],
}

# 标准教学目标三维度
OBJECTIVE_DIMENSIONS = {
    "知识与技能": [
        "能说出……（核心概念/定义/公式）",
        "能理解……（原理/规律/关系）",
        "能运用……解决……（实际问题/典型题目）",
    ],
    "过程与方法": [
        "通过……（探究/讨论/实验）过程，经历……",
        "运用……（比较/归纳/演绎）方法，提升……能力",
    ],
    "情感态度与价值观": [
        "通过……，感受/体验/领悟……",
        "结合……，培养……（科学精神/审美情趣/社会责任感）",
    ],
}

# 核心素养四维度（通用）
CORE_LITERACY = {
    "文化基础": ["人文底蕴", "科学精神"],
    "自主发展": ["学会学习", "健康生活"],
    "社会参与": ["责任担当", "实践创新"],
}


# ============================================================
# 第二部分：教案内容生成函数
# ============================================================

def generate_basic_info(config):
    """
    生成「一、基本信息」模块。
    包含课题、学科、年级、课时、课型、教材版本、编写日期等基本信息。
    """
    return f"""## 一、基本信息

| 项目 | 内容 |
|------|------|
| 课题名称 | {config['topic']} |
| 学科 | {config['subject']} |
| 年级 | {config['grade']} |
| 课时 | {config['duration']}分钟 |
| 课型 | {config['lesson_type']} |
| 教材版本 | {config['version']} |
| 编写日期 | {config['date']} |
| 执教教师 | {config['author'] or '（待填写）'} |"""


def generate_textbook_analysis(config):
    """
    生成「二、教材分析」模块。
    分析本节课在教材中的地位、知识前后联系及核心要点。
    """
    return f"""## 二、教材分析

### 1. 本节课在教材中的地位与作用

本课题《{config['topic']}》是{config['subject']}学科{config['grade']}的重要内容，在整个知识体系中起着承上启下的关键作用。该内容既是前面所学知识的延伸与应用，又为后续学习奠定了重要基础。

### 2. 知识的前后联系

- **承接内容：** （填写本节课所承接的已学知识）
- **本节核心：** （填写本节课的核心知识要点）
- **后续铺垫：** （填写本节课为哪些后续知识做铺垫）

### 3. 教材内容核心要点

> （提炼教材中的3-5个核心知识点，简明扼要地列出）

1. 核心知识点一：__________
2. 核心知识点二：__________
3. 核心知识点三：__________

### 4. 教材编排特点

教材在编排上体现了由具体到抽象、由特殊到一般的认知规律，注重知识的形成过程，有利于学生自主探究与合作学习。"""


def generate_student_analysis(config):
    """
    生成「三、学情分析」模块。
    分析学生已有知识基础、认知特点、学习障碍及兴趣动机。
    """
    return f"""## 三、学情分析

### 1. 学生已有知识基础

{config['grade']}学生在学习本课题前，已经掌握了__________（填写学生已具备的相关知识与技能），这为本节课的学习提供了必要的知识储备。

### 2. 学生认知特点与思维水平

- 该年龄段学生处于__________阶段，思维以__________为主，正逐步向__________过渡。
- 学生具有较强的求知欲和好奇心，喜欢动手操作和参与讨论。
- 抽象思维能力尚在发展中，对抽象概念的理解需要借助直观演示和具体实例。

### 3. 可能存在的学习障碍与困难点

- **概念理解障碍：** （填写学生可能难以理解的概念）
- **方法运用障碍：** （填写学生可能难以掌握的方法）
- **思维转换障碍：** 从__________到__________的思维转换可能存在困难

### 4. 学生学习兴趣与动机分析

- 学生对__________内容兴趣浓厚，可利用__________激发学习兴趣。
- 部分学生自主学习意识较强，可设计探究性活动满足其需求。
- 需关注学习困难学生，提供适当的支架与帮助。"""


def generate_objectives(config):
    """
    生成「四、教学目标」模块。
    按新课标三维目标编写，含知识与技能、过程与方法、情感态度与价值观。
    """
    objectives_text = "## 四、教学目标\n\n"
    objectives_text += "> 依据新课程标准，从三个维度设定教学目标，确保目标具体、可测量、可达成。\n\n"

    for dimension, items in OBJECTIVE_DIMENSIONS.items():
        objectives_text += f"### {dimension}目标\n\n"
        objectives_text += "（请根据实际教学内容，参照以下模板编写具体目标）\n\n"
        for i, item in enumerate(items, 1):
            objectives_text += f"{i}. {item}\n"
        objectives_text += "\n"

    objectives_text += """### 核心素养落实说明

本节课着重落实以下核心素养：

| 维度 | 落实要点 |
|------|---------|
| 人文底蕴/科学精神 | （填写具体落实方式） |
| 学会学习 | （填写具体落实方式） |
| 实践创新 | （填写具体落实方式） |
| 责任担当 | （填写具体落实方式） |

> **编写提示：** 教学目标应使用可观察、可测量的行为动词，避免使用"了解""体会"等模糊词汇。
> 推荐使用"能说出""能辨认""能解释""能运用""能设计"等外显性动词。"""

    return objectives_text


def generate_key_difficulties(config):
    """
    生成「五、教学重难点」模块。
    明确教学重点和难点，并附突破策略。
    """
    return f"""## 五、教学重难点

### 教学重点

本节课的教学重点是学生必须掌握的核心知识与技能：

1. **重点一：** （填写核心知识点/技能）
   - 重点分析：这是本节课的核心内容，是后续学习的基础。

2. **重点二：** （填写核心知识点/技能）
   - 重点分析：这是学生形成学科能力的关键环节。

### 教学难点

本节课的难点是学生最易混淆或最难理解的内容：

1. **难点一：** （填写难点内容）
   - 难点成因：学生缺乏__________经验/抽象思维能力不足/概念易混淆
   - **突破策略：** 采用__________（直观演示/类比迁移/分层递进/小组讨论）方法，通过__________帮助学生突破。

2. **难点二：** （填写难点内容）
   - 难点成因：__________
   - **突破策略：** __________

> **编写提示：** 每个难点都必须附上具体的突破策略，说明"用什么方法、通过什么途径、达到什么效果"。"""


def generate_preparation(config):
    """
    生成「六、教学准备」模块。
    列出教师准备和学生准备。
    """
    return f"""## 六、教学准备

### 教师准备

- [ ] 多媒体课件（PPT/微课视频）
- [ ] 教具：__________（填写具体教具）
- [ ] {('实验器材：__________' if config['lesson_type'] == '实验课' else '演示材料：__________')}
- [ ] 学习任务单/导学案
- [ ] 分层练习题

### 学生准备

- [ ] 预习教材第__页至第__页
- [ ] 收集相关资料：__________
- [ ] 准备学具：__________
- [ ] 完成预习自测题

### 教学环境准备

- {('实验室检查与器材调试' if config['lesson_type'] == '实验课' else '多媒体设备检查与课件调试')}
- 课桌椅摆放方式：__________（常规/小组围坐/U型排列）"""


def generate_process(config):
    """
    生成「七、教学过程」模块。
    根据课型选择对应的教学环节模板，生成详细的表格化教学过程。
    """
    lesson_type = config["lesson_type"]
    processes = LESSON_PROCESSES.get(lesson_type, LESSON_PROCESSES["新授课"])

    process_text = "## 七、教学过程\n\n"
    process_text += f"> 本节课为{lesson_type}，总时长{config['duration']}分钟。\n\n"
    process_text += "### 教学环节总览\n\n"

    # 生成教学环节总览表
    process_text += "| 环节 | 时间 | 设计意图 |\n"
    process_text += "|------|------|----------|\n"
    total_time = 0
    for name, time, intent in processes:
        process_text += f"| {name} | {time}分钟 | {intent} |\n"
        total_time += time
    process_text += f"| **合计** | **{total_time}分钟** | |\n\n"

    process_text += f"> **时间校验：** 各环节时间合计为{total_time}分钟"
    if total_time == config["duration"]:
        process_text += f"，等于课时总时长{config['duration']}分钟，符合要求。\n\n"
    else:
        process_text += f"，与课时总时长{config['duration']}分钟存在差异，请根据实际情况调整。\n\n"

    # 生成各环节详细设计
    process_text += "### 各环节详细设计\n\n"

    for idx, (name, time, intent) in enumerate(processes, 1):
        process_text += f"#### 环节{idx}：{name}（{time}分钟）\n\n"
        process_text += f"**设计意图：** {intent}\n\n"

        process_text += "**教师活动：**\n"
        if name == "导入新课":
            process_text += (
                "1. 创设情境：__________（生活实例/故事/实验演示/问题驱动/复习导入）\n"
                "2. 提出问题：__________（设计1-2个有启发性的关键问题）\n"
                "3. 引出课题：板书课题《" + config["topic"] + "》\n\n"
            )
        elif "探究" in name or "新知" in name:
            process_text += (
                "1. 引导观察/思考：__________\n"
                "2. 组织活动：__________（讨论/实验/操作）\n"
                "3. 关键问题：__________\n"
                "4. 归纳总结：__________\n\n"
            )
        elif "练习" in name or "训练" in name:
            process_text += (
                "1. 出示练习题：__________（基础题/提高题分层设计）\n"
                "2. 巡视指导，关注学困生\n"
                "3. 组织反馈与讲评\n\n"
            )
        elif "小结" in name or "总结" in name:
            process_text += (
                "1. 引导学生回顾本节课所学内容\n"
                "2. 用思维导图/表格/口诀梳理知识脉络\n"
                "3. 强调重点，提醒易错点\n\n"
            )
        elif "作业" in name:
            process_text += (
                "1. 基础作业：__________（面向全体学生）\n"
                "2. 拓展作业：__________（面向学有余力学生）\n"
                "3. 实践/探究作业（选做）：__________\n\n"
            )
        else:
            process_text += (
                "1. __________\n"
                "2. __________\n"
                "3. __________\n\n"
            )

        process_text += "**学生活动：**\n"
        process_text += (
            "1. __________（独立思考/小组讨论/动手操作/展示交流）\n"
            "2. __________\n"
            "3. __________\n\n"
        )

        process_text += "**预设生成与应对：**\n"
        process_text += (
            "- 预设学生可能出现的反应：__________\n"
            "- 应对策略：__________\n\n"
        )

        process_text += "---\n\n"

    # 补充分层教学说明
    process_text += "### 分层教学设计\n\n"
    process_text += "| 层次 | 目标要求 | 活动设计 |\n"
    process_text += "|------|---------|----------|\n"
    process_text += "| 基础层 | 达成基本目标 | __________ |\n"
    process_text += "| 提高层 | 灵活运用知识 | __________ |\n"
    process_text += "| 拓展层 | 综合与创新能力 | __________ |\n"

    return process_text


def generate_blackboard(config):
    """
    生成「八、板书设计」模块。
    提供主板书和副板书的分区设计说明。
    """
    return f"""## 八、板书设计

### 板书布局示意

```
┌─────────────────────────────────────────────────────┐
│                    主板书区域                         │
│                                                       │
│                    《{config['topic']}》                  │
│                                                       │
│    一、核心概念/知识点一            三、核心概念/知识点三  │
│                                                       │
│    二、核心概念/知识点二            四、核心方法/规律     │
│                                                       │
│              （知识脉络图/思维导图）                     │
├─────────────────────────────────────────────────────┤
│                    副板书区域                         │
│                                                       │
│    演示过程 / 例题板演 / 学生板演 / 补充说明              │
└─────────────────────────────────────────────────────┘
```

### 板书设计说明

- **主板书：** 呈现本节课的核心知识结构，条理清晰，保留至课终。
- **副板书：** 用于例题板演、学生演算、临时补充等，可随时擦除更新。
- **书写要求：** 字迹工整，布局合理，重点内容可用彩色粉笔标注。
- **设计理念：** 板书应体现知识的逻辑关系，帮助学生构建知识网络。

> **编写提示：** 可根据学科特点，将板书设计为提纲式、表格式、图示式或思维导图式。"""


def generate_reflection(config):
    """
    生成「九、教学反思」模块。
    课后填写，包括目标达成、亮点不足及改进措施。
    """
    return """## 九、教学反思（课后填写）

### 1. 教学目标达成情况

| 目标维度 | 达成情况 | 评价依据 |
|---------|---------|---------|
| 知识与技能 | □完全达成 □基本达成 □未达成 | __________ |
| 过程与方法 | □完全达成 □基本达成 □未达成 | __________ |
| 情感态度与价值观 | □完全达成 □基本达成 □未达成 | __________ |

### 2. 教学过程亮点

- __________
- __________

### 3. 教学过程不足

- __________
- __________

### 4. 学生反馈与学情再分析

- 课堂参与度：□高 □中 □低
- 学生疑问集中在：__________
- 意外生成与处理：__________

### 5. 改进措施与后续调整

| 不足之处 | 改进措施 | 调整时间 |
|---------|---------|---------|
| __________ | __________ | __________ |
| __________ | __________ | __________ |

### 6. 再教设计建议

> 基于本次教学经验，若再次执教本课题，将做如下调整：
>
> __________

---

> **填写提示：** 教学反思应在课后及时完成，建议在授课当天或次日内填写。
> 反思应具体、客观，既有成功经验的提炼，也有不足之处的分析，并形成可操作的改进方案。"""


# ============================================================
# 第三部分：教案文档组装
# ============================================================

def generate_lesson_plan(config):
    """
    根据配置信息，组装完整的教案文档（Markdown格式）。
    将九大模块按顺序拼接，形成结构完整的教案。
    """
    # 文档标题
    header = f"# {config['subject']}教案：{config['topic']}\n\n"
    header += f"> {config['grade']} · {config['lesson_type']} · {config['version']} · {config['duration']}分钟\n\n"
    header += "---\n\n"

    # 按九大模块顺序组装
    modules = [
        generate_basic_info(config),
        generate_textbook_analysis(config),
        generate_student_analysis(config),
        generate_objectives(config),
        generate_key_difficulties(config),
        generate_preparation(config),
        generate_process(config),
        generate_blackboard(config),
        generate_reflection(config),
    ]

    # 模块间添加分隔线
    body = "\n\n---\n\n".join(modules)

    # 文档结尾
    footer = "\n\n---\n\n"
    footer += f"*本教案由教案生成脚本自动生成，生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}*\n"
    footer += "*请根据实际教学情况填写各模块中的占位内容。*\n"

    return header + body + footer


# ============================================================
# 第四部分：命令行参数解析与主程序
# ============================================================

def parse_args():
    """
    解析命令行参数。
    支持学科、年级、课题、课型、课时、教材版本等参数。
    """
    parser = argparse.ArgumentParser(
        description="教案生成脚本 - 生成包含九大模块的标准教案文档",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用示例：
  python generate_lesson_plan.py --subject 数学 --grade 八年级 \\
      --topic 勾股定理 --type 新授课 --duration 45 --version 人教版

  python generate_lesson_plan.py --interactive

  python generate_lesson_plan.py --output D:\\教案\\数学_勾股定理_教案.md
        """,
    )

    parser.add_argument(
        "--subject", "-s",
        type=str,
        default=DEFAULT_CONFIG["subject"],
        help="学科名称（如：语文、数学、英语、物理等），默认：语文",
    )
    parser.add_argument(
        "--grade", "-g",
        type=str,
        default=DEFAULT_CONFIG["grade"],
        help="年级（如：七年级、高二等），默认：七年级",
    )
    parser.add_argument(
        "--topic", "-t",
        type=str,
        default=DEFAULT_CONFIG["topic"],
        help="课题名称（如：勾股定理），默认：示例课题",
    )
    parser.add_argument(
        "--type",
        type=str,
        default=DEFAULT_CONFIG["lesson_type"],
        choices=LESSON_TYPES,
        help="课型（新授课/复习课/实验课/习题课），默认：新授课",
    )
    parser.add_argument(
        "--duration", "-d",
        type=int,
        default=DEFAULT_CONFIG["duration"],
        help="课时长度（分钟），默认：40",
    )
    parser.add_argument(
        "--version", "-v",
        type=str,
        default=DEFAULT_CONFIG["version"],
        help="教材版本（如：人教版/北师大版/苏教版等），默认：人教版",
    )
    parser.add_argument(
        "--author", "-a",
        type=str,
        default="",
        help="教师姓名（可选）",
    )
    parser.add_argument(
        "--output", "-o",
        type=str,
        default=None,
        help="输出文件路径，默认在当前目录下生成「课题_教案.md」",
    )
    parser.add_argument(
        "--interactive", "-i",
        action="store_true",
        help="交互式输入模式",
    )

    return parser.parse_args()


def interactive_input():
    """
    交互式输入模式。
    逐项引导用户输入教案参数。
    """
    print("=" * 50)
    print("       教案生成脚本 - 交互式输入模式")
    print("=" * 50)
    print()

    config = {}
    config["subject"] = input(f"请输入学科名称（默认：{DEFAULT_CONFIG['subject']}）：").strip() or DEFAULT_CONFIG["subject"]
    config["grade"] = input(f"请输入年级（默认：{DEFAULT_CONFIG['grade']}）：").strip() or DEFAULT_CONFIG["grade"]
    config["topic"] = input(f"请输入课题名称（默认：{DEFAULT_CONFIG['topic']}）：").strip() or DEFAULT_CONFIG["topic"]

    print(f"\n可选课型：{' / '.join(LESSON_TYPES)}")
    type_input = input(f"请输入课型（默认：{DEFAULT_CONFIG['lesson_type']}）：").strip()
    config["lesson_type"] = type_input if type_input in LESSON_TYPES else DEFAULT_CONFIG["lesson_type"]

    duration_input = input(f"请输入课时长度/分钟（默认：{DEFAULT_CONFIG['duration']}）：").strip()
    config["duration"] = int(duration_input) if duration_input.isdigit() else DEFAULT_CONFIG["duration"]

    config["version"] = input(f"请输入教材版本（默认：{DEFAULT_CONFIG['version']}）：").strip() or DEFAULT_CONFIG["version"]
    config["author"] = input("请输入教师姓名（可选，直接回车跳过）：").strip()
    config["date"] = datetime.now().strftime("%Y-%m-%d")

    print()
    print("-" * 50)
    print("已确认的教案信息：")
    for key, label in [("subject", "学科"), ("grade", "年级"), ("topic", "课题"),
                        ("lesson_type", "课型"), ("duration", "课时"), ("version", "教材版本")]:
        print(f"  {label}：{config[key]}")
    print("-" * 50)

    confirm = input("\n确认生成教案？（回车确认，输入 n 取消）：").strip().lower()
    if confirm == "n":
        print("已取消生成。")
        sys.exit(0)

    return config


def main():
    """
    主程序入口。
    解析参数 → 组装教案 → 输出文件。
    """
    args = parse_args()

    # 交互模式或命令行模式
    if args.interactive:
        config = interactive_input()
    else:
        config = {
            "subject": args.subject,
            "grade": args.grade,
            "topic": args.topic,
            "lesson_type": args.type,
            "duration": args.duration,
            "version": args.version,
            "author": args.author,
            "date": datetime.now().strftime("%Y-%m-%d"),
        }

    # 生成教案内容
    print(f"\n正在生成教案：《{config['topic']}》...")
    lesson_plan = generate_lesson_plan(config)

    # 确定输出路径
    if args.output:
        output_path = args.output
    else:
        filename = f"{config['subject']}_{config['topic']}_教案.md"
        output_path = os.path.join(os.getcwd(), filename)

    # 确保输出目录存在
    output_dir = os.path.dirname(output_path)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    # 写入文件
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(lesson_plan)

    print(f"\n教案已生成：{output_path}")
    print(f"文件大小：{os.path.getsize(output_path)} 字节")
    print(f"包含九大模块：基本信息、教材分析、学情分析、教学目标、")
    print(f"              重难点、教学准备、教学过程、板书设计、教学反思")


if __name__ == "__main__":
    main()
