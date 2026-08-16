/* ==========================================================================
   Kandy's Treats — Payments (Paystack via Supabase Edge Functions)
   --------------------------------------------------------------------------
   Paystack only. Flutterwave is gone from the active architecture.

   The browser's entire role is: "start payment for order KD-…", then read
   back whether the order became paid. It never sees an amount it can alter,
   never holds a Paystack credential (we use the hosted checkout redirect, not
   Inline, so not even the public key is needed here), and cannot settle
   anything.

   verify() deliberately does NOT confirm payment. Returning from Paystack
   proves only that a browser came back to our URL — a customer can reach that
   URL by hand. It polls the order row instead, which only the webhook can
   flip. If the webhook has not landed yet the honest answer is "pending", and
   the order page keeps its live subscription open to catch it.
   ========================================================================== */

import { supabase, TABLES, errorMessage } from "./supabase.js";
import { authService } from "./auth.js";

export const PROVIDERS = [
  { id: "paystack", name: "Paystack", blurb: "Card, bank transfer or USSD" }
];

/** How long to wait for the webhook after the customer returns. */
const POLL_ATTEMPTS = 8;
const POLL_DELAY_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readOrderPaymentState(orderCode) {
  const { data, error } = await supabase
    .from(TABLES.orders)
    .select("code, paid, payment_status, payment_ref, total")
    .eq("code", orderCode)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export const paymentService = {
  PROVIDERS,

  /**
   * Which gateways are usable. The secret lives in Edge Function config, so
   * the browser cannot inspect it; an unconfigured key surfaces as a readable
   * error from start() rather than a silently dead button.
   */
  async status() {
    return { paystack: true, flutterwave: false };
  },

  /**
   * Hand off to Paystack. The Edge Function reads the amount from the order
   * row — this call carries an order code and nothing else.
   */
  async start(orderCode, provider = "paystack") {
    if (provider !== "paystack") {
      throw new Error("That payment method is not available.");
    }
    if (!authService.isSignedIn()) {
      throw new Error("Please sign in to pay.");
    }

    const callbackUrl = new URL(
      window.KT.url("pages/order-detail.html"),
      window.location.origin
    );
    callbackUrl.searchParams.set("id", orderCode);
    callbackUrl.searchParams.set("verify", "paystack");

    const { data, error } = await supabase.functions.invoke("paystack-initialize", {
      body: { orderCode, callbackUrl: callbackUrl.href }
    });

    if (error) {
      /* Edge Function errors arrive as a Response we must read for the body. */
      let message = "Could not start the payment.";
      try {
        const body = await error.context?.json?.();
        if (body && body.error) message = body.error;
      } catch { /* keep the default */ }
      throw new Error(message);
    }
    if (!data || !data.checkoutUrl) throw new Error("Could not start the payment.");

    window.location.href = data.checkoutUrl;
    return data;
  },

  /**
   * Called after the redirect back. NOT proof of payment — it polls the order
   * row, which only the webhook can change.
   */
  async verify({ orderId }) {
    const code = String(orderId || "");
    if (!code) throw new Error("Missing order reference.");

    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      const row = await readOrderPaymentState(code);
      if (!row) throw new Error("Order not found.");
      if (row.paid) return { status: "paid", orderId: code, amount: row.total };
      if (row.payment_status === "failed" || row.payment_status === "cancelled") {
        return { status: row.payment_status, orderId: code };
      }
      if (attempt < POLL_ATTEMPTS - 1) await sleep(POLL_DELAY_MS);
    }

    /* Not a failure — the webhook may still be in flight. */
    return { status: "pending", orderId: code };
  },

  /**
   * The webhook records authentic failures with the gateway's own payload;
   * a browser claim of failure is not evidence, so nothing is written here.
   */
  async recordFailure() {
    return { recorded: false };
  },

  /** Parse the return leg: ?id=…&verify=paystack&reference=… */
  readReturn() {
    const q = new URLSearchParams(window.location.search);
    const provider = q.get("verify");
    if (!provider) return null;
    return {
      orderId: q.get("id") || "",
      provider,
      reference: q.get("reference") || q.get("trxref") || "",
      status: q.get("status") || ""
    };
  }
};

export { errorMessage };
