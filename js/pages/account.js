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
    editing: null, gateways: null,
    rewards: null, redeeming: false,
    staffFlag: null
  };

  var TOP_UPS = [2000, 5000, 10000, 20000];

  /* The referral code is generated server-side from a fixed alphabet, so it
     cannot carry markup today. Escaped anyway: it reaches innerHTML, and a
     renderer that is only safe because of what its source happens to produce
     is one change away from not being. */
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function initials(name) {
    return String(name || "K")
      .split(" ").map(function (n) { return n[0]; }).join("").slice(0, 2).toUpperCase();
  }

  function sideNav(active) {
    /* The orders and order-detail pages reuse this nav without running this
       module's load(), so state.profile is null there. Falling back to the
       session user keeps the header truthful without a second request. */
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

  /* Shown while Supabase is still restoring the session for a returning
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
        '<p class="loyalty__note">Pay from your wallet for one-tap checkout ' +
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

  /* ---- Staff flag notice ----------------------------------------------- */

  /*
     WHAT THIS CARD KNOWS IS EXACTLY TWO THINGS: that an unresolved flag
     exists against the signed-in account, and when the oldest one was
     raised. That is everything my_staff_flag_status() returns, and it is
     everything this renders.

     It does not know — and cannot ask — who raised the flag, what it says,
     how serious it is, what category it sits in, how many there are, or what
     management has written about it. staff_flags keeps its is_manager()-only
     SELECT policy, so the subject reads nothing from the table itself.

     There is no acknowledge, dismiss or resolve control here on purpose. The
     lifecycle belongs to management; the subject's move is to go and talk to
     them, which is what the two buttons are for. The card clears itself when
     the flag reaches 'resolved' or 'dismissed', because it reads the same
     status column the Flags screen writes.
  */
  function staffFlagCard() {
    var f = state.staffFlag;
    if (!f || !f.flagged) return "";

    var since = f.since
      ? new Date(f.since).toLocaleDateString("en-NG",
          { day: "2-digit", month: "long", year: "numeric", timeZone: "Africa/Lagos" })
      : "";

    return (
      '<div class="panel sflag" id="staff-flag" role="region" ' +
        'aria-labelledby="sflagTitle">' +
        '<div class="sflag__head">' +
          '<span class="sflag__icon" aria-hidden="true">' + KT.icon("flame", 20) + "</span>" +
          '<div><h2 id="sflagTitle">Staff flag raised</h2>' +
            '<p class="sflag__status">' +
              /* Status in words, not only in the card's colour. */
              '<span class="sflag__dot" aria-hidden="true"></span>' +
              "Requires management discussion" +
              (since ? ' <span class="sflag__since">· raised ' + esc(since) + "</span>" : "") +
            "</p></div>" +
        "</div>" +

        '<p class="sflag__body">A flag has been raised against your staff ' +
          "account. Please visit the office to discuss and resolve this with " +
          "management. You can also start a conversation with them here.</p>" +

        '<div class="sflag__actions">' +
          '<button class="btn btn--primary" type="button" data-open-chat ' +
            'aria-label="Chat with management about this flag">' +
            KT.icon("mail", 16) + "<span>Chat management</span></button>" +
        "</div>" +

        '<p class="sflag__note">The details of a flag are kept between you and ' +
          "management in person — they are not shown here, and this notice " +
          "clears itself once management resolves it.</p>" +
      "</div>"
    );
  }

  /* ---- Kandy Rewards --------------------------------------------------- */

  /*
     POINTS ARE NOT A BANK BALANCE, and this panel is built so it cannot be
     mistaken for one. The number is shown with a star and the word "points",
     never with a naira sign; the wallet card above is the only place money
     appears. The conversion is stated as a rate rather than as a balance, and
     the small print says in plain words that points are not cash until they
     are redeemed.

     Nothing here decides what a redemption is worth. The rate, the balance
     and the eligibility all come from my_rewards(), and the redeem button
     sends no amount — see js/services/rewards.js.
  */
  function rewardsPanel() {
    var r = state.rewards;
    if (!r) {
      return '<div class="panel rewards" id="rewards">' +
        '<div class="panel__head"><div><h2>Kandy Rewards</h2>' +
        "<p>Invite friends and earn points.</p></div></div>" +
        KT.skeleton.lines(3) + "</div>";
    }

    var code = r.code || "";
    var link = code && KT.referral ? KT.referral.linkFor(code) : "";
    var enough = r.available >= r.ratePoints;
    var short = Math.max(0, r.ratePoints - r.available);
    var pct = r.ratePoints > 0
      ? Math.min(100, Math.round((r.available / r.ratePoints) * 100)) : 0;

    return (
      '<div class="panel rewards" id="rewards">' +
        '<div class="panel__head"><div><h2>Kandy Rewards</h2>' +
          "<p>Invite friends and earn points on their first order.</p></div></div>" +

        '<div class="rewards__balance">' +
          '<span class="rewards__star" aria-hidden="true">' + KT.icon("star", 20) + "</span>" +
          '<p class="rewards__points"><strong>' + r.available + "</strong> " +
            "<span>point" + (r.available === 1 ? "" : "s") + " available</span></p>" +
        "</div>" +

        /* Progress toward the next redemption, labelled in words as well as
           by the bar — the bar alone would carry the meaning in colour. */
        '<div class="rewards__progress">' +
          '<div class="rewards__bar" role="progressbar" aria-valuemin="0" aria-valuemax="' +
            r.ratePoints + '" aria-valuenow="' + Math.min(r.available, r.ratePoints) +
            '" aria-label="Progress to your next reward">' +
            '<span style="width:' + pct + '%"></span></div>' +
          "<p class=\"rewards__next\">" +
            (enough
              ? "You have enough points to redeem " + KT.naira(r.rateNaira) +
                " of wallet credit."
              : "Earn <strong>" + short + "</strong> more point" + (short === 1 ? "" : "s") +
                " to unlock " + KT.naira(r.rateNaira) + " wallet credit.") +
          "</p>" +
        "</div>" +

        '<button class="btn btn--primary btn--block" type="button" data-redeem' +
          (enough && !state.redeeming ? "" : " disabled") + ">" +
          (state.redeeming
            ? KT.spinner(16) + "<span>Redeeming…</span>"
            : "Redeem " + r.ratePoints + " points for " + KT.naira(r.rateNaira) +
              " wallet credit") +
        "</button>" +

        '<p class="rewards__legal">Points are reward credits, not cash. They ' +
          "become wallet credit only when you redeem them at " + r.ratePoints +
          " points to " + KT.naira(r.rateNaira) + ", and they expire if unused." +
          (r.expiring > 0
            ? " <strong>" + r.expiring + " of your points expire within 14 days.</strong>"
            : "") +
        "</p>" +

        /* ---- sharing ---- */
        '<div class="rewards__share">' +
          '<p class="rewards__label" id="refCodeLabel">Your referral code</p>' +
          '<div class="rewards__codeRow">' +
            '<code class="rewards__code" aria-labelledby="refCodeLabel">' +
              esc(code || "…") + "</code>" +
            '<button class="btn btn--soft btn--sm" type="button" data-copy-code' +
              (code ? "" : " disabled") + ' aria-label="Copy your referral code">' +
              KT.icon("check", 14) + "<span>Copy code</span></button>" +
          "</div>" +
          '<div class="rewards__actions">' +
            '<button class="btn btn--soft btn--sm" type="button" data-copy-link' +
              (link ? "" : " disabled") + ' aria-label="Copy your referral link">' +
              "Copy link</button>" +
            '<button class="btn btn--soft btn--sm" type="button" data-share-ref' +
              (link ? "" : " disabled") + ' aria-label="Share your referral link">' +
              "Share</button>" +
            (link
              ? '<a class="btn btn--soft btn--sm" target="_blank" rel="noopener noreferrer" ' +
                'href="https://wa.me/?text=' + encodeURIComponent(
                  "Order from Kandy's Treats with my code " + code + " — " + link) +
                '" aria-label="Share your referral link on WhatsApp">WhatsApp</a>'
              : "") +
          "</div>" +
          '<p class="rewards__hint">Your friend gets points too, once their ' +
            "first order of " + KT.naira(r.minOrder) + " or more is completed.</p>" +
        "</div>" +

        /* ---- counts ---- */
        '<dl class="rewards__stats">' +
          '<div><dt>Successful referrals</dt><dd>' + r.referralsSuccess + "</dd></div>" +
          '<div><dt>Pending</dt><dd>' + r.referralsPending + "</dd></div>" +
          '<div><dt>Points earned</dt><dd>' + r.earned + "</dd></div>" +
          '<div><dt>Points redeemed</dt><dd>' + r.redeemed + "</dd></div>" +
        "</dl>" +
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
    var NOTE_ICON = { order: "receipt", chat: "mail", support: "mail",
      wallet: "wallet", message: "sparkle" };
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
                KT.icon(NOTE_ICON[n.type] || "sparkle", 18) + "</span>" +
              '<div class="orderitem__text"><strong>' + (n.title || "Update") + "</strong>" +
                "<span>" + (n.message || "") + "</span></div>" +
              (n.read ? "" : '<span class="tile__badge">New</span>');

            /* Where it points is decided by the notification's TYPE, in the
               service. A chat notification carries a conversation id, so the
               old "any relatedId means an order" rule produced dead links the
               moment anything other than orders started notifying. */
            var link = KT.services && KT.services.notifications
              ? KT.services.notifications.href(n) : null;

            return link
              ? '<a class="orderitem" href="' + link +
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
                  '<option value="">About</option>' +
                  state.orders.map(function (o) {
                    return '<option value="' + o.id + '">' + o.id + " · " +
                      KT.naira(o.total) + "</option>";
                  }).join("") +
                "</select></label>" +
              '<label class="field" style="margin-top:16px">' +
                '<span class="field__label">Subject</span>' +
                '<input class="input" name="subject" placeholder="What is this about?"></label>' +
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
        /* No Label field: addresses.clean() defaults it to "Delivery address",
           so the column and every consumer are unaffected — the customer just
           is not asked for something they never needed to provide. */
        '<label class="field"><span class="field__label">Who receives it?</span>' +
          '<input class="input" name="recipientName" placeholder="Full name" value="' + (a.recipientName || "") + '"></label>' +
        '<label class="field" style="margin-top:16px"><span class="field__label">Phone number</span>' +
          '<input class="input" name="phone" type="tel" placeholder="+234 801 234 5678" value="' +
            KT.rules.displayPhone(a.phone) + '"></label>' +
        '<label class="field" style="margin-top:16px"><span class="field__label">Full address</span>' +
          '<textarea class="textarea" name="address" rows="3" ' +
            'placeholder="Street, area and a landmark — e.g. EKSU Main Gate, Iworoko Road, Ado-Ekiti">' +
            (a.address || "") + "</textarea>" +
          '<span class="field__hint">We deliver to ' + KT.config.serviceArea.areas.join(", ") +
            ". Type it in full — there is no map lookup.</span></label>" +
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
                '<span class="ring">' + KT.images.picture(
                  '<img data-food alt="" loading="lazy" decoding="async" src="' +
                    KT.images.src(first || {}) + '">', first || {}, "64px") + '</span>' +
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
      staffFlagCard() + walletCard() + rewardsPanel() + notificationsPanel() + profilePanel() + addressPanel() +
      favouritesPanel() + ordersPanel() + transactionsPanel() + supportPanel());
    KT.images.bindAll(document);
    KT.components.paintCards(document);
  }

  /* ---- Data ------------------------------------------------------------ */

  async function load() {
    if (!KT.services || !KT.auth || !KT.auth.isSignedIn()) return render();
    var s = KT.services;
    var results = await Promise.allSettled([
      s.account.profile(), s.wallet.get(), s.addresses.list(),
      s.orders.list({ limit: 5 }), s.wallet.transactions({ limit: 8 }),
      s.account.favourites(), s.payments.status(),
      s.account.notifications({ limit: 8 }), s.content.supportTickets({ limit: 5 }),
      s.rewards.summary(), s.account.staffFlagStatus()
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
    state.rewards = results[9].value || null;
    state.staffFlag = results[10].value || null;
    render();

    /* The code is minted on first ask, so a customer who has never opened
       this page does not have one yet. Asked for after the first paint so
       the panel appears immediately rather than waiting on it. */
    if (state.rewards && !state.rewards.code) {
      try {
        var code = await s.rewards.ensureCode();
        if (code) { state.rewards.code = code; render(); }
      } catch (error) { /* the panel still works without a code */ }
    }

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

  /* kt:auth and kt:services both fire during boot, ~200ms apart, and each used
     to trigger a full load() — every query ran twice. The initial load belongs
     to kt:services (which now fires immediately after auth settles); kt:auth
     only re-loads once booted, i.e. for a genuine sign-in or sign-out.
     inFlight additionally coalesces overlapping loads. */
  var booted = false;
  var inFlight = null;
  var rerunRequested = false;

  function requestLoad() {
    if (inFlight) { rerunRequested = true; return inFlight; }
    inFlight = Promise.resolve(load()).catch(function (error) {
      console.warn("[Kandy's] load failed:", error);
    }).then(function () {
      inFlight = null;
      if (rerunRequested) { rerunRequested = false; requestLoad(); }
    });
    return inFlight;
  }

  /* ---- Wiring ---------------------------------------------------------- */

  /**
   * Consume the one-shot welcome left by a successful sign-in or sign-up.
   * Read-and-delete: a refresh of this page must not replay it.
   */
  function consumeWelcome() {
    var raw;
    try {
      raw = window.sessionStorage.getItem("kt.welcome");
      if (raw) window.sessionStorage.removeItem("kt.welcome");
    } catch (e) { return; }
    if (!raw) return;

    var payload;
    try { payload = JSON.parse(raw); } catch (e) { return; }
    if (!payload || !payload.kind) return;

    /* An abandoned OAuth attempt leaves the flag behind, so ignore a stale one
       rather than greeting someone who never completed sign-in. */
    if (payload.at && (Date.now() - payload.at) > 15 * 60 * 1000) return;

    var kind = payload.kind;
    var first = String(payload.name || "").split(" ")[0];

    /* Google gives no "is this new?" signal at click time, so decide here: a
       first-ever sign-in has created_at effectively equal to last_sign_in_at.
       30s of slack covers the OAuth round trip. */
    if (kind === "oauth") {
      var u = (KT.auth && KT.auth.user && KT.auth.user()) || null;
      var rawUser = u && u.raw;
      var createdAt = rawUser && rawUser.created_at ? Date.parse(rawUser.created_at) : 0;
      var lastSignIn = rawUser && rawUser.last_sign_in_at ? Date.parse(rawUser.last_sign_in_at) : 0;
      kind = (createdAt && lastSignIn && Math.abs(lastSignIn - createdAt) < 30000)
        ? "signup" : "login";
      if (!first && u) first = String(u.displayName || "").split(" ")[0];
    }

    if (kind === "signup") {
      KT.toast("Welcome to Kandy's Treats \uD83C\uDF89 Your account is ready.",
        "success", { duration: 5200 });
    } else {
      KT.toast(first ? "Welcome back, " + first + "." : "You are signed in.",
        "success", { duration: 3600 });
    }
  }

  KT.pages.account = function () {
    /* Deep links from a notification. #support has always worked as an
       anchor; ?section=support is what the support-reply notification sends,
       and it also OPENS the panel rather than just scrolling to it. */
    (function () {
      var section = KT.param("section");
      if (section === "support") {
        state.editing = "support";
        window.setTimeout(function () {
          var panel = KT.qs("#support");
          if (panel) panel.scrollIntoView({ block: "center", behavior: "smooth" });
        }, 400);
      }
    })();

    render();
    document.addEventListener("kt:auth", function () { if (booted) requestLoad(); });
    document.addEventListener("kt:services", function () { booted = true; requestLoad(); });
    if (KT.services) { booted = true; requestLoad(); }

    /* consumeWelcome() is read-and-delete, so calling it from several points is
       idempotent — the first one that finds the flag wins and the rest are
       no-ops. That deliberately removes any dependence on whether auth resolves
       before or after this module runs, and on when the toast host mounts. */
    function tryWelcome() {
      if (KT.auth && KT.auth.isSignedIn()) consumeWelcome();
    }
    document.addEventListener("kt:auth", tryWelcome);
    document.addEventListener("kt:services", tryWelcome);
    tryWelcome();

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
        var defDone = KT.busy(def, "Saving…");
        if (!defDone) return;
        try {
          await KT.services.addresses.makeDefault(def.getAttribute("data-default-address"));
          state.addresses = await KT.services.addresses.list();
          render();
        } catch (error) {
          defDone();
          KT.toast(KT.services.errorMessage(error), "error", { duration: 5000 });
        }
      }
      var rm = t.closest("[data-remove-address]");
      if (rm) {
        var rmDone = KT.busy(rm, "Removing…");
        if (!rmDone) return;
        try {
          await KT.services.addresses.remove(rm.getAttribute("data-remove-address"));
          state.addresses = await KT.services.addresses.list();
          render();
          KT.toast("Address removed.", "info");
        } catch (error) {
          rmDone();
          KT.toast(KT.services.errorMessage(error), "error", { duration: 5000 });
        }
      }
      var resend = t.closest("[data-resend]");
      if (resend) {
        var resendDone = KT.busy(resend, "Sending…");
        if (!resendDone) return;
        try {
          await KT.auth.resendVerification();
          KT.toast("Verification email sent.", "success");
        } catch (error) {
          KT.toast(KT.services.errorMessage(error), "error");
        } finally {
          resendDone();
        }
      }
      var note = t.closest("[data-notification]");
      if (note && !note.dataset.marked) {
        note.dataset.marked = "1";
        KT.services.account.markNotificationRead(note.getAttribute("data-notification"))
          .catch(function () {});
      }

      if (t.closest("[data-read-all]")) {
        /* One statement, scoped by RLS to this customer's own rows — not a
           fan-out of one request per notification. */
        await KT.services.account.markAllNotificationsRead().catch(function () {});
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

      /* ---- Kandy Rewards ------------------------------------------- */

      /* One clipboard helper with a real fallback: navigator.clipboard needs
         a secure context and a permission that can be refused, and a copy
         button that silently does nothing is worse than no button. */
      async function copy(text, said) {
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          KT.toast(said, "success");
          return;
        } catch (error) { /* fall through */ }
        try {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          KT.toast(said, "success");
        } catch (error) {
          KT.toast("Copy that code by hand — your browser blocked the clipboard.", "info");
        }
      }

      if (t.closest("[data-copy-code]")) {
        e.preventDefault();
        await copy(state.rewards && state.rewards.code, "Referral code copied.");
        return;
      }
      if (t.closest("[data-copy-link]")) {
        e.preventDefault();
        await copy(state.rewards && KT.referral.linkFor(state.rewards.code),
                   "Referral link copied.");
        return;
      }
      if (t.closest("[data-share-ref]")) {
        e.preventDefault();
        var link = state.rewards && KT.referral.linkFor(state.rewards.code);
        if (!link) return;
        var payload = {
          title: "Kandy's Treats",
          text: "Order from Kandy's Treats with my code " +
                (state.rewards.code || "") + " and we both earn rewards.",
          url: link
        };
        /* Web Share where it exists, clipboard where it does not. A cancelled
           share is a choice, not a failure, so it says nothing. */
        if (navigator.share) {
          try { await navigator.share(payload); }
          catch (error) { /* dismissed */ }
        } else {
          await copy(link, "Referral link copied — paste it to a friend.");
        }
        return;
      }

      if (t.closest("[data-redeem]")) {
        e.preventDefault();
        if (state.redeeming || !state.rewards) return;
        if (state.rewards.available < state.rewards.ratePoints) return;
        state.redeeming = true; render();
        try {
          /* No arguments. The server decides the cost, the payout and the
             recipient — this only asks. */
          var res = await KT.services.rewards.redeem();
          KT.toast("Redeemed — " + KT.naira(res.naira_credited) +
                   " added to your wallet.", "success");
          var fresh = await Promise.allSettled([
            KT.services.rewards.summary(), KT.services.wallet.get(),
            KT.services.wallet.transactions({ limit: 8 })
          ]);
          if (fresh[0].value) state.rewards = fresh[0].value;
          if (fresh[1].value) state.wallet = fresh[1].value;
          if (fresh[2].value) state.transactions = fresh[2].value;
        } catch (error) {
          KT.toast(KT.services.errorMessage(error), "error", { duration: 6000 });
        } finally {
          state.redeeming = false; render();
        }
        return;
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
        var fundDone = KT.busy(fundWith, "Redirecting to Paystack…");
        if (!fundDone) return;
        try {
          await KT.services.wallet.fund(
            Number(fundWith.getAttribute("data-fund-amount")),
            fundWith.getAttribute("data-fund-with")
          );
        } catch (error) {
          fundDone();
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
        var supportDone = KT.busy(KT.qs("[type=submit]", supportForm), "Sending…");
        if (!supportDone) return;
        try {
          await KT.services.content.openSupportTicket(data);
          state.editing = null;
          state.tickets = await KT.services.content.supportTickets({ limit: 5 });
          render();
          KT.toast("Support has your message — we will be in touch.", "success", { duration: 5000 });
        } catch (error) {
          KT.toast(KT.services.errorMessage(error), "error", { duration: 5500 });
        } finally {
          supportDone();
        }
        return;
      }

      var addrForm = e.target.closest("[data-address-form]");
      if (addrForm) { e.preventDefault(); return saveAddress(addrForm); }

      var profForm = e.target.closest("[data-profile-form]");
      if (profForm && state.editing === "profile") {
        e.preventDefault();
        var data = Object.fromEntries(new FormData(profForm).entries());
        var profDone = KT.busy(KT.qs("[type=submit]", profForm), "Saving…");
        if (!profDone) return;
        try {
          await KT.services.account.updateProfile(data);
          state.editing = null;
          state.profile = await KT.services.account.profile();
          render();
          KT.toast("Details updated.", "success");
        } catch (error) {
          KT.toast(KT.services.errorMessage(error), "error");
        } finally {
          profDone();
        }
      }
    });
  };

  KT.pages.accountNav = sideNav;
})(window.KT || (window.KT = {}));
