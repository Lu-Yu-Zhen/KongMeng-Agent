
/* ============================================================
 * 题目批改 / 智能组卷 历史记录（侧边横推，参照学生端实现）
 * 数据经 localStorage（Electron 下自动落盘到 data 对应模块）
 * ============================================================ */
var GRADING_HISTORY_KEY='ai_teacher_grading_history';
var PAPER_HISTORY_KEY='ai_teacher_paper_history';

function fmtHistoryTime(ts: number){
 try{ var d=new Date(ts); var p=function(n: number){return (n<10?'0':'')+n;}; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); }catch(e){ return ''; }
}
function stripMd(s: string){ return String(s||'').replace(/[#*`>|]/g,' ').replace(/\s+/g,' ').trim(); }

/* ---------------- 批改历史 ---------------- */
function getGradingHistory(){ try{ return JSON.parse(localStorage.getItem(GRADING_HISTORY_KEY))||[]; }catch(e){ return []; } }
function saveGradingHistory(list: HTMLElement){ try{ localStorage.setItem(GRADING_HISTORY_KEY, JSON.stringify(list)); }catch(e){} }
function addGradingHistory(rec: LegacyBoundary){ var list=getGradingHistory(); list.unshift(rec); if(list.length>50) list=list.slice(0,50); saveGradingHistory(list); renderGradingHistoryList(); }
function toggleGradingHistory(){
 var overlay=document.getElementById('gradingHistoryOverlay'), panel=document.getElementById('gradingHistoryPanel');
 if(!overlay||!panel) return;
 if(overlay.classList.contains('hidden')){
  overlay.classList.remove('hidden'); renderGradingHistoryList();
  void overlay.offsetHeight;
  setTimeout(function(){ panel.style.transform!!!!!='translateX(0)'; },20);
 } else { closeGradingHistory(); }
}
function closeGradingHistory(event: Event){
 if(event && event.target && (event.target as LegacyBoundary).id!=='gradingHistoryOverlay') return;
 var overlay=document.getElementById('gradingHistoryOverlay'), panel=document.getElementById('gradingHistoryPanel');
 if(!overlay||!panel) return;
 panel.style.transform='translateX(-100%)';
 setTimeout(function(){ overlay.classList.add('hidden')!!; },300);
}
function renderGradingHistoryList(){
 var list=document.getElementById('gradingHistoryList'); if(!list) return;
 var recs=getGradingHistory();
 var countEl=document.getElementById('gradingHistoryCount'); if(countEl) countEl.textContent=recs.length;
 if(!recs.length){ list.innerHTML='<div class="text-center py-8 text-ink-300"><i class="fa-solid fa-pen-to-square text-3xl mb-2 opacity-40"></i><p class="text-xs">暂无批改历史</p></div>'; return; }
 list.innerHTML=recs.map(function(r: LegacyBoundary){
  var title=(r.typeLabel||'批改')+' · '+(r.subject||'');
  var summary=stripMd(r.summary||r.result||'').slice(0,60);
  return '<div class="group bg-white border border-ink-100 rounded-xl p-3 hover:border-jade-300 hover:shadow-sm transition-all cursor-pointer" onclick="loadGradingHistoryRecord(\''+r.id+'\')">'
   +'<div class="flex items-center justify-between mb-1"><span class="text-[11px] font-semibold text-ink-700">'+escapeHtml(title)+'</span><span class="text-[10px] text-ink-300">'+fmtHistoryTime(r.time)+'</span></div>'
   +(summary?'<p class="text-[11px] text-ink-400 leading-relaxed line-clamp-2 mb-1.5">'+escapeHtml(summary)+'</p>':'')
   +'<div class="flex items-center gap-2"><button onclick="event.stopPropagation();deleteGradingHistoryRecord(\''+r.id+'\')" class="text-[10px] text-ink-300 hover:text-rose-500 transition"><i class="fa-solid fa-trash-can mr-0.5"></i>删除</button></div>'
   +'</div>';
 }).join('');
}
function loadGradingHistoryRecord(id: string){
 var recs=getGradingHistory(); var rec=recs.find(function(r: LegacyBoundary){ return r.id===id; });
 if(!rec){ showToast('记录不存在或已删除'); return; }
 var resultBox=document.getElementById('gradingResult'); if(!resultBox) return;
 /* 恢复批改结果到右侧展示区 */
 resultBox.innerHTML='<div id="gradingStream" class="text-sm text-ink-700 leading-relaxed">'+renderMarkdown(rec.result||'')+'</div>';
 window._lastGradingResult=rec.result||'';
 var exportBar=document.createElement('div');
 exportBar.className='flex items-center gap-2 mt-4 pt-3 border-t border-ink-100';
 exportBar.innerHTML='<button onclick="exportGradingResult()" class="px-4 py-1.5 text-xs font-medium text-jade-700 bg-jade-50 border border-jade-200 rounded-lg hover:bg-jade-100 transition flex items-center gap-1.5"><i class="fa-solid fa-file-export"></i>导出文档</button>';
 resultBox.appendChild(exportBar);
 closeGradingHistory();
 showToast('已加载历史批改记录');
}
function deleteGradingHistoryRecord(id: string){
 var list=getGradingHistory().filter(function(r: LegacyBoundary){ return r.id!==id; });
 saveGradingHistory(list); renderGradingHistoryList();
}
function clearGradingHistory(){
 if(!getGradingHistory().length){ showToast('暂无历史记录'); return; }
 showConfirmDialog('确认清空？','确定要清空所有批改历史记录吗？此操作不可恢复',function(){ saveGradingHistory([]); renderGradingHistoryList(); });
}

/* ---------------- 组卷历史 ---------------- */
function getPaperHistory(){ try{ return JSON.parse(localStorage.getItem(PAPER_HISTORY_KEY))||[]; }catch(e){ return []; } }
function savePaperHistory(list: HTMLElement){ try{ localStorage.setItem(PAPER_HISTORY_KEY, JSON.stringify(list)); }catch(e){} }
function addPaperHistory(rec: LegacyBoundary){ var list=getPaperHistory(); list.unshift(rec); if(list.length>50) list=list.slice(0,50); savePaperHistory(list); renderPaperHistoryList(); }
function togglePaperHistory(){
 var overlay=document.getElementById('paperHistoryOverlay'), panel=document.getElementById('paperHistoryPanel');
 if(!overlay||!panel) return;
 if(overlay.classList.contains('hidden')){
  overlay.classList.remove('hidden'); renderPaperHistoryList();
  void overlay.offsetHeight;
  setTimeout(function(){ panel.style.transform!!!!!='translateX(0)'; },20);
 } else { closePaperHistory(); }
}
function closePaperHistory(event: Event){
 if(event && event.target && (event.target as LegacyBoundary).id!=='paperHistoryOverlay') return;
 var overlay=document.getElementById('paperHistoryOverlay'), panel=document.getElementById('paperHistoryPanel');
 if(!overlay||!panel) return;
 panel.style.transform='translateX(-100%)';
 setTimeout(function(){ overlay.classList.add('hidden')!!; },300);
}
function renderPaperHistoryList(){
 var list=document.getElementById('paperHistoryList'); if(!list) return;
 var recs=getPaperHistory();
 var countEl=document.getElementById('paperHistoryCount'); if(countEl) countEl.textContent=recs.length;
 if(!recs.length){ list.innerHTML='<div class="text-center py-8 text-ink-300"><i class="fa-solid fa-layer-group text-3xl mb-2 opacity-40"></i><p class="text-xs">暂无组卷历史</p></div>'; return; }
 list.innerHTML=recs.map(function(r: LegacyBoundary){
  var diffLabel={easy:'基础巩固',medium:'能力提升',hard:'挑战拔高'}[r.difficulty]||r.difficulty||'';
  var qCount=(r.questions||[]).length;
  var title=(r.topic||'组卷')+' · '+qCount+'题';
  return '<div class="group bg-white border border-ink-100 rounded-xl p-3 hover:border-jade-300 hover:shadow-sm transition-all cursor-pointer" onclick="loadPaperHistoryRecord(\''+r.id+'\')">'
   +'<div class="flex items-center justify-between mb-1"><span class="text-[11px] font-semibold text-ink-700">'+escapeHtml(title)+'</span><span class="text-[10px] text-ink-300">'+fmtHistoryTime(r.time)+'</span></div>'
   +'<p class="text-[11px] text-ink-400 mb-1.5">'+(r.subject?escapeHtml(r.subject)+' · ':'')+(diffLabel?escapeHtml(diffLabel):'')+' · 单选'+(r.single||0)+' 多选'+(r.multi||0)+' 填空'+(r.fill||0)+' 解答'+(r.solve||0)+'</p>'
   +'<div class="flex items-center gap-2"><button onclick="event.stopPropagation();deletePaperHistoryRecord(\''+r.id+'\')" class="text-[10px] text-ink-300 hover:text-rose-500 transition"><i class="fa-solid fa-trash-can mr-0.5"></i>删除</button></div>'
   +'</div>';
 }).join('');
}
function loadPaperHistoryRecord(id: string){
 var recs=getPaperHistory(); var rec=recs.find(function(r: LegacyBoundary){ return r.id===id; });
 if(!rec){ showToast('记录不存在或已删除'); return; }
 /* 恢复题池 */
 if((window as LegacyBoundary).paperPool===undefined) (window as LegacyBoundary).paperPool=[];
 paperPool=JSON.parse(JSON.stringify(rec.questions||[]));
 paperSelected=[];
 renderPaperPool();
 if(typeof renderPaperPreview==='function') renderPaperPreview();
 /* 回填参数 */
 try{
  if(rec.topic){ var tp=document.getElementById('paperTopic'); if(tp) (tp as LegacyBoundary).value=rec.topic; }
  if(rec.difficulty){ var df=document.getElementById('paperDifficulty'); if(df) (df as LegacyBoundary).value=rec.difficulty; }
 }catch(e){}
 closePaperHistory();
 showToast('已加载历史组卷（'+paperPool.length+' 题）');
}
function deletePaperHistoryRecord(id: string){
 var list=getPaperHistory().filter(function(r: LegacyBoundary){ return r.id!==id; });
 savePaperHistory(list); renderPaperHistoryList();
}
function clearPaperHistory(){
 if(!getPaperHistory().length){ showToast('暂无历史记录'); return; }
 showConfirmDialog('确认清空？','确定要清空所有组卷历史记录吗？此操作不可恢复',function(){ savePaperHistory([]); renderPaperHistoryList(); });
}
