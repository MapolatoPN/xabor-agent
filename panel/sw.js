// Xabor — Service Worker para Push Notifications
self.addEventListener('push', (event) => {
  let datos = { titulo: 'Xabor', cuerpo: 'Nueva notificación', data: {} };
  try { datos = event.data.json(); } catch {}

  event.waitUntil(
    self.registration.showNotification(datos.titulo, {
      body:    datos.cuerpo,
      icon:    '/icon-192.png',
      badge:   '/icon-72.png',
      vibrate: [200, 100, 200],
      tag:     'xabor-pedido',        // reemplaza notificación anterior del mismo tipo
      renotify: true,
      data:    datos.data || {}
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      // Si el panel ya está abierto, enfocarlo
      for (const c of lista) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          return c.focus();
        }
      }
      // Si no, abrir el panel
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
