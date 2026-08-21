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

  /* Brand marks are solid shapes, not strokes on the 24px grid, so they opt
     into fill and skip the stroke treatment the rest of the set uses. */
  KT.icon.filled = {
    star: true, dot: true,
    instagram: true, facebook: true, tiktok: true, whatsapp: true, x: true
  };

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
    bell:
      '<path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9z"/>' +
      '<path d="M13.7 19a2 2 0 0 1-3.4 0"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    eye: '<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    logout: '<path d="M14 5.5H7a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 7 18.5h7M17 8.5 20.5 12 17 15.5M20 12h-9"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M17.8 6.2l-1.4 1.4M7.6 16.4l-1.4 1.4M17.8 17.8l-1.4-1.4M7.6 7.6 6.2 6.2"/>',
    dot: '<circle cx="12" cy="12" r="4"/>',
    flame: '<path d="M12 21a6 6 0 0 0 6-6c0-4-3.5-5.5-3.5-9C13 7.5 12 9 12 9s-1.5-2.5-4-4c0 4.5-2 5-2 10a6 6 0 0 0 6 6z"/>',
    leaf: '<path d="M5 19C5 10 11 5 20 5c0 9-5 14-14 14z"/><path d="M5 19c3.5-3.5 6.5-6 10-8"/>',
    gift: '<rect x="3.5" y="9.5" width="17" height="11" rx="2"/><path d="M3.5 13.5h17M12 9.5v11M12 9.5S9 9.5 8 8.5a2 2 0 1 1 3-2.6C12 7 12 9.5 12 9.5zM12 9.5s3 0 4-1a2 2 0 1 0-3-2.6c-1 1.1-1 3.6-1 3.6z"/>',
    wallet: '<rect x="3.5" y="6" width="17" height="13" rx="2.5"/><path d="M3.5 10h17M16 14.5h1.5"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/>',

    /* ---- Brand marks (filled) ---------------------------------------- */
    instagram:
      '<path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23a3.7 3.7 0 0 1-.9 1.38c-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zm0 1.98c-3.14 0-3.51.01-4.75.07-.9.04-1.39.19-1.71.32-.43.17-.74.37-1.06.69-.32.32-.52.63-.69 1.06-.13.32-.28.81-.32 1.71-.06 1.24-.07 1.61-.07 4.75s.01 3.51.07 4.75c.04.9.19 1.39.32 1.71.17.43.37.74.69 1.06.32.32.63.52 1.06.69.32.13.81.28 1.71.32 1.24.06 1.61.07 4.75.07s3.51-.01 4.75-.07c.9-.04 1.39-.19 1.71-.32.43-.17.74-.37 1.06-.69.32-.32.52-.63.69-1.06.13-.32.28-.81.32-1.71.06-1.24.07-1.61.07-4.75s-.01-3.51-.07-4.75c-.04-.9-.19-1.39-.32-1.71a2.85 2.85 0 0 0-.69-1.06 2.85 2.85 0 0 0-1.06-.69c-.32-.13-.81-.28-1.71-.32-1.24-.06-1.61-.07-4.75-.07zm0 3.37a5.49 5.49 0 1 1 0 10.98 5.49 5.49 0 0 1 0-10.98zm0 9.05a3.56 3.56 0 1 0 0-7.12 3.56 3.56 0 0 0 0 7.12zm6.99-9.27a1.28 1.28 0 1 1-2.56 0 1.28 1.28 0 0 1 2.56 0z"/>',
    facebook:
      '<path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.52 1.49-3.91 3.77-3.91 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.89h2.78l-.45 2.91h-2.33V22c4.78-.76 8.44-4.92 8.44-9.94z"/>',
    tiktok:
      '<path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.09v12.4a2.59 2.59 0 0 1-2.59 2.5 2.59 2.59 0 1 1 .77-5.06V9.7a5.68 5.68 0 0 0-.77-.05A5.66 5.66 0 1 0 15.54 15.3V9.01a7.35 7.35 0 0 0 4.3 1.38V7.3a4.29 4.29 0 0 1-3.24-1.48z"/>',
    whatsapp:
      '<path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2 22l5.25-1.38a9.86 9.86 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91A9.85 9.85 0 0 0 12.04 2zm0 18.15h-.01a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.11.82.83-3.04-.2-.31a8.2 8.2 0 0 1 12.75-10.1 8.13 8.13 0 0 1 2.4 5.79c0 4.54-3.7 8.17-8.18 8.17zm4.49-6.12c-.25-.12-1.45-.72-1.68-.8-.22-.08-.39-.12-.55.13-.16.24-.63.79-.77.96-.14.16-.28.18-.53.06-.25-.13-1.04-.38-1.98-1.22-.73-.65-1.23-1.46-1.37-1.71-.14-.24-.02-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.55-1.33-.76-1.82-.2-.48-.4-.41-.55-.42h-.47c-.16 0-.43.06-.65.31-.22.24-.86.84-.86 2.05s.88 2.38 1 2.54c.12.16 1.73 2.64 4.19 3.7.59.25 1.04.4 1.4.52.59.19 1.12.16 1.55.1.47-.07 1.45-.59 1.66-1.17.2-.57.2-1.06.14-1.16-.06-.11-.22-.17-.47-.29z"/>',
    x:
      '<path d="M17.53 3h3.02l-6.6 7.54L21.72 21h-6.08l-4.76-6.22L5.42 21H2.4l7.06-8.07L2.6 3h6.23l4.3 5.69L17.53 3zm-1.06 16.19h1.67L7.63 4.73H5.84l10.63 14.46z"/>'
  };
})();
