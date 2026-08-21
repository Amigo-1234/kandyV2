/* ==========================================================================
   Kandy's Treats — Web Push subscription
   --------------------------------------------------------------------------
   Registers the one service worker, asks the browser for a push subscription,
   and hands the endpoint to the database. That is all it does — it never
   decides who gets notified or what a notification says, because the browser
   is not allowed to decide either of those things.

   The public VAPID key lives in js/config/app.js and is safe there: it is the
   half of the keypair the browser is *supposed* to hold, exactly like the
   Supabase anon key. The private half exists only as a Supabase Edge Function
   secret and is what actually authorises a send.

   PERMISSION IS NOT REQUESTED HERE ON LOAD
   ----------------------------------------
   Nothing in this module runs on its own. A page has to call enable(), and
   the UI only offers that behind a deliberate press (§6). A permission prompt
   fired at page load is the fastest way to get permanently blocked, and a
   blocked customer cannot be un-blocked by us.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";
import { authService } from "./auth.js";

const SW_URL = "/sw.js";
const SW_SCOPE = "/";

function vapidKey() {
  const cfg = window.KT.config.push || {};
  return cfg.publicKey || "";
}

/** base64url -> the Uint8Array applicationServerKey wants. */
function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function keyToB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Every reason push might be unavailable, told apart — because the honest
 * answer to the customer is different in each case, and "it did not work" is
 * not one of them.
 */
export function support() {
  const hasSW = "serviceWorker" in navigator;
  const hasPush = "PushManager" in window;
  const hasNotification = "Notification" in window;
  const secure = window.isSecureContext;
  /*
     iOS/iPadOS only expose push to a Home Screen web app: Safari there
     reports PushManager but subscribing throws unless standalone.

     iPadOS 13+ reports platform "MacIntel", so touch points are the only
     tell — but that pair alone false-positives on any Chromium build with
     touch emulation on, and suppressing the Enable button on a desktop that
     can actually receive push is worse than the problem it solves. The third
     clause requires a WebKit-flavoured UA: real iOS never carries "Chrome",
     "Chromium" or "Electron", and every browser on iOS is WebKit underneath.
  */
  const webkitOnly = !/Chrome|Chromium|Electron|Android/.test(navigator.userAgent);
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1 && webkitOnly);
  const standalone = window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  let reason = null;
  if (!secure) reason = "insecure";
  else if (!hasSW || !hasPush || !hasNotification) reason = "unsupported";
  else if (iOS && !standalone) reason = "ios-needs-install";

  return {
    supported: !reason,
    reason,
    iOS,
    standalone,
    permission: hasNotification ? Notification.permission : "unsupported"
  };
}

let registration = null;

/** Idempotent: repeated calls return the same registration. */
export async function ensureServiceWorker() {
  if (registration) return registration;
  if (!("serviceWorker" in navigator)) return null;
  registration = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  await navigator.serviceWorker.ready;
  return registration;
}

