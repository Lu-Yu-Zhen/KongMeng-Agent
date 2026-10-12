#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
学生学情分析脚本
==================
功能：接收学生成绩数据，进行多维度学情分析，生成 Markdown 格式学情诊断报告。

支持分析维度：
  1. 成绩维度（总分、平均分、排名、及格率、优秀率、标准差、得分率）
  2. 知识维度（知识点掌握率、薄弱点定位）
  3. 能力维度（识记/理解/应用/分析/综合/评价六层能力分析）
  4. 题型维度（各题型得分率分析）
  5. 趋势维度（历次成绩对比、进退步分析）
  6. 个体维度（分层分类分析）

使用方式：
  方式一（命令行参数）：python analyze_student.py --name "张三" --subject "数学" --exam "期中考试" --data data.json
  方式二（内置示例）：  python analyze_student.py --demo

作者：学情分析技能
日期：2025年
"""

import argparse
import json
import math
import sys
import os
from datetime import datetime


# =============================================================================
# 一、数据结构定义
# =============================================================================

class StudentData:
    """学生成绩数据结构"""

    def __init__(self, name, class_name, subject, exam_name, total_score,
                 questions, history=None, rank=None, total_students=None):
        """
        初始化学生数据

        参数:
            name: 学生姓名
            class_name: 班级名称
            subject: 学科
            exam_name: 考试名称
            total_score: 试卷满分
            questions: 题目数据列表，每道题包含:
                       - 题号 (int)
                       - 题型 (str): 选择题/填空题/解答题等
                       - 满分 (float)
                       - 得分 (float)
                       - 知识点 (list[str]): 该题考查的知识点列表
                       - 能力层级 (str): 识记/理解/应用/分析/综合/评价
            history: 历史成绩列表，每条包含:
                     - 考试 (str)
                     - 得分 (float)
                     - 排名 (int, 可选)
            rank: 本次考试排名
            total_students: 班级总人数
        """
        self.name = name
        self.class_name = class_name
        self.subject = subject
        self.exam_name = exam_name
        self.total_score = total_score
        self.questions = questions
        self.history = history or []
        self.rank = rank
        self.total_students = total_students
        self.analyze_date = datetime.now().strftime("%Y年%m月%d日")

    def actual_score(self):
        """计算实际得分（所有题目得分之和）"""
        return sum(q["得分"] for q in self.questions)

    def score_rate(self):
        """计算得分率"""
        if self.total_score == 0:
            return 0.0
        return self.actual_score() / self.total_score * 100


# =============================================================================
# 二、成绩维度分析
# =============================================================================

class ScoreAnalyzer:
    """成绩维度分析器"""

    def __init__(self, student_data):
        self.data = student_data

    def get_total_score(self):
        """获取实际总分"""
        return self.data.actual_score()

    def get_score_rate(self):
        """获取得分率"""
        return self.data.score_rate()

    def get_average_per_question(self):
        """计算每题平均分"""
        if not self.data.questions:
            return 0.0
        return self.get_total_score() / len(self.data.questions)

    def get_pass_status(self):
        """判断及格状态（得分率>=60%为及格）"""
        rate = self.get_score_rate()
        if rate >= 60:
            return "及格"
        return "不及格"

    def get_excellent_status(self):
        """判断优秀状态（得分率>=85%为优秀）"""
        rate = self.get_score_rate()
        if rate >= 85:
            return "优秀"
        return "非优秀"

    def get_question_score_rates(self):
        """计算每道题的得分率"""
        rates = []
        for q in self.data.questions:
            rate = q["得分"] / q["满分"] * 100 if q["满分"] > 0 else 0
            rates.append({
                "题号": q["题号"],
                "题型": q["题型"],
                "满分": q["满分"],
                "得分": q["得分"],
                "得分率": round(rate, 1)
            })
        return rates

    def get_score_summary(self):
        """生成成绩概要"""
        return {
            "总分": self.get_total_score(),
            "满分": self.data.total_score,
            "得分率": round(self.get_score_rate(), 1),
            "每题平均分": round(self.get_average_per_question(), 2),
            "及格状态": self.get_pass_status(),
            "优秀状态": self.get_excellent_status(),
            "排名": self.data.rank,
            "总人数": self.data.total_students
        }


# =============================================================================
# 三、知识维度分析
# =============================================================================

class KnowledgeAnalyzer:
    """知识维度分析器"""

    # 掌握率分级标准
    LEVEL_STANDARDS = [
        (85, "优秀", "知识点掌握扎实"),
        (70, "良好", "基本掌握，可进一步提升"),
        (60, "一般", "掌握不牢固，需巩固"),
        (40, "薄弱", "掌握不足，需重点补救"),
        (0, "盲区", "严重欠缺，需系统重学")
    ]

    def __init__(self, student_data):
        self.data = student_data

    def get_knowledge_stats(self):
        """按知识点分类统计得分率"""
        knowledge_data = {}  # 知识点 -> {"满分": , "得分": , "题目数": }

        for q in self.data.questions:
            for kp in q.get("知识点", []):
                if kp not in knowledge_data:
                    knowledge_data[kp] = {"满分": 0, "得分": 0, "题目数": 0}
                knowledge_data[kp]["满分"] += q["满分"]
                knowledge_data[kp]["得分"] += q["得分"]
                knowledge_data[kp]["题目数"] += 1

        results = []
        for kp, data in knowledge_data.items():
            rate = data["得分"] / data["满分"] * 100 if data["满分"] > 0 else 0
            level, desc = self._get_level(rate)
            results.append({
                "知识点": kp,
                "满分": data["满分"],
                "得分": round(data["得分"], 1),
                "得分率": round(rate, 1),
                "掌握等级": level,
                "等级说明": desc,
                "涉及题数": data["题目数"]
            })

        # 按得分率升序排列（薄弱的排在前面）
        results.sort(key=lambda x: x["得分率"])
        return results

    def _get_level(self, rate):
        """根据得分率判定掌握等级"""
        for threshold, level, desc in self.LEVEL_STANDARDS:
            if rate >= threshold:
                return level, desc
        return "盲区", "严重欠缺，需系统重学"

    def get_weak_points(self):
        """获取薄弱知识点（得分率<60%）"""
        stats = self.get_knowledge_stats()
        return [s for s in stats if s["得分率"] < 60]

    def get_blind_spots(self):
        """获取知识盲区（得分率<40%）"""
        stats = self.get_knowledge_stats()
        return [s for s in stats if s["得分率"] < 40]


# =============================================================================
# 四、能力维度分析
# =============================================================================

class AbilityAnalyzer:
    """能力维度分析器（布鲁姆六层能力模型）"""

    # 六大能力层级
    ABILITY_LEVELS = ["识记", "理解", "应用", "分析", "综合", "评价"]

    def __init__(self, student_data):
        self.data = student_data

    def get_ability_stats(self):
        """按能力层级分类统计得分率"""
        ability_data = {}
        for level in self.ABILITY_LEVELS:
            ability_data[level] = {"满分": 0, "得分": 0, "题目数": 0}

        for q in self.data.questions:
            level = q.get("能力层级", "识记")
            if level not in ability_data:
                ability_data[level] = {"满分": 0, "得分": 0, "题目数": 0}
            ability_data[level]["满分"] += q["满分"]
            ability_data[level]["得分"] += q["得分"]
            ability_data[level]["题目数"] += 1

        results = []
        for level in self.ABILITY_LEVELS:
            data = ability_data[level]
            if data["满分"] > 0:
                rate = data["得分"] / data["满分"] * 100
                results.append({
                    "能力层级": level,
                    "满分": data["满分"],
                    "得分": round(data["得分"], 1),
                    "得分率": round(rate, 1),
                    "题目数": data["题目数"]
                })
        return results

    def get_weak_abilities(self):
        """获取薄弱能力（得分率<60%）"""
        stats = self.get_ability_stats()
        return [s for s in stats if s["得分率"] < 60]

    def get_ability_profile(self):
        """生成能力画像描述"""
        stats = self.get_ability_stats()
        if not stats:
            return "无能力数据"

        # 找出最强和最弱能力
        sorted_stats = sorted(stats, key=lambda x: x["得分率"])
        weakest = sorted_stats[0]
        strongest = sorted_stats[-1]

        profile = f"最薄弱能力：{weakest['能力层级']}（得分率{weakest['得分率']}%）；"
        profile += f"最强能力：{strongest['能力层级']}（得分率{strongest['得分率']}%）"
        return profile


# =============================================================================
# 五、题型维度分析
# =============================================================================

class QuestionTypeAnalyzer:
    """题型维度分析器"""

    def __init__(self, student_data):
        self.data = student_data

    def get_type_stats(self):
        """按题型分类统计得分率"""
        type_data = {}
        for q in self.data.questions:
            qtype = q.get("题型", "其他")
            if qtype not in type_data:
                type_data[qtype] = {"满分": 0, "得分": 0, "题目数": 0}
            type_data[qtype]["满分"] += q["满分"]
            type_data[qtype]["得分"] += q["得分"]
            type_data[qtype]["题目数"] += 1

        results = []
        for qtype, data in type_data.items():
            rate = data["得分"] / data["满分"] * 100 if data["满分"] > 0 else 0
            results.append({
                "题型": qtype,
                "满分": data["满分"],
                "得分": round(data["得分"], 1),
                "得分率": round(rate, 1),
                "题目数": data["题目数"]
            })

        # 按得分率升序排列
        results.sort(key=lambda x: x["得分率"])
        return results

    def get_weak_types(self):
        """获取薄弱题型（得分率<60%）"""
        stats = self.get_type_stats()
        return [s for s in stats if s["得分率"] < 60]


# =============================================================================
# 六、趋势维度分析
# =============================================================================

class TrendAnalyzer:
    """趋势维度分析器"""

    def __init__(self, student_data):
        self.data = student_data

    def get_trend_analysis(self):
        """分析成绩趋势"""
        history = self.data.history
        current_score = self.data.actual_score()
        current_rank = self.data.rank

        if not history:
            return {
                "可用": False,
                "说明": "无历史成绩数据，无法进行趋势分析"
            }

        # 添加当前成绩到历史序列
        all_records = list(history)
        all_records.append({
            "考试": self.data.exam_name,
            "得分": current_score,
            "排名": current_rank
        })

        # 计算变化趋势
        comparisons = []
        for i in range(1, len(all_records)):
            prev = all_records[i - 1]
            curr = all_records[i]
            score_change = curr["得分"] - prev["得分"]

            # 排名变化（注意：排名下降是正数表示退步）
            rank_change = None
            if prev.get("排名") and curr.get("排名"):
                rank_change = prev["排名"] - curr["排名"]  # 正数=进步，负数=退步

            trend = self._judge_trend(score_change, rank_change)

            comparisons.append({
                "上次考试": prev["考试"],
                "上次得分": prev["得分"],
                "本次考试": curr["考试"],
                "本次得分": curr["得分"],
                "分数变化": score_change,
                "排名变化": rank_change,
                "趋势判定": trend
            })

        # 稳定性分析
        scores = [r["得分"] for r in all_records]
        if len(scores) >= 2:
            avg = sum(scores) / len(scores)
            variance = sum((s - avg) ** 2 for s in scores) / len(scores)
            std = math.sqrt(variance)
            stability = self._judge_stability(std, avg)
        else:
            std = 0
            stability = "数据不足，无法判断"

        return {
            "可用": True,
            "历次成绩": all_records,
            "变化对比": comparisons,
            "平均分": round(avg, 1) if len(scores) >= 2 else current_score,
            "标准差": round(std, 2),
            "稳定性": stability
        }

    def _judge_trend(self, score_change, rank_change):
        """判定进退步趋势"""
        # 以得分率变化为主要判断依据
        # 假设满分不变，用分数变化近似得分率变化
        # 排名变化为辅助判断

        if rank_change is not None:
            # 有排名数据时综合判断
            if rank_change >= 5 or score_change >= 10:
                return "显著进步"
            elif rank_change >= 1 or score_change >= 5:
                return "稳中有进"
            elif rank_change <= -5 or score_change <= -10:
                return "显著退步"
            elif rank_change <= -1 or score_change <= -5:
                return "略有退步"
            else:
                return "保持稳定"
        else:
            # 无排名数据时仅按分数变化判断
            if score_change >= 10:
                return "显著进步"
            elif score_change >= 5:
                return "稳中有进"
            elif score_change <= -10:
                return "显著退步"
            elif score_change <= -5:
                return "略有退步"
            else:
                return "保持稳定"

    def _judge_stability(self, std, avg):
        """判定成绩稳定性"""
        if avg == 0:
            return "无法判断"
        cv = std / avg * 100  # 变异系数
        if cv < 5:
            return "高度稳定"
        elif cv < 10:
            return "较为稳定"
        elif cv < 15:
            return "波动较大"
        else:
            return "很不稳定"


# =============================================================================
# 七、报告生成器
# =============================================================================

class ReportGenerator:
    """学情诊断报告生成器（Markdown格式）"""

    def __init__(self, student_data):
        self.data = student_data
        self.score_analyzer = ScoreAnalyzer(student_data)
        self.knowledge_analyzer = KnowledgeAnalyzer(student_data)
        self.ability_analyzer = AbilityAnalyzer(student_data)
        self.type_analyzer = QuestionTypeAnalyzer(student_data)
        self.trend_analyzer = TrendAnalyzer(student_data)

    def generate(self):
        """生成完整的 Markdown 学情分析报告"""
        lines = []
        lines.append(self._generate_header())
        lines.append(self._generate_basic_info())
        lines.append(self._generate_score_overview())
        lines.append(self._generate_knowledge_analysis())
        lines.append(self._generate_ability_analysis())
        lines.append(self._generate_type_analysis())
        lines.append(self._generate_weakness_diagnosis())
        lines.append(self._generate_trend_analysis())
        lines.append(self._generate_teaching_suggestions())
        lines.append(self._generate_footer())
        return "\n".join(lines)

    def _generate_header(self):
        """生成报告标题"""
        return f"""# 学情诊断报告

