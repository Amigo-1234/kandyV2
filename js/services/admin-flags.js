/* ==========================================================================
   Kandy's Treats — Staff flags data access
   --------------------------------------------------------------------------
   Private management accountability records. Every call here is manager+
   (admin or owner) and refused by the database for anyone else, including
   the person a flag is about — staff_flags has one SELECT policy,
   using (is_manager()), and no policy under which a subject reads their own.

   There is no delete function on purpose. A flag that stops mattering is
   resolved or dismissed; the row keeps saying who decided that and when.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

export const FLAG_CATEGORIES = [
  { value: "attendance",         label: "Attendance" },
  { value: "order_handling",     label: "Order handling" },
  { value: "customer_complaint", label: "Customer complaint" },
  { value: "cash",               label: "Cash / accountability" },
  { value: "operational",        label: "Operational mistake" },
  { value: "policy",             label: "Policy" },
  { value: "performance",        label: "Performance" },
  { value: "recognition",        label: "Recognition" },
  { value: "other",              label: "Other note" }
];

export const FLAG_SEVERITIES = [
  { value: "note",     label: "Note" },
  { value: "low",      label: "Low" },
  { value: "medium",   label: "Medium" },
  { value: "high",     label: "High" },
  { value: "critical", label: "Critical" }
];

export const FLAG_STATUSES = [
  { value: "open",         label: "Open" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "resolved",     label: "Resolved" },
  { value: "dismissed",    label: "Dismissed" }
];

const labelOf = (list, v) => (list.find((x) => x.value === v) || {}).label || v;

export const adminFlagsService = {
  FLAG_CATEGORIES, FLAG_SEVERITIES, FLAG_STATUSES,
  categoryLabel: (v) => labelOf(FLAG_CATEGORIES, v),
  severityLabel: (v) => labelOf(FLAG_SEVERITIES, v),
  statusLabel:   (v) => labelOf(FLAG_STATUSES, v),

  async list(staffUserId, includeClosed) {
    const { data, error } = await supabase.rpc("staff_flags_list", {
      p_staff_user_id: staffUserId || null,
      p_include_closed: includeClosed !== false
    });
    if (error) throw error;
    return data || { rows: [], viewer_role: "", is_owner: false };
  },

  /** Per-person counters for the Team roster badges. */
  async summary() {
    const { data, error } = await supabase.rpc("staff_flag_summary");
    if (error) throw error;
    return data || {};
  },

  async save(flag) {
    const { data, error } = await supabase.rpc("staff_flag_save", {
      p_staff_user_id: flag.staffUserId,
      p_title:         flag.title,
      p_details:       flag.details || "",
      p_category:      flag.category || "other",
      p_severity:      flag.severity || "note",
      p_id:            flag.id || null
    });
    if (error) throw error;
    return data;
  },

  /** acknowledge / resolve / dismiss / reopen — one call, audited each time. */
  async setStatus(id, status, resolution) {
    const { data, error } = await supabase.rpc("staff_flag_set_status", {
      p_id: id, p_status: status, p_resolution: resolution || null
    });
    if (error) throw error;
    return data;
  }
};

export { errorMessage };
