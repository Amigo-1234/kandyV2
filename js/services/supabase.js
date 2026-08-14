/* ==========================================================================
   Kandy's Treats — Supabase bootstrap
   --------------------------------------------------------------------------
   The only module that touches the Supabase SDK directly. Everything else in
   js/services/ imports from here, exactly as it used to import firebase.js.

   Config comes from js/config/app.js (a classic script that runs first), so
   there is one place to change the project.

   Only the PUBLISHABLE anon key appears here. Every table is protected by Row
   Level Security, so this key grants no access to another customer's data.
   The service_role key never appears in client code.
   ========================================================================== */

const cfg = window.KT.config;
const CDN = `https://esm.sh/@supabase/supabase-js@${cfg.supabaseSdkVersion}`;

const { createClient } = await import(CDN);

export const supabase = createClient(cfg.supabase.url, cfg.supabase.anonKey, {
  auth: {
    /* Persistent sessions: the SDK keeps the session in localStorage and
       refreshes it silently, which is what keeps a customer signed in across
       reloads without us managing tokens by hand. */
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

export const TABLES = {
  profiles: "profiles",
  addresses: "addresses",
  menuItems: "menu_items",
  categories: "categories",
  quickPicks: "quick_picks",
  quickPickItems: "quick_pick_items",
  announcements: "announcements",
  orders: "orders",
  orderItems: "order_items",
  orderStatusHistory: "order_status_history",
  wallets: "wallets",
  walletTransactions: "wallet_transactions",
  favourites: "favourites",
  reviews: "reviews",
  notifications: "notifications",
  supportTickets: "support_tickets",
  contactMessages: "contact_messages",
  coupons: "coupons"
};

/**
 * Turn a Supabase/Postgres error into something a customer can read.
 * Mirrors the Firebase errorMessage() contract so callers need no changes.
 */
export function errorMessage(error) {
  if (!error) return "Something went wrong. Please try again.";

  const code = String(error.code || "");
  const msg = String(error.message || "");
  const lower = msg.toLowerCase();

  /* ---- Auth ---------------------------------------------------------- */
  if (lower.includes("invalid login credentials")) return "Email or password is incorrect.";
  if (lower.includes("email not confirmed")) {
    return "Please confirm your email address first — check your inbox.";
  }
  if (lower.includes("user already registered") || code === "user_already_exists") {
    return "That email already has an account. Sign in instead.";
  }
  if (lower.includes("password should be at least")) {
    return "Use at least 6 characters for your password.";
  }
  if (lower.includes("unable to validate email") || lower.includes("invalid email")) {
    return "That email address does not look right.";
  }
  if (lower.includes("for security purposes") || lower.includes("rate limit") ||
      code === "over_email_send_rate_limit") {
    return "Too many attempts. Wait a moment and try again.";
  }
  if (lower.includes("provider is not enabled")) {
    return "That sign-in method is not enabled yet.";
  }
  if (lower.includes("popup") && lower.includes("closed")) return "Sign-in was cancelled.";

  /* ---- Postgres / RLS ------------------------------------------------ */
  if (code === "42501" || lower.includes("row-level security") ||
      lower.includes("permission denied")) {
    return "You do not have access to that.";
  }
  if (code === "23505") return "That already exists.";
  if (code === "23503") return "That refers to something that no longer exists.";
  if (code === "PGRST116") return "We could not find that.";

  /* ---- Transport ----------------------------------------------------- */
  if (lower.includes("failed to fetch") || lower.includes("networkerror") ||
      lower.includes("load failed")) {
    return "We could not reach Kandy's. Check your connection and try again.";
  }

  return msg || "Something went wrong. Please try again.";
}
