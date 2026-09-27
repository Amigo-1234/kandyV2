/* ==========================================================================
   Kandy's Treats — "Install Kandy's" / Add to Home Screen
   --------------------------------------------------------------------------
   One small card, shown inline in the page content on the browsing pages
   only (home, menu, product). Never an overlay: it cannot sit
   over the basket, checkout, sign-in, a modal, the tab bar or the
   notification permission flow, because it is never on those pages and is
   never on top of anything.

   Two variants, from the existing PWA setup (manifest.webmanifest +
   the one /sw.js registered by js/app.js):

     iOS Safari   iOS has no install API, so the card explains the three taps:
                  Share -> Add to Home Screen -> Add. On iOS, installing is
                  also what makes order notifications possible at all.
     Chromium     If the browser fires `beforeinstallprompt` (Android Chrome,
                  Edge, Samsung Internet…), the card offers a native Install
                  button that opens the browser's own install dialog. The
                  browser's mini-infobar is suppressed so it cannot appear
                  over checkout; our card is the only prompt.

   Layout stability: the card must never push content the customer is
   already looking at. On home, menu and product this file is loaded
   synchronously right after <main> opens, so the iOS card is inserted
   before any of the page's content has been parsed, let alone painted.
   That is also why it uses nothing else from KT (its own url() and icons):
   kt.js has not loaded yet at that point. Every other page loads it at the
   end of <body>, only to suppress the browser's install banner.
   The Chromium event arrives later, at an unknown moment, so that card goes
   at the END of the page content, where it moves nothing on screen.

   Nothing is shown when the site is already running as the installed app
   (display-mode standalone / navigator.standalone), in in-app browsers
   (Instagram, Facebook, WhatsApp…) where Add to Home Screen is not offered,
   or on any other browser that cannot install.

   Dismissal is remembered in localStorage for this origin:
     "Not now" / close   quiet for 14 days
     "Done" / installed  quiet for 180 days
   ========================================================================== */
