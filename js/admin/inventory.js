/* ==========================================================================
   Kandy's Treats — Inventory (every menu product)
   --------------------------------------------------------------------------
   Every product on the menu — rice, proteins, drinks, sides, everything not
   in the trash — under its own menu id, what happened to each of them on a
   day, and the history behind it. A product added to the menu appears here
   by itself (0085); nothing is copied, so a rename shows at once. Raw
   ingredients live on their own screen (#/ingredients) and never feed into
   this one or into menu availability.

   THE ONE DISTINCTION THIS SCREEN HAS TO MAKE

   Half these numbers are derived and half are typed, and confusing the two is
   how an inventory system stops being believed. So they are visually separate
   and labelled:

     derived   opening (carried from the last count), customer consumption
               (from orders that reached the kitchen), expected closing,
               variance. None of these is an input anywhere on the page,
               because none of them has a column to write to.

     recorded  added (prepared/restocked), waste, staff meal, adjustment,
               opening count, closing count. Each is a form, each is
               attributed, and each becomes a ledger row that cannot
               afterwards be edited. Sales are never typed: they come from
               the orders that reached the kitchen, once each.

   Where a product has never been counted, the screen says "not set" / "not
   counted" rather than showing zero — an unknown opening and an empty pot are
   different facts, and only one of them can be fixed by counting.

   PAST DAYS ARE READ-ONLY. The date picker reads history through
   admin_inventory_range(); the entry forms only exist on today's board, and
   the server dates every entry itself, so nothing typed here can land on a
   past day.

   Rendering only. Every query lives in js/services/admin-inventory.js.
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
      tab: "dishes",
      date: null,          /* null = today; otherwise YYYY-MM-DD (past, read-only) */
      loading: true, error: null,
      day: null, history: null,   /* today: admin_inventory_day + admin_inventory_history */
      past: null,                 /* a past day: one day of admin_inventory_range */
      open: null, form: null, saving: false, showHistory: false,
      board: { cat: "", q: "", uncounted: false },
      sales: { key: null, loading: false, error: null, data: null },
      track: { open: false, loading: false, error: null, data: null, q: "", busy: null, confirm: null },
      hist: { preset: "7", from: "", to: "", item: "", cat: "", kind: "", q: "", gaps: false,
              loading: false, error: null, data: null, openDay: null }
    };
  }
  var state = freshState();
  var ctx = { role: "staff" };

  function canAdjust() { return KT.admin.rank(ctx.role) >= KT.admin.rank("supervisor"); }
  /* Creating a menu item or changing what is tracked is a manager act — the
     same rank Menu management requires, and the same one the RPCs enforce. */
  function canManage() { return KT.admin.rank(ctx.role) >= KT.admin.rank("admin"); }

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
  /** "Tue 13 Oct" for a YYYY-MM-DD business date (a calendar date, no zone maths). */
  function dayLabel(d, withYear) {
    if (!d) return "";
    var p = String(d).split("-").map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
    return dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short",
      year: withYear ? "numeric" : undefined, timeZone: "UTC" });
  }
  function addDays(d, n) {
    var p = String(d).split("-").map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n, 12));
    return dt.toISOString().slice(0, 10);
  }
  function today() { return (state.day && state.day.business_date) || (state.past && state.past.today) || null; }
  function isPast() { return !!state.date && state.date !== today(); }

  /** Portions can be fractional; trailing ".00" is noise on a kitchen screen. */
  function num(v) {
    if (v === null || v === undefined) return null;
    var n = Number(v);
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
  }
  function show(v, dash) { var s = num(v); return s === null ? (dash || "—") : s; }
  function shortName(n) { return String(n).replace(/\s*\(per .*?\)\s*/i, ""); }

  /* Sales are not a kind: they are worked out from orders (see "sold"). */
  var KINDS = [
    { id: "opening",    label: "Opening count", hint: "What is there before service starts", sup: false },
    { id: "prepared",   label: "Added",      hint: "Cooked, restocked or received — ready to sell", sup: false },
    { id: "waste",      label: "Waste",      hint: "Thrown away — needs a reason", sup: false },
    { id: "staff_meal", label: "Staff meal", hint: "Eaten by the team", sup: false },
    { id: "adjustment", label: "Adjustment", hint: "Correcting the ledger", sup: true },
    { id: "count",      label: "Closing count", hint: "What is actually there now / at close", sup: false }
  ];
  var KIND_LABEL = { prepared: "Added", waste: "Waste", staff_meal: "Staff meal",
                     adjustment: "Adjustment", opening: "Opening count", count: "Closing count" };
  function isCount(kind) { return kind === "count" || kind === "opening"; }

  /* ---- One product ------------------------------------------------------ */

  function cell(label, value, cls) {
    return '<div class="invc ' + (cls || "") + '">' +
      '<span class="invc__n">' + value + "</span>" +
      '<span class="invc__l">' + esc(label) + "</span></div>";
  }

  function flag(text, kind) {
    return '<span class="invflag invflag--' + kind + '">' + esc(text) + "</span>";
  }

  /**
   * One product. `it` is an item from admin_inventory_day or _range (same
   * shape). mode: "today" opens the entry panel; "past" opens a read-only
   * panel (the orders behind "sold"); "history" is a plain read-only row.
   */
  function rowHTML(it, mode) {
    var ro = mode !== "today";
    var openable = mode !== "history";
    var open = openable && state.open === it.menu_item_id;
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

    var on = Number(it.overnight_change);
    var flags = (it.missing_entry ? flag("Not entered", "entry") : "") +
                (it.missing_count
                  ? flag(it.opening_established ? "Closing not counted" : "Not counted", "count") : "") +
                (it.overnight_change !== null && it.overnight_change !== undefined && on !== 0
                  ? flag("Overnight " + (on > 0 ? "+" : "") + num(on), "entry") : "") +
                (it.menu_status === "hidden" ? flag("Hidden on menu", "muted") : "") +
                (it.menu_status === "sold_out" ? flag("Sold out on menu", "muted") : "") +
                (it.tracked_that_day === false ? flag("Not tracked this day", "muted") : "");

    var tag = openable ? "button" : "div";
    return (
      '<article class="invrow' + (open ? " is-open" : "") + (openable ? "" : " is-ro") + '">' +
        "<" + tag + ' class="invrow__head"' +
          (openable ? ' type="button" data-invopen="' + esc(it.menu_item_id) + '" ' +
            'aria-expanded="' + (open ? "true" : "false") + '"' : "") + ">" +
          '<span class="invrow__name"><strong>' + esc(shortName(it.name)) + "</strong>" +
            '<span class="invrow__unit">per ' + esc(it.sale_unit) + "</span>" +
            (flags ? '<span class="invrow__flags">' + flags + "</span>" : "") + "</span>" +
          '<span class="invrow__figs">' +
            cell("opening", unestablished
              ? '<span class="invc__none">' + (it.never_counted ? "not counted" : "not set") + "</span>"
              : show(it.opening), "invc--derived") +
            cell("added", show(it.prepared, "0"), "invc--rec") +
            cell("sold", show(it.consumed, "0"), "invc--derived") +
            cell("waste", show(it.waste, "0"), "invc--rec") +
            cell("staff", show(it.staff_meal, "0"), "invc--rec") +
            cell("adjust", show(it.adjustment, "0"), "invc--rec") +
            cell("expected", expected === null || expected === undefined
              ? '<span class="invc__none">—</span>'
              : (Number(expected) < 0 ? '<span class="is-negative">' + num(expected) + "</span>"
                                      : num(expected)), "invc--derived is-total") +
            cell("closing", it.counted === null || it.counted === undefined
              ? '<span class="invc__none">not counted</span>' : num(it.counted), "invc--rec") +
            varianceCell +
          "</span>" +
          (openable ? '<span class="invrow__chev">' + KT.icon("chevronDown", 16) + "</span>" : "") +
        "</" + tag + ">" +
        (open ? (ro ? '<div class="invrow__body">' + salesHTML(it) + "</div>" : panelHTML(it)) : "") +
      "</article>"
    );
  }

  /* ---- The orders behind "sold" ----------------------------------------- */

  function salesKey(it) { return (state.date || today()) + ":" + it.menu_item_id; }

  function salesHTML(it) {
    var s = state.sales;
    var head = '<div class="invsales"><h4>Sold ' + show(it.consumed, "0") + " — from orders that reached the kitchen</h4>";
    if (s.key !== salesKey(it) || s.loading) return head + KT.skeleton.lines(2) + "</div>";
    if (s.error) return head + '<p class="field__error">' + esc(s.error) + "</p></div>";
    var rows = (s.data && s.data.orders) || [];
    if (!rows.length) return head + '<p class="odetail__muted">No orders for this product reached the kitchen on this day.</p></div>';
    return head + '<ul class="invsales__list">' + rows.map(function (o) {
      var off = o.status === "Cancelled" || o.payment_status === "refunded";
      return "<li>" +
        "<strong>" + esc(o.code) + "</strong>" +
        "<span>× " + num(o.qty) + "</span>" +
        '<span class="invsales__st' + (off ? " is-off" : "") + '">' + esc(o.status) +
          (o.payment_status && o.payment_status !== "paid" ? " · " + esc(o.payment_status) : "") + "</span>" +
        '<span class="invsales__t">kitchen ' + clock(o.kitchen_at) + "</span>" +
      "</li>";
    }).join("") + "</ul>" +
      '<p class="invhint">Each order is counted once, on the day it first reached the kitchen. ' +
      "A cancelled or refunded order still counts if it was cooked. Sales are never typed in, " +
      "so stock cannot be taken off twice.</p></div>";
  }

  /* ---- The entry panel (today only) ------------------------------------- */

  function reasonsFor(kind) {
    if (!svc) return [];
    if (kind === "waste") return svc.WASTE_REASONS;
    if (kind === "adjustment") return svc.ADJUSTMENT_REASONS;
    return [];
  }

  function openingNote(it) {
    if (it.opening_source === "opening_count") {
      var on = it.overnight_change;
      return '<p class="invnote">Opening counted today' +
        (it.opening_counted_at ? " at " + clock(it.opening_counted_at) : "") + "." +
        (on !== null && on !== undefined
          ? " Last closing count was " + num(it.carried) + " (" +
            ((Number(on) > 0 ? "+" : "") + num(on)) + " overnight)."
          : "") + "</p>";
    }
    if (it.opening_established) {
      return '<p class="invnote">Opening carried from the closing count on ' +
        esc(dayLabel(it.opening_from)) + ".</p>";
    }
    return '<p class="invnote invnote--warn">' +
      (it.never_counted ? "Never counted. " : "Opening stock not established. ") +
      "Record an opening count before service to start tracking this product.</p>";
  }

  function panelHTML(it) {
    var f = state.form || { kind: "prepared", qty: "", reason: "", note: "" };
    var kinds = KINDS.filter(function (k) { return !k.sup || canAdjust(); });
    var reasons = reasonsFor(f.kind);
    var needsReason = f.kind === "waste" || f.kind === "adjustment";
    var meta = KINDS.filter(function (k) { return k.id === f.kind; })[0] || KINDS[0];
    var lateOpening = f.kind === "opening" && Number(it.consumed) > 0;

    return (
      '<div class="invrow__body">' +
        openingNote(it) +

        '<div class="ochips invkinds">' +
          kinds.map(function (k) {
            return '<button class="chip' + (f.kind === k.id ? " is-active" : "") +
              '" type="button" data-invkind="' + k.id + '">' + esc(k.label) + "</button>";
          }).join("") +
        "</div>" +
        '<p class="invhint">' + esc(meta.hint) + "</p>" +
        (lateOpening
          ? '<p class="invnote invnote--warn">' + num(it.consumed) + " already sold today. An opening count " +
            "now would leave those sales out — use a closing count instead.</p>"
          : "") +

        '<div class="invform">' +
          '<label class="field invform__qty">' +
            '<span class="field__label">' +
              (isCount(f.kind) ? "Counted" : "Quantity") + " (" + esc(it.sale_unit) + "s)</span>" +
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
          '<label class="field invform__note"><span class="field__label">Note <span class="invopt">optional</span></span>' +
            '<textarea class="textarea" rows="2" maxlength="500" data-invnote ' +
              'placeholder="e.g. 2 pots · 1 crate · anything the next shift should know">' +
              esc(f.note) + "</textarea></label>" +
          '<button class="btn btn--primary invform__go" type="button" data-invsave' +
            (state.saving ? " disabled" : "") + ">" +
            (state.saving ? KT.spinner(15) + "<span>Saving…</span>" : "Record") +
          "</button>" +
        "</div>" +
        '<p class="invhint">Recorded entries cannot be edited afterwards. A ' +
          "mistake is fixed with an adjustment that references it, or a new " +
          "count, so both stay in the history.</p>" +
        salesHTML(it) +
      "</div>"
    );
  }

  /* ---- Entries list ----------------------------------------------------- */

  function entriesHTML(rows, emptyText) {
    if (!rows || !rows.length) {
      return '<p class="odetail__muted">' + esc(emptyText || "Nothing recorded.") + "</p>";
    }
    return '<ul class="invhist">' + rows.map(function (r) {
      var sign = r.kind === "waste" || r.kind === "staff_meal" ? "−" :
                 isCount(r.kind) ? "=" :
                 (Number(r.qty) < 0 ? "" : "+");
      return "<li>" +
        '<span class="invhist__kind invhist__kind--' + esc(r.kind) + '">' +
          esc(KIND_LABEL[r.kind] || r.kind) + "</span>" +
        '<span class="invhist__what"><strong>' +
          esc(shortName(r.product)) + "</strong> " +
          sign + num(Math.abs(Number(r.qty))) +
          (r.reason ? ' <span class="invhist__why">' + esc(String(r.reason).replace(/_/g, " ")) + "</span>" : "") +
          (r.corrects_id ? ' <span class="invhist__why">correction</span>' : "") +
          (r.note ? '<span class="invhist__note">' + esc(r.note) + "</span>" : "") +
        "</span>" +
        '<span class="invhist__who">' + (esc(r.actor) || "<em>unknown</em>") +
          " · " + clock(r.created_at) + "</span>" +
      "</li>";
    }).join("") + "</ul>";
  }

  /* ---- Tabs and date bar ----------------------------------------------- */

  function tabsHTML() {
    function tab(id, label, href) {
      var on = state.tab === id;
      return href
        ? '<a class="invtab" href="' + href + '">' + esc(label) + "</a>"
        : '<button class="invtab' + (on ? " is-active" : "") + '" type="button" data-invtab="' + id +
          '" aria-pressed="' + on + '">' + esc(label) + "</button>";
    }
    return '<nav class="invtabs" aria-label="Inventory sections">' +
      tab("dishes", "Products") + tab("history", "History") +
      tab("ingredients", "Ingredients", "#/ingredients") + "</nav>";
  }

  function dateBarHTML() {
    var t = today();
    var d = state.date || t;
    var min = (state.day && state.day.activated_on) || (state.past && state.past.activated_on) || "";
    return '<div class="invdate">' +
      '<button class="btn btn--soft btn--sm invdate__step" type="button" data-invstep="-1" aria-label="Previous day"' +
        (min && d <= min ? " disabled" : "") + ">‹</button>" +
      '<label class="invdate__pick"><span class="sr-only">Choose a day</span>' +
        '<input class="input" type="date" data-invdate value="' + esc(d || "") + '"' +
          (t ? ' max="' + esc(t) + '"' : "") + (min ? ' min="' + esc(min) + '"' : "") + "></label>" +
      '<button class="btn btn--soft btn--sm invdate__step" type="button" data-invstep="1" aria-label="Next day"' +
        (!isPast() ? " disabled" : "") + ">›</button>" +
      (isPast() ? '<button class="btn btn--ghost btn--sm" type="button" data-invtoday>Back to today</button>' : "") +
    "</div>";
  }

  function summaryHTML(items, entriesCount) {
    var inScope = items.filter(function (i) { return i.tracked_that_day !== false; });
    var notEntered = inScope.filter(function (i) { return i.missing_entry; }).length;
    var notCounted = inScope.filter(function (i) { return i.missing_count; }).length;
    function stat(n, label, warn) {
      return '<div class="invsum__s' + (warn && n ? " is-warn" : "") + '"><strong>' + n + "</strong><span>" +
        esc(label) + "</span></div>";
    }
    return '<div class="invsum">' +
      stat(inScope.length, inScope.length === 1 ? "product" : "products") +
      stat(entriesCount, entriesCount === 1 ? "entry" : "entries") +
      stat(notEntered, "prep not entered", true) +
      stat(notCounted, "not counted", true) +
    "</div>";
  }

  /* ---- Prep list (tracks_stock) ----------------------------------------- */

  /*
     Every product is on the board whatever this says (0085). The prep list
     is the batch-cooked dishes: they get "Not entered" on a day with no
     entry, and they are the products automatic availability would follow —
     which stays off until Kandy switches it on.
  */
  function trackHTML() {
    var t = state.track;
    if (!t.open) return "";
    var body;
    if (t.loading) body = KT.skeleton.lines(4);
    else if (t.error) body = '<p class="field__error">' + esc(t.error) + "</p>";
    else if (t.data) {
      var q = t.q.trim().toLowerCase();
      var items = t.data.items.filter(function (i) {
        return !q || (i.name + " " + i.category_id).toLowerCase().indexOf(q) !== -1;
      });
      var untracked = items.filter(function (i) { return !i.tracks_stock; });
      var tracked = items.filter(function (i) { return i.tracks_stock; });
      function line(i) {
        var busy = t.busy === i.id;
        var confirming = t.confirm === i.id;
        return '<li class="invtrack__row">' +
          '<span class="invtrack__name"><strong>' + esc(i.name) + "</strong>" +
            '<span>' + esc(String(i.category_id || "").replace(/-/g, " ")) + " · counted in " +
              esc(i.sale_unit) + "s" + (i.status !== "available" ? " · " + esc(i.status.replace("_", " ")) : "") +
              (i.tracks_stock && i.tracked_since ? " · on the list since " + esc(dayLabel(String(i.tracked_since).slice(0, 10), true)) : "") +
            "</span></span>" +
          (!t.data.can_change ? "" :
            i.tracks_stock
              ? '<button class="btn btn--ghost btn--sm" type="button" data-invuntrack="' + esc(i.id) + '"' +
                  (busy ? " disabled" : "") + ">" + (confirming ? "Confirm remove" : "Remove") + "</button>"
              : '<button class="btn btn--primary btn--sm" type="button" data-invtrack="' + esc(i.id) + '"' +
                  (busy ? " disabled" : "") + ">" + (busy ? KT.spinner(14) : "Add") + "</button>") +
        "</li>";
      }
      body =
        '<label class="field"><span class="sr-only">Search menu items</span>' +
          '<input class="input" type="search" data-invtrackq value="' + esc(t.q) + '" ' +
            'placeholder="Search the menu — e.g. rice, stew, beans"></label>' +
        "<h4>On the prep list</h4>" +
        (tracked.length ? '<ul class="invtrack">' + tracked.map(line).join("") + "</ul>"
                        : '<p class="odetail__muted">Nothing matches.</p>') +
        "<h4>Not on the prep list</h4>" +
        (untracked.length ? '<ul class="invtrack">' + untracked.map(line).join("") + "</ul>"
                          : '<p class="odetail__muted">Nothing matches.</p>');
    }
    return '<section class="panel apanel invtrackpanel" aria-labelledby="invTrackTitle">' +
      '<div class="invtrackpanel__head"><div><h3 id="invTrackTitle">Daily prep list</h3>' +
        "<p>Every menu product is already in Inventory — this list does not add or remove anything " +
        "from the board. It marks the batch-cooked dishes, which are flagged “Not entered” on a day " +
        "with no preparation entry. Automatic stock-based availability stays off.</p></div>" +
        '<button class="btn btn--ghost btn--sm" type="button" data-invtrackclose>Close</button></div>' +
      body + "</section>";
  }

  /* ---- Board: categories and filters ------------------------------------ */

  function categoriesOf(items) {
    var seen = {}, out = [];
    items.forEach(function (i) {
      var id = i.category_id || "";
      if (!seen[id]) { seen[id] = { id: id, name: i.category || id || "Other", n: 0 }; out.push(seen[id]); }
      seen[id].n += 1;
    });
    return out;
  }

  function boardFilter(items) {
    var b = state.board, q = b.q.trim().toLowerCase();
    return items.filter(function (i) {
      if (b.cat && (i.category_id || "") !== b.cat) return false;
      if (b.uncounted && !i.missing_count) return false;
      if (q && (i.name + " " + (i.category || "")).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function boardControlsHTML(items) {
    var b = state.board;
    var cats = categoriesOf(items);
    return '<div class="invboardf">' +
      '<div class="ochips invcats" role="group" aria-label="Category">' +
        '<button class="chip' + (!b.cat ? " is-active" : "") + '" type="button" data-invcat="">All <span>' +
          items.length + "</span></button>" +
        cats.map(function (c) {
          return '<button class="chip' + (b.cat === c.id ? " is-active" : "") + '" type="button" data-invcat="' +
            esc(c.id) + '">' + esc(c.name) + " <span>" + c.n + "</span></button>";
        }).join("") +
      "</div>" +
      '<div class="invboardf__row">' +
        '<label class="field invboardf__q"><span class="sr-only">Find a product</span>' +
          '<input class="input" type="search" data-invboardq value="' + esc(b.q) + '" placeholder="Find a product — e.g. coke, chicken"></label>' +
        '<label class="invcheck"><input type="checkbox" data-invuncounted' + (b.uncounted ? " checked" : "") +
          "> Only not counted</label>" +
      "</div></div>";
  }

  /** Rows grouped under their category, in menu order. */
  function groupedHTML(items, mode) {
    var shown = boardFilter(items);
    if (!shown.length) {
      return '<p class="odetail__muted">' + (items.length ? "No products match these filters." : "No products.") + "</p>";
    }
    return categoriesOf(shown).map(function (c) {
      var rows = shown.filter(function (i) { return (i.category_id || "") === c.id; });
      return '<div class="invgroup"><h3 class="invgroup__h">' + esc(c.name) + " <span>" + rows.length + "</span></h3>" +
        '<div class="invlist">' + rows.map(function (i) { return rowHTML(i, mode); }).join("") + "</div></div>";
    }).join("");
  }

  /* ---- Dishes tab ------------------------------------------------------- */

  function todayItems() {
    var d = state.day;
    var rows = (state.history && state.history.rows) || [];
    var entries = {};
    rows.forEach(function (r) { if (r.record !== "count") entries[r.menu_item_id] = (entries[r.menu_item_id] || 0) + 1; });
    return d.items.map(function (it) {
      return Object.assign({}, it, {
        tracked_that_day: true,
        entries: entries[it.menu_item_id] || 0,
        /* Only a batch-cooked dish is expected to have an entry every day. */
        missing_entry: !!it.prep_tracked && !entries[it.menu_item_id],
        missing_count: it.counted === null || it.counted === undefined
      });
    });
  }

  function dishesHTML() {
    if (isPast()) {
      var p = state.past && state.past.days && state.past.days[0];
      if (!p) return "";
      if (!p.tracked) return notTrackedHTML(state.past.activated_on);
      var allOn = state.past.all_products_on;
      return (
        '<div class="invro" role="note">' + KT.icon("lock", 15) +
          "<span><strong>" + esc(dayLabel(p.business_date, true)) + " — read only.</strong> Past records " +
          "can be viewed but not changed." +
          (allOn && p.business_date < allOn
            ? " Before " + esc(dayLabel(allOn, true)) + " only the stock-tracked dishes were in Inventory, so only they are shown."
            : "") + "</span></div>" +
        summaryHTML(p.items, p.summary.entries) +
        '<section class="dsec">' +
          '<header class="dsec__head"><h2>' + KT.icon("flame", 17) + "Stock on " +
            esc(dayLabel(p.business_date)) + "</h2></header>" +
          legendHTML() +
          (p.items.length ? boardControlsHTML(p.items) + groupedHTML(p.items, "past")
                          : '<p class="odetail__muted">No products were tracked on this day.</p>') +
        "</section>" +
        '<section class="dsec">' +
          '<header class="dsec__head"><h2>' + KT.icon("clock", 17) + "Entries that day</h2>" +
            '<span class="dsec__hint">' + p.entries.length + "</span></header>" +
          '<div class="panel apanel">' + entriesHTML(p.entries, "Nothing was recorded on this day.") + "</div>" +
        "</section>"
      );
    }
    var d = state.day;
    if (!d) return "";
    if (!d.tracked) return notTrackedHTML(d.activated_on);
    var items = todayItems();
    var nEntries = ((state.history && state.history.rows) || []).length;
    return (
      summaryHTML(items, nEntries) +
      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("flame", 17) + "Today's stock</h2>" +
          '<span class="dsec__hint">' + esc(dayLabel(d.business_date)) + "</span></header>" +
        legendHTML() +
        boardControlsHTML(items) +
        groupedHTML(items, "today") +
      "</section>" +
      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("clock", 17) + "Today's entries</h2>" +
          '<button class="osection__more" type="button" data-invhist>' +
            (state.showHistory ? "Hide" : "Show (" + nEntries + ")") + "</button>" +
        "</header>" +
        (state.showHistory ? '<div class="panel apanel">' +
          entriesHTML(state.history && state.history.rows, "Nothing recorded today yet.") + "</div>" : "") +
      "</section>"
    );
  }

  function legendHTML() {
    return '<p class="eodlede">' +
      '<span class="invkey invkey--derived"></span>worked out by the system · ' +
      '<span class="invkey invkey--rec"></span>recorded by the team · ' +
      "<em>not counted</em> means nobody counted it — not that there were none · " +
      "tap a product to record or to see the orders behind “sold”</p>";
  }

  function notTrackedHTML(activated) {
    return '<div class="panel apanel"><div class="empty">' +
      '<div class="empty__art">' + KT.icon("receipt", 32) + "</div>" +
      "<h3>Inventory was not tracked on this date</h3>" +
      "<p>Tracking began on " + esc(activated ? dayLabel(activated, true) : "a later date") +
      ". Nothing before then was recorded, and nothing has been invented for it.</p>" +
      "</div></div>";
  }

  /* ---- History tab ------------------------------------------------------ */

  function histRange() {
    var h = state.hist, t = today();
    if (h.preset === "custom" && h.from && h.to) return { from: h.from, to: h.to };
    var n = Number(h.preset) || 7;
    return { from: addDays(t, -(n - 1)), to: t };
  }

  /** menu_item_id -> category_id, from today's board (every live product). */
  function catMap() {
    var m = {};
    ((state.day && state.day.items) || []).forEach(function (i) { m[i.menu_item_id] = i.category_id || ""; });
    return m;
  }

  function entryMatches(e) {
    var h = state.hist;
    if (h.kind && e.kind !== h.kind) return false;
    if (h.cat && catMap()[e.menu_item_id] !== h.cat) return false;
    if (h.q) {
      var q = h.q.toLowerCase();
      var hay = [e.product, e.note, e.actor, e.reason, KIND_LABEL[e.kind]].join(" ").toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  function historyTabHTML() {
    var h = state.hist;
    var items = (state.day && state.day.items) || [];
    var r = histRange();
    var controls =
      '<div class="panel apanel invfilters">' +
        '<div class="ochips" role="group" aria-label="Date range">' +
          [["7", "Last 7 days"], ["14", "14 days"], ["30", "30 days"], ["custom", "Choose dates"]].map(function (p) {
            return '<button class="chip' + (h.preset === p[0] ? " is-active" : "") + '" type="button" data-invpreset="' +
              p[0] + '">' + p[1] + "</button>";
          }).join("") +
        "</div>" +
        (h.preset === "custom"
          ? '<div class="invfilters__dates">' +
              '<label class="field"><span class="field__label">From</span><input class="input" type="date" data-invhfrom value="' +
                esc(h.from || r.from) + '" max="' + esc(today()) + '"></label>' +
              '<label class="field"><span class="field__label">To</span><input class="input" type="date" data-invhto value="' +
                esc(h.to || r.to) + '" max="' + esc(today()) + '"></label>' +
              '<button class="btn btn--primary btn--sm" type="button" data-invhapply>Show</button></div>'
          : "") +
        '<div class="invfilters__row">' +
          '<label class="field"><span class="field__label">Category</span><select class="select" data-invhcat>' +
            '<option value="">All categories</option>' +
            categoriesOf(items).map(function (c) {
              return '<option value="' + esc(c.id) + '"' + (h.cat === c.id ? " selected" : "") + ">" + esc(c.name) + "</option>";
            }).join("") + "</select></label>" +
          '<label class="field"><span class="field__label">Product</span><select class="select" data-invhitem>' +
            '<option value="">All products</option>' +
            categoriesOf(items).filter(function (c) { return !h.cat || c.id === h.cat; }).map(function (c) {
              return '<optgroup label="' + esc(c.name) + '">' +
                items.filter(function (i) { return (i.category_id || "") === c.id; }).map(function (i) {
                  return '<option value="' + esc(i.menu_item_id) + '"' + (h.item === i.menu_item_id ? " selected" : "") + ">" +
                    esc(shortName(i.name)) + "</option>";
                }).join("") + "</optgroup>";
            }).join("") + "</select></label>" +
          '<label class="field"><span class="field__label">Entry type</span><select class="select" data-invhkind>' +
            '<option value="">All types</option>' +
            Object.keys(KIND_LABEL).map(function (k) {
              return '<option value="' + k + '"' + (h.kind === k ? " selected" : "") + ">" + KIND_LABEL[k] + "</option>";
            }).join("") + "</select></label>" +
          '<label class="field invfilters__q"><span class="field__label">Search notes or names</span>' +
            '<input class="input" type="search" data-invhq value="' + esc(h.q) + '" placeholder="e.g. burnt, Sam, chicken"></label>' +
        "</div>" +
        '<label class="invcheck"><input type="checkbox" data-invhgaps' + (h.gaps ? " checked" : "") + "> " +
          "Only days with something missing</label>" +
      "</div>";

    var body;
    if (h.loading) body = '<div class="panel apanel">' + KT.skeleton.lines(6) + "</div>";
    else if (h.error) body = '<div class="panel apanel"><p class="field__error">' + esc(h.error) + "</p>" +
      '<button class="btn btn--primary btn--sm" type="button" data-invhreload>Try again</button></div>';
    else if (h.data) body = daysHTML(h.data);
    else body = "";
    return controls + body;
  }

  function daysHTML(data) {
    var h = state.hist;
    var filtering = !!(h.kind || h.q || h.cat);
    var shown = data.days.filter(function (d) {
      if (!d.tracked) return !filtering && !h.gaps;
      if (h.gaps && !(d.summary.missing_entries || d.summary.missing_counts)) return false;
      if ((h.kind || h.q) && !d.entries.some(entryMatches)) return false;
      return true;
    });
    if (!shown.length) {
      return '<div class="panel apanel"><div class="empty"><h3>Nothing matches</h3>' +
        "<p>Try a longer range or clear the filters.</p></div></div>";
    }
    return '<div class="invdays">' + shown.map(function (d) {
      if (!d.tracked) {
        return '<article class="invday is-off"><div class="invday__head"><strong>' + esc(dayLabel(d.business_date, true)) +
          "</strong><span class=\"invday__chips\">" + flag("Not tracked yet", "muted") + "</span></div></article>";
      }
      var s = d.summary;
      var open = h.openDay === d.business_date;
      var entries = d.entries.filter(entryMatches);
      var dayItems = h.cat ? d.items.filter(function (i) { return (i.category_id || "") === h.cat; }) : d.items;
      return '<article class="invday' + (open ? " is-open" : "") + '">' +
        '<button class="invday__head" type="button" data-invday="' + esc(d.business_date) + '" aria-expanded="' + open + '">' +
          "<strong>" + esc(dayLabel(d.business_date, true)) + "</strong>" +
          (d.is_today ? flag("Today", "today") : "") +
          '<span class="invday__chips">' +
            flag(s.entries + (s.entries === 1 ? " entry" : " entries"), "muted") +
            (s.missing_entries ? flag(s.missing_entries + " not entered", "entry") : "") +
            (s.missing_counts ? flag(s.missing_counts + " not counted", "count") : "") +
            (s.notes ? flag(s.notes + (s.notes === 1 ? " note" : " notes"), "muted") : "") +
          "</span>" +
          (s.people && s.people.length ? '<span class="invday__who">By ' + esc(s.people.join(", ")) + "</span>" : "") +
          '<span class="invrow__chev">' + KT.icon("chevronDown", 16) + "</span>" +
        "</button>" +
        (open
          ? '<div class="invday__body">' +
              (dayItems.length ? '<div class="invlist">' + dayItems.map(function (i) { return rowHTML(i, "history"); }).join("") + "</div>"
                               : '<p class="odetail__muted">No products in this view.</p>') +
              "<h4>Entries" + (filtering ? " matching your filters" : "") + "</h4>" +
              entriesHTML(entries, filtering ? "No entries match." : "Nothing was recorded.") +
            "</div>"
          : "") +
      "</article>";
    }).join("") + "</div>";
  }

  /* ---- Page ------------------------------------------------------------- */

  function render() {
    if (viewGen !== mountGen) return;
    var host = KT.qs("[data-admin-page]");
    if (!host) return;

    var a = document.activeElement;
    var key = a && a.getAttribute && (a.hasAttribute("data-invqty") ? "[data-invqty]"
      : a.hasAttribute("data-invnote") ? "[data-invnote]"
      : a.hasAttribute("data-invhq") ? "[data-invhq]"
      : a.hasAttribute("data-invtrackq") ? "[data-invtrackq]"
      : a.hasAttribute("data-invboardq") ? "[data-invboardq]" : null);
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
    } else if (state.tab === "history") {
      body = historyTabHTML();
    } else {
      body = dateBarHTML() + trackHTML() + dishesHTML();
    }

    KT.mount(host,
      '<header class="apage__head opage__head"><div><h1>Inventory</h1>' +
        '<p class="apage__lede">What was added, sold, wasted and counted for every product on the menu — ' +
        "today, and on any day since tracking began.</p></div>" +
        /*
           A kitchen leaves this screen open. Loaded at 23:50 and looked at
           again at 00:10, it would still be showing yesterday's board while
           the server had already moved to the new Lagos business day — the
           ledger stays correct either way, because inventory_record() stamps
           the date server-side, but the heading would name the wrong day.
           Observed exactly that crossing 2026-09-03 into 09-04 during
           testing, which is why there is a way to re-ask.
        */
        '<div class="mhead__actions">' +
          '<button class="btn btn--soft btn--sm" type="button" data-invretry' +
            (state.loading ? " disabled" : "") + ">" +
            (state.loading ? KT.spinner(15) + "<span>Refreshing…</span>" : "Refresh") +
          "</button>" +
          (canManage()
            ? '<button class="btn btn--soft btn--sm" type="button" data-invtrackopen>' +
                KT.icon("check", 15) + "<span>Prep list</span></button>" +
              /* Opens the Menu management editor (one create form, one set of
                 rules); saving returns here and reloads the board. Only for a
                 product that is not on the menu at all — every menu product is
                 already on this board. */
              '<a class="btn btn--primary btn--sm" href="#/menu-manage?new=1&amp;from=inventory" data-invadd ' +
                'title="Only for a product that is not on the menu yet">' +
                KT.icon("plus", 15) + "<span>New menu item</span></a>"
            : "") +
        "</div>" +
      "</header>" + tabsHTML() + body);

    if (key) {
      var again = KT.qs(key);
      if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (e) {} }
    }
  }

  /* ---- Data -------------------------------------------------------------- */

  async function ensureSvc() {
    if (!svc) svc = (await import("../services/admin-inventory.js")).adminInventoryService;
  }

  function errText(error) {
    return (KT.services && KT.services.errorMessage)
      ? KT.services.errorMessage(error) : String(error.message || error);
  }

  async function load() {
    var gen = mountGen;
    state.loading = true; state.error = null;
    render();
    try {
      await ensureSvc();
      /* Today's board is always loaded: it carries today's date, the
         activation date and the dish list the filters use. */
      var got = await Promise.all([svc.day(), svc.history()]);
      if (gen !== mountGen) return;
      state.day = got[0];
      state.history = got[1];
      if (state.date === state.day.business_date) state.date = null;
      if (isPast()) {
        var p = await svc.range(state.date, state.date, null);
        if (gen !== mountGen) return;
        state.past = p;
      } else state.past = null;
    } catch (error) {
      if (gen !== mountGen) return;
      state.error = errText(error);
    } finally {
      if (gen === mountGen) { state.loading = false; render(); }
    }
    if (gen === mountGen && state.tab === "history" && !state.error) loadHistory();
  }

  async function loadHistory() {
    var gen = mountGen;
    var h = state.hist;
    var r = histRange();
    if (r.from > r.to) { KT.toast("The start date must be on or before the end date.", "error"); return; }
    h.loading = true; h.error = null; render();
    try {
      await ensureSvc();
      var data = await svc.range(r.from, r.to, h.item || null);
      if (gen !== mountGen) return;
      h.data = data;
      if (!h.openDay && data.days.length) h.openDay = data.days[0].business_date;
    } catch (error) {
      if (gen !== mountGen) return;
      h.error = errText(error);
    } finally {
      if (gen === mountGen) { h.loading = false; render(); }
    }
  }

  async function loadTrack() {
    var gen = mountGen;
    state.track.loading = true; state.track.error = null; render();
    try {
      await ensureSvc();
      var data = await svc.candidates();
      if (gen !== mountGen) return;
      state.track.data = data;
    } catch (error) {
      if (gen !== mountGen) return;
      state.track.error = errText(error);
    } finally {
      if (gen === mountGen) { state.track.loading = false; render(); }
    }
  }

  async function setTracking(id, on) {
    var t = state.track;
    if (t.busy) return;
    t.busy = id; render();
    try {
      await svc.setTracking(id, on);
      var item = (t.data.items.filter(function (i) { return i.id === id; })[0] || {});
      KT.toast(on ? shortName(item.name) + " is on the prep list."
                  : shortName(item.name) + " is off the prep list. It stays in Inventory.", "success");
      t.confirm = null;
      await Promise.all([loadTrack(), load()]);
    } catch (error) {
      KT.toast(errText(error), "error", { duration: 6000 });
    } finally {
      t.busy = null; render();
    }
  }

  /** The orders behind the open product's "sold" figure (read-only). */
  async function loadSales() {
    var gen = mountGen;
    var it = (isPast() ? ((state.past && state.past.days && state.past.days[0] && state.past.days[0].items) || [])
                       : ((state.day && state.day.items) || []))
      .filter(function (i) { return i.menu_item_id === state.open; })[0];
    if (!it) return;
    var key = salesKey(it);
    var s = state.sales;
    s.key = key; s.loading = true; s.error = null; s.data = null; render();
    try {
      await ensureSvc();
      var data = await svc.sales(state.date || null, it.menu_item_id);
      if (gen !== mountGen || s.key !== key) return;
      s.data = data;
    } catch (error) {
      if (gen !== mountGen || s.key !== key) return;
      s.error = errText(error);
    } finally {
      if (gen === mountGen && s.key === key) { s.loading = false; render(); }
    }
  }

  async function save() {
    var f = state.form;
    if (!f || state.saving || !state.open || isPast()) return;
    var qty = Number(f.qty);
    if (!f.qty || Number.isNaN(qty)) { KT.toast("Enter a quantity.", "error"); return; }
    if (f.kind !== "adjustment" && !isCount(f.kind) && qty <= 0) {
      KT.toast("Quantity must be more than zero.", "error"); return;
    }
    if (isCount(f.kind) && qty < 0) { KT.toast("A count cannot be negative.", "error"); return; }
    if ((f.kind === "waste" || f.kind === "adjustment") && !f.reason) {
      KT.toast("Choose a reason.", "error"); return;
    }
    state.saving = true; render();
    try {
      if (isCount(f.kind)) await svc.count(state.open, qty, f.note, f.kind === "opening");
      else await svc.record(state.open, f.kind, qty, f.reason, f.note);
      state.form = { kind: f.kind, qty: "", reason: "", note: "" };
      KT.toast("Recorded.", "success");
      state.sales.key = null;
      await load();
      if (state.open) loadSales();
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    } finally {
      state.saving = false; render();
    }
  }

  function goTo(date) {
    var t = today();
    if (!date || (t && date >= t)) state.date = null;
    else state.date = date;
    state.open = null; state.form = null; state.sales.key = null;
    load();
  }

  /* ---- Entry point ------------------------------------------------------- */

  KT.admin.views.inventory = function (viewCtx) {
    ctx = viewCtx || ctx;
    var gen = ++mountGen;
    viewGen = gen;
    state = freshState();
    /* The Ingredients screen's "History" tab lands here on the history tab. */
    try {
      if (sessionStorage.getItem("kt.inv.tab") === "history") state.tab = "history";
      sessionStorage.removeItem("kt.inv.tab");
    } catch (e) { /* private mode: default tab */ }

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

  function onPage() { return viewGen === mountGen && !!KT.qs("[data-admin-page] .invtabs"); }

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest || !onPage()) return;

    if (t.closest("[data-invretry]")) { load(); return; }
    if (t.closest("[data-invhist]")) { state.showHistory = !state.showHistory; render(); return; }

    var tab = t.closest("[data-invtab]");
    if (tab) {
      state.tab = tab.getAttribute("data-invtab");
      render();
      if (state.tab === "history" && !state.hist.data) loadHistory();
      return;
    }
    var step = t.closest("[data-invstep]");
    if (step) { goTo(addDays(state.date || today(), Number(step.getAttribute("data-invstep")))); return; }
    if (t.closest("[data-invtoday]")) { goTo(null); return; }

    if (t.closest("[data-invtrackopen]")) {
      state.track.open = !state.track.open;
      render();
      if (state.track.open && !state.track.data) loadTrack();
      return;
    }
    if (t.closest("[data-invtrackclose]")) { state.track.open = false; render(); return; }
    var tr = t.closest("[data-invtrack]");
    if (tr) { setTracking(tr.getAttribute("data-invtrack"), true); return; }
    var un = t.closest("[data-invuntrack]");
    if (un) {
      var uid = un.getAttribute("data-invuntrack");
      if (state.track.confirm !== uid) { state.track.confirm = uid; render(); return; }
      setTracking(uid, false);
      return;
    }

    var cat = t.closest("[data-invcat]");
    if (cat) { state.board.cat = cat.getAttribute("data-invcat"); render(); return; }

    var preset = t.closest("[data-invpreset]");
    if (preset) {
      state.hist.preset = preset.getAttribute("data-invpreset");
      if (state.hist.preset !== "custom") { state.hist.openDay = null; loadHistory(); } else render();
      return;
    }
    if (t.closest("[data-invhapply]")) { state.hist.openDay = null; loadHistory(); return; }
    if (t.closest("[data-invhreload]")) { loadHistory(); return; }
    var dayBtn = t.closest("[data-invday]");
    if (dayBtn) {
      var d = dayBtn.getAttribute("data-invday");
      state.hist.openDay = state.hist.openDay === d ? null : d;
      render();
      return;
    }

    var open = t.closest("[data-invopen]");
    if (open) {
      var id = open.getAttribute("data-invopen");
      state.open = state.open === id ? null : id;
      state.form = { kind: "prepared", qty: "", reason: "", note: "" };
      render();
      if (state.open) loadSales();
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
    if (!t.closest || !onPage()) return;
    if (t.closest("[data-invhq]")) { state.hist.q = t.value; render(); return; }
    if (t.closest("[data-invtrackq]")) { state.track.q = t.value; render(); return; }
    if (t.closest("[data-invboardq]")) { state.board.q = t.value; render(); return; }
    if (!state.form) return;
    if (t.closest("[data-invqty]")) { state.form.qty = t.value; return; }
    if (t.closest("[data-invnote]")) { state.form.note = t.value; }
  });

  document.addEventListener("change", function (e) {
    var t = e.target;
    if (!t.closest || !onPage()) return;
    if (t.closest("[data-invdate]")) { if (t.value) goTo(t.value); return; }
    if (t.closest("[data-invhfrom]")) { state.hist.from = t.value; return; }
    if (t.closest("[data-invhto]")) { state.hist.to = t.value; return; }
    if (t.closest("[data-invuncounted]")) { state.board.uncounted = t.checked; render(); return; }
    if (t.closest("[data-invhcat]")) {
      state.hist.cat = t.value;
      var inCat = catMap();
      if (state.hist.item && t.value && inCat[state.hist.item] !== t.value) {
        state.hist.item = ""; state.hist.openDay = null; loadHistory(); return;
      }
      render(); return;
    }
    if (t.closest("[data-invhitem]")) { state.hist.item = t.value; state.hist.openDay = null; loadHistory(); return; }
    if (t.closest("[data-invhkind]")) { state.hist.kind = t.value; render(); return; }
    if (t.closest("[data-invhgaps]")) { state.hist.gaps = t.checked; render(); return; }
    var sel = t.closest("[data-invreason]");
    if (!sel || !state.form) return;
    state.form.reason = sel.value;
  });
})(window.KT || (window.KT = {}));
