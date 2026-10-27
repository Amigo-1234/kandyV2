/* ==========================================================================
   Kandy's Treats — Takeaway packs strip (menu + cart)
   --------------------------------------------------------------------------
   One control for "this order is for more than one person": the basket is
   split into numbered takeaway packs so the kitchen bags each person's food
   apart. It is NOT a bill split — the order, its total and its payment stay
   one. Each pack holding rice, spaghetti or beans is one plate of packaging
   (0086); KT.rules shows that figure and the server recomputes it at
   checkout from the menu, whatever the basket claims.

   The same strip appears on the menu (compact, once there is food in the
   basket) and in the cart (full), so the choice made in one place is the
   choice shown in the other. Off by default; "Don't split" puts everything
   back into one basket without removing any food.
   ========================================================================== */
(function (KT) {
  "use strict";

  function rates() { return KT.rules.TAKEAWAY_RATES(); }

  /* short = numbers only (the one-row menu strip); the accessible name is
     always the full "Takeaway N". */
  function tabsHTML(groups, active, atMax, short) {
    var tabs = "";
    for (var g = 1; g <= groups; g += 1) {
      tabs +=
        '<button class="takeaway__tab' + (g === active ? " is-active" : "") + '" ' +
          'type="button" data-takeaway-pick="' + g + '" ' +
          (short ? 'aria-label="Takeaway ' + g + '" ' : "") +
          'aria-pressed="' + (g === active ? "true" : "false") + '">' +
          (short ? g : "Takeaway " + g) +
        "</button>";
    }
    return '<div class="takeaway__tabs" role="group" aria-label="Choose the pack new items go into">' +
      tabs +
      (atMax ? "" :
        '<button class="takeaway__tab takeaway__tab--add" type="button" ' +
          'data-takeaway-add aria-label="Add another takeaway pack">' +
          KT.icon("plus", 15) + "</button>") +
    "</div>";
  }

  /**
   * @param {{compact?: boolean}} [opts] compact = the one-row menu version
   * @returns {string} "" only when the basket is empty and opts.compact
   */
  function strip(opts) {
    var compact = !!(opts && opts.compact);
    var count = KT.cart.count();
    var groups = KT.cart.groupCount();
    var atMax = groups >= KT.cart.maxGroups();

    if (!count) {
      /* Nothing to split yet. The menu stays uncluttered; the cart says why
         the option is not there instead of silently leaving it out. */
      return compact ? "" :
        '<p class="takeaway__later">Feeding more than one person? Once there is food in ' +
        "your basket you can split it into separate takeaway packs.</p>";
    }

    if (!groups) {
      if (compact) {
        return '<div class="takeaway takeaway--compact takeaway--off">' +
          "<span><strong>Ordering for more than one person?</strong></span>" +
          '<button class="btn btn--soft btn--sm" type="button" data-takeaway-add>' +
            KT.icon("plus", 15) + "<span>Split into packs</span></button>" +
        "</div>";
      }
      return (
        '<div class="takeaway takeaway--off">' +
          '<div class="takeaway__intro">' +
            '<span class="takeaway__icon">' + KT.icon("cart", 18) + "</span>" +
            "<div><strong>Splitting this between people?</strong>" +
            "<p>Group items into separate takeaway packs so the kitchen bags " +
            "them apart. Each pack of rice, spaghetti or beans is one plate of " +
            "packaging.</p></div>" +
          "</div>" +
          '<button class="btn btn--soft btn--sm" type="button" data-takeaway-add>' +
            KT.icon("plus", 15) + "<span>Split into packs</span></button>" +
        "</div>"
      );
    }

    var active = KT.cart.activeGroup();
    var off = '<button class="takeaway__off" type="button" data-takeaway-off>Don\'t split</button>';

    if (compact) {
      return '<div class="takeaway takeaway--compact">' +
        '<span class="takeaway__lead">Adding to takeaway</span>' +
        tabsHTML(groups, active, atMax, true) + off +
      "</div>";
    }

    return (
      '<div class="takeaway">' +
        '<div class="takeaway__head">' +
          "<strong>Takeaway packs · " + groups + " people</strong>" +
          '<span class="takeaway__note">Packaging is charged per plate: each pack ' +
            "of rice, spaghetti or beans is one plate (" + KT.naira(rates().combined) +
            " with White Rice, Ofada or rice and beans, otherwise " +
            KT.naira(rates().standard) + ").</span>" +
        "</div>" +
        tabsHTML(groups, active, atMax) +
        '<p class="takeaway__hint">New items go into <strong>Takeaway ' + active + "</strong>." +
          (atMax ? " " + groups + " packs is the most one order can hold." : "") + "</p>" +
        off +
      "</div>"
    );
  }

  /* Repaints every [data-takeaway-strip] host (the menu page has one). The
     cart page renders the full strip inside its own basket render. */
  function paint() {
    KT.qsa("[data-takeaway-strip]").forEach(function (host) {
      var html = strip({ compact: host.getAttribute("data-takeaway-strip") === "compact" });
      host.hidden = !html;
      if (host.innerHTML !== html) host.innerHTML = html;
    });
  }

  function init() {
    paint();
    KT.cart.subscribe(paint);
    document.addEventListener("kt:menu", paint);

    /* Basket changes only — never a price. */
    document.addEventListener("click", function (e) {
      var t = /** @type {HTMLElement} */ (e.target);
      if (!t.closest) return;
      if (t.closest("[data-takeaway-add]")) {
        var made = KT.cart.addGroup();
        if (made == null) KT.toast("That is as many packs as one order can have.", "info");
        else KT.toast("Takeaway " + made + " added — new items go there.", "success");
        return;
      }
      var pick = t.closest("[data-takeaway-pick]");
      if (pick) { KT.cart.setActiveGroup(pick.getAttribute("data-takeaway-pick")); return; }
      if (t.closest("[data-takeaway-off]")) {
        KT.cart.ungroup();
        KT.toast("Back to one basket — nothing was removed.", "info");
      }
    });
  }

  KT.components = KT.components || {};
  KT.components.takeawayStrip = strip;
  KT.takeaway = { init: init, paint: paint };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(window.KT || (window.KT = {}));
