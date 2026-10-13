# -*- coding: utf-8 -*-
"""备课 Agent 运行器：Qoder Agent SDK 真引擎 + Mock 离线回退。

引擎选择（pick_engine）：
  1. 环境变量 AGENT_USE_QODER=0 → 强制 mock（灰度开关/回滚）；
  2. qoder_agent_sdk 可导入 且 认证可用（QODER_PERSONAL_ACCESS_TOKEN 环境变量
     或本机 qodercli 登录态）→ qoder 真引擎；
  3. 否则 → mock（同一套数据工具与生成脚本，输出确定性可验证）。

两引擎共同点（质量要求内建于工具层）：
  - 数据工具（kongmeng-data，只读）：usage / class_stats / student_profile / kb / memory；
  - 生成工具（kongmeng-export）：gen_lesson_plan / gen_ppt —— 质量硬校验失败返回
    isError+问题清单，真引擎在 Agent 循环内自修复重试，mock 则确定性满足；
  - 产物统一登记 EXPORT_REGISTRY，由 /api/agent/lesson_prep 取走落历史。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import Any, Dict, List

from .. import databus, kb
from . import export_tools
from .bus_tools import MCP_SERVER_NAME, build_sdk_mcp_server, tool_full_names as data_tool_names
from .export_tools import MCP_EXPORT_SERVER_NAME, build_sdk_mcp_server as build_export_server
from .export_tools import tool_full_names as export_tool_names
from .prompts import LESSON_PREP_SYSTEM_PROMPT

try:  # SDK 可用性探测（延迟到真正运行时才启动 qodercli 子进程）
    import qoder_agent_sdk as _sdk

    SDK_AVAILABLE = True
    SDK_VERSION = getattr(_sdk, "__version__", "")
except Exception:  # pragma: no cover
    _sdk = None
    SDK_AVAILABLE = False
    SDK_VERSION = ""

_ROOT_HINT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


# ---------------------------------------------------------------------------
# 引擎探测
# ---------------------------------------------------------------------------
def _pat_available() -> bool:
    if os.environ.get("QODER_PERSONAL_ACCESS_TOKEN", "").strip():
        return True
    auth = os.path.join(os.path.expanduser("~"), ".qoder", ".auth")
    return os.path.exists(auth)


def engine_status() -> Dict[str, Any]:
    return {
        "sdkAvailable": SDK_AVAILABLE,
        "sdkVersion": SDK_VERSION,
        "patOrCliAuth": _pat_available(),
        "useQoderSwitch": os.environ.get("AGENT_USE_QODER", "1") != "0",
        "engine": pick_engine(),
        "mcpServers": [MCP_SERVER_NAME, MCP_EXPORT_SERVER_NAME] if SDK_AVAILABLE else [],
    }


def pick_engine() -> str:
    if os.environ.get("AGENT_USE_QODER", "1") == "0":
        return "mock"
    if SDK_AVAILABLE and _pat_available():
        return "qoder"
    return "mock"


# ---------------------------------------------------------------------------
# 旧格式兜底解析（Agent 未调用生成工具而是直接输出全文时使用）
# ---------------------------------------------------------------------------
PPT_SEPARATOR = "===PPT_SLIDES==="


def parse_agent_output(text: str) -> Dict[str, Any]:
    text = (text or "").strip()
    slides: List[Dict[str, Any]] = []
    plan = text
    if PPT_SEPARATOR in text:
        parts = text.split(PPT_SEPARATOR, 1)
        plan = parts[0].strip()
        raw = re.sub(r"^```(?:json)?\s*|```\s*$", "", parts[1].strip()).strip()
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                slides = [s for s in data if isinstance(s, dict) and s.get("title")]
        except Exception:
            slides = []
    if not slides:
        slides = _slides_from_plan(plan)
    if not plan.startswith("#"):
        plan = "# 教案：备课方案\n" + plan
    return {"plan": plan, "slides": slides}


def _slides_from_plan(plan: str) -> List[Dict[str, Any]]:
    titles = []
    for m in re.finditer(r"^#{1,3}\s+(.+)$", plan, flags=re.M):
        t = m.group(1).strip()
        if t and t not in titles:
            titles.append(t)
    slides = [{"title": "封面", "content": "", "note": "课题与授课教师"}]
    for t in titles[:14]:
        slides.append({"title": t, "content": "", "note": "与教案对应章节"})
    return slides


def _slide_titles_in_plan(slides: List[Dict[str, Any]], plan: str) -> float:
    """PPT-教案对应率：跳过结构页（封面/目录/结束），标题去掉括号后缀后比对。"""
    counted = [s for s in slides if s.get("layout") not in ("title", "toc", "end")]
    if not counted:
        return 1.0
    hit = 0
    for s in counted:
        base = re.sub(r"[（(].*?[)）]\s*$", "", str(s.get("title", "")).strip()).strip()
        if base and base in plan:
            hit += 1
    return round(hit / len(counted), 3)


# ---------------------------------------------------------------------------
# Qoder 真引擎
# ---------------------------------------------------------------------------
def _all_allowed_tools() -> List[str]:
    return data_tool_names() + export_tool_names()


async def run_with_qoder(request: Dict[str, Any]) -> Dict[str, Any]:
    export_tools.reset_registry()
    opts_kwargs: Dict[str, Any] = {
        "cwd": _ROOT_HINT,
        "setting_sources": [],
        "system_prompt": LESSON_PREP_SYSTEM_PROMPT,
        "mcp_servers": {
            MCP_SERVER_NAME: build_sdk_mcp_server(),
            MCP_EXPORT_SERVER_NAME: build_export_server(),
        },
        "tools": _all_allowed_tools(),
        "allowed_tools": _all_allowed_tools(),
        "max_turns": 32,
        "permission_mode": "default",
    }
    pat = os.environ.get("QODER_PERSONAL_ACCESS_TOKEN", "").strip()
    if pat:
        opts_kwargs["auth"] = _sdk.access_token_from_env()
    else:
        opts_kwargs["auth"] = _sdk.qodercli_auth()

    async def _can_use_tool(tool_name: str, _input: Dict[str, Any], _ctx: Any = None) -> Dict[str, Any]:
        if tool_name.startswith(f"mcp__{MCP_SERVER_NAME}__") or tool_name.startswith(f"mcp__{MCP_EXPORT_SERVER_NAME}__"):
            return {"behavior": "allow", "updatedInput": _input}
        return {"behavior": "deny", "message": f"备课 Agent 仅允许数据查询与产物生成工具，拒绝：{tool_name}"}

    opts_kwargs["can_use_tool"] = _can_use_tool
    options = _sdk.QoderAgentOptions(**opts_kwargs)

    prompt = _build_prompt(request)
    collected: List[str] = []
    subtype = ""
    deadline = time.time() + float(os.environ.get("AGENT_QODER_TIMEOUT", "600"))
    async for msg in _sdk.query(prompt=prompt, options=options):
        if time.time() > deadline:
            break
        mtype = getattr(msg, "type", "")
        if mtype == "assistant":
            m = getattr(msg, "message", None)
            for block in (m.content if m else []):
                if getattr(block, "type", "") == "text" and getattr(block, "text", ""):
                    collected.append(block.text)
        elif mtype == "result":
            subtype = getattr(msg, "subtype", "") or ""
            break

    reg = list(export_tools.EXPORT_REGISTRY)
    if reg:
        lp = next((a for a in reg if a["kind"] == "lesson_plan"), {})
        ppt = next((a for a in reg if a["kind"] == "ppt"), {})
        return {
            "engine": "qoder",
            "engineDetail": {"sdkVersion": SDK_VERSION, "resultSubtype": subtype, "toolsUsed": True},
            "plan": ("\n".join(collected).strip()
                     or f"# 教案：已由 gen_lesson_plan 落盘\n路径：{lp.get('relPath', '')}"),
            "slides": [],
            "artifacts": reg,
            "genQuality": {"lessonPlan": lp, "ppt": ppt},
        }
    # 兜底：Agent 未调用生成工具而是输出了全文 → 旧格式解析（由 API 层走旧导出）
    parsed = parse_agent_output("\n".join(collected))
    return {"engine": "qoder",
            "engineDetail": {"sdkVersion": SDK_VERSION, "resultSubtype": subtype, "toolsUsed": False},
            **parsed}


def _build_prompt(request: Dict[str, Any]) -> str:
    return (
        "请为以下备课需求完成全流程：\n"
        f"- 学科：{request.get('subject', '')}\n"
        f"- 课题：{request.get('topic', '')}\n"
        f"- 年级：{request.get('grade', '')}\n"
        f"- 班级 ID：{request.get('classId', '')}\n"
        f"- 教师补充要求：{request.get('teacherInput') or '无'}\n"
        "按系统提示词的四步流程执行：先读数据工具，再调用 gen_lesson_plan 生成教案，"
        "然后调用 gen_ppt 生成多版式 PPT，最后简短收尾。质量不达标工具会返回问题清单，务必修正重试。"
    )


# ---------------------------------------------------------------------------
# Mock 引擎（确定性、数据驱动；调用与真引擎完全相同的生成脚本与质量校验）
# ---------------------------------------------------------------------------
def _build_mock_plan(request: Dict[str, Any], usage: Dict[str, Any], stats: Dict[str, Any],
                     kb_nodes: List[Dict[str, Any]]) -> str:
    subject = str(request.get("subject") or "数学")
    topic = str(request.get("topic") or "专题")
    teacher_input = str(request.get("teacherInput") or "")
    weak = stats.get("weakKps") or []
    blind = stats.get("blindKps") or []
    all_kps = stats.get("allKps") or []
    tier = stats.get("tierDist") or {}
    top_ask = stats.get("topAskedKps") or []

    weak_txt = "、".join(f"{w['kp']}（掌握率{w['mastery_pct']}%，薄弱面{int(round(w['weak_ratio'] * 100))}%）" for w in weak) or "暂无（样本不足）"
    blind_txt = "、".join(f"{b['kp']}（掌握率{b['mastery_pct']}%）" for b in blind) or "暂无"
    ask_txt = "、".join(f"{a['kp']}（{a['count']}次）" for a in top_ask) or "暂无提问记录"
    tier_txt = f"优秀 {tier.get('top', 0)} 人 / 中等 {tier.get('mid', 0)} 人 / 学困 {tier.get('base', 0)} 人" if tier else "暂无考试分层数据"
    kp_line = "；".join(f"{k['kp']} {k['masteryPct']}%" for k in all_kps[:8]) or "暂无"

    return f"""# 教案：{topic}

