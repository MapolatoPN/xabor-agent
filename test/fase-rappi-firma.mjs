// Firma de los avisos de Rappi (rappiFirma.js + webhook de rappi.js).
//
// Por qué existe: desde el 7-oct-2026 los pedidos de Rappi de Obispado entran
// solos a cocina, y hasta hoy el webhook aceptaba cualquier aviso sin revisar
// su firma. Esta suite fija: la verificación (HMAC sobre el cuerpo crudo,
// ventana de tiempo, varios secretos), que en «exigir» un pedido sin firma
// válida NO llega a registrarse, que «registrar» nunca rechaza, que el
// servidor guarda el cuerpo crudo de /webhook/rappi, y que un 401 de Rappi
// con el token en caché se reintenta una sola vez con un token nuevo.
// No llama a Rappi: `fetch` se sustituye.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const SERVER = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');

const { pool } = await import('../src/services/database.js');
const { calcularFirmaRappi, verificarFirmaRappi, evaluarFirmaWebhookRappi } = await import('../src/channels/rappiFirma.js');
const { default: rappiRouter } = await import('../src/channels/rappi.js');
const { consultarAprobacionMenu, reiniciarSecretoWebhook, obtenerWebhook } = await import('../src/services/rappi-api.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;
const suf = Date.now().toString().slice(-6);
const STORE = `RF_${suf}`;
const SECRETO = `secreto-nuevo-order-${suf}`;
const OTRO = `secreto-ping-${suf}`;
const firmar = (secreto, cuerpo, t = Date.now()) => `t=${t},sign=${calcularFirmaRappi(secreto, String(t), cuerpo)}`;

// ── Rappi falso ──────────────────────────────────────────────────────────
const llamadas = [];
// Cola de { status, body } solo para la ruta que cada caso prueba: tomar un
// pedido (casos 4 y 5) corre en segundo plano y no debe consumirla.
let rutaProbada = null;
let respuestasApi = [];
let tokensEmitidos = 0;
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return fetchOriginal(url, opts);
  if (u.includes('/token/login')) {
    tokensEmitidos++;
    return new Response(JSON.stringify({ access_token: `tok-${tokensEmitidos}`, expires_in: 3600 }), { status: 200 });
  }
  if (!rutaProbada || !u.includes(rutaProbada)) return new Response('{}', { status: 200 });
  llamadas.push({ url: u, metodo: opts.method, auth: opts.headers?.['x-authorization'] });
  const r = respuestasApi.shift() || { status: 200, body: '{}' };
  return new Response(r.body, { status: r.status });
};

// ── Servidor mínimo con el mismo parser que server.js y el router real ──
const app = express();
app.use(express.json({
  limit: '20mb',
  verify: (req, _res, buf) => {
    if (req.originalUrl && (req.originalUrl.startsWith('/webhook/whatsapp') || req.originalUrl.startsWith('/webhook/rappi'))) req.rawBody = buf;
  },
}));
app.use('/webhook/rappi', rappiRouter);
const servidor = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
const BASE = `http://127.0.0.1:${servidor.address().port}/webhook/rappi`;
const enviar = (cuerpo, firma) => fetchOriginal(BASE, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(firma ? { 'Rappi-Signature': firma } : {}) }, body: cuerpo,
});
// Con espacios a propósito: la firma es sobre los bytes tal cual llegaron, y
// una re-serialización (JSON.stringify) daría otros bytes.
const pedidoFalso = (orderId) => JSON.stringify({
  order_detail: { order_id: orderId, items: [{ name: 'RF Producto', sku: 'XB-1', quantity: 1, price: 150 }], totals: { total_order: 150, total_products: 150 } },
  customer: { first_name: 'Prueba' }, store: { internal_id: STORE },
}, null, 2);
const pedidosCreados = async (orderId) => (await pool.query(
  `SELECT folio FROM pedidos_activos WHERE datos->>'rappi_order_id' = $1`, [orderId])).rows.length;
const esperarPedido = async (orderId, ms = 6000) => {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (await pedidosCreados(orderId)) return true; await new Promise(r => setTimeout(r, 150)); }
  return false;
};

