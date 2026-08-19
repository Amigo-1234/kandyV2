/* ==========================================================================
   Kandy's Treats — Admin views
   --------------------------------------------------------------------------
   Phase 4 ships the dashboard placeholder only. Every other view renders an
   honest "not built yet" panel rather than a fake screen, so nobody mistakes
   scaffolding for a working module.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};
  KT.admin.views = {};

  function card(label, value, hint) {
    return '<div class="astat">' +
      '<span class="astat__label">' + label + "</span>" +
      '<strong class="astat__value">' + value + "</strong>" +
      (hint ? '<span class="astat__hint">' + hint + "</span>" : "") +
      "</div>";
  }

  KT.admin.views.dashboard = function (ctx) {
    var first = String(ctx.name || "").split(" ")[0] || "there";
    return (
      '<header class="apage__head">' +
        "<div><h1>Welcome back, " + first + "</h1>" +
        '<p class="apage__lede">You are signed in as <strong>' + ctx.role +
        "</strong>. This is the admin dashboard shell — live figures arrive with the " +
        "reporting module.</p></div>" +
      "</header>" +

      '<div class="astat__grid">' +
        card("Orders today", "—", "placeholder") +
        card("In the kitchen", "—", "placeholder") +
        card("Out for delivery", "—", "placeholder") +
        card("Completed today", "—", "placeholder") +
      "</div>" +

      '<div class="panel apanel">' +
        '<div class="panel__head"><h2>Not wired up yet</h2></div>' +
        "<p>These cards are deliberately blank. Phase 4 covers the shell, " +
        "authentication, authorisation and navigation only — no business " +
        "module reads or writes data yet.</p>" +
        '<p class="apanel__note">Your access level decides what appears in the ' +
        "sidebar, but the real boundary is the database: every screen built from " +
        "here is refused server-side if your role is not permitted, regardless of " +
        "what the interface shows.</p>" +
      "</div>"
    );
  };

  /** Placeholder for every module still to be built. */
  KT.admin.views.placeholder = function (ctx, item) {
    return (
      '<header class="apage__head"><div><h1>' + item.label + "</h1>" +
        '<p class="apage__lede">Requires <strong>' + item.min +
        "</strong> or above. You are <strong>" + ctx.role + "</strong>.</p></div></header>" +
      '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon(item.icon || "settings", 34) + "</div>" +
        "<h3>Coming in a later phase</h3>" +
        "<p>The shell and permissions for " + item.label.toLowerCase() +
        " are in place. The module itself has not been built yet.</p>" +
      "</div></div>"
    );
  };

  /** Shown when a role opens a view above its tier. */
  KT.admin.views.forbidden = function (ctx, id) {
    var item = KT.admin.itemById(id);
    return (
      '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("lock", 34) + "</div>" +
        "<h3>Not available to your role</h3>" +
        "<p>" + (item ? item.label + " requires <strong>" + item.min + "</strong> or above."
                      : "That screen does not exist.") +
        " You are signed in as <strong>" + ctx.role + "</strong>.</p>" +
        '<p class="apanel__note">Changing the address bar does not grant access: ' +
        "the database refuses the underlying requests either way.</p>" +
      "</div></div>"
    );
  };
})(window.KT || (window.KT = {}));