## 一、课标依据与教材分析
本课属高中{subject}核心内容，对应教材知识树节点：{('、'.join(str(n.get('kp_id')) for n in kb_nodes)) or '（知识库暂未收录该课题，依课标通用要求设计）'}。
课标要求学生经历从具体情境中抽象出核心概念的过程，理解其本质并能运用解决综合问题，同时发展数学抽象与逻辑推理素养。
{(('知识库检索要点：' + '；'.join(str(n.get('knowledge_point')) for n in kb_nodes if n.get('knowledge_point')))) if kb_nodes else ''}

## 二、学情分析（数据来源：学情数据总线，截至 version {stats.get('version', 0)}）
### 数据速览（学情画像）
本课设计前已读取数据总线：提问 {usage.get('qaRecords', {}).get('count', 0)} 条、批改 {usage.get('gradeRecords', {}).get('count', 0)} 条（确认 {usage.get('gradeRecords', {}).get('confirmed', 0)} 条）、成绩 {usage.get('examScores', {}).get('count', 0)} 条、画像 {usage.get('profileCells', 0)} 格。
1. **班级构成**：数据总线登记学生 {usage.get('students', 0)} 人；最近一次考试分层：{tier_txt}。
2. **知识点掌握概况**：{kp_line}。
3. **薄弱知识点（掌握率 40%-60%）**：{weak_txt}。
4. **盲区知识点（掌握率 < 40%）**：{blind_txt}——本课必须安排针对性补救环节。
5. **提问证据链（近 30 天学生提问板块高频知识点）**：{ask_txt}。提问频次与批改错因交叉印证，说明学生在相关概念的理解与迁移上存在困难。
6. **批改数据**：累计批改记录 {usage.get('gradeRecords', {}).get('count', 0)} 条（教师确认 {usage.get('gradeRecords', {}).get('confirmed', 0)} 条）；提问记录 {usage.get('qaRecords', {}).get('count', 0)} 条；成绩导入 {usage.get('examScores', {}).get('count', 0)} 条。

