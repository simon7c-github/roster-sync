/* Roster Sync — core logic (no DOM). Parses Qantas WebCIS "csRoster" exports,
   compares exports, and builds the Google Calendar event plan.
   Works in the browser (window.RosterCore) and in Node (module.exports). */
(function (root) {
  'use strict';

  const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
  const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Duty codes confirmed by the user. Anything else that has a pattern block is a trip.
  const DAY_CODES = {
    'A':  { kind: 'standby', label: 'Standby', calTitle: 'Standby (A)', colorId: '6' },
    'X':  { kind: 'rest',    label: 'Off duty – rest day', calTitle: 'Off duty – rest day', colorId: '2' },
    'R-': { kind: 'rrr',     label: 'Roster rest recovery', calTitle: 'Roster rest recovery', colorId: '8' },
  };
  const COLOR = { sector: '9', tripDay: '7', other: '3' };

  /* ---------- small helpers ---------- */
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const hhmmToMin = (s) => { const m = /^(\d{1,3}):(\d{2})$/.exec(s || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  const minToHhmm = (m) => (m == null ? '' : `${Math.floor(m / 60)}:${pad(m % 60)}`);
  const clock = (s) => { const m = /^(\d{2})(\d{2})$/.exec(s || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  const fmtClock = (s) => (s && s.length === 4 ? `${s.slice(0, 2)}:${s.slice(2)}` : s || '');
  // Dates are handled as 'YYYY-MM-DD' strings and UTC-midnight Date objects to stay timezone-proof.
  const isoDate = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const dateObj = (iso) => new Date(iso + 'T00:00:00Z');
  const addDays = (iso, n) => { const d = dateObj(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dowOf = (iso) => dateObj(iso).getUTCDay();
  const flightLabel = (svc) => { const m = /^([A-Z0-9]{2})[A-Z]?0*(\d+[A-Z]?)$/.exec(svc); return m ? m[1] + m[2] : svc; };
  // Offset of a port from its Lst/Utc pair, normalised to −12h..+14h.
  const offsetMin = (lst, utc) => { let o = clock(lst) - clock(utc); while (o <= -12 * 60) o += 1440; while (o > 14 * 60) o -= 1440; return o; };
  const toUtcMs = (isoLocalDate, lstHHMM, offMin) => dateObj(isoLocalDate).getTime() + (clock(lstHHMM) - offMin) * 60000;

  function hashStr(str) { // FNV-1a 64-bit → 16 hex chars (valid Google event-id chars)
    let h1 = 0x811c9dc5, h2 = 0xcbf29ce4;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= c; h2 = Math.imul(h2 ^ (h1 >>> 7), 0x01000193) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  /* ---------- parsing ---------- */
  function parseRoster(rawText, fileName) {
    const text = String(rawText).replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const warnings = [];
    const r = { fileName: fileName || '', warnings };

    const ts = /(\d{1,2}) ([A-Za-z]{3}) (\d{4})\s+(\d{2}):(\d{2})/.exec(text.slice(0, 2000));
    if (!ts) throw new Error('Not a WebCIS roster export (no report timestamp found).');
    r.exportYear = +ts[3]; r.exportMonth = MONTHS[ts[2].toUpperCase()];
    r.exportedAt = `${isoDate(+ts[3], r.exportMonth, +ts[1])}T${ts[4]}:${ts[5]}`; // local (base) time, as printed

    const bp = /BID PERIOD\s+(\d+)/.exec(text); if (!bp) throw new Error('No bid period found.');
    r.bidPeriod = bp[1];
    const nm = /Name:\s+(.+?)\s{2,}Staff No:\s*(\S+)/.exec(text); if (!nm) throw new Error('No crew name / staff number found.');
    r.name = nm[1].trim(); r.staffNo = nm[2].trim();
    r.base = (/Base:\s+([A-Z]{3})/.exec(text) || [])[1] || '';
    const hdr = (label) => { const m = new RegExp(label + '\\s*:\\s*(\\d+:\\d{2})').exec(text); return m ? m[1] : null; };
    r.header = { planned: hdr('Plnd Hours'), projected: hdr('Projected'), minGuarantee: hdr('Min Guarantee') };
    for (const [k, v] of Object.entries(r.header)) {
      if (v && hhmmToMin(v) == null || (v && +v.split(':')[1] > 59)) warnings.push(`Header ${k} "${v}" is not a valid hh:mm.`);
    }
    const fn = /webCisRoster_(\d+)_(\d{2})(\d{2})(\d{4})/i.exec(r.fileName);
    if (fn && fn[1] !== r.staffNo) warnings.push(`File name staff no ${fn[1]} differs from header ${r.staffNo}.`);
    const un = /No Unnotified Duties exist/.test(text);
    if (!un) warnings.push('File lists unnotified duties — they are not yet interpreted.');

    // --- daily grid ---
    const gi = lines.findIndex((l) => /^Date\s+Duty\s+Detail/.test(l));
    if (gi < 0) throw new Error('Roster grid not found.');
    const cols = [];
    for (let i = gi + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^-{10,}/.test(l) || /END OF REPORT/.test(l)) break;
      if (!l.trim()) continue;
      l.split('|').forEach((seg, c) => { (cols[c] = cols[c] || []).push(seg); });
    }
    const rows = [].concat(...cols).filter((s) => /^\d{2}\/\d{2}/.test(s));
    // year inference: export year = bid-period start month; roll forward if start month is
    // clearly "before" the export month (Dec export of a Jan period) and across Dec→Jan.
    let year = r.exportYear, prevMonth = null;
    const firstMonth = rows.length ? +rows[0].slice(3, 5) : r.exportMonth;
    if (firstMonth < r.exportMonth && r.exportMonth - firstMonth > 6) year += 1;
    r.days = rows.map((seg) => {
      const dd = +seg.slice(0, 2), mm = +seg.slice(3, 5);
      if (prevMonth != null && mm < prevMonth) year += 1;
      prevMonth = mm;
      const f = (a, b) => seg.slice(a, b).trim();
      const day = { date: isoDate(year, mm, dd), code: f(8, 18), detail: f(18, 26), rept: f(26, 31), end: f(31, 36), credit: f(36, 46) };
      if (!/^\d{4}$/.test(day.rept)) day.rept = ''; if (!/^\d{4}$/.test(day.end)) day.end = '';
      return day;
    });
    if (!r.days.length) throw new Error('Roster grid has no days.');
    r.startDate = r.days[0].date; r.endDate = r.days[r.days.length - 1].date;
    if (r.days.some((d) => DOW_NAMES[dowOf(d.date)][0] !== (rows[r.days.indexOf(d)][6] || '?')))
      warnings.push('Some weekday letters do not match the inferred year — check the export date.');

    // --- pattern blocks ---
    r.patterns = {};
    for (let i = 0; i < lines.length; i++) {
      const pm = /^\|\*\s*Pattern:\s*(\S+)/.exec(lines[i]); if (!pm) continue;
      const p = { code: pm[1], sectors: [], totals: {} };
      for (let j = i + 1; j < lines.length && !/^\|\*\s*Pattern:/.test(lines[j]); j++) {
        const l = lines[j];
        const s = /^\s*(\d)\s+(\S+)\s+(\S)\s+(?:(P)\s+)?([A-Z]{3})\/([A-Z]{3})\s+(\d{4})\s+([A-Z]{2})\s+(\d{4})\s+(\d{4})\s+([A-Z]{2})\s+(\d{4})\s+(\d{4})(.*)$/.exec(l);
        if (s) {
          const tail = (s[14].match(/\d+:\d{2}/g) || []);
          p.sectors.push({
            service: s[2], flight: flightLabel(s[2]), cls: s[3], positioning: !!s[4], from: s[5], to: s[6],
            report: s[7], depDay: s[8], depLst: s[9], depUtc: s[10], arrDay: s[11], arrLst: s[12], arrUtc: s[13],
            dutyHours: tail.length >= 2 ? tail[tail.length - 2] : null, credit: tail.length ? tail[tail.length - 1] : null,
            slip: tail.length >= 4 ? tail[0] : null,
          });
          continue;
        }
        const rc = /Route Code:\s*(\S+)/.exec(l); if (rc) p.routeCode = rc[1];
        const da = /Days Away:\s*(\d+)/.exec(l); if (da) p.totals.daysAway = +da[1];
        const tc = /Applicable Credit:\s*(\d+:\d{2})/.exec(l); if (tc) p.totals.credit = tc[1];
        const dh = /Duty Hrs:\s*(\d+:\d{2})/.exec(l); if (dh) p.totals.dutyHours = dh[1];
      }
      r.patterns[p.code] = p;
    }

    // --- classify days and assemble trips ---
    r.trips = [];
    let cur = null;
    r.days.forEach((d, idx) => {
      const known = DAY_CODES[d.code];
      if (known) { d.kind = known.kind; cur = null; return; }
      if (!d.code) { d.kind = 'blank'; cur = null; return; }
      const isPattern = !!r.patterns[d.code];
      if (!isPattern) { d.kind = 'other'; cur = null; warnings.push(`Unknown duty code "${d.code}" on ${d.date}.`); return; }
      d.kind = 'trip';
      if (!cur || cur.pattern !== d.code || d.rept) {
        cur = { pattern: d.code, startDate: d.date, detail: d.detail, rept: d.rept, credit: d.credit, end: '', days: [] };
        r.trips.push(cur);
      }
      cur.days.push(d.date); d.tripIndex = r.trips.length - 1;
      if (d.end) { cur.end = d.end; cur.endDate = d.date; cur = null; }
    });
    r.trips.forEach((t) => {
      t.endDate = t.endDate || t.days[t.days.length - 1];
      t.key = `${t.startDate}|${t.pattern}`;
      resolveSectors(t, r.patterns[t.pattern], r, warnings);
      t.dayInfo = t.days.map((date, i) => ({ date, n: i + 1, of: t.days.length, label: dayLabel(t, date) }));
    });
    r.id = `${r.staffNo}|${r.bidPeriod}|${r.exportedAt}`;
    return r;
  }

  function resolveSectors(trip, pat, r, warnings) {
    trip.sectors = [];
    if (!pat || !pat.sectors.length) { warnings.push(`Pattern ${trip.pattern} has no sector detail.`); return; }
    let cursor = trip.startDate;
    const nextDow = (from, code) => { let d = from; for (let k = 0; k < 8; k++) { if (dowOf(d) === DOW[code]) return d; d = addDays(d, 1); } return from; };
    pat.sectors.forEach((s, i) => {
      const depDate = nextDow(cursor, s.depDay);
      const arrDate = nextDow(depDate, s.arrDay);
      const depOff = offsetMin(s.depLst, s.depUtc), arrOff = offsetMin(s.arrLst, s.arrUtc);
      const depMs = toUtcMs(depDate, s.depLst, depOff), arrMs = toUtcMs(arrDate, s.arrLst, arrOff);
      let lead = clock(s.depLst) - clock(s.report); if (lead < 0) lead += 1440;
      const sec = Object.assign({}, s, { idx: i, depDate, arrDate, depOff, arrOff, depMs, arrMs, reportMs: depMs - lead * 60000 });
      if (arrMs <= depMs) warnings.push(`${trip.pattern} ${s.flight}: arrival is not after departure — check day codes.`);
      if (trip.days.indexOf(depDate) < 0 && depDate !== trip.startDate) warnings.push(`${trip.pattern} ${s.flight} departs ${depDate}, outside the rostered days.`);
      trip.sectors.push(sec);
      cursor = arrDate;
    });
    const first = trip.sectors[0], last = trip.sectors[trip.sectors.length - 1];
    const baseOff = first.from === r.base ? first.depOff : (last.to === r.base ? last.arrOff : first.depOff);
    trip.baseOff = baseOff;
    trip.reportMs = trip.rept ? toUtcMs(trip.startDate, trip.rept, baseOff) : first.reportMs;
    trip.signOffMs = trip.end ? toUtcMs(trip.endDate, trip.end, baseOff) : last.arrMs;
    if (trip.signOffMs < last.arrMs) trip.signOffMs += 86400000; // sign-off after midnight
  }

  function dayLabel(trip, date) {
    const deps = trip.sectors.filter((s) => s.depDate === date);
    if (deps.length) return [deps[0].from].concat(deps.map((s) => s.to)).join('→');
    const prior = trip.sectors.filter((s) => s.arrDate <= date).pop();
    return prior ? `${prior.to} layover` : '';
  }

  /* ---------- comparison ---------- */
  const sectorSig = (s) => `${s.flight} ${s.from}-${s.to} ${s.depLst}/${s.arrLst}${s.positioning ? ' P' : ''}`;

  function compareRosters(oldR, newR) {
    const out = { from: oldR && oldR.id, to: newR.id, trips: [], days: {}, header: [], count: 0 };
    if (!oldR) return out;
    const oldTrips = oldR.trips.slice(), newTrips = newR.trips.slice();
    const used = new Set();
    const pairs = [];
    // 1) same start date + same pattern
    newTrips.forEach((n) => { const o = oldTrips.find((t) => !used.has(t) && t.key === n.key); if (o) { used.add(o); pairs.push([o, n, 'same']); } });
    // 2) same start date, different pattern → renamed; 3) overlapping dates → changed
    newTrips.forEach((n) => {
      if (pairs.some((p) => p[1] === n)) return;
      let o = oldTrips.find((t) => !used.has(t) && t.startDate === n.startDate);
      if (!o) o = oldTrips.find((t) => !used.has(t) && t.days.some((d) => n.days.includes(d)));
      if (o) { used.add(o); pairs.push([o, n, o.pattern !== n.pattern ? 'renamed' : 'same']); }
    });
    pairs.forEach(([o, n, how]) => {
      const fields = [];
      const f = (label, a, b) => { if ((a || '') !== (b || '')) fields.push({ label, from: a || '—', to: b || '—' }); };
      if (how === 'renamed') f('Pattern', o.pattern, n.pattern);
      f('Start date', o.startDate, n.startDate); f('End date', o.endDate, n.endDate);
      f('Report', fmtClock(o.rept), fmtClock(n.rept)); f('Sign-off', fmtClock(o.end), fmtClock(n.end));
      f('Credit', o.credit, n.credit); f('Detail', o.detail, n.detail);
      const len = Math.max(o.sectors.length, n.sectors.length);
      for (let i = 0; i < len; i++) {
        const a = o.sectors[i], b = n.sectors[i], lab = `Sector ${i + 1}`;
        if (!a) { fields.push({ label: lab, from: '—', to: sectorSig(b) }); continue; }
        if (!b) { fields.push({ label: lab, from: sectorSig(a), to: '—' }); continue; }
        if (a.flight !== b.flight) f(`${lab} flight`, a.flight, b.flight);
        if (a.from + a.to !== b.from + b.to) f(`${lab} route`, `${a.from}–${a.to}`, `${b.from}–${b.to}`);
        if (a.depMs !== b.depMs) f(`${b.flight} departs`, `${fmtClock(a.depLst)} ${a.from}`, `${fmtClock(b.depLst)} ${b.from}`);
        if (a.arrMs !== b.arrMs) f(`${b.flight} arrives`, `${fmtClock(a.arrLst)} ${a.to}`, `${fmtClock(b.arrLst)} ${b.to}`);
        if (a.positioning !== b.positioning) f(`${b.flight} positioning`, a.positioning ? 'yes' : 'no', b.positioning ? 'yes' : 'no');
      }
      if (fields.length) {
        const timesOnly = how === 'same' && fields.every((x) => /Report|Sign-off|departs|arrives/.test(x.label));
        out.trips.push({ type: how === 'renamed' ? 'renamed' : (timesOnly ? 'retimed' : 'changed'), old: o, new: n, fields, date: n.startDate });
      }
    });
    oldTrips.filter((t) => !used.has(t)).forEach((o) => out.trips.push({ type: 'removed', old: o, fields: [], date: o.startDate }));
    newTrips.filter((n) => !pairs.some((p) => p[1] === n)).forEach((n) => out.trips.push({ type: 'added', new: n, fields: [], date: n.startDate }));
    out.trips.sort((a, b) => a.date.localeCompare(b.date));

    // day-level marks for the grid
    const om = Object.fromEntries(oldR.days.map((d) => [d.date, d])), nm = Object.fromEntries(newR.days.map((d) => [d.date, d]));
    new Set([...Object.keys(om), ...Object.keys(nm)]).forEach((date) => {
      const a = om[date], b = nm[date];
      if (!a) { out.days[date] = { type: 'added' }; return; }
      if (!b) { out.days[date] = { type: 'removed', was: a.code }; return; }
      if (a.code !== b.code) out.days[date] = { type: 'changed', was: a.code };
    });
    out.trips.forEach((c) => {
      if (c.type === 'removed') return;
      const t = c.new; t.days.forEach((d) => { if (!out.days[d]) out.days[d] = { type: c.type, was: c.old ? c.old.pattern : '' }; });
    });
    ['planned', 'projected'].forEach((k) => {
      if (oldR.header[k] !== newR.header[k]) out.header.push({ label: k === 'planned' ? 'Planned hours' : 'Projected hours', from: oldR.header[k], to: newR.header[k] });
    });
    out.count = out.trips.length + out.header.length +
      Object.entries(out.days).filter(([d, v]) => !newR.trips.some((t) => t.days.includes(d)) && !(oldR.trips.some((t) => t.days.includes(d)))).length;
    return out;
  }

  /* ---------- library: group many exports ---------- */
  function buildLibrary(rosters) {
    const byKey = {};
    rosters.forEach((r) => {
      const k = `${r.staffNo}|${r.bidPeriod}`;
      (byKey[k] = byKey[k] || { staffNo: r.staffNo, name: r.name, bidPeriod: r.bidPeriod, exports: [] }).exports.push(r);
    });
    const periods = Object.values(byKey).map((p) => {
      const seen = new Set();
      p.exports = p.exports.sort((a, b) => a.exportedAt.localeCompare(b.exportedAt) || a.fileName.localeCompare(b.fileName))
        .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
      const latest = p.exports[p.exports.length - 1];
      p.latest = latest; p.startDate = latest.startDate; p.endDate = latest.endDate; p.name = latest.name;
      p.history = p.exports.map((e, i) => ({ roster: e, diff: i ? compareRosters(p.exports[i - 1], e) : null }));
      return p;
    });
    return periods.sort((a, b) => b.startDate.localeCompare(a.startDate));
  }

  /* ---------- calendar event plan ---------- */
  function eventPlan(roster, opts) {
    opts = opts || {};
    const ev = [];
    const staff = roster.staffNo, bid = roster.bidPeriod;
    const mk = (key, body) => {
      const sig = JSON.stringify(body);
      ev.push(Object.assign(body, {
        id: 'rq' + hashStr(`${staff}|${key}`) + hashStr(`${key}|${staff}`).slice(0, 8),
        extendedProperties: { private: { rqApp: '1', rqStaff: staff, rqBid: bid, rqKey: key, rqHash: hashStr(sig) } },
      }));
    };
    const allDay = (date) => ({ start: { date }, end: { date: addDays(date, 1) } });
    roster.days.forEach((d) => {
      const c = DAY_CODES[d.code];
      if (c) {
        const desc = [`${c.label}`, d.code === 'R-' && d.rept ? `Listed ${fmtClock(d.rept)}–${fmtClock(d.end)}` : '', `Bid period ${bid} · ${roster.name} (${staff})`].filter(Boolean).join('\n');
        mk(`D|${d.date}`, Object.assign({ summary: c.calTitle, description: desc, colorId: c.colorId, transparency: 'transparent' }, allDay(d.date)));
      } else if (d.kind === 'other') {
        mk(`D|${d.date}`, Object.assign({ summary: d.code, description: `Duty code ${d.code} (not recognised)\nBid period ${bid}`, colorId: COLOR.other, transparency: 'transparent' }, allDay(d.date)));
      }
    });
    roster.trips.forEach((t) => {
      const route = t.sectors.map((s) => s.flight).join('/');
      t.dayInfo.forEach((di) => {
        mk(`D|${di.date}`, Object.assign({
          summary: `${t.pattern} · Day ${di.n}/${di.of}${di.label ? ' · ' + di.label : ''}`,
          description: [`Trip ${t.pattern} (${route}) ${t.startDate} → ${t.endDate}`, `Report ${fmtClock(t.rept)} ${roster.base} · Sign-off ${fmtClock(t.end)} ${roster.base}`, `Credit ${t.credit || '—'} · Bid period ${bid}`].join('\n'),
          colorId: COLOR.tripDay, transparency: 'transparent',
        }, allDay(di.date)));
      });
      t.sectors.forEach((s, i) => {
        const lines = [];
        if (i === 0) lines.push(`Report ${fmtClock(t.rept || s.report)} ${s.from} (local)`);
        lines.push(`${s.flight} ${s.from}→${s.to}${s.positioning ? ' · positioning (P)' : ''}`,
          `Departs ${fmtClock(s.depLst)} ${s.from} local · Arrives ${fmtClock(s.arrLst)} ${s.to} local`,
          s.dutyHours ? `Duty ${s.dutyHours}` : '');
        if (i === t.sectors.length - 1) lines.push(`Sign-off ${fmtClock(t.end)} ${roster.base} (local)`);
        lines.push(`Trip ${t.pattern} · sector ${i + 1}/${t.sectors.length} · Bid period ${bid}`);
        const body = {
          summary: `✈ ${s.flight} ${s.from}–${s.to}${s.positioning ? ' (P)' : ''} · ${t.pattern}`,
          description: lines.filter(Boolean).join('\n'),
          location: `${s.from} → ${s.to}`,
          colorId: COLOR.sector,
          start: { dateTime: new Date(s.depMs).toISOString().replace('.000', '') },
          end: { dateTime: new Date(s.arrMs).toISOString().replace('.000', '') },
        };
        if (opts.reminderMin != null && opts.reminderMin >= 0) {
          const lead = Math.round((s.depMs - s.reportMs) / 60000);
          body.reminders = { useDefault: false, overrides: i === 0 ? [{ method: 'popup', minutes: Math.min(40320, lead + opts.reminderMin) }] : [] };
        }
        mk(`S|${t.startDate}|${i}`, body);
      });
    });
    return ev;
  }

  // Desired events vs events already in the calendar (only ones this app created).
  function syncPlan(desired, existing) {
    const ex = new Map(existing.map((e) => [e.id, e]));
    const plan = { create: [], update: [], remove: [], keep: [] };
    desired.forEach((d) => {
      const e = ex.get(d.id);
      if (!e || e.status === 'cancelled') plan.create.push(d);
      else if ((e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.rqHash) !== d.extendedProperties.private.rqHash) plan.update.push(d);
      else plan.keep.push(d);
      ex.delete(d.id);
    });
    ex.forEach((e) => { if (e.status !== 'cancelled') plan.remove.push(e); });
    return plan;
  }

  const api = { parseRoster, compareRosters, buildLibrary, eventPlan, syncPlan, DAY_CODES, COLOR, fmtClock, addDays, dowOf, DOW_NAMES, hhmmToMin, minToHhmm, hashStr };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RosterCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
