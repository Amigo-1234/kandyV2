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

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
