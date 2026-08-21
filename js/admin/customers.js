/* ==========================================================================
   Kandy's Treats — Admin customers module
   --------------------------------------------------------------------------
   Rendering only; all data access lives in js/services/admin-customers.js.

   The staff/manager difference is NOT a UI decision here. The RPC returns
   null for email, spend and addresses when the caller is staff, so this file
   renders what it was given. Hiding a column would be cosmetic; receiving
   nothing is the actual boundary.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var svc = null, searchTimer = null;
  var ctx = { role: "staff" };
  var state = {
    rows: [], total: 0, tier: "staff", page: 0,
    loading: true, error: null, refreshing: false,
    search: "", status: "all",
    open: null, detail: null, detailLoading: false,
    confirm: null, confirmCheck: null, deleting: false, exporting: false
  };

  function isManager() { return KT.admin.rank(ctx.role) >= KT.admin.rank("admin"); }
  function isOwner()   { return KT.admin.rank(ctx.role) >= KT.admin.rank("owner"); }

  function esc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function when(d) {
    return d ? d.toLocaleDateString("en-NG", { day: "2-digit", month: "short", year: "numeric" }) : "—";
  }
  function statusBadge(s) {
    var cls = s === "active" ? "is-completed" : s === "dormant" ? "is-out" : "is-new";
    var label = s === "new" ? "No orders" : s;
    return '<span class="obadge ' + cls + '">' + esc(label) + "</span>";
  }

  /* ---- Chrome ---------------------------------------------------------- */

  function headHTML() {
    return (
      '<header class="apage__head opage__head">' +
        "<div><h1>Customers</h1>" +
          '<p class="apage__lede">' + state.total + " customer" + (state.total === 1 ? "" : "s") +
            (isManager() ? "" : " — you are seeing the operational view; contact details beyond a phone number are restricted.") +
          "</p></div>" +
        '<div class="mhead__actions">' +
          '<button class="btn btn--soft btn--sm" type="button" data-crefresh' +
            (state.refreshing ? " disabled" : "") + ">" +
            (state.refreshing ? KT.spinner(15) + "<span>Refreshing…</span>" : "Refresh") + "</button>" +
          (isManager()
            ? '<button class="btn btn--soft btn--sm" type="button" data-cexport' +
              (state.exporting ? " disabled" : "") + ">" +
              (state.exporting ? KT.spinner(15) + "<span>Exporting…</span>" : "Export CSV") + "</button>"
            : "") +
        "</div>" +
      "</header>"
    );
  }

  function filtersHTML() {
    return (
      '<div class="ofilters">' +
        '<div class="ochips">' +
          (svc ? svc.STATUSES : []).map(function (s) {
            return '<button class="chip' + (state.status === s.id ? " is-active" : "") +
              '" type="button" data-cstatus="' + s.id + '">' + s.label + "</button>";
          }).join("") +
        "</div>" +
        '<div class="osearch">' +
          '<span class="osearch__icon">' + KT.icon("search", 17) + "</span>" +
          '<input class="input" type="search" data-csearch aria-label="Search customers" ' +
            'placeholder="' + (isManager() ? "Name, email or phone" : "Name or phone") + '" ' +
            'value="' + esc(state.search) + '">' +
        "</div>" +
      "</div>"
    );
  }

  /* ---- List ------------------------------------------------------------ */

  function initials(name, phone) {
    var src = String(name || phone || "?").trim();
    return src.split(/[\s@.]+/).filter(Boolean).map(function (p) { return p[0]; })
      .join("").slice(0, 2).toUpperCase() || "?";
  }

  function cardHTML(c) {
    return (
      '<article class="ccard" data-copen="' + c.id + '" tabindex="0" role="button" ' +
        'aria-label="Open customer ' + esc(c.name || c.phone) + '">' +
        '<span class="ccard__avatar">' + esc(initials(c.name, c.phone)) + "</span>" +
        '<div class="ccard__main">' +
          '<div class="ccard__top"><strong>' + (esc(c.name) || "<em>No name</em>") + "</strong>" +
            statusBadge(c.status) + "</div>" +
          '<p class="ccard__contact">' +
            (c.email ? esc(c.email) : '<span class="ccard__redacted">email restricted</span>') +
            (c.phone ? ' <span class="ocard__sep">·</span> ' + esc(c.phone) : "") +
          "</p>" +
          '<p class="ccard__meta"><span>joined ' + when(c.createdAt) + "</span>" +
            (c.lastSignInAt ? '<span class="ocard__sep">·</span><span>last seen ' + when(c.lastSignInAt) + "</span>" : "") +
          "</p>" +
        "</div>" +
        '<div class="ccard__right">' +
          '<span class="ccard__orders">' + c.orderCount + "</span>" +
          '<span class="ccard__ordersLabel">order' + (c.orderCount === 1 ? "" : "s") + "</span>" +
          (c.totalSpent != null ? '<span class="ccard__spent">' + KT.naira(c.totalSpent) + "</span>" : "") +
        "</div>" +
      "</article>"
    );
  }

  function pagerHTML() {
    var size = svc ? svc.PAGE_SIZE : 25;
    var pages = Math.ceil(state.total / size);
    if (pages <= 1) return "";
    return '<div class="cpager">' +
      '<button class="btn btn--ghost btn--sm" type="button" data-cpage="prev"' +
        (state.page === 0 ? " disabled" : "") + ">Previous</button>" +
      '<span>Page ' + (state.page + 1) + " of " + pages + "</span>" +
      '<button class="btn btn--ghost btn--sm" type="button" data-cpage="next"' +
        (state.page >= pages - 1 ? " disabled" : "") + ">Next</button>" +
    "</div>";
  }

  function listHTML() {
    if (state.loading) return '<div class="clist">' + KT.loadingLabel("Loading customers…") + KT.skeleton.orders(4) + "</div>";
    if (state.error) {
      return '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("close", 32) + "</div>" +
        "<h3>We could not load customers</h3><p>" + esc(state.error) + "</p>" +
        '<button class="btn btn--primary" type="button" data-cretry>Try again</button></div></div>';
    }
    if (!state.rows.length) {
      var filtered = state.status !== "all" || state.search;
      return '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("user", 32) + "</div>" +
        (filtered
          ? "<h3>No customers match</h3><p>Try a different status or search term.</p>" +
            '<button class="btn btn--soft" type="button" data-cclear>Clear filters</button>'
          : "<h3>No customers yet</h3><p>Accounts appear here as people sign up.</p>") +
        "</div></div>";
    }
    return '<div class="clist">' + state.rows.map(cardHTML).join("") + "</div>" + pagerHTML();
  }

  /* ---- Detail ---------------------------------------------------------- */

  function detailHTML() {
    if (state.detailLoading) return '<div class="odetail__body">' + KT.skeleton.panel(3) + KT.skeleton.panel(4) + "</div>";
    var d = state.detail;
    if (!d) return '<div class="odetail__body"><div class="empty"><h3>Customer not found</h3></div></div>';
    var p = d.profile;

    var orders = d.orders.length
      ? d.orders.map(function (o) {
          return '<div class="oline"><span class="oline__name"><strong>' + esc(o.code) + "</strong>" +
            '<span class="cdetail__sub">' + when(o.createdAt) + " · " +
            (o.fulfilment === "pickup" ? "Pickup" : "Delivery") + "</span></span>" +
            '<span class="obadge ' + (o.status === "Completed" ? "is-completed"
              : o.status === "Cancelled" ? "is-cancelled" : "is-out") + '">' + esc(o.status) + "</span>" +
            '<span class="obadge obadge--pay ' + (o.paid ? "is-paid" : "is-unpaid") + '">' +
              (o.paid ? "Paid" : esc(o.paymentStatus)) + "</span>" +
            '<span class="oline__price">' + KT.naira(o.total) + "</span></div>";
        }).join("")
      : '<p class="odetail__muted">No orders yet.</p>';

    var addresses = d.tier !== "manager"
      ? '<p class="odetail__note">Saved addresses are visible to an admin or owner only.</p>'
      : (d.addresses.length
          ? d.addresses.map(function (a) {
              return '<div class="caddr"><strong>' + esc(a.label) +
                (a.isDefault ? ' <span class="otag">default</span>' : "") + "</strong>" +
                "<p>" + esc(a.address) + "</p>" +
                '<p class="odetail__muted">' + esc(a.recipientName) + " · " + esc(a.phone) + "</p>" +
                (a.notes ? '<p class="odetail__muted">' + esc(a.notes) + "</p>" : "") + "</div>";
            }).join("")
          : '<p class="odetail__muted">No saved addresses.</p>');

    return (
      '<div class="odetail__body">' +
        '<section class="odetail__sec"><h3>Profile</h3>' +
          '<p class="cdetail__name">' + (esc(p.name) || "<em>No name</em>") + "</p>" +
          '<dl class="osum">' +
            '<div class="osum__row"><dt>Email</dt><dd>' +
              (p.email ? esc(p.email) : '<span class="ccard__redacted">restricted</span>') + "</dd></div>" +
            '<div class="osum__row"><dt>Phone</dt><dd>' + (esc(p.phone) || "—") + "</dd></div>" +
            '<div class="osum__row"><dt>Joined</dt><dd>' + when(p.createdAt) + "</dd></div>" +
            (p.lastSignInAt
              ? '<div class="osum__row"><dt>Last seen</dt><dd>' + when(p.lastSignInAt) + "</dd></div>" : "") +
          "</dl>" +
        "</section>" +
        '<section class="odetail__sec"><h3>Orders (' + d.orders.length + ")</h3>" + orders +
          '<p class="odetail__note">Payment state is set by the settlement system and is read-only here.</p>' +
        "</section>" +
        '<section class="odetail__sec"><h3>Saved addresses</h3>' + addresses + "</section>" +
        /* d.tier is the server's word for what this caller is — the same
           value that decided whether email and spend were redacted above. A
           staff or supervisor caller does not see this section, and
           admin_notify_customer() refuses them regardless. */
        (d.tier === "manager" ? notifyHTML(p) : "") +
        (isOwner()
          ? '<section class="odetail__sec"><h3>Danger zone</h3>' +
            '<p class="odetail__muted">Deleting an account removes its wallet, addresses, ' +
            "favourites and reviews. Customers with order history cannot be deleted.</p>" +
            '<button class="btn btn--ghost odanger" type="button" data-cdel="' + p.id + '">' +
              "Delete this account</button></section>"
          : "") +
      "</div>"
    );
  }

  /*
     Admin -> customer, outside any conversation the customer started. It
     lands in their notification centre in real time, exactly like a chat or
     ticket reply, because it is the same table and the same trigger-free
     path: admin_notify_customer() calls notify_user() server-side. Nothing
     here inserts a notification, and nothing here could — `authenticated`
     has no INSERT grant on the table.
  */
  function notifyHTML(p) {
    return (
      '<section class="odetail__sec"><h3>Send a notification</h3>' +
        '<p class="odetail__muted">Appears in this customer\'s notification ' +
        "centre straight away. It is recorded in the audit log with your name " +
        "against it.</p>" +
        '<form class="cnotify" data-cnotify="' + esc(p.id) + '">' +
          '<label class="field"><span class="field__label">Title</span>' +
            '<input class="input" name="title" maxlength="120" required ' +
              'placeholder="Your order is ready"></label>' +
          '<label class="field"><span class="field__label">Message</span>' +
            '<textarea class="input" name="message" rows="3" maxlength="500" required ' +
              'placeholder="Short and specific — they see this as a notification."></textarea>' +
          "</label>" +
          '<button class="btn btn--soft btn--sm" type="submit">Send notification</button>' +
        "</form>" +
      "</section>"
    );
  }

  function drawerHTML() {
    if (!state.open) return "";
    var name = state.detail && state.detail.profile ? state.detail.profile.name : "";
    return (
      '<div class="odrawer is-open" data-cdrawer>' +
        '<div class="odrawer__scrim" data-cclose></div>' +
        '<aside class="odrawer__panel" role="dialog" aria-modal="true" aria-label="Customer detail">' +
          '<header class="odrawer__head"><div><strong>' + (esc(name) || "Customer") + "</strong>" +
            '<span class="odrawer__sub">Customer record</span></div>' +
            '<button class="icon-btn" type="button" data-cclose aria-label="Close">' + KT.icon("close", 20) + "</button>" +
          "</header>" + detailHTML() +
        "</aside>" +
      "</div>"
    );
  }

  function confirmHTML() {
    var c = state.confirm;
    if (!c) return "";
    var chk = state.confirmCheck;
    var blocked = chk && chk.can_delete === false;
    return (
      '<div class="mconfirm" data-cconfirm>' +
        '<div class="mconfirm__scrim" data-ccancel></div>' +
        '<div class="mconfirm__box" role="alertdialog" aria-modal="true">' +
          '<span class="mconfirm__mark">' + KT.icon(blocked ? "lock" : "trash", 26) + "</span>" +
          "<h3>" + (blocked ? "Cannot delete this account" : "Delete " + esc(c.name || "this customer") + "?") + "</h3>" +
          (chk === null
            ? "<p>Checking what this would affect…</p>"
            : blocked
              ? "<p>" + esc(chk.reason) + "</p>"
              : "<p>This permanently removes the account and its wallet, " +
                (chk.addresses || 0) + " saved address(es) and " +
                (chk.wallet_transactions || 0) + " wallet transaction(s). " +
                "It cannot be undone, and the action is recorded in the audit log.</p>") +
          '<div class="mconfirm__actions">' +
            '<button class="btn btn--ghost" type="button" data-ccancel>' +
              (blocked ? "Close" : "Keep the account") + "</button>" +
            (blocked || chk === null ? ""
              : '<button class="btn btn--primary odanger-solid" type="button" data-cconfirmdel>' +
                (state.deleting ? KT.spinner(15) + "<span>Deleting…</span>" : "Delete permanently") + "</button>") +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }

  /* ---- Render ---------------------------------------------------------- */

  function render() {
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    var a = document.activeElement;
    var wasSearch = a && a.hasAttribute && a.hasAttribute("data-csearch");
    var caret = wasSearch ? a.selectionStart : null;

    KT.mount(host, headHTML() + filtersHTML() + listHTML() + drawerHTML() + confirmHTML());

    if (wasSearch) {
      var i = KT.qs("[data-csearch]");
      if (i) { i.focus(); try { i.setSelectionRange(caret, caret); } catch (e) {} }
    }
  }

  /* ---- Data ------------------------------------------------------------ */

  async function load(opts) {
    opts = opts || {};
    if (opts.refresh) state.refreshing = true; else state.loading = true;
    state.error = null; render();
    try {
      var res = await svc.adminCustomerService.list({
        search: state.search, status: state.status,
        offset: state.page * svc.PAGE_SIZE
      });
      state.rows = res.rows; state.total = res.total; state.tier = res.tier;
    } catch (error) {
      state.error = KT.services.errorMessage(error); state.rows = [];
    } finally {
      state.loading = false; state.refreshing = false; render();
    }
  }

  async function openDetail(id) {
    state.open = id; state.detail = null; state.detailLoading = true; render();
    try { state.detail = await svc.adminCustomerService.get(id); }
    catch (error) {
      state.detail = null;
      KT.toast(KT.services.errorMessage(error), "error", { duration: 5000 });
    } finally { state.detailLoading = false; render(); }
  }

  async function askDelete(id) {
    var row = state.rows.filter(function (r) { return r.id === id; })[0];
    state.confirm = { id: id, name: (row && row.name) || (state.detail && state.detail.profile.name) };
    state.confirmCheck = null; render();
    try { state.confirmCheck = await svc.adminCustomerService.canDelete(id); }
    catch (error) {
      state.confirmCheck = { can_delete: false, reason: KT.services.errorMessage(error) };
    } finally { render(); }
  }

  async function doDelete() {
    if (!state.confirm) return;
    state.deleting = true; render();
    try {
      await svc.adminCustomerService.remove(state.confirm.id);
      KT.toast("Account deleted.", "success");
      state.confirm = null; state.confirmCheck = null;
      state.open = null; state.detail = null;
      await load({ refresh: true });
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    } finally { state.deleting = false; render(); }
  }

  async function doExport() {
    state.exporting = true; render();
    try {
      var all = await svc.adminCustomerService.list({
        search: state.search, status: state.status, limit: 200, offset: 0
      });
      var csv = svc.adminCustomerService.toCsv(all.rows);
      await svc.adminCustomerService.logExport(all.rows.length);
      var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = "kandys-customers.csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      KT.toast("Exported " + all.rows.length + " customer(s).", "success");
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    } finally { state.exporting = false; render(); }
  }

  /* ---- Entry ----------------------------------------------------------- */

  document.addEventListener("submit", async function (e) {
    var form = e.target.closest("[data-cnotify]");
    if (!form) return;
    e.preventDefault();
    var data = Object.fromEntries(new FormData(form).entries());
    var done = KT.busy(KT.qs("[type=submit]", form), "Sending…");
    if (!done) return;
    try {
      var mod = await import("../services/admin-notify.js");
      await mod.adminNotifyService.notifyCustomer(
        form.getAttribute("data-cnotify"), data.title, data.message);
      form.reset();
      KT.toast("Notification sent.", "success");
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    } finally {
      done();
    }
  });

  KT.admin.views.customers = function (viewCtx) {
    ctx = viewCtx || ctx;
    setTimeout(async function () {
      if (!svc) {
        try { svc = await import("../services/admin-customers.js"); }
        catch (e) { state.loading = false; state.error = "Could not load the customers module."; render(); return; }
      }
      await load();
    }, 0);
    return '<div data-customers-mount>' + KT.loadingLabel("Loading customers…") + KT.skeleton.orders(4) + "</div>";
  };

  KT.admin.views.customersTeardown = function () {
    state.open = null; state.detail = null; state.confirm = null; state.confirmCheck = null;
  };

  /* ---- Events ---------------------------------------------------------- */

  document.addEventListener("click", function (e) {
    var t = e.target;
    var st = t.closest("[data-cstatus]");
    if (st) { state.status = st.getAttribute("data-cstatus"); state.page = 0; load(); return; }
    if (t.closest("[data-crefresh]")) { load({ refresh: true }); return; }
    if (t.closest("[data-cretry]"))   { load(); return; }
    if (t.closest("[data-cclear]"))   { state.status = "all"; state.search = ""; state.page = 0; load(); return; }
    if (t.closest("[data-cexport]"))  { doExport(); return; }
    var pg = t.closest("[data-cpage]");
    if (pg) {
      state.page += pg.getAttribute("data-cpage") === "next" ? 1 : -1;
      if (state.page < 0) state.page = 0;
      load(); return;
    }
    if (t.closest("[data-cclose]")) { state.open = null; state.detail = null; render(); return; }
    if (t.closest("[data-ccancel]")) { state.confirm = null; state.confirmCheck = null; render(); return; }
    if (t.closest("[data-cconfirmdel]")) { doDelete(); return; }
    var del = t.closest("[data-cdel]");
    if (del) { askDelete(del.getAttribute("data-cdel")); return; }
    var open = t.closest("[data-copen]");
    if (open) { openDetail(open.getAttribute("data-copen")); }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (state.confirm) { state.confirm = null; state.confirmCheck = null; render(); }
      else if (state.open) { state.open = null; state.detail = null; render(); }
      return;
    }
    var card = e.target.closest && e.target.closest("[data-copen]");
    if (card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault(); openDetail(card.getAttribute("data-copen"));
    }
  });

  document.addEventListener("input", function (e) {
    var i = e.target.closest("[data-csearch]");
    if (!i) return;
    state.search = i.value; state.page = 0;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { load(); }, 280);
  });
})(window.KT || (window.KT = {}));
