'use strict';
(() => {
/* =====================================================================
   רועי להב · מחברת דיונים
   Handwriting notes for iPad + Apple Pencil. Static PWA, no build step.
   Storage: IndexedDB (notes meta + stroke data kept in separate stores).
   Coordinates: a note is PAGE_W units wide, infinitely tall; the canvas
   is only viewport-sized and scrolls virtually (keeps iPad memory low).
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);
const PAGE_W = 1000;
const PAPER = '#FFFDF9';
const GRID = 44;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const FOLDER_COLORS = ['#F97316', '#EA580C', '#F59E0B', '#EF4444', '#EC4899', '#A855F7', '#0EA5E9', '#22C55E'];
const INK = ['#1C1917', '#EA580C', '#DC2626', '#2563EB', '#16A34A', '#7C3AED', '#DB2777', '#FACC15'];
const SIZES = { pen: [1.6, 2.8, 5], tip: [10, 18, 30], hi: [14, 22, 34], eraser: [14, 26, 46] };
const TIP_ANGLE = -Math.PI * 0.22; // flat wide nib, tilted like a chisel marker
const DOT = [6, 10, 16];
const PAPERS = [['blank', 'דף חלק'], ['lines', 'שורות'], ['grid', 'משבצות']];

/* ------------------------------ IndexedDB ------------------------------ */
const DB = (() => {
  let db;
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });
  return {
    open: () => new Promise((res, rej) => {
      const r = indexedDB.open('roee-notes', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('folders', { keyPath: 'id' });
        d.createObjectStore('notes', { keyPath: 'id' });
        d.createObjectStore('data', { keyPath: 'id' });
      };
      r.onsuccess = () => { db = r.result; res(); };
      r.onerror = () => rej(r.error);
    }),
    all: (s) => req(db.transaction(s).objectStore(s).getAll()),
    get: (s, id) => req(db.transaction(s).objectStore(s).get(id)),
    putFolder(f) { const t = db.transaction('folders', 'readwrite'); t.objectStore('folders').put(f); return done(t); },
    delFolder(id) { const t = db.transaction('folders', 'readwrite'); t.objectStore('folders').delete(id); return done(t); },
    putNote(n, strokes) {
      const t = db.transaction(['notes', 'data'], 'readwrite');
      t.objectStore('notes').put(n);
      if (strokes) t.objectStore('data').put({ id: n.id, strokes });
      return done(t);
    },
    delNote(id) {
      const t = db.transaction(['notes', 'data'], 'readwrite');
      t.objectStore('notes').delete(id); t.objectStore('data').delete(id);
      return done(t);
    },
  };
})();

/* -------------------------------- state -------------------------------- */
const prefs = Object.assign({ tool: 'pen', col: {}, sz: {}, penOnly: true, hinted: false }, ls.get('prefs', {}));
prefs.col = Object.assign({ pen: INK[0], tip: INK[0], hi: INK[7] }, prefs.col);
prefs.sz = Object.assign({ pen: 1, tip: 1, hi: 1, eraser: 1 }, prefs.sz);
const S = {
  folders: [], notes: [],
  folderId: ls.get('folder', 'all'), query: '',
  noteId: null, strokes: [], paper: 'lines', scrollY: 0, bottom: 0,
  undo: [], redo: [], dirty: false,
};
const curNote = () => S.notes.find((n) => n.id === S.noteId);
const savePrefs = () => ls.set('prefs', prefs);

/* ------------------------------- canvases ------------------------------ */
const wrap = $('#canvasWrap'), cv = $('#ink'), lv = $('#live');
const ctx = cv.getContext('2d'), lctx = lv.getContext('2d');
let W = 1, H = 1, DPR = 1, scale = 1, rect = wrap.getBoundingClientRect();

function resize() {
  rect = wrap.getBoundingClientRect();
  W = Math.max(1, rect.width); H = Math.max(1, rect.height);
  DPR = Math.min(window.devicePixelRatio || 1, 3);
  for (const c of [cv, lv]) {
    c.width = Math.round(W * DPR); c.height = Math.round(H * DPR);
    c.style.width = W + 'px'; c.style.height = H + 'px';
  }
  scale = W / PAGE_W;
  clampScroll();
  redraw();
}
new ResizeObserver(resize).observe(wrap);

const setView = (c) => { const k = DPR * scale; c.setTransform(k, 0, 0, k, 0, -S.scrollY * k); };

function paintPaper(c, y0, y1, px, paper) {
  c.fillStyle = PAPER; c.fillRect(0, y0, PAGE_W, y1 - y0);
  if (paper === 'blank') return;
  c.strokeStyle = '#F0D9C0'; c.lineWidth = px; c.lineCap = 'butt';
  c.beginPath();
  for (let y = Math.ceil(y0 / GRID) * GRID; y <= y1; y += GRID) { c.moveTo(0, y); c.lineTo(PAGE_W, y); }
  if (paper === 'grid') for (let x = GRID; x < PAGE_W; x += GRID) { c.moveTo(x, y0); c.lineTo(x, y1); }
  c.stroke();
}

