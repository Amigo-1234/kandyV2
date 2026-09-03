/* ==========================================================================
   Kandy's Treats — End-of-day reporting data access
   --------------------------------------------------------------------------
   Four RPCs, no computation. Every number a handler or a manager reads here
   is derived in Postgres from order_status_history, which is also where it is
   testable — nothing on this screen is a figure somebody typed.

   The split between the two halves is the whole point of the feature:

     staffDay()      what the signed-in person DID (derived, read-only) plus
                     what they WROTE (theirs to edit).
     teamDay()       supervisor+ only: everyone's derived activity and report
                     status in one call, with the day's operations and scoop
                     totals reused from Phase 02 and Phase 01 rather than
                     recomputed.

   There is deliberately no write path for the derived numbers, because there
   is no column holding them.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

export const adminEodService = {
  /** The signed-in handler's own page. `day` is YYYY-MM-DD or null for today. */
  async staffDay(day) {
    const { data, error } = await supabase.rpc("staff_day_report",
      { p_day: day || null });
    if (error) throw error;
    return data;
  },

  /**
   * Save or submit one's own report.
   *
   * The server decides the business date and stamps submitted_at, so neither
   * can be argued with from here — this function cannot backdate a report or
   * write anybody else's, because the RPC never takes a staff id.
   */
  async save(fields, submit) {
    const f = fields || {};
    const { data, error } = await supabase.rpc("staff_day_report_save", {
      p_problems:        f.problems || "",
      p_customer_issues: f.customerIssues || "",
      p_stock_issues:    f.stockIssues || "",
      p_follow_ups:      f.followUps || "",
      p_notes:           f.notes || "",
      p_submit:          !!submit
    });
    if (error) throw error;
    return data;
  },

  /** Throw away today's untouched draft. Own draft only; never a submission. */
  async discard() {
    const { data, error } = await supabase.rpc("staff_day_report_discard", {});
    if (error) throw error;
    return data;
  },

  /** Supervisor+: the whole team's day in one call. */
  async teamDay(day) {
    const { data, error } = await supabase.rpc("admin_day_reports",
      { p_day: day || null });
    if (error) throw error;
    return data;
  },

  /**
   * Supervisor+: record that a report has been read, and optionally flag it.
   * Writes only the review columns — the author's own text is not a parameter
   * of this call and cannot be reached by it.
   */
  async review(reportId, needsFollowUp, note) {
    const { data, error } = await supabase.rpc("admin_review_day_report", {
      p_report_id: reportId,
      p_needs_follow_up: !!needsFollowUp,
      p_note: note || ""
    });
    if (error) throw error;
    return data;
  }
};

export { errorMessage };
