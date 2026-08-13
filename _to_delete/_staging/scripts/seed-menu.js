/* ==========================================================================
   Kandy's Treats — Menu seeder (admin only)
   --------------------------------------------------------------------------
   V1's seeder used addDoc(), which gives every meal a random Firestore id.
   That made the client unable to know an item's id ahead of time. This
   version writes the SAME menu with setDoc() using stable slugs, so the ids
   match js/data/menu.js exactly — the snapshot, the deep links
   (/pages/product.html?id=jollof-rice) and the server's price lookup all line
   up.

   It MERGES: existing `status`, `imageUrl` and any admin edits are preserved.
   Nothing is deleted.

   How to run
     1. Sign in to the storefront as a user whose users/{uid}.role is
        admin | staff | super-admin | owner (firestore.rules requires it).
     2. Open the browser console on any page of the site.
     3. await import('/scripts/seed-menu.js').then(m => m.seedMenu())
        Add { dryRun: true } to preview without writing.
   ========================================================================== */

import { db, fb, COLLECTIONS } from "../js/services/firebase.js";

/** Pulled from js/data/menu.js so there is a single list to maintain. */
function sourceItems() {
  const menu = window.KT && window.KT.menu;
  if (!menu) throw new Error("Open this on a Kandy's page so js/data/menu.js is loaded.");
  return menu.items.map((item) => ({
    id: item.id,
    name: item.name,
    price: item.price,
    section: item.section,
    blurb: item.blurb,
    description: item.description,
    tags: item.tags.filter((t) => t !== "quick-pick" && t !== "sold-out")
  }));
}

export async function seedMenu({ dryRun = false } = {}) {
  const items = sourceItems();
  console.info(`[seed] ${items.length} items ready${dryRun ? " (dry run)" : ""}`);

  const existing = await fb.getDocs(fb.collection(db, COLLECTIONS.menus));
  const byId = new Map(existing.docs.map((d) => [d.id, d.data()]));
  const legacy = existing.docs.filter((d) => !items.some((i) => i.id === d.id));

  if (legacy.length) {
    console.warn(`[seed] ${legacy.length} document(s) are not in the slug list ` +
      `(likely V1's auto-id docs). They are left untouched — review and delete ` +
      `them in the console once you have confirmed the new ids work:`,
      legacy.map((d) => `${d.id} · ${d.data().name}`));
  }

  if (dryRun) {
    return { wouldWrite: items.length, legacy: legacy.length };
  }

  /* Firestore batches cap at 500 writes — this menu is well under, but keep
     the chunking so the script survives the menu growing. */
  let written = 0;
  for (let i = 0; i < items.length; i += 400) {
    const batch = fb.writeBatch(db);
    items.slice(i, i + 400).forEach((item) => {
      const prev = byId.get(item.id) || {};
      batch.set(fb.doc(db, COLLECTIONS.menus, item.id), {
        name: item.name,
        price: item.price,
        section: item.section,
        blurb: item.blurb,
        description: item.description,
        tags: item.tags,
        /* preserve whatever the admin has already set */
        status: prev.status || "available",
        imageUrl: prev.imageUrl || "",
        gallery: prev.gallery || [],
        createdAt: prev.createdAt || fb.serverTimestamp(),
        updatedAt: fb.serverTimestamp()
      }, { merge: true });
      written += 1;
    });
    await batch.commit();
  }

  console.info(`[seed] wrote ${written} menu documents.`);
  return { written, legacy: legacy.length };
}

if (typeof window !== "undefined") window.seedMenu = seedMenu;
