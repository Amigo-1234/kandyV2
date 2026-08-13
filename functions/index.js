const crypto = require("crypto");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const {
  onDocumentCreated,
  onDocumentUpdated,
} = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const PAYSTACK_SECRET_KEY = defineSecret("PAYSTACK_SECRET_KEY");
const FLUTTERWAVE_SECRET_KEY = defineSecret("FLUTTERWAVE_SECRET_KEY");
const FLUTTERWAVE_SECRET_HASH = defineSecret("FLUTTERWAVE_SECRET_HASH");

const COLLECTIONS = {
  users: "users",
  wallets: "wallets",
  transactions: "transactions",
  orders: "orders",
  orderItems: "orderItems",
  notifications: "notifications",
  menus: "menus",
  addresses: "addresses",
};

const ORDER_STATUSES = ["New", "Preparing", "Out", "Completed"];
const PROVIDERS = new Set(["paystack", "flutterwave"]);
const CURRENCY = "NGN";
const DELIVERY_FEE = 500;
const PROCESSING_FEE_RATE = 0.02;
const MAX_DRAFTS = 10;
const MAX_ITEMS = 60;
const FUNCTION_REGION = "us-central1";
const ALLOWED_WEB_ORIGINS = [
  "http://127.0.0.1:5501",
  "http://localhost:5501",
  "https://kandystreat-840b1.web.app",
  "https://kandystreat-840b1.firebaseapp.com",
  "https://kandystreats.com.ng",
  "https://www.kandystreats.com.ng",
  /^https:\/\/(?:[a-z0-9-]+-)?kandys?-?treats?(?:-[a-z0-9-]+)?\.vercel\.app$/,
];

setGlobalOptions({ region: FUNCTION_REGION, maxInstances: 20 });

const CALLABLE_OPTIONS = {
  cors: ALLOWED_WEB_ORIGINS,
};

function callableOptions(extra = {}) {
  return {
    ...CALLABLE_OPTIONS,
    ...extra,
  };
}

const COUPONS = {
  WELCOME5: {
    code: "WELCOME5",
    label: "Welcome discount",
    type: "percent",
    value: 5,
    minSubtotal: 1000,
  },
  KANDY10: {
    code: "KANDY10",
    label: "Kandys customer reward",
    type: "percent",
    value: 10,
    minSubtotal: 5000,
  },
};

function assertSignedIn(request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Please sign in to continue.");
  }
  return uid;
}

async function assertAdmin(request) {
  const uid = assertSignedIn(request);
  const userSnap = await db.collection(COLLECTIONS.users).doc(uid).get();
  const role = userSnap.exists ? userSnap.data().role : "";

  if (!["admin", "super-admin", "owner"].includes(role)) {
    throw new HttpsError("permission-denied", "Admin access is required.");
  }

  return uid;
}

function readSecret(secretParam, envName) {
  try {
    const value = secretParam.value();
    if (value) return value;
  } catch (error) {
    // Local emulators can use process.env instead of deployed secrets.
  }
  return process.env[envName] || "";
}

function cleanString(value, max = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanProvider(value) {
  const provider = cleanString(value, 30).toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw new HttpsError("invalid-argument", "Unsupported payment provider.");
  }
  return provider;
}

function cleanAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpsError("invalid-argument", "Enter a valid amount.");
  }
  return Math.round(amount);
}

function cleanQty(value) {
  const qty = Math.trunc(Number(value));
  if (!Number.isFinite(qty) || qty < 1 || qty > 99) {
    throw new HttpsError("invalid-argument", "Invalid item quantity.");
  }
  return qty;
}

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("0")) return `234${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith("7")) return `234${digits}`;
  return digits;
}

function cleanAddressPayload(value) {
  const raw = value || {};
  const address = cleanString(raw.address, 500);
  if (address.length < 8) {
    throw new HttpsError("invalid-argument", "Enter a complete delivery address.");
  }

  return {
    label: cleanString(raw.label || "Delivery address", 60) || "Delivery address",
    recipientName: cleanString(raw.recipientName, 100),
    phone: normalizePhone(raw.phone),
    address,
    notes: cleanString(raw.notes, 300),
    isDefault: Boolean(raw.isDefault),
  };
}

function formatNgn(amount) {
  return `NGN ${Number(amount || 0).toLocaleString("en-NG")}`;
}

function calculateProcessingFee(amount) {
  return Math.round(Number(amount || 0) * PROCESSING_FEE_RATE);
}

function calculateCouponDiscount(coupon, subtotal) {
  if (!coupon || subtotal < (coupon.minSubtotal || 0)) return 0;
  if (coupon.type === "percent") return Math.round((subtotal * coupon.value) / 100);
  if (coupon.type === "fixed") return Math.min(subtotal, Number(coupon.value || 0));
  return 0;
}

function calculateTakeawayFee(items) {
  let hasFood = false;
  let hasRice = false;
  let hasBeans = false;
  let hasOfada = false;

  items.forEach((item) => {
    const name = String(item.name || "").toLowerCase();
    if (/(coke|fanta|pepsi|soda|juice|chivita|hollandia|yogurt|water)/.test(name)) {
      return;
    }
    if (/(rice|beans|ofada|amala|swallow|semo|eba|spaghetti|pepper soup|pounded yam|ewa agoyin)/.test(name)) {
      hasFood = true;
    }
    if (name.includes("rice")) hasRice = true;
    if (name.includes("beans")) hasBeans = true;
    if (name.includes("ofada")) hasOfada = true;
  });

  if (!hasFood) return 0;
  if (hasOfada || (hasRice && hasBeans)) return 300;
  return 200;
}

function transactionIdFor(provider, reference) {
  const safeReference = cleanString(reference, 140)
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${provider}_${safeReference || Date.now()}`;
}

function isAllowedCallbackUrl(value, fallbackPath) {
  const fallback = `https://kandystreat-840b1.web.app/${fallbackPath}`;
  const raw = cleanString(value, 500) || fallback;
  let url;

  try {
    url = new URL(raw);
  } catch (error) {
    return fallback;
  }

  const host = url.hostname.toLowerCase();
  const allowedHosts = new Set([
    "localhost",
    "127.0.0.1",
    "kandystreats.com.ng",
    "www.kandystreats.com.ng",
    "kandystreat-840b1.web.app",
    "kandystreat-840b1.firebaseapp.com",
  ]);

  if ((url.protocol === "http:" || url.protocol === "https:")
    && (allowedHosts.has(host) || host.endsWith(".web.app") || host.endsWith(".firebaseapp.com"))) {
    return url.href;
  }

  return fallback;
}

