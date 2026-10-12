/* ============================================================
   api.js · API stub 服务层（stub-only，无真实后端）
   ------------------------------------------------------------
   // TODO: 接入真实系统后替换以下所有 stub。
   // 学生端真实后端：无（Electron 直读本地 JSON）；
   // 教师端真实后端：FastAPI  http://127.0.0.1:8767
   //   作业下发 → POST   /api/artifacts 或语法化产物导出
   //   提问/回复 → POST  /api/memories
   //   同步载荷 → 经 cloud 目录读写
   // 每个同步函数模拟"经 cloud 目录流转"，并写入一条 sync-center 事件。
   ============================================================ */

const API = {};

/* 模拟网络延迟，让加载态可见 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* 写一条同步事件（模拟数据经 cloud 流转） */
function pushSyncEvent(chain, direction, from, to, file, classId, subject, action, delta) {
  DB.syncEvents.unshift({
    id: 'e' + Date.now(),
    chain, direction, from, to, file, classId, subject, action, delta,
    ts: new Date().toLocaleString('zh-CN', { hour12: false })
  });
  /* // TODO: 接真实系统后此处改为向 cloud 目录写入/追加载荷文件 */
}

/* 同步状态回调：页面用它驱动右上角同步条 */
let syncStatusCb = null;
API.onSyncStatus = (cb) => { syncStatusCb = cb; };
function setSync(status) {
  if (syncStatusCb) syncStatusCb(status);
}

/* ---------- 链路 A：作业下发与接收 ---------- */
// 教师端下发 → POST /api/artifacts  (TODO) ；当前写 mock + 事件
API.publishHomework = async (item) => {
  setSync('syncing');
  await delay(500);
  DB.homework.unshift(item);
  pushSyncEvent('作业下发', 'teacher→cloud→student', '教师端', '学生端', 'homework.json', item.classId, item.subject, '下发作业', 1);
  setSync('synced');
  return { ok: true, item };
};

// 学生端接收（拉取云端新作业）→ GET cloud/homework.json (TODO)
API.syncHomework = async ({ classId, subject } = {}) => {
  setSync('syncing');
  await delay(500);
  const list = DB.homework.filter(h => (!classId || h.classId === classId) && (!subject || h.subject === subject));
  setSync('synced');
  return { ok: true, list };
};

// 学生端提交作业 → POST 经 cloud 写 submissions (TODO)
API.submitHomework = async ({ homeworkId, classId, content, attachments }) => {
  setSync('syncing');
  await delay(500);
  const hw = DB.homework.find(x => x.id === homeworkId);
  if (hw) hw.status = 'submitted';
  DB.homeworkSubmissions.unshift({
    id: 'sub' + Date.now(), homeworkId, classId, studentId: DB.student.id,
    studentName: DB.student.name, content, attachments: attachments || [],
    submittedAt: new Date().toLocaleDateString('zh-CN'), status: 'submitted'
  });
  pushSyncEvent('作业提交', 'student→cloud→teacher', '学生端', '教师端', 'homework.json', classId, hw ? hw.subject : '', '提交作业', 1);
  setSync('synced');
  return { ok: true };
};

/* ---------- 链路 B：成绩公布与学情 ---------- */
// 教师端发布成绩 → POST 经 cloud 写 grades.json (TODO)
API.publishGrade = async ({ classId, subject, examName, score, total, classAvg, rank }) => {
  setSync('syncing');
  await delay(600);
  DB.grades.unshift({
    id: 'g' + Date.now(), classId, subject, examName, publishDate: new Date().toLocaleDateString('zh-CN'),
    studentId: DB.student.id, studentName: DB.student.name, score, total, classAvg, rank,
    trend: [score - 10, score - 5, score]
  });
  pushSyncEvent('成绩公布', 'teacher→cloud→student', '教师端', '学生端', 'grades.json', classId, subject, '发布成绩', 1);
  setSync('synced');
  return { ok: true };
};

