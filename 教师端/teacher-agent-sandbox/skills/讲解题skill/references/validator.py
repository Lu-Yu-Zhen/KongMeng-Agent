"""
高中知识解答技能 - 后置校验脚本

用途：对AI生成的解答进行自动化质量检查，确保符合 style-guide.md 中的规范。
运行方式：
    python validator.py --input <解答文本文件路径>
    python validator.py --text "解答文本内容"

校验项目：
    1. 超纲内容检测
    2. 术语规范性检查
    3. 化学方程式格式检查
    4. 教材引用格式检查
    5. 答题格式检查
    6. 跨学科关联格式检查
    7. 负面语气检测
"""

import re
import argparse
import sys
import json
from typing import List, Dict, Tuple


class ValidationResult:
    """单个校验结果"""
    def __init__(self, rule_name: str, passed: bool, message: str, severity: str = "warning"):
        self.rule_name = rule_name
        self.passed = passed
        self.message = message
        self.severity = severity  # "error" / "warning" / "info"

    def to_dict(self) -> dict:
        return {
            "rule": self.rule_name,
            "passed": self.passed,
            "severity": self.severity,
            "message": self.message,
        }


# ==================== 校验规则 ====================

# 1. 超纲内容检测
OVERRANGE_PATTERNS = [
    (r"量子力学.*[算符|本征值|波函数]", "量子力学运算超纲"),
    (r"广义相对论.*[张量|度规]", "广义相对论超纲"),
    (r"拓扑学", "拓扑学超纲"),
    (r"抽象代数.*[群|环|域].*同构", "抽象代数超纲"),
    (r"数学分析.*(epsilon.*delta|柯西序列)", "数学分析严格定义超纲"),
    (r"量子化学.*[薛定谔|哈密顿]", "量子化学计算超纲"),
]

# 拓展内容未标注检测
UNMARKED_EXTENSION_KEYWORDS = [
    "大学里会学到", "大学阶段", "进一步研究", "高等数学中",
    "如果你以后学", "研究生阶段",
]


def check_overrange(text: str) -> List[ValidationResult]:
    """检查是否包含超纲内容"""
    results = []
    for pattern, desc in OVERRANGE_PATTERNS:
        if re.search(pattern, text):
            results.append(ValidationResult(
                "超纲内容检测", False,
                f"检测到可能超纲内容：{desc}。如需保留请标注【拓展了解，高考不考】",
                "error"
            ))

    # 检查拓展内容是否标注
    for kw in UNMARKED_EXTENSION_KEYWORDS:
        if kw in text:
            # 检查附近是否有拓展标注
            idx = text.index(kw)
            context = text[max(0, idx - 50):idx + len(kw) + 50]
            if "拓展了解" not in context and "高考不考" not in context:
                results.append(ValidationResult(
                    "拓展标注检测", False,
                    f"检测到拓展内容'{kw}'未标注【拓展了解，高考不考】",
                    "warning"
                ))
    if not results:
        results.append(ValidationResult("超纲内容检测", True, "未检测到超纲内容", "info"))
    return results


# 2. 术语规范性检查
INCORRECT_TERMS = [
    ("摩尔数", "物质的量"),
    ("分子量", "相对分子质量"),
    ("原子量", "相对原子质量"),
    ("质量守恒", "质量守恒定律（教材用语）"),
    ("一直变大", "单调递增"),
    ("一直变小", "单调递减"),
    ("用景色来表达感情", "借景抒情"),
    ("用物品来表达志向", "托物言志"),
]


def check_terminology(text: str) -> List[ValidationResult]:
    """检查术语是否规范"""
    results = []
    found = []
    for wrong, correct in INCORRECT_TERMS:
        if wrong in text:
            found.append(f"'{wrong}'→应改为'{correct}'")
    if found:
        results.append(ValidationResult(
            "术语规范性", False,
            "以下术语不规范：" + "；".join(found),
            "warning"
        ))
    else:
        results.append(ValidationResult("术语规范性", True, "术语使用规范", "info"))
    return results