const widthAt = (s, pr) => s.w * (s.t === 'h' ? 1 : 0.35 + 1.1 * pr);

function drawStroke(c, s, mul = 1) {
  const p = s.p, n = p.length / 3;
  if (!n) return;
  c.strokeStyle = s.c; c.fillStyle = s.c; c.lineCap = 'round'; c.lineJoin = 'round';
  if (s.t === 't') { // wide flat tip: sweep a fixed-angle line segment along the path
    const dx = Math.cos(TIP_ANGLE) * s.w / 2, dy = Math.sin(TIP_ANGLE) * s.w / 2;
    c.lineWidth = 0.6; c.lineJoin = 'round';
    if (n === 1) { c.lineWidth = Math.max(1, s.w * 0.22); c.beginPath(); c.moveTo(p[0] - dx, p[1] - dy); c.lineTo(p[0] + dx, p[1] + dy); c.stroke(); return; }
    for (let i = 1; i < n; i++) {
      const ax = p[i * 3 - 3], ay = p[i * 3 - 2], bx = p[i * 3], by = p[i * 3 + 1];
      c.beginPath(); c.moveTo(ax - dx, ay - dy); c.lineTo(ax + dx, ay + dy); c.lineTo(bx + dx, by + dy); c.lineTo(bx - dx, by - dy); c.closePath();
      c.fill(); c.stroke();
    }
    return;
  }
  if (n === 1) { c.beginPath(); c.arc(p[0], p[1], widthAt(s, p[2]) * mul / 2, 0, 6.2832); c.fill(); return; }
  if (s.t === 'h') { // highlighter: one translucent path, constant width
    c.globalAlpha = 0.38; c.lineWidth = s.w * mul; c.lineCap = 'butt';
    c.beginPath(); c.moveTo(p[0], p[1]);
    for (let i = 1; i < n - 1; i++) c.quadraticCurveTo(p[i * 3], p[i * 3 + 1], (p[i * 3] + p[i * 3 + 3]) / 2, (p[i * 3 + 1] + p[i * 3 + 4]) / 2);
    c.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
    c.stroke(); c.globalAlpha = 1; return;
  }
  // pen: pressure-sensitive, drawn as smoothed quadratic segments
  let sx = p[0], sy = p[1];
  for (let i = 1; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1];
    const last = i === n - 1;
    const ex = last ? x : (x + p[i * 3 + 3]) / 2, ey = last ? y : (y + p[i * 3 + 4]) / 2;
    c.lineWidth = widthAt(s, p[i * 3 + 2]) * mul;
    c.beginPath(); c.moveTo(sx, sy); c.quadraticCurveTo(x, y, ex, ey); c.stroke();
    sx = ex; sy = ey;
  }
}

function box(s) {
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
  for (let i = 0; i < s.p.length; i += 3) {
    const x = s.p[i], y = s.p[i + 1];
    if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y;
  }
  const pad = s.w * 1.3;
  s.b = [a - pad, b - pad, c + pad, d + pad];
}
const calcBottom = () => { let m = 0; for (const s of S.strokes) if (s.b[3] > m) m = s.b[3]; S.bottom = m; };

let rafMain = 0;
const redraw = () => { if (!rafMain) rafMain = requestAnimationFrame(() => { rafMain = 0; paintMain(); }); };
function paintMain() {
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
  setView(ctx);
  const y0 = S.scrollY, y1 = S.scrollY + H / scale;
  paintPaper(ctx, y0, y1, 1 / scale, S.paper);
  for (const s of S.strokes) if (s.b[3] >= y0 && s.b[1] <= y1) drawStroke(ctx, s);
  updateSbar();
}

/* scrolling */
const maxScroll = () => Math.max(0, S.bottom - (H / scale) * 0.5);
function clampScroll() { S.scrollY = Math.min(Math.max(0, S.scrollY), maxScroll()); }
function scrollBy(du) { const before = S.scrollY; S.scrollY += du; clampScroll(); if (S.scrollY !== before) { redraw(); liveSoon(); } return S.scrollY !== before; }
let sbarT;
function updateSbar() {
  const bar = $('#sbar'), vh = H / scale, total = Math.max(S.bottom + vh * 0.5, vh);
  if (total <= vh + 1) { bar.classList.remove('show'); return; }
  bar.style.height = Math.max(30, (vh / total) * H) + 'px';
  bar.style.top = (S.scrollY / total) * H + 'px';
  bar.classList.add('show'); clearTimeout(sbarT); sbarT = setTimeout(() => bar.classList.remove('show'), 900);
}

