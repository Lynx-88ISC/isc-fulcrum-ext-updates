/* Shift Flow - Day flow that draws WORK, not envelopes.  (console-paste prototype)
 *
 * THE PROBLEM THIS FIXES
 * Fulcrum's scheduleItems carry scheduledStartTimeUtc -> scheduledEndTimeUtc, and that pair
 * is an ENVELOPE, not a duration. It spans nights, weekends and queue time. Measured on the
 * live schedule: of 147 operations starting 2026-09-25, 85 had a clock span longer than their
 * estimated hours and 90 ended after 15:30 or on a later calendar day. Worst case was a
 * Twister plasma cut with 164.3 h of span for 0.1 h of work - a work-order group whose
 * envelope covered a whole week.
 *
 * Drawing that envelope as a solid bar makes a 6-minute job paint a week of continuous colour
 * straight through every closing time, which is what made the old Day flow look like the shop
 * runs to 11pm. It does not.
 *
 * WHAT THIS DRAWS INSTEAD
 *   solid block  = estimatedTotalTimeInSeconds, laid into working hours from the start
 *   faint rail   = the envelope (start -> end), i.e. how long the op is hanging around
 * So "how much work" and "how long it is open" stop being the same mark.
 *
 * WORKING HOURS ARE DERIVED FROM THE SCHEDULE, NOT FROM SHIFT SETUP.
 * Every scheduled START is a real placement the scheduler made inside an open window, so the
 * distribution of start times per work centre recovers the window without reading any config.
 * Ends are useless for this (they are envelope ends and run past midnight). Percentiles, not
 * min/max, because a handful of outliers would otherwise stretch a window to 00:00.
 * Verified against Welding: derived 05:30-15:29 vs 05:30-15:30 actual.
 *
 * Read-only. Issues no requests of its own - reads window.__all, which isc-schedule.js or
 * schedule-by-day.js populates. Paste one of those first.
 */