// 学生端接收成绩 → GET cloud/grades.json (TODO)
API.syncGrades = async () => {
  setSync('syncing');
  await delay(500);
  const list = DB.grades.filter(g => g.studentId === DB.student.id);
  setSync('synced');
  return { ok: true, list };
};

/* ---------- 链路 C：学生提问/反馈 ---------- */
// 学生端发起提问 → POST 经 cloud 写 questions.json (TODO)
API.askQuestion = async ({ classId, subject, content }) => {
  setSync('syncing');
  await delay(500);
  DB.questions.unshift({
    id: 'q' + Date.now(), studentId: DB.student.id, studentName: DB.student.name,
    classId, subject, content,
    askedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    reply: '', replyAt: '', status: 'pending'
  });
  pushSyncEvent('提问', 'student→cloud→teacher', '学生端', '教师端', 'questions.json', classId, subject, '发起提问', 1);
  setSync('synced');
  return { ok: true };
};

// 教师端接收提问队列 → GET cloud/questions.json (TODO)
API.syncQuestions = async ({ classId, subject } = {}) => {
  setSync('syncing');
  await delay(500);
  const list = DB.questions.filter(q => (!classId || q.classId === classId) && (!subject || q.subject === subject));
  setSync('synced');
  return { ok: true, list };
};

// 教师端回复 → POST 经 cloud (TODO)
API.replyQuestion = async ({ id, reply }) => {
  setSync('syncing');
  await delay(500);
  const q = DB.questions.find(x => x.id === id);
  if (q) {
    q.reply = reply;
    q.replyAt = new Date().toLocaleString('zh-CN', { hour12: false });
    q.status = 'replied';
    pushSyncEvent('回复', 'teacher→cloud→student', '教师端', '学生端', 'questions.json', q.classId, q.subject, '回复提问', 1);
  }
  setSync('synced');
  return { ok: true };
};

/* 学生端查看回复（拉取）→ GET cloud/questions.json (TODO) */
API.syncReplies = async () => {
  setSync('syncing');
  await delay(500);
  const list = DB.questions.filter(q => q.studentId === DB.student.id);
  setSync('synced');
  return { ok: true, list };
};

/* ---------- 链路 D：批改/讲解同步 ---------- */
// 教师端发布批改 → POST 经 cloud 写 comments.json (TODO)
API.publishComment = async ({ homeworkId, classId, studentId, studentName, subject, grade, comment, explanation }) => {
  setSync('syncing');
  await delay(600);
  DB.comments.unshift({
    id: 'cm' + Date.now(), homeworkId, classId, studentId, studentName, subject,
    grade, comment, explanation, gradedAt: new Date().toLocaleDateString('zh-CN'), readByStudent: false
  });
  const sub = DB.homeworkSubmissions.find(s => s.homeworkId === homeworkId && s.studentId === studentId);
  if (sub) sub.status = 'graded';
  pushSyncEvent('批改发布', 'teacher→cloud→student', '教师端', '学生端', 'comments.json', classId, subject, '发布批改', 1);
  setSync('synced');
  return { ok: true };
};

// 学生端接收批改 → GET cloud/comments.json (TODO)
API.syncComments = async () => {
  setSync('syncing');
  await delay(500);
  const list = DB.comments.filter(c => c.studentId === DB.student.id);
  setSync('synced');
  return { ok: true, list };
};

// 学生端标记已读 → POST (TODO)
API.markRead = async ({ id }) => {
  setSync('syncing');
  await delay(300);
  const c = DB.comments.find(x => x.id === id);
  if (c) c.readByStudent = true;
  setSync('synced');
  return { ok: true };
};

/* ---------- 云端同步中心 ---------- */
API.getSyncEvents = async ({ classId, subject } = {}) => {
  await delay(400);
  let list = DB.syncEvents;
  if (classId) list = list.filter(e => e.classId === classId);
  if (subject) list = list.filter(e => e.subject === subject);
  return { ok: true, list };
};

API.getSyncBuckets = async () => {
  await delay(400);
  return { ok: true, buckets: store.syncBuckets() };
};

if (typeof window !== 'undefined') {
  window.API = API;
}