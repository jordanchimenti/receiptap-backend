// public/sw.js
// Service worker for the customer wallet. Two jobs: web push, and caching the
// static shell so the home-screen app doesn't feel sluggish.
//
// What is cached is deliberately narrow: the stylesheet, logo and icons only.
// Pages, receipts and stamp counts are NEVER cached -- a stale total or a card
// showing the wrong number of stamps is worse than a slow one, so every HTML
// and API request goes to the network exactly as before.
//
// Served from the site root on purpose: a service worker can only control
// pages at or below its own path, and /account/* has to be in scope.

const CACHE = 'receiptap-static-v1';

// Take over immediately instead of waiting for every open tab to close --
// otherwise the first install does nothing until the customer quits the app.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from older versions of this worker so a rename is all it
    // takes to force everyone onto fresh assets.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Only these. Anything not matching falls through to the network untouched.
function isCacheableAsset(url) {
  if (url.origin !== self.location.origin) return false;
  return /^\/(css|images|icons)\//.test(url.pathname) || url.pathname === '/favicon.ico';
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (!isCacheableAsset(url)) return; // pages and data always go to the network

  // Stale-while-revalidate: answer instantly from cache, then quietly refresh
  // in the background. A changed logo shows up on the next page load rather
  // than costing a round trip on this one.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);

    const network = fetch(request)
      .then((response) => {
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      })
      .catch(() => cached); // offline -- the cached copy is the best we have

    return cached || network;
  })());
});

self.addEventListener('push', (event) => {
  // A push with no readable body still has to show something: browsers revoke
  // push permission from sites that receive a push and display nothing.
  let payload = { title: 'ReceipTap', body: 'You have a new alert.', url: '/account/notifications' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (err) {
    // Malformed payload -- fall through to the generic notification above.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: payload.url },
      // One notification per merchant replaces the last rather than stacking:
      // two "your card is full" alerts for the same shop is noise.
      tag: payload.tag || 'receiptap',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/account/notifications';

  // Focus an already-open wallet tab rather than piling up new ones.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('/account') && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
