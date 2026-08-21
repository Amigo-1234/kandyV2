/* ==========================================================================
   Kandy's Treats — Live chat panel (customer side)
   --------------------------------------------------------------------------
   A WhatsApp-shaped thread that never leaves the site. Mounted lazily: the
   markup is only built the first time someone opens it, so every other page
   pays nothing for it.

   The panel is presentation only. It cannot decide who it is talking as —
   sender_role is stamped by the database — and it cannot see another
   customer's thread, because RLS scopes the query, not this file.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.components = KT.components || {};

  var state = { mounted: false, open: false, conv: null, msgs: [], busy: false, error: null };
  var unsubscribe = null;

  /* ---- Time -------------------------------------------------------------- */

  function clock(d) {
    if (!d) return "";
    return d.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" });
  }

  function dayLabel(d) {
    if (!d) return "";
    var today = new Date();
    var y = new Date(); y.setDate(today.getDate() - 1);
    var same = function (a, b) { return a.toDateString() === b.toDateString(); };
    if (same(d, today)) return "Today";
    if (same(d, y)) return "Yesterday";
    return d.toLocaleDateString("en-NG", { day: "2-digit", month: "short" });
  }

  /* ---- Render ------------------------------------------------------------ */

  function threadHTML() {
    if (state.error) {
      return '<div class="chat__state"><span class="chat__stateicon">' + KT.icon("close", 26) + "</span>" +
        "<p>" + state.error + "</p>" +
        '<button class="btn btn--soft btn--sm" type="button" data-chat-retry>Try again</button></div>';
    }
    if (state.busy && !state.msgs.length) {
      return '<div class="chat__state">' + KT.spinner(22) + "<p>Opening your conversation…</p></div>";
    }
    if (!state.msgs.length) {
      return '<div class="chat__state"><span class="chat__stateicon">' + KT.icon("sparkle", 26) + "</span>" +
        "<p><strong>Say hello</strong><br>Ask about an order, the menu, or anything else. " +
        "We reply here — no need to leave the site.</p></div>";
    }

    var lastDay = "";
    return state.msgs.map(function (m) {
      var head = "";
      var label = dayLabel(m.createdAt);
      if (label !== lastDay) { lastDay = label; head = '<p class="chat__day">' + label + "</p>"; }
      return head +
        '<div class="chat__row ' + (m.mine ? "is-mine" : "is-them") + '">' +
          '<div class="chat__bubble">' +
            (m.fromStaff && !m.mine ? '<span class="chat__who">Kandy\'s</span>' : "") +
            '<span class="chat__body">' + escapeHTML(m.body) + "</span>" +
            '<time class="chat__time">' + clock(m.createdAt) + "</time>" +
          "</div>" +
        "</div>";
    }).join("");
  }

  function escapeHTML(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function paint() {
    var body = KT.qs("[data-chat-thread]");
    if (!body) return;
    body.innerHTML = threadHTML();
    body.scrollTop = body.scrollHeight;
    var badge = KT.qs("[data-chat-badge]");
    if (badge) {
      var n = state.conv ? Number(state.conv.customer_unread || 0) : 0;
      badge.textContent = n;
      badge.hidden = !n || state.open;
    }
  }

  function mount() {
    if (state.mounted) return;
    var el = KT.el("div.chat", { "data-chat": true, hidden: true, html:
      '<div class="chat__scrim" data-chat-close></div>' +
      '<section class="chat__panel" role="dialog" aria-modal="true" aria-label="Live chat with Kandy\'s Treats">' +
        '<header class="chat__head">' +
          '<span class="chat__avatar">' + KT.icon("sparkle", 18) + "</span>" +
          "<div class=\"chat__title\"><strong>Kandy's Treats</strong>" +
            "<span>We usually reply within a few minutes</span></div>" +
          '<button class="icon-btn" type="button" data-chat-close aria-label="Close chat">' +
            KT.icon("close", 20) + "</button>" +
        "</header>" +
        '<div class="chat__thread" data-chat-thread></div>' +
        '<form class="chat__compose" data-chat-form>' +
          '<input class="chat__input" name="body" autocomplete="off" ' +
            'placeholder="Type a message…" aria-label="Message">' +
          '<button class="chat__send btn btn--primary" type="submit" aria-label="Send">' +
            KT.icon("arrowRight", 18) + "</button>" +
        "</form>" +
      "</section>" });
    document.body.appendChild(el);
    state.mounted = true;
  }

  /* ---- Open / close ------------------------------------------------------ */

  async function open() {
    mount();
    var root = KT.qs("[data-chat]");
    root.hidden = false;
    /* Resolve the closed state before animating in, or the panel jumps. */
    void root.offsetHeight;
    root.classList.add("is-open");
    state.open = true;
    KT.lockScroll(true);

    if (!KT.auth || !KT.auth.isSignedIn()) {
      state.error = null;
      KT.mount(KT.qs("[data-chat-thread]"),
        '<div class="chat__state"><span class="chat__stateicon">' + KT.icon("lock", 26) + "</span>" +
        "<p><strong>Sign in to chat</strong><br>Your conversation is tied to your account so " +
        "we can pick it up where you left off.</p>" +
        '<a class="btn btn--primary btn--sm" href="' + KT.url("pages/login.html?next=account") +
        '">Sign in</a></div>');
      var form = KT.qs("[data-chat-form]");
      if (form) form.hidden = true;
      return;
    }

    var form2 = KT.qs("[data-chat-form]");
    if (form2) form2.hidden = false;

    state.busy = true; state.error = null; paint();
    try {
      state.conv = await KT.services.chat.myConversation();
      state.msgs = await KT.services.chat.messages(state.conv.id);
      state.busy = false;
      paint();

      unsubscribe = KT.services.chat.subscribe(state.conv.id, function (m) {
        /* Our own insert already rendered optimistically. */
        if (state.msgs.some(function (x) { return x.id === m.id; })) return;
        state.msgs.push(m);
        paint();
      });

      if (state.conv.customer_unread) {
        await KT.services.chat.markRead(state.conv.id, "customer").catch(function () {});
        state.conv.customer_unread = 0;
      }
      paint();
      var input = KT.qs(".chat__input");
      if (input) input.focus();
    } catch (error) {
      state.busy = false;
      state.error = KT.services ? KT.services.errorMessage(error) : "We could not open the chat.";
      paint();
    }
  }

  function close() {
    var root = KT.qs("[data-chat]");
    if (!root) return;
    root.classList.remove("is-open");
    state.open = false;
    KT.lockScroll(false);
    /* Always drop the channel — reopening resubscribes, and leaving it would
       stack duplicate handlers and double-render every message. */
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    window.setTimeout(function () { if (!state.open) root.hidden = true; }, 240);
  }

  /* ---- Wiring ------------------------------------------------------------ */

  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-open-chat]")) { e.preventDefault(); open(); return; }
    if (e.target.closest("[data-chat-close]")) { e.preventDefault(); close(); return; }
    if (e.target.closest("[data-chat-retry]")) { e.preventDefault(); open(); }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.open) close();
  });

  document.addEventListener("submit", async function (e) {
    var form = e.target.closest("[data-chat-form]");
    if (!form) return;
    e.preventDefault();
    var input = KT.qs(".chat__input", form);
    var text = input.value.trim();
    if (!text || !state.conv) return;

    var done = KT.busy(KT.qs(".chat__send", form), "");
    input.value = "";
    try {
      var sent = await KT.services.chat.send(state.conv.id, text);
      if (!state.msgs.some(function (x) { return x.id === sent.id; })) {
        state.msgs.push(sent);
      }
      paint();
    } catch (error) {
      input.value = text;             /* never lose what they typed */
      KT.toast(KT.services.errorMessage(error), "error", { duration: 5000 });
    } finally {
      if (done) done();
      input.focus();
    }
  });

  /* A chat notification links to ?chat=1 rather than to a separate page —
     the thread lives in this panel, so deep-linking means opening it. The
     parameter is stripped afterwards so a refresh does not reopen it. */
  function openFromQuery() {
    if (!/[?&]chat=1\b/.test(window.location.search)) return;
    var url = new URL(window.location.href);
    url.searchParams.delete("chat");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    open();
  }

  document.addEventListener("kt:services", openFromQuery);

  KT.components.chat = { open: open, close: close };
})(window.KT || (window.KT = {}));
