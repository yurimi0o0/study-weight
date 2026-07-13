try {
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
  firebase.initializeApp({
    apiKey: 'AIzaSyC4gkAvxpB87UqVUItrLK098AY758f2hMQ',
    authDomain: 'study-weight.firebaseapp.com',
    projectId: 'study-weight',
    storageBucket: 'study-weight.firebasestorage.app',
    messagingSenderId: '850012109401',
    appId: '1:850012109401:web:6ba78214593f87c7054f48'
  });
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const title = payload?.notification?.title || '通知';
    const body = payload?.notification?.body || '';
    self.registration.showNotification(title, { body, tag: 'sdl-push' });
  });
} catch (err) {
  console.error('FCM SW init failed:', err);
}

const CACHE_NAME = 'study-density-log-v6';
const APP_SHELL = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // addAll は1件でも404があると全体失敗するため、個別に安全追加
      await Promise.all(APP_SHELL.map(async (url) => {
        try {
          const req = new Request(url, { cache: 'no-cache' });
          const res = await fetch(req);
          if (res.ok) await cache.put(req, res.clone());
        } catch (_) {
          // オフラインや404でも install 全体を失敗させない
        }
      }));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 通知タップでアプリを前面表示 / 未起動なら開く
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const req = event.request;
  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isAsset = req.destination === 'script' || req.destination === 'style' || req.destination === 'document';
  if (!isSameOrigin || !isAsset) return;

  if (req.destination === 'script' || req.destination === 'style') {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        const cloned = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, cloned));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});
