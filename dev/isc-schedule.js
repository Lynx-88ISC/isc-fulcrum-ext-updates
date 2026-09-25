/* ISC Schedule views for Fulcrum (PROTOTYPE, v1)
   Paste this whole file into the browser console on https://iscmfg.fulcrumpro.com/ui/schedule
   Read-only: it only issues the same GETs the schedule page already makes.

   One app, four views, switched from the top bar:
     Fulcrum     - hides the overlay and gives you the stock schedule back (orange pill to return)
     Day board   - Fulcrum's machine columns flipped to day columns
     Day flow    - one day as an hour timeline, rows = machine
     Order gantt - one sales order across days, split into job bands, zoomable

   STYLING: matches Fulcrum's own dark theme, sampled from the live app rather than guessed -
   page #0c0d12, panel #191a1f, card #27292e, text #e6e6f0, Inter 14.4px, 8px radius
   (Taiga UI --tui-radius-s). ISC Orange #F58220 is used ONLY on ISC-built controls (the badge,
   the active view tab, job-band rules, the NOW line, the return pill) so it stays obvious which
   parts are ours - per the standing ISC convention. It is never used as a data value.

   DATA COLOURS are validated with the dataviz palette checker against Fulcrum's own card surface
   (#27292e, dark): #3987e5 planned + #199e70 running pass all-pairs (CVD dE 19.6, normal 20.9,
   contrast >= 3:1). Fulcrum's own trio (#369bc5 / #4ac99b / #978cd7) FAILS - its violet and blue
   sit at dE 11.4 normal / 3.2 deutan, and its green is outside the lightness band. Waiting-on-
   upstream is a neutral #6a6d78, deliberately not a hue.

   NO HARD DATES. From the audit (see AUDIT.md): every date is placed by Fulcrum's auto-scheduler
   (GREEDY, freezeDays 0, material-gated); the median operation has moved 14 days from its first
   plan, p90 is 56 days. Users cannot hand-place dates at all (dragAndDropScheduling is false).
   So these views deliberately DO NOT flag "late" - 81 of 85 operations on a given day carry the
   flag, which destroys every other signal and measures the staleness of the record rather than
   the shop. The banner says so in the UI. Only the CUSTOMER DUE date (the sales order's own
   production due date) is drawn as a hard marker, because that one is a real commitment.

   OTHER THINGS PROVEN AGAINST LIVE DATA - do not re-derive:
   - Bucket days in America/Chicago. 9 of ~1,870 operations change calendar day otherwise.
   - `order` is a SPARSE sort key (1,2,4). A gap is not a missing or completed step.
   - Stacked identical-looking operations are usually ONE work order nesting many parts: group by
     workOrderOperationSummary.workOrderOperationId, never by a time-overlap guess. 287 of 1,843
     ops collapse into 19 work-order operations, 13 of which span multiple jobs.
   - Job Tracking deep-links per operation ONLY via its hash route, and selectedOperationId is the
     schedule item's own `id`: /jobtracking/#/operation?type=Job&jobId=..&selectedOperationId=..
     &selectedItemToMakeId=..   (/jobtracking/<jobId> does NOT work - it drops you on the board.)
   - Axis labels and NOW/DUE captions belong to the HEADER only. Put them in the per-row gridline
     string and every row repeats the whole date grid behind the bars.
   - Overlapping operations must be lane-stacked or they hide each other.
*/