/* -------------------------------- drawing ------------------------------- */
let mode = null, pid = null, cur = null, erased = [], hover = null, pan = null, inertia = 0, rafLive = 0;
const pt = (e) => [(e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale + S.scrollY];

function liveSoon() { if (!rafLive) rafLive = requestAnimationFrame(paintLive); }
function paintLive() {
  rafLive = 0;
  lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, lv.width, lv.height);
  setView(lctx);
  if (cur) drawStroke(lctx, cur);
  const showEraser = hover && (mode === 'erase' || (!mode && prefs.tool === 'eraser'));
  if (showEraser) {
    lctx.beginPath(); lctx.arc(hover.x, hover.y, SIZES.eraser[prefs.sz.eraser], 0, 6.2832);
    lctx.fillStyle = 'rgba(249,115,22,.14)'; lctx.fill();
    lctx.lineWidth = 1.6 / scale; lctx.strokeStyle = '#C2410C'; lctx.stroke();
  }
}

function addPoints(e) {
  const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ev of list.length ? list : [e]) {
    const [x, y] = pt(ev);
    let pr = ev.pointerType === 'pen' ? (ev.pressure || 0.5) : 0.5;
    const p = cur.p, n = p.length;
    if (n) {
      const dx = x - p[n - 3], dy = y - p[n - 2];
      if (dx * dx + dy * dy < 0.25) continue;
      pr = p[n - 1] * 0.55 + pr * 0.45;
    }
    p.push(x, y, pr);
  }
  liveSoon();
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}
function hits(s, x, y, R) {
  const r = R + s.w * 0.4, r2 = r * r, p = s.p, n = p.length / 3;
  if (n === 1) { const dx = p[0] - x, dy = p[1] - y; return dx * dx + dy * dy <= r2; }
  for (let i = 1; i < n; i++) if (segDist2(x, y, p[i * 3 - 3], p[i * 3 - 2], p[i * 3], p[i * 3 + 1]) <= r2) return true;
  return false;
}
function eraseAt(e) {
  const R = SIZES.eraser[prefs.sz.eraser];
  const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  let removed = false;
  for (const ev of list.length ? list : [e]) {
    const [x, y] = pt(ev); hover = { x, y };
    for (let i = S.strokes.length - 1; i >= 0; i--) {
      const s = S.strokes[i], b = s.b;
      if (x < b[0] - R || x > b[2] + R || y < b[1] - R || y > b[3] + R) continue;
      if (hits(s, x, y, R)) { erased.push({ s, i }); S.strokes.splice(i, 1); removed = true; }
    }
  }
  if (removed) redraw();
  liveSoon();
}

function stopInertia() { cancelAnimationFrame(inertia); inertia = 0; }
function startInertia(v) {
  stopInertia();
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(40, now - last); last = now;
    if (Math.abs(v) < 0.015) { inertia = 0; return; }
    if (!scrollBy(v * dt)) { inertia = 0; return; }
    v *= Math.pow(0.94, dt / 16);
    inertia = requestAnimationFrame(step);
  };
  inertia = requestAnimationFrame(step);
}

function finishStroke() {
  if (!cur) return;
  const s = cur; cur = null;
  if (s.p.length >= 3) {
    for (let i = 0; i < s.p.length; i += 3) { s.p[i] = Math.round(s.p[i] * 10) / 10; s.p[i + 1] = Math.round(s.p[i + 1] * 10) / 10; s.p[i + 2] = Math.round(s.p[i + 2] * 100) / 100; }
    box(s); S.strokes.push(s);
    if (s.b[3] > S.bottom) S.bottom = s.b[3];
    S.undo.push({ t: 'add', s }); S.redo.length = 0;
    setView(ctx); drawStroke(ctx, s);
    changed();
  }
}

