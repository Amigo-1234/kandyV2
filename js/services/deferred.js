/* ==========================================================================
   Kandy's Treats — Services not yet migrated (Phase 5 / payments)
   --------------------------------------------------------------------------
   Auth now issues Supabase UUIDs. The Firestore implementations of these
   services key off a Firebase UID, so calling them would produce nothing but
   permission-denied noise — and the payment callables cannot resolve at all,
   because no Cloud Function is deployed and none can be.

   Rather than leave those calls to fail loudly on every page load, this module
   supplies inert stand-ins with the SAME method surface and the SAME return
   shapes the UI already expects. Read paths answer "empty"; write paths raise
   a sentence a customer can actually read.

   Every one of these collections is empty in both backends, so nothing is
   being hidden — the UI simply renders its empty states until Phase 5 wires
   these to Supabase. Addresses and favourites left in Phase 5A.
   ========================================================================== */

const announced = new Set();
function note(what) {
  if (announced.has(what)) return;
  announced.add(what);
  console.info("[Kandy's] %s is not migrated yet — Phase 5.", what);
}

const soon = (what) => () => {
  throw new Error(`${what} is being moved to the new system — back shortly.`);
};

export const paymentServiceDeferred = {
  /* account.js filters over this, so it must stay an array. */
  PROVIDERS: [],
  async status() { note("Payment configuration"); return { paystack: false, flutterwave: false }; },
  start: soon("Payment"),
  verify: soon("Payment verification"),
  async recordFailure() { /* nothing to record while payments are off */ },
  readReturn() { return null; }
};

export const walletServiceDeferred = {
  async get() { note("Wallet"); return { balance: 0, availableBalance: 0, lockedBalance: 0 }; },
  async transactions() { return []; },
  fund: soon("Wallet top-up"),
  verifyFunding: soon("Wallet top-up"),
  payOrder: soon("Paying from your wallet"),
  watch() { return () => {}; }
};
