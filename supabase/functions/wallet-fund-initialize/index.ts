/* ==========================================================================
   wallet-fund-initialize
   --------------------------------------------------------------------------
   Starts a wallet top-up for the CALLER.

   Unlike an order, a top-up has no pre-existing authoritative amount — the
   customer chooses it. So the requested amount is validated and then RECORDED
   SERVER-SIDE as a funding intent before the customer ever reaches Paystack.
   Settlement later verifies the gateway's amount against that stored intent,
   which is why a forged webhook cannot credit an arbitrary figure.

   The amount is accepted from the client HERE (it is a request, not a price)
   but is never accepted again at settlement.

   MODE. Runs against whichever key PAYSTACK_SECRET_KEY holds. The sk_live_
   refusal that used to sit here was removed for launch; the amount bounds,
   the server-generated reference and the recorded intent are unchanged.
   ========================================================================== */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PAYSTACK_API, toKobo, json, CORS } from "../_shared/paystack.ts";

const MIN_FUND = 100;        // ₦100
const MAX_FUND = 1_000_000;  // ₦1,000,000 — sanity bound, not a business rule

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secretKey = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!secretKey) return json({ error: "Payment is not configured." }, 503);

  const asCaller = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );

  const { data: auth } = await asCaller.auth.getUser();
  if (!auth?.user) return json({ error: "Please sign in to top up." }, 401);

  let body: { amount?: number; callbackUrl?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const amount = Math.floor(Number(body.amount));
  if (!Number.isFinite(amount) || amount < MIN_FUND || amount > MAX_FUND) {
    return json({ error: `Enter an amount between ₦${MIN_FUND} and ₦${MAX_FUND.toLocaleString()}.` }, 400);
  }

  const reference = `KTW-${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`.toUpperCase();

  /* service_role: the intent table is not writable by customers. */
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { error: intentError } = await admin
    .from("wallet_funding_intents")
    .insert({ user_id: auth.user.id, reference, amount, currency: "NGN" });

  if (intentError) return json({ error: "Could not start the top-up." }, 500);

  const initRes = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: auth.user.email,
      amount: toKobo(amount),
      currency: "NGN",
      reference,
      callback_url: body.callbackUrl || undefined,
      /* purpose is what routes this away from order settlement in the webhook */
      metadata: { purpose: "wallet_funding", user_id: auth.user.id },
    }),
  });

  const payload = await initRes.json().catch(() => ({}));
  if (!initRes.ok || !payload?.status) {
    await admin.from("wallet_funding_intents")
      .update({ status: "failed", settled_at: new Date().toISOString() })
      .eq("reference", reference);
    return json({ error: payload?.message || "Could not start the top-up." }, 502);
  }

  return json({ checkoutUrl: payload.data.authorization_url, reference, amount }, 200);
});
