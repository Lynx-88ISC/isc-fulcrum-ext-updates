/* Fulcrum Active Materials - attachment sync (MAIN world).
 *
 * Engineering attaches drawings to ITEMS. Fulcrum snapshots an item's attachments onto a
 * job when the job is created, and never again - so anything added to the item afterwards
 * never reaches the job, and the operator working that subassembly never sees it.
 *
 * This adds a button on the job page that compares every subassembly against its parent
 * item and offers to make the job match. The item is the source of truth and is NEVER
 * written to.
 *
 * This is the only feature in this extension that writes. Rules it holds to:
 *   - nothing happens without an explicit Apply and a confirm
 *   - an item that cannot be read is SKIPPED, never judged (a failed read must not look
 *     like "the item has no attachments" and trigger deletions)
 *   - job-level uploads - attachments with no item scope - are never touched
 *
 * An attachment counts as present on the job for an item when it is job-owned and carries
 * that item's scope (parentType Item + parentId, or metadata.ItemId). NOT by
 * AttachmentLevel: a record can be AttachmentLevel "JobTracking_Operation" and still be
 * item-scoped, and Job Tracking renders it under Subassembly (Item). Matching on
 * AttachmentLevel instead produced false "missing" rows that would have created duplicates.
 *
 * Matching is by file id. The same filename recurs across items with different file ids.
 */
