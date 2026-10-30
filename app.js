'use strict';

/* StudyOS — local-first study planner. No backend or framework required. */
const DB_NAME = 'studyos-local-db';
const DB_VERSION = 1;
const STORE_NAMES = ['subjects', 'chapters', 'routines', 'records', 'sessions', 'notes', 'timer'];
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const appContent = $('#app-content');
const modalRoot = $('#modal-root');
let db;
let activeView = 'dashboard';
let appData = { subjects: [], chapters: [], routines: [], records: [], sessions: [], notes: [] };
let activeTimer = null;
let timerInterval = null;
let installPrompt = null;
let pendingFiles = [];
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let currentHistoryFilter = { query: '', status: 'all', from: '', to: '' };

function uid() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function dateFromInput(value) { return new Date(`${value}T00:00:00`); }
function prettyDate(value, options = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!value) return '—';
  return dateFromInput(value).toLocaleDateString('en-GB', options);
}
function timeLabel(value) {
  if (!value) return '—';
  const [h, m] = value.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatMinutes(seconds = 0) {
  const mins = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
function formatTimer(seconds = 0) {
  const safe = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(safe / 3600), m = Math.floor((safe % 3600) / 60), s = safe % 60;
  return h ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}
function colorFor(subject) { return subject?.color || '#9385ff'; }
function subjectById(id) { return appData.subjects.find(item => item.id === id); }
function chapterById(id) { return appData.chapters.find(item => item.id === id); }
function recordId(date, subjectId, chapterId) { return `${date}__${subjectId}__${chapterId}`; }
function showToast(message, type = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $('#toast-region').append(toast);
  setTimeout(() => toast.remove(), 3400);
}
function emptyState(title, text, action = '', label = '') {
  return `<div class="empty-state"><div class="empty-icon">✦</div><strong>${escapeHTML(title)}</strong><p>${escapeHTML(text)}</p>${action ? `<button class="button button-secondary button-small" data-action="${action}">${escapeHTML(label)}</button>` : ''}</div>`;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const store of STORE_NAMES) {
        if (!database.objectStoreNames.contains(store)) database.createObjectStore(store, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function dbGet(store, id) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
function dbAll(store) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}
function dbPut(store, value) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readwrite').objectStore(store).put(value);
    request.onsuccess = () => resolve(value);
    request.onerror = () => reject(request.error);
  });
}
function dbDelete(store, id) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readwrite').objectStore(store).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
function dbClear(store) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readwrite').objectStore(store).clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
async function loadData() {
  const [subjects, chapters, routines, records, sessions, notes] = await Promise.all([
    dbAll('subjects'), dbAll('chapters'), dbAll('routines'), dbAll('records'), dbAll('sessions'), dbAll('notes')
  ]);
  appData = { subjects, chapters, routines, records, sessions, notes };
}

async function ensureRecord(date, subjectId, chapterId) {
  const id = recordId(date, subjectId, chapterId);
  let record = await dbGet('records', id);
  if (!record) {
    record = { id, date, subjectId, chapterId, plannedSeconds: 0, actualSeconds: 0, completed: false, createdAt: Date.now(), updatedAt: Date.now() };
    await dbPut('records', record);
  }
  return record;
}
async function adjustPlannedTime(date, subjectId, chapterId, deltaSeconds) {
  const record = await ensureRecord(date, subjectId, chapterId);
  record.plannedSeconds = Math.max(0, (record.plannedSeconds || 0) + deltaSeconds);
  record.updatedAt = Date.now();
  await dbPut('records', record);
}

/* Every focus/manual addition becomes its own immutable session row while the daily
   Subject + Chapter record accumulates all seconds. This prevents overwrite bugs. */
async function addStudySession({ date, subjectId, chapterId, seconds, source = 'timer', note = '', startedAt = Date.now() }) {
  const amount = Math.max(0, Math.round(Number(seconds) || 0));
  if (amount < 1) return null;
  const id = recordId(date, subjectId, chapterId);
  const session = {
    id: uid(), recordId: id, date, subjectId, chapterId,
    seconds: amount, source, note: String(note || ''), startedAt,
    endedAt: Date.now(), createdAt: Date.now()
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['records', 'sessions'], 'readwrite');
    const records = tx.objectStore('records');
    const sessions = tx.objectStore('sessions');
    const request = records.get(id);
    request.onsuccess = () => {
      const record = request.result || {
        id, date, subjectId, chapterId, plannedSeconds: 0, actualSeconds: 0,
        completed: false, createdAt: Date.now()
      };
      record.actualSeconds = (record.actualSeconds || 0) + amount;
      record.updatedAt = Date.now();
      records.put(record);
      sessions.put(session);
    };
    tx.oncomplete = () => resolve(session);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Database transaction aborted'));
  });
}

