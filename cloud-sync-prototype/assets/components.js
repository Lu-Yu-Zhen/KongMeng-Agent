/* ============================================================
   components.js · 共享组件
   renderShell(surface, activePage)  → 冻结 App Shell + canonical Nav
   icon(name)                       → 内联 SVG（Lucide 风格，零外部依赖）
   openModal / closeModal / toast / syncStatus 工具
   ============================================================ */

/* ---------- 内联 SVG 图标（Lucide 风格，stroke 1.5~2，currentColor） ---------- */
const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  message: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  arrowRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
  time: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  arrowLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>'
};

function icon(name) {
  return ICONS[name] || ICONS.file;
}

/* ---------- surface 配置：主题 + 导航 ---------- */
const SURFACES = {
  student: {
    label: '学生端', tag: '孔孟·学生端',
    userKey: 'student',
    nav: [
      { key: 'homework', label: '作业中心', icon: 'book', href: '../student/homework.html' },
      { key: 'grades', label: '成绩学情', icon: 'chart', href: '../student/grades.html' },
      { key: 'ask', label: '提问反馈', icon: 'message', href: '../student/ask.html' },
      { key: 'grading', label: '批改讲解', icon: 'check', href: '../student/grading.html' }
    ]
  },
  teacher: {
    label: '教师端', tag: '教育智能体·教师端',
    userKey: 'teacher',
    nav: [
      { key: 'homework', label: '作业下发', icon: 'upload', href: '../teacher/homework.html' },
      { key: 'grades', label: '成绩学情', icon: 'chart', href: '../teacher/grades.html' },
      { key: 'ask', label: '提问处理', icon: 'message', href: '../teacher/ask.html' },
      { key: 'grading', label: '题目批改', icon: 'check', href: '../teacher/grading.html' }
    ]
  },
  cloud: {
    label: '云端同步中心', tag: '云端同步中心',
    userKey: null,
    nav: [
      { key: 'sync', label: '同步中心', icon: 'cloud', href: '../cloud/sync-center.html' },
      { key: 'student', label: '学生端', icon: 'user', href: '../student/homework.html' },
      { key: 'teacher', label: '教师端', icon: 'user', href: '../teacher/homework.html' }
    ]
  }
};

/* ---------- 渲染 App Shell + Nav（冻结，逐页调用） ---------- */
function renderShell(surfaceKey, activeKey) {
  const cfg = SURFACES[surfaceKey];
  if (!cfg) return '';
  const body = document.body;
  body.setAttribute('data-surface', surfaceKey);

  const user = cfg.userKey ? DB[cfg.userKey] : null;
  const userChip = user
    ? '<div class="user-chip"><div class="avatar">' + (user.name ? user.name.charAt(0) : '?') + '</div>' +
      '<div><div>' + escapeHtml(user.name) + '</div><div class="role">' + escapeHtml(user.role) + '</div></div></div>'
    : '';

  const navHtml = cfg.nav.map(n => {
    const active = n.key === activeKey;
    return '<button class="tab-btn' + (active ? ' active' : '') + '" data-nav="' + n.key + '" onclick="location.href=\'' + n.href + '\'">' +
      '<span class="nav-ic">' + icon(n.icon) + '</span>' + n.label + '</button>';
  }).join('');

  const shellHtml =
    '<div class="shell">' +
      '<header class="app-bar">' +
        '<div class="brand">' +
          '<span class="logo">' + icon('cloud') + '</span>' +
          '<span>孔孟·智学云</span>' +
          '<span class="surface-tag">' + cfg.tag + '</span>' +
        '</div>' +
        '<div class="app-bar-right">' +
          '<div class="sync-status" id="syncStatus"><span class="dot"></span><span id="syncStatusText">未同步</span></div>' +
          userChip +
        '</div>' +
      '</header>' +
      '<nav class="top-nav">' + navHtml + '</nav>' +
      '<main class="main-content"><div class="content-inner" id="pageRoot"></div></main>' +
    '</div>';

  body.insertAdjacentHTML('afterbegin', shellHtml);

  /* 同步状态导出给页面用 */
  API.onSyncStatus(function(status) {
    const el = document.getElementById('syncStatus');
    if (!el) return;
    const text = document.getElementById('syncStatusText');
    el.className = 'sync-status';
    if (status === 'syncing') { el.classList.add('syncing'); text.textContent = '同步中…'; }
    else if (status === 'synced') { el.classList.add('synced'); text.textContent = '已同步'; }
    else { text.textContent = '未同步'; }
  });
}

/* 页面主体挂载点 */
function pageRoot() {
  return document.getElementById('pageRoot');
}

/* ---------- Modal ---------- */
function openModal(html) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.id = 'modalMask';
  mask.innerHTML = '<div class="modal">' + html + '</div>';
  mask.addEventListener('click', function(e) {
    if (e.target === mask) closeModal();
  });
  document.body.appendChild(mask);
}
function closeModal() {
  const m = document.getElementById('modalMask');
  if (m) m.remove();
}
function modalHead(title) {
  return '<div class="modal-head"><h3>' + title + '</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>';
}

/* ---------- Toast ---------- */
function toast(msg, type) {
  let wrap = document.getElementById('toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.innerHTML = msg;
  wrap.appendChild(t);
  setTimeout(function() { t.remove(); }, 2600);
}

/* ---------- 工具 ---------- */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* 状态徽章 */
function statusBadge(status) {
  const map = {
    assigned: ['badge-pending', '待提交'],
    submitted: ['badge-submitted', '已提交'],
    graded: ['badge-graded', '已批改'],
    pending: ['badge-pending', '待处理'],
    replied: ['badge-replied', '已回复'],
    read: ['badge-read', '已读'],
    unread: ['badge-graded', '未读']
  };
  const m = map[status] || ['badge-default', status];
  return '<span class="badge ' + m[0] + '">' + m[1] + '</span>';
}

/* 空态 */
function emptyState(msg, iconName) {
  return '<div class="empty">' + icon(iconName || 'inbox') + '<p>' + escapeHtml(msg) + '</p></div>';
}

/* 科目徽章 */
function subjectBadge(subject) {
  return '<span class="badge badge-subject">' + escapeHtml(subject) + '</span>';
}
function classBadge(className) {
  return '<span class="badge badge-class">' + escapeHtml(className) + '</span>';
}

/* 暴露到全局 */
if (typeof window !== 'undefined') {
  window.renderShell = renderShell;
  window.pageRoot = pageRoot;
  window.openModal = openModal;
  window.closeModal = closeModal;
  window.modalHead = modalHead;
  window.toast = toast;
  window.icon = icon;
  window.escapeHtml = escapeHtml;
  window.statusBadge = statusBadge;
  window.emptyState = emptyState;
  window.subjectBadge = subjectBadge;
  window.classBadge = classBadge;
}