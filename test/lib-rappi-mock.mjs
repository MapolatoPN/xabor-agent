// Doble de la API de Rappi para las suites: registra cada llamada saliente
// (con qué client_id se autenticó, a qué orden, qué cuerpo) y permite forzar
// fallos por orden. Nunca habla con Rappi de verdad.
import http from 'node:http';

export async function arrancarRappiMock({ puerto }) {
  const llamadas = [];
  const fallos = new Map(); // `${metodo} ${ruta}` -> status
  const tokens = new Map(); // token -> clientId

  const servidor = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', d => { cuerpo += d; });
    req.on('end', () => {
      const url = new URL(req.url, `http://localhost:${puerto}`);
      let body = null;
      try { body = cuerpo ? JSON.parse(cuerpo) : null; } catch { body = cuerpo; }
      const responder = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };

      if (url.pathname === '/auth') {
        if (!body?.client_id || !body?.client_secret) return responder(401, { error: 'credenciales' });
        const token = `tok-${body.client_id}-${Date.now()}`;
        tokens.set(token, body.client_id);
        llamadas.push({ metodo: 'POST', ruta: '/auth', clientId: body.client_id });
        return responder(200, { access_token: token, expires_in: 3600 });
      }

      const auth = String(req.headers['x-authorization'] || '').replace(/^Bearer\s+/i, '');
      const clientId = tokens.get(auth) || null;
      const ruta = url.pathname.replace('/api/v2/restaurants-integrations-public-api', '');
      const registro = { metodo: req.method, ruta, clientId, body, query: Object.fromEntries(url.searchParams) };
      llamadas.push(registro);
      if (!clientId) return responder(401, { error: 'token' });

      const clave = `${req.method} ${ruta}`;
      for (const [patron, status] of fallos) {
        if (clave.startsWith(patron)) return responder(status, { error: 'fallo forzado' });
      }
      if (/^\/orders\/[^/]+\/take\//.test(ruta) && req.method === 'PUT') return responder(200, { ok: true });
      if (/^\/orders\/[^/]+\/reject$/.test(ruta) && req.method === 'PUT') return responder(200, { ok: true });
      if (/^\/orders\/[^/]+\/ready-for-pickup$/.test(ruta) && req.method === 'POST') return responder(200, { ok: true });
      if (ruta === '/availability/stores/items' && req.method === 'PUT') return responder(200, { ok: true });
      if (ruta === '/availability/stores/enable' && req.method === 'PUT') return responder(200, { ok: true });
      if (ruta === '/menu' && req.method === 'POST') return responder(200, { ok: true, items: body?.items?.length ?? 0 });
      if (/^\/menu\/approved\//.test(ruta)) return responder(200, { approved: true });
      if (/^\/webhook\//.test(ruta) && req.method === 'GET') return responder(404, { error: 'not found' });
      if (ruta === '/webhook' && req.method === 'POST') return responder(200, { event: body?.event, secret: 'SECRETO-MOCK', stores: body?.data?.[0]?.stores });
      if (/^\/webhook\/[^/]+\/change-url$/.test(ruta)) return responder(404, { error: 'not found' });
      return responder(404, { error: `sin ruta ${clave}` });
    });
  });

  await new Promise((ok, ko) => { servidor.on('error', ko); servidor.listen(puerto, '127.0.0.1', ok); });
  const base = `http://127.0.0.1:${puerto}`;
  return {
    base,
    authUrl: `${base}/auth`,
    llamadas,
    forzarFallo: (patron, status = 500) => fallos.set(patron, status),
    quitarFallo: (patron) => fallos.delete(patron),
    limpiar: () => { llamadas.length = 0; },
    tomas: (orderId) => llamadas.filter(l => l.metodo === 'PUT' && l.ruta === `/orders/${orderId}/take/20`.replace('/20', '') || (l.metodo === 'PUT' && l.ruta.startsWith(`/orders/${orderId}/take/`))),
    rechazos: (orderId) => llamadas.filter(l => l.metodo === 'PUT' && l.ruta === `/orders/${orderId}/reject`),
    listos: (orderId) => llamadas.filter(l => l.metodo === 'POST' && l.ruta === `/orders/${orderId}/ready-for-pickup`),
    detener: () => new Promise(ok => servidor.close(() => ok())),
  };
}