function setView(view) {
  activeView = view;
  $$('.nav-link, .mobile-nav-link').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
  $('#sidebar').classList.remove('open');
  render();
}
function setHeader(title, eyebrow = 'YOUR WORKSPACE') {
  $('#page-title').textContent = title;
  $('#top-eyebrow').textContent = eyebrow;
  $('#today-label').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
function render() {
  if (!db) return;
  const renderers = {
    dashboard: renderDashboard, planner: renderPlanner, subjects: renderSubjects,
    history: renderHistory, notes: renderNotes, analytics: renderAnalytics, settings: renderSettings
  };
  (renderers[activeView] || renderDashboard)();
  renderTimerStrip();
}

function renderDashboard() {
  setHeader('Dashboard', 'YOUR STUDY OVERVIEW');
  const today = localDate();
  const records = appData.records.filter(r => r.date === today);
  const routines = appData.routines.filter(r => r.date === today).sort((a,b) => a.startTime.localeCompare(b.startTime));
  const actual = records.reduce((sum,r) => sum + (r.actualSeconds || 0), 0);
  const planned = records.reduce((sum,r) => sum + (r.plannedSeconds || 0), 0);
  const completed = records.filter(r => r.completed).length;
  const percent = planned ? Math.min(100, Math.round(actual / planned * 100)) : 0;
  const upcoming = routines.find(r => !r.completed && `${r.date}T${r.startTime}` >= `${today}T${new Date().toTimeString().slice(0,5)}`);
  const recentRecords = [...records].sort((a,b) => (b.updatedAt||0)-(a.updatedAt||0)).slice(0,4);
  appContent.innerHTML = `
    <section class="panel hero-panel">
      <div class="hero-kicker">${new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})}</div>
      <h2>Small focused sessions build extraordinary progress.</h2>
      <p>Plan one chapter, focus on one session, and let StudyOS keep your progress organized.</p>
      <div class="hero-actions"><button class="button button-primary" data-action="open-timer">◷ Start focus timer</button><button class="button button-secondary" data-action="open-routine">＋ Add to routine</button></div>
    </section>
    <section class="grid stats-grid" style="margin-top:17px">
      <article class="stat-card"><div class="stat-top">Study time today <span class="stat-icon">◷</span></div><div class="stat-value">${formatMinutes(actual)}</div><div class="stat-foot">Actual time accumulated</div></article>
      <article class="stat-card" style="--glow:rgba(73,214,207,.13)"><div class="stat-top">Planned today <span class="stat-icon" style="--tone:var(--cyan);--tone-bg:rgba(73,214,207,.12)">▣</span></div><div class="stat-value">${formatMinutes(planned)}</div><div class="stat-foot">Across ${records.length} subject-chapter records</div></article>
      <article class="stat-card" style="--glow:rgba(88,214,162,.13)"><div class="stat-top">Completed items <span class="stat-icon" style="--tone:var(--green);--tone-bg:rgba(88,214,162,.12)">✓</span></div><div class="stat-value">${completed}<span class="muted" style="font-size:13px"> / ${records.length}</span></div><div class="stat-foot">Marked complete by you</div></article>
      <article class="stat-card" style="--glow:rgba(255,189,115,.12)"><div class="stat-top">Study records <span class="stat-icon" style="--tone:var(--orange);--tone-bg:rgba(255,189,115,.12)">☷</span></div><div class="stat-value">${appData.records.length}</div><div class="stat-foot">All-time subject-chapter entries</div></article>
    </section>
    <section class="grid two-col">
      <article class="panel">
        <div class="panel-heading"><div><h3>Today's progress</h3><p>Actual study time compared with planned time</p></div><span class="badge">${percent}%</span></div>
        <div class="progress-row"><div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div><div class="progress-number">${percent}%</div></div>
        <div class="divider"></div>
        <div class="panel-heading"><div><h3>Today's study records</h3><p>Repeated sessions are combined in one record</p></div><button class="text-link" data-view="history">View history →</button></div>
        ${recentRecords.length ? `<div class="list-stack">${recentRecords.map(record => renderCompactRecord(record)).join('')}</div>` : emptyState('No study activity yet','Create a routine or start a focus timer to begin.','open-routine','Create first session')}
      </article>
      <article class="panel">
        <div class="panel-heading"><div><h3>Next on your routine</h3><p>Today's scheduled sessions</p></div><button class="text-link" data-view="planner">Open planner →</button></div>
        ${upcoming ? `<div class="task-row"><div class="task-color" style="--task-color:${colorFor(subjectById(upcoming.subjectId))}"></div><div class="task-main"><strong>${escapeHTML(chapterById(upcoming.chapterId)?.name || 'Chapter')}</strong><small>${escapeHTML(subjectById(upcoming.subjectId)?.name || 'Subject')}</small></div><div class="task-time">${timeLabel(upcoming.startTime)}<br>${formatMinutes(upcoming.durationSeconds)}</div></div>` : `<div class="empty-state"><div class="empty-icon">☼</div><strong>Nothing upcoming</strong><p>Plan a session to give your next study block a clear place.</p><button class="button button-secondary button-small" data-action="open-routine">＋ Add routine</button></div>`}
        <div class="divider"></div>
        <div class="panel-heading"><div><h3>Your subjects</h3><p>${appData.subjects.length} subjects created</p></div><button class="text-link" data-view="subjects">Manage →</button></div>
        ${appData.subjects.length ? appData.subjects.slice(0,4).map(s => {
          const chapters = appData.chapters.filter(c => c.subjectId === s.id);
          const done = chapters.filter(c => c.completed).length;
          const pct = chapters.length ? Math.round(done/chapters.length*100) : 0;
          return `<div class="subject-stat"><div class="subject-stat-top"><span>${escapeHTML(s.name)}</span><span>${done}/${chapters.length} chapters</span></div><div class="progress-track"><div class="progress-fill" style="width:${pct}%;background:${colorFor(s)}"></div></div></div>`;
        }).join('') : `<p class="small-muted">Add a subject to organize your chapters.</p>`}
      </article>
    </section>`;
}
function renderCompactRecord(record) {
  const subject = subjectById(record.subjectId), chapter = chapterById(record.chapterId);
  return `<div class="task-row"><div class="task-color" style="--task-color:${colorFor(subject)}"></div><div class="task-main"><strong>${escapeHTML(chapter?.name || 'Deleted chapter')}</strong><small>${escapeHTML(subject?.name || 'Deleted subject')}</small></div><div class="task-time"><b>${formatMinutes(record.actualSeconds)}</b><br>${record.completed ? '<span class="badge green">Done</span>' : 'Studied'}</div></div>`;
}

function renderPlanner() {
  setHeader('Routine planner', 'PLAN YOUR STUDY TIME');
  const date = $('#planner-date')?.value || localDate();
  const routines = appData.routines.filter(r => r.date === date).sort((a,b) => a.startTime.localeCompare(b.startTime));
  appContent.innerHTML = `
    <div class="page-heading"><div><h2>Plan your sessions</h2><p>Set a time block, choose a chapter, and start its timer when ready.</p></div><div class="heading-actions"><button class="button button-primary" data-action="open-routine">＋ New routine</button></div></div>
    <div class="toolbar"><div class="toolbar-left"><div class="field"><label for="planner-date">Choose date</label><input class="input" type="date" id="planner-date" value="${date}"></div></div><div class="toolbar-right"><span class="badge">${routines.length} scheduled</span><span class="badge green">${formatMinutes(routines.filter(r=>r.completed).reduce((a,r)=>a+r.durationSeconds,0))} completed plan</span></div></div>
    <section class="panel"><div class="panel-heading"><div><h3>${prettyDate(date,{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</h3><p>Daily timeline</p></div></div>
      ${routines.length ? `<div class="routine-list">${routines.map(renderRoutine).join('')}</div>` : emptyState('No routine for this day','Add a Subject, Chapter and duration to create your first study block.','open-routine','＋ Create routine')}
    </section>`;
}
function renderRoutine(routine) {
  const subject = subjectById(routine.subjectId), chapter = chapterById(routine.chapterId);
  return `<article class="routine-card" data-routine-id="${routine.id}"><div class="routine-clock">${timeLabel(routine.startTime)}<small>${routine.endTime ? timeLabel(routine.endTime) : 'Custom duration'}</small></div><div class="routine-color" style="--task-color:${colorFor(subject)}"></div><div class="routine-info"><strong>${escapeHTML(chapter?.name || 'Chapter removed')}</strong><small>${escapeHTML(subject?.name || 'Subject removed')} · ${formatMinutes(routine.durationSeconds)} planned ${routine.completed ? '· Completed' : ''}</small></div><div class="routine-actions"><button class="icon-button" data-action="start-routine" data-id="${routine.id}" title="Start timer">▶</button><button class="icon-button" data-action="toggle-routine" data-id="${routine.id}" title="Toggle complete">${routine.completed ? '↶' : '✓'}</button><button class="icon-button" data-action="edit-routine" data-id="${routine.id}" title="Edit">✎</button><button class="icon-button" data-action="delete-routine" data-id="${routine.id}" title="Delete">×</button></div></article>`;
}

function renderSubjects() {
  setHeader('Subjects & chapters', 'YOUR LEARNING LIBRARY');
  appContent.innerHTML = `
    <div class="page-heading"><div><h2>Subjects & chapters</h2><p>Organize your syllabus into manageable chapters.</p></div><div class="heading-actions"><button class="button button-primary" data-action="add-subject">＋ Add subject</button></div></div>
    ${appData.subjects.length ? `<section class="grid subject-grid">${appData.subjects.map(subject => {
      const chapters = appData.chapters.filter(c => c.subjectId === subject.id);
      const done = chapters.filter(c => c.completed).length;
      const pct = chapters.length ? Math.round(done/chapters.length*100) : 0;
      return `<article class="subject-card"><div class="subject-top"><div class="subject-symbol" style="--subject-color:${colorFor(subject)}">${escapeHTML(subject.icon || subject.name.slice(0,1).toUpperCase())}</div><div class="chapter-actions"><button class="icon-button" data-action="edit-subject" data-id="${subject.id}" title="Edit subject">✎</button><button class="icon-button" data-action="delete-subject" data-id="${subject.id}" title="Delete subject">×</button></div></div><h3>${escapeHTML(subject.name)}</h3><p>${chapters.length} chapters · ${done} completed</p><div class="subject-progress"><div class="progress-row"><div class="progress-track"><div class="progress-fill" style="width:${pct}%;background:${colorFor(subject)}"></div></div><div class="progress-number">${pct}%</div></div></div><div class="chapter-list">${chapters.length ? chapters.map(ch => `<div class="chapter-item ${ch.completed?'done':''}"><span>${escapeHTML(ch.name)}</span><button class="checkmark ${ch.completed?'checked':''}" data-action="toggle-chapter" data-id="${ch.id}" title="Toggle chapter completed">${ch.completed?'✓':''}</button><button class="icon-button" style="width:26px;height:26px" data-action="edit-chapter" data-id="${ch.id}" title="Edit chapter">✎</button><button class="icon-button" style="width:26px;height:26px" data-action="delete-chapter" data-id="${ch.id}" title="Delete chapter">×</button></div>`).join('') : '<small class="muted">No chapters added yet.</small>'}</div><button class="button button-secondary button-small button-block" style="margin-top:12px" data-action="add-chapter" data-id="${subject.id}">＋ Add chapter</button></article>`;
    }).join('')}</section>` : emptyState('Start with your first subject','Create a subject such as Physics, Chemistry or Biology, then add its chapters.','add-subject','＋ Add subject')}`;
}

function renderHistory() {
  setHeader('Study history', 'YOUR PERSONAL STUDY DATABASE');
  const query = currentHistoryFilter.query.toLowerCase();
  let records = [...appData.records].filter(r => {
    const subject = subjectById(r.subjectId)?.name || '';
    const chapter = chapterById(r.chapterId)?.name || '';
    const textMatch = !query || `${subject} ${chapter}`.toLowerCase().includes(query);
    const statusMatch = currentHistoryFilter.status === 'all' || (currentHistoryFilter.status === 'done' ? r.completed : !r.completed);
    const fromMatch = !currentHistoryFilter.from || r.date >= currentHistoryFilter.from;
    const toMatch = !currentHistoryFilter.to || r.date <= currentHistoryFilter.to;
    return textMatch && statusMatch && fromMatch && toMatch;
  }).sort((a,b) => b.date.localeCompare(a.date) || (b.updatedAt||0)-(a.updatedAt||0));
  const grouped = records.reduce((map, record) => { (map[record.date] ||= []).push(record); return map; }, {});
  appContent.innerHTML = `
    <div class="page-heading"><div><h2>Study history</h2><p>One card per date + subject + chapter. Every added session is kept separately.</p></div><div class="heading-actions"><button class="button button-secondary" data-action="export-csv">↓ Export CSV</button><button class="button button-primary" data-action="open-timer">◷ Add study time</button></div></div>
    <section class="panel"><div class="toolbar"><div class="toolbar-left"><input class="input search-input" id="history-search" placeholder="Search subject or chapter..." value="${escapeHTML(currentHistoryFilter.query)}"><select class="select" id="history-status" style="width:auto"><option value="all" ${currentHistoryFilter.status==='all'?'selected':''}>All status</option><option value="done" ${currentHistoryFilter.status==='done'?'selected':''}>Completed</option><option value="pending" ${currentHistoryFilter.status==='pending'?'selected':''}>Not completed</option></select></div><div class="toolbar-right"><input class="input" style="width:145px" type="date" id="history-from" value="${currentHistoryFilter.from}" aria-label="From date"><input class="input" style="width:145px" type="date" id="history-to" value="${currentHistoryFilter.to}" aria-label="To date"></div></div>
    <div class="small-muted" style="margin-bottom:12px">${records.length} records · ${formatMinutes(records.reduce((sum,r)=>sum+(r.actualSeconds||0),0))} total actual study time</div>
    ${records.length ? Object.entries(grouped).map(([date, list]) => `<div class="history-day"><div class="history-day-head"><strong>${prettyDate(date,{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</strong><small>${list.length} record${list.length>1?'s':''} · ${formatMinutes(list.reduce((s,r)=>s+(r.actualSeconds||0),0))}</small></div>${list.map(renderRecord).join('')}</div>`).join('') : emptyState('No matching study records','Start a timer, add a routine or change your filters.','open-timer','Start study session')}</section>`;
}
function renderRecord(record) {
  const subject = subjectById(record.subjectId), chapter = chapterById(record.chapterId);
  const sessions = appData.sessions.filter(s => s.recordId === record.id).sort((a,b) => a.startedAt-b.startedAt);
  const targetPct = record.plannedSeconds ? Math.min(100,Math.round(record.actualSeconds/record.plannedSeconds*100)) : 0;
  return `<article class="record-card"><div class="record-title"><button class="checkmark ${record.completed?'checked':''}" data-action="toggle-record" data-id="${record.id}" aria-label="Mark complete">${record.completed?'✓':''}</button><div><strong>${escapeHTML(chapter?.name || 'Deleted chapter')}</strong><small><span style="color:${colorFor(subject)}">●</span> ${escapeHTML(subject?.name || 'Deleted subject')} · ${sessions.length} saved session${sessions.length===1?'':'s'}</small></div></div><div class="record-metrics"><strong>${formatMinutes(record.actualSeconds)}</strong><small>${record.plannedSeconds ? `${formatMinutes(record.plannedSeconds)} planned · ${targetPct}%` : 'No planned duration'}</small><div class="progress-track" style="width:100%;max-width:150px"><div class="progress-fill" style="width:${targetPct}%"></div></div></div><div class="record-actions"><button class="icon-button" data-action="add-time" data-id="${record.id}" title="Add more duration">＋</button><button class="icon-button" data-action="focus-record" data-id="${record.id}" title="Start another focus session">▶</button></div>${sessions.length ? `<details class="session-details"><summary>See ${sessions.length} individual session${sessions.length===1?'':'s'} · total ${formatMinutes(record.actualSeconds)}</summary><ul>${sessions.map(s=>`<li>${new Date(s.startedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} · +${formatMinutes(s.seconds)} · ${s.source==='manual'?'Manual addition':s.source==='timer'?'Focus timer':'Routine timer'}${s.note?` · ${escapeHTML(s.note)}`:''}</li>`).join('')}</ul></details>` : ''}</article>`;
}

function renderNotes() {
  setHeader('Notes & resources', 'YOUR STUDY MATERIALS');
  appContent.innerHTML = `<div class="page-heading"><div><h2>Notes & resources</h2><p>Keep text, images, PDFs and audio attached to the relevant subject or chapter.</p></div><div class="heading-actions"><button class="button button-primary" data-action="add-note">＋ Create note</button></div></div>
    ${appData.notes.length ? `<section class="grid note-grid">${[...appData.notes].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).map(note=>`<article class="note-card"><div class="subject-top"><span class="badge">${prettyDate(note.date || localDate())}</span><div class="chapter-actions"><button class="icon-button" data-action="edit-note" data-id="${note.id}" title="Edit note">✎</button><button class="icon-button" data-action="delete-note" data-id="${note.id}" title="Delete note">×</button></div></div><h3>${escapeHTML(note.title)}</h3><div class="small-muted">${escapeHTML(subjectById(note.subjectId)?.name || 'General note')}${note.chapterId?` · ${escapeHTML(chapterById(note.chapterId)?.name || '')}`:''}</div><p>${escapeHTML(note.body || 'No text content.')}</p><div>${(note.attachments||[]).map((f,i)=>`<button class="file-chip" data-action="open-attachment" data-id="${note.id}" data-index="${i}">${fileIcon(f.type)} ${escapeHTML(f.name)}</button>`).join('')}</div></article>`).join('')}</section>` : emptyState('Your notes space is empty','Save a chapter summary, image, PDF or audio recording here.','add-note','＋ Create first note')}`;
}
function fileIcon(type='') { if(type.includes('image')) return '▧'; if(type.includes('pdf')) return 'PDF'; if(type.includes('audio')) return '♫'; return '⌁'; }

function renderAnalytics() {
  setHeader('Analytics', 'MEASURE YOUR CONSISTENCY');
  const today = dateFromInput(localDate());
  const days = Array.from({length:7},(_,i)=>{const d=new Date(today);d.setDate(today.getDate()-6+i);return localDate(d);});
  const values = days.map(day=>appData.records.filter(r=>r.date===day).reduce((s,r)=>s+(r.actualSeconds||0),0));
  const max = Math.max(1,...values);
  const total = appData.records.reduce((s,r)=>s+(r.actualSeconds||0),0);
  const planned = appData.records.reduce((s,r)=>s+(r.plannedSeconds||0),0);
  const completed = appData.records.filter(r=>r.completed).length;
  const subjectTotals = appData.subjects.map(subject=>({subject,seconds:appData.records.filter(r=>r.subjectId===subject.id).reduce((s,r)=>s+(r.actualSeconds||0),0)})).sort((a,b)=>b.seconds-a.seconds);
  appContent.innerHTML = `<div class="page-heading"><div><h2>Your progress at a glance</h2><p>Statistics are calculated from saved study sessions, not planned time.</p></div><span class="badge green">Local data</span></div>
    <section class="grid stats-grid"><article class="stat-card"><div class="stat-top">All-time study time</div><div class="stat-value">${formatMinutes(total)}</div><div class="stat-foot">Actual accumulated time</div></article><article class="stat-card"><div class="stat-top">Planned time</div><div class="stat-value">${formatMinutes(planned)}</div><div class="stat-foot">Across all records</div></article><article class="stat-card"><div class="stat-top">Completed records</div><div class="stat-value">${completed}</div><div class="stat-foot">Marked complete</div></article><article class="stat-card"><div class="stat-top">Total sessions</div><div class="stat-value">${appData.sessions.length}</div><div class="stat-foot">Including manual additions</div></article></section>
    <section class="grid analytics-grid"><article class="panel"><div class="panel-heading"><div><h3>Last 7 days</h3><p>Daily actual study duration</p></div><span class="badge">${formatMinutes(values.reduce((a,b)=>a+b,0))}</span></div><div class="bar-chart">${values.map((v,i)=>`<div class="bar-col"><strong>${v?formatMinutes(v):'—'}</strong><div class="bar" style="height:${Math.max(v?4:1,(v/max)*76)}%"></div><small>${dateFromInput(days[i]).toLocaleDateString('en-GB',{weekday:'short'})}</small></div>`).join('')}</div></article><article class="panel"><div class="panel-heading"><div><h3>Subject distribution</h3><p>Actual study time by subject</p></div></div>${subjectTotals.length ? subjectTotals.map(x=>`<div class="subject-stat"><div class="subject-stat-top"><span>${escapeHTML(x.subject.name)}</span><span>${formatMinutes(x.seconds)}</span></div><div class="progress-track"><div class="progress-fill" style="width:${total?Math.round(x.seconds/total*100):0}%;background:${colorFor(x.subject)}"></div></div></div>`).join('') : emptyState('No subject data yet','Add subjects and record study sessions.')}</article></section>`;
}

function renderSettings() {
  setHeader('Settings', 'PERSONALIZE YOUR WORKSPACE');
  const theme = localStorage.getItem('studyos-theme') || 'dark';
  const notifications = localStorage.getItem('studyos-notifications') !== 'off';
  appContent.innerHTML = `<div class="page-heading"><div><h2>Settings</h2><p>Control your StudyOS experience and protect your local data.</p></div></div>
    <section class="panel settings-section"><div class="panel-heading"><div><h3>Appearance</h3><p>Choose a comfortable workspace theme.</p></div></div><div class="settings-row"><div><strong>Theme</strong><small>Switch between dark and light mode.</small></div><button class="button button-secondary button-small" data-action="toggle-theme">${theme==='dark'?'Dark mode':'Light mode'} · Change</button></div></section>
    <section class="panel settings-section"><div class="panel-heading"><div><h3>Notifications</h3><p>Reminders can be delivered while the app is open and allowed by your browser.</p></div></div><div class="settings-row"><div><strong>Study reminders</strong><small>Browser support and background delivery vary. A PWA cannot guarantee exact-time reminders when fully closed on every Android browser.</small></div><button class="switch ${notifications?'on':''}" data-action="toggle-notifications" aria-label="Toggle notifications"></button></div><div class="settings-row"><div><strong>Notification permission</strong><small>Current status: ${('Notification' in window)?Notification.permission:'Not supported'}</small></div><button class="button button-secondary button-small" data-action="request-notifications">Enable notifications</button></div></section>
    <section class="panel settings-section"><div class="panel-heading"><div><h3>Data & backup</h3><p>Your records and attachments are stored locally in this browser using IndexedDB.</p></div></div><div class="settings-row"><div><strong>Export full backup</strong><small>Download subjects, chapters, routines, study history, notes and attachments as JSON.</small></div><button class="button button-secondary button-small" data-action="backup-export">↓ Download backup</button></div><div class="settings-row"><div><strong>Restore backup</strong><small>Import a previous StudyOS JSON backup. Existing data will be replaced after confirmation.</small></div><button class="button button-secondary button-small" data-action="backup-import">↑ Restore JSON</button><input class="hidden" type="file" id="backup-file" accept="application/json,.json"></div><div class="settings-row"><div><strong>Export study history</strong><small>Open your study records in spreadsheet software using CSV.</small></div><button class="button button-secondary button-small" data-action="export-csv">↓ Export CSV</button></div><div class="settings-row"><div><strong>Persistent storage</strong><small id="storage-status">Checking browser storage support...</small></div><button class="button button-secondary button-small" data-action="request-persistence">Request</button></div><div class="settings-row"><div><strong>Delete all local data</strong><small>This permanently clears StudyOS records stored in this browser.</small></div><button class="button button-danger button-small" data-action="clear-data">Clear all data</button></div></section>
    <section class="panel settings-section"><div class="panel-heading"><div><h3>Install StudyOS</h3><p>Install it from your browser menu or use the install prompt when available.</p></div></div><div class="settings-row"><div><strong>Progressive Web App</strong><small>Serve this project over HTTPS (or localhost) for installation and service-worker support.</small></div><button class="button button-primary button-small" data-action="install-pwa">Install app</button></div></section>`;
  updateStorageStatus();
}

function renderTimerStrip() {
  const existing = $('#timer-strip');
  if (existing) existing.remove();
  if (!activeTimer || activeTimer.status === 'finished') return;
  const remaining = activeTimer.status === 'running' ? Math.max(0,Math.ceil((activeTimer.endAt-Date.now())/1000)) : activeTimer.remainingSeconds;
  const subject = subjectById(activeTimer.subjectId), chapter = chapterById(activeTimer.chapterId);
  const strip = document.createElement('div');
  strip.id = 'timer-strip';
  strip.className = 'panel';
  strip.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;padding:10px 14px;border-color:rgba(147,133,255,.3);background:linear-gradient(100deg,rgba(147,133,255,.12),rgba(73,214,207,.06)),var(--panel)';
  strip.innerHTML = `<div style="min-width:0"><strong style="font-size:11px">◷ ${activeTimer.status==='paused'?'Timer paused':'Focus session active'}</strong><div class="small-muted">${escapeHTML(subject?.name||'Subject')} · ${escapeHTML(chapter?.name||'Chapter')}</div></div><strong style="font-size:17px;font-variant-numeric:tabular-nums">${formatTimer(remaining)}</strong><button class="button button-secondary button-small" data-action="show-timer">Open timer</button>`;
  appContent.prepend(strip);
}

function openModal(markup, wide = false) {
  modalRoot.innerHTML = `<div class="modal-backdrop" data-action="backdrop-close" style="position:absolute;inset:0"></div><section class="modal ${wide?'modal-wide':''}" role="dialog" aria-modal="true">${markup}</section>`;
}
function closeModal() { modalRoot.innerHTML = ''; pendingFiles = []; }
function modalHeader(title, subtitle = '') {
  return `<div class="modal-head"><div><h2>${title}</h2>${subtitle?`<p>${subtitle}</p>`:''}</div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close">×</button></div>`;
}
function subjectSelectOptions(selected = '') {
  return `<option value="">Choose a subject</option>${appData.subjects.map(s=>`<option value="${s.id}" ${s.id===selected?'selected':''}>${escapeHTML(s.name)}</option>`).join('')}`;
}
function chapterSelectOptions(subjectId, selected = '') {
  return `<option value="">Choose a chapter</option>${appData.chapters.filter(c=>c.subjectId===subjectId).map(c=>`<option value="${c.id}" ${c.id===selected?'selected':''}>${escapeHTML(c.name)}</option>`).join('')}`;
}

async function openRoutineModal(routineId = null) {
  if (!appData.subjects.length) { showToast('প্রথমে একটি Subject তৈরি করুন।'); openSubjectModal(); return; }
  const routine = routineId ? appData.routines.find(r=>r.id===routineId) : null;
  const subjectId = routine?.subjectId || appData.subjects[0].id;
  const startTime = routine?.startTime || '08:00';
  const endTime = routine?.endTime || '09:00';
  const durationMin = Math.max(1,Math.round((routine?.durationSeconds || 3600)/60));
  openModal(`${modalHeader(routine?'Edit routine':'Add a routine','Choose a subject, chapter, date and time block. The planned time is added to that date’s study record.')}
    <form id="routine-form" data-id="${routine?.id||''}"><div class="form-grid">
      <div class="field"><label for="routine-date">Date</label><input class="input" type="date" id="routine-date" name="date" required value="${routine?.date||localDate()}"></div>
      <div class="field"><label for="routine-subject">Subject</label><select class="select" id="routine-subject" name="subjectId" required>${subjectSelectOptions(subjectId)}</select></div>
      <div class="field full"><label for="routine-chapter">Chapter</label><select class="select" id="routine-chapter" name="chapterId" required>${chapterSelectOptions(subjectId,routine?.chapterId||'')}</select></div>
      <div class="field"><label for="routine-start">Start time</label><input class="input" type="time" id="routine-start" name="startTime" value="${startTime}"></div>
      <div class="field"><label for="routine-end">End time</label><input class="input" type="time" id="routine-end" name="endTime" value="${endTime}"></div>
      <div class="field"><label for="routine-duration">Planned duration (minutes)</label><input class="input" type="number" id="routine-duration" name="durationMinutes" min="1" max="1440" value="${durationMin}" required></div>
      <div class="field"><label for="routine-priority">Priority</label><select class="select" id="routine-priority" name="priority"><option value="normal" ${routine?.priority==='normal'?'selected':''}>Normal</option><option value="high" ${routine?.priority==='high'?'selected':''}>High</option><option value="low" ${routine?.priority==='low'?'selected':''}>Low</option></select></div>
      <div class="field full"><label for="routine-description">Description (optional)</label><textarea class="textarea" id="routine-description" name="description" placeholder="What will you focus on?">${escapeHTML(routine?.description||'')}</textarea></div>
    </div><div class="duration-hint" id="routine-duration-hint" style="margin-top:13px">Planned duration will be counted in the daily Subject–Chapter record. Another routine for the same chapter on the same date adds to the existing planned time.</div>
    <div class="modal-footer"><button class="button button-ghost" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">${routine?'Save changes':'Save routine'}</button></div></form>`);
  updateRoutineHint();
}
function updateRoutineHint() {
  const start = $('#routine-start')?.value, end = $('#routine-end')?.value;
  const duration = Number($('#routine-duration')?.value || 0);
  let message = `${duration} minute${duration===1?'':'s'} planned. This adds to the existing daily Subject–Chapter plan.`;
  if (start && end) {
    const [sh,sm]=start.split(':').map(Number),[eh,em]=end.split(':').map(Number);
    let diff = eh*60+em-(sh*60+sm); if(diff<0) diff += 1440;
    if(diff>0) message = `Time range ${timeLabel(start)}–${timeLabel(end)} = ${diff} minutes. This will be added to the existing daily Subject–Chapter plan.`;
    else message = 'End time matches the start time. Adjust the time range or enter a custom duration.';
  }
  const hint = $('#routine-duration-hint'); if(hint) hint.textContent = message;
}

function openSubjectModal(subjectId = null) {
  const subject = subjectId ? subjectById(subjectId) : null;
  openModal(`${modalHeader(subject?'Edit subject':'Create a subject','Subjects help you group chapters and measure progress.')}
    <form id="subject-form" data-id="${subject?.id||''}"><div class="form-grid"><div class="field full"><label for="subject-name">Subject name</label><input class="input" id="subject-name" name="name" required maxlength="70" placeholder="e.g. Physics" value="${escapeHTML(subject?.name||'')}"></div><div class="field"><label for="subject-icon">Icon / initial</label><input class="input" id="subject-icon" name="icon" maxlength="3" placeholder="P" value="${escapeHTML(subject?.icon||'')}"></div><div class="field"><label for="subject-color">Accent color</label><input class="input" style="height:42px;padding:4px" id="subject-color" name="color" type="color" value="${subject?.color||'#9385ff'}"></div></div><div class="modal-footer"><button class="button button-ghost" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Save subject</button></div></form>`);
}
function openChapterModal(subjectId, chapterId = null) {
  const chapter = chapterId ? chapterById(chapterId) : null;
  const parentId = chapter?.subjectId || subjectId;
  openModal(`${modalHeader(chapter?'Edit chapter':'Add a chapter','Create and track progress for individual chapters.')}
    <form id="chapter-form" data-id="${chapter?.id||''}" data-subject="${parentId}"><div class="form-grid"><div class="field full"><label>Subject</label><select class="select" name="subjectId" required>${subjectSelectOptions(parentId)}</select></div><div class="field full"><label for="chapter-name">Chapter name</label><input class="input" id="chapter-name" name="name" maxlength="100" required placeholder="e.g. Newtonian Mechanics" value="${escapeHTML(chapter?.name||'')}"></div><div class="field full"><label for="chapter-description">Description (optional)</label><textarea class="textarea" id="chapter-description" name="description">${escapeHTML(chapter?.description||'')}</textarea></div></div><div class="modal-footer"><button class="button button-ghost" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Save chapter</button></div></form>`);
}

async function openTimerSetup(record = null, defaults = {}) {
  if (activeTimer) { openTimerModal(); return; }
  if (!appData.subjects.length) { showToast('Timer শুরু করার আগে একটি Subject তৈরি করুন।'); openSubjectModal(); return; }
  const subjectId = record?.subjectId || defaults.subjectId || appData.subjects[0].id;
  const chapterId = record?.chapterId || defaults.chapterId || appData.chapters.find(c=>c.subjectId===subjectId)?.id || '';
  if (!appData.chapters.some(c=>c.subjectId===subjectId)) { showToast('এই Subject-এর জন্য আগে একটি Chapter যোগ করুন।'); openChapterModal(subjectId); return; }
  openModal(`${modalHeader('Start a focus session','This session will add its time to the matching daily Subject–Chapter record.')}
    <form id="timer-setup-form"><div class="form-grid"><div class="field"><label for="timer-date">Study date</label><input class="input" type="date" id="timer-date" name="date" required value="${record?.date||defaults.date||localDate()}"></div><div class="field"><label for="timer-minutes">Focus duration (minutes)</label><input class="input" type="number" id="timer-minutes" name="minutes" min="1" max="1440" value="${defaults.minutes||25}" required></div><div class="field full"><label for="timer-subject">Subject</label><select class="select" id="timer-subject" name="subjectId" required>${subjectSelectOptions(subjectId)}</select></div><div class="field full"><label for="timer-chapter">Chapter</label><select class="select" id="timer-chapter" name="chapterId" required>${chapterSelectOptions(subjectId,chapterId)}</select></div></div><div class="duration-hint" style="margin-top:13px">You can complete another focus session later. Its duration will be added to this same record, not replace the previous time.</div><div class="modal-footer"><button class="button button-ghost" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">▶ Start timer</button></div></form>`);
}

function timerRemaining(timer = activeTimer) {
  if (!timer) return 0;
  return timer.status === 'running' ? Math.max(0,Math.ceil((timer.endAt-Date.now())/1000)) : Math.max(0,timer.remainingSeconds || 0);
}
async function beginTimer({ date, subjectId, chapterId, minutes, source = 'timer' }) {
  const record = await ensureRecord(date,subjectId,chapterId);
  const totalSeconds = Math.max(1,Math.round(minutes*60));
  activeTimer = { id: 'active', recordId: record.id, date, subjectId, chapterId, totalSeconds, remainingSeconds: totalSeconds, status: 'running', startedAt: Date.now(), endAt: Date.now()+totalSeconds*1000, source };
  await dbPut('timer',activeTimer);
  closeModal();
  renderTimerModal();
  startTimerTick();
  render();
}
function startTimerTick() {
  clearInterval(timerInterval);
  timerInterval = setInterval(async () => {
    if (!activeTimer) { clearInterval(timerInterval); return; }
    const remaining = timerRemaining();
    const timerText = $('#timer-time');
    const ring = $('#timer-ring');
    if (timerText) timerText.textContent = formatTimer(remaining);
    if (ring) ring.style.setProperty('--timer-progress',`${Math.min(100,((activeTimer.totalSeconds-remaining)/activeTimer.totalSeconds)*100)}%`);
    if (remaining <= 0 && activeTimer.status === 'running') await finishTimer(true);
    if ($('#timer-strip')) renderTimerStrip();
  },1000);
}
async function persistTimer() { if (activeTimer) await dbPut('timer',activeTimer); }
function renderTimerModal() {
  if (!activeTimer) return;
  const remaining = timerRemaining();
  const subject = subjectById(activeTimer.subjectId), chapter = chapterById(activeTimer.chapterId);
  const progress = Math.min(100,((activeTimer.totalSeconds-remaining)/activeTimer.totalSeconds)*100);
  openModal(`<div class="timer-modal">${modalHeader('Focus session',`${escapeHTML(subject?.name||'Subject')} · ${escapeHTML(chapter?.name||'Chapter')}`)}
    <div class="timer-ring" id="timer-ring" style="--timer-progress:${progress}%"><div class="timer-time" id="timer-time">${formatTimer(remaining)}</div></div><div class="timer-caption">${activeTimer.status==='paused'?'PAUSED':'TIME REMAINING'}</div><p class="timer-subtitle">${prettyDate(activeTimer.date)} · ${formatMinutes(activeTimer.totalSeconds)} session</p>
    <div class="timer-actions">${activeTimer.status==='paused'?'<button class="button button-primary" data-action="resume-timer">▶ Resume</button>':'<button class="button button-secondary" data-action="pause-timer">Ⅱ Pause</button>'}<button class="button button-secondary" data-action="stop-save-timer">✓ Save session</button><button class="button button-ghost" data-action="discard-timer">Discard</button></div><p class="small-muted" style="margin-top:14px">Closing this panel will not discard the timer. The active timer is saved on this device.</p></div>`,true);
}
async function pauseTimer() {
  if (!activeTimer || activeTimer.status !== 'running') return;
  activeTimer.remainingSeconds = timerRemaining(); activeTimer.status = 'paused'; activeTimer.endAt = null;
  await persistTimer(); renderTimerModal(); render();
}
async function resumeTimer() {
  if (!activeTimer || activeTimer.status !== 'paused') return;
  activeTimer.status = 'running'; activeTimer.endAt = Date.now()+activeTimer.remainingSeconds*1000;
  await persistTimer(); renderTimerModal(); startTimerTick(); render();
}
async function finishTimer(completed) {
  if (!activeTimer) return;
  const timer = {...activeTimer};
  const seconds = completed ? timer.totalSeconds : Math.max(0,timer.totalSeconds-timerRemaining(timer));
  clearInterval(timerInterval); timerInterval = null; activeTimer = null;
  await dbDelete('timer','active');
  if (seconds > 0) await addStudySession({date:timer.date,subjectId:timer.subjectId,chapterId:timer.chapterId,seconds,source:timer.source||'timer',startedAt:timer.startedAt});
  closeModal(); await loadData(); render();
  if (completed) {
    showToast(`Focus session complete — ${formatMinutes(seconds)} added to your study record.`, 'success');
    sendNotification('Focus session complete',`${formatMinutes(seconds)} added to ${chapterById(timer.chapterId)?.name || 'your study record'}.`);
  } else showToast(seconds ? `${formatMinutes(seconds)} added to your study record.` : 'Timer discarded. No time was added.', seconds?'success':'');
}

function openAddTimeModal(recordIdValue) {
  const record = appData.records.find(r=>r.id===recordIdValue);
  if (!record) return;
  const subject = subjectById(record.subjectId), chapter = chapterById(record.chapterId);
  openModal(`${modalHeader('Add more study time','This creates a new session and adds it to the existing total. Previous sessions remain saved.')}
    <form id="add-time-form" data-record="${record.id}"><div class="duration-hint" style="margin-bottom:14px"><b>${escapeHTML(subject?.name||'Subject')} · ${escapeHTML(chapter?.name||'Chapter')}</b><br>Current total: <b>${formatMinutes(record.actualSeconds)}</b>. New time will be added to this total.</div><div class="form-grid"><div class="field"><label for="manual-minutes">Additional duration (minutes)</label><input class="input" id="manual-minutes" name="minutes" type="number" min="1" max="1440" value="30" required></div><div class="field"><label for="manual-note">Session note (optional)</label><input class="input" id="manual-note" name="note" placeholder="e.g. Solved practice problems"></div></div><div class="modal-footer"><button class="button button-ghost" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">＋ Add duration</button></div></form>`);
}

async function openNoteModal(noteId = null) {
  const note = noteId ? appData.notes.find(n=>n.id===noteId) : null;
  pendingFiles = [];
  const subjectId = note?.subjectId || '';
  const chapterId = note?.chapterId || '';
  openModal(`${modalHeader(note?'Edit note':'Create a note','Attach images, PDFs and audio files to this note. Files are stored locally in IndexedDB.')}
    <form id="note-form" data-id="${note?.id||''}"><div class="form-grid"><div class="field full"><label for="note-title">Title</label><input class="input" id="note-title" name="title" maxlength="100" required placeholder="Chapter summary..." value="${escapeHTML(note?.title||'')}"></div><div class="field"><label for="note-subject">Subject (optional)</label><select class="select" id="note-subject" name="subjectId"><option value="">General note</option>${appData.subjects.map(s=>`<option value="${s.id}" ${s.id===subjectId?'selected':''}>${escapeHTML(s.name)}</option>`).join('')}</select></div><div class="field"><label for="note-chapter">Chapter (optional)</label><select class="select" id="note-chapter" name="chapterId">${chapterSelectOptions(subjectId,chapterId)}</select></div><div class="field full"><label for="note-body">Note</label><textarea class="textarea" id="note-body" name="body" placeholder="Write your note here...">${escapeHTML(note?.body||'')}</textarea></div><div class="field full"><label for="note-files">Attach image, PDF or audio</label><input class="input" id="note-files" type="file" accept="image/*,application/pdf,audio/*" multiple><small>Large files use your browser's local storage quota. Keep a JSON backup to protect your attachments.</small></div><div class="field full"><div class="toolbar-left"><button class="button button-secondary button-small" type="button" data-action="start-audio">● Record audio</button><span id="audio-status" class="small-muted">${note?.attachments?.length||0} existing attachment(s)</span></div><div id="pending-file-list" class="small-muted" style="margin-top:7px"></div></div></div><div class="modal-footer"><button class="button button-ghost" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Save note</button></div></form>`,true);
  pendingFiles = [];
  if (note?.attachments?.length) $('#audio-status').textContent = `${note.attachments.length} existing attachment(s) · new files can be added`;
}
function refreshPendingFileList() {
  const el = $('#pending-file-list'); if (!el) return;
  el.textContent = pendingFiles.length ? `Ready to attach: ${pendingFiles.map(f=>f.name).join(', ')}` : 'No new files selected.';
}
async function startAudioRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { showToast('Audio recording is not supported in this browser.'); return; }
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({audio:true});
    audioChunks = [];
    mediaRecorder = new MediaRecorder(audioStream);
    mediaRecorder.ondataavailable = e => { if (e.data.size) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunks,{type:mediaRecorder.mimeType||'audio/webm'});
      pendingFiles.push(new File([blob],`StudyOS-audio-${Date.now()}.webm`,{type:blob.type}));
      audioStream?.getTracks().forEach(t=>t.stop()); audioStream=null;
      if ($('#audio-status')) $('#audio-status').textContent = 'Audio recording ready to save';
      refreshPendingFileList(); showToast('Audio recording added to pending attachments.');
    };
    mediaRecorder.start();
    if ($('#audio-status')) $('#audio-status').textContent = 'Recording… tap Stop recording when finished.';
    const button = $('[data-action="start-audio"]'); if (button) { button.dataset.action='stop-audio'; button.textContent='■ Stop recording'; }
  } catch (error) { showToast(`Microphone unavailable: ${error.message}`,'error'); }
}
function stopAudioRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  const button = $('[data-action="stop-audio"]'); if (button) { button.dataset.action='start-audio'; button.textContent='● Record audio'; }
}

