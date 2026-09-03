/* ==========================================================================
   Kandy's Treats — Staff announcements
   --------------------------------------------------------------------------
   Internal notices. Manager+ writes them; every handler reads them.

   NOT the customer promo strip. public.announcements drives that and is
   readable by signed-out visitors; this is public.staff_announcements and is
   staff-only. Nothing on this screen ever reaches the storefront.

   Publishing is the act that notifies, and it happens server-side inside
   staff_announcement_save() through the notification pipeline that already
   exists — this file sends nothing.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var svc = null;
  var mountGen = 0;
  var viewGen = -1;
  var stopViewport = null;

  var state = {
    loading: true, error: null, data: null,
    showArchived: false,
    editing: null,          /* null | {} for new | the row being edited */
    saving: false
  };
  var ctx = { role: "staff" };

  function canManage() { return KT.admin.rank(ctx.role) >= KT.admin.rank("admin"); }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  var LAGOS = { timeZone: "Africa/Lagos" };
  function when(v) {
    if (!v) return "—";
    return new Date(v).toLocaleString("en-NG", Object.assign({
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
      hour12: false }, LAGOS));
  }

  /* ---- List -------------------------------------------------------------- */

  function pill(a) {
    if (a.status === "draft") return '<span class="anpill anpill--draft">Draft</span>';
    if (a.status === "archived") return '<span class="anpill anpill--arch">Archived</span>';
    if (a.expired) return '<span class="anpill anpill--exp">Expired</span>';
    return '<span class="anpill anpill--live">Active</span>';
  }

  function cardHTML(a) {
    return (
      '<article class="ancard ancard--' + esc(a.priority) +
        (a.status !== "published" || a.expired ? " is-dim" : "") + '">' +
        '<header class="ancard__top">' +
          (a.priority !== "normal"
            ? '<span class="anprio anprio--' + esc(a.priority) + '">' +
              esc(a.priority) + "</span>"
            : "") +
          "<h3>" + esc(a.title) + "</h3>" + pill(a) +
        "</header>" +
        '<p class="ancard__body">' + esc(a.body) + "</p>" +
        '<footer class="ancard__foot">' +
          "<span>" + (esc(a.author) || "<em>unknown</em>") +
            (a.author_role ? " · " + esc(a.author_role) : "") + "</span>" +
          "<span>" + (a.status === "published"
            ? "published " + esc(when(a.published_at))
            : "saved " + esc(when(a.created_at))) + "</span>" +
          (a.expires_at
            ? "<span>" + (a.expired ? "expired " : "expires ") +
              esc(when(a.expires_at)) + "</span>"
            : "") +
          (canManage()
            ? '<span class="ancard__acts">' +
                '<button class="anlink" type="button" data-anedit="' + esc(a.id) + '">Edit</button>' +
                (a.status === "archived"
                  ? '<button class="anlink" type="button" data-anrestore="' + esc(a.id) + '">Restore</button>'
                  : '<button class="anlink" type="button" data-anarchive="' + esc(a.id) + '">Archive</button>') +
              "</span>"
            : "") +
        "</footer>" +
      "</article>"
    );
  }

  /* ---- Composer ---------------------------------------------------------- */

  function editorHTML() {
    var e = state.editing;
    if (!e) return "";
    var prios = svc ? svc.PRIORITIES : [];
    return (
      '<div class="panel apanel aneditor">' +
        "<h3>" + (e.id ? "Edit announcement" : "New announcement") + "</h3>" +
        '<label class="field"><span class="field__label">Title</span>' +
          '<input class="input" type="text" data-anfield="title" ' +
            'value="' + esc(e.title || "") + '" placeholder="Short and plain"></label>' +
        '<label class="field"><span class="field__label">Message</span>' +
          '<textarea class="input aneditor__body" rows="4" data-anfield="body" ' +
            'placeholder="What the team needs to know.">' + esc(e.body || "") + "</textarea></label>" +
        '<div class="aneditor__row">' +
          '<label class="field"><span class="field__label">Priority</span>' +
            '<select class="select" data-anfield="priority">' +
              prios.map(function (p) {
                return '<option value="' + p.id + '"' +
                  ((e.priority || "normal") === p.id ? " selected" : "") + ">" +
                  esc(p.label) + "</option>";
              }).join("") +
            "</select></label>" +
          '<label class="field"><span class="field__label">Stops showing (optional)</span>' +
            '<input class="input" type="datetime-local" data-anfield="expiresAt" ' +
              'value="' + esc(e.expiresLocal || "") + '"></label>' +
        "</div>" +
        '<div class="eodactions">' +
          '<button class="btn btn--primary" type="button" data-anpublish' +
            (state.saving ? " disabled" : "") + ">" +
            (state.saving ? KT.spinner(15) + "<span>Saving…</span>"
              : e.status === "published" ? "Save changes" : "Publish to the team") +
          "</button>" +
          '<button class="btn btn--soft" type="button" data-andraft' +
            (state.saving ? " disabled" : "") + ">Save as draft</button>" +
          '<button class="btn btn--ghost" type="button" data-ancancel>Cancel</button>' +
        "</div>" +
        '<p class="invhint">Publishing notifies every handler once, through the ' +
          "same bell and push that carries order alerts. Editing a published " +
          "notice does not notify again.</p>" +
      "</div>"
    );
  }

  /* ---- Page -------------------------------------------------------------- */

  function bodyHTML() {
    var d = state.data;
    if (!d) return "";
    var rows = d.rows || [];
    return (
      (canManage()
        ? '<div class="eodactions anbar">' +
            (state.editing ? "" :
              '<button class="btn btn--primary btn--sm" type="button" data-annew>' +
              KT.icon("plus", 15) + "New announcement</button>") +
            '<button class="chip' + (state.showArchived ? " is-active" : "") +
              '" type="button" data-anarchived>Show archived</button>' +
          "</div>"
        : "") +
      editorHTML() +
      (rows.length
        ? '<div class="anlist">' + rows.map(cardHTML).join("") + "</div>"
        : '<div class="panel apanel"><div class="empty">' +
          '<div class="empty__art">' + KT.icon("sparkle", 32) + "</div>" +
          "<h3>Nothing posted</h3><p>" +
          (canManage()
            ? "Post a notice and every handler sees it here and in their bell."
            : "Operational notices from management will appear here.") +
          "</p></div></div>")
    );
  }

  function render() {
    if (viewGen !== mountGen) return;
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    var a = document.activeElement;
    var key = a && a.getAttribute && a.getAttribute("data-anfield");
    var caret = key && a.selectionStart != null ? a.selectionStart : null;

    var body;
    if (state.loading) body = '<div class="panel apanel">' + KT.skeleton.lines(5) + "</div>";
    else if (state.error) {
      body = '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("close", 32) + "</div>" +
        "<h3>We could not load announcements</h3><p>" + esc(state.error) + "</p>" +
        '<button class="btn btn--primary" type="button" data-anretry>Try again</button></div></div>';
    } else body = bodyHTML();

    KT.mount(host,
      '<header class="apage__head"><div><h1>Announcements</h1>' +
        '<p class="apage__lede">Operational notices for the team. These are ' +
        "internal — nothing here reaches the storefront.</p></div></header>" + body);

    if (key) {
      var again = KT.qs('[data-anfield="' + key + '"]');
      if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (e) {} }
    }
  }

  /* ---- Data -------------------------------------------------------------- */

  async function load() {
    var gen = mountGen;
    state.loading = true; state.error = null; render();
    try {
      if (!svc) svc = (await import("../services/admin-announcements.js")).adminAnnouncementsService;
      var d = await svc.list(state.showArchived);
      if (gen !== mountGen) return;
      state.data = d;
    } catch (error) {
      if (gen !== mountGen) return;
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
    } finally {
      if (gen === mountGen) { state.loading = false; render(); }
    }
  }

  async function save(publish) {
    var e = state.editing;
    if (!e || state.saving) return;
    if (!String(e.title || "").trim() || !String(e.body || "").trim()) {
      KT.toast("A title and a message are both needed.", "error"); return;
    }
    state.saving = true; render();
    try {
      await svc.save({
        id: e.id || null, title: e.title, body: e.body,
        priority: e.priority || "normal", publish: !!publish,
        /* datetime-local has no zone; the server stores an instant. */
        expiresAt: e.expiresLocal ? new Date(e.expiresLocal).toISOString() : null
      });
      state.editing = null;
      KT.toast(publish ? "Published to the team." : "Draft saved.", "success");
      await load();
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    } finally {
      state.saving = false; render();
    }
  }

  async function archive(id, restore) {
    try {
      await svc.archive(id, restore);
      KT.toast(restore ? "Restored." : "Archived.", "success");
      await load();
    } catch (error) { KT.toast(KT.services.errorMessage(error), "error"); }
  }

  /* ---- Entry point ------------------------------------------------------- */

  KT.admin.views.announcements = function (viewCtx) {
    ctx = viewCtx || ctx;
    var gen = ++mountGen; viewGen = gen;
    state = { loading: true, error: null, data: null, showArchived: false,
      editing: null, saving: false };
    if (!stopViewport) stopViewport = KT.viewportInset.start();
    setTimeout(function () { if (gen === mountGen) load(); }, 0);
    return '<header class="apage__head"><div><h1>Announcements</h1>' +
      '<p class="apage__lede">Loading…</p></div></header>' +
      '<div class="panel apanel">' + KT.skeleton.lines(5) + "</div>";
  };

  KT.admin.views.announcementsTeardown = function () {
    mountGen += 1;
    if (stopViewport) { stopViewport(); stopViewport = null; }
  };

  /* ---- Events ------------------------------------------------------------ */

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t.closest("[data-anretry]")) { load(); return; }
    if (t.closest("[data-annew]")) {
      state.editing = { title: "", body: "", priority: "normal" }; render(); return;
    }
    if (t.closest("[data-ancancel]")) { state.editing = null; render(); return; }
    if (t.closest("[data-anarchived]")) {
      state.showArchived = !state.showArchived; load(); return;
    }
    if (t.closest("[data-anpublish]")) { save(true); return; }
    if (t.closest("[data-andraft]")) { save(false); return; }

    var ed = t.closest("[data-anedit]");
    if (ed) {
      var id = ed.getAttribute("data-anedit");
      var row = (state.data.rows || []).filter(function (r) { return r.id === id; })[0];
      if (row) {
        state.editing = {
          id: row.id, title: row.title, body: row.body,
          priority: row.priority, status: row.status,
          expiresLocal: row.expires_at
            ? new Date(row.expires_at).toISOString().slice(0, 16) : ""
        };
        render();
      }
      return;
    }
    var ar = t.closest("[data-anarchive]");
    if (ar) { archive(ar.getAttribute("data-anarchive"), false); return; }
    var rs = t.closest("[data-anrestore]");
    if (rs) { archive(rs.getAttribute("data-anrestore"), true); }
  });

  function field(e) {
    var f = e.target.closest && e.target.closest("[data-anfield]");
    if (!f || !state.editing) return;
    var k = f.getAttribute("data-anfield");
    state.editing[k === "expiresAt" ? "expiresLocal" : k] = f.value;
  }
  document.addEventListener("input", field);
  document.addEventListener("change", field);
})(window.KT || (window.KT = {}));
