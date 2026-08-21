/* ==========================================================================
   Kandy's Treats — service worker
   --------------------------------------------------------------------------
   Registered at the site ROOT so its scope covers both the storefront
   (/pages/…) and the admin app (/admin/…) with one worker. There is no second
   service worker in this project and there must not be: two workers competing
   for the same scope is how a push arrives twice.

   Its only job is push. It deliberately does NOT cache the site or intercept
   fetches — an offline cache is a separate decision with its own failure
   modes (stale prices, stale menu), and Phase 13 is about notifications.

   Everything it displays is decided server-side. The payload it receives has
   already been through push-send, which read the title, body and link off a
   notifications row rather than taking them from any client. This file
   chooses no wording and resolves no permissions.
   ========================================================================== */

const VERSION = "kt-sw-v1";

/* Take over as soon as we are installed rather than waiting for every tab to
   close. A customer who just granted permission should not have to close the
   site before the first push can arrive. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

/* ---- Push --------------------------------------------------------------- */

self.addEventListener("push", (event) => {
  /* A push with no readable body still has to show SOMETHING: the Push API
     contract (userVisibleOnly) is that every push produces a notification,
     and browsers will show their own "site updated in the background" if we
     do not. A generic Kandy's notification is better than that. */
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }

  const title = data.title || "Kandy's Treats";
  const options = {
    body: data.body || "You have a new update.",
    icon: "/assets/logo/icon-192.png",
    badge: "/assets/logo/favicon-64.png",
    /* Same tag = the OS replaces the previous one instead of stacking. This
       is what stops three status changes on one order becoming three
       separate lock-screen entries. */
    tag: data.tag || "kandys",
    renotify: true,
    timestamp: Date.now(),
    data: { url: data.url || "/pages/account.html#notifications", id: data.id || null }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/* ---- Click -------------------------------------------------------------- */

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) ||
    "/pages/account.html#notifications";

  event.waitUntil((async () => {
    const url = new URL(target, self.location.origin);
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    /* Prefer focusing a tab that is already on this origin and steering it,
       rather than opening a duplicate. Comparing origin only — an admin
       sitting on #/dashboard should be moved to the order, not have a second
       admin tab opened beside the first. */
    for (const client of clients) {
      if (new URL(client.url).origin !== url.origin) continue;
      await client.focus();
      if ("navigate" in client) {
        try { await client.navigate(url.href); } catch (_) { /* cross-document; focus is enough */ }
      }
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});

/* A subscription can be rotated by the push service. The page cannot hear
   that event, so the worker relays it and the app re-registers the new
   endpoint next time it is open. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: "kt:push-resubscribe" });
  })());
});

/* Lets the page ask which build is running, which is the cheap way to tell a
   stale worker from a fresh one during testing. */
self.addEventListener("message", (event) => {
  if (event.data === "kt:version" && event.source) {
    event.source.postMessage({ type: "kt:version", version: VERSION });
  }
});
