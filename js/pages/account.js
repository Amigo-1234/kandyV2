/* ==========================================================================
   Kandy's Treats — Account page (UI ONLY)
   Profile, loyalty, addresses and payment methods, all from mock data.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.pages = KT.pages || {};

  var LINKS = [
    ["account", "Account overview", "user", "pages/account.html"],
    ["orders", "Order history", "receipt", "pages/orders.html"],
    ["addresses", "Saved addresses", "pin", "pages/account.html#addresses"],
    ["payment", "Payment methods", "wallet", "pages/account.html#payment"],
    ["settings", "Preferences", "settings", "pages/account.html#prefs"]
  ];

  function initials(name) {
    return name
      .split(" ")
      .map(function (n) {
        return n[0];
      })
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }

  function sideNav(active) {
    var p = KT.account.profile;
    return (
      '<div class="account__nav">' +
        '<div class="account__who">' +
          '<span class="avatar">' + initials(p.name) + "</span>" +
          "<div><strong>" + p.name + "</strong><span>Member since " + p.joined + "</span></div>" +
        "</div>" +
        '<nav class="account__links" aria-label="Account">' +
          LINKS.map(function (l) {
            return (
              '<a href="' + KT.url(l[3]) + '"' +
              (l[0] === active ? ' class="is-active" aria-current="page"' : "") + ">" +
              KT.icon(l[2], 19) + l[1] + "</a>"
            );
          }).join("") +
          '<a href="#" class="is-danger" data-signout>' + KT.icon("logout", 19) + "Sign out</a>" +
        "</nav>" +
      "</div>"
    );
  }

  KT.pages.account = function () {
    var p = KT.account.profile;
    KT.mount("[data-account-nav]", sideNav("account"));

    var pct = Math.round((p.points / (p.points + p.pointsToNext)) * 100);
    var recent = KT.account.orders.slice(0, 2);

    KT.mount(
      "[data-account-main]",
      /* Loyalty */
      '<div class="loyalty">' +
        '<div class="loyalty__top">' +
          "<div><span class=\"loyalty__tier\">" + KT.icon("sparkle", 15) + p.tier + "</span>" +
            '<p class="loyalty__points">' + p.points.toLocaleString() + "<em>points</em></p></div>" +
          '<a class="btn btn--onDark btn--sm" href="' + KT.url("pages/menu.html") + '">Spend points</a>' +
        "</div>" +
        '<div class="loyalty__bar"><span style="width:' + pct + '%"></span></div>' +
        '<p class="loyalty__note">' + p.pointsToNext.toLocaleString() +
          " points to the next tier. Points are placeholder data in this build.</p>" +
      "</div>" +

      /* Profile */
      '<div class="panel">' +
        '<div class="panel__head"><div><h2>Your details</h2>' +
          "<p>Used for delivery updates and receipts.</p></div>" +
          '<button class="btn btn--ghost btn--sm" type="button" data-soon>Edit</button></div>' +
        '<div class="authrow">' +
          '<label class="field"><span class="field__label">Full name</span>' +
            '<input class="input" value="' + p.name + '" readonly></label>' +
          '<label class="field"><span class="field__label">Phone</span>' +
            '<input class="input" value="' + p.phone + '" readonly></label>' +
        "</div>" +
        '<label class="field" style="margin-top:16px"><span class="field__label">Email</span>' +
          '<input class="input" value="' + p.email + '" readonly></label>' +
      "</div>" +

      /* Addresses */
      '<div class="panel" id="addresses">' +
        '<div class="panel__head"><div><h2>Saved addresses</h2>' +
          "<p>Riders use the note when they arrive.</p></div></div>" +
        '<div class="tilegrid">' +
          p.addresses
            .map(function (a) {
              return (
                '<div class="tile' + (a.default ? " is-default" : "") + '">' +
                  '<p class="tile__label">' + KT.icon("pin", 17) + a.label +
                    (a.default ? '<span class="tile__badge">Default</span>' : "") + "</p>" +
                  "<p>" + a.line + "<br>" + a.city + "</p>" +
                  "<small>" + a.note + "</small>" +
                  '<div class="tile__acts"><button type="button" data-soon>Edit</button>' +
                    (a.default ? "" : '<button type="button" data-soon>Make default</button>') +
                  "</div>" +
                "</div>"
              );
            })
            .join("") +
          '<button class="tile tile--add" type="button" data-soon>' +
            "<span>" + KT.icon("plus", 20) + "</span>Add a new address</button>" +
        "</div>" +
      "</div>" +

      /* Payment */
      '<div class="panel" id="payment">' +
        '<div class="panel__head"><div><h2>Payment methods</h2>' +
          "<p>Cards are display-only until payments are wired up.</p></div></div>" +
        '<div class="tilegrid">' +
          p.cards
            .map(function (c) {
              return (
                '<div class="tile' + (c.default ? " is-default" : "") + '">' +
                  '<p class="tile__label">' + KT.icon("wallet", 17) + c.brand +
                    (c.default ? '<span class="tile__badge">Default</span>' : "") + "</p>" +
                  "<p>•••• •••• •••• " + c.last4 + "</p>" +
                  "<small>Expires " + c.expiry + "</small>" +
                  '<div class="tile__acts"><button type="button" data-soon>Remove</button></div>' +
                "</div>"
              );
            })
            .join("") +
          '<button class="tile tile--add" type="button" data-soon>' +
            "<span>" + KT.icon("plus", 20) + "</span>Add a card</button>" +
        "</div>" +
      "</div>" +

      /* Recent orders */
      '<div class="panel">' +
        '<div class="panel__head"><div><h2>Recent orders</h2></div>' +
          '<a class="btn btn--ghost btn--sm" href="' + KT.url("pages/orders.html") + '">See all</a></div>' +
        '<div class="orderitems">' +
          recent
            .map(function (o) {
              return (
                '<a class="orderitem" href="' + KT.url("pages/order-detail.html?id=" + o.id) + '">' +
                  '<span class="ring"><img data-food alt="" src="' +
                    KT.images.src((KT.menu.byId(o.lines[0].itemId) || {}).image, "thumb") + '"></span>' +
                  '<div class="orderitem__text"><strong>' + o.id + "</strong>" +
                    "<span>" + o.placed + " · " + KT.plural(KT.account.itemCount(o), "item") + "</span></div>" +
                  '<span class="status status--' + o.status + '">' + o.statusLabel + "</span>" +
                  '<span class="price">' + KT.naira(KT.account.orderTotal(o)) + "</span>" +
                "</a>"
              );
            })
            .join("") +
        "</div>" +
      "</div>" +

      /* Preferences */
      '<div class="panel" id="prefs">' +
        '<div class="panel__head"><div><h2>Preferences</h2>' +
          "<p>Applied automatically to new orders.</p></div></div>" +
        '<div style="display:grid;gap:12px">' +
          '<label class="checkline"><input type="checkbox" checked>' +
            '<span class="checkline__box">' + KT.icon("check", 12) + "</span>" +
            "<span>Default pepper level: <strong>Medium</strong></span></label>" +
          '<label class="checkline"><input type="checkbox" checked>' +
            '<span class="checkline__box">' + KT.icon("check", 12) + "</span>" +
            "<span>Text me when the rider is 5 minutes away</span></label>" +
          '<label class="checkline"><input type="checkbox">' +
            '<span class="checkline__box">' + KT.icon("check", 12) + "</span>" +
            "<span>Email me new menu items and offers</span></label>" +
        "</div>" +
        '<div class="phasenote" style="margin-top:16px">' + KT.icon("lock", 16) +
          "<span>Nothing on this page is saved — Phase 1 is the visual layer only.</span></div>" +
      "</div>"
    );

    KT.images.bindAll(document);

    document.addEventListener("click", function (e) {
      if (e.target.closest("[data-soon]")) {
        e.preventDefault();
        KT.toast("Editing arrives with the accounts release.", "info");
      }
      if (e.target.closest("[data-signout]")) {
        e.preventDefault();
        KT.toast("Sign-out needs authentication, which lands in a later phase.", "info");
      }
    });
  };

  /* Order pages reuse the same side navigation. */
  KT.pages.accountNav = sideNav;
})(window.KT || (window.KT = {}));