const capture = (id) => { try { wrap.setPointerCapture(id); } catch { /* pointer already gone */ } };
wrap.addEventListener('pointerdown', (e) => {
  if (!S.noteId) return;
  if (mode === 'pan' && e.pointerType !== 'touch') { endPointer(true); }   // pen beats a resting palm
  if (mode) return;
  rect = wrap.getBoundingClientRect();
  if (e.pointerType === 'touch' && prefs.penOnly) {
    mode = 'pan'; pid = e.pointerId; stopInertia();
    pan = { y: e.clientY, t: e.timeStamp, v: 0 };
    capture(pid); return;
  }
  e.preventDefault();
  pid = e.pointerId; capture(pid);
  const barrel = e.pointerType === 'pen' && (e.buttons & 32);
  const tool = barrel ? 'eraser' : prefs.tool;
  if (tool === 'eraser') { mode = 'erase'; erased = []; eraseAt(e); }
  else { mode = 'draw'; cur = { t: tool === 'hi' ? 'h' : tool === 'tip' ? 't' : 'p', c: prefs.col[tool], w: SIZES[tool][prefs.sz[tool]], p: [] }; addPoints(e); }
});
wrap.addEventListener('pointermove', (e) => {
  if (!mode) {
    if (prefs.tool === 'eraser' && e.pointerType !== 'touch') { rect = wrap.getBoundingClientRect(); const [x, y] = pt(e); hover = { x, y }; liveSoon(); }
    return;
  }
  if (e.pointerId !== pid) return;
  e.preventDefault();
  if (mode === 'pan') {
    const dy = e.clientY - pan.y, dt = e.timeStamp - pan.t;
    scrollBy(-dy / scale);
    if (dt > 0) pan.v = pan.v * 0.6 + ((-dy / scale) / dt) * 0.4;
    pan.y = e.clientY; pan.t = e.timeStamp;
  } else if (mode === 'erase') eraseAt(e);
  else addPoints(e);
});
function endPointer(cancel) {
  if (mode === 'draw') { if (cancel) cur = null; else finishStroke(); }
  else if (mode === 'erase' && erased.length) { S.undo.push({ t: 'erase', items: erased }); S.redo.length = 0; calcBottom(); clampScroll(); changed(); }
  else if (mode === 'pan' && !cancel && pan && Math.abs(pan.v) > 0.05) startInertia(pan.v);
  mode = null; pid = null; pan = null; erased = []; hover = mode === null && prefs.tool === 'eraser' ? hover : null;
  liveSoon(); syncUndo();
}
wrap.addEventListener('pointerup', (e) => { if (e.pointerId === pid) endPointer(false); });
wrap.addEventListener('pointercancel', (e) => { if (e.pointerId === pid) endPointer(true); });
wrap.addEventListener('pointerleave', (e) => { if (!mode && e.pointerType !== 'touch') { hover = null; liveSoon(); } });
wrap.addEventListener('wheel', (e) => { e.preventDefault(); stopInertia(); scrollBy(e.deltaY / scale); }, { passive: false });
wrap.addEventListener('contextmenu', (e) => e.preventDefault());
wrap.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

/* undo / redo */
function undo() {
  const op = S.undo.pop(); if (!op) return;
  if (op.t === 'add') { const i = S.strokes.indexOf(op.s); if (i >= 0) S.strokes.splice(i, 1); }
  else for (let k = op.items.length - 1; k >= 0; k--) S.strokes.splice(op.items[k].i, 0, op.items[k].s);
  S.redo.push(op); afterHistory();
}
function redo() {
  const op = S.redo.pop(); if (!op) return;
  if (op.t === 'add') S.strokes.push(op.s);
  else for (const it of op.items) { const i = S.strokes.indexOf(it.s); if (i >= 0) S.strokes.splice(i, 1); }
  S.undo.push(op); afterHistory();
}
function afterHistory() { calcBottom(); clampScroll(); redraw(); changed(); syncUndo(); }
function syncUndo() { $('#undoBtn').disabled = !S.undo.length; $('#redoBtn').disabled = !S.redo.length; }
$('#undoBtn').onclick = undo; $('#redoBtn').onclick = redo;
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
});

/* ------------------------------ autosave ------------------------------- */
let saveTimer = 0, chain = Promise.resolve();
function setStatus(state) {
  const el = $('#status');
  el.className = 'status ' + state;
  $('span', el).textContent = state === 'saving' ? 'שומר…' : state === 'error' ? 'שגיאת שמירה' : 'נשמר אוטומטית';
}
function changed() {
  S.dirty = true; setStatus('saving');
  clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400);
}
function makeThumb() {
  const tw = 320, th = 200, c = document.createElement('canvas'); c.width = tw; c.height = th;
  const x = c.getContext('2d'), k = tw / PAGE_W;
  x.setTransform(k, 0, 0, k, 0, 0);
  paintPaper(x, 0, th / k, 1 / k, S.paper === 'blank' ? 'blank' : S.paper);
  for (const s of S.strokes) if (s.b[1] < th / k) drawStroke(x, s, 1.7);
  return c.toDataURL('image/jpeg', 0.72);
}
function saveNow() {
  clearTimeout(saveTimer);
  const n = curNote();
  if (!n || !S.dirty) return chain;
  S.dirty = false;
  n.updated = Date.now(); n.paper = S.paper; n.count = S.strokes.length; n.scroll = Math.round(S.scrollY);
  n.thumb = makeThumb();
  const meta = { ...n }, strokes = S.strokes.slice();
  chain = chain.then(() => DB.putNote(meta, strokes)).then(() => { if (!S.dirty) setStatus('saved'); }).catch((err) => { console.error(err); setStatus('error'); });
  renderNotes(); renderFolders();
  return chain;
}
addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

/* ------------------------------ notes logic ------------------------------ */
const stamp = (ts) => {
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return 'היום ' + hm;
  if (d.toDateString() === new Date(now - 864e5).toDateString()) return 'אתמול ' + hm;
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + hm;
};
const defaultTitle = (ts = Date.now()) => 'הערה · ' + new Date(ts).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' }) + ' ' + new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
const folderOf = (id) => S.folders.find((f) => f.id === id);
const realFolder = () => (folderOf(S.folderId) ? S.folderId : (S.folders[0] && S.folders[0].id) || null);

