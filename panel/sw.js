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

// ─── Caché del panel para sobrevivir a un corte de internet ─────────────────
//
// Sin esto, el failover de sala (panel/offline-sala.js) solo funciona mientras
// nadie recargue la página: el panel se sirve desde la nube, así que un F5
// durante el corte deja la pantalla en blanco y al restaurante sin sistema.
//
// ESTRATEGIA: RED PRIMERO, caché como respaldo. Nunca al revés.
//
// Esa dirección importa y no es un detalle. Un service worker que sirviera de
// caché primero dejaría a los negocios operando con un panel viejo después de
// cada despliegue, y ese problema es peor y más difícil de diagnosticar que el
// que vino a resolver: nadie sospecha del navegador. Con red primero, mientras
// haya enlace SIEMPRE se ve la versión recién desplegada; la copia solo aparece
// cuando la red no responde.
const CACHE_SHELL = 'xabor-shell-v1';

// Solo lo que hace falta para que la pantalla ABRA. Los datos nunca se
// cachean: vienen del Edge de la red local, que es quien sabe la verdad
// durante el corte.
const DEL_SHELL = /\.(html|js|css|png|ico|woff2?)$/i;

self.addEventListener('activate', (event) => {
  // Al cambiar de versión se borran las anteriores: una caché vieja olvidada
  // es exactamente el problema que se quiere evitar.
  event.waitUntil(
    caches.keys().then((claves) => Promise.all(
      claves.filter((k) => k.startsWith('xabor-shell-') && k !== CACHE_SHELL).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Las llamadas a la API JAMÁS se cachean. Servir un tablero de mesas viejo
  // sería peor que no servir nada: el mesero cobraría sobre una cuenta que ya
  // no existe.
  if (url.pathname.startsWith('/api/')) return;

  const esShell = url.pathname === '/' || url.pathname === '/app' || DEL_SHELL.test(url.pathname);
  if (!esShell) return;

  event.respondWith((async () => {
    try {
      const respuesta = await fetch(req);
      // Solo se guarda lo que salió bien: cachear un 500 dejaría el error
      // congelado en esa máquina.
      if (respuesta && respuesta.ok) {
        const copia = respuesta.clone();
        caches.open(CACHE_SHELL).then((c) => c.put(req, copia)).catch(() => {});
      }
      return respuesta;
    } catch (e) {
      const guardada = await caches.match(req);
      if (guardada) return guardada;
      // Para una navegación sin copia, se intenta el panel completo: es lo que
      // permite que un F5 durante el corte siga abriendo la sala.
      if (req.mode === 'navigate') {
        const app = await caches.match('/app') || await caches.match('/');
        if (app) return app;
      }
      throw e;
    }
  })());
});

self.addEventListener('install', () => self.skipWaiting());
// El `clients.claim()` que estaba aquí se fusionó con el handler de 'activate'
// de arriba, que ya lo hace: dos listeners del mismo evento funcionan, pero
// dejaban la limpieza de cachés y la toma de control en sitios distintos.
