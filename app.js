/* Roster Sync — UI, local cache, Google Drive import and Google Calendar sync. */
(function () {
  'use strict';
  const C = window.RosterCore;
  const CFG = Object.assign({ mode: 'hosted', clientId: '', samples: [] }, window.ROSTER_CONFIG || {});
  const PREVIEW = CFG.mode === 'preview';
  const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/calendar';
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const fmtDate = (iso, opt) => { const [y, m, d] = iso.split('-').map(Number); const w = C.DOW_NAMES[C.dowOf(iso)]; return opt === 'long' ? `${w} ${d} ${MON[m - 1]} ${y}` : `${w} ${d} ${MON[m - 1]}`; };
  const fmtExport = (s) => { const [d, t] = s.split('T'); const [y, m, dd] = d.split('-').map(Number); return `${dd} ${MON[m - 1]} ${y} ${t}`; };
  const tzShort = (() => { try { return new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value; } catch (e) { return ''; } })();
  const devFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const devTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const fc = C.fmtClock;

  /* ---------- settings (localStorage, best effort) ---------- */
  const DEFAULTS = { clientId: CFG.clientId || '', folder: '', months: 12, reminder: 120, calName: 'Qantas Roster', calId: '', staff: '', lastDrive: '' };
  const settings = Object.assign({}, DEFAULTS, (() => { try { return JSON.parse(localStorage.getItem('rq.settings') || '{}'); } catch (e) { return {}; } })());
  const saveSettings = () => { try { localStorage.setItem('rq.settings', JSON.stringify(settings)); } catch (e) { /* storage blocked */ } };

  /* ---------- file cache (IndexedDB, falls back to memory) ---------- */
  const store = (() => {
    let dbp = null; const mem = new Map();
    const open = () => dbp || (dbp = new Promise((res) => {
      try {
        const rq = indexedDB.open('roster-sync', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('files', { keyPath: 'key' });
        rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null);
      } catch (e) { res(null); }
    }));
    const tx = async (mode, fn) => { const db = await open(); if (!db) { const r = fn(null); return r && typeof r === 'object' && 'result' in r ? r.result : r; } return new Promise((res, rej) => { const t = db.transaction('files', mode); const r = fn(t.objectStore('files')); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); };
    return {
      all: () => tx('readonly', (s) => (s ? s.getAll() : { result: [...mem.values()] })),
      put: (rec) => tx('readwrite', (s) => (s ? s.put(rec) : (mem.set(rec.key, rec), null))),
      clear: () => tx('readwrite', (s) => (s ? s.clear() : (mem.clear(), null))),
    };
  })();

  /* ---------- state ---------- */
  const S = {
    view: 'roster', files: [], rosters: [], errors: [], periods: [], staffList: [],
    periodKey: null, exportIdx: null, date: null, openRow: null, cmp: null,
    token: null, tokenExp: 0, gis: null, busy: '', plan: null, progress: 0, confirmClear: false, drag: false,
  };

  function rebuild() {
    S.errors = []; const rosters = [];
    S.files.forEach((f) => { try { rosters.push(C.parseRoster(f.text, f.name)); } catch (e) { S.errors.push(`${f.name}: ${e.message}`); } });
    S.rosters = rosters;
    const staff = {}; rosters.forEach((r) => { staff[r.staffNo] = staff[r.staffNo] && staff[r.staffNo].exportedAt > r.exportedAt ? staff[r.staffNo] : r; });
    S.staffList = Object.values(staff).sort((a, b) => b.exportedAt.localeCompare(a.exportedAt)).map((r) => ({ staffNo: r.staffNo, name: r.name }));
    if (!S.staffList.some((s) => s.staffNo === settings.staff)) settings.staff = S.staffList.length ? S.staffList[0].staffNo : '';
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - Number(settings.months));
    const cutoff = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    S.periods = C.buildLibrary(rosters.filter((r) => r.staffNo === settings.staff)).filter((p) => p.startDate >= cutoff);
    if (!S.periods.some((p) => key(p) === S.periodKey)) {
      const t = todayIso();
      const cur = S.periods.find((p) => p.startDate <= t && p.endDate >= t) || S.periods.filter((p) => p.startDate > t).pop() || S.periods[0];
      S.periodKey = cur ? key(cur) : null; S.exportIdx = null; S.date = null; S.cmp = null;
    }
  }
  const key = (p) => `${p.staffNo}|${p.bidPeriod}`;
  const period = () => S.periods.find((p) => key(p) === S.periodKey) || null;
  const expIdx = (p) => (S.exportIdx == null || S.exportIdx >= p.exports.length ? p.exports.length - 1 : S.exportIdx);

  async function addFiles(list, source) {
    let added = 0, dup = 0, bad = 0;
    for (const f of list) {
      const text = f.text != null ? f.text : await f.file.text();
      try { C.parseRoster(text, f.name); } catch (e) { bad++; S.errors.push(`${f.name}: ${e.message}`); continue; }
      const k = C.hashStr(text) + '-' + text.length;
      if (S.files.some((x) => x.key === k)) { dup++; continue; }
      const rec = Object.assign({ key: k, name: f.name, text, source, addedAt: new Date().toISOString() }, f.meta || {});
      S.files.push(rec); if (source !== 'sample') { try { await store.put(rec); } catch (e) { /* cache unavailable */ } }
      added++;
    }
    return { added, dup, bad };
  }

  /* ---------- Google: sign-in, Drive, Calendar ---------- */
  function loadGis() {
    if (PREVIEW) return Promise.reject(new Error('Google sign-in only works on the hosted app.'));
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => res(); s.onerror = () => rej(new Error('Could not load Google sign-in. Check your connection.'));
      document.head.appendChild(s);
    });
  }
  // Must be called at the start of a click handler so the sign-in popup is allowed.
  function ensureToken() {
    if (S.token && Date.now() < S.tokenExp - 60000) return Promise.resolve(S.token);
    if (!settings.clientId) return Promise.reject(new Error('Add your Google client ID in Settings first.'));
    if (!(window.google && google.accounts && google.accounts.oauth2)) return Promise.reject(new Error('Google sign-in is still loading. Try again in a moment.'));
    return new Promise((res, rej) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: settings.clientId, scope: SCOPES,
        callback: (r) => {
          if (r.error) return rej(new Error(r.error_description || r.error));
          if (!google.accounts.oauth2.hasGrantedAllScopes(r, ...SCOPES.split(' '))) return rej(new Error('Both Drive and Calendar access are needed. Tick both boxes when Google asks.'));
          S.token = r.access_token; S.tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000; render(); res(S.token);
        },
        error_callback: (e) => rej(new Error(e && e.type === 'popup_closed' ? 'Sign-in window was closed.' : 'Sign-in failed or the popup was blocked.')),
      });
      try { client.requestAccessToken({ prompt: settings.granted ? '' : 'consent' }); settings.granted = true; saveSettings(); } catch (e) { rej(e); }
    });
  }
  async function gapi(method, url, body, tries = 0) {
    const r = await fetch(url, { method, headers: Object.assign({ Authorization: 'Bearer ' + S.token }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    if ((r.status === 429 || r.status === 403 || r.status >= 500) && tries < 4) {
      const txt = r.status === 403 ? await r.clone().text() : '';
      if (r.status !== 403 || /rateLimit|userRateLimit/i.test(txt)) { await new Promise((ok) => setTimeout(ok, 800 * 2 ** tries)); return gapi(method, url, body, tries + 1); }
    }
    if (r.status === 401) { S.token = null; render(); throw new Error('Google session expired. Tap Connect Google again.'); }
    if (!r.ok) { const e = new Error(`Google ${method} failed (${r.status}): ${(await r.text()).slice(0, 200)}`); e.status = r.status; throw e; }
    if (r.status === 204) return null;
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.text();
  }
  const folderId = () => { const m = /folders\/([A-Za-z0-9_-]+)/.exec(settings.folder) || /[?&]id=([A-Za-z0-9_-]+)/.exec(settings.folder); return m ? m[1] : settings.folder.trim(); };

  async function driveRefresh() {
    const fid = folderId(); if (!fid) throw new Error('Set the Google Drive folder link in Settings first.');
    S.busy = 'Checking Google Drive…'; render();
    let files = [], page = '';
    do {
      const q = encodeURIComponent(`'${fid}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`);
      const res = await gapi('GET', `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=1000&fields=nextPageToken,files(id,name,md5Checksum,modifiedTime,size)${page ? '&pageToken=' + page : ''}&supportsAllDrives=true&includeItemsFromAllDrives=true`);
      files = files.concat(res.files || []); page = res.nextPageToken || '';
    } while (page);
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - Number(settings.months) - 2);
    const cutoff = d.toISOString().slice(0, 10);
    const wanted = files.filter((f) => /\.txt$/i.test(f.name) || /webcis/i.test(f.name)).filter((f) => {
      const m = /_(\d{2})(\d{2})(\d{4})\b/.exec(f.name); return !m || `${m[3]}-${m[2]}-${m[1]}` >= cutoff;
    });
    const known = new Set(S.files.filter((x) => x.driveId).map((x) => x.driveId + ':' + x.md5));
    const todo = wanted.filter((f) => !known.has(f.id + ':' + f.md5Checksum));
    const got = [];
    for (let i = 0; i < todo.length; i++) {
      S.busy = `Downloading ${i + 1} of ${todo.length}…`; render();
      const text = await gapi('GET', `https://www.googleapis.com/drive/v3/files/${todo[i].id}?alt=media&supportsAllDrives=true`);
      got.push({ name: todo[i].name, text: String(text), meta: { driveId: todo[i].id, md5: todo[i].md5Checksum } });
    }
    const r = await addFiles(got, 'drive');
    settings.lastDrive = new Date().toISOString(); saveSettings(); S.busy = ''; rebuild();
    return `${files.length} file${files.length === 1 ? '' : 's'} in folder · ${r.added} new roster${r.added === 1 ? '' : 's'}${r.bad ? ` · ${r.bad} not readable` : ''}`;
  }

  async function ensureCalendar() {
    if (settings.calId) {
      try { await gapi('GET', `https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(settings.calId)}`); return settings.calId; } catch (e) { if (e.status !== 404) throw e; }
    }
    let page = '', found = null;
    do {
      const res = await gapi('GET', `https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250${page ? '&pageToken=' + page : ''}`);
      found = (res.items || []).find((c) => c.summary === settings.calName && c.accessRole === 'owner'); page = res.nextPageToken || '';
    } while (!found && page);
    if (!found) found = await gapi('POST', 'https://www.googleapis.com/calendar/v3/calendars', { summary: settings.calName, description: 'Crew roster synced from WebCIS exports by Roster Sync. Events here are added, changed and removed automatically.', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Singapore' });
    settings.calId = found.id; saveSettings(); return found.id;
  }

  async function checkPlan(p) {
    S.busy = 'Reading your roster calendar…'; S.plan = null; render();
    const cal = await ensureCalendar();
    const desired = C.eventPlan(p.latest, { reminderMin: Number(settings.reminder) });
    let existing = [], page = '';
    do {
      const q = `privateExtendedProperty=${encodeURIComponent('rqBid=' + p.bidPeriod)}&privateExtendedProperty=${encodeURIComponent('rqStaff=' + p.staffNo)}`;
      const res = await gapi('GET', `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events?${q}&showDeleted=true&maxResults=2500&fields=nextPageToken,items(id,status,summary,start,end,extendedProperties)${page ? '&pageToken=' + page : ''}`);
      existing = existing.concat(res.items || []); page = res.nextPageToken || '';
    } while (page);
    S.plan = { key: key(p), cal, plan: C.syncPlan(desired, existing), at: Date.now(), export: p.latest.id };
    S.busy = ''; render();
  }

  async function applyPlan() {
    const { cal, plan } = S.plan; const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events`;
    const ops = [
      ...plan.create.map((e) => async () => { try { await gapi('POST', base, e); } catch (x) { if (x.status !== 409) throw x; await gapi('PUT', `${base}/${e.id}`, Object.assign({ status: 'confirmed' }, e)); } }),
      ...plan.update.map((e) => () => gapi('PUT', `${base}/${e.id}`, Object.assign({ status: 'confirmed' }, e))),
      ...plan.remove.map((e) => async () => { try { await gapi('DELETE', `${base}/${e.id}`); } catch (x) { if (x.status !== 404 && x.status !== 410) throw x; } }),
    ];
    let done = 0; const fails = []; S.progress = 0;
    const worker = async () => { while (ops.length) { const op = ops.shift(); try { await op(); } catch (e) { fails.push(e.message); } done++; S.progress = done; S.busy = `Updating calendar ${done} of ${S.plan.total}…`; renderProgress(); } };
    S.plan.total = ops.length; S.busy = 'Updating calendar…'; render();
    await Promise.all([worker(), worker(), worker(), worker()]);
    S.busy = '';
    if (fails.length) throw new Error(`${fails.length} change${fails.length > 1 ? 's' : ''} failed. First error: ${fails[0]}`);
    return done;
  }

  /* ---------- rendering ---------- */
  const ICONS = {
    roster: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>',
    changes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h13l-3-3M20 17H7l3 3"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3M18 3v4h-4M6 21v-4h4"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  };
  const TAG_TEXT = { added: 'Added', removed: 'Removed', changed: 'Changed', retimed: 'Retimed', renamed: 'Renamed' };
  const tag = (t) => `<span class="tag chg-${t}">${TAG_TEXT[t] || t}</span>`;

  function render() {
    const p = period();
    const latestDiff = p && p.history[p.history.length - 1].diff;
    $('#crew').textContent = p ? `${p.name} · ${p.staffNo}` : '';
    const pill = $('#status');
    if (PREVIEW) { pill.className = 'pill warn'; pill.innerHTML = '<span class="dot"></span>Preview · sample exports'; }
    else if (S.token) { pill.className = 'pill ok'; pill.innerHTML = '<span class="dot"></span>Google connected'; }
    else { pill.className = 'pill'; pill.innerHTML = '<span class="dot"></span>Not connected'; }
    $('#tabs').innerHTML = [['roster', 'Roster'], ['changes', 'Changes'], ['history', 'History'], ['sync', 'Sync'], ['settings', 'Settings']].map(([v, l]) => {
      const n = v === 'changes' && latestDiff ? latestDiff.trips.length + latestDiff.header.length : 0;
      return `<button role="tab" data-view="${v}" aria-selected="${S.view === v}">${ICONS[v]}<span>${l}</span>${n ? `<span class="count">${n}</span>` : ''}</button>`;
    }).join('');
    const views = { roster: viewRoster, changes: viewChanges, history: viewHistory, sync: viewSync, settings: viewSettings };
    $('#view').innerHTML = views[S.view]();
  }
  function renderProgress() { const b = $('#prog i'); if (b && S.plan && S.plan.total) b.style.width = `${(100 * S.progress) / S.plan.total}%`; const t = $('#prog-label'); if (t) t.textContent = S.busy; }

  function emptyState() {
    return `<div class="empty-state"><h2>No rosters loaded yet</h2><p>${PREVIEW ? 'Add WebCIS export files to see your roster.' : 'Connect Google and pick your WebCIS folder on the Sync tab, or add export files from this device.'}</p>
      <p style="margin-top:14px"><button class="btn primary" data-view="sync">Go to Sync</button></p></div>`;
  }

  function periodPicker(p, withExport) {
    const opts = S.periods.map((x) => `<option value="${esc(key(x))}" ${key(x) === S.periodKey ? 'selected' : ''}>BP ${esc(x.bidPeriod)} · ${fmtDate(x.startDate)} – ${fmtDate(x.endDate)}</option>`).join('');
    const staff = S.staffList.length > 1 ? `<div class="field"><label class="label" for="pick-staff">Crew member</label><select id="pick-staff">${S.staffList.map((s) => `<option value="${esc(s.staffNo)}" ${s.staffNo === settings.staff ? 'selected' : ''}>${esc(s.name)} (${esc(s.staffNo)})</option>`).join('')}</select></div>` : '';
    const ex = withExport ? `<div class="field"><label class="label" for="pick-export">As of export</label><select id="pick-export">${p.exports.map((e, i) => `<option value="${i}" ${i === expIdx(p) ? 'selected' : ''}>${fmtExport(e.exportedAt)}${i === p.exports.length - 1 ? ' (latest)' : ''}</option>`).join('')}</select></div>` : '';
    return `<div class="toolbar">${staff}<div class="field"><label class="label" for="pick-period">Bid period</label><select id="pick-period">${opts}</select></div>${ex}</div>`;
  }

  function dayView(r, d) {
    const t = d.tripIndex != null ? r.trips[d.tripIndex] : null;
    const info = { kind: d.kind, code: d.code || '—', sub: '', sub2: '', pos: '' };
    if (t) {
      const di = t.dayInfo.find((x) => x.date === d.date); const first = di.n === 1, last = di.n === di.of;
      info.pos = first && last ? 'trip-start trip-end' : first ? 'trip-start' : last ? 'trip-end' : 'trip-mid';
      info.sub = first ? `Rpt ${fc(t.rept)}` : last ? `Off ${fc(t.end)}` : di.label;
      info.mono = first || last; info.sub2 = first || last ? di.label : '';
      info.line = `${t.sectors.filter((s) => s.depDate === d.date).map((s) => `${s.flight} ${s.from}→${s.to} ${fc(s.depLst)}`).join(', ') || di.label}`;
    } else {
      info.sub = { standby: 'Standby', rest: 'Rest day', rrr: 'Rest recovery', other: 'Unrecognised code', blank: '' }[d.kind] || '';
      info.line = { standby: 'Standby', rest: 'Off duty – rest day', rrr: 'Roster rest recovery', other: 'Unrecognised duty code' }[d.kind] || '';
    }
    return info;
  }

  function viewRoster() {
    const p = period(); if (!p) return banners() + emptyState();
    const i = expIdx(p), r = p.exports[i], diff = p.history[i].diff, prev = i ? p.exports[i - 1] : null;
    const today = todayIso();
    if (!S.date || !r.days.some((d) => d.date === S.date)) {
      S.date = r.days.some((d) => d.date === today) ? today : (diff && Object.keys(diff.days).sort()[0]) || r.startDate;
    }
    const credit = r.trips.reduce((a, t) => a + (C.hhmmToMin(t.credit) || 0), 0);
    const hdrChange = (k) => diff && diff.header.find((h) => h.label.toLowerCase().startsWith(k));
    const stat = (label, val, ch) => `<div class="stat"><span class="label">${label}</span><b>${esc(val)}${ch ? `<span class="was">${esc(ch.from)}</span>` : ''}</b></div>`;
    const counts = { trip: 0, standby: 0, rest: 0, rrr: 0 }; r.days.forEach((d) => { counts[d.kind] = (counts[d.kind] || 0) + 1; });
    let html = banners() + periodPicker(p, true);
    html += `<div class="stats">${stat('Dates', `${fmtDate(r.startDate)} – ${fmtDate(r.endDate)}`)}${stat('Planned', r.header.planned || '—', hdrChange('planned'))}${stat('Trip credit', C.minToHhmm(credit))}${stat('Trips', String(r.trips.length))}${stat('Standby days', String(counts.standby || 0))}${stat('Exported', fmtExport(r.exportedAt))}</div>`;
    if (diff) html += `<p class="note" style="margin:-6px 0 12px">Dashed outlines show what changed since the ${esc(fmtExport(prev.exportedAt))} export.</p>`;
    // grid
    const lead = (C.dowOf(r.startDate) + 6) % 7;
    let cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => `<div class="dow">${w}</div>`).join('');
    for (let k = 0; k < lead; k++) cells += '<div class="cell empty"></div>';
    r.days.forEach((d) => {
      const v = dayView(r, d), ch = diff && diff.days[d.date];
      const was = ch && ch.was && ch.was !== d.code ? `<span class="was">${esc(ch.was)}</span>` : '';
      cells += `<button class="cell k-${v.kind} ${v.pos} ${ch ? 'chg chg-' + ch.type : ''} ${d.date === today ? 'is-today' : ''}" data-date="${d.date}" aria-pressed="${d.date === S.date}" aria-label="${esc(fmtDate(d.date))} ${esc(v.code)} ${esc(v.line)}">
        <span class="d"><span>${Number(d.date.slice(8))}${d.date.slice(8) === '01' || d.date === r.startDate ? ' ' + MON[Number(d.date.slice(5, 7)) - 1] : ''}</span>${was}</span>
        <span class="code">${esc(v.code)}</span><span class="sub ${v.mono ? 'mono' : ''}">${esc(v.sub)}</span>${v.sub2 ? `<span class="sub">${esc(v.sub2)}</span>` : ''}
        ${ch ? tag(ch.type) : ''}</button>`;
    });
    // agenda
    let ag = '', wk = null;
    r.days.forEach((d) => {
      const mon = C.addDays(d.date, -((C.dowOf(d.date) + 6) % 7));
      if (mon !== wk) { if (wk) ag += '</div>'; wk = mon; ag += `<div class="wk"><span class="label">Week of ${fmtDate(mon)}</span>`; }
      const v = dayView(r, d), ch = diff && diff.days[d.date];
      ag += `<button class="row k-${v.kind} ${ch ? 'chg chg-' + ch.type : ''} ${d.date === today ? 'is-today' : ''}" data-row="${d.date}" aria-expanded="${S.openRow === d.date}">
        <span class="dt">${C.DOW_NAMES[C.dowOf(d.date)]}<b>${d.date.slice(8)}</b></span>
        <span style="min-width:0"><span class="code">${esc(v.code)}</span> ${ch && ch.was && ch.was !== d.code ? `<span class="was muted" style="text-decoration:line-through;font-size:.8rem">${esc(ch.was)}</span>` : ''}<span class="sub" style="display:block">${esc(v.line)}${v.mono ? ` · ${esc(v.sub)}` : ''}</span></span>
        <span>${ch ? tag(ch.type) : ''}</span></button>`;
      if (S.openRow === d.date) ag += `<div class="row-detail">${detail(p, r, diff, d.date, true)}</div>`;
    });
    if (wk) ag += '</div>';
    html += `<div class="roster-wrap"><div style="min-width:0"><div class="grid-wrap"><div class="grid">${cells}</div>${legend()}</div><div class="agenda">${ag}${legend()}</div></div>
      <aside class="detail side">${detail(p, r, diff, S.date)}</aside></div>`;
    return html;
  }
  const legend = () => `<div class="legend"><span><i class="sw k-trip"></i>Trip</span><span><i class="sw k-standby"></i>Standby (A)</span><span><i class="sw k-rest"></i>Rest day (X)</span><span><i class="sw k-rrr"></i>Rest recovery (R-)</span><span><i class="sw chg"></i>Changed</span></div>`;

  function detail(p, r, diff, date, inline) {
    const d = r.days.find((x) => x.date === date); if (!d) return '';
    const v = dayView(r, d), ch = diff && diff.days[date];
    const t = d.tripIndex != null ? r.trips[d.tripIndex] : null;
    let h = inline ? '' : `<div class="detail-head k-${v.kind}"><span class="code">${esc(v.code)}</span><h3>${esc(fmtDate(date, 'long'))}</h3></div>`;
    if (!t) {
      h += `<p>${esc(v.line || 'No duty')}</p>`;
      if (d.code === 'R-' && d.rept) h += `<p class="note">Listed ${fc(d.rept)}–${fc(d.end)} in the export; shown as an all-day entry.</p>`;
      if (ch && ch.was) h += `<p class="note">${tag(ch.type)} Was <b>${esc(ch.was)}</b> in the previous export.</p>`;
      return h;
    }
    const tc = diff && diff.trips.find((c) => c.new === t);
    const changed = (lab) => tc && tc.fields.find((f) => f.label === lab);
    const val = (lab, now) => { const c = changed(lab); return c ? `<span class="del">${esc(c.from)}</span> <span class="ins">${esc(now)}</span>` : esc(now); };
    const di = t.dayInfo.find((x) => x.date === date);
    h += `<p style="margin:0 0 4px"><b>${esc(t.pattern)}</b> · day ${di.n} of ${di.of} · ${esc(di.label)}</p>`;
    if (tc) h += `<p class="note" style="margin:0 0 6px">${tag(tc.type)} since the previous export${tc.type === 'renamed' ? ` (was ${esc(tc.old.pattern)})` : ''}.</p>`;
    h += `<dl class="kv"><dt>Trip</dt><dd>${esc(fmtDate(t.startDate))} – ${esc(fmtDate(t.endDate))}</dd><dt>Report</dt><dd>${val('Report', fc(t.rept))} ${esc(r.base)}</dd><dt>Sign-off</dt><dd>${val('Sign-off', fc(t.end))} ${esc(r.base)}</dd><dt>Credit</dt><dd>${val('Credit', t.credit || '—')}</dd>${t.detail ? `<dt>Detail</dt><dd>${esc(t.detail)}</dd>` : ''}</dl>`;
    h += '<div class="secs">' + t.sectors.map((s, i) => {
      const fl = changed(`Sector ${i + 1} flight`), dep = changed(`${s.flight} departs`), arr = changed(`${s.flight} arrives`);
      return `<div class="sec"><span><span class="fl">${fl ? `<span class="del">${esc(fl.from)}</span> ` : ''}${esc(s.flight)}</span>${s.positioning ? '<span class="pflag" title="P flag in WebCIS — positioning">P</span>' : ''}</span><span class="rt">${esc(s.from)}→${esc(s.to)}</span>
        <span class="tm"><span>Dep ${dep ? `<span class="del">${esc(dep.from)}</span> ` : ''}${esc(C.DOW_NAMES[C.dowOf(s.depDate)])} ${fc(s.depLst)} ${esc(s.from)}</span><span>Arr ${arr ? `<span class="del">${esc(arr.from)}</span> ` : ''}${esc(C.DOW_NAMES[C.dowOf(s.arrDate)])} ${fc(s.arrLst)} ${esc(s.to)}</span></span>
        <span class="yours">Your time (${esc(tzShort)}): ${esc(devFmt.format(s.depMs))} – ${esc(new Date(s.arrMs).toDateString() === new Date(s.depMs).toDateString() ? devTime.format(s.arrMs) : devFmt.format(s.arrMs))}${s.dutyHours ? ` · duty ${esc(s.dutyHours)}` : ''}</span></div>`;
    }).join('') + '</div>';
    h += '<p class="note">Sector times are local to each airport.</p>';
    return h;
  }

  function viewChanges() {
    const p = period(); if (!p) return banners() + emptyState();
    let html = banners() + periodPicker(p, false);
    if (p.exports.length < 2) return html + `<div class="empty-state"><h2>Only one export for this bid period</h2><p>Changes appear once a newer WebCIS export of BP ${esc(p.bidPeriod)} is added.</p></div>`;
    const n = p.exports.length;
    let [a, b] = S.cmp && S.cmp.key === key(p) ? [S.cmp.a, S.cmp.b] : [n - 2, n - 1];
    const opt = (sel) => p.exports.map((e, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${fmtExport(e.exportedAt)}${i === n - 1 ? ' (latest)' : ''}</option>`).join('');
    html += `<div class="compare"><div class="field"><label class="label" for="cmp-a">From export</label><select id="cmp-a">${opt(a)}</select></div><div class="field"><label class="label" for="cmp-b">To export</label><select id="cmp-b">${opt(b)}</select></div></div>`;
    if (a === b) return html + '<p class="muted">Pick two different exports to compare.</p>';
    if (a > b) [a, b] = [b, a];
    const diff = C.compareRosters(p.exports[a], p.exports[b]);
    const by = {}; diff.trips.forEach((c) => { by[c.type] = (by[c.type] || 0) + 1; });
    if (!diff.trips.length && !diff.header.length) return html + '<div class="empty-state"><h2>No roster changes</h2><p>These two exports list the same duties.</p></div>';
    html += `<div class="summary-line">${Object.entries(by).map(([t, k]) => `<span class="tag chg-${t}">${k} ${TAG_TEXT[t]}</span>`).join('')}${diff.header.length ? `<span class="tag chg-changed">Hours changed</span>` : ''}</div><div class="cards">`;
    if (diff.header.length) html += `<div class="card chg-changed"><div class="card-head">${tag('changed')}<h3>Bid period hours</h3></div><table class="ftab"><tbody>${diff.header.map((f) => `<tr><td>${esc(f.label)}</td><td><span class="del">${esc(f.from)}</span> → <span class="ins">${esc(f.to)}</span></td></tr>`).join('')}</tbody></table></div>`;
    diff.trips.forEach((c) => {
      const t = c.new || c.old;
      const title = c.type === 'renamed' ? `${c.old.pattern} → ${c.new.pattern}` : t.pattern;
      const body = c.type === 'removed' ? `<p class="note">Trip no longer on the roster. ${esc(t.sectors.map((s) => s.flight).join('/'))} · report ${fc(t.rept)}.</p>${replacement(p.exports[b], t)}`
        : c.type === 'added' ? `<p class="note">New trip. ${esc(t.sectors.map((s) => `${s.flight} ${s.from}→${s.to} ${fc(s.depLst)}`).join(' · '))}</p>`
        : `<div class="scroll-x"><table class="ftab"><tbody>${c.fields.map((f) => `<tr><td>${esc(f.label)}</td><td><span class="del">${esc(f.from)}</span> → <span class="ins">${esc(f.to)}</span></td></tr>`).join('')}</tbody></table></div>`;
      html += `<div class="card chg-${c.type}"><div class="card-head">${tag(c.type)}<h3>${esc(title)}</h3><span class="muted mono" style="font-size:.85rem">${esc(fmtDate(t.startDate))} – ${esc(fmtDate(t.endDate))}</span>
        <button class="btn small" data-goto="${t.startDate}" style="margin-left:auto" ${c.type === 'removed' && b !== n - 1 ? 'disabled' : ''}>Show on roster</button></div>${body}</div>`;
    });
    return html + '</div>';
  }
  const replacement = (r, t) => { const now = t.days.map((d) => r.days.find((x) => x.date === d)).filter(Boolean); return now.length ? `<p class="note">Those days are now: ${now.map((d) => `${esc(fmtDate(d.date))} <b>${esc(d.code)}</b>`).join(', ')}.</p>` : ''; };

  function viewHistory() {
    if (!S.periods.length) return banners() + emptyState();
    let html = banners() + '<div class="hist">';
    S.periods.forEach((p) => {
      html += `<section class="hist-period"><h3>BP ${esc(p.bidPeriod)} · ${esc(fmtDate(p.startDate))} – ${esc(fmtDate(p.endDate))}</h3>`;
      p.history.slice().reverse().forEach((h) => {
        const i = p.exports.indexOf(h.roster), d = h.diff; const by = {};
        if (d) d.trips.forEach((c) => { by[c.type] = (by[c.type] || 0) + 1; });
        const chips = d ? (Object.keys(by).length || d.header.length ? Object.entries(by).map(([t, k]) => `<span class="tag chg-${t}">${k} ${TAG_TEXT[t]}</span>`).join(' ') + (d.header.length ? ' <span class="tag chg-changed">Hours</span>' : '') : '<span class="muted" style="font-size:.82rem">No changes</span>') : '<span class="muted" style="font-size:.82rem">First export</span>';
        html += `<div class="hist-row"><div style="min-width:0"><div class="when">${esc(fmtExport(h.roster.exportedAt))}</div><div class="fname">${esc(h.roster.fileName)}</div><div class="chips">${chips}</div></div>
          <div class="actions">${d ? `<button class="btn small" data-hist="${esc(key(p))}|${i}">Changes</button>` : ''}<button class="btn small" data-asof="${esc(key(p))}|${i}">View</button></div></div>`;
      });
      html += '</section>';
    });
    return html + '</div>';
  }

  function banners() {
    let h = '';
    if (PREVIEW) h += `<div class="banner info"><p><b>Preview with the three sample exports.</b> Browse the roster, changes and calendar plan here. Google Drive import and Calendar sync run on your hosted copy of the app.</p></div>`;
    else if (!S.token && settings.clientId && settings.folder && S.view !== 'settings') h += `<div class="banner info"><p>Check your Drive folder for new WebCIS exports.${settings.lastDrive ? ` Last checked ${esc(new Date(settings.lastDrive).toLocaleString())}.` : ''}</p><button class="btn primary small" data-act="drive">Check Drive</button></div>`;
    if (S.busy && S.view !== 'sync') h += `<div class="banner"><p>${esc(S.busy)}</p></div>`;
    if (S.errors.length) h += `<div class="banner"><ul class="warnlist">${S.errors.slice(-5).map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
    const p = period(); const w = p ? p.latest.warnings : [];
    if (w.length) h += `<div class="banner"><ul class="warnlist">${w.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
    return h;
  }

  function viewSync() {
    const p = period(); const t = todayIso();
    const eligible = S.periods.filter((x) => x.endDate >= t);
    let html = banners() + '<div class="panels two">';
    // sources
    html += `<section class="panel"><h3>Roster files</h3>`;
    if (!PREVIEW) {
      html += `<p class="muted">${settings.folder ? 'Drive folder set.' : 'No Drive folder set yet.'} ${S.files.filter((f) => f.source === 'drive').length} exports from Drive, ${S.files.filter((f) => f.source === 'device').length} added from this device.</p>
        <div class="actions"><button class="btn ${S.token ? '' : 'primary'}" data-act="connect" ${!settings.clientId ? 'disabled' : ''}>${S.token ? 'Reconnect Google' : 'Connect Google'}</button><button class="btn primary" data-act="drive" ${!settings.folder || !settings.clientId || S.busy ? 'disabled' : ''}>Check Drive now</button></div>
        ${!settings.clientId ? '<p class="note">Add your Google client ID and Drive folder link in Settings to turn on Drive and Calendar.</p>' : ''}
        ${settings.lastDrive ? `<p class="note">Last checked ${esc(new Date(settings.lastDrive).toLocaleString())}.</p>` : ''}`;
    } else html += `<p class="muted">${S.files.length} exports loaded (3 samples${S.files.length > 3 ? ' plus yours' : ''}).</p>`;
    html += `<label class="drop ${S.drag ? 'over' : ''}" id="drop">Drop WebCIS .txt exports here, or <span style="color:var(--accent);text-decoration:underline">choose files</span><input type="file" id="pick-files" accept=".txt,text/plain" multiple hidden></label></section>`;
    // calendar
    html += `<section class="panel"><h3>Google Calendar</h3>`;
    if (!eligible.length) html += '<p class="muted">No current or future bid periods in range. Past periods are left as they are in your calendar.</p>';
    else {
      const sp = eligible.find((x) => key(x) === S.periodKey) || eligible[eligible.length - 1];
      html += `<div class="form"><div class="field"><label class="label" for="sync-period">Bid period to sync</label><select id="sync-period">${eligible.map((x) => `<option value="${esc(key(x))}" ${x === sp ? 'selected' : ''}>BP ${esc(x.bidPeriod)} · ${fmtDate(x.startDate)} – ${fmtDate(x.endDate)}</option>`).join('')}</select>
        <p class="hint">Uses the latest export (${esc(fmtExport(sp.latest.exportedAt))}) and only touches the “${esc(settings.calName)}” calendar.</p></div></div>`;
      const plan = S.plan && S.plan.key === key(sp) && S.plan.export === sp.latest.id ? S.plan : null;
      if (PREVIEW || !S.token) {
        const ev = C.eventPlan(sp.latest, { reminderMin: Number(settings.reminder) });
        html += `<p>${ev.length} calendar entries for this bid period: ${ev.filter((e) => e.start.dateTime).length} flight sectors and ${ev.filter((e) => e.start.date).length} all-day day entries.</p>
          ${PREVIEW ? '' : `<div class="actions"><button class="btn primary" data-act="check" ${!settings.clientId ? 'disabled' : ''}>Connect and check calendar</button></div>`}${evList(ev.map((e) => ({ e })))}`;
      } else if (!plan) {
        html += `<div class="actions"><button class="btn primary" data-act="check" ${S.busy ? 'disabled' : ''}>Check what will change</button></div>${S.busy ? `<p class="note">${esc(S.busy)}</p>` : ''}`;
      } else {
        const pl = plan.plan, n = pl.create.length + pl.update.length + pl.remove.length;
        html += `<div class="plan-counts"><div><span class="label">Add</span><b>${pl.create.length}</b></div><div><span class="label">Update</span><b>${pl.update.length}</b></div><div><span class="label">Remove</span><b>${pl.remove.length}</b></div><div><span class="label">Unchanged</span><b>${pl.keep.length}</b></div></div>`;
        if (S.busy) html += `<div id="prog" class="progress"><i style="width:${plan.total ? (100 * S.progress) / plan.total : 0}%"></i></div><p class="note" id="prog-label">${esc(S.busy)}</p>`;
        else html += n ? `<div class="actions"><button class="btn primary" data-act="apply">Apply ${n} change${n > 1 ? 's' : ''} to calendar</button><button class="btn" data-act="check">Check again</button></div>` : `<p>Calendar already matches this export.</p><div class="actions"><button class="btn" data-act="check">Check again</button></div>`;
        html += evList([...pl.create.map((e) => ({ e, op: 'added' })), ...pl.update.map((e) => ({ e, op: 'changed' })), ...pl.remove.map((e) => ({ e, op: 'removed' }))]);
      }
    }
    html += '</section></div>';
    return html;
  }
  function evList(items) {
    if (!items.length) return '';
    const when = (e) => (e.start.dateTime ? devFmt.format(new Date(e.start.dateTime)) : fmtDate(e.start.date) + ' · all day');
    const kind = (e) => { const c = e.colorId; return c === C.COLOR.sector ? 'sector' : c === C.COLOR.tripDay ? 'trip' : c === C.DAY_CODES.A.colorId ? 'standby' : c === C.DAY_CODES.X.colorId ? 'rest' : c === C.DAY_CODES['R-'].colorId ? 'rrr' : 'other'; };
    const sk = (e) => (e.start.dateTime || e.start.date + 'T00:00') + (e.start.date ? '0' : '1');
    return `<div class="evlist">${items.sort((a, b) => sk(a.e).localeCompare(sk(b.e))).map(({ e, op }) => `<div class="ev ${op ? 'chg-' + op : ''}"><i class="sw k-${kind(e)}"></i><span class="when">${esc(when(e))}</span><span class="t">${esc(e.summary)}</span><span class="op">${op ? TAG_TEXT[op] : ''}</span></div>`).join('')}</div>`;
  }

  function viewSettings() {
    const m = Number(settings.months);
    return banners() + `<div class="panels two"><section class="panel"><h3>Coverage and calendar</h3><div class="form">
      <div class="field"><label class="label" for="set-months">Bid periods to show</label><div class="range-row"><input type="range" id="set-months" min="1" max="12" value="${m}"><span class="mono" id="months-label">${m} month${m > 1 ? 's' : ''}</span></div><p class="hint">Bid periods that started within this many months back, plus all future ones.</p></div>
      <div class="field"><label class="label" for="set-reminder">Reminder before report time</label><select id="set-reminder">${[['-1', 'No reminder'], ['0', 'At report time'], ['30', '30 minutes'], ['60', '1 hour'], ['90', '1½ hours'], ['120', '2 hours'], ['180', '3 hours']].map(([v, l]) => `<option value="${v}" ${String(settings.reminder) === v ? 'selected' : ''}>${l}</option>`).join('')}</select><p class="hint">Set on the first flight of each trip.</p></div>
      <div class="field"><label class="label" for="set-cal">Calendar name</label><input type="text" id="set-cal" value="${esc(settings.calName)}" autocomplete="off"><p class="hint">A separate calendar the app creates and owns. Your other calendars are never touched.</p></div>
    </div></section>
    <section class="panel"><h3>Google connection</h3><div class="form">
      <div class="field"><label class="label" for="set-client">Google OAuth client ID</label><input type="text" id="set-client" value="${esc(settings.clientId)}" placeholder="1234…apps.googleusercontent.com" autocomplete="off" spellcheck="false" ${PREVIEW ? 'disabled' : ''}><p class="hint">From your free Google Cloud project. See SETUP.md.</p></div>
      <div class="field"><label class="label" for="set-folder">WebCIS folder in Google Drive</label><input type="url" id="set-folder" value="${esc(settings.folder)}" placeholder="https://drive.google.com/drive/folders/…" autocomplete="off" spellcheck="false" ${PREVIEW ? 'disabled' : ''}><p class="hint">Open the folder in Drive and paste its link.</p></div>
    </div></section>
    <section class="panel"><h3>Data on this device</h3><p class="muted">${S.files.length} export file${S.files.length === 1 ? '' : 's'} cached in this browser. Nothing is sent anywhere except Google.</p>
      ${S.confirmClear ? `<div class="confirm"><span>Remove all cached exports from this device?</span><button class="btn danger small" data-act="clear-yes">Remove</button><button class="btn small" data-act="clear-no">Cancel</button></div>` : '<div class="actions"><button class="btn danger" data-act="clear">Clear cached exports</button></div>'}
    </section></div>`;
  }

  /* ---------- events ---------- */
  let toastTimer;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500); }
  const fail = (e) => { S.busy = ''; render(); toast(e.message || String(e)); };

  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-view],[data-date],[data-row],[data-act],[data-goto],[data-hist],[data-asof]'); if (!b) return;
    if (b.dataset.view) { S.view = b.dataset.view; render(); window.scrollTo(0, 0); return; }
    if (b.dataset.date) { S.date = b.dataset.date; render(); return; }
    if (b.dataset.row) { S.openRow = S.openRow === b.dataset.row ? null : b.dataset.row; render(); return; }
    if (b.dataset.goto) { S.exportIdx = null; S.date = b.dataset.goto; S.openRow = b.dataset.goto; S.view = 'roster'; render(); return; }
    if (b.dataset.hist || b.dataset.asof) {
      const v = b.dataset.hist || b.dataset.asof; const i = Number(v.slice(v.lastIndexOf('|') + 1)); S.periodKey = v.slice(0, v.lastIndexOf('|'));
      if (b.dataset.hist) { S.cmp = { key: S.periodKey, a: i - 1, b: i }; S.view = 'changes'; } else { S.exportIdx = i; S.date = null; S.view = 'roster'; }
      render(); window.scrollTo(0, 0); return;
    }
    const act = b.dataset.act;
    if (act === 'connect') ensureToken().then(() => toast('Google connected.')).catch(fail);
    if (act === 'drive') ensureToken().then(driveRefresh).then((m) => { render(); toast(m); }).catch(fail);
    if (act === 'check') { const p = syncPeriod(); ensureToken().then(() => checkPlan(p)).catch(fail); }
    if (act === 'apply') ensureToken().then(applyPlan).then(async (n) => { toast(`Calendar updated: ${n} change${n === 1 ? '' : 's'}.`); await checkPlan(syncPeriod()); }).catch(fail);
    if (act === 'clear') { S.confirmClear = true; render(); }
    if (act === 'clear-no') { S.confirmClear = false; render(); }
    if (act === 'clear-yes') { store.clear().then(() => { S.files = S.files.filter((f) => f.source === 'sample'); S.confirmClear = false; rebuild(); render(); toast('Cached exports removed.'); }); }
  });
  const syncPeriod = () => { const el = $('#sync-period'); const k = el ? el.value : S.periodKey; return S.periods.find((p) => key(p) === k) || period(); };

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.id === 'pick-period' || el.id === 'sync-period') { S.periodKey = el.value; S.exportIdx = null; S.date = null; S.cmp = null; S.plan = null; render(); }
    if (el.id === 'pick-staff') { settings.staff = el.value; saveSettings(); S.periodKey = null; rebuild(); render(); }
    if (el.id === 'pick-export') { S.exportIdx = Number(el.value); S.date = null; render(); }
    if (el.id === 'cmp-a' || el.id === 'cmp-b') { S.cmp = { key: S.periodKey, a: Number($('#cmp-a').value), b: Number($('#cmp-b').value) }; render(); }
    if (el.id === 'set-months') { settings.months = Number(el.value); saveSettings(); rebuild(); render(); }
    if (el.id === 'set-reminder') { settings.reminder = Number(el.value); saveSettings(); S.plan = null; }
    if (el.id === 'set-cal') { settings.calName = el.value.trim() || DEFAULTS.calName; settings.calId = ''; saveSettings(); S.plan = null; }
    if (el.id === 'set-client') { settings.clientId = el.value.trim(); saveSettings(); if (settings.clientId) loadGis().catch(() => {}); toast('Client ID saved.'); }
    if (el.id === 'set-folder') { settings.folder = el.value.trim(); saveSettings(); toast('Drive folder saved.'); }
    if (el.id === 'pick-files') ingest([...el.files]);
  });
  document.addEventListener('input', (ev) => { if (ev.target.id === 'set-months') { const m = ev.target.value; $('#months-label').textContent = `${m} month${m > 1 ? 's' : ''}`; } });
  ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (ev) => { if (ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')) { ev.preventDefault(); if (!S.drag) { S.drag = true; const d = $('#drop'); if (d) d.classList.add('over'); } } }));
  document.addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) { S.drag = false; const d = $('#drop'); if (d) d.classList.remove('over'); } });
  document.addEventListener('drop', (ev) => { if (!ev.dataTransfer || !ev.dataTransfer.files.length) return; ev.preventDefault(); S.drag = false; ingest([...ev.dataTransfer.files]); });
  async function ingest(files) {
    const r = await addFiles(files.map((f) => ({ name: f.name, file: f })), 'device');
    S.periodKey = null; rebuild(); render();
    toast(`${r.added} added${r.dup ? `, ${r.dup} already loaded` : ''}${r.bad ? `, ${r.bad} not WebCIS rosters` : ''}.`);
  }

  /* ---------- start ---------- */
  (async function start() {
    try { S.files = (await store.all()) || []; } catch (e) { S.files = []; }
    if (CFG.samples && CFG.samples.length) await addFiles(CFG.samples, 'sample');
    rebuild(); render();
    if (!PREVIEW && settings.clientId) loadGis().catch(() => {});
    if (!PREVIEW && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  })();
})();