async function handleRoutineSubmit(form) {
  const fd = new FormData(form);
  const date = fd.get('date'), subjectId = fd.get('subjectId'), chapterId = fd.get('chapterId');
  const startTime = fd.get('startTime') || '', endTime = fd.get('endTime') || '';
  let durationMinutes = Number(fd.get('durationMinutes'));
  if (startTime && endTime) {
    const [sh,sm]=startTime.split(':').map(Number),[eh,em]=endTime.split(':').map(Number);
    let diff=eh*60+em-(sh*60+sm); if(diff<0) diff+=1440;
    if (diff > 0) durationMinutes = diff;
  }
  if (!date || !subjectId || !chapterId || !Number.isFinite(durationMinutes) || durationMinutes < 1) { showToast('সব প্রয়োজনীয় তথ্য সঠিকভাবে পূরণ করুন।','error'); return; }
  const durationSeconds = Math.round(durationMinutes*60);
  const id = form.dataset.id || uid();
  const old = form.dataset.id ? appData.routines.find(r=>r.id===form.dataset.id) : null;
  const collision = appData.routines.find(r=>r.id!==id && r.date===date && r.startTime && startTime && r.endTime && endTime &&
    Math.max(toMinutes(startTime),toMinutes(r.startTime)) < Math.min(toMinutes(endTime),toMinutes(r.endTime)));
  if (collision && !confirm('This time overlaps another routine. Save anyway?')) return;
  const routine = { id, date, subjectId, chapterId, startTime, endTime, durationSeconds, priority:fd.get('priority')||'normal', description:fd.get('description')||'', completed:old?.completed||false, notifiedAt:old?.notifiedAt||null, createdAt:old?.createdAt||Date.now(), updatedAt:Date.now() };
  await dbPut('routines',routine);
  if (old) {
    const oldKey = recordId(old.date,old.subjectId,old.chapterId), newKey=recordId(date,subjectId,chapterId);
    if (oldKey===newKey) await adjustPlannedTime(date,subjectId,chapterId,durationSeconds-(old.durationSeconds||0));
    else { await adjustPlannedTime(old.date,old.subjectId,old.chapterId,-(old.durationSeconds||0)); await adjustPlannedTime(date,subjectId,chapterId,durationSeconds); }
  } else await adjustPlannedTime(date,subjectId,chapterId,durationSeconds);
  closeModal(); await loadData(); render(); showToast(old?'Routine updated.':'Routine saved. Planned time added to your daily record.','success');
}
function toMinutes(time) { const [h,m]=time.split(':').map(Number); return h*60+m; }

