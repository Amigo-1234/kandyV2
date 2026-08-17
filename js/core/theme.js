/* ==========================================================================
   Kandy's Treats — Theme (light / dark)
   --------------------------------------------------------------------------
   The stored theme is applied by a tiny inline snippet in every page's <head>
   (see the data-theme-boot script), BEFORE first paint. This file only owns
   the toggle behaviour and keeping the label in step — it must never be the
   thing that first applies the theme, or the page would flash.

   Precedence, deliberately:
     explicit choice in localStorage  >  prefers-color-scheme  >  light
   ========================================================================== */
(function (KT) {
  "use strict";

  var KEY = "kt.theme";

  function stored() {
    try {
      var v = window.localStorage.getItem(KEY);
      return v === "dark" || v === "light" ? v : null;
    } catch (e) { return null; }
  }

  function systemPrefersDark() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  /** The theme actually on screen right now. */
  function current() {
    var attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
    return systemPrefersDark() ? "dark" : "light";
  }

  function apply(theme, persist) {
    var root = document.documentElement;

    /* Suppress transitions for one frame. Two reasons:
       1. A theme swap should be instant, not a half-second colour crossfade.
       2. Chrome pins the pre-change computed colour on elements that
          transition background-color from a custom property — .nav kept its
          light colour in dark mode while .tabbar (no transition) updated
          correctly. Killing transitions across the swap forces a clean
          recalculation for every element. */
    root.classList.add("is-theme-switching");
    root.setAttribute("data-theme", theme);
    /* Read a layout property to flush the style change before re-enabling. */
    void root.offsetHeight;
    /* rAF does not fire in a hidden tab, and leaving this class on would
       disable every transition site-wide, so a timer backs it up. Whichever
       lands first wins; removing twice is harmless. */
    function release() { root.classList.remove("is-theme-switching"); }
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(release);
    });
    window.setTimeout(release, 120);
    if (persist) {
      try { window.localStorage.setItem(KEY, theme); } catch (e) { /* private mode */ }
    }
    paintToggles();
    document.dispatchEvent(new CustomEvent("kt:theme", { detail: { theme: theme } }));
  }

  /** Sun when dark (tap for light), moon when light (tap for dark). */
  function paintToggles() {
    var now = current();
    var next = now === "dark" ? "light" : "dark";
    KT.qsa("[data-theme-toggle]").forEach(function (btn) {
      btn.innerHTML = KT.icon(now === "dark" ? "sun" : "moon", 18);
      btn.setAttribute("aria-label", "Switch to " + next + " theme");
      btn.setAttribute("title", "Switch to " + next + " theme");
      btn.setAttribute("aria-pressed", now === "dark" ? "true" : "false");
    });
  }

  KT.theme = {
    current: current,
    set: function (theme) { apply(theme === "dark" ? "dark" : "light", true); },
    toggle: function () { apply(current() === "dark" ? "light" : "dark", true); },
    paintToggles: paintToggles
  };

  /* One delegated listener for the whole document — no per-button binding, so
     re-rendering the navbar cannot accumulate duplicates. */
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-theme-toggle]");
    if (!btn) return;
    e.preventDefault();
    KT.theme.toggle();
  });

  /* Follow the system only while the customer has made no explicit choice. */
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    if (!stored()) paintToggles();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", paintToggles);
  } else {
    paintToggles();
  }
})(window.KT || (window.KT = {}));
