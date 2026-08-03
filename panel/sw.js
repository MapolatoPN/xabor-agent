// Xabor — Service Worker para PWA + Push Notifications (Bloque 4)
const CACHE_VERSION = 'xabor-v1';

self.addEventListener('push', (event) => {
  let datos = { titulo: 'Xabor', cuerpo: 'Nueva notificación', data: {} };
  try { datos = event.data.json(); } catch {}
  const data = datos.data || {};

  event.waitUntil((async () => {
    // No mostrar la notificación del sistema si el panel ya está abierto
    // y enfocado (una pestaña con foco real, no solo abierta en segundo
    // plano) -- el toast/sonido que ya dispara el WebSocket es
    // suficiente en ese caso, evita duplicar el aviso.
    const clientesAbiertos = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hayClienteEnfocado = clientesAbiertos.some((c) => c.focused);
    if (hayClienteEnfocado) return;

    await self.registration.showNotification(datos.titulo, {
      body: datos.cuerpo,
      icon: '/icon-192.png',
      badge: '/icon-72.png',
      vibrate: [200, 100, 200],
      // tag por conversación/evento (no un tag fijo global) -- así una
      // foto nueva de un cliente no reemplaza el aviso de un pedido
      // nuevo, pero dos mensajes seguidos DEL MISMO chat sí se
      // consolidan en una sola notificación (igual que WhatsApp).
      tag: data.tag || 'xabor-general',
      renotify: true,
      data,
    });

    // Badge del ícono de la app (Android/desktop -- iOS Safari aún no
    // soporta la Badging API, se ignora silenciosamente ahí).
    if ('setAppBadge' in self.navigator) {
      const total = (await self.registration.getNotifications()).length;
      self.navigator.setAppBadge(total).catch(() => {});
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/app';
  event.waitUntil((async () => {
    const lista = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of lista) {
      if (c.url.includes(self.location.origin)) {
        // Enfoca la pestaña existente Y la navega/enruta al chat o
        // sección exacta -- postMessage lo escucha panel/index.html para
        // abrir la conversación sin recargar toda la SPA.
        await c.focus();
        c.postMessage({ tipo: 'xabor-push-click', url });
        return;
      }
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});

self.addEventListener('notificationclose', async () => {
  if ('setAppBadge' in self.navigator) {
    const restantes = (await self.registration.getNotifications()).length;
    if (restantes === 0) self.navigator.clearAppBadge().catch(() => {});
    else self.navigator.setAppBadge(restantes).catch(() => {});
  }
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
