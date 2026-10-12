# -*- coding: utf-8 -*-
"""
学情数据总线（四板块共享 · 单一事实源）
==========================================
学生提问 / 题目批改 / 学生学情分析 / 备课 四板块共用同一数据层：

  - 记录层（原始事实，append-only）：
      students        学生名册（伪 ID，L1 明文映射仅保留在端侧）
      qa_records      提问记录（学生提问板块 + 批改摘要事件 source=grading）
      grade_records   逐题批改记录（结构化：kp_id/score/error_type，教师确认后生效）
      exam_scores     考试成绩（学情板块导入，趋势分析）
  - 事件层（跨板块更新的唯一通道）：
      profile_events  事件溯源表：qa_created / grade_confirmed / score_imported /
                      profile_corrected（教师修正，最高优先级）；幂等 event_id、
                      失败重试 3 次进 dead、消费可重放
  - 画像层（派生数据，单写者 = 本总线消费者）：
      profiles        (student, subject, kp) 掌握度画像，乐观锁 version
      class_profiles  (class, subject, kp) 班级聚合
  - 治理层：
      audit_log       审计哈希链（who/action/outcome/prev_hash）

一致性设计（对应迁移方案 §5.5）：
  1) 单写者：profiles 仅由 consume_events 写，各板块只产事件；
  2) 幂等：event_id = type:ref 唯一约束，重放不重复累计；
  3) 乐观锁：画像更新 WHERE version=?，冲突则重读重算（确定性计算必收敛）；
  4) 教师权威：grade_records.teacher_confirmed 才计入口径；correction 事件覆盖 AI 结论；
  5) 记录与事件同事务落库（T0），写接口返回前同步消费（T1 秒级）。

掌握度口径（沿用「学生学情分析」技能标准）：
  mastery  = sum(score) / sum(full_score)   （该知识点全部已确认批改记录）
  分级     ≥85% 优秀 / 70-84% 良好 / 60-69% 一般 / 40-59% 薄弱 / <40% 盲区
  班级薄弱 = 班级均值 < 60% 的知识点
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
from typing import Any, Dict, List, Optional

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(_BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "kongmeng.db")

ERROR_TYPES = ("知识", "方法", "计算", "格式", "审题")

_lock = threading.RLock()
_local = threading.local()


def _conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
    return conn


def _now() -> float:
    return time.time()


SCHEMA = """
CREATE TABLE IF NOT EXISTS students (
    pseudo_id   TEXT PRIMARY KEY,          -- 伪 ID，如 P1001
    class_id    TEXT NOT NULL DEFAULT '',
    grade       TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS qa_records (
    qa_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    pseudo_id    TEXT NOT NULL,
    subject      TEXT NOT NULL,
    kp_ids       TEXT NOT NULL DEFAULT '[]',   -- JSON 数组；可为空（前端暂未标注知识点）
    question_digest TEXT NOT NULL DEFAULT '',  -- 摘要（截断，不存全文）
    depth        TEXT NOT NULL DEFAULT '',
    source       TEXT NOT NULL DEFAULT 'student-qa',  -- student-qa / grading
    session_ref  TEXT NOT NULL DEFAULT '',
    sensitivity  TEXT NOT NULL DEFAULT 'L2',
    created_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qa_student ON qa_records(pseudo_id, subject, created_at);
CREATE TABLE IF NOT EXISTS grade_records (
    grade_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    pseudo_id    TEXT NOT NULL,
    subject      TEXT NOT NULL,
    question_no  TEXT NOT NULL DEFAULT '',
    kp_id        TEXT NOT NULL DEFAULT '',
    score        REAL NOT NULL DEFAULT 0,
    full_score   REAL NOT NULL DEFAULT 0,
    error_type   TEXT NOT NULL DEFAULT '',     -- 知识/方法/计算/格式/审题
    comment      TEXT NOT NULL DEFAULT '',
    confidence   REAL NOT NULL DEFAULT -1,     -- AI 置信度 [0,1]，-1 表示无
    teacher_confirmed INTEGER NOT NULL DEFAULT 0,
    sensitivity  TEXT NOT NULL DEFAULT 'L2',
    created_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grade_student ON grade_records(pseudo_id, subject, kp_id);
CREATE TABLE IF NOT EXISTS exam_scores (
    exam_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    pseudo_id    TEXT NOT NULL,
    class_id     TEXT NOT NULL DEFAULT '',
    subject      TEXT NOT NULL,
    exam_name    TEXT NOT NULL DEFAULT '',
    exam_date    TEXT NOT NULL DEFAULT '',
    total        REAL NOT NULL DEFAULT 0,
    full_score   REAL NOT NULL DEFAULT 100,
    rank         INTEGER,
    scores       TEXT NOT NULL DEFAULT '{}',   -- JSON：逐题/逐 kp 得分（可选）
    sensitivity  TEXT NOT NULL DEFAULT 'L2',
    created_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exam_class ON exam_scores(class_id, subject, created_at);
CREATE TABLE IF NOT EXISTS profile_events (
    event_id     TEXT PRIMARY KEY,             -- 幂等键：type:ref_table:ref_id
    event_type   TEXT NOT NULL,
    ref_table    TEXT NOT NULL DEFAULT '',
    ref_id       TEXT NOT NULL DEFAULT '',
    priority     INTEGER NOT NULL DEFAULT 5,   -- 1 最高（profile_corrected）
    payload_digest TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'pending',  -- pending/done/failed/dead
    retry_count  INTEGER NOT NULL DEFAULT 0,
    error        TEXT NOT NULL DEFAULT '',
    created_at   REAL NOT NULL,
    consumed_at  REAL
);
CREATE INDEX IF NOT EXISTS idx_events_pending ON profile_events(status, priority, created_at);
CREATE TABLE IF NOT EXISTS profiles (
    pseudo_id    TEXT NOT NULL,
    subject      TEXT NOT NULL,
    kp_id        TEXT NOT NULL,
    mastery      REAL NOT NULL DEFAULT -1,     -- [0,1]；-1 表示尚无有效批改样本
    attempts     INTEGER NOT NULL DEFAULT 0,
    wrong_count  INTEGER NOT NULL DEFAULT 0,
    ask_count    INTEGER NOT NULL DEFAULT 0,   -- 提问频次（薄弱证据链）
    evidence_ids TEXT NOT NULL DEFAULT '[]',   -- JSON：来源 grade_id 列表（可回溯）
    version      INTEGER NOT NULL DEFAULT 0,
    updated_at   REAL NOT NULL,
    PRIMARY KEY (pseudo_id, subject, kp_id)
);
CREATE TABLE IF NOT EXISTS class_profiles (
    class_id     TEXT NOT NULL,
    subject      TEXT NOT NULL,
    kp_id        TEXT NOT NULL,
    avg_mastery  REAL NOT NULL DEFAULT -1,
    weak_ratio   REAL NOT NULL DEFAULT 0,      -- 掌握率<0.6 的学生占比
    sample_count INTEGER NOT NULL DEFAULT 0,
    tier_dist    TEXT NOT NULL DEFAULT '{}',   -- JSON：{top, mid, base}（考试得分率分层）
    tier_exam    TEXT NOT NULL DEFAULT '',     -- tier_dist 对应的考试名
    version      INTEGER NOT NULL DEFAULT 0,
    updated_at   REAL NOT NULL,
    PRIMARY KEY (class_id, subject, kp_id)
);
CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    who          TEXT NOT NULL DEFAULT '',
    action       TEXT NOT NULL,
    target       TEXT NOT NULL DEFAULT '',
    detail_digest TEXT NOT NULL DEFAULT '',
    data_level   TEXT NOT NULL DEFAULT 'L2',
    outcome      TEXT NOT NULL DEFAULT 'ok',
    prev_hash    TEXT NOT NULL DEFAULT '',
    row_hash     TEXT NOT NULL DEFAULT '',
    created_at   REAL NOT NULL
);
"""


def init_db() -> None:
    with _lock:
        conn = _conn()
        conn.executescript(SCHEMA)
        conn.commit()


# ---------------------------------------------------------------------------
# 审计（哈希链防篡改）
# ---------------------------------------------------------------------------
def _audit(conn: sqlite3.Connection, who: str, action: str, target: str,
           detail: str = "", data_level: str = "L2", outcome: str = "ok") -> None:
    row = conn.execute(
        "SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1"
    ).fetchone()
    prev = row["row_hash"] if row else ""
    ts = _now()
    digest = hashlib.sha256((detail or "").encode("utf-8")).hexdigest()[:16]
    row_hash = hashlib.sha256(
        f"{prev}|{who}|{action}|{target}|{ts}|{outcome}".encode("utf-8")
    ).hexdigest()
    conn.execute(
        "INSERT INTO audit_log(who, action, target, detail_digest, data_level, outcome, prev_hash, row_hash, created_at)"
        " VALUES(?,?,?,?,?,?,?,?,?)",
        (who, action, target, digest, data_level, outcome, prev, row_hash, ts),
    )


def audit_list(limit: int = 50) -> List[Dict[str, Any]]:
    with _lock:
        rows = _conn().execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


def audit_verify() -> Dict[str, Any]:
    """校验审计哈希链完整性。"""
    with _lock:
        rows = _conn().execute("SELECT * FROM audit_log ORDER BY id ASC").fetchall()
    prev = ""
    for r in rows:
        expect = hashlib.sha256(
            f"{prev}|{r['who']}|{r['action']}|{r['target']}|{r['created_at']}|{r['outcome']}".encode("utf-8")
        ).hexdigest()
        if r["prev_hash"] != prev or r["row_hash"] != expect:
            return {"ok": False, "broken_at": r["id"]}
        prev = r["row_hash"]
    return {"ok": True, "entries": len(rows)}


# ---------------------------------------------------------------------------
# 学生名册
# ---------------------------------------------------------------------------
def ensure_students(items: List[Dict[str, Any]]) -> int:
    """批量登记学生（伪 ID）。返回新增条数。"""
    n = 0
    with _lock:
        conn = _conn()
        for it in items:
            pid = str(it.get("pseudoId") or "").strip()
            if not _valid_pid(pid):
                continue
            cur = conn.execute(
                "INSERT OR IGNORE INTO students(pseudo_id, class_id, grade, note, created_at) VALUES(?,?,?,?,?)",
                (pid, str(it.get("classId") or ""), str(it.get("grade") or ""), str(it.get("note") or ""), _now()),
            )
            n += cur.rowcount or 0
        _audit(conn, "system", "ensure_students", f"batch:{len(items)}")
        conn.commit()
    return n


def _valid_pid(pid: str) -> bool:
    return pid.startswith("P") and pid[1:].isdigit() and 3 <= len(pid) <= 6


def list_students(class_id: str = "") -> List[Dict[str, Any]]:
    sql = "SELECT * FROM students"
    args: List[Any] = []
    if class_id:
        sql += " WHERE class_id=?"
        args.append(class_id)
    sql += " ORDER BY pseudo_id"
    with _lock:
        rows = _conn().execute(sql, args).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# 写入路径（T0：记录 + 事件同事务）
# ---------------------------------------------------------------------------
def _enqueue(conn: sqlite3.Connection, event_type: str, ref_table: str, ref_id: str,
             priority: int = 5, detail: str = "") -> None:
    event_id = f"{event_type}:{ref_table}:{ref_id}"
    digest = hashlib.sha256((detail or "").encode("utf-8")).hexdigest()[:16]
    conn.execute(
        "INSERT INTO profile_events(event_id, event_type, ref_table, ref_id, priority, payload_digest, status, created_at)"
        " VALUES(?,?,?,?,?,?,'pending',?)"
        " ON CONFLICT(event_id) DO NOTHING",
        (event_id, event_type, ref_table, ref_id, priority, digest, _now()),
    )


def save_qa(pseudo_id: str, subject: str, kp_ids: Optional[List[str]] = None,
            question_digest: str = "", depth: str = "", source: str = "student-qa",
            session_ref: str = "") -> Dict[str, Any]:
    # 学生提问必须带伪 ID；批改摘要（source=grading）允许班级级记录（pseudo_id 置空）
    if source == "student-qa" and not _valid_pid(pseudo_id):
        raise ValueError("pseudoId 非法（应为 P+数字，如 P1001）")
    if not subject:
        raise ValueError("subject 不能为空")
    if source not in ("student-qa", "grading"):
        raise ValueError("source 仅支持 student-qa / grading")
    kps = json.dumps([str(k) for k in (kp_ids or [])][:10], ensure_ascii=False)
    digest = str(question_digest or "")[:200]
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                "INSERT INTO qa_records(pseudo_id, subject, kp_ids, question_digest, depth, source, session_ref, created_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (pseudo_id, subject, kps, digest, depth, source, session_ref, _now()),
            )
            qa_id = int(cur.lastrowid)
            _enqueue(conn, "qa_created", "qa_records", str(qa_id), priority=5, detail=digest)
            _audit(conn, "section:qa" if source == "student-qa" else "section:grading",
                   "save_qa", f"qa:{qa_id}", digest)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    consume_events()  # T1：写后同步消费（秒级画像）
    return {"qaId": qa_id, "pseudoId": pseudo_id, "subject": subject}


def save_grades(pseudo_id: str, subject: str, items: List[Dict[str, Any]],
                teacher_confirmed: bool = True) -> Dict[str, Any]:
    """逐题批改落库。teacher_confirmed=False 的记录仅存档，不计入口径。"""
    if not _valid_pid(pseudo_id):
        raise ValueError("pseudoId 非法")
    if not items:
        raise ValueError("items 不能为空")
    ids: List[int] = []
    with _lock:
        conn = _conn()
        try:
            for it in items:
                kp = str(it.get("kpId") or "").strip()
                score = float(it.get("score") or 0)
                full = float(it.get("fullScore") or 0)
                et = str(it.get("errorType") or "").strip()
                if full <= 0:
                    raise ValueError(f"fullScore 必须大于 0（题 {it.get('questionNo')}）")
                if score < 0 or score > full:
                    raise ValueError(f"score 越界（题 {it.get('questionNo')}：{score}/{full}）")
                if et and et not in ERROR_TYPES:
                    raise ValueError(f"errorType 非法：{et}（允许：{'/'.join(ERROR_TYPES)}）")
                cur = conn.execute(
                    "INSERT INTO grade_records(pseudo_id, subject, question_no, kp_id, score, full_score,"
                    " error_type, comment, confidence, teacher_confirmed, created_at)"
                    " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (pseudo_id, subject, str(it.get("questionNo") or ""), kp, score, full,
                     et, str(it.get("comment") or "")[:300],
                     float(it.get("confidence", -1)) if it.get("confidence") is not None else -1,
                     1 if teacher_confirmed else 0, _now()),
                )
                gid = int(cur.lastrowid)
                ids.append(gid)
                if teacher_confirmed and kp:
                    _enqueue(conn, "grade_confirmed", "grade_records", str(gid),
                             priority=5, detail=f"{pseudo_id}:{subject}:{kp}")
            _audit(conn, "section:grading", "save_grades", f"{pseudo_id}:{subject}", f"count={len(ids)}")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    if teacher_confirmed:
        consume_events()
    return {"gradeIds": ids, "pseudoId": pseudo_id, "subject": subject,
            "count": len(ids), "teacherConfirmed": bool(teacher_confirmed)}


def correct_grade(grade_id: int, patch: Dict[str, Any]) -> Dict[str, Any]:
    """教师修正：直接改写批改记录并触发高优先级重算（教师权威覆盖 AI）。"""
    with _lock:
        conn = _conn()
        row = conn.execute("SELECT * FROM grade_records WHERE grade_id=?", (grade_id,)).fetchone()
        if not row:
            raise ValueError(f"批改记录不存在：{grade_id}")
        sets, args = [], []
        if patch.get("score") is not None:
            score = float(patch["score"])
            if score < 0 or score > float(row["full_score"]):
                raise ValueError("修正分数越界")
            sets.append("score=?"); args.append(score)
        if patch.get("errorType"):
            et = str(patch["errorType"]).strip()
            if et not in ERROR_TYPES:
                raise ValueError(f"errorType 非法：{et}")
            sets.append("error_type=?"); args.append(et)
        if patch.get("comment") is not None:
            sets.append("comment=?"); args.append(str(patch["comment"])[:300])
        if not sets:
            raise ValueError("无可修正字段")
        args.append(grade_id)
        conn.execute(f"UPDATE grade_records SET {', '.join(sets)} WHERE grade_id=?", args)
        _enqueue(conn, "profile_corrected", "grade_records", str(grade_id), priority=1,
                 detail=f"correct:{grade_id}")
        _audit(conn, "teacher", "correct_grade", f"grade:{grade_id}", json.dumps(patch, ensure_ascii=False))
        conn.commit()
    consume_events()
    return {"gradeId": grade_id, "corrected": list(patch.keys())}


def import_scores(class_id: str, subject: str, exam_name: str, exam_date: str,
                  items: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not class_id or not subject:
        raise ValueError("classId / subject 不能为空")
    if not items:
        raise ValueError("items 不能为空")
    n = 0
    with _lock:
        conn = _conn()
        try:
            for it in items:
                pid = str(it.get("pseudoId") or "").strip()
                if not _valid_pid(pid):
                    raise ValueError(f"pseudoId 非法：{pid}")
                # 自动登记学生（幂等），成绩导入无需先单独报名册
                conn.execute(
                    "INSERT OR IGNORE INTO students(pseudo_id, class_id, created_at) VALUES(?,?,?)",
                    (pid, class_id, _now()),
                )
                total = float(it.get("total") or 0)
                full = float(it.get("fullScore") or 100)
                if total < 0 or total > full:
                    raise ValueError(f"成绩越界：{pid} {total}/{full}")
                conn.execute(
                    "INSERT INTO exam_scores(pseudo_id, class_id, subject, exam_name, exam_date, total, full_score, rank, scores, created_at)"
                    " VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (pid, class_id, subject, str(exam_name or ""), str(exam_date or ""),
                     total, full, it.get("rank"), json.dumps(it.get("scores") or {}, ensure_ascii=False), _now()),
                )
                n += 1
            _enqueue(conn, "score_imported", "exam_scores", f"{class_id}:{subject}:{exam_name}",
                     priority=5, detail=f"{class_id}:{subject}:{n}")
            _audit(conn, "section:analytics", "import_scores", f"{class_id}:{subject}:{exam_name}", f"count={n}")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    consume_events()
    return {"classId": class_id, "subject": subject, "exam": exam_name, "imported": n}


# ---------------------------------------------------------------------------
# 消费路径（T1：单写者，确定性重算）
# ---------------------------------------------------------------------------
def consume_events(limit: int = 200) -> Dict[str, int]:
    """串行消费待处理事件（priority 1 最先）。返回 {done, failed, dead}。"""
    done = failed = dead = 0
    for _round in range(3):  # 冲突重读重算最多 3 轮，确定性计算必收敛
        with _lock:
            conn = _conn()
            rows = conn.execute(
                "SELECT * FROM profile_events WHERE status='pending'"
                " ORDER BY priority ASC, created_at ASC LIMIT ?", (limit,)
            ).fetchall()
            if not rows:
                break
            for r in rows:
                try:
                    _apply_event(conn, dict(r))
                    conn.execute(
                        "UPDATE profile_events SET status='done', consumed_at=?, retry_count=retry_count+1"
                        " WHERE event_id=? AND status='pending'",
                        (_now(), r["event_id"]),
                    )
                    # 每事件一提交：画像更新与事件状态原子落库；
                    # 否则长挂事务会因进程退出/跨连接不可见而"丢失"更新（单写者+幂等，重放安全）
                    conn.commit()
                    done += 1
                except _Conflict:
                    # 乐观锁冲突：事件保持 pending，下一轮重读重算
                    conn.rollback()
                    continue
                except Exception as e:  # noqa: BLE001
                    conn.rollback()
                    retries = int(r["retry_count"]) + 1
                    status = "dead" if retries >= 3 else "pending"
                    conn.execute(
                        "UPDATE profile_events SET retry_count=?, status=?, error=? WHERE event_id=?",
                        (retries, status, str(e)[:200], r["event_id"]),
                    )
                    conn.commit()
                    if status == "dead":
                        dead += 1
                    else:
                        failed += 1
        # 无锁重算窗口结束，进入下一轮
    return {"done": done, "failed": failed, "dead": dead}


class _Conflict(Exception):
    """画像乐观锁冲突：需要重读后重算。"""


def _mastery_tier(m: float) -> str:
    if m >= 0.85: return "优秀"
    if m >= 0.70: return "良好"
    if m >= 0.60: return "一般"
    if m >= 0.40: return "薄弱"
    return "盲区"


def _recompute_profile(conn: sqlite3.Connection, pseudo_id: str, subject: str, kp_id: str) -> None:
    """按确定性口径重算单个画像格子，乐观锁写入（单写者）。"""
    row = conn.execute(
        "SELECT COALESCE(SUM(score),0) AS s, COALESCE(SUM(full_score),0) AS f,"
        " COUNT(*) AS n, COALESCE(SUM(CASE WHEN score/full_score<0.6 THEN 1 ELSE 0 END),0) AS w"
        " FROM grade_records WHERE pseudo_id=? AND subject=? AND kp_id=? AND teacher_confirmed=1",
        (pseudo_id, subject, kp_id),
    ).fetchone()
    total, full, n, wrong = float(row["s"]), float(row["f"]), int(row["n"]), int(row["w"])
    mastery = (total / full) if full > 0 else -1.0
    ev = conn.execute(
        "SELECT grade_id FROM grade_records WHERE pseudo_id=? AND subject=? AND kp_id=? AND teacher_confirmed=1"
        " ORDER BY grade_id DESC LIMIT 20",
        (pseudo_id, subject, kp_id),
    ).fetchall()
    evidence = json.dumps([r["grade_id"] for r in ev], ensure_ascii=False)
    cur = conn.execute(
        "UPDATE profiles SET mastery=?, attempts=?, wrong_count=?, evidence_ids=?, version=version+1, updated_at=?"
        " WHERE pseudo_id=? AND subject=? AND kp_id=? AND version=?",
        (mastery, n, wrong, evidence, _now(), pseudo_id, subject, kp_id,
         _current_version(conn, pseudo_id, subject, kp_id)),
    )
    if cur.rowcount == 0:
        # 行不存在则插入（新格子无并发写者，插入冲突即冲突）
        try:
            conn.execute(
                "INSERT INTO profiles(pseudo_id, subject, kp_id, mastery, attempts, wrong_count, evidence_ids, version, updated_at)"
                " VALUES(?,?,?,?,?,?,?,1,?)",
                (pseudo_id, subject, kp_id, mastery, n, wrong, evidence, _now()),
            )
        except sqlite3.IntegrityError:
            raise _Conflict()


def _current_version(conn: sqlite3.Connection, pseudo_id: str, subject: str, kp_id: str) -> int:
    row = conn.execute(
        "SELECT version FROM profiles WHERE pseudo_id=? AND subject=? AND kp_id=?",
        (pseudo_id, subject, kp_id),
    ).fetchone()
    return int(row["version"]) if row else 0


def _apply_event(conn: sqlite3.Connection, ev: Dict[str, Any]) -> None:
    et = ev["event_type"]
    ref_id = ev["ref_id"]
    if et == "grade_confirmed" or et == "profile_corrected":
        row = conn.execute("SELECT * FROM grade_records WHERE grade_id=?", (ref_id,)).fetchone()
        if not row:
            return  # 记录被清理：事件自然失效
        _recompute_profile(conn, row["pseudo_id"], row["subject"], row["kp_id"])
        _recompute_class(conn, _class_of(conn, row["pseudo_id"]), row["subject"], row["kp_id"])
    elif et == "qa_created":
        row = conn.execute("SELECT * FROM qa_records WHERE qa_id=?", (ref_id,)).fetchone()
        if not row:
            return
        kps = json.loads(row["kp_ids"] or "[]")
        if not kps:
            return  # 未标注知识点的提问只进证据链查询，不动画像格子
        for kp in kps:
            conn.execute(
                "INSERT INTO profiles(pseudo_id, subject, kp_id, ask_count, version, updated_at)"
                " VALUES(?,?,?,1,1,?)"
                " ON CONFLICT(pseudo_id, subject, kp_id) DO UPDATE SET ask_count=ask_count+1, version=version+1, updated_at=?",
                (row["pseudo_id"], row["subject"], kp, _now(), _now()),
            )
    elif et == "score_imported":
        class_id, subject = ref_id.split(":")[0], ref_id.split(":")[1]
        _recompute_class_tiers(conn, class_id, subject)
    else:
        raise ValueError(f"未知事件类型：{et}")


def _class_of(conn: sqlite3.Connection, pseudo_id: str) -> str:
    row = conn.execute("SELECT class_id FROM students WHERE pseudo_id=?", (pseudo_id,)).fetchone()
    return row["class_id"] if row else ""


def _recompute_class(conn: sqlite3.Connection, class_id: str, subject: str, kp_id: str) -> None:
    if not class_id:
        return
    row = conn.execute(
        "SELECT COALESCE(AVG(p.mastery),-1) AS avg_m,"
        " COALESCE(SUM(CASE WHEN p.mastery>=0 AND p.mastery<0.6 THEN 1 ELSE 0 END)*1.0"
        "  / NULLIF(SUM(CASE WHEN p.mastery>=0 THEN 1 ELSE 0 END),0),0) AS weak_r,"
        " COUNT(*) AS n"
        " FROM profiles p JOIN students s ON s.pseudo_id=p.pseudo_id"
        " WHERE s.class_id=? AND p.subject=? AND p.kp_id=? AND p.mastery>=0",
        (class_id, subject, kp_id),
    ).fetchone()
    if not row or int(row["n"]) == 0:
        return
    cur_ver = conn.execute(
        "SELECT version FROM class_profiles WHERE class_id=? AND subject=? AND kp_id=?",
        (class_id, subject, kp_id),
    ).fetchone()
    ver = int(cur_ver["version"]) if cur_ver else 0
    if cur_ver:
        conn.execute(
            "UPDATE class_profiles SET avg_mastery=?, weak_ratio=?, sample_count=?, version=version+1, updated_at=?"
            " WHERE class_id=? AND subject=? AND kp_id=? AND version=?",
            (float(row["avg_m"]), float(row["weak_r"]), int(row["n"]), _now(), class_id, subject, kp_id, ver),
        )
    else:
        conn.execute(
            "INSERT INTO class_profiles(class_id, subject, kp_id, avg_mastery, weak_ratio, sample_count, version, updated_at)"
            " VALUES(?,?,?,?,?,?,1,?)",
            (class_id, subject, kp_id, float(row["avg_m"]), float(row["weak_r"]), int(row["n"]), _now()),
        )


def _recompute_class_tiers(conn: sqlite3.Connection, class_id: str, subject: str) -> None:
    """考试分层（top/mid/base）刷新：只更新 tier_dist/tier_exam 字段。

    口径统一原则：班级 kp 均值/薄弱比 一律由 _recompute_class 基于学生个体
    掌握率（profiles 表）计算，本函数不得用记录级均值覆盖，避免双口径。
    """
    row = conn.execute(
        "SELECT exam_name FROM exam_scores WHERE class_id=? AND subject=?"
        " ORDER BY created_at DESC LIMIT 1", (class_id, subject),
    ).fetchone()
    exam_name = row["exam_name"] if row else ""
    st = conn.execute(
        "SELECT total, full_score FROM exam_scores WHERE class_id=? AND subject=? AND exam_name=?",
        (class_id, subject, exam_name),
    ).fetchall()
    dist = {"top": 0, "mid": 0, "base": 0}
    for r in st:
        rate = float(r["total"]) / float(r["full_score"]) if float(r["full_score"]) > 0 else 0
        if rate >= 0.85: dist["top"] += 1
        elif rate >= 0.60: dist["mid"] += 1
        else: dist["base"] += 1
    conn.execute(
        "UPDATE class_profiles SET tier_dist=?, tier_exam=?, version=version+1, updated_at=?"
        " WHERE class_id=? AND subject=? AND kp_id<>''",
        (json.dumps(dist, ensure_ascii=False), exam_name, _now(), class_id, subject),
    )


# ---------------------------------------------------------------------------
# 读取路径（T2：按需聚合）
# ---------------------------------------------------------------------------
def query_profile(pseudo_id: str, subject: str = "", kp_id: str = "") -> Dict[str, Any]:
    if not _valid_pid(pseudo_id):
        raise ValueError("pseudoId 非法")
    sql = "SELECT * FROM profiles WHERE pseudo_id=?"
    args: List[Any] = [pseudo_id]
    if subject:
        sql += " AND subject=?"; args.append(subject)
    if kp_id:
        sql += " AND kp_id=?"; args.append(kp_id)
    sql += " ORDER BY subject, kp_id"
    with _lock:
        rows = [dict(r) for r in _conn().execute(sql, args).fetchall()]
    for r in rows:
        r["kp_ids_json"] = r.pop("evidence_ids")
        r["mastery_pct"] = round(r["mastery"] * 100, 1) if r["mastery"] >= 0 else None
        r["tier"] = _mastery_tier(r["mastery"]) if r["mastery"] >= 0 else "无样本"
    return {"pseudoId": pseudo_id, "items": rows, "count": len(rows)}


def class_stats(class_id: str, subject: str) -> Dict[str, Any]:
    with _lock:
        conn = _conn()
        kps = [dict(r) for r in conn.execute(
            "SELECT * FROM class_profiles WHERE class_id=? AND subject=? ORDER BY avg_mastery ASC",
            (class_id, subject),
        ).fetchall()]
        weak, blind = [], []
        for r in kps:
            if r["avg_mastery"] < 0:
                continue
            pct = round(r["avg_mastery"] * 100, 1)
            label = {"kp": r["kp_id"], "mastery_pct": pct, "weak_ratio": round(r["weak_ratio"], 2),
                     "sample": r["sample_count"]}
            if r["avg_mastery"] < 0.40: blind.append(label)
            elif r["avg_mastery"] < 0.60: weak.append(label)
        tier = {}
        if kps and kps[0].get("tier_dist"):
            tier = json.loads(kps[0]["tier_dist"])
        # 提问薄弱证据：近 30 天提问频次 top 知识点
        ask_rows = [dict(r) for r in conn.execute(
            "SELECT kp_ids, COUNT(*) AS c FROM qa_records WHERE subject=? AND source='student-qa'"
            " AND created_at>=? GROUP BY kp_ids", (subject, _now() - 30 * 86400),
        ).fetchall()]
        ask_counter: Dict[str, int] = {}
        for r in ask_rows:
            for kp in json.loads(r["kp_ids"] or "[]"):
                ask_counter[kp] = ask_counter.get(kp, 0) + int(r["c"])
        top_ask = sorted(ask_counter.items(), key=lambda x: -x[1])[:5]
    return {
        "classId": class_id, "subject": subject,
        "kpCount": len(kps),
        "weakKps": weak, "blindKps": blind,
        "allKps": [{"kp": r["kp_id"], "masteryPct": round(r["avg_mastery"] * 100, 1) if r["avg_mastery"] >= 0 else None,
                    "weakRatio": round(r["weak_ratio"], 2), "sample": r["sample_count"]} for r in kps],
        "tierDist": tier,
        "topAskedKps": [{"kp": k, "count": c} for k, c in top_ask],
        "version": max([r["version"] for r in kps], default=0),
    }


def data_usage(class_id: str = "", subject: str = "") -> Dict[str, Any]:
    """各板块数据使用情况汇总（备课板块「数据使用说明」依据）。"""
    cond, args = "", []
    if class_id:
        cond += " AND s.class_id=?"; args.append(class_id)
    if subject:
        cond += " AND (g.subject=? OR g.subject IS NULL)"; args.append(subject)
    with _lock:
        conn = _conn()
        stu = conn.execute(
            "SELECT COUNT(*) AS n FROM students" + (" WHERE class_id=?" if class_id else ""),
            (args[0],) if class_id and not subject else ((args[0],) if class_id else ()),
        ).fetchone()
        qa = conn.execute(
            "SELECT COUNT(*) AS n, MAX(created_at) AS last_ts FROM qa_records"
            " WHERE (?='' OR subject=?)", (subject, subject),
        ).fetchone()
        gr = conn.execute(
            "SELECT COUNT(*) AS n, SUM(teacher_confirmed) AS confirmed, MAX(created_at) AS last_ts"
            " FROM grade_records WHERE (?='' OR subject=?)", (subject, subject),
        ).fetchone()
        ex = conn.execute(
            "SELECT COUNT(*) AS n, MAX(created_at) AS last_ts FROM exam_scores WHERE (?='' OR subject=?)",
            (subject, subject),
        ).fetchone()
        pf = conn.execute("SELECT COUNT(*) AS n FROM profiles WHERE (?='' OR subject=?)", (subject, subject)).fetchone()
        ev = conn.execute(
            "SELECT status, COUNT(*) AS n FROM profile_events GROUP BY status"
        ).fetchall()
    def _ts(v):
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(v)) if v else None
    return {
        "students": int(stu["n"]) if stu else 0,
        "qaRecords": {"count": int(qa["n"]), "lastAt": _ts(qa["last_ts"])},
        "gradeRecords": {"count": int(gr["n"]), "confirmed": int(gr["confirmed"] or 0), "lastAt": _ts(gr["last_ts"])},
        "examScores": {"count": int(ex["n"]), "lastAt": _ts(ex["last_ts"])},
        "profileCells": int(pf["n"]),
        "events": {r["status"]: int(r["n"]) for r in ev},
        "auditChain": audit_verify(),
    }


def reset_all() -> None:
    """清空总线（仅测试用）。"""
    with _lock:
        conn = _conn()
        conn.executescript(
            "DELETE FROM students; DELETE FROM qa_records; DELETE FROM grade_records;"
            " DELETE FROM exam_scores; DELETE FROM profile_events; DELETE FROM profiles;"
            " DELETE FROM class_profiles; DELETE FROM audit_log;"
        )
        conn.commit()