async function ensureWallet(uid, transaction) {
  const walletRef = db.collection(COLLECTIONS.wallets).doc(uid);
  const walletSnap = transaction
    ? await transaction.get(walletRef)
    : await walletRef.get();

  if (walletSnap.exists) return { ref: walletRef, data: walletSnap.data() };

  const wallet = {
    userId: uid,
    currency: CURRENCY,
    balance: 0,
    availableBalance: 0,
    lockedBalance: 0,
    status: "active",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (transaction) {
    transaction.set(walletRef, wallet);
  } else {
    await walletRef.set(wallet);
  }

  return { ref: walletRef, data: wallet };
}

async function createNotification(userId, payload) {
  if (!userId) return;
  await db.collection(COLLECTIONS.notifications).add({
    userId,
    read: false,
    createdAt: FieldValue.serverTimestamp(),
    ...payload,
  });
}

async function notifyAdmins(title, body) {
  const tokensSnap = await db.collection("adminTokens").get();
  const tokens = tokensSnap.docs
    .map((doc) => doc.data().token)
    .filter(Boolean);

  if (!tokens.length) return;

  await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
  });
}

exports.ensureCustomerAccount = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = assertSignedIn(request);
  const profile = request.data?.profile || {};
  const token = request.auth?.token || {};
  const userRef = db.collection(COLLECTIONS.users).doc(uid);
  const walletRef = db.collection(COLLECTIONS.wallets).doc(uid);

  await db.runTransaction(async (transaction) => {
    const [userSnap, walletSnap] = await Promise.all([
      transaction.get(userRef),
      transaction.get(walletRef),
    ]);
    const existing = userSnap.exists ? userSnap.data() : {};

    transaction.set(userRef, {
      uid,
      role: existing.role || "customer",
      email: cleanString(token.email || profile.email || existing.email || "", 160),
      displayName: cleanString(profile.displayName || token.name || existing.displayName || "", 100),
      phone: normalizePhone(profile.phone || existing.phone || ""),
      photoURL: cleanString(profile.photoURL || token.picture || existing.photoURL || "", 500),
      emailVerified: Boolean(token.email_verified),
      createdAt: existing.createdAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    if (!walletSnap.exists) {
      transaction.set(walletRef, {
        userId: uid,
        currency: CURRENCY,
        balance: 0,
        availableBalance: 0,
        lockedBalance: 0,
        status: "active",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });

  return { status: "ready" };
});

exports.saveCustomerAddress = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = assertSignedIn(request);
  const payload = cleanAddressPayload(request.data?.address || request.data);
  const addressId = cleanString(request.data?.addressId || request.data?.id, 160);
  const now = FieldValue.serverTimestamp();
  const addressesRef = db.collection(COLLECTIONS.addresses);
  const addressRef = addressId ? addressesRef.doc(addressId) : addressesRef.doc();
  let existing = null;

  if (addressId) {
    const addressSnap = await addressRef.get();
    if (!addressSnap.exists) {
      throw new HttpsError("not-found", "Saved address not found.");
    }
    existing = addressSnap.data();
    if (existing.userId !== uid) {
      throw new HttpsError("permission-denied", "You can only update your own addresses.");
    }
  }

  const firstAddressSnap = addressId
    ? null
    : await addressesRef.where("userId", "==", uid).limit(1).get();
  const shouldBeDefault = payload.isDefault || (firstAddressSnap && firstAddressSnap.empty);
  const batch = db.batch();

  if (shouldBeDefault) {
    const existingAddresses = await addressesRef.where("userId", "==", uid).get();
    existingAddresses.forEach((docSnap) => {
      if (docSnap.id !== addressRef.id) {
        batch.update(docSnap.ref, {
          isDefault: false,
          updatedAt: now,
        });
      }
    });
  }

  batch.set(addressRef, {
    userId: uid,
    label: payload.label,
    recipientName: payload.recipientName,
    phone: payload.phone,
    address: payload.address,
    notes: payload.notes,
    isDefault: shouldBeDefault || Boolean(existing?.isDefault),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }, { merge: true });

  await batch.commit();
  return { status: "saved", addressId: addressRef.id };
});

exports.deleteCustomerAddress = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = assertSignedIn(request);
  const addressId = cleanString(request.data?.addressId || request.data?.id, 160);
  if (!addressId) throw new HttpsError("invalid-argument", "Address ID is required.");

  const addressesRef = db.collection(COLLECTIONS.addresses);
  const addressRef = addressesRef.doc(addressId);
  const addressSnap = await addressRef.get();
  if (!addressSnap.exists) throw new HttpsError("not-found", "Saved address not found.");

  const address = addressSnap.data();
  if (address.userId !== uid) {
    throw new HttpsError("permission-denied", "You can only delete your own addresses.");
  }

  const batch = db.batch();
  batch.delete(addressRef);

  if (address.isDefault) {
    const fallbackSnap = await addressesRef.where("userId", "==", uid).limit(2).get();
    const fallback = fallbackSnap.docs.find((docSnap) => docSnap.id !== addressId);
    if (fallback) {
      batch.update(fallback.ref, {
        isDefault: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  }

  await batch.commit();
  return { status: "deleted" };
});

exports.setDefaultCustomerAddress = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = assertSignedIn(request);
  const addressId = cleanString(request.data?.addressId || request.data?.id, 160);
  if (!addressId) throw new HttpsError("invalid-argument", "Address ID is required.");

  const addressesRef = db.collection(COLLECTIONS.addresses);
  const addressSnap = await addressesRef.doc(addressId).get();
  if (!addressSnap.exists) throw new HttpsError("not-found", "Saved address not found.");
  if (addressSnap.data().userId !== uid) {
    throw new HttpsError("permission-denied", "You can only update your own addresses.");
  }

  const ownedSnap = await addressesRef.where("userId", "==", uid).get();
  const batch = db.batch();
  ownedSnap.forEach((docSnap) => {
    batch.update(docSnap.ref, {
      isDefault: docSnap.id === addressId,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  await batch.commit();
  return { status: "default_updated" };
});

exports.getPaymentConfigurationStatus = onCall(callableOptions({
  secrets: [PAYSTACK_SECRET_KEY, FLUTTERWAVE_SECRET_KEY],
}), async (request) => {
  assertSignedIn(request);
  return {
    paystack: Boolean(readSecret(PAYSTACK_SECRET_KEY, "PAYSTACK_SECRET_KEY")),
    flutterwave: Boolean(readSecret(FLUTTERWAVE_SECRET_KEY, "FLUTTERWAVE_SECRET_KEY")),
  };
});

async function gatewayJson(provider, url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = {};

  try {
    payload = text ? JSON.parse(text) : {};
  } catch (error) {
    payload = { message: text };
  }

  if (!response.ok) {
    console.error(`${provider} API error`, response.status, payload);
    throw new HttpsError("unavailable", `${provider} payment service is unavailable.`);
  }

  return payload;
}

async function initializePaystackPayment({ secretKey, email, amount, reference, callbackUrl, metadata }) {
  const payload = await gatewayJson("paystack", "https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      amount: amount * 100,
      currency: CURRENCY,
      reference,
      callback_url: callbackUrl,
      metadata,
    }),
  });

  if (!payload.status || !payload.data?.authorization_url) {
    throw new HttpsError("internal", payload.message || "Could not initialize Paystack payment.");
  }

  return {
    authorizationUrl: payload.data.authorization_url,
    accessCode: payload.data.access_code || null,
    reference: payload.data.reference || reference,
  };
}

async function initializeFlutterwavePayment({ secretKey, customer, amount, reference, callbackUrl, metadata }) {
  const payload = await gatewayJson("flutterwave", "https://api.flutterwave.com/v3/payments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tx_ref: reference,
      amount,
      currency: CURRENCY,
      redirect_url: callbackUrl,
      customer,
      customizations: {
        title: "Kandy's Treats",
        description: "Food order payment",
      },
      meta: metadata,
    }),
  });

  if (payload.status !== "success" || !payload.data?.link) {
    throw new HttpsError("internal", payload.message || "Could not initialize Flutterwave payment.");
  }

  return {
    authorizationUrl: payload.data.link,
    reference,
  };
}

