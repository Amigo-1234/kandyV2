/* ==========================================================================
   Kandy's Treats — Account
   Profile, Kandy's wallet, saved addresses and recent orders — all live from
   Firestore. The layout and every component are unchanged from the approved
   design; the loyalty card now shows the real wallet balance instead of
   invented points, because a wallet is what V1 actually gives customers.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.pages = KT.pages || {};

  var LINKS = [
    ["account", "Account overview", "user", "pages/account.html"],
    ["orders", "Order history", "receipt", "pages/orders.html"],
    ["addresses", "Saved addresses", "pin", "pages/account.html#addresses"],
    ["wallet", "Kandy's wallet", "wallet", "pages/account.html#wallet"]
  ];

  var state = { profile: null, wallet: null, addresses: [], orders: [], editing: null };

  function initials(name) {
    return String(name || "K")
      .split(" ").map(function (n) { return n[0]; }).join("").slice(0, 2).toUpperCase();
  }

  function sideNav(active) {
    var p = state.profile;
    var name = (p && p.displayName) || (p && p.email) || "Your account";
    return (
      '<div class="account__nav">' +
        '<div class="account__who">' +
          '<span class="avatar">' + initials(name) + "</span>" +
          "<div><strong>" + name + "</strong><span>" +
            (p && p.email ? p.email : "Not signed in") + "</span></div>" +
        "</div>" +
        '<nav class="account__links" aria-label="Account">' +
          LINKS.map(function (l) {
            return '<a href="' + KT.url(l[3]) + '"' +
              (l[0] === active ? ' class="is-active" aria-current="page"' : "") + ">" +
              KT.icon(l[2], 19) + l[1] + "</a>";
          }).join("") +
          '<a href="#" class="is-danger" data-signout>' + KT.icon("logout", 19) + "Sign out</a>" +
        "</nav>" +
      "</div>"
    );
  }

  /* ---- Signed-out ------------------------------------------------------ */

  function signedOut() {
    KT.mount("[data-account-nav]", "");
    KT.mount("[data-account-main]",
      '<div class="panel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("user", 38) + "</div>" +
        "<h3>Sign in to see your account</h3>" +
        "<p>Your saved addresses, wallet balance and order history live behind your Kandy's account.</p>" +
        '<a class="btn btn--primary" href="' + KT.url("pages/login.html?next=account") + '">Sign in</a>' +
        '<p style="margin-top:14px"><a href="' + KT.url("pages/signup.html") +
          '" style="font-weight:700;color:var(--kt-pink)">Create an account</a></p>' +
      "</div></div>");
  }

  /* ---- Sections -------------------------------------------------------- */

  function walletCard() {
    var w = state.wallet || { balance: 0 };
    var balance = Number(w.balance || 0);
    return (
      '<div class="loyalty" id="wallet">' +
        '<div class="loyalty__top">' +
          '<div><span class="loyalty__tier">' + KT.icon("wallet", 15) + "Kandy's wallet</span>" +
            '<p class="loyalty__points">' + KT.naira(balance) + "<em>available</em></p></div>" +
          '<button class="btn btn--onDark btn--sm" type="button" data-fund>Top up</button>' +
        "</div>" +
        '<div class="loyalty__bar"><span style="width:' +
          Math.min(100, balance ? Math.max(6, Math.round((balance / 20000) * 100)) : 0) + '%"></span></div>' +
        '<p class="loyalty__note">Pay from your wallet and skip the 2% card processing fee. ' +
          "Top-ups are handled by Paystack or Flutterwave.</p>" +
      "</div>"
    );
  }

  function profilePanel() {
    var p = state.profile || {};
    var editing = state.editing === "profile";
    return (
      '<div class="panel">' +
        '<div class="panel__head"><div><h2>Your details</h2>' +
          "<p>Used for delivery updates and receipts.</p></div>" +
          '<button class="btn btn--ghost btn--sm" type="button" data-edit-profile>' +
            (editing ? "Cancel" : "Edit") + "</button></div>" +
        '<form data-profile-form>' +
          '<div class="authrow">' +
            '<label class="field"><span class="field__label">Full name</span>' +
              '<input class="input" name="displayName" value="' + (p.displayName || "") + '"' +
              (editing ? "" : " readonly") + "></label>" +
            '<label class="field"><span class="field__label">Phone</span>' +
              '<input class="input" name="phone" value="' + KT.rules.displayPhone(p.phone) + '"' +
              (editing ? "" : " readonly") + "></label>" +
          "</div>" +
          '<label class="field" style="margin-top:16px"><span class="field__label">Email</span>' +
            '<input class="input" value="' + (p.email || "") + '" readonly></label>' +
          (p.emailVerified ? "" :
            '<p class="field__hint" style="color:var(--amber)">Email not verified — ' +
            '<button type="button" data-resend style="font-weight:700;color:var(--kt-pink)">resend the link</button>.</p>') +
          (editing
            ? '<button class="btn btn--primary" type="submit" style="margin-top:16px">Save changes</button>'
            : "") +
        "</form>" +
      "</div>"
    );
  }

  function addressForm(address) {
    var a = address || {};
    return (
      '<form class="panel" data-address-form style="border-color:var(--kt-pink-200);background:var(--kt-pink-50)">' +
        '<div class="panel__head"><div><h2>' + (a.id ? "Edit address" : "New delivery address") + "</h2>" +
          "<p>" + KT.config.serviceArea.note + "</p></div></div>" +
        '<input type="hidden" name="id" value="' + (a.id || "") + '">' +
        '<div class="authrow">' +
          '<label class="field"><span class="field__label">Label</span>' +
            '<input class="input" name="label" placeholder="Home, Office…" value="' + (a.label || "") + '"></label>' +
          '<label class="field"><span class="field__label">Who receives it?</span>' +
            '<input class="input" name="recipientName" placeholder="Full name" value="' + (a.recipientName || "") + '"></label>' +
        "</div>" +
        '<label class="field" style="margin-top:16px"><span class="field__label">Phone number</span>' +
          '<input class="input" name="phone" type="tel" placeholder="+234 801 234 5678" value="' +
            KT.rules.displayPhone(a.phone) + '"></label>' +
        '<label class="field" style="margin-top:16px"><span class="field__label">Full address</span>' +
          '<textarea class="textarea" name="address" rows="3" ' +
            'placeholder="Street, area and a landmark — e.g. 14 Adeola Odeku Street, Victoria Island, opposite the filling station">' +
            (a.address || "") + "</textarea>" +
          '<span class="field__hint">We deliver within ' + KT.config.serviceArea.state +
            " State only. Type it in full — there is no map lookup.</span></label>" +
        '<label class="field" style="margin-top:16px"><span class="field__label">Note for the rider (optional)</span>' +
          '<input class="input" name="notes" placeholder="Gate code, call on arrival…" value="' + (a.notes || "") + '"></label>' +
        '<label class="checkline" style="margin-top:16px"><input type="checkbox" name="isDefault"' +
          (a.isDefault ? " checked" : "") + '><span class="checkline__box">' + KT.icon("check", 12) +
          "</span><span>Use this as my default delivery address</span></label>" +
        '<div style="display:flex;gap:10px;margin-top:18px">' +
          '<button class="btn btn--primary" type="submit">Save address</button>' +
          '<button class="btn btn--ghost" type="button" data-cancel-address>Cancel</button>' +
        "</div>" +
      "</form>"
    );
  }

  function addressPanel() {
    if (state.editing === "address" || state.editing === "new-address") {
      return addressForm(state.editingAddress);
    }
    return (
      '<div class="panel" id="addresses">' +
        '<div class="panel__head"><div><h2>Saved addresses</h2>' +
          "<p>" + KT.config.serviceArea.label + " · riders use the note when they arrive.</p></div></div>" +
        '<div class="tilegrid">' +
          state.addresses.map(function (a) {
            return (
              '<div class="tile' + (a.isDefault ? " is-default" : "") + '">' +
                '<p class="tile__label">' + KT.icon("pin", 17) + (a.label || "Address") +
                  (a.isDefault ? '<span class="tile__badge">Default</span>' : "") + "</p>" +
                "<p>" + (a.address || "") + "</p>" +
                "<small>" + [a.recipientName, KT.rules.displayPhone(a.phone), a.notes]
                  .filter(Boolean).join(" · ") + "</small>" +
                '<div class="tile__acts">' +
                  '<button type="button" data-edit-address="' + a.id + '">Edit</button>' +
                  (a.isDefault ? "" : '<button type="button" data-default-address="' + a.id + '">Make default</button>') +
                  '<button type="button" data-remove-address="' + a.id + '">Remove</button>' +
                "</div>" +
              "</div>"
            );
          }).join("") +
          '<button class="tile tile--add" type="button" data-new-address>' +
            "<span>" + KT.icon("plus", 20) + "</span>Add a new address</button>" +
        "</div>" +
      "</div>"
    );
  }

  function ordersPanel() {
    if (!state.orders.length) {
      return (
        '<div class="panel">' +
          '<div class="panel__head"><div><h2>Recent orders</h2></div></div>' +
          '<div class="empty" style="padding:24px 0">' +
            "<p>No orders yet. Your first one will appear here.</p>" +
            '<a class="btn btn--soft" href="' + KT.url("pages/menu.html") + '">Browse the menu</a>' +
          "</div>" +
        "</div>"
      );
    }
    return (
      '<div class="panel">' +
        '<div class="panel__head"><div><h2>Recent orders</h2></div>' +
          '<a class="btn btn--ghost btn--sm" href="' + KT.url("pages/orders.html") + '">See all</a></div>' +
        '<div class="orderitems">' +
          state.orders.slice(0, 3).map(function (o) {
            var first = KT.menu.byId((o.items[0] || {}).menuId || (o.items[0] || {}).id);
            return (
              '<a class="orderitem" href="' + KT.url("pages/order-detail.html?id=" + encodeURIComponent(o.id)) + '">' +
                '<span class="ring"><img data-food alt="" src="' + KT.images.src(first || {}) + '"></span>' +
                '<div class="orderitem__text"><strong>' + o.id + "</strong>" +
                  "<span>" + (o.createdAt ? o.createdAt.toLocaleString("en-NG", {
                    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "") +
                  " · " + KT.plural(o.itemCount, "item") + "</span></div>" +
                '<span class="status status--' + o.status.toLowerCase() + '">' + o.statusLabel + "</span>" +
                '<span class="price">' + KT.naira(o.total) + "</span>" +
              "</a>"
            );
          }).join("") +
        "</div>" +
      "</div>"
    );
  }

  function render() {
    if (!KT.auth || !KT.auth.isSignedIn()) return signedOut();
    KT.mount("[data-account-nav]", sideNav("account"));
    KT.mount("[data-account-main]",
      walletCard() + profilePanel() + addressPanel() + ordersPanel());
    KT.images.bindAll(document);
  }

  /* ---- Data ------------------------------------------------------------ */

  async function load() {
    if (!KT.services || !KT.auth.isSignedIn()) return render();
    var s = KT.services;
    var results = await Promise.allSettled([
      s.account.profile(), s.wallet.get(), s.addresses.list(), s.orders.list({ limit: 5 })
    ]);
    state.profile = results[0].value || null;
    state.wallet = results[1].value || null;
    state.addresses = results[2].value || [];
    state.orders = results[3].value || [];
    render();

    s.wallet.watch(function (w) { state.wallet = w; render(); });
  }

  async function saveAddress(form) {
    var data = Object.fromEntries(new FormData(form).entries());
    data.isDefault = !!data.isDefault;
    var btn = KT.qs("[type=submit]", form);
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      await KT.services.addresses.save(data);
      state.editing = null; state.editingAddress = null;
      state.addresses = await KT.services.addresses.list();
      render();
      KT.toast("Address saved.", "success");
    } catch (error) {
      btn.disabled = false; btn.textContent = "Save address";
      KT.toast(KT.services ? KT.services.errorMessage(error) : error.message, "error", { duration: 5000 });
    }
  }

  /* ---- Wiring ---------------------------------------------------------- */

  KT.pages.account = function () {
    render();
    document.addEventListener("kt:auth", load);
    document.addEventListener("kt:services", load);
    if (location.hash === "#addresses") state.editing = null;

    document.addEventListener("click", async function (e) {
      var t = e.target;

      if (t.closest("[data-signout]")) {
        e.preventDefault();
        await KT.auth.signOut();
        window.location.href = KT.url("index.html");
      }
      if (t.closest("[data-edit-profile]")) {
        state.editing = state.editing === "profile" ? null : "profile";
        render();
      }
      if (t.closest("[data-new-address]")) {
        state.editing = "new-address"; state.editingAddress = null; render();
      }
      var edit = t.closest("[data-edit-address]");
      if (edit) {
        state.editing = "address";
        state.editingAddress = state.addresses.filter(function (a) {
          return a.id === edit.getAttribute("data-edit-address");
        })[0];
        render();
      }
      if (t.closest("[data-cancel-address]")) {
        state.editing = null; state.editingAddress = null; render();
      }
      var def = t.closest("[data-default-address]");
      if (def) {
        await KT.services.addresses.makeDefault(def.getAttribute("data-default-address"));
        state.addresses = await KT.services.addresses.list();
        render();
      }
      var rm = t.closest("[data-remove-address]");
      if (rm) {
        await KT.services.addresses.remove(rm.getAttribute("data-remove-address"));
        state.addresses = await KT.services.addresses.list();
        render();
        KT.toast("Address removed.", "info");
      }
      if (t.closest("[data-resend]")) {
        await KT.auth.resendVerification();
        KT.toast("Verification email sent.", "success");
      }
      if (t.closest("[data-fund]")) {
        KT.toast("Wallet top-up opens Paystack — coming to this screen next.", "info");
      }
    });

    document.addEventListener("submit", async function (e) {
      var addrForm = e.target.closest("[data-address-form]");
      if (addrForm) { e.preventDefault(); return saveAddress(addrForm); }

      var profForm = e.target.closest("[data-profile-form]");
      if (profForm && state.editing === "profile") {
        e.preventDefault();
        var data = Object.fromEntries(new FormData(profForm).entries());
        try {
          await KT.services.account.updateProfile(data);
          state.editing = null;
          state.profile = await KT.services.account.profile();
          render();
          KT.toast("Details updated.", "success");
        } catch (error) {
          KT.toast(KT.services.errorMessage(error), "error");
        }
      }
    });
  };

  KT.pages.accountNav = sideNav;
})(window.KT || (window.KT = {}));
