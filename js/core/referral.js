/* ==========================================================================
   Kandy's Treats — referral link capture
   --------------------------------------------------------------------------
   A visitor arrives on ?ref=KANDYABC123 and may browse for a while before
   signing up. This holds the code across that journey and hands it to the
   signup call.

   NOT A REDIRECT PARAMETER
   ------------------------
   `ref` names a referral code and nothing else. It is never read as a URL,
   a path or a destination, and nothing in this file navigates. That is what
   keeps it from becoming an open redirect: there is no code path where the
   value could be turned into somewhere to go.

   The value is also not trusted as an identity. It is a short opaque string
   the server looks up in referral_codes; an unknown one simply produces no
   referral, and the customer still gets an account. So the worst a forged
   ?ref= can do is name somebody else's real code — which is exactly what
   sharing a referral link is for.

   sessionStorage, not localStorage: a referral belongs to the visit that
   arrived on the link, not to the browser for ever. A second, organic visit
   next week should not still be attributed to whoever shared a link once.
   ========================================================================== */
(function (KT) {
  "use strict";

  var KEY = "kt.referral";
  /* The alphabet generate_referral_code() uses, and the same length. Anything
     that cannot be one of our codes is discarded here rather than sent. */
  var SHAPE = /^KANDY[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

  function clean(value) {
    var v = String(value == null ? "" : value).trim().toUpperCase();
    return SHAPE.test(v) ? v : "";
  }

  function read() {
    try { return clean(sessionStorage.getItem(KEY)); } catch (e) { return ""; }
  }

  function write(code) {
    try {
      if (code) sessionStorage.setItem(KEY, code);
      else sessionStorage.removeItem(KEY);
    } catch (e) {
      /* Private mode — the code simply lives for this page instead. */
    }
  }

  var memory = "";

  /* Capture on load, then take the parameter back out of the address bar so
     the customer does not copy a friend's referral link out of their own URL
     and re-share it unchanged. */
  function capture() {
    var found = "";
    try {
      found = clean(new URLSearchParams(window.location.search).get("ref"));
    } catch (e) { found = ""; }
    if (!found) return;

    memory = found;
    write(found);

    try {
      var url = new URL(window.location.href);
      url.searchParams.delete("ref");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    } catch (e) {
      /* Leaving the parameter in place is cosmetic, not a failure. */
    }
  }

  KT.referral = {
    /** The code this visit arrived with, or "" — always validated. */
    captured: function () { return memory || read(); },

    /** Called once the referral has been spent on a signup. */
    clear: function () { memory = ""; write(""); },

    /** Build a share link for a code. Same-origin by construction. */
    linkFor: function (code) {
      var c = clean(code);
      if (!c) return "";
      return KT.absoluteUrl
        ? KT.absoluteUrl("pages/signup.html") + "?ref=" + encodeURIComponent(c)
        : new URL(KT.url("pages/signup.html"), window.location.href).href +
          "?ref=" + encodeURIComponent(c);
    },

    isValidShape: function (code) { return !!clean(code); }
  };

  capture();
})(window.KT || (window.KT = {}));
