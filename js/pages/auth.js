/* ==========================================================================
   Kandy's Treats — Login & sign-up (UI ONLY)
   No authentication, no requests, no storage. Submitting shows the intended
   feedback pattern and stops. Validation here is presentational.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.pages = KT.pages || {};

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

  function artwork() {
    var img = KT.qs("[data-auth-art]");
    if (img) img.src = KT.images.src("kitchen-story", "tall");
  }

  function handle(formSel, message) {
    var form = KT.qs(formSel);
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = KT.qs("[type=submit]", form);
      var label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "One moment…";
      setTimeout(function () {
        btn.disabled = false;
        btn.textContent = label;
        KT.toast(message, "info", { duration: 4200 });
      }, 700);
    });
  }

  KT.pages.login = function () {
    artwork();
    passwordToggles(document);
    handle("[data-login-form]",
      "Sign-in is UI only in Phase 1 — no account is created or checked.");
    KT.qsa("[data-social]").forEach(function (b) {
      b.addEventListener("click", function () {
        KT.toast("Social sign-in arrives with the auth release.", "info");
      });
    });
  };

  KT.pages.signup = function () {
    artwork();
    passwordToggles(document);
    handle("[data-signup-form]",
      "Sign-up is UI only in Phase 1 — nothing is submitted anywhere.");

    /* Password strength meter — purely visual feedback. */
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

    KT.qsa("[data-social]").forEach(function (b) {
      b.addEventListener("click", function () {
        KT.toast("Social sign-up arrives with the auth release.", "info");
      });
    });
  };
})(window.KT || (window.KT = {}));
