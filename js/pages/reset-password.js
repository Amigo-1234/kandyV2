/* ==========================================================================
   Kandy's Treats — Choose a new password
   --------------------------------------------------------------------------
   The screen a Supabase recovery link lands on.

   The link establishes a REAL session, which is why this needed its own route:
   sending recovery to the login page meant the page saw a session and ran its
   "already signed in" redirect, dropping the customer on their account without
   ever offering a new password.

   Three states, and one of them matters more than it looks: a session that is
   NOT from a recovery link. Someone already signed in who opens this URL by
   hand should not be able to silently change the password of whatever account
   the browser happens to hold — so that case is refused rather than served.

   Uses the existing Supabase auth. No second auth system, no service role,
   nothing about roles or profiles is touched.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.pages = KT.pages || {};

  var state = { ready: false, email: "", done: false };

  function lede(text) {
    var el = KT.qs("[data-reset-lede]");
    if (el) el.textContent = text;
  }

  function body(html) {
    var el = KT.qs("[data-reset-body]");
    if (el) el.innerHTML = html;
  }

  function formHTML() {
    return (
      '<form class="authform" data-reset-form novalidate>' +
        '<label class="field">' +
          '<span class="field__label">New password</span>' +
          '<span class="input-group">' +
            '<span class="input-group__icon" data-icon="lock" aria-hidden="true"></span>' +
            '<input class="input" type="password" id="rpNew" autocomplete="new-password" ' +
              'placeholder="At least 6 characters">' +
            '<button class="input-group__action" type="button" data-pw-toggle="rpNew" ' +
              'aria-label="Show password"></button>' +
          "</span>" +
        "</label>" +

        '<label class="field" style="margin-top:16px">' +
          '<span class="field__label">Confirm new password</span>' +
          '<span class="input-group">' +
            '<span class="input-group__icon" data-icon="lock" aria-hidden="true"></span>' +
            '<input class="input" type="password" id="rpConfirm" autocomplete="new-password" ' +
              'placeholder="Type it again">' +
          "</span>" +
          '<span class="field__hint" data-reset-hint></span>' +
        "</label>" +

        '<button class="btn btn--primary btn--lg btn--block" type="submit" ' +
          'style="margin-top:18px">Save new password</button>' +
      "</form>"
    );
  }

  function successHTML() {
    return (
      '<div class="panel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("check", 34) + "</div>" +
        "<h3>Password updated</h3>" +
        "<p>Sign in with your new password to continue.</p>" +
        '<a class="btn btn--primary" href="' + KT.url("pages/login.html") + '">Go to sign in</a>' +
      "</div></div>"
    );
  }

  function invalidHTML(reason) {
    return (
      '<div class="panel"><div class="empty">' +
        '<div class="empty__art">' + KT.icon("lock", 34) + "</div>" +
        "<h3>This reset link cannot be used</h3>" +
        "<p>" + reason + "</p>" +
        '<a class="btn btn--primary" href="' + KT.url("pages/login.html") + '">Back to sign in</a>' +
      "</div></div>"
    );
  }

  /** Recovery links expire; a session alone is not proof this is a recovery. */
  function evaluate() {
    if (state.done) return;

    if (KT.auth && KT.auth.isRecovery && KT.auth.isRecovery()) {
      state.ready = true;
      lede(state.email
        ? "Setting a new password for " + state.email + "."
        : "Enter a new password for your account.");
      body(formHTML());
      /* Reuse the shared eye toggle rather than writing a second one. */
      if (KT.pages.bindPasswordToggles) KT.pages.bindPasswordToggles(document);
      KT.qsa("[data-pw-toggle]").forEach(function (btn) {
        if (btn.innerHTML.trim()) return;
        btn.innerHTML = KT.icon("eye", 18);
        btn.addEventListener("click", function () {
          var input = KT.qs("#" + btn.getAttribute("data-pw-toggle"));
          var show = input.type === "password";
          input.type = show ? "text" : "password";
          btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
          btn.style.color = show ? "var(--kt-pink)" : "";
        });
      });
      var first = KT.qs("#rpNew");
      if (first) first.focus();
      return;
    }

    if (KT.auth && KT.auth.isSignedIn()) {
      /* Signed in, but not via a recovery link. Refuse: changing the password
         of whatever account this browser holds is not what a reset link is
         for, and doing it silently would be worse. */
      state.ready = false;
      lede("");
      body(invalidHTML(
        "You are signed in already, but this page was not opened from a password " +
        "reset email. Request a fresh link from the sign-in page."));
      return;
    }

    state.ready = false;
    lede("");
    body(invalidHTML(
      "The link may have expired or already been used. Reset links are " +
      "single-use and time-limited — request a new one and try again."));
  }

  KT.pages["reset-password"] = function () {
    var art = KT.qs("[data-auth-art]");
    if (art && KT.images) art.src = KT.images.src("kitchen-story");

    lede("Checking your reset link…");
    body(KT.loadingLabel("Checking your reset link…") + KT.skeleton.lines(3));

    document.addEventListener("kt:recovery", function (e) {
      state.email = (e.detail && e.detail.email) || "";
      evaluate();
    });

    /* The event may arrive before or after this module runs, so settle on
       kt:services too rather than depending on the order. */
    document.addEventListener("kt:services", function () {
      window.setTimeout(evaluate, 400);
    });
    document.addEventListener("kt:auth", function () {
      window.setTimeout(evaluate, 200);
    });
    if (KT.services) window.setTimeout(evaluate, 400);

    document.addEventListener("submit", async function (e) {
      var form = e.target.closest("[data-reset-form]");
      if (!form) return;
      e.preventDefault();
      if (!state.ready) return;

      var pw = KT.qs("#rpNew").value;
      var confirm = KT.qs("#rpConfirm").value;
      var hint = KT.qs("[data-reset-hint]");

      if (pw.length < 6) {
        if (hint) hint.textContent = "Use at least 6 characters.";
        return;
      }
      if (pw !== confirm) {
        if (hint) hint.textContent = "Those two passwords do not match.";
        return;
      }
      if (hint) hint.textContent = "";

      var done = KT.busy(KT.qs("[type=submit]", form), "Saving…");
      if (!done) return;

      try {
        await KT.auth.updatePassword(pw);
        state.done = true;
        /* Sign the recovery session out. The new password should be proved by
           using it, and it stops a shared or public browser keeping a session
           that was only ever meant to reset a password. */
        await KT.auth.signOut().catch(function () {});
        lede("");
        body(successHTML());
        KT.toast("Password updated. Sign in with your new password.", "success",
          { duration: 5200 });
      } catch (error) {
        done();
        KT.toast(KT.services ? KT.services.errorMessage(error) : error.message,
          "error", { duration: 5600 });
      }
    });
  };
})(window.KT || (window.KT = {}));
