'use strict';

// Bump CACHE whenever the app shell changes: activate() drops every other
// cache, which is what stops an old style.css/ui.js being served forever.
const CACHE = 'wireless-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/ui.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/host.html',
  '/laptop.html',
  '/desktop.html',
  '/download.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Live endpoints are always fetched from the network.
  const live = ['/api/status', '/api/downloads', '/qr.png', '/host', '/laptop', '/download', '/downloads'];
  if (live.includes(url.pathname)) return;

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match('/index.html'));
    })
  );
});