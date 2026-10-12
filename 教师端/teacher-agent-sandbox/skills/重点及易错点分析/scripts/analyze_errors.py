#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
易错点分析与管理工具
====================
本脚本用于对学科知识进行系统化的易错点分析与管理，支持：
  1. 接收参数（学科、年级、知识范围）生成易错点分析报告框架
  2. 按错因类型分类统计
  3. 输出结构化的 Markdown 格式分析报告
  4. 内置示例数据，可独立运行展示功能

使用方式：
  python analyze_errors.py --subject 数学 --grade 九年级 --scope "一元二次方程"
  python analyze_errors.py --demo
  python analyze_errors.py --list-subjects

作者：重点及易错点分析技能
版本：1.0.0
"""

import argparse
import json
import sys
from collections import Counter
from datetime import datetime
from typing import Dict, List, Optional, Any


# ============================================================
#  常量定义
# ============================================================

# 六大错因类型及其描述
ERROR_CAUSE_TYPES = {
    "concept_confusion": {
        "name": "概念混淆型",
        "description": "对相似概念区分不清，张冠李戴，导致知识运用错误",
        "manifestation": "将两个相似但不同的概念混为一谈，如把'平方根'与'算术平方根'等同",
        "strategy": "制作概念对比表，从定义、特征、适用范围等方面辨析异同",
    },
    "misreading": {
        "name": "审题不清型",
        "description": "漏读条件、误读题意或忽略关键限制，导致方向性错误",
        "manifestation": "遗漏题目中的隐含条件，或将'不正确的是'读成'正确的是'",
        "strategy": "采用划线标注法审题，建立审题清单，逐条核对已知条件",
    },
    "calculation": {
        "name": "计算失误型",
        "description": "符号错误、运算顺序错误、进退位错误等纯计算层面的问题",
        "manifestation": "去括号时忘记变号，或运算顺序颠倒导致结果错误",
        "strategy": "规范解题步骤，养成验算习惯，分步书写减少跳步",
    },
    "mindset": {
        "name": "思维定式型",
        "description": "套用旧方法处理新情境，缺乏灵活应变能力",
        "manifestation": "看到'最值'就配方法，忽略均值不等式等其他路径",
        "strategy": "开展变式训练，鼓励一题多解，打破单一思维路径",
    },
    "forgetting": {
        "name": "知识遗忘型",
        "description": "前置知识不牢固，导致新知识学习或运用时出现断层",
        "manifestation": "运用勾股定理时不会解一元二次方程，导致计算中断",
        "strategy": "定期进行知识链梳理，新课前做前置知识复习与检测",
    },
    "expression": {
        "name": "表达不规范型",
        "description": "解题过程跳步、格式错误、术语使用不当等表达层面的问题",
        "manifestation": "证明题中'因为所以'逻辑链断裂，或缺少必要的文字说明",
        "strategy": "提供规范解题模板，通过示范引领和反复训练形成习惯",
    },
}

# 支持的学科列表
SUPPORTED_SUBJECTS = [
    "语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理"
]

# 学段定义
GRADE_STAGES = {
    "小学": list(range(1, 7)),
    "初中": list(range(7, 10)),
    "高中": list(range(10, 13)),
}


# ============================================================
#  示例数据
# ============================================================

def get_sample_data() -> Dict[str, Any]:
    """
    返回内置的示例数据，用于演示脚本功能。
    示例以"九年级数学 - 一元二次方程"为分析对象。
    """
    return {
        "subject": "数学",
        "grade": "九年级",
        "scope": "一元二次方程",
        "purpose": "期末复习",
        "student_level": "普通班",
        "key_points": [
            {
                "name": "一元二次方程的定义",
                "importance": "整式方程识别的基础，判定方程类型的前提",
                "curriculum_standard": "理解一元二次方程的概念，能识别一元二次方程",
                "exam_style": "概念辨析题、方程识别题",
                "mastery_standard": "能准确判断一个方程是否为一元二次方程，能写出一般形式",
            },
            {
                "name": "求根公式与判别式",
                "importance": "解方程的核心工具，判断根的情况的关键依据",
                "curriculum_standard": "掌握求根公式，理解判别式的作用",
                "exam_style": "计算题、根的情况判断题、含参讨论题",
                "mastery_standard": "能熟练运用求根公式解方程，能用判别式判断根的情况",
            },
            {
                "name": "韦达定理（根与系数的关系）",
                "importance": "连接方程根与系数的桥梁，综合题的常考工具",
                "curriculum_standard": "了解根与系数的关系，能简单应用",
                "exam_style": "综合计算题、证明题",
                "mastery_standard": "能运用韦达定理求两根之和与两根之积，能处理简单综合题",
            },
        ],
        "error_points": [
            {
                "id": "E001",
                "name": "忽略二次项系数不为零的条件",
                "error_manifestation": "含参方程中未讨论二次项系数是否为零，直接按一元二次方程求解",
                "cause_analysis": "对一元二次方程定义中'a≠0'的条件理解不透彻，缺乏分类讨论意识",
                "correct_understanding": "一元二次方程的一般形式ax²+bx+c=0中，必须满足a≠0；若a可能为0，需分类讨论",
                "typical_error": "解方程(k-1)x²+2x+1=0时，直接用求根公式，未讨论k=1的情况",
                "correction_strategy": "强调定义中的隐含条件，建立'见参必讨论'的解题意识",
                "variant_training": "设计多组含参方程，要求先判断方程类型再求解",
                "cause_type": "concept_confusion",
            },
            {
                "id": "E002",
                "name": "求根公式中符号运用错误",
                "error_manifestation": "套用求根公式时，将'-b'写成'b'，或将'4ac'写成'-4ac'",
                "cause_analysis": "公式记忆不牢，对公式中各符号的含义理解不清",
                "correct_understanding": "求根公式x=(-b±√(b²-4ac))/2a，注意b前的负号和判别式中的减号",
                "typical_error": "解x²-5x+6=0时，写成x=(5±√(25-24))/2，漏掉了b前的负号",
                "correction_strategy": "推导公式来源，理解而非死记；做题时先写出a、b、c的值再代入",
                "variant_training": "反复练习不同系数的方程，强调先标a、b、c再代入的步骤",
                "cause_type": "calculation",
            },
            {
                "id": "E003",
                "name": "判别式运用时忽略前提条件",
                "error_manifestation": "使用判别式判断根的情况时，未先确认方程是一元二次方程",
                "cause_analysis": "审题不仔细，习惯性套用方法，忽略了使用判别式的前提是a≠0",
                "correct_understanding": "判别式Δ=b²-4ac仅在a≠0时有效；若a=0，方程退化为一元一次方程",
                "typical_error": "判断方程(k²-4)x²+(k+2)x+1=0根的情况时，直接计算Δ，未讨论k=±2",
                "correction_strategy": "建立解题流程：先确认方程类型→再选择方法→最后计算",
                "variant_training": "设计一组需要先分类讨论再使用判别式的综合题",
                "cause_type": "misreading",
            },
            {
                "id": "E004",
                "name": "韦达定理运用时符号错误",
                "error_manifestation": "运用韦达定理时，将x₁+x₂=-b/a写成b/a，或x₁·x₂=c/a写成-c/a",
                "cause_analysis": "公式记忆偏差，对韦达定理中符号的含义理解有误",
                "correct_understanding": "韦达定理：x₁+x₂=-b/a，x₁·x₂=c/a，注意和的符号有负号",
                "typical_error": "已知方程x²+3x-1=0的两根为x₁、x₂，求x₁+x₂时写成3而非-3",
                "correction_strategy": "通过具体方程验证韦达定理，加深对符号的理解",
                "variant_training": "设计多组方程，先求根再验证韦达定理，强化记忆",
                "cause_type": "calculation",
            },
            {
                "id": "E005",
                "name": "因式分解法解方程时遗漏根",
                "error_manifestation": "方程(x-2)(x+3)=0，只写出x=2，漏掉x=-3",
                "cause_analysis": "对'两数之积为零'的条件理解不完整，只考虑了一个因式为零",
                "correct_understanding": "若AB=0，则A=0或B=0，两个因式都要讨论，不能遗漏",
                "typical_error": "解方程x(x-5)=0时，只写出x=5，漏掉x=0",
                "correction_strategy": "强调'或'的含义，通过口诀'因式为零各有根'加深记忆",
                "variant_training": "设计三因式相乘的方程，训练不遗漏根的习惯",
                "cause_type": "concept_confusion",
            },
            {
                "id": "E006",
                "name": "配方法配方时常数项处理错误",
                "error_manifestation": "配方时只在一边加常数，或加了常数后忘记在等号另一边也加",
                "cause_analysis": "对配方法的原理理解不清，等式性质运用不当",
                "correct_understanding": "配方时等式两边同时加上一次项系数一半的平方，保持等式平衡",
                "typical_error": "将x²+6x+1=0配方时，写成(x+3)²=8而非(x+3)²=8",
                "correction_strategy": "讲清配方原理，强调等式两边同时操作的重要性",
                "variant_training": "从简单到复杂设计一组配方法练习，逐步提升难度",
                "cause_type": "calculation",
            },
            {
                "id": "E007",
                "name": "实际问题中忽略根的实际意义",
                "error_manifestation": "列方程解应用题时，求出两个根后未检验是否符合实际意义",
                "cause_analysis": "缺乏检验意识，将纯数学运算与实际情境割裂",
                "correct_understanding": "应用题中方程的根必须符合实际意义，如边长不能为负，人数必须为正整数",
                "typical_error": "求矩形边长时得出x=-2，仍作为答案写出",
                "correction_strategy": "养成'解完必验'的习惯，检验根是否满足实际条件",
                "variant_training": "设计含多余解的应用题，训练筛选符合实际意义的根",
                "cause_type": "mindset",
            },
            {
                "id": "E008",
                "name": "直接开平方法忽略正负两个根",
                "error_manifestation": "用直接开平方法解x²=9时，只写x=3，漏掉x=-3",
                "cause_analysis": "对平方根概念理解不完整，混淆了平方根与算术平方根",
                "correct_understanding": "正数有两个平方根，互为相反数；x²=a(a>0)则x=±√a",
                "typical_error": "解x²=25时，只写x=5，漏掉x=-5",
                "correction_strategy": "强调'开平方'与'求算术平方根'的区别，通过对比加深理解",
                "variant_training": "设计含隐含条件的题目，如x²+2x+1=4，训练完整求解",
                "cause_type": "concept_confusion",
            },
            {
                "id": "E009",
                "name": "分式方程转化后未检验增根",
                "error_manifestation": "将分式方程转化为一元二次方程求解后，未代入原方程检验增根",
                "cause_analysis": "对分式方程增根产生的原因不理解，缺乏检验习惯",
                "correct_understanding": "分式方程去分母后可能产生增根，必须将解代入原分式方程检验",
                "typical_error": "解方程1/(x-1)+2/(x+1)=1时，去分母后求解，未检验是否使分母为零",
                "correction_strategy": "讲清增根产生原因，强调检验是解分式方程的必要步骤",
                "variant_training": "设计会产生增根的题目，训练检验和取舍",
                "cause_type": "expression",
            },
            {
                "id": "E010",
                "name": "根的判别式计算中代值错误",
                "error_manifestation": "计算Δ=b²-4ac时，a、b、c的值代入错误",
                "cause_analysis": "对一般形式ax²+bx+c=0中各项系数的识别不熟练",
                "correct_understanding": "先化为一般形式，再按顺序标出a、b、c的值（含符号），最后代入",
                "typical_error": "方程2x²-3x+1=0中，将b写成3而非-3",
                "correction_strategy": "规范解题步骤：化一般式→标系数→代入公式",
                "variant_training": "设计含负系数的方程，训练带符号代入的习惯",
                "cause_type": "calculation",
            },
        ],
    }


# ============================================================
#  核心功能模块
# ============================================================

class ErrorAnalyzer:
    """易错点分析器，负责生成分析报告框架与统计"""

    def __init__(self, subject: str, grade: str, scope: str,
                 purpose: str = "日常教学", student_level: str = "普通班"):
        """
        初始化分析器

        参数：
            subject:       学科名称（如"数学"）
            grade:         年级（如"九年级"）
            scope:         知识范围（如"一元二次方程"）
            purpose:       分析目的（日常教学/单元复习/期末备考/中高考冲刺）
            student_level: 学生层次（普通班/重点班/分层教学）
        """
        self.subject = subject
        self.grade = grade
        self.scope = scope
        self.purpose = purpose
        self.student_level = student_level
        self.key_points: List[Dict] = []
        self.error_points: List[Dict] = []

    def add_key_point(self, name: str, importance: str,
                      curriculum_standard: str, exam_style: str,
                      mastery_standard: str) -> None:
        """添加一个重点知识"""
        self.key_points.append({
            "name": name,
            "importance": importance,
            "curriculum_standard": curriculum_standard,
            "exam_style": exam_style,
            "mastery_standard": mastery_standard,
        })

    def add_error_point(self, name: str, error_manifestation: str,
                        cause_analysis: str, correct_understanding: str,
                        typical_error: str, correction_strategy: str,
                        variant_training: str, cause_type: str) -> None:
        """
        添加一个易错点

        参数：
            name:                 易错点名称
            error_manifestation:  错误表现
            cause_analysis:       错因分析
            correct_understanding:正确理解
            typical_error:        典型错例
            correction_strategy: 纠错策略
            variant_training:     变式训练
            cause_type:           错因类型代码（见 ERROR_CAUSE_TYPES）
        """
        if cause_type not in ERROR_CAUSE_TYPES:
            raise ValueError(
                f"错因类型代码'{cause_type}'无效，"
                f"可选值：{list(ERROR_CAUSE_TYPES.keys())}"
            )
        point_id = f"E{len(self.error_points) + 1:03d}"
        self.error_points.append({
            "id": point_id,
            "name": name,
            "error_manifestation": error_manifestation,
            "cause_analysis": cause_analysis,
            "correct_understanding": correct_understanding,
            "typical_error": typical_error,
            "correction_strategy": correction_strategy,
            "variant_training": variant_training,
            "cause_type": cause_type,
        })

    def classify_by_cause(self) -> Dict[str, List[Dict]]:
        """按错因类型分类统计易错点"""
        result = {key: [] for key in ERROR_CAUSE_TYPES}
        for point in self.error_points:
            cause_type = point["cause_type"]
            if cause_type in result:
                result[cause_type].append(point)
        return result

    def get_cause_statistics(self) -> List[Dict[str, Any]]:
        """获取错因类型统计信息（按数量降序排列）"""
        counter = Counter(p["cause_type"] for p in self.error_points)
        total = len(self.error_points)
        stats = []
        for cause_code, count in counter.most_common():
            cause_info = ERROR_CAUSE_TYPES[cause_code]
            percentage = (count / total * 100) if total > 0 else 0
            stats.append({
                "cause_code": cause_code,
                "cause_name": cause_info["name"],
                "count": count,
                "percentage": round(percentage, 1),
                "strategy": cause_info["strategy"],
            })
        return stats

    def load_from_data(self, data: Dict[str, Any]) -> None:
        """从数据字典加载分析内容"""
        self.key_points = data.get("key_points", [])
        self.error_points = data.get("error_points", [])

    def generate_report(self) -> str:
        """
        生成完整的 Markdown 格式分析报告。
        报告包含七大模块：分析概述→知识结构→重点分析→易错分析→错因汇总→教学建议→附录。
        """
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        stats = self.get_cause_statistics()
        classified = self.classify_by_cause()

        lines = []
        # ---- 标题 ----
        lines.append(f"# {self.subject}易错点分析报告")
        lines.append(f"## {self.grade} · {self.scope}")
        lines.append("")
        lines.append(f"> 生成时间：{timestamp}  ")
        lines.append(f"> 分析目的：{self.purpose}  ")
        lines.append(f"> 学生层次：{self.student_level}")
        lines.append("")
        lines.append("---")
        lines.append("")

        # ---- 一、分析概述 ----
        lines.append("## 一、分析概述")
        lines.append("")
        lines.append(f"| 项目 | 内容 |")
        lines.append(f"|------|------|")
        lines.append(f"| 学科 | {self.subject} |")
        lines.append(f"| 年级 | {self.grade} |")
        lines.append(f"| 知识范围 | {self.scope} |")
        lines.append(f"| 分析目的 | {self.purpose} |")
        lines.append(f"| 学生层次 | {self.student_level} |")
        lines.append(f"| 重点知识数量 | {len(self.key_points)} 个 |")
        lines.append(f"| 易错点数量 | {len(self.error_points)} 个 |")
        lines.append(f"| 错因类型覆盖 | {len(stats)} 种 |")
        lines.append("")
        lines.append("**分析说明：**")
        lines.append("")
        lines.append(f"本报告针对{self.grade}{self.subject}"
                      f"「{self.scope}」部分进行系统化的重点提炼与易错点分析，"
                      f"共梳理重点知识{len(self.key_points)}个、易错点"
                      f"{len(self.error_points)}个，按{len(stats)}种错因类型分类汇总，"
                      f"并给出针对性的教学建议。")
        lines.append("")
        lines.append("---")
        lines.append("")

        # ---- 二、知识结构 ----
        lines.append("## 二、知识结构")
        lines.append("")
        lines.append("### 2.1 知识体系概览")
        lines.append("")
        lines.append("```")
        lines.append(f"  {self.scope}")
        lines.append("  │")
        for i, kp in enumerate(self.key_points):
            prefix = "├──" if i < len(self.key_points) - 1 else "└──"
            lines.append(f"  {prefix} {kp['name']}")
        lines.append("```")
        lines.append("")
        lines.append("### 2.2 知识逻辑关系")
        lines.append("")
        lines.append("| 序号 | 知识点 | 逻辑关系说明 |")
        lines.append("|------|--------|------------|")
        for i, kp in enumerate(self.key_points, 1):
            lines.append(f"| {i} | {kp['name']} | {kp['importance']} |")
        lines.append("")
        lines.append("---")
        lines.append("")

        # ---- 三、重点知识分析 ----
        lines.append("## 三、重点知识分析")
        lines.append("")
        for i, kp in enumerate(self.key_points, 1):
            lines.append(f"### 重点知识 {i}：{kp['name']}")
            lines.append("")
            lines.append(f"- **重要性说明：** {kp['importance']}")
            lines.append(f"- **课标要求：** {kp['curriculum_standard']}")
            lines.append(f"- **考查方式：** {kp['exam_style']}")
            lines.append(f"- **掌握标准：** {kp['mastery_standard']}")
            lines.append("")
        lines.append("---")
        lines.append("")

        # ---- 四、易错点分析 ----
        lines.append("## 四、易错点分析")
        lines.append("")
        lines.append(f"本部分共分析 {len(self.error_points)} 个易错点，"
                      f"每条均包含六要素：错误表现→错因分析→正确理解→典型错例→纠错策略→变式训练。")
        lines.append("")
        for i, ep in enumerate(self.error_points, 1):
            cause_name = ERROR_CAUSE_TYPES[ep["cause_type"]]["name"]
            lines.append(f"### 易错点 {i}：{ep['name']}")
            lines.append("")
            lines.append(f"> 错因类型：{cause_name}  ")
            lines.append(f"> 编号：{ep['id']}")
            lines.append("")
            lines.append(f"- **■ 错误表现：** {ep['error_manifestation']}")
            lines.append(f"- **■ 错因分析：** {ep['cause_analysis']}")
            lines.append(f"- **■ 正确理解：** {ep['correct_understanding']}")
            lines.append(f"- **■ 典型错例：** {ep['typical_error']}")
            lines.append(f"- **■ 纠错策略：** {ep['correction_strategy']}")
            lines.append(f"- **■ 变式训练：** {ep['variant_training']}")
            lines.append("")
        lines.append("---")
        lines.append("")

        # ---- 五、错因分类汇总 ----
        lines.append("## 五、错因分类汇总")
        lines.append("")
        lines.append("### 5.1 错因分布统计")
        lines.append("")
        lines.append("| 排名 | 错因类型 | 数量 | 占比 | 防范策略 |")
        lines.append("|------|---------|------|------|---------|")
        for rank, s in enumerate(stats, 1):
            lines.append(
                f"| {rank} | {s['cause_name']} | {s['count']} | "
                f"{s['percentage']}% | {s['strategy']} |"
            )
        lines.append("")
        lines.append("### 5.2 分类详情")
        lines.append("")
        for cause_code, cause_info in ERROR_CAUSE_TYPES.items():
            points_in_category = classified.get(cause_code, [])
            if not points_in_category:
                continue
            lines.append(f"#### {cause_info['name']}（{len(points_in_category)}个）")
            lines.append("")
            lines.append(f"- **典型表现：** {cause_info['manifestation']}")
            lines.append(f"- **防范策略：** {cause_info['strategy']}")
            lines.append(f"- **涉及易错点：**")
            for p in points_in_category:
                lines.append(f"  - {p['id']} {p['name']}")
            lines.append("")
        lines.append("---")
        lines.append("")

        # ---- 六、教学建议 ----
        lines.append("## 六、教学建议")
        lines.append("")
        lines.append("### 6.1 教学优先级排序")
        lines.append("")
        lines.append("| 优先级 | 类别 | 内容 |")
        lines.append("|--------|------|------|")
        lines.append("| ★★★ 必须掌握 | 核心重点 | "
                      + "、".join(kp["name"] for kp in self.key_points[:3]) + " |")
        top_errors = sorted(self.error_points,
                            key=lambda x: x["cause_type"])[:3]
        lines.append("| ★★ 重点突破 | 高频易错 | "
                      + "、".join(ep["name"] for ep in top_errors) + " |")
        lines.append("| ★ 了解拓展 | 次要内容 | 根据学情灵活安排 |")
        lines.append("")

        lines.append("### 6.2 课堂教学策略建议")
        lines.append("")
        if stats:
            top_cause = stats[0]
            lines.append(
                f"1. **针对{top_cause['cause_name']}（占比{top_cause['percentage']}%）：**"
                f" {top_cause['strategy']}"
            )
        for s in stats[1:]:
            lines.append(
                f"2. **针对{s['cause_name']}（占比{s['percentage']}%）：**"
                f" {s['strategy']}"
            )
        lines.append("")

        lines.append("### 6.3 复习与练习建议")
        lines.append("")
        lines.append("- **复习时间分配：** 重点知识60%，易错纠正30%，综合提升10%")
        lines.append("- **推荐复习流程：** 知识梳理 → 错题回顾 → 变式训练 → 综合检测")
        lines.append("- **考前提醒清单：**")
        for ep in self.error_points[:5]:
            lines.append(f"  - [ ] {ep['name']}：{ep['correction_strategy']}")
        lines.append("")
        lines.append("---")
        lines.append("")

        # ---- 七、附录 ----
        lines.append("## 七、附录")
        lines.append("")
        lines.append("### 附录A：易错点速查表")
        lines.append("")
        lines.append("| 编号 | 易错点名称 | 错因类型 |")
        lines.append("|------|-----------|---------|")
        for ep in self.error_points:
            cause_name = ERROR_CAUSE_TYPES[ep["cause_type"]]["name"]
            lines.append(f"| {ep['id']} | {ep['name']} | {cause_name} |")
        lines.append("")
        lines.append("### 附录B：推荐练习方向")
        lines.append("")
        for ep in self.error_points:
            lines.append(f"- **{ep['name']}：** {ep['variant_training']}")
        lines.append("")
        lines.append("### 附录C：考前注意事项")
        lines.append("")
        lines.append("1. 解题前先确认方程类型，再选择合适的方法")
        lines.append("2. 计算时先标出a、b、c的值（含符号），再代入公式")
        lines.append("3. 解完方程后必须检验：数学检验（代入原方程）+ 实际检验（是否符合题意）")
        lines.append("4. 应用题求出根后，务必检验是否符合实际意义")
        lines.append("5. 分式方程必须检验增根")
        lines.append("")
        lines.append("---")
        lines.append("")
        lines.append("*本报告由「重点及易错点分析」技能自动生成，供教学参考使用。*")
        lines.append("")

        return "\n".join(lines)


# ============================================================
#  命令行接口
# ============================================================

def build_arg_parser() -> argparse.ArgumentParser:
    """构建命令行参数解析器"""
    parser = argparse.ArgumentParser(
        description="易错点分析与管理工具 — 生成结构化的重点与易错点分析报告",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用示例：
  # 使用示例数据生成报告
  python analyze_errors.py --demo

  # 指定学科、年级、知识范围生成报告框架
  python analyze_errors.py --subject 数学 --grade 九年级 --scope "一元二次方程"

  # 生成报告并保存到文件
  python analyze_errors.py --demo --output report.md

  # 查看支持的学科列表
  python analyze_errors.py --list-subjects

  # 查看错因分类体系
  python analyze_errors.py --list-causes
        """,
    )
    parser.add_argument(
        "--subject", type=str, default="",
        help="学科名称（如：数学、物理、化学等）",
    )
    parser.add_argument(
        "--grade", type=str, default="",
        help="年级（如：九年级、高一）",
    )
    parser.add_argument(
        "--scope", type=str, default="",
        help="知识范围（如：一元二次方程、电学综合）",
    )
    parser.add_argument(
        "--purpose", type=str, default="日常教学",
        help="分析目的（日常教学/单元复习/期末备考/中高考冲刺）",
    )
    parser.add_argument(
        "--student-level", type=str, default="普通班",
        help="学生层次（普通班/重点班/分层教学）",
    )
    parser.add_argument(
        "--demo", action="store_true",
        help="使用内置示例数据生成完整报告",
    )
    parser.add_argument(
        "--output", "-o", type=str, default="",
        help="输出文件路径（不指定则打印到屏幕）",
    )
    parser.add_argument(
        "--list-subjects", action="store_true",
        help="列出支持的学科",
    )
    parser.add_argument(
        "--list-causes", action="store_true",
        help="列出错因分类体系",
    )
    parser.add_argument(
        "--json", action="store_true",
        help="以JSON格式输出统计结果",
    )
    return parser


