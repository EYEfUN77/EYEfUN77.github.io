/* 바탕화면 달력 — 휴대폰·웹 버전의 '내 구글 계정 직접 연결' (브라우저에서 실행)
   PC 앱(google.js)과 같은 방식으로, 각자 자기 구글 계정으로 로그인해 자기 구글 캘린더·할 일·드라이브에 직접 연결합니다.
   개발자 서버를 거치지 않습니다. 로그인 정보(1시간짜리 접근 토큰)는 이 기기에만 보관합니다.
   google.js 의 일정·할 일·설정 처리 부분을 그대로 가져와 씁니다(자동 생성 — 직접 고치지 말고 mkgweb.py 로 다시 만드세요). */
(function(){
'use strict';
const CLIENT_ID = (window.GWEB_CONFIG && window.GWEB_CONFIG.clientId) || '';
const SCOPES = ['openid', 'email', 'profile',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.appdata'];
const EP = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  revoke: 'https://oauth2.googleapis.com/revoke',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  cal: 'https://www.googleapis.com/calendar/v3',
  tasks: 'https://tasks.googleapis.com/tasks/v1',
  drive: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3'
};
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
const TK = 'dcal.gtok';
/* 브라우저용 작은 Buffer 대용 */
const Buffer = {
  from(x, encd) {
    if (encd === 'base64') { const s = atob(String(x)); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    return new TextEncoder().encode(String(x));
  },
  concat(arr) { return new Blob(arr); }
};
function u8b64(u) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
class AuthError extends Error {}
const MS = { isMs: id => /^ms:/.test(String(id || '')), enabled: () => false, accounts: () => [] };
let EXTRA = [];
const CAL_ACCT = new Map();
function acctForUrl() { return null; }

/* ================= 로그인(구글로 이동 → 돌아오면 토큰 받음) ================= */
let TOK = null;
try { TOK = JSON.parse(localStorage.getItem(TK) || 'null'); } catch (e) { TOK = null; }
function saveTok() { try { if (TOK) localStorage.setItem(TK, JSON.stringify(TOK)); else localStorage.removeItem(TK); } catch (e) {} }
function returnUrl() { return location.origin + location.pathname.replace(/[^/]*$/, ''); }
function goAuth(silent) {
  if (!CLIENT_ID) throw new Error('구글 로그인 설정이 아직 끝나지 않았습니다.');
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { sessionStorage.setItem('dcal.gstate', state); sessionStorage.setItem('dcal.gsilent', silent ? '1' : ''); } catch (e) {}
  const p = { client_id: CLIENT_ID, redirect_uri: returnUrl(), response_type: 'token', scope: SCOPES.join(' '), state, include_granted_scopes: 'true' };
  if (silent) { p.prompt = 'none'; if (TOK && TOK.email) p.login_hint = TOK.email; }
  else p.prompt = 'select_account consent';
  location.href = EP.auth + '?' + Object.keys(p).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(p[k])).join('&');
  return new Promise(() => {}); /* 페이지를 떠남 */
}
async function accessToken() {
  if (TOK && TOK.access_token && Date.now() < TOK.expires_at - 60000) return TOK.access_token;
  if (TOK && TOK.email && !sessionStorage.getItem('dcal.gnoretry')) return goAuth(true); /* 이미 허용한 계정: 화면이 잠깐 넘어갔다 돌아옴 */
  throw new AuthError('로그인이 필요합니다.');
}
async function gfetch(method, url, body, opts) {
  opts = opts || {};
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await accessToken();
    const headers = { Authorization: 'Bearer ' + tok };
    let payload;
    if (opts.body !== undefined) { payload = opts.body; headers['Content-Type'] = opts.type || 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json; charset=utf-8'; }
    const r = await fetch(url, { method, headers, body: payload });
    if (r.status === 401 && attempt === 0) { if (TOK) TOK.expires_at = 0; continue; }
    if (opts.raw) { if (!r.ok) throw httpErr(r.status, await r.text()); return r; }
    const txt = await r.text();
    let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (e) {}
    if (!r.ok) throw httpErr(r.status, txt, j);
    return j;
  }
}
async function signIn() { try { sessionStorage.removeItem('dcal.gnoretry'); } catch (e) {} return goAuth(false); }
async function signOut() {
  const t = TOK; TOK = null; saveTok(); SET = null; SET_ID = null; SET_AT = 0;
  if (t && t.access_token) { try { await fetch(EP.revoke + '?token=' + encodeURIComponent(t.access_token), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); } catch (e) {} }
  return true;
}
/* 구글에서 돌아온 직후(#access_token=…) 처리 — 껍데기 화면이 부름 */
async function finishAuth(hash) {
  const p = {}; String(hash || '').replace(/^#/, '').split('&').forEach(kv => { const i = kv.indexOf('='); if (i > 0) p[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')); });
  let st = ''; try { st = sessionStorage.getItem('dcal.gstate') || ''; } catch (e) {}
  if (!p.state || p.state !== st) return { ok: false, error: 'state' };
  try { sessionStorage.removeItem('dcal.gstate'); } catch (e) {}
  if (p.error) {
    if (TOK) { TOK.access_token = ''; TOK.expires_at = 0; }
    try { sessionStorage.setItem('dcal.gnoretry', '1'); } catch (e) {}
    if (p.error !== 'access_denied' && !/interaction|consent|login/.test(p.error)) return { ok: false, error: p.error };
    return { ok: false, error: p.error === 'access_denied' ? '로그인을 취소했거나 권한을 허용하지 않았습니다.' : '' };
  }
  const scope = String(p.scope || '');
  TOK = Object.assign(TOK || {}, { access_token: p.access_token, expires_at: Date.now() + (+p.expires_in || 3600) * 1000 });
  try { sessionStorage.removeItem('dcal.gnoretry'); } catch (e) {}
  const r = await fetch(EP.userinfo, { headers: { Authorization: 'Bearer ' + TOK.access_token } });
  const me = await r.json().catch(() => ({}));
  if (TOK.email && me.email && TOK.email !== me.email) { SET = null; SET_ID = null; SET_AT = 0; }
  TOK.email = me.email || TOK.email || ''; TOK.name = me.name || TOK.name || ''; saveTok();
  const missing = ['auth/calendar', 'auth/tasks', 'drive.appdata'].filter(s => scope && scope.indexOf(s) < 0);
  return { ok: true, email: TOK.email, missing };
}
/* 구글 API 호출(JSON). opts.raw: 그대로 받기, opts.body: 문자열/Buffer, opts.type: Content-Type */
/* 외부 달력(ICS·webcal) 받아 오기 — 30분 메모리 캐시 */
const ICS_CACHE = new Map();
async function fetchIcs(url) {
  url = String(url || '').trim().replace(/^webcal:\/\//i, 'https://');
  if (!/^https?:\/\/\S+$/i.test(url) || url.length > 2000) throw new Error('달력 주소가 올바르지 않습니다.');
  const hit = ICS_CACHE.get(url); if (hit && Date.now() - hit.at < 30 * 60000) return hit.t;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('달력을 받지 못했습니다(' + r.status + ').');
  const t = await r.text();
  if (t.indexOf('BEGIN:VCALENDAR') < 0) throw new Error('웹 달력(ICS) 형식이 아닙니다.');
  if (t.length > 3000000) throw new Error('달력 파일이 너무 큽니다.');
  ICS_CACHE.set(url, { at: Date.now(), t });
  return t;
}
function httpErr(status, txt, j) {
  const msg = (j && j.error && (j.error.message || j.error)) || ('구글 서버 오류(' + status + ')');
  const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)); e.status = status;
  if (status === 401) return new AuthError('로그인이 필요합니다.');
  return e;
}
const q = o => '?' + Object.keys(o).filter(k => o[k] !== undefined && o[k] !== null && o[k] !== '').map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');
const enc = encodeURIComponent;

/* ================= 앱 설정(드라이브 앱 전용 공간) ================= */
const SETTINGS_FILE = 'dcal-settings.json';          // 예전 저장 위치(앱 전용 숨김 공간) — 옮겨 오기용
/* 같은 구글 계정의 웹·휴대폰 버전(서버)과 같은 설정을 쓰도록, 내 드라이브의 일반 파일 하나에 저장
   (이 앱이 만든 파일이라 drive.file 권한으로 접근. 서버는 같은 계정 드라이브에서 이 파일을 찾아 함께 씀) */
const SYNC_NAME = '바탕화면 달력 설정.json', SYNC_MARK = 'dcal-sync-v1';
let SET = null, SET_ID = null, SET_MOD = '', SET_AT = 0, saving = Promise.resolve();
async function findSync() {
  const l = await gfetch('GET', EP.drive + '/files' + q({ q: "name='" + SYNC_NAME + "' and trashed=false", fields: 'files(id,modifiedTime,description)', orderBy: 'modifiedTime desc', pageSize: 10 }));
  const fs_ = (l.files || []);
  const f = fs_.filter(x => x.description === SYNC_MARK)[0] || fs_[0];
  return f || null;
}
async function download(id) {
  const r = await gfetch('GET', EP.drive + '/files/' + id + '?alt=media', undefined, { raw: true });
  try { const o = JSON.parse(await r.text()); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
}
async function settings(fresh) {
  if (SET && !fresh && Date.now() - SET_AT < 20000) return SET;
  let meta = null;
  if (SET_ID) {
    try { meta = await gfetch('GET', EP.drive + '/files/' + SET_ID + q({ fields: 'id,modifiedTime,trashed' })); if (meta.trashed) meta = null; }
    catch (e) { if (e instanceof AuthError) throw e; meta = null; }
  }
  if (!meta) meta = await findSync();
  if (meta) {
    if (!SET || meta.id !== SET_ID || meta.modifiedTime !== SET_MOD) SET = await download(meta.id);
    SET_ID = meta.id; SET_MOD = meta.modifiedTime;
  } else {
    /* 처음: 예전 앱 전용 공간의 설정을 그대로 옮겨 새 파일로 만듦 */
    let old = {};
    try {
      const l = await gfetch('GET', EP.drive + '/files' + q({ spaces: 'appDataFolder', q: "name='" + SETTINGS_FILE + "' and trashed=false", fields: 'files(id)' }));
      const oid = l.files && l.files[0] && l.files[0].id;
      if (oid) old = await download(oid);
    } catch (e) { if (e instanceof AuthError) throw e; }
    SET = old; SET_ID = null;
    await persist();
  }
  SET_AT = Date.now();
  return SET;
}
function persist() {
  saving = saving.then(async () => {
    const body = Buffer.from(JSON.stringify(SET));
    let f;
    if (SET_ID) f = await gfetch('PATCH', EP.upload + '/files/' + SET_ID + '?uploadType=media&fields=id,modifiedTime', undefined, { body, type: 'application/json' });
    else f = await multipart({ name: SYNC_NAME, description: SYNC_MARK, mimeType: 'application/json' }, body, 'application/json');
    if (f && f.id) SET_ID = f.id;
    if (f && f.modifiedTime) SET_MOD = f.modifiedTime;
    SET_AT = Date.now();
  }).catch(e => { console.error('settings save', e); throw e; });
  const p = saving; saving = saving.catch(() => {});
  return p;
}
async function multipart(meta, data, mime) {
  const bnd = 'dcal' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const body = Buffer.concat([
    Buffer.from('--' + bnd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + bnd + '\r\nContent-Type: ' + mime + '\r\n\r\n'),
    data, Buffer.from('\r\n--' + bnd + '--')
  ]);
  return gfetch('POST', EP.upload + '/files?uploadType=multipart&fields=id,modifiedTime', undefined, { body, type: 'multipart/related; boundary=' + bnd });
}
async function getSetting(name) {
  if (!/^[A-Za-z0-9_]{1,40}$/.test(String(name))) throw new Error('설정 이름이 잘못되었습니다.');
  const s = await settings(); return s[name] === undefined ? null : s[name];
}
async function setSetting(name, value) {
  if (!/^[A-Za-z0-9_]{1,40}$/.test(String(name))) throw new Error('설정 이름이 잘못되었습니다.');
  const s = await settings(true);
  if (value === null || value === undefined) delete s[name]; else s[name] = value;
  await persist(); return true;
}

/* ================= 분류(처음 쓰는 사람용 기본값) ================= */
const DEFAULT_CATEGORIES = [ 
  { id:'c_work', group:'업무', name:'업무', tag:'업', bg:'#1e5fd6', fg:'#ffffff' },
  { id:'c_meet', group:'업무', name:'회의', tag:'회', bg:'#fb8c00', fg:'#ffffff' },
  { id:'c_appt', group:'개인', name:'약속', tag:'약', bg:'#00897b', fg:'#ffffff' },
  { id:'c_fam',  group:'개인', name:'가족', tag:'가', bg:'#d81b60', fg:'#ffffff' },
  { id:'c_per',  group:'개인', name:'개인', tag:'개', bg:'#2e7d32', fg:'#ffffff' },
  { id:'c_trip', group:'개인', name:'여행·휴가', tag:'여', bg:'#6a3fc8', fg:'#ffffff' },
  { id:'c_imp',  group:'기타', name:'중요', tag:'중', bg:'#e53935', fg:'#ffffff' }
];
async function getCategories() {
  /* 설정 저장소(드라이브)에 문제가 있어도 일정은 보이도록 기본 분류로 대신함 */
  try { const s = await settings(); return Array.isArray(s.categories) && s.categories.length ? s.categories : DEFAULT_CATEGORIES; }
  catch (e) { if (e instanceof AuthError) throw e; return DEFAULT_CATEGORIES; }
}
async function saveCategories(list) {
  if (!Array.isArray(list)) throw new Error('분류 목록 형식이 잘못되었습니다.');
  const clean = list.slice(0, 60).map((c, i) => ({
    id: String(c.id || ('c_' + Date.now() + '_' + i)).slice(0, 40), group: String(c.group || '기타').slice(0, 10),
    name: String(c.name || '').slice(0, 40), tag: String(c.tag || '').slice(0, 6),
    bg: /^#[0-9a-fA-F]{6}$/.test(c.bg) ? c.bg : '#8a8f98', fg: /^#[0-9a-fA-F]{6}$/.test(c.fg) ? c.fg : '#ffffff'
  })).filter(c => c.name);
  const s = await settings(true); s.categories = clean; await persist(); return clean;
}

/* ================= 캘린더 ================= */
let COLORS = null;
async function eventColors() {
  if (COLORS) return COLORS;
  const c = await gfetch('GET', EP.cal + '/colors'); COLORS = {};
  Object.keys(c.event || {}).forEach(k => { COLORS[k] = c.event[k].background; });
  return COLORS;
}
async function listCalendars() {
  const out = await listCalendarsFor(null);
  const seen = new Set(out.map(c => c.id)); CAL_ACCT.clear();
  for (const a of EXTRA.slice()) {
    try {
      (await listCalendarsFor(a)).forEach(c => { if (seen.has(c.id)) return; seen.add(c.id); c.primary = false; c.account = a.email; CAL_ACCT.set(c.id, a); out.push(c); });
    } catch (e) { console.error('extra calendars', a.email, e.message); }
  }
  if (MS.enabled()) { try { out.push(...await MS.listCalendars()); } catch (e) { console.error('ms', e.message); } }
  return out;
}
async function listCalendarsFor(acct) {
  const out = []; let pt;
  do {
    const r = await gfetch('GET', EP.cal + '/users/me/calendarList' + q({ maxResults: 250, pageToken: pt }), undefined, acct ? { acct } : undefined);
    (r.items || []).forEach(c => {
      if (c.hidden) return;
      out.push({ id: c.id, name: c.summaryOverride || c.summary, color: c.backgroundColor || '#4285f4',
        writable: c.accessRole === 'owner' || c.accessRole === 'writer', owner: c.accessRole === 'owner', primary: !!c.primary, selected: c.selected !== false,
        holiday: /#holiday@/.test(c.id), made: c.accessRole === 'owner' && !c.primary && String(c.description || '').includes(SHARED_MARK), rem: (c.defaultReminders || []).filter(x => x.method === 'popup').map(x => x.minutes) });
    });
    pt = r.nextPageToken;
  } while (pt);
  out.sort((a, b) => b.primary - a.primary);
  return out;
}
const priv = (ev, k) => (ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private[k]) || '';
function dcalProps(ev) {
  const out = {}, pv = (ev.extendedProperties && ev.extendedProperties.private) || {};
  Object.keys(pv).forEach(k => { if (k.indexOf('dcal_') === 0 && ['dcal_bg', 'dcal_fg', 'dcal_cat', 'dcal_photos'].indexOf(k) < 0) out[k.slice(5)] = pv[k]; });
  return out;
}
function remindersOf(ev, cal) {
  const r = ev.reminders;
  if (!r || r.useDefault !== false) return cal.rem || [];
  return (r.overrides || []).filter(o => o.method === 'popup').map(o => o.minutes);
}
function mapEvent(ev, cal, colors) {
  const allDay = !!ev.start.date;
  return {
    id: ev.id, calendarId: cal.id, title: ev.summary || '(제목 없음)', allDay,
    start: allDay ? ev.start.date : ev.start.dateTime, end: allDay ? ev.end.date : ev.end.dateTime,
    location: ev.location || '', description: ev.description || '',
    color: (ev.colorId && colors[ev.colorId]) || cal.color,
    bg: priv(ev, 'dcal_bg'), fg: priv(ev, 'dcal_fg'), cat: priv(ev, 'dcal_cat'),
    photos: priv(ev, 'dcal_photos') ? priv(ev, 'dcal_photos').split(',') : [], files: filesOf(ev), props: dcalProps(ev),
    recurring: !!ev.recurringEventId, series: !!(ev.recurrence && ev.recurrence.length),
    holiday: cal.holiday, writable: cal.writable, rem: remindersOf(ev, cal),
    remDefault: !ev.reminders || ev.reminders.useDefault !== false, rrule: (ev.recurrence || []).join('\n'),
    type: ev.eventType && ev.eventType !== 'default' ? ev.eventType : ''
  };
}
/* 공휴일 캘린더가 영어로 구독되어 있어도 한국어 공휴일 이름으로 받아 옴 */
const koHoliday = id => /#holiday@group\.v\.calendar\.google\.com$/.test(id) && !/^ko\./.test(id) ? id.replace(/^[a-z]{2,3}(?:[-_][a-z]{2,4})?\./i, 'ko.') : id;
async function listEvents(start, end, since) {
  const now = new Date().toISOString();
  const cals = await listCalendars();
  const sel = cals.filter(c => c.selected);
  if (since) {
    const sd = new Date(since);
    if (!isNaN(sd) && Date.now() - sd.getTime() < 20 * 86400000) {
      const res = await Promise.all(sel.filter(c => !c.ms).map(cal => gfetch('GET', EP.cal + '/calendars/' + enc(cal.id) + '/events' + q({ updatedMin: sd.toISOString(), showDeleted: true, maxResults: 1, fields: 'items(id)' })).catch(() => ({ items: [1] }))));
      if (!res.some(r => (r.items || []).length)) return { unchanged: true, now, calendars: cals };
    }
  }
  const colors = await eventColors();
  const fetchAll = async id => {
    const items = []; let pt;
    do {
      const r = await gfetch('GET', EP.cal + '/calendars/' + enc(id) + '/events' + q({ timeMin: start, timeMax: end, singleEvents: true, orderBy: 'startTime', maxResults: 2500, pageToken: pt }));
      items.push(...(r.items || [])); pt = r.nextPageToken;
    } while (pt);
    return items;
  };
  const lists = await Promise.all(sel.map(async cal => {
    if (cal.ms) { try { return await MS.listEvents(cal, start, end); } catch (e) { console.error('ms events', e.message); return []; } }
    const ko = koHoliday(cal.id); let items = null;
    if (ko !== cal.id) { try { items = await fetchAll(ko); } catch (e) { if (e instanceof AuthError) throw e; items = null; } }
    if (!items) items = await fetchAll(cal.id);
    return items.filter(ev => ev.status !== 'cancelled' && ev.start).map(ev => mapEvent(ev, cal, colors));
  }));
  return { calendars: cals, events: [].concat.apply([], lists), categories: await getCategories(), now };
}
async function searchAll(qs) {
  qs = String(qs || '').trim().toLowerCase();
  if (!qs) return { events: [], total: 0 };
  const words = qs.split(/\s+/);
  const cals = (await listCalendars()).filter(c => !c.holiday && !c.ms);
  const colors = await eventColors();
  const out = [];
  await Promise.all(cals.map(async cal => {
    let pt, pages = 0;
    do {
      const r = await gfetch('GET', EP.cal + '/calendars/' + enc(cal.id) + '/events' + q({ q: words[0], singleEvents: false, maxResults: 2500, pageToken: pt }));
      (r.items || []).forEach(ev => {
        if (ev.status === 'cancelled' || !ev.start) return;
        const text = ((ev.summary || '') + ' ' + (ev.location || '') + ' ' + (ev.description || '')).toLowerCase();
        if (words.every(w => text.indexOf(w) >= 0)) out.push(mapEvent(ev, cal, colors));
      });
      pt = r.nextPageToken;
    } while (pt && ++pages < 10);
  }));
  out.sort((a, b) => String(b.start).localeCompare(String(a.start)));
  return { events: out.slice(0, 500), total: out.length };
}

function applyTimes(res, ev) {
  if (ev.allDay) { res.start = { date: ev.startDate }; res.end = { date: ev.endDate }; }
  else { res.start = { dateTime: ev.startDateTime, timeZone: TZ }; res.end = { dateTime: ev.endDateTime, timeZone: TZ }; }
  return res;
}
function hexRgb(h) { h = String(h).replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function nearestColorId(hex, colors) {
  const t = hexRgb(hex); let best = null, bestD = Infinity;
  Object.keys(colors).forEach(id => { const c = hexRgb(colors[id]); const d = Math.pow(c[0] - t[0], 2) * 0.3 + Math.pow(c[1] - t[1], 2) * 0.59 + Math.pow(c[2] - t[2], 2) * 0.11; if (d < bestD) { bestD = d; best = id; } });
  return best;
}
function applyProps(res, props) {
  if (!props || typeof props !== 'object') return res;
  res.extendedProperties = res.extendedProperties || {};
  const pv = res.extendedProperties.private = res.extendedProperties.private || {};
  Object.keys(props).slice(0, 30).forEach(name => {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(name)) return;
    const k = 'dcal_' + name, v = props[name];
    if (v === null || v === undefined || v === '') delete pv[k];
    else pv[k] = (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 1000);
  });
  return res;
}
async function applyStyle(res, ev) {
  applyProps(res, ev.props);
  if (!('bg' in ev) && !('fg' in ev) && !('cat' in ev)) return res;
  res.extendedProperties = res.extendedProperties || {};
  const pv = res.extendedProperties.private = res.extendedProperties.private || {};
  ['bg', 'fg', 'cat'].forEach(k => { if (ev[k]) pv['dcal_' + k] = String(ev[k]); else delete pv['dcal_' + k]; });
  if (ev.bg) res.colorId = nearestColorId(ev.bg, await eventColors()); else delete res.colorId;
  return res;
}
/* 첨부파일(PDF·엑셀·한글 등): 드라이브 '바탕화면 달력 첨부파일' 폴더 + 구글 캘린더 일정 첨부 */
const FILE_FOLDER = '바탕화면 달력 첨부파일';
let FF_ID = null;
async function fileFolder() {
  if (FF_ID) return FF_ID;
  const l = await gfetch('GET', EP.drive + '/files' + q({ q: "mimeType='application/vnd.google-apps.folder' and name='" + FILE_FOLDER + "' and trashed=false", fields: 'files(id)' }));
  if (l.files && l.files[0]) return (FF_ID = l.files[0].id);
  const f = await gfetch('POST', EP.drive + '/files?fields=id', { name: FILE_FOLDER, mimeType: 'application/vnd.google-apps.folder' });
  return (FF_ID = f.id);
}
async function uploadFile(p) {
  if (!p.data) throw new Error('파일 데이터가 없습니다.');
  const name = String(p.name || '첨부파일').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  const mime = String(p.mime || 'application/octet-stream').slice(0, 120);
  const buf = Buffer.from(p.data, 'base64');
  if (buf.length > 20 * 1024 * 1024) throw new Error('파일이 너무 큽니다(20MB까지).');
  const f = await multipart({ name, parents: [await fileFolder()], mimeType: mime }, buf, mime);
  return { id: f.id, name, mime, url: 'https://drive.google.com/open?id=' + f.id };
}
const isPhotoAtt = a => /^사진 \d+$/.test(a.title || '') || /^dcal:/.test(a.title || '');
function fileIdOf(a) { if (a.fileId) return a.fileId; const m = String(a.fileUrl || '').match(/[?&]id=([\w-]+)|\/d\/([\w-]+)/); return m ? (m[1] || m[2]) : ''; }
function filesOf(ev) { return (ev.attachments || []).filter(a => !isPhotoAtt(a)).map(a => ({ id: fileIdOf(a), name: a.title || '첨부파일', mime: a.mimeType || '', url: a.fileUrl || '' })); }
function applyFiles(res, ev) {
  if (!('files' in ev)) return res;
  const photos = (res.attachments || []).filter(isPhotoAtt);
  const files = (ev.files || []).filter(f => f && (f.url || f.id)).slice(0, 20).map(f => {
    const o = { fileUrl: String(f.url || ('https://drive.google.com/open?id=' + f.id)), title: String(f.name || '첨부파일').slice(0, 200) };
    if (f.mime) o.mimeType = String(f.mime); return o;
  });
  res.attachments = files.concat(photos).slice(0, 25);
  return res;
}
function applyPhotos(res, ev) {
  if (!('photos' in ev)) return res;
  const toks = (ev.photos || []).map(String).filter(t => /^[\w-]+(:[\w-]+)?$/.test(t));
  let joined = toks.join(','); while (joined.length > 1000) { toks.pop(); joined = toks.join(','); }
  res.extendedProperties = res.extendedProperties || {};
  const pv = res.extendedProperties.private = res.extendedProperties.private || {};
  if (joined) pv.dcal_photos = joined; else delete pv.dcal_photos;
  const others = (res.attachments || []).filter(a => !/^dcal:/.test(a.title || '') && !(a.title || '').match(/^사진 \d+$/));
  const mine = toks.map((t, i) => ({ fileUrl: 'https://drive.google.com/open?id=' + t.split(':')[0], title: '사진 ' + (i + 1), mimeType: 'image/jpeg' }));
  res.attachments = others.concat(mine).slice(0, 25);
  return res;
}
function applyReminders(res, ev) {
  if (!('reminders' in ev) || ev.reminders === undefined) return res;
  if (ev.reminders === 'default' || ev.reminders === null) res.reminders = { useDefault: true };
  else res.reminders = { useDefault: false, overrides: (ev.reminders || []).slice(0, 5).map(m => ({ method: 'popup', minutes: Math.max(0, Math.min(40320, +m || 0)) })) };
  return res;
}
async function createEvent(ev) {
  if (MS.isMs(ev.calendarId)) return MS.createEvent(ev);
  const res = applyTimes({ summary: ev.title, location: ev.location || '', description: ev.description || '' }, ev);
  await applyStyle(res, ev); applyFiles(res, ev); applyPhotos(res, ev); applyReminders(res, ev);
  if (ev.recurrence && ev.recurrence.length) res.recurrence = ev.recurrence.filter(x => /^RRULE:/.test(x));
  const r = await gfetch('POST', EP.cal + '/calendars/' + enc(ev.calendarId) + '/events?supportsAttachments=true', res);
  return r.id;
}
async function updateEvent(ev) {
  if (MS.isMs(ev.calendarId) || MS.isMs(ev.originalCalendarId)) { if (MS.isMs(ev.calendarId) !== MS.isMs(ev.originalCalendarId || ev.calendarId)) throw new Error('구글 캘린더와 아웃룩 캘린더 사이로는 옮길 수 없습니다. 새로 만든 뒤 원래 일정을 지워 주세요.'); return MS.updateEvent(ev); }
  let calId = ev.originalCalendarId || ev.calendarId, id = ev.id;
  if (ev.originalCalendarId && ev.originalCalendarId !== ev.calendarId) {
    if ((CAL_ACCT.get(ev.originalCalendarId) || null) !== (CAL_ACCT.get(ev.calendarId) || null)) throw new Error('다른 구글 계정의 캘린더로는 옮길 수 없습니다. 새 일정으로 만든 뒤 원래 일정을 지워 주세요.');
    const m = await gfetch('POST', EP.cal + '/calendars/' + enc(ev.originalCalendarId) + '/events/' + enc(id) + '/move?destination=' + enc(ev.calendarId));
    id = m.id; calId = ev.calendarId;
  }
  const cur = await gfetch('GET', EP.cal + '/calendars/' + enc(calId) + '/events/' + enc(id));
  cur.summary = ev.title; cur.location = ev.location || ''; cur.description = ev.description || '';
  applyTimes(cur, ev); await applyStyle(cur, ev); applyFiles(cur, ev); applyPhotos(cur, ev); applyReminders(cur, ev);
  if (ev.recurrence && ev.recurrence.length && !cur.recurringEventId) cur.recurrence = ev.recurrence.filter(x => /^RRULE:/.test(x));
  const r = await gfetch('PUT', EP.cal + '/calendars/' + enc(calId) + '/events/' + enc(id) + '?supportsAttachments=true', cur);
  return r.id;
}
async function rescheduleEvent(ev) {
  if (MS.isMs(ev.calendarId)) return MS.rescheduleEvent(ev);
  const t = applyTimes({}, ev);
  const r = await gfetch('PATCH', EP.cal + '/calendars/' + enc(ev.calendarId) + '/events/' + enc(ev.id), { start: t.start, end: t.end });
  return r.id;
}
async function deleteEvent(calendarId, eventId) {
  if (MS.isMs(calendarId)) return MS.deleteEvent(calendarId, eventId);
  await gfetch('DELETE', EP.cal + '/calendars/' + enc(calendarId) + '/events/' + enc(eventId), undefined, { raw: true });
  return true;
}
/* 공유 캘린더 만들기: 새 캘린더 + 적은 이메일에 보기/편집 권한 공유 */
async function createSharedCalendar(p) {
  const name = String(p.name || '').trim().slice(0, 60);
  if (!name) throw new Error('캘린더 이름을 입력하세요.');
  const desc = (p.kind === 'import' ? '' : SHARED_MARK + (p.description ? '\n' : '')) + String(p.description || '').slice(0, 300);
  const cal = await gfetch('POST', EP.cal + '/calendars', { summary: name, description: desc, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul' });
  const color = /^#[0-9a-fA-F]{6}$/.test(p.color || '') ? p.color : '';
  try { await gfetch('PATCH', EP.cal + '/users/me/calendarList/' + enc(cal.id) + (color ? '?colorRgbFormat=true' : ''), color ? { selected: true, backgroundColor: color, foregroundColor: '#ffffff' } : { selected: true }); } catch (e) {}
  const r = await shareCalendar(cal.id, p.members);
  return { id: cal.id, name, shared: r.shared, failed: r.failed };
}
/* '공유 캘린더 만들기'로 만든 캘린더 표시(캘린더 설명에 넣음) — 이 표시가 있는 캘린더만 삭제 가능 */
const SHARED_MARK = '바탕화면 달력에서 만든 공유 캘린더';
async function markSharedCalendars() {
  let n = 0;
  const r = await gfetch('GET', EP.cal + '/users/me/calendarList' + q({ maxResults: 250 }));
  for (const c of (r.items || [])) {
    if (c.primary || c.accessRole !== 'owner' || c.description || /#holiday@/.test(c.id)) continue;
    try {
      const acl = await gfetch('GET', EP.cal + '/calendars/' + enc(c.id) + '/acl');
      if ((acl.items || []).some(x => x.role !== 'owner' && x.scope && (x.scope.type === 'user' || x.scope.type === 'group'))) {
        await gfetch('PATCH', EP.cal + '/calendars/' + enc(c.id), { description: SHARED_MARK }); n++;
      }
    } catch (e) {}
  }
  return n;
}
async function deleteOwnCalendar(calId) {
  calId = String(calId || '');
  if (MS.isMs(calId)) throw new Error('아웃룩 캘린더는 여기서 삭제할 수 없습니다.');
  const acct = CAL_ACCT.get(calId) || null;
  const c = await gfetch('GET', EP.cal + '/users/me/calendarList/' + enc(calId), undefined, { acct });
  if (!c) throw new Error('캘린더를 찾지 못했습니다.');
  if (c.primary) throw new Error('기본 캘린더는 삭제할 수 없습니다.');
  /* 내가 만든(소유한) 캘린더는 삭제, 구독·공유받은 캘린더는 내 목록에서만 뺌 */
  if (c.accessRole === 'owner') { await gfetch('DELETE', EP.cal + '/calendars/' + enc(calId), undefined, { raw: true, acct }); return 'deleted'; }
  await gfetch('DELETE', EP.cal + '/users/me/calendarList/' + enc(calId), undefined, { raw: true, acct });
  return 'removed';
}
async function shareCalendar(calId, members) {
  const shared = [], failed = [];
  for (const m of (members || []).slice(0, 30)) {
    const email = String(m.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
    try { await gfetch('POST', EP.cal + '/calendars/' + enc(calId) + '/acl', { role: m.role === 'writer' ? 'writer' : 'reader', scope: { type: 'user', value: email } }); shared.push(email); }
    catch (e) { failed.push(email); }
  }
  return { shared, failed };
}
/* 반복 일정 삭제 — mode: one(이 일정만) / following(이 일정과 이후 모두) / all(연결된 반복 일정 전체) */
function untilBefore(orig) {
  if (orig.date) { const d = new Date(orig.date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10).replace(/-/g, ''); }
  return new Date(new Date(orig.dateTime).getTime() - 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function cutRule(lines, until) {
  return (lines || []).map(l => {
    if (!/^RRULE:/i.test(l)) return l;
    const parts = l.slice(6).split(';').filter(x => x && !/^(UNTIL|COUNT)=/i.test(x));
    parts.push('UNTIL=' + until);
    return 'RRULE:' + parts.join(';');
  });
}
/* 반복 일정 수정 — mode: one / following / all */
const rYmdTz = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const rDayOf = t => t.date ? t.date : rYmdTz(new Date(t.dateTime));
const rDn = s => Math.round(new Date(s + 'T00:00:00Z').getTime() / 864e5);
const rDs = n => new Date(n * 864e5 + 43200000).toISOString().slice(0, 10);
function rTimesFor(ev, day) {
  if (ev.allDay) return { start: { date: day }, end: { date: rDs(rDn(day) + Math.max(1, rDn(ev.endDate) - rDn(ev.startDate))) } };
  const dur = new Date(ev.endDateTime + 'Z').getTime() - new Date(ev.startDateTime + 'Z').getTime();
  const s = day + String(ev.startDateTime).slice(10, 19);
  const e = new Date(new Date(s + 'Z').getTime() + dur).toISOString().slice(0, 19);
  return { start: { dateTime: s, timeZone: TZ }, end: { dateTime: e, timeZone: TZ } };
}
function rAdjRule(lines, o) {
  const BY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'], dd = new Date(o.date + 'T12:00:00Z');
  return (lines || []).filter(l => /^RRULE:/i.test(l)).map(l => 'RRULE:' + l.slice(6).split(';').filter(Boolean).map(x => {
    const k = x.split('=')[0].toUpperCase(), v = x.split('=')[1] || '';
    if (k === 'UNTIL') return 'UNTIL=' + (o.allDay ? v.slice(0, 8) : (/T/.test(v) ? v : v + 'T145959Z'));
    if (k === 'COUNT' && o.count !== null && o.count !== undefined) return 'COUNT=' + o.count;
    if (o.shifted && k === 'BYDAY' && /^[A-Z]{2}$/.test(v)) return 'BYDAY=' + BY[dd.getUTCDay()];
    if (o.shifted && k === 'BYDAY' && /^-?\d[A-Z]{2}$/.test(v)) return 'BYDAY=' + Math.ceil(dd.getUTCDate() / 7) + BY[dd.getUTCDay()];
    if (o.shifted && k === 'BYMONTHDAY' && /^\d+$/.test(v)) return 'BYMONTHDAY=' + dd.getUTCDate();
    if (o.shifted && k === 'BYMONTH' && /^\d+$/.test(v)) return 'BYMONTH=' + (dd.getUTCMonth() + 1);
    return x;
  }).join(';'));
}
async function updateRecurring(ev, mode) {
  if (MS.isMs(arguments[0] && arguments[0].calendarId)) { if (arguments[1] && arguments[1] !== 'one') throw new Error('아웃룩 반복 일정은 이 일정 하나만 고칠 수 있습니다.'); return MS.updateEvent(arguments[0]); }
  const calId = ev.originalCalendarId || ev.calendarId, base = EP.cal + '/calendars/' + enc(calId) + '/events/';
  const inst = await gfetch('GET', base + enc(ev.id));
  const masterId = inst.recurringEventId || '';
  if (!masterId || mode === 'one') return { id: await updateEvent(ev), mode: 'one' };
  const master = await gfetch('GET', base + enc(masterId));
  const orig = inst.originalStartTime || inst.start;
  const origDay = rDayOf(orig), masterDay = rDayOf(master.start);
  const newDay = ev.allDay ? ev.startDate : String(ev.startDateTime).slice(0, 10);
  const shift = rDn(newDay) - rDn(origDay);
  if (mode === 'following' && origDay <= masterDay) mode = 'all';
  if (mode === 'all') {
    const mDay = rDs(rDn(masterDay) + shift), t = rTimesFor(ev, mDay);
    const keepOther = !shift && !!ev.allDay === !!master.start.date;
    const other = (master.recurrence || []).filter(l => !/^RRULE:/i.test(l) && keepOther);
    master.start = t.start; master.end = t.end;
    master.summary = ev.title; master.location = ev.location || ''; master.description = ev.description || '';
    await applyStyle(master, ev); applyFiles(master, ev); applyPhotos(master, ev); applyReminders(master, ev);
    master.recurrence = rAdjRule(master.recurrence, { allDay: !!ev.allDay, date: mDay, shifted: shift !== 0, count: null }).concat(other);
    await gfetch('PUT', base + enc(masterId) + '?supportsAttachments=true', master);
    return { id: masterId, mode: 'all' };
  }
  const origIso = orig.date ? new Date(orig.date + 'T00:00:00').toISOString() : new Date(orig.dateTime).toISOString();
  let count = null;
  const cm = (master.recurrence || []).join(';').match(/COUNT=(\d+)/i);
  if (cm) {
    const before = (await gfetch('GET', base + enc(masterId) + '/instances' + q({ timeMax: origIso, maxResults: 2500 }))).items || [];
    count = Math.max(0, +cm[1] - before.length);
  }
  const rec = rAdjRule(master.recurrence, { allDay: !!ev.allDay, date: newDay, shifted: shift !== 0, count });
  await gfetch('PATCH', base + enc(masterId), { recurrence: cutRule(master.recurrence, untilBefore(orig)) });
  try {
    const left = (await gfetch('GET', base + enc(masterId) + '/instances' + q({ timeMin: origIso, maxResults: 250 }))).items || [];
    for (const x of left) { try { await deleteEvent(calId, x.id); } catch (e) {} }
  } catch (e) {}
  if (count === 0) return { id: '', mode: 'following' };
  const ne = Object.assign({}, ev, { calendarId: calId, recurrence: rec }); delete ne.id; delete ne.originalCalendarId;
  return { id: await createEvent(ne), mode: 'following' };
}
async function setRecurEnd(calId, eventId, until) {
  if (MS.isMs(arguments[0])) throw new Error('아웃룩 반복 일정의 끝 날짜는 아웃룩에서 바꿔 주세요.');
  const base = EP.cal + '/calendars/' + enc(calId) + '/events/';
  const inst = await gfetch('GET', base + enc(eventId));
  const masterId = inst.recurringEventId || (inst.recurrence && inst.recurrence.length ? inst.id : '');
  if (!masterId) throw new Error('반복 일정이 아닙니다.');
  const master = await gfetch('GET', base + enc(masterId));
  const allDay = !!master.start.date;
  const sd = allDay ? null : new Date(master.start.dateTime);
  const first = allDay ? master.start.date : sd.getFullYear() + '-' + String(sd.getMonth() + 1).padStart(2, '0') + '-' + String(sd.getDate()).padStart(2, '0');
  let u = '';
  if (until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error('종료일 형식이 잘못되었습니다.');
    if (until < first) throw new Error('종료일이 반복 시작일(' + first + ')보다 빠릅니다.');
    u = allDay ? until.replace(/-/g, '') : new Date(until + 'T23:59:59').toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }
  const lines = (master.recurrence || []).map(l => {
    if (!/^RRULE:/i.test(l)) return l;
    const parts = l.slice(6).split(';').filter(x => x && !/^(UNTIL|COUNT)=/i.test(x));
    if (u) parts.push('UNTIL=' + u);
    return 'RRULE:' + parts.join(';');
  });
  await gfetch('PATCH', base + enc(masterId), { recurrence: lines });
  return { first, until: until || '' };
}
async function deleteRecurring(calId, eventId, mode) {
  if (MS.isMs(calId)) { if (mode && mode !== 'one') throw new Error('아웃룩 반복 일정은 이 일정 하나만 지울 수 있습니다. 전체는 아웃룩에서 지워 주세요.'); return MS.deleteEvent(calId, eventId); }
  const base = EP.cal + '/calendars/' + enc(calId) + '/events/';
  const inst = await gfetch('GET', base + enc(eventId));
  const masterId = inst.recurringEventId || (inst.recurrence && inst.recurrence.length ? inst.id : '');
  if (!masterId || mode === 'one') { await deleteEvent(calId, eventId); return { mode: 'one' }; }
  if (mode === 'all') { await deleteEvent(calId, masterId); return { mode: 'all' }; }
  const master = await gfetch('GET', base + enc(masterId));
  const orig = inst.originalStartTime || inst.start;
  const first = master.start.date || new Date(master.start.dateTime).getTime();
  const here = orig.date || new Date(orig.dateTime).getTime();
  if (here <= first) { await deleteEvent(calId, masterId); return { mode: 'all' }; }
  await gfetch('PATCH', base + enc(masterId), { recurrence: cutRule(master.recurrence, untilBefore(orig)) });
  const from = orig.date ? new Date(orig.date + 'T00:00:00').toISOString() : new Date(orig.dateTime).toISOString();
  try {
    const left = (await gfetch('GET', base + enc(masterId) + '/instances' + q({ timeMin: from, maxResults: 250 }))).items || [];
    for (const x of left) { try { await deleteEvent(calId, x.id); } catch (e) {} }
  } catch (e) {}
  return { mode: 'following' };
}

/* ================= 사진(각자 드라이브의 '바탕화면 달력 첨부사진' 폴더) ================= */
const PHOTO_FOLDER = '바탕화면 달력 첨부사진';
let PF_ID = null;
async function photoFolder() {
  if (PF_ID) return PF_ID;
  const l = await gfetch('GET', EP.drive + '/files' + q({ q: "mimeType='application/vnd.google-apps.folder' and name='" + PHOTO_FOLDER + "' and trashed=false", fields: 'files(id)' }));
  if (l.files && l.files[0]) return (PF_ID = l.files[0].id);
  const f = await gfetch('POST', EP.drive + '/files?fields=id', { name: PHOTO_FOLDER, mimeType: 'application/vnd.google-apps.folder' });
  return (PF_ID = f.id);
}
async function uploadPhoto(p) {
  if (!p.data) throw new Error('사진 데이터가 없습니다.');
  const folder = await photoFolder();
  const d = new Date(), stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0');
  const base = String(p.name || '사진').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const full = await multipart({ name: stamp + '_' + base + '.jpg', parents: [folder], mimeType: 'image/jpeg' }, Buffer.from(p.data, 'base64'), 'image/jpeg');
  let thumbId = full.id;
  if (p.thumb) thumbId = (await multipart({ name: stamp + '_' + base + '_작은사진.jpg', parents: [folder], mimeType: 'image/jpeg' }, Buffer.from(p.thumb, 'base64'), 'image/jpeg')).id;
  return { id: full.id, thumbId };
}
async function getPhoto(id) {
  if (!/^[\w-]+$/.test(String(id))) throw new Error('사진 번호가 잘못되었습니다.');
  try {
    const r = await gfetch('GET', EP.drive + '/files/' + enc(id) + '?alt=media', undefined, { raw: true });
    const buf = new Uint8Array(await r.arrayBuffer());
    return { mime: r.headers.get('content-type') || 'image/jpeg', data: u8b64(buf) };
  } catch (e) {
    if (e.status === 404 || e.status === 403) throw new Error('이 사진은 예전 방식으로 첨부되어 앱에서 바로 열 수 없습니다. 구글 캘린더의 첨부파일에서 볼 수 있습니다.');
    throw e;
  }
}

/* ================= 할 일(구글 할 일) ================= */
async function taskLists() { return ((await gfetch('GET', EP.tasks + '/users/@me/lists?maxResults=20')).items || []); }
const mapTask = (t, l) => ({ id: t.id, list: l.id, listName: l.title, title: t.title || '(제목 없음)', notes: t.notes || '', due: t.due ? String(t.due).slice(0, 10) : '', done: t.status === 'completed', src: 'google' });
async function listTasks(start, end) {
  const s = String(start || '').slice(0, 10), e = String(end || '').slice(0, 10);
  const lists = await taskLists(), out = [];
  await Promise.all(lists.map(async l => {
    let pt;
    do {
      const r = await gfetch('GET', EP.tasks + '/lists/' + enc(l.id) + '/tasks' + q({ showCompleted: true, showHidden: true, maxResults: 100, pageToken: pt }));
      (r.items || []).forEach(t => {
        if (!t.title && !t.notes) return;
        const x = mapTask(t, l), inRange = x.due && (!s || x.due >= s) && (!e || x.due <= e);
        if (inRange || (!x.done && (!x.due || (s && x.due < s)))) out.push(x);
      });
      pt = r.nextPageToken;
    } while (pt);
  }));
  return { src: 'google', tasks: out, lists: lists.map(l => ({ id: l.id, name: l.title })) };
}
async function saveTask(t) {
  t = t || {};
  const listId = t.list || (await taskLists())[0].id;
  const body = { title: t.title || '', notes: t.notes || '', status: t.done ? 'completed' : 'needsAction', due: t.due ? t.due + 'T00:00:00.000Z' : null };
  if (!t.done) body.completed = null;
  const r = t.id ? await gfetch('PATCH', EP.tasks + '/lists/' + enc(listId) + '/tasks/' + enc(t.id), body)
                 : await gfetch('POST', EP.tasks + '/lists/' + enc(listId) + '/tasks', body);
  return { id: r.id };
}
async function deleteTask(t) { await gfetch('DELETE', EP.tasks + '/lists/' + enc(t.list) + '/tasks/' + enc(t.id), undefined, { raw: true }); return true; }

/* ================= 예전 달력 설정 옮겨 오기 ================= */
async function importSettings(p) {
  const s = await settings(true);
  const allow = ['semesters', 'stickers', 'templates', 'pins', 'annivs', 'calsets', 'blinkCats', 'catPresets'];
  Object.keys(p.settings || {}).forEach(k => { if (allow.indexOf(k) >= 0 && p.settings[k] != null) s[k] = p.settings[k]; });
  if (Array.isArray(p.categories) && p.categories.length) s.categories = p.categories;
  await persist(); return Object.keys(s);
}

/* ================= 화면에서 오는 요청 처리 ================= */
const ok = data => ({ ok: true, data });
async function handle(action, p) {
  p = p || {};
  try {
    switch (action) {
      case 'me': return ok({ email: TOK && TOK.email, name: TOK && TOK.name });
      case 'logout': case 'logoutAll': await signOut(); return ok(true);
      case 'calendars': return ok(await listCalendars());
      case 'events': return ok(await listEvents(p.start, p.end, p.since));
      case 'search': return ok(await searchAll(p.q));
      case 'categories': return ok(await getCategories());
      case 'saveCategories': return ok(await saveCategories(p.categories));
      case 'getSetting': return ok(await getSetting(p.name));
      case 'setSetting': return ok(await setSetting(p.name, p.value));
      case 'upload': return ok(await uploadPhoto(p));
      case 'uploadFile': return ok(await uploadFile(p));
      case 'photo': return ok(await getPhoto(p.id));
      case 'create': return ok(await createEvent(p.event));
      case 'update': return ok(await updateEvent(p.event));
      case 'reschedule': return ok(await rescheduleEvent(p.event));
      case 'delete': return ok(await deleteEvent(p.calendarId, p.eventId));
      case 'deleteRecurring': return ok(await deleteRecurring(p.calendarId, p.eventId, p.mode));
      case 'createCalendar': return ok(await createSharedCalendar(p));
      case 'shareCalendar': return ok(await shareCalendar(p.calendarId, p.members));
      case 'deleteCalendar': return ok(await deleteOwnCalendar(p.calendarId));
      case 'markShared': return ok(await markSharedCalendars());
      case 'recurEnd': return ok(await setRecurEnd(p.calendarId, p.eventId, p.until));
      case 'updateRecurring': return ok(await updateRecurring(p.event, p.mode));
      case 'ics': return ok(await fetchIcs(p.url));
      case 'tasks': return ok(await listTasks(p.start, p.end));
      case 'taskSave': return ok(await saveTask(p.task));
      case 'taskDelete': return ok(await deleteTask(p.task));
      case 'importSettings': return ok(await importSettings(p));
      case 'accounts': return ok({ list: [{ email: TOK && TOK.email, name: TOK && TOK.name, primary: true, type: 'google' }], ms: false, web: true });
      case 'addAccount': case 'addMsAccount': throw new Error('다른 계정 추가는 PC 앱에서 할 수 있습니다.');
      case 'removeAccount': return ok(true);
    }
    return { ok: false, error: '알 수 없는 요청입니다.' };
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, error: e.message, auth: false };
    return { ok: false, error: String((e && e.message) || e) };
  }
}
function state() { return { email: TOK && TOK.email && (TOK.access_token || !sessionStorage.getItem('dcal.gnoretry')) ? TOK.email : '', name: (TOK && TOK.name) || '' }; }
window.dcalApp = {
  web: true,
  g: { call: (a, p) => handle(a, p), signIn, signOut, state: () => Promise.resolve(state()), finishAuth },
  openExternal: u => { window.open(u, '_blank', 'noopener'); return Promise.resolve(); }
};
})();