## 三、教学目标（学习目标）
1. 知识与技能：理解{topic}的核心概念与判定方法，能独立完成基础题型；针对薄弱知识点「{(weak[0]['kp'] if weak else '核心概念')}」达到 70% 以上课堂检测正确率。
2. 过程与方法：经历「情境观察→概念抽象→方法归纳→变式迁移」的完整探究过程，渗透数形结合与分类讨论思想。
3. 情感态度：在数据反馈中看见自己的进步，建立学习信心；养成先审题再动笔的规范习惯。

## 四、教学重难点
- **重点**：{topic}核心概念的形成与基本方法的规范表达。
- **难点**：{(weak[0]['kp'] if weak else '综合情境下的方法选择')}——学情数据显示该点掌握率仅 {(weak[0]['mastery_pct'] if weak else '——')}%，属于薄弱区。
- **突破策略**：从学生高频提问的具体疑问切入（{ask_txt}），用阶梯式设问拆解认知负荷；配合易错警示页集中纠偏。

## 五、教学过程（共 45 分钟）
### 环节一：情境导入（5 分钟）
【教师活动】展示与{topic}相关的生活情境/前置作业典型错误，提出核心问题。
【学生活动】观察、口答初步猜想。
【设计意图】激活先备知识，暴露原始认知。
### 环节二：概念建构（10 分钟）
【教师活动】引导抽象定义，板书关键要素；针对「{(weak[0]['kp'] if weak else '核心概念')}」用正反例对照辨析。
【学生活动】小组归纳定义要素，完成概念判断 2 题。
【设计意图】概念本源理解优先于技巧，直指薄弱点的认知根因。
### 环节三：例题精讲（12 分钟）
【教师活动】例题 1 逐步板演（见例题部分），每步追问依据；例题 2 学生先试后讲。
【学生活动】独立尝试例题 2，两名学生板演，全班纠错。
【设计意图】规范解题表达，渗透得分点意识。
### 环节四：变式迁移与易错警示（10 分钟）
【教师活动】发布变式训练；集中展示「{(weak[0]['kp'] if weak else '高频易错点')}」的三类典型错误（对应批改错因统计）。
【学生活动】限时完成变式，同桌互评纠错。
【设计意图】在变式中检验方法迁移，集中纠偏薄弱点。
### 环节五：课堂小结与分层作业布置（8 分钟）
【教师活动】引导学生用一句话总结方法链；按分层布置作业（见分层作业部分）。
【学生活动】自主梳理知识结构图。
【设计意图】结构化收束，作业与课堂分层一致。

