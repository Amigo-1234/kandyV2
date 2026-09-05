/* ==========================================================================
   Kandy's Treats — App settings
   --------------------------------------------------------------------------
   Rendering only; data access lives in js/services/admin-settings.js.

   Admin and owner both open this screen and both see every setting, because
   an admin needs to know what the delivery fee IS even though only the owner
   may change it. Which rows are editable comes from the server — admin_settings()
   returns `editable` per row, computed by the same setting_tier() the write
   trigger consults — so a locked card and a refused write can never disagree.

   Staff and supervisor do not reach this screen at all: the nav entry is
   admin+, and every write is refused by the trigger regardless of what the
   interface shows.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};
  KT.admin.views = KT.admin.views || {};

  var svc = null;
  var state = {
    loading: true, error: null,
    rows: [], viewerRole: "", isOwner: false,
    dirty: {},          /* key -> form object, present only while edited */
    saving: null
  };

  function esc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function when(d) {
    if (!d) return "never";
    return new Date(d).toLocaleString("en-NG",
      { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  /** The form values for a row: whatever is being edited, else the stored value. */
  function formOf(row) {
    if (state.dirty[row.key]) return state.dirty[row.key];
    return svc.meta(row.key).unpack(row.value);
  }

  function isDirty(row) {
    return !!state.dirty[row.key];
  }

  /* ---- Cards ------------------------------------------------------------- */

  function toggleHTML(row, form) {
    return (
      '<label class="setform__switch">' +
        '<input type="checkbox" data-set-field="' + esc(row.key) + '|enabled"' +
          (form.enabled ? " checked" : "") + (row.editable ? "" : " disabled") + ">" +
        '<span class="setform__track"><span class="setform__knob"></span></span>' +
        '<span class="setform__switchlabel">' +
          (form.enabled ? "Accepting orders" : "Ordering paused") + "</span>" +
      "</label>"
    );
  }

  function fieldsHTML(row, form) {
    return '<div class="setform__grid">' + (svc.meta(row.key).fields || []).map(function (f) {
      var val = form[f.name];
      return (
        '<label class="field setform__field">' +
          '<span class="field__label">' + esc(f.label) + "</span>" +
          '<span class="setform__input' + (f.prefix ? " has-prefix" : "") + '">' +
            (f.prefix ? '<span class="setform__affix">' + esc(f.prefix) + "</span>" : "") +
            '<input class="input" data-set-field="' + esc(row.key) + "|" + esc(f.name) + '" ' +
              'type="' + (f.type || "number") + '" ' +
              (f.step ? 'step="' + f.step + '" ' : "") +
              (f.min != null ? 'min="' + f.min + '" ' : "") +
              (f.max != null ? 'max="' + f.max + '" ' : "") +
              'value="' + esc(val == null ? "" : val) + '"' +
              (row.editable ? "" : " disabled") + ">" +
            (f.suffix ? '<span class="setform__affix">' + esc(f.suffix) + "</span>" : "") +
          "</span>" +
        "</label>"
      );
    }).join("") + "</div>";
  }

  function cardHTML(row) {
    var meta = svc.meta(row.key);
    var form = formOf(row);
    var dirty = isDirty(row);
    return (
      '<article class="setcard' + (row.editable ? "" : " is-locked") + '" data-set-card="' +
        esc(row.key) + '">' +
        '<header class="setcard__head">' +
          "<div><h3>" + esc(row.label) + "</h3>" +
            '<p class="setcard__blurb">' + esc(meta.blurb) + "</p></div>" +
          '<span class="setcard__tier setcard__tier--' + esc(row.tier) + '">' +
            (row.tier === "owner" ? "owner only" : "admin") + "</span>" +
        "</header>" +

        '<div class="setcard__body">' +
          (meta.kind === "toggle" ? toggleHTML(row, form) : fieldsHTML(row, form)) +
        "</div>" +

        '<footer class="setcard__foot">' +
          '<span class="setcard__stamp">Updated ' + when(row.updated_at) + "</span>" +
          (row.editable
            ? '<span class="setcard__actions">' +
                (dirty
                  ? '<button class="btn btn--ghost btn--sm" type="button" data-set-reset="' +
                      esc(row.key) + '">Discard</button>'
                  : "") +
                '<button class="btn btn--primary btn--sm" type="button" data-set-save="' +
                  esc(row.key) + '"' + (dirty ? "" : " disabled") + ">" +
                  (state.saving === row.key ? "Saving…" : "Save") + "</button>" +
              "</span>"
            : '<span class="setcard__locked">' + KT.icon("lock", 14) +
              "Only the owner can change this</span>") +
        "</footer>" +
      "</article>"
    );
  }

  /* ---- Shell ------------------------------------------------------------- */

  function bodyHTML() {
    if (state.error) {
      return '<div class="panel apanel"><div class="empty"><div class="empty__art">' +
        KT.icon("close", 32) + "</div><h3>Could not load settings</h3><p>" +
        esc(state.error) + '</p><button class="btn btn--soft" type="button" ' +
        'data-set-reload>Try again</button></div></div>';
    }
    if (state.loading) {
      return '<div class="panel apanel">' + KT.loadingLabel("Loading settings…") +
        KT.skeleton.lines(6) + "</div>";
    }
    if (!state.rows.length) {
      return '<div class="panel apanel"><div class="empty"><div class="empty__art">' +
        KT.icon("settings", 30) + "</div><h3>No settings</h3>" +
        "<p>app_settings is empty. Nothing to show.</p></div></div>";
    }
    return '<div class="setgrid">' + state.rows.map(cardHTML).join("") + "</div>";
  }

  function paint() {
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    KT.mount(host,
      '<header class="apage__head"><div><h1>App settings</h1>' +
        '<p class="apage__lede">Operational settings the storefront reads live. ' +
        (state.isOwner
          ? "You are the owner, so every setting is yours to change."
          : "Fees and service area are owner-only — you can see them, not change them.") +
        " Every change is recorded in the audit log.</p></div></header>" +
      bodyHTML());
  }

  /* ---- Data -------------------------------------------------------------- */

  async function load() {
    state.loading = true; state.error = null; paint();
    try {
      if (!svc) svc = (await import("../services/admin-settings.js")).adminSettingsService;
      var res = await svc.list();
      /*
         app_settings also holds internal markers that are not operator
         settings — `inventory_activated_on` is written by the inventory
         ledger and read by it to decide which dates were tracked. Those have
         no field definition here, and rendering one as a generic input would
         invite an edit with consequences nobody intended. The screen shows
         the settings it actually knows how to present.
      */
      state.rows = (res.rows || []).filter(function (r) { return svc.knows(r.key); });
      state.viewerRole = res.viewer_role || "";
      state.isOwner = !!res.is_owner;
      state.dirty = {};
      state.loading = false;
      paint();
    } catch (error) {
      state.loading = false;
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
      paint();
    }
  }

  async function save(key) {
    var row = state.rows.filter(function (r) { return r.key === key; })[0];
    if (!row || !state.dirty[key]) return;
    var btn = KT.qs('[data-set-save="' + key + '"]');
    var done = KT.busy(btn, "Saving…");
    if (!done) return;
    state.saving = key;
    try {
      var packed = svc.meta(key).pack(state.dirty[key]);
      var out = await svc.save(key, packed);
      row.value = out.value;
      row.updated_at = out.updated_at;
      delete state.dirty[key];
      KT.toast(row.label + " saved.", "success");
    } catch (error) {
      done();
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    } finally {
      state.saving = null;
      paint();
    }
  }

  /* ---- Wiring ------------------------------------------------------------ */

  function edit(key, name, value) {
    var row = state.rows.filter(function (r) { return r.key === key; })[0];
    if (!row) return;
    if (!state.dirty[key]) state.dirty[key] = svc.meta(key).unpack(row.value);
    state.dirty[key][name] = value;
  }

  document.addEventListener("input", function (e) {
    var f = e.target.closest("[data-set-field]");
    if (!f || f.type === "checkbox") return;
    var parts = f.getAttribute("data-set-field").split("|");
    edit(parts[0], parts[1], f.type === "number" ? f.value : f.value);
    /* Repaint only the footer so the caret is never yanked out of the field. */
    var card = KT.qs('[data-set-card="' + parts[0] + '"]');
    var save = card && KT.qs("[data-set-save]", card);
    if (save) save.disabled = false;
    if (card && !KT.qs("[data-set-reset]", card)) paintFoot(parts[0]);
  });

  function paintFoot(key) {
    var row = state.rows.filter(function (r) { return r.key === key; })[0];
    var card = KT.qs('[data-set-card="' + key + '"]');
    if (!row || !card) return;
    var foot = KT.qs(".setcard__foot", card);
    if (!foot) return;
    foot.innerHTML =
      '<span class="setcard__stamp">Updated ' + when(row.updated_at) + "</span>" +
      '<span class="setcard__actions">' +
        '<button class="btn btn--ghost btn--sm" type="button" data-set-reset="' +
          esc(key) + '">Discard</button>' +
        '<button class="btn btn--primary btn--sm" type="button" data-set-save="' +
          esc(key) + '">Save</button>' +
      "</span>";
  }

  document.addEventListener("change", function (e) {
    var f = e.target.closest("[data-set-field]");
    if (!f || f.type !== "checkbox") return;
    var parts = f.getAttribute("data-set-field").split("|");
    edit(parts[0], parts[1], f.checked);
    paint();
  });

  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-set-reload]")) { e.preventDefault(); load(); return; }

    var reset = e.target.closest("[data-set-reset]");
    if (reset) {
      e.preventDefault();
      delete state.dirty[reset.getAttribute("data-set-reset")];
      paint();
      return;
    }

    var s = e.target.closest("[data-set-save]");
    if (s) { e.preventDefault(); save(s.getAttribute("data-set-save")); }
  });

  /* ---- View -------------------------------------------------------------- */

  KT.admin.views.settings = function () {
    state = { loading: true, error: null, rows: [], viewerRole: "", isOwner: false,
      dirty: {}, saving: null };
    window.setTimeout(load, 0);
    return '<header class="apage__head"><div><h1>App settings</h1>' +
      '<p class="apage__lede">Loading settings…</p></div></header>' +
      '<div class="panel apanel">' + KT.skeleton.lines(6) + "</div>";
  };

  /* No subscriptions here, but unsaved edits must not survive navigation — a
     half-typed delivery fee reappearing on a later visit would be worse than
     losing it. */
  KT.admin.views.settingsTeardown = function () {
    state.dirty = {};
    state.saving = null;
  };
})(window.KT || (window.KT = {}));
