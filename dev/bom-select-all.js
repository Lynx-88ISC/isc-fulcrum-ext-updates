/* Fulcrum Active Materials - select/deselect all on the BOM "Required Items & Materials" list.
 *
 * Adds one ISC-orange checkbox above the item rows that ticks or clears the whole list. Appears on
 * both the Item Production BOM and the Job BOM.
 *
 * TWO PAGES, TWO VERY DIFFERENT COSTS (measured 2026-10-22, job 2610-1043-1):
 *
 *   Item Production BOM  has a "Save Changes" button. Ticking only stages; one save when you choose.
 *   Job BOM              has NO save button. EVERY checkbox click fires
 *                          POST /api/JobDetailPage/SaveJob              (saves the WHOLE job)
 *                          POST /api/JobDetailPage/GetPurchasingDemandForJob
 *
 * So on a job, "select all" over 20 rows is up to 20 full job saves and 20 demand recalculations
 * from a single click, with no undo. That is why the job page asks first and the item page does not.
 * Do not "simplify" this by dropping the confirm.
 *
 * SCOPING MATTERS. A document-wide j-checkbox selector is WRONG: the Job BOM page also renders a
 * mat-accordion of ~30 "Location & Lot Number" picking checkboxes which must never be touched. So
 * anchor on the panel heading and take only the rows inside that list.
 *
 * Rows are <j-checkbox>; the three toggles (Group With Previous / Include Machine Time / Show items
 * associated to other operations) are <j-switch>, so the element name alone separates them - no text
 * matching, and no matching on class names either (Fulcrum ships a misspelling,
 * "juicy-bom-editor-oepration-det", in this very panel).
 *
 * Rows are driven with .click(), never by setting .checked: setting the property never reaches
 * Angular's form model, so the page would look right and save nothing.
 */
