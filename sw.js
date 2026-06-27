// SecPlus Tracker — service worker
// Caches the app shell for offline use. Firestore handles offline *data* itself
// (via its IndexedDB cache); here we just make sure the HTML/CSS/JS and the
// Firebase SDK modules are available without the network.

const VERSION = "v6";
const SHELL_CACHE = `secplus-shell-${VERSION}`;
const RUNTIME_CACHE = `secplus-runtime-${VERSION}`;

// Same-origin files that make up the app shell. Paths are relative so this works
// under a GitHub Pages subpath (e.g. /secplus-tracker/).
const SHELL = [
  ".",
  "index.html",
  "styles.css",
  "app.js",
  "firebase-config.js",
  "manifest.webmanifest",
  "data/videos.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // Don't fail the whole install if one optional file 404s.
      .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never cache writes

  const url = new URL(req.url);

  // Google Fonts (stylesheet + font files): cache-first so type works offline.
  // Checked BEFORE the Firebase rule below, which would otherwise swallow
  // fonts.googleapis.com via its `.googleapis.com` match.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }

  // Firebase data/auth APIs: always go to the network (Firestore caches its own
  // data). Don't intercept these.
  if (/(\.googleapis\.com|identitytoolkit|firestore|firebaseinstallations|firebaseio\.com)/.test(url.hostname + url.pathname)) {
    return;
  }

  // Firebase SDK modules from gstatic: cache-first (they're immutable per version).
  if (url.hostname === "www.gstatic.com" && url.pathname.includes("/firebasejs/")) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }

  // App navigations: network-first, fall back to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("index.html").then((r) => r || caches.match(".")))
    );
    return;
  }

  // Same-origin static assets: stale-while-revalidate.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }
  // Anything else: just try the network.
});

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) (await caches.open(cacheName)).put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => cached);
  return cached || network;
}
