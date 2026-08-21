/* ==========================================================================
   Kandy's Treats — Admin menu module
   --------------------------------------------------------------------------
   Serves BOTH routes from one implementation:
     #/menu         "Menu availability"  — staff+
     #/menu-manage  "Menu management"    — admin+
   The nav already stops staff reaching the second, so the difference here is
   purely which controls are drawn. Capability is read from the role, and the
   database enforces it independently: a staff member who reaches an edit form
   by any means gets "Staff may only change item availability" from the
   trigger.

   All data access lives in js/services/admin-menu.js.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var svc = null, unwatch = null, searchTimer = null;
  var ctx = { role: "staff" };
  var state = {
    items: [], categories: [], loading: true, error: null, refreshing: false,
    search: "", category: "all", status: "all", live: false,
    editing: null,        /* null | {} for new | item object */
    form: null, formErrors: {}, saving: false, uploading: false,
    confirm: null         /* {kind:'item'|'category', id, name} */
  };

  function can(what) {
    var r = KT.admin.rank(ctx.role);
    if (what === "edit")   return r >= KT.admin.rank("admin");
    if (what === "delete") return r >= KT.admin.rank("owner");
    return r >= KT.admin.rank("staff");     /* availability */
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function when(d) {
    return d ? d.toLocaleDateString("en-NG", { day: "2-digit", month: "short", year: "numeric" }) : "—";
  }
  function catName(id) {
    var c = state.categories.filter(function (x) { return x.id === id; })[0];
    return c ? c.name : (id || "—");
  }
  function imageFor(item) {
    if (item.imageUrl) return item.imageUrl;
    if (item.imageKey && KT.images && KT.images.src) return KT.images.src({ image: item.imageKey });
    return "";
  }

  /* ---- Chrome ---------------------------------------------------------- */

  function headHTML() {
    return (
      '<header class="apage__head opage__head">' +
        "<div><h1>" + (can("edit") ? "Menu management" : "Menu availability") + "</h1>" +
          '<p class="apage__lede">' +
            (state.live ? '<span class="olive"><span class="olive__dot"></span>Live</span> — ' : "") +
            (can("edit")
              ? "Create, edit and price the catalogue."
              : "Mark items available, sold out or hidden. Prices and details are managed by a manager.") +
          "</p></div>" +
        '<div class="mhead__actions">' +
          '<button class="btn btn--soft btn--sm" type="button" data-mrefresh' +
            (state.refreshing ? " disabled" : "") + ">" +
            (state.refreshing ? KT.spinner(15) + "<span>Refreshing…</span>" : "Refresh") + "</button>" +
          (can("edit")
            ? '<button class="btn btn--primary btn--sm" type="button" data-mnew>New item</button>' : "") +
        "</div>" +
      "</header>"
    );
  }

  function filtersHTML() {
    return (
      '<div class="ofilters">' +
        '<div class="ochips">' +
          '<button class="chip' + (state.category === "all" ? " is-active" : "") +
            '" type="button" data-mcat="all">All categories</button>' +
          state.categories.map(function (c) {
            return '<button class="chip' + (state.category === c.id ? " is-active" : "") +
              '" type="button" data-mcat="' + esc(c.id) + '">' + esc(c.name) + "</button>";
          }).join("") +
        "</div>" +
        '<div class="ochips">' +
          [["all", "Any status"]].concat((svc ? svc.STATUSES : []).map(function (s) { return [s.id, s.label]; }))
            .map(function (t) {
              return '<button class="chip' + (state.status === t[0] ? " is-active" : "") +
                '" type="button" data-mstatus="' + t[0] + '">' + t[1] + "</button>";
            }).join("") +
        "</div>" +
        '<div class="osearch">' +
          '<span class="osearch__icon">' + KT.icon("search", 17) + "</span>" +
          '<input class="input" type="search" data-msearch placeholder="Search items by name" ' +
            'value="' + esc(state.search) + '" aria-label="Search menu items">' +
        "</div>" +
      "</div>"
    );
  }

  /* ---- List ------------------------------------------------------------ */

  function statusPickerHTML(item) {
    return '<div class="mstatus" role="group" aria-label="Availability">' +
      (svc ? svc.STATUSES : []).map(function (s) {
        return '<button class="mstatus__btn' + (item.status === s.id ? " is-on" : "") +
          '" type="button" data-mset="' + item.id + '" data-mval="' + s.id + '">' +
          s.label + "</button>";
      }).join("") + "</div>";
  }

  function cardHTML(item) {
    var img = imageFor(item);
    return (
      '<article class="mcard" data-mitem="' + item.id + '">' +
        '<div class="mcard__thumb">' +
          (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" decoding="async">'
               : '<span class="mcard__noimg">' + KT.icon("flame", 20) + "</span>") +
        "</div>" +
        '<div class="mcard__body">' +
          '<div class="mcard__top">' +
            "<strong>" + esc(item.name) + "</strong>" +
            '<span class="obadge ' + (item.status === "available" ? "is-completed"
              : item.status === "sold_out" ? "is-cancelled" : "is-out") + '">' +
              esc(item.status.replace("_", " ")) + "</span>" +
          "</div>" +
          '<p class="mcard__desc">' + (esc(item.blurb || item.description) || "<em>No description</em>") + "</p>" +
          '<p class="mcard__meta"><span class="otag">' + esc(catName(item.categoryId)) + "</span>" +
            "<span>created " + when(item.createdAt) + "</span>" +
            '<span class="ocard__sep">·</span><span>updated ' + when(item.updatedAt) + "</span></p>" +
          statusPickerHTML(item) +
        "</div>" +
        '<div class="mcard__right">' +
          '<span class="mcard__price">' + KT.naira(item.price) + "</span>" +
          (can("edit") ? '<button class="btn btn--ghost btn--sm" type="button" data-medit="' +
            item.id + '">Edit</button>' : "") +
          (can("delete") ? '<button class="btn btn--ghost btn--sm odanger" type="button" data-mdel="' +
            item.id + '">Delete</button>' : "") +
        "</div>" +
      "</article>"
    );
  }

  function listHTML() {
    if (state.loading) return '<div class="mlist">' + KT.loadingLabel("Loading menu…") + KT.skeleton.orders(4) + "</div>";
    if (state.error) {
      return '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("close", 32) + "</div>" +
        "<h3>We could not load the menu</h3><p>" + esc(state.error) + "</p>" +
        '<button class="btn btn--primary" type="button" data-mretry>Try again</button></div></div>';
    }
    if (!state.items.length) {
      var filtered = state.category !== "all" || state.status !== "all" || state.search;
      return '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("flame", 32) + "</div>" +
        (filtered
          ? "<h3>No items match those filters</h3><p>Try another category, status or search term.</p>" +
            '<button class="btn btn--soft" type="button" data-mclear>Clear filters</button>'
          : "<h3>The catalogue is empty</h3><p>Add your first item to get started.</p>") +
        "</div></div>";
    }
    return '<div class="mlist">' + state.items.map(cardHTML).join("") + "</div>";
  }

  /* ---- Form ------------------------------------------------------------ */

  function field(name, label, control, hint) {
    var err = state.formErrors[name];
    return '<label class="field mfield"><span class="field__label">' + label + "</span>" +
      control + (err ? '<span class="field__hint mfield__err">' + esc(err) + "</span>"
                     : (hint ? '<span class="field__hint">' + hint + "</span>" : "")) + "</label>";
  }

  function formHTML() {
    var f = state.form || {};
    var isNew = !state.editing || !state.editing.id;
    var preview = f.imageUrl || (state.editing && imageFor(state.editing)) || "";
    return (
      '<div class="odrawer is-open" data-mdrawer>' +
        '<div class="odrawer__scrim" data-mclose></div>' +
        '<aside class="odrawer__panel" role="dialog" aria-modal="true" aria-label="Menu item">' +
          '<header class="odrawer__head"><div><strong>' +
            (isNew ? "New item" : esc(state.editing.name)) + "</strong>" +
            '<span class="odrawer__sub">' + (isNew ? "Create a menu item" : "Edit menu item") + "</span></div>" +
            '<button class="icon-btn" type="button" data-mclose aria-label="Close">' + KT.icon("close", 20) + "</button>" +
          "</header>" +
          '<form class="odetail__body mform" data-mform novalidate>' +
            field("name", "Name",
              '<input class="input" name="name" value="' + esc(f.name || "") + '" required>') +
            field("blurb", "Short description",
              '<input class="input" name="blurb" value="' + esc(f.blurb || "") + '">',
              "Shown on the menu card.") +
            field("description", "Full description",
              '<textarea class="input" name="description" rows="3">' + esc(f.description || "") + "</textarea>") +
            field("price", "Price (₦)",
              '<input class="input" name="price" type="number" min="0" step="1" value="' +
                esc(f.price == null ? "" : f.price) + '" required>') +
            field("categoryId", "Category",
              '<select class="input" name="categoryId" required>' +
                '<option value="">Choose…</option>' +
                state.categories.map(function (c) {
                  return '<option value="' + esc(c.id) + '"' +
                    (f.categoryId === c.id ? " selected" : "") + ">" + esc(c.name) + "</option>";
                }).join("") + "</select>") +
            field("status", "Availability",
              '<select class="input" name="status">' +
                (svc ? svc.STATUSES : []).map(function (s) {
                  return '<option value="' + s.id + '"' +
                    ((f.status || "available") === s.id ? " selected" : "") + ">" + s.label + "</option>";
                }).join("") + "</select>") +
            '<div class="field mfield"><span class="field__label">Image</span>' +
              '<div class="mimage">' +
                (preview ? '<img class="mimage__preview" src="' + esc(preview) + '" alt="">'
                         : '<span class="mimage__empty">' + KT.icon("flame", 22) + "</span>") +
                '<div class="mimage__actions">' +
                  '<input class="mimage__file" type="file" accept="image/*" data-mfile id="mfile">' +
                  '<label class="btn btn--soft btn--sm" for="mfile">' +
                    (state.uploading ? KT.spinner(14) + "<span>Uploading…</span>" : "Choose photo") + "</label>" +
                  (f.imageUrl ? '<button class="btn btn--ghost btn--sm" type="button" data-mimgclear>Remove</button>' : "") +
                "</div>" +
              "</div>" +
              '<span class="field__hint">JPEG, PNG or WebP up to 5&nbsp;MB. Leaving this blank keeps the bundled photo.</span>' +
            "</div>" +
            '<div class="mform__actions">' +
              '<button class="btn btn--primary" type="submit" data-msave>' +
                (state.saving ? KT.spinner(15) + "<span>Saving…</span>" : (isNew ? "Create item" : "Save changes")) +
              "</button>" +
              '<button class="btn btn--ghost" type="button" data-mclose>Cancel</button>' +
            "</div>" +
          "</form>" +
        "</aside>" +
      "</div>"
    );
  }

  function confirmHTML() {
    var c = state.confirm;
    if (!c) return "";
    return (
      '<div class="mconfirm" data-mconfirm>' +
        '<div class="mconfirm__scrim" data-mcancel></div>' +
        '<div class="mconfirm__box" role="alertdialog" aria-modal="true" aria-labelledby="mcTitle">' +
          '<span class="mconfirm__mark">' + KT.icon("trash", 26) + "</span>" +
          '<h3 id="mcTitle">Delete ' + esc(c.name) + "?</h3>" +
          "<p>This permanently removes the " + (c.kind === "category" ? "category" : "menu item") +
            ". It cannot be undone, and the action is recorded in the audit log.</p>" +
          '<div class="mconfirm__actions">' +
            '<button class="btn btn--ghost" type="button" data-mcancel>Keep it</button>' +
            '<button class="btn btn--primary odanger-solid" type="button" data-mconfirmdel>' +
              (state.saving ? KT.spinner(15) + "<span>Deleting…</span>" : "Delete permanently") + "</button>" +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }

  /* ---- Render ---------------------------------------------------------- */

  function render() {
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    var active = document.activeElement;
    var wasSearch = active && active.hasAttribute && active.hasAttribute("data-msearch");
    var caret = wasSearch ? active.selectionStart : null;

    KT.mount(host, headHTML() + filtersHTML() + listHTML() +
      (state.editing ? formHTML() : "") + confirmHTML());

    if (wasSearch) {
      var i = KT.qs("[data-msearch]");
      if (i) { i.focus(); try { i.setSelectionRange(caret, caret); } catch (e) {} }
    }
  }

  /* ---- Data ------------------------------------------------------------ */

  async function load(opts) {
    opts = opts || {};
    if (opts.refresh) state.refreshing = true; else state.loading = true;
    state.error = null;
    render();
    try {
      if (!state.categories.length) state.categories = await svc.adminMenuService.categories();
      state.items = await svc.adminMenuService.list({
        search: state.search, category: state.category, status: state.status
      });
    } catch (error) {
      state.error = KT.services.errorMessage(error);
      state.items = [];
    } finally {
      state.loading = false; state.refreshing = false; render();
    }
  }

  async function setStatus(id, value, btn) {
    var done = KT.busy(btn, "…");
    if (!done) return;
    try {
      await svc.adminMenuService.setStatus(id, value);
      state.items = state.items.map(function (i) {
        return i.id === id ? Object.assign({}, i, { status: value }) : i;
      });
      KT.toast("Availability updated.", "success", { duration: 2400 });
      render();
    } catch (error) {
      done();
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    }
  }

  function openForm(item) {
    state.editing = item || {};
    state.form = item
      ? { name: item.name, blurb: item.blurb, description: item.description,
          price: item.price, categoryId: item.categoryId, status: item.status,
          imageUrl: item.imageUrl }
      : { name: "", blurb: "", description: "", price: "", categoryId: "", status: "available", imageUrl: "" };
    state.formErrors = {};
    render();
  }

  function readForm() {
    var form = KT.qs("[data-mform]");
    if (!form) return state.form;
    var f = {};
    ["name", "blurb", "description", "price", "categoryId", "status"].forEach(function (k) {
      var el = form.querySelector('[name="' + k + '"]');
      if (el) f[k] = el.value;
    });
    f.imageUrl = state.form.imageUrl;
    return f;
  }

  async function save() {
    state.form = readForm();
    var check = svc.validate(state.form);
    state.formErrors = check.errors;
    if (!check.valid) { render(); return; }

    state.saving = true; render();
    try {
      var saved = await svc.adminMenuService.save(state.editing.id || null, state.form);
      KT.toast(state.editing.id ? "Item updated." : "Item created.", "success");
      state.editing = null; state.form = null;
      await load({ refresh: true });
      return saved;
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    } finally {
      state.saving = false; render();
    }
  }

  async function upload(file) {
    if (!file) return;
    state.uploading = true; render();
    try {
      var url = await svc.adminMenuService.uploadImage(file, state.editing && state.editing.id);
      state.form = Object.assign(readForm(), { imageUrl: url });
      KT.toast("Photo uploaded.", "success", { duration: 2600 });
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    } finally {
      state.uploading = false; render();
    }
  }

  async function doDelete() {
    var c = state.confirm;
    if (!c) return;
    state.saving = true; render();
    try {
      if (c.kind === "category") await svc.adminMenuService.removeCategory(c.id);
      else await svc.adminMenuService.remove(c.id);
      KT.toast("Deleted.", "success");
      state.confirm = null;
      state.categories = [];
      await load({ refresh: true });
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    } finally {
      state.saving = false; render();
    }
  }

  /* ---- Realtime -------------------------------------------------------- */

  function startWatch() {
    if (unwatch) return;
    unwatch = svc.adminMenuService.watch(
      function () { if (!state.editing && !state.confirm) load({ refresh: true }); },
      function (s) { var live = s === "SUBSCRIBED"; if (live !== state.live) { state.live = live; render(); } }
    );
  }

  /* ---- Entry ----------------------------------------------------------- */

  function mount(viewCtx) {
    ctx = viewCtx || ctx;

    /* #/menu?status=sold_out, from the dashboard's availability tile. */
    var qp = KT.admin.routeParams();
    state.status = (qp.status === "sold_out" || qp.status === "hidden" ||
                    qp.status === "available") ? qp.status : "all";

    setTimeout(async function () {
      if (!svc) {
        try { svc = await import("../services/admin-menu.js"); }
        catch (e) { state.loading = false; state.error = "Could not load the menu module."; render(); return; }
      }
      await load();
      startWatch();
    }, 0);
    return '<div data-menu-mount>' + KT.loadingLabel("Loading menu…") + KT.skeleton.orders(4) + "</div>";
  }

  KT.admin.views.menu = mount;
  KT.admin.views["menu-manage"] = mount;

  function teardown() {
    if (unwatch) { unwatch(); unwatch = null; }
    state.live = false; state.editing = null; state.form = null; state.confirm = null;
  }
  KT.admin.views.menuTeardown = teardown;
  KT.admin.views["menu-manageTeardown"] = teardown;

  /* ---- Events ---------------------------------------------------------- */

  document.addEventListener("click", function (e) {
    var t = e.target;
    var cat = t.closest("[data-mcat]");
    if (cat) { state.category = cat.getAttribute("data-mcat"); load(); return; }
    var st = t.closest("[data-mstatus]");
    if (st) { state.status = st.getAttribute("data-mstatus"); load(); return; }
    if (t.closest("[data-mrefresh]")) { load({ refresh: true }); return; }
    if (t.closest("[data-mretry]"))   { load(); return; }
    if (t.closest("[data-mclear]")) {
      state.category = "all"; state.status = "all"; state.search = ""; load(); return;
    }
    var set = t.closest("[data-mset]");
    if (set) { setStatus(set.getAttribute("data-mset"), set.getAttribute("data-mval"), set); return; }
    if (t.closest("[data-mnew]")) { openForm(null); return; }
    var ed = t.closest("[data-medit]");
    if (ed) {
      var item = state.items.filter(function (i) { return i.id === ed.getAttribute("data-medit"); })[0];
      if (item) openForm(item);
      return;
    }
    var del = t.closest("[data-mdel]");
    if (del) {
      var d = state.items.filter(function (i) { return i.id === del.getAttribute("data-mdel"); })[0];
      if (d) { state.confirm = { kind: "item", id: d.id, name: d.name }; render(); }
      return;
    }
    if (t.closest("[data-mclose]"))   { state.editing = null; state.form = null; render(); return; }
    if (t.closest("[data-mcancel]"))  { state.confirm = null; render(); return; }
    if (t.closest("[data-mconfirmdel]")) { doDelete(); return; }
    if (t.closest("[data-mimgclear]")) {
      state.form = Object.assign(readForm(), { imageUrl: "" }); render(); return;
    }
    if (t.closest("[data-msave]")) { e.preventDefault(); save(); }
  });

  document.addEventListener("submit", function (e) {
    if (e.target.closest("[data-mform]")) { e.preventDefault(); save(); }
  });

  document.addEventListener("change", function (e) {
    var file = e.target.closest("[data-mfile]");
    if (file && file.files && file.files[0]) upload(file.files[0]);
  });

  document.addEventListener("input", function (e) {
    var i = e.target.closest("[data-msearch]");
    if (!i) return;
    state.search = i.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { load(); }, 280);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (state.confirm) { state.confirm = null; render(); }
    else if (state.editing) { state.editing = null; state.form = null; render(); }
  });
})(window.KT || (window.KT = {}));