**跨板块数据印证**：批改错因（题目批改板块）与提问频次（学生提问板块）在本课重难点选择上交叉印证——「{(weak[0]['kp'] if weak else '核心概念')}」既是低掌握率知识点也是高频提问知识点，故安排两个教学环节专门突破。

## 六、例题与变式
**例题 1 精讲**（概念直接应用）：设 $f(x)=x^3-3x$，求 $f(x)$ 在 $[-2,2]$ 上的最大值与最小值。解答：① 求导得 $f'(x)=3x^2-3$；② 令 $f'(x)=0$ 得 $x=\\pm1$；③ 列表判断单调区间；④ 比较端点与极值点得 $f(-1)=3$ 为最大值、$f(1)=-1$ 为最小值。每一步标注得分点：求导 2 分、解方程 2 分、单调性讨论 3 分、结论 3 分。
**例题 2 学生试做**（方法综合）：融合「{(weak[0]['kp'] if weak else '核心方法')}」的两步综合题，先由学生独立尝试并板演，再全班讲评，重点纠正批改数据中出现的高频步骤错误。
**变式训练**：将例题 2 条件改为逆向设问（已知最值反求参数范围），检验学生是否真正理解而非记忆套路。
**易错提醒**：批改数据显示「{weak_txt}」为高发错误区，解题前先圈画条件关键词，完成后代入检验。

