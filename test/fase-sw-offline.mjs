// EL SERVICE WORKER QUE DEJA ABRIR EL PANEL DURANTE UN CORTE.
//
// Sin él, el failover de sala solo funciona mientras nadie recargue la página:
// el panel se sirve desde la nube, así que un F5 durante el corte deja la
// pantalla en blanco y al restaurante sin sistema.
//
// Lo que más hay que vigilar aquí NO es que cachee, sino que cachee en la
// dirección correcta. Un service worker de "caché primero" dejaría a los
// negocios operando con un panel viejo después de cada despliegue, y ese
// problema es peor que el que vino a resolver porque nadie sospecha del
// navegador. Se prueba explícitamente que mientras hay red SIEMPRE gana la red.
//
// Se evalúa `panel/sw.js` en un sandbox con los globales simulados, que es el
// mismo método que ya usa `fase-impresion-self-service` con el panel.
//
// Uso: node test/fase-sw-offline.mjs
import assert from 'assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const fuente = readFileSync(new URL('../panel/sw.js', import.meta.url), 'utf8');

/** Monta el SW con globales de mentira y devuelve sus manejadores. */
function montar({ red, guardadas = {} } = {}) {
  const manejadores = {};
  const cache = new Map(Object.entries(guardadas));
  const borradas = [];
  const almacenes = new Map([['xabor-shell-v1', cache], ['xabor-shell-v0', new Map()], ['otra-cosa', new Map()]]);

  // En un Service Worker real `self.clients` y el global `clients` son EL
  // MISMO objeto, y `caches.match('/app')` resuelve la ruta contra el origen.
  // El mock tiene que comportarse igual o prueba otra cosa.
  const ORIGEN = 'https://xabor.mx';
  const clientes = { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} };
  const clave = (req) => new URL(typeof req === 'string' ? req : String(req.url), ORIGEN).href;

  const sandbox = {
    self: {
      addEventListener: (ev, fn) => { manejadores[ev] = fn; },
      location: { origin: ORIGEN },
      registration: { showNotification: () => {} },
      clients: clientes,
    },
    clients: clientes,
    caches: {
      keys: async () => [...almacenes.keys()],
      delete: async (k) => { borradas.push(k); return almacenes.delete(k); },
      open: async () => ({ put: async (req, res) => cache.set(clave(req), res) }),
      match: async (req) => cache.get(clave(req)) || undefined,
    },
    fetch: red,
    URL,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fuente, sandbox);
  return { manejadores, cache, borradas };
}

const peticion = (url, { method = 'GET', mode = 'no-cors' } = {}) => ({ url, method, mode });
const respuesta = (ok, cuerpo = 'contenido') => ({ ok, status: ok ? 200 : 500, cuerpo, clone() { return { ...this }; } });

/** Ejecuta el handler de fetch y devuelve lo que respondió, o null si no intervino. */
async function pedir(manejadores, req) {
  let promesa = null;
  manejadores.fetch({ request: req, respondWith: (p) => { promesa = p; } });
  return promesa === null ? null : promesa;
}

// ═══ A. La dirección correcta: la red manda ════════════════════════════════
await t('A1. con red, SIEMPRE gana la red — nunca una copia vieja', async () => {
  const { manejadores, cache } = montar({
    red: async () => respuesta(true, 'version-nueva'),
    guardadas: { 'https://xabor.mx/app': respuesta(true, 'version-vieja') },
  });
  const r = await pedir(manejadores, peticion('https://xabor.mx/app'));
  assert.strictEqual(r.cuerpo, 'version-nueva',
    'servir la copia con red disponible dejaría al negocio en un panel viejo tras cada despliegue');
  assert.strictEqual(cache.get('https://xabor.mx/app').cuerpo, 'version-nueva', 'y se actualiza la copia');
});

await t('A2. sin red, se sirve la copia y el panel ABRE', async () => {
  const { manejadores } = montar({
    red: async () => { throw new TypeError('Failed to fetch'); },
    guardadas: { 'https://xabor.mx/app': respuesta(true, 'copia') },
  });
  const r = await pedir(manejadores, peticion('https://xabor.mx/app'));
  assert.strictEqual(r.cuerpo, 'copia', 'esto es lo que permite un F5 durante el corte');
});