async function handleSubjectSubmit(form) {
  const fd=new FormData(form), id=form.dataset.id||uid();
  const old=subjectById(id);
  await dbPut('subjects',{id,name:String(fd.get('name')).trim(),icon:String(fd.get('icon')||'').trim(),color:fd.get('color')||'#9385ff',createdAt:old?.createdAt||Date.now(),updatedAt:Date.now()});
  closeModal(); await loadData(); render(); showToast('Subject saved.','success');
}
async function handleChapterSubmit(form) {
  const fd=new FormData(form), id=form.dataset.id||uid(), old=chapterById(id);
  if (old && old.subjectId!==fd.get('subjectId') && (appData.records.some(r=>r.chapterId===id)||appData.routines.some(r=>r.chapterId===id))) { showToast('এই Chapter-এর Study History বা Routine আছে, তাই Subject পরিবর্তন করা যাচ্ছে না।','error'); return; }
  await dbPut('chapters',{id,subjectId:fd.get('subjectId'),name:String(fd.get('name')).trim(),description:fd.get('description')||'',completed:old?.completed||false,createdAt:old?.createdAt||Date.now(),updatedAt:Date.now()});
  closeModal(); await loadData(); render(); showToast('Chapter saved.','success');
}
async function handleTimerSetupSubmit(form) {
  const fd=new FormData(form), minutes=Number(fd.get('minutes'));
  if (!fd.get('date')||!fd.get('subjectId')||!fd.get('chapterId')||minutes<1||minutes>1440) { showToast('Please check the timer details.','error'); return; }
  await beginTimer({date:fd.get('date'),subjectId:fd.get('subjectId'),chapterId:fd.get('chapterId'),minutes,source:'timer'});
}
async function handleManualTimeSubmit(form) {
  const record=appData.records.find(r=>r.id===form.dataset.record);
  if (!record) return;
  const fd=new FormData(form), minutes=Number(fd.get('minutes'));
  if (!Number.isFinite(minutes)||minutes<1||minutes>1440) { showToast('Enter a duration between 1 and 1440 minutes.','error'); return; }
  await addStudySession({date:record.date,subjectId:record.subjectId,chapterId:record.chapterId,seconds:minutes*60,source:'manual',note:fd.get('note')||''});
  closeModal(); await loadData(); render(); showToast(`${minutes} minutes added to the existing total.`,'success');
}
async function handleNoteSubmit(form) {
  const fd=new FormData(form), id=form.dataset.id||uid(), old=appData.notes.find(n=>n.id===id);
  if (pendingFiles.some(f=>f.size>25*1024*1024)) { showToast('A file is larger than 25 MB. Please choose a smaller file.','error'); return; }
  const attachments=[...(old?.attachments||[]),...pendingFiles.map(file=>({name:file.name,type:file.type||'application/octet-stream',size:file.size,blob:file}))];
  const note={id,title:String(fd.get('title')).trim(),body:fd.get('body')||'',subjectId:fd.get('subjectId')||'',chapterId:fd.get('chapterId')||'',date:old?.date||localDate(),attachments,createdAt:old?.createdAt||Date.now(),updatedAt:Date.now()};
  await dbPut('notes',note); closeModal(); await loadData(); render(); showToast('Note and attachments saved locally.','success');
}

