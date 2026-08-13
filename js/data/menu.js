/* ==========================================================================
   Kandy's Treats — Mock menu data (Phase 1, UI only)
   --------------------------------------------------------------------------
   This is placeholder content shaped like the real thing so the UI can be
   built and reviewed. When the real menu arrives, replace CATEGORIES/ITEMS
   below — no component or stylesheet needs to change.

   Item shape
     id          unique slug, used in URLs (/pages/product.html?id=…)
     name        display name
     blurb       one line, ~60–90 chars, shown on cards
     description longer copy, product detail page only
     price       integer, Naira
     was         optional original price → renders a strike-through
     category    one of CATEGORIES[].id
     image       key into KT.images (js/data/images.js)
     rating      0–5
     reviews     integer
     prep        minutes, used for the "ready in" metadata
     tags        subset of: hot | new | veg | deal | bestseller
     serves      optional, shown on combos
     addons      optional groups for the product detail page
   ========================================================================== */
(function (KT) {
  "use strict";

  var CATEGORIES = [
    { id: "meals", name: "Meals", image: "party-jollof", blurb: "Rice, swallow & proteins" },
    { id: "snacks", name: "Snacks", image: "small-chops", blurb: "Small chops & finger food" },
    { id: "pastries", name: "Pastries", image: "meat-pie", blurb: "Baked fresh every morning" },
    { id: "drinks", name: "Drinks", image: "zobo", blurb: "Chilled & bottled to order" },
    { id: "combos", name: "Combos", image: "kandy-classic", blurb: "Full plates, one price" },
    { id: "desserts", name: "Desserts", image: "cupcakes", blurb: "The sweet part of Kandy's" }
  ];

  /* Re-usable add-on groups so items stay readable. */
  var EXTRAS = {
    protein: {
      id: "protein",
      title: "Add a protein",
      note: "Optional • pick as many as you like",
      type: "multi",
      options: [
        { id: "chicken", name: "Grilled chicken", price: 2500 },
        { id: "beef", name: "Peppered beef", price: 2000 },
        { id: "turkey", name: "Smoky turkey", price: 3500 },
        { id: "fish", name: "Grilled tilapia", price: 4000 }
      ]
    },
    sides: {
      id: "sides",
      title: "Sides",
      note: "Optional",
      type: "multi",
      options: [
        { id: "dodo", name: "Fried plantain (dodo)", price: 1200 },
        { id: "moimoi", name: "Moi moi wrap", price: 1500 },
        { id: "salad", name: "Coleslaw", price: 1000 }
      ]
    },
    pepper: {
      id: "pepper",
      title: "How much pepper?",
      note: "Required • pick one",
      type: "single",
      options: [
        { id: "mild", name: "Mild", price: 0 },
        { id: "medium", name: "Medium", price: 0, default: true },
        { id: "hot", name: "Kandy hot", price: 0 }
      ]
    },
    drink: {
      id: "drink",
      title: "Make it a meal",
      note: "Optional",
      type: "single",
      options: [
        { id: "none", name: "No drink", price: 0, default: true },
        { id: "zobo", name: "Chilled zobo", price: 1200 },
        { id: "chapman", name: "Chapman", price: 1800 },
        { id: "water", name: "Bottled water", price: 500 }
      ]
    },
    packs: {
      id: "packs",
      title: "Packaging",
      note: "Required • pick one",
      type: "single",
      options: [
        { id: "standard", name: "Standard pack", price: 0, default: true },
        { id: "gift", name: "Gift box + ribbon", price: 2500 }
      ]
    }
  };

  var ITEMS = [
    /* ---------------------------- MEALS ---------------------------- */
    {
      id: "party-jollof",
      name: "Kandy's Party Jollof",
      blurb: "Smoky party rice, fried plantain and a quarter chicken.",
      description:
        "The one people order twice. Long grain rice cooked down in our own pepper base over firewood heat for that party smoke, served with sweet fried plantain and a quarter of grilled chicken.",
      price: 6500,
      category: "meals",
      image: "party-jollof",
      rating: 4.9,
      reviews: 412,
      prep: 25,
      tags: ["bestseller", "hot"],
      addons: [EXTRAS.pepper, EXTRAS.protein, EXTRAS.sides, EXTRAS.drink]
    },
    {
      id: "coconut-fried-rice",
      name: "Coconut Fried Rice",
      blurb: "Coconut milk rice with prawns, sweetcorn and green beans.",
      description:
        "Rice steamed in fresh coconut milk with prawns, sweetcorn, carrots and green beans. Lighter than jollof, and the one to order when you want something a little different.",
      price: 7200,
      category: "meals",
      image: "coconut-fried-rice",
      rating: 4.7,
      reviews: 208,
      prep: 25,
      tags: [],
      addons: [EXTRAS.protein, EXTRAS.sides, EXTRAS.drink]
    },
    {
      id: "ofada-ayamase",
      name: "Ofada Rice & Ayamase",
      blurb: "Unpolished ofada rice under proper green pepper stew.",
      description:
        "Local unpolished ofada rice with designer stew — green bell pepper, locust bean and assorted meat, cooked slowly in bleached palm oil. Wrapped in leaf, the way it should be.",
      price: 8000,
      category: "meals",
      image: "ofada-ayamase",
      rating: 4.8,
      reviews: 176,
      prep: 30,
      tags: ["hot"],
      addons: [EXTRAS.pepper, EXTRAS.protein, EXTRAS.drink]
    },
    {
      id: "egusi-pounded-yam",
      name: "Egusi & Pounded Yam",
      blurb: "Melon seed soup, assorted meat, smooth pounded yam.",
      description:
        "Ground melon seed simmered with ugu, assorted meat and stockfish, served with soft pounded yam. Comfort food, portioned generously.",
      price: 7800,
      category: "meals",
      image: "egusi-pounded-yam",
      rating: 4.9,
      reviews: 331,
      prep: 30,
      tags: ["bestseller"],
      addons: [EXTRAS.protein, EXTRAS.drink]
    },
    {
      id: "efo-riro",
      name: "Efo Riro & Semo",
      blurb: "Rich spinach stew with ponmo, beef and smoked fish.",
      description:
        "Chopped spinach cooked down in pepper and palm oil with ponmo, beef and smoked fish. Served with a wrap of semolina.",
      price: 7000,
      category: "meals",
      image: "efo-riro",
      rating: 4.6,
      reviews: 154,
      prep: 28,
      tags: [],
      addons: [EXTRAS.protein, EXTRAS.drink]
    },
    {
      id: "pepper-soup",
      name: "Goat Meat Pepper Soup",
      blurb: "Clear, fiery broth with tender goat and scent leaf.",
      description:
        "Goat meat simmered in a clear broth of uziza, scent leaf and our house pepper soup spice. Order it hot, drink the broth first.",
      price: 6800,
      category: "meals",
      image: "pepper-soup",
      rating: 4.8,
      reviews: 189,
      prep: 22,
      tags: ["hot"],
      addons: [EXTRAS.pepper, EXTRAS.drink]
    },
    {
      id: "asun",
      name: "Asun (Peppered Goat)",
      blurb: "Smoked goat tossed in habanero, onion and bell pepper.",
      description:
        "Goat meat smoked over open fire, chopped and tossed hot in habanero, onions and bell pepper. Small plate energy, big plate flavour.",
      price: 9500,
      category: "meals",
      image: "asun",
      rating: 4.9,
      reviews: 264,
      prep: 20,
      tags: ["hot", "bestseller"],
      addons: [EXTRAS.pepper, EXTRAS.drink]
    },
    {
      id: "suya-platter",
      name: "Suya Platter",
      blurb: "Beef suya, yaji spice, raw onion and fresh tomato.",
      description:
        "Thin cut beef rolled in yaji and grilled over coals, served with sliced onion, tomato and extra spice on the side. Shareable.",
      price: 8500,
      category: "meals",
      image: "suya-platter",
      rating: 4.8,
      reviews: 297,
      prep: 20,
      tags: ["hot"],
      addons: [EXTRAS.pepper, EXTRAS.drink]
    },
    {
      id: "grilled-chicken-dodo",
      name: "Grilled Chicken & Dodo",
      blurb: "Half chicken, marinated overnight, with sweet plantain.",
      description:
        "Half a chicken marinated overnight in ginger, garlic and our pepper mix, then grilled to order. Served with sweet fried plantain and pepper sauce.",
      price: 8200,
      category: "meals",
      image: "grilled-chicken-dodo",
      rating: 4.7,
      reviews: 221,
      prep: 28,
      tags: [],
      addons: [EXTRAS.pepper, EXTRAS.sides, EXTRAS.drink]
    },
    {
      id: "seafood-okro",
      name: "Seafood Okro",
      blurb: "Draw soup with prawns, crab and smoked fish.",
      description:
        "Fresh okro cut by hand and cooked light with prawns, crab and smoked fish. Pick your swallow at checkout.",
      price: 9000,
      category: "meals",
      image: "seafood-okro",
      rating: 4.6,
      reviews: 118,
      prep: 30,
      tags: ["new"],
      addons: [EXTRAS.protein, EXTRAS.drink]
    },
    {
      id: "asaro",
      name: "Yam Porridge (Asaro)",
      blurb: "Soft yam mashed into pepper, palm oil and crayfish.",
      description:
        "Yam cooked down until it half-collapses into a stew of pepper, palm oil and crayfish, finished with ugu. Vegetarian as standard.",
      price: 5500,
      category: "meals",
      image: "asaro",
      rating: 4.5,
      reviews: 96,
      prep: 25,
      tags: ["veg"],
      addons: [EXTRAS.protein, EXTRAS.drink]
    },
    {
      id: "moi-moi",
      name: "Moi Moi & Pap",
      blurb: "Steamed bean pudding with fish, egg and smooth pap.",
      description:
        "Peeled beans blended with pepper and steamed in leaf with mackerel and boiled egg, served with warm pap. Breakfast, all day.",
      price: 4500,
      category: "meals",
      image: "moi-moi",
      rating: 4.6,
      reviews: 143,
      prep: 18,
      tags: [],
      addons: [EXTRAS.drink]
    },

    /* --------------------------- SNACKS ---------------------------- */
    {
      id: "small-chops",
      name: "Small Chops Platter",
      blurb: "Puff-puff, samosa, spring rolls, gizzard. Serves 2–3.",
      description:
        "The full tray: puff-puff, samosa, spring rolls and peppered gizzard with our dipping sauce. The thing you order when people are coming over.",
      price: 9500,
      was: 11000,
      category: "snacks",
      image: "small-chops",
      rating: 4.9,
      reviews: 508,
      prep: 20,
      tags: ["bestseller", "deal"],
      serves: "2–3 people",
      addons: [EXTRAS.pepper, EXTRAS.drink, EXTRAS.packs]
    },
    {
      id: "puff-puff",
      name: "Puff-Puff (10 pcs)",
      blurb: "Soft, golden, faintly sweet. Fried to order.",
      description:
        "Ten pieces of proper puff-puff — light inside, crisp at the edge, fried when you order so they arrive warm.",
      price: 2500,
      category: "snacks",
      image: "puff-puff",
      rating: 4.8,
      reviews: 372,
      prep: 15,
      tags: ["veg"],
      addons: [EXTRAS.packs]
    },
    {
      id: "spring-rolls",
      name: "Spring Rolls (6 pcs)",
      blurb: "Crisp pastry, seasoned vegetable and chicken filling.",
      description:
        "Six hand-rolled spring rolls with cabbage, carrot and shredded chicken, fried crisp and served with sweet chilli.",
      price: 3200,
      category: "snacks",
      image: "spring-rolls",
      rating: 4.7,
      reviews: 214,
      prep: 15,
      tags: [],
      addons: [EXTRAS.packs]
    },
    {
      id: "samosa",
      name: "Beef Samosa (6 pcs)",
      blurb: "Spiced minced beef in a thin, shattering shell.",
      description:
        "Six samosas filled with spiced minced beef and onion, folded thin so the pastry stays crisp all the way to your door.",
      price: 3200,
      category: "snacks",
      image: "samosa",
      rating: 4.7,
      reviews: 198,
      prep: 15,
      tags: [],
      addons: [EXTRAS.packs]
    },
    {
      id: "peppered-gizzard",
      name: "Peppered Gizzard",
      blurb: "Gizzard and bell pepper, fried down in pepper sauce.",
      description:
        "Gizzard boiled soft then fried and tossed in pepper sauce with onion and bell pepper. Sold by the tub.",
      price: 4800,
      category: "snacks",
      image: "peppered-gizzard",
      rating: 4.8,
      reviews: 241,
      prep: 20,
      tags: ["hot"],
      addons: [EXTRAS.pepper, EXTRAS.packs]
    },
    {
      id: "chin-chin",
      name: "Chin Chin (Large Tub)",
      blurb: "Crunchy, nutmeg-scented, dangerously easy to finish.",
      description:
        "Our large tub of chin chin, cut small and fried golden with a hint of nutmeg. Keeps for two weeks, never lasts two days.",
      price: 3500,
      category: "snacks",
      image: "chin-chin",
      rating: 4.9,
      reviews: 456,
      prep: 10,
      tags: ["bestseller", "veg"],
      addons: [EXTRAS.packs]
    },
    {
      id: "plantain-chips",
      name: "Plantain Chips",
      blurb: "Thin, salted, fried in small batches.",
      description:
        "Green plantain sliced thin and fried in small batches so every piece stays crisp. Lightly salted, nothing else.",
      price: 1800,
      category: "snacks",
      image: "plantain-chips",
      rating: 4.6,
      reviews: 187,
      prep: 10,
      tags: ["veg"],
      addons: []
    },
    {
      id: "scotch-egg",
      name: "Scotch Egg (2 pcs)",
      blurb: "Soft-boiled egg wrapped in seasoned sausage meat.",
      description:
        "Two scotch eggs — boiled egg wrapped in seasoned sausage meat, crumbed and fried. Cut one open, you'll see.",
      price: 2800,
      category: "snacks",
      image: "scotch-egg",
      rating: 4.5,
      reviews: 92,
      prep: 15,
      tags: [],
      addons: [EXTRAS.packs]
    },

    /* -------------------------- PASTRIES --------------------------- */
    {
      id: "meat-pie",
      name: "Kandy's Meat Pie",
      blurb: "The signature. Thick pastry, minced beef, potato, carrot.",
      description:
        "The pie Kandy's is known for. Short, buttery pastry with a proper filling of minced beef, potato and carrot — heavy in the hand, the way a meat pie should be.",
      price: 1800,
      category: "pastries",
      image: "meat-pie",
      rating: 5.0,
      reviews: 731,
      prep: 12,
      tags: ["bestseller"],
      addons: [EXTRAS.packs]
    },
    {
      id: "sausage-roll",
      name: "Sausage Roll (4 pcs)",
      blurb: "Flaky pastry wound around seasoned sausage.",
      description:
        "Four sausage rolls baked each morning — flaky pastry, well-seasoned sausage, nothing dry about them.",
      price: 2400,
      category: "pastries",
      image: "sausage-roll",
      rating: 4.7,
      reviews: 268,
      prep: 12,
      tags: [],
      addons: [EXTRAS.packs]
    },
    {
      id: "doughnuts",
      name: "Glazed Doughnuts (6 pcs)",
      blurb: "Pillow-soft, glazed while still warm.",
      description:
        "Six raised doughnuts, glazed while warm so the sugar sets into a thin shell. Ask for chocolate drizzle in your order note.",
      price: 4200,
      category: "pastries",
      image: "doughnuts",
      rating: 4.8,
      reviews: 315,
      prep: 15,
      tags: ["veg"],
      addons: [EXTRAS.packs]
    },
    {
      id: "croissant",
      name: "Butter Croissant (3 pcs)",
      blurb: "Laminated over two days. Worth the wait.",
      description:
        "Three all-butter croissants, laminated over two days for the layers. Best eaten within the hour — we bake to the delivery slot.",
      price: 4500,
      category: "pastries",
      image: "croissant",
      rating: 4.7,
      reviews: 141,
      prep: 15,
      tags: ["new", "veg"],
      addons: [EXTRAS.packs]
    },
    {
      id: "cinnamon-roll",
      name: "Cinnamon Rolls (4 pcs)",
      blurb: "Soft swirls, cream cheese frosting, still warm.",
      description:
        "Four cinnamon rolls with cream cheese frosting spread on while warm so it melts into the swirl.",
      price: 5200,
      category: "pastries",
      image: "cinnamon-roll",
      rating: 4.9,
      reviews: 224,
      prep: 18,
      tags: ["bestseller", "veg"],
      addons: [EXTRAS.packs]
    },
    {
      id: "banana-bread",
      name: "Banana Bread Loaf",
      blurb: "Dense, moist, made with over-ripe bananas only.",
      description:
        "A full loaf, made only with bananas that are past the point of being eaten plain. Dense, moist, keeps four days wrapped.",
      price: 5800,
      category: "pastries",
      image: "banana-bread",
      rating: 4.8,
      reviews: 167,
      prep: 15,
      tags: ["veg"],
      addons: [EXTRAS.packs]
    },

    /* --------------------------- DRINKS ---------------------------- */
    {
      id: "zobo",
      name: "Chilled Zobo",
      blurb: "Hibiscus steeped with ginger, clove and pineapple.",
      description:
        "Hibiscus steeped overnight with ginger, clove and pineapple, strained and chilled. Lightly sweetened — say the word and we'll leave the sugar out.",
      price: 1200,
      category: "drinks",
      image: "zobo",
      rating: 4.8,
      reviews: 389,
      prep: 5,
      tags: ["bestseller", "veg"],
      addons: []
    },
    {
      id: "chapman",
      name: "Kandy's Chapman",
      blurb: "The house pour. Citrus, bitters, cucumber ribbon.",
      description:
        "Our version of the classic — Fanta, Sprite, blackcurrant, a proper dash of bitters, cucumber and a wheel of orange.",
      price: 1800,
      category: "drinks",
      image: "chapman",
      rating: 4.9,
      reviews: 452,
      prep: 5,
      tags: ["bestseller"],
      addons: []
    },
    {
      id: "berry-smoothie",
      name: "Berry Blast Smoothie",
      blurb: "Strawberry, banana and yoghurt. Thick, not watery.",
      description:
        "Strawberry, banana and full-fat yoghurt blended thick. No added water, no syrup.",
      price: 3200,
      category: "drinks",
      image: "berry-smoothie",
      rating: 4.7,
      reviews: 203,
      prep: 8,
      tags: ["veg"],
      addons: []
    },
    {
      id: "tropical-juice",
      name: "Tropical Juice",
      blurb: "Pineapple, mango and orange, pressed this morning.",
      description:
        "Pineapple, mango and orange pressed the same morning and bottled cold. Nothing from concentrate.",
      price: 2200,
      category: "drinks",
      image: "tropical-juice",
      rating: 4.6,
      reviews: 128,
      prep: 5,
      tags: ["veg"],
      addons: []
    },
    {
      id: "kunu",
      name: "Tigernut Milk (Kunu Aya)",
      blurb: "Tigernut, date and coconut. Naturally sweet.",
      description:
        "Tigernuts soaked and blended with dates and coconut, then strained smooth. Dairy free and sweet without added sugar.",
      price: 2000,
      category: "drinks",
      image: "kunu",
      rating: 4.7,
      reviews: 154,
      prep: 5,
      tags: ["veg", "new"],
      addons: []
    },
    {
      id: "iced-latte",
      name: "Iced Vanilla Latte",
      blurb: "Double shot, vanilla, milk, plenty of ice.",
      description:
        "A double shot over ice with vanilla and cold milk. Say the word for oat milk instead.",
      price: 2800,
      category: "drinks",
      image: "iced-latte",
      rating: 4.5,
      reviews: 87,
      prep: 8,
      tags: [],
      addons: []
    },

    /* -------------------------- DESSERTS --------------------------- */
    {
      id: "red-velvet",
      name: "Red Velvet Slice",
      blurb: "Tall slice, cream cheese frosting, proper crumb.",
      description:
        "A generous slice of red velvet with cream cheese frosting between every layer. Order the whole cake through our events line.",
      price: 3500,
      category: "desserts",
      image: "red-velvet",
      rating: 4.9,
      reviews: 341,
      prep: 10,
      tags: ["bestseller"],
      addons: [EXTRAS.packs]
    },
    {
      id: "fudge-cake",
      name: "Chocolate Fudge Cake",
      blurb: "Dark, dense and deliberately over-frosted.",
      description:
        "Dark chocolate sponge with fudge frosting, and yes, we put more on than we should. Sold by the slice.",
      price: 3800,
      category: "desserts",
      image: "fudge-cake",
      rating: 4.8,
      reviews: 276,
      prep: 10,
      tags: [],
      addons: [EXTRAS.packs]
    },
    {
      id: "parfait",
      name: "Berry Parfait Cup",
      blurb: "Yoghurt, granola and berries, layered in a jar.",
      description:
        "Thick yoghurt layered with our own granola and fresh berries in a jar you can keep. Assembled to order so the granola stays crunchy.",
      price: 3000,
      category: "desserts",
      image: "parfait",
      rating: 4.7,
      reviews: 189,
      prep: 10,
      tags: ["veg", "new"],
      addons: []
    },
    {
      id: "cupcakes",
      name: "Vanilla Cupcakes (6 pcs)",
      blurb: "Six cupcakes, swirled high, sprinkles included.",
      description:
        "Six vanilla cupcakes with buttercream swirled high and sprinkles on top. Tell us the colour and we'll match it.",
      price: 6000,
      category: "desserts",
      image: "cupcakes",
      rating: 4.9,
      reviews: 298,
      prep: 15,
      tags: ["bestseller", "veg"],
      addons: [EXTRAS.packs]
    },
    {
      id: "cookies-cream",
      name: "Cookies & Cream Jar",
      blurb: "Layered cookie crumb, cream and chocolate.",
      description:
        "Crushed cookies layered with vanilla cream and chocolate in a chilled jar. Eat cold, straight from the fridge.",
      price: 3400,
      category: "desserts",
      image: "cookies-cream",
      rating: 4.8,
      reviews: 211,
      prep: 10,
      tags: ["veg"],
      addons: []
    },
    {
      id: "fruit-cup",
      name: "Fresh Fruit Cup",
      blurb: "Pineapple, watermelon, pawpaw and mango, cut today.",
      description:
        "Pineapple, watermelon, pawpaw and mango cut the same morning and packed cold. The one virtuous thing on this menu.",
      price: 2500,
      category: "desserts",
      image: "fruit-cup",
      rating: 4.6,
      reviews: 104,
      prep: 8,
      tags: ["veg"],
      addons: []
    },

    /* --------------------------- COMBOS ---------------------------- */
    {
      id: "kandy-classic",
      name: "The Kandy Classic",
      blurb: "Party jollof, grilled chicken, dodo and a chapman.",
      description:
        "Our most-ordered plate as one price: party jollof, a quarter grilled chicken, sweet fried plantain and a bottle of house chapman.",
      price: 9500,
      was: 11500,
      category: "combos",
      image: "kandy-classic",
      rating: 4.9,
      reviews: 623,
      prep: 30,
      tags: ["bestseller", "deal"],
      serves: "1 person",
      addons: [EXTRAS.pepper, EXTRAS.sides]
    },
    {
      id: "chops-and-chill",
      name: "Chops & Chill",
      blurb: "Small chops platter with two chilled drinks.",
      description:
        "The small chops platter with two drinks of your choice. Built for a Friday night in.",
      price: 12000,
      was: 13800,
      category: "combos",
      image: "chops-and-chill",
      rating: 4.8,
      reviews: 287,
      prep: 25,
      tags: ["deal"],
      serves: "2 people",
      addons: [EXTRAS.pepper, EXTRAS.packs]
    },
    {
      id: "owanbe-pack",
      name: "Owanbe Party Pack",
      blurb: "Jollof, fried rice, chicken, small chops and drinks.",
      description:
        "Party jollof and fried rice, six pieces of chicken, a full small chops tray and five drinks. Order by 6pm the day before.",
      price: 42000,
      was: 48000,
      category: "combos",
      image: "owanbe-pack",
      rating: 5.0,
      reviews: 156,
      prep: 60,
      tags: ["deal", "bestseller"],
      serves: "5 people",
      addons: [EXTRAS.pepper, EXTRAS.packs]
    },
    {
      id: "breakfast-treat",
      name: "Breakfast Treat Combo",
      blurb: "Meat pie, croissant, fruit cup and a coffee.",
      description:
        "One meat pie, one butter croissant, a fresh fruit cup and an iced vanilla latte. Delivered from 7am.",
      price: 8500,
      was: 9800,
      category: "combos",
      image: "breakfast-treat",
      rating: 4.7,
      reviews: 132,
      prep: 20,
      tags: ["deal", "new"],
      serves: "1 person",
      addons: [EXTRAS.packs]
    }
  ];

  /* ---- Query helpers ------------------------------------------------ */

  var menu = {
    categories: CATEGORIES,
    items: ITEMS,

    byId: function (id) {
      return ITEMS.filter(function (i) {
        return i.id === id;
      })[0];
    },

    byCategory: function (catId) {
      if (!catId || catId === "all") return ITEMS.slice();
      return ITEMS.filter(function (i) {
        return i.category === catId;
      });
    },

    category: function (id) {
      return CATEGORIES.filter(function (c) {
        return c.id === id;
      })[0];
    },

    tagged: function (tag) {
      return ITEMS.filter(function (i) {
        return (i.tags || []).indexOf(tag) > -1;
      });
    },

    trending: function (n) {
      return ITEMS.slice()
        .sort(function (a, b) {
          return b.reviews * b.rating - a.reviews * a.rating;
        })
        .slice(0, n || 6);
    },

    search: function (q) {
      var t = (q || "").trim().toLowerCase();
      if (!t) return ITEMS.slice();
      return ITEMS.filter(function (i) {
        return (
          i.name.toLowerCase().indexOf(t) > -1 ||
          i.blurb.toLowerCase().indexOf(t) > -1 ||
          i.category.indexOf(t) > -1 ||
          (i.tags || []).join(" ").indexOf(t) > -1
        );
      });
    },

    /** Cheapest → most expensive within an item's add-on defaults. */
    defaultAddons: function (item) {
      var picked = {};
      (item.addons || []).forEach(function (g) {
        g.options.forEach(function (o) {
          if (o.default) picked[g.id] = [o.id];
        });
      });
      return picked;
    }
  };

  KT.menu = menu;
})(window.KT || (window.KT = {}));