async function verifyPaystackPayment(secretKey, reference) {
  const payload = await gatewayJson(
    "paystack",
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
      },
    },
  );

  const data = payload.data || {};
  return {
    raw: payload,
    success: Boolean(payload.status && data.status === "success"),
    reference: data.reference || reference,
    amount: Math.round(Number(data.amount || 0) / 100),
    currency: data.currency || CURRENCY,
    orderId: data.metadata?.orderId || null,
    userId: data.metadata?.userId || null,
    transactionId: data.metadata?.transactionId || null,
    status: data.status || "failed",
  };
}

async function verifyFlutterwavePayment(secretKey, gatewayTransactionId) {
  const payload = await gatewayJson(
    "flutterwave",
    `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(gatewayTransactionId)}/verify`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
      },
    },
  );

  const data = payload.data || {};
  return {
    raw: payload,
    success: payload.status === "success" && data.status === "successful",
    reference: data.tx_ref || null,
    amount: Math.round(Number(data.amount || 0)),
    currency: data.currency || CURRENCY,
    orderId: data.meta?.orderId || null,
    userId: data.meta?.userId || null,
    transactionId: data.meta?.transactionId || null,
    gatewayTransactionId: String(data.id || gatewayTransactionId),
    status: data.status || "failed",
  };
}

