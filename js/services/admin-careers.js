/* ==========================================================================
   Kandy's Treats — Careers, admin side
   --------------------------------------------------------------------------
   Loaded on demand by the admin app only. It reads job_applications through
   ordinary PostgREST: job_applications_admin_select already scopes SELECT to
   is_manager(), so an admin sees every application and a staff member sees
   none — this file is not what decides that.

   The storefront's js/services/careers.js writes applications and never reads
   them back. That split is deliberate and stays: two modules against one
   table, each holding exactly one half of the traffic.

   WHAT A HANDLER MAY CHANGE
   -------------------------
   Only `status`, and only because migration 0048 grants UPDATE on that one
   column. The applicant's name, phone, email and message are a record of what
   they sent us; nothing in the admin can edit them, and that is a grant, not
   a convention this file follows.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

const TABLE = "job_applications";

/* The three states the CHECK constraint on job_applications.status allows.
   Not a UI preference — adding a fourth here would simply fail server-side. */
export const STATUSES = [
  { key: "new",       label: "New",       hint: "Not looked at yet" },
  { key: "reviewing", label: "Reviewing", hint: "Being considered" },
  { key: "closed",    label: "Closed",    hint: "Decided, no further action" }
];

/* Mirrors ROLES in js/services/careers.js, which is what the storefront form
   writes. Kept as a lookup rather than imported so the admin bundle does not
   pull in the customer module for three labels. */
const ROLE_LABELS = {
  chef: "Chef",
  rider: "Rider",
  "kitchen-assistant": "Kitchen assistant"
};

export function roleLabel(slug) {
  return ROLE_LABELS[slug] || slug || "—";
}

function toRow(r) {
  return {
    id: r.id,
    roleSlug: r.role_slug,
    roleLabel: roleLabel(r.role_slug),
    name: r.name || "",
    phone: r.phone || "",
    email: r.email || "",
    about: r.about || "",
    status: r.status,
    createdAt: r.created_at ? new Date(r.created_at) : null
  };
}

export const adminCareersService = {
  STATUSES,
  roleLabel,

  /**
   * One page of applications, newest first, filtered server-side.
   * `count: "exact"` is what lets the header state a real total rather than
   * however many rows this page happened to hold.
   */
  async list(opts) {
    opts = opts || {};
    const limit = opts.limit || 25;
    const offset = opts.offset || 0;

    let q = supabase.from(TABLE)
      .select("id, role_slug, name, phone, email, about, status, created_at",
              { count: "exact" });

    if (opts.status && opts.status !== "all") q = q.eq("status", opts.status);
    if (opts.role && opts.role !== "all") q = q.eq("role_slug", opts.role);

    const term = String(opts.search || "").trim();
    if (term) {
      /* PostgREST splits an `or=` list on commas and reads parentheses as
         grouping, so those are stripped rather than escaped — a search box is
         not a query language. */
      const like = "*" + term.replace(/[*,()]/g, "") + "*";
      q = q.or([
        "name.ilike." + like,
        "phone.ilike." + like,
        "email.ilike." + like
      ].join(","));
    }

    const res = await q.order("created_at", { ascending: false })
                       .range(offset, offset + limit - 1);
    if (res.error) throw res.error;

    const rows = (res.data || []).map(toRow);
    return {
      rows,
      total: typeof res.count === "number" ? res.count : rows.length,
      hasMore: offset + rows.length < (res.count || 0)
    };
  },

  /** The three tallies the header shows, in one round trip. */
  async counts() {
    const { data, error } = await supabase.rpc("admin_career_counts");
    if (error) throw error;
    return data || { new: 0, reviewing: 0, closed: 0, total: 0 };
  },

  /**
   * Move an application along. Only `status` is sent, and only `status` is
   * grantable — so this cannot become an edit of what the applicant wrote
   * even by mistake. The audit row is written by a trigger, not from here.
   */
  async setStatus(id, status) {
    if (!STATUSES.some((s) => s.key === status)) {
      throw new Error("Unknown application status.");
    }
    const res = await supabase.from(TABLE)
      .update({ status })
      .eq("id", id)
      .select("id, status");
    if (res.error) throw res.error;
    if (!res.data || !res.data.length) {
      /* RLS filtered it: the caller may read applications but not move them. */
      throw new Error("That application could not be updated with your access level.");
    }
    return res.data[0];
  }
};

export { errorMessage };
