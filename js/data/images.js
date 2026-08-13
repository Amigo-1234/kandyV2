/* ==========================================================================
   Kandy's Treats — Image manifest
   --------------------------------------------------------------------------
   EVERY image used anywhere in the UI is registered here and nowhere else.
   No HTML file contains a hard-coded photo URL.

   Swapping in the real Kandy's Treats photography later:
     1. Drop your photos into  assets/images/food/  using the `file` name below.
     2. Set  KT.images.mode = 'local'  (see MODE constant).
     3. Done — every page, card, modal and hero picks them up automatically.

   Until then the manifest serves curated stock photography from a CDN, and
   any image that fails to load falls back to a branded local placeholder.
   ========================================================================== */
(function (KT) {
  "use strict";

  /* 'remote' = curated stock photography (prototype default)
     'local'  = your own files in assets/images/food/                       */
  var MODE = "remote";

  var REMOTE_BASE = "https://images.unsplash.com/";
  var LOCAL_BASE = "assets/images/food/";
  var PLACEHOLDER = "assets/images/brand/food-placeholder.svg";

  /* key: [ remote photo id, local filename ] */
  var MAP = {
    /* --- Meals ----------------------------------------------------- */
    "party-jollof": ["photo-1603496987674-79600a000f55", "party-jollof.jpg"],
    "coconut-fried-rice": ["photo-1512058564366-18510be2db19", "coconut-fried-rice.jpg"],
    "ofada-ayamase": ["photo-1604329756574-bda1f2cada6f", "ofada-ayamase.jpg"],
    "egusi-pounded-yam": ["photo-1763048443535-1243379234e2", "egusi-pounded-yam.jpg"],
    "efo-riro": ["photo-1604329760661-e71dc83f8f26", "efo-riro.jpg"],
    "pepper-soup": ["photo-1781332152758-8cb1d61f2192", "pepper-soup.jpg"],
    asun: ["photo-1765584830134-12d879ad13bd", "asun.jpg"],
    "suya-platter": ["photo-1767974968707-db3d448d4ef3", "suya-platter.jpg"],
    "grilled-chicken-dodo": ["photo-1763219802762-1d34ee0907c5", "grilled-chicken-dodo.jpg"],
    "seafood-okro": ["photo-1661588669110-81142a5b9e57", "seafood-okro.jpg"],
    asaro: ["photo-1554054204-b2f70b09d031", "asaro.jpg"],
    "moi-moi": ["photo-1665554837563-3782d21a676b", "moi-moi.jpg"],

    /* --- Snacks ---------------------------------------------------- */
    "small-chops": ["photo-1772457677598-2dc68bb6f4c8", "small-chops.jpg"],
    "puff-puff": ["photo-1602080926844-153f7ff5ce66", "puff-puff.jpg"],
    "spring-rolls": ["photo-1623253083987-26681ce4a992", "spring-rolls.jpg"],
    samosa: ["photo-1606525437679-037aca74a3e9", "samosa.jpg"],
    "peppered-gizzard": ["photo-1614398750956-402891a7dce1", "peppered-gizzard.jpg"],
    "chin-chin": ["photo-1577835371994-379cc06f1fe5", "chin-chin.jpg"],
    "plantain-chips": ["photo-1762884601729-0eeeafbdfb8a", "plantain-chips.jpg"],
    "scotch-egg": ["photo-1772457677641-394bbc0c20f6", "scotch-egg.jpg"],

    /* --- Pastries -------------------------------------------------- */
    "meat-pie": ["photo-1778449470133-5ce3092a6c09", "meat-pie.jpg"],
    "sausage-roll": ["photo-1756137948749-84e73141137b", "sausage-roll.jpg"],
    doughnuts: ["photo-1618411640018-972400a01458", "doughnuts.jpg"],
    croissant: ["photo-1649019937955-9687640aaaab", "croissant.jpg"],
    "cinnamon-roll": ["photo-1756137948759-a6454e107c6b", "cinnamon-roll.jpg"],
    "banana-bread": ["photo-1592311785385-09560835dab5", "banana-bread.jpg"],

    /* --- Drinks ---------------------------------------------------- */
    zobo: ["photo-1499638673689-79a0b5115d87", "zobo.jpg"],
    chapman: ["photo-1614481975705-673893461065", "chapman.jpg"],
    "berry-smoothie": ["photo-1570696516188-ade861b84a49", "berry-smoothie.jpg"],
    "tropical-juice": ["photo-1622597467821-df79dcb4f94d", "tropical-juice.jpg"],
    kunu: ["photo-1601390395693-364c0e22031a", "kunu.jpg"],
    "iced-latte": ["photo-1642442928346-6e43e9f6760e", "iced-latte.jpg"],

    /* --- Desserts -------------------------------------------------- */
    "red-velvet": ["photo-1517427294546-5aa121f68e8a", "red-velvet.jpg"],
    "fudge-cake": ["photo-1607257882338-70f7dd2ae344", "fudge-cake.jpg"],
    parfait: ["photo-1550594645-25c5bd703258", "parfait.jpg"],
    cupcakes: ["photo-1603532553059-3facb851d937", "cupcakes.jpg"],
    "cookies-cream": ["photo-1654584240523-6b8d3f6c33b4", "cookies-cream.jpg"],
    "fruit-cup": ["photo-1664993090321-b2caff794431", "fruit-cup.jpg"],

    /* --- Combos ---------------------------------------------------- */
    "kandy-classic": ["photo-1638436684761-7e59f8a9072f", "kandy-classic.jpg"],
    "chops-and-chill": ["photo-1575178018553-5b4e17b751be", "chops-and-chill.jpg"],
    "owanbe-pack": ["photo-1641565095186-21ea5bb5aef0", "owanbe-pack.jpg"],
    "breakfast-treat": ["photo-1762719265197-b14e8052538f", "breakfast-treat.jpg"],

    /* --- Editorial / marketing ------------------------------------- */
    "hero-plate": ["photo-1603496987674-79600a000f55", "hero-plate.jpg"],
    "promo-spread": ["photo-1641565095186-21ea5bb5aef0", "promo-spread.jpg"],
    "kitchen-story": ["photo-1638436684761-7e59f8a9072f", "kitchen-story.jpg"]
  };

  /* Presets keep image weight sane and crops consistent across the site. */
  var PRESETS = {
    thumb: "w=180&h=180&fit=crop&crop=entropy&q=70",
    card: "w=560&h=420&fit=crop&crop=entropy&q=75",
    wide: "w=900&h=520&fit=crop&crop=entropy&q=78",
    tall: "w=560&h=740&fit=crop&crop=entropy&q=78",
    square: "w=720&h=720&fit=crop&crop=entropy&q=80",
    hero: "w=1100&h=1100&fit=crop&crop=entropy&q=82",
    detail: "w=1000&h=760&fit=crop&crop=entropy&q=82"
  };

  var images = {
    mode: MODE,
    placeholder: PLACEHOLDER,

    /** Resolve an image key to a usable src. */
    src: function (key, preset) {
      var entry = MAP[key];
      if (!entry) return KT.base + PLACEHOLDER;
      if (images.mode === "local") return KT.base + LOCAL_BASE + entry[1];
      return REMOTE_BASE + entry[0] + "?" + (PRESETS[preset] || PRESETS.card) +
        "&auto=format";
    },

    /** srcset for crisp rendering on retina displays. */
    srcset: function (key, preset) {
      if (images.mode === "local") return "";
      var one = images.src(key, preset);
      return one + " 1x, " + one.replace(/w=(\d+)/, function (_, w) {
        return "w=" + Math.round(w * 1.8);
      }) + " 2x";
    },

    /** Attach a fallback so a dead URL never shows a broken-image icon. */
    bind: function (img) {
      img.addEventListener(
        "error",
        function () {
          if (img.dataset.fellBack) return;
          img.dataset.fellBack = "1";
          img.removeAttribute("srcset");
          img.src = KT.base + PLACEHOLDER;
          img.classList.add("is-placeholder");
        },
        { once: true }
      );
    },

    /** Bind fallbacks for every food image inside a container. */
    bindAll: function (root) {
      (root || document).querySelectorAll("img[data-food]").forEach(images.bind);
    },

    keys: function () {
      return Object.keys(MAP);
    }
  };

  KT.images = images;
})(window.KT || (window.KT = {}));
