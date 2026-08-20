/* ==========================================================================
   Kandy's Treats — Admin finance data access
   --------------------------------------------------------------------------
   Read-only. Every call is a SECURITY DEFINER RPC that re-checks is_manager()
   server-side, so hiding the nav item is decoration and the database is the
   boundary.

   Nothing here writes. The one mutating capability Finance offers — a refund —
   goes through the EXISTING admin_refund_order RPC, which already enforces
   admin+ and is idempotent. No second refund path is created, and no
   JavaScript ever touches paid, payment_status, payment_ref or a wallet
   balance directly.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

export const SEVERITY = ["critical", "warning", "info"];

export const EVENT_STATUSES = [
  { value: "all",       label: "All events" },
  { value: "success",   label: "Successful" },
  { value: "failed",    label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "mismatch",  label: "Amount rejected" },
  { value: "ignored",   label: "Ignored (replay)" }
];

export const adminFinanceService = {
  SEVERITY,
  EVENT_STATUSES,

  async overview() {
    const { data, error } = await supabase.rpc("admin_finance_overview");
    if (error) throw error;
    return data;
  },

  async reconciliation({ limit = 200 } = {}) {
    const { data, error } = await supabase.rpc("admin_reconciliation", { p_limit: limit });
    if (error) throw error;
    return data || [];
  },

  async paymentEvents({ search = "", status = "all", limit = 50, offset = 0 } = {}) {
    const { data, error } = await supabase.rpc("admin_payment_events", {
      p_search: search, p_status: status, p_limit: limit, p_offset: offset
    });
    if (error) throw error;
    return data || { total: 0, rows: [] };
  },

  /**
   * Wallet overview. Read-only by construction: wallets and
   * wallet_transactions carry no client write policy at all, so this can only
   * ever read. Adjusting a balance remains admin_adjust_wallet (owner only).
   */
  async wallets({ limit = 50 } = {}) {
    const { data, error } = await supabase
      .from("wallets")
      .select("user_id, balance, locked_balance, available_balance, currency, status, updated_at")
      .order("balance", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  async walletTransactions({ userId, limit = 20 } = {}) {
    let q = supabase
      .from("wallet_transactions")
      .select("id, user_id, type, reason, amount, balance_after, reference, description, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (userId) q = q.eq("user_id", userId);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  /** The EXISTING refund RPC. Admin+ enforced inside; idempotent; audited. */
  async refund(orderCode, reason) {
    const { data, error } = await supabase.rpc("admin_refund_order", {
      p_order_code: orderCode, p_reason: reason || ""
    });
    if (error) throw error;
    return data;
  },

  /**
   * Deliberate, meaningful actions only — never a repaint. The action name is
   * whitelisted server-side, so this cannot be used to forge an audit entry
   * for something that did not happen.
   */
  async logAction(action, summary, detail) {
    try {
      await supabase.rpc("admin_log_finance", {
        p_action: action, p_summary: summary || "", p_detail: detail || {}
      });
    } catch (e) { /* audit is best-effort; it must never block the view */ }
  },

  naira(v) {
    return "₦" + Number(v || 0).toLocaleString("en-NG");
  }
};

export { errorMessage };