await t('A3. una navegación sin copia exacta cae al panel guardado', async () => {
  const { manejadores } = montar({
    red: async () => { throw new TypeError('Failed to fetch'); },
    guardadas: { 'https://xabor.mx/app': respuesta(true, 'panel') },
  });
  const r = await pedir(manejadores, peticion('https://xabor.mx/', { mode: 'navigate' }));
  assert.strictEqual(r.cuerpo, 'panel');
});

await t('A4. un error del servidor NO se cachea: quedaría congelado', async () => {
  const { manejadores, cache } = montar({ red: async () => respuesta(false) });
  const r = await pedir(manejadores, peticion('https://xabor.mx/app'));
  assert.strictEqual(r.ok, false, 'el 500 se devuelve tal cual');
  assert.strictEqual(cache.has('https://xabor.mx/app'), false, 'pero no se guarda');
});

// ═══ B. Lo que NUNCA debe tocar ════════════════════════════════════════════
await t('B1. las llamadas a la API jamás se interceptan', async () => {
  const { manejadores } = montar({ red: async () => respuesta(true) });
  for (const ruta of ['/api/restaurante/mesas', '/api/ventas', '/api/config/operativa']) {
    const r = await pedir(manejadores, peticion(`https://xabor.mx${ruta}`));
    assert.strictEqual(r, null,
      `servir un tablero de mesas viejo sería peor que no servir nada (${ruta})`);
  }
});

await t('B2. ni los POST, ni otro origen, ni lo que no es del shell', async () => {
  const { manejadores } = montar({ red: async () => respuesta(true) });
  assert.strictEqual(await pedir(manejadores, peticion('https://xabor.mx/app', { method: 'POST' })), null);
  assert.strictEqual(await pedir(manejadores, peticion('https://otro-sitio.mx/app')), null);
  assert.strictEqual(await pedir(manejadores, peticion('https://xabor.mx/algo-raro')), null);
});

await t('B3. sí se cachea lo que hace falta para que la pantalla abra', async () => {
  const { manejadores } = montar({ red: async () => respuesta(true, 'ok') });
  for (const ruta of ['/app', '/', '/offline-sala.js', '/index.html', '/estilos.css', '/icon-192.png']) {
    const r = await pedir(manejadores, peticion(`https://xabor.mx${ruta}`));
    assert.ok(r !== null, `${ruta} debería servirse desde el shell`);
  }
});

// ═══ C. No dejar cachés viejas olvidadas ══════════════════════════════════
await t('C1. al activarse borra las versiones anteriores y respeta lo ajeno', async () => {
  const { manejadores, borradas } = montar({ red: async () => respuesta(true) });
  let esperar = null;
  await manejadores.activate({ waitUntil: (p) => { esperar = p; } });
  await esperar;
  assert.ok(borradas.includes('xabor-shell-v0'), 'una caché vieja olvidada es justo el problema a evitar');
  assert.ok(!borradas.includes('xabor-shell-v1'), 'la actual no se borra');
  assert.ok(!borradas.includes('otra-cosa'), 'ni cachés que no son suyas');
});

// ═══ D. Lo que ya hacía sigue igual ═══════════════════════════════════════
await t('D1. push, notificationclick e install siguen registrados', async () => {
  const { manejadores } = montar({ red: async () => respuesta(true) });
  assert.strictEqual(typeof manejadores.push, 'function', 'las notificaciones no pueden romperse por esto');
  assert.strictEqual(typeof manejadores.notificationclick, 'function');
  assert.strictEqual(typeof manejadores.install, 'function', 'skipWaiting sigue ahí');
});

await t('D2. un SOLO handler de activate', () => {
  // Había dos: el `clients.claim()` que ya existía al final del archivo y el
  // que limpia cachés. Ambos funcionan a la vez, pero dejaban la limpieza y la
  // toma de control en sitios distintos, y el segundo tapaba al primero en
  // cualquier prueba que registre por nombre. Se fusionaron.
  const cuantos = (fuente.match(/addEventListener\('activate'/g) || []).length;
  assert.strictEqual(cuantos, 1, `hay ${cuantos} handlers de 'activate'`);
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
