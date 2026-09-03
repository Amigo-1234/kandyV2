/* ==========================================================================
   Kandy's Treats — Admin navigation model
   --------------------------------------------------------------------------
   One declaration of what exists and the minimum tier that may see it. The
   shell filters this list by rank, so a lower tier is never shown a link to
   something it cannot use.

   This is COSMETIC ONLY. The real boundary is the RLS policy or SECURITY
   DEFINER RPC behind each screen — a staff member who edits the hash by hand
   reaches the view, and every request it makes is still refused by Postgres.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  /* Mirrors public.role_rank() in the database, deliberately. */
  var RANK = { customer: 10, staff: 20, supervisor: 25, admin: 30, owner: 40 };

  KT.admin.rank = function (role) {
    return RANK[role] || 0;
  };

  /* min: the lowest tier that may see the item. */
  KT.admin.NAV = [
    { group: "Operations", items: [
      { id: "dashboard",  label: "Dashboard",         icon: "grid",     min: "staff" },
      { id: "orders",     label: "Orders",            icon: "receipt",  min: "staff" },
      { id: "menu",       label: "Menu availability", icon: "flame",    min: "staff" },
      /* badge: the shell paints an unread count on this item from
         admin_support_unread(). Cosmetic — the counter itself is
         chat_conversations.admin_unread, maintained server-side. */
      { id: "support",    label: "Support",           icon: "mail",     min: "staff", badge: "support" },
      /* staff+: every handler files their own end-of-day report, and the same
         route shows supervisors and above the whole team's. */
      { id: "end-of-day", label: "End of day",        icon: "check",    min: "staff" }
    ]},
    { group: "Management", items: [
      { id: "menu-manage", label: "Menu management",  icon: "settings", min: "admin" },
      /* staff+, not admin: Phase 7 gives staff an operational customer view
         (name, phone, order history). The redaction is enforced server-side
         by admin_list_customers / admin_get_customer, which return null for
         email, spend and addresses to a staff caller — so widening the nav
         does not widen the data. */
      { id: "customers",   label: "Customers",        icon: "user",     min: "staff" },
      { id: "announcements", label: "Announcements",  icon: "sparkle",  min: "admin" },
      { id: "finance",     label: "Finance",          icon: "wallet",   min: "admin" },
      /* admin+, because job_applications_admin_select scopes SELECT to
         is_manager(). A staff or supervisor account offered this screen would
         get an empty list, not a shorter one — the nav is gated to match the
         policy rather than to create it. */
      { id: "careers",     label: "Careers",          icon: "user",     min: "admin" },
      { id: "exports",     label: "Exports",          icon: "arrowRight", min: "admin" }
    ]},
    /* Renamed from "Owner": two of these three are now admin+, so calling the
       group Owner would misdescribe it. Reconciliation is still owner-only. */
    { group: "Administration", items: [
      /* Payment reconciliation is deliberately NOT a nav entry. The findings
         it would show already live inside Finance as a tab — same data, same
         admin+ tier — and there is no reconciliation view module, so the
         entry rendered "Coming in a later phase" while the dashboard tile
         beside it carried a live count. One home for one dataset. */
      /* admin+ since Phase 11. An admin sees every setting but may only WRITE
         the operational ones — setting_tier() decides that per key, in the
         database, and admin_settings() reports it back per row. */
      { id: "settings",       label: "App settings",           icon: "settings", min: "admin" },
      /* admin+ because admin_list_team permits a manager to VIEW the roster,
         and since Phase 11 an admin may also create and manage supervisors.
         Everything above supervisor stays owner-only inside admin_set_role. */
      { id: "team",           label: "Team & roles",           icon: "user",     min: "admin" }
    ]}
  ];

  /** Nav groups visible to a role, with empty groups dropped. */
  KT.admin.navFor = function (role) {
    var r = KT.admin.rank(role);
    return KT.admin.NAV
      .map(function (g) {
        return { group: g.group, items: g.items.filter(function (i) {
          return r >= KT.admin.rank(i.min);
        }) };
      })
      .filter(function (g) { return g.items.length; });
  };

  /** Flat lookup, used by the router to validate a hash. */
  KT.admin.itemById = function (id) {
    var found = null;
    KT.admin.NAV.forEach(function (g) {
      g.items.forEach(function (i) { if (i.id === id) found = i; });
    });
    return found;
  };

  /**
   * Query parameters carried on the hash, e.g. #/orders?status=Preparing.
   * The shell already splits the id off at "?"; this reads what follows so a
   * dashboard tile can deep-link into a module's existing filters instead of
   * a new screen being built for each one.
   */
  KT.admin.routeParams = function () {
    var h = String(window.location.hash || "");
    var q = h.indexOf("?");
    var out = {};
    if (q === -1) return out;
    new URLSearchParams(h.slice(q + 1)).forEach(function (v, k) { out[k] = v; });
    return out;
  };

  /** May this role open this view? */
  KT.admin.canOpen = function (role, id) {
    var item = KT.admin.itemById(id);
    if (!item) return false;
    return KT.admin.rank(role) >= KT.admin.rank(item.min);
  };
})(window.KT || (window.KT = {}));
