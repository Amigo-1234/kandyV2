/* ==========================================================================
   Kandy's Treats — Admin views
   --------------------------------------------------------------------------
   Shared fallbacks only. The dashboard moved to js/admin/dashboard.js in
   Phase 12 when it stopped being a placeholder; what is left here is the
   "not built yet" panel and the forbidden screen, both of which exist so
   nobody mistakes scaffolding — or a blocked route — for a working module.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};
  KT.admin.views = {};

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
