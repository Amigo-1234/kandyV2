/* ==========================================================================
   Kandy's Treats — Admin chat inbox
   --------------------------------------------------------------------------
   Staff+ answer customers here. It reuses js/services/chat.js — the same
   client, session and realtime channel the storefront panel uses.

   Nothing about "who is staff" is decided in this file. RLS admits an admin
   tier to every conversation via is_admin(); a customer running the same
   query sees only their own row. The reply's sender_role is stamped by the
   database from the caller's JWT, so a forged role never lands.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};
  KT.admin.views = KT.admin.views || {};

  var state = { convs: [], activeId: null, msgs: [], loading: true, error: null, names: {} };
  var stop = null;

  function clock(d) {
    if (!d) return "";
    var t = new Date(d);
    var today = new Date();
    var sameDay = t.toDateString() === today.toDateString();
    return sameDay ? t.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })
                   : t.toLocaleDateString("en-NG", { day: "2-digit", month: "short" });
  }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function who(conv) {
    return state.names[conv.user_id] || "Customer " + String(conv.user_id).slice(0, 8);
  }

  function listHTML() {
    if (!state.convs.length) {
      return '<p class="achat__empty">No conversations yet. When a customer opens Live Chat ' +
why()  + "</p>";
    }
    return state.convs.map(function (c) {
      return '<button class="achat__item' + (c.id === state.activeId ? " is-active" : "") +
        '" type="button" data-conv="' + c.id + '">' +
        '<span class="achat__avatar">' + esc(who(c).slice(0, 2).toUpperCase()) + "</span>" +
        '<span class="achat__meta"><strong>' + esc(who(c)) + "</strong>" +
        "<span>" + clock(c.last_message_at) + "</span></span>" +
        (Number(c.admin_unread) ? '<span class="achat__unread">' + c.admin_unread + "</span>" : "") +
        "</button>";
    }).join("");
  }
  function why() { return " on the storefront, it appears here."; }

  function threadHTML() {
    if (!state.activeId) {
      return '<div class="achat__placeholder">' + KT.icon("mail", 30) +
        "<p>Choose a conversation to read and reply.</p></div>";
    }
    if (!state.msgs.length) {
      return '<div class="achat__placeholder">' + KT.icon("sparkle", 30) +
        "<p>No messages in this conversation yet.</p></div>";
    }
    return state.msgs.map(function (m) {
      var mine = m.fromStaff;      /* staff replies sit on the right here */
      return '<div class="chat__row ' + (mine ? "is-mine" : "is-them") + '">' +
        '<div class="chat__bubble">' +
          (mine ? '<span class="chat__who">' + esc(m.senderRole) + "</span>" : "") +
          '<span class="chat__body">' + esc(m.body) + "</span>" +
          '<time class="chat__time">' + clock(m.createdAt) + "</time>" +
        "</div></div>";
    }).join("");
  }

  function paint() {
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    KT.mount(host,
      '<header class="apage__head"><div><h1>Live chat</h1>' +
        '<p class="apage__lede">Customer conversations, in real time. Replies are sent as your ' +
        "role — the database stamps it, not the browser.</p></div></header>" +
      (state.error
        ? '<div class="panel apanel"><div class="empty"><div class="empty__art">' +
          KT.icon("close", 32) + "</div><h3>Could not load conversations</h3><p>" +
          esc(state.error) + '</p><button class="btn btn--soft" type="button" data-chat-reload>' +
          "Try again</button></div></div>"
        : state.loading
          ? '<div class="panel apanel">' + KT.loadingLabel("Loading conversations…") +
            KT.skeleton.lines(5) + "</div>"
          : '<div class="achat">' +
              '<aside class="achat__list" data-achat-list>' + listHTML() + "</aside>" +
              '<section class="achat__thread">' +
                '<div class="achat__scroll" data-achat-thread>' + threadHTML() + "</div>" +
                (state.activeId
                  ? '<form class="chat__compose" data-achat-form>' +
                      '<input class="chat__input" name="body" autocomplete="off" ' +
                        'placeholder="Reply to the customer…" aria-label="Reply">' +
                      '<button class="chat__send btn btn--primary" type="submit" aria-label="Send">' +
                        KT.icon("arrowRight", 18) + "</button></form>"
                  : "") +
              "</section>" +
            "</div>"));
    var sc = KT.qs("[data-achat-thread]");
    if (sc) sc.scrollTop = sc.scrollHeight;
  }

  async function loadNames() {
    /* Reuses the customers RPC, which already redacts by tier — staff get a
       display name, never an email. Imported the same way customers.js does
       it, since the admin services are not published on KT.services. */
    try {
      var svc = await import("../services/admin-customers.js");
      var res = await svc.adminCustomerService.list({ limit: 200, offset: 0 });
      (res.rows || []).forEach(function (r) {
        state.names[r.id] = r.display_name || r.name || "";
      });
    } catch (e) { /* names are a nicety; the inbox works without them */ }
  }

  async function load() {
    state.loading = true; state.error = null; paint();
    try {
      state.convs = await KT.services.chat.allConversations({ limit: 100 });
      await loadNames();
      state.loading = false;
      paint();
      stop = KT.services.chat.subscribeAll(async function (m) {
        if (m.conversationId === state.activeId) {
          if (!state.msgs.some(function (x) { return x.id === m.id; })) state.msgs.push(m);
        }
        state.convs = await KT.services.chat.allConversations({ limit: 100 });
        paint();
      });
    } catch (error) {
      state.loading = false;
      state.error = KT.services.errorMessage(error);
      paint();
    }
  }

  async function openConv(id) {
    state.activeId = id;
    try {
      state.msgs = await KT.services.chat.messages(id);
      paint();
      await KT.services.chat.markRead(id, "admin").catch(function () {});
      var c = state.convs.filter(function (x) { return x.id === id; })[0];
      if (c) c.admin_unread = 0;
      paint();
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error");
    }
  }

  document.addEventListener("click", function (e) {
    var item = e.target.closest("[data-conv]");
    if (item) { e.preventDefault(); openConv(item.getAttribute("data-conv")); return; }
    if (e.target.closest("[data-chat-reload]")) { e.preventDefault(); load(); }
  });

  document.addEventListener("submit", async function (e) {
    var form = e.target.closest("[data-achat-form]");
    if (!form) return;
    e.preventDefault();
    var input = KT.qs(".chat__input", form);
    var text = input.value.trim();
    if (!text || !state.activeId) return;
    var done = KT.busy(KT.qs(".chat__send", form), "");
    input.value = "";
    try {
      var sent = await KT.services.chat.send(state.activeId, text);
      if (!state.msgs.some(function (x) { return x.id === sent.id; })) state.msgs.push(sent);
      paint();
    } catch (error) {
      input.value = text;
      KT.toast(KT.services.errorMessage(error), "error", { duration: 5000 });
    } finally {
      if (done) done();
      var i2 = KT.qs(".chat__input");
      if (i2) i2.focus();
    }
  });

  KT.admin.views.chat = function () {
    state = { convs: [], activeId: null, msgs: [], loading: true, error: null, names: {} };
    /* Defer: the shell mounts whatever this returns, so painting synchronously
       from load() would be wiped a moment later. Hand back the skeleton and
       let the first real paint land after the mount. */
    window.setTimeout(load, 0);
    return '<header class="apage__head"><div><h1>Live chat</h1>' +
      '<p class="apage__lede">Customer conversations, in real time.</p></div></header>' +
      '<div class="panel apanel">' + KT.loadingLabel("Loading conversations…") +
      KT.skeleton.lines(5) + "</div>";
  };

  /* The shell calls this when navigating away — the channel must not leak. */
  KT.admin.views.chatTeardown = function () {
    if (stop) { stop(); stop = null; }
  };
})(window.KT || (window.KT = {}));