## 七、分层作业（与班级分层对应：{tier_txt}）
- **基础巩固（学困/全体必做）**：3 道概念与基本方法题，直接对准薄弱知识点「{(weak[0]['kp'] if weak else '基础概念')}」。
- **能力提升（中等/选做）**：2 道两步综合题，含一道变式。
- **拓展压轴（优秀/挑战）**：1 道含参讨论或跨知识点综合题。
- 学困生附加：错题订正单（引用个人最近批改记录中的错因）。

## 八、板书设计
主板书：{topic}知识框架（定义→判定→应用）；副板书：例题 1 规范解答与易错批注。

## 九、教学反思预设
1. 薄弱点的阶梯设问是否有效降低了认知负荷？
2. 课堂检测正确率是否达到预设的 70%？未达标时的补救预案：课后推送 3 道同类题至提问板块跟踪。

## 十、数据使用说明
- **学生提问板块**：{usage.get('qaRecords', {}).get('count', 0)} 条提问记录（最近 {usage.get('qaRecords', {}).get('lastAt') or '—'}），用于薄弱证据链与讲解深度设定；
- **题目批改板块**：{usage.get('gradeRecords', {}).get('count', 0)} 条逐题记录（教师确认 {usage.get('gradeRecords', {}).get('confirmed', 0)} 条），用于掌握率与错因统计；
- **学情分析板块**：{usage.get('examScores', {}).get('count', 0)} 条考试成绩，用于分层与趋势；
- **画像层**：当前 {stats.get('kpCount', 0)} 个知识点画像格子（version {stats.get('version', 0)}）；
- **数据缺口**：掌握率仅统计教师确认的结构化批改记录；前端批改摘要与未标注 kp 的提问不进入口径。
{('- 教师补充要求已纳入设计：' + teacher_input) if teacher_input else ''}

## 十一、教学资源与教具准备
多媒体课件（本 PPT 共 14 页，与教案章节一一对应）；课堂检测单 6 份（对应薄弱知识点各 2 题）；分层作业纸（A/B/C 三档）；几何画板动态演示资源；学生错题订正单（由批改记录自动生成）。

