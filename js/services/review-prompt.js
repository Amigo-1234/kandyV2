/* ==========================================================================
   Kandy's Treats — Google review prompt
   --------------------------------------------------------------------------
   Two RPCs (migration 0078), nothing else:

     my_review_prompt_state(p_order_id?)  should this customer see the prompt
                                          now, for which order, with which link
     record_review_prompt(order, event)   shown | later | clicked

   Every decision — Completed + paid, 45 minutes to 14 days after completion,
   the 30-day snooze, the second "Maybe later", three ignored days, the
   180-day quiet after a click — is made on the server, per customer, so the
   browser, the installed app and a second phone all agree. This file only
   asks and reports.

   The link comes from app_settings.google_review_url via the state call. It
   is empty (feature off) until management sets it; nothing is hard-coded.

   "clicked" means the customer opened the Google link from our page. It is
   never reported as a submitted review: Google does not tell us that.

   Failure is silent by design. If the RPC is missing (migration not yet
   applied), the network drops or anything else goes wrong, the answer is
   simply "no prompt" — this must never get in the way of an order page.
   ========================================================================== */

import { supabase } from "./supabase.js";

const OFF = { show: false };

export const reviewPromptService = {
  /** @param {string|null} orderUuid  a specific order (Order Detail) or null (latest eligible) */
  async state(orderUuid = null) {
    try {
      const { data, error } = await supabase.rpc("my_review_prompt_state",
        { p_order_id: orderUuid || null });
      if (error || !data || data.show !== true || !data.url || !data.order_id) return OFF;
      return { show: true, orderUuid: data.order_id, orderCode: data.order_code || "", url: data.url };
    } catch {
      return OFF;
    }
  },

  /** Best effort: a lost event must never surface to the customer. */
  async record(orderUuid, event) {
    if (!orderUuid) return false;
    try {
      const { data, error } = await supabase.rpc("record_review_prompt",
        { p_order_id: orderUuid, p_event: event });
      return !error && !!(data && data.recorded);
    } catch {
      return false;
    }
  }
};
