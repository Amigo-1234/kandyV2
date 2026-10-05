/* Unit tests for walletSettlementNaira (paystack-webhook's wallet amount).
   Run:  deno test --no-config supabase/functions/_shared/paystack_wallet_test.ts
   Not imported by any function, so it is never deployed. */
import { walletSettlementNaira } from "./paystack.ts";

const REF = "KTW-0A1B2C3D4E5F607182";
const USER = "00000000-0000-0000-0000-00000000a11e";

/** A charge.success payload for a ₦5,000 top-up with the fee passed on. */
function ev(data: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    event: "charge.success",
    ...top,
    data: {
      status: "success",
      reference: REF,
      currency: "NGN",
      amount: 517563,
      requested_amount: 500000,
      fees: 17563,
      metadata: { purpose: "wallet_funding", user_id: USER },
      ...data,
    },
  };
}

function eq(actual: unknown, expected: unknown, name: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${name}: expected ${e}, got ${a}`);
}

const gross = (kobo: number) => ({ amount: Math.round(kobo / 100), basis: "charged" });
const requested = (naira: number) => ({ amount: naira, basis: "requested" });

Deno.test("exact top-up: settles the gross charge, as before", () => {
  eq(walletSettlementNaira(ev({ amount: 500000, requested_amount: 500000, fees: 7500 })), gross(500000), "exact");
  eq(walletSettlementNaira(ev({ amount: 500000, requested_amount: undefined, fees: undefined })), gross(500000), "exact, no extra fields");
});

Deno.test("customer-borne fee: settles the signed requested_amount", () => {
  eq(walletSettlementNaira(ev()), requested(5000), "fee passed on");
  eq(walletSettlementNaira(ev({ amount: 510000 })), requested(5000), "extra below the signed fee");
});

Deno.test("underpayment: gross", () => {
  eq(walletSettlementNaira(ev({ amount: 499900 })), gross(499900), "under requested");
  eq(walletSettlementNaira(ev({ amount: 500000 })), gross(500000), "equal is the exact path");
});

Deno.test("arbitrary overpayment / extra beyond the fee: gross", () => {
  eq(walletSettlementNaira(ev({ amount: 600000 })), gross(600000), "far beyond fee");
  eq(walletSettlementNaira(ev({ amount: 517564 })), gross(517564), "one kobo beyond the fee");
  eq(walletSettlementNaira(ev({ fees: 0 })), gross(517563), "no fee at all");
});

Deno.test("missing or malformed requested_amount / fees: gross", () => {
  eq(walletSettlementNaira(ev({ requested_amount: undefined })), gross(517563), "no requested_amount");
  eq(walletSettlementNaira(ev({ fees: undefined })), gross(517563), "no fees");
  eq(walletSettlementNaira(ev({ requested_amount: null })), gross(517563), "null requested_amount");
  eq(walletSettlementNaira(ev({ requested_amount: "500000x" })), gross(517563), "non-numeric");
  eq(walletSettlementNaira(ev({ requested_amount: 500050 })), gross(517563), "not whole naira");
  eq(walletSettlementNaira(ev({ requested_amount: 0 })), gross(517563), "zero");
  eq(walletSettlementNaira(ev({ fees: -5 })), gross(517563), "negative fees");
  eq(walletSettlementNaira(ev({ amount: 517563.5 })), gross(517563.5), "fractional kobo");
});

Deno.test("binding: wrong reference / purpose / user never unlocks requested_amount", () => {
  eq(walletSettlementNaira(ev({ reference: "KT-KD-260927-0068-BE21C939" })), gross(517563), "order reference");
  eq(walletSettlementNaira(ev({ reference: "KTW-0a1b2c3d4e5f607182" })), gross(517563), "lowercase hex");
  eq(walletSettlementNaira(ev({ reference: "KTW-0A1B2C3D4E5F6071" })), gross(517563), "short reference");
  eq(walletSettlementNaira(ev({ reference: `${REF}X` })), gross(517563), "trailing junk");
  eq(walletSettlementNaira(ev({ metadata: { purpose: "order", user_id: USER } })), gross(517563), "wrong purpose");
  eq(walletSettlementNaira(ev({ metadata: { purpose: "wallet_funding" } })), gross(517563), "no user");
});

Deno.test("non-NGN and non-success: gross", () => {
  eq(walletSettlementNaira(ev({ currency: "USD" })), gross(517563), "USD");
  eq(walletSettlementNaira(ev({ status: "failed" })), gross(517563), "status failed");
  eq(walletSettlementNaira(ev({}, { event: "charge.failed" })), gross(517563), "event not charge.success");
});
