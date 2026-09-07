/* ==========================================================================
   Kandy's Treats — Notification bell
   --------------------------------------------------------------------------
   The bell lives in the existing header, beside the theme toggle and the
   cart. Nothing else about the navigation changes: same logo, same links,
   same mobile sheet, same tab bar, same theme system.

   THREE STATES, NOT TWO
   ---------------------
   The same discipline the account CTA uses. While the session is still
   resolving the bell is rendered but invisible, so it holds its footprint and
   a signed-in customer never sees the header reflow once auth lands. Signed
   out, it is removed entirely — there is nothing to notify.

   REALTIME
   --------
   One channel per signed-in customer, opened on sign-in and closed on
   sign-out or page unload. It reuses the shared Supabase socket through
   js/services/notifications.js, so this adds no second websocket and no
   second subscription to the same table.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.components = KT.components || {};

  var state = {
    open: false,
    loading: false,
    loaded: false,
    items: [],
    unread: 0,
    error: null,
    prefsOpen: false,
    prefs: null
  };
  var stop = null;          /* realtime unsubscribe */
  var boundUid = null;      /* who the current subscription belongs to */
  var hostEl = null;        /* body-level layer the panel is drawn into */

  /* Web Push state, resolved lazily. `null` means "not looked at yet" — the
     panel renders nothing about push until it knows, rather than flashing an
     offer and then withdrawing it. */
  var push = { checked: false, supported: false, reason: null, enabled: false, busy: false };

  /*
     The panel lives on <body>, NOT inside the header — the same place the
     chat panel and cart drawer put themselves, and for the same reason.
     .nav carries `backdrop-filter`, which makes it a containing block for
     any `position: fixed` descendant: a panel rendered inside the header
     could not become a full-width bottom sheet on a phone, because "fixed"
     would resolve against the header rather than the viewport. It anchored
     itself to the top of the document instead.
  */
  function host() {
    if (hostEl && document.body.contains(hostEl)) return hostEl;
    hostEl = document.createElement("div");
    hostEl.className = "notifhost";
    hostEl.setAttribute("data-notif-host", "");
    document.body.appendChild(hostEl);
    return hostEl;
  }

  /* On a wide screen the panel hangs under the header, so it needs to know
     where the header ends. Measured at open time rather than hard-coded,
     because the header condenses on scroll and the promo strip can be
     replaced by live announcements. */
  function anchor(el) {
    var nav = KT.qs("[data-nav]");
    var bottom = nav ? Math.round(nav.getBoundingClientRect().bottom) : 76;
    el.style.setProperty("--notif-top", bottom + 8 + "px");
  }

  function svc() {
    return KT.services && KT.services.notifications;
  }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function ago(d) {
    if (!d) return "";
    var mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    var days = Math.round(hrs / 24);
    if (days < 7) return days + "d ago";
    return new Date(d).toLocaleDateString("en-NG", { day: "2-digit", month: "short" });
  }

  var ICONS = {
    order: "receipt", chat: "mail", support: "mail",
    wallet: "wallet", message: "sparkle", reward: "star"
  };

  /* ---- Markup ------------------------------------------------------------ */

  /** The button itself, so the navbar can render it inline. */
  function bellHTML() {
    if (KT.authResolving && KT.authResolving()) {
      /* Keeps the slot, paints nothing: no reflow when the session lands. */
      return '<button class="notifbtn" type="button" data-notif-toggle ' +
        'style="visibility:hidden" aria-hidden="true" tabindex="-1">' +
        KT.icon("bell", 21) + "</button>";
    }
    if (!(KT.auth && KT.auth.isSignedIn())) return "";
    return (
      '<button class="notifbtn" type="button" data-notif-toggle ' +
        'aria-label="Notifications" aria-haspopup="dialog" aria-expanded="' +
        (state.open ? "true" : "false") + '">' +
        KT.icon("bell", 21) +
        '<span class="notifbtn__badge" data-notif-badge' +
          (state.unread ? "" : " hidden") + ">" +
          (state.unread > 9 ? "9+" : state.unread) + "</span>" +
      "</button>"
    );
  }

  function itemHTML(n) {
    var link = svc() ? svc().href(n) : null;
    var inner =
      '<span class="notifitem__icon">' + KT.icon(ICONS[n.type] || "sparkle", 17) + "</span>" +
      '<span class="notifitem__text">' +
        "<strong>" + esc(n.title) + "</strong>" +
        "<span>" + esc(n.message) + "</span>" +
        '<time>' + ago(n.createdAt) + "</time>" +
      "</span>" +
      (n.read ? "" : '<span class="notifitem__dot" aria-label="Unread"></span>');

    var cls = "notifitem" + (n.read ? "" : " is-unread");
    return link
      ? '<a class="' + cls + '" href="' + link + '" data-notif-item="' + esc(n.id) + '">' + inner + "</a>"
      : '<div class="' + cls + '" data-notif-item="' + esc(n.id) + '" tabindex="0" role="button">' +
        inner + "</div>";
  }

  /*
     The permission offer. It is the only place the site ever asks, it is
     rendered inside a panel the customer opened deliberately, and it says
     what the permission is for before asking for it (§6). Every refusal
     state has its own wording, because "enable notifications" shown to
     somebody who has already blocked them is a dead end.
  */
  function pushRowHTML() {
    if (!push.checked) return "";
    if (push.enabled) {
      return '<div class="notifpush is-on">' +
        '<span class="notifpush__icon">' + KT.icon("check", 15) + "</span>" +
        '<span class="notifpush__text"><strong>Order alerts are on</strong>' +
        "<span>This device gets updates even when the site is closed.</span></span>" +
        '<button class="notifpush__off" type="button" data-push-disable>Turn off</button>' +
      "</div>";
    }
    if (push.reason === "ios-needs-install") {
      return '<div class="notifpush">' +
        '<span class="notifpush__icon">' + KT.icon("phone", 15) + "</span>" +
        '<span class="notifpush__text"><strong>Add Kandy\'s to your Home Screen</strong>' +
        "<span>On iPhone, alerts need the app installed: tap Share, then " +
        "<em>Add to Home Screen</em>, and open it from there.</span></span></div>";
    }
    if (push.reason === "blocked") {
      return '<div class="notifpush">' +
        '<span class="notifpush__icon">' + KT.icon("lock", 15) + "</span>" +
        '<span class="notifpush__text"><strong>Notifications are blocked</strong>' +
        "<span>Your browser is refusing them for this site. Allow notifications " +
        "in the site settings to turn them back on.</span></span></div>";
    }
    if (!push.supported) return "";
    return '<div class="notifpush">' +
      '<span class="notifpush__icon">' + KT.icon("bell", 15) + "</span>" +
      '<span class="notifpush__text"><strong>Get order updates</strong>' +
      "<span>Know the moment your order is being prepared or on its way — " +
      "even with the site closed.</span></span>" +
      '<button class="btn btn--primary btn--sm notifpush__on" type="button" data-push-enable' +
        (push.busy ? " disabled" : "") + ">" + (push.busy ? "Enabling…" : "Enable") + "</button>" +
    "</div>";
  }

  /*
     §13. Four switches, and one of them is deliberately not a switch: order
     and payment updates are marked CRITICAL server-side
     (notification_is_critical) and wants_push() returns true for them
     regardless of preference. Showing a toggle that the server ignores would
     be a lie, so it is shown as a fixed row that says why.
  */
  function prefsHTML() {
    if (!state.prefsOpen) return "";
    var p = state.prefs || {};
    var row = function (key, label, hint) {
      return '<label class="notifpref">' +
        '<input type="checkbox" data-pref="' + key + '"' + (p[key] ? " checked" : "") + ">" +
        '<span class="notifpref__text"><strong>' + esc(label) + "</strong>" +
        "<span>" + esc(hint) + "</span></span></label>";
    };
    return (
      '<div class="notifprefs">' +
        '<div class="notifpref is-locked">' +
          '<span class="notifpref__lock">' + KT.icon("lock", 14) + "</span>" +
          '<span class="notifpref__text"><strong>Order &amp; payment updates</strong>' +
          "<span>Always on. These tell you what happened to money you spent " +
          "or food you are waiting for.</span></span></div>" +
        row("push_support", "Messages", "Replies from Kandy's in chat and support.") +
        row("push_marketing", "Announcements", "Offers and news. Off by choice is fine.") +
      "</div>"
    );
  }

  function panelHTML() {
    var body;
    if (state.error) {
      body = '<div class="notifpanel__state"><p>' + esc(state.error) + "</p>" +
        '<button class="btn btn--soft btn--sm" type="button" data-notif-reload>Try again</button></div>';
    } else if (state.loading && !state.items.length) {
      body = '<div class="notifpanel__list">' + KT.skeleton.lines(3) + "</div>";
    } else if (!state.items.length) {
      body = '<div class="notifpanel__state">' +
        '<span class="notifpanel__art">' + KT.icon("bell", 26) + "</span>" +
        "<p><strong>Nothing yet</strong><br>Order updates and replies from " +
        "Kandy's Treats will appear here.</p></div>";
    } else {
      body = '<div class="notifpanel__list">' + state.items.map(itemHTML).join("") + "</div>";
    }

    return (
      '<div class="notifpanel" data-notif-panel role="dialog" aria-label="Notifications">' +
        '<header class="notifpanel__head">' +
          "<strong>Notifications</strong>" +
          (state.unread
            ? '<button class="notifpanel__all" type="button" data-notif-readall>Mark all read</button>'
            : "") +
          '<button class="icon-btn notifpanel__prefs" type="button" data-notif-prefs ' +
            'aria-label="Notification settings" aria-expanded="' +
            (state.prefsOpen ? "true" : "false") + '">' + KT.icon("settings", 17) + "</button>" +
          '<button class="icon-btn notifpanel__close" type="button" data-notif-close ' +
            'aria-label="Close notifications">' + KT.icon("close", 18) + "</button>" +
        "</header>" +
        pushRowHTML() + prefsHTML() +
        body +
        '<a class="notifpanel__foot" href="' + KT.url("pages/account.html#notifications") + '">' +
          "See everything in your account" + KT.icon("chevronRight", 15) + "</a>" +
      "</div>"
    );
  }

  /* ---- Painting ---------------------------------------------------------- */

  function paintBell() {
    KT.qsa("[data-notif-slot]").forEach(function (slot) {
      slot.innerHTML = bellHTML();
    });
  }

  function paintBadge() {
    KT.qsa("[data-notif-badge]").forEach(function (b) {
      b.textContent = state.unread > 9 ? "9+" : String(state.unread);
      b.hidden = !state.unread;
    });
    KT.qsa("[data-notif-toggle]").forEach(function (b) {
      b.classList.toggle("has-unread", state.unread > 0);
    });
  }

  function paintPanel() {
    var el = host();
    el.innerHTML = state.open ? panelHTML() : "";
    el.classList.toggle("is-open", state.open);
    if (state.open) anchor(el);
    KT.qsa("[data-notif-toggle]").forEach(function (b) {
      b.setAttribute("aria-expanded", state.open ? "true" : "false");
    });
  }

  /* ---- Data -------------------------------------------------------------- */

  async function refreshCount() {
    if (!svc() || !(KT.auth && KT.auth.isSignedIn())) { state.unread = 0; paintBadge(); return; }
    try {
      state.unread = await svc().unreadCount();
    } catch (error) {
      state.unread = 0;
    }
    paintBadge();
  }

  async function loadList() {
    if (!svc()) return;
    state.loading = true; state.error = null;
    paintPanel();
    try {
      state.items = await svc().list({ limit: 20 });
      state.unread = state.items.filter(function (n) { return !n.read; }).length;
      state.loaded = true;
    } catch (error) {
      state.error = KT.services.errorMessage(error);
    }
    state.loading = false;
    paintPanel();
    paintBadge();
  }

  /* ---- Open / close ------------------------------------------------------ */

  async function refreshPushState() {
    var svcPush = KT.services && KT.services.push;
    if (!svcPush) return;
    try {
      var s = svcPush.support();
      push.supported = s.supported;
      push.reason = s.reason || (s.permission === "denied" ? "blocked" : null);
      push.enabled = s.supported && s.permission === "granted" && await svcPush.isEnabled();
    } catch (error) {
      push.supported = false;
      push.reason = "unsupported";
    }
    push.checked = true;
    if (state.open) paintPanel();
  }

  function open() {
    state.open = true;
    paintPanel();
    if (!state.loaded || state.unread) loadList(); else paintPanel();
    /* Resolved on open, not on page load: asking the browser about push costs
       a service-worker round trip, and nobody who never opens the bell should
       pay for it. */
    refreshPushState();
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    paintPanel();
  }

  /* ---- Realtime ---------------------------------------------------------- */

  function watch() {
    var uid = KT.auth && KT.auth.uid && KT.auth.uid();
    if (!svc()) return;

    if (!uid) { unwatch(); state.items = []; state.loaded = false; state.unread = 0; paintBadge(); return; }
    if (stop && boundUid === uid) return;      /* already watching this customer */

    unwatch();
    boundUid = uid;
    stop = svc().subscribe(function (change) {
      var n = change.notification;
      /* Keep the open panel current, and the badge current either way. */
      var i = state.items.findIndex(function (x) { return x.id === n.id; });
      if (change.event === "DELETE") {
        if (i >= 0) state.items.splice(i, 1);
      } else if (i >= 0) {
        state.items[i] = n;
      } else {
        state.items.unshift(n);
        state.items = state.items.slice(0, 20);
      }
      state.unread = state.items.filter(function (x) { return !x.read; }).length;
      paintBadge();
      if (state.open) paintPanel();

      /* A toast only for genuinely new, unread traffic — not for the update
         that lands when a row is collapsed or marked read elsewhere. */
      if (change.event === "INSERT" && !n.read && !state.open) {
        KT.toast(n.title, "success", { duration: 5200 });
      }
    });
  }

  function unwatch() {
    if (stop) { stop(); stop = null; }
    boundUid = null;
  }

  /** One sentence per refusal, because each one has a different way out. */
  function pushRefusal(res) {
    switch (res.reason) {
      case "blocked":          return "Your browser is blocking notifications for this site. Allow them in site settings.";
      case "dismissed":        return "No problem — you can turn alerts on any time from here.";
      case "ios-needs-install":return "On iPhone, add Kandy's to your Home Screen first, then enable alerts from there.";
      case "signed-out":       return "Sign in first so we know whose orders to tell you about.";
      case "not-configured":   return "Push is not configured for this site yet.";
      case "insecure":         return "Notifications need a secure (https) connection.";
      case "unsupported":      return "This browser does not support notifications.";
      case "subscribe-failed": return "This browser refused the subscription. Alerts still show in the bell.";
      default:                 return "Could not turn on alerts. The bell still works.";
    }
  }

  /* ---- Wiring ------------------------------------------------------------ */

  document.addEventListener("click", async function (e) {
    if (e.target.closest("[data-notif-toggle]")) {
      e.preventDefault();
      if (state.open) close(); else open();
      return;
    }
    if (e.target.closest("[data-notif-close]")) { e.preventDefault(); close(); return; }
    if (e.target.closest("[data-notif-reload]")) { e.preventDefault(); loadList(); return; }

    if (e.target.closest("[data-notif-prefs]")) {
      e.preventDefault();
      state.prefsOpen = !state.prefsOpen;
      paintPanel();
      if (state.prefsOpen && !state.prefs) {
        try { state.prefs = await KT.services.push.preferences(); }
        catch (error) { state.prefs = null; }
        paintPanel();
      }
      return;
    }

    if (e.target.closest("[data-push-enable]")) {
      e.preventDefault();
      push.busy = true; paintPanel();
      var res = await KT.services.push.enable();
      push.busy = false;
      if (res.ok) {
        push.enabled = true; push.reason = null;
        KT.toast("Order alerts are on for this device.", "success");
      } else {
        push.reason = res.reason;
        push.enabled = false;
        KT.toast(pushRefusal(res), "error", { duration: 6000 });
      }
      paintPanel();
      return;
    }

    if (e.target.closest("[data-push-disable]")) {
      e.preventDefault();
      push.busy = true; paintPanel();
      var off = await KT.services.push.disable();
      push.busy = false;
      push.enabled = !off.ok;
      KT.toast(off.ok ? "Order alerts turned off for this device."
                      : "Could not turn alerts off.", off.ok ? "success" : "error");
      paintPanel();
      return;
    }

    if (e.target.closest("[data-notif-readall]")) {
      e.preventDefault();
      try {
        await svc().markAllRead();
        state.items = state.items.map(function (n) {
          return Object.assign({}, n, { read: true });
        });
        state.unread = 0;
        paintBadge(); paintPanel();
      } catch (error) {
        KT.toast(KT.services.errorMessage(error), "error");
      }
      return;
    }

    var item = e.target.closest("[data-notif-item]");
    if (item) {
      var id = item.getAttribute("data-notif-item");
      var n = state.items.filter(function (x) { return x.id === id; })[0];
      if (n && !n.read) {
        n.read = true;
        state.unread = Math.max(0, state.unread - 1);
        paintBadge();
        svc().markRead(id).catch(function () {});
      }
      /* An <a> continues to its href; a plain row just closes the panel. */
      if (item.tagName !== "A") { close(); paintPanel(); }
      return;
    }

    /* Click-away. */
    if (state.open && !e.target.closest("[data-notif-panel]")) close();
  });

  document.addEventListener("change", async function (e) {
    var box = e.target.closest("[data-pref]");
    if (!box) return;
    var key = box.getAttribute("data-pref");
    var value = box.checked;
    state.prefs = Object.assign({}, state.prefs || {});
    state.prefs[key] = value;
    try {
      var patch = {}; patch[key] = value;
      await KT.services.push.savePreferences(patch);
    } catch (error) {
      /* Put the switch back where the server still has it. */
      state.prefs[key] = !value;
      paintPanel();
      KT.toast(KT.services.errorMessage(error), "error");
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.open) close();
  });

  /* Auth is the trigger for everything: the bell appears, the count loads and
     the channel opens on sign-in, and all three unwind on sign-out. */
  function onAuth() {
    state.open = false;
    paintBell();
    paintPanel();
    if (KT.auth && KT.auth.isSignedIn()) {
      refreshCount();
      watch();
      if (KT.services && KT.services.push) KT.services.push.listenForResubscribe();
    } else {
      unwatch();
      state.items = []; state.loaded = false; state.unread = 0;
      /* Signing out invalidates what we knew about this device's permission
         for the previous account. */
      push = { checked: false, supported: false, reason: null, enabled: false, busy: false };
      state.prefs = null; state.prefsOpen = false;
    }
  }

  document.addEventListener("kt:auth", onAuth);
  document.addEventListener("kt:services", onAuth);
  window.addEventListener("pagehide", unwatch);

  KT.components.notifications = {
    bellHTML: bellHTML,
    paint: onAuth,
    refresh: loadList,
    teardown: unwatch
  };
})(window.KT || (window.KT = {}));