def print_supported_subjects() -> None:
    """打印支持的学科列表"""
    print("=" * 50)
    print("支持的学科列表")
    print("=" * 50)
    for i, subject in enumerate(SUPPORTED_SUBJECTS, 1):
        print(f"  {i}. {subject}")
    print()
    print("学段划分：")
    for stage, grades in GRADE_STAGES.items():
        grade_str = "、".join(str(g) for g in grades)
        print(f"  {stage}：{grade_str}年级")


def print_cause_types() -> None:
    """打印错因分类体系"""
    print("=" * 60)
    print("错因分类体系（六大类型）")
    print("=" * 60)
    for i, (code, info) in enumerate(ERROR_CAUSE_TYPES.items(), 1):
        print()
        print(f"  {i}. 【{info['name']}】（代码：{code}）")
        print(f"     定义：{info['description']}")
        print(f"     典型表现：{info['manifestation']}")
        print(f"     防范策略：{info['strategy']}")
    print()


def run_demo(json_output: bool = False) -> str:
    """使用示例数据运行分析并返回报告"""
    data = get_sample_data()
    analyzer = ErrorAnalyzer(
        subject=data["subject"],
        grade=data["grade"],
        scope=data["scope"],
        purpose=data.get("purpose", "期末复习"),
        student_level=data.get("student_level", "普通班"),
    )
    analyzer.load_from_data(data)

    if json_output:
        result = {
            "subject": analyzer.subject,
            "grade": analyzer.grade,
            "scope": analyzer.scope,
            "key_points_count": len(analyzer.key_points),
            "error_points_count": len(analyzer.error_points),
            "cause_statistics": analyzer.get_cause_statistics(),
            "error_points": [
                {
                    "id": ep["id"],
                    "name": ep["name"],
                    "cause_type": ep["cause_type"],
                    "cause_name": ERROR_CAUSE_TYPES[ep["cause_type"]]["name"],
                }
                for ep in analyzer.error_points
            ],
        }
        return json.dumps(result, ensure_ascii=False, indent=2)

    return analyzer.generate_report()


