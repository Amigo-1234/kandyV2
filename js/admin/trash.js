/* ==========================================================================
   Kandy's Treats — Trash
   --------------------------------------------------------------------------
   Rendering only; data access lives in js/services/admin-trash.js.

   Admin and owner both open this screen. An admin sees what was removed and
   cannot act on it, because deleting a menu item was owner-only before this
   phase and still is — admin_trash_list() returns `can_act` and the buttons
   follow the server's answer rather than a role string this file guesses at.

   Staff and supervisor do not reach this screen: the nav entry is admin+,
   and admin_trash_list() refuses anyone below is_manager() regardless of
   what the interface shows.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};
  KT.admin.views = KT.admin.views || {};

  var svc = null;
  var state = {
    loading: true, error: null,
    rows: [], canAct: false, viewerRole: "",
    busy: null,          /* "kind:id" while a request is in flight */
    confirming: null     /* "kind:id" of the row awaiting purge confirmation */
  };

  /* Mount and request generations: a view that was torn down must never
     repaint, and a slow list must never overwrite a newer one. */
  var mountGen = 0, loadSeq = 0;

  function esc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function when(d) {
    if (!d) return "—";
    return new Date(d).toLocaleString("en-NG", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  }

  function keyOf(row) { return row.kind + ":" + row.id; }

  /* ---- Rows -------------------------------------------------------------- */

  /**
   * What restoring or purging this row would mean. The counts come from the
   * database, not from a guess here — a dish on a paid order line cannot be
   * purged at all, and saying so before the click is kinder than an error.
   */
  function consequence(row) {
    var d = row.detail || {};
    if (row.kind === "menu_item") {
      var lines = Number(d.order_lines || 0);
      var moves = Number(d.stock_moves || 0);
      var counts = Number(d.stock_counts || 0);
      if (lines > 0) {
        return { locked: true, note: "On " + lines + " historical order line" +
          (lines === 1 ? "" : "s") + ". Kept forever so those orders still resolve." };
      }
      if (moves > 0) {
        return { locked: true, note: "Has " + moves + " inventory movement" +
          (moves === 1 ? "" : "s") + " on record." };
      }
      if (counts > 0) {
        return { locked: true, note: "Has inventory count history on record." };
      }
      return { locked: false, note: "Never ordered — permanent deletion is possible." };
    }
    var items = Number(d.items || 0);
    if (items > 0) {
      return { locked: true, note: items + " menu item" + (items === 1 ? "" : "s") +
        " still reference this category." };
    }
    return { locked: false, note: "No menu items reference it." };
  }

  function rowHTML(row) {
    var meta = svc.meta(row.kind);
    var k = keyOf(row);
    var cons = consequence(row);
    var busy = state.busy === k;
    var confirming = state.confirming === k;

    return (
      '<article class="trashcard" data-trash-row="' + esc(k) + '">' +
        '<div class="trashcard__main">' +
          '<span class="trashcard__icon">' + KT.icon(meta.icon, 18) + "</span>" +
          "<div>" +
            '<h3 class="trashcard__name">' + esc(row.label) + "</h3>" +
            '<p class="trashcard__meta">' +
              '<span class="trashcard__kind">' + esc(meta.label) + "</span>" +
              "<span> · deleted " + esc(when(row.deleted_at)) + "</span>" +
              (row.deleted_by_name
                ? "<span> · by " + esc(row.deleted_by_name) +
                  (row.deleted_by_role
                    ? ' <span class="rolebadge rolebadge--' + esc(row.deleted_by_role) + '">' +
                      esc(row.deleted_by_role) + "</span>"
                    : "") + "</span>"
                : "") +
            "</p>" +
            (row.delete_reason
              ? '<p class="trashcard__reason">“' + esc(row.delete_reason) + '”</p>'
              : "") +
            '<p class="trashcard__note">' + esc(cons.note) + "</p>" +
          "</div>" +
        "</div>" +

        '<div class="trashcard__actions">' +
          (!state.canAct
            ? '<span class="trashcard__locked">' + KT.icon("lock", 14) +
              "Only the owner can restore</span>"
            : confirming
              ? '<span class="trashcard__confirm">Delete forever?' +
                  '<button class="btn btn--ghost btn--sm" type="button" data-trash-cancel>Cancel</button>' +
                  '<button class="btn btn--dark btn--sm" type="button" data-trash-purge="' +
                    esc(k) + '"' + (busy ? " disabled" : "") + ">Yes, delete</button>" +
                "</span>"
              : '<button class="btn btn--primary btn--sm" type="button" data-trash-restore="' +
                  esc(k) + '"' + (busy ? " disabled" : "") + ">" +
                  (busy ? "Working…" : "Restore") + "</button>" +
                (cons.locked
                  ? ""
                  : '<button class="btn btn--ghost btn--sm" type="button" data-trash-confirm="' +
                      esc(k) + '">Delete forever</button>')) +
        "</div>" +
      "</article>"
    );
  }

  /* ---- Shell ------------------------------------------------------------- */

  function bodyHTML() {
    if (state.error) {
      return '<div class="panel apanel"><div class="empty"><div class="empty__art">' +
        KT.icon("close", 32) + "</div><h3>Could not load Trash</h3><p>" +
        esc(state.error) + '</p><button class="btn btn--soft" type="button" ' +
        "data-trash-reload>Try again</button></div></div>";
    }
    if (state.loading) {
      return '<div class="panel apanel">' + KT.loadingLabel("Loading Trash…") +
        KT.skeleton.lines(4) + "</div>";
    }
    if (!state.rows.length) {
      return '<div class="panel apanel"><div class="empty"><div class="empty__art">' +
        KT.icon("trash", 30) + "</div><h3>Trash is empty</h3>" +
        "<p>Nothing has been removed. Deleted menu items and categories " +
        "appear here and can be put back.</p></div></div>";
    }
    return '<div class="trashlist">' + state.rows.map(rowHTML).join("") + "</div>";
  }

  function paint() {
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    KT.mount(host,
      '<header class="apage__head"><div><h1>Trash</h1>' +
        '<p class="apage__lede">Menu items and categories that were removed. ' +
        (state.canAct
          ? "You can put any of them back, exactly as they were."
          : "Restoring is owner-only, so these are read-only for you.") +
        " Nothing financial is ever here: orders, payments and the audit log " +
        "cannot be deleted at all.</p></div></header>" +
      bodyHTML());
  }

  /* ---- Data -------------------------------------------------------------- */

  async function ensureSvc() {
    if (!svc) svc = (await import("../services/admin-trash.js")).adminTrashService;
    return svc;
  }

  async function load() {
    var gen = mountGen, seq = ++loadSeq;
    state.loading = true; state.error = null; paint();
    try {
      await ensureSvc();
      var res = await svc.list();
      if (gen !== mountGen || seq !== loadSeq) return;   /* stale */
      state.rows = res.rows || [];
      state.canAct = !!res.can_act;
      state.viewerRole = res.viewer_role || "";
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

  async function act(k, fn, done) {
    var parts = k.split(":");
    var kind = parts.shift();
    var id = parts.join(":");          /* category ids are text and may contain ':' */
    state.busy = k; state.confirming = null; paint();
    try {
      await ensureSvc();
      var res = await fn(kind, id);
      KT.toast(done(res), "success");
      state.busy = null;
      await load();
    } catch (error) {
      state.busy = null;
      KT.toast(KT.services.errorMessage(error), "error", { duration: 7000 });
      paint();
    }
  }

  /* ---- Wiring ------------------------------------------------------------ */

  document.addEventListener("click", function (e) {
    var reload = e.target.closest("[data-trash-reload]");
    if (reload) { e.preventDefault(); load(); return; }

    var restore = e.target.closest("[data-trash-restore]");
    if (restore) {
      e.preventDefault();
      act(restore.getAttribute("data-trash-restore"),
          function (kind, id) { return svc.restore(kind, id); },
          function (res) { return "“" + res.label + "” is back."; });
      return;
    }

    var confirm = e.target.closest("[data-trash-confirm]");
    if (confirm) {
      e.preventDefault();
      state.confirming = confirm.getAttribute("data-trash-confirm");
      paint();
      return;
    }

    if (e.target.closest("[data-trash-cancel]")) {
      e.preventDefault(); state.confirming = null; paint(); return;
    }

    var purge = e.target.closest("[data-trash-purge]");
    if (purge) {
      e.preventDefault();
      act(purge.getAttribute("data-trash-purge"),
          function (kind, id) { return svc.purge(kind, id); },
          function (res) { return "“" + res.label + "” was permanently deleted."; });
    }
  });

  /* ---- View -------------------------------------------------------------- */

  KT.admin.views.trash = function () {
    mountGen++;
    state = {
      loading: true, error: null, rows: [], canAct: false,
      viewerRole: "", busy: null, confirming: null
    };
    /* Deferred like every other view: the shell mounts the string below
       AFTER this returns, so painting now would be overwritten. */
    window.setTimeout(load, 0);
    return '<div class="panel apanel">' + KT.loadingLabel("Loading Trash…") +
      KT.skeleton.lines(4) + "</div>";
  };
})(window.KT || (window.KT = {}));