> 本报告由学情分析系统自动生成，基于多维度数据分析，仅供教学参考。

---

"""

    def _generate_basic_info(self):
        """生成基本信息"""
        d = self.data
        rank_info = f"{d.rank}/{d.total_students}" if d.rank and d.total_students else "未提供"
        return f"""## 一、基本信息

| 项目 | 内容 |
|------|------|
| 学生姓名 | {d.name} |
| 班级 | {d.class_name} |
| 学科 | {d.subject} |
| 考试名称 | {d.exam_name} |
| 试卷满分 | {d.total_score} 分 |
| 班级排名 | {rank_info} |
| 分析日期 | {d.analyze_date} |

---

"""

    def _generate_score_overview(self):
        """生成成绩概览"""
        summary = self.score_analyzer.get_score_summary()
        return f"""## 二、成绩概览

| 指标 | 数值 |
|------|------|
| 实际总分 | **{summary['总分']}** 分 |
| 试卷满分 | {summary['满分']} 分 |
| 得分率 | **{summary['得分率']}%** |
| 每题平均分 | {summary['每题平均分']} 分 |
| 及格状态 | {summary['及格状态']} |
| 优秀状态 | {summary['优秀状态']} |

---

"""

    def _generate_knowledge_analysis(self):
        """生成知识掌握分析"""
        stats = self.knowledge_analyzer.get_knowledge_stats()
        weak_points = self.knowledge_analyzer.get_weak_points()
        blind_spots = self.knowledge_analyzer.get_blind_spots()

        lines = ["## 三、知识掌握分析\n"]

        # 知识点得分率表格
        lines.append("### 3.1 各知识点得分率\n")
        lines.append("| 知识点 | 满分 | 得分 | 得分率 | 掌握等级 | 涉及题数 |")
        lines.append("|--------|------|------|--------|---------|---------|")
        for s in stats:
            lines.append(f"| {s['知识点']} | {s['满分']} | {s['得分']} | {s['得分率']}% | {s['掌握等级']} | {s['涉及题数']} |")
        lines.append("")

        # 薄弱知识点
        lines.append("### 3.2 薄弱知识点（得分率<60%）\n")
        if weak_points:
            for wp in weak_points:
                lines.append(f"- **{wp['知识点']}**：得分率 {wp['得分率']}%（{wp['掌握等级']}）— {wp['等级说明']}")
        else:
            lines.append("无明显薄弱知识点，各知识点掌握情况良好。")
        lines.append("")

        # 知识盲区
        lines.append("### 3.3 知识盲区（得分率<40%）\n")
        if blind_spots:
            for bs in blind_spots:
                lines.append(f"- **{bs['知识点']}**：得分率 {bs['得分率']}%（{bs['掌握等级']}）— {bs['等级说明']}")
        else:
            lines.append("无明显知识盲区。")
        lines.append("\n---\n")
        return "\n".join(lines)

    def _generate_ability_analysis(self):
        """生成能力水平分析"""
        stats = self.ability_analyzer.get_ability_stats()
        weak = self.ability_analyzer.get_weak_abilities()
        profile = self.ability_analyzer.get_ability_profile()

        lines = ["## 四、能力水平分析\n"]
        lines.append("### 4.1 六维能力分析表\n")
        lines.append("| 能力层级 | 满分 | 得分 | 得分率 | 题目数 |")
        lines.append("|---------|------|------|--------|--------|")
        for s in stats:
            lines.append(f"| {s['能力层级']} | {s['满分']} | {s['得分']} | {s['得分率']}% | {s['题目数']} |")
        lines.append("")

        lines.append("### 4.2 能力画像\n")
        lines.append(f"> {profile}\n")

        lines.append("### 4.3 能力短板分析\n")
        if weak:
            for w in weak:
                lines.append(f"- **{w['能力层级']}**：得分率 {w['得分率']}%，建议针对性加强该层级能力训练")
        else:
            lines.append("各能力层级表现均达到及格水平，无明显能力短板。")
        lines.append("\n---\n")
        return "\n".join(lines)

    def _generate_type_analysis(self):
        """生成题型分析"""
        stats = self.type_analyzer.get_type_stats()
        weak = self.type_analyzer.get_weak_types()

        lines = ["## 五、题型分析\n"]
        lines.append("### 5.1 各题型得分率\n")
        lines.append("| 题型 | 满分 | 得分 | 得分率 | 题目数 |")
        lines.append("|------|------|------|--------|--------|")
        for s in stats:
            lines.append(f"| {s['题型']} | {s['满分']} | {s['得分']} | {s['得分率']}% | {s['题目数']} |")
        lines.append("")

        lines.append("### 5.2 题型优劣势分析\n")
        if stats:
            strongest = stats[-1]
            weakest = stats[0]
            lines.append(f"- **优势题型**：{strongest['题型']}（得分率 {strongest['得分率']}%）")
            lines.append(f"- **劣势题型**：{weakest['题型']}（得分率 {weakest['得分率']}%）")
        lines.append("")

        lines.append("### 5.3 薄弱题型\n")
        if weak:
            for w in weak:
                lines.append(f"- **{w['题型']}**：得分率 {w['得分率']}%，建议加强该题型专项训练")
        else:
            lines.append("各题型表现均衡，无明显薄弱题型。")
        lines.append("\n---\n")
        return "\n".join(lines)

    def _generate_weakness_diagnosis(self):
        """生成薄弱点综合诊断"""
        weak_knowledge = self.knowledge_analyzer.get_weak_points()
        weak_ability = self.ability_analyzer.get_weak_abilities()
        weak_type = self.type_analyzer.get_weak_types()

        lines = ["## 六、薄弱点综合诊断\n"]
        lines.append("### 6.1 薄弱知识点\n")
        if weak_knowledge:
            for wp in weak_knowledge:
                lines.append(f"- {wp['知识点']}（得分率 {wp['得分率']}%，{wp['掌握等级']}）")
        else:
            lines.append("- 无明显薄弱知识点")
        lines.append("")

        lines.append("### 6.2 薄弱能力\n")
        if weak_ability:
            for wa in weak_ability:
                lines.append(f"- {wa['能力层级']}（得分率 {wa['得分率']}%）")
        else:
            lines.append("- 无明显薄弱能力")
        lines.append("")

        lines.append("### 6.3 薄弱题型\n")
        if weak_type:
            for wt in weak_type:
                lines.append(f"- {wt['题型']}（得分率 {wt['得分率']}%）")
        else:
            lines.append("- 无明显薄弱题型")
        lines.append("")

        # 综合诊断
        lines.append("### 6.4 综合诊断结论\n")
        issues = []
        if weak_knowledge:
            issues.append(f"知识层面存在 {len(weak_knowledge)} 个薄弱点")
        if weak_ability:
            issues.append(f"能力层面存在 {len(weak_ability)} 个短板")
        if weak_type:
            issues.append(f"题型层面存在 {len(weak_type)} 个薄弱项")

        if issues:
            lines.append(f"综合以上分析，该生当前存在以下问题：{'，'.join(issues)}。")
            lines.append('建议按照「先补救知识薄弱点，再强化能力短板，最后专项突破薄弱题型」的顺序进行针对性提升。')
        else:
            lines.append("该生各维度表现均达到良好水平，建议在保持现有水平的基础上拓展提升。")
        lines.append("\n---\n")
        return "\n".join(lines)

    def _generate_trend_analysis(self):
        """生成趋势分析"""
        trend = self.trend_analyzer.get_trend_analysis()

        lines = ["## 七、成绩趋势分析\n"]
        if not trend["可用"]:
            lines.append(f"> {trend['说明']}\n")
            lines.append("\n---\n")
            return "\n".join(lines)

        # 历次成绩
        lines.append("### 7.1 历次成绩对比\n")
        lines.append("| 考试名称 | 得分 | 排名 |")
        lines.append("|---------|------|------|")
        for rec in trend["历次成绩"]:
            rank = rec.get("排名", "—")
            if rank is None:
                rank = "—"
            lines.append(f"| {rec['考试']} | {rec['得分']} | {rank} |")
        lines.append("")

        # 变化趋势
        lines.append("### 7.2 进退步分析\n")
        for comp in trend["变化对比"]:
            rank_str = ""
            if comp["排名变化"] is not None:
                rank_str = f"，排名{'上升' if comp['排名变化'] > 0 else '下降'}{abs(comp['排名变化'])}名"
            lines.append(f"- {comp['上次考试']} → {comp['本次考试']}："
                        f"分数{'+' if comp['分数变化'] >= 0 else ''}{comp['分数变化']}{rank_str}"
                        f" → **{comp['趋势判定']}**")
        lines.append("")

        # 稳定性
        lines.append("### 7.3 稳定性分析\n")
        lines.append(f"- 历次成绩平均分：{trend['平均分']} 分")
        lines.append(f"- 成绩标准差：{trend['标准差']}")
        lines.append(f"- 稳定性判定：**{trend['稳定性']}**")
        lines.append("\n---\n")
        return "\n".join(lines)

    def _generate_teaching_suggestions(self):
        """生成教学建议"""
        weak_knowledge = self.knowledge_analyzer.get_weak_points()
        weak_ability = self.ability_analyzer.get_weak_abilities()
        weak_type = self.type_analyzer.get_weak_types()
        blind_spots = self.knowledge_analyzer.get_blind_spots()

        lines = ["## 八、教学建议\n"]

        # 知识薄弱型建议
        if weak_knowledge:
            lines.append("### 8.1 知识补救建议\n")
            for wp in weak_knowledge:
                if wp["得分率"] < 40:
                    lines.append(f"- **{wp['知识点']}**（掌握率{wp['得分率']}%，知识盲区）：")
                    lines.append(f"  - 建议安排 2-3 课时系统重学该知识点，从基础概念入手")
                    lines.append(f"  - 配合 15-20 道基础练习巩固，逐步提升难度")
                    lines.append(f"  - 一周后进行知识点专项测试，确保掌握率达到 70% 以上")
                else:
                    lines.append(f"- **{wp['知识点']}**（掌握率{wp['得分率']}%，薄弱）：")
                    lines.append(f"  - 建议安排 1 课时专项复习，针对易错点讲解")
                    lines.append(f"  - 配合 8-10 道针对性练习，重点关注错题订正")
            lines.append("")

        # 能力训练建议
        if weak_ability:
            lines.append("### 8.2 能力训练建议\n")
            ability_suggestions = {
                "识记": "加强概念记忆训练，采用间隔重复法巩固核心术语和公式",
                "理解": "多进行概念辨析与举例说明练习，提升对知识的深层理解",
                "应用": "增加情境化练习，在真实问题中运用所学知识",
                "分析": "训练拆解复杂问题的能力，多做比较分析与结构分解练习",
                "综合": "开展开放性探究活动，培养信息整合与创新表达能力",
                "评价": "引导批判性思维训练，学习基于标准进行判断与论证"
            }
            for wa in weak_ability:
                suggestion = ability_suggestions.get(wa["能力层级"], "针对性加强训练")
                lines.append(f"- **{wa['能力层级']}**（得分率{wa['得分率']}%）：{suggestion}")
            lines.append("")

        # 题型专项建议
        if weak_type:
            lines.append("### 8.3 题型专项建议\n")
            for wt in weak_type:
                lines.append(f"- **{wt['题型']}**（得分率{wt['得分率']}%）：建议每周进行 2 组该题型专项训练，每组限时完成")
            lines.append("")

        # 分层建议
        score_rate = self.data.score_rate()
        lines.append("### 8.4 分层教学建议\n")
        if score_rate >= 85:
            lines.append("- **层次定位：优秀生**")
            lines.append("  - 目标：拓展拔高，冲刺更高目标")
            lines.append("  - 策略：增加挑战性题目，培养综合与评价能力，鼓励自主探究")
            lines.append("  - 建议：参加学科拓展活动或竞赛训练，发展学科特长")
        elif score_rate >= 60:
            lines.append("- **层次定位：中等生**")
            lines.append("  - 目标：查漏补缺，突破瓶颈")
            lines.append("  - 策略：针对薄弱知识点和题型重点突破，优化学习方法")
            lines.append("  - 建议：建立错题本，每周回顾总结，稳步提升薄弱环节")
        else:
            lines.append("- **层次定位：学困生**")
            lines.append("  - 目标：夯实基础，重建信心")
            lines.append("  - 策略：降低学习起点，从基础概念入手，循序渐进")
            lines.append("  - 建议：安排同伴互助或课后辅导，注重情感激励与正面反馈")

        lines.append("\n---\n")
        return "\n".join(lines)

    def _generate_footer(self):
        """生成报告页脚"""
        return f"""## 附录

