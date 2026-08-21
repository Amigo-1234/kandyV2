/* ==========================================================================
   Kandy's Treats — Admin dashboard data access
   --------------------------------------------------------------------------
   One RPC, one call. admin_dashboard() assembles every count server-side and
   decides per tier what the response even contains — a staff caller receives
   no `finance` key at all, rather than a zero this file would have to
   remember to hide.

   Nothing is computed here. If a number is wrong, it is wrong in Postgres,
   which is also where it is testable.

   REALTIME
   --------
   The dashboard does not open a channel of its own. It reuses the channels
   the operational modules already run — orders and chat — and simply re-reads
   the RPC when one of them reports movement. That keeps one subscription per
   table for the whole admin app rather than one per screen, and it means the
   refreshed numbers come from the database rather than from a payload this
   module would otherwise have to fold in by hand.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

/** Channels this module owns. Named so a leak is obvious in getChannels(). */
let channel = null;

export const adminDashboardService = {
  async load() {
    const { data, error } = await supabase.rpc("admin_dashboard");
    if (error) throw error;
    return data;
  },

  /**
   * Watch the tables whose movement the dashboard reflects. `onChange` is
   * debounced by the caller — a burst of order updates should cost one
   * re-read, not five.
   *
   * Returns an unsubscribe. The dashboard view owns the lifecycle, so
   * re-entering the screen cannot stack a second channel.
   */
  watch(onChange) {
    adminDashboardService.unwatch();
    channel = supabase
      .channel("admin-dashboard")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "orders" }, onChange)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" }, onChange)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "support_tickets" }, onChange)
      .subscribe();
    return adminDashboardService.unwatch;
  },

  unwatch() {
    if (!channel) return;
    supabase.removeChannel(channel);
    channel = null;
  }
};

export { errorMessage };