(() => {
  if (window.__famSyncInstalled) return;
  window.__famSyncInstalled = true;

  const root = document.documentElement;
  const ISC_ORANGE = "#F58220";

  const JOB_PATH = /^\/ui\/jobs\/([0-9a-f]{24})\/details/;
  // The BOM & Routing header action row, alongside Update Options / Edit BOM & Routing.
  // This is a BOM-level operation, not an attachment-pane one.
  const HOST = ".juicy-fulcrum-bom-nested-view-header-actions";
  const BTN_ID = "fam-sync-btn";
  const OVERLAY_ID = "fam-sync-overlay";

  const syncOn = () => root.getAttribute("data-fam-sync") !== "off";
  const jobIdFromPath = () => {
    const m = JOB_PATH.exec(location.pathname);
    return m ? m[1] : null;
  };

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const getJson = async (url) => {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) return null;
    try { return await r.json(); } catch (e) { return null; }
  };

  const jobAttachments = (jobId) =>
    getJson("/api/attachments/getFileAttachmentByOwner?ownerId=" + jobId +
            "&attachmentType=Standard&children=true&ownerType=Job");

  // The ownerType=Item variant strips metadata, but it still returns name + file, which is
  // all the item side needs.
  const itemAttachments = (itemId) =>
    getJson("/api/attachments/getFileAttachmentByOwner?ownerId=" + itemId +
            "&attachmentType=Standard&children=true&ownerType=Item");

  function itemScope(a) {
    if (a.metadata && a.metadata.ItemId) return a.metadata.ItemId;
    if (a.parentType === "Item" && a.parentId) return a.parentId;
    return null;
  }

  // Pending and Ready both mean nobody has touched it yet - Ready only means queued and
  // available. Treating "not Pending" as started flagged untouched work as in progress.
  const NOT_STARTED = { Pending: 1, Ready: 1, Cancelled: 1 };

  /* ---------- scan ---------- */

  async function scan(jobId) {
    const [atts, roll, opList] = await Promise.all([
      jobAttachments(jobId),
      getJson("/api/JobDetailPage/GetJobItemRollup?jobId=" + jobId + "&isEditMode=false"),
      getJson("/api/JobDetailPage/GetJobDetailsOperationList?jobId=" + jobId)
    ]);
    if (!atts || !roll) return null;

    // item -> operations, carrying the ids Job Tracking needs to deep-link
    const opsByItem = new Map();
    for (const it of ((opList && opList.items) || [])) {
      const iid = it.itemReference && it.itemReference.id;
      if (!iid) continue;
      const list = (it.operations || []).map((o) => ({
        guid: o.id, sysId: o.systemOperationId, name: o.name,
        status: o.status, itemToMakeId: it.id,
        onWorkOrder: !!o.isOnWorkOrder,
        workOrderId: o.workOrder && o.workOrder.id,
        workOrderOperationId: o.workOrderOperationReference && o.workOrderOperationReference.id
      }));
      opsByItem.set(iid, (opsByItem.get(iid) || []).concat(list));
    }
    // Job Tracking addresses work-order operations differently from job operations.
    // Building the job form for an operation that lives on a work order yields a dead link.
    //
    // Which operation to point at: the one the attachment names, if it is still workable.
    // Otherwise the first workable one - a finished operation is not what the operator
    // wants to open, and Job Tracking refuses to load a completed work-order operation at
    // all ("we weren't able to find this operation").
    const DONE = { Complete: 1, Cancelled: 1 };
    const trackUrl = (itemId, sysOpId) => {
      const ops = opsByItem.get(itemId) || [];
      if (!ops.length) return null;
      const named = sysOpId ? ops.find((o) => o.sysId === sysOpId) : null;
      const workable = ops.filter((o) => !DONE[o.status]);
      const op = (named && !DONE[named.status] && named) || workable[0] || named || ops[0];
      const base = location.origin + "/jobtracking/#/operation?";
      if (op.onWorkOrder && op.workOrderId && op.workOrderOperationId) {
        return base + "type=WorkOrder&selectedOperationId=" + op.workOrderOperationId +
               "&workOrderId=" + op.workOrderId +
               "&workOrderOperationId=" + op.workOrderOperationId;
      }
      if (op.onWorkOrder) return null; // on a work order but missing its ids - no guess
      return base + "type=Job&jobId=" + jobId +
             "&selectedOperationId=" + op.guid + "&selectedItemToMakeId=" + op.itemToMakeId;
    };

    const jobByItem = new Map();
    for (const a of atts) {
      const s = itemScope(a);
      if (!s) continue;
      if (!jobByItem.has(s)) jobByItem.set(s, new Map());
      jobByItem.get(s).set(a.file && a.file.id, a);
    }

    // Everything the job references: the BOM rollup, plus any item already tagged on the
    // job (which can sit outside the rollup - judging those blind would delete valid records).
    const ids = new Set((roll.makeItems || []).map((m) => m.item.id));
    for (const s of jobByItem.keys()) ids.add(s);
    const labels = new Map((roll.makeItems || []).map((m) => [m.item.id, m.item.number || m.item.name]));

    const adds = [], removes = [], skipped = [];
    for (const id of ids) {
      const list = await itemAttachments(id);
      if (!Array.isArray(list)) { skipped.push(labels.get(id) || id); continue; }
      if (!labels.has(id)) {
        const it = await getJson("/api/items/" + id);
        labels.set(id, (it && (it.number || it.name)) || id);
      }
      const have = jobByItem.get(id) || new Map();
      const onItem = new Set(list.map((a) => a.file && a.file.id).filter(Boolean));
      // Pending and Ready both mean nobody has touched it - Ready only means queued and
      // available. Treating "not Pending" as started flagged untouched work.
      const statuses = [...new Set((opsByItem.get(id) || []).map((o) => o.status))];
      const started = statuses.some((s) => s && !NOT_STARTED[s]);

      for (const a of list) {
        const fid = a.file && a.file.id;
        if (fid && !have.has(fid)) {
          adds.push({ itemId: id, item: labels.get(id) || id, file: a.name, src: a,
                      started, statuses, url: trackUrl(id, a.metadata && a.metadata.OperationId) });
        }
      }
      for (const [fid, a] of have) {
        // Operation images are job-level and production owns them - never remove one,
        // even if its file is gone from the item.
        if ((a.metadata && a.metadata.AttachmentLevel) === "JobTracking_Operation") continue;
        if (fid && !onItem.has(fid)) {
          removes.push({ itemId: id, item: labels.get(id) || id, file: a.name, rec: a,
                         started, statuses, url: trackUrl(id, a.metadata && a.metadata.OperationId) });
        }
      }
    }
    return { itemCount: ids.size, adds, removes, skipped };
  }

  /* ---------- writes ---------- */

  // Always writes at Item level. The star (operation image) is a JOB-level decision that
  // production owns, so this never creates one - even when the source attachment is the
  // item's own operation image. Mirroring the metadata verbatim would set operation images
  // on the job, silently overriding what the shop set up.
  //
  // Item level is king for the Subassembly section; job level is king for the star.
  //
  // AutodeskForgeUrn is kept - it only drives the CAD preview for that file.
  function addBody(jobId, entry) {
    const s = entry.src;
    const md = Object.assign({}, s.metadata, { ItemId: entry.itemId, AttachmentLevel: "Item" });
    delete md.OperationId;
    delete md.OperationOrder;
    delete md.StepId;
    return [{
      metadata: md,
      ownerType: "Job", ownerId: jobId, ownerPath: "", ownerName: "",
      parentType: "Item", parentId: entry.itemId, parentPath: "", parentName: "",
      isNoteAttachment: false, isBarcode: false, purchaseOrder: null,
      name: s.name,
      file: { id: s.file.id, name: s.file.name, size: s.file.size },
      fileSummary: { id: s.file.id, name: s.file.name, size: s.file.size },
      thumbnail: s.thumbnail || null, needsThumbnail: !s.thumbnail,
      mediumThumbnail: s.mediumThumbnail || null, needsMediumThumbnail: !s.mediumThumbnail,
      needsCADProcessing: false, description: s.description || "",
      isImage: !!s.isImage, isCADFile: !!s.isCADFile, isVideoFile: !!s.isVideoFile,
      isDocument: !!s.isDocument, isPDF: !!s.isPDF,
      attachmentType: s.attachmentType || "Standard", certificationLotGuid: null
    }];
  }

  async function applyChanges(jobId, addList, removeList, onProgress) {
    let ok = 0, failed = 0;
    for (const a of addList) {
      try {
        const r = await fetch("/api/attachments/saveFileAttachments?allowDuplicates=true", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(addBody(jobId, a))
        });
        r.ok ? ok++ : failed++;
      } catch (e) { failed++; }
      onProgress(ok, failed);
    }
    // Deleting a tag record leaves the original attachment and the stored file intact -
    // it only removes that one reference.
    for (const r0 of removeList) {
      try {
        const r = await fetch("/api/attachments/deleteFileAttachments", {
          method: "DELETE", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(r0.rec)
        });
        r.ok ? ok++ : failed++;
      } catch (e) { failed++; }
      onProgress(ok, failed);
    }
    return { ok, failed };
  }

  /* ---------- the screen ---------- */

  function rowHtml(o, kind, i) {
    return '<tr>' +
      '<td style="padding:5px 8px;border-bottom:1px solid #2c3037"><input type="checkbox" checked data-t="' + kind + '" data-i="' + i + '" style="accent-color:' + ISC_ORANGE + '"></td>' +
      '<td style="padding:5px 8px;border-bottom:1px solid #2c3037;color:#9aa1ab">' + esc(o.item) + '</td>' +
      '<td style="padding:5px 8px;border-bottom:1px solid #2c3037">' + esc(o.file) + '</td>' +
      '<td style="padding:5px 8px;border-bottom:1px solid #2c3037;font-size:11px;color:' + (o.started ? ISC_ORANGE : "#6f757e") + '">' +
        (o.statuses.length ? esc(o.statuses.join(", ")) : "no operations") + '</td>' +
      '<td style="padding:5px 8px;border-bottom:1px solid #2c3037;text-align:right">' +
        (o.url ? '<a href="' + esc(o.url) + '" target="_blank" rel="noopener" style="color:' + ISC_ORANGE + ';text-decoration:none;font-size:11px">Job Tracking</a>' : "") +
      '</td></tr>';
  }

  function sectionHtml(title, arr, kind, note) {
    const th = "padding:6px 8px;border-bottom:1px solid #3a3f47;text-align:left;font-weight:600;" +
               "font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#8d949e";
    const head = '<thead><tr>' +
      '<th style="' + th + ';width:28px"><input type="checkbox" checked data-all="' + kind + '" ' +
        'title="Select all in this section" style="accent-color:' + ISC_ORANGE + '"></th>' +
      '<th style="' + th + '">Subassembly</th>' +
      '<th style="' + th + '">Attachment</th>' +
      '<th style="' + th + '">Operation status</th>' +
      '<th style="' + th + ';text-align:right">Open</th>' +
      '</tr></thead>';
    return '<div style="display:flex;align-items:center;gap:10px;margin:18px 0 6px">' +
      '<strong>' + title + '</strong><span style="color:' + ISC_ORANGE + '">' + arr.length + '</span>' +
      (note ? '<span style="font-weight:400;opacity:.6;font-size:11.5px">' + note + '</span>' : "") +
      '</div>' +
      (arr.length ? '<table style="border-collapse:collapse;width:100%;font-size:12px">' + head +
                    "<tbody>" + arr.map((o, i) => rowHtml(o, kind, i)).join("") + "</tbody></table>"
                  : '<div style="opacity:.5">nothing</div>');
  }

  async function openOverlay() {
    const jobId = jobIdFromPath();
    if (!jobId) return;
    document.getElementById(OVERLAY_ID)?.remove();

    const ov = document.createElement("div");
    ov.id = OVERLAY_ID;
    ov.style.cssText = "position:fixed;inset:40px;z-index:2147483600;background:#23262b;color:#d4d4e2;" +
      "border:1px solid " + ISC_ORANGE + ";border-radius:10px;display:flex;flex-direction:column;" +
      "font:13px/1.45 Inter,system-ui,sans-serif;box-shadow:0 8px 40px rgba(0,0,0,.6)";
    ov.innerHTML = '<div style="padding:20px 16px;opacity:.7">Scanning subassemblies...</div>';
    document.body.appendChild(ov);

    const result = await scan(jobId);
    if (!result) {
      ov.innerHTML = '<div style="padding:20px 16px">Could not read this job. Nothing was changed.' +
        '<button id="fam-sync-close" style="margin-left:12px;background:#3a3f47;color:#d4d4e2;border:0;border-radius:6px;padding:6px 12px;cursor:pointer">Close</button></div>';
      ov.querySelector("#fam-sync-close").onclick = () => ov.remove();
      return;
    }
    const { itemCount, adds, removes, skipped } = result;

    ov.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #3a3f47">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + ISC_ORANGE + '"></span>' +
        '<strong style="font-size:14px">Sync attachments from items</strong>' +
        '<span style="opacity:.6">' + itemCount + ' items checked</span><span style="flex:1"></span>' +
        '<label style="font-size:12px;cursor:pointer"><input type="checkbox" checked id="fam-sync-all" style="accent-color:' + ISC_ORANGE + ';vertical-align:-1px"> select everything</label>' +
        '<button id="fam-sync-close" style="margin-left:12px;background:#3a3f47;color:#d4d4e2;border:0;border-radius:6px;padding:6px 12px;cursor:pointer">Close</button>' +
      '</div>' +
      '<div style="flex:1;overflow:auto;padding:14px 16px">' +
        sectionHtml("Add to job", adds, "add", "on the item, missing from this job") +
        sectionHtml("Remove from job", removes, "remove", "item-scoped records whose file is gone from the item") +
        (skipped.length ? '<div style="margin-top:18px;color:' + ISC_ORANGE + '">' + skipped.length +
          ' item(s) could not be read - skipped, nothing judged against them</div>' : "") +
      '</div>' +
      '<div style="padding:12px 16px;border-top:1px solid #3a3f47;display:flex;align-items:center;gap:10px">' +
        '<span id="fam-sync-msg" style="opacity:.7;font-size:12px">Items are never modified. Job-level uploads are never touched.</span>' +
        '<span style="flex:1"></span>' +
        '<button id="fam-sync-apply" style="background:' + ISC_ORANGE + ';color:#fff;border:0;border-radius:6px;padding:8px 18px;font-weight:600;cursor:pointer"' +
          ((adds.length + removes.length) ? "" : " disabled") + '>Apply</button>' +
      '</div>';

    const boxes = (kind) => [...ov.querySelectorAll('input[data-t="' + kind + '"]')];
    ov.querySelectorAll("input[data-all]").forEach((master) => {
      master.onchange = () => boxes(master.dataset.all).forEach((b) => { b.checked = master.checked; });
    });
    ov.querySelector("#fam-sync-all").onchange = (e) => {
      ov.querySelectorAll('input[type="checkbox"]').forEach((b) => { b.checked = e.target.checked; });
    };
    ov.querySelector("#fam-sync-close").onclick = () => ov.remove();

    // Confirmation is drawn in the overlay rather than window.confirm(): a native dialog
    // can be suppressed by the browser, and when it is, confirm() returns false and Apply
    // aborts with no feedback at all. This also shows exactly what is about to be written.
    ov.querySelector("#fam-sync-apply").onclick = () => {
      const picked = [...ov.querySelectorAll("input[data-t]:checked")].map((c) => ({ t: c.dataset.t, i: +c.dataset.i }));
      const A = picked.filter((p) => p.t === "add").map((p) => adds[p.i]);
      const R = picked.filter((p) => p.t === "remove").map((p) => removes[p.i]);
      const msg = ov.querySelector("#fam-sync-msg");
      const btn = ov.querySelector("#fam-sync-apply");

      if (!A.length && !R.length) {
        msg.textContent = "Nothing selected.";
        return;
      }

      btn.style.display = "none";
      const bar = document.createElement("span");
      bar.id = "fam-sync-confirm";
      bar.style.cssText = "display:flex;align-items:center;gap:10px";
      bar.innerHTML =
        '<span style="font-size:12px">Write <strong style="color:' + ISC_ORANGE + '">' + A.length +
        '</strong> add' + (A.length === 1 ? "" : "s") + ' and <strong style="color:' + ISC_ORANGE + '">' +
        R.length + '</strong> removal' + (R.length === 1 ? "" : "s") + ' to this job?</span>' +
        '<button id="fam-sync-cancel" style="background:#3a3f47;color:#d4d4e2;border:0;border-radius:6px;padding:7px 14px;cursor:pointer">Cancel</button>' +
        '<button id="fam-sync-go" style="background:' + ISC_ORANGE + ';color:#fff;border:0;border-radius:6px;padding:7px 16px;font-weight:600;cursor:pointer">Yes, write it</button>';
      btn.parentElement.appendChild(bar);

      bar.querySelector("#fam-sync-cancel").onclick = () => {
        bar.remove();
        btn.style.display = "";
        msg.textContent = "Cancelled - nothing was written.";
      };
      bar.querySelector("#fam-sync-go").onclick = async () => {
        bar.remove();
        btn.style.display = "";
        btn.disabled = true;
        btn.style.opacity = ".5";
        const res = await applyChanges(jobId, A, R, (ok, failed) => {
          msg.textContent = "working... " + ok + " done" + (failed ? ", " + failed + " failed" : "");
        });
        msg.textContent = res.ok + " applied" + (res.failed ? ", " + res.failed + " failed" : "") + " - rescanning...";
        setTimeout(openOverlay, 900);
      };
    };
  }

  /* ---------- the button ---------- */

  let mounted = false;

  function sync() {
    const host = document.querySelector(HOST);
    const wanted = !!host && !!jobIdFromPath() && syncOn();

    if (!wanted) {
      document.getElementById(BTN_ID)?.remove();
      document.getElementById(OVERLAY_ID)?.remove();
      mounted = false;
      return;
    }
    let btn = document.getElementById(BTN_ID);
    // Angular rebuilds the header on navigation, taking our node with it.
    if (!btn || !btn.isConnected || btn.parentElement !== host) {
      btn?.remove();
      btn = document.createElement("button");
      btn.id = BTN_ID;
      btn.type = "button";
      btn.textContent = "Sync attachments";
      btn.title = "Compare each subassembly against its parent item and offer to make the job match";
      btn.style.cssText = "background:transparent;color:" + ISC_ORANGE +
        ";border:1px solid " + ISC_ORANGE + ";border-radius:6px;padding:5px 12px;cursor:pointer;" +
        "font:600 12px/1 Inter,system-ui,sans-serif;align-self:center;white-space:nowrap;margin:0 8px";
      btn.addEventListener("click", openOverlay);
      // First in the row, so Fulcrum's own actions keep their usual position on the right.
      host.insertBefore(btn, host.firstChild);
      mounted = true;
    }
  }

  setInterval(sync, 500);

  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-fam-sync"] });
})();
