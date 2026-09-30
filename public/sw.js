// Minimal service worker: it exists only so notifications work on mobile browsers
// (Android Chrome refuses `new Notification()`; it needs registration.showNotification)
// and so tapping one brings the chat back. No fetch handler, no caching, no network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list[0];
      if (open) return open.focus();
      return self.clients.openWindow(self.registration.scope);
    }),
  );
});