# 3. 化学方程式格式检查
def check_chemical_equations(text: str) -> List[ValidationResult]:
    """检查化学方程式是否配平和标注条件"""
    results = []
    # 匹配类似 A + B → C + D 或 A + B = C + D 的化学方程式
    eq_pattern = r'[A-Za-z0-9₂₃₄₀-₉]+\s*(?:\+?\s*[A-Za-z0-9₂₃₄₀-₉()]+)*\s*[→=]\s*[A-Za-z0-9₂₃₄₀-₉()]+'
    equations = re.findall(eq_pattern, text)

    for eq in equations:
        issues = []
        # 检查是否有反应条件标注
        if "→" in eq or "=" in eq:
            # 查找上下文中是否有条件标注
            idx = text.find(eq)
            context = text[max(0, idx - 20):idx + len(eq) + 20]
            has_condition = any(c in context for c in ["△", "加热", "高温", "催化", "点燃", "通电", "催化剂"])
            has_reversible = "⇌" in eq
            if not has_condition and not has_reversible and "=" in eq and "+" in eq:
                issues.append("可能缺少反应条件标注（如△/催化剂等）")

        # 检查是否有↓或↑标注（简单启发式：产物含气体或沉淀常见物质时）
        gas_products = ["CO₂", "SO₂", "H₂", "O₂", "NH₃", "NO₂", "NO", "Cl₂"]
        precipitate_products = ["AgCl", "BaSO₄", "CaCO₃", "Mg(OH)₂", "Fe(OH)₃", "Cu(OH)₂"]
        for gas in gas_products:
            if gas in eq and "↑" not in eq:
                issues.append(f"产物{gas}可能需要标注↑")
                break
        for ppt in precipitate_products:
            if ppt in eq and "↓" not in eq:
                issues.append(f"产物{ppt}可能需要标注↓")
                break

        if issues:
            results.append(ValidationResult(
                "化学方程式格式", False,
                f"方程式'{eq}'：" + "；".join(issues),
                "warning"
            ))

    if not results:
        results.append(ValidationResult("化学方程式格式", True, "未检测到格式问题", "info"))
    return results


# 4. 教材引用格式检查
def check_textbook_citation(text: str) -> List[ValidationResult]:
    """检查教材引用格式是否规范"""
    results = []
    # 检测是否提到了教材
    citation_keywords = ["教材", "必修", "选择性必修", "人教版", "课本"]
    has_citation_ref = any(kw in text for kw in citation_keywords)

    if has_citation_ref:
        # 检查格式是否符合 （人教版xxx 第x章）
        valid_format = re.search(r'[（(].*(?:人教版|北师大版|鲁科版|鲁教版).*[）)]', text)
        if not valid_format:
            results.append(ValidationResult(
                "教材引用格式", False,
                "教材引用未使用规范格式（如：（人教版必修第一册 第X章 第X节））",
                "warning"
            ))
        else:
            results.append(ValidationResult("教材引用格式", True, "教材引用格式规范", "info"))
    else:
        results.append(ValidationResult("教材引用格式", True, "本次解答未引用教材（非必须）", "info"))
    return results


# 5. 答题格式检查
def check_answer_format(text: str) -> List[ValidationResult]:
    """检查答题是否分步骤、是否有结论"""
    results = []

    # 检查是否有分步骤
    has_steps = bool(re.search(r'(?:步骤|Step|①|②|③|1[.、]|2[.、]|3[.、])', text))
    # 检查是否有结论
    has_conclusion = bool(re.search(r'(?:∴|所以|故|因此|综上|结论)', text))

    # 如果是计算题/解答题（包含公式或计算）
    is_calculation = bool(re.search(r'[=＝].*[\d]+\s*$|[＝=].*[a-z]', text, re.MULTILINE))

    if is_calculation:
        if not has_steps:
            results.append(ValidationResult(
                "答题格式-分步", False,
                "计算/推导题建议分步骤作答（使用1. 2. 3. 或①②③）",
                "warning"
            ))
        if not has_conclusion:
            results.append(ValidationResult(
                "答题格式-结论", False,
                "建议在解答末尾给出明确结论（∴ / 所以 / 故）",
                "warning"
            ))

    if not results:
        results.append(ValidationResult("答题格式", True, "答题格式符合规范", "info"))
    return results


