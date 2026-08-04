#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
题目批改辅助脚本
=================
功能：
1. 支持选择题自动批改模式（输入标准答案与学生答案，自动计算得分）
2. 支持主观题批改记录模式（逐题记录得分、扣分原因、批注）
3. 生成批改结果汇总（总分、各题得分、错误分布统计）
4. 输出Markdown格式的批改报告

使用方法：
    python grade_homework.py

可直接运行，包含示例数据演示功能。全中文注释，可独立运行。

作者：题目批改技能
日期：2026年
"""

import json
import os
from datetime import datetime
from collections import OrderedDict


# ============================================================
#  数据模型定义
# ============================================================

class GradingTask:
    """批改任务：记录一次完整的批改信息"""

    def __init__(self, subject, grade, total_score, question_count,
                 student_name="未命名学生", class_name="未指定班级"):
        """
        初始化批改任务

        参数:
            subject: 学科名称（如"数学"）
            grade: 年级（如"高中一年级"）
            total_score: 试卷总分
            question_count: 题目数量
            student_name: 学生姓名
            class_name: 班级名称
        """
        self.subject = subject          # 学科
        self.grade = grade              # 年级
        self.total_score = total_score  # 总分
        self.question_count = question_count  # 题目数量
        self.student_name = student_name      # 学生姓名
        self.class_name = class_name          # 班级
        self.date = datetime.now().strftime("%Y-%m-%d")  # 批改日期
        self.results = []  # 批改结果列表，每项为 GradingResult 对象

    def add_result(self, result):
        """添加一道题的批改结果"""
        self.results.append(result)

    def get_total_obtained(self):
        """获取学生总得分"""
        return sum(r.obtained_score for r in self.results)

    def get_score_rate(self):
        """获取得分率（百分比）"""
        if self.total_score == 0:
            return 0.0
        return round(self.get_total_obtained() / self.total_score * 100, 1)

    def get_grade_level(self):
        """根据得分率返回成绩等级"""
        rate = self.get_score_rate()
        if rate >= 90:
            return "优秀"
        elif rate >= 80:
            return "良好"
        elif rate >= 70:
            return "中等"
        elif rate >= 60:
            return "及格"
        else:
            return "不及格"

    def get_error_distribution(self):
        """获取错误类型分布统计"""
        distribution = OrderedDict()
        distribution["知识性错误"] = 0
        distribution["方法性错误"] = 0
        distribution["计算性错误"] = 0
        distribution["格式性错误"] = 0
        distribution["审题性错误"] = 0
        for r in self.results:
            for error_type in r.error_types:
                if error_type in distribution:
                    distribution[error_type] += 1
        return distribution


class GradingResult:
    """单题批改结果"""

    def __init__(self, question_no, question_type, max_score,
                 student_answer, correct_answer,
                 obtained_score, is_correct=None,
                 deduction_reasons=None, comment="", error_types=None):
        """
        初始化单题批改结果

        参数:
            question_no: 题号
            question_type: 题型（选择题/填空题/判断题/简答题/计算题/证明题/作文题）
            max_score: 该题满分
            student_answer: 学生作答
            correct_answer: 正确答案
            obtained_score: 学生得分
            is_correct: 是否完全正确（True/False/None表示部分正确）
            deduction_reasons: 扣分原因列表
            comment: 教师批注
            error_types: 错误类型列表
        """
        self.question_no = question_no            # 题号
        self.question_type = question_type        # 题型
        self.max_score = max_score                # 满分
        self.student_answer = student_answer      # 学生作答
        self.correct_answer = correct_answer      # 正确答案
        self.obtained_score = obtained_score      # 得分
        # 判断是否正确：若未指定，则根据得分自动判断
        if is_correct is None:
            if obtained_score >= max_score:
                self.is_correct = True
            elif obtained_score <= 0:
                self.is_correct = False
            else:
                self.is_correct = None  # 部分正确
        else:
            self.is_correct = is_correct
        self.deduction_reasons = deduction_reasons or []  # 扣分原因
        self.comment = comment                        # 批注
        self.error_types = error_types or []          # 错误类型


# ============================================================
#  选择题自动批改模块
# ============================================================

class ObjectiveGrader:
    """客观题（选择题/判断题）自动批改器"""

    # 多选题给分规则
    RULE_FULL_ONLY = "full_only"    # 全对才得分
    RULE_PARTIAL = "partial"        # 漏选得半分，错选不得分
    RULE_NO_PARTIAL = "no_partial"  # 无部分分，全对或全错

    @staticmethod
    def grade_single_choice(student_answer, correct_answer, max_score):
        """
        批改单选题

        参数:
            student_answer: 学生答案（如"A"）
            correct_answer: 标准答案（如"A"）
            max_score: 满分

        返回: GradingResult 对象
        """
        student_answer = str(student_answer).strip().upper()
        correct_answer = str(correct_answer).strip().upper()
        is_correct = student_answer == correct_answer
        obtained = max_score if is_correct else 0
        result = GradingResult(
            question_no=0,  # 题号在外部设置
            question_type="选择题",
            max_score=max_score,
            student_answer=student_answer,
            correct_answer=correct_answer,
            obtained_score=obtained,
            is_correct=is_correct,
            deduction_reasons=[] if is_correct else ["答案不正确"],
            comment="" if is_correct else "请复习相关知识点",
            error_types=[] if is_correct else ["知识性错误"]
        )
        return result

    @staticmethod
    def grade_multiple_choice(student_answer, correct_answer, max_score,
                               rule=RULE_PARTIAL):
        """
        批改多选题

        参数:
            student_answer: 学生答案（如"ABD"或"A,B,D"）
            correct_answer: 标准答案（如"ABD"或"A,B,D"）
            max_score: 满分
            rule: 给分规则（full_only / partial / no_partial）

        返回: GradingResult 对象
        """
        # 统一处理答案格式：去除分隔符，转大写，转为集合
        def parse_answer(ans):
            ans = str(ans).strip().upper()
            for sep in [",", "，", " ", "、"]:
                ans = ans.replace(sep, "")
            return set(ans)

        student_set = parse_answer(student_answer)
        correct_set = parse_answer(correct_answer)

        # 判断对错
        if student_set == correct_set:
            # 完全正确
            return GradingResult(
                question_no=0,
                question_type="选择题",
                max_score=max_score,
                student_answer=student_answer,
                correct_answer=correct_answer,
                obtained_score=max_score,
                is_correct=True,
                deduction_reasons=[],
                comment="全部选对，表现优秀！",
                error_types=[]
            )

        if rule == ObjectiveGrader.RULE_FULL_ONLY:
            # 全对才得分
            return GradingResult(
                question_no=0,
                question_type="选择题",
                max_score=max_score,
                student_answer=student_answer,
                correct_answer=correct_answer,
                obtained_score=0,
                is_correct=False,
                deduction_reasons=["多选题未全对，不部分给分"],
                comment="多选题需全部选对才得分",
                error_types=["知识性错误"]
            )

        elif rule == ObjectiveGrader.RULE_PARTIAL:
            # 漏选得半分，错选不得分
            # 检查是否有错选（学生选了不在正确答案中的选项）
            wrong_selections = student_set - correct_set
            if wrong_selections:
                # 有错选，不得分
                return GradingResult(
                    question_no=0,
                    question_type="选择题",
                    max_score=max_score,
                    student_answer=student_answer,
                    correct_answer=correct_answer,
                    obtained_score=0,
                    is_correct=False,
                    deduction_reasons=[f"存在错选: {''.join(sorted(wrong_selections))}"],
                    comment="多选题中有错选项，不得分",
                    error_types=["审题性错误"]
                )
            else:
                # 仅有漏选，得半分
                half_score = max_score // 2
                missed = correct_set - student_set
                return GradingResult(
                    question_no=0,
                    question_type="选择题",
                    max_score=max_score,
                    student_answer=student_answer,
                    correct_answer=correct_answer,
                    obtained_score=half_score,
                    is_correct=None,
                    deduction_reasons=[f"漏选: {''.join(sorted(missed))}"],
                    comment="部分正确，有漏选",
                    error_types=["审题性错误"]
                )

        else:
            # 无部分分
            return GradingResult(
                question_no=0,
                question_type="选择题",
                max_score=max_score,
                student_answer=student_answer,
                correct_answer=correct_answer,
                obtained_score=0,
                is_correct=False,
                deduction_reasons=["多选题未全对"],
                comment="",
                error_types=["知识性错误"]
            )

    @staticmethod
    def grade_true_false(student_answer, correct_answer, max_score):
        """
        批改判断题

        参数:
            student_answer: 学生答案（"对"/"错" 或 "T"/"F" 或 "√"/"×"）
            correct_answer: 标准答案
            max_score: 满分

        返回: GradingResult 对象
        """
        # 统一判断题答案格式
        def normalize(ans):
            ans = str(ans).strip()
            if ans in ["对", "正确", "T", "t", "√", "是", "Y", "y"]:
                return True
            elif ans in ["错", "错误", "F", "f", "×", "否", "N", "n"]:
                return False
            return None

        student_val = normalize(student_answer)
        correct_val = normalize(correct_answer)
        is_correct = student_val == correct_val
        obtained = max_score if is_correct else 0
        return GradingResult(
            question_no=0,
            question_type="判断题",
            max_score=max_score,
            student_answer=student_answer,
            correct_answer=correct_answer,
            obtained_score=obtained,
            is_correct=is_correct,
            deduction_reasons=[] if is_correct else["判断错误"],
            comment="" if is_correct else "请注意概念的准确理解",
            error_types=[] if is_correct else ["知识性错误"]
        )

    @staticmethod
    def batch_grade_objective(answers, rule=RULE_PARTIAL):
        """
        批量批改客观题

        参数:
            answers: 答案列表，每项为字典:
                {
                    "no": 题号,
                    "type": 题型("单选"/"多选"/"判断"),
                    "student_answer": 学生答案,
                    "correct_answer": 标准答案,
                    "max_score": 满分
                }
            rule: 多选题给分规则

        返回: GradingResult 列表
        """
        results = []
        for item in answers:
            no = item["no"]
            q_type = item["type"]
            s_ans = item["student_answer"]
            c_ans = item["correct_answer"]
            max_s = item["max_score"]

            if q_type == "单选":
                result = ObjectiveGrader.grade_single_choice(s_ans, c_ans, max_s)
            elif q_type == "多选":
                result = ObjectiveGrader.grade_multiple_choice(
                    s_ans, c_ans, max_s, rule)
            elif q_type == "判断":
                result = ObjectiveGrader.grade_true_false(s_ans, c_ans, max_s)
            else:
                # 默认按单选处理
                result = ObjectiveGrader.grade_single_choice(s_ans, c_ans, max_s)

            result.question_no = no
            results.append(result)
        return results


# ============================================================
#  主观题批改记录模块
# ============================================================

class SubjectiveGrader:
    """主观题批改记录器：记录教师手动批改的得分与批注"""

    @staticmethod
    def record_grading(question_no, question_type, max_score,
                       student_answer, correct_answer, obtained_score,
                       deduction_reasons=None, comment="", error_types=None):
        """
        记录一道主观题的批改结果

        参数:
            question_no: 题号
            question_type: 题型（填空题/简答题/计算题/证明题/作文题）
            max_score: 满分
            student_answer: 学生作答
            correct_answer: 参考答案
            obtained_score: 得分
            deduction_reasons: 扣分原因列表
            comment: 教师批注
            error_types: 错误类型列表

        返回: GradingResult 对象
        """
        # 校验得分范围
        obtained_score = max(0, min(obtained_score, max_score))

        return GradingResult(
            question_no=question_no,
            question_type=question_type,
            max_score=max_score,
            student_answer=student_answer,
            correct_answer=correct_answer,
            obtained_score=obtained_score,
            deduction_reasons=deduction_reasons or [],
            comment=comment,
            error_types=error_types or []
        )


# ============================================================
#  报告生成模块
# ============================================================

class ReportGenerator:
    """批改报告生成器：输出Markdown格式报告"""

    # 成绩等级评语模板
    LEVEL_COMMENTS = {
        "优秀": "表现出色，基础知识扎实，解题思路清晰，继续保持！",
        "良好": "整体表现不错，个别知识点需加强巩固，继续加油！",
        "中等": "有一定基础，部分重点内容需加强复习，多加练习！",
        "及格": "基本掌握核心内容，建议针对薄弱环节重点突破，加油！",
        "不及格": "基础较为薄弱，建议系统复习基础知识，老师相信你可以进步！"
    }

    @staticmethod
    def generate_markdown_report(task):
        """
        生成Markdown格式的批改报告

        参数:
            task: GradingTask 对象

        返回: Markdown字符串
        """
        lines = []
        # === 报告标题 ===
        lines.append(f"# 批改报告")
        lines.append("")

        # === 学生信息区 ===
        lines.append("## 一、学生信息")
        lines.append("")
        lines.append(f"| 项目 | 内容 |")
        lines.append(f"|------|------|")
        lines.append(f"| 学生姓名 | {task.student_name} |")
        lines.append(f"| 班级 | {task.class_name} |")
        lines.append(f"| 学科 | {task.subject} |")
        lines.append(f"| 年级 | {task.grade} |")
        lines.append(f"| 批改日期 | {task.date} |")
        lines.append("")

        # === 成绩汇总区 ===
        total_obtained = task.get_total_obtained()
        score_rate = task.get_score_rate()
        grade_level = task.get_grade_level()

        lines.append("## 二、成绩汇总")
        lines.append("")
        lines.append(f"| 项目 | 数值 |")
        lines.append(f"|------|------|")
        lines.append(f"| 试卷总分 | {task.total_score} 分 |")
        lines.append(f"| 学生得分 | {total_obtained} 分 |")
        lines.append(f"| 得分率 | {score_rate}% |")
        lines.append(f"| 成绩等级 | {grade_level} |")
        lines.append("")

        # 各题得分表
        lines.append("### 各题得分明细")
        lines.append("")
        lines.append(f"| 题号 | 题型 | 满分 | 得分 | 得分率 | 是否正确 |")
        lines.append(f"|------|------|------|------|--------|----------|")
        for r in task.results:
            q_rate = round(r.obtained_score / r.max_score * 100, 1) if r.max_score > 0 else 0
            if r.is_correct is True:
                correct_str = "✓ 正确"
            elif r.is_correct is False:
                correct_str = "✗ 错误"
            else:
                correct_str = "△ 部分正确"
            lines.append(
                f"| 第{r.question_no}题 | {r.question_type} | "
                f"{r.max_score} | {r.obtained_score} | {q_rate}% | {correct_str} |"
            )
        lines.append(f"| **合计** | — | **{task.total_score}** | "
                     f"**{total_obtained}** | **{score_rate}%** | — |")
        lines.append("")

        # === 逐题批改详情区 ===
        lines.append("## 三、逐题批改详情")
        lines.append("")
        for r in task.results:
            lines.append(f"### 第{r.question_no}题（{r.question_type}，满分{r.max_score}分）")
            lines.append("")
            lines.append(f"- **学生作答**：{r.student_answer}")
            lines.append(f"- **正确答案**：{r.correct_answer}")
            lines.append(f"- **本题得分**：{r.obtained_score} / {r.max_score}")
            if r.deduction_reasons:
                lines.append(f"- **扣分原因**：")
                for reason in r.deduction_reasons:
                    lines.append(f"  - {reason}")
            if r.error_types:
                error_str = "、".join(r.error_types)
                lines.append(f"- **错误类型**：{error_str}")
            if r.comment:
                lines.append(f"- **教师批注**：{r.comment}")
            lines.append("")

        # === 错误分布统计区 ===
        lines.append("## 四、错误分布统计")
        lines.append("")
        distribution = task.get_error_distribution()
        total_errors = sum(distribution.values())
        lines.append(f"| 错误类型 | 出现次数 | 占比 |")
        lines.append(f"|----------|----------|------|")
        for error_type, count in distribution.items():
            pct = f"{round(count / total_errors * 100, 1)}%" if total_errors > 0 else "0%"
            lines.append(f"| {error_type} | {count} | {pct} |")
        lines.append(f"| **合计** | **{total_errors}** | **100%** |")
        lines.append("")

        # === 总体评价与建议区 ===
        lines.append("## 五、总体评价与建议")
        lines.append("")
        overall_comment = ReportGenerator.LEVEL_COMMENTS.get(grade_level, "")
        lines.append(f"**成绩等级**：{grade_level}（得分率{score_rate}%）")
        lines.append("")
        lines.append(f"**总体评语**：{overall_comment}")
        lines.append("")

        # 主要问题分析
        if total_errors > 0:
            lines.append("**主要问题**：")
            # 按出现次数排序
            sorted_errors = sorted(distribution.items(),
                                  key=lambda x: x[1], reverse=True)
            for error_type, count in sorted_errors:
                if count > 0:
                    suggestion = ReportGenerator._get_suggestion(error_type)
                    lines.append(f"- {error_type}（{count}处）：{suggestion}")
            lines.append("")

        # 改进建议
        lines.append("**改进建议**：")
        suggestions = ReportGenerator._generate_suggestions(task)
        for s in suggestions:
            lines.append(f"- {s}")
        lines.append("")

        lines.append("---")
        lines.append(f"*本报告由题目批改辅助脚本自动生成 | 生成时间：{task.date}*")

        return "\n".join(lines)

    @staticmethod
    def _get_suggestion(error_type):
        """根据错误类型返回改进建议"""
        suggestions = {
            "知识性错误": "建议回归教材，系统复习相关概念、公式与定理，确保基础知识牢固。",
            "方法性错误": "建议多总结解题方法与题型规律，建立解题思路框架。",
            "计算性错误": "建议加强计算练习，养成验算习惯，注意运算符号与小数点。",
            "格式性错误": "建议规范答题格式，注意书写步骤完整、单位标注、有效数字。",
            "审题性错误": "建议养成圈画关键词的习惯，仔细审题，确保理解题意后再作答。"
        }
        return suggestions.get(error_type, "建议针对性加强练习。")

    @staticmethod
    def _generate_suggestions(task):
        """根据整体表现生成改进建议列表"""
        suggestions = []
        rate = task.get_score_rate()

        if rate < 60:
            suggestions.append("建议系统梳理本阶段基础知识，从课本概念入手逐步巩固。")
            suggestions.append("建议每天安排固定时间进行基础练习，从简单题做起。")
        elif rate < 75:
            suggestions.append("建议重点复习错题涉及的知识点，查漏补缺。")
            suggestions.append("建议建立错题本，定期回顾，避免同类错误重复出现。")
        elif rate < 90:
            suggestions.append("建议针对薄弱题型进行专项训练，提升综合解题能力。")
            suggestions.append("建议尝试拓展提升类题目，拓宽解题思路。")
        else:
            suggestions.append("表现优异，建议挑战更高难度的拓展题目，持续提升。")
            suggestions.append("可尝试帮助同学讲解题目，巩固理解的同时提升表达能力。")

        return suggestions


# ============================================================
#  示例数据演示
# ============================================================

def demo_objective_grading():
    """演示选择题自动批改功能"""
    print("=" * 60)
    print("  演示一：选择题自动批改模式")
    print("=" * 60)
    print()

    # 创建批改任务
    task = GradingTask(
        subject="数学",
        grade="高中一年级",
        total_score=20,
        question_count=5,
        student_name="张明",
        class_name="高一(3)班"
    )

    # 定义选择题答案数据
    answers = [
        {"no": 1, "type": "单选", "student_answer": "B", "correct_answer": "B", "max_score": 4},
        {"no": 2, "type": "单选", "student_answer": "C", "correct_answer": "D", "max_score": 4},
        {"no": 3, "type": "多选", "student_answer": "ABD", "correct_answer": "ABCD", "max_score": 4},
        {"no": 4, "type": "多选", "student_answer": "AC", "correct_answer": "AC", "max_score": 4},
        {"no": 5, "type": "判断", "student_answer": "对", "correct_answer": "错", "max_score": 4},
    ]

    # 批量批改
    results = ObjectiveGrader.batch_grade_objective(
        answers, rule=ObjectiveGrader.RULE_PARTIAL)

    for r in results:
        task.add_result(r)

    # 输出批改结果
    print(f"学生：{task.student_name}（{task.class_name}）")
    print(f"学科：{task.subject}    年级：{task.grade}")
    print(f"总分：{task.total_score}分    得分：{task.get_total_obtained()}分"
          f"    得分率：{task.get_score_rate()}%    等级：{task.get_grade_level()}")
    print()
    print("逐题结果：")
    for r in task.results:
        status = "✓正确" if r.is_correct else ("△部分" if r.is_correct is None else "✗错误")
        print(f"  第{r.question_no}题 [{r.question_type}] "
              f"学生:{r.student_answer} 正确:{r.correct_answer} "
              f"得分:{r.obtained_score}/{r.max_score} {status}")
        if r.deduction_reasons:
            for reason in r.deduction_reasons:
                print(f"    扣分原因：{reason}")
    print()

    # 生成Markdown报告
    report = ReportGenerator.generate_markdown_report(task)
    print("【Markdown格式批改报告】")
    print(report)
    print()

    return task


def demo_subjective_grading():
    """演示主观题批改记录功能"""
    print("=" * 60)
    print("  演示二：主观题批改记录模式")
    print("=" * 60)
    print()

    # 创建批改任务
    task = GradingTask(
        subject="物理",
        grade="高中二年级",
        total_score=30,
        question_count=3,
        student_name="李华",
        class_name="高二(1)班"
    )

    # 记录第1题：计算题
    result1 = SubjectiveGrader.record_grading(
        question_no=1,
        question_type="计算题",
        max_score=10,
        student_answer="设物体加速度为a，由F=ma得 a=F/m=10/2=5m/s²..."
        "（计算过程中将10/2算成了4，得到a=4m/s²）",
        correct_answer="a = F/m = 10N/2kg = 5m/s²，v = at = 5×3 = 15m/s",
        obtained_score=7,
        deduction_reasons=["列式正确得4分", "计算过程错误（10/2≠4）扣2分",
                           "最终结果因计算错误而错误扣1分"],
        comment="解题思路正确，但计算过程中出现失误，10÷2=5而非4。"
                "建议加强基础运算练习，养成验算习惯。",
        error_types=["计算性错误"]
    )
    task.add_result(result1)

    # 记录第2题：简答题
    result2 = SubjectiveGrader.record_grading(
        question_no=2,
        question_type="简答题",
        max_score=10,
        student_answer="牛顿第二定律表述为：物体的加速度与所受合外力成正比，"
        "与质量成反比。（未提及方向关系）",
        correct_answer="牛顿第二定律：物体的加速度跟所受合外力成正比，"
        "跟物体的质量成反比，加速度的方向与合外力的方向相同。",
        obtained_score=7,
        deduction_reasons=["基本表述正确得7分", "遗漏加速度方向与合外力方向"
                           "相同的条件扣3分"],
        comment="核心内容表述正确，但遗漏了加速度方向与合外力方向相同这一"
                "重要条件，回答不够完整。",
        error_types=["知识性错误", "格式性错误"]
    )
    task.add_result(result2)

    # 记录第3题：证明题
    result3 = SubjectiveGrader.record_grading(
        question_no=3,
        question_type="证明题",
        max_score=10,
        student_answer="证明：设...由动能定理...（中间跳步较多，"
        "缺少关键推导步骤）...得证。",
        correct_answer="完整证明过程包含：受力分析→列动能定理方程→"
        "代入数据→化简→得出结论",
        obtained_score=6,
        deduction_reasons=["证明方向正确得6分", "关键步骤缺失，逻辑跳跃扣3分",
                           "未写"证毕"格式扣1分"],
        comment="证明思路正确，但过程不够完整，关键推导步骤有跳跃。"
                "建议写出每步的依据，使证明过程更加严密。",
        error_types=["方法性错误", "格式性错误"]
    )
    task.add_result(result3)

    # 输出批改结果
    print(f"学生：{task.student_name}（{task.class_name}）")
    print(f"学科：{task.subject}    年级：{task.grade}")
    print(f"总分：{task.total_score}分    得分：{task.get_total_obtained()}分"
          f"    得分率：{task.get_score_rate()}%    等级：{task.get_grade_level()}")
    print()

    # 错误分布统计
    distribution = task.get_error_distribution()
    print("错误分布统计：")
    for error_type, count in distribution.items():
        if count > 0:
            bar = "█" * count
            print(f"  {error_type}：{bar} {count}处")
    print()

    # 生成Markdown报告
    report = ReportGenerator.generate_markdown_report(task)
    print("【Markdown格式批改报告】")
    print(report)
    print()

    return task


def demo_mixed_grading():
    """演示混合题型（客观题+主观题）批改"""
    print("=" * 60)
    print("  演示三：混合题型批改（客观题+主观题）")
    print("=" * 60)
    print()

    task = GradingTask(
        subject="数学",
        grade="初中三年级",
        total_score=100,
        question_count=8,
        student_name="王芳",
        class_name="初三(2)班"
    )

    # 客观题部分（选择题，共40分）
    objective_answers = [
        {"no": 1, "type": "单选", "student_answer": "A", "correct_answer": "A", "max_score": 5},
        {"no": 2, "type": "单选", "student_answer": "B", "correct_answer": "C", "max_score": 5},
        {"no": 3, "type": "单选", "student_answer": "D", "correct_answer": "D", "max_score": 5},
        {"no": 4, "type": "多选", "student_answer": "ABC", "correct_answer": "ABCD", "max_score": 5},
        {"no": 5, "type": "判断", "student_answer": "对", "correct_answer": "对", "max_score": 5},
        {"no": 6, "type": "判断", "student_answer": "错", "correct_answer": "对", "max_score": 5},
        {"no": 7, "type": "多选", "student_answer": "BD", "correct_answer": "ABD", "max_score": 5},
        {"no": 8, "type": "单选", "student_answer": "C", "correct_answer": "C", "max_score": 5},
    ]

    objective_results = ObjectiveGrader.batch_grade_objective(objective_answers)
    for r in objective_results:
        task.add_result(r)

    # 主观题部分（共60分）
    subjective_results = [
        SubjectiveGrader.record_grading(
            question_no=9, question_type="填空题", max_score=10,
            student_answer="x=3",
            correct_answer="x=3（或x=-1）",
            obtained_score=5,
            deduction_reasons=["只写出一个解，遗漏另一个解"],
            comment="注意二次方程可能有两个解，需全面求解。",
            error_types=["知识性错误"]
        ),
        SubjectiveGrader.record_grading(
            question_no=10, question_type="计算题", max_score=15,
            student_answer="解：设x为未知数...3x+5=20, 3x=15, x=5...",
            correct_answer="x=5",
            obtained_score=15,
            deduction_reasons=[],
            comment="解题过程完整规范，计算准确，非常棒！",
            error_types=[]
        ),
        SubjectiveGrader.record_grading(
            question_no=11, question_type="证明题", max_score=15,
            student_answer="证明：...（过程基本完整，个别步骤跳跃）...",
            correct_answer="完整证明过程",
            obtained_score=12,
            deduction_reasons=["整体逻辑正确得12分", "个别中间步骤跳跃扣3分"],
            comment="证明思路清晰，建议补充中间步骤使过程更严密。",
            error_types=["格式性错误"]
        ),
        SubjectiveGrader.record_grading(
            question_no=12, question_type="简答题", max_score=20,
            student_answer="二次函数的图像是抛物线...（回答较为简略）",
            correct_answer="二次函数y=ax²+bx+c(a≠0)的图像是抛物线，"
            "开口方向由a的符号决定...",
            obtained_score=14,
            deduction_reasons=["基本概念正确得14分", "回答不够详尽扣6分"],
            comment="核心概念正确，但回答不够全面，建议补充开口方向、"
                    "对称轴、顶点等要素。",
            error_types=["知识性错误", "格式性错误"]
        ),
    ]
    for r in subjective_results:
        task.add_result(r)

    # 输出批改结果
    print(f"学生：{task.student_name}（{task.class_name}）")
    print(f"学科：{task.subject}    年级：{task.grade}")
    print(f"总分：{task.total_score}分    得分：{task.get_total_obtained()}分"
          f"    得分率：{task.get_score_rate()}%    等级：{task.get_grade_level()}")
    print()
    print("各题得分一览：")
    for r in task.results:
        status = "✓" if r.is_correct else ("△" if r.is_correct is None else "✗")
        print(f"  第{r.question_no:2d}题 [{r.question_type}]  "
              f"{r.obtained_score:5.1f}/{r.max_score}  {status}")
    print()

    # 错误分布统计
    distribution = task.get_error_distribution()
    print("错误分布统计：")
    for error_type, count in distribution.items():
        if count > 0:
            bar = "█" * count
            print(f"  {error_type}：{bar} {count}处")
    print()

    # 生成并保存Markdown报告
    report = ReportGenerator.generate_markdown_report(task)
    print("【Markdown格式批改报告（节选）】")
    print(report[:2000])
    print("  ...（报告完整内容见上方输出）")
    print()

    return task


# ============================================================
#  主程序入口
# ============================================================

def main():
    """主程序：运行示例演示"""
    print()
    print("╔══════════════════════════════════════════════════════════╗")
    print("║          题目批改辅助脚本 - 功能演示                    ║")
    print("║          支持选择题自动批改 / 主观题记录 / 报告生成     ║")
    print("╚══════════════════════════════════════════════════════════╝")
    print()

    # 演示一：选择题自动批改
    demo_objective_grading()

    print()
    print("-" * 60)
    print()

    # 演示二：主观题批改记录
    demo_subjective_grading()

    print()
    print("-" * 60)
    print()

    # 演示三：混合题型批改
    demo_mixed_grading()

    print()
    print("=" * 60)
    print("  所有演示完成！")
    print("  本脚本支持以下功能：")
    print("  1. ObjectiveGrader - 客观题自动批改（单选/多选/判断）")
    print("  2. SubjectiveGrader - 主观题批改记录（填空/简答/计算/证明/作文）")
    print("  3. ReportGenerator - Markdown格式批改报告生成")
    print("  4. GradingTask - 批改任务管理与成绩汇总")
    print("=" * 60)
    print()


if __name__ == "__main__":
    main()
