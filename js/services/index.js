/* ==========================================================================
   Kandy's Treats — Service layer entry point
   --------------------------------------------------------------------------
   Loaded once per page as <script type="module">, AFTER the classic UI
   scripts. Module scripts are deferred, so window.KT and its components
   already exist by the time this runs.

   MIGRATION STATE (Phase 4 — auth + profile)
     Supabase : auth, profile, addresses, favourites, catalogue, orders,
                reviews, announcements, contact, support
     Firebase : NONE. No live service imports the Firebase SDK.
     Deferred : wallet, notifications, reviews, support, payments.
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

  const { menuService } = await import("./menu.js");
  const { contentService } = await import("./content.js");
  const { reviewService } = await import("./reviews.js");

  /* Not migrated yet. Inert stand-ins with the same method surface, so the UI
     renders empty states instead of spraying permission-denied errors from
     Firestore queries made with a Supabase UUID. See deferred.js. */
  const { addressService } = await import("./addresses.js");
  const { orderService } = await import("./orders.js");
  const { paymentService } = await import("./payments.js");
  const { chatService } = await import("./chat.js");
  const { careersService } = await import("./careers.js");
  const { walletService } = await import("./wallet.js");

  /* Every live service is Supabase now, so one error handler covers them. */
  const errorMessage = supaError;

  KT.auth = authService;
  KT.services = {
    auth: authService,
    account: accountService,
    menu: menuService,
    content: contentService,
    reviews: reviewService,
    addresses: addressService,
    orders: orderService,
    payments: paymentService,
    chat: chatService,
    careers: careersService,
    wallet: walletService,
    errorMessage,
    backend: {
      auth: "supabase", profile: "supabase",
      addresses: "supabase", favourites: "supabase",
      catalogue: "supabase", orders: "supabase",
      reviews: "supabase", content: "supabase",
      payments: "supabase+paystack", wallet: "supabase+paystack",
      chat: "supabase+realtime", careers: "supabase"
    }
  };

  /* Auth settles first and is cheap — it is what decides whether a page shows
     an account or a sign-in prompt, so nothing should wait behind it. */
  await authService.ready();

  /* Only now may auth events reach page code: KT.auth and KT.services exist. */
  authService.beginBroadcast();

  document.documentElement.classList.add("has-services");
  document.dispatchEvent(new CustomEvent("kt:services", { detail: { ok: true } }));

  /* The catalogue loads independently and announces itself with kt:menu, which
     home / menu / product / cart already listen for. Awaiting it here used to
     hold kt:services for seconds, so the account and orders pages sat on a
     stale or empty state waiting for food data they never needed. */
  /* Only the storefront has a catalogue to hydrate. The admin app loads this
     same service layer without js/data/menu.js or the cart, and menuService
     writes straight into window.KT.menu / window.KT.cart — so starting it
     there would throw during boot. */
  if (window.KT.menu && window.KT.cart) {
    menuService.load()
      .then(() => menuService.watch())
      .catch((error) => console.warn("[Kandy's] menu load deferred:", error));
  }
}

boot().catch((error) => {
  console.warn("[Kandy's] running without the backend:", error);
  document.documentElement.classList.add("no-services");
  document.dispatchEvent(new CustomEvent("kt:services", {
    detail: { ok: false, error: String(error && error.message || error) }
  }));
});
