/* ==========================================================================
   Kandy's Treats — Loading states, auth gating & busy buttons
   --------------------------------------------------------------------------
   Loaded straight after core/kt.js on every page, before any page module.

   Three jobs, all of them about never showing the customer a screen that
   looks broken:

   1. Auth is a THREE-state value, not a boolean. Firebase restores the
      session from IndexedDB asynchronously, so for the first second of every
      page load `isSignedIn()` is false for a signed-in customer. Pages that
      branch on it alone paint "Sign in to see your account" and then correct
      themselves — the flash. Pages must branch on pending / in / out.

   2. A one-bit crumb in localStorage tells the very first frame whether the
      customer is *likely* returning, so we can show a skeleton to them and
      the real signed-out state to everyone else. No PII, no token — one bit.

   3. Buttons come back. A button left disabled after a failed request is
      indistinguishable from a frozen page, so KT.busy() hands back a restore
      function that callers run from `finally`.
   ========================================================================== */
(function (KT) {
  "use strict";

  var SESSION_HINT = "kt.session.v1";

  /* ---- Session crumb ---------------------------------------------------- */

  KT.session = {
    likely: function () {
      try { return window.localStorage.getItem(SESSION_HINT) === "1"; }
      catch (e) { return false; }
    },
    remember: function () {
      try { window.localStorage.setItem(SESSION_HINT, "1"); } catch (e) { /* private mode */ }
    },
    forget: function () {
      try { window.localStorage.removeItem(SESSION_HINT); } catch (e) { /* private mode */ }
    }
  };

  /* ---- Auth state ------------------------------------------------------- */

  /** "pending" until Firebase reports the initial state, then "in" | "out". */
  KT.authState = "pending";

  KT.authPending = function () {
    return KT.authState === "pending";
  };

  /**
   * True when a page should paint a skeleton instead of the signed-out state:
   * we are still waiting AND this browser has signed in before. A first-time
   * visitor sees the signed-out state immediately, with no skeleton flash.
   */
  KT.authResolving = function () {
    return KT.authState === "pending" && KT.session.likely();
  };

  document.addEventListener("kt:auth", /** @param {CustomEvent} e */ function (e) {
    var signedIn = !!(e.detail && e.detail.signedIn);
    KT.authState = signedIn ? "in" : "out";
    if (signedIn) KT.session.remember();
    else KT.session.forget();
  });

  document.addEventListener("kt:services", /** @param {CustomEvent} e */ function (e) {
    /* Backend never came up. Stop waiting — the offline note explains why.
       The crumb is deliberately left alone: we did not learn they signed out. */
    if (!(e.detail && e.detail.ok) && KT.authState === "pending") KT.authState = "out";
  });

  /* ---- Skeleton vocabulary ---------------------------------------------- */

  function box(width, height, radius) {
    return '<span class="skeleton sk-box" style="width:' + width + ";height:" + height +
      (radius ? ";border-radius:" + radius : "") + '"></span>';
  }

  KT.skeleton = {
    box: box,

    /** n stacked text lines, last one short so it reads as a paragraph. */
    lines: function (n) {
      var out = "";
      for (var i = 0; i < (n || 3); i++) {
        out += box(i === (n || 3) - 1 ? "58%" : "100%", "12px", "6px");
      }
      return '<span class="sk-lines">' + out + "</span>";
    },

    /** A panel shell matching .panel + .panel__head. */
    panel: function (lines) {
      return '<div class="panel sk-panel" aria-hidden="true">' +
        '<div class="panel__head">' + box("42%", "18px", "8px") + "</div>" +
        KT.skeleton.lines(lines || 3) +
        "</div>";
    },

    /** Food-card grid placeholder — matches the .card footprint. */
    cards: function (n) {
      var out = "";
      for (var i = 0; i < (n || 6); i++) {
        out += '<div class="sk-card" aria-hidden="true">' +
          box("100%", "168px", "var(--r-md)") +
          '<span class="sk-lines">' + box("78%", "13px", "6px") + box("45%", "13px", "6px") + "</span>" +
        "</div>";
      }
      return '<div class="sk-cardgrid">' + out + "</div>";
    },

    /** Order-history card placeholder — matches .ordercard. */
    orders: function (n) {
      var out = "";
      for (var i = 0; i < (n || 3); i++) {
        out += '<article class="ordercard sk-ordercard" aria-hidden="true">' +
          '<div class="ordercard__top">' + box("38%", "14px", "6px") + box("84px", "24px", "var(--r-pill)") + "</div>" +
          '<div class="ordercard__body">' +
            box("52px", "52px", "50%") +
            '<span class="sk-lines">' + box("70%", "13px", "6px") + box("40%", "12px", "6px") + "</span>" +
            box("92px", "34px", "var(--r-pill)") +
          "</div>" +
        "</article>";
      }
      return out;
    },

    /** Account side-nav placeholder. */
    accountNav: function () {
      var links = "";
      for (var i = 0; i < 5; i++) links += box("100%", "38px", "var(--r-sm)");
      return '<div class="account__nav sk-nav" aria-hidden="true">' +
        '<div class="account__who">' + box("46px", "46px", "50%") +
          '<span class="sk-lines">' + box("120px", "13px", "6px") + box("90px", "11px", "6px") + "</span>" +
        "</div>" +
        '<div class="sk-lines">' + links + "</div>" +
      "</div>";
    },

    /** Account main column placeholder. */
    accountMain: function () {
      return KT.skeleton.panel(2) + KT.skeleton.panel(4) + KT.skeleton.panel(3);
    }
  };

  /** Screen-reader announcement to pair with a visual skeleton. */
  KT.loadingLabel = function (text) {
    return '<span class="sr-only" role="status" aria-live="polite">' +
      (text || "Loading…") + "</span>";
  };

  /* ---- Spinner ---------------------------------------------------------- */

  KT.spinner = function (size) {
    return '<span class="spinner" style="width:' + (size || 18) + "px;height:" +
      (size || 18) + 'px" aria-hidden="true"></span>';
  };

  /* ---- Busy buttons ----------------------------------------------------- */

  /**
   * Put a button into its busy state; returns the restore function, or null
   * if the button is already busy (which is how double-submits are refused).
   *
   *   var done = KT.busy(btn, "Saving…");
   *   if (!done) return;
   *   try { await save(); } finally { done(); }
   */
  KT.busy = function (btn, label) {
    if (!btn) return function () {};
    if (btn.getAttribute("data-kt-busy") === "1") return null;

    var originalHTML = btn.innerHTML;
    var wasDisabled = btn.disabled;
    var restored = false;

    btn.setAttribute("data-kt-busy", "1");
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
    btn.innerHTML = KT.spinner(16) + "<span>" + (label || "Working…") + "</span>";

    return function done() {
      if (restored) return;
      restored = true;
      btn.removeAttribute("data-kt-busy");
      btn.removeAttribute("aria-busy");
      btn.disabled = wasDisabled;
      btn.innerHTML = originalHTML;
    };
  };

  /* ---- Global top progress bar ------------------------------------------ */

  /* One honest signal that the page is still talking to the backend. Shown
     while the service layer boots, and available to any slow operation. */

  var bar = null;
  var depth = 0;

  function ensureBar() {
    if (bar) return bar;
    bar = KT.el("div.ktprogress", { "aria-hidden": "true" });
    document.body.appendChild(bar);
    return bar;
  }

  KT.progress = {
    start: function () {
      depth++;
      if (document.body) ensureBar().classList.add("is-active");
    },
    done: function () {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && bar) {
        bar.classList.remove("is-active");
        bar.classList.add("is-finishing");
        window.setTimeout(function () {
          if (bar && depth === 0) bar.classList.remove("is-finishing");
        }, 320);
      }
    },
    /** Wrap a promise so the bar always clears, success or failure. */
    around: function (promise) {
      KT.progress.start();
      return Promise.resolve(promise).finally(function () { KT.progress.done(); });
    }
  };

  /* The service layer is the one boot-time request every page makes. */
  function startBoot() {
    if (KT.authState === "pending") KT.progress.start();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startBoot);
  } else {
    startBoot();
  }
  document.addEventListener("kt:services", function () { KT.progress.done(); }, { once: true });
})(window.KT || (window.KT = {}));