function visibleNotes() {
  const q = S.query.trim().toLowerCase();
  return S.notes
    .filter((n) => (S.folderId === 'all' ? true : S.folderId === 'none' ? !folderOf(n.folderId) : n.folderId === S.folderId))
    .filter((n) => !q || n.title.toLowerCase().includes(q))
    .sort((a, b) => b.updated - a.updated);
}

async function leaveNote() {
  const n = curNote(); if (!n) return;
  await saveNow();
  if (n.auto && !S.strokes.length) { // never keep empty untouched notes
    S.notes = S.notes.filter((x) => x.id !== n.id);
    await DB.delNote(n.id);
  }
}

let openToken = 0;
async function openNote(id) {
  const token = ++openToken;
  await leaveNote();
  const n = S.notes.find((x) => x.id === id); if (!n) return;
  const d = await DB.get('data', id);
  if (token !== openToken) return;
  S.noteId = id; S.strokes = (d && d.strokes) || [];
  for (const s of S.strokes) if (!s.b) box(s);
  calcBottom();
  S.paper = n.paper || 'lines'; S.scrollY = n.scroll || 0; S.undo = []; S.redo = []; S.dirty = false;
  $('#title').value = n.title; 
  clampScroll(); redraw(); syncUndo(); renderAll(); setStatus('saved');
  ls.set('lastNote', id);
  if (matchMedia('(max-width:1099px)').matches) setNav(false);
}

async function newNote() {
  await leaveNote();
  const now = Date.now();
  const n = { id: uid(), folderId: realFolder(), title: defaultTitle(now), auto: true, created: now, updated: now, paper: S.paper || 'lines', count: 0, thumb: '', scroll: 0 };
  S.notes.push(n);
  await DB.putNote(n, []);
  S.noteId = null;
  await openNote(n.id);
  if (matchMedia('(max-width:1099px)').matches) setNav(false);
}

async function deleteNote(id) {
  const n = S.notes.find((x) => x.id === id); if (!n) return;
  const isCur = id === S.noteId;
  const data = isCur ? S.strokes.slice() : ((await DB.get('data', id)) || {}).strokes || [];
  clearTimeout(saveTimer); if (isCur) S.dirty = false;
  S.notes = S.notes.filter((x) => x.id !== id);
  await chain; await DB.delNote(id);
  if (isCur) { S.noteId = null; const next = visibleNotes()[0]; if (next) await openNote(next.id); else await newNote(); }
  renderAll();
  toast('ההערה נמחקה', 'בטל', async () => {
    S.notes.push(n); await DB.putNote(n, data); await openNote(n.id);
  });
}

async function moveNote(id, folderId) {
  const n = S.notes.find((x) => x.id === id); if (!n || n.folderId === folderId) return;
  n.folderId = folderId; n.updated = Date.now();
  await DB.putNote({ ...n });
  renderAll();
  toast('הועבר ל־' + (folderOf(folderId) ? folderOf(folderId).name : 'ללא תיקייה'));
}

/* ------------------------------- folders -------------------------------- */
async function addFolder(thenMove) {
  const name = await askText('תיקייה חדשה', '', 'צור');
  if (!name) return null;
  const f = { id: uid(), name, color: FOLDER_COLORS[S.folders.length % FOLDER_COLORS.length], order: Date.now() };
  S.folders.push(f); await DB.putFolder(f);
  if (thenMove) await moveNote(thenMove, f.id); else selectFolder(f.id);
  renderAll(); return f;
}
function selectFolder(id) { S.folderId = id; ls.set('folder', id); S.query = ''; $('#search').value = ''; renderAll(); }

function folderMenu(id) {
  const f = folderOf(id); if (!f) return;
  sheet(f.name, [
    { label: 'שנה שם', icon: 'folder', fn: async () => { const v = await askText('שם התיקייה', f.name, 'שמור'); if (v) { f.name = v; await DB.putFolder(f); renderAll(); } } },
    { label: 'מחק תיקייה', icon: 'trash', danger: true, fn: async () => {
      const cnt = S.notes.filter((n) => n.folderId === id).length;
      const ok = await confirmBox('למחוק את "' + f.name + '"?', cnt ? 'ההערות שבתיקייה (' + cnt + ') לא יימחקו – הן יעברו ל"ללא תיקייה".' : 'התיקייה ריקה.', 'מחק', true);
      if (!ok) return;
      for (const n of S.notes) if (n.folderId === id) { n.folderId = null; await DB.putNote({ ...n }); }
      S.folders = S.folders.filter((x) => x.id !== id); await DB.delFolder(id);
      selectFolder('all');
    } },
  ]);
}

async function pickFolder(noteId) {
  const n = S.notes.find((x) => x.id === noteId); if (!n) return;
  const items = S.folders.map((f) => ({ label: f.name, dot: f.color, check: f.id === n.folderId, fn: () => moveNote(noteId, f.id) }));
  items.push({ sep: true });
  items.push({ label: 'תיקייה חדשה…', icon: 'folder-plus', fn: () => addFolder(noteId) });
  sheet('העבר לתיקייה', items);
}

