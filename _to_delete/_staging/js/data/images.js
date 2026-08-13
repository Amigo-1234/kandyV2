/* ==========================================================================
   Kandy's Treats — Image manifest
   --------------------------------------------------------------------------
   EVERY image in the UI resolves through here and nowhere else. No HTML file
   contains a photo URL.

   Resolution order for a menu item:
     1. `menu.imageUrl` from Firestore (admin-uploaded via Storage) — wins.
     2. A real Kandy's photo in assets/images/food/ (ported from V1).
     3. The branded placeholder, so a missing photo never shows as broken.

   ITEMS STILL NEEDING A REAL PHOTO are listed in NEEDS_PHOTO below — mostly
   drinks. Shoot them, drop the file in assets/images/food/<key>.jpg and add
   the key to LOCAL. Nothing else has to change.
   ========================================================================== */
(function (KT) {
  "use strict";

  var LOCAL_BASE = "assets/images/food/";
  var PLACEHOLDER = "assets/images/brand/food-placeholder.svg";

  /* Real Kandy's photography carried over from V1's images/menu/. */
  var LOCAL = [
    "jollof-rice", "jollof-rice-alt", "fried-rice", "white-rice", "rice-and-beans",
    "ofada-rice", "beans", "beans-bread", "spaghetti", "spaghetti-alt",
    "amala", "pounded-yam", "beef", "gizzard", "big-turkey", "small-turkey",
    "chicken", "peppered-turkey", "catfish-soup", "chicken-chips", "meat-pie",
    "parfait", "plantain", "salad", "beef-shawarma", "chicken-shawarma",
    "burger", "kandys-box"
  ];

  /* Editorial slots used by the homepage. */
  var EDITORIAL = {
    "hero-plate": "jollof-rice",
    "promo-spread": "chicken-chips",
    "kitchen-story": "kandys-box"
  };

  /** Menu items with no photograph yet — surfaced so the gap is visible. */
  var NEEDS_PHOTO = [
    "tiger-nut", "hollandia-yogurt", "chivita-active-exotic", "can-chivita",
    "soft-drink", "energy-drink", "malt", "nutri-milk", "nutri-choco", "pulpy",
    "fayrouz", "viju-milk", "viju-choco", "heineken", "smirnoff", "bullet",
    "big-fish"
  ];

  var localSet = {};
  LOCAL.forEach(function (k) { localSet[k] = true; });

  var images = {
    placeholder: PLACEHOLDER,
    needsPhoto: NEEDS_PHOTO,

    /**
     * Resolve an image key (or a menu item) to a usable src.
     * @param {string|object|null} keyOrItem
     */
    src: function (keyOrItem) {
      if (keyOrItem && typeof keyOrItem === "object") {
        /* A live Firestore menu doc may carry its own uploaded image URL. */
        if (keyOrItem.imageUrl) return keyOrItem.imageUrl;
        return images.src(keyOrItem.image);
      }
      var key = EDITORIAL[keyOrItem] || keyOrItem;
      if (key && localSet[key]) return KT.base + LOCAL_BASE + key + ".jpg";
      return KT.base + PLACEHOLDER;
    },

    /** True when we are showing the branded stand-in rather than a photo. */
    isPlaceholder: function (keyOrItem) {
      return images.src(keyOrItem).indexOf(PLACEHOLDER) > -1;
    },

    /** Attach a fallback so a dead URL never shows a broken-image icon. */
    bind: function (img) {
      img.addEventListener("error", function () {
        if (img.dataset.fellBack) return;
        img.dataset.fellBack = "1";
        img.removeAttribute("srcset");
        img.src = KT.base + PLACEHOLDER;
        img.classList.add("is-placeholder");
      }, { once: true });
    },

    bindAll: function (root) {
      (root || document).querySelectorAll("img[data-food]").forEach(images.bind);
    }
  };

  KT.images = images;
})(window.KT || (window.KT = {}));
