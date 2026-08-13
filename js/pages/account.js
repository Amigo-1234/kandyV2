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
    ["wallet", "Kandy's wallet", "wallet", "pages/account.html#wallet"],
    ["support", "Help & support", "mail", "pages/account.html#support"]
  ];

  var state = {
    profile: null, wallet: null, addresses: [], orders: [],
    transactions: [], favourites: [], notifications: [], tickets: [],
    editing: null, gateways: null
  };

  var TOP_UPS = [2000, 5000, 10000, 20000];

  function initials(name) {
    return String(name || "K")
      .split(" ").map(function (n) { return n[0]; }).join("").slice(0, 2).toUpperCase();
  }

  function sideNav(active) {
    /* The orders and order-detail pages reuse this nav without running this
       module's load(), so state.profile is null there. Falling back to the
       Firebase user keeps the header truthful without a second request. */
    var p = state.profile;
    var u = (KT.auth && KT.auth.user && KT.auth.user()) || null;
    var name = (p && p.displayName) || (p && p.email) ||
      (u && (u.displayName || u.email)) || "Your account";
    var email = (p && p.email) || (u && u.email) || "";
    return (
      '<div class="account__nav">' +
        '<div class="account__who">' +
          '<span class="avatar">' + initials(name) + "</span>" +
          "<div><strong>" + name + "</strong><span>" +
            (email || "Not signed in") + "</span></div>" +
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

  /* Shown while Firebase is still restoring the session for a returning
     customer. Without it the page paints signedOut() first and corrects
     itself a second later, which reads as a bug. */
  function loadingState() {
    KT.mount("[data-account-nav]", KT.skeleton.accountNav());
    KT.mount("[data-account-main]",
      KT.loadingLabel("Loading your account…") + KT.skeleton.accountMain());
  }

  /* ---- Sections -------------------------------------------------------- */

  function walletCard() {
    var w = state.wallet || { balance: 0 };
    var balance = Number(w.balance || 0);
    var open = state.editing === "fund";
    var gateways = state.gateways;
    var live = !gateways || gateways.paystack || gateways.flutterwave;

    return (
      '<div class="loyalty" id="wallet">' +
        '<div class="loyalty__top">' +
          '<div><span class="loyalty__tier">' + KT.icon("wallet", 15) + "Kandy's wallet</span>" +
            '<p class="loyalty__points">' + KT.naira(balance) + "<em>available</em></p></div>" +
          '<button class="btn btn--onDark btn--sm" type="button" data-fund>' +
            (open ? "Close" : "Top up") + "</button>" +
        "</div>" +
        '<div class="loyalty__bar"><span style="width:' +
          Math.min(100, balance ? Math.max(6, Math.round((balance / 20000) * 100)) : 0) + '%"></span></div>' +
        '<p class="loyalty__note">Pay from your wallet and skip the 2% card processing fee ' +
          "on every order.</p>" +

        (open
          ? '<div class="walletfund">' +
              '<p class="walletfund__label">How much would you like to add?</p>' +
              '<div class="walletfund__amounts">' +
                TOP_UPS.map(function (a) {
                  return '<button class="chip" type="button" data-amount="' + a + '">' +
                    KT.naira(a) + "</button>";
                }).join("") +
              "</div>" +
              '<form class="promoform walletfund__custom" data-fund-form>' +
                '<label class="sr-only" for="fundAmount">Amount in Naira</label>' +
                '<input class="input" id="fundAmount" type="number" min="500" step="100" ' +
                  'placeholder="Other amount" inputmode="numeric">' +
                '<button class="btn btn--onDark" type="submit"' + (live ? "" : " disabled") +
                  ">Continue</button>" +
              "</form>" +
              '<div class="walletfund__providers" data-fund-providers hidden></div>' +
              (live
                ? '<p class="walletfund__note">You will finish on Paystack or Flutterwave\'s ' +
                  "own secure page. Your balance updates once we verify the payment.</p>"
                : '<p class="walletfund__note">Wallet top-up is unavailable — no payment ' +
                  "gateway is configured yet.</p>") +
            "</div>"
          : "") +
      "</div>"
    );
  }

  function transactionsPanel() {
    if (!state.transactions.length) return "";
    return (
      '<div class="panel">' +
        '<div class="panel__head"><div><h2>Wallet activity</h2>' +
          "<p>Top-ups, order payments and refunds.</p></div></div>" +
        '<div class="orderitems">' +
          state.transactions.map(function (tx) {
            var credit = tx.direction === "credit";
            return (
              '<div class="orderitem">' +
                '<span class="ring" style="display:grid;place-items:center;background:' +
                  (credit ? "var(--mint-50)" : "var(--kt-pink-50)") + ';color:' +
                  (credit ? "var(--mint)" : "var(--kt-pink)") + '">' +
                  KT.icon(credit ? "plus" : "cart", 18) + "</span>" +
                '<div class="orderitem__text"><strong>' + tx.title + "</strong>" +
                  "<span>" + (tx.createdAt ? when(tx.createdAt) : "") +
                  (tx.provider ? " · " + tx.provider : "") + "</span></div>" +
                '<span class="status status--' +
                  (tx.status === "success" ? "delivered" : tx.status === "pending" ? "on-the-way" : "cancelled") +
                  '">' + tx.status + "</span>" +
                '<span class="price">' + (credit ? "+" : "−") + KT.naira(tx.amount) + "</span>" +
              "</div>"
            );
          }).join("") +
        "</div>" +
      "</div>"
    );
  }

  function when(date) {
    return date.toLocaleString("en-NG", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
    });
  }

  function favouritesPanel() {
    var items = state.favourites.map(KT.menu.byId).filter(Boolean);
    if (!items.length) return "";
    return (
      '<div class="panel" id="favourites">' +
        '<div class="panel__head"><div><h2>Saved for later</h2>' +
          "<p>Tap the heart on any dish to keep it here.</p></div></div>" +
        '<div class="cardgrid">' + KT.components.foodCards(items.slice(0, 4)) + "</div>" +
      "</div>"
    );
  }

  function notificationsPanel() {
    if (!state.notifications.length) return "";
    var unread = state.notifications.filter(function (n) { return !n.read; }).length;
    return (
      '<div class="panel" id="notifications">' +
        '<div class="panel__head"><div><h2>Updates' +
          (unread ? ' <em class="tile__badge">' + unread + " new</em>" : "") + "</h2>" +
          "<p>Order confirmations, status changes and wallet activity.</p></div>" +
          (unread ? '<button class="btn btn--ghost btn--sm" type="button" data-read-all>' +
            "Mark all read</button>" : "") + "</div>" +
        '<div class="orderitems">' +
          state.notifications.map(function (n) {
            var body =
              '<span class="ring" style="display:grid;place-items:center;background:' +
                (n.read ? "var(--surface-3)" : "var(--kt-pink-50)") + ';color:' +
                (n.read ? "var(--ink-3)" : "var(--kt-pink)") + '">' +
                KT.icon(n.type === "wallet" ? "wallet" : "receipt", 18) + "</span>" +
              '<div class="orderitem__text"><strong>' + (n.title || "Update") + "</strong>" +
                "<span>" + (n.message || "") + "</span></div>" +
              (n.read ? "" : '<span class="tile__badge">New</span>');

            return n.relatedId
              ? '<a class="orderitem" href="' +
                KT.url("pages/order-detail.html?id=" + encodeURIComponent(n.relatedId)) +
                '" data-notification="' + n.id + '">' + body + "</a>"
              : '<div class="orderitem" data-notification="' + n.id + '">' + body + "</div>";
          }).join("") +
        "</div>" +
      "</div>"
    );
  }

  function supportPanel() {
    var open = state.editing === "support";
    return (
      '<div class="panel" id="support">' +
        '<div class="panel__head"><div><h2>Need a hand?</h2>' +
          "<p>Wrong order, late delivery, refund — tell us and we will sort it.</p></div>" +
          '<button class="btn btn--ghost btn--sm" type="button" data-support-toggle>' +
            (open ? "Cancel" : "Contact support") + "</button></div>" +

        (open
          ? '<form data-support-form>' +
              '<label class="field"><span class="field__label">What is it about?</span>' +
                '<select class="select" name="orderId">' +
                  '<option value="">Not about a specific order</option>' +
                  state.orders.map(function (o) {
                    return '<option value="' + o.id + '">' + o.id + " · " +
                      KT.naira(o.total) + "</option>";
                  }).join("") +
                "</select></label>" +
              '<label class="field" style="margin-top:16px">' +
                '<span class="field__label">Subject</span>' +
                '<input class="input" name="subject" placeholder="Missing item from my order"></label>' +
              '<label class="field" style="margin-top:16px">' +
                '<span class="field__label">What happened?</span>' +
                '<textarea class="textarea" name="message" rows="4" ' +
                  'placeholder="Tell us what went wrong and what would make it right."></textarea></label>' +
              '<button class="btn btn--primary" type="submit" style="margin-top:16px">Send to support</button>' +
            "</form>"
          : "") +

        (state.tickets.length
          ? '<div class="orderitems" style="margin-top:' + (open ? "18px" : "0") + '">' +
              state.tickets.map(function (ticket) {
                return '<div class="orderitem">' +
                  '<span class="ring" style="display:grid;place-items:center;' +
                    'background:var(--surface-3);color:var(--ink-3)">' +
                    KT.icon("mail", 18) + "</span>" +
                  '<div class="orderitem__text"><strong>' + ticket.subject + "</strong>" +
                    "<span>" + (ticket.createdAt ? when(ticket.createdAt) : "") +
                    (ticket.orderId ? " · " + ticket.orderId : "") + "</span></div>" +
                  '<span class="status status--' +
                    (ticket.status === "closed" ? "delivered" : "on-the-way") + '">' +
                    ticket.status + "</span></div>";
              }).join("") +
            "</div>"
          : "") +
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

  /** "Hello, Idris" once we know who it is — never a name we invented. */
  function greet() {
    var host = KT.qs("[data-account-greeting]");
    if (!host) return;
    var p = state.profile;
    var u = (KT.auth && KT.auth.user && KT.auth.user()) || null;
    var full = (p && p.displayName) || (u && u.displayName) || "";
    var first = String(full).trim().split(" ")[0];
    host.textContent = first ? "Hello, " + first : "Your account";
  }

  function render() {
    greet();
    if (KT.authResolving()) return loadingState();
    if (!KT.auth || !KT.auth.isSignedIn()) return signedOut();
    KT.mount("[data-account-nav]", sideNav("account"));
    KT.mount("[data-account-main]",
      walletCard() + notificationsPanel() + profilePanel() + addressPanel() +
      favouritesPanel() + ordersPanel() + transactionsPanel() + supportPanel());
    KT.images.bindAll(document);
    KT.components.paintCards(document);
  }

  /* ---- Data ------------------------------------------------------------ */

  async function load() {
    if (!KT.services || !KT.auth.isSignedIn()) return render();
    var s = KT.services;
    var results = await Promise.allSettled([
      s.account.profile(), s.wallet.get(), s.addresses.list(),
      s.orders.list({ limit: 5 }), s.wallet.transactions({ limit: 8 }),
      s.account.favourites(), s.payments.status(),
      s.account.notifications({ limit: 8 }), s.content.supportTickets({ limit: 5 })
    ]);
    state.profile = results[0].value || null;
    state.wallet = results[1].value || null;
    state.addresses = results[2].value || [];
    state.orders = results[3].value || [];
    state.transactions = results[4].value || [];
    state.favourites = results[5].value || [];
    state.gateways = results[6].value || null;
    state.notifications = results[7].value || [];
    state.tickets = results[8].value || [];
    render();

    s.wallet.watch(function (w) { state.wallet = w; render(); });
    await handleFundingReturn();
  }

  async function saveAddress(form) {
    var data = Object.fromEntries(new FormData(form).entries());
    data.isDefault = !!data.isDefault;
    /* KT.busy returns null when the button is already in flight, which is
       how a double-submit is refused. */
    var done = KT.busy(KT.qs("[type=submit]", form), "Saving…");
    if (!done) return;

    try {
      await KT.services.addresses.save(data);
      state.editing = null; state.editingAddress = null;
      state.addresses = await KT.services.addresses.list();
      render();
      KT.toast("Address saved.", "success");
    } catch (error) {
      KT.toast(KT.services ? KT.services.errorMessage(error) : error.message, "error", { duration: 5000 });
    } finally {
      done();
    }
  }

  /** Coming back from a wallet top-up: ?wallet=paystack&reference=… */
  async function handleFundingReturn() {
    var q = new URLSearchParams(window.location.search);
    var provider = q.get("wallet");
    if (!provider) return;

    var payload = {
      provider: provider,
      reference: q.get("reference") || q.get("trxref") || q.get("tx_ref") || "",
      transactionId: q.get("transaction_id") || ""
    };
    history.replaceState(null, "", window.location.pathname + "#wallet");

    if (!payload.reference && !payload.transactionId) return;
    try {
      await KT.services.wallet.verifyFunding(payload);
      state.wallet = await KT.services.wallet.get();
      state.transactions = await KT.services.wallet.transactions({ limit: 8 });
      render();
      KT.toast("Wallet topped up.", "success", { duration: 4500 });
    } catch (error) {
      KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
    }
  }

  /** Amount chosen — offer the gateways that are actually configured. */
  function offerGateways(amount) {
    var host = KT.qs("[data-fund-providers]");
    if (!host) return;
    var g = state.gateways || {};
    var available = KT.services.payments.PROVIDERS.filter(function (p) {
      return !state.gateways || g[p.id];
    });

    if (!available.length) {
      KT.toast("No payment gateway is configured yet.", "info");
      return;
    }
    host.hidden = false;
    host.innerHTML =
      '<p class="walletfund__label">Add ' + KT.naira(amount) + " with</p>" +
      available.map(function (p) {
        return '<button class="btn btn--onDark btn--block" type="button" ' +
          'data-fund-with="' + p.id + '" data-fund-amount="' + amount + '">' +
          p.name + "</button>";
      }).join("");
  }

  /* ---- Wiring ---------------------------------------------------------- */

  KT.pages.account = function () {
    render();
    document.addEventListener("kt:auth", load);
    document.addEventListener("kt:services", load);
    load();
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
      var note = t.closest("[data-notification]");
      if (note && !note.dataset.marked) {
        note.dataset.marked = "1";
        KT.services.account.markNotificationRead(note.getAttribute("data-notification"))
          .catch(function () {});
      }

      if (t.closest("[data-read-all]")) {
        await Promise.all(state.notifications.filter(function (n) { return !n.read; })
          .map(function (n) {
            return KT.services.account.markNotificationRead(n.id).catch(function () {});
          }));
        state.notifications = state.notifications.map(function (n) {
          return Object.assign({}, n, { read: true });
        });
        render();
      }

      if (t.closest("[data-support-toggle]")) {
        state.editing = state.editing === "support" ? null : "support";
        render();
        var panel = KT.qs("#support");
        if (panel && state.editing === "support") {
          panel.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }

      if (t.closest("[data-fund]")) {
        state.editing = state.editing === "fund" ? null : "fund";
        render();
      }

      var amount = t.closest("[data-amount]");
      if (amount) {
        KT.qsa("[data-amount]").forEach(function (x) {
          x.classList.toggle("is-active", x === amount);
        });
        offerGateways(Number(amount.getAttribute("data-amount")));
      }

      var fundWith = t.closest("[data-fund-with]");
      if (fundWith) {
        fundWith.disabled = true;
        fundWith.textContent = "Opening…";
        try {
          await KT.services.wallet.fund(
            Number(fundWith.getAttribute("data-fund-amount")),
            fundWith.getAttribute("data-fund-with")
          );
        } catch (error) {
          render();
          KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
        }
      }
    });

    document.addEventListener("submit", async function (e) {
      var fundForm = e.target.closest("[data-fund-form]");
      if (fundForm) {
        e.preventDefault();
        var value = Number(KT.qs("#fundAmount", fundForm).value);
        if (!(value >= 500)) {
          KT.toast("Enter at least " + KT.naira(500) + ".", "info");
          return;
        }
        offerGateways(Math.round(value));
        return;
      }

      var supportForm = e.target.closest("[data-support-form]");
      if (supportForm) {
        e.preventDefault();
        var data = Object.fromEntries(new FormData(supportForm).entries());
        if (!String(data.message || "").trim()) {
          KT.toast("Tell us what happened so we can help.", "info");
          return;
        }
        var btn = KT.qs("[type=submit]", supportForm);
        btn.disabled = true; btn.textContent = "Sending…";
        try {
          await KT.services.content.openSupportTicket(data);
          state.editing = null;
          state.tickets = await KT.services.content.supportTickets({ limit: 5 });
          render();
          KT.toast("Support has your message — we will be in touch.", "success", { duration: 5000 });
        } catch (error) {
          btn.disabled = false; btn.textContent = "Send to support";
          KT.toast(KT.services.errorMessage(error), "error", { duration: 5500 });
        }
        return;
      }

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
