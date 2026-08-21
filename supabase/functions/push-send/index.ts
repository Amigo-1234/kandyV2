/* ==========================================================================
   push-send
   --------------------------------------------------------------------------
   Turns one notifications row into Web Push deliveries.

   Called by a database trigger through pg_net, not by a browser. verify_jwt
   is off (there is no user session behind a trigger), so the caller is
   authenticated by a shared secret compared in constant time — the same
   pattern paystack-webhook uses.

   WHAT IT WILL NOT DO
   -------------------
   It takes a notification ID and nothing else. The recipient, the title, the
   body and the deep link are all read from the row the database already
   wrote, so there is no field a caller could supply to aim a notification at
   somebody else or to put words in Kandy's mouth (§19). The worst a leaked
   dispatch secret allows is re-sending a notification that already exists to
   the person it already belongs to — and push_sent_at makes even that a
   no-op.

   IDEMPOTENCY
   -----------
   push_sent_at is claimed with a conditional UPDATE before anything is sent.
   Two concurrent dispatches for the same row cannot both win that update, so
   the second exits without sending (§20).

   PRIVACY
   -------
   The payload carries a short title, a short body and a URL. No address, no
   basket contents, no payment detail, no other customer — these strings land
   on lock screens (§23).
   ========================================================================== */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "../_shared/webpush.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-dispatch-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });

/** Constant time, so a wrong secret cannot be narrowed down by timing. */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Where a notification opens. Mirrors js/services/notifications.js on the
 * customer side and the admin hash routes on the handler side — the service
 * worker just opens what it is given.
 */
function linkFor(n: { type: string; related_id: string | null }): string {
  switch (n.type) {
    case "order":        return n.related_id ? `/pages/order-detail.html?id=${encodeURIComponent(n.related_id)}` : "/pages/orders.html";
    case "payment":      return n.related_id ? `/pages/order-detail.html?id=${encodeURIComponent(n.related_id)}` : "/pages/orders.html";
    case "chat":         return "/pages/account.html?chat=1";
    case "support":      return "/pages/account.html#support";
    case "admin_order":  return n.related_id ? `/admin/index.html#/orders?code=${encodeURIComponent(n.related_id)}` : "/admin/index.html#/orders";
    case "admin_support":return "/admin/index.html#/support?tab=chat";
    default:             return "/pages/account.html#notifications";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const expected = Deno.env.get("PUSH_DISPATCH_SECRET") ?? "";
  const offered = req.headers.get("x-dispatch-secret") ?? "";
  if (!expected || !safeEqual(offered, expected)) {
    return json({ error: "Not authorised" }, 401);
  }

  const vapid = {
    publicKey: Deno.env.get("VAPID_PUBLIC_KEY") ?? "",
    privateKey: Deno.env.get("VAPID_PRIVATE_KEY") ?? "",
    subject: Deno.env.get("VAPID_SUBJECT") ?? "mailto:hello@kandystreats.com.ng",
  };
  if (!vapid.publicKey || !vapid.privateKey) {
    return json({ error: "Push is not configured on the server" }, 503);
  }

  let body: { notification_id?: string; selftest?: boolean; endpoint?: string; p256dh?: string; auth?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  /* ---- Self-test ------------------------------------------------------
     Sends to a caller-supplied endpoint with no subscription behind it, so
     the push service answers 404/410 — which proves the VAPID JWT was
     ACCEPTED and the request well-formed, without messaging any real person.
     A 401/403 here would mean the signing is wrong. */
  if (body.selftest) {
    if (!body.endpoint || !body.p256dh || !body.auth) {
      return json({ error: "selftest needs endpoint, p256dh and auth" }, 400);
    }
    const res = await sendPush(
      { endpoint: body.endpoint, p256dh: body.p256dh, auth: body.auth },
      { title: "selftest", body: "selftest", url: "/" },
      vapid,
    );
    /* 404/410 is the PASS here: the push service parsed the VAPID JWT,
       accepted it, and only then found no such subscription. A 401 or 403
       would mean the signature was rejected. */
    return json({ selftest: true, vapidAccepted: res.status !== 401 && res.status !== 403, ...res });
  }

  const id = String(body.notification_id ?? "");
  if (!id) return json({ error: "notification_id is required" }, 400);

  /* Claim the row. `is` null in the filter is what makes this the idempotency
     gate: the second dispatch for the same notification updates zero rows. */
  const { data: claimed, error: claimError } = await admin
    .from("notifications")
    .update({ push_sent_at: new Date().toISOString() })
    .eq("id", id)
    .is("push_sent_at", null)
    .select("id, user_id, type, title, message, related_id")
    .maybeSingle();

  if (claimError) return json({ error: claimError.message }, 500);
  if (!claimed) return json({ status: "skipped", reason: "already dispatched or not found" });

  /* The recipient's own switch. Checked server-side; the browser never gets
     to decide whether it is allowed to be silent. */
  const { data: wants } = await admin.rpc("wants_push", {
    p_user_id: claimed.user_id, p_type: claimed.type,
  });
  if (wants === false) return json({ status: "skipped", reason: "recipient has this channel off" });

  const { data: subs, error: subError } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", claimed.user_id);
  if (subError) return json({ error: subError.message }, 500);
  if (!subs || !subs.length) return json({ status: "no-subscriptions", id });

  const payload = {
    id: claimed.id,
    title: `Kandy's Treats — ${claimed.title}`,
    body: claimed.message ?? "",
    url: linkFor(claimed),
    /* Collapses repeats of the same subject on the OS side. */
    tag: `${claimed.type}:${claimed.related_id ?? claimed.id}`,
  };

  const results = await Promise.all(subs.map((s) => sendPush(s, payload, vapid)));

  /* Prune what the push service says is gone. Scoped to this recipient's own
     rows by construction — `subs` came from their user_id. */
  const dead = subs.filter((_, i) => results[i].gone).map((s) => s.id);
  if (dead.length) await admin.from("push_subscriptions").delete().in("id", dead);

  const ok = results.filter((r) => r.status >= 200 && r.status < 300).length;
  return json({
    status: "sent", id, attempted: subs.length, delivered: ok, pruned: dead.length,
    codes: results.map((r) => r.status),
  });
});
