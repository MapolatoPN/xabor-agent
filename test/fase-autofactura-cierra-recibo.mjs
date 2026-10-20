// La venta que se factura por el portal de Xabor cierra su recibo de Facturapi.
//
// El portal timbra un CFDI directo (POST /invoices) y el recibo de la venta se
// quedaba abierto: la misma venta podía facturarse otra vez en el portal de
// Facturapi o entrar en una factura global. Esta suite demuestra, con el
// transporte de Facturapi SIMULADO
// (globalThis.fetch interceptado, cero tráfico real):
//   · antes de timbrar se confirma el recibo con el proveedor: si el cliente ya
//     lo facturó allá no se emite otro CFDI; si entró en una global, se detiene;
//     si el proveedor no responde, no se timbra;
//   · después de timbrar se cancela el recibo y queda `facturado` con el CFDI
//     del portal; una sincronización posterior no lo vuelve `cancelado`;
//   · si cancelar falla, la emisión sigue siendo un éxito y el barrido lo
//     retoma (con espera de 30 min entre intentos), con la llave de SU negocio;
//   · una venta ya facturada nunca crea un recibo nuevo, y el panel no la
//     vuelve a facturar.
import assert from 'node:assert/strict';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida');

const { pool } = await import('../src/services/database.js');
const { guardarCredencialesFacturapi, eliminarCredencialesFacturapi } = await import('../src/services/integracionesService.js');
const { guardarConfiguracionFacturacion, sincronizarRecibo, asegurarReciboPedido, emitirFacturaPedido, reconciliarRecibosFacturacion } =
  await import('../src/services/facturacionService.js');
const { crearOObtenerAutofactura } = await import('../src/services/autofacturaService.js');
const { emitirAutofactura } = await import('../src/services/autofacturaEmision.js');
const { emitirAutofacturaPublica } = await import('../src/services/autofacturaRutas.js');
const { cerrarRecibosPendientesTrasAutofactura } = await import('../src/services/reciboTrasAutofactura.js');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}
async function rechaza(fn, codigo) {
  try { await fn(); } catch (e) { assert.equal(e.codigo, codigo, `esperaba ${codigo}, llegó ${e.codigo || e.message}`); return e; }
  assert.fail(`debía rechazar con ${codigo}`);
}

// ═══ Mock del transporte de Facturapi ═══
const llamadas = [];
let cola = [];
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://www.facturapi.io/')) return fetchOriginal(url, init);
  const llamada = { method: init.method || 'GET', url: u, body: init.body ?? null, headers: init.headers || {} };
  llamadas.push(llamada);
  const h = cola.shift();
  if (!h) throw new Error(`mock Facturapi: sin respuesta encolada para ${llamada.method} ${u}`);
  const r = await h(llamada);
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'Content-Type': 'application/json' } });
};
const encolar = (...hs) => { for (const h of hs) cola.push(typeof h === 'function' ? h : () => h); };
const desde = () => llamadas.length;
const resumen = (i) => llamadas.slice(i).map((c) => `${c.method} ${c.url.replace('https://www.facturapi.io/v2', '')}`);
const RECIBO = (id, status, extra = {}) => ({ status: 200, body: {
  id, status, total: 150, key: `clave-${id}`, self_invoice_url: `https://factura.space/prueba/${id}`,
  expires_at: '2026-11-30T00:00:00.000Z', ...extra } });
const FACTURA = (id, uuid) => ({ status: 200, body: { id, uuid, status: 'valid', total: 150 } });
const CAIDO = { status: 500, body: { message: 'caído' } };

// ═══ Datos ═══
const { rows: negocios } = await pool.query('SELECT id FROM negocios ORDER BY created_at LIMIT 2');
if (negocios.length < 2) throw new Error('La base local necesita al menos dos negocios de prueba');
const [NEG, NEG_B] = negocios.map((n) => n.id);
const PREFIJO = 'XAB-AFREC';
const F = (s) => `${PREFIJO}-${s}`;
const DATOS = { rfc: 'REC010101AB1', nombre: 'Receptora de Prueba SA de CV', cp: '26000', regimen: '601', uso_cfdi: 'G03', email: 'facturas@receptora-prueba.test' };
const PANEL = { rfc: 'REC010101AB1', nombre_fiscal: 'Receptora de Prueba SA de CV', cp: '26000', regimen: '601', uso_cfdi: 'G03' };

