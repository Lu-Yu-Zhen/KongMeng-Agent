/* ============================================================
   mock.js · 中心化 mock 数据（单一数据源）
   所有业务数据均带 classId + subject 维度，支撑班级/科目过滤。
   贴近真实系统：作业项字段 { id, subject, title, teacher, desc,
   dueDate, dueTime, status }，另加 classId/difficulty。
   ============================================================ */

const DB = {
  /* ---- 班级 ---- */
  classes: [
    { id: 'c1', name: '高一(1)班', grade: '高一', studentCount: 48 },
    { id: 'c2', name: '高二(2)班', grade: '高二', studentCount: 52 },
    { id: 'c3', name: '高三(3)班', grade: '高三', studentCount: 45 }
  ],

  /* ---- 科目 ---- */
  subjects: ['语文','数学','英语','物理','化学','生物','历史','政治','地理'],

  /* ---- 当前登录用户（通过 surface 区分） ---- */
  student: {
    id: 's01', name: '李明', role: '学生',
    classId: 'c1',
    subjects: ['数学','物理','化学']   // 选科组合
  },
  teacher: {
    id: 't01', name: '王老师', role: '教师',
    subjects: ['数学','物理'],        // 任教科目
    classIds: ['c1','c2']            // 任教班级
  },

  /* ---- 作业（教师下发 → 学生接收） ---- */
  homework: [
    { id: 'hw1', classId: 'c1', subject: '数学', title: '函数单调性专项练习', teacher: '王老师',
      desc: '完成课本第 3 章课后习题 1-12 题，重点练习函数单调性的判定与证明。', dueDate: '2026-08-15', dueTime: '20:00', status: 'assigned', difficulty: '中等' },
    { id: 'hw2', classId: 'c1', subject: '数学', title: '期末模拟卷一讲评订正', teacher: '王老师',
      desc: '针对期末模拟卷一，订正错题并总结错因，拍照上传。', dueDate: '2026-08-18', dueTime: '21:00', status: 'submitted', difficulty: '较难' },
    { id: 'hw3', classId: 'c2', subject: '数学', title: '数列求和的常见方法', teacher: '王老师',
      desc: '掌握等差、等比数列求和及裂项相消法，完成配套练习。', dueDate: '2026-08-16', dueTime: '20:30', status: 'assigned', difficulty: '中等' },
    { id: 'hw4', classId: 'c2', subject: '物理', title: '牛顿运动定律综合训练', teacher: '王老师',
      desc: '受力分析专题，完成训练卷 A 卷。', dueDate: '2026-08-17', dueTime: '19:00', status: 'assigned', difficulty: '较难' },
    { id: 'hw5', classId: 'c1', subject: '语文', title: '《劝学》文言文背诵默写', teacher: '陈老师',
      desc: '熟背全文并默写，注意重点字词。', dueDate: '2026-08-14', dueTime: '22:00', status: 'assigned', difficulty: '简单' },
    { id: 'hw6', classId: 'c3', subject: '物理', title: '电磁感应综合复习', teacher: '刘老师',
      desc: '高考真题精选，直击高频考点。', dueDate: '2026-08-19', dueTime: '18:00', status: 'assigned', difficulty: '较难' }
  ],

  /* ---- 作业提交（学生 → 教师） ---- */
  homeworkSubmissions: [
    { id: 'sub1', homeworkId: 'hw1', classId: 'c1', studentId: 's01', studentName: '李明',
      content: '已完成全部习题，详见上传图片。', attachments: ['hw1_李img1.png'], submittedAt: '2026-08-13', status: 'submitted' },
    { id: 'sub2', homeworkId: 'hw2', classId: 'c1', studentId: 's01', studentName: '李明',
      content: '已订正第 3、7、12 题，错因已总结。', attachments: ['hw2_订正.jpg'], submittedAt: '2026-08-12', status: 'graded' },
    { id: 'sub3', homeworkId: 'hw1', classId: 'c1', studentId: 's02', studentName: '张伟',
      content: '完成 1-10 题，11、12 题有待进一步思考。', attachments: [], submittedAt: '2026-08-13', status: 'submitted' }
  ],

  /* ---- 成绩公布（教师 → 学生） ---- */
  grades: [
    { id: 'g1', classId: 'c1', subject: '数学', examName: '期末模拟考一', publishDate: '2026-08-10',
      studentId: 's01', studentName: '李明', score: 132, total: 150, classAvg: 118.5, rank: 8, trend: [118, 125, 128, 132] },
    { id: 'g2', classId: 'c1', subject: '数学', examName: '周测三', publishDate: '2026-08-05',
      studentId: 's01', studentName: '李明', score: 128, total: 150, classAvg: 116, rank: 12, trend: [118, 125, 128] },
    { id: 'g3', classId: 'c2', subject: '数学', examName: '阶段测验', publishDate: '2026-08-08',
      studentId: 's03', studentName: '赵敏', score: 141, total: 150, classAvg: 121, rank: 2, trend: [130, 136, 141] },
    { id: 'g4', classId: 'c1', subject: '物理', examName: '期末模拟考一', publishDate: '2026-08-10',
      studentId: 's01', studentName: '李明', score: 88, total: 100, classAvg: 79, rank: 6, trend: [76, 82, 88] }
  ],

  /* ---- 学情反馈（教师生成 → 学生查看） ---- */
  learningReports: [
    { id: 'r1', studentId: 's01', classId: 'c1', subject: '数学', reportAt: '2026-08-10',
      weakPoints: ['函数与导数综合应用', '数列求和的灵活运用'],
      suggestion: '建议加强函数压轴题的限时训练，建立错题本并定期回顾；数列部分每周完成 2 组综合题。' },
    { id: 'r2', studentId: 's01', classId: 'c1', subject: '物理', reportAt: '2026-08-10',
      weakPoints: ['受力分析的临界问题'],
      suggestion: '多画受力分析图，规范解题步骤，注意整体法与隔离法的灵活切换。' }
  ],

  /* ---- 学生提问/反馈（学生 → 教师 → 学生） ---- */
  questions: [
    { id: 'q1', studentId: 's01', studentName: '李明', classId: 'c1', subject: '数学', content: '老师，函数单调性证明里，遇到含参函数分类讨论的标准是什么？',
      askedAt: '2026-08-10 14:20', reply: '一般先看定义域，再对导数符号不易判定的部分，依据参数是否影响判别式符号进行分段。常态是：参数二次项系数→判别式→根的位置，逐层分类。',
      replyAt: '2026-08-10 15:02', status: 'replied' },
    { id: 'q2', studentId: 's01', studentName: '李明', classId: 'c1', subject: '物理', content: '传送带模型的摩擦力方向如何判断？',
      askedAt: '2026-08-11 09:12', reply: '先看相对运动趋势：物体相对传送带向后滑则摩擦力向前，反之向后。关键是找相对运动方向，而非运动方向。',
      replyAt: '2026-08-11 09:40', status: 'replied' },
    { id: 'q3', studentId: 's02', studentName: '张伟', classId: 'c1', subject: '数学', content: '裂项相消的求和式，如何快速识别可以裂项的式子？',
      askedAt: '2026-08-12 16:00', reply: '', replyAt: '', status: 'pending' }
  ],

  /* ---- 批改/讲解（教师 → 学生） ---- */
  comments: [
    { id: 'cm1', homeworkId: 'hw2', classId: 'c1', studentId: 's01', studentName: '李明', subject: '数学',
      grade: 'A', comment: '订正认真，第 7 题过程完整，第 12 题注意分类讨论的完整性。', explanation: '第 12 题：当参数 a 使二次项系数为 0 时需单独讨论，这是本题易漏点。',
      gradedAt: '2026-08-13', readByStudent: false },
    { id: 'cm2', homeworkId: 'hw1', classId: 'c1', studentId: 's02', studentName: '张伟', subject: '数学',
      grade: 'B+', comment: '基础题完成较好，压轴题需加强。', explanation: '第 11 题用数形结合会更简洁。',
      gradedAt: '2026-08-13', readByStudent: true }
  ],

  /* ---- 同步事件（云端时间线，跨端流转记录） ---- */
  syncEvents: [
    { id: 'e1', chain: '成绩公布', direction: 'teacher→cloud→student', from: '教师端', to: '学生端', file: 'grades.json', classId: 'c1', subject: '数学', action: '发布成绩', delta: 1, ts: '2026-08-10 15:05' },
    { id: 'e2', chain: '提问', direction: 'student→cloud→teacher', from: '学生端', to: '教师端', file: 'questions.json', classId: 'c1', subject: '数学', action: '发起提问', delta: 1, ts: '2026-08-10 14:20' },
    { id: 'e3', chain: '回复', direction: 'teacher→cloud→student', from: '教师端', to: '学生端', file: 'questions.json', classId: 'c1', subject: '数学', action: '回复提问', delta: 1, ts: '2026-08-10 15:02' },
    { id: 'e4', chain: '作业下发', direction: 'teacher→cloud→student', from: '教师端', to: '学生端', file: 'homework.json', classId: 'c1', subject: '数学', action: '下发作业', delta: 1, ts: '2026-08-11 08:30' },
    { id: 'e5', chain: '作业提交', direction: 'student→cloud→teacher', from: '学生端', to: '教师端', file: 'homework.json', classId: 'c1', subject: '数学', action: '提交作业', delta: 1, ts: '2026-08-13 19:12' },
    { id: 'e6', chain: '批改发布', direction: 'teacher→cloud→student', from: '教师端', to: '学生端', file: 'comments.json', classId: 'c1', subject: '数学', action: '发布批改', delta: 1, ts: '2026-08-13 21:00' }
  ]
};