async function toggleRecord(id) {
  const record=await dbGet('records',id); if(!record)return;
  record.completed=!record.completed; record.updatedAt=Date.now(); await dbPut('records',record); await loadData(); render();
}
async function toggleChapter(id) {
  const chapter=chapterById(id); if(!chapter)return;
  chapter.completed=!chapter.completed; chapter.updatedAt=Date.now(); await dbPut('chapters',chapter); await loadData(); render();
}
async function toggleRoutine(id) {
  const routine=appData.routines.find(r=>r.id===id); if(!routine)return;
  routine.completed=!routine.completed; routine.updatedAt=Date.now(); await dbPut('routines',routine); await loadData(); render();
}
async function deleteRoutine(id) {
  const routine=appData.routines.find(r=>r.id===id); if(!routine)return;
  if(!confirm('Delete this routine? Its planned duration will be subtracted from the daily record. Actual study time will remain.')) return;
  await dbDelete('routines',id); await adjustPlannedTime(routine.date,routine.subjectId,routine.chapterId,-routine.durationSeconds); await loadData(); render(); showToast('Routine deleted. Actual study time was preserved.');
}
async function deleteSubject(id) {
  if (appData.records.some(r=>r.subjectId===id) || appData.routines.some(r=>r.subjectId===id) || appData.notes.some(n=>n.subjectId===id)) { showToast('এই Subject-এর Study History / Routine / Note আছে। ডেটা অক্ষুণ্ণ রাখতে এটি মুছে ফেলা যাচ্ছে না।','error'); return; }
  if(!confirm('Delete this subject and all its chapters?'))return;
  const chapters=appData.chapters.filter(c=>c.subjectId===id);
  for(const c of chapters) await dbDelete('chapters',c.id);
  await dbDelete('subjects',id); await loadData(); render(); showToast('Subject deleted.');
}
async function deleteChapter(id) {
  if (appData.records.some(r=>r.chapterId===id) || appData.routines.some(r=>r.chapterId===id) || appData.notes.some(n=>n.chapterId===id)) { showToast('এই Chapter-এর saved data আছে। আগে সংশ্লিষ্ট routine/note সরান; history অক্ষুণ্ণ রাখা হয়েছে।','error'); return; }
  if(!confirm('Delete this chapter?'))return;
  await dbDelete('chapters',id); await loadData(); render(); showToast('Chapter deleted.');
}
async function deleteNote(id) { if(!confirm('Delete this note and its attached files?'))return; await dbDelete('notes',id); await loadData(); render(); showToast('Note deleted.'); }

