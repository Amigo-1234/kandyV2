/* ==========================================================================
   Kandy's Treats — Menu snapshot
   --------------------------------------------------------------------------
   THE REAL MENU, ported from V1 (js/seedMenu.js). Names, sections and prices
   are exactly as the kitchen sells them.

   This file is a SNAPSHOT, not the source of truth. At runtime the menu is
   loaded from Firestore `menus/{id}` by js/services/menu.js, which is also
   what the server re-prices against at checkout. The snapshot exists so the
   first paint is instant and the storefront still renders if Firestore is
   unreachable — in that state ordering is blocked, never guessed.

   Doc ids below match scripts/seed-menu.js, which writes the same slugs with
   setDoc(). Keep them in step: `createCheckoutOrder` looks up menus by id.

   Kandy's is a build-your-plate kitchen. Rice is sold per scoop; proteins and
   sides are separate items you add alongside. That is why the product page's
   "Add a protein" / "Sides" panels list real Proteins and Sides items at
   their real prices rather than fictional add-ons — each selection becomes
   its own cart line with its own menuId so the server can verify it.
   ========================================================================== */
(function (KT) {
  "use strict";

  var CATEGORIES = [
    { id: "foods", section: "Foods", name: "Foods", image: "jollof-rice", blurb: "Sold per scoop — build your plate" },
    { id: "proteins", section: "Proteins", name: "Proteins", image: "big-turkey", blurb: "Chicken, turkey, beef, fish" },
    { id: "specials", section: "Specials", name: "Specials", image: "chicken-chips", blurb: "The Kandy's signatures" },
    { id: "shawarma", section: "Shawarma", name: "Shawarma", image: "beef-shawarma", blurb: "Rolled to order" },
    { id: "soups", section: "Soups", name: "Soups", image: "catfish-soup", blurb: "Fresh catfish pepper soup" },
    { id: "sides", section: "Sides", name: "Sides", image: "plantain", blurb: "Plantain, salad, packaging" },
    { id: "drinks", section: "Drinks", name: "Drinks", image: "parfait", blurb: "Chilled and bottled" }
  ];

  /* price is in whole Naira. `image` keys into js/data/images.js. */
  var ITEMS = [
    /* ------------------------------ FOODS ------------------------------ */
    { id: "jollof-rice", name: "Jollof Rice (per scoop)", price: 500, category: "foods", image: "jollof-rice",
      blurb: "Party jollof cooked down in our own pepper base.",
      description: "Long grain rice cooked in our pepper base until it takes on the smoke. Sold per scoop — order two or three and add a protein alongside." },
    { id: "fried-rice", name: "Fried Rice (per scoop)", price: 500, category: "foods", image: "fried-rice",
      blurb: "Vegetable fried rice, sold per scoop.",
      description: "Fried rice with sweetcorn, carrots and green beans. Sold per scoop so you decide how much goes on the plate." },
    { id: "spaghetti", name: "Spaghetti (per scoop)", price: 500, category: "foods", image: "spaghetti",
      blurb: "Stir-fried spaghetti with peppers and veg.",
      description: "Spaghetti stir-fried with pepper, onion and mixed vegetables. Sold per scoop." },
    { id: "white-rice", name: "White Rice (per scoop)", price: 700, category: "foods", image: "white-rice",
      blurb: "Plain white rice — pair it with stew or beans.",
      description: "Steamed white rice, sold per scoop. Works with any of our stews, or alongside a scoop of beans." },
    { id: "ofada-rice", name: "Ofada Rice (per scoop)", price: 700, category: "foods", image: "ofada-rice",
      blurb: "Local unpolished ofada with designer stew.",
      description: "Local unpolished ofada rice served with proper green pepper designer stew. Comes in the bigger takeaway pack." },
    { id: "beans", name: "Beans (per scoop)", price: 600, category: "foods", image: "beans",
      blurb: "Soft beans in palm oil and pepper.",
      description: "Beans cooked down soft in palm oil and pepper. Good with plantain, bread or a scoop of white rice." },

    /* ---------------------------- PROTEINS ----------------------------- */
    { id: "big-chicken", name: "Big Chicken", price: 2500, category: "proteins", image: "chicken",
      blurb: "Full-size grilled chicken portion.",
      description: "A big cut of chicken, marinated and grilled to order." },
    { id: "small-chicken", name: "Small Chicken", price: 1200, category: "proteins", image: "small-turkey",
      blurb: "Smaller chicken portion.",
      description: "A smaller cut of chicken — the everyday portion to go with a scoop or two of rice." },
    { id: "beef", name: "Beef", price: 800, category: "proteins", image: "beef",
      blurb: "Peppered beef, cooked down soft.",
      description: "Beef cooked down soft in our pepper base." },
    { id: "small-beef", name: "Small Beef", price: 700, category: "proteins", image: "beef",
      blurb: "Smaller cut of peppered beef.",
      description: "A smaller cut of the same peppered beef." },
    { id: "big-fish", name: "Big Fish", price: 1000, category: "proteins", image: "catfish-soup",
      blurb: "Whole fish portion.",
      description: "A big fish portion to go with rice or beans." },
    { id: "peppered-gizzard", name: "Peppered Gizzard (stick)", price: 1500, category: "proteins", image: "gizzard",
      blurb: "Gizzard grilled on a stick in pepper sauce.",
      description: "Gizzard boiled soft, threaded on a stick and grilled in pepper sauce. Sold per stick." },
    { id: "small-turkey", name: "Small Turkey", price: 3000, category: "proteins", image: "peppered-turkey",
      blurb: "Peppered turkey, smaller cut.",
      description: "Turkey cooked down in pepper sauce — the smaller cut." },
    { id: "big-turkey", name: "Big Turkey", price: 3500, category: "proteins", image: "big-turkey",
      blurb: "The big peppered turkey cut.",
      description: "A generous cut of turkey, seasoned and cooked down in pepper sauce." },

    /* ------------------------------ SIDES ------------------------------ */
    { id: "plantain", name: "Plantain", price: 350, category: "sides", image: "plantain",
      blurb: "Sweet fried plantain, diced.",
      description: "Ripe plantain diced and fried sweet. The side almost every order adds." },
    { id: "takeaway-pack", name: "Takeaway Pack", price: 200, category: "sides", image: "kandys-box",
      blurb: "Extra Kandy's takeaway pack.",
      description: "An extra branded takeaway pack. Packaging for your food is added automatically at checkout — this is only for extras." },
    { id: "salad-single-cream", name: "Salad (Single Cream)", price: 700, category: "sides", image: "salad",
      blurb: "Coleslaw with a single layer of cream.",
      description: "Shredded cabbage and carrot in salad cream." },
    { id: "salad-double-cream", name: "Salad (Double Cream)", price: 800, category: "sides", image: "salad",
      blurb: "Coleslaw, extra creamy.",
      description: "The same coleslaw with a double helping of salad cream." },

    /* ---------------------------- SPECIALS ----------------------------- */
    { id: "chicken-and-chips", name: "Chicken & Chips", price: 4800, category: "specials", image: "chicken-chips",
      blurb: "Grilled chicken, chips and ketchup.",
      description: "A full plate of grilled chicken with a pile of chips and ketchup on the side. No extras needed." },
    { id: "meat-pie", name: "Meat Pie", price: 1000, category: "specials", image: "meat-pie",
      blurb: "Thick pastry, minced beef, potato and carrot.",
      description: "Short, buttery pastry with a proper filling of minced beef, potato and carrot. Baked fresh." },
    { id: "parfait-small", name: "Kandy's Parfait (Small)", price: 3500, category: "specials", image: "parfait",
      blurb: "The signature parfait, small cup.",
      description: "Our own parfait layered in a branded Kandy's cup. The small size." },
    { id: "parfait-big", name: "Kandy's Parfait (Big)", price: 5000, category: "specials", image: "parfait",
      blurb: "The signature parfait, big cup.",
      description: "The full-size Kandy's parfait — the one people order for the table." },

    /* ------------------------------ SOUPS ------------------------------ */
    { id: "catfish-pepper-soup-head", name: "Catfish Pepper Soup (Head)", price: 3500, category: "soups", image: "catfish-soup",
      blurb: "Clear pepper soup with the catfish head.",
      description: "Fresh catfish head simmered in a clear, fiery broth with scent leaf and our pepper soup spice." },
    { id: "catfish-pepper-soup-tail", name: "Catfish Pepper Soup (Middle/Tail)", price: 3000, category: "soups", image: "catfish-soup",
      blurb: "Clear pepper soup, middle or tail cut.",
      description: "The same broth with the middle or tail cut — more flesh, fewer bones." },

    /* ---------------------------- SHAWARMA ----------------------------- */
    { id: "beef-shawarma-1-sausage", name: "Beef Shawarma (1 Sausage)", price: 2800, category: "shawarma", image: "beef-shawarma",
      blurb: "Beef shawarma rolled with one sausage.",
      description: "Beef, vegetables and our sauces rolled into a warm wrap with one sausage." },
    { id: "beef-shawarma-2-sausage", name: "Beef Shawarma (2 Sausage)", price: 3100, category: "shawarma", image: "beef-shawarma",
      blurb: "Beef shawarma with two sausages.",
      description: "The beef shawarma with a second sausage rolled in." },
    { id: "chicken-shawarma-1-sausage", name: "Chicken Shawarma (1 Sausage)", price: 3000, category: "shawarma", image: "chicken-shawarma",
      blurb: "Chicken shawarma rolled with one sausage.",
      description: "Grilled chicken, vegetables and sauces in a warm wrap with one sausage." },
    { id: "chicken-shawarma-2-sausage", name: "Chicken Shawarma (2 Sausage)", price: 3300, category: "shawarma", image: "chicken-shawarma",
      blurb: "Chicken shawarma with two sausages.",
      description: "The chicken shawarma with a second sausage rolled in." },
    { id: "special-shawarma", name: "Special Shawarma", price: 3600, category: "shawarma", image: "chicken-shawarma",
      blurb: "Beef and chicken together, fully loaded.",
      description: "Beef and chicken together with both sausages and everything on. The one to order when you are hungry." },

    /* ------------------------------ DRINKS ----------------------------- */
    { id: "tiger-nut", name: "Tiger Nut", price: 1500, category: "drinks", image: null,
      blurb: "Tigernut milk, chilled.", description: "Tigernuts blended smooth and served cold. Dairy free." },
    { id: "hollandia-yogurt", name: "Hollandia Yogurt", price: 2200, category: "drinks", image: null,
      blurb: "Chilled Hollandia yogurt.", description: "Bottled Hollandia yogurt, served chilled." },
    { id: "chivita-active-exotic", name: "Chivita Active / Exotic", price: 1900, category: "drinks", image: null,
      blurb: "Chivita Active or Exotic.", description: "Bottled Chivita — tell us Active or Exotic in your order note." },
    { id: "can-chivita", name: "Can Chivita", price: 900, category: "drinks", image: null,
      blurb: "Chivita in a can.", description: "A single chilled can of Chivita." },
    { id: "soft-drink", name: "Fanta / Coke / Pepsi / Soda / Teem", price: 500, category: "drinks", image: null,
      blurb: "Your choice of soft drink.", description: "Any of the standard soft drinks. Say which one in your order note." },
    { id: "energy-drink", name: "Fearless / Predator", price: 800, category: "drinks", image: null,
      blurb: "Energy drink, chilled.", description: "Fearless or Predator — say which in your order note." },
    { id: "malt", name: "Malt", price: 750, category: "drinks", image: null,
      blurb: "Chilled malt drink.", description: "A bottle of malt, served cold." },
    { id: "nutri-milk", name: "Nutri Milk", price: 700, category: "drinks", image: null,
      blurb: "Nutri Milk, chilled.", description: "Bottled Nutri Milk." },
    { id: "nutri-choco", name: "Nutri Choco", price: 850, category: "drinks", image: null,
      blurb: "Chocolate Nutri Milk.", description: "The chocolate version of Nutri Milk." },
    { id: "pulpy", name: "Pulpy", price: 1500, category: "drinks", image: null,
      blurb: "Pulpy orange juice.", description: "Chilled Pulpy with the orange bits in." },
    { id: "fayrouz", name: "Fayrouz", price: 750, category: "drinks", image: null,
      blurb: "Chilled Fayrouz.", description: "A bottle of Fayrouz, served cold." },
    { id: "viju-milk", name: "Viju Milk", price: 750, category: "drinks", image: null,
      blurb: "Viju Milk, chilled.", description: "Bottled Viju Milk." },
    { id: "viju-choco", name: "Viju Choco", price: 1200, category: "drinks", image: null,
      blurb: "Chocolate Viju.", description: "The chocolate version of Viju." },
    { id: "heineken", name: "Heineken", price: 1500, category: "drinks", image: null, tags: ["alcohol"],
      blurb: "Chilled Heineken. 18+.", description: "A cold bottle of Heineken. You must be 18 or over to order alcohol." },
    { id: "smirnoff", name: "Smirnoff", price: 1800, category: "drinks", image: null, tags: ["alcohol"],
      blurb: "Chilled Smirnoff Ice. 18+.", description: "A cold bottle of Smirnoff. You must be 18 or over to order alcohol." },
    { id: "bullet", name: "Bullet", price: 2500, category: "drinks", image: null, tags: ["alcohol"],
      blurb: "Chilled Bullet. 18+.", description: "A cold bottle of Bullet. You must be 18 or over to order alcohol." }
  ];

  /* Normalise: every item gets the fields the UI expects. */
  ITEMS.forEach(function (item) {
    item.tags = item.tags || [];
    item.status = item.status || "available";
    item.section = (CATEGORIES.filter(function (c) { return c.id === item.category; })[0] || {}).section || "";
  });

  /* Which categories can be offered as an upsell on a product page.
     These are REAL menu items, not invented add-ons — picking one adds a
     separate cart line with its own menuId. */
  var UPSELL_GROUPS = [
    { id: "proteins", title: "Add a protein", note: "Optional • adds a separate item", category: "proteins", limit: 8 },
    { id: "sides", title: "Add a side", note: "Optional", category: "sides", limit: 4 },
    { id: "drinks", title: "Make it a meal", note: "Optional", category: "drinks", limit: 6 }
  ];

  /* Which categories get upsells offered. Shawarma and drinks stand alone. */
  var UPSELL_FOR = { foods: ["proteins", "sides", "drinks"], soups: ["sides", "drinks"], specials: ["drinks"], proteins: ["sides"] };

  var menu = {
    categories: CATEGORIES,
    items: ITEMS,
    /** true once js/services/menu.js has replaced this with live Firestore data */
    live: false,

    byId: function (id) {
      return menu.items.filter(function (i) { return i.id === id; })[0];
    },

    byCategory: function (catId) {
      if (!catId || catId === "all") return menu.items.slice();
      return menu.items.filter(function (i) { return i.category === catId; });
    },

    category: function (id) {
      return CATEGORIES.filter(function (c) { return c.id === id; })[0];
    },

    /** Map a Firestore `section` string onto a V2 category id. */
    categoryForSection: function (section) {
      var s = String(section || "").trim().toLowerCase();
      var hit = CATEGORIES.filter(function (c) { return c.section.toLowerCase() === s; })[0];
      return hit ? hit.id : "specials";
    },

    available: function (item) {
      return String(item && item.status || "available").toLowerCase() !== "sold-out";
    },

    tagged: function (tag) {
      return menu.items.filter(function (i) { return (i.tags || []).indexOf(tag) > -1; });
    },

    /** Admin-curated quick picks when live, cheapest-entry favourites offline. */
    featured: function (n) {
      var picks = menu.tagged("quick-pick");
      if (!picks.length) {
        picks = ["jollof-rice", "chicken-and-chips", "beef-shawarma-1-sausage", "meat-pie",
          "parfait-big", "peppered-gizzard", "big-turkey", "catfish-pepper-soup-head"]
          .map(menu.byId).filter(Boolean);
      }
      return picks.slice(0, n || 6);
    },

    search: function (q) {
      var t = String(q || "").trim().toLowerCase();
      if (!t) return menu.items.slice();
      return menu.items.filter(function (i) {
        return i.name.toLowerCase().indexOf(t) > -1
          || String(i.blurb || "").toLowerCase().indexOf(t) > -1
          || i.category.indexOf(t) > -1
          || String(i.section || "").toLowerCase().indexOf(t) > -1;
      });
    },

    /** Upsell groups to show on a product page, filled with real items. */
    upsellsFor: function (item) {
      var ids = UPSELL_FOR[item && item.category] || [];
      return UPSELL_GROUPS.filter(function (g) { return ids.indexOf(g.id) > -1; })
        .map(function (g) {
          return {
            id: g.id,
            title: g.title,
            note: g.note,
            options: menu.byCategory(g.category)
              .filter(menu.available)
              .filter(function (i) { return i.id !== item.id && i.id !== "takeaway-pack"; })
              .slice(0, g.limit)
          };
        })
        .filter(function (g) { return g.options.length; });
    },

    /** Replace the snapshot with live Firestore documents. */
    hydrate: function (items, quickPickIds) {
      if (!Array.isArray(items) || !items.length) return false;
      var picks = quickPickIds || [];
      items.forEach(function (i) {
        i.tags = i.tags || [];
        if (picks.indexOf(i.id) > -1 && i.tags.indexOf("quick-pick") === -1) i.tags.push("quick-pick");
      });
      menu.items = items;
      menu.live = true;
      return true;
    }
  };

  KT.menu = menu;
})(window.KT || (window.KT = {}));
