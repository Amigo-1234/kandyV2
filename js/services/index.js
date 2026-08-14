/* ==========================================================================
   Kandy's Treats — Service layer entry point
   --------------------------------------------------------------------------
   Loaded once per page as <script type="module">, AFTER the classic UI
   scripts. Module scripts are deferred, so window.KT and its components
   already exist by the time this runs.

   MIGRATION STATE (Phase 4 — auth + profile)
     Supabase : auth, profile, addresses, favourites
     Firebase : menu, announcements, reviews (all PUBLIC reads, which need no
                session and therefore keep working unchanged)
     Deferred : orders, wallet, notifications, reviews, support.
                These are owner-scoped in Firestore and would be queried with a
                Supabase UUID that Firebase Auth has never seen, so they are
                not wired up here. All of them are empty in both backends.
                Phase 5 moves them.

   If the backend fails to load — offline, blocked, or opened over file:// —
   the storefront still renders from the bundled menu snapshot. Ordering is
   blocked in that state rather than guessed at.
   ========================================================================== */

const KT = window.KT;

async function boot() {
  /* Supabase first: auth is what everything else keys off. */
  const { errorMessage: supaError } = await import("./supabase.js");
  const { authService } = await import("./auth.js");
  const { accountService } = await import("./account.js");

  /* Firebase remains only for the public catalogue reads during the
     transition. It creates no auth listener, so there is exactly one
     dispatcher for kt:auth. */
  const { errorMessage: fbError } = await import("./firebase.js");
  const { menuService } = await import("./menu.js");
  const { contentService } = await import("./content.js");
  const { reviewService } = await import("./reviews.js");

  /* Not migrated yet. Inert stand-ins with the same method surface, so the UI
     renders empty states instead of spraying permission-denied errors from
     Firestore queries made with a Supabase UUID. See deferred.js. */
  const { addressService } = await import("./addresses.js");
  const {
    orderServiceDeferred, paymentServiceDeferred, walletServiceDeferred
  } = await import("./deferred.js");

  /* Two backends are live at once during the migration, so route each error
     to the handler that understands it. Firebase codes look like
     "permission-denied" or "auth/wrong-password"; Postgres codes are SQLSTATE
     ("42501") or PostgREST ("PGRST116"). */
  function errorMessage(error) {
    const code = String((error && error.code) || "");
    const looksFirebase = /^[a-z]+\/[a-z-]+$/.test(code) || /^[a-z]+-[a-z-]+$/.test(code);
    return looksFirebase ? fbError(error) : supaError(error);
  }

  KT.auth = authService;
  KT.services = {
    auth: authService,
    account: accountService,
    menu: menuService,
    content: contentService,
    reviews: reviewService,
    addresses: addressService,
    orders: orderServiceDeferred,
    payments: paymentServiceDeferred,
    wallet: walletServiceDeferred,
    errorMessage,
    backend: {
      auth: "supabase", profile: "supabase",
      addresses: "supabase", favourites: "supabase",
      catalogue: "firebase"
    }
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
