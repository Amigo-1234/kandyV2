/* ==========================================================================
   Kandy's Treats — Team management
   --------------------------------------------------------------------------
   Rendering only; data access lives in js/services/admin-team.js.

   Admin and owner both SEE this module. What each may DO is the server's
   answer, not this file's: admin_list_team returns `assignable_roles`, and
   admin_team_member returns `role_options` for that specific person, both
   computed by can_assign_role() — the same function admin_set_role() consults
   before it acts. The dropdown therefore cannot offer a move the RPC would
   refuse, and cannot hide one it would allow.

   In practice that means an admin can create and unmake supervisors but
   cannot touch a fellow admin, cannot mint an owner and cannot change their
   own role, while the owner can do all of it. None of those sentences are
   written in JavaScript anywhere in this file.

   Invitations live here too, because an invitation is the only way to give a
   role to someone who has no account yet. The token is shown once, and the
   invitee sets their own password through the ordinary sign-up flow.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};
  KT.admin.views = KT.admin.views || {};

  var svc = null;
  function blank() {
    return {
      loading: true, error: null,
      rows: [], total: 0, search: "", roleFilter: "team", offset: 0,
      canChange: false, assignable: [], ownerCount: 0, viewerRole: "",
      detail: null, detailLoading: false,
      confirm: null,
      invites: [], inviteOpen: false, inviteBusy: false, issued: null
    };
  }
  var state = blank();
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
        flagBadgeHTML(m) +
      "</article>"
    );
  }

  /*
     Open accountability flags for this person, if any. The counts come from
     staff_flag_summary(), which is is_manager() in the database — a
     supervisor who somehow reached this screen gets no counts rather than a
     redacted set, because the request itself is refused.

     Deliberately a COUNT and nothing more. Titles and details are private
     management records; the roster is not the place to spill them, and the
     subject of a flag can be standing behind whoever is looking.
  */
  function flagBadgeHTML(m) {
    var c = (state.flags || {})[m.id];
    if (!c || !c.open) return "";
    var severe = Number(c.severe || 0);
    return '<button class="teamrow__flags' + (severe ? " is-severe" : "") +
      '" type="button" data-team-flags="' + esc(m.id) + '" ' +
      'title="Open staff flags">' + KT.icon("flame", 13) + c.open +
      (severe ? " · " + severe + " urgent" : "") + "</button>";
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

                (d.can_change_roles
                  ? roleControlHTML(m, d.role_options || [])
                  : lockedNoteHTML(m)) +

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

  function lockedNoteHTML(m) {
    var why = m.is_self
      ? "You cannot change your own role."
      : m.role === "owner" || m.role === "admin"
        ? "Admins and the owner are the owner's to appoint. You are an admin."
        : "Your role does not permit changing this account.";
    return '<p class="fin__note">' + KT.icon("lock", 15) +
      "<span>" + esc(why) + " This is enforced by the database, not by hiding " +
      "the control.</span></p>";
  }

  function roleControlHTML(m, options) {
    var lastOwner = m.role === "owner" && state.ownerCount <= 1;
    /* `options` is role_options from the server: exactly the moves
       can_assign_role() would permit for this viewer and this person. The
       current role is added so the select has something to sit on. */
    var values = options.slice();
    if (values.indexOf(m.role) === -1) values.unshift(m.role);
    return (
      '<div class="team__rolebox">' +
        '<label class="field"><span class="field__label">Change role</span>' +
          '<select class="select" data-team-role' + (lastOwner ? " disabled" : "") + ">" +
            values.map(function (v) {
              return '<option value="' + esc(v) + '"' +
                (v === m.role ? " selected" : "") + ">" + esc(svc.roleMeta(v).label) + "</option>";
            }).join("") +
          "</select>" +
          '<span class="field__hint">' +
            (lastOwner
              ? "This is the only owner. Promote another owner before changing this one."
              : "Takes effect immediately and is recorded in the audit log.") +
          "</span></label>" +
        '<p class="team__rolehint">' + esc(svc.roleMeta(m.role).blurb) + "</p>" +
      "</div>"
    );
  }

  /* ---- Invitations ------------------------------------------------------- */

  /*
     The token appears exactly once, in the panel below, and is never stored
     anywhere it could be read again — not in the invitation row (only its
     SHA-256 is kept), not in the audit log, and not in this module's state
     beyond the moment the panel is dismissed.
  */

  function invitableRoles() {
    /* assignable_roles from the server, minus the two that are not team
       seats. An invitation creates a colleague; a customer just signs up. */
    return (state.assignable || []).filter(function (r) {
      return r === "staff" || r === "supervisor" || r === "admin";
    });
  }

  function inviteListHTML() {
    if (!state.invites.length) return "";
    return (
      '<div class="team__invites">' +
        '<h4 class="team__subhead">Pending invitations</h4>' +
        state.invites.map(function (i) {
          var expired = i.status === "expired";
          return '<article class="inviterow' + (expired ? " is-expired" : "") + '">' +
            '<span class="inviterow__icon">' + KT.icon("mail", 17) + "</span>" +
            '<div class="inviterow__who"><strong>' + esc(i.email) + "</strong>" +
              "<span>invited by " + esc(i.invited_by || "—") + " · " +
              (expired ? "expired " : "expires ") + when(i.expires_at) + "</span></div>" +
            '<span class="rolebadge rolebadge--' + esc(i.role) + '">' + esc(i.role) + "</span>" +
            '<button class="btn btn--ghost btn--sm" type="button" data-invite-revoke="' +
              esc(i.id) + '">Revoke</button>' +
          "</article>";
        }).join("") +
      "</div>"
    );
  }

  function issuedHTML() {
    var iss = state.issued;
    var link = svc.inviteLink(iss.token);
    return (
      '<div class="fin__modal" data-invite-modal>' +
        '<div class="fin__modalscrim" data-invite-done></div>' +
        '<div class="fin__modalpanel" role="dialog" aria-modal="true">' +
          "<h3>Invitation ready for " + esc(iss.email) + "</h3>" +
          '<p class="fin__note">' + KT.icon("lock", 16) +
            "<span>Send this link to " + esc(iss.email) + " yourself. They sign in or " +
            "sign up <strong>with that exact address</strong> and choose their own " +
            "password — the link alone cannot promote anyone. It expires on " +
            esc(when(iss.expires_at)) + ".</span></p>" +
          '<label class="field"><span class="field__label">Invitation link</span>' +
            '<input class="input team__tokenbox" data-invite-link readonly value="' +
              esc(link) + '"></label>' +
          '<p class="fin__warn">' + KT.icon("close", 16) +
            "<span><strong>This is the only time it is shown.</strong> The database " +
            "stores a hash, not the link, so it cannot be looked up again — revoke " +
            "and reissue if it is lost.</span></p>" +
          '<div class="fin__modalactions">' +
            '<button class="btn btn--soft" type="button" data-invite-copy>Copy link</button>' +
            '<button class="btn btn--primary" type="button" data-invite-done>Done</button>' +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }

  function inviteFormHTML() {
    var roles = invitableRoles();
    if (!state.inviteOpen) return "";
    return (
      '<div class="fin__modal" data-invite-form-modal>' +
        '<div class="fin__modalscrim" data-invite-cancel></div>' +
        '<form class="fin__modalpanel" data-invite-form role="dialog" aria-modal="true">' +
          "<h3>Invite a teammate</h3>" +
          '<p class="fin__note">' + KT.icon("sparkle", 16) +
            "<span>No account is created here and no password is set. They receive a " +
            "one-time link, sign up with the email you enter, and the role is " +
            "assigned by the database when they accept.</span></p>" +
          '<label class="field"><span class="field__label">Email</span>' +
            '<input class="input" name="email" type="email" required autocomplete="off" ' +
              'placeholder="name@example.com"></label>' +
          '<label class="field"><span class="field__label">Name <em>(optional)</em></span>' +
            '<input class="input" name="name" type="text" autocomplete="off"></label>' +
          '<label class="field"><span class="field__label">Phone <em>(optional)</em></span>' +
            '<input class="input" name="phone" type="tel" autocomplete="off"></label>' +
          '<label class="field"><span class="field__label">Role</span>' +
            '<select class="select" name="role">' +
              roles.map(function (r) {
                return '<option value="' + esc(r) + '"' +
                  (r === "supervisor" ? " selected" : "") + ">" +
                  esc(svc.roleMeta(r).label) + "</option>";
              }).join("") +
            "</select>" +
            '<span class="field__hint" data-invite-blurb>' +
              esc(svc.roleMeta(roles.indexOf("supervisor") >= 0 ? "supervisor" : roles[0]).blurb) +
            "</span></label>" +
          '<div class="fin__modalactions">' +
            '<button class="btn btn--ghost" type="button" data-invite-cancel>Cancel</button>' +
            '<button class="btn btn--primary" type="submit">Send invitation</button>' +
          "</div>" +
        "</form>" +
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
        (!state.canChange
          ? " Your role does not permit changing anyone's."
          : state.viewerRole === "owner"
            ? " You can change any role."
            : " You can manage staff and supervisors; admins and owners are the " +
              "owner's to appoint.") + "</p></div></header>" +
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
        (invitableRoles().length
          ? '<button class="btn btn--primary btn--sm team__invitebtn" type="button" ' +
            'data-invite-open>' + KT.icon("plus", 16) + "Invite teammate</button>"
          : "") +
      "</div>" +
      inviteListHTML() + listHTML() + detailHTML() + confirmHTML() +
      inviteFormHTML() + (state.issued ? issuedHTML() : ""));
  }

  /* ---- Data -------------------------------------------------------------- */

  async function load() {
    state.loading = true; state.error = null; paint();
    try {
      if (!svc) svc = (await import("../services/admin-team.js")).adminTeamService;
      var res = await svc.list({
        search: state.search, role: state.roleFilter,
        limit: svc.PAGE_SIZE, offset: state.offset });
      /* Best-effort: the roster must still render if flags are unavailable
         (not yet migrated, or the viewer is below is_manager()). */
      try {
        var flagSvc = (await import("../services/admin-flags.js")).adminFlagsService;
        state.flags = await flagSvc.summary();
      } catch (_) { state.flags = {}; }
      state.rows = res.rows || [];
      state.total = res.total || 0;
      state.canChange = !!res.can_change_roles;
      state.assignable = res.assignable_roles || [];
      state.ownerCount = res.owner_count || 0;
      state.viewerRole = res.viewer_role || "";
      state.loading = false;
      paint();
      /* Invitations are a separate, cheaper query and must never hold up the
         roster — a manager with no pending invites should not wait for an
         empty list. */
      loadInvites();
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

  async function loadInvites() {
    if (!invitableRoles().length) { state.invites = []; return; }
    try {
      state.invites = await svc.invitations("pending");
    } catch (error) {
      state.invites = [];         /* a failed invite list must not break the roster */
    }
    paint();
  }

  async function sendInvite(form) {
    var data = Object.fromEntries(new FormData(form).entries());
    var done = KT.busy(KT.qs("[type=submit]", form), "Sending…");
    if (!done) return;
    try {
      var out = await svc.invite({
        email: data.email, role: data.role,
        name: data.name || "", phone: data.phone || ""
      });
      state.inviteOpen = false;
      state.issued = out;          /* the only place the token ever lives */
      paint();
      loadInvites();
    } catch (error) {
      done();
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6500 });
    }
  }

  /* ---- Wiring ------------------------------------------------------------ */

  document.addEventListener("click", async function (e) {
    if (e.target.closest("[data-team-reload]")) { e.preventDefault(); load(); return; }

    if (e.target.closest("[data-invite-open]")) {
      e.preventDefault(); state.inviteOpen = true; paint();
      var first = KT.qs("[data-invite-form] input[name=email]");
      if (first) first.focus();
      return;
    }
    if (e.target.closest("[data-invite-cancel]")) {
      e.preventDefault(); state.inviteOpen = false; paint(); return;
    }
    if (e.target.closest("[data-invite-done]")) {
      /* Dropping it from state is the last copy going away. */
      e.preventDefault(); state.issued = null; paint(); return;
    }
    if (e.target.closest("[data-invite-copy]")) {
      e.preventDefault();
      var box = KT.qs("[data-invite-link]");
      if (!box) return;
      box.select();
      try {
        await navigator.clipboard.writeText(box.value);
        KT.toast("Invitation link copied.", "success");
      } catch (err) {
        /* Clipboard access can be refused; the field is selected either way. */
        KT.toast("Select the link and copy it.", "error");
      }
      return;
    }

    var rev = e.target.closest("[data-invite-revoke]");
    if (rev) {
      e.preventDefault();
      var doneRev = KT.busy(rev, "Revoking…");
      if (!doneRev) return;
      try {
        await svc.revokeInvitation(rev.getAttribute("data-invite-revoke"));
        KT.toast("Invitation revoked.", "success");
        await loadInvites();
      } catch (error) {
        doneRev();
        KT.toast(KT.services.errorMessage(error), "error");
      }
      return;
    }

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
    var inviteRole = e.target.closest("[data-invite-form] select[name=role]");
    if (inviteRole) {
      var hint = KT.qs("[data-invite-blurb]");
      if (hint) hint.textContent = svc.roleMeta(inviteRole.value).blurb;
      return;
    }

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

  document.addEventListener("submit", function (e) {
    var form = e.target.closest("[data-invite-form]");
    if (!form) return;
    e.preventDefault();
    sendInvite(form);
  });

  document.addEventListener("input", function (e) {
    var s = e.target.closest("[data-team-search]");
    if (!s) return;
    state.search = s.value;
    state.offset = 0;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(load, 320);      /* debounced */
  });

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-team-flags]");
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();          /* not a row click: do not open the member drawer */
    window.location.hash = "#/flags?staff=" + b.getAttribute("data-team-flags");
  });

  KT.admin.views.team = function () {
    state = blank();
    window.setTimeout(load, 0);
    return '<header class="apage__head"><div><h1>Team &amp; roles</h1>' +
      '<p class="apage__lede">Loading team…</p></div></header>' +
      '<div class="panel apanel">' + KT.skeleton.lines(5) + "</div>";
  };

  KT.admin.views.teamTeardown = function () {
    window.clearTimeout(searchTimer);
    state.detail = null;
    state.confirm = null;
    state.inviteOpen = false;
    /* Navigating away discards the token. It was never recoverable anyway;
       leaving it in memory would only make it recoverable by accident. */
    state.issued = null;
  };
})(window.KT || (window.KT = {}));
