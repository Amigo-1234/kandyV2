/* ==========================================================================
   admin-delete-customer
   --------------------------------------------------------------------------
   Deleting an auth user needs the service_role key, which must never reach a
   browser. So the browser calls this with its own JWT, and the function:

     1. Confirms the CALLER is an owner, using an anon client bound to their
        token — so the tier check runs through the same is_owner() everything
        else uses, not a claim the client asserts.
     2. Re-runs the pre-flight server-side. The UI already showed it, but the
        UI is not the boundary: a customer with orders must be refused here
        too.
     3. Writes the audit row BEFORE deleting, while the profile still exists
        to describe.
     4. Only then uses service_role to remove the auth user, which cascades
        the profile and its owned rows.

   Requires a valid JWT (verify_jwt defaults to true).
   ========================================================================== */
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "Please sign in." }, 401);

  /* Bound to the CALLER's token: RLS and the role helpers apply as normal. */
  const asCaller = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: auth } = await asCaller.auth.getUser();
  if (!auth?.user) return json({ error: "Please sign in." }, 401);

  let body: { customerId?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const customerId = String(body.customerId ?? "").trim();
  if (!customerId) return json({ error: "customerId is required." }, 400);

  /* Owner check + pre-flight, both server-side. admin_can_delete_customer
     raises 42501 for a non-owner, so this single call covers the tier too. */
  const { data: pre, error: preError } = await asCaller
    .rpc("admin_can_delete_customer", { p_id: customerId });

  if (preError) {
    const denied = (preError.code === "42501") || /owner/i.test(preError.message || "");
    return json({ error: preError.message }, denied ? 403 : 400);
  }
  if (!pre?.can_delete) {
    return json({ error: pre?.reason || "This customer cannot be deleted." }, 409);
  }

  /* Audit first: after the cascade there is no profile left to describe. */
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  await admin.from("admin_audit_log").insert({
    actor_id: auth.user.id,
    actor_role: "owner",
    action: "customer.delete",
    target_table: "profiles",
    target_id: customerId,
    summary: "Deleted customer account " + customerId,
    detail: {
      addresses_removed: pre.addresses ?? 0,
      wallet_transactions_removed: pre.wallet_transactions ?? 0,
    },
  });

  const { error: delError } = await admin.auth.admin.deleteUser(customerId);
  if (delError) {
    console.error("customer delete failed", delError.message);
    return json({ error: "Could not delete the account: " + delError.message }, 500);
  }

  return json({ status: "deleted", customerId });
});