/* ---------------------------------------------------------------- part 1: tokens, css, state */
(function () {
  ['iscapp', 'iscapp-css', 'iscapp-pill', 'iscapp-pop'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); });
  const NL = String.fromCharCode(10);
  const TZ = 'America/Chicago';
  const F = o => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: TZ }, o));
  const dk = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const md = d => F({ month: 'short', day: 'numeric' }).format(d);
  const wd = d => F({ weekday: 'short' }).format(d);
  const tm = d => F({ hour: 'numeric', minute: '2-digit' }).format(d).replace(' AM', 'a').replace(' PM', 'p');
  const esc = t => { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };
  const H = s => s / 3600, DAY = 864e5, kd = k => new Date(k + 'T12:00:00Z'), LABW = 246;
  const css = `
  #iscapp{position:fixed;inset:0;z-index:2147483200;background:#191a1f;color:#e6e6f0;font:14.4px/1.4 Inter,sans-serif;display:flex;flex-direction:column;
   --page:#0c0d12;--panel:#191a1f;--card:#27292e;--raise:#2f3238;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);
   --ink:#e6e6f0;--ink2:rgba(230,230,240,.62);--ink3:rgba(230,230,240,.38);
   --plan:#3987e5;--run:#199e70;--wait:#6a6d78;--isc:#F58220;--neg:#f45725}
  #iscapp *{box-sizing:border-box} #iscapp button{font:inherit;cursor:pointer}
  #iscapp .bar{display:flex;align-items:center;gap:14px;padding:10px 16px;background:var(--page);border-bottom:1px solid var(--line)}
  #iscapp .mark{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink2)}
  #iscapp .mark b{background:var(--isc);color:#fff;font-weight:700;padding:3px 7px;border-radius:4px;font-size:11.5px;letter-spacing:.4px}
  #iscapp .seg{display:flex;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:2px;gap:2px}
  #iscapp .seg button{background:transparent;border:0;color:var(--ink2);padding:6px 14px;border-radius:6px;font-size:13.5px}
  #iscapp .seg button:hover{color:var(--ink);background:rgba(255,255,255,.05)}
  #iscapp .seg button.on{background:var(--isc);color:#fff;font-weight:600}
  #iscapp .sp{flex:1}
  #iscapp .ctl{display:flex;align-items:center;gap:7px}
  #iscapp select,#iscapp input[type=date]{background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 9px;font:inherit;font-size:13.5px;max-width:330px}
  #iscapp .btn{background:var(--card);border:1px solid var(--line);color:var(--ink2);border-radius:8px;padding:6px 11px;font-size:13px}
  #iscapp .btn:hover{color:var(--ink);border-color:var(--line2)}
  #iscapp .btn.on{background:var(--isc);border-color:var(--isc);color:#fff}
  #iscapp .lab{font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--ink3)}
  #iscapp .note{display:flex;align-items:center;gap:9px;padding:7px 16px;background:#20222a;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--ink2)}
  #iscapp .note b{color:var(--ink)}
  #iscapp .note .x{margin-left:auto;background:none;border:0;color:var(--ink3);font-size:15px;padding:0 4px}
  #iscapp .body{flex:1;overflow:auto;position:relative}
  #iscapp .sum{display:flex;gap:26px;padding:11px 16px;background:var(--page);border-bottom:1px solid var(--line);align-items:flex-end;flex-wrap:wrap}
  #iscapp .sum .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.7px;color:var(--ink3)}
  #iscapp .sum .v{font-size:15px;font-weight:600;margin-top:3px}
  #iscapp .lg{display:flex;gap:15px;align-items:center;padding:6px 16px;background:var(--panel);border-bottom:1px solid var(--line);font-size:12px;color:var(--ink2);flex-wrap:wrap}
  #iscapp .lg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
  #iscapp .cols{display:flex;gap:11px;padding:14px;align-items:flex-start;min-height:100%}
  #iscapp .col{flex:0 0 250px;background:var(--panel);border:1px solid var(--line);border-radius:10px;display:flex;flex-direction:column;max-height:calc(100vh - 150px)}
  #iscapp .col.today{border-color:var(--isc)}
  #iscapp .col.we{opacity:.62}
  #iscapp .ch{padding:10px 12px;border-bottom:1px solid var(--line)}
  #iscapp .ch .d{font-size:14px;font-weight:600}
  #iscapp .ch .m{font-size:11.5px;color:var(--ink3);margin-top:3px;display:flex;gap:9px}
  #iscapp .ch .load{height:3px;background:rgba(255,255,255,.08);border-radius:2px;margin-top:8px;overflow:hidden}
  #iscapp .ch .load i{display:block;height:100%;background:var(--plan)}
  #iscapp .col.today .ch .load i{background:var(--isc)}
  #iscapp .cb{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
  #iscapp .card{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--plan);border-radius:8px;padding:9px 10px;cursor:pointer}
  #iscapp .card:hover{border-color:var(--line2);background:var(--raise)}
  #iscapp .card.run{border-left-color:var(--run)}
  #iscapp .card.wait{border-left-color:var(--wait)}
  #iscapp .card .j{font-weight:600;font-size:13px}
  #iscapp .card .o{font-size:13px;color:var(--ink2);margin-top:3px}
  #iscapp .card .mm{display:flex;justify-content:space-between;gap:6px;margin-top:7px;font-size:11.5px;color:var(--ink3)}
  #iscapp .card .eq{background:rgba(255,255,255,.06);border-radius:4px;padding:2px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #iscapp .card .cu{font-size:11.5px;color:var(--ink3);margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #iscapp .empty{color:var(--ink3);font-size:12px;text-align:center;padding:16px}
  #iscapp .g{position:relative}
  #iscapp .hrow{display:flex;position:sticky;top:0;z-index:6;background:var(--page);border-bottom:1px solid var(--line)}
  #iscapp .rl{flex:0 0 246px;padding:7px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--ink3);border-right:1px solid var(--line);background:var(--page);position:sticky;left:0;z-index:7}
  #iscapp .track{flex:0 0 auto;position:relative;min-width:0}
  #iscapp .cell{position:absolute;top:0;bottom:0;border-left:1px solid rgba(255,255,255,.05)}
  #iscapp .cell.we{background:rgba(255,255,255,.028)}
  #iscapp .hrow .cell{top:23px}
  #iscapp .dl{position:absolute;top:4px;left:0;right:0;text-align:center;font-size:10.5px;color:var(--ink3);white-space:nowrap}
  #iscapp .dl b{font-weight:600;color:var(--ink2);margin-right:3px}
  #iscapp .mb{position:absolute;top:0;height:21px;border-left:1px solid var(--line2);color:var(--ink2);font-size:11px;font-weight:600;padding:3px 8px;white-space:nowrap;overflow:hidden;z-index:2}
  #iscapp .row{display:flex;border-bottom:1px solid rgba(255,255,255,.05)}
  #iscapp .row:hover{background:rgba(255,255,255,.02)}
  #iscapp .rn{flex:0 0 246px;padding:10px 12px;font-size:13px;border-right:1px solid var(--line);position:sticky;left:0;background:var(--panel);z-index:4}
  #iscapp .rn small{display:block;color:var(--ink3);font-size:10.5px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #iscapp .rn.sub{padding-left:22px}
  #iscapp .rn.sub b{font-weight:500;color:var(--ink)}
  #iscapp .seg2{position:absolute;height:23px;line-height:21px;border-radius:6px;background:var(--plan);border:1px solid rgba(255,255,255,.14);overflow:hidden;font-size:11.5px;color:#fff;white-space:nowrap;padding:0 7px;cursor:pointer}
  #iscapp .seg2:hover{filter:brightness(1.17)}
  #iscapp .seg2.run{background:var(--run)}
  #iscapp .seg2.wait{background:var(--wait)}
  #iscapp .seg2.wo{background:#2f6bb5;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}
  #iscapp .seg2.shared{border:1px dashed var(--isc)}
  #iscapp .seg2.hl{outline:2px solid var(--isc);outline-offset:1px;z-index:8}
  #iscapp .seg2 em{font-style:normal;font-weight:700;margin-right:5px}
  #iscapp .wob{background:rgba(0,0,0,.35);border-radius:4px;padding:0 5px;margin-right:5px;font-weight:600}
  #iscapp .jobhd{display:flex;background:#20222a;border-top:1px solid var(--isc);border-bottom:1px solid var(--line);position:sticky;left:0;margin-top:13px}
  #iscapp .jobhd .jl{flex:0 0 246px;padding:10px 12px;position:sticky;left:0;background:#20222a;z-index:5}
  #iscapp .jobhd .jl b{color:var(--isc);font-size:13px}
  #iscapp .jobhd .jl small{display:block;color:var(--ink3);font-size:10.5px;margin-top:3px}
  #iscapp .jobhd .jm{flex:1;padding:10px 14px;font-size:11.5px;color:var(--ink2);display:flex;gap:22px;align-items:center}
  #iscapp .due{position:absolute;top:0;bottom:0;width:0;border-left:2px dashed var(--neg);z-index:3}
  #iscapp .due span{position:absolute;top:2px;left:5px;font-size:9.5px;font-weight:700;color:var(--neg);white-space:nowrap}
  #iscapp .now{position:absolute;top:0;bottom:0;width:2px;background:var(--isc);z-index:5}
  #iscapp .now span{position:absolute;top:2px;left:5px;font-size:9.5px;font-weight:700;color:var(--isc)}
  #iscapp .row .now span,#iscapp .row .due span,#iscapp .jobhd .now span,#iscapp .jobhd .due span{display:none}
  #iscapp ::-webkit-scrollbar{height:10px;width:10px}
  #iscapp ::-webkit-scrollbar-thumb{background:#40434d;border-radius:5px}
  #iscapp-pill{position:fixed;top:12px;right:16px;z-index:2147483250;background:#F58220;color:#fff;border:0;border-radius:8px;padding:8px 13px;font:600 13px Inter,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4)}
  #iscapp-pop{position:fixed;z-index:2147483300;background:#27292e;border:1px solid rgba(255,255,255,.14);border-radius:10px;box-shadow:0 14px 36px rgba(0,0,0,.6);min-width:300px;max-width:440px;max-height:60vh;overflow:auto;padding:10px;font:14.4px/1.4 Inter,sans-serif;color:#e6e6f0}
  #iscapp-pop h4{margin:0 0 5px;font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:#F58220}
  #iscapp-pop .ps{font-size:11.5px;color:rgba(230,230,240,.55);margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.1)}
  #iscapp-pop a{display:block;padding:7px 8px;border-radius:6px;color:#e6e6f0;text-decoration:none;font-size:12.5px;cursor:pointer}
  #iscapp-pop a:hover{background:rgba(255,255,255,.07)}
  #iscapp-pop a small{display:block;color:rgba(230,230,240,.5);font-size:10.5px;margin-top:2px}
  #iscboot2{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;color:#e6e6f0;font:14.4px Inter,sans-serif}
  #iscboot2 .pb{width:300px;height:4px;background:rgba(255,255,255,.1);border-radius:3px;overflow:hidden}
  #iscboot2 .pb i{display:block;height:100%;width:0;background:#F58220;transition:width .3s}`;
  const st = document.createElement('style'); st.id = 'iscapp-css'; st.textContent = css; document.head.appendChild(st);

  const S = { view: 'board', items: [], day: dk(new Date()), days: 14, so: null, px: null, by: 'op', detail: false, work: true };
  let CTX = {}, BARS = [];
  const items = () => S.items.filter(i => i.scheduledStartTimeUtc);
  const soOf = i => { const r = i.job && i.job.salesOrderLineItemReference; return r && r.soNumber != null ? String(r.soNumber) : null; };
  const woOf = i => i.workOrderOperationSummary ? i.workOrderOperationSummary.workOrderOperationId : null;
  const partOf = i => (i.itemToMakeItemReference && i.itemToMakeItemReference.number) || '';
  const trackUrl = i => '/jobtracking/#/operation?type=Job&jobId=' + i.parentId + '&selectedOperationId=' + i.id + '&selectedItemToMakeId=' + i.itemToMakeId;
  const jobUrl = i => '/ui/jobs/' + i.parentId + '/details';
  const kls = i => i.status === 'Running' ? 'run' : (i.status === 'Pending' ? 'wait' : '');
  const mins = (d, key) => {
    const k = dk(d); const p = F({ hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(d);
    const h = +p.find(x => x.type === 'hour').value, m = +p.find(x => x.type === 'minute').value;
    return k === key ? h * 60 + m : (k < key ? -1e6 : 1e6);
  };
  /* WORK vs ENVELOPE ------------------------------------------------------------------
     scheduledStartTimeUtc -> scheduledEndTimeUtc is an ENVELOPE: it spans nights, weekends
     and queue time, so drawing it solid makes a 6-minute job paint a week of colour through
     every closing time. Measured on 2026-09-25: of 147 operations starting that day, 85 had
     a clock span longer than their estimate and 90 ended after 15:30 or on a later day; the
     worst was 164.3h of span for 0.1h of work.

     So in work mode we draw estimatedTotalTimeInSeconds laid into working hours instead.

     Working hours are DERIVED FROM THE SCHEDULE, never from Shift Setup: every scheduled
     start is a real placement the scheduler made inside an open window, so the distribution
     of start times per work centre recovers it. Ends are useless (they are envelope ends).
     Percentiles, not min/max - one stray midnight placement would otherwise stretch Plasma
     Cutting's window to 00:00. Checked against Welding: derived 05:30-15:29, actual 05:30-15:30. */
  let WIN = null;
  const wcOf = i => (i._wc && (i._wc.name || i._wc)) || '(none)';
  const wdOf = key => new Date(key + 'T12:00:00Z').getUTCDay();
  function windows() {
    if (WIN) return WIN;
    const acc = {};
    items().forEach(i => {
      const k = wcOf(i), d = new Date(i.scheduledStartTimeUtc), dkey = dk(d);
      (acc[k] = acc[k] || { s: [], d: {} });
      acc[k].s.push(mins(d, dkey));
      acc[k].d[wdOf(dkey)] = (acc[k].d[wdOf(dkey)] || 0) + 1;
    });
    WIN = {};
    for (const k in acc) {
      const s = acc[k].s.sort((a, b) => a - b), n = s.length;
      const p = q => s[Math.min(n - 1, Math.max(0, Math.floor(n * q)))];
      const from = p(0.02);
      // work continues past the last START, so give the tail an hour of headroom
      let to = Math.min(1440, p(0.98) + 60);
      if (to - from < 240) to = Math.min(1440, from + 480);
      const days = {};
      // a weekday counts as worked only if it carries >=5% of the centre's operations,
      // otherwise a single Saturday call-in would read as a standing shift
      for (const wd in acc[k].d) if (acc[k].d[wd] / n >= 0.05) days[wd] = 1;
      WIN[k] = { from, to, days };
    }
    return WIN;
  }
  /* MACHINE QUEUE PACKING ---------------------------------------------------------------
     Laying every operation in independently from its own start lets several of them claim the
     same morning hours; lanes() then stacks them and the row quietly asserts more work than
     the machine can do. Measured on 2026-09-28, Weld Bay 1 claimed 20h of work in a 10.8h day.

     So pack each machine as a queue: runs in scheduled-start order, laid end to end inside the
     working window, overflow spilling to the next working day. A run never starts before its own
     scheduled start, so the scheduler's sequencing is preserved - we only remove the overlap.

     A WORK ORDER IS ONE RUN, and its time is workOrderOperationSummary.totalEstimatedTimeInSeconds,
     NOT the sum of its parts. Work orders combine many parts across several jobs (14 of 20 groups
     here span multiple jobs) and the per-part estimates are near zero: WO 1280 carries 27 parts
     across 3 jobs whose estimates sum to 0.1h, while the run itself is 21780s = 6.05h. Summing
     parts therefore UNDER-states a nest badly, and counting each part as its own run over-states
     the machine - Twister read 71.9h of work in an 11.1h day, against 2.1h once collapsed. */
  let PACK = null;
  function pack() {
    if (PACK) return PACK;
    const byEq = {};
    items().forEach(i => { const k = i._eq || '(unassigned)'; (byEq[k] = byEq[k] || []).push(i); });
    const out = { byDay: {}, byRun: [] };
    for (const eq in byEq) {
      const wo = {}, runs = [];
      byEq[eq].forEach(i => {
        const w = woOf(i);
        if (w) (wo[w] = wo[w] || []).push(i);
        else runs.push({ list: [i], mins: Math.round((i.estimatedTotalTimeInSeconds || 0) / 60), start: i.scheduledStartTimeUtc, wo: null });
      });
      for (const w in wo) {
        const arr = wo[w];
        const s = arr.map(i => i.scheduledStartTimeUtc).sort()[0];
        const sum = arr[0].workOrderOperationSummary.totalEstimatedTimeInSeconds || 0;
        runs.push({ list: arr, mins: Math.round(sum / 60), start: s, wo: arr[0].workOrderOperationSummary });
      }
      if (!runs.length) continue;
      runs.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      const w0 = windows()[wcOf(byEq[eq][0])] || { from: 330, to: 930, days: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 } };
      for (const r of runs) {
        /* Each run is placed at ITS OWN scheduled start - we do NOT carry a cursor from the
           previous run. An earlier version queued them end to end, which removed the visual
           overlap but re-planned the shop: compared against Fulcrum's own end dates across 50
           jobs it ran a median of 83 days late, p90 202, max 216, with only 14 matching within
           two days. Fulcrum evidently runs operations in parallel on a machine (simultaneous
           assignment / extra operators), so serialising them invents a schedule into 2027.
           Fulcrum owns WHEN. We only correct HOW MUCH, and report overload rather than hiding
           it by moving work. */
        let k = dk(new Date(r.start));
        let cur = Math.max(w0.from, mins(new Date(r.start), k));
        let left = Math.max(r.mins, 5);          // zero-time runs still deserve a visible tick
        r.eq = eq; r.segs = [];
        for (let g = 0; g < 600 && left > 0; g++) {
          if (!w0.days[wdOf(k)]) { k = dk(new Date(kd(k).getTime() + DAY)); cur = w0.from; continue; }
          const avail = w0.to - cur;
          if (avail <= 0) { k = dk(new Date(kd(k).getTime() + DAY)); cur = w0.from; continue; }
          const take = Math.min(avail, left);
          r.segs.push({ key: k, s: cur, e: cur + take });
          left -= take; cur += take;
          if (left > 0) { k = dk(new Date(kd(k).getTime() + DAY)); cur = w0.from; }
        }
        out.byRun.push(r);
        r.segs.forEach(sg => { (out.byDay[sg.key] = out.byDay[sg.key] || []).push({ run: r, seg: sg }); });
      }
    }
    PACK = out;
    return PACK;
  }

  // The block of real work this operation puts on `key`, in minutes past midnight, or null.
  function workSpan(i, key) {
    const w = windows()[wcOf(i)] || { from: 330, to: 930, days: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 } };
    let left = Math.round((i.estimatedTotalTimeInSeconds || 0) / 60);
    let k = dk(new Date(i.scheduledStartTimeUtc));
    let cur = Math.max(w.from, mins(new Date(i.scheduledStartTimeUtc), k));
    if (left <= 0) return k === key ? { s: cur, e: cur + 5 } : null;   // zero-time ops still get a tick
    for (let g = 0; g < 400 && left > 0; g++) {
      if (!w.days[wdOf(k)]) { k = dk(new Date(kd(k).getTime() + DAY)); cur = w.from; continue; }
      const avail = w.to - cur;
      if (avail <= 0) { k = dk(new Date(kd(k).getTime() + DAY)); cur = w.from; continue; }
      const take = Math.min(avail, left);
      if (k === key) return { s: cur, e: cur + take };
      left -= take; cur += take;
      if (left > 0) { k = dk(new Date(kd(k).getTime() + DAY)); cur = w.from; }
    }
    return null;
  }

  function lanes(list, ka, kb) {
    const ends = [], out = [];
    list.slice().sort((a, b) => a[ka] - b[ka]).forEach(it => {
      let l = 0; while (ends[l] != null && ends[l] > it[ka]) l++;
      ends[l] = it[kb]; out.push(Object.assign({ lane: l }, it));
    });
    return { items: out, count: Math.max(1, ends.length) };
  }
  function soList() {
    const m = {};
    items().forEach(i => {
      const s = soOf(i); if (!s) return;
      const r = m[s] = m[s] || { so: s, cust: (i.job && i.job.customerReference && i.job.customerReference.name) || '', ops: 0, jobs: new Set(), hrs: 0, due: null };
      r.ops++; r.jobs.add(i.job.name); r.hrs += H(i.estimatedTotalTimeInSeconds || 0);
      const d = i.job && i.job.productionDueDate ? +new Date(i.job.productionDueDate) : null;
      if (d != null) r.due = r.due == null ? d : Math.min(r.due, d);
    });
    return Object.values(m).sort((a, b) => +a.so - +b.so);
  }
  function closePop() { const p = document.getElementById('iscapp-pop'); if (p) p.remove(); }
  function openPop(ev, list, title, sub) {
    closePop(); const p = document.createElement('div'); p.id = 'iscapp-pop';
    p.innerHTML = '<h4>' + esc(title) + '</h4><div class="ps">' + esc(sub) + '<br>click a part to open it in Job Tracking</div>';
    list.slice(0, 60).forEach(i => {
      const a = document.createElement('a');
      a.innerHTML = '<b>' + esc(partOf(i) || i.job.name) + '</b><small>' + esc(i.job.name) + ' &middot; ' + esc(i.name) + ' &middot; ' + esc(i._eq) + ' &middot; ' + H(i.estimatedTotalTimeInSeconds || 0).toFixed(2) + 'h</small>';
      a.onclick = e => { e.stopPropagation(); window.open(trackUrl(i), '_blank'); closePop(); };
      p.appendChild(a);
    });
    if (list.length > 60) { const m = document.createElement('div'); m.className = 'ps'; m.style.marginTop = '6px'; m.textContent = (list.length - 60) + ' more not shown'; p.appendChild(m); }
    document.body.appendChild(p);
    const r = p.getBoundingClientRect();
    p.style.left = Math.min(ev.clientX + 8, window.innerWidth - r.width - 12) + 'px';
    p.style.top = Math.min(ev.clientY + 8, window.innerHeight - r.height - 12) + 'px';
    setTimeout(() => document.addEventListener('click', closePop, { once: true }), 0);
  }
  window.ISCApp = {
    S, items, soList, trackUrl, jobUrl, openPop, closePop, lanes, mins, kls, woOf, partOf, soOf,
    windows, workSpan, wcOf, pack,
    esc, F, dk, md, wd, tm, H, DAY, kd, LABW, NL, CTX: () => CTX, setCTX: v => { CTX = v; }, BARS: () => BARS, setBARS: v => { BARS = v; }
  };
})();

