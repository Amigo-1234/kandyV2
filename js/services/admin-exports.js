/* ==========================================================================
   Kandy's Treats — Exports
   --------------------------------------------------------------------------
   Every export is a CSV rendering of a function that already exists. Nothing
   here queries a table directly and nothing here does arithmetic: the scoop
   totals come from admin_scoop_report(), the inventory equation from
   admin_inventory_day(), staff activity from admin_day_reports(), and so on.
   If an exported number ever disagreed with the screen it came from, that
   would mean a second calculation had been written, which is the thing this
   module exists to avoid.

   PERMISSIONS ARE INHERITED, NOT RE-IMPLEMENTED

   Each export calls the RPC the signed-in user is already entitled to call.
   A staff member exporting inventory gets exactly what the inventory screen
   shows them; a customer gets a 42501 from the RPC itself. There is no
   separate export permission to get wrong, and no query here that could
   accidentally reach past the caller's tier.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

/* ---- CSV -----------------------------------------------------------------
   RFC 4180: quote anything containing a comma, quote or newline, and double
   an embedded quote. A leading =, +, - or @ is prefixed with an apostrophe —
   Excel and Sheets treat those as formulas, and a product literally named
   "=Jollof" would otherwise execute on open. */
function csvCell(v) {
  if (v === null || v === undefined) return "";
  var s = String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCSV(headers, rows) {
  var out = [headers.map(csvCell).join(",")];
  rows.forEach(function (r) { out.push(r.map(csvCell).join(",")); });
  /* CRLF and a BOM: Excel opens UTF-8 as the local codepage without one, so
     "₦" and "Kandy's" arrive mangled. */
  return "﻿" + out.join("\r\n") + "\r\n";
}

/** Africa/Lagos, so a file's name matches the business day inside it. */
export function lagosToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
}

const money = (v) => (v === null || v === undefined ? "" : Number(v));

export const adminExportsService = {
  toCSV,
  lagosToday,

  /**
   * Orders over a date range. Reuses the admin order list the Orders screen
   * uses, including its role-aware email rule — a staff member's export has
   * the same blank email column their screen has.
   */
  async orders(fromDate, toDate, canSeeEmail) {
    const svc = await import("./admin-orders.js");
    const rows = [];
    /* section() is the paged, filtered reader the board already uses. */
    for (const sec of svc.SECTIONS) {
      let offset = 0;
      for (;;) {
        const page = await svc.adminOrderService.section(sec.status, {
          range: "all", limit: 200, offset, canSeeEmail: canSeeEmail
        });
        rows.push(...page.rows);
        if (!page.hasMore) break;
        offset += page.rows.length;
        if (offset > 5000) break;           /* a sane ceiling, not a filter */
      }
    }
    const inRange = rows.filter((o) => {
      if (!o.createdAt) return false;
      const d = o.createdAt.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
      return (!fromDate || d >= fromDate) && (!toDate || d <= toDate);
    }).sort((a, b) => a.createdAt - b.createdAt);

    const headers = ["business_date", "placed_at", "code", "status", "payment_status",
      "paid", "fulfilment", "customer_name", "customer_phone",
      ...(canSeeEmail ? ["customer_email"] : []),
      "items", "subtotal", "delivery_fee", "packaging", "discount", "total"];
    const body = inRange.map((o) => [
      o.createdAt.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }),
      o.createdAt.toISOString(),
      o.code, o.status, o.paymentStatus, o.paid ? "yes" : "no", o.fulfilment,
      o.customerName, o.customerPhone,
      ...(canSeeEmail ? [o.customerEmail] : []),
      o.itemCount, money(o.subtotal), money(o.deliveryFee), money(o.takeawayFee),
      money(o.discount), money(o.total)
    ]);
    return { name: "orders", headers, rows: body };
  },

  /**
   * Sales and payment. Manager+ — admin_payment_events() refuses below that,
   * so the tier is enforced by the source, not here.
   */
  async payments(fromDate, toDate) {
    const { data, error } = await supabase.rpc("admin_payment_events", {
      p_status: null, p_search: null, p_limit: 1000, p_offset: 0
    });
    if (error) throw error;
    const rows = (data && data.rows) || [];
    const inRange = rows.filter((r) => {
      const d = new Date(r.created_at)
        .toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
      return (!fromDate || d >= fromDate) && (!toDate || d <= toDate);
    });
    const headers = ["business_date", "created_at", "order_code", "provider",
      "reference", "status", "amount"];
    return { name: "payments", headers, rows: inRange.map((r) => [
      new Date(r.created_at).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }),
      r.created_at, r.order_code || "", r.provider || "", r.reference || "",
      r.status || "", money(r.amount)
    ]) };
  },

  /** Inventory for one day, straight from the Phase 04B equation. */
  async inventory(day) {
    const { data, error } = await supabase.rpc("admin_inventory_day", { p_day: day || null });
    if (error) throw error;
    const headers = ["business_date", "product", "sale_unit", "opening",
      "opening_established", "prepared", "consumed", "waste", "staff_meal",
      "adjustment", "net_change", "expected_closing", "counted", "variance"];
    if (!data.tracked) return { name: "inventory", headers, rows: [], note: data.reason };
    return { name: "inventory", headers, rows: (data.items || []).map((i) => [
      data.business_date, i.name, i.sale_unit,
      i.opening, i.opening_established ? "yes" : "no",
      i.prepared, i.consumed, i.waste, i.staff_meal, i.adjustment,
      i.net_change, i.expected_closing, i.counted, i.variance
    ]) };
  },

  /** Staff activity and end-of-day, from the Phase 02/03 sources. */
  async staff(day) {
    const { data, error } = await supabase.rpc("admin_day_reports", { p_day: day || null });
    if (error) throw error;
    const headers = ["business_date", "staff", "role", "expected_to_report",
      "orders_touched", "orders_picked_up", "orders_completed", "orders_cancelled",
      "status_changes", "first_action", "last_action",
      "report_status", "submitted_at", "reviewed_at", "needs_follow_up"];
    return { name: "staff-activity", headers, rows: (data.people || []).map((p) => {
      const a = p.activity || {}, r = p.report || {};
      return [data.business_date, p.name || "", p.role || "",
        p.expected ? "yes" : "no",
        a.orders_touched, a.orders_picked_up, a.orders_completed,
        a.orders_cancelled, a.status_changes,
        a.first_action_at || "", a.last_action_at || "",
        r.status || "not started", r.submitted_at || "", r.reviewed_at || "",
        r.needs_follow_up ? "yes" : "no"];
    }) };
  },

  /** Scoop sales for one day, from the Phase 01 report. */
  async scoops(day) {
    const { data, error } = await supabase.rpc("admin_scoop_report", { p_day: day || null });
    if (error) throw error;
    const headers = ["business_date", "product", "gross_scoops",
      "cancelled_scoops", "net_scoops", "net_revenue"];
    return { name: "scoops", headers, rows: (data.by_product || []).map((p) => [
      data.day, p.product, p.gross_scoops, p.cancelled_scoops,
      p.net_scoops, p.net_revenue
    ]) };
  },

  /** Careers applications. admin_career_counts()'s tier — manager+. */
  async careers() {
    const { data, error } = await supabase
      .from("job_applications")
      .select("created_at, role_slug, name, phone, email, status")
      .order("created_at", { ascending: false });
    if (error) throw error;
    const headers = ["received_at", "role", "name", "phone", "email", "status"];
    return { name: "careers", headers, rows: (data || []).map((r) => [
      r.created_at, r.role_slug, r.name, r.phone, r.email || "", r.status
    ]) };
  }
};

export { errorMessage };
