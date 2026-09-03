/* ==========================================================================
   Kandy's Treats — Inventory
   --------------------------------------------------------------------------
   The seven batch-cooked products, and what happened to each of them today.

   THE ONE DISTINCTION THIS SCREEN HAS TO MAKE

   Half these numbers are derived and half are typed, and confusing the two is
   how an inventory system stops being believed. So they are visually separate
   and labelled:

     derived   opening (carried from the last count), customer consumption
               (from orders that reached the kitchen), expected closing,
               variance. None of these is an input anywhere on the page,
               because none of them has a column to write to.

     recorded  prepared, waste, staff meal, adjustment, physical count. Each
               is a form, each is attributed, and each becomes a ledger row
               that cannot afterwards be edited.

   Where a product has never been counted, the screen says "not established"
   rather than showing zero — an unknown opening and an empty pot are
   different facts, and only one of them can be fixed by counting.

   Rendering only. Every query lives in js/services/admin-inventory.js.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var svc = null;
  var mountGen = 0;
  var viewGen = -1;
  var stopViewport = null;

  var state = {
    loading: true, error: null,
    day: null, history: null,
    open: null,        /* menu_item_id whose entry panel is expanded */
    form: null,        /* { kind, qty, reason, note } */
    saving: false,
    showHistory: false
  };
  var ctx = { role: "staff" };

  function canAdjust() { return KT.admin.rank(ctx.role) >= KT.admin.rank("supervisor"); }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  var LAGOS = { timeZone: "Africa/Lagos" };
  function clock(v) {
    if (!v) return "—";
    return new Date(v).toLocaleTimeString("en-NG", Object.assign({
      hour: "2-digit", minute: "2-digit", hour12: false }, LAGOS));
  }

  /** Portions can be fractional; trailing ".00" is noise on a kitchen screen. */
  function num(v) {
    if (v === null || v === undefined) return null;
    var n = Number(v);
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
  }
  function show(v, dash) { var s = num(v); return s === null ? (dash || "—") : s; }

  var KINDS = [
    { id: "prepared",   label: "Prepared",   hint: "Cooked and ready to sell", sup: false },
    { id: "waste",      label: "Waste",      hint: "Thrown away — needs a reason", sup: false },
    { id: "staff_meal", label: "Staff meal", hint: "Eaten by the team", sup: false },
    { id: "adjustment", label: "Adjustment", hint: "Correcting the ledger", sup: true },
    { id: "count",      label: "Physical count", hint: "What is actually there now", sup: true }
  ];

  /* ---- One product ------------------------------------------------------ */

  function cell(label, value, cls) {
    return '<div class="invc ' + (cls || "") + '">' +
      '<span class="invc__n">' + value + "</span>" +
      '<span class="invc__l">' + esc(label) + "</span></div>";
  }

  function rowHTML(it) {
    var open = state.open === it.menu_item_id;
    var unestablished = !it.opening_established;
    var expected = it.expected_closing;
    var variance = it.variance;

    var varianceCell = "";
    if (variance !== null && variance !== undefined) {
      var v = Number(variance);
      varianceCell = cell("variance",
        (v > 0 ? "+" : "") + num(v),
        "invc--derived " + (v === 0 ? "is-flat" : v < 0 ? "is-short" : "is-over"));
    }

    return (
      '<article class="invrow' + (open ? " is-open" : "") + '">' +
        '<button class="invrow__head" type="button" data-invopen="' + esc(it.menu_item_id) + '" ' +
          'aria-expanded="' + (open ? "true" : "false") + '">' +
          '<span class="invrow__name"><strong>' +
            esc(String(it.name).replace(/\s*\(per .*?\)\s*/i, "")) + "</strong>" +
            '<span class="invrow__unit">per ' + esc(it.sale_unit) + "</span></span>" +
          '<span class="invrow__figs">' +
            cell("opening", unestablished
              ? '<span class="invc__none">not set</span>' : show(it.opening), "invc--derived") +
            cell("prepared", show(it.prepared, "0"), "invc--rec") +
            cell("sold", show(it.consumed, "0"), "invc--derived") +
            cell("waste", show(it.waste, "0"), "invc--rec") +
            cell("staff", show(it.staff_meal, "0"), "invc--rec") +
            cell("adjust", show(it.adjustment, "0"), "invc--rec") +
            cell("expected", expected === null
              ? '<span class="invc__none">—</span>'
              : (Number(expected) < 0 ? '<span class="is-negative">' + num(expected) + "</span>"
                                      : num(expected)), "invc--derived is-total") +
            cell("counted", show(it.counted), "invc--rec") +
            varianceCell +
          "</span>" +
          '<span class="invrow__chev">' + KT.icon("chevronDown", 16) + "</span>" +
        "</button>" +
        (open ? panelHTML(it) : "") +
      "</article>"
    );
  }

  /* ---- The entry panel -------------------------------------------------- */

  function reasonsFor(kind) {
    if (!svc) return [];
    if (kind === "waste") return svc.WASTE_REASONS;
    if (kind === "adjustment") return svc.ADJUSTMENT_REASONS;
    return [];
  }

  function panelHTML(it) {
    var f = state.form || { kind: "prepared", qty: "", reason: "", note: "" };
    var kinds = KINDS.filter(function (k) { return !k.sup || canAdjust(); });
    var reasons = reasonsFor(f.kind);
    var needsReason = f.kind === "waste" || f.kind === "adjustment";
    var meta = KINDS.filter(function (k) { return k.id === f.kind; })[0] || KINDS[0];

    return (
      '<div class="invrow__body">' +
        (it.opening_established
          ? '<p class="invnote">Opening carried from the count on ' +
            esc(it.opening_from) + ".</p>"
          : '<p class="invnote invnote--warn">Opening stock not established — ' +
            "record a physical count to start tracking this product.</p>") +

        '<div class="ochips invkinds">' +
          kinds.map(function (k) {
            return '<button class="chip' + (f.kind === k.id ? " is-active" : "") +
              '" type="button" data-invkind="' + k.id + '">' + esc(k.label) + "</button>";
          }).join("") +
        "</div>" +
        '<p class="invhint">' + esc(meta.hint) + "</p>" +

        '<div class="invform">' +
          '<label class="field invform__qty">' +
            '<span class="field__label">' +
              (f.kind === "count" ? "Counted" : "Quantity") + "</span>" +
            '<input class="input" type="number" step="0.25" inputmode="decimal" ' +
              'data-invqty value="' + esc(f.qty) + '" ' +
              'placeholder="' + (f.kind === "adjustment" ? "+ or −" : "0") + '">' +
          "</label>" +
          (needsReason
            ? '<label class="field invform__reason"><span class="field__label">Reason</span>' +
              '<select class="select" data-invreason>' +
                '<option value="">Choose a reason…</option>' +
                reasons.map(function (r) {
                  return '<option value="' + r.id + '"' +
                    (f.reason === r.id ? " selected" : "") + ">" + esc(r.label) + "</option>";
                }).join("") +
              "</select></label>"
            : "") +
          '<label class="field invform__note"><span class="field__label">Note</span>' +
            '<input class="input" type="text" data-invnote value="' + esc(f.note) + '" ' +
              'placeholder="Optional"></label>' +
          '<button class="btn btn--primary invform__go" type="button" data-invsave' +
            (state.saving ? " disabled" : "") + ">" +
            (state.saving ? KT.spinner(15) + "<span>Saving…</span>" : "Record") +
          "</button>" +
        "</div>" +
        '<p class="invhint">Recorded entries cannot be edited afterwards. A ' +
          "mistake is fixed with an adjustment that references it, so both stay " +
          "in the history.</p>" +
      "</div>"
    );
  }

  /* ---- History ---------------------------------------------------------- */

  function historyHTML() {
    var h = state.history;
    if (!h || !h.rows || !h.rows.length) {
      return '<p class="odetail__muted">Nothing recorded today yet.</p>';
    }
    return '<ul class="invhist">' + h.rows.map(function (r) {
      var sign = r.kind === "waste" || r.kind === "staff_meal" ? "−" :
                 r.kind === "count" ? "=" :
                 (Number(r.qty) < 0 ? "" : "+");
      return "<li>" +
        '<span class="invhist__kind invhist__kind--' + esc(r.kind) + '">' +
          esc(r.kind.replace("_", " ")) + "</span>" +
        '<span class="invhist__what"><strong>' +
          esc(String(r.product).replace(/\s*\(per .*?\)\s*/i, "")) + "</strong> " +
          sign + num(Math.abs(Number(r.qty))) +
          (r.reason ? ' <span class="invhist__why">' + esc(r.reason.replace("_", " ")) + "</span>" : "") +
          (r.corrects_id ? ' <span class="invhist__why">correction</span>' : "") +
          (r.note ? " — " + esc(r.note) : "") +
        "</span>" +
        '<span class="invhist__who">' + (esc(r.actor) || "<em>unknown</em>") +
          " · " + clock(r.created_at) + "</span>" +
      "</li>";
    }).join("") + "</ul>";
  }

  /* ---- Page ------------------------------------------------------------- */

  function bodyHTML() {
    var d = state.day;
    if (!d) return "";
    if (!d.tracked) {
      return '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("receipt", 32) + "</div>" +
        "<h3>Inventory was not tracked on this date</h3>" +
        "<p>Tracking began on " + esc(d.activated_on || "a later date") +
        ". Nothing before then was recorded, and nothing has been invented for it.</p>" +
        "</div></div>";
    }
    return (
      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("flame", 17) + "Today's stock</h2>" +
          '<span class="dsec__hint">' + esc(d.business_date) + "</span></header>" +
        '<p class="eodlede">' +
          '<span class="invkey invkey--derived"></span>worked out by the system · ' +
          '<span class="invkey invkey--rec"></span>recorded by the team' +
        "</p>" +
        '<div class="invlist">' + d.items.map(rowHTML).join("") + "</div>" +
      "</section>" +

      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("clock", 17) + "Today's entries</h2>" +
          '<button class="osection__more" type="button" data-invhist>' +
            (state.showHistory ? "Hide" : "Show") + "</button>" +
        "</header>" +
        (state.showHistory ? '<div class="panel apanel">' + historyHTML() + "</div>" : "") +
      "</section>"
    );
  }

  function render() {
    if (viewGen !== mountGen) return;
    var host = KT.qs("[data-admin-page]");
    if (!host) return;

    var a = document.activeElement;
    var key = a && a.getAttribute && (a.hasAttribute("data-invqty") ? "qty"
      : a.hasAttribute("data-invnote") ? "note" : null);
    var caret = key ? a.selectionStart : null;

    var body;
    if (state.loading) {
      body = '<div class="panel apanel">' + KT.skeleton.lines(6) + "</div>";
    } else if (state.error) {
      body = '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("close", 32) + "</div>" +
        "<h3>We could not load inventory</h3><p>" + esc(state.error) + "</p>" +
        '<button class="btn btn--primary" type="button" data-invretry>Try again</button>' +
        "</div></div>";
    } else {
      body = bodyHTML();
    }

    KT.mount(host,
      '<header class="apage__head opage__head"><div><h1>Inventory</h1>' +
        '<p class="apage__lede">What was cooked, sold, wasted and counted — for the ' +
        "seven products portioned by hand.</p></div>" +
        /*
           A kitchen leaves this screen open. Loaded at 23:50 and looked at
           again at 00:10, it would still be showing yesterday's board while
           the server had already moved to the new Lagos business day — the
           ledger stays correct either way, because inventory_record() stamps
           the date server-side, but the heading would name the wrong day.
           Observed exactly that crossing 2026-09-03 into 09-04 during
           testing, which is why there is a way to re-ask.
        */
        '<button class="btn btn--soft btn--sm" type="button" data-invretry' +
          (state.loading ? " disabled" : "") + ">" +
          (state.loading ? KT.spinner(15) + "<span>Refreshing…</span>" : "Refresh") +
        "</button>" +
      "</header>" + body);

    if (key) {
      var again = KT.qs(key === "qty" ? "[data-invqty]" : "[data-invnote]");
      if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (e) {} }
    }
  }

  /* ---- Data -------------------------------------------------------------- */

  async function load() {
    var gen = mountGen;
    state.loading = true; state.error = null;
    render();
    try {
      if (!svc) svc = (await import("../services/admin-inventory.js")).adminInventoryService;
      var got = await Promise.all([svc.day(), svc.history()]);
      if (gen !== mountGen) return;
      state.day = got[0];
      state.history = got[1];
    } catch (error) {
      if (gen !== mountGen) return;
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
    } finally {
      if (gen === mountGen) { state.loading = false; render(); }
    }
  }

  async function save() {
    var f = state.form;
    if (!f || state.saving || !state.open) return;
    var qty = Number(f.qty);
    if (!f.qty || Number.isNaN(qty)) { KT.toast("Enter a quantity.", "error"); return; }
    if (f.kind !== "adjustment" && qty <= 0) {
      KT.toast("Quantity must be more than zero.", "error"); return;
    }
    if ((f.kind === "waste" || f.kind === "adjustment") && !f.reason) {
      KT.toast("Choose a reason.", "error"); return;
    }
    state.saving = true; render();
    try {
      if (f.kind === "count") await svc.count(state.open, qty, f.note);
      else await svc.record(state.open, f.kind, qty, f.reason, f.note);
      state.form = { kind: f.kind, qty: "", reason: "", note: "" };
      KT.toast("Recorded.", "success");
      await load();
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    } finally {
      state.saving = false; render();
    }
  }

  /* ---- Entry point ------------------------------------------------------- */

  KT.admin.views.inventory = function (viewCtx) {
    ctx = viewCtx || ctx;
    var gen = ++mountGen;
    viewGen = gen;
    state = { loading: true, error: null, day: null, history: null,
      open: null, form: null, saving: false, showHistory: false };

    /* Number inputs on a phone raise the keyboard over the Record button;
       the same helper both chats and the end-of-day form use. */
    if (!stopViewport) stopViewport = KT.viewportInset.start();

    setTimeout(function () { if (gen === mountGen) load(); }, 0);
    return '<header class="apage__head"><div><h1>Inventory</h1>' +
      '<p class="apage__lede">Loading today\'s stock…</p></div></header>' +
      '<div class="panel apanel">' + KT.skeleton.lines(6) + "</div>";
  };

  KT.admin.views.inventoryTeardown = function () {
    mountGen += 1;
    if (stopViewport) { stopViewport(); stopViewport = null; }
  };

  /* ---- Events ------------------------------------------------------------ */

  document.addEventListener("click", function (e) {
    var t = e.target;

    if (t.closest("[data-invretry]")) { load(); return; }
    if (t.closest("[data-invhist]")) { state.showHistory = !state.showHistory; render(); return; }

    var open = t.closest("[data-invopen]");
    if (open) {
      var id = open.getAttribute("data-invopen");
      state.open = state.open === id ? null : id;
      state.form = { kind: "prepared", qty: "", reason: "", note: "" };
      render();
      return;
    }

    var kind = t.closest("[data-invkind]");
    if (kind) {
      state.form = state.form || {};
      state.form.kind = kind.getAttribute("data-invkind");
      /* Reasons are per kind, so a stale one must not carry across. */
      state.form.reason = "";
      render();
      return;
    }

    if (t.closest("[data-invsave]")) { save(); }
  });

  document.addEventListener("input", function (e) {
    var t = e.target;
    if (!state.form) return;
    if (t.closest && t.closest("[data-invqty]")) { state.form.qty = t.value; return; }
    if (t.closest && t.closest("[data-invnote]")) { state.form.note = t.value; }
  });

  document.addEventListener("change", function (e) {
    var sel = e.target.closest && e.target.closest("[data-invreason]");
    if (!sel || !state.form) return;
    state.form.reason = sel.value;
  });
})(window.KT || (window.KT = {}));
