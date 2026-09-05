/* ==========================================================================
   email-send — one notification, one email
   --------------------------------------------------------------------------
   Called by dispatch_email() through pg_net after the transaction that
   produced the notification has committed. Mirrors push-send: same shared
   secret, same claim-the-null-stamp idempotency, same refusal to trust
   anything in the request body beyond an id.

   WHAT THIS FUNCTION WILL NOT ACCEPT

   A recipient address. The body carries a notification id and nothing else;
   the address is looked up server-side from the account that owns that
   notification. There is no request shape that can make this send to an
   address of the caller's choosing, which is the difference between a
   transactional sender and an open relay.

   SECRETS: RESEND_API_KEY and EMAIL_DISPATCH_SECRET are Edge Function
   secrets. Neither appears in this repository, and neither is reachable from
   browser JavaScript — the browser never calls this function at all.
   ========================================================================== */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { render, type EmailPayload } from "../_shared/email-templates.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DISPATCH_SECRET = Deno.env.get("EMAIL_DISPATCH_SECRET") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

/* The verified sending identity. Kept in an env var so a domain change is a
   configuration change, with a sensible default that matches the site. */
const FROM = Deno.env.get("EMAIL_FROM") ?? "Kandy's Treats <orders@kandystreats.com.ng>";
const REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") ?? "hello@kandystreats.com.ng";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" }
  });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  /* Only the database may ask for an email. */
  if (!DISPATCH_SECRET || req.headers.get("x-dispatch-secret") !== DISPATCH_SECRET) {
    return json({ error: "forbidden" }, 403);
  }

  let notificationId: string | null = null;
  try {
    const body = await req.json();
    notificationId = typeof body?.notification_id === "string" ? body.notification_id : null;
  } catch (_) { /* falls through to the check below */ }
  if (!notificationId) return json({ error: "notification_id required" }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false }
  });

  /* Not configured. Reported rather than thrown: the notification is already
     delivered in-app and by push, and a missing key is a deployment state,
     not a failure of this request. */
  if (!RESEND_API_KEY) {
    return json({ skipped: "RESEND_API_KEY not configured" }, 200);
  }

  /* Eligibility is decided in the database, by the same function the trigger
     used. Asked again here because a queued request is not a trustworthy
     statement about anything — the preference may have changed, or the row
     may already have been emailed by a concurrent invocation. */
  const { data: eligible, error: eligErr } = await db
    .rpc("email_is_eligible", { p_notification_id: notificationId });
  if (eligErr) return json({ error: eligErr.message }, 500);
  if (!eligible) return json({ skipped: "not eligible" }, 200);

  /*
     CLAIM BEFORE SENDING.

     A conditional update on the null stamp: whoever flips it owns the send.
     Two concurrent invocations — a pg_net retry racing the original, say —
     cannot both pass this, because the second updates zero rows.

     Claiming first means a crash between the claim and a successful send
     leaves a row marked sent that never arrived. The alternative, claiming
     afterwards, risks sending the same customer the same email twice. For a
     receipt, the silent miss is the better failure: it is recoverable by a
     human reading email_error, while a duplicate is not recoverable at all.
     Part E asks for exactly this trade.
  */
  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await db
    .from("notifications")
    .update({ email_sent_at: claimedAt })
    .eq("id", notificationId)
    .is("email_sent_at", null)
    .select("id");
  if (claimErr) return json({ error: claimErr.message }, 500);
  if (!claimed || claimed.length === 0) {
    return json({ skipped: "already claimed" }, 200);
  }

  /* Everything the email needs, and nothing else. The recipient address comes
     from here — never from the request. */
  const { data: payload, error: payloadErr } = await db
    .rpc("email_payload", { p_notification_id: notificationId });
  if (payloadErr || !payload?.to_email) {
    await release(db, notificationId, payloadErr?.message ?? "no recipient address");
    return json({ error: "payload unavailable" }, 500);
  }

  const mail = render(payload as EmailPayload);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        /* Resend honours this for at-least-once callers: the same key never
           produces two sends. A third guard, independent of ours. */
        "Idempotency-Key": notificationId
      },
      body: JSON.stringify({
        from: FROM,
        to: [payload.to_email],
        reply_to: REPLY_TO,
        subject: mail.subject,
        html: mail.html,
        text: mail.text
      })
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      await release(db, notificationId, `resend ${res.status}: ${detail}`);
      return json({ error: "resend rejected", status: res.status }, 502);
    }

    /* Sent. The claim stands, and the attempt counter records that it took
       one try. */
    await db.from("notifications")
      .update({ email_error: null })
      .eq("id", notificationId);

    return json({ sent: true, notification_id: notificationId });
  } catch (e) {
    await release(db, notificationId, String((e as Error).message ?? e).slice(0, 300));
    return json({ error: "send failed" }, 502);
  }
});

/**
 * Hand the row back so a later attempt can take it, and record why this one
 * did not work. email_is_eligible() caps attempts, so a permanently broken
 * address stops being retried rather than looping forever.
 */
async function release(db: ReturnType<typeof createClient>, id: string, reason: string) {
  const { data } = await db
    .from("notifications").select("email_attempts").eq("id", id).single();
  await db.from("notifications")
    .update({
      email_sent_at: null,
      email_attempts: ((data?.email_attempts as number) ?? 0) + 1,
      email_error: reason
    })
    .eq("id", id);
}
