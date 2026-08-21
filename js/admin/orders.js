/* ==========================================================================
   Kandy's Treats — Admin orders module
   --------------------------------------------------------------------------
   Rendering and interaction only. Every query, mutation and subscription lives
   in js/services/admin-orders.js, which is dynamically imported so the
   storefront never loads it.

   Role-awareness here is presentation: a staff member is shown no Cancel
   button because it would fail, not to make it safe. The database refuses the
   move regardless of what this file renders.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var svc = null;                  /* resolved service module */
  var unwatch = null;              /* realtime unsubscribe */
  var state = {
    rows: [], loading: true, error: null, refreshing: false,
    status: "all", payment: "all", search: "",
    open: null, detail: null, detailLoading: false, live: false
  };
  var ctx = { role: "staff" };
  var searchTimer = null;

  var STATUS_TABS = [
    ["all", "All"], ["New", "New"], ["Preparing", "Preparing"],
    ["Out", "Out"], ["Completed", "Completed"], ["Cancelled", "Cancelled"]
  ];
  var PAY_TABS = [["all", "Any payment"], ["paid", "Paid"], ["unpaid", "Unpaid"]];

  function money(n) { return KT.naira(n); }
  function when(d) {
    if (!d) return "—";
    return d.toLocaleString("en-NG", { day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit" });
  }
  function statusClass(s) { return "is-" + String(s || "").toLowerCase(); }
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---- Chrome ---------------------------------------------------------- */

  function filtersHTML() {
    return (
      '<div class="ofilters">' +
        '<div class="ochips">' +
          STATUS_TABS.map(function (t) {
            return '<button class="chip' + (state.status === t[0] ? " is-active" : "") +
              '" type="button" data-ostatus="' + t[0] + '">' + t[1] + "</button>";
          }).join("") +
        "</div>" +
        '<div class="ochips">' +
          PAY_TABS.map(function (t) {
            return '<button class="chip' + (state.payment === t[0] ? " is-active" : "") +
              '" type="button" data-opay="' + t[0] + '">' + t[1] + "</button>";
          }).join("") +
        "</div>" +
        '<div class="osearch">' +
          '<span class="osearch__icon">' + KT.icon("search", 17) + "</span>" +
          '<input class="input" type="search" data-osearch placeholder="Order code, name, email or phone" ' +
            'value="' + esc(state.search) + '" aria-label="Search orders">' +
        "</div>" +
      "</div>"
    );
  }

  function headHTML() {
    return (
      '<header class="apage__head opage__head">' +
        "<div><h1>Orders</h1>" +
          '<p class="apage__lede">' +
            (state.live
              ? '<span class="olive"><span class="olive__dot"></span>Live</span> — updates arrive automatically.'
              : "Reconnecting to live updates…") +
          "</p></div>" +
        '<button class="btn btn--soft btn--sm" type="button" data-orefresh' +
          (state.refreshing ? " disabled" : "") + ">" +
          (state.refreshing ? KT.spinner(15) + "<span>Refreshing…</span>" : "Refresh") +
        "</button>" +
      "</header>"
    );
  }

  /* ---- List ------------------------------------------------------------ */

  function rowHTML(o) {
    return (
      '<article class="ocard" data-oopen="' + esc(o.code) + '" tabindex="0" role="button" ' +
        'aria-label="Open order ' + esc(o.code) + '">' +
        '<div class="ocard__main">' +
          '<div class="ocard__top">' +
            '<strong class="ocard__code">' + esc(o.code) + "</strong>" +
            '<span class="obadge ' + statusClass(o.status) + '">' + esc(o.status) + "</span>" +
            '<span class="obadge obadge--pay ' + (o.paid ? "is-paid" : "is-unpaid") + '">' +
              (o.paid ? "Paid" : esc(o.paymentStatus || "unpaid")) + "</span>" +
          "</div>" +
          '<p class="ocard__who">' + (esc(o.customerName) || "<em>No name</em>") +
            (o.customerPhone ? ' <span class="ocard__sep">·</span> ' + esc(o.customerPhone) : "") +
          "</p>" +
          '<p class="ocard__meta">' +
            '<span class="otag">' + (o.fulfilment === "pickup" ? "Pickup" : "Delivery") + "</span>" +
            "<span>" + when(o.createdAt) + "</span>" +
            '<span class="ocard__sep">·</span><span>updated ' + when(o.updatedAt) + "</span>" +
          "</p>" +
        "</div>" +
        '<div class="ocard__right">' +
          '<span class="ocard__total">' + money(o.total) + "</span>" +
          '<span class="ocard__chev">' + KT.icon("chevronRight", 18) + "</span>" +
        "</div>" +
      "</article>"
    );
  }

  function listHTML() {
    if (state.loading) {
      return '<div class="olist">' + KT.loadingLabel("Loading orders…") +
        KT.skeleton.orders(4) + "</div>";
    }
    if (state.error) {
      return '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("close", 32) + "</div>" +
        "<h3>We could not load orders</h3><p>" + esc(state.error) + "</p>" +
        '<button class="btn btn--primary" type="button" data-oretry>Try again</button>' +
        "</div></div>";
    }
    if (!state.rows.length) {
      var filtered = state.status !== "all" || state.payment !== "all" || state.search;
      return '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("receipt", 32) + "</div>" +
        (filtered
          ? "<h3>No orders match those filters</h3><p>Try a different status, payment state or search term.</p>" +
            '<button class="btn btn--soft" type="button" data-oclear>Clear filters</button>'
          : "<h3>No orders yet</h3><p>New orders appear here the moment a customer checks out.</p>") +
        "</div></div>";
    }
    return '<div class="olist">' + state.rows.map(rowHTML).join("") + "</div>";
  }

  /* ---- Detail ---------------------------------------------------------- */

  function actionsHTML(o) {
    var moves = svc ? svc.nextStatuses(o.status) : [];
    var rank = KT.admin.rank(ctx.role);
    var buttons = moves.filter(function (m) {
      /* Cancelling is supervisor+ since Phase 11 — enforce_order_status_tier()
         moved from is_manager() to is_supervisor(). Everything else is staff+.
         Mirrors the trigger; the trigger is what actually decides. */
      return m !== "Cancelled" || rank >= KT.admin.rank("supervisor");
    }).map(function (m) {
      var danger = m === "Cancelled";
      return '<button class="btn ' + (danger ? "btn--ghost odanger" : "btn--primary") +
        ' btn--sm" type="button" data-oset="' + m + '">' +
        (danger ? "Cancel order" : "Mark " + m) + "</button>";
    }).join("");

    if (!buttons) {
      return '<p class="odetail__note">' +
        (o.status === "Completed" || o.status === "Cancelled"
          ? "This order is finished — its status can no longer change."
          : "Your role cannot change this order's status.") + "</p>";
    }
    return '<div class="odetail__actions">' + buttons + "</div>";
  }

  function detailHTML() {
    if (state.detailLoading) {
      return '<div class="odetail__body">' + KT.skeleton.panel(3) + KT.skeleton.panel(4) + "</div>";
    }
    var o = state.detail;
    if (!o) {
      return '<div class="odetail__body"><div class="empty"><h3>Order not found</h3>' +
        "<p>It may have been removed.</p></div></div>";
    }

    var lines = (o.items || []).map(function (l) {
      return '<div class="oline"><span class="oline__qty">' + l.qty + "×</span>" +
        '<span class="oline__name">' + esc(l.name) + "</span>" +
        '<span class="oline__price">' + money(l.lineTotal) + "</span></div>";
    }).join("") || '<p class="odetail__note">No line items recorded.</p>';

    var hist = (o.history || []).map(function (h) {
      return '<li><span class="obadge ' + statusClass(h.status) + '">' + esc(h.status) + "</span>" +
        '<span class="ohist__note">' + esc(h.note) + "</span>" +
        '<time>' + when(h.at) + "</time></li>";
    }).join("") || "<li><em>No history recorded.</em></li>";

    function row(label, value, strong) {
      return '<div class="osum__row"><dt>' + label + "</dt><dd" +
        (strong ? ' class="is-strong"' : "") + ">" + value + "</dd></div>";
    }

    return (
      '<div class="odetail__body">' +
        '<section class="odetail__sec">' +
          '<div class="odetail__status">' +
            '<span class="obadge ' + statusClass(o.status) + '">' + esc(o.status) + "</span>" +
            '<span class="obadge obadge--pay ' + (o.paid ? "is-paid" : "is-unpaid") + '">' +
              (o.paid ? "Paid" : esc(o.paymentStatus)) + "</span>" +
            '<span class="otag">' + (o.fulfilment === "pickup" ? "Pickup" : "Delivery") + "</span>" +
          "</div>" +
          actionsHTML(o) +
        "</section>" +

        '<section class="odetail__sec"><h3>Customer</h3>' +
          "<p>" + (esc(o.customerName) || "<em>No name</em>") + "</p>" +
          '<p class="odetail__muted">' + (esc(o.customerPhone) || "no phone") + " · " +
            (esc(o.customerEmail) || "no email") + "</p>" +
          (o.addressSnapshot && o.addressSnapshot.address
            ? '<p class="odetail__muted">' + esc(o.addressSnapshot.address) + "</p>" : "") +
          (o.notes ? '<p class="odetail__note">Note: ' + esc(o.notes) + "</p>" : "") +
        "</section>" +

        '<section class="odetail__sec"><h3>Items</h3>' + lines + "</section>" +

        '<section class="odetail__sec"><h3>Totals</h3><dl class="osum">' +
          row("Subtotal", money(o.subtotal)) +
          (o.takeawayFee ? row("Packaging", money(o.takeawayFee)) : "") +
          row(o.fulfilment === "pickup" ? "Pickup" : "Delivery", money(o.deliveryFee)) +
          (o.discount ? row("Discount", "−" + money(o.discount)) : "") +
          (o.processingFee ? row("Processing", money(o.processingFee)) : "") +
          row("Total", money(o.total), true) +
        "</dl></section>" +

        '<section class="odetail__sec"><h3>Payment</h3>' +
          '<dl class="osum osum--readonly">' +
            row("Status", esc(o.paymentStatus)) +
            row("Provider", esc(o.paymentProvider || "—")) +
            row("Reference", '<code>' + esc(o.paymentRef || "—") + "</code>") +
          "</dl>" +
          '<p class="odetail__note">Payment details are set by the settlement system ' +
            "and cannot be edited from here by any role.</p>" +
        "</section>" +

        '<section class="odetail__sec"><h3>History</h3><ol class="ohist">' + hist + "</ol>" +
          '<p class="odetail__muted">Created ' + when(o.createdAt) +
          " · updated " + when(o.updatedAt) + "</p>" +
        "</section>" +
      "</div>"
    );
  }

  function panelHTML() {
    if (!state.open) return "";
    return (
      '<div class="odrawer is-open" data-odrawer>' +
        '<div class="odrawer__scrim" data-oclose></div>' +
        '<aside class="odrawer__panel" role="dialog" aria-modal="true" aria-label="Order detail">' +
          '<header class="odrawer__head">' +
            "<div><strong>" + esc(state.open) + "</strong>" +
            '<span class="odrawer__sub">Order detail</span></div>' +
            '<button class="icon-btn" type="button" data-oclose aria-label="Close">' +
              KT.icon("close", 20) + "</button>" +
          "</header>" +
          detailHTML() +
        "</aside>" +
      "</div>"
    );
  }

  /* ---- Render ---------------------------------------------------------- */

  function render() {
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    var focused = document.activeElement &&
      document.activeElement.hasAttribute &&
      document.activeElement.hasAttribute("data-osearch");
    var caret = focused ? document.activeElement.selectionStart : null;

    KT.mount(host, headHTML() + filtersHTML() + listHTML() + panelHTML());

    if (focused) {
      var input = KT.qs("[data-osearch]");
      if (input) { input.focus(); try { input.setSelectionRange(caret, caret); } catch (e) {} }
    }
  }

  /* ---- Data ------------------------------------------------------------ */

  async function load(opts) {
    opts = opts || {};
    if (opts.refresh) state.refreshing = true; else state.loading = true;
    state.error = null;
    render();
    try {
      state.rows = await svc.adminOrderService.list({
        status: state.status, payment: state.payment, search: state.search
      });
    } catch (error) {
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : (error.message || "Unknown error");
      state.rows = [];
    } finally {
      state.loading = false; state.refreshing = false;
      render();
    }
  }

  async function openDetail(code) {
    state.open = code; state.detail = null; state.detailLoading = true;
    render();
    try {
      state.detail = await svc.adminOrderService.get(code);
    } catch (error) {
      state.detail = null;
      KT.toast(KT.services.errorMessage(error), "error", { duration: 5000 });
    } finally {
      state.detailLoading = false; render();
    }
  }

  async function setStatus(code, next, btn) {
    var done = KT.busy(btn, "Saving…");
    if (!done) return;
    try {
      await svc.adminOrderService.setStatus(code, next);
      KT.toast("Order " + code + " → " + next, "success");
      await openDetail(code);
      load({ refresh: true });
    } catch (error) {
      done();
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    }
  }

  /* ---- Realtime -------------------------------------------------------- */

  function startWatch() {
    if (unwatch) return;
    unwatch = svc.adminOrderService.watch(
      function () {
        /* Any insert/update to orders: refresh the list quietly, and the open
           detail if it is the one that moved. */
        load({ refresh: true });
        if (state.open) openDetail(state.open);
      },
      function (status) {
        var live = status === "SUBSCRIBED";
        if (live !== state.live) { state.live = live; render(); }
      }
    );
  }

  function stopWatch() {
    if (unwatch) { unwatch(); unwatch = null; }
    state.live = false;
  }

  /* ---- Entry point ----------------------------------------------------- */

  KT.admin.views.orders = function (viewCtx) {
    ctx = viewCtx || ctx;

    /* A dashboard tile links here with the filter already chosen, e.g.
       #/orders?status=Preparing. Reading it here means "In the kitchen" opens
       the real Orders screen rather than a second, near-identical view. An
       absent parameter resets the filter, so arriving from the sidebar always
       shows everything. */
    var qp = KT.admin.routeParams();
    state.status = STATUS_TABS.some(function (t) { return t[0] === qp.status; })
      ? qp.status : "all";
    state.payment = (qp.payment === "paid" || qp.payment === "unpaid") ? qp.payment : "all";
    var wanted = qp.code || null;

    /* Returned synchronously so the router can mount immediately; the real
       content replaces it as soon as the service module resolves. */
    setTimeout(async function () {
      if (!svc) {
        try {
          svc = await import("../services/admin-orders.js");
        } catch (error) {
          state.loading = false;
          state.error = "Could not load the orders module.";
          render();
          return;
        }
      }
      await load();
      startWatch();
      if (wanted) openDetail(wanted);
    }, 0);

    return '<div data-orders-mount>' + KT.loadingLabel("Loading orders…") +
      KT.skeleton.orders(4) + "</div>";
  };

  /** The shell calls this when navigating away, so channels never stack. */
  KT.admin.views.ordersTeardown = function () {
    stopWatch();
    state.open = null; state.detail = null;
  };

  /* ---- Events ---------------------------------------------------------- */

  document.addEventListener("click", function (e) {
    var t = e.target;
    var tab = t.closest("[data-ostatus]");
    if (tab) { state.status = tab.getAttribute("data-ostatus"); load(); return; }

    var pay = t.closest("[data-opay]");
    if (pay) { state.payment = pay.getAttribute("data-opay"); load(); return; }

    if (t.closest("[data-orefresh]")) { load({ refresh: true }); return; }
    if (t.closest("[data-oretry]"))   { load(); return; }
    if (t.closest("[data-oclear]")) {
      state.status = "all"; state.payment = "all"; state.search = "";
      load(); return;
    }
    if (t.closest("[data-oclose]")) {
      state.open = null; state.detail = null; render(); return;
    }

    var set = t.closest("[data-oset]");
    if (set && state.open) {
      setStatus(state.open, set.getAttribute("data-oset"), set); return;
    }

    var open = t.closest("[data-oopen]");
    if (open) { openDetail(open.getAttribute("data-oopen")); }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.open) {
      state.open = null; state.detail = null; render();
    }
    var card = e.target.closest && e.target.closest("[data-oopen]");
    if (card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openDetail(card.getAttribute("data-oopen"));
    }
  });

  document.addEventListener("input", function (e) {
    var input = e.target.closest("[data-osearch]");
    if (!input) return;
    state.search = input.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { load(); }, 280);
  });
})(window.KT || (window.KT = {}));
