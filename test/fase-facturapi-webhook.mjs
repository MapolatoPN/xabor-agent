// Avisos de Facturapi sobre recibos (src/services/facturapiWebhook.js) y su
// registro (scripts/ops/facturapi-webhook-2026-10/webhook.mjs).
//
// Facturapi suspendió la cuenta por consultar recibo por recibo. Con el aviso,
// Facturapi le dice a Xabor qué recibo cambió. Esta suite fija:
//   A. identidad: token de la URL, firma sobre los bytes crudos, organización
//      y ambiente; un negocio nunca toca recibos de otro;
//   B. un evento se aplica una vez y un recibo solo avanza (reglas de
//      facturado, cancelado, global, doble CFDI, total distinto, base caída);
//   C. el barrido: sin consultas uno por uno con el aviso activo, respaldo
//      diario por lista que retoma la página, UUID de la factura avisada;
//   D. la ruta montada antes del lector JSON global y la migración en el predeploy;
//   E. el script de registro contra un Facturapi simulado.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida');
process.env.FACTURAPI_BARRIDO_MAX_LLAMADAS = '20';
process.env.FACTURAPI_BARRIDO_ESPACIO_MS = '0';
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

const express = (await import('express')).default;
const { pool } = await import('../src/services/database.js');
const { guardarCredencialesFacturapi } = await import('../src/services/integracionesService.js');
const { cifrarSecretoIntegracion, descifrarSecretoIntegracion } = await import('../src/services/cifradoIntegraciones.js');
const { reconciliarRecibosFacturacion } = await import('../src/services/facturacionService.js');
const wh = await import('../src/services/facturapiWebhook.js');
const ritmo = await import('../src/services/facturapiRitmo.js');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  ritmo._reiniciarRitmoFacturapi();
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}