(function (KT) {
  "use strict";

  var KEY = "kt.install.v1";
  var SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
  var DONE_MS = 180 * 24 * 60 * 60 * 1000;
  var PAGES = ["home", "menu", "product"];

  function url(path) { return ((/** @type {any} */ (window)).KT_BASE || "") + path; }
  function svg(d, size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + d + "</svg>";
  }
  var CLOSE_SVG = svg('<path d="M6 6l12 12M18 6L6 18"/>', 18);
  var PLUS_SVG = svg('<path d="M12 5.5v13M5.5 12h13"/>', 16);

  var deferred = null;        /* the saved beforeinstallprompt event */
  var ready = false;          /* start() has run */
  var card = null;

  /* ---- Environment ------------------------------------------------------ */

  function isStandalone() {
    try {
      if ((/** @type {any} */ (navigator)).standalone === true) return true;
      return ["standalone", "fullscreen", "minimal-ui"].some(function (m) {
        return window.matchMedia("(display-mode: " + m + ")").matches;
      });
    } catch (e) { return false; }
  }

  function isIOS() {
    var ua = navigator.userAgent || "";
    /* iPadOS reports itself as a Mac; touch points give it away. */
    return /iPad|iPhone|iPod/.test(ua) ||
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }

  /* Safari itself — not Chrome/Firefox/Edge on iOS and not an in-app
     browser, whose Share sheets do not offer "Add to Home Screen". */
  function isIOSSafari() {
    var ua = navigator.userAgent || "";
    return isIOS() && /Safari\//.test(ua) &&
      !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|YaBrowser|DuckDuckGo|FBAN|FBAV|FB_IAB|Instagram|Line\/|Twitter|Snapchat|WhatsApp|MicroMessenger|TikTok|musical_ly/i.test(ua);
  }

  function pageAllowed() {
    return PAGES.indexOf(document.body && document.body.getAttribute("data-page")) !== -1;
  }

  /* ---- Remembered choice ------------------------------------------------ */

  function read() {
    try { return JSON.parse(window.localStorage.getItem(KEY) || "null"); }
    catch (e) { return null; }
  }
  function remember(state) {
    try { window.localStorage.setItem(KEY, JSON.stringify({ state: state, at: Date.now() })); }
    catch (e) { /* private mode: it simply is not remembered */ }
  }
  function quiet() {
    var r = read();
    if (!r || typeof r.at !== "number") return false;
    var span = r.state === "done" ? DONE_MS : SNOOZE_MS;
    return Date.now() - r.at < span;
  }

  /* ---- Rendering -------------------------------------------------------- */

  var SHARE_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/>' +
    '<path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
  var ADD_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="4"/>' +
    '<path d="M12 8v8M8 12h8"/></svg>';

  function mode() {
    if (deferred) return "native";
    if (isIOSSafari()) return "ios";
    return null;
  }

  function html(m) {
    var head =
      '<div class="ktinstall__head">' +
        '<img class="ktinstall__icon" src="' + url("assets/logo/apple-touch-icon.png") + '" ' +
          'width="52" height="52" alt="">' +
        '<div class="ktinstall__intro">' +
          '<h2 class="ktinstall__title" id="ktinstall-title">Get the Kandy\'s app</h2>' +
          '<p class="ktinstall__lede">Add Kandy\'s to your Home Screen for the best app-like experience' +
            (m === "ios" ? " — and to turn on order notifications, so you know the moment your food is on its way."
                         : " — one tap to reopen, and order notifications that reach you.") + "</p>" +
        "</div>" +
        '<button class="ktinstall__close" type="button" data-install-later aria-label="Not now">' +
          CLOSE_SVG + "</button>" +
      "</div>";

    if (m === "ios") {
      return head +
        '<ol class="ktinstall__steps">' +
          '<li><span class="ktinstall__num">1</span><span>Tap <strong>Share</strong> ' +
            '<span class="ktinstall__glyph">' + SHARE_SVG + "</span> in Safari's toolbar</span></li>" +
          '<li><span class="ktinstall__num">2</span><span>Choose <strong>Add to Home Screen</strong> ' +
            '<span class="ktinstall__glyph">' + ADD_SVG + "</span></span></li>" +
          '<li><span class="ktinstall__num">3</span><span>Tap <strong>Add</strong></span></li>' +
        "</ol>" +
        '<div class="ktinstall__actions">' +
          '<button class="btn btn--ghost btn--sm" type="button" data-install-later>Not now</button>' +
          '<button class="btn btn--primary btn--sm" type="button" data-install-done>Done</button>' +
        "</div>";
    }
    return head +
      '<div class="ktinstall__actions">' +
        '<button class="btn btn--ghost btn--sm" type="button" data-install-later>Not now</button>' +
        '<button class="btn btn--primary btn--sm" type="button" data-install-native>' +
          PLUS_SVG + "<span>Install app</span></button>" +
      "</div>";
  }

  function remove() {
    if (card && card.parentNode) card.parentNode.removeChild(card);
    card = null;
  }

  function render() {
    if (!ready) return;
    var m = mode();
    if (!m || isStandalone() || quiet() || !pageAllowed()) { remove(); return; }
    var main = document.getElementById("main");
    if (!main) return;

    if (!card) {
      card = document.createElement("div");
      card.className = "wrap ktinstall-wrap ktinstall-wrap--" + (m === "native" ? "end" : "top");
      if (m === "native") main.appendChild(card);
      else main.insertBefore(card, main.firstChild);
    }
    card.innerHTML =
      '<aside class="ktinstall ktinstall--' + m + '" data-install-card="' + m + '" ' +
        'role="region" aria-labelledby="ktinstall-title">' + html(m) + "</aside>";
  }

  /* ---- Wiring ----------------------------------------------------------- */

  /* Registered at parse time so an early event is not missed. Always
     prevented: the browser's own mini-infobar would otherwise be free to
     appear over the basket or checkout. The event is kept, and offered only
     from the card, only on browsing pages. */
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    render();
  });

  window.addEventListener("appinstalled", function () {
    deferred = null;
    remember("done");
    remove();
  });

  document.addEventListener("click", async function (e) {
    var t = /** @type {Element} */ (e.target);
    if (!t || !t.closest || !t.closest("[data-install-card]")) return;

    if (t.closest("[data-install-later]")) {
      e.preventDefault(); remember("later"); remove(); return;
    }
    if (t.closest("[data-install-done]")) {
      e.preventDefault(); remember("done"); remove(); return;
    }
    var nat = t.closest("[data-install-native]");
    if (nat && deferred) {
      e.preventDefault();
      var ev = deferred;
      deferred = null;              /* a prompt event can only be used once */
      try {
        await ev.prompt();
        var choice = await ev.userChoice;
        remember(choice && choice.outcome === "accepted" ? "done" : "later");
      } catch (err) {
        remember("later");
      }
      remove();
    }
  });

  function start() {
    if (isStandalone()) return;     /* already the installed app: nothing, ever */
    ready = true;
    render();
  }

  /* #main already exists wherever this script is loaded (see the header),
     so render now rather than after DOMContentLoaded, which waits for the
     module scripts and so lands after first paint. */
  if (document.getElementById("main")) start();
  else document.addEventListener("DOMContentLoaded", start);

  /* Read-only view of the decision, for support and for tests. */
  KT.installPrompt = {
    mode: mode,
    isStandalone: isStandalone,
    isIOSSafari: isIOSSafari,
    quiet: quiet
  };
})((/** @type {any} */ (window)).KT || ((/** @type {any} */ (window)).KT = {}));