(() => {
  if (window.__famBomSelAllInstalled) return;
  window.__famBomSelAllInstalled = true;

  const root = document.documentElement;
  const CLS = "fam-bomsel";
  const ORANGE = "#F58220";
  const BOX = 24, PAD_LEFT = 12, GAP = 10;   // measured off the native rows: 24px box at x=112

  const on = () => root.getAttribute("data-fam-bom") !== "off";
  // the Job BOM writes on every tick; the Item BOM stages behind Save Changes
  const isJobPage = () => /^\/ui\/jobs\//.test(location.pathname);

  function listEl() {
    const h = [...document.querySelectorAll("*")].find(e =>
      e.children.length === 0 && /^Required Items\s*&\s*Materials$/i.test((e.textContent || "").trim()));
    if (!h) return null;
    let panel = h;
    for (let i = 0; i < 8 && panel; i++) {
      if (panel.querySelectorAll("j-checkbox").length >= 2) break;
      panel = panel.parentElement;
    }
    if (!panel) return null;
    const rows = rowsOf(panel);
    if (rows.length < 2) return null;
    // deepest container inside the panel that still holds every row
    let best = panel;
    for (let x = rows[0]; x && (panel.contains(x) || x === panel); x = x.parentElement) {
      if (rows.every(r => x.contains(r))) { best = x; break; }
    }
    return best;
  }
  const rowsOf = (scope) => [...scope.querySelectorAll("j-checkbox")]
    .filter(c => c.querySelector("input[type=checkbox]") && !c.getAttribute("data-" + CLS));
  const boxOf = (c) => c.querySelector("input[type=checkbox]");

  function apply(want) {
    const list = listEl(); if (!list) return;
    rowsOf(list).forEach(c => {
      const b = boxOf(c);
      if (b && b.checked !== want) b.click();
    });
    setTimeout(paint, 0);
  }

  function askThenApply(bar, want, count) {
    // an in-page confirm, not window.confirm(): the preview pane suppresses native confirms
    // (returns false instantly), which is how an earlier feature silently did nothing
    let ask = bar.nextElementSibling;
    if (!ask || ask.getAttribute("data-" + CLS) !== "ask") {
      ask = document.createElement("div");
      ask.setAttribute("data-" + CLS, "ask");
      ask.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;" +
        "padding:8px 10px;margin:0 0 8px;border-radius:6px;background:rgba(245,130,32,.12);" +
        "border:1px solid rgba(245,130,32,.45);font:500 12px Inter,system-ui,sans-serif;color:#e6e6f0;";
      bar.parentElement.insertBefore(ask, bar.nextSibling);
    }
    ask.textContent = "";
    const msg = document.createElement("span");
    msg.textContent = (want ? "Tick" : "Clear") + " all " + count + " items? This saves the job " +
      count + " times and recalculates purchasing demand.";
    const go = document.createElement("button");
    go.textContent = want ? "Tick all" : "Clear all";
    go.style.cssText = "border:0;border-radius:5px;padding:5px 11px;cursor:pointer;" +
      "font:600 12px Inter,system-ui,sans-serif;background:" + ORANGE + ";color:#1a1206;";
    const no = document.createElement("button");
    no.textContent = "Cancel";
    no.style.cssText = "border:1px solid #4a525d;border-radius:5px;padding:5px 11px;cursor:pointer;" +
      "font:600 12px Inter,system-ui,sans-serif;background:transparent;color:#e6e6f0;";
    go.onclick = (e) => { e.preventDefault(); e.stopPropagation(); ask.remove(); apply(want); };
    no.onclick = (e) => { e.preventDefault(); e.stopPropagation(); ask.remove(); paint(); };
    ask.append(msg, go, no);
  }

  function mount() {
    if (!on()) { teardown(); return; }
    const list = listEl(); if (!list) return;
    const rows = rowsOf(list); if (rows.length < 2) return;
    if (list.querySelector(":scope > [data-" + CLS + "='bar']")) { paint(); return; }

    const bar = document.createElement("label");
    bar.setAttribute("data-" + CLS, "bar");
    bar.style.cssText = "display:flex;align-items:center;gap:" + GAP + "px;" +
      "padding:6px 2px 10px " + PAD_LEFT + "px;margin:0 0 8px;cursor:pointer;" +
      "font:600 12.5px Inter,system-ui,sans-serif;color:" + ORANGE + ";user-select:none;" +
      "border-bottom:1px solid rgba(245,130,32,.3);width:100%;flex:0 0 auto;box-sizing:border-box;";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.setAttribute("data-" + CLS, "cb");
    cb.style.cssText = "width:" + BOX + "px;height:" + BOX + "px;flex:0 0 " + BOX + "px;" +
      "margin:0;cursor:pointer;accent-color:" + ORANGE + ";";
    const txt = document.createElement("span");
    bar.append(cb, txt);

    cb.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const want = cb.checked;
      const l = listEl(); if (!l) return;
      const count = rowsOf(l).length;
      if (isJobPage()) {
        paint();                       // put the control back; the confirm decides
        askThenApply(bar, want, count);
      } else {
        apply(want);
      }
    });

    const firstWrap = [...list.children].find(c => c.contains(rows[0]));
    list.insertBefore(bar, firstWrap || list.firstChild);
    paint();
  }

  function paint() {
    const bar = document.querySelector("[data-" + CLS + "='bar']"); if (!bar) return;
    const list = listEl(); if (!list) return;
    const cb = bar.querySelector("[data-" + CLS + "='cb']");
    const boxes = rowsOf(list).map(boxOf).filter(Boolean);
    const lit = boxes.filter(b => b.checked).length;
    cb.checked = boxes.length > 0 && lit === boxes.length;
    cb.indeterminate = lit > 0 && lit < boxes.length;
    bar.querySelector("span").textContent =
      (cb.checked ? "Deselect all" : "Select all") + "  (" + lit + " of " + boxes.length + ")";
  }

  function teardown() {
    document.querySelectorAll("[data-" + CLS + "]").forEach(e => {
      if (e.getAttribute("data-" + CLS) !== "cb") e.remove();
    });
  }

  // Polled, never a subtree MutationObserver on a panel we also write into - one that feeds
  // itself locks the tab up.
  setInterval(mount, 500);
  new MutationObserver(mount).observe(root, { attributes: true, attributeFilter: ["data-fam-bom"] });
})();
