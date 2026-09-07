/* ==========================================================================
   Kandy's Treats — Referral analytics
   --------------------------------------------------------------------------
   How the referral programme is doing, in aggregate. Manager+ only, and
   enforced by admin_referral_overview() rather than by this file — a
   supervisor who edits the hash reaches a refusal from Postgres, not an
   empty screen that looks like a bug.

   AGGREGATES ONLY, ON PURPOSE
   ---------------------------
   There is no per-customer list here and no way to ask for one. A manager
   needs to know whether the programme converts and what it is costing, not
   who invited whom — and a referral graph is exactly the kind of social data
   that should not be casually browsable by staff. The RPC returns counts and
   sums; it never returns a name, an email, a phone number or a user id.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var svc = null;
  var mountGen = 0;
  var viewGen = -1;
  var state = { loading: true, error: null, data: null };
  var ctx = { role: "staff" };

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function tile(label, value, note) {
    return '<div class="rstat">' +
      '<p class="rstat__label">' + esc(label) + "</p>" +
      '<p class="rstat__value">' + esc(String(value)) + "</p>" +
      (note ? '<p class="rstat__note">' + esc(note) + "</p>" : "") +
    "</div>";
  }

  function bodyHTML() {
    var d = state.data;
    if (!d) return "";
    var s = d.settings || {};
    var success = Number(d.referrals_success) || 0;
    var total = Number(d.referrals_total) || 0;
    /* Conversion is signups that went on to a qualifying order. Shown as "—"
       rather than 0% when nobody has signed up, because 0-of-0 is not a
       failure rate, it is no data. */
    var rate = total > 0 ? Math.round((success / total) * 100) + "%" : "—";

    return (
      '<div class="panel apanel">' +
        "<h3>Programme</h3>" +
        '<div class="rstats">' +
          tile("Referral codes issued", d.codes_issued) +
          tile("Total referrals", total) +
          tile("Successful", success) +
          tile("Pending", d.referrals_pending) +
          tile("Conversion", rate, "signups that reached a qualifying order") +
        "</div>" +
      "</div>" +

      '<div class="panel apanel">' +
        "<h3>Points</h3>" +
        '<div class="rstats">' +
          tile("Points issued", d.points_issued) +
          tile("Points redeemed", d.points_redeemed) +
          tile("Outstanding", d.points_outstanding, "unexpired and unspent") +
          tile("Credited to wallets", KT.naira(Number(d.naira_credited) || 0)) +
        "</div>" +
        '<p class="invhint">Outstanding points are a liability: they can still ' +
          "become wallet credit at " + esc(String(s.rate_points)) + " points to " +
          KT.naira(Number(s.rate_naira) || 0) + ".</p>" +
      "</div>" +

      '<div class="panel apanel">' +
        "<h3>Orders</h3>" +
        '<div class="rstats">' +
          tile("Qualifying orders", d.referral_orders) +
          tile("Revenue from them", KT.naira(Number(d.referral_revenue) || 0)) +
        "</div>" +
      "</div>" +

      '<div class="panel apanel">' +
        "<h3>Current settings</h3>" +
        '<dl class="osum osum--readonly">' +
          '<div class="osum__row"><dt>Referrer reward</dt><dd>' +
            esc(String(s.referrer_points)) + " points</dd></div>" +
          '<div class="osum__row"><dt>New customer reward</dt><dd>' +
            esc(String(s.referred_points)) + " points</dd></div>" +
          '<div class="osum__row"><dt>Minimum qualifying order</dt><dd>' +
            KT.naira(Number(s.min_order) || 0) + "</dd></div>" +
          '<div class="osum__row"><dt>Points expire after</dt><dd>' +
            esc(String(s.expiry_days)) + " days</dd></div>" +
          '<div class="osum__row"><dt>Redemption</dt><dd>' +
            esc(String(s.rate_points)) + " points → " +
            KT.naira(Number(s.rate_naira) || 0) + "</dd></div>" +
        "</dl>" +
        '<p class="invhint">Reward economics are owner-only settings. Change ' +
          "them under <strong>App settings</strong>.</p>" +
      "</div>"
    );
  }

  function head() {
    return '<header class="apage__head"><div><h1>Referrals</h1>' +
      '<p class="apage__lede">How Kandy Rewards is performing. Aggregates ' +
      "only — no individual customer data.</p></div></header>";
  }

  function render() {
    if (viewGen !== mountGen) return;
    var host = KT.qs("[data-admin-page]");
    if (!host) return;
    var body;
    if (state.loading) body = '<div class="panel apanel">' + KT.skeleton.lines(5) + "</div>";
    else if (state.error) {
      body = '<div class="panel apanel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("close", 32) + "</div>" +
        "<h3>We could not load referral analytics</h3><p>" + esc(state.error) + "</p>" +
        '<button class="btn btn--primary" type="button" data-rretry>Try again</button>' +
        "</div></div>";
    } else body = bodyHTML();
    KT.mount(host, head() + body);
  }

  async function load() {
    var gen = mountGen;
    state.loading = true; state.error = null; render();
    try {
      if (!svc) svc = (await import("../services/rewards.js")).rewardsService;
      var d = await svc.adminOverview();
      if (gen !== mountGen) return;
      state.data = d;
    } catch (error) {
      if (gen !== mountGen) return;
      state.error = (KT.services && KT.services.errorMessage)
        ? KT.services.errorMessage(error) : String(error.message || error);
    } finally {
      if (gen === mountGen) { state.loading = false; render(); }
    }
  }

  KT.admin.views.referrals = function (viewCtx) {
    ctx = viewCtx || ctx;
    var gen = ++mountGen; viewGen = gen;
    state = { loading: true, error: null, data: null };
    setTimeout(function () { if (gen === mountGen) load(); }, 0);
    return head() + '<div class="panel apanel">' + KT.skeleton.lines(5) + "</div>";
  };

  KT.admin.views.referralsTeardown = function () { mountGen += 1; };

  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-rretry]")) load();
  });
})(window.KT || (window.KT = {}));
