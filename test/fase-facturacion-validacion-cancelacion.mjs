// Panel de facturación: validación fiscal en el servidor y cancelación de CFDI.
//
// A. emitirFacturaPedido (modal del panel y Mesas) validaba solo que los
//    campos no vinieran vacíos: RFC sin formato, régimen fuera del catálogo o
//    uso incompatible llegaban a Facturapi. Ahora usa el mismo validador que
//    el portal, antes de cualquier llamada al proveedor.
// B. Cancelación de CFDI desde Xabor (cancelacionCfdi.js): motivo del SAT,
//    sustitución para 01/04, solo CFDI del propio negocio, una solicitud viva
//    por CFDI, y los estados reales de la cancelación (inmediata, en espera del
//    receptor o del SAT, rechazada, expirada, resultado desconocido).
// Transporte de Facturapi SIMULADO (globalThis.fetch interceptado).
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida');

const { pool, registrarFacturaEmitida } = await import('../src/services/database.js');
const { guardarCredencialesFacturapi, eliminarCredencialesFacturapi } = await import('../src/services/integracionesService.js');
const { guardarConfiguracionFacturacion, emitirFacturaPedido, reconciliarRecibosFacturacion } = await import('../src/services/facturacionService.js');
const { solicitarCancelacionCfdi, sincronizarCancelacionCfdi, sincronizarCancelacionesPendientes, listarCancelacionesCfdi, registrarRutasCancelacionCfdi } =
  await import('../src/services/cancelacionCfdi.js');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}
async function rechaza(fn, codigo) {
  try { await fn(); } catch (e) { assert.equal(e.codigo, codigo, `esperaba ${codigo}, llegó ${e.codigo || e.message}`); return e; }
  assert.fail(`debía rechazar con ${codigo}`);
}

const llamadas = []; let cola = [];
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://www.facturapi.io/')) return fetchOriginal(url, init);
  llamadas.push({ method: init.method || 'GET', url: u.replace('https://www.facturapi.io/v2', ''), headers: init.headers || {} });
  const h = cola.shift();
  if (!h) throw new Error(`mock Facturapi: sin respuesta encolada para ${init.method || 'GET'} ${u}`);
  if (h.lanzar) { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
  return new Response(JSON.stringify(h.body ?? {}), { status: h.status, headers: { 'Content-Type': 'application/json' } });
};
const desde = () => llamadas.length;
const desdeI = (i) => llamadas.slice(i).map((c) => `${c.method} ${c.url}`);
const FACT = (id, extra = {}) => ({ status: 200, body: { id, status: 'valid', cancellation_status: 'none', ...extra } });

