/* Referral aggregates and admin/owner-only partner controls. RPCs enforce access. */
(function (KT) {
  "use strict";

  KT.admin = KT.admin || {};

  var svc = null;
  var mountGen = 0;
  var viewGen = -1;
  var state = { loading: true, error: null, data: null };
  var ctx = { role: "staff" };
  var selectedId = "";
  var searchTerm = "";
  var saving = false;

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

  function badge(label, kind) {
    return '<span class="refbadge refbadge--' + kind + '">' + esc(label) + '</span>';
  }

  function customerOptions(users) {
    var matches = users.filter(function (u) {
      return !searchTerm || [u.name, u.code].concat(u.aliases || []).join(" ").toLowerCase().includes(searchTerm);
    });
    var selected = users.find(function (u) { return u.id === selectedId; });
    if (selected && !matches.some(function (u) { return u.id === selectedId; })) matches.unshift(selected);
    return '<option value="">' + (matches.length ? 'Choose a customer…' : 'No matching customers') + '</option>' + matches.map(function (u) {
      return '<option value="' + esc(u.id) + '"' + (u.id === selectedId ? ' selected' : '') + '>' +
        esc(u.name || u.id) + ' · ' + (u.enabled ? 'Partner' : 'Normal') + ' · ' + esc(u.code || 'No code') + '</option>';
    }).join('');
  }

  function partnerHTML() {
    var d = state.data && state.data.partners;
    if (!d) return "";
    return '<section class="panel apanel refpartner" aria-labelledby="partnerTitle">' +
      '<div class="refsection-head"><div><p class="refeyebrow">Partner management</p><h2 id="partnerTitle">Celebrity / Partner Referrers</h2>' +
      '<p>Manage promo codes and the referral mode for a selected customer.</p></div>' + badge('Admin / Owner', 'neutral') + '</div>' +
      '<div class="refcontrols"><div class="refcontrol-card"><h3>1. Choose a customer</h3>' +
      '<div class="field"><label class="field__label" for="partnerSearch">Search customers</label>' +
      '<input class="input" id="partnerSearch" type="search" data-partner-search value="' + esc(searchTerm) + '" placeholder="Name, promo code or old alias" aria-describedby="partnerSearchHint">' +
      '<p class="field__hint" id="partnerSearchHint">Filter the list, then select the account you want to manage.</p></div>' +
      '<div class="field"><label class="field__label" for="partnerUser">Customer · mode · current code</label>' +
      '<select class="select" id="partnerUser" data-partner-user>' + customerOptions(d.users) + '</select></div>' +
      '<div class="refselected" data-partner-account-detail aria-live="polite"></div></div>' +
      '<div class="refcontrol-card"><h3>2. Promo code &amp; mode</h3>' +
      '<div class="field"><label class="field__label" for="partnerCode">New custom promo code</label>' +
      '<input class="input refcode-input" id="partnerCode" data-partner-code placeholder="e.g. TEMMIE" maxlength="20" autocapitalize="characters" spellcheck="false" aria-describedby="partnerCodeHint">' +
      '<p class="field__hint" id="partnerCodeHint">4–20 letters or numbers. Codes are saved in uppercase.</p></div>' +
      '<button type="button" class="btn btn--primary" data-partner-save disabled>Update promo code</button>' +
      '<p class="refalias-note">Previous codes stay reserved as aliases, so shared links keep working.</p>' +
      '<div class="refmode-actions"><div><strong>Referral mode</strong><p>Update the mode, or leave the code blank to keep the current code.</p></div>' +
      '<div class="refbuttons"><button type="button" class="btn btn--soft" data-partner-enable disabled>Enable Partner</button>' +
      '<button type="button" class="btn btn--ghost refdisable" data-partner-disable disabled>Disable Partner</button></div></div></div></div>' +
      '<div class="refresults-head"><div><h3>Attributed customers &amp; rewards</h3><p>Mode is recorded at signup. Commission applies to the first qualifying order.</p></div>' +
      '<span class="refcount">' + d.referrals.length + ' referrals</span></div>' +
      '<p class="refscroll-hint">Scroll the table sideways to view all columns.</p>' +
      '<div class="reftable-wrap" tabindex="0" role="region" aria-label="Referral results — scroll horizontally"><table class="reftable"><caption class="sr-only">Customers attributed to referrers and their qualifying rewards</caption><thead><tr>' +
      '<th scope="col">Referrer</th><th scope="col">Customer</th><th scope="col">Mode at signup</th><th scope="col">Code used</th><th scope="col">Order</th><th scope="col" class="refmoney">10% base</th><th scope="col" class="refmoney">Commission</th><th scope="col">Credited</th></tr></thead><tbody>' +
      (d.referrals.length ? d.referrals.map(function (r) {
        var referrer = d.users.find(function (u) { return u.id === r.referrer_id; });
        var status = r.partner_reward ? (r.credited ? badge('Credited','credited') : (r.commission === 0 && r.order_id ? badge('No credit due','neutral') : badge('Pending','pending'))) : badge('N/A','neutral');
        return '<tr><td>' + esc((referrer || {}).name || r.referrer_id || 'Deleted account') + '</td><td>' + esc(r.customer_name || r.customer_id) + '</td><td>' +
          badge(r.partner_reward ? 'Partner' : 'Normal', r.partner_reward ? 'partner' : 'neutral') + '</td><td><code class="refcode">' + esc(r.code_used || 'Unknown (legacy)') + '</code></td>' +
          '<td class="reforder">' + (r.order_id ? '<span title="' + esc(r.order_id) + '">' + esc(r.order_id) + '</span>' : '<span class="refmuted">Awaiting order</span>') + '</td>' +
          '<td class="refmoney">' + esc(r.base == null ? '—' : KT.naira(r.base)) + '</td><td class="refmoney"><strong>' + esc(r.commission == null ? '—' : KT.naira(r.commission)) + '</strong></td><td>' + status + '</td></tr>';
      }).join('') : '<tr><td colspan="8" class="refempty">No attributed customers yet. Referrals will appear here when customers join through a reserved code.</td></tr>') +
      '</tbody></table></div><p class="refalias-note">Credited refers to Partner wallet commission. Normal referrals use the existing points rewards.</p></section>';
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

      '<section class="panel apanel refsettings" aria-labelledby="rewardSettingsTitle">' +
        '<div class="refsection-head"><div><p class="refeyebrow">Reward settings</p><h2 id="rewardSettingsTitle">Current reward settings</h2><p>Normal referral rewards and points conversion.</p></div>' + badge('Read only', 'neutral') + '</div>' +
        '<dl class="refsettings-list">' +
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
      "</section>"
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
    selectedPartnerDetail();
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
    selectedId = ""; searchTerm = ""; saving = false;
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
    document.querySelectorAll("[data-partner-save], [data-partner-enable], [data-partner-disable]").forEach(function (button) {
      (/** @type {HTMLButtonElement} */ (button)).disabled = !user || saving;
    });
    select.disabled = saving;
    var codeInput = /** @type {HTMLInputElement} */ (document.querySelector("[data-partner-code]"));
    var searchInput = /** @type {HTMLInputElement} */ (document.querySelector("[data-partner-search]"));
    if (codeInput) codeInput.disabled = !user || saving;
    if (searchInput) searchInput.disabled = saving;
    if (!user) { host.innerHTML = '<p class="refmuted">No customer selected. Choose an account above to view its code and aliases.</p>'; return; }
    host.innerHTML = '<div class="refselected-head"><div><span class="refeyebrow">Selected customer</span><strong>' + esc(user.name || user.id) + '</strong></div>' +
      badge(user.enabled ? 'Partner' : 'Normal', user.enabled ? 'partner' : 'neutral') + '</div>' +
      '<dl><div><dt>Current promo code</dt><dd><code class="refcode">' + esc(user.code || 'No code yet') + '</code></dd></div>' +
      '<div><dt>Previous aliases</dt><dd class="refaliases">' + ((user.aliases || []).length ? user.aliases.map(function (code) { return '<code class="refcode">' + esc(code) + '</code>'; }).join(' ') : '<span class="refmuted">None yet</span>') + '</dd></div></dl>';
  }

  document.addEventListener("input", function (e) {
    var target = /** @type {HTMLInputElement} */ (e.target);
    if (!target.matches("[data-partner-search]")) return;
    var select = KT.qs("[data-partner-user]");
    var d = state.data && state.data.partners;
    if (!select || !d) return;
    searchTerm = String(target.value || "").trim().toLowerCase();
    select.innerHTML = customerOptions(d.users);
    selectedPartnerDetail();
  });

  document.addEventListener("change", function (e) {
    if ((/** @type {Element} */ (e.target)).matches("[data-partner-user]")) {
      selectedId = (/** @type {HTMLSelectElement} */ (e.target)).value;
      var input = /** @type {HTMLInputElement} */ (document.querySelector("[data-partner-code]"));
      if (input) input.value = "";
      selectedPartnerDetail();
    }
  });

  document.addEventListener("click", async function (e) {
    var target = /** @type {Element} */ (e.target);
    var enable = target.closest("[data-partner-enable]");
    var disable = target.closest("[data-partner-disable]");
    var save = target.closest("[data-partner-save]");
    if (enable || disable || save) {
      if (saving) return;
      var select = /** @type {HTMLSelectElement} */ (document.querySelector("[data-partner-user]"));
      var input = /** @type {HTMLInputElement} */ (document.querySelector("[data-partner-code]"));
      if (!select.value) { KT.toast("Select a customer first.", "info"); return; }
      var user = state.data.partners.users.find(function (u) { return u.id === select.value; });
      if (save && !input.value.trim()) { KT.toast("Enter a new promo code first.", "info"); input.focus(); return; }
      var gen = mountGen;
      saving = true; selectedPartnerDetail();
      try {
        await svc.setPartner(select.value, save ? user.enabled : !!enable, input.value);
        if (gen !== mountGen) return;
        KT.toast(save ? "Promo code updated. Previous aliases are preserved." : (enable ? "Partner mode enabled." : "Partner mode disabled."), "success");
        await load();
      } catch (error) { if (gen === mountGen) KT.toast(String(error.message || error), "error"); }
      finally { if (gen === mountGen) { saving = false; selectedPartnerDetail(); } }
      return;
    }
    if (target.closest("[data-rretry]")) load();
  });
})(window.KT || (window.KT = {}));