# 6. 跨学科关联格式检查
def check_cross_subject(text: str) -> List[ValidationResult]:
    """检查跨学科关联是否规范标注"""
    results = []
    # 检测跨学科关联内容
    cross_keywords = [
        "和物理", "和化学", "和生物", "和数学", "和语文", "和英语",
        "联系物理", "联系化学", "联系生物", "联系数学",
        "物理中", "化学中", "生物中", "数学中",
    ]
    found_cross = [kw for kw in cross_keywords if kw in text]

    if found_cross:
        has_proper_label = "跨学科关联" in text or "【跨学科" in text
        if not has_proper_label:
            results.append(ValidationResult(
                "跨学科关联格式", False,
                f"检测到跨学科内容（{found_cross[0]}等）但未标注【跨学科关联：X→Y】",
                "info"
            ))
        else:
            results.append(ValidationResult("跨学科关联格式", True, "跨学科关联标注规范", "info"))
    else:
        results.append(ValidationResult("跨学科关联格式", True, "本次解答无跨学科关联（非必须）", "info"))
    return results


# 7. 负面语气检测
NEGATIVE_PHRASES = [
    "这都不会", "这么简单", "你怎么连", "太差了", "笨",
    "你应该", "你必须", "你怎么不", "这么基础的",
]


def check_tone(text: str) -> List[ValidationResult]:
    """检测是否有负面/说教式语气"""
    results = []
    found = [phrase for phrase in NEGATIVE_PHRASES if phrase in text]
    if found:
        results.append(ValidationResult(
            "语气检查", False,
            f"检测到不当语气词汇：{', '.join(found)}。应使用鼓励性表达",
            "error"
        ))
    else:
        results.append(ValidationResult("语气检查", True, "语气积极友好", "info"))
    return results


# ==================== 主校验流程 ====================

def validate(text: str) -> Dict:
    """执行全部校验规则"""
    all_results = []
    all_results.extend(check_overrange(text))
    all_results.extend(check_terminology(text))
    all_results.extend(check_chemical_equations(text))
    all_results.extend(check_textbook_citation(text))
    all_results.extend(check_answer_format(text))
    all_results.extend(check_cross_subject(text))
    all_results.extend(check_tone(text))

    # 统计
    errors = sum(1 for r in all_results if not r.passed and r.severity == "error")
    warnings = sum(1 for r in all_results if not r.passed and r.severity == "warning")
    passed = sum(1 for r in all_results if r.passed)

    return {
        "summary": {
            "total_rules": len(all_results),
            "passed": passed,
            "warnings": warnings,
            "errors": errors,
            "overall": "PASS" if errors == 0 else "FAIL",
        },
        "details": [r.to_dict() for r in all_results],
    }


def print_report(result: Dict):
    """打印校验报告"""
    summary = result["summary"]
    print("=" * 60)
    print("  高中知识解答技能 - 校验报告")
    print("=" * 60)
    print(f"  总体结果: {'✓ 通过' if summary['overall'] == 'PASS' else '✗ 不通过'}")
    print(f"  通过: {summary['passed']}  警告: {summary['warnings']}  错误: {summary['errors']}")
    print("-" * 60)

    for detail in result["details"]:
        status = "✓" if detail["passed"] else ("✗" if detail["severity"] == "error" else "⚠")
        print(f"  {status} [{detail['rule']}] {detail['message']}")

    print("=" * 60)


def main():
    parser = argparse.ArgumentParser(description="高中知识解答技能 - 后置校验脚本")
    parser.add_argument("--input", "-i", type=str, help="解答文本文件路径")
    parser.add_argument("--text", "-t", type=str, help="解答文本内容（直接传入）")
    parser.add_argument("--json", "-j", action="store_true", help="以JSON格式输出结果")
    args = parser.parse_args()

    if args.input:
        with open(args.input, "r", encoding="utf-8") as f:
            text = f.read()
    elif args.text:
        text = args.text
    else:
        print("用法: python validator.py --input <文件路径>  或  --text <文本内容>")
        sys.exit(1)

    result = validate(text)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_report(result)

    # 有error时退出码为1
    sys.exit(0 if result["summary"]["errors"] == 0 else 1)


if __name__ == "__main__":
    main()
