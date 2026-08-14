/* ==========================================================================
   Kandy's Treats — Firebase bootstrap
   --------------------------------------------------------------------------
   The only module that touches the Firebase SDK directly. Everything else in
   js/services/ imports from here.

   Config comes from js/config/app.js (a classic script that runs first), so
   there is exactly one place to change the project.

   Only PUBLIC identifiers appear here. Payment secret keys live in Firebase
   Secrets and are read by Cloud Functions — never by this code.
   ========================================================================== */

const cfg = window.KT.config;
const V = cfg.sdkVersion;
const CDN = `https://www.gstatic.com/firebasejs/${V}`;

const [appMod, authMod, storeMod, fnMod] = await Promise.all([
  import(`${CDN}/firebase-app.js`),
  import(`${CDN}/firebase-auth.js`),
  import(`${CDN}/firebase-firestore.js`),
  import(`${CDN}/firebase-functions.js`)
]);

export const app = appMod.getApps().length
  ? appMod.getApp()
  : appMod.initializeApp(cfg.firebase);

export const auth = authMod.getAuth(app);
export const db = storeMod.getFirestore(app);
export const functions = fnMod.getFunctions(app, cfg.functionsRegion);

export const fb = { ...authMod, ...storeMod, ...fnMod };
export const COLLECTIONS = cfg.collections;

/** Wrap a callable so every caller gets `.data` and consistent errors. */
export function callable(name) {
  const fn = fnMod.httpsCallable(functions, name);
  return async (payload) => (await fn(payload || {})).data;
}

/* Callable failures that mean "the function never ran", as opposed to "the
   function ran and refused". Only the first kind is safe to retry as a direct
   Firestore write: firestore.rules re-check ownership there, so the fallback
   cannot widen access. A permission-denied or unauthenticated is a real answer
   and must surface instead of silently taking the other path.

   This project has NO Cloud Functions deployed — Cloud Billing (Blaze) is not
   enabled on kandystreat-840b1 — so in practice every callable lands here. */
const TRANSPORT_FAILURES = [
  "not-found",           /* no function deployed under that name */
  "internal",            /* cold-start crash, emulator not running */
  "unavailable",         /* offline, DNS, blocked origin */
  "deadline-exceeded",
  "failed-precondition",
  "cancelled",
  "resource-exhausted",
  "aborted"
];

/** @param {any} error @returns {boolean} */
export function callableNeverRan(error) {
  const code = String((error && error.code) || "").toLowerCase();
  /* A CORS or network rejection arrives as an opaque error with no code. */
  if (!code) return true;
  return TRANSPORT_FAILURES.some((c) => code.includes(c));
}

/**
 * Turn a Firebase error into something a customer can act on.
 * Cloud Function HttpsErrors already carry a written message — prefer it.
 */
export function errorMessage(error) {
  if (!error) return "Something went wrong. Please try again.";
  const code = String(error.code || "");

  if (code.includes("unauthenticated")) return "Please sign in to continue.";
  if (code.includes("permission-denied")) return "You do not have access to that.";
  if (code.includes("unavailable") || code.includes("network")) {
    return "We could not reach Kandy's. Check your connection and try again.";
  }
  if (code.includes("email-already-in-use")) return "That email already has an account. Sign in instead.";
  if (code.includes("invalid-email")) return "That email address does not look right.";
  if (code.includes("weak-password")) return "Use at least 6 characters for your password.";
  if (code.includes("wrong-password") || code.includes("invalid-credential")) {
    return "Email or password is incorrect.";
  }
  if (code.includes("too-many-requests")) return "Too many attempts. Wait a moment and try again.";
  if (code.includes("popup-closed-by-user")) return "Sign-in was cancelled.";

  return error.message || "Something went wrong. Please try again.";
}