async function openAttachment(noteId,index) {
  const note=await dbGet('notes',noteId), file=note?.attachments?.[index];
  if(!file?.blob){showToast('Attachment data is missing.','error');return;}
  const url=URL.createObjectURL(file.blob);
  const a=document.createElement('a'); a.href=url; a.target='_blank';
  if(!(file.type||'').startsWith('image/') && file.type!=='application/pdf' && !(file.type||'').startsWith('audio/')) a.download=file.name || 'attachment';
  document.body.append(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),120000);
}

function exportCSV() {
  const records=[...appData.records].sort((a,b)=>a.date.localeCompare(b.date));
  const rows=[['Date','Subject','Chapter','Planned minutes','Actual minutes','Status','Session count']];
  for(const r of records) rows.push([r.date,subjectById(r.subjectId)?.name||'Deleted subject',chapterById(r.chapterId)?.name||'Deleted chapter',Math.round((r.plannedSeconds||0)/60),Math.round((r.actualSeconds||0)/60),r.completed?'Completed':'Not completed',appData.sessions.filter(s=>s.recordId===r.id).length]);
  const csv=rows.map(row=>row.map(value=>`"${String(value??'').replace(/"/g,'""')}"`).join(',')).join('\r\n');
  downloadBlob(new Blob(['\ufeff',csv],{type:'text/csv;charset=utf-8'}),`studyos-history-${localDate()}.csv`);
}
function downloadBlob(blob, filename) {
  const url=URL.createObjectURL(blob), a=document.createElement('a'); a.href=url; a.download=filename; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function blobToDataURL(blob) {
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
}
function dataURLToBlob(dataURL) {
  const [meta,data]=dataURL.split(','); const mime=meta.match(/:(.*?);/)?.[1]||'application/octet-stream';
  const binary=atob(data); const bytes=new Uint8Array(binary.length); for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i); return new Blob([bytes],{type:mime});
}
async function exportBackup() {
  showToast('Preparing backup…');
  const payload={format:'studyos-backup-v1',createdAt:new Date().toISOString(),data:{}};
  for(const store of STORE_NAMES) {
    payload.data[store]=await dbAll(store);
    if(store==='notes') for(const note of payload.data.notes) {
      note.attachments=await Promise.all((note.attachments||[]).map(async file=>({name:file.name,type:file.type,size:file.size,dataURL:await blobToDataURL(file.blob)})));
    }
  }
  downloadBlob(new Blob([JSON.stringify(payload)],{type:'application/json'}),`studyos-backup-${localDate()}.json`);
  showToast('Full backup downloaded. Keep it somewhere safe.','success');
}
async function importBackup(file) {
  try {
    const payload=JSON.parse(await file.text());
    if(payload.format!=='studyos-backup-v1'||!payload.data)throw new Error('This file is not a valid StudyOS backup.');
    if(!confirm('Restore this backup? All current StudyOS data in this browser will be replaced.'))return;
    for(const store of STORE_NAMES) await dbClear(store);
    for(const store of STORE_NAMES) {
      const items=payload.data[store]||[];
      for(const item of items) {
        if(store==='notes') item.attachments=await Promise.all((item.attachments||[]).map(async f=>({...f,blob:dataURLToBlob(f.dataURL)})));
        await dbPut(store,item);
      }
    }
    activeTimer=await dbGet('timer','active'); await loadData(); if(activeTimer?.status==='running'){ if(timerRemaining(activeTimer)<=0) await finishTimer(true); else startTimerTick(); } closeModal(); render(); showToast('Backup restored successfully.','success');
  } catch(error) { showToast(`Restore failed: ${error.message}`,'error'); }
}
async function clearAllData() {
  const confirmation=prompt('To permanently delete all StudyOS data, type DELETE');
  if(confirmation!=='DELETE')return;
  for(const store of STORE_NAMES) await dbClear(store);
  activeTimer=null; clearInterval(timerInterval); timerInterval=null; localStorage.removeItem('studyos-theme'); localStorage.removeItem('studyos-notifications'); applyTheme();
  await loadData(); render(); showToast('All StudyOS data cleared.');
}

