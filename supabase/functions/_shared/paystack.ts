/* Shared Paystack helpers. Nothing here ever reaches the browser. */

export const PAYSTACK_API = "https://api.paystack.co";

/** Naira (major units) -> kobo (minor units) that Paystack expects. */
export const toKobo = (naira: number) => Math.round(Number(naira) * 100);
/** Kobo -> naira, for comparing against orders.total. */
export const toNaira = (kobo: number) => Math.round(Number(kobo) / 100);

/**
 * Constant-time comparison. V1 used `hash !== signature`, whose early exit
 * leaks how many leading bytes matched. Length is compared first because the
 * loop below requires equal lengths to be meaningful.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HMAC-SHA512 of the RAW body, hex encoded — Paystack's signature scheme. */
export async function hmacSha512Hex(secret: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * CORS headers belong on EVERY response, not just the preflight. Without them
 * the browser blocks the reply and supabase-js reports the opaque
 * "Failed to send a request to the Edge Function", which looks like the
 * function is down rather than like a header problem.
 */
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

/**
 * The amount, in naira, to settle an ORDER payment against.
 *
 * Default: the gross `data.amount` Paystack charged — today's behaviour, and
 * all that is ever needed while Kandy's absorbs Paystack's fee.
 *
 * When the Paystack account passes its transaction fee to the customer, the
 * signed `amount` is the order total PLUS Paystack's fee, and the signed
 * `requested_amount` is exactly what paystack-initialize asked for (the
 * server-priced order total). Only then is `requested_amount` used — and
 * only when every one of these holds on the HMAC-verified payload:
 *
 *   - event charge.success, status success, currency NGN
 *   - metadata.order_code is this order, the reference is KT-<that code>-…,
 *     and metadata.user_id is present (the database then requires it to be
 *     the order's owner — migration 0079)
 *   - amount, requested_amount and fees are whole kobo; requested_amount is
 *     positive and whole naira (initialize only ever asks for whole naira)
 *   - amount > requested_amount            (never an underpayment)
 *   - amount − requested_amount ≤ fees     (the extra is Paystack's own
 *                                            signed fee — never an arbitrary
 *                                            overpayment)
 *
 * Anything else falls back to the gross amount, which settle_order_payment
 * refuses unless it equals the order total exactly. That exact check stays
 * the final authority in every case: this function can only choose which of
 * Paystack's two signed figures is offered to it.
 */
export function orderSettlementNaira(
  event: any,
  orderCode: string,
): { amount: number; basis: "charged" | "requested" } {
  const d = event?.data ?? {};
  const gross = { amount: toNaira(d?.amount ?? 0), basis: "charged" as const };

  const charged = Number(d?.amount);
  const requested = Number(d?.requested_amount);
  const fees = Number(d?.fees);
  if (d?.requested_amount == null || d?.fees == null) return gross;
  if (!Number.isSafeInteger(charged) || !Number.isSafeInteger(requested) || !Number.isSafeInteger(fees)) return gross;
  if (requested <= 0 || requested % 100 !== 0 || fees < 0) return gross;
  if (charged <= requested) return gross;
  if (charged - requested > fees) return gross;

  if (event?.event !== "charge.success" || d?.status !== "success") return gross;
  if (String(d?.currency ?? "").toUpperCase() !== "NGN") return gross;
  const code = String(orderCode ?? "");
  if (!code || String(d?.metadata?.order_code ?? "") !== code) return gross;
  if (!String(d?.reference ?? "").startsWith(`KT-${code}-`)) return gross;
  if (!String(d?.metadata?.user_id ?? "")) return gross;

  return { amount: requested / 100, basis: "requested" };
}