/* -------------------------------- render -------------------------------- */
const icon = (n, cls = '') => `<svg class="ic ${cls}"><use href="#i-${n}"/></svg>`;
function renderFolders() {
  const el = $('#folderList'), counts = {}; let none = 0;
  for (const n of S.notes) { if (folderOf(n.folderId)) counts[n.folderId] = (counts[n.folderId] || 0) + 1; else none++; }
  const row = (id, inner, cnt, drop) => `<div class="frow ${S.folderId === id ? 'active' : ''}" data-id="${id}" ${drop ? 'data-drop="1"' : ''}>${inner}<span class="cnt">${cnt}</span>${folderOf(id) ? `<button class="fmore" data-more="${id}" aria-label="אפשרויות">${icon('more')}</button>` : ''}</div>`;
  el.innerHTML = row('all', `${icon('layers', 'lead')}<span class="nm">כל ההערות</span>`, S.notes.length, false)
    + S.folders.slice().sort((a, b) => a.order - b.order).map((f) => row(f.id, `<i class="dot" style="background:${f.color}"></i><span class="nm">${esc(f.name)}</span>`, counts[f.id] || 0, true)).join('')
    + (none ? row('none', `${icon('folder', 'lead')}<span class="nm">ללא תיקייה</span>`, none, false) : '');
}
function renderNotes() {
  const list = visibleNotes();
  $('#folderTitle').textContent = S.folderId === 'all' ? 'כל ההערות' : S.folderId === 'none' ? 'ללא תיקייה' : (folderOf(S.folderId) || {}).name || '';
  $('#folderCount').textContent = list.length + (list.length === 1 ? ' הערה' : ' הערות');
  const el = $('#noteList');
  if (!list.length) { el.innerHTML = `<div class="empty">${S.query ? 'לא נמצאו הערות' : 'אין עדיין הערות כאן.<br>לחץ על <b>הערה חדשה</b> והתחל לכתוב.'}</div>`; return; }
  el.innerHTML = list.map((n) => {
    const f = folderOf(n.folderId);
    return `<div class="ncard ${n.id === S.noteId ? 'active' : ''}" data-id="${n.id}" draggable="true">
      <div class="thumb" style="${n.thumb ? `background-image:url(${n.thumb})` : ''}"></div>
      <div class="ninfo"><div class="ntitle">${esc(n.title)}</div>
        <div class="nmeta"><span>${stamp(n.updated)}</span>${S.folderId === 'all' && f ? `<span class="tag"><i style="background:${f.color}"></i>${esc(f.name)}</span>` : ''}</div></div>
      <button class="nmore" data-more="${n.id}" aria-label="אפשרויות">${icon('more')}</button></div>`;
  }).join('');
}
function renderEditorBar() {
  const n = curNote(), f = n && folderOf(n.folderId);
  $('#folderChipTxt').textContent = f ? f.name : 'ללא תיקייה';
  $('#folderChip').querySelector('svg use').setAttribute('href', '#i-folder');
}
function renderTools() {
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === prefs.tool));
  const t = prefs.tool;
  $('#swatches').innerHTML = INK.map((c) => `<button class="sw ${t !== 'eraser' && prefs.col[t] === c ? 'on' : ''} ${t === 'eraser' ? 'dim' : ''}" data-col="${c}" style="background:${c}" aria-label="צבע"></button>`).join('');
  $('#sizes').innerHTML = DOT.map((d, i) => `<button class="sz ${prefs.sz[t] === i ? 'on' : ''}" data-sz="${i}" aria-label="עובי"><i style="width:${d}px;height:${d}px"></i></button>`).join('');
  $('#penOnlyBtn').classList.toggle('on', prefs.penOnly);
  $('#penOnlyBtn span').textContent = prefs.penOnly ? 'אצבע גוללת' : 'אצבע כותבת';
  $('#paperBtn').title = 'נייר: ' + PAPERS.find((p) => p[0] === S.paper)[1];
}
function renderAll() { renderFolders(); renderNotes(); renderEditorBar(); renderTools(); }

/* --------------------------- toolbar interactions --------------------------- */
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => { prefs.tool = b.dataset.tool; hover = null; savePrefs(); renderTools(); liveSoon(); }));
$('#swatches').addEventListener('click', (e) => {
  const b = e.target.closest('[data-col]'); if (!b) return;
  if (prefs.tool === 'eraser') prefs.tool = 'pen';
  prefs.col[prefs.tool] = b.dataset.col; savePrefs(); renderTools();
});
$('#sizes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sz]'); if (!b) return;
  prefs.sz[prefs.tool] = +b.dataset.sz; savePrefs(); renderTools();
});
$('#penOnlyBtn').onclick = () => { prefs.penOnly = !prefs.penOnly; savePrefs(); renderTools(); toast(prefs.penOnly ? 'עט כותב · אצבע גוללת' : 'גם האצבע כותבת'); };
$('#paperBtn').onclick = () => {
  const i = PAPERS.findIndex((p) => p[0] === S.paper);
  S.paper = PAPERS[(i + 1) % PAPERS.length][0];
  redraw(); changed(); renderTools(); toast('נייר: ' + PAPERS.find((p) => p[0] === S.paper)[1]);
};

