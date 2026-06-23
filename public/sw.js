/*
 * Kill-switch service worker.
 *
 * The previous SW cached the app shell (cache-first on hashed chunks,
 * network-first on pages) and ended up serving STALE JavaScript across deploys
 * inside the Capacitor remote-URL shell — a genuine force-quit still ran old
 * code. For an app that loads a live remote URL, fresh-on-every-load matters far
 * more than offline support, so the SW is retired.
 *
 * This worker takes over from any old registration, deletes every cache,
 * unregisters itself, and reloads open windows so they fetch the latest code
 * from the network. After it runs once, the app has no service worker
 * (ServiceWorkerRegister now only unregisters), so future web deploys reach the
 * app on the next load with no caching in the way.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 1. Nuke every cache the old worker created.
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      // 2. Remove this worker so nothing intercepts future requests.
      await self.registration.unregister();
      // 3. Reload any open windows — now uncontrolled + uncached → fresh code.
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        try {
          client.navigate(client.url);
        } catch {
          /* ignore */
        }
      }
    })(),
  );
});

// No fetch handler on purpose: requests go straight to the network.
