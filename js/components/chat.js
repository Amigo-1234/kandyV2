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

  var state = { mounted: false, open: false, conv: null, msgs: [], busy: false, error: null,
                /* null until asked; true once the account is known to hold an
                   operational role. Only ever changes the wording. */
                staffSide: null };

  /*
     SAME THREAD, SAME TABLE, HONEST LABEL.

     A member of staff opening this from the staff-flag notice is writing to
     management, not to customer support, and the header should say so rather
     than greeting them as a customer of the business they work for. Nothing
     about the routing changes here — chat_message_stamp() decides that from
     who owns the thread — this is only the words on the panel.

     The role comes from my_account_status(), the same authoritative source
     the admin shell gates on, so a promotion or demotion is reflected
     automatically with no list to maintain.
  */
  var RANK = { customer: 10, staff: 20, supervisor: 25, admin: 30, owner: 40 };

  async function resolveSide() {
    if (state.staffSide !== null) return state.staffSide;
    state.staffSide = false;
    try {
      var s = await KT.services.account.status();
      state.staffSide = (RANK[s && s.role] || 0) >= RANK.staff;
    } catch (error) { /* unknown role reads as a customer, which is the safe default */ }
    return state.staffSide;
  }

  function paintHead() {
    var t = KT.qs("[data-chat-title]");
    if (!t) return;
    t.innerHTML = state.staffSide
      ? "<strong>Management</strong><span>Your message goes to the management team</span>"
      : "<strong>Kandy's Treats</strong><span>We usually reply within a few minutes</span>";
  }
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

  /* Within this many pixels of the end counts as "following the conversation". */
  var FOLLOW_SLACK = 60;
  /*
     Whether the reader is pinned to the newest message.

     Kept as state rather than measured on demand, because the two moments
     that need the answer — a resize and a repaint — are both moments where
     measuring gives the wrong one. A rotation or an opening keyboard relays
     out the thread BEFORE the event fires, so by the time anything can ask
     "were they at the bottom?", they demonstrably are not: the content did
     not move, the window shrank under it. The flag records what the reader
     last chose, which is the thing actually being preserved.
  */
  var following = true;

  function atBottom(el) {
    return (el.scrollHeight - el.scrollTop - el.clientHeight) <= FOLLOW_SLACK;
  }

  /*
     A smooth scroll can finish short: the list is still being painted when the
     animation starts, so scrollHeight grows underneath it. Measured 196px shy
     of the end after tapping the pill — which is exactly the message the pill
     was advertising. So the animation is a nicety and the snap is the
     contract: whatever the animation managed, land at the end.
  */
  function toBottom(el, smooth) {
    if (!el) return;
    following = true;
    setJump(false);
    if (smooth && !KT.prefersReducedMotion) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      window.setTimeout(function () {
        if (!atBottom(el)) el.scrollTop = el.scrollHeight;
      }, 420);
      return;
    }
    el.scrollTop = el.scrollHeight;
  }

  function setJump(show) {
    var pill = KT.qs("[data-chat-jump]");
    if (pill) pill.classList.toggle("is-shown", !!show);
  }

  function paint(opts) {
    opts = opts || {};
    var body = KT.qs("[data-chat-thread]");
    if (!body) return;
    /* Decided BEFORE the repaint: afterwards the metrics describe the new
       content, not where the reader was. */
    /*
       A repaint is a trustworthy moment to measure: nothing has resized, the
       reader is wherever they left themselves. Refresh the flag here as well
       as on scroll, so the pill decision never rests on a stale record — and
       so it still behaves correctly where scroll events are coalesced away
       (a backgrounded tab renders no frames and therefore fires none).
    */
    if (body.scrollHeight) following = atBottom(body);
    var wasFollowing = opts.force || !body.scrollHeight || following;
    body.innerHTML = threadHTML();
    if (wasFollowing) toBottom(body);
    else setJump(true);          /* they had scrolled up — offer, do not jump */
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
          '<div class="chat__title" data-chat-title><strong>Kandy\'s Treats</strong>' +
            "<span>We usually reply within a few minutes</span></div>" +
          '<button class="icon-btn" type="button" data-chat-close aria-label="Close chat">' +
            KT.icon("close", 20) + "</button>" +
        "</header>" +
        '<div class="chat__thread" data-chat-thread></div>' +
        '<button class="chat__jump" type="button" data-chat-jump ' +
          'aria-label="Jump to the newest message">' + KT.icon("chevronDown", 15) +
          "New message</button>" +
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

  /* ---- Mobile viewport plumbing -----------------------------------------
     Two numbers the CSS cannot work out on its own:

       --kt-kb           how much of the viewport the on-screen keyboard is
                         covering. visualViewport is the only API that
                         reports this; without it iOS scrolls the whole page
                         to reveal the focused input, which is what makes a
                         chat "jump unpredictably".

       --kt-safe-bottom  the home-indicator inset, but ONLY while the
                         keyboard is down. With the keyboard up that space is
                         already taken, and adding it again leaves a gap
                         under the composer.
  */
  var stopViewport = null;   /* KT.viewportInset teardown */

  /*
     The keyboard inset is computed by KT.viewportInset (js/core/kt.js), which
     the admin chat uses too — one implementation, so the two full-screen chat
     views cannot drift apart. The only chat-specific part is the callback:
     keep the newest message in view as the keyboard opens or the phone
     rotates, but only for a reader who was already following.
  */
  function bindViewport() {
    if (stopViewport) return;
    stopViewport = KT.viewportInset.start(function () {
      var body = KT.qs("[data-chat-thread]");
      if (following && body) toBottom(body);
    });
  }

  function unbindViewport() {
    if (stopViewport) { stopViewport(); stopViewport = null; }
  }

  async function open() {
    mount();
    /* Every open starts at the newest message, whatever the last session
       left the flag on. */
    following = true;
    var root = KT.qs("[data-chat]");
    root.hidden = false;
    /* Resolve the closed state before animating in, or the panel jumps. */
    void root.offsetHeight;
    root.classList.add("is-open");
    state.open = true;
    /* Asked once per session and cached; the header repaints as soon as the
       answer lands, so the panel never waits on it to appear. */
    resolveSide().then(paintHead);
    /* Hides the storefront tab bar and locks the page behind — see the
       html.kt-chat-open rules in css/chat.css. */
    document.documentElement.classList.add("kt-chat-open");
    bindViewport();
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
      paint({ force: true });      /* open at the latest message */

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
      /* While this panel is open the customer is demonstrably reading the
         thread, so a staff reply should land as a message and not also as a
         notification and a push. Stops when the panel closes. */
      startPresence(state.conv.id);
      paint();
      var input = KT.qs(".chat__input");
      if (input) input.focus();
    } catch (error) {
      state.busy = false;
      state.error = KT.services ? KT.services.errorMessage(error) : "We could not open the chat.";
      paint();
    }
  }

  var presenceTimer = null;
  var presenceFor = null;

  function startPresence(conversationId) {
    stopPresence();
    presenceFor = conversationId;
    var touch = function () {
      if (!presenceFor || !KT.services) return;
      KT.services.chat.touchPresence(presenceFor).catch(function () {});
    };
    touch();
    presenceTimer = window.setInterval(touch, 30000);
  }

  function stopPresence() {
    if (presenceTimer) { window.clearInterval(presenceTimer); presenceTimer = null; }
    presenceFor = null;
  }

  function close() {
    var root = KT.qs("[data-chat]");
    if (!root) return;
    root.classList.remove("is-open");
    state.open = false;
    /* Everything the open added, removed — the tab bar comes back, the page
       scrolls again, and no listener outlives the panel. */
    document.documentElement.classList.remove("kt-chat-open");
    unbindViewport();
    setJump(false);
    KT.lockScroll(false);
    /* Always drop the channel — reopening resubscribes, and leaving it would
       stack duplicate handlers and double-render every message. */
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    stopPresence();
    window.setTimeout(function () { if (!state.open) root.hidden = true; }, 240);
  }

  /* ---- Wiring ------------------------------------------------------------ */

  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-chat-jump]")) {
      e.preventDefault();
      toBottom(KT.qs("[data-chat-thread]"), true);
      return;
    }
    if (e.target.closest("[data-open-chat]")) { e.preventDefault(); open(); return; }
    if (e.target.closest("[data-chat-close]")) { e.preventDefault(); close(); return; }
    if (e.target.closest("[data-chat-retry]")) { e.preventDefault(); open(); }
  });

  /* Delegated and passive. Attached once for the life of the page rather than
     per-open, so there is no listener to leak, and passive so it can never
     hold up a scroll frame. */
  document.addEventListener("scroll", function (e) {
    var el = e.target;
    if (!el || !el.classList || !el.classList.contains("chat__thread")) return;
    /* The one place a reader's own intent is expressed: scrolling away means
       stop following, scrolling back means resume. */
    following = atBottom(el);
    if (following) setJump(false);
  }, { passive: true, capture: true });

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
      /* force: your own message always scrolls into view, wherever you were. */
      paint({ force: true });
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
