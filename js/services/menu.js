/* ==========================================================================
   Kandy's Treats — Menu service
   --------------------------------------------------------------------------
   Loads `menus/{id}` (public read per firestore.rules) and the admin-curated
   `quickPicks`, then hands them to KT.menu.hydrate().

   The local snapshot in js/data/menu.js paints instantly; this replaces it as
   soon as Firestore answers. Until it does, KT.menu.live stays false and
   checkout refuses to run — the server prices against these documents, so
   ordering from a stale snapshot is never allowed.
   ========================================================================== */

import { db, fb, COLLECTIONS } from "./firebase.js";

const CACHE_KEY = window.KT.config.storage.menuCache;
const CACHE_TTL = 10 * 60 * 1000;

/** Firestore menu doc → the shape the UI components expect. */
function normalise(id, data) {
  const KT = window.KT;
  const section = data.section || data.category || "";
  const category = KT.menu.categoryForSection(section);
  /* Matched by name, not id: V1's documents have random addDoc() ids. */
  const snapshot = KT.menu.snapshotFor(id, data.name);

  return {
    id,
    name: KT.rules.cleanString(data.name, 120),
    price: Math.max(0, Math.round(Number(data.price) || 0)),
    category,
    section,
    status: String(data.status || "available").toLowerCase(),
    /* Prefer an admin-uploaded Storage URL; otherwise reuse the photo and
       copy we already ship for this slug. */
    imageUrl: data.imageUrl || (typeof data.image === "string" && data.image.startsWith("http") ? data.image : ""),
    image: (snapshot && snapshot.image) || null,
    gallery: Array.isArray(data.gallery) ? data.gallery : [],
    blurb: data.blurb || (snapshot && snapshot.blurb) || "",
    description: data.description || (snapshot && snapshot.description) || "",
    rating: Number(data.rating) || 0,
    tags: Array.isArray(data.tags) ? data.tags.slice() : []
  };
}

function readCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (!raw || Date.now() - raw.at > CACHE_TTL) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(items, quickPicks) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), items, quickPicks }));
  } catch { /* quota — the snapshot still covers first paint */ }
}

function announce(source) {
  window.KT.cart.reconcile();
  document.dispatchEvent(new CustomEvent("kt:menu", {
    detail: { live: window.KT.menu.live, count: window.KT.menu.items.length, source }
  }));
}

export const menuService = {
  /** Load the live menu. Falls back to cache, then to the bundled snapshot. */
  async load() {
    const cached = readCache();
    if (cached) {
      window.KT.menu.hydrate(cached.items, cached.quickPicks);
      announce("cache");
    }

    try {
      const [menuSnap, pickSnap] = await Promise.all([
        fb.getDocs(fb.collection(db, COLLECTIONS.menus)),
        fb.getDocs(fb.collection(db, COLLECTIONS.quickPicks)).catch(() => ({ docs: [] }))
      ]);

      const items = menuSnap.docs
        .map((d) => normalise(d.id, d.data()))
        .filter((i) => i.name && i.price > 0);

      if (!items.length) throw new Error("empty menu");

      const quickPicks = pickSnap.docs
        .map((d) => d.data().menuId || d.id)
        .filter(Boolean);

      window.KT.menu.hydrate(items, quickPicks);
      writeCache(items, quickPicks);
      announce("firestore");
      return items;
    } catch (error) {
      if (!cached) {
        console.warn("[Kandy's] live menu unavailable — showing the bundled snapshot.", error);
        announce("snapshot");
      }
      return window.KT.menu.items;
    }
  },

  /** Live updates while the customer browses (sold-out flips, price changes). */
  watch() {
    return fb.onSnapshot(
      fb.collection(db, COLLECTIONS.menus),
      (snap) => {
        const items = snap.docs
          .map((d) => normalise(d.id, d.data()))
          .filter((i) => i.name && i.price > 0);
        if (!items.length) return;
        const picks = window.KT.menu.tagged("quick-pick").map((i) => i.id);
        window.KT.menu.hydrate(items, picks);
        writeCache(items, picks);
        announce("live");
      },
      () => { /* permission or network drop — keep whatever we have */ }
    );
  }
};
