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

    /**
     * The local image key behind a value, or null when there is no local file
     * to offer variants of — a remote Storage URL or an item with no photo.
     * @param {string|object|null} keyOrItem
     */
    keyOf: function (keyOrItem) {
      if (keyOrItem && typeof keyOrItem === "object") {
        if (keyOrItem.imageUrl) return null;   /* remote, no variants on disk */
        return images.keyOf(keyOrItem.image);
      }
      var key = EDITORIAL[keyOrItem] || keyOrItem;
      return key && localSet[key] ? key : null;
    },

    /**
     * The bundled photo to use when an item's remote imageUrl cannot load, or
     * null when there is none (no remote URL, or no local photo behind it).
     * @param {string|object|null} keyOrItem
     */
    fallback: function (keyOrItem) {
      if (!keyOrItem || typeof keyOrItem !== "object" || !keyOrItem.imageUrl) return null;
      var key = images.keyOf(keyOrItem.image);
      return key ? KT.base + LOCAL_BASE + key + ".jpg" : null;
    },

    /**
     * A WebP srcset for the widths that actually exist, or "" when there are
     * none. Pair it with <source type="image/webp"> so browsers without WebP
     * fall through to the original JPEG in <img src>.
     * @param {string|object|null} keyOrItem
     */
    srcset: function (keyOrItem) {
      var key = images.keyOf(keyOrItem);
      if (!key) return "";
      var widths = (KT.imageVariants || {})[key];
      if (!widths || !widths.length) return "";
      return widths.map(function (w) {
        return KT.base + LOCAL_BASE + key + "-" + w + ".webp " + w + "w";
      }).join(", ");
    },

    /**
     * Wrap an <img> tag in a <picture> that prefers WebP. Returns the <img>
     * untouched when no variants exist, so callers never branch.
     * @param {string} imgHTML  a complete <img ...> tag
     * @param {string|object|null} keyOrItem
     * @param {string} sizes    the CSS `sizes` attribute for this slot
     */
    picture: function (imgHTML, keyOrItem, sizes) {
      /* A remote photo that fails falls back to the dish's bundled photo
         first, and only then to the placeholder (see onError below). */
      var backup = images.fallback(keyOrItem);
      if (backup) imgHTML = imgHTML.replace("<img ", '<img data-fallback="' + backup + '" ');
      var set = images.srcset(keyOrItem);
      if (!set) return imgHTML;
      return '<picture><source type="image/webp" srcset="' + set + '"' +
        (sizes ? ' sizes="' + sizes + '"' : "") + ">" + imgHTML + "</picture>";
    },

    /** True when we are showing the branded stand-in rather than a photo. */
    isPlaceholder: function (keyOrItem) {
      return images.src(keyOrItem).indexOf(PLACEHOLDER) > -1;
    },

    /**
     * Kept for existing callers. Failures are now handled by one capturing
     * listener on the document (below), which also covers images that fail
     * before a caller gets round to binding them.
     */
    bind: function () {},
    bindAll: function () {}
  };

  /* A dead photo never shows as a broken image: first the dish's bundled
     photo (when a remote URL failed), then the branded placeholder. The
     <source> siblings go too, or a <picture> would keep choosing the WebP
     that just failed. The slot's size is fixed by CSS, so nothing moves. */
  function onError(e) {
    var img = e.target;
    if (!img || img.tagName !== "IMG" || !img.hasAttribute("data-food")) return;
    var pic = img.parentNode;
    if (pic && pic.tagName === "PICTURE") {
      Array.prototype.slice.call(pic.querySelectorAll("source")).forEach(function (s) { pic.removeChild(s); });
    }
    img.removeAttribute("srcset");
    var backup = img.getAttribute("data-fallback");
    if (backup && !img.dataset.triedFallback) {
      img.dataset.triedFallback = "1";
      img.src = backup;
      return;
    }
    if (img.dataset.fellBack) return;
    img.dataset.fellBack = "1";
    img.src = KT.base + PLACEHOLDER;
    img.classList.add("is-placeholder");
  }
  document.addEventListener("error", onError, true);

  KT.images = images;
})(window.KT || (window.KT = {}));
