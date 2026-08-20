/* ==========================================================================
   Kandy's Treats — Team management
   --------------------------------------------------------------------------
   Rendering only; data access lives in js/services/admin-team.js.

   Admin and owner both SEE this module, but only the owner can change a role,
   because admin_set_role is owner-only. The UI reads can_change_roles straight
   off the server response rather than deciding for itself — if the RPC's rule
   ever changes, this follows it instead of drifting out of step.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};
  KT.admin.views = KT.admin.views || {};

  var svc = null;
  var state = {
    loading: true, error: null,
    rows: [], total: 0, search: "", roleFilter: "team", offset: 0,
    canChange: false, ownerCount: 0, viewerRole: "",
    detail: null, detailLoading: false,
    confirm: null
  };
  var searchTimer = null;

  function esc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function when(d) {
    if (!d) return "—";
    return new Date(d).toLocaleDateString("en-NG", { day: "2-digit", month: "short", year: "numeric" });
  }
  function ago(d) {
    if (!d) return "never";
    var days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return days + " days ago";
    return when(d);
  }
  function initials(name, email) {
    var v = name || email || "?";
    return String(v).split(/[\s@.]+/).filter(Boolean)
      .map(function (n) { return n[0]; }).join("").slice(0, 2).toUpperCase();
  }

  /* ---- List -------------------------------------------------------------- */

  function rowHTML(m) {
    return (
      '<article class="teamrow" data-member="' + esc(m.id) + '">' +
        '<span class="teamrow__avatar">' + esc(initials(m.name, m.email)) + "</span>" +
        '<div class="teamrow__who">' +
          "<strong>" + esc(m.name || "—") + (m.is_self ? ' <span class="teamrow__you">you</span>' : "") + "</strong>" +
          "<span>" + esc(m.email) + "</span>" +
        "</div>" +
        '<span class="rolebadge rolebadge--' + esc(m.role) + '">' + esc(m.role) + "</span>" +
        '<div class="teamrow__meta">' +
          "<span>joined " + when(m.created_at) + "</span>" +
          "<span>last seen " + ago(m.last_sign_in_at) + "</span>" +
        "</div>" +
        (m.banned ? '<span class="teamrow__flag">suspended</span>' : "") +
      "</article>"
    );
  }

  function listHTML() {
    if (state.error) {
      return '<div class="panel apanel"><div class="empty"><div class="empty__art">' +
        KT.icon("close", 32) + "</div><h3>Could not load the team</h3><p>" + esc(state.error) +
        '</p><button class="btn btn--soft" type="button" data-team-reload>Try again</button></div></div>';
    }
    if (state.loading) {
      return '<div class="panel apanel">' + KT.loadingLabel("Loading team…") +
        KT.skeleton.lines(5) + "</div>";
    }
    if (!state.rows.length) {
      return '<div class="panel apanel"><div class="empty"><div class="empty__art">' +
        KT.icon("user", 30) + "</div><h3>Nobody here</h3><p>" +
        (state.search || state.roleFilter !== "team"
          ? "Nothing matches that filter."
          : "No team members yet.") + "</p></div></div>";
    }
    var pages = Math.ceil(state.total / svc.PAGE_SIZE);
    var page = Math.floor(state.offset / svc.PAGE_SIZE) + 1;
    return (
      '<p class="fin__count">' + state.total + " " +
        (state.roleFilter === "team" ? "team member" : "account") +
        (state.total === 1 ? "" : "s") + "</p>" +
      '<div class="fin__rows">' + state.rows.map(rowHTML).join("") + "</div>" +
      (pages > 1
        ? '<div class="team__pager">' +
            '<button class="btn btn--ghost btn--sm" type="button" data-team-page="prev"' +
              (state.offset <= 0 ? " disabled" : "") + ">Previous</button>" +
            "<span>Page " + page + " of " + pages + "</span>" +
            '<button class="btn btn--ghost btn--sm" type="button" data-team-page="next"' +
              (page >= pages ? " disabled" : "") + ">Next</button>" +
          "</div>"
        : "")
    );
  }

  /* ---- Detail drawer ----------------------------------------------------- */

  function detailHTML() {
    if (!state.detail && !state.detailLoading) return "";
    var d = state.detail;
    var m = d && d.member;
    return (
      '<div class="team__drawer" data-team-drawer>' +
        '<div class="team__scrim" data-team-close></div>' +
        '<aside class="team__panel" role="dialog" aria-modal="true" aria-label="Team member">' +
          '<header class="team__panelhead">' +
            "<h3>Team member</h3>" +
            '<button class="icon-btn" type="button" data-team-close aria-label="Close">' +
              KT.icon("close", 20) + "</button>" +
          "</header>" +
          (state.detailLoading || !m
            ? '<div class="team__panelbody">' + KT.skeleton.lines(5) + "</div>"
            : '<div class="team__panelbody">' +
                '<div class="team__identity">' +
                  '<span class="teamrow__avatar teamrow__avatar--lg">' +
                    esc(initials(m.name, m.email)) + "</span>" +
                  "<div><strong>" + esc(m.name || "—") + "</strong>" +
                  "<span>" + esc(m.email) + "</span>" +
                  '<span class="rolebadge rolebadge--' + esc(m.role) + '">' + esc(m.role) + "</span></div>" +
                "</div>" +

                '<dl class="finrow__facts team__facts">' +
                  "<div><dt>Phone</dt><dd>" + esc(m.phone || "—") + "</dd></div>" +
                  "<div><dt>Joined</dt><dd>" + when(m.created_at) + "</dd></div>" +
                  "<div><dt>Last sign-in</dt><dd>" + ago(m.last_sign_in_at) + "</dd></div>" +
                  "<div><dt>Email confirmed</dt><dd>" + (m.email_confirmed ? "Yes" : "No") + "</dd></div>" +
                "</dl>" +

                (d.can_change_roles ? roleControlHTML(m) : lockedNoteHTML()) +

                '<h4 class="team__subhead">Role history</h4>' +
                (!d.history_available
                  ? '<p class="team__muted">Role history is visible to the owner only.</p>'
                  : !d.history.length
                    ? '<p class="team__muted">No role changes recorded for this account.</p>'
                    : '<ol class="team__history">' +
                        d.history.map(function (h) {
                          return "<li><strong>" + esc(h.summary) + "</strong>" +
                            "<span>" + esc(h.actor_email || "system") + " · " +
                            new Date(h.at).toLocaleString("en-NG",
                              { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) +
                            "</span></li>";
                        }).join("") +
                      "</ol>") +
              "</div>") +
        "</aside>" +
      "</div>"
    );
  }

  function lockedNoteHTML() {
    return '<p class="fin__note">' + KT.icon("lock", 15) +
      "<span>Only the owner can change roles. This is enforced by the database, " +
      "not by hiding the control.</span></p>";
  }

  function roleControlHTML(m) {
    var lastOwner = m.role === "owner" && state.ownerCount <= 1;
    return (
      '<div class="team__rolebox">' +
        '<label class="field"><span class="field__label">Change role</span>' +
          '<select class="select" data-team-role' + (lastOwner ? " disabled" : "") + ">" +
            svc.ROLES.map(function (r) {
              return '<option value="' + r.value + '"' +
                (r.value === m.role ? " selected" : "") + ">" + r.label + "</option>";
            }).join("") +
          "</select>" +
          '<span class="field__hint">' +
            (lastOwner
              ? "This is the only owner. Promote another owner before changing this one."
              : "Takes effect immediately and is recorded in the audit log.") +
          "</span></label>" +
      "</div>"
    );
  }

  /* ---- Confirmation ------------------------------------------------------ */

  function confirmHTML() {
    var c = state.confirm;
    if (!c) return "";
    var sum = svc.changeSummary(c.from, c.to);
    return (
      '<div class="fin__modal" data-team-modal>' +
        '<div class="fin__modalscrim" data-team-cancel></div>' +
        '<div class="fin__modalpanel" role="dialog" aria-modal="true">' +
          "<h3>Change " + esc(c.name || c.email) + " from " +
            esc(svc.roleMeta(c.from).label) + " to " + esc(svc.roleMeta(c.to).label) + "?</h3>" +
          '<dl class="finrow__facts" style="margin-bottom:14px">' +
            "<div><dt>Current role</dt><dd>" + esc(svc.roleMeta(c.from).label) + "</dd></div>" +
            "<div><dt>New role</dt><dd>" + esc(svc.roleMeta(c.to).label) + "</dd></div>" +
          "</dl>" +
          '<p class="' + (sum.dangerous ? "fin__warn" : "fin__note") + '">' +
            KT.icon(sum.dangerous ? "close" : "sparkle", 16) +
            "<span>" +
              (c.to === "owner"
                ? "<strong>This grants full control of Kandy's Treats</strong> — roles, wallet " +
                  "adjustments, app settings and every financial control."
                : c.from === "owner"
                  ? "<strong>This removes owner access.</strong> " + esc(sum.loses)
                  : esc(svc.roleMeta(c.to).blurb)) +
            "</span></p>" +
          '<div class="fin__modalactions">' +
            '<button class="btn btn--ghost" type="button" data-team-cancel>Cancel</button>' +
            '<button class="btn btn--primary" type="button" data-team-confirm>' +
              (sum.dangerous ? "Yes, change it" : "Change role") + "</button>" +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }

  /* ---- Shell ------------------------------------------------------------- */

  function paint() {
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    KT.mount(host,
      '<header class="apage__head"><div><h1>Team &amp; roles</h1>' +
        '<p class="apage__lede">Who has access to the admin, and at what level.' +
        (state.canChange ? "" : " Role changes are owner-only.") + "</p></div></header>" +
      '<div class="fin__filters">' +
        '<label class="field fin__search"><span class="sr-only">Search team</span>' +
          '<input class="input" type="search" data-team-search placeholder="Name or email" ' +
            'value="' + esc(state.search) + '"></label>' +
        '<label class="field"><span class="sr-only">Role</span>' +
          '<select class="select" data-team-filter>' +
            (svc ? svc.ROLE_FILTERS : []).map(function (f) {
              return '<option value="' + f.value + '"' +
                (f.value === state.roleFilter ? " selected" : "") + ">" + f.label + "</option>";
            }).join("") +
          "</select></label>" +
        '<button class="btn btn--ghost btn--sm" type="button" data-team-reload>Refresh</button>' +
      "</div>" +
      listHTML() + detailHTML() + confirmHTML());
  }

  /* ---- Data -------------------------------------------------------------- */

  async function load() {
    state.loading = true; state.error = null; paint();
    try {
      if (!svc) svc = (await import("../services/admin-team.js")).adminTeamService;
      var res = await svc.list({
        search: state.search, role: state.roleFilter,
        limit: svc.PAGE_SIZE, offset: state.offset });
      state.rows = res.rows || [];
      state.total = res.total || 0;
      state.canChange = !!res.can_change_roles;
      state.ownerCount = res.owner_count || 0;
      state.viewerRole = res.viewer_role || "";
      state.loading = false;
      paint();
    } catch (error) {
      state.loading = false;
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
      paint();
    }
  }

  async function openMember(id) {
    state.detailLoading = true; state.detail = null; paint();
    try {
      state.detail = await svc.member(id);
      state.ownerCount = state.detail.owner_count || state.ownerCount;
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error");
      state.detail = null;
    } finally {
      state.detailLoading = false;
      paint();
    }
  }

  /* ---- Wiring ------------------------------------------------------------ */

  document.addEventListener("click", async function (e) {
    if (e.target.closest("[data-team-reload]")) { e.preventDefault(); load(); return; }

    var pager = e.target.closest("[data-team-page]");
    if (pager) {
      state.offset = pager.getAttribute("data-team-page") === "next"
        ? state.offset + svc.PAGE_SIZE
        : Math.max(0, state.offset - svc.PAGE_SIZE);
      load();
      return;
    }

    if (e.target.closest("[data-team-close]")) { state.detail = null; paint(); return; }
    if (e.target.closest("[data-team-cancel]")) { state.confirm = null; paint(); return; }

    if (e.target.closest("[data-team-confirm]")) {
      var c = state.confirm;
      var done = KT.busy(e.target.closest("[data-team-confirm]"), "Saving…");
      if (!done) return;
      try {
        var out = await svc.setRole(c.id, c.to);
        state.confirm = null;
        KT.toast("Role updated: " + (out.from || c.from) + " → " + (out.to || c.to),
          "success", { duration: 4600 });
        await load();
        await openMember(c.id);            /* refresh the member and its history */
      } catch (error) {
        done();
        KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
      }
      return;
    }

    var row = e.target.closest("[data-member]");
    if (row) { openMember(row.getAttribute("data-member")); }
  });

  document.addEventListener("change", function (e) {
    var filter = e.target.closest("[data-team-filter]");
    if (filter) { state.roleFilter = filter.value; state.offset = 0; load(); return; }

    var sel = e.target.closest("[data-team-role]");
    if (sel && state.detail && state.detail.member) {
      var m = state.detail.member;
      if (sel.value === m.role) return;
      state.confirm = { id: m.id, name: m.name, email: m.email, from: m.role, to: sel.value };
      sel.value = m.role;                  /* never change on the select alone */
      paint();
    }
  });

  document.addEventListener("input", function (e) {
    var s = e.target.closest("[data-team-search]");
    if (!s) return;
    state.search = s.value;
    state.offset = 0;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(load, 320);      /* debounced */
  });

  KT.admin.views.team = function () {
    state = { loading: true, error: null, rows: [], total: 0, search: "", roleFilter: "team",
      offset: 0, canChange: false, ownerCount: 0, viewerRole: "",
      detail: null, detailLoading: false, confirm: null };
    window.setTimeout(load, 0);
    return '<header class="apage__head"><div><h1>Team &amp; roles</h1>' +
      '<p class="apage__lede">Loading team…</p></div></header>' +
      '<div class="panel apanel">' + KT.skeleton.lines(5) + "</div>";
  };

  KT.admin.views.teamTeardown = function () {
    window.clearTimeout(searchTimer);
    state.detail = null;
    state.confirm = null;
  };
})(window.KT || (window.KT = {}));