/* title */
$('#title').addEventListener('input', (e) => {
  const n = curNote(); if (!n) return;
  n.title = e.target.value; n.auto = false; changed();
});
$('#title').addEventListener('blur', (e) => {
  const n = curNote(); if (n && !e.target.value.trim()) { n.title = defaultTitle(n.created); e.target.value = n.title; changed(); }
});
$('#title').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

/* header / nav */
function setNav(open) { $('#app').classList.toggle('nav-open', open); setTimeout(resize, 290); }
$('#navToggle').onclick = () => setNav(!$('#app').classList.contains('nav-open'));
$('#scrim').onclick = () => setNav(false);
$('#newNote').onclick = newNote;
$('#addFolder').onclick = () => addFolder();
$('#search').addEventListener('input', (e) => { S.query = e.target.value; renderNotes(); });

$('#folderList').addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]'); if (more) { e.stopPropagation(); folderMenu(more.dataset.more); return; }
  const r = e.target.closest('.frow'); if (r) selectFolder(r.dataset.id);
});
$('#noteList').addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]');
  if (more) {
    const id = more.dataset.more;
    sheet('אפשרויות', [
      { label: 'העבר לתיקייה', icon: 'folder', fn: () => pickFolder(id) },
      { label: 'מחק הערה', icon: 'trash', danger: true, fn: () => deleteNote(id) },
    ]); return;
  }
  const c = e.target.closest('.ncard'); if (c) openNote(c.dataset.id);
});
/* drag a note onto a folder (iPadOS: long-press then drag) */
let dragId = null;
$('#noteList').addEventListener('dragstart', (e) => { const c = e.target.closest('.ncard'); if (!c) return; dragId = c.dataset.id; c.classList.add('dragging'); e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; });
$('#noteList').addEventListener('dragend', () => { dragId = null; renderNotes(); });
$('#folderList').addEventListener('dragover', (e) => { const r = e.target.closest('.frow[data-drop]'); if (r && dragId) { e.preventDefault(); document.querySelectorAll('.frow.drop').forEach((x) => x.classList.remove('drop')); r.classList.add('drop'); } });
$('#folderList').addEventListener('dragleave', (e) => { const r = e.target.closest('.frow'); if (r) r.classList.remove('drop'); });
$('#folderList').addEventListener('drop', (e) => { const r = e.target.closest('.frow[data-drop]'); if (r && dragId) { e.preventDefault(); r.classList.remove('drop'); moveNote(dragId, r.dataset.id); } });

$('#folderChip').onclick = () => S.noteId && pickFolder(S.noteId);
$('#moreBtn').onclick = () => {
  if (!S.noteId) return;
  sheet('אפשרויות הערה', [
    { label: 'שתף / ייצא כתמונה', icon: 'share', fn: exportPng },
    { label: 'העבר לתיקייה', icon: 'folder', fn: () => pickFolder(S.noteId) },
    { label: 'נקה את כל ההערה', icon: 'eraser', fn: async () => {
      if (!S.strokes.length) return;
      if (!(await confirmBox('לנקות את כל ההערה?', 'אפשר לבטל מיד אחרי עם כפתור ה"בטל".', 'נקה', true))) return;
      const items = S.strokes.map((s, i) => ({ s, i })).reverse();
      S.strokes = []; S.undo.push({ t: 'erase', items }); S.redo.length = 0; calcBottom(); clampScroll(); redraw(); changed(); syncUndo();
    } },
    { sep: true },
    { label: 'מחק הערה', icon: 'trash', danger: true, fn: () => deleteNote(S.noteId) },
  ]);
};

