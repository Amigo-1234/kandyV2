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
    overview: null, findings: [], events: { total: 0, rows: [] },
    w: wfresh(),
    eventSearch: "", eventStatus: "all",
    confirm: null, refunding: false,
    salesGrain: "day", sales: null, salesError: null, salesLoading: false
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

  /* ---- Sales trend --------------------------------------------------------

     One series (paid, non-refunded order value per period), so one colour and
     no legend — the heading names it. Bars, because the periods are discrete
     buckets. Hover or focus a bar for its exact figures; the same numbers are
     in the table underneath, so nothing is hover-only. */

  var GRAINS = [
    { id: "day",   label: "Daily",   span: "last 14 days",   prev: "previous 14 days" },
    { id: "week",  label: "Weekly",  span: "last 12 weeks",  prev: "previous 12 weeks" },
    { id: "month", label: "Monthly", span: "last 12 months", prev: "previous 12 months" }
  ];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function grainMeta() {
    return GRAINS.filter(function (g) { return g.id === state.salesGrain; })[0] || GRAINS[0];
  }

  /* "2026-10-05" -> "5 Oct" / "Oct" / "Oct 2026" — no Date parsing, so no
     timezone can shift a Lagos bucket onto the neighbouring day. */
  function bucketLabel(start, long) {
    var p = String(start).split("-");
    var m = MONTHS[(Number(p[1]) || 1) - 1];
    if (state.salesGrain === "month") return long ? m + " " + p[0] : m;
    var d = String(Number(p[2]) || "");
    if (state.salesGrain === "week") return long ? "Week of " + d + " " + m : d + " " + m;
    return d + " " + m;
  }

  function compact(v) {
    v = Number(v) || 0;
    if (v >= 1e6) return "₦" + (Math.round(v / 1e5) / 10) + "M";
    if (v >= 1e3) return "₦" + (Math.round(v / 100) / 10) + "k";
    return "₦" + v;
  }

  /* Clean y-axis ceiling: 1, 2, 2.5 or 5 x 10^n, so ticks read as round naira. */
  function niceMax(v) {
    if (v <= 0) return 1000;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * p >= v) return steps[i] * p;
    return 10 * p;
  }

  function salesHTML() {
    var g = grainMeta();
    var chips = '<div class="fin__tabs salesc__grains" role="group" aria-label="Sales period">' +
      GRAINS.map(function (x) {
        return '<button class="chip' + (x.id === state.salesGrain ? " is-active" : "") +
          '" type="button" data-fin-grain="' + x.id + '" aria-pressed="' +
          (x.id === state.salesGrain) + '">' + x.label + "</button>";
      }).join("") + "</div>";

    var head = '<h3 class="fin__section">Sales <span>paid orders, refunds excluded · ' +
      g.span + "</span></h3>";

    if (state.salesError) {
      return head + chips + '<div class="panel apanel salesc"><p class="fin__note is-bad">' +
        KT.icon("close", 15) + "<span>Could not load the sales trend: " + esc(state.salesError) +
        "</span></p></div>";
    }
    var d = state.sales;
    if (!d || state.salesLoading) {
      return head + chips + '<div class="panel apanel salesc" aria-busy="true">' +
        KT.skeleton.lines(4) + "</div>";
    }

    var series = d.series || [];
    var cur = d.current || {}, prev = d.previous || {};
    var revenue = Number(cur.revenue) || 0, orders = Number(cur.orders) || 0;
    var prevRev = Number(prev.revenue) || 0;
    var delta = prevRev > 0 ? Math.round(((revenue - prevRev) / prevRev) * 100) : null;
    var max = niceMax(series.reduce(function (m, b) { return Math.max(m, Number(b.revenue) || 0); }, 0));
    var ticks = [0, 0.25, 0.5, 0.75, 1].map(function (f) { return max * f; });
    var best = series.reduce(function (a, b) { return (Number(b.revenue) || 0) > (Number(a.revenue) || 0) ? b : a; },
      series[0] || {});

    var tiles = '<div class="astat__grid salesc__tiles">' +
      stat("Sales", naira(revenue), orders + " paid order" + (orders === 1 ? "" : "s")) +
      stat("Average order", orders ? naira(Math.round(revenue / orders)) : "—", g.span) +
      stat("Vs " + g.prev, delta == null ? "—" : (delta > 0 ? "+" : "") + delta + "%",
           naira(prevRev) + " before", delta == null ? "" : delta >= 0 ? "good" : "warn") +
      "</div>";

    var bars = series.map(function (b, i) {
      var v = Number(b.revenue) || 0;
      var h = max ? (v / max) * 100 : 0;
      var label = bucketLabel(b.start, true) + ": " + naira(v) + ", " + (b.orders || 0) +
        " order" + (b.orders === 1 ? "" : "s");
      return '<div class="salesc__col">' +
        '<button class="salesc__hit" type="button" data-sbar="' + i + '" aria-label="' + esc(label) + '">' +
          '<span class="salesc__bar' + (v ? "" : " is-zero") + '" style="height:' + h.toFixed(2) + '%"></span>' +
        "</button>" +
        '<span class="salesc__x' + (i % 2 ? " is-odd" : "") + '">' + esc(bucketLabel(b.start)) + "</span>" +
      "</div>";
    }).join("");

    var grid = ticks.map(function (t) {
      return '<div class="salesc__tick" style="bottom:' + ((t / max) * 100).toFixed(2) + '%">' +
        "<span>" + compact(t) + "</span></div>";
    }).join("");

    var table = '<details class="salesc__table"><summary>Show as table</summary>' +
      '<div class="salesc__scroll"><table><thead><tr><th scope="col">Period</th>' +
      '<th scope="col">Sales</th><th scope="col">Orders</th></tr></thead><tbody>' +
      series.slice().reverse().map(function (b) {
        return "<tr><td>" + esc(bucketLabel(b.start, true)) + "</td><td>" + naira(b.revenue) +
          "</td><td>" + (b.orders || 0) + "</td></tr>";
      }).join("") + "</tbody></table></div></details>";

    return head + chips + tiles +
      '<div class="panel apanel salesc">' +
        (revenue
          ? '<p class="salesc__peak">Best ' + (state.salesGrain === "day" ? "day" : state.salesGrain) +
            ": <strong>" + esc(bucketLabel(best.start, true)) + "</strong> · " + naira(best.revenue) + "</p>"
          : '<p class="salesc__peak">No paid sales in this period yet.</p>') +
        '<div class="salesc__plot" data-sales-plot>' +
          '<div class="salesc__grid" aria-hidden="true">' + grid + "</div>" +
          '<div class="salesc__bars" role="group" aria-label="Sales by ' +
            (state.salesGrain === "day" ? "day" : state.salesGrain) + '">' + bars + "</div>" +
          '<div class="salesc__tip" data-sales-tip hidden></div>' +
        "</div>" +
        table +
      "</div>";
  }

  function showTip(btn) {
    var tip = KT.qs("[data-sales-tip]");
    var plot = KT.qs("[data-sales-plot]");
    if (!tip || !plot || !state.sales) return;
    var b = (state.sales.series || [])[Number(btn.getAttribute("data-sbar"))];
    if (!b) return;
    tip.textContent = "";
    var v = document.createElement("strong");
    v.textContent = naira(b.revenue);
    var l = document.createElement("span");
    l.textContent = bucketLabel(b.start, true) + " · " + (b.orders || 0) + " order" + (b.orders === 1 ? "" : "s");
    tip.appendChild(v); tip.appendChild(l);
    tip.hidden = false;
    var pr = plot.getBoundingClientRect(), br = btn.getBoundingClientRect();
    var x = br.left + br.width / 2 - pr.left;
    var w = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(pr.width - w, x - w / 2)) + "px";
  }
  function hideTip() { var tip = KT.qs("[data-sales-tip]"); if (tip) tip.hidden = true; }

  async function loadSales() {
    state.salesLoading = true; state.salesError = null;
    if (state.tab === "overview" && !state.loading) paint();
    try {
      state.sales = await svc.salesSeries(state.salesGrain);
    } catch (error) {
      state.salesError = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
    } finally {
      state.salesLoading = false;
      if (state.tab === "overview" && !state.loading) paint();
    }
  }

  function overviewHTML() {
    var o = state.overview;
    if (!o) return "";
    return (
      '<p class="fin__asof">Figures as at ' + when(o.generated_at) + "</p>" +
      salesHTML() +

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
        /* An "ignored" event is a payment that arrived for an order that was
           ALREADY paid. A true webhook replay reuses the same reference and
           is de-duplicated before it is ever recorded, so a row here is a
           separate charge until proven otherwise — flag it, never shrug it. */
        stat("Needs review", o.collected.events_ignored,
             "payments on already-paid orders — possible duplicate charge; check and refund",
             o.collected.events_ignored ? "bad" : "") +
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
                  '<span class="paybadge paybadge--' + esc(e.status) + '">' +
                    (e.status === "ignored"
                      ? "needs review — order was already paid"
                      : esc(e.status)) + "</span>" +
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

  /* ---- Wallets -----------------------------------------------------------

     A customer directory over the authoritative ledger (0084). Every figure
     comes from admin_wallet_directory / admin_wallet_history, which read
     wallets, wallet_transactions and wallet_funding_intents as stored —
     nothing here adds up money on its own except to display it. Both RPCs
     are owner/admin only and refuse anyone else on the server. */

  var WFILTERS = [
    { id: "activity", label: "With activity", count: "with_activity" },
    { id: "balance",  label: "Money in wallet", count: "with_balance" },
    { id: "attempts", label: "Unfinished top-ups", count: null },
    { id: "mismatch", label: "Mismatches", count: "mismatched" },
    { id: "all",      label: "Everyone", count: "wallets" }
  ];
  var WCATS = [
    { id: "",                   label: "All" },
    { id: "funding",            label: "Top-ups" },
    { id: "payment",            label: "Payments" },
    { id: "refund",             label: "Refunds" },
    { id: "adjustment",         label: "Adjustments" },
    { id: "partner_commission", label: "Partner commission" },
    { id: "reward",             label: "Rewards" }
  ];
  var CAT_LABEL = { funding: "Top-up", payment: "Order payment", refund: "Refund", adjustment: "Adjustment",
                    partner_commission: "Partner commission", reward: "Reward", other: "Other" };
  var ATTEMPT_LABEL = {
    pending: "Not completed — no money received",
    failed: "Failed — no money received",
    cancelled: "Cancelled — no money received",
    mismatch: "Not credited — payment could not be verified. Needs review."
  };

  function wfresh() {
    return { search: "", filter: "activity", data: null, rows: [], loading: false, error: null,
             sel: null, hist: null, histLoading: false, histError: null, cat: "", q: "" };
  }

  function dayTime(d) {
    if (!d) return "—";
    return new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Lagos" });
  }
  function signed(n) {
    var v = Number(n || 0);
    return (v < 0 ? "−" : "+") + naira(Math.abs(v));
  }

  function reconBanner(t) {
    if (t.reconciled) {
      return '<p class="fin__note wrecon is-ok">' + KT.icon("check", 15) + "<span><strong>Ledger reconciles.</strong> " +
        naira(t.balance_total) + " held in " + t.wallets + " wallets equals " + naira(t.ledger_net_total) +
        " recorded in the wallet ledger, every wallet matches its own history, and each of the " + t.paid_intents +
        " paid Paystack top-ups has exactly one matching credit.</span></p>";
    }
    var bits = [];
    if (t.mismatched) bits.push(t.mismatched + " wallet(s) whose balance does not match their ledger");
    if (Number(t.balance_total) !== Number(t.ledger_net_total)) bits.push("total balances " + naira(t.balance_total) +
      " vs ledger " + naira(t.ledger_net_total));
    if (t.paid_intents_unmatched) bits.push(t.paid_intents_unmatched + " paid top-up(s) without a matching credit");
    if (t.funding_without_intent) bits.push(t.funding_without_intent + " top-up credit(s) without a paid Paystack record");
    if (t.transactions_without_wallet) bits.push(t.transactions_without_wallet + " ledger owner(s) without a wallet");
    return '<p class="fin__note wrecon is-bad">' + KT.icon("close", 15) + "<span><strong>Needs attention:</strong> " +
      esc(bits.join("; ")) + ". Nothing has been changed — " +
      (t.mismatched ? '<button class="linkbtn" type="button" data-wfilter="mismatch">show the mismatched wallets</button>.' : "review below.") +
      "</span></p>";
  }

  function walletTotalsHTML(t) {
    return '<div class="astat__grid">' +
      stat("Held in wallets", naira(t.balance_total), t.with_balance + " with money" + (t.locked_total ? " · " + naira(t.locked_total) + " locked" : "")) +
      stat("Topped up", naira(t.funding_total), t.funding_count + " successful Paystack top-ups") +
      stat("Spent from wallets", naira(t.payments_total), t.payments_count + " order payments") +
      stat("Refunded to wallets", naira(t.refunds_in_total), t.refunds_out_total ? naira(t.refunds_out_total) + " refund debits" : "order refunds") +
      stat("Adjustments", (t.adjust_in_total || t.adjust_out_total) ? "+" + naira(t.adjust_in_total) + " / −" + naira(t.adjust_out_total) : naira(0),
           "owner corrections") +
      stat("Partner commission", naira(t.partner_total), t.rewards_total ? naira(t.rewards_total) + " other rewards" : "paid to Partners") +
      stat("Unfinished top-ups", String(t.attempts), naira(t.attempts_amount) + " — no money received") +
    "</div>";
  }

  function wrowHTML(r) {
    var contact = [r.email, r.phone].filter(Boolean).map(esc).join(" · ") || '<span class="wmuted">No email or phone on file</span>';
    var facts = [["Topped up", naira(r.funding)], ["Spent", naira(r.payments)]];
    if (r.refunds_in || r.refunds_out) facts.push(["Refunds", naira(r.refunds_in) + (r.refunds_out ? " / −" + naira(r.refunds_out) : "")]);
    if (r.adjust_in || r.adjust_out) facts.push(["Adjustments", "+" + naira(r.adjust_in) + " / −" + naira(r.adjust_out)]);
    if (r.partner) facts.push(["Partner commission", naira(r.partner)]);
    if (r.rewards) facts.push(["Rewards", naira(r.rewards)]);
    if (r.attempts) facts.push(["Unfinished top-ups", r.attempts + " · " + naira(r.attempts_amount)]);
    return '<button class="wrow' + (r.reconciled ? "" : " is-bad") + '" type="button" data-wopen="' + esc(r.user_id) + '">' +
      '<span class="wrow__who"><strong>' + (r.name ? esc(r.name) : '<em class="wmuted">No name on account</em>') + "</strong>" +
        (r.role && r.role !== "customer" ? '<span class="wrole">' + esc(r.role) + "</span>" : "") +
        (r.suspended ? '<span class="wrole is-bad">suspended</span>' : "") +
        '<span class="wrow__contact">' + contact + "</span></span>" +
      '<span class="wrow__bal"><strong>' + naira(r.balance) + "</strong><span>balance</span></span>" +
      '<span class="wrow__facts">' + facts.map(function (f) {
        return "<span><em>" + esc(f[0]) + "</em> " + esc(f[1]) + "</span>";
      }).join("") + "</span>" +
      '<span class="wrow__meta">' + (r.last_at ? "Last activity " + esc(dayTime(r.last_at)) : "No wallet transactions") +
        (r.reconciled ? "" : ' · <strong class="wbad">balance does not match its ledger</strong>') + "</span>" +
    "</button>";
  }

  function walletsHTML() {
    var w = state.w;
    if (w.sel) return walletHistoryHTML();
    if (w.error) {
      return '<div class="panel apanel"><p class="field__error">' + esc(w.error) + '</p>' +
        '<button class="btn btn--soft btn--sm" type="button" data-wreload>Try again</button></div>';
    }
    if (!w.data) return '<div class="panel apanel">' + KT.loadingLabel("Loading customer wallets…") + KT.skeleton.lines(5) + "</div>";
    var t = w.data.totals;
    return (
      reconBanner(t) +
      walletTotalsHTML(t) +
      '<p class="fin__note">' + KT.icon("lock", 15) +
        "<span>Read-only. Only owners and admins can open this page. Balances change only through payments, " +
        "Paystack top-ups, refunds and the owner's audited adjustment tool.</span></p>" +
      '<div class="fin__filters">' +
        '<label class="field fin__search"><span class="sr-only">Search customers</span>' +
          '<input class="input" type="search" data-wsearch value="' + esc(w.search) + '" placeholder="Search by name, email or phone"></label>' +
      "</div>" +
      '<div class="ochips wfilters" role="group" aria-label="Show">' + WFILTERS.map(function (f) {
        var n = f.count ? t[f.count] : null;
        return '<button class="chip' + (w.filter === f.id ? " is-active" : "") + '" type="button" data-wfilter="' + f.id + '">' +
          esc(f.label) + (n !== null && n !== undefined ? " (" + n + ")" : "") + "</button>";
      }).join("") + "</div>" +
      '<p class="fin__count">' + (w.loading ? "Loading…" : w.data.matching + (w.data.matching === 1 ? " customer" : " customers")) + "</p>" +
      (w.rows.length
        ? '<div class="wlist">' + w.rows.map(wrowHTML).join("") + "</div>"
        : '<div class="panel apanel"><p class="odetail__muted">No customers match.</p></div>') +
      (w.rows.length < w.data.matching
        ? '<p class="wmore"><button class="btn btn--soft" type="button" data-wmore' + (w.loading ? " disabled" : "") + ">Show more</button></p>"
        : "")
    );
  }

  function walletHistoryHTML() {
    var w = state.w;
    var back = '<p><button class="btn btn--ghost btn--sm" type="button" data-wback>' + KT.icon("arrowLeft", 15) +
      "<span>All customer wallets</span></button></p>";
    if (w.histError) return back + '<div class="panel apanel"><p class="field__error">' + esc(w.histError) + "</p></div>";
    if (w.histLoading || !w.hist) return back + '<div class="panel apanel">' + KT.loadingLabel("Loading wallet history…") + KT.skeleton.lines(6) + "</div>";
    var h = w.hist, c = h.customer, s = h.summary, rc = h.reconciliation, wl = h.wallet || {};
    var q = w.q.trim().toLowerCase();
    var rows = h.transactions.slice().reverse().filter(function (t) {
      if (w.cat && t.category !== w.cat) return false;
      if (q && [t.order_code, t.reference, t.description, CAT_LABEL[t.category]].join(" ").toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    return back +
      '<section class="panel apanel whead">' +
        '<div class="whead__who"><h2>' + (c.name ? esc(c.name) : '<em class="wmuted">No name on account</em>') + "</h2>" +
          "<p>" + [c.email, c.phone].filter(Boolean).map(esc).join(" · ") +
            (c.role && c.role !== "customer" ? ' · <span class="wrole">' + esc(c.role) + "</span>" : "") +
            (c.joined ? " · joined " + esc(dayTime(c.joined).replace(/,? \d\d:\d\d$/, "")) : "") + "</p></div>" +
        '<div class="whead__bal"><strong>' + naira(wl.balance) + "</strong><span>current balance" +
          (wl.locked ? " · " + naira(wl.locked) + " locked" : "") + "</span></div>" +
      "</section>" +
      (rc.ok
        ? '<p class="fin__note wrecon is-ok">' + KT.icon("check", 15) + "<span>Balance " + naira(rc.balance) +
          " matches this customer's ledger (" + s.transactions + " transactions). Every running balance below agrees with the balance recorded at the time.</span></p>"
        : '<p class="fin__note wrecon is-bad">' + KT.icon("close", 15) + "<span><strong>Does not reconcile:</strong> balance " +
          naira(rc.balance) + " vs ledger " + naira(rc.ledger_net) +
          (rc.running_mismatches ? "; " + rc.running_mismatches + " row(s) whose recorded balance differs from the running total" : "") +
          ". Nothing has been changed.</span></p>") +
      '<div class="astat__grid">' +
        stat("Topped up", naira(s.funding), s.funding_count + " top-ups") +
        stat("Spent", naira(s.payments), s.payments_count + " order payments") +
        stat("Refunds", naira(s.refunds_in), s.refunds_out ? "−" + naira(s.refunds_out) + " refund debits" : "back to wallet") +
        stat("Adjustments", "+" + naira(s.adjust_in) + " / −" + naira(s.adjust_out), "owner corrections") +
        stat("Partner commission", naira(s.partner_commission), s.rewards ? naira(s.rewards) + " other rewards" : "") +
      "</div>" +
      '<h3 class="fin__section">Transactions <span>newest first</span></h3>' +
      '<div class="ochips wfilters" role="group" aria-label="Transaction type">' + WCATS.map(function (k) {
        return '<button class="chip' + (w.cat === k.id ? " is-active" : "") + '" type="button" data-wcat="' + k.id + '">' + esc(k.label) + "</button>";
      }).join("") + "</div>" +
      '<div class="fin__filters"><label class="field fin__search"><span class="sr-only">Search transactions</span>' +
        '<input class="input" type="search" data-wq value="' + esc(w.q) + '" placeholder="Order number or reference"></label></div>' +
      (rows.length
        ? '<div class="wtx-wrap" tabindex="0" role="region" aria-label="Wallet transactions"><table class="wtx"><thead><tr>' +
            "<th>Date</th><th>Type</th><th>Order</th><th>Reference</th><th class=\"num\">Amount</th><th class=\"num\">Balance after</th><th>Status</th>" +
          "</tr></thead><tbody>" + rows.map(function (t) {
            return '<tr class="' + (t.running_ok ? "" : "is-bad") + '">' +
              '<td data-l="Date">' + esc(dayTime(t.created_at)) + "</td>" +
              '<td data-l="Type"><span class="wcat wcat--' + esc(t.category) + '">' + esc(CAT_LABEL[t.category] || t.category) + "</span>" +
                (t.description ? '<span class="wdesc">' + esc(t.description) + "</span>" : "") + "</td>" +
              '<td data-l="Order">' + (t.order_code ? "<strong>" + esc(t.order_code) + "</strong>" : '<span class="wmuted">—</span>') + "</td>" +
              '<td data-l="Reference"><code class="wref">' + esc(t.reference || "—") + "</code></td>" +
              '<td data-l="Amount" class="num ' + (t.signed < 0 ? "wneg" : "wpos") + '">' + signed(t.signed) + "</td>" +
              '<td data-l="Balance after" class="num">' + naira(t.balance_after) +
                (t.running_ok ? "" : '<span class="wbad"> (running total ' + naira(t.running) + ")</span>") + "</td>" +
              '<td data-l="Status">Completed</td></tr>';
          }).join("") + "</tbody></table></div>"
        : '<div class="panel apanel"><p class="odetail__muted">' +
            (h.transactions.length ? "No transactions match." : "This wallet has no transactions.") + "</p></div>") +
      '<h3 class="fin__section">Top-ups that did not go through <span>no money was received for these</span></h3>' +
      (h.attempts.length
        ? '<div class="wtx-wrap"><table class="wtx"><thead><tr><th>Started</th><th class="num">Amount</th><th>Reference</th><th>Status</th></tr></thead><tbody>' +
          h.attempts.map(function (a) {
            return "<tr>" +
              '<td data-l="Started">' + esc(dayTime(a.created_at)) + "</td>" +
              '<td data-l="Amount" class="num wmuted">' + naira(a.amount) + "</td>" +
              '<td data-l="Reference"><code class="wref">' + esc(a.reference) + "</code></td>" +
              '<td data-l="Status"><span class="wattempt wattempt--' + esc(a.status) + '">' +
                esc(a.awaiting ? "Waiting for Paystack confirmation" : (ATTEMPT_LABEL[a.status] || a.status)) + "</span></td></tr>";
          }).join("") + "</tbody></table></div>"
        : '<div class="panel apanel"><p class="odetail__muted">None.</p></div>');
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
        svc.paymentEvents({ search: state.eventSearch, status: state.eventStatus })
      ]);
      state.overview = res[0];
      state.findings = res[1];
      state.events = res[2];
      state.loading = false;
      paint();
      if (state.tab === "wallets") loadWallets(false);
      loadSales();   /* its own failure must not take the rest of Finance down */
      svc.logAction("finance.view_sensitive", "Opened the finance overview",
        { findings: state.findings.length });
    } catch (error) {
      state.loading = false;
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
      paint();
    }
  }

  var wGen = 0;
  async function loadWallets(append) {
    var w = state.w;
    var gen = ++wGen;
    w.loading = true; w.error = null; paint();
    try {
      if (!svc) svc = (await import("../services/admin-finance.js")).adminFinanceService;
      var res = await svc.walletDirectory({ search: w.search, filter: w.filter, limit: 50,
                                            offset: append ? w.rows.length : 0 });
      if (gen !== wGen) return;
      w.data = res;
      w.rows = append ? w.rows.concat(res.rows) : res.rows;
    } catch (error) {
      if (gen !== wGen) return;
      w.error = KT.services.errorMessage(error);
    } finally {
      if (gen === wGen) { w.loading = false; paint(); }
    }
  }

  async function openWallet(userId) {
    var w = state.w;
    w.sel = userId; w.hist = null; w.histError = null; w.histLoading = true; w.cat = ""; w.q = "";
    paint();
    window.scrollTo({ top: 0, behavior: "smooth" });
    try {
      var h = await svc.walletHistory(userId);
      if (state.w !== w || w.sel !== userId) return;
      w.hist = h;
    } catch (error) {
      if (state.w !== w || w.sel !== userId) return;
      w.histError = KT.services.errorMessage(error);
    } finally {
      if (state.w === w && w.sel === userId) { w.histLoading = false; paint(); }
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
          if (!state.w.data) loadWallets(false);
        }
      }
      return;
    }

    var wf = e.target.closest("[data-wfilter]");
    if (wf) { state.w.filter = wf.getAttribute("data-wfilter"); state.w.sel = null; loadWallets(false); return; }
    if (e.target.closest("[data-wmore]")) { loadWallets(true); return; }
    if (e.target.closest("[data-wreload]")) { loadWallets(false); return; }
    var wo = e.target.closest("[data-wopen]");
    if (wo) { openWallet(wo.getAttribute("data-wopen")); return; }
    if (e.target.closest("[data-wback]")) { state.w.sel = null; state.w.hist = null; paint(); return; }
    var wc = e.target.closest("[data-wcat]");
    if (wc) { state.w.cat = wc.getAttribute("data-wcat"); paint(); return; }
    if (e.target.closest("[data-fin-reload]")) { e.preventDefault(); load(); return; }

    var grain = e.target.closest("[data-fin-grain]");
    if (grain) {
      var want = grain.getAttribute("data-fin-grain");
      if (want !== state.salesGrain && svc) { state.salesGrain = want; loadSales(); }
      return;
    }

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

  /* One tooltip for the sales chart: pointer and keyboard focus alike. */
  document.addEventListener("pointerover", function (e) {
    var b = e.target.closest && e.target.closest("[data-sbar]");
    if (b) showTip(b);
  });
  document.addEventListener("focusin", function (e) {
    var b = e.target.closest && e.target.closest("[data-sbar]");
    if (b) showTip(b);
  });
  document.addEventListener("pointerout", function (e) {
    if (e.target.closest && e.target.closest("[data-sales-plot]") &&
        !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("[data-sbar]"))) hideTip();
  });
  document.addEventListener("focusout", function (e) {
    if (e.target.closest && e.target.closest("[data-sbar]")) hideTip();
  });

  var wTimer = null;
  function refocus(sel, el) {
    var caret = el.selectionStart;
    var again = KT.qs(sel);
    if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (x) {} }
  }

  document.addEventListener("input", function (e) {
    var ws = e.target.closest && e.target.closest("[data-wsearch]");
    if (ws) {
      state.w.search = ws.value;
      window.clearTimeout(wTimer);
      wTimer = window.setTimeout(function () {
        loadWallets(false).then(function () { refocus("[data-wsearch]", ws); });
      }, 320);
      return;
    }
    var wq = e.target.closest && e.target.closest("[data-wq]");
    if (wq) { state.w.q = wq.value; paint(); refocus("[data-wq]", wq); return; }
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
    /*
       #/finance?tab=reconciliation is a real entry point, not a convenience:
       the dashboard's "Payment issues" tile and every `payment` notification
       carry a live count, and a count that lands on the wrong tab is the same
       broken promise as one that lands nowhere. Only the tabs this view
       actually has are honoured, so a hand-edited hash falls back to the
       overview rather than rendering an empty panel.
    */
    var qp = KT.admin.routeParams();
    var wanted = TABS.some(function (t) { return t.id === qp.tab; }) ? qp.tab : "overview";
    state = { tab: wanted, loading: true, error: null, overview: null,
      findings: [], events: { total: 0, rows: [] }, w: wfresh(),
      eventSearch: "", eventStatus: "all", confirm: null, refunding: false,
      salesGrain: "day", sales: null, salesError: null, salesLoading: false };
    window.setTimeout(load, 0);
    return '<header class="apage__head"><div><h1>Finance</h1>' +
      '<p class="apage__lede">Loading financial data…</p></div></header>' +
      '<div class="panel apanel">' + KT.skeleton.lines(6) + "</div>";
  };

  KT.admin.views.financeTeardown = function () {
    window.clearTimeout(searchTimer);
    window.clearTimeout(wTimer);
    wGen += 1;
    state.confirm = null;
  };
})(window.KT || (window.KT = {}));
