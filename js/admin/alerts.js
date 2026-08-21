/* ==========================================================================
   Kandy's Treats — new-order alerts for handlers
   --------------------------------------------------------------------------
   Three things, in order of how much they can be relied on:

     Web Push   works with the admin closed. The real answer.
     Sound      works only while a tab is open AND the browser has decided we
                are allowed to make noise.
     Toast      works while a tab is open and someone is looking at it.

   The sound is the part with the awkward rules, so they are handled here
   rather than hoped about:

     Browsers block audio until the page has been interacted with. There is no
     way around that and no attempt is made to find one (§11). Instead the
     first blocked play flips a visible "Enable order sounds" control, which
     IS a user interaction, and unlocks audio for the rest of the session.

     The tone is generated with WebAudio rather than shipped as an mp3 — no
     asset to load, no request to fail, and it cannot be silently missing.

   WHO HEARS IT
   ------------
   Nothing here decides that. The alert fires off the `admin_order`
   notification rows the database wrote for THIS account, so a handler hears
   about an order only if the server addressed one to them. A customer running
   this file would receive nothing, because no such row would exist for them.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var MUTE_KEY = "kt.admin.sound_muted";
  var CLAIM_KEY = "kt.admin.sound_claim";
  var ctx = null;
  var unlocked = false;
  var blocked = false;          /* we tried to play and the browser said no */
  var stop = null;
  var seen = Object.create(null); /* notification ids already alerted on */
  var queue = [];               /* visible alerts on screen */
  /* Anything older than this when we first hear about it is history, not
     news — see claimSound(). */
  var startedAt = Date.now();

  /*
     §12: two admin tabs must both UPDATE, but only one may make a noise.

     localStorage is shared across tabs of an origin and its writes are
     synchronous, so it works as a claim ticket: whoever writes the id first
     owns the sound for it. The read-then-write is not atomic in theory, but
     both tabs are reacting to the same realtime frame and the window between
     them is microseconds — and the failure mode if two ever tie is one extra
     beep, not a wrong action.

     The record is a small ring of recent ids rather than a single value, so
     two orders arriving together do not evict one another.
  */
  function claimSound(id) {
    var now = Date.now();
    var claims = [];
    try { claims = JSON.parse(window.localStorage.getItem(CLAIM_KEY) || "[]"); }
    catch (e) { claims = []; }
    if (!Array.isArray(claims)) claims = [];

    /* Drop anything older than a minute so the list cannot grow forever. */
    claims = claims.filter(function (c) { return c && (now - c.t) < 60000; });
    if (claims.some(function (c) { return c.id === id; })) return false;

    claims.push({ id: id, t: now });
    try { window.localStorage.setItem(CLAIM_KEY, JSON.stringify(claims.slice(-20))); }
    catch (e) { /* private mode: fall through and let this tab play */ }
    return true;
  }

  function muted() {
    try { return window.localStorage.getItem(MUTE_KEY) === "1"; } catch (e) { return false; }
  }
  function setMuted(v) {
    try { window.localStorage.setItem(MUTE_KEY, v ? "1" : "0"); } catch (e) { /* private mode */ }
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ---- Sound ------------------------------------------------------------- */

  /**
   * Two short rising notes. Deliberately not a long chime: this fires in a
   * kitchen, possibly repeatedly, and an alert people want to disable is an
   * alert that stops working.
   */
  function tone() {
    if (!ctx) return false;
    var now = ctx.currentTime;
    [[880, 0], [1170, 0.13]].forEach(function (pair) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = pair[0];
      gain.gain.setValueAtTime(0.0001, now + pair[1]);
      gain.gain.exponentialRampToValueAtTime(0.22, now + pair[1] + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + pair[1] + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + pair[1]);
      osc.stop(now + pair[1] + 0.24);
    });
    return true;
  }

  function ensureContext() {
    if (ctx) return ctx;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  }

  /** Called from a real click, which is the only thing that unlocks audio. */
  function unlock() {
    var c = ensureContext();
    if (!c) return false;
    if (c.state === "suspended") c.resume();
    unlocked = c.state === "running";
    if (unlocked) { blocked = false; paintControls(); }
    return unlocked;
  }

  function play() {
    if (muted()) return;
    var c = ensureContext();
    if (!c) return;
    if (c.state === "suspended") {
      /* Autoplay policy. Surface the control rather than retrying in a loop. */
      blocked = true;
      paintControls();
      return;
    }
    unlocked = true;
    tone();
  }

  /* ---- Visual alert ------------------------------------------------------ */

  function alertHTML(a) {
    return (
      '<div class="oalert" data-oalert="' + esc(a.id) + '">' +
        '<span class="oalert__mark">' + KT.icon("receipt", 20) + "</span>" +
        '<div class="oalert__body">' +
          '<strong class="oalert__title">' + esc(a.title) + "</strong>" +
          '<span class="oalert__detail">' + esc(a.message) + "</span>" +
        "</div>" +
        (a.href
          ? '<a class="btn btn--primary btn--sm" href="' + a.href + '" data-oalert-open="' +
            esc(a.id) + '">View</a>'
          : "") +
        '<button class="oalert__close" type="button" data-oalert-close="' + esc(a.id) +
          '" aria-label="Dismiss">' + KT.icon("close", 16) + "</button>" +
      "</div>"
    );
  }

  function host() {
    var el = KT.qs("[data-oalerts]");
    if (el) return el;
    el = document.createElement("div");
    el.className = "oalerts";
    el.setAttribute("data-oalerts", "");
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
    return el;
  }

  function paintAlerts() {
    var el = host();
    el.innerHTML = queue.map(alertHTML).join("") + controlsHTML();
  }

  /* ---- Sound control ----------------------------------------------------- */

  /* The floating control only exists when autoplay has been refused, because
     that is the one case that needs an interaction to resolve. The everyday
     mute switch lives in the top bar instead — a handler has to be able to
     silence the kitchen BEFORE the rush, not only while an alert happens to
     be on screen. */
  function controlsHTML() {
    if (!blocked) return "";
    return '<button class="osound osound--blocked" type="button" data-sound-unlock>' +
      KT.icon("bell", 15) + "Enable order sounds</button>";
  }

  /** The persistent control, rendered by the shell into its top bar. */
  function toggleHTML() {
    var off = muted();
    return '<span class="asoundwrap">' +
      '<button class="icon-btn asound' + (off ? " is-off" : "") + '" type="button" ' +
        'data-sound-toggle aria-pressed="' + (off ? "false" : "true") + '" ' +
        'title="' + (off ? "Order sounds are off" : "Order sounds are on") + '" ' +
        'aria-label="' + (off ? "Turn order sounds on" : "Turn order sounds off") + '">' +
        KT.icon(off ? "close" : "bell", 19) + "</button>" +
      /* §4: hearing it once, deliberately, is the only way to know the tab is
         allowed to make noise before the first real order depends on it. The
         click doubles as the gesture that unlocks autoplay. */
      (off ? "" :
        '<button class="asoundtest" type="button" data-sound-test ' +
          'title="Play the order sound">Test</button>') +
    "</span>";
  }

  function paintControls() {
    paintAlerts();
    var slot = KT.qs("[data-admin-sound]");
    if (slot) slot.innerHTML = toggleHTML();
  }

  /* ---- Reacting to a notification --------------------------------------- */

  function hrefFor(n) {
    if (n.type === "admin_order") {
      return n.relatedId ? "#/orders?code=" + encodeURIComponent(n.relatedId) : "#/orders";
    }
    if (n.type === "admin_support") {
      return n.relatedId
        ? "#/support?tab=chat&conversation=" + encodeURIComponent(n.relatedId)
        : "#/support?tab=chat";
    }
    if (n.type === "admin_ticket") {
      return n.relatedId
        ? "#/support?tab=tickets&ticket=" + encodeURIComponent(n.relatedId)
        : "#/support?tab=tickets";
    }
    if (n.type === "payment") return "#/reconciliation";
    return "#/dashboard";
  }

  function show(n) {
    /* One alert per notification id, however many times realtime tells us
       about it. This is the client half of the duplicate guard; the server
       half is push_sent_at. */
    if (seen[n.id]) return;
    seen[n.id] = true;

    queue.unshift({ id: n.id, title: n.title, message: n.message, href: hrefFor(n) });
    queue = queue.slice(0, 3);
    paintAlerts();

    /*
       §22: a realtime reconnect re-delivers rows we have already lived
       through, and a backlog replayed as sound would have the kitchen
       chasing orders from an hour ago. Two guards, both required:
       the event must be newer than this tab, and no other tab may have
       claimed it.
    */
    if (n.type === "admin_order") {
      var at = n.createdAt ? new Date(n.createdAt).getTime() : Date.now();
      if (at >= startedAt - 5000 && claimSound(n.id)) play();
    }

    window.setTimeout(function () { dismiss(n.id); }, 30000);
  }

  function dismiss(id) {
    queue = queue.filter(function (a) { return a.id !== id; });
    paintAlerts();
  }

  /* ---- Wiring ------------------------------------------------------------ */

  document.addEventListener("click", function (e) {
    var close = e.target.closest("[data-oalert-close]");
    if (close) { e.preventDefault(); dismiss(close.getAttribute("data-oalert-close")); return; }

    var open = e.target.closest("[data-oalert-open]");
    if (open) { dismiss(open.getAttribute("data-oalert-open")); return; }

    if (e.target.closest("[data-sound-unlock]")) {
      e.preventDefault();
      if (unlock()) { setMuted(false); tone(); KT.toast("Order sounds are on.", "success"); }
      else KT.toast("This browser will not let the page play sound.", "error");
      return;
    }
    if (e.target.closest("[data-sound-test]")) {
      e.preventDefault();
      if (unlock()) { tone(); KT.toast("That is the new-order sound.", "success"); }
      else KT.toast("This browser will not let the page play sound.", "error");
      return;
    }
    if (e.target.closest("[data-sound-toggle]")) {
      e.preventDefault();
      var next = !muted();
      setMuted(next);
      if (!next) { unlock(); tone(); }
      paintControls();
    }
  });

  /* ---- Public API -------------------------------------------------------- */

  KT.admin.alerts = {
    /** Started by the shell once a staff+ role has resolved. */
    start: function () {
      if (stop) return;
      if (!KT.services || !KT.services.notifications) return;
      stop = KT.services.notifications.subscribe(function (change) {
        /* One subscription on public.notifications for the whole admin. The
           centre is told rather than opening its own channel — two channels
           on the same table is how a notification arrives twice. */
        if (KT.admin.notifications) KT.admin.notifications.onIncoming(change);
        if (change.event !== "INSERT") return;
        var n = change.notification;
        if (["admin_order", "admin_support", "admin_ticket"].indexOf(n.type) === -1) return;
        if (n.read) return;
        show(n);
      });
    },
    stop: function () {
      if (stop) { stop(); stop = null; }
      queue = [];
      var el = KT.qs("[data-oalerts]");
      if (el) el.innerHTML = "";
    },
    muted: muted,
    /* The shell paints this into its top bar once a handler role resolves. */
    toggleHTML: toggleHTML,
    paintControls: paintControls,
    /* Exposed for the shell's own control, and for testing. */
    play: play,
    unlock: unlock,
    /* Testing hook: forces the autoplay-refused branch so the unlock control
       can be exercised without waiting for a browser to refuse. */
    simulateBlocked: function () { blocked = true; paintControls(); }
  };
})(window.KT || (window.KT = {}));
