/* ------------------------------------------------------------------
   Balance Bridge — service worker.

   Served from /sw.js (see routes/client.ts) so its scope is the whole
   origin. Two jobs:

     1. **App shell caching** so the portal opens instantly, and opens
        at all with no signal.
     2. **Draining the offline capture queue** via Background Sync, with
        the tab closed and the phone in a pocket.

   ## What is deliberately NOT cached

   Everything client-specific. This is financial data on a device that
   may be shared, and the Cache API is not cleared by signing out. So:

     * no HTML page is ever written to the cache — /m, /insights and
       friends are network-only with an offline fallback that contains
       no data;
     * /api/*, /documents/* and every POST bypass the worker entirely;
     * only static, non-personal assets under /assets/ are stored.

   The offline experience is therefore "you can still capture", not "you
   can still browse your balances" — which is the right trade for a
   phone on a job site.
------------------------------------------------------------------- */

'use strict';

importScripts('/assets/pwa/queue.js');

var VERSION = 'v1';
var SHELL_CACHE = 'bb-shell-' + VERSION;
var SYNC_TAG = 'bb-capture-flush';
var UPLOAD_ENDPOINT = '/api/pwa/upload';

/** Static, non-personal assets only. */
var SHELL = [
  '/assets/portal.css',
  '/assets/portal.js',
  '/assets/favicon.svg',
  '/assets/pwa/pwa.css',
  '/assets/pwa/queue.js',
  '/assets/pwa/capture.js',
  '/assets/pwa/icon-192.png',
  '/assets/pwa/icon-512.png',
  '/manifest.webmanifest',
];

/* ================================================================== */
/* Install / activate                                                  */
/* ================================================================== */

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // Individually, not addAll: one asset missing in dev must not stop the
      // worker installing and taking over the capture queue.
      return Promise.all(
        SHELL.map(function (url) {
          return cache.add(new Request(url, { cache: 'reload' })).catch(function () { return null; });
        }),
      );
    }).then(function () { return self.skipWaiting(); }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(
          keys.filter(function (k) {
            return k.indexOf('bb-shell-') === 0 && k !== SHELL_CACHE;
          }).map(function (k) { return caches.delete(k); }),
        );
      })
      .then(function () { return self.clients.claim(); })
      // A worker waking up after an update may find captures still waiting.
      .then(function () { return drain(); }),
  );
});

/* ================================================================== */
/* Fetch                                                               */
/* ================================================================== */

function isShellAsset(url) {
  return url.pathname.indexOf('/assets/') === 0 || url.pathname === '/manifest.webmanifest';
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return; // uploads and forms are never intercepted

  var url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Never touch the API, document downloads, or the worker/auth endpoints.
  if (
    url.pathname.indexOf('/api/') === 0 ||
    url.pathname.indexOf('/webhooks/') === 0 ||
    url.pathname.indexOf('/documents/') === 0 ||
    url.pathname === '/sw.js' ||
    url.pathname === '/logout'
  ) {
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(req));
    return;
  }

  if (isShellAsset(url)) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

/**
 * Network-only with an offline fallback. No page HTML is cached, so a signed
 * out or borrowed phone can never pull a previous user's figures out of the
 * cache — and the fallback below contains no client data at all.
 */
function handleNavigation(req) {
  return fetch(req).catch(function () {
    return offlinePage();
  });
}

function staleWhileRevalidate(req) {
  return caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(req).then(function (cached) {
      var network = fetch(req)
        .then(function (res) {
          // Opaque and redirected responses cannot be replayed from a cache.
          if (res && res.ok && res.type === 'basic' && !res.redirected) {
            cache.put(req, res.clone());
          }
          return res;
        })
        .catch(function () { return cached; });
      return cached || network;
    });
  });
}

/**
 * The offline shell. Built here rather than fetched so it is available even
 * on the very first offline load, and so it is guaranteed to be empty of
 * anything client-specific.
 */
function offlinePage() {
  var html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Offline — Balance Bridge</title>' +
    '<link rel="stylesheet" href="/assets/portal.css">' +
    '<link rel="stylesheet" href="/assets/pwa/pwa.css">' +
    '</head><body class="app"><main class="content"><div class="m-page">' +
    '<section class="m-empty-hero">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 8.5A1.5 1.5 0 014.5 7h2.2l1.2-2h8.2l1.2 2h2.2A1.5 1.5 0 0121 8.5v9A1.5 1.5 0 0119.5 19h-15A1.5 1.5 0 013 17.5z"/>' +
    '<circle cx="12" cy="13" r="3.5"/></svg>' +
    '<p class="m-empty-title">You’re offline</p>' +
    '<p class="m-empty-sub">Anything you captured is safe on this phone and will send itself ' +
    'as soon as you have signal. Nothing is lost.</p>' +
    '<a class="btn btn-primary" href="/m">Try again</a>' +
    '</section></div></main></body></html>';

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/* ================================================================== */
/* Background Sync — the reason this worker exists                     */
/* ================================================================== */

/**
 * Drain the queue and tell any open tab so its list re-renders.
 *
 * The CSRF token comes from the `meta` store, written by capture.js on every
 * page load. If the session has since rotated, items come back BLOCKED rather
 * than failed or dropped, and the next page load re-queues them with a fresh
 * token. A capture is never thrown away because a token expired.
 */
function drain(force) {
  if (!self.BBQueue) return Promise.resolve();
  return self.BBQueue.flush({ endpoint: UPLOAD_ENDPOINT, force: !!force })
    .then(function (result) {
      return notifyClients(result);
    })
    .catch(function () { return undefined; });
}

function notifyClients(result) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    list.forEach(function (client) {
      client.postMessage({ type: 'bb-queue-changed', result: result || null });
    });
  });
}

self.addEventListener('sync', function (event) {
  if (event.tag === SYNC_TAG) {
    // Rejecting tells the browser to retry the sync later with its own
    // backoff, which is exactly what we want on a phone with no signal.
    event.waitUntil(
      drain().then(function () {
        return self.BBQueue.pendingCount().then(function (n) {
          if (n > 0) throw new Error('captures still pending');
        });
      }),
    );
  }
});

/** Periodic Sync where it exists: a belt-and-braces sweep. */
self.addEventListener('periodicsync', function (event) {
  if (event.tag === SYNC_TAG) event.waitUntil(drain());
});

self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type === 'bb-flush') event.waitUntil(drain(data.force));
  if (data.type === 'bb-skip-waiting') self.skipWaiting();
});
