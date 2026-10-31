/* Roster Sync — core logic (no DOM). Parses Qantas WebCIS "csRoster" exports,
   compares exports, and builds the Google Calendar event plan.
   Works in the browser (window.RosterCore) and in Node (module.exports). */
(function (root) {
  'use strict';

  const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
  const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Roster codes from the corporate "Rostering & Operational Information" document, §4.1–4.4.
  // Anything else that has a pattern block is a trip; anything else again is "other" (flagged).
  // kind = colour/behaviour group. Google Calendar colour ids: 1 Lavender, 2 Sage, 5 Banana,
  // 6 Tangerine, 7 Peacock, 8 Graphite, 9 Blueberry, 11 Tomato, 3 Grape.
  const KIND_COLOR = { available: '6', standby: '5', off: '2', reserve: '8', leave: '1', fail: '11', trip: '7', sector: '9', other: '3' };
  const KIND_LABEL = { trip: 'Flying', available: 'Available', standby: 'Standby', off: 'Day off', reserve: 'Reserve block', leave: 'Leave', fail: 'Failed obligation', other: 'Unrecognised' };
  const dc = (kind, label, calTitle, extra) => Object.assign({ kind, label, calTitle, colorId: KIND_COLOR[kind] }, extra || {});
  const DAY_CODES = {
    'A':    dc('available', 'Available day', 'Available (A)'),
    'X':    dc('off', 'Day off', 'Day off (X)'),
    'RX':   dc('off', 'Redesignated day off', 'Day off (RX)'),
    'SR':   dc('standby', 'Standby duty', 'Standby (SR)', { times: 'file' }),
    'S/':   dc('standby', 'Standby duty 04:00–16:00', 'Standby (S/)', { times: ['0400', '1600'] }),
    '/S':   dc('standby', 'Standby duty 10:00–22:00', 'Standby (/S)', { times: ['1000', '2200'] }),
    'SS':   dc('standby', 'Standby duty 11:30–23:30', 'Standby (SS)', { times: ['1130', '2330'] }),
    'R-':   dc('reserve', 'Reserve block', 'Reserve block starts (R-)'),
    'AL':   dc('leave', 'Annual leave', 'Annual leave (AL)'),
    'SL':   dc('leave', 'Sick leave', 'Sick leave (SL)'),
    'US':   dc('leave', 'Unpaid sick leave', 'Unpaid sick leave (US)'),
    'UL':   dc('leave', 'Upline sickness', 'Upline sickness (UL)'),
    'CHL':  dc('leave', 'Child care leave', 'Child care leave (CHL)'),
    'SPL':  dc('leave', 'Shared parental leave', 'Shared parental leave (SPL)'),
    'DL':   dc('leave', 'Defence leave (NS reservist)', 'Defence leave (DL)'),
    'LWOP': dc('leave', 'Leave without pay', 'Leave without pay (LWOP)'),
    'UN':   dc('fail', 'Failed obligation', 'Failed obligation (UN)'),
  };
  // Upline standby ESxx (§4.4): 12 hours from xx:00 local port time, e.g. ES04 = 04:00–16:00.
  const codeInfo = (code) => {
    if (DAY_CODES[code]) return DAY_CODES[code];
    const es = /^ES(\d{2})$/.exec(code || '');
    if (es && +es[1] < 24) { const h = +es[1], e = (h + 12) % 24; return dc('standby', `Upline standby ${pad(h)}:00–${pad(e)}:00 local`, `Upline standby (${code})`, { times: [pad(h) + '00', pad(e) + '00'], upline: true }); }
    return null;
  };
  const COLOR = { sector: KIND_COLOR.sector, tripDay: KIND_COLOR.trip, other: KIND_COLOR.other };
  const RESERVE_BLOCK_DAYS = 7; // §4.1: five A days + two X days
  const SIGNOFF_AFTER_ARRIVAL = 30; // minutes; observed on every sector of the original export

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
  // Clock time / date of an instant at a fixed UTC offset (e.g. SIN +480)
  const clockAt = (ms, offMin) => new Date(ms + offMin * 60000).toISOString().slice(11, 16);
  const dateAt = (ms, offMin) => new Date(ms + offMin * 60000).toISOString().slice(0, 10);

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
      const known = codeInfo(d.code);
      if (known) {
        d.kind = known.kind; d.info = known;
        if (!known.upline) cur = null; // upline standby sits inside a pattern; keep the trip open
        return;
      }
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
    // base (home) UTC offset: from any sector touching base, else SIN +8
    const anySec = [].concat(...r.trips.map((t) => t.sectors));
    const bs = anySec.find((s) => s.from === r.base) || anySec.find((s) => s.to === r.base);
    r.baseOff = bs ? (bs.from === r.base ? bs.depOff : bs.arrOff) : 480;

    // reserve blocks (§4.1): R- marks day 1 of a 7-day block (five A days + two X days)
    r.days.forEach((d, i) => {
      if (d.code !== 'R-') return;
      const n = Math.min(RESERVE_BLOCK_DAYS, r.days.length - i);
      for (let k = 0; k < n; k++) r.days[i + k].reserve = { start: d.date, end: r.days[i + n - 1].date, n: k + 1, of: n };
      if (n < RESERVE_BLOCK_DAYS) warnings.push(`Reserve block starting ${d.date} runs past the end of this bid period.`);
    });

    // standby duties with times (§4.3, §4.4)
    r.standbys = [];
    r.days.forEach((d) => {
      if (d.kind !== 'standby') return;
      let st, en;
      if (d.info.times === 'file') { st = d.rept; en = d.end; } else { [st, en] = d.info.times; }
      if (!st || !en) { d.standby = null; return; }
      let off = r.baseOff, port = r.base;
      if (d.info.upline) { // port local time: the port of the last arrival before this day
        const prior = anySec.filter((s) => s.arrDate <= d.date).sort((a, b) => a.arrMs - b.arrMs).pop();
        if (prior) { off = prior.arrOff; port = prior.to; } else warnings.push(`Upline standby on ${d.date}: could not tell which port it is at.`);
      }
      const startMs = toUtcMs(d.date, st, off); let endMs = toUtcMs(d.date, en, off);
      if (endMs <= startMs) endMs += 86400000; // crosses midnight
      d.standby = { startMs, endMs, port, off, st, en };
      r.standbys.push(Object.assign({ date: d.date, code: d.code }, d.standby));
      if (endMs - startMs > 16 * 3600000) warnings.push(`Standby ${d.code} on ${d.date} is longer than 16 hours.`);
    });

    r.id = `${r.staffNo}|${r.bidPeriod}|${r.exportedAt}`;
    r.checks = checkRules(r);
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
    // Per-flight sign-off = report + duty hours (from the file). In the original export this always
    // equals arrival + 30 min; a mismatch means the file is inconsistent, so warn and fall back.
    trip.sectors.forEach((s, i) => {
      const viaArr = s.arrMs + SIGNOFF_AFTER_ARRIVAL * 60000;
      const dh = hhmmToMin(s.dutyHours);
      s.signOffMs = dh != null ? s.reportMs + dh * 60000 : viaArr;
      if (dh != null && s.signOffMs !== viaArr) {
        warnings.push(`${trip.pattern} ${s.flight}: report ${fmtClock(s.report)} + duty ${s.dutyHours} gives a sign-off ${Math.round((s.signOffMs - viaArr) / 60000)} min from arrival + 30. Using arrival + 30 min.`);
        s.signOffMs = viaArr; s.signOffCheck = false;
      }
      if (s.reportMs >= s.depMs) warnings.push(`${trip.pattern} ${s.flight}: report time is not before departure.`);
    });
    trip.sectors.forEach((s, i) => {
      const nx = trip.sectors[i + 1];
      if (!nx) return;
      s.layoverMin = Math.round((nx.reportMs - s.signOffMs) / 60000);
      s.layoverPort = s.to;
      const slip = hhmmToMin(s.slip);
      if (slip != null && slip !== s.layoverMin) warnings.push(`${trip.pattern} ${s.to} layover: Slip Time ${s.slip} differs from sign-off → next report ${minToHhmm(s.layoverMin)}.`);
      if (s.layoverMin <= 0) warnings.push(`${trip.pattern}: ${nx.flight} reports before ${s.flight} signs off.`);
    });
    const first = trip.sectors[0], last = trip.sectors[trip.sectors.length - 1];
    const baseOff = first.from === r.base ? first.depOff : (last.to === r.base ? last.arrOff : first.depOff);
    trip.baseOff = baseOff;
    trip.reportMs = trip.rept ? toUtcMs(trip.startDate, trip.rept, baseOff) : first.reportMs;
    trip.signOffMs = trip.end ? toUtcMs(trip.endDate, trip.end, baseOff) : last.signOffMs;
    if (trip.signOffMs < last.arrMs) trip.signOffMs += 86400000; // sign-off after midnight
    if (first.from === r.base && trip.reportMs !== first.reportMs) warnings.push(`${trip.pattern}: roster report ${fmtClock(trip.rept)} differs from ${first.flight} report ${fmtClock(first.report)}.`);
    if (last.to === r.base && trip.signOffMs !== last.signOffMs) warnings.push(`${trip.pattern}: roster sign-off ${fmtClock(trip.end)} differs from ${last.flight} sign-off.`);
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
        if (a.reportMs !== b.reportMs) f(`${b.flight} report`, `${fmtClock(a.report)} ${a.from}`, `${fmtClock(b.report)} ${b.from}`);
        if (a.depMs !== b.depMs) f(`${b.flight} departs`, `${fmtClock(a.depLst)} ${a.from}`, `${fmtClock(b.depLst)} ${b.from}`);
        if (a.arrMs !== b.arrMs) f(`${b.flight} arrives`, `${fmtClock(a.arrLst)} ${a.to}`, `${fmtClock(b.arrLst)} ${b.to}`);
        if (a.positioning !== b.positioning) f(`${b.flight} positioning`, a.positioning ? 'yes' : 'no', b.positioning ? 'yes' : 'no');
      }
      if (fields.length) {
        const timesOnly = how === 'same' && fields.every((x) => /report|sign-off|departs|arrives/i.test(x.label));
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
    const iso = (ms) => new Date(ms).toISOString().replace('.000', '');
    const bt = (ms) => clockAt(ms, roster.baseOff); // base (SIN) clock time
    const reserveNote = (d) => (d.reserve ? `Reserve block day ${d.reserve.n}/${d.reserve.of} (${d.reserve.start} → ${d.reserve.end})` : '');
    roster.days.forEach((d) => {
      const c = d.info;
      if (c && d.kind === 'standby' && d.standby) {
        const sb = d.standby;
        const desc = [c.label, `${fmtClock(sb.st)}–${fmtClock(sb.en)} ${sb.port} local`,
          sb.off !== roster.baseOff ? `${bt(sb.startMs)}–${bt(sb.endMs)} ${roster.base}` : '',
          'Report ready to operate within 90 min of contact (§4.3).', reserveNote(d), `Bid period ${bid} · ${roster.name} (${staff})`].filter(Boolean).join('\n');
        const body = { summary: c.calTitle, description: desc, colorId: c.colorId, start: { dateTime: iso(sb.startMs) }, end: { dateTime: iso(sb.endMs) } };
        if (opts.reminderMin != null && opts.reminderMin >= 0) body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: Math.min(40320, opts.reminderMin) }] };
        mk(`D|${d.date}`, body);
      } else if (c) {
        const desc = [c.label,
          d.code === 'R-' ? `Seven-day reserve block (five A days, two X days): ${d.reserve.start} → ${d.reserve.end}. A days may be converted to standby.` : '',
          d.code === 'R-' && d.rept ? `Listed ${fmtClock(d.rept)}–${fmtClock(d.end)} in WebCIS` : '',
          d.code === 'A' ? 'Stay contactable 00:01–23:59; a duty needs at least 8 hours’ notice (§4.2).' : '',
          d.code !== 'R-' ? reserveNote(d) : '',
          `Bid period ${bid} · ${roster.name} (${staff})`].filter(Boolean).join('\n');
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
        const local = (ms, off, port) => `${clockAt(ms, off)} ${port}` + (off !== roster.baseOff ? ` (${bt(ms)} ${roster.base})` : '');
        const lines = [
          `${s.flight} ${s.from}→${s.to}${s.positioning ? ' · positioning (paxing)' : ''}`,
          `Report   ${local(s.reportMs, s.depOff, s.from)}`,
          `Departs  ${local(s.depMs, s.depOff, s.from)}`,
          `Arrives  ${local(s.arrMs, s.arrOff, s.to)}`,
          `Sign-off ${local(s.signOffMs, s.arrOff, s.to)}`,
          s.dutyHours ? `Duty ${s.dutyHours}` : '',
          s.layoverMin != null ? `Layover ${s.to} ${minToHhmm(s.layoverMin)} until next report` : '',
          'Local times are airport time.',
          `Trip ${t.pattern} · sector ${i + 1}/${t.sectors.length} · Bid period ${bid}`,
        ];
        const body = {
          summary: `✈ ${s.flight} ${s.from}–${s.to}${s.positioning ? ' (P)' : ''} · ${t.pattern}`,
          description: lines.filter(Boolean).join('\n'),
          location: `${s.from} → ${s.to}`,
          colorId: COLOR.sector,
          start: { dateTime: iso(s.reportMs) },
          end: { dateTime: iso(s.signOffMs) },
        };
        if (opts.reminderMin != null && opts.reminderMin >= 0) {
          body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: Math.min(40320, opts.reminderMin) }] };
        }
        mk(`S|${t.startDate}|${i}`, body);
      });
    });
    return ev;
  }

  /* ---------- advisory rule checks (corporate doc §4.5, §4.10, §4.11) ---------- */
  // Warnings only — they never block a sync. Each check: { id, rule, ok, text, date? }
  const DUTY_LIMITS = { // planned hours, §4.10
    multi: { label: 'Multi-sector', max: 18 * 60 },
    single: { label: 'Single sector', max: 24 * 60 },
    opDh: { label: 'Operate to deadhead', max: 26 * 60 },
    dhOp: { label: 'Deadhead to operate', max: 18 * 60 },
    dh: { label: 'Pure deadhead', max: 26 * 60 },
  };
  const minRestFor = (dutyMin, deadhead) => { // §4.11 planned rest at home base
    if (deadhead) return { min: 12 * 60, band: 'deadhead' };
    if (dutyMin <= 14 * 60) return { min: 12 * 60, band: 'duty up to 14:00' };
    if (dutyMin <= 18 * 60) return { min: 16 * 60, band: 'duty 14:01–18:00' };
    return { min: 22 * 60, band: 'duty over 18:00' };
  };
  // A duty = consecutive sectors with no layover (no Slip Time) between them.
  function dutiesOf(trip) {
    const out = []; let cur = null;
    trip.sectors.forEach((s, i) => {
      if (!cur) { cur = { sectors: [] }; out.push(cur); }
      cur.sectors.push(s);
      const last = i === trip.sectors.length - 1;
      if (last || s.slip || (s.layoverMin != null && s.layoverMin >= 4 * 60)) cur = null;
    });
    out.forEach((d) => {
      const a = d.sectors[0], b = d.sectors[d.sectors.length - 1];
      d.reportMs = a.reportMs; d.signOffMs = b.signOffMs; d.minutes = Math.round((d.signOffMs - d.reportMs) / 60000);
      const dh = d.sectors.map((s) => s.positioning);
      d.type = d.sectors.length === 1 ? (dh[0] ? 'dh' : 'single')
        : dh.every(Boolean) ? 'dh' : dh.every((x) => !x) ? 'multi' : dh[dh.length - 1] && !dh[0] ? 'opDh' : 'dhOp';
      d.label = d.sectors.map((s) => s.flight).join('/');
    });
    return out;
  }

  function checkRules(r) {
    const checks = [];
    // X days: 16 per 56-day roster period (§4.1, §4.5); scaled for other period lengths.
    const offDays = r.days.filter((d) => d.code === 'X' || d.code === 'RX').length;
    const needX = Math.round((16 * r.days.length) / 56);
    checks.push({ id: 'xdays', rule: 'Days off (§4.5)', ok: offDays >= needX,
      text: `${offDays} days off (X/RX) in ${r.days.length} days; at least ${needX} expected.` });
    // Duty limits per duty (§4.10, planned)
    const over = [];
    r.trips.forEach((t) => dutiesOf(t).forEach((d) => {
      const lim = DUTY_LIMITS[d.type];
      if (d.minutes > lim.max) over.push(`${t.pattern} ${d.label}: ${minToHhmm(d.minutes)} exceeds ${lim.label.toLowerCase()} limit ${minToHhmm(lim.max)}`);
    }));
    const nDuties = r.trips.reduce((a, t) => a + dutiesOf(t).length, 0);
    checks.push({ id: 'duty', rule: 'Duty limits (§4.10)', ok: !over.length, text: over.length ? over.join('; ') + '.' : `All ${nDuties} duties are within planned limits.` });
    // Home-base minimum rest after a pattern (§4.11): planned duty length = last duty back into base.
    const starts = [].concat(
      r.trips.map((t) => ({ ms: t.reportMs, what: `${t.pattern} report` })),
      r.standbys.map((s) => ({ ms: s.startMs, what: `standby ${s.code}` }))).sort((a, b) => a.ms - b.ms);
    const short = []; let n = 0;
    r.trips.forEach((t) => {
      const last = t.sectors[t.sectors.length - 1]; if (!last || last.to !== r.base) return;
      const ds = dutiesOf(t), lastDuty = ds[ds.length - 1];
      const req = minRestFor(lastDuty.minutes, lastDuty.type === 'dh');
      const next = starts.find((s) => s.ms > t.signOffMs);
      if (!next) return;
      n++;
      const rest = Math.round((next.ms - t.signOffMs) / 60000);
      if (rest < req.min) short.push(`after ${t.pattern} (${req.band}): ${minToHhmm(rest)} before ${next.what}, ${minToHhmm(req.min)} required`);
    });
    checks.push({ id: 'rest', rule: 'Home-base minimum rest (§4.11)', ok: !short.length,
      text: short.length ? short.join('; ') + '.' : n ? `Rest after all ${n} patterns meets the planned minimum.` : 'No pattern is followed by another duty in this export.' });
    return checks;
  }

  /* ---------- allowance estimates (corporate "Pay & Benefits" §2.3–2.5) ---------- */
  const ALLOWANCE_DEFAULTS = { miscSGD: 50, transportSGD: 25, mealRate: 50, mealCurrency: 'AUD', portRates: {}, fx: null, mealsProvided: {} };
  const monthOf = (iso) => iso.slice(0, 7);
  const payDateFor = (month) => { const [y, m] = month.split('-').map(Number); return m === 12 ? `${y + 1}-01-23` : `${y}-${pad(m + 1)}-23`; };
  // Meal allowance for one layover (§2.4)
  function mealAmount(minutes, rate) {
    if (minutes <= 12 * 60) return { amount: rate * 0.5, basis: `up to 12 h → 50% of ${rate}` , hours: null };
    const hours = Math.ceil(minutes / 60);
    return { amount: (rate / 24) * hours, basis: `${hours} h (rounded up) × ${rate} ÷ 24`, hours };
  }
  function allowances(r, cfg) {
    cfg = Object.assign({}, ALLOWANCE_DEFAULTS, cfg || {});
    const items = [];
    const sinDate = (ms) => dateAt(ms, r.baseOff), sinClock = (ms) => clockAt(ms, r.baseOff);
    const push = (o) => { o.month = monthOf(o.date); o.payDate = payDateFor(o.month); items.push(o); };
    // Miscellaneous: flat per bid period with an operating pattern (any non-P flight)
    const op = r.trips.find((t) => t.sectors.some((s) => !s.positioning));
    if (op) push({ type: 'misc', key: `misc|${r.bidPeriod}`, date: op.startDate, currency: 'SGD', amount: cfg.miscSGD,
      desc: `Bid period ${r.bidPeriod} · first operating pattern ${op.pattern}`, basis: 'Flat per bid period' });
    r.trips.forEach((t) => {
      // Meal: every layover away from base
      t.sectors.forEach((s, i) => {
        if (s.layoverMin == null || s.to === r.base) return;
        const rate = Number(cfg.portRates[s.to] != null ? cfg.portRates[s.to] : cfg.mealRate) || 0;
        const k = `meal|${r.staffNo}|${t.startDate}|${i}`;
        const m = mealAmount(s.layoverMin, rate);
        const provided = !!cfg.mealsProvided[k];
        push({ type: 'meal', key: k, date: sinDate(s.signOffMs), currency: cfg.mealCurrency, amount: provided ? 0 : m.amount, full: m.amount, provided,
          port: s.to, minutes: s.layoverMin, rate, desc: `${t.pattern} · ${s.to} layover ${minToHhmm(s.layoverMin)}`, basis: m.basis });
      });
      // Transport: home-base sign-on / sign-off between 23:00 and 06:30 inclusive
      const inWindow = (hhmm) => { const m = clock(hhmm.replace(':', '')); return m >= 23 * 60 || m <= 6 * 60 + 30; };
      const first = t.sectors[0], last = t.sectors[t.sectors.length - 1];
      if (first && first.from === r.base && inWindow(sinClock(t.reportMs)))
        push({ type: 'transport', key: `tr-on|${t.key}`, date: sinDate(t.reportMs), currency: 'SGD', amount: cfg.transportSGD, desc: `${t.pattern} sign-on ${sinClock(t.reportMs)} ${r.base}`, basis: 'Sign-on 23:00–06:30' });
      if (last && last.to === r.base && inWindow(sinClock(t.signOffMs)))
        push({ type: 'transport', key: `tr-off|${t.key}`, date: sinDate(t.signOffMs), currency: 'SGD', amount: cfg.transportSGD, desc: `${t.pattern} sign-off ${sinClock(t.signOffMs)} ${r.base}`, basis: 'Sign-off 23:00–06:30' });
    });
    items.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
    const totals = {};
    items.forEach((it) => { totals[it.currency] = (totals[it.currency] || 0) + it.amount; });
    let combinedSGD = null;
    const fx = Number(cfg.fx);
    if (Object.keys(totals).every((c) => c === 'SGD')) combinedSGD = totals.SGD || 0;
    else if (fx > 0 && Object.keys(totals).every((c) => c === 'SGD' || c === cfg.mealCurrency)) combinedSGD = (totals.SGD || 0) + (totals[cfg.mealCurrency] || 0) * fx;
    return { items, totals, combinedSGD };
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

  const api = { parseRoster, compareRosters, buildLibrary, eventPlan, syncPlan, checkRules, dutiesOf, allowances, mealAmount, payDateFor,
    DAY_CODES, KIND_COLOR, KIND_LABEL, codeInfo, COLOR, ALLOWANCE_DEFAULTS, fmtClock, clockAt, dateAt, addDays, dowOf, DOW_NAMES, hhmmToMin, minToHhmm, hashStr };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RosterCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
