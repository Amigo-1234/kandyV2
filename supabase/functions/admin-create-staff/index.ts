/* ==========================================================================
   admin-create-staff
   --------------------------------------------------------------------------
   Management creates a colleague's account directly: name, email, phone and
   role, and the person appears in Team & Roles straight away. The existing
   invitation flow stays as the alternative.

   Creating an auth user needs the service_role key, which must never reach a
   browser — so, as in admin-delete-customer, the browser calls this with its
   own JWT and the function does the privileged part:

     1. Who is asking? getUser() on a client bound to the CALLER's token.
     2. May they? my_account_status() and assignable_roles(), both run AS the
        caller, so the tier, the suspension check and the role matrix are the
        database's own — not something this file decides. Admin may create
        staff and supervisors; the owner may also create admins. Nobody
        creates an owner here (that stays a promotion via admin_set_role).
     3. Does the person already exist? admin_list_team(), again as the caller.
        An existing account is never duplicated: the response names it and
        the UI sends management to the existing role-change path.
     4. Create the auth user (service_role), email pre-confirmed, NO password.
        handle_new_user() gives them a customer profile and a wallet, exactly
        as for any sign-up.
     5. Assign the role by calling admin_set_role() AS THE CALLER — the one
        authoritative role path, with its matrix, last-owner rule and audit
        row naming the real actor. If that fails, the new auth user is deleted
        so no half-created account is left behind.
     6. Record team.account_created in admin_audit_log with the real actor.
     7. Ask Supabase Auth to email a password-setup link — the same recovery
        email and pages/reset-password.html flow customers already use. The
        employee chooses their own password; management never knows it.

   Requires a valid JWT (verify_jwt = true in supabase/config.toml).
   ========================================================================== */
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });

/* Team seats this form can create. Owner is deliberately absent. */
const CREATABLE = ["staff", "supervisor", "admin"];
const MANAGER_ROLES = ["admin", "owner"];

/* Mirrors js/lib/rules.js normalizePhone / isValidPhone. */
function normalizePhone(p: string) {
  const d = String(p || "").replace(/[^\d]/g, "");
  if (d.length === 11 && d.charAt(0) === "0") return "234" + d.slice(1);
  if (d.length === 10 && d.charAt(0) === "7") return "234" + d;
  return d;
}
const validPhone = (d: string) => d.length === 13 && d.startsWith("234");
const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;

/* Where the password-setup link lands. Only the calling site's own origin, and
   only on the existing reset page; Supabase Auth still checks it against the
   project's redirect allow-list and falls back to the Site URL otherwise. */
function setupRedirect(req: Request): string | undefined {
  const origin = req.headers.get("Origin") || "";
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) ||
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    return origin + "/pages/reset-password.html";
  }
  return undefined;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "Please sign in." }, 401);

  /* ---- 1. The caller, through their own token ------------------------- */
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth } = await asCaller.auth.getUser();
  if (!auth?.user) return json({ error: "Please sign in." }, 401);

  /* ---- Input ----------------------------------------------------------- */
  let body: { email?: string; name?: string; phone?: string; role?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const phone = normalizePhone(String(body.phone ?? ""));
  const role = String(body.role ?? "").trim().toLowerCase();

  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
  if (!name) return json({ error: "Enter the employee's full name." }, 400);
  if (!validPhone(phone)) return json({ error: "Enter a valid Nigerian phone number, e.g. 0801 234 5678." }, 400);
  if (!CREATABLE.includes(role)) {
    return json({ error: role === "owner"
      ? "Owners cannot be created here. Create the account, then promote it from Team & Roles."
      : "Choose staff, supervisor or admin." }, 400);
  }

  /* ---- 2. Tier + role matrix, both as the caller ---------------------- */
  const { data: me, error: meError } = await asCaller.rpc("my_account_status");
  if (meError) return json({ error: "Could not confirm your access." }, 403);
  const actorRole = String(me?.role ?? "");
  if (me?.suspended || !MANAGER_ROLES.includes(actorRole)) {
    return json({ error: "Only an admin or the owner may create staff accounts." }, 403);
  }
  const { data: allowed, error: allowedError } =
    await asCaller.rpc("assignable_roles", { p_actor_role: actorRole });
  if (allowedError || !Array.isArray(allowed) || !allowed.includes(role)) {
    return json({ error: `Your role (${actorRole}) cannot create a ${role} account.` }, 403);
  }

  /* ---- 3. Never duplicate an existing account ------------------------- */
  const { data: found, error: findError } = await asCaller.rpc("admin_list_team", {
    p_search: email, p_role: "all", p_limit: 25, p_offset: 0,
  });
  if (findError) return json({ error: "Could not check whether that email already exists." }, 502);
  const match = (found?.rows ?? []).find((r: { email?: string }) =>
    String(r.email ?? "").toLowerCase() === email);
  if (match) {
    return json({
      error: "An account with that email already exists. Change its role from Team & Roles instead.",
      existing: { id: match.id, email: match.email, name: match.name ?? "", role: match.role },
    }, 409);
  }

  /* ---- 4. Create the auth user — the only service_role step ----------- */
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,                         // management vouches for the address
    user_metadata: { display_name: name, phone }, // handle_new_user() reads these
  });
  if (createError || !created?.user) {
    const msg = String(createError?.message ?? "");
    if (/already|exists|registered/i.test(msg) || (createError as { code?: string })?.code === "email_exists") {
      return json({ error: "An account with that email already exists. Change its role from Team & Roles instead." }, 409);
    }
    console.error("staff create failed", msg);
    return json({ error: "Could not create the account." }, 500);
  }
  const newId = created.user.id;

  /* ---- 5. Role through the authoritative path, AS THE CALLER ----------- */
  const { error: roleError } = await asCaller.rpc("admin_set_role", { p_user_id: newId, p_role: role });
  if (roleError) {
    /* Roll back: a created-but-unpromoted account must not linger. */
    const { error: undoError } = await admin.auth.admin.deleteUser(newId);
    if (undoError) {
      console.error("staff create rollback failed", newId, undoError.message);
      return json({
        error: "The role could not be assigned and the new account could not be removed automatically. " +
               "It exists as a customer account for " + email + "; remove or promote it from Team & Roles.",
        orphan: { id: newId, email },
      }, 500);
    }
    return json({ error: roleError.message || "The role could not be assigned." },
                roleError.code === "42501" ? 403 : 400);
  }

  /* ---- 6. Audit, naming the real actor --------------------------------- */
  const { error: auditError } = await admin.from("admin_audit_log").insert({
    actor_id: auth.user.id,
    actor_role: actorRole,
    action: "team.account_created",
    target_table: "profiles",
    target_id: newId,
    summary: `Created ${role} account for ${email}`,
    detail: { email, role, method: "direct" },
  });
  if (auditError) console.error("staff create audit insert failed", auditError.message);

  /* ---- 7. Password setup: the standard recovery email ------------------ */
  const mailer = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: mailError } = await mailer.auth.resetPasswordForEmail(email, { redirectTo: setupRedirect(req) });
  if (mailError) console.error("staff setup email failed", mailError.message);

  return json({
    status: "created",
    user: { id: newId, email, name, role },
    setup_email: mailError ? "failed" : "sent",
    ...(mailError ? { setup_error: "The account exists but the password-setup email could not be sent. " +
      "Ask them to use “Forgot password?” on the sign-in page with " + email + "." } : {}),
  }, 200);
});
