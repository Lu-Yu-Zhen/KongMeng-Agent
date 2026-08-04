/*!
 * teacher-agent-sandbox · 记忆系统 (memory-system.js)
 * ------------------------------------------------------------------
 * 三层记忆：
 *   1) 工作记忆 WorkingMemory —— 当前任务上下文（内存，任务结束归档）
 *   2) 情景记忆 EpisodicMemory —— 历次备课任务记录（localStorage 持久）
 *   3) 语义记忆 SemanticMemory —— 教师画像/学情/偏好（localStorage 持久）
 * 存储：localStorage（key: teacher_agent_memory），结构遵循 memory-schema.json
 * 检索：基于关键词命中 + 时间衰减的简易相关性评分
 */
(function (global) {
  'use strict';

  const STORE_KEY = 'teacher_agent_memory';
  const EPISODIC_MAX = 200;
  const WORKING_TTL = 30 * 60 * 1000; // 30 分钟
  const INSIGHT_BUDGET = 600000; // 学生洞察记忆总预算：600K 字符，超出保留时间最近的部分

  // ---------- 内嵌 schema（离线兜底，与 memory-schema.json 一致） ----------
  const SCHEMA = {
    types: {
      WorkingMemory: ['taskId', 'subject', 'topic', 'grade', 'userIntent', 'plan', 'scratchpad', 'activeSkill', 'artifacts', 'toolCallCount', 'createdAt', 'ttlMs'],
      EpisodicMemory: ['id', 'timestamp', 'subject', 'topic', 'summary', 'outcome', 'skillUsed', 'artifacts', 'teacherFeedback', 'tags'],
      SemanticMemory: ['teacherId', 'subjects', 'preferredStyle', 'classProfiles', 'frequentTopics', 'lessonPrefs', 'feedbackHistory', 'updatedAt'],
      InsightMemory: ['id', 'timestamp', 'type', 'cls', 'subject', 'student', 'summary', 'detail'],
    },
  };

  // ---------- 存储读写 ----------
  function _load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* 损坏则重置 */ }
    return { version: '1.0.0', createdAt: Date.now(), semantic: _defaultSemantic(), episodic: [], insights: [], working: null };
  }
  function _save(data) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) { /* 配额满则截断情景记忆 */ }
  }
  function _defaultSemantic() {
    return {
      teacherId: 'default',
      subjects: [],
      preferredStyle: '素养导向 · 情境教学',
      classProfiles: [],
      frequentTopics: [],
      lessonPrefs: { modules: ['教学目标', '重难点', '教学过程', '板书设计', '分层作业', '教学反思'], detailLevel: '详细', defaultLayers: 3, useLaTeX: true },
      feedbackHistory: [],
      updatedAt: Date.now(),
    };
  }

  let _cache = _load();

  // ---------- 工具函数 ----------
  function _now() { return Date.now(); }
  function _id(prefix) { return (prefix || 'mem') + '_' + _now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function _tokenize(s) {
    return String(s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/gi, ' ').split(/\s+/).filter(Boolean);
  }
  // 相关性评分：关键词命中数 × 时间衰减
  function _relevance(item, queryTokens) {
    const blob = [item.subject, item.topic, item.summary, (item.tags || []).join(' ')].join(' ').toLowerCase();
    let hits = 0;
    queryTokens.forEach((tk) => { if (blob.indexOf(tk) >= 0) hits++; });
    const ageDays = Math.max(0, (_now() - (item.timestamp || 0)) / 86400000);
    const decay = 1 / (1 + ageDays * 0.1); // 时间衰减
    return hits * decay;
  }

  const MemorySystem = {
    SCHEMA,

    /* ============ 工作记忆 ============ */
    /** 开启一个任务的工作记忆 */
    startTask(task) {
      _cache.working = Object.assign({
        taskId: _id('task'),
        subject: '', topic: '', grade: '',
        userIntent: '',
        plan: [],
        scratchpad: '',
        activeSkill: '',
        artifacts: [],
        toolCallCount: 0,
        createdAt: _now(),
        ttlMs: WORKING_TTL,
      }, task || {});
      _save(_cache);
      return _cache.working;
    },
    working() { return _cache.working; },
    /** 更新工作记忆字段 */
    updateWorking(patch) {
      if (!_cache.working) return null;
      Object.assign(_cache.working, patch);
      _save(_cache);
      return _cache.working;
    },
    /** 追加到草稿区 */
    appendScratch(text) {
      if (!_cache.working) return;
      _cache.working.scratchpad = (_cache.working.scratchpad || '') + '\n' + text;
      _save(_cache);
    },
    /** 增加产物 */
    addArtifact(path) {
      if (!_cache.working) return;
      if (_cache.working.artifacts.indexOf(path) < 0) _cache.working.artifacts.push(path);
      _save(_cache);
    },
    incToolCall() {
      if (!_cache.working) return 0;
      _cache.working.toolCallCount = (_cache.working.toolCallCount || 0) + 1;
      return _cache.working.toolCallCount;
    },
    /** 结束任务：归档为情景记忆，清空工作记忆 */
    endTask(outcome, summary, feedback) {
      if (!_cache.working) return null;
      const w = _cache.working;
      const ep = {
        id: _id('ep'),
        timestamp: _now(),
        subject: w.subject,
        topic: w.topic,
        summary: summary || w.userIntent || '',
        outcome: outcome || 'success',
        skillUsed: w.activeSkill || '',
        artifacts: w.artifacts || [],
        teacherFeedback: feedback || '',
        tags: [w.subject, w.topic].filter(Boolean),
      };
      _cache.episodic.unshift(ep);
      if (_cache.episodic.length > EPISODIC_MAX) _cache.episodic.length = EPISODIC_MAX;
      // 更新语义记忆：常备课题
      if (w.topic) {
        const ft = _cache.semantic.frequentTopics;
        if (ft.indexOf(w.topic) < 0) { ft.push(w.topic); if (ft.length > 50) ft.shift(); }
      }
      _cache.working = null;
      _save(_cache);
      return ep;
    },

    /* ============ 情景记忆 ============ */
    episodic() { return _cache.episodic || []; },
    /** 按相关性检索 topK 条情景记忆 */
    recall(query, topK) {
      topK = topK || 5;
      const qt = _tokenize(query);
      if (!qt.length) return _cache.episodic.slice(0, topK);
      return _cache.episodic
        .map((it) => ({ it, score: _relevance(it, qt) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map((x) => x.it);
    },

    /* ============ 学生洞察记忆（提问/批改/学情同步） ============ */
    /**
     * 写入一条学生洞察（学生提问、教师回复、批改结果、考试学情）。
     * entry: {type:'question'|'reply'|'grading'|'exam', cls, subject, student, summary, detail}
     * 自动压缩：summary 截断 300 字、detail 截断 800 字；总量超 600K 时丢弃最旧条目。
     */
    addInsight(entry) {
      if (!entry || !entry.type) return null;
      if (!_cache.insights) _cache.insights = [];
      const it = {
        id: _id('ins'),
        timestamp: _now(),
        type: entry.type,
        cls: entry.cls || '',
        subject: entry.subject || '',
        student: entry.student || '',
        summary: String(entry.summary || '').slice(0, 300),
        detail: String(entry.detail || '').slice(0, 800),
      };
      _cache.insights.push(it);
      this._enforceInsightBudget();
      _save(_cache);
      return it;
    },
    /** 强制执行 600K 预算：超出时从时间最旧的条目开始删除，保留最近的部分 */
    _enforceInsightBudget() {
      let list = _cache.insights || [];
      let total = JSON.stringify(list).length;
      while (total > INSIGHT_BUDGET && list.length > 1) {
        list.shift(); // 删除最旧
        total = JSON.stringify(list).length;
      }
      _cache.insights = list;
    },
    /** 最近 n 条学生洞察（时间升序返回） */
    recentInsights(n) {
      n = n || 8;
      return (_cache.insights || []).slice(-n);
    },
    /** 学生洞察总字符数（调试/状态展示用） */
    insightSize() { return JSON.stringify(_cache.insights || []).length; },
    /** 构造学生洞察上下文（注入 Agent/Chat 系统提示，辅助教师预知学生情况） */
    insightsContext() {
      const lines = [];
      // 班级学情画像（来自考试/学情分析数据）
      const profiles = (_cache.semantic && _cache.semantic.classProfiles) || [];
      profiles.slice(-3).forEach((c) => {
        let l = '- 【班级学情】' + (c.classId || '未知班级');
        if (c.examName) l += '（' + c.examName + '）';
        if (c.avgScore != null) l += '：均分 ' + c.avgScore;
        if (c.passRate != null) l += '，及格率 ' + c.passRate + '%';
        if (c.excellentCount != null) l += '，优秀 ' + c.excellentCount + ' 人';
        if (c.total != null) l += '（共 ' + c.total + ' 人）';
        if (c.weakPoints && c.weakPoints.length) l += '；薄弱点：' + c.weakPoints.join('、');
        lines.push(l);
      });
      // 最近的学生提问/批改洞察
      const typeLabel = { question: '学生提问', reply: '教师回复', grading: '批改反馈', exam: '考试学情' };
      this.recentInsights(8).forEach((it) => {
        let l = '- 【' + (typeLabel[it.type] || it.type) + '】';
        if (it.cls) l += it.cls + ' ';
        if (it.student) l += it.student + ' ';
        if (it.subject) l += '(' + it.subject + ') ';
        l += it.summary;
        lines.push(l);
      });
      if (!lines.length) return '';
      return '## 学生情况预知（来自学生提问/批改/学情分析的最近记录）\n' + lines.join('\n')
        + '\n（请结合以上学生困惑与薄弱点因材施教，备课时针对性设计例题与练习）';
    },

    /* ============ 语义记忆 ============ */
    semantic() { return _cache.semantic; },
    /** 更新教师画像（合并） */
    updateSemantic(patch) {
      Object.assign(_cache.semantic, patch, { updatedAt: _now() });
      _save(_cache);
      return _cache.semantic;
    },
    /** 记录教师反馈 */
    recordFeedback(topic, rating, comment) {
      _cache.semantic.feedbackHistory.push({ timestamp: _now(), topic, rating, comment });
      if (_cache.semantic.feedbackHistory.length > 100) _cache.semantic.feedbackHistory.shift();
      _save(_cache);
    },
    /** 读取班级学情 */
    classProfile(classId) {
      const list = _cache.semantic.classProfiles || [];
      return classId ? list.find((c) => c.classId === classId) : list;
    },
    /** 写入/更新班级学情（去标识化） */
    upsertClassProfile(profile) {
      const list = _cache.semantic.classProfiles || [];
      const i = list.findIndex((c) => c.classId === profile.classId);
      if (i >= 0) list[i] = Object.assign(list[i], profile, { lastUpdated: _now() });
      else list.push(Object.assign({ lastUpdated: _now() }, profile));
      _cache.semantic.classProfiles = list;
      _save(_cache);
    },

    /* ============ 综合 ============ */
    /** 为智能体构造上下文摘要（注入系统提示） */
    contextForAgent(query) {
      const recent = this.recall(query, 3);
      const sem = this.semantic();
      const lines = [];
      if (sem.subjects && sem.subjects.length) lines.push('任教学科：' + sem.subjects.join('、'));
      if (sem.preferredStyle) lines.push('偏好风格：' + sem.preferredStyle);
      if (sem.lessonPrefs) lines.push('教案偏好：' + JSON.stringify(sem.lessonPrefs));
      if (sem.classProfiles && sem.classProfiles.length) {
        const c = sem.classProfiles[0];
        lines.push('班级学情：均分' + (c.avgScore || '未知') + '，薄弱点' + (c.weakPoints || []).join('、'));
      }
      if (recent.length) {
        lines.push('近期备课：' + recent.map((r) => r.subject + '·' + r.topic + '(' + r.outcome + ')').join('；'));
      }
      let out = lines.length ? '## 记忆上下文\n' + lines.join('\n') : '';
      // 学生洞察（提问/批改/学情）同步注入
      const ins = this.insightsContext();
      if (ins) out += (out ? '\n\n' : '') + ins;
      return out;
    },

    /** 导出全部记忆（备份/调试） */
    exportAll() { return JSON.parse(JSON.stringify(_cache)); },
    /** 导入记忆（覆盖） */
    importAll(data) { _cache = data; _save(_cache); },
    /** 清空情景记忆 */
    clearEpisodic() { _cache.episodic = []; _save(_cache); },
  };

  global.AgentMemory = MemorySystem;
})(window);
