/* ==========================================================================
   Kandy's Treats — Accept a team invitation
   --------------------------------------------------------------------------
   Where an invitation link lands. It does exactly one privileged thing —
   call accept_staff_invitation(token) — and everything that decides the
   outcome happens inside that function, in the database:

     · the caller must be signed in
     · their email must be confirmed
     · their email must MATCH the invited address
     · the invitation must be pending, unexpired and unrevoked
     · an invitation can only raise a role, never lower one

   So this page cannot grant anything. If someone opens the link while signed
   in as the wrong account, the RPC refuses and says which address to use.

   THE ROUND TRIP
   --------------
   An invitee usually has no account yet, so they must leave to sign up and
   come back. The token is parked in sessionStorage before they go and read
   back on return, which is why the sign-up link carries ?next=join rather
   than the token itself: a token in a URL that bounces through an auth
   provider ends up in more logs than it needs to.

   No password is chosen, seen or stored here. Sign-up is the ordinary
   Supabase flow the storefront already uses.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.pages = KT.pages || {};

  var KEY = "kt.invite_token";
  var state = { token: "", busy: false, done: false };

  function title(t) {
    var el = KT.qs("[data-join-title]");
    if (el) el.textContent = t;
  }
  function lede(t) {
    var el = KT.qs("[data-join-lede]");
    if (el) el.textContent = t;
  }
  function body(html) {
    var el = KT.qs("[data-join-body]");
    if (el) el.innerHTML = html;
  }

  /**
   * Read the token from the URL, remember it, and strip it from the address
   * bar so it is not left in history or in a shared screenshot.
   */
  function claimToken() {
    var fromUrl = new URLSearchParams(window.location.search).get("token");
    if (fromUrl) {
      try { window.sessionStorage.setItem(KEY, fromUrl); } catch (e) { /* private mode */ }
      var url = new URL(window.location.href);
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
      return fromUrl;
    }
    try { return window.sessionStorage.getItem(KEY) || ""; } catch (e) { return ""; }
  }

  function forget() {
    try { window.sessionStorage.removeItem(KEY); } catch (e) { /* nothing to do */ }
  }

  /* ---- Screens ----------------------------------------------------------- */

  function noToken() {
    title("Invitation not found");
    lede("This page needs an invitation link.");
    body(
      '<p class="authnote">Open the link you were sent. If it has expired, ask ' +
      "whoever invited you to send a new one.</p>" +
      '<a class="btn btn--primary btn--block" style="margin-top:18px" href="' +
      KT.url("index.html") + '">Back to the site</a>');
  }

  function signedOut() {
    title("Join the team");
    lede("Sign in — or create your account — with the email your invitation was sent to.");
    body(
      '<p class="authnote">' + KT.icon("lock", 16) +
      " Your invitation is tied to one email address. Signing in with a different " +
      "account will not accept it.</p>" +
      '<div class="authactions" style="margin-top:18px">' +
        '<a class="btn btn--primary btn--block" href="' +
          KT.url("pages/signup.html?next=join") + '">Create my account</a>' +
        '<a class="btn btn--ghost btn--block" style="margin-top:10px" href="' +
          KT.url("pages/login.html?next=join") + '">I already have an account</a>' +
      "</div>");
  }

  function ready(email) {
    title("Accept your invitation");
    lede("You are signed in as " + email + ".");
    body(
      '<p class="authnote">Accepting adds your Kandy\'s Treats team role to this ' +
      "account. Your password and your customer details do not change.</p>" +
      '<button class="btn btn--primary btn--lg btn--block" style="margin-top:18px" ' +
        'type="button" data-join-accept>Accept invitation</button>' +
      '<a class="btn btn--ghost btn--block" style="margin-top:10px" href="' +
        KT.url("pages/account.html") + '">Not now</a>');
  }

  function accepted(role) {
    state.done = true;
    forget();
    title("You are in");
    lede("Your account now has " + role + " access.");
    body(
      '<p class="authnote">' + KT.icon("check", 16) +
      " Sign-in stays exactly as it was — same email, same password. The admin " +
      "area is now open to you.</p>" +
      '<a class="btn btn--primary btn--lg btn--block" style="margin-top:18px" href="' +
        KT.url("admin/index.html") + '">Open the admin</a>' +
      '<a class="btn btn--ghost btn--block" style="margin-top:10px" href="' +
        KT.url("index.html") + '">Back to the site</a>');
  }

  function refused(message) {
    title("We could not accept that invitation");
    lede(message);
    body(
      '<a class="btn btn--ghost btn--block" style="margin-top:18px" href="' +
      KT.url("pages/account.html") + '">Go to my account</a>');
  }

  /* ---- Flow -------------------------------------------------------------- */

  function render() {
    if (state.done) return;
    if (!state.token) return noToken();
    if (KT.authResolving && KT.authResolving()) {
      title("Join the team");
      lede("Checking your invitation…");
      body(KT.skeleton.lines(2));
      return;
    }
    if (!(KT.auth && KT.auth.isSignedIn())) return signedOut();
    ready((KT.auth.user() || {}).email || "this account");
  }

  async function accept(btn) {
    var done = KT.busy(btn, "Accepting…");
    if (!done) return;
    try {
      var mod = await import("../services/supabase.js");
      var res = await mod.supabase.rpc("accept_staff_invitation", { p_token: state.token });
      if (res.error) throw res.error;
      var out = res.data || {};
      accepted(out.to || out.role || "team");
      KT.toast("Invitation accepted.", "success");
    } catch (error) {
      done();
      /* The RPC's message is the useful one — it names the address to use, or
         says the link expired. Passing it through verbatim beats a generic
         apology. */
      refused((error && error.message) ||
        (KT.services && KT.services.errorMessage(error)) ||
        "That invitation could not be accepted.");
    }
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-join-accept]");
    if (!btn) return;
    e.preventDefault();
    accept(btn);
  });

  document.addEventListener("kt:auth", render);
  document.addEventListener("kt:services", render);

  KT.pages.join = function () {
    /* The auth layout has a brand panel beside the form; without this it sits
       as an empty plum rectangle, which reads as a failed image. */
    var art = KT.qs("[data-auth-art]");
    if (art && KT.images) art.src = KT.images.src("kitchen-story");

    state.token = claimToken();
    render();
  };
})(window.KT || (window.KT = {}));