async function buildServerOrder(uid, authEmail, drafts, paymentMode) {
  if (!Array.isArray(drafts) || !drafts.length || drafts.length > MAX_DRAFTS) {
    throw new HttpsError("invalid-argument", "Review at least one saved order before checkout.");
  }

  const totalDraftItems = drafts.reduce((sum, draft) => sum + ((draft.items || []).length), 0);
  if (!totalDraftItems || totalDraftItems > MAX_ITEMS) {
    throw new HttpsError("invalid-argument", "Invalid checkout items.");
  }

  const menuIds = new Set();
  drafts.forEach((draft) => {
    (draft.items || []).forEach((item) => {
      const menuId = cleanString(item.menuId || item.id, 120);
      if (!menuId) throw new HttpsError("invalid-argument", "Every item must reference a menu item.");
      menuIds.add(menuId);
    });
  });

  const menuRefs = Array.from(menuIds).map((id) => db.collection(COLLECTIONS.menus).doc(id));
  const menuSnaps = menuRefs.length ? await db.getAll(...menuRefs) : [];
  const menus = new Map();
  menuSnaps.forEach((snap) => {
    if (snap.exists) menus.set(snap.id, snap.data());
  });

  const deliveryAddressIds = new Set();
  drafts.forEach((draft) => {
    const fulfilment = cleanString(draft.fulfilment || "delivery", 20);
    if (fulfilment === "delivery") {
      const addressId = cleanString(draft.addressId || draft.addressSnapshot?.id, 120);
      if (!addressId) {
        throw new HttpsError("invalid-argument", "Choose a saved delivery address.");
      }
      deliveryAddressIds.add(addressId);
    }
  });

  const addressRefs = Array.from(deliveryAddressIds).map((id) => db.collection(COLLECTIONS.addresses).doc(id));
  const addressSnaps = addressRefs.length ? await db.getAll(...addressRefs) : [];
  const addresses = new Map();
  addressSnaps.forEach((snap) => {
    const address = snap.exists ? snap.data() : null;
    if (!address || address.userId !== uid) {
      throw new HttpsError("permission-denied", "You can only use your own saved delivery addresses.");
    }

    addresses.set(snap.id, {
      id: snap.id,
      label: cleanString(address.label || "Delivery address", 80),
      recipientName: cleanString(address.recipientName || "", 100),
      phone: normalizePhone(address.phone || ""),
      address: cleanString(address.address, 300),
      notes: cleanString(address.notes || "", 300),
      isDefault: Boolean(address.isDefault),
    });
  });

  const orderId = `KD-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`;
  let subtotal = 0;
  let takeawayFee = 0;
  let deliveryFee = 0;
  let discount = 0;
  const subOrders = [];
  const flatItems = [];
  const deliveryAddresses = [];

  drafts.forEach((draft, index) => {
    const fulfilment = cleanString(draft.fulfilment || "delivery", 20);
    if (!["delivery", "pickup"].includes(fulfilment)) {
      throw new HttpsError("invalid-argument", "Choose delivery or pickup.");
    }

    const addressId = cleanString(draft.addressId || draft.addressSnapshot?.id, 120);
    const addressSnapshot = fulfilment === "delivery" ? addresses.get(addressId) : null;
    if (fulfilment === "delivery") {
      if (!addressSnapshot?.address) {
        throw new HttpsError("invalid-argument", "Choose a valid saved delivery address.");
      }
      deliveryAddresses.push(addressSnapshot);
    }

    const subItems = (draft.items || []).map((item) => {
      const menuId = cleanString(item.menuId || item.id, 120);
      const menu = menus.get(menuId);
      if (!menu) {
        throw new HttpsError("failed-precondition", "One of the meals is no longer available.");
      }
      if (String(menu.status || "").toLowerCase() === "sold-out") {
        throw new HttpsError("failed-precondition", `${menu.name || "Meal"} is sold out.`);
      }

      const qty = cleanQty(item.qty);
      const price = cleanAmount(menu.price);
      const lineTotal = price * qty;
      const cleanItem = {
        id: menuId,
        menuId,
        name: cleanString(menu.name || item.name, 100),
        category: cleanString(menu.section || menu.category || "", 80),
        price,
        qty,
        lineTotal,
      };

      subtotal += lineTotal;
      flatItems.push(cleanItem);
      return cleanItem;
    });

    const subSubtotal = subItems.reduce((sum, item) => sum + item.lineTotal, 0);
    const subTakeawayFee = calculateTakeawayFee(subItems);
    const subDeliveryFee = fulfilment === "delivery" && subItems.length ? DELIVERY_FEE : 0;
    const couponCode = cleanString(draft.coupon?.code || "", 30).toUpperCase();
    const coupon = COUPONS[couponCode] || null;
    const subDiscount = calculateCouponDiscount(coupon, subSubtotal);

    takeawayFee += subTakeawayFee;
    deliveryFee += subDeliveryFee;
    discount += subDiscount;

    subOrders.push({
      index: index + 1,
      items: subItems,
      fulfilment,
      addressId: addressSnapshot?.id || null,
      addressSnapshot,
      takeawayFee: subTakeawayFee,
      deliveryFee: subDeliveryFee,
      discount: subDiscount,
      coupon: coupon ? {
        code: coupon.code,
        label: coupon.label,
        type: coupon.type,
        value: coupon.value,
      } : null,
      notes: cleanString(draft.notes, 500),
    });
  });

  const firstDraft = drafts[0] || {};
  const firstCustomer = firstDraft.customer || {};
  const fulfilments = subOrders.map((item) => item.fulfilment);
  const fulfilment = fulfilments.every((item) => item === fulfilments[0]) ? fulfilments[0] : "mixed";
  const name = cleanString(firstCustomer.name, 100);
  const phone = normalizePhone(firstCustomer.phone);
  const email = cleanString(authEmail || firstCustomer.email, 160);
  const primaryAddress = deliveryAddresses[0] || null;
  const address = cleanString(primaryAddress?.address || "", 300);

  if (!name || !phone) {
    throw new HttpsError("invalid-argument", "Customer name and phone are required.");
  }
  if (fulfilments.includes("delivery") && !address) {
    throw new HttpsError("invalid-argument", "Delivery address is required.");
  }

  const netAmount = subtotal + takeawayFee + deliveryFee - discount;
  const processingFee = paymentMode === "gateway" ? calculateProcessingFee(netAmount) : 0;
  const total = netAmount + processingFee;

  return {
    orderId,
    order: {
      id: orderId,
      userId: uid,
      addressId: primaryAddress?.id || null,
      addressSnapshot: primaryAddress,
      customer: {
        name,
        phone,
        email,
        address: fulfilments.includes("delivery") ? address : "",
      },
      fulfilment,
      subOrders,
      items: flatItems,
      notes: drafts.map((draft) => cleanString(draft.notes, 300)).filter(Boolean).join(" | "),
      subtotal,
      deliveryFee,
      takeawayFee,
      discount,
      vat: processingFee,
      processingFee,
      total,
      netAmount,
      paymentProvider: paymentMode === "wallet" ? "wallet" : null,
      paymentRef: null,
      paymentStatus: "pending",
      paid: false,
      status: "New",
      statusHistory: [{
        status: "New",
        label: "Order received",
        atMs: Date.now(),
      }],
      estimatedDeliveryMinutes: Math.max(...drafts.map((draft) => Number(draft.estimatedDeliveryMinutes || 35))),
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
    },
  };
}

