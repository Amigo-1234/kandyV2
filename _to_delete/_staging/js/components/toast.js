/* ==========================================================================
   Kandy's Treats — Toast
   Small, quiet confirmations. Stacks, auto-dismisses, respects reduced motion.
   ========================================================================== */
(function (KT) {
  "use strict";

  var host;

  function ensure() {
    if (host) return host;
    host = document.createElement("div");
    host.className = "toasts";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
    return host;
  }

  var ICONS = { success: "check", info: "sparkle", error: "close" };

  KT.toast = function (message, type, opts) {
    opts = opts || {};
    var root = ensure();

    var t = document.createElement("div");
    t.className = "toast toast--" + (type || "info");
    t.innerHTML =
      '<span class="toast__icon">' + KT.icon(ICONS[type] || "sparkle", 16) + "</span>" +
      '<span class="toast__msg">' + message + "</span>" +
      (opts.action ? '<button class="toast__action" type="button">' + opts.action + "</button>" : "") +
      '<button class="toast__close" type="button" aria-label="Dismiss">' + KT.icon("close", 15) + "</button>";

    root.appendChild(t);
    requestAnimationFrame(function () {
      t.classList.add("is-in");
    });

    var timer = setTimeout(close, opts.duration || 3600);

    function close() {
      clearTimeout(timer);
      t.classList.remove("is-in");
      setTimeout(function () {
        t.remove();
      }, 260);
    }

    var actionBtn = KT.qs(".toast__action", t);
    if (actionBtn) {
      actionBtn.addEventListener("click", function () {
        close();
        if (opts.onAction) opts.onAction();
      });
    }
    KT.qs(".toast__close", t).addEventListener("click", close);

    /* Never let the stack run away. */
    while (root.children.length > 3) root.firstElementChild.remove();

    return close;
  };
})(window.KT || (window.KT = {}));
