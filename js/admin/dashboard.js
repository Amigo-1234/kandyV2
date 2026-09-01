/* ==========================================================================
   Kandy's Treats — Operational dashboard
   --------------------------------------------------------------------------
   Replaces the Phase 4 placeholder. Every figure on this screen comes from
   admin_dashboard(), which counts real rows; nothing is estimated, averaged
   or projected, and no money is totalled here — that is Finance's job and
   duplicating it would create a second set of figures to disagree with.

   ROLE
   ----
   This file does not decide what a role may see. The RPC omits the whole
   `finance` block for staff and supervisor, so the payment-issues tile is
   absent because the data is absent, not because a condition here hid it.
   The same is true of contact messages, which the server reports as zero to
   a staff caller.

   ACTIONABLE
   ----------
   Every tile is a link into the module that owns the number — Phase 12 §4.
   None of them open a new screen: they set a filter on Orders, a tab on
   Support, or a status on Menu, all of which already existed.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};
  KT.admin.views = KT.admin.views || {};

  var svc = null;
  var state = { loading: true, error: null, data: null, scoops: null, live: false };
  var stop = null;
  var refreshTimer = null;

  function esc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function clock(d) {
    if (!d) return "";
    var t = new Date(d);
    var mins = Math.round((Date.now() - t.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    if (mins < 60 * 24) return Math.round(mins / 60) + "h ago";
    return t.toLocaleDateString("en-NG", { day: "2-digit", month: "short" });
  }

  /* ---- Tiles ------------------------------------------------------------- */

  /*
     `tone` is the only decorative decision on this screen, and it is not
     cosmetic: "attention" means a number a person is expected to act on
     today. A zero is never toned — nothing to chase is good news, not an
     alert.
  */
  function tile(t) {
    var n = Number(t.value) || 0;
    /* dtile--*, not astat--*: Finance owns the astat-- tone classes and
       colours the figure with them. */
    var tone = n > 0 && t.tone ? " dtile--" + t.tone : "";
    return (
      '<a class="astat astat--link' + tone + '" href="' + t.href + '">' +
        '<span class="astat__top">' +
          '<span class="astat__icon">' + KT.icon(t.icon, 17) + "</span>" +
          '<span class="astat__label">' + esc(t.label) + "</span>" +
        "</span>" +
        '<strong class="astat__value">' + n + "</strong>" +
        '<span class="astat__hint">' + esc(t.hint) + KT.icon("chevronRight", 14) + "</span>" +
      "</a>"
    );
  }

  /* ---- Scoops ------------------------------------------------------------
     The first component of the end-of-day business report. Everything here is
     read from admin_scoop_report(); nothing is computed in the browser, and
     no product is named in this file — marking a sixth item as sold by the
     scoop puts it in the list with no code change.

     Revenue is rendered only when the server sent it. Below manager tier the
     key comes back null, exactly as the finance block does, so a handler sees
     how much food went out without seeing what it was worth.
  */
  function scoopsSection(s) {
    if (!s) return "";
    var net = (s.net && Number(s.net.scoops)) || 0;
    var rev = s.net && s.net.revenue;
    var showRev = s.includes_revenue && rev !== null && rev !== undefined;
    var rows = s.by_product || [];

    var body;
    if (!net && !rows.length) {
      body = '<p class="dscoop__empty">No scoops sold yet today.</p>';
    } else {
      body =
        '<div class="dscoop__head">' +
          '<div class="dscoop__figure">' +
            '<strong class="dscoop__n">' + net + "</strong>" +
            '<span class="dscoop__unit">scoop' + (net === 1 ? "" : "s") + "</span>" +
          "</div>" +
          (showRev ? '<span class="dscoop__rev">' + KT.naira(rev) + "</span>" : "") +
        "</div>" +
        '<ul class="dscoop__list">' +
          rows.map(function (r) {
            /* The catalogue name carries the unit for humans; the card is
               already headed "scoops", so the suffix is noise here. */
            var label = String(r.product || "").replace(/\s*\(per scoop\)\s*/i, "");
            return "<li><span class=\"dscoop__name\">" + esc(label) + "</span>" +
              '<span class="dscoop__qty">' + (Number(r.net_scoops) || 0) + "</span>" +
              (showRev
                ? '<span class="dscoop__money">' + KT.naira(Number(r.net_revenue) || 0) + "</span>"
                : "") + "</li>";
          }).join("") +
        "</ul>" +
        ((s.cancelled && Number(s.cancelled.scoops))
          ? '<p class="dsec__note"><strong>' + s.cancelled.scoops +
            "</strong> scoop" + (Number(s.cancelled.scoops) === 1 ? "" : "s") +
            " cancelled today and already excluded from this total.</p>"
          : "");
    }

    return (
      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("flame", 17) + "Scoops sold today</h2>" +
          '<a class="dsec__all" href="#/orders?range=today">Today\u2019s orders' +
            KT.icon("chevronRight", 14) + "</a>" +
        "</header>" +
        '<div class="panel apanel dscoop">' + body + "</div>" +
      "</section>"
    );
  }

  function ordersSection(d) {
    var o = d.orders || {};
    return (
      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("receipt", 17) + "Kitchen</h2>" +
          '<a class="dsec__all" href="#/orders">All orders' + KT.icon("chevronRight", 14) + "</a>" +
        "</header>" +
        '<div class="astat__grid">' +
          tile({ label: "Awaiting start", value: o.new, icon: "clock",
                 tone: "warn", href: "#/orders?status=New",
                 hint: "New orders" }) +
          tile({ label: "In the kitchen", value: o.preparing, icon: "flame",
                 tone: "info", href: "#/orders?status=Preparing",
                 hint: "Being prepared" }) +
          tile({ label: "Out for delivery", value: o.out, icon: "bike",
                 tone: "info", href: "#/orders?status=Out",
                 hint: "On the way" }) +
          tile({ label: "Completed today", value: o.completed_today, icon: "check",
                 href: "#/orders?status=Completed", hint: "Delivered today" }) +
        "</div>" +
        '<p class="dsec__note">' +
          "<strong>" + (Number(o.today) || 0) + "</strong> order" +
          ((Number(o.today) || 0) === 1 ? "" : "s") + " placed today" +
          ((Number(o.cancelled_today) || 0)
            ? " · <strong>" + o.cancelled_today + "</strong> cancelled"
            : "") +
        "</p>" +
      "</section>"
    );
  }

  function supportSection(d) {
    var s = d.support || {};
    var showContacts = d.is_supervisor === true;
    return (
      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("mail", 17) + "Support</h2>" +
          '<a class="dsec__all" href="#/support">Open support' + KT.icon("chevronRight", 14) + "</a>" +
        "</header>" +
        '<div class="astat__grid">' +
          tile({ label: "Unread chats", value: s.chat_conversations, icon: "mail",
                 tone: "alert", href: "#/support?tab=chat",
                 hint: (Number(s.chat_messages) || 0) + " message" +
                       ((Number(s.chat_messages) || 0) === 1 ? "" : "s") }) +
          tile({ label: "Open tickets", value: s.open_tickets, icon: "receipt",
                 tone: "warn", href: "#/support?tab=tickets",
                 hint: "Awaiting a reply" }) +
          (showContacts
            ? tile({ label: "New enquiries", value: s.new_contacts, icon: "phone",
                     tone: "warn", href: "#/support?tab=contacts",
                     hint: "Contact form" })
            : "") +
        "</div>" +
        (s.latest_at
          ? '<p class="dsec__note">Last customer message ' + esc(clock(s.latest_at)) + "</p>"
          : "") +
      "</section>"
    );
  }

  function operationsSection(d) {
    var m = d.menu || {};
    var o = d.orders || {};
    /* Finance is absent from the response for staff and supervisor. */
    var f = d.finance;
    var tiles =
      tile({ label: "Sold out", value: m.sold_out, icon: "flame", tone: "warn",
             href: "#/menu?status=sold_out", hint: "Off the menu today" }) +
      tile({ label: "Hidden items", value: m.hidden, icon: "eye",
             href: "#/menu?status=hidden", hint: "Not shown to customers" }) +
      tile({ label: "Unpaid, still open", value: o.unpaid_active, icon: "wallet",
             tone: "warn", href: "#/orders?payment=unpaid",
             hint: "Active and unpaid" });

    if (f) {
      /* Reconciliation lives inside Finance (min: admin), which is exactly the
       tier admin_dashboard() shows this count to. The old #/reconciliation
       nav id has no view module, so an owner landed on "Coming in a later
       phase" and an admin on "Not available to your role" — a live count
       pointing at a screen that never shows it. */
    tiles += tile({ label: "Payment issues", value: f.critical, icon: "lock",
                      tone: "alert", href: "#/finance?tab=reconciliation",
                      hint: (Number(f.warning) || 0) + " warning" +
                            ((Number(f.warning) || 0) === 1 ? "" : "s") });
    }

    return (
      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("settings", 17) + "Operations</h2>" +
          '<a class="dsec__all" href="#/menu">Menu availability' + KT.icon("chevronRight", 14) + "</a>" +
        "</header>" +
        '<div class="astat__grid">' + tiles + "</div>" +
        (f ? "" :
          '<p class="dsec__note dsec__note--muted">' + KT.icon("lock", 14) +
          " Payment and reconciliation figures are admin and owner only.</p>") +
      "</section>"
    );
  }

  /* ---- Recent orders ----------------------------------------------------- */

  function recentOrders(d) {
    var rows = d.recent_orders || [];
    if (!rows.length) {
      return '<div class="dpanel">' +
        '<header class="dpanel__head"><h2>Recent orders</h2></header>' +
        '<div class="dempty">' + KT.icon("receipt", 26) +
        "<p>No orders yet. They appear here the moment one is placed.</p></div></div>";
    }
    return (
      '<div class="dpanel">' +
        '<header class="dpanel__head"><h2>Recent orders</h2>' +
          '<a class="dsec__all" href="#/orders">All' + KT.icon("chevronRight", 14) + "</a>" +
        "</header>" +
        '<div class="dlist">' + rows.map(function (r) {
          return '<a class="drow" href="#/orders?code=' + encodeURIComponent(r.code) + '">' +
            '<span class="drow__main"><strong>' + esc(r.code) + "</strong>" +
              '<span class="drow__sub">' + esc(r.customer || "Guest") + " · " +
              (r.fulfilment === "pickup" ? "Pickup" : "Delivery") + "</span></span>" +
            '<span class="obadge ' + statusClass(r.status) + '">' + esc(r.status) + "</span>" +
            '<span class="drow__price">' + KT.naira(r.total) +
              (r.paid ? "" : ' <em class="drow__unpaid">unpaid</em>') + "</span>" +
            '<span class="drow__time">' + esc(clock(r.at)) + "</span>" +
          "</a>";
        }).join("") + "</div>" +
      "</div>"
    );
  }

  /* Reuses the order badge vocabulary the Orders screen already defines, so a
     status looks the same wherever it is shown. */
  function statusClass(s) {
    if (s === "Completed") return "is-completed";
    if (s === "Cancelled") return "is-cancelled";
    if (s === "New") return "is-new";
    if (s === "Preparing") return "is-preparing";
    return "is-out";
  }

  /* ---- Activity ---------------------------------------------------------- */

  var ACTIVITY = {
    "order.created":    { icon: "receipt", href: function (e) { return "#/orders?code=" + encodeURIComponent(e.subject); } },
    "order.status":     { icon: "bike",    href: function (e) { return "#/orders?code=" + encodeURIComponent(e.subject); } },
    "chat.message":     { icon: "mail",    href: function () { return "#/support?tab=chat"; } },
    "ticket.created":   { icon: "mail",    href: function () { return "#/support?tab=tickets"; } },
    "ticket.reply":     { icon: "mail",    href: function () { return "#/support?tab=tickets"; } },
    "contact.received": { icon: "phone",   href: function () { return "#/support?tab=contacts"; } },
    "menu.unavailable": { icon: "flame",   href: function () { return "#/menu"; } }
  };

  function activityPanel(d) {
    var rows = d.activity || [];
    if (!rows.length) {
      return '<div class="dpanel">' +
        '<header class="dpanel__head"><h2>Recent activity</h2></header>' +
        '<div class="dempty">' + KT.icon("sparkle", 26) +
        "<p>Nothing has happened yet today. Orders, messages and menu changes " +
        "show up here as they land.</p></div></div>";
    }
    return (
      '<div class="dpanel">' +
        '<header class="dpanel__head"><h2>Recent activity</h2>' +
          '<span class="dpanel__hint">Across orders, support and the menu</span>' +
        "</header>" +
        '<ol class="dfeed">' + rows.map(function (e) {
          var meta = ACTIVITY[e.kind] || { icon: "sparkle", href: function () { return "#/dashboard"; } };
          return '<li><a class="dfeed__row" href="' + meta.href(e) + '">' +
            '<span class="dfeed__icon dfeed__icon--' + esc(e.kind.split(".")[0]) + '">' +
              KT.icon(meta.icon, 15) + "</span>" +
            '<span class="dfeed__body">' +
              "<strong>" + esc(e.title) + "</strong>" +
              '<span class="dfeed__detail">' +
                (e.who ? esc(e.who) + " · " : "") +
                esc(e.subject && e.kind.indexOf("order") === 0 ? e.subject : (e.meta || "")) +
              "</span>" +
            "</span>" +
            '<time class="dfeed__time">' + esc(clock(e.at)) + "</time>" +
          "</a></li>";
        }).join("") + "</ol>" +
      "</div>"
    );
  }

  /* ---- States ------------------------------------------------------------ */

  function skeleton() {
    return (
      '<div class="astat__grid">' +
        Array(4).join(",").split(",").map(function () {
          return '<div class="astat astat--sk">' + KT.skeleton.lines(2) + "</div>";
        }).join("") +
      "</div>" +
      '<div class="dpanel">' + KT.skeleton.lines(4) + "</div>"
    );
  }

  function errorHTML() {
    return (
      '<div class="dpanel"><div class="dempty">' +
        '<span class="dempty__art dempty__art--bad">' + KT.icon("close", 26) + "</span>" +
        "<h3>Could not load the dashboard</h3>" +
        "<p>" + esc(state.error) + "</p>" +
        '<button class="btn btn--soft" type="button" data-dash-retry>Try again</button>' +
      "</div></div>"
    );
  }

  /* ---- Paint ------------------------------------------------------------- */

  function headHTML(ctx) {
    var first = String((ctx && ctx.name) || "").split(" ")[0] || "there";
    var d = state.data;
    return (
      '<header class="apage__head dhead">' +
        "<div><h1>Welcome back, " + esc(first) + "</h1>" +
          '<p class="apage__lede">Today in the kitchen, at a glance. ' +
          "Every tile opens the screen that owns it.</p></div>" +
        '<div class="dhead__right">' +
          (state.live
            ? '<span class="dlive" title="Updating in real time">' +
              '<span class="dlive__dot"></span>Live</span>'
            : "") +
          '<button class="btn btn--ghost btn--sm" type="button" data-dash-refresh>Refresh</button>' +
        "</div>" +
      "</header>" +
      (d && d.generated_at
        ? '<p class="dstamp">Updated ' + esc(clock(d.generated_at)) + "</p>"
        : "")
    );
  }

  function paint(ctx) {
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    var body;
    if (state.error) body = errorHTML();
    else if (state.loading && !state.data) body = skeleton();
    else {
      var d = state.data || {};
      body =
        ordersSection(d) + scoopsSection(state.scoops) +
        supportSection(d) + operationsSection(d) +
        '<div class="dsplit">' + recentOrders(d) + activityPanel(d) + "</div>";
    }
    KT.mount(host, headHTML(ctx) + body);
  }

  /* ---- Data -------------------------------------------------------------- */

  var ctxRef = {};

  async function load(opts) {
    opts = opts || {};
    if (!opts.quiet) { state.loading = true; state.error = null; paint(ctxRef); }
    try {
      if (!svc) svc = (await import("../services/admin-dashboard.js")).adminDashboardService;
      /* In parallel: the scoop report is a separate RPC so the future
         end-of-day report can ask it for any past day, but the dashboard has
         no reason to wait for one before starting the other. A scoop failure
         must not blank the rest of the screen, so it settles on its own. */
      var both = await Promise.all([
        svc.load(),
        svc.scoops().catch(function () { return null; })
      ]);
      state.data = both[0];
      state.scoops = both[1];
      state.error = null;
    } catch (error) {
      /* A refresh that fails must not blank a dashboard that is already on
         screen — the last good numbers stay, and the error is only fatal on
         the first load. */
      if (!state.data) {
        state.error = (KT.services && KT.services.errorMessage)
          ? KT.services.errorMessage(error) : String(error.message || error);
      }
    }
    state.loading = false;
    paint(ctxRef);
  }

  /** Realtime bursts are common (an order insert fires several rows). */
  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(function () { load({ quiet: true }); }, 600);
  }

  async function startWatch() {
    if (stop) return;
    if (!svc) svc = (await import("../services/admin-dashboard.js")).adminDashboardService;
    stop = svc.watch(scheduleRefresh);
    state.live = true;
    paint(ctxRef);
  }

  function stopWatch() {
    if (stop) { stop(); stop = null; }
    window.clearTimeout(refreshTimer);
    state.live = false;
  }

  /* ---- Wiring ------------------------------------------------------------ */

  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-dash-retry]")) { e.preventDefault(); load(); return; }
    if (e.target.closest("[data-dash-refresh]")) { e.preventDefault(); load(); }
  });

  KT.admin.views.dashboard = function (ctx) {
    ctxRef = ctx || {};
    state = { loading: true, error: null, data: null, scoops: null, live: false };
    window.setTimeout(function () { load().then(startWatch); }, 0);
    return headHTML(ctxRef) + skeleton();
  };

  /* The shell calls this on the way out — and, since Phase 12, also when the
     dashboard is re-entered, so repeated navigation cannot stack channels. */
  KT.admin.views.dashboardTeardown = function () {
    stopWatch();
    state.data = null;
  };
})(window.KT || (window.KT = {}));