const envOriginal = { s: process.env.RAPPI_WEBHOOK_SECRET, m: process.env.RAPPI_WEBHOOK_FIRMA };
async function limpiar() {
  await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'rappi' AND identificador LIKE 'RF_%'`).catch(() => {});
}

try {
  await limpiar();
  await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, estado, activo)
                    VALUES ($1,'rappi',$2,'RF test','activo',TRUE)`, [NEG_A, STORE]);

  await t('1. la firma valida solo con el secreto, el cuerpo exacto y dentro de la ventana', async () => {
    const cuerpo = Buffer.from('{"store_id":1}');
    const ahora = Date.now();
    assert.strictEqual(verificarFirmaRappi({ header: firmar(SECRETO, cuerpo, ahora), rawBody: cuerpo, secret: SECRETO, ahoraMs: ahora }).motivo, 'ok');
    const enSegundos = Math.floor(ahora / 1000);
    assert.strictEqual(verificarFirmaRappi({ header: firmar(SECRETO, cuerpo, enSegundos), rawBody: cuerpo, secret: SECRETO, ahoraMs: ahora }).motivo, 'ok');
    assert.strictEqual(verificarFirmaRappi({ header: firmar('otro', cuerpo, ahora), rawBody: cuerpo, secret: SECRETO, ahoraMs: ahora }).motivo, 'no_coincide');
    assert.strictEqual(verificarFirmaRappi({ header: firmar(SECRETO, cuerpo, ahora), rawBody: Buffer.from('{"store_id": 1}'), secret: SECRETO, ahoraMs: ahora }).motivo, 'no_coincide',
      'una re-serialización del cuerpo pasó como válida');
    assert.strictEqual(verificarFirmaRappi({ header: firmar(SECRETO, cuerpo, ahora - 10 * 60 * 1000), rawBody: cuerpo, secret: SECRETO, ahoraMs: ahora }).motivo, 'fuera_de_ventana');
    assert.strictEqual(verificarFirmaRappi({ header: undefined, rawBody: cuerpo, secret: SECRETO }).motivo, 'sin_header');
    assert.strictEqual(verificarFirmaRappi({ header: 'basura', rawBody: cuerpo, secret: SECRETO }).motivo, 'header_invalido');
  });

  await t('2. modos: «registrar» nunca rechaza; «exigir» rechaza lo inválido, acepta cualquiera de los secretos y sin secreto no frena', async () => {
    const cuerpo = Buffer.from('{"x":1}');
    const env = (m, s) => ({ RAPPI_WEBHOOK_FIRMA: m, RAPPI_WEBHOOK_SECRET: s });
    assert.strictEqual(evaluarFirmaWebhookRappi({ header: 'basura', rawBody: cuerpo, env: env('registrar', SECRETO) }).rechazar, false);
    assert.strictEqual(evaluarFirmaWebhookRappi({ header: 'basura', rawBody: cuerpo, env: env('', SECRETO) }).rechazar, false, 'sin modo, rechazó');
    assert.strictEqual(evaluarFirmaWebhookRappi({ header: 'basura', rawBody: cuerpo, env: env('exigir', SECRETO) }).rechazar, true);
    const conSegundo = evaluarFirmaWebhookRappi({ header: firmar(SECRETO, cuerpo), rawBody: cuerpo, env: env('exigir', `${OTRO}, ${SECRETO}`) });
    assert.deepStrictEqual([conSegundo.valida, conSegundo.rechazar], [true, false], 'no aceptó la firma del segundo secreto');
    assert.strictEqual(evaluarFirmaWebhookRappi({ header: 'basura', rawBody: cuerpo, env: env('exigir', '') }).rechazar, false,
      'exigir sin secreto dejó al restaurante sin pedidos');
  });

  await t('3. el servidor guarda el cuerpo crudo de /webhook/rappi (sin él ninguna firma valida)', async () => {
    assert.ok(/startsWith\('\/webhook\/rappi'\)\)\) req\.rawBody = buf/.test(SERVER), 'server.js no guarda req.rawBody para /webhook/rappi');
  });

  await t('4. en «exigir», un pedido FALSO no llega a registrarse (401) y uno firmado sí', async () => {
    process.env.RAPPI_WEBHOOK_SECRET = `${OTRO},${SECRETO}`;
    process.env.RAPPI_WEBHOOK_FIRMA = 'exigir';
    const falso = `RF-FALSO-${suf}`;
    const r1 = await enviar(pedidoFalso(falso), firmar('secreto-del-atacante', pedidoFalso(falso)));
    assert.strictEqual(r1.status, 401);
    const r2 = await enviar(pedidoFalso(falso));   // sin firma
    assert.strictEqual(r2.status, 401);
    await new Promise(r => setTimeout(r, 800));
    assert.strictEqual(await pedidosCreados(falso), 0, 'el pedido falso se registró');

    const real = `RF-REAL-${suf}`;
    const cuerpo = pedidoFalso(real);
    const r3 = await enviar(cuerpo, firmar(SECRETO, cuerpo));
    assert.strictEqual(r3.status, 200);
    assert.ok(await esperarPedido(real), 'el pedido con firma válida no se registró');
  });

  await t('5. en «registrar», un aviso sin firma se procesa igual (no se pierde ningún pedido mientras se valida)', async () => {
    process.env.RAPPI_WEBHOOK_FIRMA = 'registrar';
    const id = `RF-REG-${suf}`;
    const r = await enviar(pedidoFalso(id));
    assert.strictEqual(r.status, 200);
    assert.ok(await esperarPedido(id), 'en modo registrar se perdió un pedido');
  });

  await t('6. un 401 de Rappi con el token en caché: token nuevo y UN reintento; si vuelve a fallar, no insiste', async () => {
    llamadas.length = 0;
    rutaProbada = '/menu/approved/';
    const antes = tokensEmitidos;
    respuestasApi = [{ status: 401, body: '{"message":"invalid token"}' }, { status: 200, body: '{"status":"AVAILABLE"}' }];
    const r = await consultarAprobacionMenu(STORE);
    assert.deepStrictEqual(r, { status: 'AVAILABLE' });
    assert.strictEqual(llamadas.length, 2);
    assert.notStrictEqual(llamadas[0].auth, llamadas[1].auth, 'reintentó con el mismo token');
    assert.strictEqual(tokensEmitidos, antes + 1);
    llamadas.length = 0;
    respuestasApi = [{ status: 401, body: '{}' }, { status: 401, body: '{}' }];
    let error = null;
    try { await consultarAprobacionMenu(STORE); } catch (e) { error = e; }
    assert.ok(error && /401/.test(error.message));
    assert.strictEqual(llamadas.length, 2, `insistió ${llamadas.length} veces`);
  });

  await t('7. el secreto nuevo de Rappi no aparece en el log ni en el error', async () => {
    const original = console.log;
    const lineas = [];
    console.log = (...a) => { lineas.push(a.join(' ')); };
    rutaProbada = '/reset-secret';
    try {
      respuestasApi = [{ status: 200, body: JSON.stringify({ event: 'NEW_ORDER', stores: [], secret: 'SECRETO-QUE-NO-DEBE-SALIR' }) }];
      const r = await reiniciarSecretoWebhook('NEW_ORDER');
      assert.strictEqual(r.secret, 'SECRETO-QUE-NO-DEBE-SALIR');
      respuestasApi = [{ status: 500, body: '{"secret":"SECRETO-EN-ERROR"}' }];
      let error = null;
      try { await reiniciarSecretoWebhook('PING'); } catch (e) { error = e; }
      assert.ok(error && !/SECRETO-EN-ERROR/.test(error.message), 'el error copió la respuesta con el secreto');
    } finally { console.log = original; }
    assert.ok(!lineas.some(l => /SECRETO-QUE-NO-DEBE-SALIR|SECRETO-EN-ERROR/.test(l)), 'el secreto salió en el log');
  });

  await t('8. consultar un aviso no devuelve ni loguea su secreto', async () => {
    const original = console.log;
    const lineas = [];
    console.log = (...a) => { lineas.push(a.join(' ')); };
    rutaProbada = '/webhook/NEW_ORDER';
    try {
      respuestasApi = [{ status: 200, body: JSON.stringify({ event: 'NEW_ORDER', stores: [{ store_id: STORE, url: 'https://x' }], secret: 'SECRETO-DE-CONSULTA' }) }];
      const r = await obtenerWebhook('NEW_ORDER');
      assert.strictEqual(r.secret, '***', 'la consulta devolvió el secreto');
      assert.strictEqual(r.stores[0].store_id, STORE);
    } finally { console.log = original; }
    assert.ok(!lineas.some(l => /SECRETO-DE-CONSULTA/.test(l)), 'el secreto de la consulta salió en el log');
  });
} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  if (envOriginal.s === undefined) delete process.env.RAPPI_WEBHOOK_SECRET; else process.env.RAPPI_WEBHOOK_SECRET = envOriginal.s;
  if (envOriginal.m === undefined) delete process.env.RAPPI_WEBHOOK_FIRMA; else process.env.RAPPI_WEBHOOK_FIRMA = envOriginal.m;
  globalThis.fetch = fetchOriginal;
  servidor.close();
  await limpiar();
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-rappi-firma: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
