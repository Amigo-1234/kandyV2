/* ==========================================================================
   Kandy's Treats — Authentication (Supabase)
   --------------------------------------------------------------------------
   Replaces the Firebase Auth implementation. The exported interface is
   deliberately identical, and user() still returns a Firebase-shaped object
   (uid / displayName / photoURL / emailVerified), so no page or component
   needed changing for this swap.

   ensureCustomerAccount is gone: the handle_new_user() trigger on auth.users
   creates public.profiles and a zero-balance public.wallets row atomically,
   inside the same transaction that creates the account. There is no window in
   which a signed-in customer has no profile, and no Cloud Function to deploy.

   Guest browsing stays open. Only checkout requires an account, and the guest
   basket still follows the customer in through KT.cart.setScope().
   ========================================================================== */

import { supabase, TABLES, errorMessage } from "./supabase.js";

let currentUser = null;
let ready = false;
let resolveReady;
const readyPromise = new Promise((r) => { resolveReady = r; });

/** Supabase user -> the shape the existing UI already reads. */
function shape(u) {
  if (!u) return null;
  const meta = u.user_metadata || {};
  return {
    uid: u.id,
    id: u.id,
    email: u.email || "",
    displayName: meta.display_name || meta.full_name || meta.name || "",
    photoURL: meta.avatar_url || meta.picture || "",
    emailVerified: !!u.email_confirmed_at,
    raw: u
  };
}

/* Supabase emits INITIAL_SESSION the moment this module is imported — which is
   BEFORE services/index.js has finished importing the rest and assigned
   window.KT.auth. A kt:auth escaping in that window made every page evaluate
   `!KT.auth` as true and paint the signed-out state while the customer was in
   fact signed in. So the first broadcast is held until index.js confirms the
   service layer is published. */
let broadcastReady = false;
let broadcastPending = false;

function broadcast() {
  if (!broadcastReady) { broadcastPending = true; return; }
  document.dispatchEvent(new CustomEvent("kt:auth", {
    detail: { user: currentUser, signedIn: !!currentUser }
  }));
}

function settle(session) {
  currentUser = shape(session && session.user);
  /* Re-scope the basket so a guest's items follow them into their account. */
  window.KT.cart.setScope(currentUser ? currentUser.uid : null);
  if (!ready) { ready = true; resolveReady(currentUser); }
  broadcast();
}

/* onAuthStateChange fires INITIAL_SESSION on load — restored from localStorage
   — then SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED / USER_UPDATED. Handling all
   of them here keeps one dispatcher for kt:auth. */
supabase.auth.onAuthStateChange((_event, session) => settle(session));

/* Belt and braces: if the SDK never emits (offline, blocked CDN), resolve from
   the stored session so ready() cannot hang the page forever. */
supabase.auth.getSession().then(({ data }) => {
  if (!ready) settle(data && data.session);
}).catch(() => { if (!ready) settle(null); });

function absolute(path) {
  return new URL(path, window.location.origin + window.location.pathname).href;
}

export const authService = {
  /**
   * Called by services/index.js once KT.auth and KT.services exist. Flushes any
   * auth state that settled while we were still booting.
   */
  beginBroadcast() {
    if (broadcastReady) return;
    broadcastReady = true;
    if (broadcastPending) { broadcastPending = false; broadcast(); }
  },

  /** Resolves once Supabase has reported the initial session. */
  ready: () => readyPromise,

  user: () => currentUser,
  isSignedIn: () => !!currentUser,
  uid: () => (currentUser ? currentUser.uid : null),

  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: String(email).trim(), password
    });
    if (error) throw error;
    return shape(data.user);
  },

  async signUp({ firstName, lastName, email, phone, password }) {
    const displayName = [firstName, lastName].filter(Boolean).join(" ").trim();
    const { data, error } = await supabase.auth.signUp({
      email: String(email).trim(),
      password,
      options: {
        /* handle_new_user() reads these when it creates the profile row. */
        data: {
          display_name: displayName,
          phone: window.KT.rules.normalizePhone(phone || "")
        },
        emailRedirectTo: absolute(window.KT.url("index.html"))
      }
    });
    if (error) throw error;
    return shape(data.user);
  },

  async signInWithGoogle() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: absolute(authService.nextUrl()) }
    });
    if (error) throw error;
    /* The browser navigates away to Google; nothing to return. */
    return null;
  },

  async resetPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(
      String(email).trim(),
      { redirectTo: absolute(window.KT.url("pages/login.html")) }
    );
    if (error) throw error;
  },

  async resendVerification() {
    if (!currentUser || !currentUser.email) return;
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: currentUser.email,
      options: { emailRedirectTo: absolute(window.KT.url("index.html")) }
    });
    if (error) throw error;
  },

  async signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  },

  /** Where to send someone after they sign in. Unchanged from V1. */
  nextUrl() {
    const next = new URLSearchParams(window.location.search).get("next");
    const routes = {
      cart: "pages/cart.html",
      account: "pages/account.html",
      orders: "pages/orders.html"
    };
    return window.KT.url(routes[next] || "index.html");
  }
};

export { errorMessage, supabase, TABLES };
