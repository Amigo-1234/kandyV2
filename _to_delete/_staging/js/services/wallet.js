/* ==========================================================================
   Kandy's Treats — Wallet
   --------------------------------------------------------------------------
   V1 gives every customer a wallet created alongside their profile. Balances
   are NEVER written by client code: firestore.rules allows the browser to
   create only a zero-balance wallet, and every movement afterwards runs
   through a Cloud Function inside a Firestore transaction.

     createWalletFundingPayment / verifyWalletFundingPayment  — top up
     payOrderWithWallet                                       — atomic debit
     refundOrderToWallet                                      — admin refunds

   Paying from the wallet skips the 2% card processing fee, because
   functions/index.js only applies it to `paymentMode === "gateway"`.
   ========================================================================== */

import { db, fb, callable, COLLECTIONS } from "./firebase.js";
import { authService } from "./auth.js";

const createWalletFundingPayment = callable("createWalletFundingPayment");
const verifyWalletFundingPayment = callable("verifyWalletFundingPayment");
const payOrderWithWallet = callable("payOrderWithWallet");

export const walletService = {
  async get() {
    const uid = authService.uid();
    if (!uid) return null;
    const snap = await fb.getDoc(fb.doc(db, COLLECTIONS.wallets, uid));
    if (!snap.exists()) return { balance: 0, availableBalance: 0, currency: "NGN", status: "active" };
    return snap.data();
  },

  /** Live balance for the account page. */
  watch(onChange) {
    const uid = authService.uid();
    if (!uid) return () => {};
    return fb.onSnapshot(
      fb.doc(db, COLLECTIONS.wallets, uid),
      (snap) => onChange(snap.exists() ? snap.data() : { balance: 0, availableBalance: 0 }),
      () => {}
    );
  },

  async transactions({ limit = 20 } = {}) {
    const uid = authService.uid();
    if (!uid) return [];
    const snap = await fb.getDocs(fb.query(
      fb.collection(db, COLLECTIONS.transactions),
      fb.where("userId", "==", uid),
      fb.orderBy("createdAt", "desc"),
      fb.limit(limit)
    ));
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        title: data.title || data.type || "Transaction",
        type: data.type,
        direction: data.direction,
        amount: Number(data.amount) || 0,
        status: data.status,
        provider: data.provider || null,
        orderId: data.orderId || null,
        createdAt: data.createdAt && data.createdAt.toDate ? data.createdAt.toDate() : null
      };
    });
  },

  /** Top the wallet up through a gateway. Returns a hosted checkout URL. */
  async fund(amount, provider) {
    const callbackUrl = new URL(window.KT.url("pages/account.html"), window.location.origin);
    callbackUrl.searchParams.set("wallet", provider);

    const result = await createWalletFundingPayment({
      amount: Math.round(Number(amount) || 0),
      provider,
      callbackUrl: callbackUrl.href
    });
    if (!result || !result.checkoutUrl) {
      throw new Error("Wallet funding is not available right now.");
    }
    window.location.href = result.checkoutUrl;
    return result;
  },

  async verifyFunding(payload) {
    return verifyWalletFundingPayment(payload);
  },

  /** Atomic: checks balance, debits, writes a transaction, marks order paid. */
  async payOrder(orderId) {
    return payOrderWithWallet({ orderId });
  }
};
