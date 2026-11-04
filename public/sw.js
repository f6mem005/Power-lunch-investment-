// Makes the app installable and lets the page shell open without a connection.
// It deliberately never touches /api/ or /auth/: private data and sign-in are never cached on the device.
const CACHE = "pari-passu-shell-v5";
const SHELL = ["/", "/style.css", "/app.js", "/wizard.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return; // network only, never stored

  // Network first so updates show up immediately; the stored copy is only a fallback when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.status === 200 && res.type === "basic") { // not 206 partial responses, which the cache cannot store
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("/") : Response.error()))),
  );
});
