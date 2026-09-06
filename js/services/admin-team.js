/* ==========================================================================
   Kandy's Treats — Admin team data access
   --------------------------------------------------------------------------
   Reads go through admin_list_team / admin_team_member, which re-check
   is_manager() server-side.

   Role changes reuse the EXISTING admin_set_role RPC. Phase 11 widened who
   may call it — an admin can now move an account between customer, staff and
   supervisor — but that rule lives in can_assign_role() inside the database,
   not here. No second role-changing path was created, and no JavaScript ever
   writes profiles.role (the column has no UPDATE grant for any client role,
   so it could not even if it tried).

   INVITATIONS
   -----------
   The one case admin_set_role cannot cover is an account that does not exist
   yet. admin_invite_teammate() mints a single-use token; the invitee redeems
   it on pages/join.html after signing in with that exact email, and
   accept_staff_invitation() assigns the role server-side. No password is ever
   created, chosen or stored by anyone here, and the service_role key is not
   involved at any point.

   ROLE OPTIONS ARE THE SERVER'S ANSWER
   ------------------------------------
   ROLES below is the vocabulary — labels and blurbs for rendering. WHICH of
   them a viewer may pick for a given person comes from `role_options` on the
   member response, computed by can_assign_role(). This file never filters the
   list itself, so the dropdown cannot offer a move the RPC would refuse.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

export const ROLES = [
  { value: "owner",      label: "Owner",      blurb: "Full control, including roles, wallets and settings." },
  { value: "admin",      label: "Admin",      blurb: "Manager access: menu, customers, finance, settings, support." },
  { value: "supervisor", label: "Supervisor", blurb: "Runs the floor: orders including cancellations, availability, chat, tickets and contact messages. No finance and no settings." },
  { value: "staff",      label: "Staff",      blurb: "Day-to-day operations: orders, availability, chat and tickets." },
  { value: "customer",   label: "Customer",   blurb: "No admin access at all." }
];

export const ROLE_FILTERS = [
  { value: "team",       label: "Team members" },
  { value: "all",        label: "Everyone" },
  { value: "owner",      label: "Owners" },
  { value: "admin",      label: "Admins" },
  { value: "supervisor", label: "Supervisors" },
  { value: "staff",      label: "Staff" },
  { value: "customer",   label: "Customers" }
];

/** Mirrors public.role_rank(), deliberately. */
export const RANK = { customer: 10, staff: 20, supervisor: 25, admin: 30, owner: 40 };

export const PAGE_SIZE = 25;

export const adminTeamService = {
  ROLES,
  ROLE_FILTERS,
  RANK,
  PAGE_SIZE,

  roleMeta(value) {
    return ROLES.filter((r) => r.value === value)[0] || { value, label: value, blurb: "" };
  },

  async list({ search = "", role = "team", limit = PAGE_SIZE, offset = 0 } = {}) {
    const { data, error } = await supabase.rpc("admin_list_team", {
      p_search: search, p_role: role, p_limit: limit, p_offset: offset
    });
    if (error) throw error;
    return data || { total: 0, rows: [], can_change_roles: false, assignable_roles: [] };
  },

  async member(id) {
    const { data, error } = await supabase.rpc("admin_team_member", { p_id: id });
    if (error) throw error;
    return data;
  },

  /*
     Suspension. The ONLY mutation path — there is deliberately no direct
     profiles UPDATE here, and there could not be one: authenticated has no
     UPDATE grant on suspended_at, and no SELECT grant on suspend_reason.
     The server re-decides authority on every call, so a button this file
     renders is a request, never a permission.
  */
  async setSuspended(userId, suspended, reason) {
    const { data, error } = await supabase.rpc("admin_set_suspended", {
      p_user_id: userId,
      p_suspended: !!suspended,
      /* Only ever sent when suspending. Reactivation carries no text. */
      p_reason: suspended ? (reason || null) : null
    });
    if (error) throw error;
    return data;
  },

  /*
     Whether THIS viewer may open or close THIS member's workspace.

     can_manage on its own is not that answer and must never be used as one:
     it reports role-change ability, and can_assign_role()'s owner branch
     ignores is_self, so an owner's own row comes back can_manage true — the
     same blind spot that let an owner suspend themselves. A customer row is
     can_manage true as well, because an owner may promote one.

     So the three conditions the server actually enforces are asked here too,
     and the button simply does not appear when any fails.
  */
  canSuspend(member) {
    if (!member || member.is_self) return false;
    if (!member.can_manage) return false;
    return (RANK[member.role] || 0) >= RANK.staff;
  },

  /** The existing RPC. The server decides; this reports back. */
  async setRole(userId, role) {
    const { data, error } = await supabase.rpc("admin_set_role", {
      p_user_id: userId, p_role: role
    });
    if (error) throw error;
    return data;
  },

  /* ---- Invitations ----------------------------------------------------- */

  /** Returns the raw token EXACTLY ONCE. It is not stored and cannot be re-read. */
  async invite({ email, role, name = "", phone = "" }) {
    const { data, error } = await supabase.rpc("admin_invite_teammate", {
      p_email: email, p_role: role, p_name: name, p_phone: phone
    });
    if (error) throw error;
    return data;
  },

  async invitations(status = "pending") {
    const { data, error } = await supabase.rpc("admin_list_invitations", { p_status: status });
    if (error) throw error;
    return (data && data.rows) || [];
  },

  async revokeInvitation(id) {
    const { data, error } = await supabase.rpc("admin_revoke_invitation", { p_id: id });
    if (error) throw error;
    return data;
  },

  /** The link the invitee opens. Absolute, because it leaves this browser. */
  inviteLink(token) {
    return new URL(window.KT.url("pages/join.html") + "?token=" + encodeURIComponent(token),
      window.location.href).href;
  },

  /** What a role change actually grants or removes, for the confirmation. */
  changeSummary(from, to) {
    const up = (RANK[to] || 0) > (RANK[from] || 0);
    return {
      direction: up ? "promotion" : "demotion",
      gains: up ? adminTeamService.roleMeta(to).blurb : "",
      loses: up ? "" : "Loses access above " + adminTeamService.roleMeta(to).label + ".",
      dangerous: to === "owner" || from === "owner"
    };
  }
};

export { errorMessage };
