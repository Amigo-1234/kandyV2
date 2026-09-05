/* ==========================================================================
   paystack-initialize
   --------------------------------------------------------------------------
   Starts a payment for an order the CALLER owns.

   The client sends an order CODE and nothing else. Every figure that reaches
   Paystack is read from the database here: the caller cannot propose an
   amount, and there is no parameter through which one could be smuggled.

   Requires a valid customer JWT (verify_jwt defaults to true).

   MODE. This runs against whichever key PAYSTACK_SECRET_KEY holds — test or
   live. It used to refuse an sk_live_ key outright, as a guard against a
   mis-pasted production key taking real money on the first click. That guard
   was removed deliberately for launch. Nothing else about the flow changed:
   the amount still comes from the database, the reference is still generated
   here, and the caller still cannot reach an order they do not own.
   ========================================================================== */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PAYSTACK_API, toKobo, json, CORS } from "../_shared/paystack.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secretKey = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!secretKey) return json({ error: "Payment is not configured." }, 503);

  const authHeader = req.headers.get("Authorization") ?? "";

  /* Anon client bound to the CALLER's JWT: RLS applies, so this can only ever
     see the caller's own orders. */
  const asCaller = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: auth } = await asCaller.auth.getUser();
  if (!auth?.user) return json({ error: "Please sign in to pay." }, 401);

  let body: { orderCode?: string; callbackUrl?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const orderCode = String(body.orderCode ?? "").trim();
  if (!orderCode) return json({ error: "Order code is required." }, 400);

  /* RLS scopes this to the caller. A foreign order simply is not found. */
  const { data: order, error } = await asCaller
    .from("orders")
    .select("id, code, total, paid, payment_status, user_id")
    .eq("code", orderCode)
    .maybeSingle();

  if (error) return json({ error: "Could not read that order." }, 400);
  if (!order) return json({ error: "Order not found." }, 404);
  if (order.paid) return json({ error: "That order is already paid." }, 409);
  if (!order.total || order.total <= 0) return json({ error: "That order has no payable total." }, 400);

  /* Reference is generated here, never supplied by the client. */
  const reference = `KT-${order.code}-${crypto.randomUUID().slice(0, 8)}`.toUpperCase();

  const initRes = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: auth.user.email,
      amount: toKobo(order.total),          // <- from the DB, not the client
      currency: "NGN",
      reference,
      callback_url: body.callbackUrl || undefined,
      metadata: { order_code: order.code, user_id: order.user_id },
    }),
  });

  const payload = await initRes.json().catch(() => ({}));
  if (!initRes.ok || !payload?.status) {
    return json({ error: payload?.message || "Could not start the payment." }, 502);
  }

  return json({
    checkoutUrl: payload.data.authorization_url,
    reference: payload.data.reference,
    amount: order.total,
  }, 200);
});
