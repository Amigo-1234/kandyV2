/* ==========================================================================
   Kandy's Treats — Admin shell
   --------------------------------------------------------------------------
   Boot order, and why it is this way:

     1. The page paints a skeleton immediately. Nothing signed-out, nothing
        unauthorised and nothing customer-facing renders first.
     2. The shared service layer resolves the Supabase session — the SAME auth
        system the storefront uses. There is no second login here.
     3. The role is read from public.profiles through RLS. A customer can read
        only their own row, and `role` has no UPDATE grant for any client, so
        the value cannot be forged from the browser.
     4. Only then is the shell rendered, filtered to that role.

   The filtering is cosmetic. Every screen built on this shell is gated in the
   database by RLS or a SECURITY DEFINER RPC, so hand-editing the hash reaches
   a view whose requests are still refused.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var state = { role: null, name: "", email: "", ready: false };
  /* Unread counts for the nav badges. Read from admin_support_unread(), which
     sums counters the database already maintains — this is a mirror, never a
     second tally. */
  var unread = { support: 0 };
  var notifySvc = null;
  var stopUnread = null;

  /* Modules ask the shell what tier the caller is, so role-dependent UI has a
     single source. It is presentation only — every restricted operation is
     re-checked server-side regardless of what this returns. */
  KT.admin.currentRole = function () { return state.role; };

  function root() { return KT.qs("[data-admin-root]"); }

  /* ---- States before the app is allowed to render ---------------------- */

  function renderSkeleton() {
    KT.mount(root(),
      '<div class="adminboot" data-admin-boot>' +
        '<div class="adminboot__bar"></div>' +
        '<p class="adminboot__msg">Checking your access…</p>' +
      "</div>");
  }

  function renderGate(opts) {
    KT.mount(root(),
      '<div class="agate">' +
        '<div class="agate__card">' +
          '<span class="agate__mark">' + KT.icon(opts.icon || "lock", 30) + "</span>" +
          "<h1>" + opts.title + "</h1>" +
          "<p>" + opts.body + "</p>" +
          '<div class="agate__actions">' + (opts.actions || "") + "</div>" +
        "</div>" +
      "</div>");
  }

  function gateSignedOut() {
    renderGate({
      icon: "lock",
      title: "Admin sign-in required",
      body: "This area is for Kandy's Treats staff. Sign in with your staff account to continue.",
      actions:
        '<a class="btn btn--primary" href="' + KT.url("pages/login.html") + '">Sign in</a>' +
        '<a class="btn btn--ghost" href="' + KT.url("index.html") + '">Back to the site</a>'
    });
  }

  function gateNotStaff() {
    renderGate({
      icon: "user",
      title: "You do not have admin access",
      body: "This account is a customer account. If you should have staff access, " +
            "ask the owner to grant it.",
      actions:
        '<a class="btn btn--primary" href="' + KT.url("pages/account.html") + '">Go to my account</a>' +
        '<a class="btn btn--ghost" href="#" data-admin-signout>Sign out</a>'
    });
  }

  function gateError(message) {
    renderGate({
      icon: "close",
      title: "We could not confirm your access",
      body: message || "Something went wrong while checking your role. Try again in a moment.",
      actions: '<button class="btn btn--primary" type="button" data-admin-retry>Try again</button>'
    });
  }

  /* ---- Shell ----------------------------------------------------------- */

  function navHTML() {
    return KT.admin.navFor(state.role).map(function (g) {
      return '<div class="anav__group"><p class="anav__title">' + g.group + "</p>" +
        g.items.map(function (i) {
          return '<a class="anav__link" href="#/' + i.id + '" data-nav="' + i.id + '">' +
            '<span class="anav__icon">' + KT.icon(i.icon, 18) + "</span>" + i.label +
            (i.badge
              ? '<span class="anav__badge" data-nav-badge="' + i.badge + '" hidden>0</span>'
              : "") + "</a>";
        }).join("") + "</div>";
    }).join("");
  }

  function renderShell() {
    KT.mount(root(),
      '<div class="ashell">' +
        '<aside class="ashell__side" data-admin-side>' +
          '<div class="asidehead">' +
            '<a class="asidehead__brand" href="' + KT.url("index.html") + '">' +
              "<strong>Kandy's</strong><span>Admin</span></a>" +
            '<button class="icon-btn asidehead__close" type="button" data-admin-nav-close ' +
              'aria-label="Close navigation">' + KT.icon("close", 20) + "</button>" +
          "</div>" +
          '<nav class="anav" aria-label="Admin">' + navHTML() + "</nav>" +
          '<div class="asidefoot">' +
            '<a class="anav__link" href="' + KT.url("index.html") + '">' +
              '<span class="anav__icon">' + KT.icon("home", 18) + "</span>View storefront</a>" +
            '<a class="anav__link is-danger" href="#" data-admin-signout>' +
              '<span class="anav__icon">' + KT.icon("logout", 18) + "</span>Sign out</a>" +
          "</div>" +
        "</aside>" +

        '<div class="ashell__scrim" data-admin-nav-close hidden></div>' +

        '<div class="ashell__main">' +
          '<header class="atop">' +
            '<button class="icon-btn atop__burger" type="button" data-admin-nav-open ' +
              'aria-label="Open navigation" aria-expanded="false">' + KT.icon("menu", 22) + "</button>" +
            '<h2 class="atop__title" data-admin-title>Dashboard</h2>' +
            '<div class="atop__right">' +
              /* Filled in by paintPushControl() once the browser has been
                 asked what it supports — rendered empty rather than
                 optimistically, so it never offers something that will fail. */
              '<span data-admin-notif></span>' +
              '<span data-admin-push></span>' +
              '<span data-admin-sound></span>' +
              '<button class="icon-btn" type="button" data-theme-toggle aria-label="Switch theme"></button>' +
              '<div class="auser">' +
                '<span class="auser__avatar">' + initials(state.name || state.email) + "</span>" +
                '<span class="auser__meta"><strong>' + (state.name || state.email) + "</strong>" +
                  '<span class="rolebadge rolebadge--' + state.role + '">' + state.role + "</span></span>" +
              "</div>" +
            "</div>" +
          "</header>" +
          '<main class="apage" id="adminMain" data-admin-page></main>' +
        "</div>" +
      "</div>");

    if (KT.theme) KT.theme.paintToggles();
    route();
    watchUnread();
    /* Handlers only: the alert feed reads admin_* notifications, which the
       database only ever addresses to operational roles. */
    if (KT.admin.notifications) KT.admin.notifications.start();
    if (KT.admin.alerts) { KT.admin.alerts.start(); KT.admin.alerts.paintControls(); }
    refreshPushState();
  }

  function initials(v) {
    return String(v || "K").split(/[\s@.]+/).filter(Boolean)
      .map(function (n) { return n[0]; }).join("").slice(0, 2).toUpperCase();
  }

  /* ---- Routing --------------------------------------------------------- */

  function currentId() {
    var h = (window.location.hash || "").replace(/^#\/?/, "").split("?")[0];
    return h || "dashboard";
  }

  var lastView = null;

  /* Releasing the current view's subscriptions and transient state. Pulled out
     of route() because navigation is not the only way a view stops being
     shown: signing out replaces the whole shell with a gate, and the module
     that was mounted would otherwise keep its realtime channel open against a
     session that no longer exists. */
  function teardownView() {
    if (!lastView) return;
    var teardown = KT.admin.views[lastView + "Teardown"];
    if (typeof teardown === "function") teardown();
    lastView = null;
  }

  function route() {
    if (!state.ready) return;
    var id = currentId();

    /* Tear down on EVERY re-entry, not only when the id changes. Navigating
       #/orders -> #/orders?status=Out, or clicking Dashboard while already on
       it, re-runs the view's mount — which is where modules open their
       realtime channels. Without this, same-route navigation was the one path
       that could stack a duplicate subscription. */
    teardownView();
    lastView = id;
    var host = KT.qs("[data-admin-page]");
    if (!host) return;

    var ctx = { role: state.role, name: state.name, email: state.email };
    var item = KT.admin.itemById(id);

    if (!item || !KT.admin.canOpen(state.role, id)) {
      /* Reached by hand-editing the hash. The view says no, and so would the
         database if the module behind it tried to read anything. */
      KT.mount(host, KT.admin.views.forbidden(ctx, id));
      setTitle(item ? item.label : "Not found");
    } else if (typeof KT.admin.views[id] === "function") {
      /* A real module. Its own view owns the content from here. */
      KT.mount(host, KT.admin.views[id](ctx));
      setTitle(item.label);
    } else {
      KT.mount(host, KT.admin.views.placeholder(ctx, item));
      setTitle(item.label);
    }

    KT.qsa("[data-nav]").forEach(function (a) {
      var on = a.getAttribute("data-nav") === id;
      a.classList.toggle("is-active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    closeNav();
    host.scrollTop = 0;
  }

  function setTitle(label) {
    var el = KT.qs("[data-admin-title]");
    if (el) el.textContent = label;
    document.title = label + " — Kandy's Admin";
  }

  function openNav() {
    var s = KT.qs("[data-admin-side]"), sc = KT.qs(".ashell__scrim");
    if (!s) return;
    s.classList.add("is-open");
    if (sc) sc.hidden = false;
    var b = KT.qs("[data-admin-nav-open]");
    if (b) b.setAttribute("aria-expanded", "true");
  }
  function closeNav() {
    var s = KT.qs("[data-admin-side]"), sc = KT.qs(".ashell__scrim");
    if (!s) return;
    s.classList.remove("is-open");
    if (sc) sc.hidden = true;
    var b = KT.qs("[data-admin-nav-open]");
    if (b) b.setAttribute("aria-expanded", "false");
  }

  /* ---- Unread badges --------------------------------------------------- */

  function paintBadges() {
    KT.qsa("[data-nav-badge]").forEach(function (b) {
      var n = unread[b.getAttribute("data-nav-badge")] || 0;
      b.textContent = n > 99 ? "99+" : String(n);
      b.hidden = n === 0;
    });
  }

  async function refreshUnread() {
    if (!state.ready || !notifySvc) return;
    try {
      var u = await notifySvc.unread();
      /* One number for the Support item: conversations waiting plus tickets
         still open. Both are things a person has to answer. */
      unread.support = (Number(u.chat_conversations) || 0) + (Number(u.open_tickets) || 0);
    } catch (error) {
      unread.support = 0;      /* a refused count must not break the shell */
    }
    paintBadges();
  }

  async function watchUnread() {
    if (stopUnread) return;
    try {
      if (!notifySvc) {
        notifySvc = (await import("../services/admin-notify.js")).adminNotifyService;
      }
      await refreshUnread();
      stopUnread = notifySvc.subscribe(refreshUnread);
    } catch (error) {
      /* Realtime is a convenience. Without it the counts simply do not move
         until the next navigation, which is better than a broken shell. */
    }
  }

  function unwatchUnread() {
    if (stopUnread) { stopUnread(); stopUnread = null; }
    unread.support = 0;
  }

  /* ---- Order alerts ------------------------------------------------------ */

  var pushState = { checked: false, supported: false, enabled: false, reason: null, busy: false };

  function paintPushControl() {
    var slot = KT.qs("[data-admin-push]");
    if (!slot) return;
    if (!pushState.checked || !pushState.supported) { slot.innerHTML = ""; return; }
    slot.innerHTML = pushState.enabled
      ? '<button class="icon-btn apush is-on" type="button" data-admin-push-off ' +
        'aria-label="Order alerts are on" title="Order alerts are on — click to turn off">' +
        KT.icon("bell", 20) + "</button>"
      : '<button class="btn btn--soft btn--sm apush" type="button" data-admin-push-on' +
        (pushState.busy ? " disabled" : "") + ' title="Get notified about new orders even when this tab is closed">' +
        KT.icon("bell", 15) + (pushState.busy ? "Enabling…" : "Order alerts") + "</button>";
  }

  async function refreshPushState() {
    if (!KT.services || !KT.services.push) return;
    try {
      var s = KT.services.push.support();
      pushState.supported = s.supported;
      pushState.reason = s.reason;
      pushState.enabled = s.supported && s.permission === "granted" &&
        await KT.services.push.isEnabled();
    } catch (error) {
      pushState.supported = false;
    }
    pushState.checked = true;
    paintPushControl();
  }

  /* ---- Authorisation --------------------------------------------------- */

  async function resolveAccess() {
    if (!KT.services || !KT.auth) return;             /* services not up yet */

    if (!KT.auth.isSignedIn()) {
      state.ready = false;
      teardownView();
      unwatchUnread();                 /* no channel may outlive the session */
      if (KT.admin.alerts) KT.admin.alerts.stop();
      if (KT.admin.notifications) KT.admin.notifications.stop();
      gateSignedOut();
      return;
    }

    var profile;
    try {
      profile = await KT.services.account.profile();
    } catch (error) {
      state.ready = false;
      teardownView();
      gateError(KT.services.errorMessage ? KT.services.errorMessage(error) : "");
      return;
    }

    var user = KT.auth.user() || {};
    state.role  = (profile && profile.role) || "customer";
    state.name  = (profile && profile.displayName) || user.displayName || "";
    state.email = (profile && profile.email) || user.email || "";

    if (KT.admin.rank(state.role) < KT.admin.rank("staff")) {
      state.ready = false;
      teardownView();
      unwatchUnread();
      if (KT.admin.alerts) KT.admin.alerts.stop();
      if (KT.admin.notifications) KT.admin.notifications.stop();
      gateNotStaff();
      return;
    }

    state.ready = true;
    renderShell();
  }

  /* ---- Wiring ---------------------------------------------------------- */

  document.addEventListener("click", async function (e) {
    if (e.target.closest("[data-admin-nav-open]"))  { e.preventDefault(); openNav(); }
    if (e.target.closest("[data-admin-nav-close]")) { e.preventDefault(); closeNav(); }
    if (e.target.closest("[data-admin-retry]"))     { e.preventDefault(); renderSkeleton(); resolveAccess(); }

    if (e.target.closest("[data-admin-push-on]")) {
      e.preventDefault();
      pushState.busy = true; paintPushControl();
      var res = await KT.services.push.enable();
      pushState.busy = false;
      pushState.enabled = !!res.ok;
      paintPushControl();
      KT.toast(res.ok
        ? "Order alerts on. You will hear about new orders with this tab closed."
        : "Could not enable order alerts (" + res.reason + "). Sounds and on-screen alerts still work.",
        res.ok ? "success" : "error", { duration: 6000 });
      return;
    }
    if (e.target.closest("[data-admin-push-off]")) {
      e.preventDefault();
      var off = await KT.services.push.disable();
      pushState.enabled = !off.ok;
      paintPushControl();
      KT.toast(off.ok ? "Order alerts off for this device." : "Could not turn alerts off.",
        off.ok ? "success" : "error");
      return;
    }
    if (e.target.closest("[data-admin-signout]")) {
      e.preventDefault();
      teardownView();
      unwatchUnread();
      if (KT.admin.alerts) KT.admin.alerts.stop();
      if (KT.admin.notifications) KT.admin.notifications.stop();
      if (KT.auth) await KT.auth.signOut();
      window.location.href = KT.url("index.html");
    }
  });

  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeNav(); });
  window.addEventListener("hashchange", route);
  /* Reading a conversation clears admin_unread server-side, so the badge is
     stale the moment Support is left. */
  window.addEventListener("hashchange", refreshUnread);
  window.addEventListener("pagehide", unwatchUnread);

  /* Re-resolve on every auth signal: a sign-out in another tab must drop the
     shell back to the gate rather than leave it on screen. */
  document.addEventListener("kt:auth", resolveAccess);
  document.addEventListener("kt:services", resolveAccess);

  /* The admin does not load js/app.js, so it registers the worker itself.
     Handlers need push for exactly the same reason customers do: to hear
     about a new order when the admin tab is closed. */
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register(KT.url("sw.js"), { scope: "/" })
      .catch(function (error) {
        console.warn("[Kandy's] admin service worker not registered:", error && error.message);
      });
  }

  renderSkeleton();
  if (KT.services) resolveAccess();
})(window.KT || (window.KT = {}));
