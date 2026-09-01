/* ==========================================================================
   Kandy's Treats — admin notification centre
   --------------------------------------------------------------------------
   The handler's counterpart to the customer's bell. Same table, same realtime
   channel, same rows — a handler simply reads the ones the database addressed
   to THEM, which notifications_select_own already scopes to
   user_id = auth.uid().

   WHY IT IS SEPARATE FROM js/admin/alerts.js
   ------------------------------------------
   alerts.js is the interruption: a transient card and a sound for something
   happening RIGHT NOW, gone in thirty seconds. This is the record: what
   arrived while nobody was looking, still there tomorrow, with a read state.
   They consume the same stream but answer different questions, and merging
   them would mean either a toast that never leaves or a list that vanishes.

   They share one realtime subscription — alerts.js owns it and re-broadcasts,
   so opening the admin does not open two channels on the same table.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var svc = null;
  var state = { open: false, loading: false, loaded: false, rows: [], unread: 0, error: null };

  function esc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function ago(d) {
    if (!d) return "";
    var mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    if (mins < 60 * 24) return Math.round(mins / 60) + "h ago";
    return new Date(d).toLocaleDateString("en-NG", { day: "2-digit", month: "short" });
  }

  var META = {
    admin_order:   { icon: "receipt", tone: "order",   action: "View" },
    admin_support: { icon: "mail",    tone: "support", action: "Open chat" },
    admin_ticket:  { icon: "mail",    tone: "support", action: "Open ticket" },
    payment:       { icon: "wallet",  tone: "payment", action: "Review" },
    message:       { icon: "sparkle", tone: "message", action: null }
  };

  /** Where each type opens. The same routes the rest of the admin uses. */
  function hrefFor(n) {
    switch (n.type) {
      case "admin_order":
        return n.related_id ? "#/orders?code=" + encodeURIComponent(n.related_id) : "#/orders";
      case "admin_support":
        /* related_id here is a CONVERSATION. */
        return n.related_id
          ? "#/support?tab=chat&conversation=" + encodeURIComponent(n.related_id)
          : "#/support?tab=chat";
      case "admin_ticket":
        /* related_id here is a TICKET. Same tab family, different id space —
           which is exactly why these are two types and not one. */
        return n.related_id
          ? "#/support?tab=tickets&ticket=" + encodeURIComponent(n.related_id)
          : "#/support?tab=tickets";
      case "payment":
        /* See the note in js/admin/dashboard.js: #/reconciliation has no view. */
        return "#/finance?tab=reconciliation";
      default:
        return null;
    }
  }

  /* ---- Markup ------------------------------------------------------------ */

  function bellHTML() {
    return (
      '<button class="icon-btn anotifbtn" type="button" data-anotif-toggle ' +
        'aria-label="Notifications" aria-haspopup="dialog" aria-expanded="' +
        (state.open ? "true" : "false") + '">' +
        KT.icon("bell", 20) +
        '<span class="anotifbtn__badge"' + (state.unread ? "" : " hidden") + ">" +
          (state.unread > 9 ? "9+" : state.unread) + "</span>" +
      "</button>"
    );
  }

  function rowHTML(n) {
    var meta = META[n.type] || { icon: "sparkle", tone: "message", action: null };
    var href = hrefFor(n);
    return (
      '<div class="anotif' + (n.read ? "" : " is-unread") + '" data-anotif="' + esc(n.id) + '">' +
        '<span class="anotif__icon anotif__icon--' + meta.tone + '">' +
          KT.icon(meta.icon, 16) + "</span>" +
        '<div class="anotif__body">' +
          "<strong>" + esc(n.title) + "</strong>" +
          '<span class="anotif__msg">' + esc(n.message || "") + "</span>" +
          '<time class="anotif__time">' + esc(ago(n.created_at)) + "</time>" +
        "</div>" +
        (href && meta.action
          ? '<a class="btn btn--soft btn--sm anotif__action" href="' + href +
            '" data-anotif-open="' + esc(n.id) + '">' + meta.action + "</a>"
          : "") +
      "</div>"
    );
  }

  function panelHTML() {
    var body;
    if (state.error) {
      body = '<div class="anotif__state"><p>' + esc(state.error) + "</p>" +
        '<button class="btn btn--soft btn--sm" type="button" data-anotif-reload>Try again</button></div>';
    } else if (state.loading && !state.rows.length) {
      body = '<div class="anotif__list">' + KT.skeleton.lines(3) + "</div>";
    } else if (!state.rows.length) {
      body = '<div class="anotif__state">' +
        '<span class="anotif__art">' + KT.icon("bell", 24) + "</span>" +
        "<p><strong>Nothing waiting</strong><br>New orders, customer messages and " +
        "support requests land here.</p></div>";
    } else {
      body = '<div class="anotif__list">' + state.rows.map(rowHTML).join("") + "</div>";
    }
    return (
      '<div class="anotifpanel" data-anotif-panel role="dialog" aria-label="Notifications">' +
        '<header class="anotifpanel__head"><strong>Notifications</strong>' +
          (state.unread
            ? '<button class="anotifpanel__all" type="button" data-anotif-readall>Mark all read</button>'
            : "") +
          '<button class="icon-btn anotifpanel__close" type="button" data-anotif-close ' +
            'aria-label="Close">' + KT.icon("close", 18) + "</button>" +
        "</header>" + body +
      "</div>"
    );
  }

  /* ---- Paint ------------------------------------------------------------- */

  function paintBell() {
    var slot = KT.qs("[data-admin-notif]");
    if (slot) slot.innerHTML = bellHTML();
  }

  function paintPanel() {
    var host = KT.qs("[data-anotif-host]");
    if (!host) {
      host = document.createElement("div");
      host.className = "anotifhost";
      host.setAttribute("data-anotif-host", "");
      document.body.appendChild(host);
    }
    host.innerHTML = state.open ? panelHTML() : "";
    host.classList.toggle("is-open", state.open);
    if (state.open) {
      var bell = KT.qs("[data-anotif-toggle]");
      var panel = KT.qs(".anotifpanel");
      if (bell && panel) {
        var r = bell.getBoundingClientRect();
        panel.style.setProperty("--anotif-top", Math.round(r.bottom + 8) + "px");
        panel.style.setProperty("--anotif-right",
          Math.max(12, Math.round(window.innerWidth - r.right)) + "px");
      }
    }
  }

  /* ---- Data -------------------------------------------------------------- */

  async function ensureSvc() {
    if (!svc) svc = (await import("../services/admin-notify.js")).adminNotifyService;
    return svc;
  }

  async function refreshCount() {
    try {
      await ensureSvc();
      var res = await svc.centre({ limit: 1 });
      state.unread = res.unread || 0;
    } catch (error) { state.unread = 0; }
    paintBell();
  }

  async function load() {
    await ensureSvc();
    state.loading = true; state.error = null;
    if (state.open) paintPanel();
    try {
      var res = await svc.centre({ limit: 20 });
      state.rows = res.rows || [];
      state.unread = res.unread || 0;
      state.loaded = true;
    } catch (error) {
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
    }
    state.loading = false;
    paintBell();
    if (state.open) paintPanel();
  }

  /* ---- Events ------------------------------------------------------------ */

  document.addEventListener("click", async function (e) {
    if (e.target.closest("[data-anotif-toggle]")) {
      e.preventDefault();
      state.open = !state.open;
      paintPanel();
      if (state.open) load();
      return;
    }
    if (e.target.closest("[data-anotif-close]")) {
      e.preventDefault(); state.open = false; paintPanel(); return;
    }
    if (e.target.closest("[data-anotif-reload]")) { e.preventDefault(); load(); return; }

    if (e.target.closest("[data-anotif-readall]")) {
      e.preventDefault();
      try {
        await svc.markAllRead();
        state.rows = state.rows.map(function (n) { return Object.assign({}, n, { read: true }); });
        state.unread = 0;
        paintBell(); paintPanel();
      } catch (error) {
        KT.toast(KT.services.errorMessage(error), "error");
      }
      return;
    }

    var open = e.target.closest("[data-anotif-open]");
    if (open) {
      /* The <a> navigates on its own; this only settles the read state and
         closes the panel behind it. */
      markRead(open.getAttribute("data-anotif-open"));
      state.open = false;
      window.setTimeout(paintPanel, 0);
      return;
    }

    var row = e.target.closest("[data-anotif]");
    if (row) { markRead(row.getAttribute("data-anotif")); return; }

    if (state.open && !e.target.closest("[data-anotif-panel]")) {
      state.open = false; paintPanel();
    }
  });

  function markRead(id) {
    var n = state.rows.filter(function (x) { return x.id === id; })[0];
    if (!n || n.read) return;
    n.read = true;
    state.unread = Math.max(0, state.unread - 1);
    paintBell(); paintPanel();
    svc.markRead(id).catch(function () {});
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.open) { state.open = false; paintPanel(); }
  });

  /* ---- Public API -------------------------------------------------------- */

  KT.admin.notifications = {
    /** Called by the shell once a handler role has resolved. */
    start: function () {
      state = { open: false, loading: false, loaded: false, rows: [], unread: 0, error: null };
      paintBell();
      refreshCount();
    },
    /** alerts.js re-broadcasts its subscription rather than opening a second. */
    onIncoming: function () {
      if (state.open) load(); else refreshCount();
    },
    stop: function () {
      state = { open: false, loading: false, loaded: false, rows: [], unread: 0, error: null };
      var host = KT.qs("[data-anotif-host]");
      if (host) host.innerHTML = "";
      var slot = KT.qs("[data-admin-notif]");
      if (slot) slot.innerHTML = "";
    }
  };
})(window.KT || (window.KT = {}));
