/* ==========================================================================
   Kandy's Treats — Scroll entrance + light parallax
   Elements marked [data-reveal] fade and rise once, on first intersection.
   Children of [data-reveal-group] stagger. Everything is disabled outright
   when the visitor prefers reduced motion.
   ========================================================================== */
(function (KT) {
  "use strict";

  function reveal() {
    var nodes = KT.qsa("[data-reveal], [data-reveal-group] > *");

    if (KT.prefersReducedMotion || !("IntersectionObserver" in window)) {
      nodes.forEach(function (n) {
        n.classList.add("is-revealed");
      });
      return;
    }

    nodes.forEach(function (n) {
      n.classList.add("will-reveal");
    });

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          var group = el.parentElement &&
            el.parentElement.hasAttribute("data-reveal-group");
          var delay = group
            ? Math.min(Array.prototype.indexOf.call(el.parentElement.children, el), 8) * 65
            : 0;
          setTimeout(function () {
            el.classList.add("is-revealed");
          }, delay);
          io.unobserve(el);
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );

    nodes.forEach(function (n) {
      io.observe(n);
    });
  }

  /** Very light pointer parallax — max ±10px, desktop pointers only. */
  function parallax() {
    var layers = KT.qsa("[data-parallax]");
    if (!layers.length || KT.prefersReducedMotion) return;
    if (!window.matchMedia("(hover: hover) and (min-width: 1024px)").matches) return;

    var raf = null;
    window.addEventListener("pointermove", function (e) {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = null;
        var cx = (e.clientX / window.innerWidth - 0.5) * 2;
        var cy = (e.clientY / window.innerHeight - 0.5) * 2;
        layers.forEach(function (l) {
          var d = parseFloat(l.getAttribute("data-parallax")) || 1;
          l.style.setProperty("--px", (cx * d * 9).toFixed(2) + "px");
          l.style.setProperty("--py", (cy * d * 9).toFixed(2) + "px");
        });
      });
    });
  }

  /** Horizontal rails with arrow controls. */
  function rails() {
    KT.qsa("[data-rail]").forEach(function (rail) {
      var prev = KT.qs('[data-rail-prev="' + rail.id + '"]');
      var next = KT.qs('[data-rail-next="' + rail.id + '"]');
      if (!prev || !next) return;

      function step() {
        var first = rail.firstElementChild;
        return first ? first.getBoundingClientRect().width + 16 : 300;
      }
      function sync() {
        prev.disabled = rail.scrollLeft < 8;
        next.disabled =
          rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 8;
      }
      prev.addEventListener("click", function () {
        rail.scrollBy({ left: -step() * 2, behavior: "smooth" });
      });
      next.addEventListener("click", function () {
        rail.scrollBy({ left: step() * 2, behavior: "smooth" });
      });
      rail.addEventListener("scroll", KT.debounce(sync, 80), { passive: true });
      window.addEventListener("resize", KT.debounce(sync, 150));
      sync();
    });
  }

  KT.motion = { reveal: reveal, parallax: parallax, rails: rails };
})(window.KT || (window.KT = {}));
