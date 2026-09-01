/* ==========================================================================
   Kandy's Treats — Careers inbox
   --------------------------------------------------------------------------
   The other end of the storefront's "Work with us" form. Applications have
   been landing in job_applications since Phase 8 with nothing on this side to
   open them; this is that screen.

   ADMIN+ ONLY, AND THE SERVER SAYS SO
   -----------------------------------
   job_applications_admin_select scopes SELECT to is_manager(), which is admin
   and owner. Staff and supervisors get nothing back — not a shorter list, an
   empty one. The nav entry is gated to match so the screen is not offered to
   someone it would only disappoint, but the gate is the policy, not the nav.

   Rendering and interaction only; every query lives in
   js/services/admin-careers.js, dynamically imported so the storefront never
   loads it.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var svc = null;
  var searchTimer = null;

  /* Same two counters, and for the same reasons, as the Orders module: a view
     that does its work behind an await can otherwise paint into the screen
     that replaced it, and two loads in flight can land out of order. */
  var mountGen = 0;
  var viewGen = -1;
  var loadSeq = 0;

  var state = {
    rows: [], total: 0, hasMore: false, counts: null,
    loading: true, error: null, refreshing: false,
    status: "all", role: "all", search: "", page: 0,
    open: null, saving: false
  };
  var ctx = { role: "admin" };

  var ROLE_TABS = [
    ["all", "Any role"], ["chef", "Chef"],
    ["rider", "Rider"], ["kitchen-assistant", "Kitchen assistant"]
  ];

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* Africa/Lagos, for the same reason the Orders module uses it: the kitchen's
     clock is the one everybody in the business shares. */
  var LAGOS = { timeZone: "Africa/Lagos" };
  function stamp(d) {
    if (!d) return "—";
    return d.toLocaleDateString("en-NG", Object.assign({ day: "2-digit", month: "short" }, LAGOS)) +
      " · " + d.toLocaleTimeString("en-NG", Object.assign({ hour: "2-digit", minute: "2-digit", hour12: false }, LAGOS));
  }
  function ago(d) {
    if (!d) return "";
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    if (mins < 60 * 24) return Math.round(mins / 60) + "h ago";
    return Math.round(mins / 1440) + "d ago";
  }

  function statusList() { return svc ? svc.STATUSES : []; }

  /* ---- Chrome ---------------------------------------------------------- */

  function chipRow(rows, attr, current) {
    return '<div class="ochips">' + rows.map(function (t) {
      return '<button class="chip' + (current === t[0] ? " is-active" : "") +
        '" type="button" ' + attr + '="' + t[0] + '" aria-pressed="' +
        (current === t[0] ? "true" : "false") + '">' + t[1] + "</button>";
    }).join("") + "</div>";
  }

  function headHTML() {
    var c = state.counts;
    return (
      '<header class="apage__head opage__head">' +
        "<div><h1>Careers</h1>" +
          '<p class="apage__lede">' +
            (c
              ? "<strong>" + c["new"] + "</strong> new · " + c.reviewing +
                " reviewing · " + c.closed + " closed"
              : "Applications from the storefront’s Work with us form.") +
          "</p></div>" +
        '<button class="btn btn--soft btn--sm" type="button" data-crrefresh' +
          (state.refreshing ? " disabled" : "") + ">" +
          (state.refreshing ? KT.spinner(15) + "<span>Refreshing…</span>" : "Refresh") +
        "</button>" +
      "</header>"
    );
  }

  function filtersHTML() {
    var statusTabs = [["all", "All"]].concat(
      statusList().map(function (s) { return [s.key, s.label]; }));
    return (
      '<div class="ofilters">' +
        chipRow(statusTabs, "data-crstatus", state.status) +
        chipRow(ROLE_TABS, "data-crrole", state.role) +
        '<div class="osearch">' +
          '<span class="osearch__icon">' + KT.icon("search", 17) + "</span>" +
          '<input class="input" type="search" data-crsearch placeholder="Name, phone or email" ' +
            'value="' + esc(state.search) + '" aria-label="Search applications">' +
        "</div>" +
      "</div>"
    );
  }

  function activeFilters() {
    return state.status !== "all" || state.role !== "all" || !!state.search;
  }

  /* ---- List ------------------------------------------------------------ */

  function cardHTML(a) {
    return (
      '<article class="crcard" data-cropen="' + esc(a.id) + '" tabindex="0" role="button" ' +
        'aria-label="Open application from ' + esc(a.name) + '">' +
        '<div class="crcard__main">' +
          '<div class="crcard__top">' +
            "<strong>" + esc(a.name) + "</strong>" +
            '<span class="crbadge is-' + esc(a.status) + '">' + esc(a.status) + "</span>" +
            '<span class="otag">' + esc(a.roleLabel) + "</span>" +
          "</div>" +
          '<p class="crcard__who">' + esc(a.phone) +
            (a.email ? ' <span class="ocard__sep">·</span> ' + esc(a.email) : "") + "</p>" +
          '<p class="crcard__about">' + esc(a.about) + "</p>" +
        "</div>" +
        '<div class="crcard__right">' +
          '<time title="' + esc(stamp(a.createdAt)) + '">' + esc(ago(a.createdAt)) + "</time>" +
          '<span class="ocard__chev">' + KT.icon("chevronRight", 18) + "</span>" +
        "</div>" +
      "</article>"
    );
  }

  function listHTML() {
    if (state.loading) {
      return '<div class="olist">' + KT.loadingLabel("Loading applications…") +
        KT.skeleton.orders(3) + "</div>";
    }
    if (state.error) {
      return '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("close", 32) + "</div>" +
        "<h3>We could not load applications</h3><p>" + esc(state.error) + "</p>" +
        '<button class="btn btn--primary" type="button" data-crretry>Try again</button>' +
        "</div></div>";
    }
    if (!state.rows.length) {
      return '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("user", 32) + "</div>" +
        (activeFilters()
          ? "<h3>No applications match those filters</h3>" +
            "<p>Try a different status, role or search term.</p>" +
            '<button class="btn btn--soft" type="button" data-crclear>Clear filters</button>'
          : "<h3>No applications yet</h3><p>They arrive here from the " +
            "<em>Work with us</em> form on the storefront.</p>") +
        "</div></div>";
    }
    return (
      '<div class="olist">' + state.rows.map(cardHTML).join("") + "</div>" +
      (state.hasMore
        ? '<div class="omore"><button class="btn btn--soft" type="button" data-crmore' +
          (state.refreshing ? " disabled" : "") + ">" +
          (state.refreshing ? KT.spinner(15) + "<span>Loading…</span>"
                            : "Load more (" + (state.total - state.rows.length) + " left)") +
          "</button></div>"
        : "")
    );
  }

  /* ---- Detail ---------------------------------------------------------- */

  function current() {
    var id = state.open;
    if (!id) return null;
    return state.rows.filter(function (r) { return r.id === id; })[0] || null;
  }

  function actionsHTML(a) {
    var buttons = statusList().filter(function (s) { return s.key !== a.status; })
      .map(function (s) {
        return '<button class="btn btn--soft btn--sm" type="button" data-crset="' +
          s.key + '" title="' + esc(s.hint) + '">Mark ' + esc(s.label.toLowerCase()) +
          "</button>";
      }).join("");
    return '<div class="odetail__actions">' +
      (state.saving ? KT.spinner(16) + "<span>Saving…</span>" : buttons) + "</div>";
  }

  function drawerHTML() {
    if (!state.open) return "";
    var a = current();
    var body;
    if (!a) {
      body = '<div class="odetail__body"><div class="empty"><h3>Application not found</h3>' +
        "<p>It may have been filtered out of the current list.</p></div></div>";
    } else {
      body =
        '<div class="odetail__body">' +
          '<section class="odetail__sec">' +
            '<div class="odetail__status">' +
              '<span class="crbadge is-' + esc(a.status) + '">' + esc(a.status) + "</span>" +
              '<span class="otag">' + esc(a.roleLabel) + "</span>" +
            "</div>" +
            '<p class="odetail__muted">Applied ' + esc(stamp(a.createdAt)) + "</p>" +
            actionsHTML(a) +
          "</section>" +
          '<section class="odetail__sec"><h3>Applicant</h3>' +
            "<p>" + esc(a.name) + "</p>" +
            '<dl class="osum osum--readonly">' +
              '<div class="osum__row"><dt>Phone</dt><dd>' +
                '<a href="tel:' + esc(a.phone) + '">' + esc(a.phone) + "</a></dd></div>" +
              '<div class="osum__row"><dt>Email</dt><dd>' +
                (a.email
                  ? '<a href="mailto:' + esc(a.email) + '">' + esc(a.email) + "</a>"
                  : "<em>not given</em>") + "</dd></div>" +
            "</dl>" +
          "</section>" +
          '<section class="odetail__sec"><h3>What they said</h3>' +
            '<p class="crabout">' + esc(a.about) + "</p>" +
          "</section>" +
          '<section class="odetail__sec">' +
            '<p class="odetail__note">An applicant’s own words are a record of what ' +
            "they sent. Only the status can be changed from here, at any access " +
            "level, and every change is recorded in the audit log.</p>" +
          "</section>" +
        "</div>";
    }
    return (
      '<div class="odrawer is-open" data-crdrawer>' +
        '<div class="odrawer__scrim" data-crclose></div>' +
        '<aside class="odrawer__panel" role="dialog" aria-modal="true" ' +
          'aria-label="Application detail">' +
          '<header class="odrawer__head">' +
            "<div><strong>" + esc(a ? a.name : "Application") + "</strong>" +
            '<span class="odrawer__sub">' + esc(a ? a.roleLabel : "") + "</span></div>" +
            '<button class="icon-btn" type="button" data-crclose ' +
              'aria-label="Close application detail">' + KT.icon("close", 20) + "</button>" +
          "</header>" + body +
        "</aside>" +
      "</div>"
    );
  }

  /* ---- Render ---------------------------------------------------------- */

  function render() {
    if (viewGen !== mountGen) return;
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    var focused = document.activeElement &&
      document.activeElement.hasAttribute &&
      document.activeElement.hasAttribute("data-crsearch");
    var caret = focused ? document.activeElement.selectionStart : null;

    KT.mount(host, headHTML() + filtersHTML() + listHTML() + drawerHTML());

    if (focused) {
      var input = KT.qs("[data-crsearch]");
      if (input) { input.focus(); try { input.setSelectionRange(caret, caret); } catch (e) {} }
    }
  }

  /* ---- Data ------------------------------------------------------------ */

  async function ensureSvc() {
    if (svc) return true;
    try { svc = await import("../services/admin-careers.js"); return true; }
    catch (error) { svc = null; return false; }
  }

  async function load(opts) {
    opts = opts || {};
    var seq = ++loadSeq;
    var gen = mountGen;
    var live = function () { return seq === loadSeq && gen === mountGen; };

    if (opts.refresh) state.refreshing = true; else state.loading = true;
    state.error = null;
    render();

    if (!(await ensureSvc())) {
      if (!live()) return;
      state.loading = false; state.refreshing = false;
      state.error = "Could not load the careers module.";
      render();
      return;
    }

    try {
      var page = await svc.adminCareersService.list({
        status: state.status, role: state.role, search: state.search,
        limit: 25 * (state.page + 1), offset: 0
      });
      var counts = await svc.adminCareersService.counts().catch(function () { return null; });
      if (!live()) return;
      state.rows = page.rows; state.total = page.total; state.hasMore = page.hasMore;
      if (counts) state.counts = counts;
    } catch (error) {
      if (!live()) return;
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : (error.message || "Unknown error");
      state.rows = []; state.total = 0; state.hasMore = false;
    } finally {
      if (live()) {
        state.loading = false; state.refreshing = false;
        render();
      }
    }
  }

  async function setStatus(id, status) {
    if (!svc || state.saving) return;
    var gen = mountGen;
    state.saving = true; render();
    try {
      await svc.adminCareersService.setStatus(id, status);
      if (gen !== mountGen) return;
      /* Patch the row in place so the drawer does not flicker, then refresh
         the tallies from the server rather than guessing them. */
      state.rows = state.rows.map(function (r) {
        return r.id === id ? Object.assign({}, r, { status: status }) : r;
      });
      KT.toast("Application marked " + status + ".", "success");
      state.saving = false;
      render();
      load({ refresh: true });
    } catch (error) {
      if (gen !== mountGen) return;
      state.saving = false;
      render();
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    }
  }

  /* ---- Entry point ----------------------------------------------------- */

  KT.admin.views.careers = function (viewCtx) {
    ctx = viewCtx || ctx;

    var qp = KT.admin.routeParams();
    state.status = ["new", "reviewing", "closed"].indexOf(qp.status) >= 0 ? qp.status : "all";
    state.role = ROLE_TABS.some(function (t) { return t[0] === qp.role; }) ? qp.role : "all";
    state.page = 0;
    state.open = qp.application || null;

    var gen = ++mountGen;
    viewGen = gen;

    setTimeout(async function () {
      if (gen !== mountGen) return;
      await load();
    }, 0);

    return '<div data-careers-mount>' + KT.loadingLabel("Loading applications…") +
      KT.skeleton.orders(3) + "</div>";
  };

  KT.admin.views.careersTeardown = function () {
    mountGen += 1;
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    state.open = null; state.saving = false;
  };

  /* ---- Events ---------------------------------------------------------- */

  document.addEventListener("click", function (e) {
    var t = e.target;

    var st = t.closest("[data-crstatus]");
    if (st) { state.status = st.getAttribute("data-crstatus"); state.page = 0; load(); return; }

    var rl = t.closest("[data-crrole]");
    if (rl) { state.role = rl.getAttribute("data-crrole"); state.page = 0; load(); return; }

    if (t.closest("[data-crrefresh]")) { load({ refresh: true }); return; }
    if (t.closest("[data-crretry]"))   { load(); return; }
    if (t.closest("[data-crmore]"))    { state.page += 1; load({ refresh: true }); return; }
    if (t.closest("[data-crclear]")) {
      state.status = "all"; state.role = "all"; state.search = ""; state.page = 0;
      load(); return;
    }
    if (t.closest("[data-crclose]")) { state.open = null; render(); return; }

    var set = t.closest("[data-crset]");
    if (set && state.open) { setStatus(state.open, set.getAttribute("data-crset")); return; }

    var open = t.closest("[data-cropen]");
    if (open) { state.open = open.getAttribute("data-cropen"); render(); }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.open) { state.open = null; render(); return; }
    var card = e.target.closest && e.target.closest("[data-cropen]");
    if (card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      state.open = card.getAttribute("data-cropen");
      render();
    }
  });

  document.addEventListener("input", function (e) {
    var input = e.target.closest("[data-crsearch]");
    if (!input) return;
    state.search = input.value;
    state.page = 0;
    clearTimeout(searchTimer);
    var gen = mountGen;
    searchTimer = setTimeout(function () {
      searchTimer = null;
      if (gen !== mountGen) return;
      load();
    }, 280);
  });
})(window.KT || (window.KT = {}));