/* --------------------------------- export --------------------------------- */
async function exportPng() {
  await saveNow();
  const n = curNote(); if (!n) return;
  const hUnits = Math.max(S.bottom + 60, 700);
  const k = Math.min(1.6, Math.sqrt(14e6 / (PAGE_W * hUnits)));
  const c = document.createElement('canvas'); c.width = Math.round(PAGE_W * k); c.height = Math.round(hUnits * k);
  const x = c.getContext('2d'); x.setTransform(k, 0, 0, k, 0, 0);
  paintPaper(x, 0, hUnits, 1 / k, S.paper);
  for (const s of S.strokes) drawStroke(x, s);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], (n.title.replace(/[\\/:*?"<>|]/g, '-') || 'note') + '.png', { type: 'image/png' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: n.title }); return; }
  } catch (err) { if (err && err.name === 'AbortError') return; }
  download(blob, file.name);
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------------------------- backup / restore ---------------------------- */
$('#backupBtn').onclick = () => sheet('גיבוי ושחזור', [
  { label: 'ייצא גיבוי של כל ההערות', icon: 'save', fn: async () => {
    await saveNow();
    const data = await DB.all('data');
    const dump = { app: 'roee-notes', v: 1, at: Date.now(), folders: S.folders, notes: S.notes, data };
    download(new Blob([JSON.stringify(dump)], { type: 'application/json' }), 'roee-notes-backup-' + new Date().toISOString().slice(0, 10) + '.json');
  } },
  { label: 'שחזר מקובץ גיבוי', icon: 'plus', fn: () => $('#importFile').click() },
]);
$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.app !== 'roee-notes') throw new Error('bad file');
    for (const fo of d.folders) { if (!folderOf(fo.id)) { S.folders.push(fo); await DB.putFolder(fo); } }
    const byId = Object.fromEntries(d.data.map((x) => [x.id, x.strokes]));
    let added = 0;
    for (const n of d.notes) { if (!S.notes.find((x) => x.id === n.id)) { S.notes.push(n); await DB.putNote(n, byId[n.id] || []); added++; } }
    renderAll(); toast('שוחזרו ' + added + ' הערות');
  } catch (err) { toast('קובץ הגיבוי לא תקין'); }
});

/* ---------------------------- dialogs & toast ---------------------------- */
const overlay = $('#modal');
function modal(build) {
  return new Promise((resolve) => {
    const boxEl = document.createElement('div'); boxEl.className = 'box';
    const close = (v) => { overlay.classList.remove('show'); overlay.innerHTML = ''; resolve(v); };
    build(boxEl, close);
    overlay.innerHTML = ''; overlay.appendChild(boxEl);
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
    overlay.classList.add('show');
    const inp = boxEl.querySelector('input'); if (inp) { inp.focus(); inp.select(); }
  });
}
function askText(title, value, okLabel) {
  return modal((b, close) => {
    b.innerHTML = `<h3>${esc(title)}</h3><input type="text" maxlength="60" value="${esc(value)}"><div class="btns"><button class="btn main">${esc(okLabel)}</button><button class="btn">ביטול</button></div>`;
    const inp = b.querySelector('input'), [ok, no] = b.querySelectorAll('button');
    const go = () => close(inp.value.trim() || null);
    ok.onclick = go; no.onclick = () => close(null);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}
function confirmBox(title, text, okLabel, danger) {
  return modal((b, close) => {
    b.innerHTML = `<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="btns"><button class="btn ${danger ? 'danger' : 'main'}">${esc(okLabel)}</button><button class="btn">ביטול</button></div>`;
    const [ok, no] = b.querySelectorAll('button');
    ok.onclick = () => close(true); no.onclick = () => close(false);
  }).then((v) => !!v);
}
function sheet(title, items) {
  return modal((b, close) => {
    b.innerHTML = `<h3>${esc(title)}</h3>` + items.map((it, i) => it.sep ? '<div class="sheetsep"></div>'
      : `<button class="sheetitem ${it.danger ? 'danger' : ''}" data-i="${i}">${it.dot ? `<i class="dot" style="background:${it.dot}"></i>` : it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span>${it.check ? icon('check', 'ck') : ''}</button>`).join('');
    b.addEventListener('click', (e) => { const x = e.target.closest('[data-i]'); if (!x) return; close(null); items[+x.dataset.i].fn(); });
  });
}
let toastT;
function toast(msg, action, fn) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button>${esc(action)}</button>` : '');
  if (action) t.querySelector('button').onclick = () => { t.classList.remove('show'); fn(); };
  t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), action ? 7000 : 2200);
}

/* --------------------------------- start --------------------------------- */
async function init() {
  setNav(matchMedia('(min-width:1100px)').matches);
  await DB.open();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  S.folders = await DB.all('folders'); S.notes = await DB.all('notes');
  if (!S.folders.length) {
    const t = Date.now();
    S.folders = ['כללי', 'דיונים ופגישות', 'רעיונות'].map((name, i) => ({ id: uid(), name, color: FOLDER_COLORS[i], order: t + i }));
    for (const f of S.folders) await DB.putFolder(f);
  }
  if (S.folderId !== 'all' && S.folderId !== 'none' && !folderOf(S.folderId)) S.folderId = 'all';
  resize(); renderAll();
  const last = ls.get('lastNote', null);
  const start = S.notes.find((n) => n.id === last) || S.notes.slice().sort((a, b) => b.updated - a.updated)[0];
  if (start) await openNote(start.id); else await newNote();
  if (!prefs.hinted) { prefs.hinted = true; savePrefs(); toast('עט = כתיבה · אצבע = גלילה (אפשר לשנות בכפתור היד)'); }
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init().catch((err) => { console.error(err); toast('שגיאה בטעינת המחברת'); });
})();
