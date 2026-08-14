/* ==========================================================================
   Kandy's Treats — Authentication
   --------------------------------------------------------------------------
   Mirrors V1's flow (js/auth-page.js):
     sign in / sign up with email+password or Google
     → call `ensureCustomerAccount`, which creates users/{uid} and the matching
       zero-balance wallets/{uid} with Admin SDK permissions.

   Guest browsing stays open. Only checkout requires an account, exactly as in
   V1, and the guest basket merges into the account basket on sign-in.
   ========================================================================== */

import { auth, db, fb, callable, errorMessage, callableNeverRan, COLLECTIONS } from "./firebase.js";

const ensureCustomerAccount = callable("ensureCustomerAccount");
const googleProvider = new fb.GoogleAuthProvider();

let currentUser = null;
let ready = false;
let resolveReady;
const readyPromise = new Promise((r) => { resolveReady = r; });

function broadcast() {
  document.dispatchEvent(new CustomEvent("kt:auth", {
    detail: { user: currentUser, signedIn: !!currentUser }
  }));
}

/**
 * Create or refresh users/{uid} + wallets/{uid} directly, under the customer's
 * own credentials.
 *
 * This is the no-Cloud-Functions path, and it is safe because firestore.rules
 * enforce every constraint the Cloud Function used to:
 *
 *   users/{uid}    owner only; keys limited to the whitelist below; uid must
 *                  equal the caller; role pinned to "customer" on create and
 *                  frozen on update; email and emailVerified must equal the
 *                  auth token's own claims.
 *   wallets/{uid}  owner only, and creatable ONLY with a zero balance. Credits
 *                  stay admin-only, so this cannot mint money.
 *
 * The values for `email` and `emailVerified` are read back off the ID token
 * rather than off the user object, because the rules compare against the token
 * claims. Straight after email verification the two disagree until the token
 * refreshes, and sending the user-object value would be rejected.
 */
async function provisionDirect(user, extra = {}) {
  const uid = user.uid;
  const now = fb.serverTimestamp();

  let claims = {};
  try {
    claims = (await user.getIdTokenResult()).claims || {};
  } catch { /* fall through — both fields are optional under the rules */ }

  const profile = {
    uid,
    displayName: extra.displayName || user.displayName || "",
    phone: window.KT.rules.normalizePhone(extra.phone || user.phoneNumber || ""),
    photoURL: user.photoURL || "",
    updatedAt: now
  };
  /* Omit rather than guess: the rules allow these keys to be absent, but
     reject them outright if they disagree with the token. */
  if (claims.email) profile.email = claims.email;
  if (typeof claims.email_verified === "boolean") profile.emailVerified = claims.email_verified;

  const userRef = fb.doc(db, COLLECTIONS.users, uid);
  const existing = await fb.getDoc(userRef);

  if (existing.exists()) {
    /* No `role` key: keepsRole() requires it to be unchanged. */
    await fb.updateDoc(userRef, profile);
  } else {
    await fb.setDoc(userRef, { ...profile, role: "customer", createdAt: now });
  }

  /* The zero-balance wallet the account page reads. Created once, never by
     update — the rules only permit a create, and only at zero. */
  const walletRef = fb.doc(db, COLLECTIONS.wallets, uid);
  const wallet = await fb.getDoc(walletRef);
  if (!wallet.exists()) {
    await fb.setDoc(walletRef, {
      userId: uid,
      currency: "NGN",
      balance: 0,
      availableBalance: 0,
      lockedBalance: 0,
      status: "active",
      createdAt: now,
      updatedAt: now
    });
  }
}

/** Create or refresh users/{uid} + wallets/{uid}. */
async function provision(user, extra = {}) {
  if (!user) return;
  try {
    await ensureCustomerAccount({
      profile: {
        displayName: extra.displayName || user.displayName || "",
        phone: window.KT.rules.normalizePhone(extra.phone || user.phoneNumber || ""),
        email: user.email || "",
        photoURL: user.photoURL || ""
      }
    });
    return;
  } catch (error) {
    if (!callableNeverRan(error)) {
      console.warn("[Kandy's] account provisioning refused:", errorMessage(error));
      return;
    }
  }

  /* No function answered — provision directly instead. */
  try {
    await provisionDirect(user, extra);
  } catch (error) {
    /* Retried on the next sign-in; never block the customer. */
    console.warn("[Kandy's] account provisioning deferred:", errorMessage(error));
  }
}

fb.onAuthStateChanged(auth, async (user) => {
  currentUser = user || null;

  /* Re-scope the basket so a guest's items follow them into their account. */
  window.KT.cart.setScope(user ? user.uid : null);

  if (user) await provision(user);
  if (!ready) { ready = true; resolveReady(currentUser); }
  broadcast();
});

export const authService = {
  /** Resolves once Firebase has reported the initial auth state. */
  ready: () => readyPromise,

  user: () => currentUser,
  isSignedIn: () => !!currentUser,
  uid: () => (currentUser ? currentUser.uid : null),

  async signIn(email, password) {
    const cred = await fb.signInWithEmailAndPassword(auth, String(email).trim(), password);
    await provision(cred.user);
    return cred.user;
  },

  async signUp({ firstName, lastName, email, phone, password }) {
    const displayName = [firstName, lastName].filter(Boolean).join(" ").trim();
    const cred = await fb.createUserWithEmailAndPassword(auth, String(email).trim(), password);

    if (displayName) {
      await fb.updateProfile(cred.user, { displayName }).catch(() => {});
    }
    await provision(cred.user, { displayName, phone });
    await fb.sendEmailVerification(cred.user).catch(() => {});
    return cred.user;
  },

  async signInWithGoogle() {
    try {
      const cred = await fb.signInWithPopup(auth, googleProvider);
      await provision(cred.user);
      return cred.user;
    } catch (error) {
      /* Popups are blocked on some mobile browsers — V1 falls back to redirect. */
      if (String(error.code || "").includes("popup")) {
        await fb.signInWithRedirect(auth, googleProvider);
        return null;
      }
      throw error;
    }
  },

  async resetPassword(email) {
    await fb.sendPasswordResetEmail(auth, String(email).trim());
  },

  async resendVerification() {
    if (currentUser) await fb.sendEmailVerification(currentUser);
  },

  async signOut() {
    await fb.signOut(auth);
  },

  /** Where to send someone after they sign in. */
  nextUrl() {
    const next = new URLSearchParams(window.location.search).get("next");
    const routes = { cart: "pages/cart.html", account: "pages/account.html", orders: "pages/orders.html" };
    return window.KT.url(routes[next] || "index.html");
  }
};
