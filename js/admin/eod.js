/* ==========================================================================
   Kandy's Treats — End of day
   --------------------------------------------------------------------------
   One route, two audiences.

   Every handler sees MY DAY: what they did, derived from the orders they
   moved, and five boxes for the things a query cannot know. The derived half
   is rendered as figures, not inputs — there is no column behind them to
   write to, so "staff cannot edit the automatic numbers" is a fact about the
   schema rather than a rule this file enforces.

   Supervisor and above additionally see THE TEAM: who has reported, who has
   not, and each person's derived activity beside their words — so the
   question "who is still outstanding" is answered by looking, not by opening
   six reports.

   Rendering and interaction only. Every query lives in
   js/services/admin-eod.js.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var svc = null;
  var mountGen = 0;
  var viewGen = -1;
  var saveTimer = null;
  var stopViewport = null;   /* KT.viewportInset teardown */

  var state = {
    loading: true, error: null,
    mine: null, team: null,
    tab: "mine",            /* supervisor+ can switch to "team" */
    draft: null,            /* the form's working copy */
    dirty: false, saving: false, submitting: false,
    open: null,             /* staff_id whose report is expanded on the team tab */
    reviewing: null         /* report id mid-review */
  };
  var ctx = { role: "staff" };

  function canSeeTeam() { return KT.admin.rank(ctx.role) >= KT.admin.rank("supervisor"); }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  var LAGOS = { timeZone: "Africa/Lagos" };
  function clock(v) {
    if (!v) return "—";
    return new Date(v).toLocaleTimeString("en-NG", Object.assign({
      hour: "2-digit", minute: "2-digit", hour12: false }, LAGOS));
  }

  /* ---- The five things a query cannot know -----------------------------
     Fewer boxes than the brief listed, on purpose: several of its prompts ask
     the same question in different words, and this form is filled in on a
     phone at the end of a shift. Each of these produces a different action
     from a manager, which is the test for whether a field earns its place. */
  var FIELDS = [
    { key: "problems", label: "What went wrong today?",
      hint: "Delivery trouble, equipment, anything that slowed the kitchen down." },
    { key: "customerIssues", label: "Customer issues",
      hint: "Complaints or problems a customer raised, in or out of the app." },
    { key: "stockIssues", label: "Anything running low or out?",
      hint: "Just what you noticed — counting stock comes later." },
    { key: "followUps", label: "Left unfinished",
      hint: "Anything the next shift needs to pick up." },
    { key: "notes", label: "Anything else management should know",
      hint: "Optional." }
  ];

  /* ---- Derived activity ------------------------------------------------- */

  function metric(label, value) {
    return '<div class="eodm"><span class="eodm__n">' + (Number(value) || 0) + "</span>" +
      '<span class="eodm__l">' + esc(label) + "</span></div>";
  }

  function activityHTML(a) {
    a = a || {};
    var span = (a.first_action_at || a.last_action_at)
      ? clock(a.first_action_at) + " – " + clock(a.last_action_at)
      : null;
    return (
      '<div class="eodact">' +
        '<div class="eodact__grid">' +
          metric("touched", a.orders_touched) +
          metric("picked up", a.orders_picked_up) +
          metric("completed", a.orders_completed) +
          metric("cancelled", a.orders_cancelled) +
          metric("status changes", a.status_changes) +
        "</div>" +
        (span ? '<p class="eodact__span">Active ' + esc(span) + "</p>"
              : '<p class="eodact__span">No order activity recorded today.</p>') +
      "</div>"
    );
  }

  /* ---- My day ----------------------------------------------------------- */

  function fieldHTML(f) {
    var v = (state.draft && state.draft[f.key]) || "";
    return (
      '<label class="eodf">' +
        '<span class="eodf__label">' + esc(f.label) + "</span>" +
        '<span class="eodf__hint">' + esc(f.hint) + "</span>" +
        '<textarea class="input eodf__input" rows="2" data-eodfield="' + f.key + '" ' +
          'placeholder="Leave blank if there was nothing.">' + esc(v) + "</textarea>" +
      "</label>"
    );
  }

  function mineHTML() {
    var d = state.mine;
    if (!d) return "";
    var r = d.report;
    var submitted = r && r.status === "submitted";

    var status;
    if (submitted) {
      status = '<span class="eodpill eodpill--done">Submitted ' + clock(r.submitted_at) + "</span>" +
        (r.reviewed_at ? '<span class="eodpill eodpill--seen">Seen by management</span>' : "") +
        (r.needs_follow_up ? '<span class="eodpill eodpill--flag">Flagged for follow-up</span>' : "");
    } else if (r) {
      status = '<span class="eodpill eodpill--draft">Draft — not submitted</span>';
    } else {
      status = '<span class="eodpill eodpill--draft">Not started</span>';
    }

    return (
      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("check", 17) + "Your day</h2>" +
          '<span class="dsec__hint">' + esc(d.business_date) + "</span></header>" +
        '<div class="panel apanel">' +
          '<p class="eodlede">These come from the orders you moved. Nobody types them, ' +
            "and they cannot be edited.</p>" +
          activityHTML(d.activity) +
        "</div>" +
      "</section>" +

      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("mail", 17) + "Your report</h2>" +
          '<span class="eodstatus">' + status + "</span></header>" +
        '<div class="panel apanel eodform">' +
          '<p class="eodlede">Only what the system cannot see for itself.</p>' +
          FIELDS.map(fieldHTML).join("") +
          (r && r.reviewed_at && r.review_note
            ? '<div class="eodreview"><strong>From management</strong>' +
              "<p>" + esc(r.review_note) + "</p></div>"
            : "") +
          '<div class="eodactions">' +
            '<button class="btn btn--primary" type="button" data-eodsubmit' +
              (state.submitting ? " disabled" : "") + ">" +
              (state.submitting ? KT.spinner(15) + "<span>Sending…</span>"
                : submitted ? "Update my report" : "Submit my report") +
            "</button>" +
            '<button class="btn btn--soft" type="button" data-eodsave' +
              (state.saving ? " disabled" : "") + ">" +
              (state.saving ? KT.spinner(15) + "<span>Saving…</span>" : "Save draft") +
            "</button>" +
            (r && !submitted
              ? '<button class="btn btn--ghost" type="button" data-eoddiscard>Discard</button>'
              : "") +
            (state.dirty ? '<span class="eodunsaved">Unsaved changes</span>' : "") +
          "</div>" +
        "</div>" +
      "</section>"
    );
  }

  /* ---- The team --------------------------------------------------------- */

  function personHTML(p) {
    var r = p.report;
    var a = p.activity || {};
    var open = state.open === p.staff_id;
    var pill;
    if (r && r.status === "submitted") {
      pill = '<span class="eodpill eodpill--done">' + clock(r.submitted_at) + "</span>";
    } else if (r) {
      pill = '<span class="eodpill eodpill--draft">Draft</span>';
    } else if (p.expected) {
      pill = '<span class="eodpill eodpill--missing">Not submitted</span>';
    } else {
      pill = '<span class="eodpill eodpill--na">No report needed</span>';
    }

    var body = "";
    if (open && r) {
      var said = FIELDS.map(function (f) {
        var map = { problems: "problems", customerIssues: "customer_issues",
                    stockIssues: "stock_issues", followUps: "follow_ups", notes: "notes" };
        var v = r[map[f.key]];
        if (!v) return "";
        return '<div class="eodsaid"><dt>' + esc(f.label) + "</dt><dd>" + esc(v) + "</dd></div>";
      }).join("");
      body =
        '<div class="eodperson__body">' +
          (said || '<p class="odetail__muted">They reported nothing to flag.</p>') +
          (r.reviewed_at
            ? '<p class="odetail__muted">Reviewed ' + clock(r.reviewed_at) +
              (r.review_note ? " — " + esc(r.review_note) : "") + "</p>"
            : "") +
          '<div class="eodactions">' +
            '<button class="btn btn--soft btn--sm" type="button" data-eodreview="' + esc(r.id) + '" ' +
              'data-flag="0">' + (r.reviewed_at ? "Mark reviewed again" : "Mark reviewed") + "</button>" +
            '<button class="btn btn--ghost btn--sm odanger" type="button" ' +
              'data-eodreview="' + esc(r.id) + '" data-flag="1">' +
              (r.needs_follow_up ? "Still needs follow-up" : "Needs follow-up") + "</button>" +
          "</div>" +
        "</div>";
    } else if (open) {
      body = '<div class="eodperson__body"><p class="odetail__muted">' +
        "Nothing submitted yet, so there is nothing to read.</p></div>";
    }

    return (
      '<article class="eodperson' + (r && r.needs_follow_up ? " is-flagged" : "") + '">' +
        '<button class="eodperson__head" type="button" data-eodopen="' + esc(p.staff_id) + '" ' +
          'aria-expanded="' + (open ? "true" : "false") + '">' +
          '<span class="eodperson__who">' +
            "<strong>" + (esc(p.name) || "<em>Unnamed " + esc(p.role) + "</em>") + "</strong>" +
            '<span class="eodperson__role">' + esc(p.role) + "</span>" +
          "</span>" +
          '<span class="eodperson__stats">' +
            "<span>" + (Number(a.orders_touched) || 0) + " touched</span>" +
            "<span>" + (Number(a.orders_completed) || 0) + " completed</span>" +
            ((Number(a.orders_cancelled) || 0)
              ? "<span>" + a.orders_cancelled + " cancelled</span>" : "") +
          "</span>" +
          pill +
          '<span class="eodperson__chev">' + KT.icon("chevronDown", 16) + "</span>" +
        "</button>" +
        body +
      "</article>"
    );
  }

  function teamHTML() {
    var d = state.team;
    if (!d) return "";
    var t = d.team || {};
    var o = d.operations || {};
    var s = d.scoops || {};
    var net = (s.net && s.net.scoops) || 0;
    var rev = s.net && s.net.revenue;

    return (
      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("grid", 17) + "The day so far</h2>" +
          '<span class="dsec__hint">' + esc(d.business_date) + "</span></header>" +
        '<div class="astat__grid eodsum">' +
          '<div class="astat"><span class="astat__label">Reports in</span>' +
            '<strong class="astat__value">' + (t.submitted || 0) + " / " + (t.expected || 0) + "</strong>" +
            '<span class="astat__hint">from those who worked</span></div>' +
          '<div class="astat' + ((t.outstanding || 0) ? " dtile--warn" : "") + '">' +
            '<span class="astat__label">Outstanding</span>' +
            '<strong class="astat__value">' + (t.outstanding || 0) + "</strong>" +
            '<span class="astat__hint">still to report</span></div>' +
          '<div class="astat' + ((t.follow_up || 0) ? " dtile--alert" : "") + '">' +
            '<span class="astat__label">Needs follow-up</span>' +
            '<strong class="astat__value">' + (t.follow_up || 0) + "</strong>" +
            '<span class="astat__hint">flagged by management</span></div>' +
          '<div class="astat"><span class="astat__label">Orders received</span>' +
            '<strong class="astat__value">' + (o.received || 0) + "</strong>" +
            '<span class="astat__hint">' + (o.completed || 0) + " completed · " +
              (o.cancelled || 0) + " cancelled</span></div>" +
          '<div class="astat' + ((o.unattended || 0) ? " dtile--warn" : "") + '">' +
            '<span class="astat__label">Unattended</span>' +
            '<strong class="astat__value">' + (o.unattended || 0) + "</strong>" +
            '<span class="astat__hint">nobody has touched</span></div>' +
          '<div class="astat"><span class="astat__label">Scoops sold</span>' +
            '<strong class="astat__value">' + net + "</strong>" +
            '<span class="astat__hint">' +
              (rev === null || rev === undefined ? "net today" : KT.naira(rev)) + "</span></div>" +
        "</div>" +
      "</section>" +

      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("user", 17) + "Who worked today</h2></header>" +
        (d.people && d.people.length
          ? '<div class="eodlist">' + d.people.map(personHTML).join("") + "</div>"
          : '<div class="panel apanel"><p class="odetail__muted">' +
            "Nobody has worked an order yet today.</p></div>") +
      "</section>"
    );
  }

  /* ---- Shell ------------------------------------------------------------ */

  function tabsHTML() {
    if (!canSeeTeam()) return "";
    return (
      '<div class="ochips eodtabs">' +
        '<button class="chip' + (state.tab === "mine" ? " is-active" : "") +
          '" type="button" data-eodtab="mine">My day</button>' +
        '<button class="chip' + (state.tab === "team" ? " is-active" : "") +
          '" type="button" data-eodtab="team">The team</button>' +
      "</div>"
    );
  }

  function render() {
    if (viewGen !== mountGen) return;
    var host = KT.qs("[data-admin-page]");
    if (!host) return;

    var focused = document.activeElement;
    var focusKey = focused && focused.getAttribute && focused.getAttribute("data-eodfield");
    var caret = focusKey ? focused.selectionStart : null;

    var body;
    if (state.loading) {
      body = '<div class="panel apanel">' + KT.skeleton.lines(6) + "</div>";
    } else if (state.error) {
      body = '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("close", 32) + "</div>" +
        "<h3>We could not load your day</h3><p>" + esc(state.error) + "</p>" +
        '<button class="btn btn--primary" type="button" data-eodretry>Try again</button>' +
        "</div></div>";
    } else {
      body = state.tab === "team" && canSeeTeam() ? teamHTML() : mineHTML();
    }

    KT.mount(host,
      '<header class="apage__head"><div><h1>End of day</h1>' +
        '<p class="apage__lede">What the system already knows, and the part only you can tell it.</p>' +
      "</div></header>" + tabsHTML() + body);

    if (focusKey) {
      var again = KT.qs('[data-eodfield="' + focusKey + '"]');
      if (again) {
        again.focus();
        try { again.setSelectionRange(caret, caret); } catch (e) {}
      }
    }
  }

  /* ---- Data ------------------------------------------------------------- */

  function draftFrom(report) {
    return {
      problems:       (report && report.problems) || "",
      customerIssues: (report && report.customer_issues) || "",
      stockIssues:    (report && report.stock_issues) || "",
      followUps:      (report && report.follow_ups) || "",
      notes:          (report && report.notes) || ""
    };
  }

  async function load() {
    var gen = mountGen;
    state.loading = true; state.error = null;
    render();
    try {
      if (!svc) svc = (await import("../services/admin-eod.js")).adminEodService;
      var calls = [svc.staffDay()];
      if (canSeeTeam()) calls.push(svc.teamDay());
      var got = await Promise.all(calls);
      if (gen !== mountGen) return;
      state.mine = got[0];
      state.team = got[1] || null;
      /* Never clobber what the person is in the middle of typing. */
      if (!state.dirty) state.draft = draftFrom(state.mine && state.mine.report);
    } catch (error) {
      if (gen !== mountGen) return;
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
    } finally {
      if (gen === mountGen) { state.loading = false; render(); }
    }
  }

  async function save(submit) {
    if (state.saving || state.submitting) return;
    if (submit) state.submitting = true; else state.saving = true;
    render();
    try {
      await svc.save(state.draft, submit);
      state.dirty = false;
      KT.toast(submit ? "Report submitted. Thank you." : "Draft saved.", "success");
      await load();
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    } finally {
      state.saving = false; state.submitting = false; render();
    }
  }

  async function discard() {
    try {
      await svc.discard();
      state.dirty = false;
      state.draft = draftFrom(null);
      KT.toast("Draft discarded.", "success");
      await load();
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error");
    }
  }

  async function review(id, flag) {
    if (state.reviewing) return;
    state.reviewing = id; render();
    try {
      await svc.review(id, flag, "");
      KT.toast(flag ? "Flagged for follow-up." : "Marked as reviewed.", "success");
      state.team = await svc.teamDay();
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error");
    } finally {
      state.reviewing = null; render();
    }
  }

  /* ---- Entry point ------------------------------------------------------ */

  KT.admin.views["end-of-day"] = function (viewCtx) {
    ctx = viewCtx || ctx;
    var gen = ++mountGen;
    viewGen = gen;
    state = { loading: true, error: null, mine: null, team: null,
      tab: "mine", draft: null, dirty: false, saving: false,
      submitting: false, open: null, reviewing: null };

    /*
       This is a form of five textareas that a handler fills in on a phone.
       The keyboard shrinks the VISUAL viewport but not the layout one, so the
       page's scrollable extent does not grow to compensate and the submit
       button at the very bottom can end up in a band that cannot be scrolled
       into view. KT.viewportInset publishes the covered height as --kt-kb;
       .eodform reserves exactly that much at its foot, which gives the
       document the extra scroll it needs. Same helper both chats use.
    */
    if (!stopViewport) stopViewport = KT.viewportInset.start();

    setTimeout(function () { if (gen === mountGen) load(); }, 0);
    return '<header class="apage__head"><div><h1>End of day</h1>' +
      '<p class="apage__lede">Loading your day…</p></div></header>' +
      '<div class="panel apanel">' + KT.skeleton.lines(6) + "</div>";
  };

  KT.admin.views["end-of-dayTeardown"] = function () {
    mountGen += 1;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (stopViewport) { stopViewport(); stopViewport = null; }
  };

  /* ---- Events ----------------------------------------------------------- */

  document.addEventListener("input", function (e) {
    var f = e.target.closest && e.target.closest("[data-eodfield]");
    if (!f) return;
    state.draft = state.draft || draftFrom(null);
    state.draft[f.getAttribute("data-eodfield")] = f.value;
    if (!state.dirty) { state.dirty = true; render(); }
  });

  document.addEventListener("click", function (e) {
    var t = e.target;

    var tab = t.closest("[data-eodtab]");
    if (tab) { state.tab = tab.getAttribute("data-eodtab"); render(); return; }

    if (t.closest("[data-eodretry]")) { load(); return; }
    if (t.closest("[data-eodsave]")) { save(false); return; }
    if (t.closest("[data-eodsubmit]")) { save(true); return; }
    if (t.closest("[data-eoddiscard]")) { discard(); return; }

    var open = t.closest("[data-eodopen]");
    if (open) {
      var id = open.getAttribute("data-eodopen");
      state.open = state.open === id ? null : id;
      render();
      return;
    }

    var rev = t.closest("[data-eodreview]");
    if (rev) {
      review(rev.getAttribute("data-eodreview"), rev.getAttribute("data-flag") === "1");
    }
  });
})(window.KT || (window.KT = {}));
