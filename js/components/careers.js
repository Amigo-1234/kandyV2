/* ==========================================================================
   Kandy's Treats — Careers application
   --------------------------------------------------------------------------
   A small dialog rather than a page: the three footer links each open it with
   a role preselected. Open to signed-out visitors, because `anon` holds
   INSERT on job_applications and the policy pins status = 'new'.
   ========================================================================== */
(function (KT) {
  "use strict";

  KT.components = KT.components || {};

  var ROLES = [
    { slug: "chef", label: "Chef",
      blurb: "Cook on the line — jollof, proteins, soups and specials." },
    { slug: "rider", label: "Rider",
      blurb: "Deliver across Ado-Ekiti, Iworoko, Ifaki and Oye-Ekiti." },
    { slug: "kitchen-assistant", label: "Kitchen Assistant",
      blurb: "Prep, packaging and keeping the kitchen moving." }
  ];

  var mounted = false;

  function roleBySlug(slug) {
    return ROLES.filter(function (r) { return r.slug === slug; })[0] || ROLES[0];
  }

  function formHTML(role) {
    return (
      '<form class="careers__form" data-careers-form>' +
        '<input type="hidden" name="roleSlug" value="' + role.slug + '">' +
        '<label class="field"><span class="field__label">Applying for</span>' +
          '<select class="select" name="roleSelect">' +
            ROLES.map(function (r) {
              return '<option value="' + r.slug + '"' +
                (r.slug === role.slug ? " selected" : "") + ">" + r.label + "</option>";
            }).join("") +
          "</select>" +
          '<span class="field__hint" data-role-blurb>' + role.blurb + "</span></label>" +

        '<label class="field" style="margin-top:14px"><span class="field__label">Full name</span>' +
          '<input class="input" name="name" placeholder="Your full name" autocomplete="name"></label>' +

        '<div class="authrow" style="margin-top:14px">' +
          '<label class="field"><span class="field__label">Phone number</span>' +
            '<input class="input" name="phone" type="tel" placeholder="+234 801 234 5678" ' +
              'autocomplete="tel"></label>' +
          '<label class="field"><span class="field__label">Email (optional)</span>' +
            '<input class="input" name="email" type="email" placeholder="you@example.com" ' +
              'autocomplete="email"></label>' +
        "</div>" +

        '<label class="field" style="margin-top:14px">' +
          '<span class="field__label">Tell us about yourself</span>' +
          '<textarea class="textarea" name="about" rows="4" ' +
            'placeholder="Experience, availability, and why you would like to join."></textarea></label>' +

        '<button class="btn btn--primary btn--block" type="submit" style="margin-top:16px">' +
          "Send application</button>" +
      "</form>"
    );
  }

  function mount() {
    if (mounted) return;
    var el = KT.el("div.careers", { "data-careers": true, hidden: true, html:
      '<div class="careers__scrim" data-careers-close></div>' +
      '<section class="careers__panel" role="dialog" aria-modal="true" aria-label="Apply to work at Kandy\'s Treats">' +
        '<header class="careers__head">' +
          "<div><h2>Work with us</h2><p>We are hiring across the kitchen and the road.</p></div>" +
          '<button class="icon-btn" type="button" data-careers-close aria-label="Close">' +
            KT.icon("close", 20) + "</button>" +
        "</header>" +
        '<div class="careers__body" data-careers-body></div>' +
      "</section>" });
    document.body.appendChild(el);
    mounted = true;
  }

  function open(slug) {
    mount();
    var role = roleBySlug(slug);
    KT.mount(KT.qs("[data-careers-body]"), formHTML(role));
    var root = KT.qs("[data-careers]");
    root.hidden = false;
    void root.offsetHeight;
    root.classList.add("is-open");
    KT.lockScroll(true);
    var first = KT.qs('[name="name"]');
    if (first) first.focus();
  }

  function close() {
    var root = KT.qs("[data-careers]");
    if (!root) return;
    root.classList.remove("is-open");
    KT.lockScroll(false);
    window.setTimeout(function () { root.hidden = true; }, 240);
  }

  function success(role) {
    KT.mount(KT.qs("[data-careers-body]"),
      '<div class="careers__done"><span class="careers__doneicon">' + KT.icon("check", 30) + "</span>" +
      "<h3>Application received</h3>" +
      "<p>Thank you — we have your application for <strong>" + role.label + "</strong>. " +
      "If it looks like a fit we will call the number you gave us.</p>" +
      '<button class="btn btn--soft" type="button" data-careers-close>Close</button></div>');
  }

  /* ---- Wiring ------------------------------------------------------------ */

  document.addEventListener("click", function (e) {
    var trigger = e.target.closest("[data-apply]");
    if (trigger) { e.preventDefault(); open(trigger.getAttribute("data-apply")); return; }
    if (e.target.closest("[data-careers-close]")) { e.preventDefault(); close(); }
  });

  document.addEventListener("keydown", function (e) {
    var root = KT.qs("[data-careers]");
    if (e.key === "Escape" && root && !root.hidden) close();
  });

  /* Keep the hidden slug and the blurb in step with the visible select. */
  document.addEventListener("change", function (e) {
    var sel = e.target.closest('[name="roleSelect"]');
    if (!sel) return;
    var role = roleBySlug(sel.value);
    var hidden = KT.qs('[name="roleSlug"]');
    if (hidden) hidden.value = role.slug;
    var blurb = KT.qs("[data-role-blurb]");
    if (blurb) blurb.textContent = role.blurb;
  });

  document.addEventListener("submit", async function (e) {
    var form = e.target.closest("[data-careers-form]");
    if (!form) return;
    e.preventDefault();

    if (!KT.services) {
      KT.toast("Still connecting — try again in a moment.", "info");
      return;
    }

    var done = KT.busy(KT.qs("[type=submit]", form), "Sending…");
    if (!done) return;

    var data = Object.fromEntries(new FormData(form).entries());
    try {
      await KT.services.careers.apply({
        roleSlug: data.roleSlug, name: data.name, phone: data.phone,
        email: data.email, about: data.about
      });
      success(roleBySlug(data.roleSlug));
    } catch (error) {
      done();
      KT.toast(KT.services.errorMessage(error), "error", { duration: 5200 });
    }
  });

  KT.components.careers = { open: open, close: close, ROLES: ROLES };
})(window.KT || (window.KT = {}));