async function requestPersistence() {
  if(!navigator.storage?.persist){showToast('Persistent storage is not supported by this browser.');return;}
  const granted=await navigator.storage.persist(); showToast(granted?'Persistent storage granted.':'Browser did not grant persistent storage.'); updateStorageStatus();
}
async function updateStorageStatus() {
  const el=$('#storage-status'); if(!el)return;
  if(!navigator.storage?.estimate){el.textContent='Storage estimate is not supported.';return;}
  try { const {usage=0,quota=0}=await navigator.storage.estimate(); const mb=v=>(v/1024/1024).toFixed(1); el.textContent=`Approx. ${mb(usage)} MB used of ${mb(quota)} MB available by browser estimate.`; } catch { el.textContent='Could not read storage estimate.'; }
}
function applyTheme() {
  const theme=localStorage.getItem('studyos-theme')||'dark';
  document.documentElement.dataset.theme=theme;
  const meta=$('meta[name="theme-color"]'); if(meta)meta.content=theme==='dark'?'#111321':'#f3f4fb';
}
function toggleTheme() { localStorage.setItem('studyos-theme',(localStorage.getItem('studyos-theme')||'dark')==='dark'?'light':'dark');applyTheme();render(); }
async function requestNotifications() {
  if(!('Notification' in window)){showToast('Notifications are not supported in this browser.');return;}
  const permission=await Notification.requestPermission(); showToast(permission==='granted'?'Notifications enabled.':'Notification permission was not granted.',permission==='granted'?'success':'');render();
}
function sendNotification(title,body) {
  if(localStorage.getItem('studyos-notifications')==='off'||!('Notification' in window)||Notification.permission!=='granted')return;
  const options={body,icon:'assets/icons/icon-192.png',badge:'assets/icons/icon-192.png',tag:'studyos-'+Date.now()};
  if('serviceWorker' in navigator) navigator.serviceWorker.ready.then(reg=>reg.showNotification(title,options)).catch(()=>new Notification(title,options));
  else new Notification(title,options);
}
async function checkRoutineNotifications() {
  if(localStorage.getItem('studyos-notifications')==='off'||!('Notification' in window)||Notification.permission!=='granted')return;
  const now=Date.now();
  for(const routine of appData.routines) {
    if(routine.completed||routine.notifiedAt||!routine.startTime)continue;
    const scheduled=new Date(`${routine.date}T${routine.startTime}:00`).getTime();
    const diff=scheduled-now;
    if(diff<=0 && diff>=-60000) {
      routine.notifiedAt=now; await dbPut('routines',routine);
      const subject=subjectById(routine.subjectId),chapter=chapterById(routine.chapterId);
      sendNotification('Study session starting',`${subject?.name||'Subject'} · ${chapter?.name||'Chapter'} is scheduled now.`);
    }
  }
  await loadData();
}
async function installPWA() {
  if(installPrompt) { installPrompt.prompt(); const choice=await installPrompt.userChoice; installPrompt=null; if(choice.outcome==='accepted')showToast('StudyOS installation started.','success'); else showToast('Installation was dismissed.'); }
  else showToast('Open your browser menu and choose “Install app” or “Add to Home screen”.');
}