// ── Facturapi falso para el proceso (fetch) ─────────────────────────────────
const llamadas = [];
let listaRemota = [];           // recibos que devuelve GET /receipts?…
let respuestaFactura = () => ({ status: 200, body: null });
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://www.facturapi.io/')) return fetchOriginal(url, init);
  const ruta = u.replace('https://www.facturapi.io/v2', '');
  const metodo = init.method || 'GET';
  llamadas.push({ ruta: `${metodo} ${ruta}`, en: Date.now() });
  const json = (status, body) => new Response(JSON.stringify(body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
  if (metodo === 'GET' && ruta.startsWith('/receipts?')) {
    const q = new URL(u).searchParams;
    const pagina = Number(q.get('page') || 1), limite = Number(q.get('limit') || 100);
    return json(200, { page: pagina, total_pages: Math.max(1, Math.ceil(listaRemota.length / limite)),
      data: listaRemota.slice((pagina - 1) * limite, pagina * limite) });
  }
  if (metodo === 'GET' && ruta.startsWith('/invoices/')) {
    const id = ruta.split('/invoices/')[1];
    const r = respuestaFactura(id);
    return json(r.status, r.body ?? { id, uuid: `UUID-${id}` });
  }
  if (ruta.startsWith('/receipts/')) {
    const id = ruta.split('/receipts/')[1].split(/[/?]/)[0];
    return json(200, { id, status: 'open', total: 150 });
  }
  return json(404, { message: 'no simulado' });
};
const desde = (n) => llamadas.slice(n);

// ── Negocios, credenciales y recibos de prueba ─────────────────────────────
const { rows: negs } = await pool.query('SELECT id, slug FROM negocios WHERE slug IS NOT NULL ORDER BY created_at LIMIT 2');
const NEG = negs[0].id, NEG_SLUG = negs[0].slug, NEG_B = negs[1].id;
const PREFIJO = 'XAB-WH';
const { rows: previas } = await pool.query(
  `SELECT id, estado, activo FROM integraciones_canal WHERE canal='facturacion' AND proveedor='facturapi'`);
const { rows: [previaNeg] } = await pool.query(
  `SELECT id FROM integraciones_canal WHERE canal='facturacion' AND proveedor='facturapi' AND negocio_id=$1`, [NEG]);
const { rows: [cfgPrevia] } = await pool.query('SELECT iva_tasa, autoemitir_recibo FROM facturacion_configuracion WHERE negocio_id=$1', [NEG]);

const SECRETO_A = `whsec_${randomBytes(12).toString('hex')}`, SECRETO_B = `whsec_${randomBytes(12).toString('hex')}`;
const TOKEN_A = randomBytes(24).toString('hex'), TOKEN_B = randomBytes(24).toString('hex');
async function ponerWebhook(negocioId, token, secreto, organizacion, { estado = 'activo', livemode = true } = {}) {
  const s = cifrarSecretoIntegracion(secreto);
  await pool.query(
    `INSERT INTO facturapi_webhooks (negocio_id, routing_token, estado, webhook_id, organizacion_id, livemode,
       secreto_cifrado, secreto_iv, secreto_auth_tag, secreto_formato_version)
     VALUES ($1,$2,$3,'wh_prueba',$4,$5,$6,$7,$8,$9)
     ON CONFLICT (negocio_id) DO UPDATE SET routing_token=$2, estado=$3, webhook_id='wh_prueba', organizacion_id=$4,
       livemode=$5, secreto_cifrado=$6, secreto_iv=$7, secreto_auth_tag=$8, secreto_formato_version=$9,
       respaldo_desde=NULL, respaldo_pagina=NULL, respaldo_completado_at=NULL`,
    [negocioId, token, estado, organizacion, livemode, s.cifrado, s.iv, s.authTag, s.version]);
}
const estadoWebhook = (negocioId, estado) => pool.query('UPDATE facturapi_webhooks SET estado=$2 WHERE negocio_id=$1', [negocioId, estado]);

const limpiarRecibos = async () => {
  await pool.query(`DELETE FROM facturacion_recibos WHERE folio LIKE $1`, [`${PREFIJO}%`]);
  await pool.query(`DELETE FROM facturas_pedido WHERE folio LIKE $1`, [`${PREFIJO}%`]);
  await pool.query(`DELETE FROM facturapi_webhook_eventos WHERE negocio_id = ANY($1)`, [[NEG, NEG_B]]);
};
async function recibo(sufijo, { negocio = NEG, estado = 'abierto', total = 150, facturaId = null, creado = 2, revisado = 30 } = {}) {
  const folio = `${PREFIJO}-${sufijo}`;
  await pool.query(
    `INSERT INTO facturacion_recibos (negocio_id, folio, recibo_id, estado, total, idempotency_key, factura_id, expires_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + INTERVAL '5 days', NOW() - $8 * INTERVAL '1 hour', NOW() - $9 * INTERVAL '1 hour')`,
    [negocio, folio, `rec_${sufijo}`, estado, total, `${negocio}:${folio}`, facturaId, creado, revisado]);
  return folio;
}
const fila = async (folio) => (await pool.query(
  `SELECT estado, factura_id, uuid, error_codigo, error_detalle FROM facturacion_recibos WHERE folio=$1`, [folio])).rows[0];

// ── La ruta real, montada como en server.js: antes del express.json global ──
const app = express();
wh.registrarWebhookFacturapi(app);
app.use(express.json());
app.use((req, res) => res.status(200).send('<html>panel</html>'));
const servidor = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const URL_BASE = `http://127.0.0.1:${servidor.address().port}`;

let nEvento = 0;
function evento(sufijo, status, { invoice = null, total = 150, organization = 'org_A', livemode = true, type = 'receipt.status_updated', id } = {}) {
  return { id: id || `evt_${Date.now()}_${++nEvento}`, created_at: new Date().toISOString(), livemode, organization, type,
    data: { type: 'receipt', object: { id: `rec_${sufijo}`, status, total, invoice, key: 'k', self_invoice_url: 'https://factura.space/x' } } };
}
async function aviso(token, ev, { secreto = SECRETO_A, cuerpo, firma } = {}) {
  const crudo = cuerpo ?? JSON.stringify(ev);
  const headers = { 'Content-Type': 'application/json' };
  const f = firma === undefined ? createHmac('sha256', secreto).update(crudo).digest('hex') : firma;
  if (f !== null) headers['Facturapi-Signature'] = f;
  const r = await fetchOriginal(`${URL_BASE}/webhook/facturapi/${token}`, { method: 'POST', headers, body: crudo });
  return r.status;
}
const eventosDe = async (id) => (await pool.query(`SELECT resultado FROM facturapi_webhook_eventos WHERE evento_id=$1`, [id])).rows;

// ── Facturapi falso por HTTP, para el script (corre en otro proceso) ────────
const API_KEY = `sk_test_wh_${randomBytes(8).toString('hex')}`;
const remotos = []; const llamadasScript = [];
const fapi = createServer((req, res) => {
  let datos = '';
  req.on('data', (d) => { datos += d; });
  req.on('end', () => {
    const ruta = req.url.replace(/^\/v2/, '');
    llamadasScript.push({ ruta: `${req.method} ${ruta}`, auth: req.headers.authorization, body: datos });
    const responder = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${API_KEY}`) return responder(401, { message: 'llave' });
    if (req.method === 'GET' && ruta.startsWith('/webhooks?')) return responder(200, { page: 1, total_pages: 1, data: remotos });
    if (req.method === 'POST' && ruta === '/webhooks') {
      const b = JSON.parse(datos || '{}');
      const w = { id: `wh_${randomBytes(6).toString('hex')}`, url: b.url, enabled_events: b.enabled_events, status: 'enabled',
        livemode: false, organization: 'org_script', secret: `whsec_script_${randomBytes(10).toString('hex')}` };
      remotos.push(w);
      return responder(201, w);
    }
    const id = decodeURIComponent(ruta.split('/webhooks/')[1] || '');
    const w = remotos.find((x) => x.id === id);
    if (req.method === 'GET' && w) return responder(200, w);
    if (req.method === 'DELETE' && w) { remotos.splice(remotos.indexOf(w), 1); return responder(200, w); }
    return responder(404, { message: 'no existe' });
  });
});
await new Promise((r) => fapi.listen(0, '127.0.0.1', r));
const FAPI_BASE = `http://127.0.0.1:${fapi.address().port}/v2`;
const RESPALDOS = mkdtempSync(join(tmpdir(), 'xabor-wh-'));
// Asíncrono: el Facturapi simulado vive en este proceso y tiene que poder contestar.
function script(args, { base = FAPI_BASE } = {}) {
  const env = { ...process.env, NODE_OPTIONS: '' };
  if (base) env.FACTURAPI_BASE_URL = base; else delete env.FACTURAPI_BASE_URL;
  return new Promise((resolver) => {
    execFile(process.execPath, ['scripts/ops/facturapi-webhook-2026-10/webhook.mjs', ...args, `--respaldo=${RESPALDOS}`],
      { cwd: RAIZ, env, encoding: 'utf8', timeout: 60000 },
      (error, stdout, stderr) => resolver({ codigo: error ? (error.code ?? 1) : 0, salida: `${stdout || ''}${stderr || ''}` }));
  });
}

try {
  await limpiarRecibos();
  await pool.query(`DELETE FROM facturapi_webhooks WHERE negocio_id = ANY($1)`, [[NEG, NEG_B]]);
  await pool.query(`UPDATE integraciones_canal SET estado='suspendido', activo=false
                     WHERE canal='facturacion' AND proveedor='facturapi' AND negocio_id<>$1`, [NEG]);
  await pool.query(`INSERT INTO facturacion_configuracion (negocio_id, iva_tasa, autoemitir_recibo) VALUES ($1, 0.16, false)
                    ON CONFLICT (negocio_id) DO UPDATE SET autoemitir_recibo=false, iva_tasa=COALESCE(facturacion_configuracion.iva_tasa, 0.16)`, [NEG]);
  await guardarCredencialesFacturapi(NEG, API_KEY, null);
  await ponerWebhook(NEG, TOKEN_A, SECRETO_A, 'org_A');
  await ponerWebhook(NEG_B, TOKEN_B, SECRETO_B, 'org_B');

  // ── A. Identidad y firma ───────────────────────────────────────────────
  await t('A1. un aviso firmado pasa el recibo a facturado con su factura y deja el UUID pendiente', async () => {
    const folio = await recibo('A1');
    const ev = evento('A1', 'invoiced_to_customer', { invoice: 'inv_A1' });
    assert.equal(await aviso(TOKEN_A, ev), 200);
    const f = await fila(folio);
    assert.equal(f.estado, 'facturado');
    assert.equal(f.factura_id, 'inv_A1');
    assert.equal(f.error_codigo, 'UUID_PENDIENTE');
    assert.deepEqual(await eventosDe(ev.id), [{ resultado: 'aplicado' }]);
  });

  await t('A2. firma de otro secreto o sin encabezado: 401 y el recibo no cambia', async () => {
    const folio = await recibo('A2');
    assert.equal(await aviso(TOKEN_A, evento('A2', 'invoiced_to_customer', { invoice: 'inv_x' }), { secreto: 'otro' }), 401);
    assert.equal(await aviso(TOKEN_A, evento('A2', 'invoiced_to_customer', { invoice: 'inv_x' }), { firma: null }), 401);
    assert.equal(await aviso(TOKEN_A, evento('A2', 'invoiced_to_customer', { invoice: 'inv_x' }), { firma: 'zz' }), 401);
    assert.equal((await fila(folio)).estado, 'abierto');
  });

  await t('A3. la firma se verifica sobre los bytes tal como llegaron, no sobre el JSON re-serializado', async () => {
    const folio = await recibo('A3');
    const ev = evento('A3', 'canceled');
    const crudo = `{ "type":"receipt.status_updated" ,\n  "id": "${ev.id}", "organization":"org_A","livemode":true, "data":${JSON.stringify(ev.data)} }`;
    assert.notEqual(crudo, JSON.stringify(JSON.parse(crudo)));
    assert.equal(await aviso(TOKEN_A, null, { cuerpo: crudo }), 200);
    assert.equal((await fila(folio)).estado, 'cancelado');
    // Firmado sobre la re-serialización, con los bytes originales: se rechaza.
    const folio2 = await recibo('A3B');
    const ev2 = evento('A3B', 'canceled');
    const crudo2 = `{"id":"${ev2.id}",  "type":"receipt.status_updated","organization":"org_A","livemode":true,"data":${JSON.stringify(ev2.data)}}`;
    const firmaReserializada = createHmac('sha256', SECRETO_A).update(JSON.stringify(JSON.parse(crudo2))).digest('hex');
    assert.equal(await aviso(TOKEN_A, null, { cuerpo: crudo2, firma: firmaReserializada }), 401);
    assert.equal((await fila(folio2)).estado, 'abierto');
  });

  await t('A4. token desconocido: 404; el token de otro negocio no toca recibos de este', async () => {
    const folio = await recibo('A4');
    assert.equal(await aviso(randomBytes(24).toString('hex'), evento('A4', 'canceled')), 404);
    assert.equal(await aviso('no-es-token', evento('A4', 'canceled')), 404);
    // Firmado con el secreto de A pero por la URL de B: la firma no cuadra.
    assert.equal(await aviso(TOKEN_B, evento('A4', 'canceled', { organization: 'org_B' })), 401);
    // Bien firmado por B, apuntando al recibo de A: B no lo encuentra.
    const ev = evento('A4', 'canceled', { organization: 'org_B' });
    assert.equal(await aviso(TOKEN_B, ev, { secreto: SECRETO_B }), 200);
    assert.deepEqual(await eventosDe(ev.id), [{ resultado: 'recibo_ajeno' }]);
    assert.equal((await fila(folio)).estado, 'abierto');
  });

  await t('A5. otra organización u otro ambiente: se acusa y no se aplica', async () => {
    const folio = await recibo('A5');
    assert.equal(await aviso(TOKEN_A, evento('A5', 'canceled', { organization: 'org_otra' })), 200);
    assert.equal(await aviso(TOKEN_A, evento('A5', 'canceled', { livemode: false })), 200);
    assert.equal((await fila(folio)).estado, 'abierto');
  });

  await t('A6. webhook en pausa: se acusa sin aplicar; retirado: 404', async () => {
    const folio = await recibo('A6');
    await estadoWebhook(NEG, 'pausado');
    try {
      assert.equal(await aviso(TOKEN_A, evento('A6', 'canceled')), 200);
      assert.equal((await fila(folio)).estado, 'abierto');
      await estadoWebhook(NEG, 'retirado');
      assert.equal(await aviso(TOKEN_A, evento('A6', 'canceled')), 404);
      assert.equal((await fila(folio)).estado, 'abierto');
    } finally { await estadoWebhook(NEG, 'activo'); }
  });

  // ── B. Idempotencia y reglas ───────────────────────────────────────────
  await t('B1. el mismo evento dos veces se aplica una sola vez', async () => {
    const folio = await recibo('B1');
    const ev = evento('B1', 'invoiced_globally');
    assert.equal(await aviso(TOKEN_A, ev), 200);
    await pool.query(`UPDATE facturacion_recibos SET estado='abierto' WHERE folio=$1`, [folio]);
    assert.equal(await aviso(TOKEN_A, ev), 200);
    assert.equal((await fila(folio)).estado, 'abierto', 'el reenvío del mismo evento volvió a aplicarse');
    assert.equal((await eventosDe(ev.id)).length, 1);
  });

  await t('B2. un recibo cerrado nunca vuelve a abierto (aviso viejo o reenviado)', async () => {
    const folio = await recibo('B2', { estado: 'global' });
    const ev = evento('B2', 'open');
    assert.equal(await aviso(TOKEN_A, ev), 200);
    assert.equal((await fila(folio)).estado, 'global');
    assert.deepEqual(await eventosDe(ev.id), [{ resultado: 'regresion_ignorada' }]);
  });

  await t('B3. cancelado tras facturar por el portal de Xabor: sigue facturado', async () => {
    const folio = await recibo('B3', { estado: 'facturado', facturaId: 'inv_portal_B3' });
    assert.equal(await aviso(TOKEN_A, evento('B3', 'canceled')), 200);
    const f = await fila(folio);
    assert.equal(f.estado, 'facturado');
    assert.equal(f.factura_id, 'inv_portal_B3');
  });

  await t('B4. cancelado antes de que Xabor asiente su autofactura: queda facturado con el CFDI del portal', async () => {
    const folio = await recibo('B4');
    await pool.query(`INSERT INTO facturas_pedido (negocio_id, folio, factura_id, uuid, total, fuente) VALUES ($1,$2,'inv_portal_B4','UUID-B4',150,'autofactura')`, [NEG, folio]);
    assert.equal(await aviso(TOKEN_A, evento('B4', 'canceled')), 200);
    const f = await fila(folio);
    assert.equal(f.estado, 'facturado');
    assert.equal(f.factura_id, 'inv_portal_B4');
    assert.equal(f.uuid, 'UUID-B4');
  });

  await t('B5. facturado en Facturapi cuando la venta ya tenía otro CFDI: se anota doble CFDI', async () => {
    const folio = await recibo('B5');
    await pool.query(`INSERT INTO facturas_pedido (negocio_id, folio, factura_id, uuid, total, fuente) VALUES ($1,$2,'inv_portal_B5','UUID-B5',150,'autofactura')`, [NEG, folio]);
    const ev = evento('B5', 'invoiced_to_customer', { invoice: 'inv_cliente_B5' });
    assert.equal(await aviso(TOKEN_A, ev), 200);
    const f = await fila(folio);
    assert.equal(f.error_codigo, 'DOBLE_CFDI');
    assert.deepEqual(await eventosDe(ev.id), [{ resultado: 'doble_cfdi' }]);
    // Ya cerrado con otra factura: también se anota, una sola vez.
    const folio2 = await recibo('B5B', { estado: 'facturado', facturaId: 'inv_portal_B5B' });
    const ev2 = evento('B5B', 'invoiced_to_customer', { invoice: 'inv_cliente_B5B' });
    assert.equal(await aviso(TOKEN_A, ev2), 200);
    assert.equal((await fila(folio2)).error_codigo, 'DOBLE_CFDI');
    const ev3 = evento('B5B', 'invoiced_to_customer', { invoice: 'inv_cliente_B5B' });
    assert.equal(await aviso(TOKEN_A, ev3), 200);
    assert.deepEqual(await eventosDe(ev3.id), [{ resultado: 'sin_cambio' }]);
  });

  await t('B6. un total distinto al de la venta no cambia el recibo', async () => {
    const folio = await recibo('B6');
    const ev = evento('B6', 'invoiced_to_customer', { invoice: 'inv_B6', total: 999 });
    assert.equal(await aviso(TOKEN_A, ev), 200);
    assert.equal((await fila(folio)).estado, 'abierto');
    assert.deepEqual(await eventosDe(ev.id), [{ resultado: 'total_divergente' }]);
  });

  await t('B7. recibo que Xabor no creó, o evento de otro tipo: se acusa y se ignora', async () => {
    const ev = evento('NO_EXISTE', 'canceled');
    assert.equal(await aviso(TOKEN_A, ev), 200);
    assert.deepEqual(await eventosDe(ev.id), [{ resultado: 'recibo_ajeno' }]);
    const ev2 = { ...evento('B7', 'canceled'), type: 'invoice.status_updated', data: { type: 'invoice', object: { id: 'inv_1' } } };
    assert.equal(await aviso(TOKEN_A, ev2), 200);
    assert.deepEqual(await eventosDe(ev2.id), [{ resultado: 'tipo_ignorado' }]);
  });

  await t('B8. si la base falla al aplicar: 500 y el evento no queda registrado, así un reintento sí aplica', async () => {
    const folio = await recibo('B8');
    const ev = evento('B8', 'invoiced_globally');
    const connectOriginal = pool.connect.bind(pool);
    // pool.query usa connect con callback: ese camino queda intacto.
    pool.connect = (cb) => (typeof cb === 'function' ? connectOriginal(cb) : connectOriginal().then((c) => {
      const q = c.query.bind(c);
      c.query = (sql, ...rest) => (typeof sql === 'string' && /UPDATE facturacion_recibos SET estado='global'/.test(sql)
        ? Promise.reject(new Error('base caída (prueba)')) : q(sql, ...rest));
      const release = c.release.bind(c);
      c.release = (...a) => { c.query = q; return release(...a); };
      return c;
    }));
    try { assert.equal(await aviso(TOKEN_A, ev), 500); } finally { pool.connect = connectOriginal; }
    assert.equal((await eventosDe(ev.id)).length, 0, 'quedó registrado un evento que no se aplicó');
    assert.equal((await fila(folio)).estado, 'abierto');
    assert.equal(await aviso(TOKEN_A, ev), 200);
    assert.equal((await fila(folio)).estado, 'global');
  });

  // ── C. Barrido ─────────────────────────────────────────────────────────
  await t('C1. con el aviso activo el barrido no consulta abiertos uno por uno; en pausa vuelve a hacerlo', async () => {
    await limpiarRecibos();
    await recibo('C1A'); await recibo('C1B');
    listaRemota = [];
    let n = llamadas.length;
    await reconciliarRecibosFacturacion(200);
    const sueltas = desde(n).filter((l) => /^GET \/receipts\/rec_/.test(l.ruta));
    assert.equal(sueltas.length, 0, `consultó ${sueltas.map((l) => l.ruta).join(', ')}`);
    await estadoWebhook(NEG, 'pausado');
    try {
      n = llamadas.length;
      await reconciliarRecibosFacturacion(200);
      const ahora = desde(n).filter((l) => /^GET \/receipts\/rec_C1/.test(l.ruta));
      assert.equal(ahora.length, 2, 'en pausa debía consultar los dos abiertos');
    } finally { await estadoWebhook(NEG, 'activo'); }
  });

  await t('C2. respaldo diario: aplica lo que el aviso no trajo y no repite el mismo día', async () => {
    await limpiarRecibos();
    await pool.query(`UPDATE facturapi_webhooks SET respaldo_desde=NULL, respaldo_pagina=NULL, respaldo_completado_at=NULL WHERE negocio_id=$1`, [NEG]);
    const folio = await recibo('C2');
    listaRemota = [{ id: 'rec_C2', status: 'invoiced_globally', total: 150 }, { id: 'rec_ajeno', status: 'open', total: 10 }];
    let n = llamadas.length;
    const r = await ritmo.enBarridoFacturapi(() => wh.respaldoRecibosPorLista(), { llamadas: 5, espacioMs: 0 });
    const listas = desde(n).filter((l) => l.ruta.startsWith('GET /receipts?'));
    assert.equal(listas.length, 1);
    assert.match(listas[0].ruta, /date%5Bgte%5D=/);
    const desdeFecha = new Date(decodeURIComponent(listas[0].ruta.match(/date%5Bgte%5D=([^&]+)/)[1]));
    const dias = (Date.now() - desdeFecha) / 864e5;
    assert.ok(dias > 8.9 && dias < 9.1, `ventana de ${dias.toFixed(2)} días`);
    assert.equal((await fila(folio)).estado, 'global');
    assert.equal(r.corregidos, 1);
    n = llamadas.length;
    await ritmo.enBarridoFacturapi(() => wh.respaldoRecibosPorLista(), { llamadas: 5, espacioMs: 0 });
    assert.equal(desde(n).length, 0, 'repitió el respaldo el mismo día');
    await pool.query(`UPDATE facturapi_webhooks SET respaldo_completado_at = NOW() - INTERVAL '1 day' WHERE negocio_id=$1`, [NEG]);
    n = llamadas.length;
    await ritmo.enBarridoFacturapi(() => wh.respaldoRecibosPorLista(), { llamadas: 5, espacioMs: 0 });
    assert.equal(desde(n).length, 1, 'al día siguiente debía volver a listar');
  });

  await t('C3. si se acaba el presupuesto, la siguiente vuelta sigue en la página donde iba', async () => {
    await pool.query(`UPDATE facturapi_webhooks SET respaldo_desde=NULL, respaldo_pagina=NULL, respaldo_completado_at=NULL WHERE negocio_id=$1`, [NEG]);
    listaRemota = Array.from({ length: 250 }, (_, i) => ({ id: `rec_lista_${i}`, status: 'open', total: 1 }));
    let n = llamadas.length;
    await ritmo.enBarridoFacturapi(() => wh.respaldoRecibosPorLista(), { llamadas: 2, espacioMs: 0 });
    const primera = desde(n).map((l) => new URL(`http://x${l.ruta.slice(4)}`).searchParams.get('page'));
    n = llamadas.length;
    await ritmo.enBarridoFacturapi(() => wh.respaldoRecibosPorLista(), { llamadas: 2, espacioMs: 0 });
    const segunda = desde(n).map((l) => new URL(`http://x${l.ruta.slice(4)}`).searchParams.get('page'));
    assert.deepEqual(primera, ['1', '2']);
    assert.deepEqual(segunda, ['3']);
    const { rows: [w] } = await pool.query(`SELECT respaldo_pagina, respaldo_completado_at FROM facturapi_webhooks WHERE negocio_id=$1`, [NEG]);
    assert.equal(w.respaldo_pagina, null);
    assert.ok(w.respaldo_completado_at, 'no quedó completo');
    listaRemota = [];
  });

  await t('C4. con Facturapi en pausa, o con la integración suspendida (freno), el respaldo no llama ni insiste', async () => {
    await pool.query(`UPDATE facturapi_webhooks SET respaldo_completado_at=NULL, respaldo_pagina=NULL WHERE negocio_id = ANY($1)`, [[NEG, NEG_B]]);
    ritmo.registrarRespuestaFacturapi(NEG, 401, { codigo: 'user_suspended' });
    const n = llamadas.length;
    const r = await ritmo.enBarridoFacturapi(() => wh.respaldoRecibosPorLista(), { llamadas: 5, espacioMs: 0 });
    assert.equal(desde(n).length, 0);
    // NEG_B tiene aviso activo pero su integración está suspendida: ni lo intenta.
    assert.equal(r.negocios, 1, `tomó ${r.negocios} negocios`);
  });

  await t('C5. el barrido trae el UUID de la factura avisada una sola vez y la asienta en el ledger', async () => {
    await limpiarRecibos();
    const folio = await recibo('C5');
    assert.equal(await aviso(TOKEN_A, evento('C5', 'invoiced_to_customer', { invoice: 'inv_C5' })), 200);
    let n = llamadas.length;
    await ritmo.enBarridoFacturapi(() => wh.completarUuidsPendientes(), { llamadas: 5, espacioMs: 0 });
    assert.deepEqual(desde(n).map((l) => l.ruta), ['GET /invoices/inv_C5']);
    const f = await fila(folio);
    assert.equal(f.uuid, 'UUID-inv_C5');
    assert.equal(f.error_codigo, null);
    const { rows: ledger } = await pool.query(`SELECT factura_id, uuid, fuente FROM facturas_pedido WHERE folio=$1`, [folio]);
    assert.deepEqual(ledger, [{ factura_id: 'inv_C5', uuid: 'UUID-inv_C5', fuente: 'autofactura' }]);
    n = llamadas.length;
    await ritmo.enBarridoFacturapi(() => wh.completarUuidsPendientes(), { llamadas: 5, espacioMs: 0 });
    assert.equal(desde(n).length, 0);
  });

  await t('C6. si la factura no responde, el UUID se reintenta a los 30 minutos, no antes', async () => {
    const folio = await recibo('C6');
    assert.equal(await aviso(TOKEN_A, evento('C6', 'invoiced_to_customer', { invoice: 'inv_C6' })), 200);
    respuestaFactura = () => ({ status: 500, body: { message: 'caído' } });
    try {
      let n = llamadas.length;
      await ritmo.enBarridoFacturapi(() => wh.completarUuidsPendientes(), { llamadas: 5, espacioMs: 0 });
      assert.equal(desde(n).length, 1);
      n = llamadas.length;
      await ritmo.enBarridoFacturapi(() => wh.completarUuidsPendientes(), { llamadas: 5, espacioMs: 0 });
      assert.equal(desde(n).length, 0, 'reintentó de inmediato');
      assert.equal((await fila(folio)).error_codigo, 'UUID_PENDIENTE');
    } finally { respuestaFactura = () => ({ status: 200, body: null }); }
  });

  // ── D. Montaje ─────────────────────────────────────────────────────────
  await t('D1. server.js monta la ruta antes del express.json global', async () => {
    const src = readFileSync(join(RAIZ, 'src/server.js'), 'utf8');
    const montaje = src.indexOf('registrarWebhookFacturapi(app)');
    const json = src.indexOf('app.use(express.json(');
    assert.ok(montaje > 0, 'no se monta');
    assert.ok(json > 0 && montaje < json, 'se monta después del lector JSON: la firma no vería los bytes crudos');
  });

  await t('D2. con el lector JSON antes de la ruta, ningún aviso pasa la firma', async () => {
    const otra = express();
    otra.use(express.json());
    wh.registrarWebhookFacturapi(otra);
    const s = await new Promise((r) => { const x = otra.listen(0, '127.0.0.1', () => r(x)); });
    try {
      const ev = evento('D2', 'canceled');
      const crudo = JSON.stringify(ev);
      const r = await fetchOriginal(`http://127.0.0.1:${s.address().port}/webhook/facturapi/${TOKEN_A}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Facturapi-Signature': createHmac('sha256', SECRETO_A).update(crudo).digest('hex') }, body: crudo });
      assert.equal(r.status, 401);
    } finally { s.close(); }
  });

  await t('D3. el predeploy aplica la migración 121', async () => {
    const runner = readFileSync(join(RAIZ, 'scripts/predeploy-run-032-033.mjs'), 'utf8');
    assert.match(runner, /'121-facturapi-webhooks'/);
  });

  // ── E. Script de registro ──────────────────────────────────────────────
  await pool.query(`DELETE FROM facturapi_webhooks WHERE negocio_id=$1`, [NEG]);

  await t('E1. registrar sin --aplicar no escribe ni en la base ni en Facturapi', async () => {
    const n = llamadasScript.length;
    const r = await script(['registrar', `--negocio=${NEG_SLUG}`]);
    assert.equal(r.codigo, 0, r.salida);
    assert.match(r.salida, /SIMULACRO/);
    assert.equal(llamadasScript.slice(n).length, 0);
    assert.equal((await pool.query(`SELECT 1 FROM facturapi_webhooks WHERE negocio_id=$1`, [NEG])).rows.length, 0);
  });

  let registrado = null;
  await t('E2. registrar --aplicar crea el webhook y guarda su secreto cifrado, sin imprimir secretos', async () => {
    const n = llamadasScript.length;
    const r = await script(['registrar', `--negocio=${NEG_SLUG}`, '--url-base=https://xabor.mx', '--aplicar']);
    assert.equal(r.codigo, 0, r.salida);
    const posts = llamadasScript.slice(n).filter((l) => l.ruta === 'POST /webhooks');
    assert.equal(posts.length, 1);
    const cuerpo = JSON.parse(posts[0].body);
    assert.deepEqual(cuerpo.enabled_events, ['receipt.status_updated']);
    assert.match(cuerpo.url, /^https:\/\/xabor\.mx\/webhook\/facturapi\/[a-f0-9]{48}$/);
    const { rows: [w] } = await pool.query(`SELECT * FROM facturapi_webhooks WHERE negocio_id=$1`, [NEG]);
    registrado = { ...w, remoto: remotos.at(-1) };
    assert.equal(w.estado, 'activo');
    assert.equal(cuerpo.url.endsWith(`/${w.routing_token}`), true);
    assert.equal(w.organizacion_id, 'org_script');
    assert.equal(w.livemode, false);
    assert.equal(descifrarSecretoIntegracion({ cifrado: w.secreto_cifrado, iv: w.secreto_iv, authTag: w.secreto_auth_tag, version: w.secreto_formato_version }), registrado.remoto.secret);
    assert.ok(!r.salida.includes(registrado.remoto.secret), 'imprimió el secreto');
    assert.ok(!r.salida.includes(w.routing_token), 'imprimió el token completo');
    assert.ok(!r.salida.includes(API_KEY), 'imprimió la llave');
  });

  await t('E3. un aviso firmado con el secreto registrado, a la URL registrada, se aplica', async () => {
    assert.ok(registrado, 'E2 no registró');
    await limpiarRecibos();
    const folio = await recibo('E3');
    const ev = evento('E3', 'invoiced_globally', { organization: 'org_script', livemode: false });
    assert.equal(await aviso(registrado.routing_token, ev, { secreto: registrado.remoto.secret }), 200);
    assert.equal((await fila(folio)).estado, 'global');
  });

  await t('E4. registrar otra vez se niega', async () => {
    const n = llamadasScript.length;
    const r = await script(['registrar', `--negocio=${NEG_SLUG}`, '--aplicar']);
    assert.notEqual(r.codigo, 0);
    assert.equal(llamadasScript.slice(n).filter((l) => l.ruta === 'POST /webhooks').length, 0);
  });

  await t('E5. pausar y reanudar cambian solo la base; estado no imprime token ni secreto', async () => {
    const n = llamadasScript.length;
    assert.equal((await script(['pausar', `--negocio=${NEG_SLUG}`, '--aplicar'])).codigo, 0);
    assert.equal((await pool.query(`SELECT estado FROM facturapi_webhooks WHERE negocio_id=$1`, [NEG])).rows[0].estado, 'pausado');
    assert.equal((await script(['reanudar', `--negocio=${NEG_SLUG}`, '--aplicar'])).codigo, 0);
    assert.equal((await pool.query(`SELECT estado FROM facturapi_webhooks WHERE negocio_id=$1`, [NEG])).rows[0].estado, 'activo');
    assert.equal(llamadasScript.slice(n).length, 0);
    const e = await script(['estado', '--remoto']);
    assert.equal(e.codigo, 0, e.salida);
    assert.match(e.salida, /ES EL DE XABOR/);
    assert.ok(!e.salida.includes(registrado.routing_token) && !e.salida.includes(registrado.remoto.secret), 'estado imprimió token o secreto');
  });

  await t('E6. retirar borra el webhook en Facturapi y la ruta deja de aceptar avisos', async () => {
    const r = await script(['retirar', `--negocio=${NEG_SLUG}`, '--aplicar']);
    assert.equal(r.codigo, 0, r.salida);
    assert.equal(remotos.length, 0, 'el webhook sigue en Facturapi');
    const { rows: [w] } = await pool.query(`SELECT estado, secreto_cifrado FROM facturapi_webhooks WHERE negocio_id=$1`, [NEG]);
    assert.equal(w.estado, 'retirado');
    assert.equal(w.secreto_cifrado, null);
    assert.equal(await aviso(registrado.routing_token, evento('E3', 'canceled', { organization: 'org_script', livemode: false }), { secreto: registrado.remoto.secret }), 404);
  });

  await t('E7. un registro cortado a medias se repite adoptando el webhook que ya existe', async () => {
    const token = randomBytes(24).toString('hex');
    await pool.query(`UPDATE facturapi_webhooks SET estado='registrando', routing_token=$2 WHERE negocio_id=$1`, [NEG, token]);
    remotos.push({ id: 'wh_cortado', url: `https://xabor.mx/webhook/facturapi/${token}`, enabled_events: ['receipt.status_updated'],
      status: 'enabled', livemode: false, organization: 'org_script', secret: 'whsec_cortado' });
    const n = llamadasScript.length;
    const r = await script(['registrar', `--negocio=${NEG_SLUG}`, '--url-base=https://xabor.mx', '--aplicar']);
    assert.equal(r.codigo, 0, r.salida);
    assert.equal(llamadasScript.slice(n).filter((l) => l.ruta === 'POST /webhooks').length, 0, 'creó un segundo webhook');
    const { rows: [w] } = await pool.query(`SELECT estado, webhook_id, routing_token FROM facturapi_webhooks WHERE negocio_id=$1`, [NEG]);
    assert.deepEqual([w.estado, w.webhook_id, w.routing_token], ['activo', 'wh_cortado', token]);
  });

  await t('E8. con base local y sin Facturapi simulado el script no sale a la red', async () => {
    const r = await script(['registrar', `--negocio=${NEG_SLUG}`, '--aplicar'], { base: null });
    assert.notEqual(r.codigo, 0);
    assert.match(r.salida, /FACTURAPI_BASE_URL/);
  });
} finally {
  globalThis.fetch = fetchOriginal;
  servidor.close(); fapi.close();
  await limpiarRecibos().catch(() => {});
  await pool.query(`DELETE FROM facturapi_webhooks WHERE negocio_id = ANY($1)`, [[NEG, NEG_B]]).catch(() => {});
  for (const p of previas) {
    await pool.query(`UPDATE integraciones_canal SET estado=$2, activo=$3 WHERE id=$1`, [p.id, p.estado, p.activo]).catch(() => {});
  }
  if (!previaNeg) {
    await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN
      (SELECT id FROM integraciones_canal WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi')`, [NEG]).catch(() => {});
    await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi'`, [NEG]).catch(() => {});
  }
  if (cfgPrevia) await pool.query('UPDATE facturacion_configuracion SET iva_tasa=$2, autoemitir_recibo=$3 WHERE negocio_id=$1', [NEG, cfgPrevia.iva_tasa, cfgPrevia.autoemitir_recibo]).catch(() => {});
  else await pool.query('DELETE FROM facturacion_configuracion WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.end().catch(() => {});
}
console.log(`\nPASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
