'use strict';
importScripts('./pwa-shell.js');

const scope = self.registration.scope;
const prefix = 'nai-lens-shell:' + encodeURIComponent(scope) + ':';
const cacheName = prefix + SHELL_VERSION;
const indexURL = new URL('./index.html', scope).href;
const files = new Set(Object.keys(SHELL_FILES).map(path => new URL(path, scope).href));

self.addEventListener('install', event => {
  // addAll is atomic. A missing file or a mixed release fails integrity checking
  // and leaves the currently active version available, including offline.
  const requests = Object.entries(SHELL_FILES).map(([path, integrity]) =>
    new Request(new URL(path, scope), { integrity, credentials: 'omit', cache: 'reload', redirect: 'error' })
  );
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(requests)));
});

self.addEventListener('activate', event => {
  // Normal worker lifecycle lets all open sessions finish on their own version.
  event.waitUntil(caches.keys().then(names => Promise.all(
    names.filter(name => name.startsWith(prefix) && name !== cacheName).map(name => caches.delete(name))
  )));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.cache === 'no-store' ||
      request.headers.has('authorization') || request.headers.has('range')) return;

  const navigation = request.mode === 'navigate';
  const key = navigation && request.url === scope ? indexURL : request.url;
  if (navigation ? key !== indexURL : !request.destination || !files.has(key)) return;

  // Never put runtime requests, responses, generated images or backups in Cache Storage.
  event.respondWith(caches.open(cacheName).then(cache => cache.match(key))
    .then(response => response || fetch(request)));
});