(() => {
  const ALL = window.__all;
  if (!ALL || !ALL.length) {
    console.error('shift-flow: window.__all is empty - paste isc-schedule.js first and let it load.');
    return;
  }
  const PREV = document.getElementById('isc-shift-flow');
  if (PREV) PREV.remove();

  const TZ = 'America/Chicago';
  const ORANGE = '#F58220';
  const C = {
    page: '#0c0d12', panel: '#191a1f', card: '#27292e', line: '#2e3138',
    text: '#e6e6f0', dim: '#8a8f9c',
    planned: '#3987e5', running: '#199e70', waiting: '#5b6579', late: '#e66767'
  };

  // ---- time helpers, all in shop-local time -------------------------------------------
  const parts = (d) => {
    const s = new Date(d).toLocaleString('en-US', {
      timeZone: TZ, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short'
    });
    const m = s.match(/(\w{3}),\s*(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2})/);
    if (!m) return null;
    return { dow: m[1], key: m[4] + '-' + m[2] + '-' + m[3], hour: +m[5] + (+m[6]) / 60 };
  };
  const dayKey = (d) => { const p = parts(d); return p && p.key; };
  const hourOf = (d) => { const p = parts(d); return p ? p.hour : 0; };
  const dowOf = (d) => { const p = parts(d); return p && p.dow; };
  const hhmm = (h) => String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.round((h % 1) * 60)).padStart(2, '0');
  const addDays = (key, n) => {
    const [y, m, d] = key.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };
  const dowOfKey = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  };

  const wcOf = (o) => (o._wc && (o._wc.name || o._wc)) || '(no work centre)';
  const eqOf = (o) => (o._eq && (o._eq.name || o._eq)) || '(unassigned)';
  const estH = (o) => (o.estimatedTotalTimeInSeconds || 0) / 3600;

  // ---- derive each work centre's working window from observed START times --------------
  function deriveWindows(ops) {
    const acc = {};
    for (const o of ops) {
      const k = wcOf(o);
      (acc[k] = acc[k] || { starts: [], days: {} });
      acc[k].starts.push(hourOf(o.scheduledStartTimeUtc));
      const d = dowOf(o.scheduledStartTimeUtc);
      acc[k].days[d] = (acc[k].days[d] || 0) + 1;
    }
    const win = {};
    for (const k in acc) {
      const s = acc[k].starts.slice().sort((a, b) => a - b);
      const pct = (p) => s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))];
      // 2nd/98th percentile rejects the stray midnight placement that would otherwise
      // stretch Plasma Cutting's window to 00:00.
      let from = pct(0.02), to = pct(0.98);
      const total = s.length;
      // A day counts as worked if it carries at least 5% of the centre's operations -
      // below that it is a one-off, not a shift.
      const days = {};
      for (const d in acc[k].days) if (acc[k].days[d] / total >= 0.05) days[d] = true;
      // The last START is not the end of the shift; work continues past it. Give the tail
      // an hour of headroom, capped at 24.
      to = Math.min(24, to + 1);
      if (to - from < 4) { to = Math.min(24, from + 8); }
      win[k] = { from, to, days, n: total };
    }
    return win;
  }
  const WIN = deriveWindows(ALL);

  // ---- lay an operation's estimated hours into working windows -------------------------
  // Returns [{key, from, to}] - the blocks of real work, day by day.
  function workSegments(o) {
    const w = WIN[wcOf(o)] || { from: 5.5, to: 15.5, days: { Mon: 1, Tue: 1, Wed: 1, Thu: 1, Fri: 1 } };
    let remaining = estH(o);
    const segs = [];
    if (remaining <= 0) {
      const k = dayKey(o.scheduledStartTimeUtc), h = hourOf(o.scheduledStartTimeUtc);
      return [{ key: k, from: h, to: h + 0.08, zero: true }];  // still show a tick
    }
    let key = dayKey(o.scheduledStartTimeUtc);
    let cursor = Math.max(w.from, hourOf(o.scheduledStartTimeUtc));
    for (let guard = 0; guard < 400 && remaining > 0.0001; guard++) {
      if (!w.days[dowOfKey(key)]) { key = addDays(key, 1); cursor = w.from; continue; }
      const avail = w.to - cursor;
      if (avail <= 0.0001) { key = addDays(key, 1); cursor = w.from; continue; }
      const take = Math.min(avail, remaining);
      segs.push({ key, from: cursor, to: cursor + take });
      remaining -= take;
      cursor += take;
      if (remaining > 0.0001) { key = addDays(key, 1); cursor = w.from; }
    }
    return segs;
  }

  // ---- state ---------------------------------------------------------------------------
  const todayKey = dayKey(Date.now());
  let day = todayKey;
  let rowMode = 'machine';

  // ---- shell ---------------------------------------------------------------------------
  const root = document.createElement('div');
  root.id = 'isc-shift-flow';
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:' + C.page +
    ';color:' + C.text + ';font:14.4px Inter,system-ui,sans-serif;overflow:auto;';
  const style = document.createElement('style');
  style.textContent = [
    '#isc-shift-flow *{box-sizing:border-box}',
    '#isc-shift-flow .bar{position:absolute;height:15px;top:6px;border-radius:3px}',
    '#isc-shift-flow .rail{position:absolute;height:3px;top:12px;border-radius:2px;background:' + C.waiting + ';opacity:.45}',
    '#isc-shift-flow .row{position:relative;height:28px;border-bottom:1px solid ' + C.line + '}',
    '#isc-shift-flow .lbl{position:absolute;left:0;top:0;width:190px;height:28px;padding:6px 8px;' +
      'font-size:11.5px;color:' + C.dim + ';overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '#isc-shift-flow .lane{position:absolute;left:190px;right:0;top:0;bottom:0}',
    '#isc-shift-flow .btn{background:' + C.card + ';color:' + C.text + ';border:1px solid ' + C.line +
      ';border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer}',
    '#isc-shift-flow .btn.on{background:' + ORANGE + ';border-color:' + ORANGE + ';color:#1a1206;font-weight:600}',
    '#isc-shift-flow .closed{position:absolute;top:0;bottom:0;background:rgba(0,0,0,.38)}'
  ].join('\n');
  root.appendChild(style);
  document.body.appendChild(root);

  const head = document.createElement('div');
  head.style.cssText = 'position:sticky;top:0;z-index:5;background:' + C.panel +
    ';border-bottom:1px solid ' + C.line + ';padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap';
  root.appendChild(head);
  const body = document.createElement('div');
  body.style.cssText = 'padding:0 14px 40px';
  root.appendChild(body);

  function chip(label, on, fn) {
    const b = document.createElement('button');
    b.className = 'btn' + (on ? ' on' : '');
    b.textContent = label;
    b.onclick = fn;
    return b;
  }

  // ---- render ---------------------------------------------------------------------------
  function render() {
    head.textContent = '';
    body.textContent = '';

    const badge = document.createElement('span');
    badge.textContent = 'ISC';
    badge.style.cssText = 'background:' + ORANGE + ';color:#1a1206;font-weight:700;font-size:11px;' +
      'padding:3px 7px;border-radius:5px';
    head.appendChild(badge);

    const title = document.createElement('strong');
    title.textContent = 'Shift Flow';
    head.appendChild(title);

    head.appendChild(chip('<', false, () => { day = addDays(day, -1); render(); }));
    const dl = document.createElement('span');
    dl.textContent = day + '  ' + dowOfKey(day);
    dl.style.cssText = 'font-size:12.5px;min-width:130px;text-align:center';
    head.appendChild(dl);
    head.appendChild(chip('>', false, () => { day = addDays(day, 1); render(); }));
    head.appendChild(chip('Today', day === todayKey, () => { day = todayKey; render(); }));

    const sp = document.createElement('span'); sp.style.cssText = 'width:14px'; head.appendChild(sp);
    for (const m of ['machine', 'workCentre', 'job']) {
      head.appendChild(chip(m, rowMode === m, () => { rowMode = m; render(); }));
    }

    // operations whose WORK lands on this day (not whose envelope covers it)
    const items = [];
    for (const o of ALL) {
      for (const s of workSegments(o)) {
        if (s.key === day) items.push({ o, seg: s });
      }
    }

    const legend = document.createElement('div');
    legend.style.cssText = 'font-size:11.5px;color:' + C.dim + ';padding:8px 0 10px';
    legend.innerHTML =
      '<span style="display:inline-block;width:20px;height:9px;background:' + C.planned + ';border-radius:3px;vertical-align:middle"></span> work ' +
      '&nbsp;&nbsp;<span style="display:inline-block;width:26px;height:3px;background:' + C.waiting + ';vertical-align:middle;opacity:.6"></span> waiting (envelope) ' +
      '&nbsp;&nbsp;<span style="display:inline-block;width:14px;height:9px;background:rgba(0,0,0,.38);border:1px solid ' + C.line + ';vertical-align:middle"></span> outside working hours ' +
      '&nbsp;&nbsp;&middot;&nbsp; ' + items.length + ' operations working this day';
    body.appendChild(legend);

    if (!items.length) {
      const e = document.createElement('div');
      e.style.cssText = 'padding:40px;text-align:center;color:' + C.dim;
      e.textContent = 'No work scheduled on ' + day + '.';
      body.appendChild(e);
      return;
    }

    // axis spans the union of working windows actually used today
    let lo = 24, hi = 0;
    for (const it of items) {
      const w = WIN[wcOf(it.o)];
      if (w) { lo = Math.min(lo, w.from); hi = Math.max(hi, w.to); }
      lo = Math.min(lo, it.seg.from); hi = Math.max(hi, it.seg.to);
    }
    lo = Math.floor(lo - 0.5); hi = Math.ceil(hi + 0.5);
    const span = hi - lo;
    const pctOf = (h) => ((h - lo) / span) * 100;

    // axis header
    const axis = document.createElement('div');
    axis.className = 'row';
    axis.style.cssText += ';height:24px;border-bottom:1px solid ' + C.line;
    const al = document.createElement('div'); al.className = 'lbl'; al.textContent = '';
    const alane = document.createElement('div'); alane.className = 'lane';
    for (let h = Math.ceil(lo); h <= hi; h++) {
      const t = document.createElement('div');
      t.style.cssText = 'position:absolute;top:4px;font-size:10.5px;color:' + C.dim +
        ';left:' + pctOf(h) + '%;transform:translateX(-50%)';
      t.textContent = (h % 24) + (h % 24 < 12 ? 'a' : 'p');
      alane.appendChild(t);
    }
    axis.appendChild(al); axis.appendChild(alane); body.appendChild(axis);

    // group into rows
    const keyFn = rowMode === 'machine' ? (o) => eqOf(o)
      : rowMode === 'workCentre' ? (o) => wcOf(o)
      : (o) => (o.job && o.job.name) || '-';
    const rows = {};
    for (const it of items) { const k = keyFn(it.o); (rows[k] = rows[k] || []).push(it); }

    const nowH = dayKey(Date.now()) === day ? hourOf(Date.now()) : null;

    for (const k of Object.keys(rows).sort()) {
      const r = document.createElement('div'); r.className = 'row';
      const lb = document.createElement('div'); lb.className = 'lbl';
      const hrs = rows[k].reduce((t, it) => t + (it.seg.to - it.seg.from), 0);
      lb.textContent = k;
      lb.title = k + ' - ' + hrs.toFixed(1) + 'h of work this day';
      const lane = document.createElement('div'); lane.className = 'lane';

      // shade the hours this row's work centre is closed
      const w = WIN[wcOf(rows[k][0].o)];
      if (w) {
        if (w.from > lo) {
          const c = document.createElement('div'); c.className = 'closed';
          c.style.left = '0%'; c.style.width = pctOf(w.from) + '%'; lane.appendChild(c);
        }
        if (w.to < hi) {
          const c = document.createElement('div'); c.className = 'closed';
          c.style.left = pctOf(w.to) + '%'; c.style.right = '0'; lane.appendChild(c);
        }
      }

      for (const it of rows[k]) {
        const o = it.o;
        // envelope rail, clipped to this day
        const eStart = dayKey(o.scheduledStartTimeUtc) === day ? hourOf(o.scheduledStartTimeUtc) : lo;
        const eEnd = dayKey(o.scheduledEndTimeUtc) === day ? hourOf(o.scheduledEndTimeUtc) : hi;
        if (eEnd > eStart) {
          const rail = document.createElement('div'); rail.className = 'rail';
          rail.style.left = pctOf(eStart) + '%';
          rail.style.width = Math.max(0.2, pctOf(eEnd) - pctOf(eStart)) + '%';
          lane.appendChild(rail);
        }
        // the work block
        const b = document.createElement('div'); b.className = 'bar';
        b.style.left = pctOf(it.seg.from) + '%';
        b.style.width = Math.max(0.35, pctOf(it.seg.to) - pctOf(it.seg.from)) + '%';
        b.style.background = o.status === 'In Progress' ? C.running
          : o.status === 'Pending' ? C.waiting : C.planned;
        if (o.isLate) b.style.boxShadow = 'inset 3px 0 0 ' + C.late;
        const envH = (new Date(o.scheduledEndTimeUtc) - new Date(o.scheduledStartTimeUtc)) / 3600000;
        b.title = [
          (o.job && o.job.name) + '  ' + o.name,
          eqOf(o) + '  (' + wcOf(o) + ')',
          'work ' + estH(o).toFixed(2) + 'h   this block ' + (it.seg.to - it.seg.from).toFixed(2) + 'h',
          'envelope ' + envH.toFixed(1) + 'h   ' + hhmm(it.seg.from) + '-' + hhmm(it.seg.to),
          o.status + (o.isLate ? '  LATE' : '')
        ].join('\n');
        const lab = document.createElement('span');
        lab.style.cssText = 'position:absolute;left:5px;top:0;font-size:10.5px;line-height:15px;color:#fff;white-space:nowrap;pointer-events:none';
        lab.textContent = (o.job && o.job.name ? o.job.name + ' ' : '') + o.name;
        b.appendChild(lab);
        lane.appendChild(b);
      }

      if (nowH !== null && nowH >= lo && nowH <= hi) {
        const n = document.createElement('div');
        n.style.cssText = 'position:absolute;top:0;bottom:0;width:2px;background:' + ORANGE +
          ';left:' + pctOf(nowH) + '%';
        lane.appendChild(n);
      }

      r.appendChild(lb); r.appendChild(lane); body.appendChild(r);
    }

    // derived-window footnote, so the numbers are inspectable
    const foot = document.createElement('div');
    foot.style.cssText = 'margin-top:16px;font-size:11px;color:' + C.dim + ';line-height:1.7';
    foot.textContent = 'Working hours derived from observed start times (2nd-98th percentile), not from Shift Setup: ' +
      Object.keys(WIN).sort().map(k => k + ' ' + hhmm(WIN[k].from) + '-' + hhmm(WIN[k].to)).join('  |  ');
    body.appendChild(foot);
  }

  const close = document.createElement('button');
  close.className = 'btn';
  close.textContent = 'Close';
  close.style.cssText += ';position:fixed;top:10px;right:14px;z-index:10';
  close.onclick = () => root.remove();
  root.appendChild(close);

  render();
  console.log('shift-flow: ready.');
})();