/* ------------------------------------------------------------------------- part 2: the views */
(function () {
  const A = window.ISCApp, S = A.S;
  const { esc, F, dk, md, wd, tm, H, DAY, kd, LABW, NL, items, soList, soOf, woOf, partOf, trackUrl, jobUrl, kls, mins, lanes, openPop, windows, workSpan, wcOf, pack } = A;
  const q = s => document.querySelector('#iscapp ' + s);
  const body = () => q('.body');

  function board() {
    const b = body(); b.innerHTML = '<div class="cols"></div>';
    const wrap = b.querySelector('.cols');
    const today = dk(new Date()), all = items(), by = {};
    all.forEach(i => { const k = dk(new Date(i.scheduledStartTimeUtc)); (by[k] = by[k] || []).push(i); });
    const start = kd(S.day);
    const tot = [];
    for (let n = 0; n < S.days; n++) { const d = new Date(start.getTime() + n * DAY); tot.push((by[dk(d)] || []).reduce((s, i) => s + H(i.estimatedTotalTimeInSeconds || 0), 0)); }
    const peak = Math.max(1, ...tot);
    for (let n = 0; n < S.days; n++) {
      const d = new Date(start.getTime() + n * DAY), key = dk(d), w = wd(d);
      const list = (by[key] || []).sort((a, b2) => new Date(a.scheduledStartTimeUtc) - new Date(b2.scheduledStartTimeUtc));
      const col = document.createElement('div');
      col.className = 'col' + (key === today ? ' today' : '') + ((w === 'Sat' || w === 'Sun') ? ' we' : '');
      col.innerHTML = '<div class="ch"><div class="d">' + w + ' ' + md(d) + (key === today ? ' &middot; today' : '') + '</div>' +
        '<div class="m"><span>' + list.length + ' ops</span><span>' + tot[n].toFixed(1) + ' h</span><span>' + new Set(list.map(i => i._eq)).size + ' mach</span></div>' +
        '<div class="load"><i style="width:' + Math.round(tot[n] / peak * 100) + '%"></i></div></div>';
      const cb = document.createElement('div'); cb.className = 'cb';
      if (!list.length) cb.innerHTML = '<div class="empty">nothing planned</div>';
      list.forEach(i => {
        const c = document.createElement('div'); c.className = 'card ' + kls(i);
        const so = i.job && i.job.salesOrderLineItemReference;
        c.innerHTML = '<div class="j">' + esc(i.job ? i.job.name : '-') + '</div><div class="o">' + esc(i.name) + '</div>' +
          '<div class="mm"><span class="eq">' + esc(i._eq) + '</span><span>' + tm(new Date(i.scheduledStartTimeUtc)) + ' &middot; ' + H(i.estimatedTotalTimeInSeconds || 0).toFixed(1) + 'h</span></div>' +
          '<div class="cu">' + (so ? 'SO' + esc(so.soNumber) + ' &middot; ' : '') + esc(i.job && i.job.customerReference ? i.job.customerReference.name : '') + '</div>';
        c.title = i.name + NL + i._eq + NL + partOf(i) + NL + 'status: ' + i.status + NL + 'click to open in Job Tracking';
        c.onclick = () => window.open(trackUrl(i), '_blank');
        cb.appendChild(c);
      });
      col.appendChild(cb); wrap.appendChild(col);
    }
  }

  function day() {
    const b = body(); b.innerHTML = '';
    // work mode: rows carry the packed RUNS whose work lands on this day, not envelopes
    const today = S.work ? (pack().byDay[S.day] || []) : null;
    const all = S.work ? today.reduce((a, x) => a.concat(x.run.list), [])
      : items().filter(i => dk(new Date(i.scheduledStartTimeUtc)) === S.day ||
        (dk(new Date(i.scheduledStartTimeUtc)) < S.day && dk(new Date(i.scheduledEndTimeUtc)) >= S.day));
    if (!all.length) { b.innerHTML = '<div class="empty" style="padding:40px">nothing planned on this day</div>'; return; }
    // Axis spans the work actually on this day, so the dead stretch before the first job
    // collapses as the day clears instead of padding the chart out to the whole window.
    let lo = 1e9, hi = -1e9;
    if (S.work) {
      today.forEach(x => { lo = Math.min(lo, x.seg.s); hi = Math.max(hi, x.seg.e); });
    } else {
      all.forEach(i => {
        lo = Math.min(lo, Math.max(0, mins(new Date(i.scheduledStartTimeUtc), S.day)));
        hi = Math.max(hi, Math.min(1440, mins(new Date(i.scheduledEndTimeUtc), S.day)));
      });
    }
    lo = Math.max(0, Math.floor(lo / 60) * 60); hi = Math.min(1440, Math.ceil(hi / 60) * 60);
    if (hi - lo < 360) hi = Math.min(1440, lo + 360);
    const span = hi - lo, pct = m => ((m - lo) / span * 100);
    let ticks = '', grid = '';
    for (let m = lo; m <= hi; m += 60) {
      const h = (m / 60) % 24, l = (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? 'a' : 'p');
      ticks += '<div class="cell" style="left:' + pct(m) + '%"><div class="dl">' + l + '</div></div>';
      grid += '<div class="cell" style="left:' + pct(m) + '%"></div>';
    }
    const g = {}; all.forEach(i => { const k = i._eq; (g[k] = g[k] || []).push(i); });
    const nowM = (dk(new Date()) === S.day) ? mins(new Date(), S.day) : null;
    const nowEl = (nowM != null && nowM >= lo && nowM <= hi) ? '<div class="now" style="left:' + pct(nowM) + '%"><span>NOW</span></div>' : '';
    const root = document.createElement('div'); root.className = 'g';
    root.innerHTML = '<div class="hrow"><div class="rl">machine</div><div class="track" style="flex:1;height:28px">' + ticks + nowEl + '</div></div>';
    const BARS = [];
    Object.keys(g).sort().forEach(k => {
      const list = g[k];
      /* Collapse each work-order operation into ONE bar. A nest of 36 parts is a single run on the
         machine, not 36 stacked lanes - without this a plasma nest turned one machine row into a
         820px wall of identical bars. */
      const wo = {}, loose = [];
      list.forEach(i => { const w = woOf(i); if (w) { (wo[w] = wo[w] || []).push(i); } else loose.push(i); });
      const mk = arr => {
        let s0, e0;
        if (S.work) {
          const ws = arr.map(i => workSpan(i, S.day)).filter(Boolean);
          s0 = Math.min(...ws.map(w => w.s)); e0 = Math.max(...ws.map(w => w.e));
        } else {
          s0 = Math.min(...arr.map(i => mins(new Date(i.scheduledStartTimeUtc), S.day)));
          e0 = Math.max(...arr.map(i => mins(new Date(i.scheduledEndTimeUtc), S.day)));
        }
        return { a: Math.max(lo, Math.min(hi, s0)), b: Math.max(lo, Math.min(hi, e0)), s0, e0, list: arr };
      };
      const segs = [];
      if (S.work) {
        // one bar per packed run - the queue has already removed the overlap
        today.filter(x => x.run.eq === k).forEach(x => segs.push({
          a: Math.max(lo, Math.min(hi, x.seg.s)), b: Math.max(lo, Math.min(hi, x.seg.e)),
          s0: x.seg.s, e0: x.seg.e, list: x.run.list, wo: x.run.wo, run: x.run
        }));
      } else {
        Object.values(wo).forEach(v => segs.push(Object.assign(mk(v), { wo: v[0].workOrderOperationSummary })));
        loose.forEach(i => segs.push(mk([i])));
      }
      const L = lanes(segs, 'a', 'b'), rowH = Math.max(42, L.count * 27 + 12);
      // in work mode the row total is the hours the machine actually spends today,
      // so it can never exceed the working window
      const hrs = S.work ? segs.reduce((s, x) => s + (x.e0 - x.s0) / 60, 0)
        : list.reduce((s, i) => s + H(i.estimatedTotalTimeInSeconds || 0), 0);
      const nWo = S.work ? segs.filter(x => x.wo).length : Object.keys(wo).length;
      const row = document.createElement('div'); row.className = 'row';
      const tr = document.createElement('div'); tr.className = 'track'; tr.style.cssText = 'flex:1;height:' + rowH + 'px';
      tr.innerHTML = grid + nowEl;
      // shade this row's closed hours, so a bar near the edge reads as "end of shift"
      if (S.work) {
        const w = windows()[wcOf(list[0])];
        const shade = 'position:absolute;top:0;bottom:0;background:rgba(0,0,0,.34);pointer-events:none';
        if (w && w.from > lo) tr.innerHTML += '<div style="' + shade + ';left:0;width:' + pct(w.from) + '%"></div>';
        if (w && w.to < hi) tr.innerHTML += '<div style="' + shade + ';left:' + pct(w.to) + '%;right:0"></div>';
      }
      L.items.forEach(x => {
        const i0 = x.list[0];
        const anyRun = x.list.some(i => i.status === 'Running'), allW = x.list.every(i => i.status === 'Pending');
        const el = document.createElement('div');
        el.className = 'seg2' + (anyRun ? ' run' : (allW ? ' wait' : '')) + (x.wo ? ' wo' : '');
        el.style.left = pct(x.a) + '%'; el.style.width = Math.max(1.2, pct(x.b) - pct(x.a)) + '%'; el.style.top = (6 + x.lane * 27) + 'px';
        el.dataset.bar = BARS.push(x) - 1;
        // a work-order run's time is the run's own total, never the sum of its parts
        const chrs = x.run ? x.run.mins / 60
          : (x.wo ? H(x.wo.totalEstimatedTimeInSeconds || 0)
            : x.list.reduce((s, i) => s + H(i.estimatedTotalTimeInSeconds || 0), 0));
        if (x.wo) {
          const jobs = [...new Set(x.list.map(i => i.job.name))];
          el.title = 'WORK ORDER ' + x.wo.name + ' - ' + i0.name + NL + k + NL + x.list.length + ' parts' + NL +
            'jobs: ' + jobs.join(', ') + NL + chrs.toFixed(1) + 'h total' + NL + 'click to pick a part';
          el.innerHTML = (x.s0 < lo ? '<em>&larr;</em>' : '') + '<span class="wob">WO ' + esc(x.wo.name) + '</span>' + esc(i0.name) +
            ' <span style="opacity:.8">' + x.list.length + ' parts</span>' + (x.e0 > hi ? ' <em>&rarr;</em>' : '');
        } else {
          el.title = (i0.job ? i0.job.name : '') + ' - ' + i0.name + NL + k + NL + partOf(i0) + NL +
            tm(new Date(i0.scheduledStartTimeUtc)) + ' to ' + tm(new Date(i0.scheduledEndTimeUtc)) + ' (' + chrs.toFixed(1) + 'h)' + NL +
            'status: ' + i0.status + NL + 'click to open in Job Tracking';
          el.innerHTML = (x.s0 < lo ? '<em>&larr;</em>' : '') + '<b>' + esc(i0.job ? i0.job.name : '') + '</b> ' + esc(i0.name) + (x.e0 > hi ? ' <em>&rarr;</em>' : '');
        }
        tr.appendChild(el);
      });
      /* Load against the working window. Overload is REPORTED, never smoothed away by moving
         work: a machine booked past 100% is the answer to "why is this job late", and the
         earlier attempt to queue it flat invented dates months out. */
      let load = '';
      if (S.work) {
        const w = windows()[wcOf(list[0])];
        const cap = w ? (w.to - w.from) / 60 : 10;
        const p = Math.round(hrs / cap * 100);
        const col = p > 100 ? '#e66767' : (p > 85 ? '#F58220' : '#8a8f9c');
        load = ' &middot; <span style="color:' + col + (p > 100 ? ';font-weight:600' : '') + '">' +
          p + '% of ' + cap.toFixed(1) + 'h</span>';
      }
      row.innerHTML = '<div class="rn" style="height:' + rowH + 'px">' + esc(k) + '<small>' + list.length + ' ops &middot; ' + hrs.toFixed(1) + 'h' + (nWo ? ' &middot; ' + nWo + ' WO' : '') + load + '</small></div>';
      row.appendChild(tr); root.appendChild(row);
    });
    b.appendChild(root);
    A.setBARS(BARS);
    b.onclick = ev => {
      const t = ev.target.closest && ev.target.closest('.seg2'); if (!t) return;
      const bar = A.BARS()[+t.dataset.bar]; if (!bar) return;
      if (bar.list.length === 1) window.open(trackUrl(bar.list[0]), '_blank');
      else openPop(ev, bar.list, bar.wo ? ('Work order ' + bar.wo.name) : (bar.list.length + ' operations'),
        bar.list[0].name + ' - ' + bar.list[0]._eq + ' - ' + bar.list.length + ' parts');
    };
  }

  // work-order operation is the authoritative grouping; everything else falls back to a time merge
  function bars(list, allByWo) {
    const out = [], wo = {}, loose = [];
    list.forEach(i => { const k = woOf(i); if (k) { (wo[k] = wo[k] || []).push(i); } else loose.push(i); });
    Object.entries(wo).forEach(([k, v]) => out.push({
      s: Math.min(...v.map(i => +new Date(i.scheduledStartTimeUtc))),
      e: Math.max(...v.map(i => +new Date(i.scheduledEndTimeUtc))),
      list: v, wo: v[0].workOrderOperationSummary, woKey: k, woTotal: (allByWo[k] || v).length
    }));
    if (S.detail) { loose.forEach(i => out.push({ s: +new Date(i.scheduledStartTimeUtc), e: +new Date(i.scheduledEndTimeUtc), list: [i] })); }
    else {
      const ss = loose.map(i => ({ s: +new Date(i.scheduledStartTimeUtc), e: +new Date(i.scheduledEndTimeUtc), i })).sort((a, b) => a.s - b.s), cl = [];
      ss.forEach(x => {
        const last = cl[cl.length - 1];
        if (last && x.s <= last.e + 30 * 6e4) { last.e = Math.max(last.e, x.e); last.list.push(x.i); }
        else cl.push({ s: x.s, e: x.e, list: [x.i] });
      });
      cl.forEach(c => out.push({ s: c.s, e: c.e, list: c.list }));
    }
    return lanes(out, 's', 'e');
  }

  function order(keepAnchor) {
    const b = body();
    const prevLeft = b.scrollLeft, prevPx = (A.CTX() || {}).px;
    b.innerHTML = '';
    const all = items(), allByWo = {};
    all.forEach(i => { const k = woOf(i); if (k) (allByWo[k] = allByWo[k] || []).push(i); });
    const list = all.filter(i => soOf(i) === S.so), meta = soList().find(x => x.so === S.so) || {};
    const sm = q('.sum');
    if (!list.length) { b.innerHTML = '<div class="empty" style="padding:40px">no planned operations on this order</div>'; if (sm) sm.innerHTML = ''; return; }
    const s0 = Math.min(...list.map(i => +new Date(i.scheduledStartTimeUtc)));
    const e1 = Math.max(...list.map(i => +new Date(i.scheduledEndTimeUtc)));
    const due = meta.due, originK = dk(new Date(s0)), lastK = dk(new Date(Math.max(e1, due || 0)));
    const n = Math.max(3, Math.min(Math.round((kd(lastK) - kd(originK)) / DAY) + 1, 400));
    const avail = Math.max(400, b.clientWidth - LABW - 2), fitPx = avail / n;
    if (S.px == null) S.px = fitPx;
    S.px = Math.max(fitPx * 0.98, Math.min(S.px, 160));
    const px = S.px, W = Math.round(n * px);
    A.setCTX({ originK, n, px, W, fitPx });
    const zl = q('.zlev'); if (zl) zl.textContent = px >= fitPx * 1.02 ? (px.toFixed(0) + ' px/day') : ('fit ' + n + 'd');
    const woOps = new Set(list.map(woOf).filter(Boolean));
    let cross = 0; woOps.forEach(k => { if (new Set((allByWo[k] || []).map(i => i.job.name)).size > 1) cross++; });
    if (sm) sm.innerHTML = '<div><div class="k">Order</div><div class="v">SO' + esc(S.so) + '</div></div>' +
      '<div><div class="k">Customer</div><div class="v">' + esc(meta.cust || '') + '</div></div>' +
      '<div><div class="k">Jobs</div><div class="v">' + (meta.jobs ? meta.jobs.size : 0) + '</div></div>' +
      '<div><div class="k">Operations</div><div class="v">' + list.length + '</div></div>' +
      '<div><div class="k">Work orders</div><div class="v">' + woOps.size + (cross ? ' <span style="color:#F58220">(' + cross + ' cross-job)</span>' : '') + '</div></div>' +
      '<div><div class="k">Shop hours</div><div class="v">' + (meta.hrs || 0).toFixed(1) + ' h</div></div>' +
      '<div><div class="k">Planned span</div><div class="v">' + md(new Date(s0)) + ' &ndash; ' + md(new Date(e1)) + '</div></div>' +
      (due != null ? '<div><div class="k">Customer due</div><div class="v">' + md(new Date(due)) + '</div></div>' : '');
    const pos = ms => {
      const d = new Date(ms), idx = Math.round((kd(dk(d)) - kd(originK)) / DAY);
      const p = F({ hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(d);
      return (idx + (+p.find(z => z.type === 'hour').value * 60 + +p.find(z => z.type === 'minute').value) / 1440) * px;
    };
    let grid = '', head = '', band = '', segStart = 0, segLabel = null;
    const flush = end => { if (segLabel == null) return; band += '<div class="mb" style="left:' + (segStart * px) + 'px;width:' + ((end - segStart) * px) + 'px">' + segLabel + '</div>'; };
    for (let i = 0; i < n; i++) {
      const d = new Date(kd(originK).getTime() + i * DAY), w = wd(d), we = (w === 'Sat' || w === 'Sun');
      const dn = F({ day: 'numeric' }).format(d), ml = F({ month: 'long', year: 'numeric' }).format(d);
      if (ml !== segLabel) { flush(i); segStart = i; segLabel = ml; }
      const cell = '<div class="cell' + (we ? ' we' : '') + '" style="left:' + (i * px) + 'px;width:' + px + 'px">';
      grid += cell + '</div>';
      let lab = ''; if (px >= 30) lab = '<b>' + w.charAt(0) + '</b>' + dn; else if (px >= 16) lab = dn; else if (px >= 7) lab = (w === 'Mon' ? dn : '');
      head += cell + (lab ? '<div class="dl">' + lab + '</div>' : '') + '</div>';
    }
    flush(n);
    const nowP = pos(Date.now()), dueP = due != null ? pos(due) : null;
    const marks = () => ((nowP >= 0 && nowP <= W) ? '<div class="now" style="left:' + nowP + 'px"><span>NOW</span></div>' : '') +
      ((dueP != null && dueP >= 0 && dueP <= W) ? '<div class="due" style="left:' + dueP + 'px"><span>CUSTOMER DUE</span></div>' : '');
    const g = document.createElement('div'); g.className = 'g'; g.style.width = (LABW + W) + 'px';
    g.innerHTML = '<div class="hrow"><div class="rl">job / ' + ({ op: 'process step', machine: 'machine', dept: 'department' }[S.by]) +
      '</div><div class="track" style="height:46px;width:' + W + 'px">' + band + head + marks() + '</div></div>';
    const BARS = [];
    const byJob = {}; list.forEach(i => { (byJob[i.job.name] = byJob[i.job.name] || []).push(i); });
    Object.keys(byJob).sort((a, b2) => Math.min(...byJob[a].map(i => +new Date(i.scheduledStartTimeUtc))) - Math.min(...byJob[b2].map(i => +new Date(i.scheduledStartTimeUtc))))
      .forEach(jn => {
        const jl = byJob[jn], j0 = jl[0].job;
        const jh = jl.reduce((a, i) => a + H(i.estimatedTotalTimeInSeconds || 0), 0);
        const js = Math.min(...jl.map(i => +new Date(i.scheduledStartTimeUtc))), je = Math.max(...jl.map(i => +new Date(i.scheduledEndTimeUtc)));
        const jwo = new Set(jl.map(woOf).filter(Boolean));
        const hd = document.createElement('div'); hd.className = 'jobhd'; hd.style.width = (LABW + W) + 'px';
        hd.innerHTML = '<div class="jl"><b>' + esc(jn) + '</b><small>' + esc((j0.parentItemReference && j0.parentItemReference.number) || '') + '</small></div>' +
          '<div class="jm"><span>' + jl.length + ' ops</span><span>' + jh.toFixed(1) + ' h</span><span>' + new Set(jl.map(i => i._eq)).size + ' machines</span>' +
          (jwo.size ? '<span style="color:#F58220">' + jwo.size + ' work order' + (jwo.size > 1 ? 's' : '') + '</span>' : '') +
          '<span>' + md(new Date(js)) + ' &ndash; ' + md(new Date(je)) + '</span></div>';
        g.appendChild(hd);
        const sub = {}; jl.forEach(i => { const k = ({ op: i.name, machine: i._eq, dept: i._wc || '(none)' })[S.by]; (sub[k] = sub[k] || []).push(i); });
        Object.keys(sub).sort((a, b2) => Math.min(...sub[a].map(i => +new Date(i.scheduledStartTimeUtc))) - Math.min(...sub[b2].map(i => +new Date(i.scheduledStartTimeUtc))))
          .forEach(sk => {
            const l = sub[sk], hrs = l.reduce((a, i) => a + H(i.estimatedTotalTimeInSeconds || 0), 0);
            const B = bars(l, allByWo), rowH = Math.max(44, B.count * 29 + 14);
            const row = document.createElement('div'); row.className = 'row'; row.style.width = (LABW + W) + 'px';
            const tr = document.createElement('div'); tr.className = 'track'; tr.style.height = rowH + 'px'; tr.style.width = W + 'px';
            tr.innerHTML = grid + marks();
            B.items.forEach(c => {
              const p0 = pos(c.s), p1 = pos(c.e), one = c.list.length === 1 && !c.wo, i0 = c.list[0];
              const anyRun = c.list.some(i => i.status === 'Running'), allW = c.list.every(i => i.status === 'Pending');
              const outside = c.wo ? (c.woTotal - c.list.length) : 0;
              const el = document.createElement('div');
              el.className = 'seg2' + (anyRun ? ' run' : (allW ? ' wait' : '')) + (c.wo ? ' wo' : '') + (outside > 0 ? ' shared' : '');
              el.style.left = Math.max(0, p0) + 'px'; el.style.width = Math.max(3, Math.min(W, p1) - Math.max(0, p0)) + 'px'; el.style.top = (7 + c.lane * 29) + 'px';
              el.dataset.bar = BARS.push(c) - 1;
              const chrs = c.list.reduce((a, i) => a + H(i.estimatedTotalTimeInSeconds || 0), 0);
              if (c.wo) {
                el.dataset.wo = c.woKey;
                const grp = allByWo[c.woKey] || c.list;
                const oj = [...new Set(grp.map(i => i.job.name))].filter(x => x !== jn);
                const os = [...new Set(grp.map(soOf))].filter(s => s && s !== S.so);
                el.title = 'WORK ORDER ' + c.wo.name + ' - ' + i0.name + NL + i0._eq + NL + c.list.length + ' parts from ' + jn + (outside > 0 ? (' (+' + outside + ' elsewhere)') : '') + NL +
                  (oj.length ? ('also covers jobs: ' + oj.join(', ') + NL) : '') + (os.length ? ('also covers SO' + os.join(', SO') + NL) : '') +
                  chrs.toFixed(1) + 'h - ' + c.wo.status + NL + 'click to pick a part';
                el.innerHTML = '<span class="wob">WO ' + esc(c.wo.name) + '</span>' + esc(i0.name) + ' <span style="opacity:.8">' + c.list.length + ' parts' + (outside > 0 ? ' +' + outside : '') + '</span>';
              } else if (one) {
                el.title = i0.name + NL + i0._eq + NL + partOf(i0) + NL + chrs.toFixed(1) + 'h - ' + i0.status + NL + 'click to open in Job Tracking';
                el.innerHTML = esc(i0.name) + ' <span style="opacity:.8">' + esc(i0._eq) + '</span>';
              } else {
                el.title = c.list.length + ' operations merged (overlapping in time, no shared work order)' + NL + chrs.toFixed(1) + 'h' + NL + 'click to pick one';
                el.innerHTML = '<em>' + c.list.length + '&times;</em>' + esc([...new Set(c.list.map(i => i.name))].length === 1 ? i0.name : 'ops') + ' <span style="opacity:.8">' + chrs.toFixed(0) + 'h</span>';
              }
              tr.appendChild(el);
            });
            const nWo = new Set(l.map(woOf).filter(Boolean)).size;
            row.innerHTML = '<div class="rn sub" style="height:' + rowH + 'px"><b>' + esc(sk) + '</b><small>' + l.length + ' ops &middot; ' + hrs.toFixed(1) + 'h' + (nWo ? ' &middot; ' + nWo + ' WO' : '') + '</small></div>';
            row.appendChild(tr); g.appendChild(row);
          });
      });
    b.appendChild(g);
    A.setBARS(BARS);
    if (keepAnchor && prevPx) b.scrollLeft = (prevLeft + keepAnchor.x) * (px / prevPx) - keepAnchor.x;
    b.onmouseover = ev => { const t = ev.target.closest && ev.target.closest('.seg2[data-wo]'); if (!t) return; b.querySelectorAll('.seg2[data-wo="' + t.dataset.wo + '"]').forEach(x => x.classList.add('hl')); };
    b.onmouseout = ev => { const t = ev.target.closest && ev.target.closest('.seg2[data-wo]'); if (!t) return; b.querySelectorAll('.seg2.hl').forEach(x => x.classList.remove('hl')); };
    b.onclick = ev => {
      const t = ev.target.closest && ev.target.closest('.seg2'); if (!t) return;
      const bar = A.BARS()[+t.dataset.bar]; if (!bar) return;
      if (ev.shiftKey) { window.open(jobUrl(bar.list[0]), '_blank'); return; }
      if (bar.list.length === 1) window.open(trackUrl(bar.list[0]), '_blank');
      else openPop(ev, bar.list, bar.wo ? ('Work order ' + bar.wo.name) : (bar.list.length + ' operations'),
        bar.list[0].name + ' - ' + bar.list[0]._eq + ' - ' + bar.list.length + ' parts');
    };
    b.onwheel = ev => {
      if (!ev.ctrlKey) return; ev.preventDefault();
      const x = ev.clientX - b.getBoundingClientRect().left - LABW;
      const before = S.px; S.px = Math.max(1, Math.min(160, S.px * (ev.deltaY < 0 ? 1.25 : 0.8)));
      if (Math.abs(S.px - before) > 0.01) order({ x: Math.max(0, x) });
    };
  }
  A.board = board; A.day = day; A.order = order;
})();

/* ------------------------------------------------ part 3: shell, view switcher, data loading */
(function () {
  const A = window.ISCApp, S = A.S;
  const { esc, dk, DAY, kd, soList, closePop } = A;
  const VIEWS = [['fulcrum', 'Fulcrum'], ['board', 'Day board'], ['day', 'Day flow'], ['order', 'Order gantt']];

  // "Fulcrum" is not a copy of their board - it hides ours so the real one shows through
  /* The way back in is EMBEDDED in Fulcrum's own schedule toolbar, not floated over the page:
     it sits first in the row, left of the warning icon, and matches their button metrics
     (48px tall, 0 20px padding, 8px radius, 14.4px Inter). ISC Orange, filled solid, so it
     reads as ours rather than as something Fulcrum shipped. */
  let pillTimer = null;
  function pillBack() {
    const p = document.getElementById('iscapp-pill'); if (p) p.remove();
    if (pillTimer) { clearInterval(pillTimer); pillTimer = null; }
    const rr = document.getElementById('iscapp'); if (rr) rr.style.display = 'flex';
    S.view = 'board'; paint();
  }
  function mountPill() {
    if (document.getElementById('iscapp-pill')) return true;
    const jb = [...document.querySelectorAll('j-button')].find(b => (b.innerText || '').trim().indexOf('Reschedule') === 0);
    const row = jb && jb.parentElement;
    if (!row) return false;
    const b = document.createElement('button');
    b.id = 'iscapp-pill';
    b.textContent = 'ISC views';
    b.style.cssText = 'height:48px;padding:0 20px;border:0;border-radius:8px;cursor:pointer;flex:0 0 auto;' +
      'font:600 14.4px/20px Inter,sans-serif;background:#F58220;color:#1a1206;';
    b.onclick = pillBack;
    row.insertBefore(b, row.children[0]);
    return true;
  }
  function showFulcrum() {
    const r = document.getElementById('iscapp'); if (r) r.style.display = 'none';
    closePop();
    // Angular re-renders this toolbar, so re-mount if it gets wiped. Poll, never a subtree
    // MutationObserver - one that also writes DOM feeds itself and locks the tab up.
    mountPill();
    if (!pillTimer) pillTimer = setInterval(mountPill, 700);
  }
  function controls() {
    const c = document.querySelector('#iscapp .ctl'); if (!c) return;
    if (S.view === 'board') {
      c.innerHTML = '<input type="date" class="c-start" value="' + S.day + '">' +
        '<select class="c-days"><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select>';
      c.querySelector('.c-days').value = S.days;
      c.querySelector('.c-start').onchange = e => { S.day = e.target.value; A.board(); };
      c.querySelector('.c-days').onchange = e => { S.days = +e.target.value; A.board(); };
    } else if (S.view === 'day') {
      c.innerHTML = '<button class="btn c-prev">&lsaquo;</button><input type="date" class="c-day" value="' + S.day + '"><button class="btn c-next">&rsaquo;</button>' +
        '<button class="btn c-work' + (S.work ? ' on' : '') + '" title="Draw estimated work laid into working hours, instead of the raw start-to-end envelope">Work hours</button>';
      const shift = n => { S.day = dk(new Date(kd(S.day).getTime() + n * DAY)); controls(); A.day(); };
      c.querySelector('.c-day').onchange = e => { S.day = e.target.value; A.day(); };
      c.querySelector('.c-prev').onclick = () => shift(-1);
      c.querySelector('.c-next').onclick = () => shift(1);
      c.querySelector('.c-work').onclick = e => { S.work = !S.work; e.target.classList.toggle('on', S.work); A.day(); };
    } else if (S.view === 'order') {
      const sos = soList();
      if (!S.so && sos.length) S.so = sos[0].so;
      c.innerHTML = '<select class="c-so">' + sos.map(s => '<option value="' + s.so + '"' + (s.so === S.so ? ' selected' : '') + '>SO' + s.so + ' &middot; ' + esc(s.cust) + ' (' + s.ops + ' ops)</option>').join('') + '</select>' +
        '<span class="lab">rows</span><select class="c-by"><option value="op">Process step</option><option value="dept">Department</option><option value="machine">Machine</option></select>' +
        '<button class="btn z-out">&minus;</button><span class="lab zlev" style="min-width:66px;text-align:center"></span><button class="btn z-in">+</button>' +
        '<button class="btn z-fit">Fit</button><button class="btn z-week">Week</button><button class="btn z-today">Today</button>' +
        '<button class="btn c-detail' + (S.detail ? ' on' : '') + '">Expand overlaps</button>';
      c.querySelector('.c-by').value = S.by;
      c.querySelector('.c-so').onchange = e => { S.so = e.target.value; S.px = null; A.order(); };
      c.querySelector('.c-by').onchange = e => { S.by = e.target.value; A.order({ x: 0 }); };
      const zoom = f => { const b = S.px; S.px = Math.max(1, Math.min(160, S.px * f)); if (Math.abs(S.px - b) > 0.01) A.order({ x: 0 }); };
      c.querySelector('.z-in').onclick = () => zoom(1.4);
      c.querySelector('.z-out').onclick = () => zoom(1 / 1.4);
      // fractional day widths leave a few px of phantom scroll, so re-measure after layout
      c.querySelector('.z-fit').onclick = () => {
        const b = document.querySelector('#iscapp .body');
        S.px = null; A.order({ x: 0 });
        for (let i = 0; i < 3 && b.scrollWidth > b.clientWidth; i++) {
          const over = b.scrollWidth - b.clientWidth;
          const tw = parseFloat(document.querySelector('#iscapp .hrow .track').style.width) || 1;
          S.px = S.px * ((tw - over - 2) / tw); A.order({ x: 0 });
        }
        b.scrollLeft = 0;
      };
      c.querySelector('.z-week').onclick = () => { S.px = 34; A.order(); };
      c.querySelector('.z-today').onclick = () => {
        const b = document.querySelector('#iscapp .body'), t = b.querySelector('.now');
        if (t) b.scrollLeft = Math.max(0, parseFloat(t.style.left) - 250);
      };
      c.querySelector('.c-detail').onclick = e => { S.detail = !S.detail; e.target.classList.toggle('on', S.detail); A.order({ x: 0 }); };
    } else c.innerHTML = '';
  }
  function paint() {
    const r = document.getElementById('iscapp'); if (!r) return;
    r.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.view));
    const sum = r.querySelector('.sum'), lg = r.querySelector('.lg');
    if (S.view === 'fulcrum') { showFulcrum(); return; }
    sum.style.display = S.view === 'order' ? 'flex' : 'none';
    lg.style.display = (S.view === 'order' || S.view === 'day') ? 'flex' : 'none';
    controls();
    closePop();
    const b = r.querySelector('.body');
    b.onmouseover = b.onmouseout = b.onclick = b.onwheel = null; b.scrollLeft = 0;
    if (S.view === 'board') A.board();
    else if (S.view === 'day') A.day();
    else if (S.view === 'order') { S.px = null; A.order(); }
  }
  function shell() {
    const r = document.createElement('div'); r.id = 'iscapp';
    r.innerHTML = '<div class="bar"><span class="mark"><b>ISC</b></span>' +
      '<span class="seg">' + VIEWS.map(v => '<button data-v="' + v[0] + '">' + v[1] + '</button>').join('') + '</span>' +
      '<span class="ctl"></span><span class="sp"></span>' +
      '<span class="lab cnt"></span><button class="btn c-close">Close</button></div>' +
      '<div class="note"><span>Planned dates come from Fulcrum&rsquo;s auto-scheduler &mdash; greedy, no frozen window. ' +
      'The median operation has moved <b>14 days</b> from where it was first planned. Read this for <b>sequence and load</b>, not deadlines.</span>' +
      '<button class="x" title="hide">&times;</button></div>' +
      '<div class="sum"></div>' +
      '<div class="lg"><span><i style="background:#3987e5"></i>Planned</span><span><i style="background:#199e70"></i>Running now</span>' +
      '<span><i style="background:#6a6d78"></i>Waiting on upstream</span>' +
      '<span><i style="background:#2f6bb5"></i>WO n = one work order, many parts (hover to link)</span>' +
      '<span><i style="border:1px dashed #F58220;background:transparent"></i>reaches outside this job</span>' +
      '<span style="opacity:.7">click a bar &rarr; Job Tracking &middot; shift+click &rarr; job record &middot; ctrl+scroll = zoom</span></div>' +
      '<div class="body"></div>';
    document.body.appendChild(r);
    r.querySelectorAll('.seg button').forEach(b => b.onclick = () => { S.view = b.dataset.v; paint(); });
    r.querySelector('.note .x').onclick = () => { r.querySelector('.note').style.display = 'none'; };
    r.querySelector('.c-close').onclick = () => {
      closePop(); r.remove();
      const p = document.getElementById('iscapp-pill'); if (p) p.remove();
    };
    return r;
  }
  async function load(r) {
    const b = r.querySelector('.body');
    b.innerHTML = '<div id="iscboot2"><div>Loading the schedule from Fulcrum</div><div class="pb"><i></i></div><div class="msg" style="opacity:.6;font-size:12.5px"></div></div>';
    const sys = await (await fetch('/api/Scheduling/get-system-data', { credentials: 'include' })).json();
    const eq = sys.equipment.filter(e => e.isScheduled); let done = 0;
    const pageAll = async e => {
      let out = [], p = 0;
      while (p < 12) {
        const u = '/api/Scheduling/get-schedule?EquipmentId=' + e.id + '&Page=' + p + '&LateJobsFilter=false&Priorities=Low&Priorities=Moderate&Priorities=High&DebugMode=false';
        const j = await (await fetch(u, { credentials: 'include' })).json();
        out = out.concat(j.scheduleItems || []);
        if (j.isEndOfData) break;
        p++;
      }
      done++;
      const bar = b.querySelector('.pb i'), msg = b.querySelector('.msg');
      if (bar) bar.style.width = Math.round(done / eq.length * 100) + '%';
      if (msg) msg.textContent = done + ' of ' + eq.length + ' machines';
      return out.map(i => Object.assign({}, i, { _eq: e.name, _wc: e.workCenter && e.workCenter.name }));
    };
    const l = [...eq], all = [];
    while (l.length) { const bt = l.splice(0, 6); (await Promise.all(bt.map(pageAll))).forEach(x => all.push(...x)); }
    S.items = all; window.__all = all;
    r.querySelector('.cnt').textContent = all.length + ' operations / ' + eq.length + ' machines';
  }
  const r = shell();
  (async () => {
    try {
      if (window.__all && window.__all.length) {
        S.items = window.__all;
        r.querySelector('.cnt').textContent = window.__all.length + ' operations';
      } else await load(r);
      S.view = 'board'; paint();
    } catch (e) {
      r.querySelector('.body').innerHTML = '<div class="empty" style="padding:40px">failed to load: ' + e + '</div>';
    }
  })();
  A.paint = paint; A.showFulcrum = showFulcrum;
})();
