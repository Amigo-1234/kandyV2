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
  var RANK = { customer: 10, staff: 20, admin: 30, owner: 40 };

  KT.admin.rank = function (role) {
    return RANK[role] || 0;
  };

  /* min: the lowest tier that may see the item. */
  KT.admin.NAV = [
    { group: "Operations", items: [
      { id: "dashboard",  label: "Dashboard",         icon: "grid",     min: "staff" },
      { id: "orders",     label: "Orders",            icon: "receipt",  min: "staff" },
      { id: "menu",       label: "Menu availability", icon: "flame",    min: "staff" },
      { id: "support",    label: "Support",           icon: "mail",     min: "staff" }
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
      { id: "messages",    label: "Contact messages", icon: "mail",     min: "admin" },
      { id: "finance",     label: "Finance",          icon: "wallet",   min: "admin" },
      { id: "exports",     label: "Exports",          icon: "arrowRight", min: "admin" }
    ]},
    { group: "Owner", items: [
      { id: "reconciliation", label: "Payment reconciliation", icon: "lock", min: "owner" },
      { id: "settings",       label: "App settings",           icon: "settings", min: "owner" },
      { id: "team",           label: "Team & roles",           icon: "user",     min: "owner" }
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

  /** May this role open this view? */
  KT.admin.canOpen = function (role, id) {
    var item = KT.admin.itemById(id);
    if (!item) return false;
    return KT.admin.rank(role) >= KT.admin.rank(item.min);
  };
})(window.KT || (window.KT = {}));