export const pushService = {
  support,
  ensureServiceWorker,

  /** The current browser-level subscription, if any. */
  async current() {
    if (!support().supported) return null;
    const reg = await ensureServiceWorker();
    if (!reg) return null;
    return reg.pushManager.getSubscription();
  },

  async isEnabled() {
    return !!(await pushService.current());
  },

  /**
   * Ask for permission, subscribe, and store the endpoint against the signed-in
   * account. Returns a result object rather than throwing for the ordinary
   * "no" answers, because a refusal is not an error — the site keeps working
   * and the in-app bell is unaffected.
   */
  async enable() {
    const s = support();
    if (!s.supported) return { ok: false, reason: s.reason };
    if (!authService.uid()) return { ok: false, reason: "signed-out" };
    if (!vapidKey()) return { ok: false, reason: "not-configured" };

    if (Notification.permission === "denied") return { ok: false, reason: "blocked" };

    if (Notification.permission !== "granted") {
      const asked = await Notification.requestPermission();
      if (asked !== "granted") return { ok: false, reason: asked === "denied" ? "blocked" : "dismissed" };
    }

    const reg = await ensureServiceWorker();
    if (!reg) return { ok: false, reason: "unsupported" };

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey())
        });
      } catch (error) {
        /* Chrome throws AbortError when the browser itself has push disabled
           (embedded browsers, some enterprise policies) — distinct from the
           user saying no. */
        return { ok: false, reason: "subscribe-failed", detail: String(error.message || error) };
      }
    }
    return pushService.register(sub);
  },

  /** Hand an existing subscription to the database. */
  async register(sub) {
    const json = sub.toJSON ? sub.toJSON() : sub;
    const keys = json.keys || {};
    const p256dh = keys.p256dh || keyToB64(sub.getKey && sub.getKey("p256dh"));
    const auth = keys.auth || keyToB64(sub.getKey && sub.getKey("auth"));

    const { data, error } = await supabase.rpc("register_push_subscription", {
      p_endpoint: json.endpoint || sub.endpoint,
      p_p256dh: p256dh,
      p_auth: auth,
      p_user_agent: navigator.userAgent
    });
    if (error) return { ok: false, reason: "store-failed", detail: error.message };
    return { ok: true, id: data && data.id };
  },

  /** Unsubscribe this browser and forget it server-side. */
  async disable() {
    const sub = await pushService.current();
    if (!sub) return { ok: true };
    const endpoint = sub.endpoint;
    try { await sub.unsubscribe(); } catch (_) { /* already gone */ }
    const { error } = await supabase.rpc("unregister_push_subscription", { p_endpoint: endpoint });
    if (error) return { ok: false, reason: "store-failed", detail: error.message };
    return { ok: true };
  },

  /** Devices registered to the signed-in account. Never anybody else's. */
  async devices() {
    const { data, error } = await supabase.rpc("my_push_subscriptions");
    if (error) throw error;
    return data || [];
  },

  /* ---- Preferences ----------------------------------------------------- */

  async preferences() {
    const uid = authService.uid();
    if (!uid) return null;
    const { data, error } = await supabase
      .from("notification_preferences")
      .select("push_orders, push_support, push_marketing, email_orders, sound_new_order")
      .eq("user_id", uid)
      .maybeSingle();
    if (error) throw error;
    /* No row means everything is on — the same default the server applies in
       wants_push(), stated once on each side rather than inferred. */
    return data || {
      push_orders: true, push_support: true, push_marketing: true,
      email_orders: true, sound_new_order: true
    };
  },

  /**
   * One RPC rather than an upsert. An upsert on this table needs UPDATE on
   * user_id — the one column that must never be writable, since writing it
   * is how a row would change owner. The function writes only the caller's
   * own row and stamps updated_at itself; nulls mean "leave that switch
   * alone", so a single toggle does not have to send the other four back.
   */
  async savePreferences(patch) {
    if (!authService.uid()) throw new Error("Please sign in.");
    const p = patch || {};
    const { data, error } = await supabase.rpc("set_notification_preferences", {
      p_push_orders: "push_orders" in p ? p.push_orders : null,
      p_push_support: "push_support" in p ? p.push_support : null,
      p_push_marketing: "push_marketing" in p ? p.push_marketing : null,
      p_email_orders: "email_orders" in p ? p.email_orders : null,
      p_sound_new_order: "sound_new_order" in p ? p.sound_new_order : null
    });
    if (error) throw error;
    return data;
  },

  /**
   * The service worker asks for this when a push service rotates the
   * subscription behind our back. Wired once, by the bell component.
   */
  listenForResubscribe() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.addEventListener("message", async (event) => {
      if (!event.data || event.data.type !== "kt:push-resubscribe") return;
      if (!authService.uid()) return;
      const sub = await pushService.current();
      if (sub) pushService.register(sub).catch(() => {});
      else pushService.enable().catch(() => {});
    });
  }
};

export { errorMessage };
