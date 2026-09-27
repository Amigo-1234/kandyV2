/* Unit tests for orderSettlementNaira (paystack-webhook's order amount).
   Run:  deno test --no-config supabase/functions/_shared/paystack_test.ts
   Not imported by any function, so it is never deployed. */
import { orderSettlementNaira } from "./paystack.ts";

const CODE = "KD-260927-0068";
const USER = "00000000-0000-0000-0000-0000000c0068";

/** A charge.success payload as Paystack signs it; override any field. */
function ev(data: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    event: "charge.success",
    ...top,
    data: {
      status: "success",
      reference: `KT-${CODE}-BE21C939`,
      currency: "NGN",
      amount: 928935,
      requested_amount: 905000,
      fees: 23935,
      metadata: { order_code: CODE, user_id: USER },
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

Deno.test("exact normal payment: settles the gross charge, as before", () => {
  eq(orderSettlementNaira(ev({ amount: 905000, requested_amount: 905000, fees: 13675 }), CODE), gross(905000), "exact");
  eq(orderSettlementNaira(ev({ amount: 905000, requested_amount: undefined, fees: undefined }), CODE), gross(905000), "exact, no extra fields");
});

Deno.test("customer-borne Paystack fee: settles Paystack's signed requested_amount", () => {
  eq(orderSettlementNaira(ev(), CODE), requested(9050), "0068 as signed");
  eq(orderSettlementNaira(ev({ reference: "KT-KD-260927-0067-F470E218", amount: 538072, requested_amount: 520000, fees: 18072,
    metadata: { order_code: "KD-260927-0067", user_id: USER } }), "KD-260927-0067"), requested(5200), "0067 as signed");
  eq(orderSettlementNaira(ev({ amount: 928000 }), CODE), requested(9050), "extra below the signed fee");
});

Deno.test("underpayment: gross (so the exact check refuses it)", () => {
  eq(orderSettlementNaira(ev({ amount: 900000 }), CODE), gross(900000), "under requested");
});

Deno.test("arbitrary overpayment / extra beyond Paystack's fee: gross", () => {
  eq(orderSettlementNaira(ev({ amount: 1000000 }), CODE), gross(1000000), "overpay far beyond fee");
  eq(orderSettlementNaira(ev({ amount: 928936 }), CODE), gross(928936), "one kobo beyond the signed fee");
  eq(orderSettlementNaira(ev({ fees: 0 }), CODE), gross(928935), "no fee at all");
});

Deno.test("missing or malformed requested_amount / fees: gross", () => {
  eq(orderSettlementNaira(ev({ requested_amount: undefined }), CODE), gross(928935), "no requested_amount");
  eq(orderSettlementNaira(ev({ fees: undefined }), CODE), gross(928935), "no fees");
  eq(orderSettlementNaira(ev({ requested_amount: null }), CODE), gross(928935), "null requested_amount");
  eq(orderSettlementNaira(ev({ requested_amount: "905000x" }), CODE), gross(928935), "non-numeric requested_amount");
  eq(orderSettlementNaira(ev({ requested_amount: 905050 }), CODE), gross(928935), "requested not whole naira");
  eq(orderSettlementNaira(ev({ requested_amount: 0 }), CODE), gross(928935), "requested zero");
  eq(orderSettlementNaira(ev({ fees: -5 }), CODE), gross(928935), "negative fees");
  eq(orderSettlementNaira(ev({ amount: 928935.5 }), CODE), gross(928935.5), "fractional kobo");
});

Deno.test("binding: wrong reference / order / user never unlocks requested_amount", () => {
  eq(orderSettlementNaira(ev({ reference: "KT-KD-260927-0067-F470E218" }), CODE), gross(928935), "reference for another order");
  eq(orderSettlementNaira(ev({ reference: `XX-${CODE}-BE21C939` }), CODE), gross(928935), "reference not KT-");
  eq(orderSettlementNaira(ev({ reference: `KT-${CODE}BE21C939` }), CODE), gross(928935), "reference missing the separator");
  eq(orderSettlementNaira(ev({ metadata: { order_code: "KD-260927-0099", user_id: USER } }), CODE), gross(928935), "metadata for another order");
  eq(orderSettlementNaira(ev(), "KD-260927-0099"), gross(928935), "caller's order differs");
  eq(orderSettlementNaira(ev({ metadata: { order_code: CODE } }), CODE), gross(928935), "no metadata user");
  eq(orderSettlementNaira(ev(), ""), gross(928935), "no order code");
});

Deno.test("non-NGN and non-success: gross", () => {
  eq(orderSettlementNaira(ev({ currency: "USD" }), CODE), gross(928935), "USD");
  eq(orderSettlementNaira(ev({ status: "failed" }), CODE), gross(928935), "status failed");
  eq(orderSettlementNaira(ev({}, { event: "charge.failed" }), CODE), gross(928935), "event not charge.success");
});
