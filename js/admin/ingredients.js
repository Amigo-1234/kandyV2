/* ==========================================================================
   Kandy's Treats — Ingredients
   --------------------------------------------------------------------------
   Raw ingredients and supplies — rice by the bag, oil by the litre, packs by
   the carton. A separate register from the finished-dish inventory on
   #/inventory: nothing here is read by menu availability, and no ingredient
   is linked to a menu item.

   Staff record what was received, used and wasted. Supervisors and above
   also register ingredients, record adjustments and physical counts. Every
   entry carries a note, the person who made it and a date the server sets.

   "On hand" is only shown once an ingredient has been counted: it is the
   last count plus everything recorded since. Before the first count the
   screen says "not counted yet" and shows the net change on its own — never
   an invented zero.

   Past days are read-only: the date picker reads the register as it stood at
   the end of that day, and the entry form only exists for today.

   Rendering only. Every query lives in js/services/admin-ingredients.js.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var svc = null;
  var mountGen = 0;
  var viewGen = -1;
  var stopViewport = null;

  function freshState() {
    return {
      section: "stock",          /* stock | history */
      date: null,                /* null = today; YYYY-MM-DD = past, read-only */
      loading: true, error: null, data: null,
      q: "", category: "", lowOnly: false, archived: false,
      open: null, form: null, saving: false,
      edit: null,                /* { id|null, name, unit, category, reorder, notes, active, hasEntries } */
      recent: {},                /* ingredient id -> { loading, rows, error } */
      hist: { preset: "7", ingredient: "", kind: "", q: "", loading: false, error: null, data: null }
    };
  }
  var state = freshState();
  var ctx = { role: "staff" };

  function canManage() { return KT.admin.rank(ctx.role) >= KT.admin.rank("supervisor"); }

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
  function dayLabel(d, withYear) {
    if (!d) return "";
    var p = String(d).split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)).toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short", year: withYear ? "numeric" : undefined, timeZone: "UTC" });
  }
  function addDays(d, n) {
    var p = String(d).split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n, 12)).toISOString().slice(0, 10);
  }
  function num(v) {
    if (v === null || v === undefined) return null;
    var n = Number(v);
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
  }
  function today() { return state.data && state.data.today; }
  function isPast() { return !!(state.data && !state.data.is_today); }
  function unitLabel(u) {
    var m = svc && svc.UNITS.filter(function (x) { return x.id === u; })[0];
    return m ? m.label.replace(/\s*\(.*\)$/, "").toLowerCase() : u;
  }
  function catLabel(c) {
    var m = svc && svc.CATEGORIES.filter(function (x) { return x.id === c; })[0];
    return m ? m.label : c;
  }
  function qtyUnit(q, u) { return num(q) + " " + esc(u); }
  function errText(error) {
    return (KT.services && KT.services.errorMessage) ? KT.services.errorMessage(error) : String(error.message || error);
  }

  var KIND_LABEL = { received: "Received", used: "Used", waste: "Waste", adjustment: "Adjustment", count: "Count" };

  function flag(text, kind) { return '<span class="invflag invflag--' + kind + '">' + esc(text) + "</span>"; }
  function cell(label, value, cls) {
    return '<div class="invc ' + (cls || "") + '"><span class="invc__n">' + value + '</span><span class="invc__l">' +
      esc(label) + "</span></div>";
  }

  /* ---- Header, tabs, date ---------------------------------------------- */

  function tabsHTML() {
    return '<nav class="invtabs" aria-label="Inventory sections">' +
      '<a class="invtab" href="#/inventory">Dishes</a>' +
      '<a class="invtab" href="#/inventory" data-ingtohist>History</a>' +
      '<button class="invtab is-active" type="button" aria-pressed="true">Ingredients</button></nav>';
  }

  function subtabsHTML() {
    return '<div class="ochips ingsub" role="group" aria-label="Ingredients view">' +
      '<button class="chip' + (state.section === "stock" ? " is-active" : "") + '" type="button" data-ingsec="stock">Stock</button>' +
      '<button class="chip' + (state.section === "history" ? " is-active" : "") + '" type="button" data-ingsec="history">History</button>' +
      "</div>";
  }

  function dateBarHTML() {
    var t = today(), d = state.date || t;
    return '<div class="invdate">' +
      '<button class="btn btn--soft btn--sm invdate__step" type="button" data-ingstep="-1" aria-label="Previous day">‹</button>' +
      '<label class="invdate__pick"><span class="sr-only">Choose a day</span>' +
        '<input class="input" type="date" data-ingdate value="' + esc(d || "") + '"' + (t ? ' max="' + esc(t) + '"' : "") + "></label>" +
      '<button class="btn btn--soft btn--sm invdate__step" type="button" data-ingstep="1" aria-label="Next day"' +
        (!isPast() ? " disabled" : "") + ">›</button>" +
      (isPast() ? '<button class="btn btn--ghost btn--sm" type="button" data-ingtoday>Back to today</button>' : "") +
    "</div>";
  }

  /* ---- Register form ---------------------------------------------------- */

  function editHTML() {
    var f = state.edit;
    if (!f) return "";
    var isNew = !f.id;
    return '<section class="panel apanel ingedit" aria-labelledby="ingEditTitle">' +
      '<h3 id="ingEditTitle">' + (isNew ? "Add an ingredient" : "Edit " + esc(f.origName)) + "</h3>" +
      (isNew ? '<p class="invhint">Check the list first — an ingredient with the same name cannot be added twice.</p>' : "") +
      '<div class="ingedit__grid">' +
        '<label class="field"><span class="field__label">Name</span>' +
          '<input class="input" data-ingf="name" maxlength="60" value="' + esc(f.name) + '" placeholder="e.g. Rice (50kg bag)"></label>' +
        '<label class="field"><span class="field__label">Measured in</span>' +
          '<select class="select" data-ingf="unit"' + (f.hasEntries ? " disabled" : "") + ">" +
            '<option value="">Choose a unit…</option>' +
            svc.UNITS.map(function (u) {
              return '<option value="' + u.id + '"' + (f.unit === u.id ? " selected" : "") + ">" + esc(u.label) + "</option>";
            }).join("") + "</select>" +
          (f.hasEntries ? '<span class="field__hint">Fixed once stock has been recorded, so past entries keep their meaning.</span>' : "") +
        "</label>" +
        '<label class="field"><span class="field__label">Category</span><select class="select" data-ingf="category">' +
          svc.CATEGORIES.map(function (c) {
            return '<option value="' + c.id + '"' + (f.category === c.id ? " selected" : "") + ">" + esc(c.label) + "</option>";
          }).join("") + "</select></label>" +
        '<label class="field"><span class="field__label">Reorder when at or below <span class="invopt">optional</span></span>' +
          '<input class="input" type="number" min="0" step="0.25" inputmode="decimal" data-ingf="reorder" value="' + esc(f.reorder) + '"></label>' +
        '<label class="field ingedit__notes"><span class="field__label">Notes <span class="invopt">optional</span></span>' +
          '<textarea class="textarea" rows="2" maxlength="500" data-ingf="notes" placeholder="Supplier, brand, where it is kept…">' +
            esc(f.notes) + "</textarea></label>" +
        (isNew ? "" : '<label class="invcheck"><input type="checkbox" data-ingf="active"' + (f.active ? " checked" : "") +
          "> Active (untick to archive — its history is kept)</label>") +
      "</div>" +
      '<div class="ingedit__actions">' +
        '<button class="btn btn--primary" type="button" data-ingsave' + (state.saving ? " disabled" : "") + ">" +
          (state.saving ? KT.spinner(15) + "<span>Saving…</span>" : (isNew ? "Add ingredient" : "Save changes")) + "</button>" +
        '<button class="btn btn--ghost" type="button" data-ingcancel>Cancel</button></div>' +
    "</section>";
  }

  /* ---- One ingredient --------------------------------------------------- */

  function rowHTML(it) {
    var past = isPast();
    var open = state.open === it.id;
    var d = it.day;
    var flags = (!it.active ? flag("Archived", "muted") : "") +
      (it.low ? flag("Low stock", "entry") : "") +
      (it.active && d.missing_entry ? flag("Not entered", "muted") : "") +
      (it.active && d.missing_count ? flag("Not counted", "count") : "");
    var onHand = it.on_hand === null || it.on_hand === undefined
      ? '<span class="invc__none">not counted yet</span>' : num(it.on_hand);
    var lc = it.last_count;
    return '<article class="invrow ingrow' + (open ? " is-open" : "") + (!it.active ? " is-dim" : "") + '">' +
      '<button class="invrow__head" type="button" data-ingopen="' + esc(it.id) + '" aria-expanded="' + open + '">' +
        '<span class="invrow__name"><strong>' + esc(it.name) + "</strong>" +
          '<span class="invrow__unit">' + esc(catLabel(it.category)) + " · in " + esc(unitLabel(it.unit)) + "</span>" +
          (flags ? '<span class="invrow__flags">' + flags + "</span>" : "") + "</span>" +
        '<span class="invrow__figs">' +
          cell("on hand", onHand, "invc--derived is-total" + (it.low ? " is-short" : "")) +
          cell("received", num(d.received), "invc--rec") +
          cell("used", num(d.used), "invc--rec") +
          cell("waste", num(d.waste), "invc--rec") +
          cell("adjust", num(d.adjustment), "invc--rec") +
          cell("counted", d.counted === null || d.counted === undefined ? '<span class="invc__none">—</span>' : num(d.counted), "invc--rec") +
        "</span>" +
        '<span class="invrow__chev">' + KT.icon("chevronDown", 16) + "</span>" +
      "</button>" +
      (open ? '<div class="invrow__body">' +
        (it.notes ? '<p class="ingnotes">' + esc(it.notes) + "</p>" : "") +
        (lc ? '<p class="invnote">Last counted: <strong>' + qtyUnit(lc.qty, it.unit) + "</strong> on " +
               esc(dayLabel(lc.business_date)) + " at " + clock(lc.at) + (lc.by ? " by " + esc(lc.by) : "") + ".</p>"
            : '<p class="invnote invnote--warn">Never counted — on-hand stock is unknown until a supervisor counts it. ' +
              "Net change recorded so far: " + qtyUnit(it.net_without_count || 0, it.unit) + ".</p>") +
        (it.reorder_level !== null && it.reorder_level !== undefined
          ? '<p class="invhint">Reorder at or below ' + qtyUnit(it.reorder_level, it.unit) + ".</p>" : "") +
        (past ? '<p class="invhint">' + KT.icon("lock", 13) + " Viewing a past day — entries can only be recorded today.</p>"
              : !it.active ? '<p class="invhint">Archived. Reactivate it to record stock.</p>' : formHTML(it)) +
        (canManage() && !past ? '<p><button class="btn btn--ghost btn--sm" type="button" data-ingedit="' + esc(it.id) + '">Edit details</button></p>' : "") +
        "<h4>Recent entries</h4>" + recentHTML(it) +
      "</div>" : "") +
    "</article>";
  }

  function formHTML(it) {
    var f = state.form || { kind: "received", qty: "", reason: "", note: "" };
    var kinds = svc.KINDS.filter(function (k) { return !k.sup || canManage(); });
    var meta = svc.KINDS.filter(function (k) { return k.id === f.kind; })[0] || svc.KINDS[0];
    var reasons = f.kind === "waste" ? svc.WASTE_REASONS : f.kind === "adjustment" ? svc.ADJUSTMENT_REASONS : [];
    return '<div class="ochips invkinds">' + kinds.map(function (k) {
        return '<button class="chip' + (f.kind === k.id ? " is-active" : "") + '" type="button" data-ingkind="' + k.id + '">' +
          esc(k.label) + "</button>";
      }).join("") + "</div>" +
      '<p class="invhint">' + esc(meta.hint) + "</p>" +
      '<div class="invform">' +
        '<label class="field invform__qty"><span class="field__label">' + (f.kind === "count" ? "Counted" : "Quantity") +
          " (" + esc(it.unit) + ")</span>" +
          '<input class="input" type="number" step="0.25" inputmode="decimal" data-ingqty value="' + esc(f.qty) + '" placeholder="' +
            (f.kind === "adjustment" ? "+ or −" : "0") + '"></label>' +
        (reasons.length ? '<label class="field invform__reason"><span class="field__label">Reason</span>' +
          '<select class="select" data-ingreason><option value="">Choose a reason…</option>' +
          reasons.map(function (r) {
            return '<option value="' + r.id + '"' + (f.reason === r.id ? " selected" : "") + ">" + esc(r.label) + "</option>";
          }).join("") + "</select></label>" : "") +
        '<label class="field invform__note"><span class="field__label">Note <span class="invopt">optional</span></span>' +
          '<textarea class="textarea" rows="2" maxlength="500" data-ingnote placeholder="e.g. supplier, invoice no., what it was used for">' +
            esc(f.note) + "</textarea></label>" +
        '<button class="btn btn--primary invform__go" type="button" data-ingrecord' + (state.saving ? " disabled" : "") + ">" +
          (state.saving ? KT.spinner(15) + "<span>Saving…</span>" : "Record") + "</button>" +
      "</div>" +
      '<p class="invhint">Entries cannot be edited afterwards — a mistake is fixed with an adjustment, so both stay in the history.</p>';
  }

  function entryHTML(r, withName) {
    var sign = r.kind === "used" || r.kind === "waste" ? "−" : r.kind === "count" ? "=" : (Number(r.qty) < 0 ? "" : "+");
    return "<li>" +
      '<span class="invhist__kind invhist__kind--' + esc(r.kind === "received" ? "prepared" : r.kind) + '">' +
        esc(KIND_LABEL[r.kind] || r.kind) + "</span>" +
      '<span class="invhist__what">' + (withName ? "<strong>" + esc(r.ingredient) + "</strong> " : "") +
        sign + num(Math.abs(Number(r.qty))) + " " + esc(r.unit) +
        (r.reason ? ' <span class="invhist__why">' + esc(String(r.reason).replace(/_/g, " ")) + "</span>" : "") +
        (r.corrects_id ? ' <span class="invhist__why">correction</span>' : "") +
        (r.note ? '<span class="invhist__note">' + esc(r.note) + "</span>" : "") +
      "</span>" +
      '<span class="invhist__who">' + (esc(r.actor) || "<em>unknown</em>") + " · " + esc(dayLabel(r.business_date)) +
        " " + clock(r.created_at) + "</span></li>";
  }

  function recentHTML(it) {
    var r = state.recent[it.id];
    if (!r || r.loading) return KT.skeleton.lines(2);
    if (r.error) return '<p class="field__error">' + esc(r.error) + "</p>";
    if (!r.rows.length) return '<p class="odetail__muted">Nothing recorded in the last 30 days.</p>';
    return '<ul class="invhist">' + r.rows.slice(0, 15).map(function (x) { return entryHTML(x, false); }).join("") + "</ul>";
  }

  /* ---- Stock section ---------------------------------------------------- */

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return state.data.items.filter(function (i) {
      if (!state.archived && !i.active) return false;
      if (state.category && i.category !== state.category) return false;
      if (state.lowOnly && !i.low) return false;
      if (q && (i.name + " " + i.notes + " " + catLabel(i.category)).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function stockHTML() {
    var items = state.data.items.filter(function (i) { return i.active; });
    function stat(n, label, warn) {
      return '<div class="invsum__s' + (warn && n ? " is-warn" : "") + '"><strong>' + n + "</strong><span>" + esc(label) + "</span></div>";
    }
    var list = filtered();
    return (isPast()
        ? '<div class="invro" role="note">' + KT.icon("lock", 15) + "<span><strong>" + esc(dayLabel(state.data.business_date, true)) +
          " — read only.</strong> Showing stock as it stood at the end of that day.</span></div>" : "") +
      '<div class="invsum">' +
        stat(items.length, "ingredients") +
        stat(items.filter(function (i) { return i.low; }).length, "low stock", true) +
        stat(items.filter(function (i) { return i.day.missing_entry; }).length, "not entered", true) +
        stat(items.filter(function (i) { return i.day.missing_count; }).length, "not counted", true) +
      "</div>" +
      '<div class="panel apanel invfilters">' +
        '<div class="invfilters__row">' +
          '<label class="field invfilters__q"><span class="field__label">Search</span>' +
            '<input class="input" type="search" data-ingq value="' + esc(state.q) + '" placeholder="Name or note"></label>' +
          '<label class="field"><span class="field__label">Category</span><select class="select" data-ingcat>' +
            '<option value="">All categories</option>' + svc.CATEGORIES.map(function (c) {
              return '<option value="' + c.id + '"' + (state.category === c.id ? " selected" : "") + ">" + esc(c.label) + "</option>";
            }).join("") + "</select></label>" +
        "</div>" +
        '<label class="invcheck"><input type="checkbox" data-inglow' + (state.lowOnly ? " checked" : "") + "> Low stock only</label>" +
        '<label class="invcheck"><input type="checkbox" data-ingarch' + (state.archived ? " checked" : "") + "> Show archived</label>" +
      "</div>" +
      '<p class="eodlede"><span class="invkey invkey--derived"></span>worked out (last count + entries since) · ' +
        '<span class="invkey invkey--rec"></span>recorded on this day</p>' +
      (state.data.items.length === 0 && isPast()
        ? '<div class="panel apanel"><p class="odetail__muted">No ingredients had been registered by the end of this day.</p></div>'
        : state.data.items.length === 0
        ? '<div class="panel apanel"><div class="empty"><div class="empty__art">' + KT.icon("leaf", 30) + "</div>" +
          "<h3>No ingredients yet</h3><p>" + (canManage() ? "Add the ingredients you buy — rice, oil, tomatoes, packs — then record deliveries, use and counts."
                                                            : "A supervisor can add the ingredients you buy; you can then record deliveries and use.") +
          "</p></div></div>"
        : list.length ? '<div class="invlist">' + list.map(rowHTML).join("") + "</div>"
                      : '<div class="panel apanel"><p class="odetail__muted">Nothing matches.</p></div>');
  }

  /* ---- History section -------------------------------------------------- */

  function historyHTML() {
    var h = state.hist;
    var items = (state.data && state.data.items) || [];
    var rows = h.data ? h.data.rows.filter(function (r) {
      if (!h.q) return true;
      return [r.ingredient, r.note, r.actor, r.reason, KIND_LABEL[r.kind]].join(" ").toLowerCase().indexOf(h.q.toLowerCase()) !== -1;
    }) : [];
    return '<div class="panel apanel invfilters">' +
        '<div class="ochips" role="group" aria-label="Date range">' +
          [["7", "Last 7 days"], ["30", "30 days"], ["90", "90 days"]].map(function (p) {
            return '<button class="chip' + (h.preset === p[0] ? " is-active" : "") + '" type="button" data-inghpreset="' + p[0] + '">' + p[1] + "</button>";
          }).join("") + "</div>" +
        '<div class="invfilters__row">' +
          '<label class="field"><span class="field__label">Ingredient</span><select class="select" data-inghitem><option value="">All ingredients</option>' +
            items.map(function (i) {
              return '<option value="' + esc(i.id) + '"' + (h.ingredient === i.id ? " selected" : "") + ">" + esc(i.name) + "</option>";
            }).join("") + "</select></label>" +
          '<label class="field"><span class="field__label">Entry type</span><select class="select" data-inghkind><option value="">All types</option>' +
            Object.keys(KIND_LABEL).map(function (k) {
              return '<option value="' + k + '"' + (h.kind === k ? " selected" : "") + ">" + KIND_LABEL[k] + "</option>";
            }).join("") + "</select></label>" +
          '<label class="field invfilters__q"><span class="field__label">Search notes or names</span>' +
            '<input class="input" type="search" data-inghq value="' + esc(h.q) + '" placeholder="e.g. supplier, spoiled, Sam"></label>' +
        "</div></div>" +
      (h.loading ? '<div class="panel apanel">' + KT.skeleton.lines(5) + "</div>"
        : h.error ? '<div class="panel apanel"><p class="field__error">' + esc(h.error) + "</p></div>"
        : '<div class="panel apanel">' + (rows.length ? '<ul class="invhist">' + rows.map(function (r) { return entryHTML(r, true); }).join("") + "</ul>"
                                                       : '<p class="odetail__muted">No entries in this range.</p>') + "</div>");
  }

  /* ---- Page ------------------------------------------------------------- */

  function render() {
    if (viewGen !== mountGen) return;
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    var a = document.activeElement;
    var key = null;
    ["data-ingq", "data-inghq", "data-ingqty", "data-ingnote"].forEach(function (k) {
      if (a && a.hasAttribute && a.hasAttribute(k)) key = "[" + k + "]";
    });
    if (a && a.getAttribute && a.getAttribute("data-ingf")) key = '[data-ingf="' + a.getAttribute("data-ingf") + '"]';
    var caret = key && "selectionStart" in a ? a.selectionStart : null;

    var body;
    if (state.loading && !state.data) body = '<div class="panel apanel">' + KT.skeleton.lines(6) + "</div>";
    else if (state.error) {
      body = '<div class="panel apanel"><div class="empty"><div class="empty__art">' + KT.icon("close", 32) + "</div>" +
        "<h3>We could not load ingredients</h3><p>" + esc(state.error) + "</p>" +
        '<button class="btn btn--primary" type="button" data-ingretry>Try again</button></div></div>';
    } else if (state.section === "history") body = subtabsHTML() + historyHTML();
    else body = subtabsHTML() + dateBarHTML() + editHTML() + stockHTML();

    KT.mount(host,
      '<header class="apage__head opage__head"><div><h1>Ingredients</h1>' +
        '<p class="apage__lede">Raw ingredients and supplies — what came in, what was used, what is left. ' +
        "Separate from dish stock; it never changes what is on sale.</p></div>" +
        '<div class="mhead__actions">' +
          '<button class="btn btn--soft btn--sm" type="button" data-ingretry' + (state.loading ? " disabled" : "") + ">" +
            (state.loading ? KT.spinner(15) + "<span>Refreshing…</span>" : "Refresh") + "</button>" +
          (canManage() ? '<button class="btn btn--primary btn--sm" type="button" data-ingadd>' + KT.icon("plus", 15) +
            "<span>Add ingredient</span></button>" : "") +
        "</div></header>" + tabsHTML() + body);

    if (key) {
      var again = KT.qs(key);
      if (again) { again.focus(); try { if (caret !== null) again.setSelectionRange(caret, caret); } catch (e) {} }
    }
  }

  /* ---- Data -------------------------------------------------------------- */

  async function ensureSvc() {
    if (!svc) svc = (await import("../services/admin-ingredients.js")).adminIngredientsService;
  }

  async function load() {
    var gen = mountGen;
    state.loading = true; state.error = null; render();
    try {
      await ensureSvc();
      var data = await svc.list(state.date);
      if (gen !== mountGen) return;
      state.data = data;
      if (data.is_today) state.date = null;
    } catch (error) {
      if (gen !== mountGen) return;
      state.error = errText(error);
    } finally {
      if (gen === mountGen) { state.loading = false; render(); }
    }
    if (gen === mountGen && state.open) loadRecent(state.open);
  }

  async function loadRecent(id) {
    var gen = mountGen;
    var t = today();
    state.recent[id] = { loading: true, rows: [] };
    render();
    try {
      var res = await svc.history({ ingredientId: id, from: addDays(state.date || t, -29), to: state.date || t, limit: 50 });
      if (gen !== mountGen) return;
      state.recent[id] = { loading: false, rows: res.rows };
    } catch (error) {
      if (gen !== mountGen) return;
      state.recent[id] = { loading: false, rows: [], error: errText(error) };
    }
    render();
  }

  async function loadHistory() {
    var gen = mountGen;
    var h = state.hist, t = today();
    h.loading = true; h.error = null; render();
    try {
      await ensureSvc();
      h.data = await svc.history({ from: addDays(t, -(Number(h.preset) - 1)), to: t,
        ingredientId: h.ingredient || null, kind: h.kind || null, limit: 1000 });
    } catch (error) {
      if (gen === mountGen) h.error = errText(error);
    } finally {
      if (gen === mountGen) { h.loading = false; render(); }
    }
  }

  async function record() {
    var f = state.form, id = state.open;
    if (!f || !id || state.saving || isPast()) return;
    var qty = Number(f.qty);
    if (f.qty === "" || Number.isNaN(qty)) { KT.toast("Enter a quantity.", "error"); return; }
    if (f.kind === "count" && qty < 0) { KT.toast("A count cannot be negative.", "error"); return; }
    if (f.kind !== "adjustment" && f.kind !== "count" && qty <= 0) { KT.toast("Quantity must be more than zero.", "error"); return; }
    if (f.kind === "adjustment" && qty === 0) { KT.toast("An adjustment cannot be zero.", "error"); return; }
    if ((f.kind === "waste" || f.kind === "adjustment") && !f.reason) { KT.toast("Choose a reason.", "error"); return; }
    state.saving = true; render();
    try {
      await svc.record(id, f.kind, qty, f.reason, f.note);
      state.form = { kind: f.kind, qty: "", reason: "", note: "" };
      KT.toast("Recorded.", "success");
      await load();
    } catch (error) {
      KT.toast(errText(error), "error", { duration: 6000 });
    } finally {
      state.saving = false; render();
    }
  }

  async function saveEdit() {
    var f = state.edit;
    if (!f || state.saving) return;
    if (String(f.name || "").trim().length < 2) { KT.toast("Enter the ingredient name.", "error"); return; }
    if (!f.unit) { KT.toast("Choose what it is measured in.", "error"); return; }
    if (f.reorder !== "" && f.reorder != null && (Number.isNaN(Number(f.reorder)) || Number(f.reorder) < 0)) {
      KT.toast("The reorder level must be zero or more.", "error"); return;
    }
    state.saving = true; render();
    try {
      await svc.save(f.id, f);
      KT.toast(f.id ? "Saved." : f.name.trim() + " added.", "success");
      state.edit = null;
      await load();
    } catch (error) {
      KT.toast(errText(error), "error", { duration: 6000 });
    } finally {
      state.saving = false; render();
    }
  }

  function goTo(date) {
    var t = today();
    state.date = (!date || (t && date >= t)) ? null : date;
    state.open = null; state.form = null; state.edit = null; state.recent = {};
    load();
  }

  /* ---- Entry point ------------------------------------------------------- */

  KT.admin.views.ingredients = function (viewCtx) {
    ctx = viewCtx || ctx;
    var gen = ++mountGen;
    viewGen = gen;
    state = freshState();
    if (!stopViewport && KT.viewportInset) stopViewport = KT.viewportInset.start();
    setTimeout(function () { if (gen === mountGen) load(); }, 0);
    return '<header class="apage__head"><div><h1>Ingredients</h1>' +
      '<p class="apage__lede">Loading…</p></div></header>' +
      '<div class="panel apanel">' + KT.skeleton.lines(6) + "</div>";
  };

  KT.admin.views.ingredientsTeardown = function () {
    mountGen += 1;
    if (stopViewport) { stopViewport(); stopViewport = null; }
  };

  /* ---- Events ------------------------------------------------------------ */

  function onPage() { return viewGen === mountGen && !!KT.qs("[data-admin-page] .ingsub, [data-admin-page] [data-ingretry]"); }

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest || !onPage()) return;
    if (t.closest("[data-ingretry]")) { load(); if (state.section === "history") loadHistory(); return; }
    var sec = t.closest("[data-ingsec]");
    if (sec) {
      state.section = sec.getAttribute("data-ingsec");
      render();
      if (state.section === "history" && !state.hist.data) loadHistory();
      return;
    }
    if (t.closest("[data-ingtohist]")) { try { sessionStorage.setItem("kt.inv.tab", "history"); } catch (x) {} return; }
    var step = t.closest("[data-ingstep]");
    if (step) { goTo(addDays(state.date || today(), Number(step.getAttribute("data-ingstep")))); return; }
    if (t.closest("[data-ingtoday]")) { goTo(null); return; }
    if (t.closest("[data-ingadd]")) {
      state.section = "stock";
      state.edit = { id: null, name: "", unit: "", category: "other", reorder: "", notes: "", active: true, hasEntries: false };
      render();
      var n = KT.qs('[data-ingf="name"]'); if (n) n.focus();
      return;
    }
    var ed = t.closest("[data-ingedit]");
    if (ed) {
      var it = state.data.items.filter(function (i) { return i.id === ed.getAttribute("data-ingedit"); })[0];
      if (it) {
        state.edit = { id: it.id, origName: it.name, name: it.name, unit: it.unit, category: it.category,
          reorder: it.reorder_level == null ? "" : num(it.reorder_level), notes: it.notes, active: it.active,
          hasEntries: it.has_entries };
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      return;
    }
    if (t.closest("[data-ingcancel]")) { state.edit = null; render(); return; }
    if (t.closest("[data-ingsave]")) { saveEdit(); return; }
    var hp = t.closest("[data-inghpreset]");
    if (hp) { state.hist.preset = hp.getAttribute("data-inghpreset"); loadHistory(); return; }
    var open = t.closest("[data-ingopen]");
    if (open) {
      var id = open.getAttribute("data-ingopen");
      state.open = state.open === id ? null : id;
      state.form = { kind: "received", qty: "", reason: "", note: "" };
      render();
      if (state.open) loadRecent(state.open);
      return;
    }
    var kind = t.closest("[data-ingkind]");
    if (kind) {
      state.form = state.form || {};
      state.form.kind = kind.getAttribute("data-ingkind");
      state.form.reason = "";
      render();
      return;
    }
    if (t.closest("[data-ingrecord]")) record();
  });

  document.addEventListener("input", function (e) {
    var t = e.target;
    if (!t.closest || !onPage()) return;
    if (t.closest("[data-ingq]")) { state.q = t.value; render(); return; }
    if (t.closest("[data-inghq]")) { state.hist.q = t.value; render(); return; }
    var fld = t.getAttribute && t.getAttribute("data-ingf");
    if (fld && state.edit && fld !== "active") { state.edit[fld] = t.value; return; }
    if (!state.form) return;
    if (t.closest("[data-ingqty]")) { state.form.qty = t.value; return; }
    if (t.closest("[data-ingnote]")) { state.form.note = t.value; }
  });

  document.addEventListener("change", function (e) {
    var t = e.target;
    if (!t.closest || !onPage()) return;
    if (t.closest("[data-ingdate]")) { if (t.value) goTo(t.value); return; }
    if (t.closest("[data-ingcat]")) { state.category = t.value; render(); return; }
    if (t.closest("[data-inglow]")) { state.lowOnly = t.checked; render(); return; }
    if (t.closest("[data-ingarch]")) { state.archived = t.checked; render(); return; }
    if (t.closest("[data-inghitem]")) { state.hist.ingredient = t.value; loadHistory(); return; }
    if (t.closest("[data-inghkind]")) { state.hist.kind = t.value; loadHistory(); return; }
    var fld = t.getAttribute && t.getAttribute("data-ingf");
    if (fld && state.edit) { state.edit[fld] = fld === "active" ? t.checked : t.value; return; }
    var sel = t.closest("[data-ingreason]");
    if (sel && state.form) state.form.reason = sel.value;
  });
})(window.KT || (window.KT = {}));
