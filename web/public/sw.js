// Service worker for installability only: the app is online-only (see requirements),
// so nothing is cached. Every request goes straight to the network.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // No respondWith(): the browser handles the request normally.
});
