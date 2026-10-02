/* Referral aggregates and admin/owner-only partner controls. RPCs enforce access. */
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

  function partnerHTML() {
    var d = state.data && state.data.partners;
    if (!d) return "";
    return '<div class="panel apanel"><h3>Celebrity / Partner referrers</h3>' +
      '<label for="partnerSearch">Find customer</label><input id="partnerSearch" type="search" data-partner-search placeholder="Search by name or promo code">' +
      '<select data-partner-user><option value="">Select customer</option>' + d.users.map(function (u) {
        return '<option value="' + esc(u.id) + '">' + esc(u.name || u.id) + ' — ' +
          (u.enabled ? 'Partner' : 'Normal') + ' — ' + esc(u.code || 'No code') + '</option>';
      }).join('') + '</select><div data-partner-account-detail aria-live="polite"></div>' +
      '<label for="partnerCode">Custom promo code</label><input id="partnerCode" data-partner-code placeholder="Optional; preserves previous aliases" maxlength="20">' +
      '<button class="btn btn--soft" data-partner-enable>Enable Partner</button>' +
      '<button class="btn btn--soft" data-partner-disable>Disable Partner</button>' +
      '<div style="overflow:auto"><table><thead><tr><th>Referrer</th><th>Customer</th><th>Mode at signup</th><th>Code used</th><th>Order</th><th>10% base</th><th>Commission</th><th>Credited</th></tr></thead><tbody>' +
      d.referrals.map(function (r) {
        return '<tr><td>' + esc((d.users.find(function (u) { return u.id === r.referrer_id; }) || {}).name || r.referrer_id) + '</td><td>' + esc(r.customer_name || r.customer_id) + '</td><td>' + (r.partner_reward ? 'Partner' : 'Normal') + '</td><td>' + esc(r.code_used || 'Unknown (legacy)') +
          '</td><td>' + esc(r.order_id || 'Pending') + '</td><td>' + esc(r.base == null ? '—' : KT.naira(r.base)) +
          '</td><td>' + esc(r.commission == null ? '—' : KT.naira(r.commission)) + '</td><td>' + (r.credited ? 'Yes' : 'No') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
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
      "with admin-only partner controls.</p></div></header>";
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
    } else body = bodyHTML() + partnerHTML();
    KT.mount(host, head() + body);
  }

  async function load() {
    var gen = mountGen;
    state.loading = true; state.error = null; render();
    try {
      if (!svc) svc = (await import("../services/rewards.js")).rewardsService;
      var d = await svc.adminOverview();
      d.partners = await svc.partners();
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

  function selectedPartnerDetail() {
    var d = state.data && state.data.partners;
    var select = KT.qs("[data-partner-user]");
    var host = KT.qs("[data-partner-account-detail]");
    if (!d || !select || !host) return;
    var user = d.users.find(function (u) { return u.id === select.value; });
    if (!user) { host.innerHTML = ""; return; }
    host.innerHTML = '<p><strong>Mode:</strong> ' + (user.enabled ? 'Celebrity / Partner' : 'Normal') +
      ' · <strong>Current code:</strong> ' + esc(user.code || 'No code yet') +
      ' · <strong>Old aliases:</strong> ' + esc((user.aliases || []).join(', ') || 'None') + '</p>';
  }

  document.addEventListener("input", function (e) {
    var target = /** @type {HTMLInputElement} */ (e.target);
    if (!target.matches("[data-partner-search]")) return;
    var select = KT.qs("[data-partner-user]");
    var d = state.data && state.data.partners;
    if (!select || !d) return;
    var term = String(target.value || "").trim().toLowerCase();
    var selected = select.value;
    select.innerHTML = '<option value="">Select customer</option>' + d.users.filter(function (u) {
      return !term || [u.name, u.code].concat(u.aliases || []).join(" ").toLowerCase().includes(term);
    }).map(function (u) {
      return '<option value="' + esc(u.id) + '">' + esc(u.name || u.id) + ' — ' +
        (u.enabled ? 'Partner' : 'Normal') + ' — ' + esc(u.code || 'No code') + '</option>';
    }).join('');
    if (d.users.some(function (u) { return u.id === selected && (!term || [u.name,u.code].concat(u.aliases||[]).join(' ').toLowerCase().includes(term)); })) select.value = selected;
    selectedPartnerDetail();
  });

  document.addEventListener("change", function (e) {
    if ((/** @type {Element} */ (e.target)).matches("[data-partner-user]")) selectedPartnerDetail();
  });

  document.addEventListener("click", async function (e) {
    var target = /** @type {Element} */ (e.target);
    var enable = target.closest("[data-partner-enable]");
    var disable = target.closest("[data-partner-disable]");
    if (enable || disable) {
      var select = /** @type {HTMLSelectElement} */ (document.querySelector("[data-partner-user]"));
      var input = /** @type {HTMLInputElement} */ (document.querySelector("[data-partner-code]"));
      if (!select.value) { KT.toast("Select a customer first.", "info"); return; }
      try {
        await svc.setPartner(select.value, !!enable, input.value);
        await load();
      } catch (error) { KT.toast(String(error.message || error), "error"); }
      return;
    }
    if (e.target.closest("[data-rretry]")) load();
  });
})(window.KT || (window.KT = {}));