### 指标说明

| 指标 | 计算方法 | 参考标准 |
|------|---------|---------|
| 得分率 | 实际得分 / 满分 × 100% | ≥85%优秀，70-84%良好，60-69%一般，<60%薄弱 |
| 掌握等级 | 按知识点得分率分级 | 优秀≥85%，良好70-84%，一般60-69%，薄弱40-59%，盲区<40% |
| 标准差 | sqrt(Σ(xi-μ)²/n) | 反映成绩离散程度，越小越稳定 |
| 进退步判定 | 综合分数变化与排名变化 | 显著进步/稳中有进/保持稳定/略有退步/显著退步 |

### 分析工具

本报告由 `analyze_student.py` 自动生成。

---

*报告生成时间：{self.data.analyze_date}*
"""


# =============================================================================
# 八、示例数据
# =============================================================================

def get_demo_data():
    """生成示例数据用于演示功能"""
    demo_questions = [
        # 选择题（1-10题，每题5分）
        {"题号": 1, "题型": "选择题", "满分": 5, "得分": 5, "知识点": ["集合的概念"], "能力层级": "识记"},
        {"题号": 2, "题型": "选择题", "满分": 5, "得分": 5, "知识点": ["函数的定义"], "能力层级": "识记"},
        {"题号": 3, "题型": "选择题", "满分": 5, "得分": 4, "知识点": ["函数的性质"], "能力层级": "理解"},
        {"题号": 4, "题型": "选择题", "满分": 5, "得分": 3, "知识点": ["指数函数"], "能力层级": "理解"},
        {"题号": 5, "题型": "选择题", "满分": 5, "得分": 5, "知识点": ["对数函数"], "能力层级": "应用"},
        {"题号": 6, "题型": "选择题", "满分": 5, "得分": 2, "知识点": ["幂函数"], "能力层级": "应用"},
        {"题号": 7, "题型": "选择题", "满分": 5, "得分": 4, "知识点": ["函数的单调性"], "能力层级": "理解"},
        {"题号": 8, "题型": "选择题", "满分": 5, "得分": 3, "知识点": ["函数的奇偶性"], "能力层级": "分析"},
        {"题号": 9, "题型": "选择题", "满分": 5, "得分": 5, "知识点": ["集合的概念", "函数的定义"], "能力层级": "理解"},
        {"题号": 10, "题型": "选择题", "满分": 5, "得分": 4, "知识点": ["函数的性质"], "能力层级": "应用"},

        # 填空题（11-14题，每题5分）
        {"题号": 11, "题型": "填空题", "满分": 5, "得分": 5, "知识点": ["指数函数"], "能力层级": "识记"},
        {"题号": 12, "题型": "填空题", "满分": 5, "得分": 3, "知识点": ["对数函数"], "能力层级": "应用"},
        {"题号": 13, "题型": "填空题", "满分": 5, "得分": 2, "知识点": ["幂函数"], "能力层级": "应用"},
        {"题号": 14, "题型": "填空题", "满分": 5, "得分": 4, "知识点": ["函数的单调性"], "能力层级": "理解"},

        # 解答题（15-18题，每题15分）
        {"题号": 15, "题型": "解答题", "满分": 15, "得分": 12, "知识点": ["函数的性质", "函数的单调性"], "能力层级": "分析"},
        {"题号": 16, "题型": "解答题", "满分": 15, "得分": 8, "知识点": ["指数函数", "对数函数"], "能力层级": "综合"},
        {"题号": 17, "题型": "解答题", "满分": 15, "得分": 6, "知识点": ["幂函数", "函数的奇偶性"], "能力层级": "综合"},
        {"题号": 18, "题型": "解答题", "满分": 15, "得分": 5, "知识点": ["函数的综合应用"], "能力层级": "评价"},
    ]

    demo_history = [
        {"考试": "开学摸底考试", "得分": 78, "排名": 25},
        {"考试": "第一次月考", "得分": 85, "排名": 20},
        {"考试": "期中考试", "得分": 92, "排名": 12},
    ]

    return StudentData(
        name="李明",
        class_name="高一(3)班",
        subject="数学",
        exam_name="2025年秋季期末考试",
        total_score=150,
        questions=demo_questions,
        history=demo_history,
        rank=8,
        total_students=45
    )


# =============================================================================
# 九、数据加载
# =============================================================================

def load_data_from_json(filepath):
    """从 JSON 文件加载学生数据"""
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    return StudentData(
        name=data.get("学生姓名", "未知"),
        class_name=data.get("班级", "未知"),
        subject=data.get("学科", "未知"),
        exam_name=data.get("考试名称", "未知"),
        total_score=data.get("满分", 100),
        questions=data.get("题目数据", []),
        history=data.get("历史成绩", []),
        rank=data.get("排名"),
        total_students=data.get("总人数")
    )


def load_data_from_args(args):
    """从命令行参数构建学生数据"""
    # 当通过命令行参数传入时，构建基本数据结构
    # 实际使用中建议通过 JSON 文件传入完整数据
    questions = []
    if args.scores and args.full_scores and args.knowledge:
        scores = [float(x) for x in args.scores.split(",")]
        full_scores = [float(x) for x in args.full_scores.split(",")]
        knowledge_list = args.knowledge.split(";")

        for i in range(len(scores)):
            kp_list = knowledge_list[i].split(",") if i < len(knowledge_list) else []
            questions.append({
                "题号": i + 1,
                "题型": args.types.split(",")[i] if args.types and i < len(args.types.split(",")) else "其他",
                "满分": full_scores[i],
                "得分": scores[i],
                "知识点": kp_list,
                "能力层级": args.abilities.split(",")[i] if args.abilities and i < len(args.abilities.split(",")) else "识记"
            })

    return StudentData(
        name=args.name or "未知学生",
        class_name=args.class_name or "未知班级",
        subject=args.subject or "未知学科",
        exam_name=args.exam or "未知考试",
        total_score=args.total_score or 100,
        questions=questions,
        history=[],
        rank=args.rank,
        total_students=args.total_students
    )


# =============================================================================
# 十、主函数
# =============================================================================

def main():
    """主函数：解析参数并执行分析"""
    parser = argparse.ArgumentParser(
        description="学生学情分析工具 - 多维度分析学生成绩，生成诊断报告",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用示例:
  1. 运行示例数据演示:
     python analyze_student.py --demo

  2. 从 JSON 文件加载数据分析:
     python analyze_student.py --name "张三" --subject "数学" --exam "期中考试" --data data.json

  3. 通过命令行参数直接输入:
     python analyze_student.py --name "张三" --subject "数学" --exam "月考" --total-score 100 \\
       --scores "5,4,3,5,2,4,3,5" --full-scores "5,5,5,5,5,5,5,5" \\
       --knowledge "集合;函数定义;函数性质;指数函数;幂函数;对数函数;单调性;奇偶性" \\
       --types "选择题,选择题,选择题,选择题,选择题,选择题,选择题,选择题" \\
       --abilities "识记,识记,理解,理解,应用,应用,理解,分析" \\
       --rank 15 --total-students 45
        """
    )

    parser.add_argument("--demo", action="store_true", help="使用内置示例数据运行演示")
    parser.add_argument("--data", type=str, help="JSON 数据文件路径")
    parser.add_argument("--name", type=str, help="学生姓名")
    parser.add_argument("--class-name", type=str, dest="class_name", help="班级名称")
    parser.add_argument("--subject", type=str, help="学科")
    parser.add_argument("--exam", type=str, help="考试名称")
    parser.add_argument("--total-score", type=float, dest="total_score", help="试卷满分")
    parser.add_argument("--scores", type=str, help="各题得分，逗号分隔（如 5,4,3,5）")
    parser.add_argument("--full-scores", type=str, dest="full_scores", help="各题满分，逗号分隔")
    parser.add_argument("--knowledge", type=str, help="各题知识点，分号分隔每组，组内逗号分隔（如 集合;函数定义,函数性质）")
    parser.add_argument("--types", type=str, help="各题题型，逗号分隔")
    parser.add_argument("--abilities", type=str, help="各题能力层级，逗号分隔")
    parser.add_argument("--rank", type=int, help="排名")
    parser.add_argument("--total-students", type=int, dest="total_students", help="班级总人数")
    parser.add_argument("--output", type=str, help="输出文件路径（默认输出到控制台）")

    args = parser.parse_args()

    # 加载数据
    if args.demo:
        print("=" * 60)
        print("  学生学情分析工具 - 示例演示模式")
        print("=" * 60)
        print()
        student_data = get_demo_data()
        print(f"  学生：{student_data.name}（{student_data.class_name}）")
        print(f"  学科：{student_data.subject}")
        print(f"  考试：{student_data.exam_name}")
        print(f"  满分：{student_data.total_score} 分")
        print(f"  题目数：{len(student_data.questions)} 道")
        print(f"  历史成绩：{len(student_data.history)} 次记录")
        print()
    elif args.data:
        student_data = load_data_from_json(args.data)
        print(f"已从 {args.data} 加载数据")
        print(f"  学生：{student_data.name}（{student_data.class_name}）")
        print()
    elif args.scores:
        student_data = load_data_from_args(args)
    else:
        # 无参数时默认运行演示
        print("未指定数据来源，默认运行示例演示。使用 --help 查看使用说明。")
        print()
        student_data = get_demo_data()

    # 生成报告
    report_generator = ReportGenerator(student_data)
    report = report_generator.generate()

    # 输出报告
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(report)
        print(f"报告已保存至：{args.output}")
        print()
        # 同时在控制台输出简要摘要
        print_summary(student_data, report_generator)
    else:
        print(report)