async function discardTimer() {
  if(!activeTimer)return;
  if(!confirm('Discard this focus session without adding any time?'))return;
  activeTimer=null; clearInterval(timerInterval); timerInterval=null;
  await dbDelete('timer','active'); closeModal(); render(); showToast('Focus session discarded. No time was added.');
}

/* Event delegation keeps generated screens lightweight and avoids inline handlers. */
document.addEventListener('click', async (event) => {
  const viewButton=event.target.closest('[data-view]');
  if(viewButton){setView(viewButton.dataset.view);return;}
  const button=event.target.closest('[data-action]');
  if(!button)return;
  const action=button.dataset.action, id=button.dataset.id;
  try {
    switch(action) {
      case 'toggle-sidebar': $('#sidebar').classList.toggle('open'); break;
      case 'open-routine': await openRoutineModal(); break;
      case 'edit-routine': await openRoutineModal(id); break;
      case 'delete-routine': await deleteRoutine(id); break;
      case 'start-routine': {
        const routine=appData.routines.find(r=>r.id===id); if(!routine)return;
        if(activeTimer){openTimerModal();break;}
        await beginTimer({date:routine.date,subjectId:routine.subjectId,chapterId:routine.chapterId,minutes:routine.durationSeconds/60,source:'routine'}); break;
      }
      case 'toggle-routine': await toggleRoutine(id); break;
      case 'open-timer': await openTimerSetup(); break;
      case 'show-timer': renderTimerModal(); break;
      case 'pause-timer': await pauseTimer(); break;
      case 'resume-timer': await resumeTimer(); break;
      case 'stop-save-timer': await finishTimer(false); break;
      case 'discard-timer': await discardTimer(); break;
      case 'add-subject': openSubjectModal(); break;
      case 'edit-subject': openSubjectModal(id); break;
      case 'delete-subject': await deleteSubject(id); break;
      case 'add-chapter': openChapterModal(id); break;
      case 'edit-chapter': openChapterModal(chapterById(id)?.subjectId,id); break;
      case 'delete-chapter': await deleteChapter(id); break;
      case 'toggle-chapter': await toggleChapter(id); break;
      case 'toggle-record': await toggleRecord(id); break;
      case 'add-time': openAddTimeModal(id); break;
      case 'focus-record': {
        const record=appData.records.find(r=>r.id===id); if(record) await openTimerSetup(record,{minutes:25}); break;
      }
      case 'add-note': await openNoteModal(); break;
      case 'edit-note': await openNoteModal(id); break;
      case 'delete-note': await deleteNote(id); break;
      case 'open-attachment': await openAttachment(id,Number(button.dataset.index)); break;
      case 'start-audio': await startAudioRecording(); break;
      case 'stop-audio': stopAudioRecording(); break;
      case 'close-modal': closeModal(); break;
      case 'backdrop-close': if(event.target===button)closeModal(); break;
      case 'toggle-theme': toggleTheme(); break;
      case 'toggle-notifications': {
        const next=localStorage.getItem('studyos-notifications')==='off'?'on':'off';
        localStorage.setItem('studyos-notifications',next); render(); showToast(next==='on'?'Study reminders enabled.':'Study reminders disabled.'); break;
      }
      case 'request-notifications': await requestNotifications(); break;
      case 'backup-export': await exportBackup(); break;
      case 'backup-import': $('#backup-file')?.click(); break;
      case 'export-csv': exportCSV(); break;
      case 'clear-data': await clearAllData(); break;
      case 'request-persistence': await requestPersistence(); break;
      case 'install-pwa': await installPWA(); break;
    }
  } catch(error) { console.error(error); showToast(`Something went wrong: ${error.message}`,'error'); }
});

document.addEventListener('submit', async (event) => {
  const form=event.target;
  if(!form.matches('form'))return;
  event.preventDefault();
  try {
    if(form.id==='routine-form') await handleRoutineSubmit(form);
    else if(form.id==='subject-form') await handleSubjectSubmit(form);
    else if(form.id==='chapter-form') await handleChapterSubmit(form);
    else if(form.id==='timer-setup-form') await handleTimerSetupSubmit(form);
    else if(form.id==='add-time-form') await handleManualTimeSubmit(form);
    else if(form.id==='note-form') await handleNoteSubmit(form);
  } catch(error) { console.error(error); showToast(`Could not save: ${error.message}`,'error'); }
});

document.addEventListener('change', async (event) => {
  const target=event.target;
  if(target.id==='planner-date') renderPlanner();
  if(target.id==='routine-subject') { const chapter=$('#routine-chapter'); if(chapter)chapter.innerHTML=chapterSelectOptions(target.value); }
  if(target.id==='timer-subject') { const chapter=$('#timer-chapter'); if(chapter)chapter.innerHTML=chapterSelectOptions(target.value); }
  if(target.id==='note-subject') { const chapter=$('#note-chapter'); if(chapter)chapter.innerHTML=chapterSelectOptions(target.value); }
  if(target.id==='note-files') {
    const files=[...(target.files||[])];
    const tooLarge=files.filter(file=>file.size>25*1024*1024);
    if(tooLarge.length)showToast('Files larger than 25 MB are skipped.','error');
    pendingFiles.push(...files.filter(file=>file.size<=25*1024*1024)); refreshPendingFileList();
  }
  if(target.id==='backup-file' && target.files?.[0]) { await importBackup(target.files[0]); target.value=''; }
  if(['history-status','history-from','history-to','history-search'].includes(target.id)) {
    if(target.id==='history-status')currentHistoryFilter.status=target.value;
    if(target.id==='history-from')currentHistoryFilter.from=target.value;
    if(target.id==='history-to')currentHistoryFilter.to=target.value;
    if(target.id==='history-search')currentHistoryFilter.query=target.value;
    renderHistory();
  }
});

document.addEventListener('input', (event) => {
  if(['routine-start','routine-end','routine-duration'].includes(event.target.id))updateRoutineHint();
});

window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt=event; });
window.addEventListener('appinstalled', () => { installPrompt=null; showToast('StudyOS installed successfully.','success'); });
window.addEventListener('online', () => showToast('You are back online.'));
window.addEventListener('offline', () => showToast('You are offline. Your saved local data is still available.'));

document.addEventListener('visibilitychange', async () => {
  if(document.visibilityState==='visible' && activeTimer?.status==='running' && timerRemaining()<=0) await finishTimer(true);
});

async function initialize() {
  applyTheme();
  try {
    if(!('indexedDB' in window)) throw new Error('IndexedDB is not available in this browser.');
    db=await openDatabase();
    await loadData();
    activeTimer=await dbGet('timer','active');
    if(activeTimer?.status==='running') {
      if(timerRemaining(activeTimer)<=0) await finishTimer(true);
      else startTimerTick();
    }
    render();
    if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost'||location.hostname==='127.0.0.1')) {
      navigator.serviceWorker.register('./sw.js').catch(error=>console.warn('Service worker registration failed:',error));
    }
    setInterval(checkRoutineNotifications,20000);
    checkRoutineNotifications();
    if(navigator.storage?.persist) navigator.storage.persist().catch(()=>{});
  } catch(error) {
    console.error(error);
    appContent.innerHTML=`<div class="empty-state"><div class="empty-icon">!</div><strong>StudyOS could not open its local database</strong><p>${escapeHTML(error.message)}. Open this app from a secure HTTPS address, not directly as a file:// URL.</p></div>`;
  }
}

initialize();
