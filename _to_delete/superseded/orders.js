/* ==========================================================================
   Kandy's Treats — Mock order history & account profile (Phase 1, UI only)
   Replace wholesale once real orders exist. Nothing here talks to a server.
   ========================================================================== */
(function (KT) {
  "use strict";

  var PROFILE = {
    firstName: "Amaka",
    lastName: "Obi",
    name: "Amaka Obi",
    email: "amaka.obi@example.com",
    phone: "+234 801 234 5678",
    joined: "March 2024",
    tier: "Sweet Tooth",
    points: 1840,
    pointsToNext: 660,
    addresses: [
      {
        id: "a1",
        label: "Home",
        line: "14B Admiralty Way, Lekki Phase 1",
        city: "Lagos",
        note: "Gate code 4412 — call on arrival",
        default: true
      },
      {
        id: "a2",
        label: "Office",
        line: "3rd Floor, Alara House, 12A Akin Olugbade St, VI",
        city: "Lagos",
        note: "Reception will collect",
        default: false
      }
    ],
    cards: [
      { id: "c1", brand: "Visa", last4: "4242", expiry: "09/28", default: true },
      { id: "c2", brand: "Mastercard", last4: "8810", expiry: "02/27", default: false }
    ]
  };

  var ORDERS = [
    {
      id: "KT-24817",
      placed: "Today, 12:42 PM",
      status: "on-the-way",
      statusLabel: "On the way",
      eta: "Arriving 1:15 PM",
      rider: { name: "Chidi A.", vehicle: "Bike • LAG 442 KJA" },
      address: "14B Admiralty Way, Lekki Phase 1",
      lines: [
        { itemId: "party-jollof", qty: 2, extras: ["Medium", "Grilled chicken"] },
        { itemId: "chapman", qty: 2, extras: [] }
      ],
      timeline: [
        { key: "placed", label: "Order placed", time: "12:42 PM", done: true },
        { key: "confirmed", label: "Kitchen confirmed", time: "12:44 PM", done: true },
        { key: "cooking", label: "Cooking your food", time: "12:47 PM", done: true },
        { key: "on-the-way", label: "Rider picked up", time: "1:06 PM", done: true, current: true },
        { key: "delivered", label: "Delivered", time: "Est. 1:15 PM", done: false }
      ]
    },
    {
      id: "KT-24603",
      placed: "Sat, 9 Aug • 7:18 PM",
      status: "delivered",
      statusLabel: "Delivered",
      eta: "Delivered in 34 min",
      address: "14B Admiralty Way, Lekki Phase 1",
      lines: [
        { itemId: "small-chops", qty: 1, extras: ["Kandy hot", "Gift box + ribbon"] },
        { itemId: "zobo", qty: 3, extras: [] },
        { itemId: "cupcakes", qty: 1, extras: [] }
      ],
      rated: 5
    },
    {
      id: "KT-24455",
      placed: "Wed, 6 Aug • 1:02 PM",
      status: "delivered",
      statusLabel: "Delivered",
      eta: "Delivered in 28 min",
      address: "Alara House, Victoria Island",
      lines: [
        { itemId: "meat-pie", qty: 4, extras: [] },
        { itemId: "iced-latte", qty: 2, extras: [] }
      ],
      rated: 4
    },
    {
      id: "KT-24102",
      placed: "Sun, 27 Jul • 4:30 PM",
      status: "delivered",
      statusLabel: "Delivered",
      eta: "Delivered in 51 min",
      address: "14B Admiralty Way, Lekki Phase 1",
      lines: [
        { itemId: "owanbe-pack", qty: 1, extras: ["Medium"] }
      ],
      rated: 5
    },
    {
      id: "KT-23988",
      placed: "Thu, 17 Jul • 8:55 PM",
      status: "cancelled",
      statusLabel: "Cancelled",
      eta: "Refunded to card •••• 4242",
      address: "14B Admiralty Way, Lekki Phase 1",
      lines: [{ itemId: "suya-platter", qty: 1, extras: ["Kandy hot"] }]
    }
  ];

  KT.account = {
    profile: PROFILE,
    orders: ORDERS,

    order: function (id) {
      return ORDERS.filter(function (o) {
        return o.id === id;
      })[0];
    },

    orderTotal: function (order) {
      var sum = order.lines.reduce(function (n, l) {
        var item = KT.menu.byId(l.itemId);
        return n + (item ? item.price * l.qty : 0);
      }, 0);
      return sum + (sum >= 20000 ? 0 : 1500) + Math.round(sum * 0.025);
    },

    /** "2 items" / "6 items" summary string for an order row. */
    itemCount: function (order) {
      return order.lines.reduce(function (n, l) {
        return n + l.qty;
      }, 0);
    }
  };
})(window.KT || (window.KT = {}));
