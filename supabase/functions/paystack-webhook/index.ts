/* ==========================================================================
   paystack-webhook  —  THE authoritative settlement path
   --------------------------------------------------------------------------
   Paystack signs the raw body with HMAC-SHA512 using the secret key. We
   recompute it over the bytes exactly as received (never over a re-serialised
   object, which would change the signature) and compare in constant time.

   An unsigned or wrongly-signed request is rejected before anything is read
   from it. Everything after verification is delegated to
   settle_order_payment(), which re-checks the amount against the order total
   and is idempotent, so a replay changes nothing.

   verify_jwt = false: Paystack has no Supabase JWT. The HMAC IS the auth.
   ========================================================================== */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { hmacSha512Hex, timingSafeEqualHex, toNaira, json } from "../_shared/paystack.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secretKey = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!secretKey) return json({ error: "not configured" }, 503);

  /* Read the RAW body. Re-serialising would produce a different signature. */
  const raw = await req.text();
  const signature = req.headers.get("x-paystack-signature") ?? "";

  const expected = await hmacSha512Hex(secretKey, raw);
  if (!timingSafeEqualHex(expected, signature)) {
    /* Deliberately terse: never tell an attacker which part failed. */
    return json({ error: "Invalid signature" }, 401);
  }

  let event: any;
  try { event = JSON.parse(raw); } catch { return json({ error: "Invalid payload" }, 400); }

  const data = event?.data ?? {};
  const orderCode = String(data?.metadata?.order_code ?? "").trim();
  const reference = String(data?.reference ?? "").trim();

  /* Acknowledge events we do not settle, so Paystack stops retrying them. */
  if (!orderCode || !reference) return json({ received: true, ignored: "no order metadata" }, 200);

  const gatewayStatus =
    event?.event === "charge.success" && data?.status === "success" ? "success" : (data?.status ?? "failed");

  /* service_role: the ONLY caller permitted to execute the settlement RPC. */
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: result, error } = await admin.rpc("settle_order_payment", {
    p_order_code: orderCode,
    p_provider: "paystack",
    p_reference: reference,
    p_amount: toNaira(data?.amount ?? 0),     // verified against orders.total inside
    p_currency: String(data?.currency ?? "NGN"),
    p_gateway_status: gatewayStatus,
    p_source: "webhook",
    p_raw: event,
  });

  if (error) {
    /* An amount mismatch raises here. 200 on purpose: the payload is
       authentic and retrying cannot fix it, and the attempt is already
       recorded in payment_events with status 'mismatch'. */
    console.error("settlement refused", { orderCode, reference, message: error.message });
    return json({ received: true, settled: false, reason: error.message }, 200);
  }

  return json({ received: true, ...result }, 200);
});