def generate_framework(subject: str, grade: str, scope: str,
                       purpose: str, student_level: str) -> str:
    """
    根据用户输入的参数生成报告框架（不含具体数据，仅结构模板）。
    """
    analyzer = ErrorAnalyzer(subject, grade, scope, purpose, student_level)
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")

    lines = []
    lines.append(f"# {subject}易错点分析报告")
    lines.append(f"## {grade} · {scope}")
    lines.append("")
    lines.append(f"> 生成时间：{timestamp}  ")
    lines.append(f"> 分析目的：{purpose}  ")
    lines.append(f"> 学生层次：{student_level}")
    lines.append("")
    lines.append("---")
    lines.append("")

    # 一、分析概述
    lines.append("## 一、分析概述")
    lines.append("")
    lines.append("| 项目 | 内容 |")
    lines.append("|------|------|")
    lines.append(f"| 学科 | {subject} |")
    lines.append(f"| 年级 | {grade} |")
    lines.append(f"| 知识范围 | {scope} |")
    lines.append(f"| 分析目的 | {purpose} |")
    lines.append(f"| 学生层次 | {student_level} |")
    lines.append("| 重点知识数量 | （待填写） |")
    lines.append("| 易错点数量 | （待填写） |")
    lines.append("")
    lines.append("**分析说明：**")
    lines.append("")
    lines.append(f"> 请在此处填写{grade}{subject}「{scope}」部分的分析背景、"
                  f"学情概况与分析目标。")
    lines.append("")
    lines.append("---")
    lines.append("")

    # 二、知识结构
    lines.append("## 二、知识结构")
    lines.append("")
    lines.append("### 2.1 知识体系概览")
    lines.append("")
    lines.append("```")
    lines.append(f"  {scope}")
    lines.append("  │")
    lines.append("  ├── （知识点1）")
    lines.append("  ├── （知识点2）")
    lines.append("  └── （知识点3）")
    lines.append("```")
    lines.append("")
    lines.append("### 2.2 知识逻辑关系")
    lines.append("")
    lines.append("| 序号 | 知识点 | 逻辑关系说明 |")
    lines.append("|------|--------|------------|")
    lines.append("| 1 | （待填写） | （待填写） |")
    lines.append("| 2 | （待填写） | （待填写） |")
    lines.append("")
    lines.append("---")
    lines.append("")

    # 三、重点知识分析
    lines.append("## 三、重点知识分析")
    lines.append("")
    lines.append("### 重点知识 1：（待填写）")
    lines.append("")
    lines.append("- **重要性说明：** （待填写）")
    lines.append("- **课标要求：** （待填写）")
    lines.append("- **考查方式：** （待填写）")
    lines.append("- **掌握标准：** （待填写）")
    lines.append("")
    lines.append("### 重点知识 2：（待填写）")
    lines.append("")
    lines.append("- **重要性说明：** （待填写）")
    lines.append("- **课标要求：** （待填写）")
    lines.append("- **考查方式：** （待填写）")
    lines.append("- **掌握标准：** （待填写）")
    lines.append("")
    lines.append("---")
    lines.append("")

    # 四、易错点分析
    lines.append("## 四、易错点分析")
    lines.append("")
    lines.append("### 易错点 1：（待填写）")
    lines.append("")
    lines.append("> 错因类型：（概念混淆型/审题不清型/计算失误型/思维定式型/知识遗忘型/表达不规范型）")
    lines.append("")
    lines.append("- **■ 错误表现：** （待填写）")
    lines.append("- **■ 错因分析：** （待填写）")
    lines.append("- **■ 正确理解：** （待填写）")
    lines.append("- **■ 典型错例：** （待填写）")
    lines.append("- **■ 纠错策略：** （待填写）")
    lines.append("- **■ 变式训练：** （待填写）")
    lines.append("")
    lines.append("### 易错点 2：（待填写）")
    lines.append("")
    lines.append("> 错因类型：（请选择）")
    lines.append("")
    lines.append("- **■ 错误表现：** （待填写）")
    lines.append("- **■ 错因分析：** （待填写）")
    lines.append("- **■ 正确理解：** （待填写）")
    lines.append("- **■ 典型错例：** （待填写）")
    lines.append("- **■ 纠错策略：** （待填写）")
    lines.append("- **■ 变式训练：** （待填写）")
    lines.append("")
    lines.append("---")
    lines.append("")

    # 五、错因分类汇总
    lines.append("## 五、错因分类汇总")
    lines.append("")
    lines.append("### 5.1 错因分布统计")
    lines.append("")
    lines.append("| 排名 | 错因类型 | 数量 | 占比 | 防范策略 |")
    lines.append("|------|---------|------|------|---------|")
    lines.append("| 1 | （待填写） | （待填写） | （待填写） | （待填写） |")
    lines.append("| 2 | （待填写） | （待填写） | （待填写） | （待填写） |")
    lines.append("")
    lines.append("### 5.2 分类详情")
    lines.append("")
    lines.append("#### （错因类型名称）（数量个）")
    lines.append("")
    lines.append("- **典型表现：** （待填写）")
    lines.append("- **防范策略：** （待填写）")
    lines.append("- **涉及易错点：**")
    lines.append("  - （待填写）")
    lines.append("")
    lines.append("---")
    lines.append("")

    # 六、教学建议
    lines.append("## 六、教学建议")
    lines.append("")
    lines.append("### 6.1 教学优先级排序")
    lines.append("")
    lines.append("| 优先级 | 类别 | 内容 |")
    lines.append("|--------|------|------|")
    lines.append("| ★★★ 必须掌握 | 核心重点 | （待填写） |")
    lines.append("| ★★ 重点突破 | 高频易错 | （待填写） |")
    lines.append("| ★ 了解拓展 | 次要内容 | （待填写） |")
    lines.append("")
    lines.append("### 6.2 课堂教学策略建议")
    lines.append("")
    lines.append("1. （待填写）")
    lines.append("2. （待填写）")
    lines.append("")
    lines.append("### 6.3 复习与练习建议")
    lines.append("")
    lines.append("- **复习时间分配：** 重点知识60%，易错纠正30%，综合提升10%")
    lines.append("- **推荐复习流程：** 知识梳理 → 错题回顾 → 变式训练 → 综合检测")
    lines.append("- **考前提醒清单：**")
    lines.append("  - [ ] （待填写）")
    lines.append("")
    lines.append("---")
    lines.append("")

    # 七、附录
    lines.append("## 七、附录")
    lines.append("")
    lines.append("### 附录A：易错点速查表")
    lines.append("")
    lines.append("| 编号 | 易错点名称 | 错因类型 |")
    lines.append("|------|-----------|---------|")
    lines.append("| E001 | （待填写） | （待填写） |")
    lines.append("")
    lines.append("### 附录B：推荐练习方向")
    lines.append("")
    lines.append("- （待填写）")
    lines.append("")
    lines.append("### 附录C：考前注意事项")
    lines.append("")
    lines.append("1. （待填写）")
    lines.append("2. （待填写）")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("*本报告由「重点及易错点分析」技能自动生成框架，请根据实际教学情况填写具体内容。*")
    lines.append("")

    return "\n".join(lines)


