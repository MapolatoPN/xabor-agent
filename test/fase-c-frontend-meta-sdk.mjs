// Prueba de la lógica de integración del SDK de Meta en
// panel/superadmin.html (carga única, bloqueo por navegador,
// cancelación libera el candado, éxito arma el POST correcto, doble
// clic no abre dos diálogos). Extrae solo el bloque de funciones de
// Embedded Signup del HTML y lo corre con un DOM mínimo simulado --
// no requiere navegador real.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'panel', 'superadmin.html'), 'utf8');
const inicio = html.indexOf('// ── Fase C: Embedded Signup de Meta');
const fin = html.indexOf('async function cargarAuditoria');
const bloque = html.slice(inicio, fin);

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

function nuevoContexto({ configOk = true, iniciarOk = true } = {}) {
  const llamadasFetch = [];
  const elementos = {
    'dt-wa-feedback': { className: '', textContent: '' },
    'btn-conectar-meta': { disabled: false },
    'dt-titulo': { textContent: 'Negocio de prueba' },
  };
  const scripts = [];
  const doc = {
    getElementById: (id) => elementos[id],
    createElement: () => { const el = { onerror: null, onload: null }; scripts.push(el); return el; },
    body: { appendChild: (el) => { if (el.onload) el.onload(); } },
    addEventListener: () => {},
  };
  const negocioActualId = 'negocio-test-123';
  const ctx = {
    document: doc,
    window: { addEventListener: () => {} },
    negocioActualId,
    api: async (path, opts = {}) => {
      llamadasFetch.push({ path, opts });
      if (path.includes('/iniciar')) {
        return { ok: iniciarOk, json: async () => iniciarOk ? { state: 'STATE_TEST_ABC' } : { error: 'no se pudo iniciar' } };
      }
      if (path.includes('/embedded-signup/config')) {
        return { ok: configOk, json: async () => configOk ? { appId: 'APP_TEST', configId: 'CFG_TEST', graphApiVersion: 'v20.0' } : { error: 'Embedded Signup no configurado' } };
      }
      if (path.includes('/meta/callback')) {
        return { ok: true, json: async () => ({ ok: true, estado: 'activo' }) };
      }
      throw new Error('ruta no esperada: ' + path);
    },
    setTimeout,
    Promise,
    console,
    cargarIntegracionWhatsapp: () => {},
  };
  return { ctx, elementos, scripts, llamadasFetch };
}

function ejecutar(ctx) {
  const fn = new Function(...Object.keys(ctx), bloque + '\nreturn { conectarConMeta, completarSignupMeta, cargarSdkMeta, liberarSignup, get waSignupEnCurso() { return waSignupEnCurso; }, get waSignupDatos() { return waSignupDatos; } };');
  return fn(...Object.values(ctx));
}

await t('cargarSdkMeta: se carga una sola vez (mismo promise en llamadas repetidas)', () => {
  const { ctx } = nuevoContexto();
  const api = ejecutar(ctx);
  const p1 = api.cargarSdkMeta('APP', 'v20.0');
  const p2 = api.cargarSdkMeta('APP', 'v20.0');
  assert.strictEqual(p1, p2);
});

await t('SDK bloqueado por el navegador -> error controlado, no lanza', async () => {
  const { ctx, scripts } = nuevoContexto();
  const api = ejecutar(ctx);
  const p = api.cargarSdkMeta('APP', 'v20.0');
  scripts[0].onerror(new Error('bloqueado'));
  await assert.rejects(p, /bloqueado por el navegador o sin conexión/);
});

await t('cancelación (sin authResponse.code) libera el candado', async () => {
  const { ctx } = nuevoContexto();
  ctx.window.FB = { init: () => {}, login: (cb) => cb({}) }; // simula cancelación inmediata
  const api = ejecutar(ctx);
  await api.conectarConMeta();
  assert.strictEqual(api.waSignupEnCurso, false);
});

await t('doble clic: la segunda llamada no dispara un segundo /iniciar', async () => {
  const { ctx, llamadasFetch } = nuevoContexto();
  let resolverLogin;
  ctx.window.FB = { init: () => {}, login: () => { /* nunca resuelve durante la prueba */ } };
  const api = ejecutar(ctx);
  const p1 = api.conectarConMeta();
  const p2 = api.conectarConMeta(); // debe salir de inmediato por waSignupEnCurso
  await Promise.all([p1, p2]);
  const llamadasIniciar = llamadasFetch.filter(l => l.path.includes('/iniciar'));
  assert.strictEqual(llamadasIniciar.length, 1);
});

await t('éxito: completarSignupMeta envía state+code+identificadores, nunca negocio_id en el body', async () => {
  const { ctx, llamadasFetch } = nuevoContexto();
  const api = ejecutar(ctx);
  // Simula que ya se inició (arma waSignupDatos vía conectarConMeta con FB.login que responde code)
  ctx.window.FB = { init: () => {}, login: (cb) => cb({ authResponse: { code: 'CODE_TEST' } }) };
  await api.conectarConMeta();
  const llamadaCallback = llamadasFetch.find(l => l.path.includes('/meta/callback'));
  assert.ok(llamadaCallback);
  const body = JSON.parse(llamadaCallback.opts.body);
  assert.strictEqual(body.state, 'STATE_TEST_ABC');
  assert.strictEqual(body.code, 'CODE_TEST');
  assert.ok(!('negocio_id' in body) && !('negocioId' in body));
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('\nDetalle de fallos:'); fallos.forEach(f => console.log('  - ' + f)); }
process.exit(fallidas > 0 ? 1 : 0);
