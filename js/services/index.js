/* ==========================================================================
   Kandy's Treats — Service layer entry point
   --------------------------------------------------------------------------
   Loaded once per page as <script type="module">, AFTER the classic UI
   scripts. Module scripts are deferred, so window.KT and its components
   already exist by the time this runs.

   Why the split: the approved V2 interface is built from classic scripts on a
   global `KT` namespace. Rather than rewrite every component as a module
   (and risk the design), the Firebase layer lives behind this single module
   and publishes itself on `KT.services` / `KT.auth`. Pages react to the
   `kt:auth`, `kt:menu` and `kt:services` events.

   If Firebase fails to load — offline, blocked, or opened over file:// — the
   storefront still renders from the bundled menu snapshot. Ordering is
   blocked in that state rather than guessed at.
   ========================================================================== */

const KT = window.KT;

async function boot() {
  const { errorMessage } = await import("./firebase.js");
  const { authService } = await import("./auth.js");
  const { menuService } = await import("./menu.js");
  const { addressService } = await import("./addresses.js");
  const { orderService } = await import("./orders.js");
  const { paymentService } = await import("./payments.js");
  const { walletService } = await import("./wallet.js");
  const { accountService } = await import("./account.js");

  KT.auth = authService;
  KT.services = {
    auth: authService,
    menu: menuService,
    addresses: addressService,
    orders: orderService,
    payments: paymentService,
    wallet: walletService,
    account: accountService,
    errorMessage
  };

  /* Menu first — it decides whether ordering is allowed at all. */
  await menuService.load();
  menuService.watch();

  /* Then settle auth so pages can render the right state once, not twice. */
  await authService.ready();

  document.documentElement.classList.add("has-services");
  document.dispatchEvent(new CustomEvent("kt:services", { detail: { ok: true } }));
}

boot().catch((error) => {
  console.warn("[Kandy's] running without the backend:", error);
  document.documentElement.classList.add("no-services");
  document.dispatchEvent(new CustomEvent("kt:services", {
    detail: { ok: false, error: String(error && error.message || error) }
  }));
});