const { rows: negocios } = await pool.query('SELECT id FROM negocios ORDER BY created_at LIMIT 2');
const [NEG, NEG_B] = negocios.map((n) => n.id);
const PREFIJO = 'XAB-AFCAN';
const F = (s) => `${PREFIJO}-${s}`;
const previo = {};
for (const n of [NEG, NEG_B]) previo[n] = (await pool.query(`SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [n])).rows[0]?.estado ?? null;
const limpiar = async () => {
  await pool.query('DELETE FROM facturacion_cancelaciones WHERE negocio_id = ANY($1)', [[NEG, NEG_B]]);
  await pool.query(`DELETE FROM facturacion_servicios WHERE negocio_id = ANY($1) AND referencia LIKE $2`, [[NEG, NEG_B], `${PREFIJO}%`]);
  for (const tabla of ['facturas_pedido', 'facturacion_recibos', 'pedidos_activos']) await pool.query(`DELETE FROM ${tabla} WHERE folio LIKE $1`, [`${PREFIJO}%`]);
  await pool.query(`DELETE FROM clientes_fiscales WHERE negocio_id = ANY($1) AND rfc IN ('PEPJ800101AB1','REC010101AB1')`, [[NEG, NEG_B]]);
};
async function cfdiVenta(negocioId, sufijo, facturaId, uuid) {
  await registrarFacturaEmitida({ negocioId, folio: F(sufijo), facturaId, uuid, total: 100, fuente: 'panel' });
}
async function cfdiServicio(negocioId, sufijo, facturaId, uuid) {
  await pool.query(
    `INSERT INTO facturacion_servicios (negocio_id, referencia, descripcion, clave_sat, total, forma_pago, estado, idempotency_key, factura_id, uuid)
     VALUES ($1,$2,'Servicio de prueba','90101501',500,'03','facturada',$3,$4,$5)`,
    [negocioId, F(sufijo), `xabor:servicio:prueba:${sufijo}`, facturaId, uuid]);
}
const fila = (negocioId, facturaId) => pool.query('SELECT * FROM facturacion_cancelaciones WHERE negocio_id=$1 AND factura_id=$2', [negocioId, facturaId]).then((r) => r.rows[0]);
const UUID = (n) => `AAAAAAAA-BBBB-CCCC-DDDD-${String(n).padStart(12, '0')}`;

await limpiar();
for (const n of [NEG, NEG_B]) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'facturacion','activo') ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [n]);
  await guardarConfiguracionFacturacion(n, { ivaTasa: 0.16, autoemitirRecibo: true });
}
await guardarCredencialesFacturapi(NEG, 'sk_test_mock_cancel_nunca_real', null);
await guardarCredencialesFacturapi(NEG_B, 'sk_test_mock_cancel_nunca_real_b', null);

try {
// ═══ A. Validación fiscal en el servidor ═══
await pool.query(`INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at) VALUES ($1,$2,'entregado',$3::jsonb, NOW())`,
  [NEG, F('VAL'), JSON.stringify({ total: 100, forma_pago: 'efectivo', pago_confirmado: true, modalidad: 'recoger en tienda', timestamp: new Date().toISOString(), cliente: { nombre: 'Cliente', telefono: '5218780000111' } })]);
await pool.query(`INSERT INTO facturacion_recibos (negocio_id, folio, total, idempotency_key, recibo_id, estado) VALUES ($1,$2,100,$3,'rcp_val','abierto')`, [NEG, F('VAL'), `xabor:${NEG}:${F('VAL')}`]);
const BUENOS = { rfc: 'REC010101AB1', nombre_fiscal: 'Receptora de Prueba SA de CV', regimen: '601', uso_cfdi: 'G03', cp: '26000' };
for (const [nombre, cambio, campo] of [
  ['RFC sin formato', { rfc: 'RFC-INVALIDO' }, 'rfc'],
  ['RFC genérico', { rfc: 'XAXX010101000' }, 'rfc'],
  ['régimen fuera del catálogo (609, que el modal ofrecía)', { regimen: '609' }, 'regimen'],
  ['régimen de persona física para una moral', { regimen: '612' }, 'regimen'],
  ['CP de 4 dígitos', { cp: '2600' }, 'cp'],
  ['uso de CFDI inexistente', { uso_cfdi: 'Z99' }, 'uso_cfdi'],
]) {
  await t(`A. ${nombre}: DATOS_FISCALES_INVALIDOS (422) sin llamar a Facturapi`, async () => {
    const i = desde();
    const e = await rechaza(() => emitirFacturaPedido(NEG, F('VAL'), { ...BUENOS, ...cambio }), 'DATOS_FISCALES_INVALIDOS');
    assert.equal(e.status, 422); assert.ok(e.errores?.[campo], JSON.stringify(e.errores));
    assert.deepEqual(desdeI(i), []);
  });
}
await t('A. datos válidos: el RFC llega normalizado y el correo es opcional', async () => {
  const i = desde();
  cola.push({ status: 200, body: { id: 'inv_val', uuid: UUID(1) } });
  const r = await emitirFacturaPedido(NEG, F('VAL'), { ...BUENOS, rfc: ' rec-010101-ab1 ' });
  assert.equal(r.factura_id, 'inv_val');
  const post = llamadas.slice(i).find((c) => c.method === 'POST');
  assert.equal(post.url, '/receipts/rcp_val/invoice');
});

// ═══ B. Cancelación ═══
await cfdiVenta(NEG, 'V1', 'inv_v1', UUID(11));
await cfdiVenta(NEG, 'V2', 'inv_v2', UUID(12));
await cfdiVenta(NEG, 'V3', 'inv_v3', UUID(13));
await cfdiVenta(NEG, 'V4', 'inv_v4', UUID(14));
await cfdiVenta(NEG, 'V5', 'inv_v5', UUID(15));
await cfdiServicio(NEG, 'S1', 'inv_s1', UUID(21));
await cfdiVenta(NEG_B, 'B1', 'inv_b1', UUID(31));

await t('B1. motivo inválido: 400 sin llamar al proveedor', async () => {
  const i = desde();
  await rechaza(() => solicitarCancelacionCfdi(NEG, 'inv_v1', { motivo: '05' }), 'MOTIVO_INVALIDO');
  assert.deepEqual(desdeI(i), []);
});
await t('B2. un CFDI de otro negocio es «no encontrado» (por id y por UUID)', async () => {
  const i = desde();
  await rechaza(() => solicitarCancelacionCfdi(NEG, 'inv_b1', { motivo: '02' }), 'FACTURA_NO_ENCONTRADA');
  await rechaza(() => solicitarCancelacionCfdi(NEG, UUID(31), { motivo: '02' }), 'FACTURA_NO_ENCONTRADA');
  assert.deepEqual(desdeI(i), []);
  assert.equal(await fila(NEG_B, 'inv_b1'), undefined);
});
await t('B3. motivo 01: exige sustitución del mismo negocio y distinta', async () => {
  await rechaza(() => solicitarCancelacionCfdi(NEG, 'inv_v1', { motivo: '01' }), 'SUSTITUCION_REQUERIDA');
  await rechaza(() => solicitarCancelacionCfdi(NEG, 'inv_v1', { motivo: '01', sustitucion: UUID(31) }), 'SUSTITUCION_INVALIDA');
  await rechaza(() => solicitarCancelacionCfdi(NEG, 'inv_v1', { motivo: '01', sustitucion: 'inv_v1' }), 'SUSTITUCION_INVALIDA');
});
await t('B4. motivo 02 aceptado al momento: DELETE con el motivo, estado cancelada, quién la pidió', async () => {
  const i = desde();
  cola.push(FACT('inv_v1', { status: 'canceled', cancellation_status: 'accepted' }));
  const r = await solicitarCancelacionCfdi(NEG, 'inv_v1', { motivo: '02', actor: 'usuario-admin-1' });
  assert.deepEqual(desdeI(i), ['DELETE /invoices/inv_v1?motive=02']);
  assert.match(llamadas.at(-1).headers.Authorization, /sk_test_mock_cancel_nunca_real$/);
  assert.equal(r.estado, 'cancelada'); assert.equal(r.solicitada_por, 'usuario-admin-1');
});
await t('B5. un CFDI ya cancelado no se vuelve a pedir', async () => {
  const i = desde();
  await rechaza(() => solicitarCancelacionCfdi(NEG, 'inv_v1', { motivo: '02' }), 'CFDI_YA_CANCELADO');
  assert.deepEqual(desdeI(i), []);
});
await t('B6. motivo 01 con sustitución válida: la manda como substitution (UUID del reemplazo)', async () => {
  const i = desde();
  cola.push(FACT('inv_v2', { status: 'canceled' }));
  await solicitarCancelacionCfdi(NEG, 'inv_v2', { motivo: '01', sustitucion: 'inv_v3' });
  assert.deepEqual(desdeI(i), [`DELETE /invoices/inv_v2?motive=01&substitution=${UUID(13)}`]);
});
await t('B7. el receptor debe aceptar: en_proceso; otra solicitud está bloqueada; al aceptarse queda cancelada', async () => {
  cola.push(FACT('inv_v3', { cancellation_status: 'pending' }));
  const r = await solicitarCancelacionCfdi(NEG, 'inv_v3', { motivo: '02' });
  assert.equal(r.estado, 'en_proceso'); assert.equal(r.cancellation_status, 'pending');
  await rechaza(() => solicitarCancelacionCfdi(NEG, 'inv_v3', { motivo: '03' }), 'CANCELACION_EN_CURSO');
  cola.push(FACT('inv_v3', { status: 'canceled', cancellation_status: 'accepted' }));
  assert.equal((await sincronizarCancelacionCfdi(NEG, 'inv_v3')).estado, 'cancelada');
});
await t('B8. el receptor la rechaza: rechazada, y se puede volver a pedir', async () => {
  cola.push(FACT('inv_v4', { cancellation_status: 'verifying' }));
  await solicitarCancelacionCfdi(NEG, 'inv_v4', { motivo: '02' });
  cola.push(FACT('inv_v4', { cancellation_status: 'rejected' }));
  assert.equal((await sincronizarCancelacionCfdi(NEG, 'inv_v4')).estado, 'rechazada');
  cola.push(FACT('inv_v4', { status: 'canceled' }));
  assert.equal((await solicitarCancelacionCfdi(NEG, 'inv_v4', { motivo: '03' })).estado, 'cancelada');
});
await t('B9. sin respuesta (timeout): en_proceso; si el proveedor no tiene la solicitud, error reintentable', async () => {
  cola.push({ lanzar: true });
  const r = await solicitarCancelacionCfdi(NEG, 'inv_v5', { motivo: '02' });
  assert.equal(r.estado, 'en_proceso'); assert.equal(r.error_codigo, 'RESULTADO_DESCONOCIDO');
  cola.push(FACT('inv_v5'));
  const s = await sincronizarCancelacionCfdi(NEG, 'inv_v5');
  assert.equal(s.estado, 'error'); assert.equal(s.error_codigo, 'SIN_SOLICITUD_EN_PROVEEDOR');
});
await t('B10. Facturapi rechaza (400): CANCELACION_RECHAZADA, queda en error y se puede reintentar', async () => {
  cola.push({ status: 400, body: { message: 'El CFDI no puede cancelarse sin aceptación' } });
  await rechaza(() => solicitarCancelacionCfdi(NEG, 'inv_v5', { motivo: '02' }), 'CANCELACION_RECHAZADA');
  assert.equal((await fila(NEG, 'inv_v5')).estado, 'error');
  cola.push(FACT('inv_v5', { status: 'canceled' }));
  assert.equal((await solicitarCancelacionCfdi(NEG, 'inv_v5', { motivo: '02' })).estado, 'cancelada');
});
await t('B11. una factura de servicio cancelada queda cancelada también en facturacion_servicios', async () => {
  cola.push(FACT('inv_s1', { status: 'canceled' }));
  const r = await solicitarCancelacionCfdi(NEG, UUID(21), { motivo: '03' });
  assert.equal(r.origen, 'servicio'); assert.equal(r.estado, 'cancelada');
  const { rows: [s] } = await pool.query(`SELECT estado FROM facturacion_servicios WHERE negocio_id=$1 AND factura_id='inv_s1'`, [NEG]);
  assert.equal(s.estado, 'cancelada');
});
await t('B12. la reconciliación verifica las solicitudes en espera de más de 2 minutos', async () => {
  cola.push(FACT('inv_b1', { cancellation_status: 'pending' }));
  await solicitarCancelacionCfdi(NEG_B, 'inv_b1', { motivo: '02' });
  const nada = await sincronizarCancelacionesPendientes();
  assert.equal(nada.pendientes, 0, 'no debe consultar una solicitud recién hecha');
  await pool.query(`UPDATE facturacion_cancelaciones SET updated_at=now()-interval '3 minutes' WHERE negocio_id=$1 AND factura_id='inv_b1'`, [NEG_B]);
  const i = desde();
  cola.push(FACT('inv_b1', { status: 'canceled', cancellation_status: 'accepted' }));
  const r = await reconciliarRecibosFacturacion();
  assert.ok(r.cancelaciones?.revisadas >= 1, JSON.stringify(r.cancelaciones));
  const get = llamadas.slice(i).find((c) => c.url === '/invoices/inv_b1');
  assert.ok(get, desdeI(i).join(' | '));
  assert.match(get.headers.Authorization, /sk_test_mock_cancel_nunca_real_b$/, 'con la llave de SU negocio');
  assert.equal((await fila(NEG_B, 'inv_b1')).estado, 'cancelada');
});
await t('B13. el listado de un negocio no incluye las del otro', async () => {
  const a = await listarCancelacionesCfdi(NEG), b = await listarCancelacionesCfdi(NEG_B);
  assert.ok(a.every((c) => c.factura_id !== 'inv_b1'));
  assert.deepEqual(b.map((c) => c.factura_id), ['inv_b1']);
});
await t('B14. las rutas: solo pasan por los guardias de admin y facturación, y server.js las registra', async () => {
  const visto = [];
  const app = express(); app.use(express.json());
  const requireAdminSeguro = (req, res, next) => { visto.push('admin'); if (req.get('x-rol') !== 'admin') return res.status(403).json({ error: 'solo admin' }); req.negocioId = NEG; req.usuarioId = 'u-1'; next(); };
  const requireModulo = (m) => (req, res, next) => { visto.push(`modulo:${m}`); next(); };
  registrarRutasCancelacionCfdi(app, { requireAdminSeguro, requireModulo, responderError: (res, e) => res.status(e.status || 500).json({ codigo: e.codigo }) });
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const staff = await fetch(`${base}/api/admin/facturacion/facturas/inv_v1/cancelar`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rol': 'staff' }, body: '{"motivo":"02"}' });
    assert.equal(staff.status, 403);
    const ya = await fetch(`${base}/api/admin/facturacion/facturas/inv_v1/cancelar`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rol': 'admin' }, body: '{"motivo":"02"}' });
    assert.equal(ya.status, 409); assert.equal((await ya.json()).codigo, 'CFDI_YA_CANCELADO');
    assert.ok(visto.includes('modulo:facturacion'));
  } finally { s.close(); }
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(server, /registrarRutasCancelacionCfdi\(app, \{ requireAdminSeguro, requireModulo, responderError: responderErrorFacturacion \}\)/);
});
} finally {
  globalThis.fetch = fetchOriginal;
  await limpiar();
  for (const n of [NEG, NEG_B]) {
    await pool.query('DELETE FROM facturacion_configuracion WHERE negocio_id=$1', [n]).catch(() => {});
    await eliminarCredencialesFacturapi(n, null).catch(() => {});
    if (previo[n] === null) await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [n]);
    else await pool.query(`UPDATE negocio_modulos SET estado=$2 WHERE negocio_id=$1 AND modulo='facturacion'`, [n, previo[n]]);
  }
  await pool.end().catch(() => {});
}
console.log(`\nPASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