/* 便捷查询 */
const store = {
  getClass: (id) => DB.classes.find(c => c.id === id),
  getClassList: () => DB.classes,
  getSubjects: () => DB.subjects,
  getStudent: () => DB.student,
  getTeacher: () => DB.teacher,

  /* 教师端过滤：默认我的任教现状 = subjects ∩ classIds */
  teacherHomework: () => DB.homework.filter(h => DB.teacher.subjects.includes(h.subject) && DB.teacher.classIds.includes(h.classId)),
  teacherSubmissions: () => DB.homeworkSubmissions.filter(s => DB.teacher.subjects.includes(getSubjectByHw(s.homeworkId)) && DB.teacher.classIds.includes(s.classId)),
  teacherGrades: () => DB.grades.filter(g => DB.teacher.subjects.includes(g.subject) && DB.teacher.classIds.includes(g.classId)),
  teacherQuestions: () => DB.questions.filter(q => DB.teacher.subjects.includes(q.subject) && DB.teacher.classIds.includes(q.classId)),
  teacherComments: () => DB.comments.filter(c => DB.teacher.subjects.includes(c.subject) && DB.teacher.classIds.includes(c.classId)),

  /* 学生端过滤：本班 + 选科 */
  studentHomework: () => DB.homework.filter(h => h.classId === DB.student.classId && DB.student.subjects.includes(h.subject)),
  studentGrades: () => DB.grades.filter(g => g.studentId === DB.student.id),
  studentQuestions: () => DB.questions.filter(q => q.studentId === DB.student.id),
  studentComments: () => DB.comments.filter(c => c.studentId === DB.student.id)
};

