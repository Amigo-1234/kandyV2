/* ==========================================================================
   Kandy's Treats — Admin customers service
   --------------------------------------------------------------------------
   Everything here goes through SECURITY DEFINER RPCs rather than table reads,
   because customer email lives in auth.users (which PostgREST does not
   expose) and because the staff/admin split is a COLUMN rule that RLS cannot
   express. The RPCs re-check the tier server-side and redact accordingly —
   a staff caller is handed nulls for email, spend and addresses, not a
   filtered UI.

   Deletion never touches the Auth admin API from here: that needs the
   service_role key, so it goes to an Edge Function which re-verifies the
   caller is an owner.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

export const STATUSES = [
  { id: "all",     label: "All" },
  { id: "active",  label: "Active" },
  { id: "new",     label: "No orders yet" },
  { id: "dormant", label: "Dormant" }
];

export const PAGE_SIZE = 25;

function toRow(r) {
  return {
    id: r.id,
    name: r.display_name || "",
    phone: r.phone || "",
    email: r.email || null,               /* null for staff tier */
    createdAt: r.created_at ? new Date(r.created_at) : null,
    lastSignInAt: r.last_sign_in_at ? new Date(r.last_sign_in_at) : null,
    orderCount: Number(r.order_count) || 0,
    totalSpent: r.total_spent == null ? null : Number(r.total_spent),
    status: r.status
  };
}

export const adminCustomerService = {
  STATUSES,
  PAGE_SIZE,

  /** Server-side search, filter, aggregate and pagination. */
  async list(opts) {
    opts = opts || {};
    const { data, error } = await supabase.rpc("admin_list_customers", {
      p_search: opts.search || "",
      p_status: opts.status || "all",
      p_limit: opts.limit || PAGE_SIZE,
      p_offset: opts.offset || 0
    });
    if (error) throw error;
    return {
      rows: (data.rows || []).map(toRow),
      total: Number(data.total) || 0,
      tier: data.tier
    };
  },

  /** Full record. Writes a customer.view_sensitive audit row for manager+. */
  async get(id) {
    const { data, error } = await supabase.rpc("admin_get_customer", { p_id: id });
    if (error) throw error;
    const p = data.profile || {};
    return {
      tier: data.tier,
      profile: {
        id: p.id,
        name: p.display_name || "",
        phone: p.phone || "",
        email: p.email || null,
        createdAt: p.created_at ? new Date(p.created_at) : null,
        lastSignInAt: p.last_sign_in_at ? new Date(p.last_sign_in_at) : null
      },
      orders: (data.orders || []).map(function (o) {
        return { code: o.code, status: o.status, paymentStatus: o.payment_status,
                 paid: o.paid === true, total: Number(o.total) || 0,
                 fulfilment: o.fulfilment,
                 createdAt: o.created_at ? new Date(o.created_at) : null };
      }),
      addresses: (data.addresses || []).map(function (a) {
        return { label: a.label, recipientName: a.recipient_name, phone: a.phone,
                 address: a.address, notes: a.notes, isDefault: a.is_default === true };
      })
    };
  },

  /** Read-only pre-flight so the UI can explain a refusal in advance. */
  async canDelete(id) {
    const { data, error } = await supabase.rpc("admin_can_delete_customer", { p_id: id });
    if (error) throw error;
    return data;
  },

  /** Owner only. The Edge Function holds the service_role key, not the browser. */
  async remove(id) {
    const { data, error } = await supabase.functions.invoke("admin-delete-customer", {
      body: { customerId: id }
    });
    if (error) {
      let message = "Could not delete the account.";
      try {
        const body = await error.context?.json?.();
        if (body && body.error) message = body.error;
      } catch { /* keep the default */ }
      throw new Error(message);
    }
    return data;
  },

  /** manager+; the CSV is built from rows the caller already holds. */
  async logExport(count) {
    const { error } = await supabase.rpc("admin_log_customer_export", { p_count: count });
    if (error) throw error;
  },

  toCsv(rows) {
    const head = ["Name", "Email", "Phone", "Orders", "Total spent", "Status", "Joined"];
    const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const lines = [head.map(esc).join(",")];
    rows.forEach(function (r) {
      lines.push([r.name, r.email || "", r.phone, r.orderCount,
                  r.totalSpent == null ? "" : r.totalSpent, r.status,
                  r.createdAt ? r.createdAt.toISOString().slice(0, 10) : ""].map(esc).join(","));
    });
    return lines.join("\n");
  }
};

export { errorMessage };
