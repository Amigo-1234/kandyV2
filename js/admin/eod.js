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

   PAST DAYS. A date picker and a strip of recent days open any earlier day.
   A past day is read-only: the handler's own report is shown as text, not a
   form, and staff_day_report_save() refuses any day but today regardless.
   Supervisors can still mark a past report reviewed — that writes only the
   review columns, never the author's words.

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
    reviewing: null,        /* report id mid-review */
    date: null,             /* null = today; YYYY-MM-DD = a past day (read-only) */
    index: null,            /* day_report_index(): recent days and their status */
    late: null,             /* yesterday's page while it is still open (before 04:00) */
    filing: null,           /* "yesterday" | "today": which day the form files under */
    expanded: {},           /* report id -> long report unfolded */
    versions: {},           /* "staff|day" -> earlier versions (0087), fetched on open */
    showVersions: {}        /* "staff|day" -> earlier versions listed */
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

  function dayLabel(d, withYear) {
    if (!d) return "";
    var p = String(d).split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)).toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short", year: withYear ? "numeric" : undefined, timeZone: "UTC" });
  }
  function addDays(d, n) {
    var p = String(d).split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n, 12)).toISOString().slice(0, 10);
  }
  function today() { return state.index && state.index.today; }
  function isPast() { return !!state.date && !!today() && state.date < today(); }

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
              : '<p class="eodact__span">No order activity recorded ' + (isPast() ? "that day" : "today") + ".</p>") +
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
        '<textarea class="input eodf__input" rows="3" data-eodfield="' + f.key + '" ' +
          'placeholder="Leave blank if there was nothing.">' + esc(v) + "</textarea>" +
      "</label>"
    );
  }

  var FIELD_COL = { problems: "problems", customerIssues: "customer_issues",
                    stockIssues: "stock_issues", followUps: "follow_ups", notes: "notes" };

  /*
     A report as text. Used for every past day, and for the team view.
     Written on a phone as lists — one activity per line — so line breaks are
     kept exactly as typed (.eodsaid__text is pre-wrap). Collapsing them ran
     every list together into one sentence. A long report starts folded with
     a "View full report" control; nothing is ever cut from what is stored.
  */
  var LONG_CHARS = 480, LONG_LINES = 10;
  function isLong(r) {
    var all = FIELDS.map(function (f) { return r[FIELD_COL[f.key]] || ""; }).join("\n");
    return all.length > LONG_CHARS || all.split("\n").length > LONG_LINES;
  }
  function fieldsHTML(r) {
    var said = FIELDS.map(function (f) {
      var v = r[FIELD_COL[f.key]];
      if (!v) return "";
      return '<div class="eodsaid"><dt>' + esc(f.label) + '</dt><dd class="eodsaid__text">' + esc(v) + "</dd></div>";
    }).join("");
    return said ? '<dl class="eodsaidlist">' + said + "</dl>" : '<p class="odetail__muted">Nothing to flag was written.</p>';
  }
  function saidHTML(r) {
    var body = fieldsHTML(r);
    if (!r.id || !isLong(r)) return body;
    var open = !!state.expanded[r.id];
    return '<div class="eodlong' + (open ? " is-open" : "") + '" id="eodlong-' + esc(r.id) + '">' + body + "</div>" +
      '<button class="btn btn--soft btn--sm eodlong__toggle" type="button" data-eodexpand="' + esc(r.id) + '" ' +
        'aria-expanded="' + open + '" aria-controls="eodlong-' + esc(r.id) + '">' +
        (open ? "Show less" : "View full report") + "</button>";
  }

  /* Earlier text kept when a report was changed or a draft discarded (0087).
     Keyed by person and day, not report id: a discarded draft no longer has
     a report row. */
  function versionKey(staffId) {
    return staffId + "|" + ((state.team && state.team.business_date) || "");
  }
  function versionsHTML(staffId) {
    var key = versionKey(staffId);
    var v = state.versions[key];
    if (!v) return "";
    if (v.loading) return '<p class="odetail__muted">Checking for earlier versions…</p>';
    if (v.error) return '<p class="field__error">' + esc(v.error) + "</p>";
    var list = v.data || [];
    if (!list.length) return "";
    var open = !!state.showVersions[key];
    var lead = list.some(function (x) { return x.status === "submitted"; }) ? "Edited after submitting · "
      : list.some(function (x) { return x.reason === "discarded"; }) ? "Discarded drafts kept · "
      : "Earlier drafts · ";
    return '<div class="eodversions">' +
      '<button class="btn btn--ghost btn--sm" type="button" data-eodversions="' + esc(key) + '" aria-expanded="' + open + '">' +
        KT.icon("clock", 14) + "<span>" + lead + list.length +
        (list.length === 1 ? " earlier version" : " earlier versions") + "</span></button>" +
      (open ? list.map(function (x) {
        return '<div class="eodversion"><p class="eodversion__when">' + (x.reason === "discarded" ? "Discarded " : "Replaced ") +
          esc(dayLabel(String(x.replaced_at).slice(0, 10))) +
          " at " + clock(x.replaced_at) +
          (x.status === "submitted" ? " · had been submitted " + (x.submitted_at ? clock(x.submitted_at) : "")
                                    : " · was a draft") + "</p>" +
          fieldsHTML(x) + "</div>";
      }).join("") : "") +
    "</div>";
  }

  /*
     Which day the form is for. Before 04:00 Lagos time yesterday's report
     is still open (0087), so a late shift files where it belongs instead of
     landing on the new day and later being overwritten by it. The server
     re-checks the day on every save.
  */
  function filingDay() {
    return state.late && state.filing === "yesterday" ? state.late : state.mine;
  }

  function filingSwitchHTML() {
    if (!state.late) return "";
    function opt(id, d, note) {
      var on = state.filing === id;
      return '<button class="eodfiling__opt' + (on ? " is-active" : "") + '" type="button" role="radio" aria-checked="' + on +
        '" data-eodfiling="' + id + '"><strong>' + esc(dayLabel(d.business_date)) + "</strong><span>" + esc(note) + "</span></button>";
    }
    return '<div class="eodfiling" role="radiogroup" aria-label="Which day is this report for?">' +
      '<p class="eodfiling__q">Which day is this report for?</p>' +
      opt("yesterday", state.late, "Yesterday — open until 04:00") +
      opt("today", state.mine, "Today") +
    "</div>";
  }

  function minePastHTML() {
    var d = state.mine;
    var r = d.report;
    return (
      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("check", 17) + "Your day</h2>" +
          '<span class="dsec__hint">' + esc(dayLabel(d.business_date, true)) + "</span></header>" +
        '<div class="panel apanel">' + activityHTML(d.activity) + "</div>" +
      "</section>" +
      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("mail", 17) + "Your report</h2>" +
          '<span class="eodstatus">' +
            (r && r.status === "submitted"
              ? '<span class="eodpill eodpill--done">Submitted ' + clock(r.submitted_at) + "</span>" +
                (r.reviewed_at ? '<span class="eodpill eodpill--seen">Seen by management</span>' : "") +
                (r.needs_follow_up ? '<span class="eodpill eodpill--flag">Flagged for follow-up</span>' : "")
              : r ? '<span class="eodpill eodpill--draft">Draft — never submitted</span>'
                  : '<span class="eodpill eodpill--missing">No report filed</span>') +
          "</span></header>" +
        '<div class="panel apanel">' +
          (r ? saidHTML(r) : '<p class="odetail__muted">You did not write a report for this day.</p>') +
          (r && r.versions ? '<p class="odetail__muted">' + r.versions + (r.versions === 1 ? " earlier version was" : " earlier versions were") +
            " kept when you changed this report.</p>" : "") +
          (d.editable ? '<p class="invhint">This day is still open until 04:00 — go back to today to finish it.</p>' : "") +
          (r && r.reviewed_at && r.review_note
            ? '<div class="eodreview"><strong>From management</strong><p>' + esc(r.review_note) + "</p></div>" : "") +
        "</div>" +
      "</section>"
    );
  }

  function mineHTML() {
    if (!state.mine) return "";
    if (isPast()) return minePastHTML();
    var d = filingDay();
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
          '<span class="dsec__hint">' + esc(dayLabel(d.business_date)) + "</span></header>" +
        '<div class="panel apanel">' +
          filingSwitchHTML() +
          '<p class="eodlede">These come from the orders you moved. Nobody types them, ' +
            "and they cannot be edited.</p>" +
          activityHTML(d.activity) +
        "</div>" +
      "</section>" +

      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("mail", 17) + "Your report · " + esc(dayLabel(d.business_date)) + "</h2>" +
          '<span class="eodstatus">' + status + "</span></header>" +
        '<div class="panel apanel eodform">' +
          '<p class="eodlede">Only what the system cannot see for itself. Write one thing per line — ' +
            "line breaks are kept.</p>" +
          (r && r.versions ? '<p class="odetail__muted">' + r.versions + (r.versions === 1 ? " earlier version is" : " earlier versions are") +
            " kept, so updating never loses what you sent before.</p>" : "") +
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
            /* Always in the page and toggled in place: re-rendering on the
               first keystroke replaced the textarea and closed the phone
               keyboard after one character. */
            '<span class="eodunsaved" data-eodunsaved' + (state.dirty ? "" : " hidden") + ">Unsaved changes</span>" +
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
    } else if (p.versions) {
      pill = '<span class="eodpill eodpill--draft">Draft discarded</span>';
    } else if (p.expected) {
      pill = '<span class="eodpill eodpill--missing">Not submitted</span>';
    } else {
      pill = '<span class="eodpill eodpill--na">No report needed</span>';
    }

    var body = "";
    if (open && r) {
      body =
        '<div class="eodperson__body">' +
          (r.status !== "submitted" ? '<p class="odetail__muted">Draft — not submitted.</p>' : "") +
          saidHTML(r) +
          versionsHTML(p.staff_id) +
          (r.reviewed_at
            ? '<p class="odetail__muted eodsaid__text">Reviewed ' + clock(r.reviewed_at) +
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
        "Nothing submitted yet, so there is nothing to read.</p>" +
        versionsHTML(p.staff_id) + "</div>";
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
        '<header class="dsec__head"><h2>' + KT.icon("grid", 17) + (isPast() ? "The day" : "The day so far") + "</h2>" +
          '<span class="dsec__hint">' + esc(dayLabel(d.business_date, isPast())) + "</span></header>" +
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
              (rev === null || rev === undefined ? (isPast() ? "net that day" : "net today") : KT.naira(rev)) + "</span></div>" +
        "</div>" +
      "</section>" +

      '<section class="dsec">' +
        '<header class="dsec__head"><h2>' + KT.icon("user", 17) + (isPast() ? "Who worked" : "Who worked today") + "</h2></header>" +
        (d.people && d.people.length
          ? '<div class="eodlist">' + d.people.map(personHTML).join("") + "</div>"
          : '<div class="panel apanel"><p class="odetail__muted">' +
            (isPast() ? "Nobody worked an order or filed a report that day." : "Nobody has worked an order yet today.") + "</p></div>") +
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

  function dateBarHTML() {
    var t = today();
    if (!t) return "";
    var d = state.date || t;
    var ix = (state.index && state.index.days) || [];
    var team = canSeeTeam() && state.tab === "team";
    return '<div class="invdate">' +
        '<button class="btn btn--soft btn--sm invdate__step" type="button" data-eodstep="-1" aria-label="Previous day">‹</button>' +
        '<label class="invdate__pick"><span class="sr-only">Choose a day</span>' +
          '<input class="input" type="date" data-eoddate value="' + esc(d) + '" max="' + esc(t) + '"></label>' +
        '<button class="btn btn--soft btn--sm invdate__step" type="button" data-eodstep="1" aria-label="Next day"' +
          (isPast() ? "" : " disabled") + ">›</button>" +
        (isPast() ? '<button class="btn btn--ghost btn--sm" type="button" data-eodtoday>Back to today</button>' : "") +
      "</div>" +
      (ix.length ? '<div class="eoddays" role="list" aria-label="Recent days">' + ix.map(function (x) {
        var on = x.business_date === d;
        var mark, cls;
        if (team && x.team) {
          mark = x.team.submitted + " in" + (x.team.follow_up ? " · " + x.team.follow_up + " flag" : "");
          cls = x.team.submitted ? "is-done" : "is-none";
        } else {
          var m = x.mine;
          mark = !m ? "—" : m.status === "submitted" ? "Sent" : "Draft";
          cls = !m ? "is-none" : m.status === "submitted" ? "is-done" : "is-draft";
        }
        return '<button class="eodday ' + cls + (on ? " is-active" : "") + '" type="button" role="listitem" data-eodday="' +
          esc(x.business_date) + '" aria-pressed="' + on + '">' +
          "<strong>" + esc(x.is_today ? "Today" : dayLabel(x.business_date)) + "</strong>" +
          "<span>" + esc(mark) + "</span></button>";
      }).join("") + "</div>" : "") +
      (isPast() ? '<div class="invro" role="note">' + KT.icon("lock", 15) + "<span><strong>" +
        esc(dayLabel(d, true)) + " — read only.</strong> Past reports can be read but not changed" +
        (canSeeTeam() ? ". Managers can still mark them reviewed." : ".") + "</span></div>" : "");
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
      "</div></header>" + tabsHTML() + (state.loading && !state.index ? "" : dateBarHTML()) + body);

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
      var calls = [svc.staffDay(state.date), svc.index(null, null)];
      if (canSeeTeam()) calls.push(svc.teamDay(state.date));
      var got = await Promise.all(calls);
      if (gen !== mountGen) return;
      state.mine = got[0];
      state.index = got[1];
      state.team = got[2] || null;
      if (state.date && state.date >= state.index.today) state.date = null;
      /* Late window (before 04:00): yesterday's report is still open. */
      if (!isPast() && state.mine && state.mine.late_open_until) {
        var late = await svc.staffDay(addDays(state.mine.business_date, -1));
        if (gen !== mountGen) return;
        state.late = late && late.editable ? late : null;
        if (state.late && !state.filing) state.filing = "yesterday";
      } else {
        state.late = null;
      }
      if (!state.late) state.filing = "today";
      /* Never clobber what the person is in the middle of typing — and a
         past day never feeds the form. */
      if (!state.dirty && !isPast()) state.draft = draftFrom(filingDay() && filingDay().report);
    } catch (error) {
      if (gen !== mountGen) return;
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
    } finally {
      if (gen === mountGen) { state.loading = false; render(); }
    }
  }

  function goTo(date) {
    var t = today();
    if (state.dirty && !isPast() && date && t && date < t &&
        !window.confirm("You have unsaved changes to today's report. Leave them and look at another day?")) {
      render();
      return;
    }
    state.date = (!date || (t && date >= t)) ? null : date;
    state.open = null;
    load();
  }

  async function save(submit) {
    if (state.saving || state.submitting || isPast()) return;
    var d = filingDay();
    var r = d && d.report;
    if (submit && r && r.status === "submitted" && r.submitted_at &&
        Date.now() - new Date(r.submitted_at).getTime() > 2 * 3600 * 1000 &&
        !window.confirm("You already submitted the report for " + dayLabel(d.business_date) + " at " + clock(r.submitted_at) +
                        ". Replace it with this version? The earlier text will be kept.")) {
      return;
    }
    if (submit) state.submitting = true; else state.saving = true;
    render();
    try {
      await svc.save(state.draft, submit, d && d.business_date);
      state.dirty = false;
      KT.toast(submit ? "Report submitted. Thank you." : "Draft saved.", "success");
      await load();
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 8000 });
      /* The day closed while the form was open (04:00 passed): reload so the
         form moves to today. What was typed stays in the draft. */
      if (/has closed/i.test(String(error && error.message))) { state.filing = null; load(); }
    } finally {
      state.saving = false; state.submitting = false; render();
    }
  }

  async function discard() {
    try {
      await svc.discard(filingDay() && filingDay().business_date);
      state.dirty = false;
      state.draft = draftFrom(null);
      KT.toast("Draft discarded.", "success");
      await load();
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error");
    }
  }

  /** Earlier versions for the opened person on the shown day, fetched once —
      whether or not they have a report now (a discarded draft has none). */
  async function loadVersions(staffId) {
    if (!state.team || !state.team.business_date) return;
    var key = versionKey(staffId);
    if (state.versions[key]) return;
    var gen = mountGen;
    state.versions[key] = { loading: true };
    render();
    try {
      var out = await svc.versions(staffId, state.team.business_date);
      if (gen !== mountGen) return;
      state.versions[key] = { data: (out && out.versions) || [] };
    } catch (error) {
      if (gen !== mountGen) return;
      state.versions[key] = { error: KT.services.errorMessage(error) };
    }
    render();
  }

  async function review(id, flag) {
    if (state.reviewing) return;
    state.reviewing = id; render();
    try {
      await svc.review(id, flag, "");
      KT.toast(flag ? "Flagged for follow-up." : "Marked as reviewed.", "success");
      state.team = await svc.teamDay(state.date);
      state.index = await svc.index(null, null);
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
      submitting: false, open: null, reviewing: null, date: null, index: null,
      late: null, filing: null, expanded: {}, versions: {}, showVersions: {} };

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

  document.addEventListener("change", function (e) {
    var d = e.target.closest && e.target.closest("[data-eoddate]");
    if (d && d.value) goTo(d.value);
  });

  document.addEventListener("input", function (e) {
    var f = e.target.closest && e.target.closest("[data-eodfield]");
    if (!f) return;
    state.draft = state.draft || draftFrom(null);
    state.draft[f.getAttribute("data-eodfield")] = f.value;
    if (!state.dirty) {
      state.dirty = true;
      var flag = KT.qs("[data-eodunsaved]");
      if (flag) flag.hidden = false;
    }
  });

  document.addEventListener("click", function (e) {
    var t = e.target;

    var tab = t.closest("[data-eodtab]");
    if (tab) { state.tab = tab.getAttribute("data-eodtab"); render(); return; }

    var step = t.closest("[data-eodstep]");
    if (step) { goTo(addDays(state.date || today(), Number(step.getAttribute("data-eodstep")))); return; }
    if (t.closest("[data-eodtoday]")) { goTo(null); return; }
    var dayBtn = t.closest("[data-eodday]");
    if (dayBtn) { goTo(dayBtn.getAttribute("data-eodday")); return; }

    if (t.closest("[data-eodretry]")) { load(); return; }
    if (t.closest("[data-eodsave]")) { save(false); return; }
    if (t.closest("[data-eodsubmit]")) { save(true); return; }
    if (t.closest("[data-eoddiscard]")) { discard(); return; }

    var filing = t.closest("[data-eodfiling]");
    if (filing) {
      var which = filing.getAttribute("data-eodfiling");
      if (which === state.filing) return;
      if (state.dirty && !window.confirm("You have unsaved changes. Switch day and leave them?")) return;
      state.filing = which;
      state.dirty = false;
      state.draft = draftFrom(filingDay() && filingDay().report);
      render();
      return;
    }

    var exp = t.closest("[data-eodexpand]");
    if (exp) {
      var rid = exp.getAttribute("data-eodexpand");
      state.expanded[rid] = !state.expanded[rid];
      render();
      return;
    }

    var vers = t.closest("[data-eodversions]");
    if (vers) {
      var vid = vers.getAttribute("data-eodversions");
      state.showVersions[vid] = !state.showVersions[vid];
      render();
      return;
    }

    var open = t.closest("[data-eodopen]");
    if (open) {
      var id = open.getAttribute("data-eodopen");
      state.open = state.open === id ? null : id;
      render();
      if (state.open) loadVersions(state.open);
      return;
    }

    var rev = t.closest("[data-eodreview]");
    if (rev) {
      review(rev.getAttribute("data-eodreview"), rev.getAttribute("data-flag") === "1");
    }
  });
})(window.KT || (window.KT = {}));
