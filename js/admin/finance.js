/* ==========================================================================
   Kandy's Treats — Finance & payment reconciliation
   --------------------------------------------------------------------------
   Read-first. The module reports; it does not repair. The only mutating
   action is a refund, and that runs through the existing admin_refund_order
   RPC — no JavaScript here ever writes paid, payment_status, payment_ref,
   an order total or a wallet balance.

   Rendering only; all data access lives in js/services/admin-finance.js.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};
  KT.admin.views = KT.admin.views || {};

  var svc = null;
  var state = {
    tab: "overview", loading: true, error: null,
    overview: null, findings: [], events: { total: 0, rows: [] }, wallets: [],
    eventSearch: "", eventStatus: "all",
    confirm: null, refunding: false
  };
  var searchTimer = null;

  function naira(v) { return "₦" + Number(v || 0).toLocaleString("en-NG"); }
  function esc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function when(d) {
    if (!d) return "—";
    return new Date(d).toLocaleString("en-NG",
      { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function role() { return (KT.admin.currentRole && KT.admin.currentRole()) || ""; }
  /* Refunds are admin+ because that is what admin_refund_order itself permits.
     Gating the button on owner would make the UI stricter than the server —
     confusing rather than safer, since the RPC is the actual boundary. */
  function canRefund() { return role() === "admin" || role() === "owner"; }
  function isOwner() { return role() === "owner"; }

  /* ---- Overview ---------------------------------------------------------- */

  function stat(label, value, hint, tone) {
    return '<div class="astat' + (tone ? " astat--" + tone : "") + '">' +
      '<span class="astat__label">' + label + "</span>" +
      '<strong class="astat__value">' + value + "</strong>" +
      (hint ? '<span class="astat__hint">' + hint + "</span>" : "") + "</div>";
  }

  function overviewHTML() {
    var o = state.overview;
    if (!o) return "";
    return (
      '<p class="fin__asof">Figures as at ' + when(o.generated_at) + "</p>" +

      '<h3 class="fin__section">Order value <span>what was asked for</span></h3>' +
      '<div class="astat__grid">' +
        stat("Gross order value", naira(o.order_value.gross), o.orders.total + " orders") +
        stat("Value of paid orders", naira(o.order_value.paid), o.orders.paid + " paid") +
        stat("Outstanding", naira(o.order_value.outstanding), o.orders.pending + " pending", "warn") +
      "</div>" +

      '<h3 class="fin__section">Collected <span>what actually arrived at the gateway</span></h3>' +
      '<div class="astat__grid">' +
        stat("Collected", naira(o.collected.amount),
             o.collected.events_success + " successful events", "good") +
        stat("Failed", o.collected.events_failed, "gateway declined") +
        stat("Cancelled", o.collected.events_cancelled, "customer abandoned") +
        stat("Amount rejected", o.collected.events_mismatch,
             "refused: amount mismatch", o.collected.events_mismatch ? "bad" : "") +
        stat("Replays ignored", o.collected.events_ignored, "duplicate webhooks") +
      "</div>" +
      '<p class="fin__note">' + KT.icon("lock", 15) +
        "<span>Order value and collected value are counted separately and never added " +
        "together — an order total is what was requested, a successful payment event is " +
        "what was received. Repeated webhooks are de-duplicated by reference.</span></p>" +

      '<h3 class="fin__section">Wallets &amp; funding</h3>' +
      '<div class="astat__grid">' +
        stat("Wallet balances", naira(o.wallets.balance_total), o.wallets.count + " wallets") +
        stat("Locked", naira(o.wallets.locked_total), "reserved") +
        stat("Wallet transactions", o.wallets.transactions, "ledger entries") +
        stat("Funding pending", o.funding_intents.pending,
             "of " + o.funding_intents.total + " intents",
             o.funding_intents.pending ? "warn" : "") +
      "</div>"
    );
  }

  /* ---- Reconciliation ---------------------------------------------------- */

  function reconciliationHTML() {
    if (!state.findings.length) {
      return '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("check", 32) + "</div>" +
        "<h3>Nothing to reconcile</h3>" +
        "<p>Every paid order has a matching successful payment event, and every " +
        "successful event is attached to a paid order at the right amount.</p>" +
        "</div></div>";
    }
    var crit = state.findings.filter(function (f) { return f.severity === "critical"; }).length;
    return (
      '<p class="fin__note' + (crit ? " is-bad" : "") + '">' + KT.icon(crit ? "close" : "sparkle", 15) +
        "<span>" + state.findings.length + " finding" + (state.findings.length === 1 ? "" : "s") +
        (crit ? ", " + crit + " needing attention" : "") +
        ". Nothing here has been changed — reconciliation reports, it never repairs." +
        "</span></p>" +
      '<div class="fin__rows">' +
        state.findings.map(function (f) {
          return '<article class="finrow finrow--' + esc(f.severity) + '">' +
            '<div class="finrow__top">' +
              '<span class="sevbadge sevbadge--' + esc(f.severity) + '">' + esc(f.severity) + "</span>" +
              '<code class="finrow__issue">' + esc(f.issue) + "</code>" +
              '<span class="finrow__when">' + when(f.occurred_at) + "</span>" +
            "</div>" +
            '<p class="finrow__detail">' + esc(f.detail) + "</p>" +
            '<dl class="finrow__facts">' +
              (f.order_code ? "<div><dt>Order</dt><dd>" + esc(f.order_code) + "</dd></div>" : "") +
              (f.order_total != null ? "<div><dt>Order total</dt><dd>" + naira(f.order_total) + "</dd></div>" : "") +
              (f.event_ref ? "<div><dt>Reference</dt><dd>" + esc(f.event_ref) + "</dd></div>" : "") +
              (f.event_amount != null ? "<div><dt>Event amount</dt><dd>" + naira(f.event_amount) + "</dd></div>" : "") +
              (f.event_status ? "<div><dt>Event status</dt><dd>" + esc(f.event_status) + "</dd></div>" : "") +
            "</dl>" +
          "</article>";
        }).join("") +
      "</div>"
    );
  }

  /* ---- Payment events ---------------------------------------------------- */

  function eventsHTML() {
    return (
      '<div class="fin__filters">' +
        '<label class="field fin__search"><span class="sr-only">Search payments</span>' +
          '<input class="input" type="search" data-fin-search placeholder="Order code or payment reference" ' +
            'value="' + esc(state.eventSearch) + '"></label>' +
        '<label class="field"><span class="sr-only">Status</span>' +
          '<select class="select" data-fin-status>' +
            (svc ? svc.EVENT_STATUSES : []).map(function (s) {
              return '<option value="' + s.value + '"' +
                (s.value === state.eventStatus ? " selected" : "") + ">" + s.label + "</option>";
            }).join("") +
          "</select></label>" +
      "</div>" +
      (!state.events.rows.length
        ? '<div class="panel apanel"><div class="empty"><div class="empty__art">' +
          KT.icon("receipt", 30) + "</div><h3>No payment events</h3><p>" +
          (state.eventSearch || state.eventStatus !== "all"
            ? "Nothing matches that filter." : "No gateway activity recorded yet.") +
          "</p></div></div>"
        : '<p class="fin__count">' + state.events.total + " event" +
          (state.events.total === 1 ? "" : "s") + "</p>" +
          '<div class="fin__rows">' +
            state.events.rows.map(function (e) {
              var agree = e.order_total == null || e.amount === e.order_total;
              return '<article class="finrow">' +
                '<div class="finrow__top">' +
                  '<span class="paybadge paybadge--' + esc(e.status) + '">' + esc(e.status) + "</span>" +
                  '<code class="finrow__issue">' + esc(e.reference) + "</code>" +
                  '<span class="finrow__when">' + when(e.created_at) + "</span>" +
                "</div>" +
                '<dl class="finrow__facts">' +
                  "<div><dt>Amount</dt><dd>" + naira(e.amount) + " " + esc(e.currency) + "</dd></div>" +
                  "<div><dt>Order</dt><dd>" + esc(e.order_code || "— unlinked —") + "</dd></div>" +
                  (e.order_total != null
                    ? "<div><dt>Order total</dt><dd" + (agree ? "" : ' class="is-bad"') + ">" +
                      naira(e.order_total) + (agree ? "" : " ⚠") + "</dd></div>" : "") +
                  "<div><dt>Order paid</dt><dd>" + (e.order_paid ? "Yes" : "No") + "</dd></div>" +
                  "<div><dt>Source</dt><dd>" + esc(e.source) + "</dd></div>" +
                "</dl>" +
                (canRefund() && e.order_code && e.order_paid
                  ? '<div class="finrow__actions">' +
                    '<button class="btn btn--ghost btn--sm" type="button" data-fin-refund="' +
                      esc(e.order_code) + '">Refund this order</button></div>'
                  : "") +
              "</article>";
            }).join("") +
          "</div>")
    );
  }

  /* ---- Wallets ----------------------------------------------------------- */

  function walletsHTML() {
    if (!state.wallets.length) {
      return '<div class="panel apanel"><div class="empty"><div class="empty__art">' +
        KT.icon("wallet", 30) + "</div><h3>No wallets</h3></div></div>";
    }
    return (
      '<p class="fin__note">' + KT.icon("lock", 15) +
        "<span>Read-only. Wallet balances can only be changed by the owner through the " +
        "existing adjustment RPC, which records every change in the ledger and the audit log." +
        "</span></p>" +
      '<div class="fin__rows">' +
        state.wallets.map(function (w) {
          return '<article class="finrow"><div class="finrow__top">' +
            '<code class="finrow__issue">' + esc(String(w.user_id).slice(0, 8)) + "…</code>" +
            '<span class="finrow__when">' + when(w.updated_at) + "</span></div>" +
            '<dl class="finrow__facts">' +
              "<div><dt>Balance</dt><dd>" + naira(w.balance) + "</dd></div>" +
              "<div><dt>Available</dt><dd>" + naira(w.available_balance) + "</dd></div>" +
              "<div><dt>Locked</dt><dd>" + naira(w.locked_balance) + "</dd></div>" +
              "<div><dt>Status</dt><dd>" + esc(w.status) + "</dd></div>" +
            "</dl></article>";
        }).join("") +
      "</div>"
    );
  }

  /* ---- Refund confirmation ----------------------------------------------- */

  function confirmHTML() {
    var c = state.confirm;
    if (!c) return "";
    return (
      '<div class="fin__modal" data-fin-modal>' +
        '<div class="fin__modalscrim" data-fin-cancel></div>' +
        '<div class="fin__modalpanel" role="dialog" aria-modal="true">' +
          "<h3>Refund " + esc(c.orderCode) + "?</h3>" +
          '<p class="fin__warn">' + KT.icon("close", 16) +
            "<span>This moves <strong>real money</strong>. The order total is credited to the " +
            "customer's wallet and the order is marked refunded. It cannot be undone from here." +
            "</span></p>" +
          '<label class="field"><span class="field__label">Reason (recorded in the audit log)</span>' +
            '<input class="input" data-fin-reason placeholder="Why is this being refunded?"></label>' +
          '<div class="fin__modalactions">' +
            '<button class="btn btn--ghost" type="button" data-fin-cancel>Cancel</button>' +
            '<button class="btn btn--primary" type="button" data-fin-confirm>Refund order</button>' +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }

  /* ---- Shell ------------------------------------------------------------- */

  var TABS = [
    { id: "overview",       label: "Overview" },
    { id: "reconciliation", label: "Reconciliation" },
    { id: "events",         label: "Payment events" },
    { id: "wallets",        label: "Wallets" }
  ];

  function paint() {
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    var bodyHTML =
      state.error
        ? '<div class="panel apanel"><div class="empty"><div class="empty__art">' +
          KT.icon("close", 32) + "</div><h3>Could not load finance</h3><p>" + esc(state.error) +
          '</p><button class="btn btn--soft" type="button" data-fin-reload>Try again</button></div></div>'
        : state.loading
          ? '<div class="panel apanel">' + KT.loadingLabel("Loading financial data…") +
            KT.skeleton.lines(6) + "</div>"
          : state.tab === "overview" ? overviewHTML()
          : state.tab === "reconciliation" ? reconciliationHTML()
          : state.tab === "events" ? eventsHTML()
          : walletsHTML();

    KT.mount(host,
      '<header class="apage__head"><div><h1>Finance</h1>' +
        '<p class="apage__lede">Payment reconciliation and financial overview. ' +
        "Read-only — this module reports, it does not adjust.</p></div></header>" +
      '<nav class="fin__tabs" aria-label="Finance sections">' +
        TABS.map(function (t) {
          var n = t.id === "reconciliation" && state.findings.length
            ? ' <span class="fin__tabcount">' + state.findings.length + "</span>" : "";
          return '<button class="chip' + (t.id === state.tab ? " is-active" : "") +
            '" type="button" data-fin-tab="' + t.id + '">' + t.label + n + "</button>";
        }).join("") +
      "</nav>" +
      bodyHTML + confirmHTML());
  }

  /* ---- Data -------------------------------------------------------------- */

  async function load() {
    state.loading = true; state.error = null; paint();
    try {
      if (!svc) svc = (await import("../services/admin-finance.js")).adminFinanceService;
      var res = await Promise.all([
        svc.overview(),
        svc.reconciliation({ limit: 200 }),
        svc.paymentEvents({ search: state.eventSearch, status: state.eventStatus }),
        svc.wallets({ limit: 50 })
      ]);
      state.overview = res[0];
      state.findings = res[1];
      state.events = res[2];
      state.wallets = res[3];
      state.loading = false;
      paint();
      svc.logAction("finance.view_sensitive", "Opened the finance overview",
        { findings: state.findings.length });
    } catch (error) {
      state.loading = false;
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
      paint();
    }
  }

  async function reloadEvents() {
    try {
      state.events = await svc.paymentEvents({
        search: state.eventSearch, status: state.eventStatus });
      paint();
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error");
    }
  }

  /* ---- Wiring ------------------------------------------------------------ */

  document.addEventListener("click", async function (e) {
    var tab = e.target.closest("[data-fin-tab]");
    if (tab) {
      state.tab = tab.getAttribute("data-fin-tab");
      paint();
      if (svc) {
        if (state.tab === "reconciliation") {
          svc.logAction("finance.reconciliation_review", "Reviewed reconciliation findings",
            { findings: state.findings.length });
        } else if (state.tab === "events") {
          svc.logAction("finance.payment_events_review", "Reviewed payment events", {});
        } else if (state.tab === "wallets") {
          svc.logAction("finance.wallet_review", "Reviewed wallet balances", {});
        }
      }
      return;
    }
    if (e.target.closest("[data-fin-reload]")) { e.preventDefault(); load(); return; }

    var refund = e.target.closest("[data-fin-refund]");
    if (refund) {
      state.confirm = { orderCode: refund.getAttribute("data-fin-refund") };
      paint();
      return;
    }
    if (e.target.closest("[data-fin-cancel]")) { state.confirm = null; paint(); return; }

    if (e.target.closest("[data-fin-confirm]")) {
      var reason = (KT.qs("[data-fin-reason]") || {}).value || "";
      var btn = e.target.closest("[data-fin-confirm]");
      var done = KT.busy(btn, "Refunding…");
      if (!done) return;
      try {
        var out = await svc.refund(state.confirm.orderCode, reason);
        state.confirm = null;
        KT.toast("Refund: " + (out && out.status ? out.status : "done"), "success",
          { duration: 5000 });
        await load();
      } catch (error) {
        done();
        KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
      }
    }
  });

  document.addEventListener("input", function (e) {
    var s = e.target.closest("[data-fin-search]");
    if (!s) return;
    state.eventSearch = s.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(reloadEvents, 320);   /* debounced */
  });

  document.addEventListener("change", function (e) {
    var sel = e.target.closest("[data-fin-status]");
    if (!sel) return;
    state.eventStatus = sel.value;
    reloadEvents();
  });

  KT.admin.views.finance = function () {
    state = { tab: "overview", loading: true, error: null, overview: null,
      findings: [], events: { total: 0, rows: [] }, wallets: [],
      eventSearch: "", eventStatus: "all", confirm: null, refunding: false };
    window.setTimeout(load, 0);
    return '<header class="apage__head"><div><h1>Finance</h1>' +
      '<p class="apage__lede">Loading financial data…</p></div></header>' +
      '<div class="panel apanel">' + KT.skeleton.lines(6) + "</div>";
  };

  KT.admin.views.financeTeardown = function () {
    window.clearTimeout(searchTimer);
    state.confirm = null;
  };
})(window.KT || (window.KT = {}));
