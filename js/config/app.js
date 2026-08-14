/* ==========================================================================
   Kandy's Treats — Application configuration
   --------------------------------------------------------------------------
   Loaded as a CLASSIC script so both the (classic) UI components and the
   (module) service layer can read it from `window.KT.config`.

   These values MUST stay in step with functions/index.js. Where a number
   appears in both places the server is authoritative — the client only uses
   these to show the customer an accurate estimate before checkout. The server
   recalculates everything in `createCheckoutOrder`, so a stale value here is a
   display bug, never a pricing exploit.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.config = {
    /* ---- Firebase (public identifiers — safe in client code) ---------- */
    firebase: {
      apiKey: "AIzaSyCWDTVJgW5dqcBbnZRb6m_Yz-fB7flO9nU",
      authDomain: "kandystreat-840b1.firebaseapp.com",
      projectId: "kandystreat-840b1",
      storageBucket: "kandystreat-840b1.firebasestorage.app",
      messagingSenderId: "394965571986",
      appId: "1:394965571986:web:ce79a02096c2eb2f2b094b"
    },
    functionsRegion: "us-central1",

    /* Firebase JS SDK version — matches the one V1 runs in production. */
    sdkVersion: "10.12.5",

    /* ---- Firestore collections (mirrors functions/index.js) ----------- */
    collections: {
      users: "users",
      wallets: "wallets",
      transactions: "transactions",
      orders: "orders",
      orderItems: "orderItems",
      addresses: "addresses",
      favourites: "favourites",
      notifications: "notifications",
      reviews: "reviews",
      supportTickets: "supportTickets",
      contactMessages: "contactMessages",
      menus: "menus",
      quickPicks: "quickPicks",
      announcements: "announcements"
    },

    /* ---- Commerce ---------------------------------------------------- */
    currency: "NGN",
    currencySymbol: "₦",

    /* Kandy's operates within Lagos State only for this release.
       Addresses are typed manually — no GPS, no geocoding, no nationwide
       coverage. See docs/INTEGRATION.md. */
    serviceArea: {
      state: "Lagos",
      country: "Nigeria",
      label: "Lagos State only",
      note: "We deliver across Lagos State. Type your address in full so the rider can find you."
    },

    /* ---- Business details shown to customers -------------------------
       THE ONLY PLACE these live. Every value below is a placeholder until
       Kandy's supplies the real one. Anything left empty is HIDDEN in the UI
       rather than rendered as a dead link or a fake number — an empty string
       is the honest state, not a bug.                                     */
    business: {
      phone: "",           /* e.g. "+2348012345678" — also used for the tel: link */
      whatsapp: "",        /* digits only, international format, e.g. "2348012345678" */
      email: "",           /* e.g. "hello@kandystreats.com.ng" */
      address: "",         /* full street address */
      hours: "Mon–Sun, 8:00 AM – 10:00 PM"
    },

    /* Social profiles. Leave a URL empty and that icon is not rendered at
       all, so the footer never ships a link to "#". */
    socials: [
      { id: "instagram", name: "Instagram", url: "" },
      { id: "facebook",  name: "Facebook",  url: "" },
      { id: "tiktok",    name: "TikTok",    url: "" },
      { id: "whatsapp",  name: "WhatsApp",  url: "" },
      { id: "x",         name: "X",         url: "" }
    ],

    /* Legal pages. Same rule as socials: no URL, no link rendered. */
    legal: [
      { name: "Terms", url: "" },
      { name: "Privacy", url: "" },
      { name: "Refunds", url: "" }
    ],

    /* ---- Local storage keys (V1-compatible, scoped per account) ------- */
    storage: {
      cart: "kandys_cart",
      draftOrders: "kandys_draft_orders",
      lastOrder: "kandys_last_order_code",
      menuCache: "kandys_menu_cache_v1",
      guestScope: "guest"
    },

    /* ---- Limits (mirrors functions/index.js) -------------------------- */
    limits: {
      maxDrafts: 10,
      maxItems: 60,
      maxQty: 99,
      minAddressLength: 8
    }
  };
})(window.KT || (window.KT = {}));