def main():
    """主函数：解析命令行参数并执行相应操作"""
    parser = build_arg_parser()
    args = parser.parse_args()

    # 列出支持的学科
    if args.list_subjects:
        print_supported_subjects()
        return

    # 列出错因分类体系
    if args.list_causes:
        print_cause_types()
        return

    # 使用示例数据
    if args.demo:
        report = run_demo(json_output=args.json)
        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(report)
            print(f"报告已保存到：{args.output}")
        else:
            print(report)
        return

    # 根据参数生成报告框架
    if args.subject and args.grade and args.scope:
        report = generate_framework(
            subject=args.subject,
            grade=args.grade,
            scope=args.scope,
            purpose=args.purpose,
            student_level=args.student_level,
        )
        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(report)
            print(f"报告框架已保存到：{args.output}")
        else:
            print(report)
        return

    # 未提供足够参数，显示帮助
    print()
    print("=" * 60)
    print("  易错点分析与管理工具")
    print("=" * 60)
    print()
    print("  请选择运行模式：")
    print()
    print("  1. 使用示例数据生成完整报告：")
    print("     python analyze_errors.py --demo")
    print()
    print("  2. 指定参数生成报告框架：")
    print("     python analyze_errors.py --subject 数学 --grade 九年级 --scope \"一元二次方程\"")
    print()
    print("  3. 查看支持的学科：")
    print("     python analyze_errors.py --list-subjects")
    print()
    print("  4. 查看错因分类体系：")
    print("     python analyze_errors.py --list-causes")
    print()
    print("  5. 保存报告到文件：")
    print("     python analyze_errors.py --demo --output report.md")
    print()
    print("  6. JSON格式输出统计：")
    print("     python analyze_errors.py --demo --json")
    print()
    print("  详细帮助请运行：python analyze_errors.py --help")
    print()


if __name__ == "__main__":
    main()