function getSubjectByHw(hwId) {
  const h = DB.homework.find(x => x.id === hwId);
  return h ? h.subject : '';
}

/* 教师端【对应单科情况】全校该科目跨所有班级 */
store.subjectOverview = (subject) => ({
  homework: DB.homework.filter(h => h.subject === subject),
  submissions: DB.homeworkSubmissions.filter(s => getSubjectByHw(s.homeworkId) === subject),
  grades: DB.grades.filter(g => g.subject === subject),
  questions: DB.questions.filter(q => q.subject === subject),
  comments: DB.comments.filter(c => c.subject === subject)
});

/* 教师端【全年段全科情况】全校概览（只读聚合） */
store.schoolOverview = () => {
  const bySubject = {};
  DB.subjects.forEach(sub => {
    const hw = DB.homework.filter(h => h.subject === sub);
    const subs = DB.homeworkSubmissions.filter(s => getSubjectByHw(s.homeworkId) === sub);
    const gr = DB.grades.filter(g => g.subject === sub);
    const qs = DB.questions.filter(q => q.subject === sub);
    bySubject[sub] = { homework: hw.length, submissions: subs.length, grading: gr.length, questions: qs.length };
  });
  return { bySubject, totalHomework: DB.homework.length, totalGrades: DB.grades.length, totalQuestions: DB.questions.length };
};

/* 云端分桶：按 班级×科目 统计各文件记录数 */
store.syncBuckets = () => {
  const buckets = [];
  DB.classes.forEach(c => {
    DB.subjects.forEach(sub => {
      const hw = DB.homework.filter(x => x.classId === c.id && x.subject === sub);
      const gr = DB.grades.filter(x => x.classId === c.id && x.subject === sub);
      const qs = DB.questions.filter(x => x.classId === c.id && x.subject === sub);
      const cm = DB.comments.filter(x => x.classId === c.id && x.subject === sub);
      if (hw.length || gr.length || qs.length || cm.length) {
        buckets.push({
          classId: c.id, className: c.name, subject: sub,
          homework: hw.length, grades: gr.length, questions: qs.length, comments: cm.length
        });
      }
    });
  });
  return buckets;
};

/* 模拟 cloud 载荷文件（供 api.js 读写，表达"数据经 cloud 流转"） */
store.cloudFiles = {
  'homework.json': { lastWriter: '教师端', updatedAt: '2026-08-13 19:12', count: DB.homework.length },
  'grades.json': { lastWriter: '教师端', updatedAt: '2026-08-10 15:05', count: DB.grades.length },
  'questions.json': { lastWriter: '学生端', updatedAt: '2026-08-12 16:00', count: DB.questions.length },
  'comments.json': { lastWriter: '教师端', updatedAt: '2026-08-13 21:00', count: DB.comments.length }
};

/* 若希望后续接真实文件系统：把 cloud 目录下的 json 加载进内存在此处 */
if (typeof window !== 'undefined') {
  window.DB = DB;
  window.store = store;
}