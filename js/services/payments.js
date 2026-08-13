/* ==========================================================================
   Kandy's Treats — Payments (Paystack & Flutterwave)
   --------------------------------------------------------------------------
   Reuses V1's proven server-side flow rather than inventing a new one:

     createGatewayPayment  → server initialises the transaction with the SECRET
                             key and returns a hosted checkout URL
     (customer pays on the gateway's own page — no card data touches this site)
     verifyGatewayPayment  → server verifies with the gateway before the order
                             is ever marked paid
     recordGatewayPaymentEvent → records cancelled/failed returns

   Signed webhooks (paystackWebhook / flutterwaveWebhook) confirm payment even
   if the customer closes the tab, and are idempotent.

   NO SECRET KEY EVER APPEARS HERE. Public keys are only used for the
   fallback checkout, which cannot mark an order paid by itself.
   ========================================================================== */

import { callable } from "./firebase.js";

const createGatewayPayment = callable("createGatewayPayment");
const verifyGatewayPayment = callable("verifyGatewayPayment");
const recordGatewayPaymentEvent = callable("recordGatewayPaymentEvent");
const getPaymentConfigurationStatus = callable("getPaymentConfigurationStatus");

export const PROVIDERS = [
  { id: "paystack", name: "Paystack", blurb: "Card, bank transfer, USSD" },
  { id: "flutterwave", name: "Flutterwave", blurb: "Card, bank transfer, mobile money" }
];

export const paymentService = {
  PROVIDERS,

  /** Which gateways actually have their secrets configured. */
  async status() {
    try {
      return await getPaymentConfigurationStatus({});
    } catch {
      return { paystack: false, flutterwave: false };
    }
  },

  /**
   * Start a payment and hand the customer to the gateway's hosted page.
   * @param {string} orderId
   * @param {'paystack'|'flutterwave'} provider
   */
  async start(orderId, provider) {
    const callbackUrl = new URL(
      window.KT.url("pages/order-detail.html"),
      window.location.origin
    );
    callbackUrl.searchParams.set("id", orderId);
    callbackUrl.searchParams.set("verify", provider);

    const result = await createGatewayPayment({
      orderId,
      provider,
      callbackUrl: callbackUrl.href
    });

    if (!result || !result.checkoutUrl) {
      throw new Error("The payment gateway did not return a checkout link.");
    }
    window.location.href = result.checkoutUrl;
    return result;
  },

  /**
   * Called when the customer returns from the gateway. The server is the one
   * that talks to Paystack/Flutterwave — this only reports the outcome.
   */
  async verify({ orderId, provider, reference, transactionId }) {
    return verifyGatewayPayment({ orderId, provider, reference, transactionId });
  },

  async recordFailure({ orderId, provider, reference, status, reason }) {
    try {
      await recordGatewayPaymentEvent({ orderId, provider, reference, status, reason });
    } catch { /* best effort — the webhook is the real safety net */ }
  },

  /** Read the gateway's return parameters out of the current URL. */
  readReturn() {
    const q = new URLSearchParams(window.location.search);
    const provider = q.get("verify");
    if (!provider) return null;
    return {
      provider,
      orderId: q.get("id") || "",
      reference: q.get("reference") || q.get("trxref") || q.get("tx_ref") || "",
      transactionId: q.get("transaction_id") || "",
      status: (q.get("status") || "").toLowerCase()
    };
  }
};
