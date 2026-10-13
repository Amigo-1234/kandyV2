/* ==========================================================================
   Kandy's Treats — Sign in & sign up
   Real Supabase Authentication, following V1's flow. The form markup and
   styling are unchanged; only the behaviour behind them is live now.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.pages = KT.pages || {};

  function artwork() {
    var img = KT.qs("[data-auth-art]");
    if (img) img.src = KT.images.src("kitchen-story");
  }

  function passwordToggles(root) {
    KT.qsa("[data-pw-toggle]", root).forEach(function (btn) {
      btn.innerHTML = KT.icon("eye", 18);
      btn.addEventListener("click", function () {
        var input = KT.qs("#" + btn.getAttribute("data-pw-toggle"));
        var show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
        btn.style.color = show ? "var(--kt-pink)" : "";
      });
    });
  }

  /** Disable the form until the auth service module has finished loading. */
  function gate(formSel) {
    var form = KT.qs(formSel);
    if (!form) return;
    var btn = KT.qs("[type=submit]", form);
    var label = btn.textContent;

    function enable(ok) {
      btn.disabled = !ok;
      btn.textContent = ok ? label : "Connecting…";
      if (!ok) return;
      KT.qsa("[data-social]").forEach(function (b) { b.disabled = false; });
    }

    if (KT.services) enable(true);
    else {
      enable(false);
      document.addEventListener("kt:services", function (e) {
        if (e.detail.ok) enable(true);
        else {
          btn.disabled = true;
          btn.textContent = "Unavailable offline";
          KT.toast("We could not reach Kandy's. Check your connection and reload.", "error", { duration: 6000 });
        }
      });
    }
  }

  function busy(form, on, busyLabel) {
    var btn = KT.qs("[type=submit]", form);
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.disabled = on;
    btn.textContent = on ? busyLabel : btn.dataset.label;
  }

  /**
   * One-shot handoff to the destination page. sessionStorage (not local) so it
   * dies with the tab, and the destination DELETES it on read — that is what
   * stops the welcome re-appearing every time the account page is refreshed.
   */
  function handoff(kind, name) {
    try {
      window.sessionStorage.setItem("kt.welcome",
        JSON.stringify({ kind: kind, name: name || "", at: Date.now() }));
    } catch (e) { /* private mode — the redirect still works, just silently */ }
  }

  /**
   * Leave the crumb before navigating so the account page's first paint shows
   * a skeleton rather than the signed-out state. kt:auth normally sets this,
   * but doing it here removes the race entirely.
   */
  /** Undo an optimistic handoff when the navigation never actually happened. */
  function clearHandoff() {
    try { window.sessionStorage.removeItem("kt.welcome"); } catch (e) { /* no-op */ }
  }

  function goTo(url) {
    if (KT.session) KT.session.remember();
    window.location.href = url;
  }

  /** Replace the form with a success state, reusing existing panel classes. */
  function successState(formSel, opts) {
    var form = KT.qs(formSel);
    if (!form) return;
    var host = form.parentNode;
    var panel = KT.el("div.panel", { "data-auth-success": true, html:
      '<div class="empty">' +
        '<div class="empty__art">' + KT.icon(opts.icon || "check", 38) + "</div>" +
        "<h3>" + opts.title + "</h3>" +
        "<p>" + opts.body + "</p>" +
        (opts.action
          ? '<a class="btn btn--primary" href="' + opts.action.href + '">' + opts.action.label + "</a>"
          : "") +
      "</div>" });
    form.replaceWith(panel);
    /* The social buttons and separator no longer apply once we have succeeded. */
    var sep = KT.qs(".authsep", host);
    var soc = KT.qs(".authsocial", host);
    if (sep) sep.remove();
    if (soc) soc.remove();
  }

  /*
     Keep ?next= when the customer switches between sign-in and sign-up. A
     visitor sent here by "Sign in to check out" (?next=cart) who then taps
     "Create an account" used to lose it and land on their account page
     instead of back at the basket. Only the value is carried; nextUrl() still
     maps it through its fixed route list, so this cannot become a redirect to
     anywhere else.
  */
  var NEXT_KEY = "kt.next";

  function carryNext() {
    var next = KT.param("next");
    if (!next) return;
    KT.qsa(".authswap a").forEach(function (a) {
      var u = new URL(a.getAttribute("href"), window.location.href);
      u.searchParams.set("next", next);
      a.setAttribute("href", u.pathname + u.search + u.hash);
    });
  }

  /* Google sign-in leaves the site and comes back to login.html without a
     query string, so the destination rides in sessionStorage for that trip. */
  function stashNext() {
    try {
      var next = KT.param("next");
      if (next) window.sessionStorage.setItem(NEXT_KEY, next);
      else window.sessionStorage.removeItem(NEXT_KEY);
    } catch (e) { /* private mode — falls back to the default destination */ }
  }

  function restoreNext() {
    try {
      var stored = window.sessionStorage.getItem(NEXT_KEY);
      window.sessionStorage.removeItem(NEXT_KEY);
      if (!stored || KT.param("next")) return;
      var u = new URL(window.location.href);
      u.searchParams.set("next", stored);
      history.replaceState(null, "", u.pathname + u.search + u.hash);
    } catch (e) { /* nothing to restore */ }
  }

  function fail(error) {
    KT.toast(KT.services ? KT.services.errorMessage(error) : String(error.message || error),
      "error", { duration: 5200 });
  }

  function socials() {
    KT.qsa("[data-social]").forEach(function (b) {
      var isGoogle = /google/i.test(b.textContent);
      if (!isGoogle) {
        /* V1 only ships Google — do not offer a provider that is not wired. */
        b.remove();
        return;
      }
      b.addEventListener("click", async function () {
        if (!KT.services) return;
        b.disabled = true;
        b.setAttribute("aria-busy", "true");

        /* signInWithGoogle() resolves to null BECAUSE the browser navigates
           away, so there is no "after" in which to record success. Both the
           welcome handoff and the session crumb have to be written now. The
           crumb is what stops account.html painting its signed-out state while
           the callback is still being exchanged.
           Kind is "oauth", not login/signup: whether this account is new is
           only knowable once we are back, so the destination decides. */
        if (KT.session) KT.session.remember();
        handoff("oauth");
        stashNext();

        try {
          await KT.auth.signInWithGoogle();
          /* Success means we are leaving — keep the button busy. */
        } catch (error) {
          /* We never left, so roll the optimistic state back. */
          clearHandoff();
          if (KT.session && !(KT.auth && KT.auth.isSignedIn())) KT.session.forget();
          b.disabled = false;
          b.removeAttribute("aria-busy");
          fail(error);
        }
      });
    });
  }

  /* Already signed in? Skip the form. */
  function redirectIfSignedIn() {
    document.addEventListener("kt:auth", function (e) {
      /* A recovery link also produces a session. Redirecting on it would send
         someone who asked to reset their password straight to their account
         instead — which is exactly what used to happen. */
      if (KT.auth && KT.auth.isRecovery && KT.auth.isRecovery()) return;
      /* No handoff here: arriving already-authenticated is not a fresh
         sign-in, so it must not trigger a welcome message. */
      if (!e.detail.signedIn || !KT.auth) return;
      restoreNext();
      /* Role decides the destination, so this waits for the profile rather
         than bouncing to the customer account page first. One redirect, no
         flash of the wrong screen, and no loop: every destination below is a
         different page from this one. */
      KT.auth.landingUrl().then(function (url) {
        window.location.href = url;
      });
    });
  }

  /* ---- Sign in --------------------------------------------------------- */

  KT.pages.login = function () {
    artwork();
    passwordToggles(document);
    socials();
    gate("[data-login-form]");
    carryNext();
    redirectIfSignedIn();

    var form = KT.qs("[data-login-form]");
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (!KT.services) return;

      var email = KT.qs("#liEmail").value.trim();
      var password = KT.qs("#liPassword").value;
      if (!email || !password) {
        KT.toast("Enter your email and password.", "info");
        return;
      }

      busy(form, true, "Signing you in…");
      try {
        var signedIn = await KT.auth.signIn(email, password);
        handoff("login", signedIn && signedIn.displayName);
        /*
           landingUrl(), not nextUrl(): the destination depends on the role in
           the profile, which only exists once there is a session. This is the
           path an ACTUAL sign-in takes. redirectIfSignedIn() above covers only
           the case of arriving already authenticated — which is why role
           routing could look correct while every real login still landed on
           the customer account page.
        */
        if (KT.auth) goTo(await KT.auth.landingUrl());
      } catch (error) {
        busy(form, false);
        fail(error);
      }
    });

    var forgot = KT.qs('.authmeta a[href="#"]');
    if (forgot) {
      forgot.addEventListener("click", async function (e) {
        e.preventDefault();
        var email = KT.qs("#liEmail").value.trim();
        if (!email) {
          KT.toast("Enter your email address first, then tap again.", "info");
          return;
        }
        try {
          await KT.auth.resetPassword(email);
          KT.toast("Password reset link sent to " + email, "success", { duration: 5000 });
        } catch (error) {
          fail(error);
        }
      });
    }
  };

  /* ---- Sign up --------------------------------------------------------- */

  /* ---- Invite code (optional) -------------------------------------------
     A referral or Partner code typed at signup, or pre-filled from an invite
     link. Checked as the customer types so they know whether it counts; the
     server checks it again when the account is created (handle_new_user),
     and a code is never required. */
  var INVITE_HINT = "Got a code from a friend or a Kandy\u2019s Partner? Add it here.";
  function inviteField(form) {
    var input = KT.qs("[data-invite-input]", form);
    var msg = KT.qs("[data-invite-msg]", form);
    var clear = KT.qs("[data-invite-clear]", form);
    var wrap = KT.qs("[data-invite]", form);
    var state = { checked: "", ok: true, message: "", pending: null };
    var timer = null;
    if (!input) return { value: function () { return ""; }, settle: function () { return Promise.resolve(); }, ok: function () { return true; } };

    function show(text, tone) {
      msg.textContent = text;
      wrap.classList.remove("is-good", "is-bad", "is-checking");
      if (tone) wrap.classList.add("is-" + tone);
    }
    function code() { return String(input.value || "").trim().toUpperCase(); }
    function shapeOk(c) { return /^[A-Z0-9]{4,20}$/.test(c); }

    async function check() {
      var c = code();
      state.checked = c;
      if (!c) { state.ok = true; show(INVITE_HINT, null); return; }
      if (!shapeOk(c)) {
        state.ok = false;
        state.message = "Invite codes are 4\u201320 letters or numbers.";
        show(state.message, "bad");
        return;
      }
      var svc = KT.services && KT.services.rewards;
      if (!svc || !svc.lookupPartner) {
        state.ok = true; show("We\u2019ll check this code when you create your account.", null); return;
      }
      show("Checking\u2026", "checking");
      var res;
      try { res = await svc.lookupPartner(c); }
      catch (e) {
        if (code() !== c) return;
        state.ok = true;
        show("We couldn\u2019t check the code just now \u2014 it will be checked when your account is created.", null);
        return;
      }
      if (code() !== c) return;   /* the customer kept typing */
      var kind = res && res.kind;
      if (kind === "partner") {
        state.ok = true; show("\u2713 " + c + " \u2014 you\u2019re joining with " + (res.partner_name || "a Kandy\u2019s Partner") + ".", "good");
      } else if (kind === "referral") {
        state.ok = true; show("\u2713 Valid invite code. Your friend is rewarded after your first order.", "good");
      } else if (kind === "partner_paused") {
        state.ok = true; show("\u2713 Valid code. This Partner\u2019s programme is paused, so it counts as a friend\u2019s invite.", "good");
      } else if (kind === "inactive") {
        state.ok = false; state.message = "That code has expired or been disabled. Remove it to continue.";
        show(state.message, "bad");
      } else {
        state.ok = false; state.message = "We don\u2019t recognise that code. Check it, or remove it to continue.";
        show(state.message, "bad");
      }
    }

    function schedule(delay) {
      clearTimeout(timer);
      clear.hidden = !input.value;
      state.pending = new Promise(function (resolve) {
        timer = setTimeout(function () { check().then(resolve, resolve); }, delay);
      });
    }

    input.addEventListener("input", function () {
      var caret = input.selectionStart;
      input.value = input.value.toUpperCase().replace(/\s+/g, "");
      try { input.setSelectionRange(caret, caret); } catch (e) {}
      schedule(450);
    });
    input.addEventListener("blur", function () { if (code() !== state.checked) schedule(0); });
    clear.addEventListener("click", function () {
      input.value = "";
      clear.hidden = true;
      /* Removing a link code also stops the basket offering it later. */
      if (KT.referral && KT.referral.clear) KT.referral.clear();
      schedule(0);
      input.focus();
    });

    /* Arrived on an invite link: pre-fill, but leave it editable. */
    var captured = KT.referral && KT.referral.captured && KT.referral.captured();
    if (captured) {
      input.value = captured;
      clear.hidden = false;
      wrap.classList.add("is-prefilled");
    }
    function start() { if (input.value) schedule(0); }
    if (KT.services) start(); else document.addEventListener("kt:services", start, { once: true });

    return {
      value: code,
      ok: function () { return !code() || state.ok; },
      message: function () { return state.message; },
      /* Make sure the latest typing has been checked before submitting. */
      settle: async function () {
        if (code() !== state.checked) { clearTimeout(timer); await check(); }
        else if (state.pending) await state.pending;
      },
      focus: function () { input.focus(); }
    };
  }

  KT.pages.signup = function () {
    artwork();
    passwordToggles(document);
    socials();
    gate("[data-signup-form]");
    carryNext();
    redirectIfSignedIn();

    var form = KT.qs("[data-signup-form]");
    var invite = inviteField(form);

    /* Password strength meter (presentation only). */
    var pw = KT.qs("#suPassword");
    var meter = KT.qs("[data-pw-meter]");
    if (pw && meter) {
      pw.addEventListener("input", function () {
        var v = pw.value;
        var score = 0;
        if (v.length >= 8) score++;
        if (/[A-Z]/.test(v)) score++;
        if (/[0-9]/.test(v)) score++;
        if (/[^A-Za-z0-9]/.test(v)) score++;
        var labels = ["Too short", "Weak", "Getting there", "Good", "Strong"];
        var colors = ["var(--ink-4)", "var(--chili)", "var(--amber)", "var(--mint)", "var(--mint)"];
        meter.style.setProperty("--pw", (score / 4) * 100 + "%");
        meter.style.setProperty("--pwc", colors[score]);
        KT.qs("[data-pw-label]").textContent = v ? labels[score] : "";
      });
    }

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (!KT.services) return;

      var fields = KT.qsa("input", form);
      var firstName = fields[0].value.trim();
      var lastName = fields[1].value.trim();
      var email = fields[2].value.trim();
      var phone = fields[3].value.trim();
      var password = pw.value;
      var agreed = KT.qsa(".checkline input")[0].checked;

      if (!firstName || !email || !password) {
        KT.toast("Fill in your name, email and password.", "info");
        return;
      }
      if (!KT.rules.isValidPhone(phone)) {
        KT.toast("Enter a valid Nigerian phone number — the rider needs it.", "info");
        return;
      }
      if (password.length < 6) {
        KT.toast("Use at least 6 characters for your password.", "info");
        return;
      }
      if (!agreed) {
        KT.toast("Please accept the terms to create an account.", "info");
        return;
      }

      /* An invite code is optional, but one that will not count is never
         sent silently: the customer fixes it or removes it. */
      await invite.settle();
      if (!invite.ok()) {
        KT.toast(invite.message() || "Check the invite code, or remove it.", "info");
        invite.focus();
        return;
      }
      var inviteCode = invite.value();

      busy(form, true, "Creating your account…");
      try {
        var result = await KT.auth.signUp({ firstName: firstName, lastName: lastName,
          email: email, phone: phone, password: password,
          referralCode: inviteCode });
        /* Remember the code for this visit so the basket can offer a
           Partner code on the first checkout; forget a removed one. */
        if (KT.referral) { if (inviteCode) KT.referral.set(inviteCode); else KT.referral.clear(); }

        if (result && result.needsEmailConfirmation) {
          /* No session yet. Redirecting would drop a session-less visitor on
             the account page, so stay here and say what happens next. */
          successState("[data-signup-form]", {
            icon: "mail",
            title: "Confirm your email",
            body: "We sent a link to <strong>" + email + "</strong>. Open it to " +
                  "finish creating your Kandy's Treats account.",
            action: { href: KT.url("pages/login.html"), label: "Back to sign in" }
          });
          return;
        }

        /* Session issued immediately — show the welcome, then hand over. */
        handoff("signup", firstName);
        successState("[data-signup-form]", {
          icon: "sparkle",
          title: "Welcome to Kandy's Treats 🎉",
          body: "Your account has been created successfully. Taking you to your account…"
        });
        window.setTimeout(async function () {
          /* A new signup is a customer, so this resolves to the customer
             destination — but it is asked rather than assumed, so an invited
             teammate who signs up lands where their role says. */
          if (KT.auth) goTo(await KT.auth.landingUrl());
        }, 1400);
      } catch (error) {
        busy(form, false);
        fail(error);
      }
    });
  };
})(window.KT || (window.KT = {}));
