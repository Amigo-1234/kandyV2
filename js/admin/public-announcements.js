/* ==========================================================================
   Kandy's Treats — PUBLIC customer announcements
   --------------------------------------------------------------------------
   The storefront ticker. What is written here scrolls across the top of the
   site for every visitor, including signed-out ones — so the screen says so
   at the top, in those words, rather than leaving someone to discover it.

   NOT the internal board. js/admin/announcements.js manages
   public.staff_announcements, which only handlers ever see. Two screens
   because they are two audiences; the headers on both say which is which.

   AUTHORIZATION IS THE DATABASE'S
   -------------------------------
   canManage() below hides the controls from anyone under admin. That is
   courtesy, not security: migration 0073 restricts INSERT, UPDATE and
   DELETE on public.announcements to is_manager(), so a supervisor who edits
   the hash and clicks Save gets a refusal from Postgres. The hidden button
   and the policy are saying the same thing, and only one of them is load
   bearing.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var svc = null;
  var mountGen = 0;
  var viewGen = -1;
  var stopViewport = null;

  var state = {
    loading: true, error: null, rows: [],
    editing: null,          /* null | {} for new | the row being edited */
    saving: false, busyId: null
  };
  var ctx = { role: "staff" };

  /* Mirrors is_manager(): admin (30) and owner (40). */
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

  /** ISO instant → the value a datetime-local input wants, in Lagos time. */
  function toLocalInput(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  /* ---- List -------------------------------------------------------------- */

  /*
     Three states worth telling apart, because "active" alone is misleading:
     a row can be switched on and still not be on the strip because its
     window has not opened or has closed.
  */
  function pill(a) {
    if (!a.active) return '<span class="anpill anpill--draft">Off</span>';
    if (a.live) return '<span class="anpill anpill--live">On the strip</span>';
    var now = new Date().toISOString();
    if (a.startsAt && a.startsAt > now) {
      return '<span class="anpill anpill--draft">Scheduled</span>';
    }
    return '<span class="anpill anpill--exp">Window closed</span>';
  }

  function cardHTML(a) {
    var busy = state.busyId === a.id;
    return (
      '<article class="ancard' + (a.live ? "" : " is-dim") + '">' +
        '<header class="ancard__top">' +
          "<h3>" + (esc(a.title) || "<em>Untitled</em>") + "</h3>" + pill(a) +
        "</header>" +
        '<p class="ancard__body pancard__line">' + esc(a.body) + "</p>" +
        '<footer class="ancard__foot">' +
          "<span>order " + esc(String(a.sortOrder)) + "</span>" +
          (a.startsAt ? "<span>from " + esc(when(a.startsAt)) + "</span>" : "") +
          (a.endsAt ? "<span>until " + esc(when(a.endsAt)) + "</span>" : "") +
          "<span>added " + esc(when(a.createdAt)) + "</span>" +
          (canManage()
            ? '<span class="ancard__acts">' +
                '<button class="anlink" type="button" data-panedit="' + esc(a.id) + '">Edit</button>' +
                '<button class="anlink" type="button" data-pantoggle="' + esc(a.id) + '"' +
                  (busy ? " disabled" : "") + ">" +
                  (a.active ? "Turn off" : "Turn on") + "</button>" +
                '<button class="anlink anlink--danger" type="button" data-pandelete="' +
                  esc(a.id) + '">Delete</button>' +
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
    return (
      '<div class="panel apanel aneditor">' +
        "<h3>" + (e.id ? "Edit announcement" : "New public announcement") + "</h3>" +
        '<p class="invhint pannote">' + KT.icon("eye", 14) +
          "<span>This scrolls across the top of the storefront for every " +
          "visitor, signed in or not.</span></p>" +

        '<label class="field"><span class="field__label">Message</span>' +
          '<input class="input" type="text" data-panfield="body" maxlength="300" ' +
            'value="' + esc(e.body || "") + '" ' +
            'placeholder="Catfish pepper soup now available"></label>' +
        '<p class="field__hint">This is the line customers read. Keep it to a ' +
          "few words — it shares a 38px strip with the others.</p>" +

        '<label class="field"><span class="field__label">Internal label (optional)</span>' +
          '<input class="input" type="text" data-panfield="title" maxlength="120" ' +
            'value="' + esc(e.title || "") + '" ' +
            'placeholder="How you will recognise it in this list"></label>' +

        '<div class="aneditor__row">' +
          '<label class="field"><span class="field__label">Starts showing (optional)</span>' +
            '<input class="input" type="datetime-local" data-panfield="startsLocal" ' +
              'value="' + esc(e.startsLocal || "") + '"></label>' +
          '<label class="field"><span class="field__label">Stops showing (optional)</span>' +
            '<input class="input" type="datetime-local" data-panfield="endsLocal" ' +
              'value="' + esc(e.endsLocal || "") + '"></label>' +
        "</div>" +

        '<div class="aneditor__row">' +
          '<label class="field"><span class="field__label">Order on the strip</span>' +
            '<input class="input" type="number" min="0" max="999" step="1" ' +
              'data-panfield="sortOrder" value="' + esc(String(e.sortOrder == null ? 0 : e.sortOrder)) +
              '"></label>' +
          '<label class="field pantoggle"><span class="field__label">Showing</span>' +
            '<label class="panswitch"><input type="checkbox" data-panfield="active"' +
              (e.active ? " checked" : "") + ">" +
              "<span>Show this on the storefront</span></label></label>" +
        "</div>" +

        '<div class="eodactions">' +
          '<button class="btn btn--primary" type="button" data-pansave' +
            (state.saving ? " disabled" : "") + ">" +
            (state.saving ? KT.spinner(15) + "<span>Saving…</span>" : "Save") +
          "</button>" +
          '<button class="btn btn--ghost" type="button" data-pancancel>Cancel</button>' +
        "</div>" +
      "</div>"
    );
  }

  /* ---- Page -------------------------------------------------------------- */

  function bodyHTML() {
    var live = state.rows.filter(function (r) { return r.live; }).length;
    return (
      '<div class="panel apanel panpreview">' +
        '<p class="panpreview__label">On the storefront right now</p>' +
        (live
          ? '<div class="panpreview__strip">' +
              state.rows.filter(function (r) { return r.live; })
                .map(function (r) {
                  return '<span class="panpreview__msg">' + esc(r.body) + "</span>";
                }).join("") +
            "</div>"
          : '<p class="panpreview__empty">Nothing is showing — the strip is ' +
            "falling back to the built-in delivery and coupon copy.</p>") +
      "</div>" +

      (canManage() && !state.editing
        ? '<div class="eodactions anbar">' +
            '<button class="btn btn--primary btn--sm" type="button" data-pannew>' +
            KT.icon("plus", 15) + "New announcement</button></div>"
        : "") +

      editorHTML() +

      (state.rows.length
        ? '<div class="anlist">' + state.rows.map(cardHTML).join("") + "</div>"
        : '<div class="panel apanel"><div class="empty">' +
          '<div class="empty__art">' + KT.icon("sparkle", 32) + "</div>" +
          "<h3>No public announcements</h3><p>" +
          (canManage()
            ? "Add one and it starts scrolling across the storefront."
            : "Only an admin or the owner can publish to the storefront.") +
          "</p></div></div>")
    );
  }

  function head() {
    return '<header class="apage__head"><div><h1>Public announcements</h1>' +
      '<p class="apage__lede">The scrolling strip customers see at the top of ' +
      "the storefront. Internal notices for the team live under " +
      "<strong>Announcements</strong>.</p></div></header>";
  }

  function render() {
    if (viewGen !== mountGen) return;
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    var a = document.activeElement;
    var key = a && a.getAttribute && a.getAttribute("data-panfield");
    var caret = key && a.selectionStart != null ? a.selectionStart : null;

    var body;
    if (state.loading) body = '<div class="panel apanel">' + KT.skeleton.lines(5) + "</div>";
    else if (state.error) {
      body = '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("close", 32) + "</div>" +
        "<h3>We could not load public announcements</h3><p>" + esc(state.error) + "</p>" +
        '<button class="btn btn--primary" type="button" data-panretry>Try again</button>' +
        "</div></div>";
    } else body = bodyHTML();

    KT.mount(host, head() + body);

    if (key) {
      var again = KT.qs('[data-panfield="' + key + '"]');
      if (again) {
        again.focus();
        try { again.setSelectionRange(caret, caret); } catch (err) {}
      }
    }
  }

  /* ---- Data -------------------------------------------------------------- */

  async function load() {
    var gen = mountGen;
    state.loading = true; state.error = null; render();
    try {
      if (!svc) {
        svc = (await import("../services/public-announcements.js")).publicAnnouncementsService;
      }
      var rows = await svc.list();
      if (gen !== mountGen) return;
      state.rows = rows;
    } catch (error) {
      if (gen !== mountGen) return;
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
    } finally {
      if (gen === mountGen) { state.loading = false; render(); }
    }
  }

  /* datetime-local carries no zone; the server stores an instant. */
  function toISO(local) {
    if (!local) return null;
    var d = new Date(local);
    return isNaN(d) ? null : d.toISOString();
  }

  async function save() {
    var e = state.editing;
    if (!e || state.saving) return;
    if (!String(e.body || "").trim()) {
      KT.toast("An announcement needs a message.", "error");
      return;
    }
    var startsAt = toISO(e.startsLocal);
    var endsAt = toISO(e.endsLocal);
    if (startsAt && endsAt && endsAt <= startsAt) {
      KT.toast("The end time has to come after the start time.", "error");
      return;
    }

    state.saving = true; render();
    try {
      await svc.save({
        id: e.id || null,
        title: e.title, body: e.body,
        active: !!e.active,
        startsAt: startsAt, endsAt: endsAt,
        sortOrder: e.sortOrder
      });
      state.editing = null;
      KT.toast("Saved.", "success");
      await load();
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    } finally {
      state.saving = false; render();
    }
  }

  async function toggle(id) {
    var row = state.rows.filter(function (r) { return r.id === id; })[0];
    if (!row || state.busyId) return;
    state.busyId = id; render();
    try {
      await svc.setActive(id, !row.active);
      KT.toast(row.active ? "Taken off the strip." : "Showing on the storefront.", "success");
      await load();
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    } finally {
      state.busyId = null; render();
    }
  }

  async function remove(id) {
    try {
      await svc.remove(id);
      KT.toast("Deleted.", "success");
      await load();
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    }
  }

  /* ---- Entry point ------------------------------------------------------- */

  KT.admin.views["public-announcements"] = function (viewCtx) {
    ctx = viewCtx || ctx;
    var gen = ++mountGen; viewGen = gen;
    state = { loading: true, error: null, rows: [], editing: null,
      saving: false, busyId: null };
    if (!stopViewport) stopViewport = KT.viewportInset.start();
    setTimeout(function () { if (gen === mountGen) load(); }, 0);
    return head() + '<div class="panel apanel">' + KT.skeleton.lines(5) + "</div>";
  };

  KT.admin.views["public-announcementsTeardown"] = function () {
    mountGen += 1;
    if (stopViewport) { stopViewport(); stopViewport = null; }
  };

  /* ---- Events ------------------------------------------------------------ */

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t.closest("[data-panretry]")) { load(); return; }
    if (t.closest("[data-pannew]")) {
      state.editing = { title: "", body: "", active: true, sortOrder: 0,
        startsLocal: "", endsLocal: "" };
      render();
      return;
    }
    if (t.closest("[data-pancancel]")) { state.editing = null; render(); return; }
    if (t.closest("[data-pansave]")) { save(); return; }

    var ed = t.closest("[data-panedit]");
    if (ed) {
      var row = state.rows.filter(function (r) {
        return r.id === ed.getAttribute("data-panedit");
      })[0];
      if (row) {
        state.editing = {
          id: row.id, title: row.title, body: row.body,
          active: row.active, sortOrder: row.sortOrder,
          startsLocal: toLocalInput(row.startsAt),
          endsLocal: toLocalInput(row.endsAt)
        };
        render();
      }
      return;
    }

    var tg = t.closest("[data-pantoggle]");
    if (tg) { toggle(tg.getAttribute("data-pantoggle")); return; }

    var del = t.closest("[data-pandelete]");
    if (del) {
      var id = del.getAttribute("data-pandelete");
      var doomed = state.rows.filter(function (r) { return r.id === id; })[0];
      /* A public announcement has no archive state — the table has no status
         column — so deletion is final and is confirmed rather than assumed. */
      if (window.confirm("Delete this announcement?\n\n“" +
          ((doomed && doomed.body) || "") + "”\n\nThis cannot be undone.")) {
        remove(id);
      }
    }
  });

  function field(e) {
    var f = e.target.closest && e.target.closest("[data-panfield]");
    if (!f || !state.editing) return;
    var k = f.getAttribute("data-panfield");
    if (k === "active") state.editing.active = f.checked;
    else if (k === "sortOrder") state.editing.sortOrder = Number(f.value) || 0;
    else state.editing[k] = f.value;
  }
  document.addEventListener("input", field);
  document.addEventListener("change", field);
})(window.KT || (window.KT = {}));