def print_summary(student_data, report_generator):
    """输出简要摘要"""
    summary = report_generator.score_analyzer.get_score_summary()
    weak_knowledge = report_generator.knowledge_analyzer.get_weak_points()
    weak_ability = report_generator.ability_analyzer.get_weak_abilities()

    print("=" * 60)
    print("  学情分析摘要")
    print("=" * 60)
    print(f"  学生：{student_data.name}  学科：{student_data.subject}")
    print(f"  总分：{summary['总分']}/{summary['满分']}（得分率 {summary['得分率']}%）")
    print(f"  及格状态：{summary['及格状态']}  优秀状态：{summary['优秀状态']}")
    if summary['排名'] and summary['总人数']:
        print(f"  排名：{summary['排名']}/{summary['总人数']}")
    print()

    if weak_knowledge:
        print(f"  薄弱知识点（{len(weak_knowledge)}个）：")
        for wp in weak_knowledge[:5]:
            print(f"    - {wp['知识点']}（{wp['得分率']}%）")
    else:
        print("  薄弱知识点：无")

    if weak_ability:
        print(f"  薄弱能力（{len(weak_ability)}个）：")
        for wa in weak_ability:
            print(f"    - {wa['能力层级']}（{wa['得分率']}%）")
    else:
        print("  薄弱能力：无")

    print()
    print("=" * 60)


if __name__ == "__main__":
    main()
