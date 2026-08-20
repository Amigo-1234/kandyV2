/* ==========================================================================
   Kandy's Treats — Admin team data access
   --------------------------------------------------------------------------
   Reads go through admin_list_team / admin_team_member, which re-check
   is_manager() server-side.

   Role changes reuse the EXISTING admin_set_role RPC — owner-only, with
   last-owner protection and audit logging already built in. No second
   role-changing path is created here, and no JavaScript ever writes
   profiles.role (the column has no UPDATE grant for any client role, so it
   could not even if it tried).
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

export const ROLES = [
  { value: "owner",    label: "Owner",    blurb: "Full control, including roles, wallets and settings." },
  { value: "admin",    label: "Admin",    blurb: "Manager access: menu, customers, finance, support." },
  { value: "staff",    label: "Staff",    blurb: "Day-to-day operations: orders, availability, support." },
  { value: "customer", label: "Customer", blurb: "No admin access at all." }
];

export const ROLE_FILTERS = [
  { value: "team",     label: "Team members" },
  { value: "all",      label: "Everyone" },
  { value: "owner",    label: "Owners" },
  { value: "admin",    label: "Admins" },
  { value: "staff",    label: "Staff" },
  { value: "customer", label: "Customers" }
];

export const PAGE_SIZE = 25;

export const adminTeamService = {
  ROLES,
  ROLE_FILTERS,
  PAGE_SIZE,

  roleMeta(value) {
    return ROLES.filter((r) => r.value === value)[0] || { value: value, label: value, blurb: "" };
  },

  async list({ search = "", role = "team", limit = PAGE_SIZE, offset = 0 } = {}) {
    const { data, error } = await supabase.rpc("admin_list_team", {
      p_search: search, p_role: role, p_limit: limit, p_offset: offset
    });
    if (error) throw error;
    return data || { total: 0, rows: [], can_change_roles: false };
  },

  async member(id) {
    const { data, error } = await supabase.rpc("admin_team_member", { p_id: id });
    if (error) throw error;
    return data;
  },

  /** The EXISTING owner-only RPC. Not re-implemented, not wrapped in checks
      that could drift from it — the server decides and this reports back. */
  async setRole(userId, role) {
    const { data, error } = await supabase.rpc("admin_set_role", {
      p_user_id: userId, p_role: role
    });
    if (error) throw error;
    return data;
  },

  /** What a role change actually grants or removes, for the confirmation. */
  changeSummary(from, to) {
    var rank = { customer: 10, staff: 20, admin: 30, owner: 40 };
    var up = (rank[to] || 0) > (rank[from] || 0);
    return {
      direction: up ? "promotion" : "demotion",
      gains: up ? adminTeamService.roleMeta(to).blurb : "",
      loses: up ? "" : "Loses access above " + adminTeamService.roleMeta(to).label + ".",
      dangerous: to === "owner" || from === "owner"
    };
  }
};

export { errorMessage };
