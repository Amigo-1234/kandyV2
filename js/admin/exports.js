/* ==========================================================================
   Kandy's Treats — Exports
   --------------------------------------------------------------------------
   CSV renderings of reports that already exist. The screen offers a date or
   a range, calls the same function the corresponding admin page calls, and
   writes the answer to a file.

   PERMISSIONS ARE THE SOURCE'S, NOT THIS SCREEN'S

   Nothing here decides who may export what. Each export calls an RPC that
   already refuses the wrong tier — admin_payment_events() is manager+,
   admin_day_reports() is supervisor+, admin_inventory_day() is staff+ — so
   an export cannot reach past what the caller could already read. Buttons
   are hidden by role as a courtesy; the refusal comes from the database.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var svc = null;
  var mountGen = 0;
  var viewGen = -1;
  var stopViewport = null;

  var state = {
    from: "", to: "", day: "",
    busy: null,            /* id of the export currently running */
    last: null,            /* {id, rows, name} for the "what you got" line */
    error: null
  };
  var ctx = { role: "staff" };

  function rank(r) { return KT.admin.rank(ctx.role) >= KT.admin.rank(r); }
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /*
     Each entry names the tier its SOURCE enforces, so the list and the
     database cannot drift apart silently. `kind` picks the date control:
     a range for things that accumulate, a single day for things that are
     already day-scoped reports.
  */
  var EXPORTS = [
    { id: "orders",    label: "Orders",          min: "staff",
      kind: "range", note: "Every order in the range, with its operational fields." },
    { id: "scoops",    label: "Scoop sales",     min: "staff",
      kind: "day",   note: "Phase 01's daily scoop report, per product." },
    { id: "inventory", label: "Inventory",       min: "staff",
      kind: "day",   note: "The daily stock equation exactly as the Inventory page shows it." },
    { id: "staff",     label: "Staff activity & EOD", min: "supervisor",
      kind: "day",   note: "Derived activity plus end-of-day report status." },
    { id: "payments",  label: "Sales & payments", min: "admin",
      kind: "range", note: "Payment events. Management only." },
    { id: "careers",   label: "Careers applications", min: "admin",
      kind: "none",  note: "Applicant records. Management only." }
  ];

  /* ---- Download ---------------------------------------------------------
     A Blob and an object URL. No library, and nothing is uploaded anywhere
     to produce the file — the CSV is built in the page from data the user
     already has on screen rights to. */
  function download(filename, text) {
    var blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    /* Revoked on the next tick — too early and Safari cancels the save. */
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ---- Markup ------------------------------------------------------------ */

  function rowHTML(x) {
    var allowed = rank(x.min);
    var running = state.busy === x.id;
    return (
      '<article class="exrow' + (allowed ? "" : " is-locked") + '">' +
        '<div class="exrow__text"><strong>' + esc(x.label) + "</strong>" +
          '<span class="exrow__note">' + esc(x.note) + "</span>" +
          (allowed ? "" : '<span class="exrow__lock">' + KT.icon("lock", 13) +
            "Needs " + esc(x.min) + " access</span>") +
        "</div>" +
        '<span class="exrow__when">' +
          (x.kind === "range" ? "date range" : x.kind === "day" ? "one day" : "all") +
        "</span>" +
        (allowed
          ? '<button class="btn btn--soft btn--sm" type="button" data-exgo="' + x.id + '"' +
            (running ? " disabled" : "") + ">" +
            (running ? KT.spinner(15) + "<span>Building…</span>" : "Download CSV") + "</button>"
          : "") +
      "</article>"
    );
  }

  function bodyHTML() {
    return (
      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("clock", 17) + "Period</h2></header>" +
        '<div class="panel apanel exdates">' +
          '<label class="field"><span class="field__label">From</span>' +
            '<input class="input" type="date" data-exfrom value="' + esc(state.from) + '"></label>' +
          '<label class="field"><span class="field__label">To</span>' +
            '<input class="input" type="date" data-exto value="' + esc(state.to) + '"></label>' +
          '<label class="field"><span class="field__label">Single day</span>' +
            '<input class="input" type="date" data-exday value="' + esc(state.day) + '"></label>' +
        "</div>" +
        '<p class="invhint">Dates are Africa/Lagos business days, the same ' +
          "boundary the dashboard and the daily reports use. Leave blank for today.</p>" +
      "</section>" +

      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("arrowRight", 17) + "Available exports</h2></header>" +
        (state.error ? '<p class="invnote invnote--warn">' + esc(state.error) + "</p>" : "") +
        (state.last
          ? '<p class="invnote">Last download: <strong>' + esc(state.last.name) +
            "</strong> — " + state.last.rows + " row" + (state.last.rows === 1 ? "" : "s") +
            (state.last.rows === 0 ? " (nothing matched — the file has headers only)" : "") +
            "</p>"
          : "") +
        '<div class="exlist">' + EXPORTS.map(rowHTML).join("") + "</div>" +
      "</section>"
    );
  }

  function render() {
    if (viewGen !== mountGen) return;
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    var a = document.activeElement;
    var key = a && a.getAttribute &&
      (a.hasAttribute("data-exfrom") ? "from" : a.hasAttribute("data-exto") ? "to"
        : a.hasAttribute("data-exday") ? "day" : null);

    KT.mount(host,
      '<header class="apage__head"><div><h1>Exports</h1>' +
        '<p class="apage__lede">CSV copies of the reports this admin already ' +
        "produces. Nothing is recalculated for the file.</p></div></header>" + bodyHTML());

    if (key) {
      var again = KT.qs("[data-ex" + key + "]");
      if (again) again.focus();
    }
  }

  /* ---- Running one ------------------------------------------------------- */

  async function run(id) {
    var meta = EXPORTS.filter(function (x) { return x.id === id; })[0];
    if (!meta || state.busy) return;
    state.busy = id; state.error = null; render();
    try {
      if (!svc) svc = await import("../services/admin-exports.js");
      var s = svc.adminExportsService;
      var day = state.day || null;
      var res;
      if (id === "orders")         res = await s.orders(state.from || null, state.to || null,
                                          rank("admin"));
      else if (id === "payments")  res = await s.payments(state.from || null, state.to || null);
      else if (id === "inventory") res = await s.inventory(day);
      else if (id === "staff")     res = await s.staff(day);
      else if (id === "scoops")    res = await s.scoops(day);
      else if (id === "careers")   res = await s.careers();

      var stamp = (meta.kind === "day")
        ? (day || s.lagosToday())
        : (meta.kind === "range"
            ? (state.from || "start") + "_to_" + (state.to || s.lagosToday())
            : s.lagosToday());
      var filename = "kandys-" + res.name + "-" + stamp + ".csv";
      download(filename, svc.toCSV(res.headers, res.rows));
      state.last = { id: id, rows: res.rows.length, name: filename };
      if (res.note) state.error = res.note;
      KT.toast(res.rows.length + " row" + (res.rows.length === 1 ? "" : "s") + " exported.",
        "success");
    } catch (error) {
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
      KT.toast(state.error, "error", { duration: 6000 });
    } finally {
      state.busy = null; render();
    }
  }

  /* ---- Entry point ------------------------------------------------------- */

  KT.admin.views.exports = function (viewCtx) {
    ctx = viewCtx || ctx;
    var gen = ++mountGen; viewGen = gen;
    state = { from: "", to: "", day: "", busy: null, last: null, error: null };
    if (!stopViewport) stopViewport = KT.viewportInset.start();
    setTimeout(function () { if (gen === mountGen) render(); }, 0);
    return '<header class="apage__head"><div><h1>Exports</h1>' +
      '<p class="apage__lede">Loading…</p></div></header>' +
      '<div class="panel apanel">' + KT.skeleton.lines(4) + "</div>";
  };

  KT.admin.views.exportsTeardown = function () {
    mountGen += 1;
    if (stopViewport) { stopViewport(); stopViewport = null; }
  };

  /* ---- Events ------------------------------------------------------------ */

  document.addEventListener("click", function (e) {
    var go = e.target.closest && e.target.closest("[data-exgo]");
    if (go) run(go.getAttribute("data-exgo"));
  });

  document.addEventListener("change", function (e) {
    var t = e.target;
    if (!t.closest) return;
    if (t.hasAttribute("data-exfrom")) state.from = t.value;
    else if (t.hasAttribute("data-exto")) state.to = t.value;
    else if (t.hasAttribute("data-exday")) state.day = t.value;
  });
})(window.KT || (window.KT = {}));
