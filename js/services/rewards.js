/* ==========================================================================
   Kandy's Treats — Kandy Rewards
   --------------------------------------------------------------------------
   Points, referrals, and the one call that turns points into wallet credit.

   NOTHING HERE HAS FINANCIAL AUTHORITY
   ------------------------------------
   Look at redeem(): it sends no arguments. Not an amount, not a rate, not a
   user. redeem_reward_points() reads who is calling from auth.uid() and what
   a redemption is worth from app_settings, so there is no number this file
   could send that would change what a customer receives.

   The same is true of earning. `authenticated` holds SELECT and nothing else
   on reward_points, referrals, referral_codes and reward_redemptions — no
   INSERT, no UPDATE. A browser cannot award a point, advance a referral, or
   change who referred whom, because those statements are refused before any
   policy is consulted.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";
import { authService } from "./auth.js";

export const rewardsService = {
  /**
   * The caller's own rewards: balance, lifetime totals, referral counts and
   * the current conversion rate. Own data only — the RPC takes no user.
   */
  async summary() {
    if (!authService.uid()) return null;
    const { data, error } = await supabase.rpc("my_rewards");
    if (error) throw error;
    if (!data) return null;
    return {
      code: data.code || null,
      available: Number(data.available) || 0,
      earned: Number(data.earned) || 0,
      redeemed: Number(data.redeemed) || 0,
      expiring: Number(data.expiring) || 0,
      referralsTotal: Number(data.referrals_total) || 0,
      referralsPending: Number(data.referrals_pending) || 0,
      referralsSuccess: Number(data.referrals_success) || 0,
      ratePoints: Number(data.rate_points) || 500,
      rateNaira: Number(data.rate_naira) || 500,
      minOrder: Number(data.min_order) || 2500
    };
  },

  /**
   * Issues this customer's referral code, creating it on the first ask.
   * Lazy by design: existing customers get a code when they come looking for
   * one, and nobody is backfilled.
   */
  async ensureCode() {
    if (!authService.uid()) return null;
    const { data, error } = await supabase.rpc("my_referral_code");
    if (error) throw error;
    return data || null;
  },

  /**
   * Convert points into wallet credit.
   *
   * NO ARGUMENTS, deliberately — see the header. The server decides the cost,
   * the payout and the recipient. All this can do is ask.
   */
  async redeem() {
    const { data, error } = await supabase.rpc("redeem_reward_points");
    if (error) throw error;
    return data;
  },

  /** Manager+ analytics. Aggregates only; refused below admin server-side. */
  async adminOverview() {
    const { data, error } = await supabase.rpc("admin_referral_overview");
    if (error) throw error;
    return data;
  }
};

export { errorMessage };
