/* ==========================================================================
   Kandy's Treats — Orders command centre
   --------------------------------------------------------------------------
   Rendering and interaction only. Every query, mutation and subscription lives
   in js/services/admin-orders.js, which is dynamically imported so the
   storefront never loads it.

   WHY A BOARD AND NOT A LIST
   --------------------------
   A kitchen does not read orders in date order; it works a queue per state.
   The default view is therefore five counted sections — New, Preparing, Out,
   Completed, Cancelled — each fetched and paged on its own, so a hundred
   finished orders can never push a new one off the screen. Picking a single
   status opens that queue full-height with its own pagination.

   Role-awareness here is presentation: a staff member is shown no Cancel
   button because it would fail, not to make it safe. enforce_order_status_tier()
   refuses the move regardless of what this file renders, and it is the only
   thing that decides.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var svc = null;                  /* resolved service module */
  var unwatch = null;              /* realtime unsubscribe */
  var searchTimer = null;
  var tickTimer = null;            /* re-renders relative timestamps */

  /*
     WHY THERE ARE TWO COUNTERS

     The view mounts synchronously and does everything real behind an await —
     a dynamic import, then a network round trip. The admin shell tears a view
     down and mounts the next one into the SAME host element, so anything
     still in flight when that happens is holding a reference to a screen the
     handler has already left. Two distinct races follow, and each needs its
     own counter:

       mountGen  bumped on every mount AND every teardown. Anything captured
                 before a teardown compares unequal afterwards, which is what
                 stops a late load() from painting the Orders board over
                 Finance, and stops a late startWatch() from opening a channel
                 nothing will ever close.

       loadSeq   bumped per load() call. Two loads are routinely in flight —
                 realtime fires one on every order change while a chip click
                 starts another — and board() (five counted queries) is
                 reliably slower than section() (one). Without this, the slow
                 board response lands last and overwrites state.sections while
                 state.status says a single status, so singleHTML() renders
                 sections[0] — the New queue — under an "Out for delivery"
                 chip.
  */
  var mountGen = 0;
  var viewGen = -1;                /* the generation render() is painting for */
  var loadSeq = 0;

  var state = {
    sections: [],                  /* [{status, rows, total, hasMore}] */
    loading: true, error: null, refreshing: false,
    status: "all", payment: "all", fulfilment: "all", range: "all", search: "",
    page: 0,                       /* single-status mode only */
    open: null, detail: null, detailLoading: false,
    confirm: null,                 /* {code, status} — cancellation */
    cancelling: false,
    live: false
  };
  var ctx = { role: "staff" };

  /* Orders seen arriving while this screen was open. Purely a highlight: the
     database has no "acknowledged" concept and §8 says not to invent one. */
  var justIn = Object.create(null);

  /* Phase 12 adds the two provider chips to this row rather than opening a
     fourth one: on a phone the filter block is already three rows deep, and
     "how it was paid" is the same question as "whether it was paid" from the
     handler's side. Both new values filter on orders.payment_provider, which
     is written server-side only. */
  var PAY_TABS = [["all", "Any payment"], ["paid", "Paid"], ["unpaid", "Unpaid"],
                  ["wallet", "Wallet"], ["paystack", "Paystack"]];
  var TYPE_TABS = [["all", "Any type"], ["delivery", "Delivery"], ["pickup", "Pickup"]];
  var RANGE_TABS = [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["all", "All time"]];

  function canSeeEmail() { return KT.admin.rank(ctx.role) >= KT.admin.rank("admin"); }
  function canCancel()  { return KT.admin.rank(ctx.role) >= KT.admin.rank("supervisor"); }

  function money(n) { return KT.naira(n); }
  function statusClass(s) { return "is-" + String(s || "").toLowerCase(); }
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---- Time ------------------------------------------------------------
     Everything is shown in Africa/Lagos, whatever clock the handler's device
     is set to. A rider in the kitchen and a manager on holiday must read the
     same "10:42", and the dashboard's "today" already means Lagos midnight
     (kt_today_start()), so anything else here would disagree with the tile
     that was just clicked. */

  var LAGOS = { timeZone: "Africa/Lagos" };

  function clock(d) {
    return d.toLocaleTimeString("en-NG", Object.assign({
      hour: "2-digit", minute: "2-digit", hour12: false }, LAGOS));
  }
  function dayLabel(d) {
    return d.toLocaleDateString("en-NG", Object.assign({
      day: "2-digit", month: "short" }, LAGOS));
  }
  /** Lagos calendar day as a comparable string, so "today" needs no maths. */
  function lagosDay(d) {
    return d.toLocaleDateString("en-CA", LAGOS);   /* YYYY-MM-DD */
  }

  function when(d) {
    if (!d) return "—";
    var secs = Math.round((Date.now() - d.getTime()) / 1000);
    if (secs < 45) return "Just now";
    if (secs < 3600) return Math.max(1, Math.round(secs / 60)) + " min ago";
    if (lagosDay(d) === lagosDay(new Date())) return clock(d);
    return dayLabel(d) + " · " + clock(d);
  }
  /** Unambiguous form, for places where a relative age would be unhelpful. */
  function stamp(d) { return d ? dayLabel(d) + " · " + clock(d) : "—"; }

  /* ---- Chrome ---------------------------------------------------------- */

  function chipRow(rows, attr, current) {
    return '<div class="ochips">' + rows.map(function (t) {
      return '<button class="chip' + (current === t[0] ? " is-active" : "") +
        '" type="button" ' + attr + '="' + t[0] + '" aria-pressed="' +
        (current === t[0] ? "true" : "false") + '">' + t[1] + "</button>";
    }).join("") + "</div>";
  }

  function filtersHTML() {
    var statusTabs = [["all", "Board"]].concat(
      (svc ? svc.SECTIONS : []).map(function (s) { return [s.status, s.title]; }));
    return (
      '<div class="ofilters">' +
        chipRow(statusTabs, "data-ostatus", state.status) +
        '<div class="ofilters__row">' +
          chipRow(PAY_TABS, "data-opay", state.payment) +
          chipRow(TYPE_TABS, "data-otype", state.fulfilment) +
          chipRow(RANGE_TABS, "data-orange", state.range) +
        "</div>" +
        '<div class="osearch">' +
          '<span class="osearch__icon">' + KT.icon("search", 17) + "</span>" +
          '<input class="input" type="search" data-osearch placeholder="' +
            (canSeeEmail() ? "Order code, name, email or phone" : "Order code, name or phone") +
            '" value="' + esc(state.search) + '" aria-label="Search orders">' +
        "</div>" +
      "</div>"
    );
  }

  function activeFilters() {
    return state.payment !== "all" || state.fulfilment !== "all" ||
           state.range !== "all" || !!state.search;
  }

  function headHTML() {
    var live = state.sections.filter(function (s) {
      return s.status === "New" || s.status === "Preparing" || s.status === "Out";
    }).reduce(function (n, s) { return n + s.total; }, 0);
    return (
      '<header class="apage__head opage__head">' +
        "<div><h1>Orders</h1>" +
          '<p class="apage__lede">' +
            (state.live
              ? '<span class="olive"><span class="olive__dot"></span>Live</span>'
              : "Reconnecting to live updates…") +
            (state.loading ? "" : ' — <strong>' + live + "</strong> order" +
              (live === 1 ? "" : "s") + " still on the floor.") +
          "</p></div>" +
        '<button class="btn btn--soft btn--sm" type="button" data-orefresh' +
          (state.refreshing ? " disabled" : "") + ">" +
          (state.refreshing ? KT.spinner(15) + "<span>Refreshing…</span>" : "Refresh") +
        "</button>" +
      "</header>"
    );
  }

  /* ---- Card ------------------------------------------------------------ */

  function routeHTML(o) {
    if (o.fulfilment === "pickup") {
      return '<span class="ocard__route"><span class="otag otag--pickup">Pickup</span>' +
        "<span>Collecting in person</span></span>";
    }
    var to = o.deliverTo || o.customerName;
    return '<span class="ocard__route"><span class="otag">Delivery</span>' +
      "<span>" + (esc(o.deliverAddress) || "<em>no address on file</em>") +
      (to ? " · " + esc(to) : "") + "</span></span>";
  }

  /*
     Phase 12: the list said "Paid" and stopped there, so telling a wallet
     order from a gateway order meant opening each one. orders.payment_provider
     already carries the answer and is written server-side only — by
     settle_wallet_funding and settle_order_payment — so this is a display
     change over data that already exists. No new column, no new query, and
     nothing here can alter how an order was actually paid.
  */
  function providerLabel(p) {
    if (p === "wallet") return "Wallet";
    if (p === "paystack") return "Paystack";
    return p ? String(p) : "";
  }

  function payBadgeHTML(o) {
    var cls = "obadge obadge--pay " + (o.paid ? "is-paid" : "is-unpaid");
    if (!o.paid) {
      return '<span class="' + cls + '">' + esc(o.paymentStatus || "unpaid") + "</span>";
    }
    var prov = providerLabel(o.paymentProvider);
    return '<span class="' + cls + (prov ? " has-prov" : "") + '">Paid' +
      (prov ? '<span class="obadge__prov">' + esc(prov) + "</span>" : "") +
      "</span>";
  }

  function rowHTML(o) {
    var fresh = justIn[o.code];
    return (
      '<article class="ocard' + (fresh ? " is-justin" : "") +
        '" data-oopen="' + esc(o.code) + '" tabindex="0" role="button" ' +
        'aria-label="Open order ' + esc(o.code) + '">' +
        '<div class="ocard__main">' +
          '<div class="ocard__top">' +
            '<strong class="ocard__code">' + esc(o.code) + "</strong>" +
            (fresh ? '<span class="obadge obadge--just">Just in</span>' : "") +
            '<span class="obadge ' + statusClass(o.status) + '">' + esc(o.status) + "</span>" +
            payBadgeHTML(o) +
          "</div>" +
          '<p class="ocard__who">' + (esc(o.customerName) || "<em>No name</em>") +
            (o.customerPhone ? ' <span class="ocard__sep">·</span> ' + esc(o.customerPhone) : "") +
          "</p>" +
          '<p class="ocard__meta">' +
            routeHTML(o) +
            '<span class="ocard__sep">·</span>' +
            "<span>" + o.itemCount + " item" + (o.itemCount === 1 ? "" : "s") + "</span>" +
            '<span class="ocard__sep">·</span>' +
            "<time datetime=\"" + (o.createdAt ? o.createdAt.toISOString() : "") + "\" " +
              'title="' + esc(stamp(o.createdAt)) + '">' + when(o.createdAt) + "</time>" +
          "</p>" +
        "</div>" +
        '<div class="ocard__right">' +
          '<span class="ocard__total">' + money(o.total) + "</span>" +
          '<span class="ocard__chev">' + KT.icon("chevronRight", 18) + "</span>" +
        "</div>" +
      "</article>"
    );
  }

  /* ---- Sections -------------------------------------------------------- */

  function sectionMeta(status) {
    var all = svc ? svc.SECTIONS : [];
    for (var i = 0; i < all.length; i++) if (all[i].status === status) return all[i];
    return { status: status, title: status, hint: "", active: false };
  }

  function emptySectionHTML(meta) {
    var msg = activeFilters()
      ? "Nothing here matches those filters."
      : (meta.active
          ? "Nothing waiting in " + meta.title.toLowerCase() + "."
          : "No " + meta.title.toLowerCase() + " orders yet.");
    return '<p class="osection__empty">' + msg + "</p>";
  }

  function sectionHTML(sec) {
    var meta = sectionMeta(sec.status);
    var shown = sec.rows.length;
    return (
      '<section class="osection osection--' + sec.status.toLowerCase() + '">' +
        '<header class="osection__head">' +
          "<h2>" + esc(meta.title) +
            '<span class="osection__count">' + sec.total + "</span></h2>" +
          '<span class="osection__hint">' + esc(meta.hint) + "</span>" +
          (sec.total > shown
            ? '<button class="osection__more" type="button" data-ostatus="' + sec.status +
              '">View all ' + sec.total + "</button>"
            : "") +
        "</header>" +
        (shown
          ? '<div class="olist">' + sec.rows.map(rowHTML).join("") + "</div>"
          : emptySectionHTML(meta)) +
      "</section>"
    );
  }

  function boardHTML() {
    return '<div class="oboard">' + state.sections.map(sectionHTML).join("") + "</div>";
  }

  function singleHTML() {
    var sec = state.sections[0];
    if (!sec) return "";
    var meta = sectionMeta(sec.status);
    if (!sec.rows.length) {
      return '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("receipt", 32) + "</div>" +
        (activeFilters()
          ? "<h3>No orders match those filters</h3><p>Try a different payment state, " +
            "order type, period or search term.</p>" +
            '<button class="btn btn--soft" type="button" data-oclear>Clear filters</button>'
          : "<h3>Nothing in " + esc(meta.title) + "</h3><p>Orders appear here as soon as " +
            "they reach this stage.</p>") +
        "</div></div>";
    }
    return (
      '<section class="osection osection--solo osection--' + sec.status.toLowerCase() + '">' +
        '<header class="osection__head"><h2>' + esc(meta.title) +
          '<span class="osection__count">' + sec.total + "</span></h2>" +
          '<span class="osection__hint">' + esc(meta.hint) + "</span></header>" +
        '<div class="olist">' + sec.rows.map(rowHTML).join("") + "</div>" +
        (sec.hasMore
          ? '<div class="omore"><button class="btn btn--soft" type="button" data-omore' +
            (state.refreshing ? " disabled" : "") + ">" +
            (state.refreshing ? KT.spinner(15) + "<span>Loading…</span>"
                              : "Load more (" + (sec.total - sec.rows.length) + " left)") +
            "</button></div>"
          : "") +
      "</section>"
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
    var any = state.sections.some(function (s) { return s.total > 0; });
    if (!any && state.status === "all") {
      /*
         An empty board says two very different things depending on the
         filters. Without them it is good news. With them — say the Today
         range on a quiet morning — it is five zeros and no way back, because
         the Clear filters button only ever lived in the single-status empty
         state. A handler who cannot see why the screen is empty cannot fix
         it, so the reason and the escape hatch are stated here.
      */
      if (activeFilters()) {
        return '<div class="panel apanel"><div class="empty">' +
          '<div class="empty__art">' + KT.icon("search", 32) + "</div>" +
          "<h3>No orders match those filters</h3>" +
          "<p>Nothing in any queue matches the payment state, order type, " +
          "period or search term you have set.</p>" +
          '<button class="btn btn--soft" type="button" data-oclear>Clear filters</button>' +
          "</div></div>";
      }
      return '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("receipt", 32) + "</div>" +
        "<h3>No orders yet</h3><p>New orders appear here the moment a customer " +
        "checks out — you will hear about them too.</p></div></div>";
    }
    return state.status === "all" ? boardHTML() : singleHTML();
  }

  /* ---- Detail ---------------------------------------------------------- */

  function actionsHTML(o) {
    var moves = svc ? svc.nextStatuses(o.status) : [];
    var buttons = moves.filter(function (m) {
      /* Cancelling is supervisor+ since Phase 11 — enforce_order_status_tier()
         moved from is_manager() to is_supervisor(). Everything else is staff+.
         Mirrors the trigger; the trigger is what actually decides. */
      return m !== "Cancelled" || canCancel();
    }).map(function (m) {
      var danger = m === "Cancelled";
      return '<button class="btn ' + (danger ? "btn--ghost odanger" : "btn--primary") +
        ' btn--sm" type="button" data-oset="' + m + '">' +
        (danger ? "Cancel order" : "Mark " + (m === "Out" ? "out for delivery" : m.toLowerCase())) +
        "</button>";
    }).join("");

    if (!buttons) {
      return '<p class="odetail__note">' +
        (o.status === "Completed" || o.status === "Cancelled"
          ? "This order is finished — its status can no longer change."
          : "Your role cannot change this order's status.") + "</p>";
    }
    return '<div class="odetail__actions">' + buttons + "</div>";
  }

  /** A person's name, falling back to their role when they have not set one.
      Several real accounts have a blank display_name, so this fallback is the
      common case rather than a corner one — "Owner" reads as a person's
      standing in the kitchen, where "a owner" reads as a bug. */
  function actorLabel(h) {
    if (!h || !h.actorId) return "system";
    if (h.actorName) return h.actorName;
    if (!h.actorRole) return "A handler";
    return h.actorRole.charAt(0).toUpperCase() + h.actorRole.slice(1);
  }

  /*
     WHO IS RESPONSIBLE vs WHO LAST ACTED — deliberately two lines.

     There is no assigned_to column and this phase did not add one: with a
     two-person kitchen, eight of nine real orders were carried end to end by
     the same person, so allocation is not the workflow. "Picked up by" is
     derived from the first move away from New, which is what taking an order
     on actually looks like in the data.

     The second line only appears when somebody else acted later — that is
     the case worth pointing at, and printing it always would just repeat the
     first line on nearly every order.
  */
  function responsibilityHTML(o) {
    if (!o.pickedUpBy && !o.lastActionBy) {
      return '<section class="odetail__sec"><h3>Responsibility</h3>' +
        '<p class="odetail__note">Nobody has picked this order up yet.</p></section>';
    }
    var picked = o.pickedUpBy;
    var last = o.lastActionBy;
    var handedOn = picked && last && last.actorId !== picked.actorId;
    return (
      '<section class="odetail__sec"><h3>Responsibility</h3>' +
        '<dl class="osum osum--readonly oresp">' +
          '<div class="osum__row"><dt>Picked up by</dt><dd>' +
            (picked
              ? esc(actorLabel(picked)) +
                ' <span class="oresp__when">' + esc(stamp(picked.at)) + "</span>"
              : "<em>not picked up yet</em>") +
          "</dd></div>" +
          (handedOn
            ? '<div class="osum__row"><dt>Last action by</dt><dd>' +
              esc(actorLabel(last)) +
              ' <span class="oresp__when">' + esc(stamp(last.at)) + "</span></dd></div>"
            : "") +
        "</dl>" +
        (handedOn
          ? '<p class="odetail__muted">' + o.handlerCount +
            " people have worked on this order.</p>"
          : "") +
      "</section>"
    );
  }

  function deliveryHTML(o) {
    if (o.fulfilment === "pickup") {
      return '<section class="odetail__sec"><h3>Collection</h3>' +
        "<p>The customer is collecting this order in person.</p>" +
        '<p class="odetail__muted">No delivery address applies.</p></section>';
    }
    var a = o.addressSnapshot || {};
    return (
      '<section class="odetail__sec"><h3>Delivery</h3>' +
        '<dl class="osum osum--readonly">' +
          '<div class="osum__row"><dt>Recipient</dt><dd>' +
            (esc(a.recipientName) || esc(o.customerName) || "<em>not given</em>") + "</dd></div>" +
          '<div class="osum__row"><dt>Phone</dt><dd>' +
            (esc(a.phone) || esc(o.customerPhone) || "<em>not given</em>") + "</dd></div>" +
          '<div class="osum__row"><dt>Address</dt><dd>' +
            (esc(a.address) || "<em>no address on file</em>") + "</dd></div>" +
        "</dl>" +
        /* The rider note is customer-written and lives in the address
           snapshot. Shown, never edited from here — §14. */
        (a.notes
          ? '<p class="odetail__note odetail__note--rider">' +
            '<strong>Rider note:</strong> ' + esc(a.notes) + "</p>"
          : "") +
        (o.estimatedMinutes
          ? '<p class="odetail__muted">Quoted ' + o.estimatedMinutes + " minutes at checkout.</p>"
          : "") +
      "</section>"
    );
  }

  function contextHTML(o) {
    if (!o.customerOrderCount) return "";
    var n = o.customerOrderCount;
    var recent = (o.customerRecent || []).map(function (r) {
      return '<li><button class="octx__link" type="button" data-oopen="' + esc(r.code) + '">' +
        esc(r.code) + "</button>" +
        '<span class="obadge ' + statusClass(r.status) + '">' + esc(r.status) + "</span>" +
        "<span>" + money(r.total) + "</span>" +
        "<time>" + esc(stamp(r.at)) + "</time></li>";
    }).join("");
    return (
      '<section class="odetail__sec"><h3>Customer history</h3>' +
        "<p>" + (n === 1
          ? "This is their <strong>first order</strong>."
          : "<strong>" + n + "</strong> orders in total, including this one.") + "</p>" +
        (recent ? '<ul class="octx">' + recent + "</ul>" : "") +
      "</section>"
    );
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

    function lineHTML(l) {
      return '<div class="oline"><span class="oline__qty">' + l.qty + "×</span>" +
        '<span class="oline__name">' + esc(l.name) + "</span>" +
        '<span class="oline__price">' + money(l.lineTotal) + "</span></div>";
    }

    /*
       Grouped orders print pack by pack so the kitchen can bag straight off
       the screen. An order with no packs — every order placed before Phase
       12, and every ungrouped one since — takes the untouched flat path
       below, with no heading and no visual change whatsoever.
    */
    var items = o.items || [];
    var packs = [];
    items.forEach(function (l) {
      var g = l.takeawayGroup == null ? null : l.takeawayGroup;
      var bucket = packs.filter(function (p) { return p.group === g; })[0];
      if (!bucket) { bucket = { group: g, lines: [] }; packs.push(bucket); }
      bucket.lines.push(l);
    });
    var grouped = packs.some(function (p) { return p.group != null; });

    var lines;
    if (!items.length) {
      lines = '<p class="odetail__note">No line items recorded.</p>';
    } else if (!grouped) {
      lines = items.map(lineHTML).join("");
    } else {
      lines = packs.map(function (p) {
        return '<div class="opack">' +
          '<p class="opack__head">' +
            (p.group == null ? "Not in a pack" : "Takeaway " + p.group) +
            '<span class="opack__count">' +
              p.lines.reduce(function (n, l) { return n + (Number(l.qty) || 0); }, 0) +
              " item" +
              (p.lines.reduce(function (n, l) { return n + (Number(l.qty) || 0); }, 0) === 1
                ? "" : "s") +
            "</span></p>" +
          p.lines.map(lineHTML).join("") +
        "</div>";
      }).join("");
    }

    /* The note the trigger writes names the ROLE ("Updated by owner."). Now
       that created_by is read, the person is named instead, and the note is
       kept only when it says something the actor line does not. */
    var hist = (o.history || []).map(function (h) {
      var who = h.actorId
        ? '<span class="ohist__by">' + esc(actorLabel(h)) + "</span>"
        : '<span class="ohist__by ohist__by--sys">system</span>';
      var note = /^Updated by /i.test(h.note) ? "" :
        '<span class="ohist__note">' + esc(h.note) + "</span>";
      return '<li><span class="obadge ' + statusClass(h.status) + '">' + esc(h.status) + "</span>" +
        who + note + "<time>" + esc(stamp(h.at)) + "</time></li>";
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
            payBadgeHTML(o) +
            '<span class="otag' + (o.fulfilment === "pickup" ? " otag--pickup" : "") + '">' +
              (o.fulfilment === "pickup" ? "Pickup" : "Delivery") + "</span>" +
          "</div>" +
          '<p class="odetail__muted">Placed ' + esc(stamp(o.createdAt)) +
            " · " + o.itemCount + " item" + (o.itemCount === 1 ? "" : "s") +
            " on " + o.lineCount + " line" + (o.lineCount === 1 ? "" : "s") + "</p>" +
          actionsHTML(o) +
        "</section>" +

        responsibilityHTML(o) +

        '<section class="odetail__sec"><h3>Customer</h3>' +
          "<p>" + (esc(o.customerName) || "<em>No name</em>") + "</p>" +
          '<p class="odetail__muted">' + (esc(o.customerPhone) || "no phone") +
            (canSeeEmail()
              ? " · " + (esc(o.customerEmail) || "no email")
              : ' · <span class="odetail__hidden">email hidden at your access level</span>') +
          "</p>" +
          (o.notes ? '<p class="odetail__note">Order note: ' + esc(o.notes) + "</p>" : "") +
        "</section>" +

        deliveryHTML(o) +

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
            row("Reference", "<code>" + esc(o.paymentRef || "—") + "</code>") +
          "</dl>" +
          '<p class="odetail__note">Payment details are set by the settlement system ' +
            "and cannot be edited from here by any role.</p>" +
        "</section>" +

        contextHTML(o) +

        '<section class="odetail__sec"><h3>History</h3><ol class="ohist">' + hist + "</ol>" +
          '<p class="odetail__muted">Created ' + esc(stamp(o.createdAt)) +
          " · updated " + esc(stamp(o.updatedAt)) + "</p>" +
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
            '<button class="icon-btn" type="button" data-oclose aria-label="Close order detail">' +
              KT.icon("close", 20) + "</button>" +
          "</header>" +
          detailHTML() +
        "</aside>" +
      "</div>"
    );
  }

  /* ---- Cancellation confirmation --------------------------------------- */

  /*
     §22. Cancelling is terminal — enforce_order_status_tier() makes Cancelled
     a final state, so there is no undo behind this button. It says which order
     and what will happen; it does not touch payment, because nothing in this
     module can.
  */
  function confirmHTML() {
    var c = state.confirm;
    if (!c) return "";
    return (
      '<div class="mconfirm" data-oconfirm>' +
        '<div class="mconfirm__scrim" data-ocancelno></div>' +
        '<div class="mconfirm__box" role="alertdialog" aria-modal="true" ' +
          'aria-label="Confirm cancelling order ' + esc(c.code) + '">' +
          '<span class="mconfirm__mark">' + KT.icon("close", 26) + "</span>" +
          "<h3>Cancel order " + esc(c.code) + "?</h3>" +
          "<p>This moves the order to <strong>Cancelled</strong> and tells " +
            esc(c.customerName || "the customer") + " straight away. " +
            "Cancelled is final — the order cannot be reopened or advanced afterwards.</p>" +
          (c.paid
            ? "<p class=\"mconfirm__warn\">This order is marked <strong>paid</strong>. " +
              "Cancelling does not refund anything: money is settled elsewhere and " +
              "no role can move it from here.</p>"
            : "") +
          '<div class="mconfirm__actions">' +
            '<button class="btn btn--ghost" type="button" data-ocancelno>Keep the order</button>' +
            '<button class="btn btn--primary odanger-solid" type="button" data-ocancelyes>' +
              (state.cancelling ? KT.spinner(15) + "<span>Cancelling…</span>" : "Cancel this order") +
            "</button>" +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }

  /* ---- Render ---------------------------------------------------------- */

  function render() {
    /* The host still exists after a teardown — it belongs to the next view
       now. Painting into it is how a stale await redecorates someone else's
       screen. */
    if (viewGen !== mountGen) return;
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    var focused = document.activeElement &&
      document.activeElement.hasAttribute &&
      document.activeElement.hasAttribute("data-osearch");
    var caret = focused ? document.activeElement.selectionStart : null;

    KT.mount(host, headHTML() + filtersHTML() + listHTML() + panelHTML() + confirmHTML());

    if (focused) {
      var input = KT.qs("[data-osearch]");
      if (input) { input.focus(); try { input.setSelectionRange(caret, caret); } catch (e) {} }
    }
  }

  /* ---- Data ------------------------------------------------------------ */

  function filters() {
    return {
      payment: state.payment, fulfilment: state.fulfilment,
      range: state.range, search: state.search, canSeeEmail: canSeeEmail()
    };
  }

  /**
   * Resolve the service module, and be willing to try again.
   *
   * The import used to happen once at mount. If it failed — an offline
   * moment, a redeploy that invalidated the chunk — svc stayed null and the
   * error panel's "Try again" went straight into svc.adminOrderService, so
   * the handler's second press replaced a sentence they could act on with
   * "Cannot read properties of null". Living here means every retry path
   * re-attempts the import for free.
   */
  async function ensureSvc() {
    if (svc) return true;
    try {
      svc = await import("../services/admin-orders.js");
      return true;
    } catch (error) {
      svc = null;
      return false;
    }
  }

  async function load(opts) {
    opts = opts || {};
    var seq = ++loadSeq;
    var gen = mountGen;
    /* Still the newest request, and still the mounted view. */
    var current = function () { return seq === loadSeq && gen === mountGen; };

    if (opts.refresh) state.refreshing = true; else state.loading = true;
    state.error = null;
    render();

    if (!(await ensureSvc())) {
      if (!current()) return;
      state.loading = false; state.refreshing = false;
      state.error = "Could not load the orders module.";
      render();
      return;
    }

    /* Captured with the request: state.status can change under a slow
       response, and a board result must never be read as a single section. */
    var wantBoard = state.status === "all";
    try {
      var next;
      if (wantBoard) {
        next = await svc.adminOrderService.board(filters());
      } else {
        next = [await svc.adminOrderService.section(state.status,
          Object.assign(filters(), {
            limit: svc.PAGE_SIZE * (state.page + 1), offset: 0
          }))];
      }
      if (!current()) return;
      state.sections = next;
    } catch (error) {
      if (!current()) return;
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : (error.message || "Unknown error");
      state.sections = [];
    } finally {
      if (current()) {
        state.loading = false; state.refreshing = false;
        render();
      }
    }
  }

  async function openDetail(code) {
    if (!svc) return;
    var gen = mountGen;
    state.open = code; state.detail = null; state.detailLoading = true;
    /* Opening it is the acknowledgement — the highlight has done its job. */
    delete justIn[code];
    render();
    try {
      var detail = await svc.adminOrderService.get(code, { canSeeEmail: canSeeEmail() });
      /* state.open moves when a handler clicks a second order, or a customer
         history link, before the first fetch lands. */
      if (gen !== mountGen || state.open !== code) return;
      state.detail = detail;
    } catch (error) {
      if (gen !== mountGen || state.open !== code) return;
      state.detail = null;
      KT.toast(KT.services.errorMessage(error), "error", { duration: 5000 });
    } finally {
      if (gen === mountGen && state.open === code) {
        state.detailLoading = false; render();
      }
    }
  }

  async function setStatus(code, next, btn) {
    if (!svc) return;
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

  async function doCancel() {
    var c = state.confirm;
    if (!c || state.cancelling || !svc) return;
    state.cancelling = true; render();
    try {
      /* The same single mutation path every other move uses — §22 says reuse
         the existing mechanism, and there is exactly one. */
      await svc.adminOrderService.setStatus(c.code, "Cancelled");
      state.confirm = null;
      KT.toast("Order " + c.code + " cancelled.", "success");
      if (state.open === c.code) await openDetail(c.code);
      load({ refresh: true });
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    } finally {
      state.cancelling = false; render();
    }
  }

  /* ---- Realtime -------------------------------------------------------- */

  function startWatch() {
    if (unwatch || !svc) return;
    var gen = mountGen;
    unwatch = svc.adminOrderService.watch(
      function (payload) {
        /* A brand-new order gets a highlight so a handler can tell what
           landed while they were looking at the screen. Status changes do not
           — those are usually their own doing. */
        if (gen !== mountGen) return;
        if (payload && payload.eventType === "INSERT" && payload.new && payload.new.code) {
          justIn[payload.new.code] = true;
        }
        load({ refresh: true });
        if (state.open) openDetail(state.open);
      },
      function (status) {
        if (gen !== mountGen) return;
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
       absent parameter resets to the board, so arriving from the sidebar
       always shows the whole floor. */
    var qp = KT.admin.routeParams();
    var known = ["New", "Preparing", "Out", "Completed", "Cancelled"];
    state.status = known.indexOf(qp.status) >= 0 ? qp.status : "all";
    state.payment = (qp.payment === "paid" || qp.payment === "unpaid") ? qp.payment : "all";
    state.fulfilment = (qp.fulfilment === "delivery" || qp.fulfilment === "pickup")
      ? qp.fulfilment : "all";
    state.range = ["today", "7d", "30d", "all"].indexOf(qp.range) >= 0 ? qp.range : "all";
    state.page = 0;
    var wanted = qp.code || null;

    /* This mount owns the screen from here until something tears it down. */
    var gen = ++mountGen;
    viewGen = gen;

    /* Returned synchronously so the router can mount immediately; the real
       content replaces it as soon as the service module resolves. Every
       await below is a place the handler may have navigated away, so each
       one is followed by a check that this mount is still the live one —
       otherwise a slow first load would open a realtime channel and a timer
       that ordersTeardown has already been and gone without releasing. */
    setTimeout(async function () {
      if (gen !== mountGen) return;
      await load();
      if (gen !== mountGen) return;
      if (!svc) return;            /* the import failed; load() said so */
      startWatch();
      startTicking();
      if (wanted) openDetail(wanted);
    }, 0);

    return '<div data-orders-mount>' + KT.loadingLabel("Loading orders…") +
      KT.skeleton.orders(4) + "</div>";
  };

  /* "3 min ago" is a lie thirty seconds later. One timer for the whole
     screen, and only while it is mounted. */
  function startTicking() {
    if (tickTimer) return;
    tickTimer = window.setInterval(function () {
      if (!KT.qs("[data-admin-page] .ocard")) return;
      if (state.loading || state.refreshing) return;
      render();
    }, 30000);
  }
  function stopTicking() {
    if (tickTimer) { window.clearInterval(tickTimer); tickTimer = null; }
  }

  /** The shell calls this when navigating away, so channels never stack. */
  KT.admin.views.ordersTeardown = function () {
    /* Bumped FIRST: it is what makes every in-flight await give up rather
       than paint into the view that replaces this one. */
    mountGen += 1;
    stopWatch();
    stopTicking();
    /* The debounced search is a timer too, and a 280ms one is easily still
       pending when a handler types and immediately clicks away. */
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    state.open = null; state.detail = null; state.confirm = null;
    justIn = Object.create(null);
  };

  /* ---- Events ---------------------------------------------------------- */

  document.addEventListener("click", function (e) {
    var t = e.target;

    var tab = t.closest("[data-ostatus]");
    if (tab) {
      state.status = tab.getAttribute("data-ostatus");
      state.page = 0;
      load(); return;
    }
    var pay = t.closest("[data-opay]");
    if (pay) { state.payment = pay.getAttribute("data-opay"); state.page = 0; load(); return; }

    var type = t.closest("[data-otype]");
    if (type) { state.fulfilment = type.getAttribute("data-otype"); state.page = 0; load(); return; }

    var range = t.closest("[data-orange]");
    if (range) { state.range = range.getAttribute("data-orange"); state.page = 0; load(); return; }

    if (t.closest("[data-omore]")) { state.page += 1; load({ refresh: true }); return; }
    if (t.closest("[data-orefresh]")) { load({ refresh: true }); return; }
    if (t.closest("[data-oretry]"))   { load(); return; }
    if (t.closest("[data-oclear]")) {
      state.payment = "all"; state.fulfilment = "all"; state.range = "all";
      state.search = ""; state.page = 0;
      load(); return;
    }

    if (t.closest("[data-ocancelno]")) { state.confirm = null; render(); return; }
    if (t.closest("[data-ocancelyes]")) { doCancel(); return; }

    if (t.closest("[data-oclose]")) {
      state.open = null; state.detail = null; render(); return;
    }

    var set = t.closest("[data-oset]");
    if (set && state.open) {
      var next = set.getAttribute("data-oset");
      if (next === "Cancelled") {
        var o = state.detail || {};
        state.confirm = { code: state.open, customerName: o.customerName, paid: o.paid };
        render();
      } else {
        setStatus(state.open, next, set);
      }
      return;
    }

    var open = t.closest("[data-oopen]");
    if (open) { openDetail(open.getAttribute("data-oopen")); }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (state.confirm) { state.confirm = null; render(); return; }
      if (state.open) { state.open = null; state.detail = null; render(); return; }
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
    state.page = 0;
    clearTimeout(searchTimer);
    var gen = mountGen;
    searchTimer = setTimeout(function () {
      searchTimer = null;
      if (gen !== mountGen) return;
      load();
    }, 280);
  });
})(window.KT || (window.KT = {}));
