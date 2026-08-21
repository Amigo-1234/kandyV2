/* ==========================================================================
   Kandy's Treats — Support inbox (Live Chat)
   --------------------------------------------------------------------------
   Staff+ answer customers here. It is the SAME chat system the storefront
   panel uses — js/services/chat.js owns reading a thread, sending, and the
   realtime channel. Nothing about messaging is reimplemented in this file.

   WHAT CHANGED IN PHASE 12
   ------------------------
   The list. It used to render name, time and unread as adjacent inline spans
   with no structure, which is why a row read as
   "CU Customer 5125702f20 Aug Olamide Muftau 20 Aug" — three unrelated facts
   with nothing to separate them. It also fetched every conversation and then
   called the customers RPC with limit 200 purely to resolve names, so it had
   no search, no filter and no paging.

   Now: admin_chat_inbox() returns the join, the search and the page from
   Postgres, and each conversation is a row with an avatar, a name, a preview,
   a time and an unread pill in fixed positions.

   ROLE
   ----
   Not decided here. RLS admits an admin tier to every conversation through
   is_admin(); a customer running the same query sees only their own. Email is
   redacted server-side for staff and supervisor, exactly as
   admin_list_customers() does it — this file renders whatever it is given and
   shows the name alone when there is no address.

   The reply's sender_role is stamped by the database from the caller's JWT.
   A forged role never lands, so nothing here needs to police it.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};
  KT.admin.views = KT.admin.views || {};

  var svc = null;              /* admin-support.js, for the inbox RPC */
  var custSvc = null;          /* admin-customers.js, for the context panel */

  function blank() {
    return {
      rows: [], total: 0, unreadTotal: 0, canSeeEmail: false,
      loading: true, error: null,
      search: "", filter: "all",
      activeId: null, active: null,
      msgs: [], threadLoading: false, threadError: null,
      sending: false, sendError: null,
      context: null, contextLoading: false,
      mobileThread: false        /* narrow screens: list OR thread, not both */
    };
  }
  var state = blank();

  var stop = null;             /* realtime unsubscribe */
  var searchTimer = null;
  var hostEl = null;           /* the Support Center injects its tab body */

  function host() { return hostEl || KT.qs("[data-admin-page]"); }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function clock(d) {
    if (!d) return "";
    var t = new Date(d);
    var now = new Date();
    if (t.toDateString() === now.toDateString()) {
      return t.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" });
    }
    var y = new Date(); y.setDate(now.getDate() - 1);
    if (t.toDateString() === y.toDateString()) return "Yesterday";
    if (now - t < 6 * 864e5) return t.toLocaleDateString("en-NG", { weekday: "short" });
    return t.toLocaleDateString("en-NG", { day: "2-digit", month: "short" });
  }

  function dayLabel(d) {
    if (!d) return "";
    var t = new Date(d), now = new Date();
    var y = new Date(); y.setDate(now.getDate() - 1);
    if (t.toDateString() === now.toDateString()) return "Today";
    if (t.toDateString() === y.toDateString()) return "Yesterday";
    return t.toLocaleDateString("en-NG", { day: "2-digit", month: "short", year: "numeric" });
  }

  function initials(name) {
    var v = String(name || "").trim();
    if (!v) return "??";
    return v.split(/[\s@.]+/).filter(Boolean)
      .map(function (n) { return n[0]; }).join("").slice(0, 2).toUpperCase();
  }

  function nameOf(c) {
    return c.name || "Customer " + String(c.id || "").slice(0, 6);
  }

  /* ---- Conversation list -------------------------------------------------- */

  function filtersHTML() {
    var filters = (svc && svc.CHAT_FILTERS) || [{ id: "all", label: "All" }];
    return (
      '<div class="cinbox__filters">' +
        '<label class="cinbox__search">' +
          '<span class="sr-only">Search conversations</span>' +
          KT.icon("search", 16) +
          '<input class="input" type="search" data-chat-search ' +
            'placeholder="Search by name' + (state.canSeeEmail ? " or email" : "") + '…" ' +
            'value="' + esc(state.search) + '">' +
        "</label>" +
        '<div class="chips cinbox__chips">' +
          filters.map(function (f) {
            var n = f.id === "unread" && state.unreadTotal ? " (" + state.unreadTotal + ")" : "";
            return '<button class="chip' + (state.filter === f.id ? " is-active" : "") +
              '" type="button" data-chat-filter="' + f.id + '">' + esc(f.label) + n + "</button>";
          }).join("") +
        "</div>" +
      "</div>"
    );
  }

  function rowHTML(c) {
    var unread = Number(c.admin_unread) || 0;
    var preview = c.last_body
      ? (c.last_role && c.last_role !== "customer" ? "You: " : "") + c.last_body
      : "No messages yet";
    return (
      '<button class="cconv' + (c.id === state.activeId ? " is-active" : "") +
        (unread ? " is-unread" : "") + '" type="button" data-conv="' + esc(c.id) + '">' +
        '<span class="cconv__avatar">' + esc(initials(nameOf(c))) + "</span>" +
        '<span class="cconv__body">' +
          '<span class="cconv__top">' +
            '<strong class="cconv__name">' + esc(nameOf(c)) + "</strong>" +
            '<time class="cconv__time">' + esc(clock(c.last_message_at || c.created_at)) + "</time>" +
          "</span>" +
          '<span class="cconv__bottom">' +
            '<span class="cconv__preview">' + esc(preview) + "</span>" +
            (unread ? '<span class="cconv__unread">' + (unread > 99 ? "99+" : unread) + "</span>" : "") +
          "</span>" +
          /* Only rendered when the server actually sent one. */
          (c.email ? '<span class="cconv__email">' + esc(c.email) + "</span>" : "") +
        "</span>" +
      "</button>"
    );
  }

  function listHTML() {
    if (state.error) {
      return '<div class="cinbox__state">' +
        '<span class="cinbox__art cinbox__art--bad">' + KT.icon("close", 24) + "</span>" +
        "<h3>Could not load conversations</h3><p>" + esc(state.error) + "</p>" +
        '<button class="btn btn--soft btn--sm" type="button" data-chat-reload>Try again</button></div>';
    }
    if (state.loading && !state.rows.length) {
      return '<div class="cinbox__skeleton">' + KT.skeleton.lines(6) + "</div>";
    }
    if (!state.rows.length) {
      var filtered = state.search || state.filter !== "all";
      return '<div class="cinbox__state">' +
        '<span class="cinbox__art">' + KT.icon(filtered ? "search" : "mail", 24) + "</span>" +
        "<h3>" + (filtered ? "Nothing matches" : "No conversations yet") + "</h3>" +
        "<p>" + (filtered
          ? "Try a different search term or filter."
          : "When a customer opens Live Chat on the storefront, it appears here.") + "</p>" +
        (filtered
          ? '<button class="btn btn--soft btn--sm" type="button" data-chat-clear>Clear filters</button>'
          : "") +
        "</div>";
    }
    return '<div class="cinbox__rows">' + state.rows.map(rowHTML).join("") +
      (state.total > state.rows.length
        ? '<p class="cinbox__more">Showing ' + state.rows.length + " of " + state.total + "</p>"
        : "") + "</div>";
  }

  /* ---- Thread ------------------------------------------------------------- */

  function bubblesHTML() {
    if (state.threadError) {
      return '<div class="cinbox__state">' +
        '<span class="cinbox__art cinbox__art--bad">' + KT.icon("close", 24) + "</span>" +
        "<h3>Could not open this conversation</h3><p>" + esc(state.threadError) + "</p>" +
        '<button class="btn btn--soft btn--sm" type="button" data-chat-retry>Try again</button></div>';
    }
    if (state.threadLoading) {
      return '<div class="cthread__loading">' + KT.loadingLabel("Opening conversation…") +
        KT.skeleton.lines(4) + "</div>";
    }
    if (!state.msgs.length) {
      return '<div class="cinbox__state">' +
        '<span class="cinbox__art">' + KT.icon("sparkle", 24) + "</span>" +
        "<h3>No messages yet</h3><p>Say hello — the customer sees your reply instantly.</p></div>";
    }
    var lastDay = "";
    return state.msgs.map(function (m) {
      var head = "";
      var label = dayLabel(m.createdAt);
      if (label !== lastDay) { lastDay = label; head = '<p class="chat__day">' + esc(label) + "</p>"; }
      var mine = m.fromStaff;
      return head +
        '<div class="chat__row ' + (mine ? "is-mine" : "is-them") + '">' +
          '<div class="chat__bubble">' +
            /* The role shown is the one the DATABASE stamped on the row. */
            (mine ? '<span class="chat__who">' + esc(m.senderRole) + "</span>" : "") +
            '<span class="chat__body">' + esc(m.body) + "</span>" +
            '<time class="chat__time">' + esc(clock(m.createdAt)) + "</time>" +
          "</div></div>";
    }).join("");
  }

  function contextHTML() {
    var c = state.context;
    if (state.contextLoading) {
      return '<div class="cctx">' + KT.skeleton.lines(3) + "</div>";
    }
    if (!c) return "";
    var p = c.profile || {};
    var orders = c.orders || [];
    return (
      '<div class="cctx">' +
        '<div class="cctx__facts">' +
          (p.phone ? '<span class="cctx__fact">' + KT.icon("phone", 14) +
            esc(KT.rules.displayPhone(p.phone)) + "</span>" : "") +
          /* email is null for staff and supervisor — the RPC decided that. */
          (p.email ? '<span class="cctx__fact">' + KT.icon("mail", 14) + esc(p.email) + "</span>" : "") +
          '<span class="cctx__fact">' + KT.icon("receipt", 14) + orders.length +
            " order" + (orders.length === 1 ? "" : "s") + "</span>" +
        "</div>" +
        (orders.length
          ? '<div class="cctx__orders">' + orders.slice(0, 3).map(function (o) {
              return '<a class="cctx__order" href="#/orders?code=' + encodeURIComponent(o.code) + '">' +
                "<strong>" + esc(o.code) + "</strong>" +
                '<span class="obadge ' + (o.status === "Completed" ? "is-completed"
                  : o.status === "Cancelled" ? "is-cancelled" : "is-out") + '">' +
                  esc(o.status) + "</span>" +
                "<span>" + KT.naira(o.total) + "</span></a>";
            }).join("") + "</div>"
          : "") +
      "</div>"
    );
  }

  function threadHTML() {
    if (!state.activeId) {
      return '<div class="cinbox__state cinbox__state--placeholder">' +
        '<span class="cinbox__art">' + KT.icon("mail", 26) + "</span>" +
        "<h3>Choose a conversation</h3>" +
        "<p>Pick someone on the left to read the thread and reply.</p></div>";
    }
    var c = state.active || {};
    return (
      '<header class="cthread__head">' +
        '<button class="icon-btn cthread__back" type="button" data-chat-back ' +
          'aria-label="Back to conversations">' + KT.icon("arrowLeft", 20) + "</button>" +
        '<span class="cconv__avatar">' + esc(initials(nameOf(c))) + "</span>" +
        '<span class="cthread__who"><strong>' + esc(nameOf(c)) + "</strong>" +
          (c.email ? "<span>" + esc(c.email) + "</span>" : "") + "</span>" +
        (state.context && (state.context.orders || []).length
          ? '<a class="btn btn--ghost btn--sm cthread__profile" href="#/customers">' +
            "Customer</a>"
          : "") +
      "</header>" +
      contextHTML() +
      '<div class="cthread__scroll" data-cthread>' + bubblesHTML() + "</div>" +
      (state.sendError
        ? '<p class="cthread__error">' + KT.icon("close", 14) + esc(state.sendError) + "</p>"
        : "") +
      '<form class="chat__compose cthread__compose" data-cchat-form>' +
        '<input class="chat__input" name="body" autocomplete="off" ' +
          'placeholder="Reply to ' + esc(nameOf(c)) + '…" aria-label="Reply">' +
        '<button class="chat__send btn btn--primary" type="submit" aria-label="Send">' +
          KT.icon("arrowRight", 18) + "</button>" +
      "</form>"
    );
  }

  /* ---- Paint -------------------------------------------------------------- */

  function paint() {
    var el = host();
    if (!el) return;
    KT.mount(el,
      (hostEl ? "" :
        '<header class="apage__head"><div><h1>Live chat</h1>' +
        '<p class="apage__lede">Customer conversations, in real time.</p></div></header>') +
      '<div class="cinbox' + (state.mobileThread ? " is-thread" : "") + '">' +
        '<aside class="cinbox__list">' + filtersHTML() + listHTML() + "</aside>" +
        '<section class="cthread">' + threadHTML() + "</section>" +
      "</div>");
    var sc = KT.qs("[data-cthread]");
    if (sc) sc.scrollTop = sc.scrollHeight;
  }

  /* Repaint only the list, so typing in the search box never loses the caret
     and an incoming message cannot steal focus from the reply field. */
  function paintList() {
    var el = KT.qs(".cinbox__list");
    if (!el) return paint();
    var box = KT.qs("[data-chat-search]");
    var focused = document.activeElement === box;
    var caret = focused && box ? box.selectionStart : null;
    el.innerHTML = filtersHTML() + listHTML();
    if (focused) {
      var again = KT.qs("[data-chat-search]");
      if (again) { again.focus(); if (caret != null) again.setSelectionRange(caret, caret); }
    }
  }

  function paintThread() {
    var el = KT.qs(".cthread");
    if (!el) return paint();
    var box = KT.qs(".cthread__compose .chat__input");
    var kept = box ? box.value : "";
    var focused = document.activeElement === box;
    el.innerHTML = threadHTML();
    var again = KT.qs(".cthread__compose .chat__input");
    if (again) { again.value = kept; if (focused) again.focus(); }
    var sc = KT.qs("[data-cthread]");
    if (sc) sc.scrollTop = sc.scrollHeight;
  }

  /* ---- Data --------------------------------------------------------------- */

  async function ensureSvc() {
    if (!svc) svc = (await import("../services/admin-support.js")).adminSupportService;
    return svc;
  }

  async function loadInbox(opts) {
    opts = opts || {};
    await ensureSvc();
    if (!opts.quiet) { state.loading = true; state.error = null; paintList(); }
    try {
      var res = await svc.inbox({ search: state.search, filter: state.filter, limit: 40 });
      state.rows = res.rows || [];
      state.total = res.total || 0;
      state.unreadTotal = res.unread_total || 0;
      state.canSeeEmail = !!res.can_see_email;
      /* Keep the open conversation's header in step with the refreshed row. */
      if (state.activeId) {
        var found = state.rows.filter(function (r) { return r.id === state.activeId; })[0];
        if (found) state.active = found;
      }
      state.error = null;
    } catch (error) {
      if (!state.rows.length) {
        state.error = (KT.services && KT.services.errorMessage)
          ? KT.services.errorMessage(error) : String(error.message || error);
      }
    }
    state.loading = false;
    paintList();
  }

  async function openConv(id) {
    state.activeId = id;
    state.active = state.rows.filter(function (r) { return r.id === id; })[0] || null;
    state.msgs = [];
    state.threadLoading = true;
    state.threadError = null;
    state.sendError = null;
    state.mobileThread = true;
    state.context = null;
    paint();

    try {
      state.msgs = await KT.services.chat.messages(id);
      state.threadLoading = false;
      paintThread();

      /* Clearing MY badge only. 0031 refuses any attempt on the other side. */
      await KT.services.chat.markRead(id, "admin").catch(function () {});
      if (state.active) state.active.admin_unread = 0;
      var row = state.rows.filter(function (r) { return r.id === id; })[0];
      if (row) row.admin_unread = 0;
      state.unreadTotal = state.rows.reduce(function (n, r) {
        return n + (Number(r.admin_unread) || 0); }, 0);
      paintList();

      loadContext(state.active && state.active.user_id);
    } catch (error) {
      state.threadLoading = false;
      state.threadError = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
      paintThread();
    }
  }

  /**
   * Customer context beside the thread. Reuses admin_get_customer through the
   * existing customers service, which already redacts email, spend and
   * addresses by tier — so nothing new had to be granted to show it here.
   */
  async function loadContext(userId) {
    if (!userId) return;
    state.contextLoading = true;
    paintThread();
    try {
      if (!custSvc) custSvc = (await import("../services/admin-customers.js")).adminCustomerService;
      state.context = await custSvc.get(userId);
    } catch (error) {
      state.context = null;      /* context is a nicety; the thread still works */
    }
    state.contextLoading = false;
    paintThread();
  }

  /* ---- Realtime ----------------------------------------------------------- */

  function startWatch() {
    if (stop) return;
    stop = KT.services.chat.subscribeAll(function (m) {
      /* The open thread, if this belongs to it. */
      if (m.conversationId === state.activeId) {
        if (!state.msgs.some(function (x) { return x.id === m.id; })) {
          state.msgs.push(m);
          paintThread();
        }
        /* Reading it as it arrives keeps the badge honest. */
        if (m.fromStaff === false) {
          KT.services.chat.markRead(state.activeId, "admin").catch(function () {});
        }
      }
      /* The list: re-read so ordering, previews and unread all come from the
         server rather than being patched together here. */
      loadInbox({ quiet: true });
    });
  }

  function stopWatch() {
    if (stop) { stop(); stop = null; }
    window.clearTimeout(searchTimer);
  }

  /* ---- Events ------------------------------------------------------------- */

  document.addEventListener("click", function (e) {
    var item = e.target.closest("[data-conv]");
    if (item) { e.preventDefault(); openConv(item.getAttribute("data-conv")); return; }

    if (e.target.closest("[data-chat-back]")) {
      e.preventDefault();
      state.mobileThread = false;
      paint();
      return;
    }
    if (e.target.closest("[data-chat-reload]")) { e.preventDefault(); loadInbox(); return; }
    if (e.target.closest("[data-chat-retry]")) {
      e.preventDefault();
      if (state.activeId) openConv(state.activeId);
      return;
    }
    if (e.target.closest("[data-chat-clear]")) {
      e.preventDefault();
      state.search = ""; state.filter = "all";
      loadInbox();
      return;
    }
    var f = e.target.closest("[data-chat-filter]");
    if (f) {
      e.preventDefault();
      state.filter = f.getAttribute("data-chat-filter");
      loadInbox();
    }
  });

  document.addEventListener("input", function (e) {
    var box = e.target.closest("[data-chat-search]");
    if (!box) return;
    state.search = box.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(function () { loadInbox({ quiet: true }); }, 300);
  });

  document.addEventListener("submit", async function (e) {
    var form = e.target.closest("[data-cchat-form]");
    if (!form || !state.activeId) return;
    e.preventDefault();
    var input = KT.qs(".chat__input", form);
    var text = input.value.trim();
    if (!text) return;

    var done = KT.busy(KT.qs(".chat__send", form), "");
    input.value = "";
    state.sendError = null;
    try {
      var sent = await KT.services.chat.send(state.activeId, text);
      if (!state.msgs.some(function (x) { return x.id === sent.id; })) state.msgs.push(sent);
      paintThread();
      loadInbox({ quiet: true });
    } catch (error) {
      /* Never lose what was typed. */
      state.sendError = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
      paintThread();
      var again = KT.qs(".cthread__compose .chat__input");
      if (again) { again.value = text; again.focus(); }
    } finally {
      if (done) done();
    }
  });

  /* ---- Mount -------------------------------------------------------------- */

  async function boot() {
    await ensureSvc();
    await loadInbox();
    startWatch();
  }

  /* Embeddable panel — the Support Center's Live Chat tab uses this, so there
     is exactly one chat implementation on the admin side. */
  KT.admin.chatPanel = {
    mount: function (el) {
      hostEl = el;
      state = blank();
      paint();
      boot();
    },
    teardown: function () {
      stopWatch();
      hostEl = null;
      state = blank();
    }
  };

  KT.admin.views.chat = function () {
    state = blank();
    window.setTimeout(boot, 0);
    return '<header class="apage__head"><div><h1>Live chat</h1>' +
      '<p class="apage__lede">Customer conversations, in real time.</p></div></header>' +
      '<div class="cinbox"><aside class="cinbox__list">' +
      KT.skeleton.lines(6) + '</aside><section class="cthread"></section></div>';
  };

  /* The shell calls this when navigating away — the channel must not leak. */
  KT.admin.views.chatTeardown = function () {
    stopWatch();
    state = blank();
  };
})(window.KT || (window.KT = {}));