async function completeOrderPayment({ orderId, uid, provider, reference, amount, currency, raw }) {
  return db.runTransaction(async (transaction) => {
    const orderRef = db.collection(COLLECTIONS.orders).doc(orderId);
    const orderSnap = await transaction.get(orderRef);

    if (!orderSnap.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }

    const order = orderSnap.data();
    if (uid && order.userId !== uid) {
      throw new HttpsError("permission-denied", "You can only verify your own order.");
    }

    if (order.paid === true) {
      return { status: "already_paid", orderId };
    }

    if (currency !== CURRENCY || cleanAmount(amount) !== cleanAmount(order.total)) {
      throw new HttpsError("failed-precondition", "Gateway amount does not match this order.");
    }

    const txRef = db.collection(COLLECTIONS.transactions).doc(transactionIdFor(provider, reference));
    transaction.set(txRef, {
      userId: order.userId,
      orderId,
      type: "order_payment",
      direction: "debit",
      title: `Payment for ${orderId}`,
      provider,
      amount: cleanAmount(amount),
      currency,
      status: "success",
      gatewayReference: reference,
      metadata: { raw },
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    transaction.update(orderRef, {
      paid: true,
      paymentProvider: provider,
      paymentRef: reference,
      paymentStatus: "confirmed",
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { status: "paid", orderId, transactionId: txRef.id };
  });
}

async function failOrderPayment({ orderId, uid, provider, reference, status, reason }) {
  const cleanStatus = ["cancelled", "canceled"].includes(status) ? "cancelled" : "failed";
  return db.runTransaction(async (transaction) => {
    const orderRef = db.collection(COLLECTIONS.orders).doc(orderId);
    const orderSnap = await transaction.get(orderRef);

    if (!orderSnap.exists) throw new HttpsError("not-found", "Order not found.");
    const order = orderSnap.data();
    if (uid && order.userId !== uid) {
      throw new HttpsError("permission-denied", "You can only update your own payment.");
    }
    if (order.paid === true) return { status: "already_paid", orderId };

    transaction.update(orderRef, {
      paymentProvider: provider,
      paymentRef: reference || order.paymentRef || null,
      paymentStatus: cleanStatus,
      paymentFailureReason: cleanString(reason || cleanStatus, 240),
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (reference) {
      transaction.set(db.collection(COLLECTIONS.transactions).doc(transactionIdFor(provider, reference)), {
        userId: order.userId,
        orderId,
        type: "order_payment",
        direction: "debit",
        title: `Payment for ${orderId}`,
        provider,
        amount: cleanAmount(order.total),
        currency: CURRENCY,
        status: cleanStatus,
        gatewayReference: reference,
        reason: cleanString(reason || cleanStatus, 240),
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    return { status: cleanStatus, orderId };
  });
}

async function completeWalletFunding({ transactionId, provider, reference, amount, currency, raw }) {
  return db.runTransaction(async (transaction) => {
    const transactionRef = db.collection(COLLECTIONS.transactions).doc(transactionId);
    const transactionSnap = await transaction.get(transactionRef);

    if (!transactionSnap.exists) {
      throw new HttpsError("not-found", "Funding transaction not found.");
    }

    const funding = transactionSnap.data();
    if (funding.status === "success") {
      return { status: "already_success", transactionId, userId: funding.userId, amount: funding.amount };
    }
    if (funding.provider !== provider) {
      throw new HttpsError("failed-precondition", "Funding provider mismatch.");
    }
    if (currency !== CURRENCY || cleanAmount(amount) !== cleanAmount(funding.amount)) {
      throw new HttpsError("failed-precondition", "Gateway amount does not match this wallet funding.");
    }

    const { ref: walletRef, data: wallet } = await ensureWallet(funding.userId, transaction);
    const balance = Number(wallet.balance || 0);
    transaction.update(walletRef, {
      balance: FieldValue.increment(funding.amount),
      availableBalance: FieldValue.increment(funding.amount),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(transactionRef, {
      status: "success",
      balanceAfter: balance + funding.amount,
      gatewayReference: reference || funding.gatewayReference,
      metadata: { raw },
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { status: "success", transactionId, userId: funding.userId, amount: funding.amount };
  });
}

exports.createCheckoutOrder = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = assertSignedIn(request);
  const paymentMode = cleanString(request.data?.paymentMode || "gateway", 20).toLowerCase();
  if (!["gateway", "wallet"].includes(paymentMode)) {
    throw new HttpsError("invalid-argument", "Choose a valid payment method.");
  }

  const authEmail = request.auth?.token?.email || "";
  const { orderId, order } = await buildServerOrder(uid, authEmail, request.data?.drafts, paymentMode);

  await ensureWallet(uid);

  const batch = db.batch();
  const orderRef = db.collection(COLLECTIONS.orders).doc(orderId);
  batch.set(orderRef, order);

  order.items.forEach((item) => {
    const itemRef = db.collection(COLLECTIONS.orderItems).doc();
    batch.set(itemRef, {
      orderId,
      userId: uid,
      menuId: item.menuId,
      name: item.name,
      price: item.price,
      qty: item.qty,
      lineTotal: item.lineTotal,
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  await batch.commit();

  return {
    orderId,
    totals: {
      subtotal: order.subtotal,
      deliveryFee: order.deliveryFee,
      takeawayFee: order.takeawayFee,
      discount: order.discount,
      processingFee: order.processingFee,
      total: order.total,
      netAmount: order.netAmount,
    },
  };
});

exports.createGatewayPayment = onCall(callableOptions({
  secrets: [PAYSTACK_SECRET_KEY, FLUTTERWAVE_SECRET_KEY],
}), async (request) => {
  const uid = assertSignedIn(request);
  const provider = cleanProvider(request.data?.provider);
  const orderId = cleanString(request.data?.orderId, 120);
  if (!orderId) throw new HttpsError("invalid-argument", "Order ID is required.");

  const orderRef = db.collection(COLLECTIONS.orders).doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new HttpsError("not-found", "Order not found.");

  const order = orderSnap.data();
  if (order.userId !== uid) {
    throw new HttpsError("permission-denied", "You can only pay for your own order.");
  }
  if (order.paid === true) {
    return { status: "already_paid", orderId };
  }

  const amount = cleanAmount(order.total);
  const reference = `KT-${orderId}-${Date.now()}`;
  const callbackUrl = isAllowedCallbackUrl(
    request.data?.callbackUrl,
    `pay.html?order=${encodeURIComponent(orderId)}&provider=${provider}`,
  );
  const email = cleanString(order.customer?.email || request.auth?.token?.email || "", 160);
  const name = cleanString(order.customer?.name || "Kandys Treats Customer", 100);
  const phone = normalizePhone(order.customer?.phone);
  const txRef = db.collection(COLLECTIONS.transactions).doc(transactionIdFor(provider, reference));

  let gateway;
  if (provider === "paystack") {
    const secretKey = readSecret(PAYSTACK_SECRET_KEY, "PAYSTACK_SECRET_KEY");
    if (!secretKey) throw new HttpsError("failed-precondition", "Paystack secret key is not configured.");
    gateway = await initializePaystackPayment({
      secretKey,
      email,
      amount,
      reference,
      callbackUrl,
      metadata: { orderId, userId: uid, transactionId: txRef.id },
    });
  } else {
    const secretKey = readSecret(FLUTTERWAVE_SECRET_KEY, "FLUTTERWAVE_SECRET_KEY");
    if (!secretKey) throw new HttpsError("failed-precondition", "Flutterwave secret key is not configured.");
    gateway = await initializeFlutterwavePayment({
      secretKey,
      customer: { email, name, phone_number: phone },
      amount,
      reference,
      callbackUrl,
      metadata: { orderId, userId: uid, transactionId: txRef.id },
    });
  }

  const gatewayReference = gateway.reference || reference;
  const batch = db.batch();
  batch.set(txRef, {
    userId: uid,
    orderId,
    type: "order_payment",
    direction: "debit",
    title: `Payment for ${orderId}`,
    provider,
    amount,
    currency: CURRENCY,
    status: "pending",
    gatewayReference,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  batch.update(orderRef, {
    paymentProvider: provider,
    paymentRef: gatewayReference,
    paymentStatus: "pending",
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  return {
    status: "initialized",
    provider,
    orderId,
    reference: gatewayReference,
    authorizationUrl: gateway.authorizationUrl,
    accessCode: gateway.accessCode || null,
  };
});

exports.verifyGatewayPayment = onCall(callableOptions({
  secrets: [PAYSTACK_SECRET_KEY, FLUTTERWAVE_SECRET_KEY],
}), async (request) => {
  const uid = assertSignedIn(request);
  const provider = cleanProvider(request.data?.provider);
  const orderId = cleanString(request.data?.orderId, 120);
  if (!orderId) throw new HttpsError("invalid-argument", "Order ID is required.");

  let verified;
  if (provider === "paystack") {
    const reference = cleanString(request.data?.reference || request.data?.trxref, 160);
    if (!reference) throw new HttpsError("invalid-argument", "Payment reference is required.");
    const secretKey = readSecret(PAYSTACK_SECRET_KEY, "PAYSTACK_SECRET_KEY");
    if (!secretKey) throw new HttpsError("failed-precondition", "Paystack secret key is not configured.");
    verified = await verifyPaystackPayment(secretKey, reference);
  } else {
    const gatewayTransactionId = cleanString(request.data?.gatewayTransactionId || request.data?.transactionId, 160);
    if (!gatewayTransactionId) {
      throw new HttpsError("invalid-argument", "Flutterwave transaction ID is required.");
    }
    const secretKey = readSecret(FLUTTERWAVE_SECRET_KEY, "FLUTTERWAVE_SECRET_KEY");
    if (!secretKey) throw new HttpsError("failed-precondition", "Flutterwave secret key is not configured.");
    verified = await verifyFlutterwavePayment(secretKey, gatewayTransactionId);
  }

  if ((verified.orderId && verified.orderId !== orderId) || (verified.userId && verified.userId !== uid)) {
    throw new HttpsError("permission-denied", "Gateway response does not belong to this order.");
  }

  if (!verified.success) {
    return failOrderPayment({
      orderId,
      uid,
      provider,
      reference: verified.reference,
      status: "failed",
      reason: verified.status,
    });
  }

  const result = await completeOrderPayment({
    orderId,
    uid,
    provider,
    reference: verified.reference,
    amount: verified.amount,
    currency: verified.currency,
    raw: verified.raw,
  });

  if (result.status === "paid") {
    await createNotification(uid, {
      type: "order",
      title: "Payment confirmed",
      message: `Payment for ${orderId} was confirmed.`,
      relatedId: orderId,
    });
  }

  return result;
});

exports.recordGatewayPaymentEvent = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = assertSignedIn(request);
  const provider = cleanProvider(request.data?.provider);
  const orderId = cleanString(request.data?.orderId, 120);
  const status = cleanString(request.data?.status, 40).toLowerCase();
  const reference = cleanString(request.data?.reference || request.data?.txRef, 160);

  if (!orderId) throw new HttpsError("invalid-argument", "Order ID is required.");
  if (!["cancelled", "canceled", "failed"].includes(status)) {
    throw new HttpsError("invalid-argument", "Only failed or cancelled payment events can be recorded.");
  }

  return failOrderPayment({
    orderId,
    uid,
    provider,
    reference,
    status,
    reason: request.data?.reason || status,
  });
});

exports.createWalletFundingPayment = onCall(callableOptions({
  secrets: [PAYSTACK_SECRET_KEY, FLUTTERWAVE_SECRET_KEY],
}), async (request) => {
  const uid = assertSignedIn(request);
  const provider = cleanProvider(request.data?.provider);
  const amount = cleanAmount(request.data?.amount);
  if (amount < 100) {
    throw new HttpsError("invalid-argument", "Minimum funding amount is NGN 100.");
  }

  const secretKey = provider === "paystack"
    ? readSecret(PAYSTACK_SECRET_KEY, "PAYSTACK_SECRET_KEY")
    : readSecret(FLUTTERWAVE_SECRET_KEY, "FLUTTERWAVE_SECRET_KEY");
  if (!secretKey) {
    throw new HttpsError(
      "failed-precondition",
      `${provider === "paystack" ? "Paystack" : "Flutterwave"} secret key is not configured.`,
    );
  }

  const profileSnap = await db.collection(COLLECTIONS.users).doc(uid).get();
  const profile = profileSnap.exists ? profileSnap.data() : {};
  const email = cleanString(request.auth?.token?.email || profile.email, 160);
  const name = cleanString(profile.displayName || "Kandys Treats Customer", 100);
  const phone = normalizePhone(profile.phone);
  const transactionRef = db.collection(COLLECTIONS.transactions).doc();
  const gatewayReference = `KT-WALLET-${uid}-${Date.now()}`;
  const callbackBaseUrl = isAllowedCallbackUrl(
    request.data?.callbackUrl,
    `account.html?walletFunding=${transactionRef.id}&provider=${provider}`,
  );
  const callback = new URL(callbackBaseUrl);
  callback.searchParams.set("walletFunding", transactionRef.id);
  callback.searchParams.set("provider", provider);
  const callbackUrl = callback.href;

  await ensureWallet(uid);
  await transactionRef.set({
    userId: uid,
    walletId: uid,
    type: "wallet_funding",
    direction: "credit",
    title: "Wallet funding",
    provider,
    amount,
    currency: CURRENCY,
    status: "pending",
    gatewayReference,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  let gateway;
  if (provider === "paystack") {
    gateway = await initializePaystackPayment({
      secretKey,
      email,
      amount,
      reference: gatewayReference,
      callbackUrl,
      metadata: { type: "wallet_funding", transactionId: transactionRef.id, userId: uid },
    });
  } else {
    gateway = await initializeFlutterwavePayment({
      secretKey,
      customer: { email, name, phone_number: phone },
      amount,
      reference: gatewayReference,
      callbackUrl,
      metadata: { type: "wallet_funding", transactionId: transactionRef.id, userId: uid },
    });
  }

  return {
    transactionId: transactionRef.id,
    provider,
    reference: gateway.reference,
    authorizationUrl: gateway.authorizationUrl,
  };
});

exports.verifyWalletFundingPayment = onCall(callableOptions({
  secrets: [PAYSTACK_SECRET_KEY, FLUTTERWAVE_SECRET_KEY],
}), async (request) => {
  const uid = assertSignedIn(request);
  const provider = cleanProvider(request.data?.provider);
  const transactionId = cleanString(request.data?.transactionId, 160);
  const returnStatus = cleanString(request.data?.status, 40).toLowerCase();
  if (!transactionId) throw new HttpsError("invalid-argument", "Transaction ID is required.");

  const transactionRef = db.collection(COLLECTIONS.transactions).doc(transactionId);
  const transactionSnap = await transactionRef.get();
  if (!transactionSnap.exists) throw new HttpsError("not-found", "Funding transaction not found.");

  const funding = transactionSnap.data();
  if (funding.userId !== uid) {
    throw new HttpsError("permission-denied", "You can only verify your own wallet funding.");
  }

  if (["cancelled", "canceled", "failed"].includes(returnStatus)) {
    await transactionRef.update({
      status: returnStatus === "failed" ? "failed" : "cancelled",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { status: returnStatus === "failed" ? "failed" : "cancelled", transactionId };
  }

  let verified;
  if (provider === "paystack") {
    const reference = cleanString(request.data?.reference || funding.gatewayReference, 160);
    const secretKey = readSecret(PAYSTACK_SECRET_KEY, "PAYSTACK_SECRET_KEY");
    if (!secretKey) throw new HttpsError("failed-precondition", "Paystack secret key is not configured.");
    verified = await verifyPaystackPayment(secretKey, reference);
  } else {
    const gatewayTransactionId = cleanString(request.data?.gatewayTransactionId || request.data?.transaction_id, 160);
    if (!gatewayTransactionId) throw new HttpsError("invalid-argument", "Flutterwave transaction ID is required.");
    const secretKey = readSecret(FLUTTERWAVE_SECRET_KEY, "FLUTTERWAVE_SECRET_KEY");
    if (!secretKey) throw new HttpsError("failed-precondition", "Flutterwave secret key is not configured.");
    verified = await verifyFlutterwavePayment(secretKey, gatewayTransactionId);
  }

  if (!verified.success) {
    await transactionRef.update({
      status: "failed",
      reason: verified.status,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { status: "failed", transactionId };
  }

  const result = await completeWalletFunding({
    transactionId,
    provider,
    reference: verified.reference,
    amount: verified.amount,
    currency: verified.currency,
    raw: verified.raw,
  });

  if (result.userId && result.status === "success") {
    await createNotification(result.userId, {
      type: "wallet",
      title: "Wallet funded",
      message: `${formatNgn(result.amount)} has been added to your wallet.`,
      relatedId: transactionId,
    });
  }

  return result;
});

exports.requestWalletFunding = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = assertSignedIn(request);
  const amount = cleanAmount(request.data && request.data.amount);
  const provider = String(request.data && request.data.provider || "manual")
    .trim()
    .toLowerCase();

  if (amount < 100) {
    throw new HttpsError("invalid-argument", "Minimum funding amount is NGN 100.");
  }

  await ensureWallet(uid);

  const transactionRef = await db.collection(COLLECTIONS.transactions).add({
    userId: uid,
    walletId: uid,
    type: "wallet_funding",
    direction: "credit",
    title: "Wallet funding request",
    provider,
    amount,
    currency: CURRENCY,
    status: "pending",
    gatewayReference: null,
    metadata: {
      source: "customer_dashboard",
    },
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await createNotification(uid, {
    type: "wallet",
    title: "Wallet funding started",
    message: `Your ${formatNgn(amount)} funding request is pending gateway confirmation.`,
    relatedId: transactionRef.id,
  });

  return { transactionId: transactionRef.id, status: "pending" };
});

exports.payOrderWithWallet = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = assertSignedIn(request);
  const orderId = String(request.data && request.data.orderId || "").trim();

  if (!orderId) {
    throw new HttpsError("invalid-argument", "Order ID is required.");
  }

  const result = await db.runTransaction(async (transaction) => {
    const orderRef = db.collection(COLLECTIONS.orders).doc(orderId);
    const orderSnap = await transaction.get(orderRef);

    if (!orderSnap.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }

    const order = orderSnap.data();
    if (order.userId !== uid) {
      throw new HttpsError("permission-denied", "You can only pay for your own order.");
    }

    if (order.paid === true) {
      return { orderId, status: "already_paid" };
    }

    const total = cleanAmount(order.total);
    const { ref: walletRef, data: wallet } = await ensureWallet(uid, transaction);
    const balance = Number(wallet.balance || 0);

    if (balance < total) {
      throw new HttpsError("failed-precondition", "Insufficient wallet balance.");
    }

    const txRef = db.collection(COLLECTIONS.transactions).doc();

    transaction.update(walletRef, {
      balance: FieldValue.increment(-total),
      availableBalance: FieldValue.increment(-total),
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.update(orderRef, {
      paid: true,
      paymentStatus: "confirmed",
      paymentProvider: "wallet",
      paymentRef: txRef.id,
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.set(txRef, {
      userId: uid,
      walletId: uid,
      orderId,
      type: "order_payment",
      direction: "debit",
      title: `Payment for ${orderId}`,
      provider: "wallet",
      amount: total,
      currency: CURRENCY,
      status: "success",
      balanceAfter: balance - total,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { orderId, status: "paid", transactionId: txRef.id };
  });

  if (result.status === "paid") {
    await createNotification(uid, {
      type: "order",
      title: "Order paid with wallet",
      message: `Wallet payment for ${orderId} was successful.`,
      relatedId: orderId,
    });
  }

  return result;
});

exports.refundOrderToWallet = onCall(CALLABLE_OPTIONS, async (request) => {
  await assertAdmin(request);
  const orderId = String(request.data && request.data.orderId || "").trim();
  const reason = String(request.data && request.data.reason || "Order refund").trim();

  if (!orderId) {
    throw new HttpsError("invalid-argument", "Order ID is required.");
  }

  const result = await db.runTransaction(async (transaction) => {
    const orderRef = db.collection(COLLECTIONS.orders).doc(orderId);
    const orderSnap = await transaction.get(orderRef);

    if (!orderSnap.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }

    const order = orderSnap.data();
    if (!order.userId) {
      throw new HttpsError("failed-precondition", "Order is not linked to a customer wallet.");
    }

    const amount = request.data && request.data.amount
      ? cleanAmount(request.data.amount)
      : cleanAmount(order.total || order.netAmount);

    const { ref: walletRef, data: wallet } = await ensureWallet(order.userId, transaction);
    const balance = Number(wallet.balance || 0);
    const txRef = db.collection(COLLECTIONS.transactions).doc();

    transaction.update(walletRef, {
      balance: FieldValue.increment(amount),
      availableBalance: FieldValue.increment(amount),
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.set(txRef, {
      userId: order.userId,
      walletId: order.userId,
      orderId,
      type: "refund",
      direction: "credit",
      title: `Refund for ${orderId}`,
      provider: "wallet",
      amount,
      currency: CURRENCY,
      status: "success",
      reason,
      balanceAfter: balance + amount,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.update(orderRef, {
      refundStatus: "refunded",
      refundedAmount: FieldValue.increment(amount),
      refundedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { orderId, userId: order.userId, amount, transactionId: txRef.id };
  });

  await createNotification(result.userId, {
    type: "wallet",
    title: "Refund processed",
    message: `${formatNgn(result.amount)} has been refunded to your wallet.`,
    relatedId: orderId,
  });

  return { status: "success", ...result };
});

exports.paystackWebhook = onRequest({
  secrets: [PAYSTACK_SECRET_KEY],
}, async (req, res) => {
  const secretKey = readSecret(PAYSTACK_SECRET_KEY, "PAYSTACK_SECRET_KEY");
  const signature = req.headers["x-paystack-signature"];
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const hash = crypto.createHmac("sha512", secretKey).update(rawBody).digest("hex");
  const logRef = await db.collection("payment_logs").add({
    provider: "paystack",
    event: req.body?.event || null,
    verified: false,
    receivedAt: FieldValue.serverTimestamp(),
  });

  try {
    if (!secretKey || hash !== signature) {
      await logRef.update({ reason: "Invalid signature" });
      return res.status(401).send("Invalid signature");
    }

    const event = req.body || {};
    await logRef.update({ verified: true });
    if (event.event !== "charge.success") {
      await logRef.update({ reason: "Ignored event type" });
      return res.status(200).send("Ignored");
    }

    const data = event.data || {};
    const orderId = data.metadata?.orderId;
    const transactionId = data.metadata?.transactionId;
    const type = data.metadata?.type;
    const verified = {
      success: data.status === "success",
      reference: data.reference,
      amount: Math.round(Number(data.amount || 0) / 100),
      currency: data.currency || CURRENCY,
      raw: event,
    };

    if (type === "wallet_funding" && transactionId) {
      const result = await completeWalletFunding({
        transactionId,
        provider: "paystack",
        reference: verified.reference,
        amount: verified.amount,
        currency: verified.currency,
        raw: event,
      });
      await logRef.update({ success: true, transactionId, result: result.status });
      return res.status(200).send("OK");
    }

    if (!orderId || !verified.success) {
      await logRef.update({ reason: "Missing orderId or unsuccessful charge" });
      return res.status(200).send("Ignored");
    }

    const result = await completeOrderPayment({
      orderId,
      provider: "paystack",
      reference: verified.reference,
      amount: verified.amount,
      currency: verified.currency,
      raw: event,
    });

    await logRef.update({ success: true, orderId, result: result.status });
    return res.status(200).send("OK");
  } catch (error) {
    console.error("Paystack webhook error", error);
    await logRef.update({ success: false, reason: error.message });
    return res.status(500).send("Webhook error");
  }
});

exports.flutterwaveWebhook = onRequest({
  secrets: [FLUTTERWAVE_SECRET_HASH],
}, async (req, res) => {
  const secretHash = readSecret(FLUTTERWAVE_SECRET_HASH, "FLUTTERWAVE_SECRET_HASH");
  const verifHash = req.headers["verif-hash"];
  const signature = req.headers["flutterwave-signature"];
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expectedSignature = secretHash
    ? crypto.createHmac("sha256", secretHash).update(rawBody).digest("hex")
    : "";
  const isVerified = Boolean(secretHash)
    && (verifHash === secretHash || signature === expectedSignature);
  const logRef = await db.collection("payment_logs").add({
    provider: "flutterwave",
    event: req.body?.event || null,
    verified: false,
    receivedAt: FieldValue.serverTimestamp(),
  });

  try {
    if (!isVerified) {
      await logRef.update({ reason: "Invalid signature" });
      return res.status(401).send("Unauthorized");
    }

    const event = req.body || {};
    const data = event.data || {};
    await logRef.update({ verified: true });
    if (event.event !== "charge.completed" || data.status !== "successful") {
      await logRef.update({ reason: "Ignored event type" });
      return res.status(200).send("Ignored");
    }

    const orderId = data.meta?.orderId;
    const transactionId = data.meta?.transactionId;
    const type = data.meta?.type;

    if (type === "wallet_funding" && transactionId) {
      const result = await completeWalletFunding({
        transactionId,
        provider: "flutterwave",
        reference: data.tx_ref,
        amount: Math.round(Number(data.amount || 0)),
        currency: data.currency || CURRENCY,
        raw: event,
      });
      await logRef.update({ success: true, transactionId, result: result.status });
      return res.status(200).send("OK");
    }

    if (!orderId) {
      await logRef.update({ reason: "Missing orderId" });
      return res.status(200).send("Missing orderId");
    }

    const result = await completeOrderPayment({
      orderId,
      provider: "flutterwave",
      reference: data.tx_ref,
      amount: Math.round(Number(data.amount || 0)),
      currency: data.currency || CURRENCY,
      raw: event,
    });

    await logRef.update({ success: true, orderId, result: result.status });
    return res.status(200).send("OK");
  } catch (error) {
    console.error("Flutterwave webhook error", error);
    await logRef.update({ success: false, reason: error.message });
    return res.status(500).send("Webhook error");
  }
});

exports.sendOrderNotification = onDocumentCreated("orders/{orderId}", async (event) => {
  const order = event.data.data();
  const orderId = event.params.orderId;
  const total = Number(order.total || 0).toLocaleString("en-NG");

  await Promise.all([
    notifyAdmins("New Order Received", `Order ${orderId} is worth NGN ${total}.`),
    createNotification(order.userId, {
      type: "order",
      title: "Order confirmed",
      message: `We received your order ${orderId}. You can track it from your dashboard.`,
      relatedId: orderId,
    }),
  ]);
});

exports.notifyOrderStatusChange = onDocumentUpdated("orders/{orderId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();

  if (!after.userId || before.status === after.status) return;

  const statusMessages = {
    New: "Your order has been confirmed.",
    Preparing: "Your food is now being prepared.",
    Out: "Your order is on the way.",
    Completed: "Your order has been completed. Thank you for ordering.",
    Cancelled: "Your order was cancelled. Contact support if you need help.",
  };

  await createNotification(after.userId, {
    type: "order",
    title: `Order ${after.status || "updated"}`,
    message: statusMessages[after.status] || "Your order status changed.",
    relatedId: event.params.orderId,
  });
});

exports.__testables = {
  calculateCouponDiscount,
  calculateProcessingFee,
  calculateTakeawayFee,
  cleanProvider,
  normalizePhone,
  transactionIdFor,
  ORDER_STATUSES,
};
