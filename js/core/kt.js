/* ==========================================================================
   Kandy's Treats — Core namespace & helpers
   Loaded first on every page. No dependencies.
   ========================================================================== */
(function () {
  "use strict";

  var KT = (window.KT = window.KT || {});

  /* Relative path back to the project root. Pages inside /pages set
     window.KT_BASE = '../' before scripts load. */
  KT.base = window.KT_BASE || "";

  /* ---- DOM ---------------------------------------------------------- */

  KT.qs = function (sel, root) {
    return (root || document).querySelector(sel);
  };
  KT.qsa = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  /**
   * Tiny hyperscript. el('div.card', { 'data-id': 3 }, [child, 'text'])
   */
  KT.el = function (spec, attrs, children) {
    var parts = spec.split(/(?=[.#])/);
    var node = document.createElement(parts.shift() || "div");
    parts.forEach(function (p) {
      if (p[0] === ".") node.classList.add(p.slice(1));
      else node.id = p.slice(1);
    });
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "html") node.innerHTML = v;
        else if (k === "text") node.textContent = v;
        else if (k.slice(0, 2) === "on" && typeof v === "function")
          node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v === true ? "" : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  };

  /** Set innerHTML then return the container (chainable render helper). */
  KT.mount = function (target, html) {
    var node = typeof target === "string" ? KT.qs(target) : target;
    if (node) node.innerHTML = html;
    return node;
  };

  /* ---- Formatting --------------------------------------------------- */

  KT.naira = function (value) {
    return "₦" + Number(value || 0).toLocaleString("en-NG");
  };

  KT.plural = function (n, one, many) {
    return n + " " + (n === 1 ? one : many || one + "s");
  };

  /* ---- Routing helpers ---------------------------------------------- */

  KT.url = function (path) {
    return KT.base + path;
  };

  KT.param = function (name) {
    return new URLSearchParams(window.location.search).get(name);
  };

  /* ---- Misc --------------------------------------------------------- */

  KT.debounce = function (fn, wait) {
    var t;
    return function () {
      var args = arguments,
        ctx = this;
      clearTimeout(t);
      t = setTimeout(function () {
        fn.apply(ctx, args);
      }, wait || 180);
    };
  };

  KT.lockScroll = function (on) {
    document.body.classList.toggle("is-locked", !!on);
  };

  KT.prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  /* Inline icon set — single source of truth, stroke-based, 24px grid. */
  KT.icon = function (name, size) {
    var d = KT.icon.paths[name];
    if (!d) return "";
    var s = size || 20;
    return (
      '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="' +
      (KT.icon.filled[name] ? "currentColor" : "none") +
      '" stroke="' + (KT.icon.filled[name] ? "none" : "currentColor") +
      '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      d + "</svg>"
    );
  };

  KT.icon.filled = { star: true, dot: true };

  KT.icon.paths = {
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/>',
    cart:
      '<path d="M3 4h2.2l2.2 11.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L21 8H6"/>' +
      '<circle cx="10" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
    home: '<path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
    receipt:
      '<path d="M6 3.5h12a1 1 0 0 1 1 1V21l-2.5-1.6L14 21l-2-1.6L10 21l-2.5-1.6L5 21V4.5a1 1 0 0 1 1-1z"/>' +
      '<path d="M9 8.5h6M9 12.5h6"/>',
    star: '<path d="M12 3.6l2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5 2.7 1-5.6-4.1-3.9 5.6-.8z"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    minus: '<path d="M5.5 12h13"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h11"/>',
    arrowRight: '<path d="M5 12h13M13 6.5l5.5 5.5L13 17.5"/>',
    arrowLeft: '<path d="M19 12H6M11 6.5 5.5 12 11 17.5"/>',
    chevronRight: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
    chevronDown: '<path d="M5.5 9 12 15.5 18.5 9"/>',
    pin: '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
    bike: '<circle cx="6" cy="17" r="3.2"/><circle cx="18" cy="17" r="3.2"/><path d="M6 17l4-8h5M14.5 6h3l1.6 4.4M9.5 17h5"/>',
    trash: '<path d="M4.5 7h15M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M7 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.4A1.5 1.5 0 0 0 16.2 19L17 7"/>',
    heart: '<path d="M12 20s-7.4-4.6-7.4-9.6A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.4 2.8C19.4 15.4 12 20 12 20z"/>',
    check: '<path d="M5 12.5 10 17.5 19 7"/>',
    filter: '<path d="M4 6.5h16M7 12h10M10 17.5h4"/>',
    sparkle: '<path d="M12 4l1.7 4.8L18.5 10l-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.2z"/><path d="M18.5 16.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/>',
    phone: '<path d="M6.5 3.5h3l1.5 4-2 1.4a12 12 0 0 0 6.1 6.1l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z"/>',
    mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="m4.5 7.5 7.5 5.5 7.5-5.5"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    eye: '<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    logout: '<path d="M14 5.5H7a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 7 18.5h7M17 8.5 20.5 12 17 15.5M20 12h-9"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M17.8 6.2l-1.4 1.4M7.6 16.4l-1.4 1.4M17.8 17.8l-1.4-1.4M7.6 7.6 6.2 6.2"/>',
    dot: '<circle cx="12" cy="12" r="4"/>',
    flame: '<path d="M12 21a6 6 0 0 0 6-6c0-4-3.5-5.5-3.5-9C13 7.5 12 9 12 9s-1.5-2.5-4-4c0 4.5-2 5-2 10a6 6 0 0 0 6 6z"/>',
    leaf: '<path d="M5 19C5 10 11 5 20 5c0 9-5 14-14 14z"/><path d="M5 19c3.5-3.5 6.5-6 10-8"/>',
    gift: '<rect x="3.5" y="9.5" width="17" height="11" rx="2"/><path d="M3.5 13.5h17M12 9.5v11M12 9.5S9 9.5 8 8.5a2 2 0 1 1 3-2.6C12 7 12 9.5 12 9.5zM12 9.5s3 0 4-1a2 2 0 1 0-3-2.6c-1 1.1-1 3.6-1 3.6z"/>',
    wallet: '<rect x="3.5" y="6" width="17" height="13" rx="2.5"/><path d="M3.5 10h17M16 14.5h1.5"/>'
  };
})();
