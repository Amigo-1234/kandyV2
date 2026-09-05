/* ==========================================================================
   Kandy's Treats — Staff flags
   --------------------------------------------------------------------------
   Rendering only; data access lives in js/services/admin-flags.js.

   PRIVATE MANAGEMENT RECORDS

   This screen is admin+ in the nav and is_manager() in the database. The
   person a flag is about cannot read it: there is no policy that would let
   them, and nothing on the customer site or in the staff-facing screens
   reads staff_flags at all. Nobody is notified about a flag except other
   managers, and then by title only — the details stay here.

   Its own screen rather than a tab inside Team & roles: team.js is a single
   600-line module with no tab structure, and threading one through it would
   have meant reworking a screen this phase has no other reason to touch.
   The roster links here, and here links back.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};
  KT.admin.views = KT.admin.views || {};

  var svc = null;
  var mountGen = 0, loadSeq = 0;

  function blank() {
    return {
      loading: true, error: null,
      rows: [], viewerRole: "", isOwner: false,
      showClosed: false,
      subject: null,          /* filter to one person, set from the roster link */
      composing: false,
      draft: null,
      busy: null,
      resolving: null         /* id of the flag whose resolution note is open */
    };
  }
  var state = blank();

  function esc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function when(d) {
    if (!d) return "—";
    return new Date(d).toLocaleString("en-NG", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }

  /* ---- Cards ------------------------------------------------------------- */

  function flagHTML(f) {
    var closed = f.status === "resolved" || f.status === "dismissed";
    var busy = state.busy === f.id;
    return (
      '<article class="flagcard flagcard--' + esc(f.severity) +
        (closed ? " is-closed" : "") + '" data-flag="' + esc(f.id) + '">' +
        '<header class="flagcard__head">' +
          "<div>" +
            '<h3 class="flagcard__title">' + esc(f.title) + "</h3>" +
            '<p class="flagcard__who">' +
              "<strong>" + esc(f.staff_name || "Team member") + "</strong>" +
              ' <span class="rolebadge rolebadge--' + esc(f.staff_role) + '">' +
                esc(f.staff_role) + "</span>" +
              "<span> · " + esc(svc.categoryLabel(f.category)) + "</span>" +
              "<span> · raised " + esc(when(f.created_at)) +
              (f.created_by_name ? " by " + esc(f.created_by_name) : "") + "</span>" +
            "</p>" +
          "</div>" +
          '<span class="flagpill flagpill--' + esc(f.severity) + '">' +
            esc(svc.severityLabel(f.severity)) + "</span>" +
        "</header>" +

        (f.details ? '<p class="flagcard__details">' + esc(f.details) + "</p>" : "") +

        (closed
          ? '<p class="flagcard__resolution">' +
              "<strong>" + esc(svc.statusLabel(f.status)) + "</strong>" +
              (f.resolved_by_name ? " by " + esc(f.resolved_by_name) : "") +
              " · " + esc(when(f.resolved_at)) +
              (f.resolution ? "<br>“" + esc(f.resolution) + "”" : "") +
            "</p>"
          : "") +

        '<footer class="flagcard__foot">' +
          '<span class="flagcard__status flagcard__status--' + esc(f.status) + '">' +
            esc(svc.statusLabel(f.status)) + "</span>" +
          '<span class="flagcard__actions">' +
            (state.resolving === f.id
              ? '<span class="flagcard__resolve">' +
                  '<input class="input" data-flag-note placeholder="How was it settled?">' +
                  '<button class="btn btn--ghost btn--sm" type="button" data-flag-cancel>Cancel</button>' +
                  '<button class="btn btn--primary btn--sm" type="button" ' +
                    'data-flag-do="resolved" data-flag-id="' + esc(f.id) + '"' +
                    (busy ? " disabled" : "") + ">Resolve</button>" +
                  '<button class="btn btn--soft btn--sm" type="button" ' +
                    'data-flag-do="dismissed" data-flag-id="' + esc(f.id) + '"' +
                    (busy ? " disabled" : "") + ">Dismiss</button>" +
                "</span>"
              : closed
                ? '<button class="btn btn--ghost btn--sm" type="button" ' +
                    'data-flag-do="open" data-flag-id="' + esc(f.id) + '"' +
                    (busy ? " disabled" : "") + ">Reopen</button>"
                : (f.status === "open"
                    ? '<button class="btn btn--ghost btn--sm" type="button" ' +
                        'data-flag-do="acknowledged" data-flag-id="' + esc(f.id) + '"' +
                        (busy ? " disabled" : "") + ">Acknowledge</button>"
                    : "") +
                  '<button class="btn btn--primary btn--sm" type="button" ' +
                    'data-flag-resolve="' + esc(f.id) + '">Settle</button>') +
          "</span>" +
        "</footer>" +
      "</article>"
    );
  }

  /* ---- Compose ----------------------------------------------------------- */

  function composeHTML() {
    if (!state.composing) return "";
    var d = state.draft || {};
    var people = state.people || [];
    /*
       The admin's existing dialog shape — .fin__modal / .fin__modalscrim /
       .fin__modalpanel, as finance.js uses for the refund confirmation. The
       first version of this screen invented .modal / .modal__scrim /
       .modal__panel, which no stylesheet defines, so the dialog computed
       position:static and rendered as a plain block at the foot of the page.

       The one addition is the --tall modifier below. Finance's dialog holds a
       single field and never outgrows the viewport; this one holds five and a
       note, so on a short screen the panel has to scroll inside itself or the
       buttons become unreachable. That is a rule on the existing panel, not a
       second modal system.
    */
    return (
      '<div class="fin__modal" data-flag-modal>' +
        '<div class="fin__modalscrim" data-flag-close></div>' +
        '<div class="fin__modalpanel fin__modalpanel--tall" role="dialog" ' +
             'aria-modal="true" aria-label="Raise a flag">' +
          '<div class="flagform__head">' +
            "<h3>Raise a flag</h3>" +
            '<button class="icon-btn" type="button" data-flag-close aria-label="Close">' +
              KT.icon("close", 18) + "</button>" +
          "</div>" +
          '<div class="flagform">' +
            '<label class="field"><span class="field__label">Team member</span>' +
              '<select class="select" data-flag-subject>' +
                (people.length
                  ? people.map(function (p) {
                      return '<option value="' + esc(p.id) + '"' +
                        (p.id === d.staffUserId ? " selected" : "") + ">" +
                        esc(p.name || p.email) + " (" + esc(p.role) + ")</option>";
                    }).join("")
                  : '<option value="">No team members found</option>') +
              "</select></label>" +
            '<label class="field"><span class="field__label">Summary</span>' +
              '<input class="input" data-flag-title maxlength="140" value="' +
                esc(d.title || "") + '" placeholder="What happened, in one line"></label>' +
            '<div class="flagform__row">' +
              '<label class="field"><span class="field__label">Category</span>' +
                '<select class="select" data-flag-category>' +
                  svc.FLAG_CATEGORIES.map(function (c) {
                    return '<option value="' + c.value + '"' +
                      (c.value === (d.category || "other") ? " selected" : "") + ">" +
                      esc(c.label) + "</option>";
                  }).join("") + "</select></label>" +
              '<label class="field"><span class="field__label">Severity</span>' +
                '<select class="select" data-flag-severity>' +
                  svc.FLAG_SEVERITIES.map(function (sv) {
                    return '<option value="' + sv.value + '"' +
                      (sv.value === (d.severity || "note") ? " selected" : "") + ">" +
                      esc(sv.label) + "</option>";
                  }).join("") + "</select></label>" +
            "</div>" +
            '<label class="field"><span class="field__label">Details</span>' +
              '<textarea class="input" rows="4" data-flag-details ' +
                'placeholder="Context, dates, what was agreed">' + esc(d.details || "") +
              "</textarea></label>" +
            '<p class="apanel__note">' + KT.icon("lock", 14) +
              " This is a private management record. The person it is about cannot " +
              "see it, and it is never emailed. High and critical flags notify the " +
              "other managers by title only.</p>" +
          "</div>" +
          '<div class="fin__modalactions">' +
            '<button class="btn btn--ghost" type="button" data-flag-close>Cancel</button>' +
            '<button class="btn btn--primary" type="button" data-flag-save' +
              (state.busy === "new" ? " disabled" : "") + ">" +
              (state.busy === "new" ? "Saving…" : "Raise flag") + "</button>" +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }

  /* ---- Shell ------------------------------------------------------------- */

  function listHTML() {
    if (state.error) {
      return '<div class="panel apanel"><div class="empty"><div class="empty__art">' +
        KT.icon("close", 32) + "</div><h3>Could not load staff flags</h3><p>" +
        esc(state.error) + '</p><button class="btn btn--soft" type="button" ' +
        "data-flag-reload>Try again</button></div></div>";
    }
    if (state.loading) {
      return '<div class="panel apanel">' + KT.loadingLabel("Loading flags…") +
        KT.skeleton.lines(4) + "</div>";
    }
    var rows = state.rows;
    if (!rows.length) {
      return '<div class="panel apanel"><div class="empty"><div class="empty__art">' +
        KT.icon("check", 30) + "</div><h3>Nothing flagged</h3>" +
        "<p>No accountability notes have been raised" +
        (state.showClosed ? "" : " that are still open") + ".</p></div></div>";
    }
    return '<div class="flaglist">' + rows.map(flagHTML).join("") + "</div>";
  }

  function paint() {
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    var open = state.rows.filter(function (f) {
      return f.status === "open" || f.status === "acknowledged";
    }).length;
    var severe = state.rows.filter(function (f) {
      return (f.status === "open" || f.status === "acknowledged") &&
             (f.severity === "high" || f.severity === "critical");
    }).length;

    KT.mount(host,
      '<header class="apage__head"><div><h1>Staff flags</h1>' +
        '<p class="apage__lede">Private management notes about the team — ' +
        "accountability, recognition and anything that needs following up. " +
        "The person a flag is about cannot see it.</p></div></header>" +
      '<div class="fin__filters">' +
        '<span class="flagstat">' + open + " open" +
          (severe ? ' <span class="flagstat__severe">' + severe + " high/critical</span>" : "") +
        "</span>" +
        '<label class="field flagtoggle"><input type="checkbox" data-flag-closed' +
          (state.showClosed ? " checked" : "") + "> <span>Show settled</span></label>" +
        '<button class="btn btn--ghost btn--sm" type="button" data-flag-reload>Refresh</button>' +
        '<button class="btn btn--primary btn--sm" type="button" data-flag-new>' +
          KT.icon("plus", 16) + "Raise a flag</button>" +
      "</div>" +
      listHTML() + composeHTML());
  }

  /* ---- Data -------------------------------------------------------------- */

  async function ensureSvc() {
    if (!svc) svc = (await import("../services/admin-flags.js")).adminFlagsService;
    return svc;
  }

  async function load() {
    var gen = mountGen, seq = ++loadSeq;
    state.loading = true; state.error = null; paint();
    try {
      await ensureSvc();
      var res = await svc.list(state.subject, state.showClosed);
      if (gen !== mountGen || seq !== loadSeq) return;
      state.rows = res.rows || [];
      state.viewerRole = res.viewer_role || "";
      state.isOwner = !!res.is_owner;
      state.loading = false;
      paint();
    } catch (error) {
      if (gen !== mountGen || seq !== loadSeq) return;
      state.loading = false;
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
      paint();
    }
  }

  /** The roster, so a flag can be pointed at somebody. Manager+ by policy. */
  async function loadPeople() {
    try {
      var team = (await import("../services/admin-team.js")).adminTeamService;
      /* "team" is admin_list_team()'s own filter for staff and above. */
      var res = await team.list({ role: "team", limit: 100, offset: 0 });
      state.people = (res.rows || []).map(function (r) {
        return { id: r.id, name: r.display_name || r.displayName || "", email: r.email, role: r.role };
      }).filter(function (p) { return KT.admin.rank(p.role) >= KT.admin.rank("staff"); });
    } catch (_) {
      state.people = [];
    }
  }

  /* ---- Wiring ------------------------------------------------------------ */

  document.addEventListener("click", async function (e) {
    if (e.target.closest("[data-flag-reload]")) { e.preventDefault(); load(); return; }

    if (e.target.closest("[data-flag-new]")) {
      e.preventDefault();
      state.composing = true;
      state.draft = { category: "other", severity: "note" };
      paint();
      await loadPeople();
      paint();
      return;
    }

    if (e.target.closest("[data-flag-close]")) {
      e.preventDefault(); state.composing = false; state.draft = null; paint(); return;
    }

    if (e.target.closest("[data-flag-save]")) {
      e.preventDefault();
      var subject = KT.qs("[data-flag-subject]");
      var title = KT.qs("[data-flag-title]");
      if (!subject || !subject.value) { KT.toast("Choose a team member.", "error"); return; }
      if (!title || !title.value.trim()) { KT.toast("A flag needs a summary.", "error"); return; }
      state.busy = "new"; paint();
      try {
        await ensureSvc();
        await svc.save({
          staffUserId: subject.value,
          title: title.value.trim(),
          details: (KT.qs("[data-flag-details]") || {}).value || "",
          category: (KT.qs("[data-flag-category]") || {}).value || "other",
          severity: (KT.qs("[data-flag-severity]") || {}).value || "note"
        });
        state.busy = null; state.composing = false; state.draft = null;
        KT.toast("Flag raised.", "success");
        load();
      } catch (error) {
        state.busy = null; paint();
        KT.toast(KT.services.errorMessage(error), "error", { duration: 7000 });
      }
      return;
    }

    var resolve = e.target.closest("[data-flag-resolve]");
    if (resolve) {
      e.preventDefault();
      state.resolving = resolve.getAttribute("data-flag-resolve");
      paint();
      return;
    }
    if (e.target.closest("[data-flag-cancel]")) {
      e.preventDefault(); state.resolving = null; paint(); return;
    }

    var act = e.target.closest("[data-flag-do]");
    if (act) {
      e.preventDefault();
      var id = act.getAttribute("data-flag-id");
      var status = act.getAttribute("data-flag-do");
      var note = KT.qs("[data-flag-note]");
      state.busy = id; paint();
      try {
        await ensureSvc();
        await svc.setStatus(id, status, note ? note.value : null);
        state.busy = null; state.resolving = null;
        KT.toast("Flag marked " + status + ".", "success");
        load();
      } catch (error) {
        state.busy = null; paint();
        KT.toast(KT.services.errorMessage(error), "error", { duration: 7000 });
      }
    }
  });

  document.addEventListener("change", function (e) {
    if (e.target.closest("[data-flag-closed]")) {
      state.showClosed = e.target.checked;
      load();
    }
  });

  /* ---- View -------------------------------------------------------------- */

  KT.admin.views.flags = function () {
    mountGen++;
    state = blank();
    /* The roster may link here for one person: #/flags?staff=<uuid>. */
    var m = /[?&]staff=([0-9a-f-]{36})/i.exec(window.location.hash);
    state.subject = m ? m[1] : null;
    window.setTimeout(load, 0);
    return '<header class="apage__head"><div><h1>Staff flags</h1>' +
      '<p class="apage__lede">Loading flags…</p></div></header>' +
      '<div class="panel apanel">' + KT.skeleton.lines(4) + "</div>";
  };

  KT.admin.views.flagsTeardown = function () {
    state.composing = false;
    state.draft = null;
    state.resolving = null;
    state.busy = null;
  };
})(window.KT || (window.KT = {}));
