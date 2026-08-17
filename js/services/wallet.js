/* ==========================================================================
   Kandy's Treats — Kandy's wallet (Supabase)
   --------------------------------------------------------------------------
   The browser can READ a balance and never write one. `authenticated` holds
   SELECT and nothing else on wallets and wallet_transactions — there is no
   UPDATE grant to exploit, so "balance = 100000" is not a request the database
   will even parse from a customer.

   Balance moves through exactly two server-side paths:
     credit — settle_wallet_funding(), service_role only, reached from the
              Paystack webhook. Verifies the gateway amount against an intent
              recorded BEFORE the customer paid.
     debit  — pay_order_from_wallet(), customer-callable but it reads the
              amount from orders.total; the caller supplies only an order code.

   available_balance is a GENERATED column (balance - locked_balance), so it
   cannot drift out of step with the ledger.
   ========================================================================== */

import { supabase, TABLES, errorMessage } from "./supabase.js";
import { authService } from "./auth.js";

const EMPTY = { balance: 0, availableBalance: 0, lockedBalance: 0,
                currency: "NGN", status: "active" };

function toUI(row) {
  if (!row) return { ...EMPTY };
  return {
    balance: Number(row.balance) || 0,
    availableBalance: Number(row.available_balance ?? row.balance) || 0,
    lockedBalance: Number(row.locked_balance) || 0,
    currency: row.currency || "NGN",
    status: row.status || "active"
  };
}

export const walletService = {
  async get() {
    const uid = authService.uid();
    if (!uid) return { ...EMPTY };
    const { data, error } = await supabase
      .from(TABLES.wallets)
      .select("balance, available_balance, locked_balance, currency, status")
      .eq("user_id", uid)
      .maybeSingle();
    if (error) throw error;
    return toUI(data);
  },

  /** Live balance for the account page. Returns an unsubscribe function. */
  watch(onChange) {
    const uid = authService.uid();
    if (!uid) return () => {};

    const channel = supabase
      .channel(`wallet:${uid}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "wallets", filter: `user_id=eq.${uid}` },
        (payload) => onChange(toUI(payload.new)))
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  },

  async transactions({ limit = 20 } = {}) {
    const uid = authService.uid();
    if (!uid) return [];
    const { data, error } = await supabase
      .from(TABLES.walletTransactions)
      .select("id, type, reason, amount, balance_after, reference, order_id, description, created_at")
      .eq("user_id", uid)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;

    /* The account page renders tx.direction / tx.title / tx.provider /
       tx.status — the shape the Firestore version returned. Keep it exactly,
       or "Wallet activity" renders a row of undefined. The Postgres columns
       are mapped onto it rather than replacing it. */
    const TITLES = {
      funding: "Wallet top-up",
      order_payment: "Order payment",
      refund: "Refund",
      adjustment: "Adjustment"
    };

    return (data || []).map((t) => ({
      id: t.id,
      title: TITLES[t.reason] || t.description || "Transaction",
      type: t.reason,
      direction: t.type,                       /* 'credit' | 'debit' */
      amount: Number(t.amount) || 0,
      status: "success",                       /* only settled rows are written */
      provider: String(t.reference || "").split(":")[0] === "wallet"
        ? null
        : String(t.reference || "").split(":")[0] || null,
      orderId: t.order_id,
      createdAt: t.created_at ? new Date(t.created_at) : null,
      /* Additions, safe because nothing renders them positionally. */
      reason: t.reason,
      balanceAfter: Number(t.balance_after) || 0,
      reference: t.reference,
      description: t.description || ""
    }));
  },

  /**
   * Start a top-up. The amount is a REQUEST: the Edge Function validates it,
   * records it as an intent, and settlement later verifies the gateway against
   * that intent rather than against anything the browser says.
   */
  async fund(amount, provider = "paystack") {
    if (provider !== "paystack") throw new Error("That payment method is not available.");
    if (!authService.isSignedIn()) throw new Error("Please sign in to top up.");

    const callbackUrl = new URL(window.KT.url("pages/account.html"), window.location.origin);
    callbackUrl.hash = "wallet";
    callbackUrl.searchParams.set("wallet", "paystack");

    const { data, error } = await supabase.functions.invoke("wallet-fund-initialize", {
      body: { amount: Math.floor(Number(amount)), callbackUrl: callbackUrl.href }
    });

    if (error) {
      let message = "Could not start the top-up.";
      try {
        const body = await error.context?.json?.();
        if (body && body.error) message = body.error;
      } catch { /* keep the default */ }
      throw new Error(message);
    }
    if (!data || !data.checkoutUrl) throw new Error("Could not start the top-up.");

    window.location.href = data.checkoutUrl;
    return data;
  },

  /**
   * After returning from Paystack. NOT proof of payment — only the webhook can
   * credit a balance. This re-reads the wallet and reports what the server
   * actually holds, polling briefly in case the webhook is still in flight.
   */
  async verifyFunding() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const wallet = await walletService.get();
      if (wallet.balance > 0) return { status: "credited", wallet };
      if (attempt < 7) await new Promise((r) => setTimeout(r, 1500));
    }
    return { status: "pending" };
  },

  /** Pay an order from the balance. The RPC reads the amount from the order. */
  async payOrder(orderCode) {
    const { data, error } = await supabase.rpc("pay_order_from_wallet", {
      p_order_code: String(orderCode)
    });
    if (error) throw error;

    if (data && data.status === "insufficient_funds") {
      throw new Error(
        `Your wallet has ${window.KT.naira(data.balance)} — this order needs ${window.KT.naira(data.required)}.`
      );
    }
    return data;
  }
};

export { errorMessage };