## 十二、评价设计
1. **课堂即时评价**：概念判断 2 题（环节二）与变式 1 题（环节四）当堂反馈，目标正确率 ≥70%——薄弱知识点「{(weak[0]['kp'] if weak else '核心概念')}」为首要观测点。
2. **作业分层评价**：基础层全批全改、提升层抽查板演、拓展层面批点拨；错题自动回流批改板块，纳入下一轮学情画像。
3. **数据闭环**：本次课堂检测与作业成绩将写回数据总线（grade_records），持续修正掌握率与分层，实现「备课—批改—学情」循环。""".strip()


def _build_mock_slides(request: Dict[str, Any], stats: Dict[str, Any], topic: str) -> List[Dict[str, Any]]:
    subject = str(request.get("subject") or "数学")
    grade = str(request.get("grade") or "高三")
    weak = stats.get("weakKps") or []
    all_kps = stats.get("allKps") or []
    tier = stats.get("tierDist") or {}
    top_ask = stats.get("topAskedKps") or []
    weak0 = weak[0]["kp"] if weak else "核心概念"
    weak0_pct = weak[0]["mastery_pct"] if weak else "——"

    labels = [k["kp"].split("-")[-1] for k in all_kps[:6]]
    values = [k["masteryPct"] or 0 for k in all_kps[:6]]

    return [
        {"layout": "title", "title": topic,
         "subtitle": f"高中{subject} · {grade} · 基于学情画像的精准教学"},
        {"layout": "toc", "title": "目录",
         "points": ["数据速览：班级学情画像", "学习目标与重难点", "概念建构与正反辨析",
                    "例题精讲与变式训练", "易错警示与分层作业", "课堂小结与课后思考"]},
        {"layout": "chart", "title": "数据速览（学情画像）",
         "chartData": {"labels": labels, "values": values, "title": "各知识点班级掌握率（%）"},
         "points": [f"班级薄弱知识点：{('、'.join(w['kp'] + ' ' + str(w['mastery_pct']) + '%' for w in weak)) or '暂无'}（红/绿虚线为 60%/85% 达标线）",
                    f"近 30 天高频提问：{('、'.join(a['kp'] + ' ' + str(a['count']) + ' 次' for a in top_ask)) or '暂无'}，与批改错因交叉印证",
                    f"考试分层：优秀 {tier.get('top', 0)} 人 / 中等 {tier.get('mid', 0)} 人 / 学困 {tier.get('base', 0)} 人——决定分层作业配比"],
         "summary": "本课重点针对掌握率低于 60% 的薄弱知识点展开，讲解深度从概念本源起步。"},
        {"layout": "summary", "title": "学习目标",
         "points": [f"知识：理解{topic}的核心概念与判定方法，能规范完成基础题型",
                    "方法：经历「情境→概念→方法→变式」完整链条，掌握数形结合工具",
                    f"达成：课堂检测针对「{weak0}」（掌握率 {weak0_pct}%）达到 70% 正确率",
                    "习惯：先圈画条件关键词再动笔，完成后代入检验"],
         "summary": "目标可直接观测：以薄弱知识点课堂正确率 70% 为达成线。"},
        {"layout": "concept", "title": "教学重难点",
         "box": f"重点：{topic}核心概念的形成与基本方法的规范表达。\n难点：{weak0}（掌握率 {weak0_pct}%，薄弱区）。",
         "points": ["难点成因：批改数据显示该点错误集中于概念混淆与步骤跳步，提问板块亦高频出现",
                    "突破策略一：阶梯式设问，从具体数值情境抽象到一般形式，拆解认知负荷",
                    "突破策略二：正反例对照辨析，先建立判断标准再做变式迁移",
                    "突破策略三：课堂检测即时反馈，未达标当堂补救"],
         "summary": "重难点直接由数据确定：掌握率最薄弱处即本课主攻方向。"},
        {"layout": "twocolumn", "title": "概念建构（正反辨析）",
         "left": {"heading": "正确理解（正例）",
                  "points": ["紧扣定义三要素：条件、对象、结论，逐条对照题目再下判断",
                             "单调性用导数符号判定：f'(x)>0 递增、f'(x)<0 递减，且在区间内恒成立",
                             "表述规范：先写定义域，再写判断过程，最后下结论"]},
         "right": {"heading": "常见误区（反例）",
                   "points": ["忽视定义域先行，直接对式子求导判定（批改高频错误）",
                              "把「区间内恒成立」误写成「存在一点成立」（概念混淆）",
                              "跳步：不列导数方程直接写单调区间（步骤分丢失）"]},
         "summary": "正反对照建立判断标准：定义域先行、恒成立意识、规范表达。"},
        {"layout": "case", "title": "例题 1 精讲（图文混排）",
         "caseText": "设 $f(x)=x^3-3x$，求 $f(x)$ 在区间 $[-2,2]$ 上的最大值与最小值。（10 分）",
         "points": ["第一步：求导 $f'(x)=3x^2-3$，先确认 f(x) 在闭区间上可导（2 分）",
                    "第二步：令 $f'(x)=0$，解得 $x=\\pm1$，均在 $[-2,2]$ 内（2 分）",
                    "第三步：列表判断单调性——$[-2,-1]$ 增、$[-1,1]$ 减、$[1,2]$ 增（3 分）",
                    "第四步：比较端点与极值：$f(-1)=3$ 最大，$f(1)=-1$ 最小（3 分）"],
         "plotSpec": {"kind": "function", "expr": "x**3-3*x", "range": [-2, 2],
                      "title": "y = x³ − 3x 在 [−2,2] 上的图像"},
         "summary": "四步模板：求导→解方程→列表判单调→比较取最值，每步对应得分点。"},
        {"layout": "case", "title": "例题 2 学生试做",
         "caseText": "已知函数 $f(x)=x^3+ax+1$ 在 $x=1$ 处取得极值，求实数 a 的值并判断极值类型。（综合题）",
         "points": ["学生先独立尝试 3 分钟，两名板演（教师巡视收集典型错误）",
                    "关键点：极值点处 $f'(1)=0$ 得 $a=-3$，再验证 $x=1$ 两侧导数变号",
                    "易错：只解方程不变号验证——「驻点」不一定是「极值点」，需说明两侧单调性改变",
                    "讲评聚焦批改数据中的高频步骤错误，规范书写极值判断过程"],
         "summary": "极值判断必须「求导＋变号验证」两步齐全，防止单纯解方程的假会。"},
        {"layout": "concept", "title": "变式训练",
         "box": "变式（逆向设问）：已知 $f(x)=x^3-3x$ 在 $[a,a+1]$ 上的最大值为 3，求实数 a。\n要求：限时 6 分钟，同桌互评。",
         "points": ["逆向设问检验真理解：从「给区间求最值」反转为「给最值定区间」",
                    "讨论分类：按 a 的位置分三种情形（相对单调区间的位置关系）",
                    "互评标准：分类是否完整、每类最值比较是否到位、结论是否回应设问"],
         "summary": "变式的价值在于迁移：同一方法链在不同设问方向上的再运用。"},
        {"layout": "chart", "title": "易错警示（数据支撑）",
         "chartData": {"labels": [w["kp"].split("-")[-1] for w in weak[:5]] or ["样本不足"],
                       "values": [round(w["weak_ratio"] * 100, 1) for w in weak[:5]] or [0],
                       "title": "薄弱知识点班级薄弱面（掌握率<60% 学生占比 %）"},
         "points": ["错误类型一：概念混淆——定义要素记忆不清（批改标注「知识错误」最多）",
                    "错误类型二：计算失误——求导或解方程运算出错（「计算错误」次之）",
                    "错误类型三：审题偏差——忽略定义域/区间限制（「审题错误」反复出现）",
                    "对策：解题前圈画条件关键词，完成后代入检验，订正单追踪到人"],
         "summary": "三类高发错误均有数据出处，课堂警示与课后订正单一一对应。"},
        {"layout": "table", "title": "分层作业",
         "table": {"headers": ["层次", "题量", "内容要求", "对应人数"],
                   "rows": [["基础巩固", "3 题", f"概念与基本方法，直接对准「{weak0}」", f"学困 {tier.get('base', 0)} 人（必做）"],
                            ["能力提升", "2 题", "两步综合 + 1 道逆向变式", f"中等 {tier.get('mid', 0)} 人（选做）"],
                            ["拓展压轴", "1 题", "含参讨论 / 跨知识点综合", f"优秀 {tier.get('top', 0)} 人（挑战）"],
                            ["错题订正", "——", "引用个人最近批改记录错因，订正到步", "全体（按需）"]]},
         "summary": f"作业分层与考试分层人数一致，基础层直击「{weak0}」。"},
        {"layout": "summary", "title": "课堂小结",
         "points": [f"知识链：{topic}的定义 → 判定方法 → 综合应用（一句话方法链）",
                    f"数据链：本课目标对准掌握率 {weak0_pct}% 的薄弱点，下节课用检测数据检验达成",
                    "规范链：定义域先行 → 步骤完整 → 结论回应设问",
                    "习惯链：圈画条件 → 规范表达 → 代入检验"],
         "summary": "四条链收束全课：知识、数据、规范、习惯，环环有出处。"},
        {"layout": "concept", "title": "板书设计",
         "box": "主板书（左）：知识框架图——定义要素 / 判定方法 / 应用步骤三层结构。\n副板书（右）：例题 1 规范解答 + 易错批注（红笔）。",
         "points": ["主板书保留整节课，随教学进程逐层生成，形成完整知识地图",
                    "副板书动态书写学生板演与纠错过程，突出「错在哪、怎么改」",
                    "板书与 PPT 分工：PPT 呈现数据与情境，板书承载推理过程"],
         "summary": "板书承载思维过程，PPT 承载数据与情境，二者互补不重复。"},
        {"layout": "end", "title": "结束页",
         "points": ["思考题：若把例题 1 的区间改为 [a, a+1]，最大值会怎样变化？",
                    "预习任务：阅读教材下一节「函数的极值与最值」前两段，标记疑问"]},
    ]


def run_with_mock(request: Dict[str, Any]) -> Dict[str, Any]:
    export_tools.reset_registry()
    subject = str(request.get("subject") or "数学")
    topic = str(request.get("topic") or "专题")
    class_id = str(request.get("classId") or "")

    usage = databus.data_usage(class_id=class_id, subject=subject)
    stats = databus.class_stats(class_id, subject) if class_id else {}
    kbn = kb.retrieve(subject=subject, topic=topic)
    kb_nodes = (kbn.get("matched_nodes") or [])[:4]

    plan = _build_mock_plan(request, usage, stats, kb_nodes)
    slides = _build_mock_slides(request, stats, topic)

    # 与真引擎同一套生成脚本与质量硬校验（不达标抛 ValueError）
    gen_errors: List[str] = []
    lp_quality: Dict[str, Any] = {}
    ppt_quality: Dict[str, Any] = {}
    try:
        lp_quality = export_tools.generate_lesson_plan_tool(plan, topic)
    except ValueError as e:
        gen_errors.append(f"教案：{e}")
    try:
        ppt_quality = export_tools.generate_ppt_tool(
            slides, {"subject": subject, "grade": str(request.get("grade") or ""), "topic": topic})
    except ValueError as e:
        gen_errors.append(f"PPT：{e}")
    if gen_errors:
        raise RuntimeError("；".join(gen_errors))

    reg = list(export_tools.EXPORT_REGISTRY)
    return {
        "engine": "mock",
        "engineDetail": {"reason": "离线确定性引擎（AGENT_USE_QODER=0 或无 SDK 认证）；与真引擎共用生成脚本与质量校验"},
        "plan": plan,
        "slides": slides,
        "artifacts": reg,
        "genQuality": {"lessonPlan": lp_quality, "ppt": ppt_quality},
    }


# ---------------------------------------------------------------------------
# 统一门面
# ---------------------------------------------------------------------------
async def run_lesson_prep(request: Dict[str, Any]) -> Dict[str, Any]:
    engine = pick_engine()
    if engine == "qoder":
        try:
            out = await run_with_qoder(request)
        except Exception as e:  # noqa: BLE001 —— 真引擎失败自动回退，保证可用性
            # run_with_mock 是同步重活（databus 查询 + docx/pptx 渲染），
            # 必须放线程池执行，否则会卡死 FastAPI 事件循环（健康检查/SSE 全挂）
            out = await asyncio.to_thread(run_with_mock, request)
            out["engineDetail"] = {"reason": f"qoder 引擎失败回退 mock：{e}"}
            out["engine"] = "mock(fallback)"
    else:
        out = await asyncio.to_thread(run_with_mock, request)
    reg = out.get("artifacts") or []
    lp = next((a for a in reg if a["kind"] == "lesson_plan"), {})
    ppt = next((a for a in reg if a["kind"] == "ppt"), {})
    out["quality"] = {
        "structureOk": bool(lp.get("ok")),
        "missingSections": lp.get("issues") or ([] if lp else ["教案生成工具未调用"]),
        "planChars": lp.get("chars", len(out.get("plan", ""))),
        "lessonPlanScore": lp.get("score", 0),
        "slideCount": ppt.get("total", 0),
        "layoutStats": ppt.get("layoutStats", {}),
        "pptQualityOk": bool(ppt.get("ok")),
        "slideTitleHitRate": (_slide_titles_in_plan(out.get("slides", []), out.get("plan", ""))
                              if out.get("slides") else None),
    }
    return out
