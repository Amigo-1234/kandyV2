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

import { auth, fb, callable, errorMessage } from "./firebase.js";

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

/** Create or refresh users/{uid} + wallets/{uid} through the callable. */
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
  } catch (error) {
    /* Provisioning is retried on the next sign-in; never block the customer. */
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