const filaUnica = async (sql, p) => (await pool.query(sql, p)).rows[0] || null;
const previo = {};
for (const n of [NEG, NEG_B]) {
  previo[n] = {
    activo: (await filaUnica('SELECT activo FROM negocios WHERE id=$1', [n])).activo,
    modulo: (await filaUnica(`SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [n]))?.estado ?? null,
  };
}
async function fijarModulo(negocioId, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'facturacion',$2)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado=$2`, [negocioId, estado]);
}
async function venta(negocioId, sufijo) {
  const folio = F(sufijo);
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at)
     VALUES ($1,$2,'entregado',$3::jsonb, NOW())
     ON CONFLICT (folio) DO UPDATE SET negocio_id=$1, estado='entregado', datos=$3::jsonb, entregado_at=NOW()`,
    [negocioId, folio, JSON.stringify({ total: 150, forma_pago: 'efectivo', pago_confirmado: true, modalidad: 'recoger en tienda',
      timestamp: '2026-10-19T15:00:00.000Z', cliente: { nombre: 'Cliente Recibo', telefono: '5218780000009' } })]);
  return { folio, af: await crearOObtenerAutofactura(negocioId, folio) };
}
async function recibo(negocioId, folio, { reciboId = null, estado = 'abierto', antiguedadMin = 0 } = {}) {
  await pool.query(
    `INSERT INTO facturacion_recibos (negocio_id, folio, total, idempotency_key, recibo_id, estado, clave, url_autofactura, expires_at, updated_at)
     VALUES ($1,$2,150,$3,$4,$5,$6,$7,'2026-11-30T00:00:00Z', NOW() - make_interval(mins => $8))`,
    [negocioId, folio, `xabor:${negocioId}:${folio}`, reciboId, estado, reciboId ? `clave-${reciboId}` : null,
      reciboId ? `https://factura.space/prueba/${reciboId}` : null, antiguedadMin]);
}
const reciboLocal = (negocioId, folio) => filaUnica('SELECT * FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2', [negocioId, folio]);
const autof = (id) => filaUnica('SELECT * FROM autofacturas WHERE id=$1', [id]);
const ledger = (negocioId, folio) => pool.query('SELECT * FROM facturas_pedido WHERE negocio_id=$1 AND folio=$2', [negocioId, folio]).then((r) => r.rows);
const limpiar = async () => {
  for (const tabla of ['facturas_pedido', 'facturacion_recibos', 'autofactura_intentos', 'autofacturas', 'pedidos_activos']) {
    await pool.query(`DELETE FROM ${tabla} WHERE folio LIKE $1`, [`${PREFIJO}%`]);
  }
  await pool.query('DELETE FROM clientes_fiscales WHERE negocio_id = ANY($1) AND rfc=$2', [[NEG, NEG_B], DATOS.rfc]);
};
await limpiar();
await pool.query('UPDATE negocios SET activo=TRUE WHERE id = ANY($1)', [[NEG, NEG_B]]);
await fijarModulo(NEG, 'activo'); await fijarModulo(NEG_B, 'activo');
await guardarCredencialesFacturapi(NEG, 'sk_test_mock_recibo_nunca_real', null);
await guardarCredencialesFacturapi(NEG_B, 'sk_test_mock_recibo_nunca_real_b', null);
await guardarConfiguracionFacturacion(NEG, { ivaTasa: 0.16, autoemitirRecibo: true });
await guardarConfiguracionFacturacion(NEG_B, { ivaTasa: 0.16, autoemitirRecibo: true });

try {

// ═══ 1. Camino feliz: confirmar, timbrar, cancelar ═══
const V1 = await venta(NEG, 'OK');
await recibo(NEG, V1.folio, { reciboId: 'rcp_ok' });
await t('1. con recibo abierto: GET del recibo, POST /invoices y DELETE del recibo, en ese orden', async () => {
  const i = desde();
  encolar(RECIBO('rcp_ok', 'open'), FACTURA('inv_portal_1', 'UUID-PORTAL-1'), RECIBO('rcp_ok', 'canceled'), { status: 200, body: {} });
  const r = await emitirAutofactura({ token: V1.af.token, datosFiscales: DATOS, fuente: 'portal' });
  assert.equal(r.estado, 'facturada');
  const pasos = resumen(i);
  assert.deepEqual(pasos.slice(0, 3), ['GET /receipts/rcp_ok', 'POST /invoices', 'DELETE /receipts/rcp_ok'], pasos.join(' | '));
});
await t('2. el recibo queda facturado con el CFDI del portal y el ledger tiene UNA factura', async () => {
  const rec = await reciboLocal(NEG, V1.folio);
  assert.equal(rec.estado, 'facturado');
  assert.equal(rec.factura_id, 'inv_portal_1');
  assert.equal(rec.uuid, 'UUID-PORTAL-1');
  assert.equal(rec.error_codigo, null);
  const l = await ledger(NEG, V1.folio);
  assert.equal(l.length, 1); assert.equal(l[0].fuente, 'autofactura');
});
await t('3. sincronizar después (el proveedor dice canceled) no lo vuelve cancelado', async () => {
  encolar(RECIBO('rcp_ok', 'canceled'));
  const r = await sincronizarRecibo(NEG, V1.folio);
  assert.equal(r.estado, 'facturado');
  assert.equal(r.factura_id, 'inv_portal_1');
});
await t('4. el panel no la vuelve a facturar: yaEmitida y ninguna llamada al proveedor', async () => {
  const i = desde();
  const r = await emitirFacturaPedido(NEG, V1.folio, PANEL, { fuente: 'panel' });
  assert.equal(r.yaEmitida, true);
  assert.equal(r.factura_id, 'inv_portal_1');
  assert.deepEqual(resumen(i), []);
});

// ═══ 2. Sin recibo: nada nuevo ═══
const V2 = await venta(NEG, 'SINREC');
await t('5. sin recibo en la base: solo el POST /invoices, sin GET ni DELETE de recibos', async () => {
  const i = desde();
  encolar(FACTURA('inv_portal_2', 'UUID-PORTAL-2'), { status: 200, body: {} });
  const r = await emitirAutofactura({ token: V2.af.token, datosFiscales: DATOS, fuente: 'portal' });
  assert.equal(r.estado, 'facturada');
  assert.ok(resumen(i).every((p) => !p.includes('/receipts')), resumen(i).join(' | '));
});
await t('6. y después nadie le crea un recibo: asegurarReciboPedido lo marca facturado sin llamar al proveedor', async () => {
  const i = desde();
  const r = await asegurarReciboPedido(NEG, V2.folio);
  assert.equal(r.estado, 'facturado');
  assert.equal(r.factura_id, 'inv_portal_2');
  assert.deepEqual(resumen(i), []);
});
const V2b = await venta(NEG, 'ERRSINID');
await t('7. un recibo en error que nunca llegó a Facturapi se marca facturado al timbrar (la reconciliación ya no lo crea)', async () => {
  await recibo(NEG, V2b.folio, { reciboId: null, estado: 'error' });
  encolar(FACTURA('inv_portal_2b', 'UUID-PORTAL-2B'), { status: 200, body: {} });
  await emitirAutofactura({ token: V2b.af.token, datosFiscales: DATOS, fuente: 'portal' });
  const rec = await reciboLocal(NEG, V2b.folio);
  assert.equal(rec.estado, 'facturado'); assert.equal(rec.factura_id, 'inv_portal_2b');
});

// ═══ 3. Antes de timbrar manda el proveedor ═══
const V3 = await venta(NEG, 'FACTURAPI');
await recibo(NEG, V3.folio, { reciboId: 'rcp_fp' });
await t('8. el cliente ya lo facturó en el portal de Facturapi: no hay POST /invoices y la liga queda facturada con ESE CFDI', async () => {
  const i = desde();
  encolar(RECIBO('rcp_fp', 'invoiced_to_customer', { invoice: 'inv_facturapi' }), FACTURA('inv_facturapi', 'UUID-FACTURAPI'));
  const r = await emitirAutofactura({ token: V3.af.token, datosFiscales: DATOS, fuente: 'portal' });
  assert.equal(r.estado, 'facturada'); assert.equal(r.yaEmitida, true);
  assert.ok(resumen(i).every((p) => p !== 'POST /invoices'), resumen(i).join(' | '));
  assert.equal((await autof(V3.af.id)).factura_id, 'inv_facturapi');
  assert.equal((await ledger(NEG, V3.folio)).length, 1);
});
const V3b = await venta(NEG, 'PANSINLED');   // folio <= 20 caracteres
await t('8b. el recibo ya está facturado (por el panel) y su ledger no se asentó: VENTA_YA_FACTURADA, sin POST /invoices', async () => {
  await recibo(NEG, V3b.folio, { reciboId: 'rcp_pan', estado: 'facturado' });
  await pool.query(`UPDATE facturacion_recibos SET factura_id='inv_panel_x', uuid='UUID-PANEL-X' WHERE negocio_id=$1 AND folio=$2`, [NEG, V3b.folio]);
  const i = desde();
  encolar(RECIBO('rcp_pan', 'invoiced_to_customer', { invoice: 'inv_panel_x' }));
  await rechaza(() => emitirAutofactura({ token: V3b.af.token, datosFiscales: DATOS, fuente: 'portal' }), 'VENTA_YA_FACTURADA');
  assert.ok(resumen(i).every((p) => p !== 'POST /invoices'), resumen(i).join(' | '));
  assert.equal((await autof(V3b.af.id)).estado, 'vigente');
});
const V4 = await venta(NEG, 'GLOBAL');
await recibo(NEG, V4.folio, { reciboId: 'rcp_gl' });
await t('9. el recibo ya entró en una factura global: VENTA_EN_FACTURA_GLOBAL, sin POST y la liga sigue vigente', async () => {
  const i = desde();
  encolar(RECIBO('rcp_gl', 'invoiced_globally', { invoice: 'inv_global' }));
  await rechaza(() => emitirAutofactura({ token: V4.af.token, datosFiscales: DATOS, fuente: 'portal' }), 'VENTA_EN_FACTURA_GLOBAL');
  assert.ok(resumen(i).every((p) => p !== 'POST /invoices'));
  assert.equal((await autof(V4.af.id)).estado, 'vigente');
  assert.equal((await reciboLocal(NEG, V4.folio)).estado, 'global');
});
await t('10. la ruta pública responde 409 con un mensaje para el cliente', async () => {
  encolar(RECIBO('rcp_gl', 'invoiced_globally', { invoice: 'inv_global' }));
  const r = await emitirAutofacturaPublica(V4.af.token, { rfc: DATOS.rfc, nombre: DATOS.nombre, cp_fiscal: DATOS.cp, regimen_fiscal: DATOS.regimen, uso_cfdi: DATOS.uso_cfdi, email: DATOS.email });
  assert.equal(r.status, 409); assert.equal(r.body.codigo, 'VENTA_EN_FACTURA_GLOBAL');
  assert.match(r.body.error, /factura global/);
});
const V5 = await venta(NEG, 'NOVERIF');
await recibo(NEG, V5.folio, { reciboId: 'rcp_nv' });
await t('11. si el proveedor no responde al confirmar, no se timbra (503 en la ruta pública) y la liga sigue vigente', async () => {
  const i = desde();
  encolar(CAIDO);
  await rechaza(() => emitirAutofactura({ token: V5.af.token, datosFiscales: DATOS, fuente: 'portal' }), 'RECIBO_NO_VERIFICABLE');
  encolar(CAIDO);
  const r = await emitirAutofacturaPublica(V5.af.token, { rfc: DATOS.rfc, nombre: DATOS.nombre, cp_fiscal: DATOS.cp, regimen_fiscal: DATOS.regimen, uso_cfdi: DATOS.uso_cfdi, email: DATOS.email });
  assert.equal(r.status, 503); assert.equal(r.body.codigo, 'RECIBO_NO_VERIFICABLE');
  assert.ok(resumen(i).every((p) => p !== 'POST /invoices'));
  assert.equal((await autof(V5.af.id)).estado, 'vigente');
});

// ═══ 4. Cancelar falla: la emisión sigue, el barrido lo retoma ═══
const V6 = await venta(NEG, 'REINTENTO');
await recibo(NEG, V6.folio, { reciboId: 'rcp_re' });
await t('12. DELETE caído tras timbrar: la venta queda facturada y el recibo abierto con CIERRE_PENDIENTE', async () => {
  encolar(RECIBO('rcp_re', 'open'), FACTURA('inv_portal_6', 'UUID-PORTAL-6'), CAIDO, RECIBO('rcp_re', 'open'), { status: 200, body: {} });
  const r = await emitirAutofactura({ token: V6.af.token, datosFiscales: DATOS, fuente: 'portal' });
  assert.equal(r.estado, 'facturada');
  assert.equal((await ledger(NEG, V6.folio)).length, 1);
  const rec = await reciboLocal(NEG, V6.folio);
  assert.equal(rec.estado, 'abierto'); assert.equal(rec.error_codigo, 'CIERRE_PENDIENTE');
});
await t('13. el barrido espera 30 minutos antes de reintentar un cierre fallido', async () => {
  const i = desde();
  const r = await cerrarRecibosPendientesTrasAutofactura();
  assert.ok(resumen(i).every((p) => !p.includes('rcp_re')), resumen(i).join(' | '));
  assert.equal((await reciboLocal(NEG, V6.folio)).estado, 'abierto');
  assert.ok(r.revisados >= 0);
});
await t('14. pasados los 30 minutos, el barrido cancela el recibo y lo deja facturado con el CFDI del portal', async () => {
  await pool.query(`UPDATE facturacion_recibos SET updated_at=NOW()-INTERVAL '31 minutes' WHERE negocio_id=$1 AND folio=$2`, [NEG, V6.folio]);
  const i = desde();
  encolar(RECIBO('rcp_re', 'canceled'));
  const r = await cerrarRecibosPendientesTrasAutofactura();
  assert.deepEqual(resumen(i), ['DELETE /receipts/rcp_re']);
  assert.equal(r.cerrados, 1);
  const rec = await reciboLocal(NEG, V6.folio);
  assert.equal(rec.estado, 'facturado'); assert.equal(rec.factura_id, 'inv_portal_6'); assert.equal(rec.error_codigo, null);
});

// ═══ 5. Doble CFDI que ya ocurrió: se deja asentado ═══
const V7 = await venta(NEG, 'DOBLE');
await recibo(NEG, V7.folio, { reciboId: 'rcp_db' });
await t('15. si el recibo se facturó en Facturapi entre la confirmación y el cierre: DOBLE_CFDI asentado, la emisión no falla', async () => {
  encolar(RECIBO('rcp_db', 'open'), FACTURA('inv_portal_7', 'UUID-PORTAL-7'),
    { status: 400, body: { message: 'El recibo ya fue facturado' } }, RECIBO('rcp_db', 'invoiced_to_customer', { invoice: 'inv_otro' }), { status: 200, body: {} });
  const r = await emitirAutofactura({ token: V7.af.token, datosFiscales: DATOS, fuente: 'portal' });
  assert.equal(r.estado, 'facturada');
  const rec = await reciboLocal(NEG, V7.folio);
  assert.equal(rec.estado, 'facturado'); assert.equal(rec.factura_id, 'inv_otro'); assert.equal(rec.error_codigo, 'DOBLE_CFDI');
});

// ═══ 6. Ventas facturadas antes de este cambio: el barrido de la reconciliación ═══
const V8 = await venta(NEG_B, 'HISTORICO');
await t('16. una venta facturada por el portal antes de este cambio, con su recibo abierto, se cierra en la reconciliación con la llave de SU negocio', async () => {
  encolar(FACTURA('inv_portal_8', 'UUID-PORTAL-8'), { status: 200, body: {} });
  await emitirAutofactura({ token: V8.af.token, datosFiscales: DATOS, fuente: 'portal' });   // sin recibo todavía
  await pool.query(`DELETE FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2`, [NEG_B, V8.folio]);
  await recibo(NEG_B, V8.folio, { reciboId: 'rcp_hist' });                                   // y luego apareció su recibo
  const i = desde();
  encolar(RECIBO('rcp_hist', 'canceled'));
  const r = await reconciliarRecibosFacturacion();
  const borrados = llamadas.slice(i).filter((c) => c.method === 'DELETE');
  assert.equal(borrados.length, 1, resumen(i).join(' | '));
  assert.ok(borrados[0].url.endsWith('/receipts/rcp_hist'));
  assert.match(borrados[0].headers.Authorization, /^Bearer sk_test_mock_recibo_nunca_real_b$/);
  assert.ok(r.cierres && r.cierres.cerrados >= 1, JSON.stringify(r.cierres));
  const rec = await reciboLocal(NEG_B, V8.folio);
  assert.equal(rec.estado, 'facturado'); assert.equal(rec.factura_id, 'inv_portal_8');
});
await t('17. el barrido no toca espejos: una liga marcada facturada por otro camino no cancela el recibo', async () => {
  const V9 = await venta(NEG, 'ESPEJO');
  await recibo(NEG, V9.folio, { reciboId: 'rcp_esp' });
  await pool.query(`UPDATE autofacturas SET estado='facturada', factura_id='inv_panel', uuid='UUID-PANEL', intento_key=NULL WHERE id=$1`, [V9.af.id]);
  const i = desde();
  await cerrarRecibosPendientesTrasAutofactura();
  assert.ok(resumen(i).every((p) => !p.includes('rcp_esp')), resumen(i).join(' | '));
});

} finally {
  globalThis.fetch = fetchOriginal;
  await limpiar();
  await pool.query('DELETE FROM facturacion_configuracion WHERE negocio_id = ANY($1)', [[NEG, NEG_B]]).catch(() => {});
  await eliminarCredencialesFacturapi(NEG, null).catch(() => {});
  await eliminarCredencialesFacturapi(NEG_B, null).catch(() => {});
  for (const n of [NEG, NEG_B]) {
    const p = previo[n];
    await pool.query('UPDATE negocios SET activo=$2 WHERE id=$1', [n, p.activo]);
    if (p.modulo === null) await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [n]);
    else await fijarModulo(n, p.modulo);
  }
  await pool.end().catch(() => {});
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
