// Autofactura nativa de Xabor — fase 4A: motor de emisión del CFDI con el
// transporte de Facturapi SIMULADO (globalThis.fetch interceptado). Cero
// tráfico real: cualquier llamada a facturapi.io sin respuesta encolada
// revienta la prueba.
//
// Lo que demuestra: el payload de POST /invoices sale de la venta REAL y de los
// datos validados; el snapshot cifrado y la idempotency_key existen ANTES de
// la red; 200 cierra (facturada + ledger + ficha), 202 queda pendiente y se
// reconcilia sin POST nuevo; timeout/401/429/5xx dejan un intento reanudable
// con el MISMO payload y la MISMA clave; 400 cierra el intento sin CFDI; y
// diez emisiones simultáneas producen a lo sumo UN POST.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida');

const { pool, registrarFacturaEmitida } = await import('../src/services/database.js');
const { guardarCredencialesFacturapi, eliminarCredencialesFacturapi } = await import('../src/services/integracionesService.js');
const { guardarConfiguracionFacturacion } = await import('../src/services/facturacionService.js');
const { crearOObtenerAutofactura, revocarAutofactura } = await import('../src/services/autofacturaService.js');
const { construirConceptoVenta } = await import('../src/services/facturapi.js');
const { descifrarSecretoIntegracion } = await import('../src/services/cifradoIntegraciones.js');
const { emitirAutofactura, reanudarEmisionAutofactura, reconciliarAutofacturaPendiente, formaPagoDeVenta } =
  await import('../src/services/autofacturaEmision.js');

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
  const llamada = { method: init.method || 'GET', url: u, body: init.body ?? null, headers: init.headers || {}, en: Date.now() };
  llamadas.push(llamada);
  const h = cola.shift();
  if (!h) throw new Error(`mock Facturapi: sin respuesta encolada para ${llamada.method} ${u}`);
  const r = await h(llamada);
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'Content-Type': 'application/json' } });
};
const encolar = (h) => { cola.push(typeof h === 'function' ? h : () => h); };
const posts = () => llamadas.filter((c) => c.method === 'POST' && /\/v2\/invoices$/.test(c.url));
const gets = () => llamadas.filter((c) => c.method === 'GET');
const VALIDA = (id = 'inv_ok', uuid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE') => ({ status: 200, body: { id, uuid, status: 'valid', total: 150 } });
const timeout = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };

// ═══ Datos ═══
const { rows: negocios } = await pool.query('SELECT id FROM negocios ORDER BY created_at LIMIT 2');
if (negocios.length < 2) throw new Error('La base local necesita al menos dos negocios de prueba');
const [NEG, NEG_B] = negocios.map((n) => n.id);
const PREFIJO = 'XAB-AFEMI';
const F = (s) => `${PREFIJO}-${s}`;
const MORAL = { rfc: 'EMI010101AB1', nombre: 'Emisora de Prueba SA de CV', cp: '26000', regimen: '601', uso_cfdi: 'G03', email: 'Facturas@Emisora-Prueba.TEST' };
const TEL = '5218780000004';

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
async function sembrarPedido(negocioId, folio, { total = 150, formaPago = 'efectivo', modalidad = 'recoger en tienda' } = {}) {
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at)
     VALUES ($1,$2,'entregado',$3::jsonb, NOW())
     ON CONFLICT (folio) DO UPDATE SET negocio_id=$1, estado='entregado', datos=$3::jsonb, entregado_at=NOW()`,
    [negocioId, folio, JSON.stringify({
      total, forma_pago: formaPago, pago_confirmado: true, modalidad, timestamp: '2026-09-22T15:00:00.000Z',
      cliente: { nombre: 'Cliente Emisión', telefono: TEL },
    })]);
}
async function liga(negocioId, sufijo, opts) { await sembrarPedido(negocioId, F(sufijo), opts); return crearOObtenerAutofactura(negocioId, F(sufijo)); }
const af = (id) => filaUnica('SELECT * FROM autofacturas WHERE id=$1', [id]);
const ledger = (negocioId, folio) => pool.query('SELECT * FROM facturas_pedido WHERE negocio_id=$1 AND folio=$2', [negocioId, folio]).then((r) => r.rows);
async function enClaro(id, valor) {
  const { rows: [r] } = await pool.query(`SELECT count(*)::int AS n FROM autofacturas WHERE id=$1 AND autofacturas::text ILIKE '%' || $2 || '%'`, [id, valor]);
  return r.n;
}
const SENSIBLES = ['EMI010101AB1', 'Emisora de Prueba', 'emisora-prueba.test'];
function sinSecretos(obj, extra = []) {
  const s = JSON.stringify(obj);
  for (const v of ['snapshot', 'cifrado', 'auth_tag', 'token_hash', 'sk_test', 'sk_live', ...extra]) assert.ok(!s.includes(v), `el resultado contiene "${v}"`);
}
const limpiar = async () => {
  await pool.query('DELETE FROM facturas_pedido WHERE folio LIKE $1', [`${PREFIJO}%`]);
  await pool.query('DELETE FROM autofacturas WHERE folio LIKE $1', [`${PREFIJO}%`]);
  await pool.query('DELETE FROM pedidos_activos WHERE folio LIKE $1', [`${PREFIJO}%`]);
  await pool.query('DELETE FROM clientes_fiscales WHERE negocio_id = ANY($1) AND rfc=$2', [[NEG, NEG_B], MORAL.rfc]);
};
await limpiar();
await pool.query('UPDATE negocios SET activo=TRUE WHERE id = ANY($1)', [[NEG, NEG_B]]);
await fijarModulo(NEG, 'activo'); await fijarModulo(NEG_B, 'activo');
await guardarCredencialesFacturapi(NEG, 'sk_test_mock_emision_nunca_real', null);
await guardarCredencialesFacturapi(NEG_B, 'sk_test_mock_emision_nunca_real_b', null);
await guardarConfiguracionFacturacion(NEG, { ivaTasa: 0.16, autoemitirRecibo: true, serie: 'A' });
await guardarConfiguracionFacturacion(NEG_B, { ivaTasa: 0.16, autoemitirRecibo: true });

const errores = []; // resultados/errores de negocio para la prueba 39
try {

// ═══ Emisión exitosa (200) ═══
const A = await liga(NEG, 'OK');
let payloadA, resultadoA, snapshotDuranteElPost;
await t('1-10. el POST /invoices lleva el customer, address.zip, régimen, uso, correo normalizado, PUE, forma de pago real, concepto fiscal y total congelado', async () => {
  encolar(async (ll) => {
    snapshotDuranteElPost = await af(A.id); // qué había en la base EN el momento del POST
    return VALIDA('inv_ok_A');
  });
  resultadoA = await emitirAutofactura({ token: A.token, datosFiscales: MORAL, fuente: 'portal' });
  assert.equal(posts().length, 1, 'exactamente un POST');
  payloadA = JSON.parse(posts()[0].body);
  assert.deepEqual(payloadA.customer, {
    legal_name: 'Emisora de Prueba SA de CV', tax_id: 'EMI010101AB1', tax_system: '601', address: { zip: '26000' }, email: 'facturas@emisora-prueba.test',
  });
  assert.equal(payloadA.use, 'G03');
  assert.equal(payloadA.payment_method, 'PUE');
  assert.equal(payloadA.payment_form, '01', 'efectivo -> 01, derivado de la venta real');
  assert.equal(payloadA.currency, 'MXN');
  assert.equal(payloadA.series, 'A', 'la serie configurada del negocio');
  const esperado = construirConceptoVenta({ folio: F('OK'), total: 150, modalidad: 'recoger en tienda' }, { ivaTasa: 0.16 });
  assert.deepEqual(payloadA.items, [esperado], 'los items salen del constructor fiscal existente');
  assert.equal(payloadA.items[0].product.price, 150, 'el total enviado es el congelado');
  assert.match(posts()[0].headers.Authorization, /^Bearer sk_test_mock_emision_nunca_real$/);
});

await t('11. el snapshot y la idempotency_key existen en la base ANTES del POST', async () => {
  assert.equal(snapshotDuranteElPost.estado, 'emitiendo');
  assert.ok(snapshotDuranteElPost.snapshot_cifrado && snapshotDuranteElPost.snapshot_iv && snapshotDuranteElPost.snapshot_auth_tag);
  assert.equal(snapshotDuranteElPost.intento_key, payloadA.idempotency_key);
  assert.ok(snapshotDuranteElPost.intento_iniciado_at);
});

await t('12-13. el snapshot está cifrado, coincide con el POST y RFC/nombre/correo no quedan en claro', async () => {
  const fila = await af(A.id);
  const json = descifrarSecretoIntegracion({ cifrado: fila.snapshot_cifrado, iv: fila.snapshot_iv, authTag: fila.snapshot_auth_tag, version: fila.snapshot_formato_version });
  assert.equal(json, posts()[0].body, 'el snapshot es byte a byte lo que se mandó');
  assert.equal(fila.snapshot_sha256, createHash('sha256').update(json).digest('hex'));
  assert.notEqual(fila.snapshot_cifrado, json);
  for (const v of SENSIBLES) assert.equal(await enClaro(A.id, v), 0, `"${v}" aparece en claro en autofacturas`);
});

await t('14-15. intento_key y external_id son estables y no llevan datos fiscales', async () => {
  const fila = await af(A.id);
  assert.equal(payloadA.idempotency_key, `xabor:af:${A.id}:1`);
  assert.equal(fila.intento_key, `xabor:af:${A.id}:1`);
  assert.equal(fila.intento_numero, 1);
  assert.equal(payloadA.external_id, `xabor:${NEG}:${F('OK')}`);
  for (const v of SENSIBLES) assert.ok(!payloadA.idempotency_key.includes(v) && !payloadA.external_id.includes(v));
});

await t('16-19. 200 -> facturada con factura_id, uuid, emitida_at, fuente y ledger', async () => {
  assert.equal(resultadoA.estado, 'facturada');
  assert.equal(resultadoA.factura_id, 'inv_ok_A');
  assert.equal(resultadoA.uuid, 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE');
  const fila = await af(A.id);
  assert.equal(fila.estado, 'facturada'); assert.equal(fila.factura_id, 'inv_ok_A'); assert.equal(fila.uuid, resultadoA.uuid);
  assert.ok(fila.emitida_at); assert.equal(fila.proveedor_status, 'valid'); assert.equal(Number(fila.total), 150);
  const fp = await ledger(NEG, F('OK'));
  assert.equal(fp.length, 1); assert.equal(fp[0].factura_id, 'inv_ok_A'); assert.equal(fp[0].uuid, resultadoA.uuid); assert.equal(Number(fp[0].total), 150);
});

await t('20. la ficha del cliente fiscal se guarda solo después del éxito', async () => {
  const ficha = await filaUnica('SELECT * FROM clientes_fiscales WHERE negocio_id=$1 AND rfc=$2', [NEG, MORAL.rfc]);
  assert.ok(ficha, 'no se guardó la ficha');
  assert.equal(ficha.regimen, '601'); assert.equal(ficha.uso_cfdi, 'G03'); assert.equal(ficha.email, 'facturas@emisora-prueba.test');
  assert.equal(ficha.telefono, TEL);
});

await t('38. la fuente queda registrada (portal -> autofactura en el ledger)', async () => {
  assert.equal((await af(A.id)).fuente_emision, 'portal');
  assert.equal((await ledger(NEG, F('OK')))[0].fuente, 'autofactura');
});

await t('21. volver a emitir una autofactura facturada -> 0 POST nuevos', async () => {
  const antes = posts().length;
  const r = await emitirAutofactura({ token: A.token, datosFiscales: MORAL });
  assert.equal(r.estado, 'facturada'); assert.equal(r.yaEmitida, true); assert.equal(r.factura_id, 'inv_ok_A');
  assert.equal(posts().length, antes);
  errores.push(r);
});

await t('22. factura previa en facturas_pedido (otra vía) -> 0 POST y la liga queda facturada', async () => {
  const L = await liga(NEG, 'LEDGER');
  await registrarFacturaEmitida({ negocioId: NEG, folio: F('LEDGER'), facturaId: 'inv_panel_previa', uuid: '11111111-2222-3333-4444-555555555555', total: 150, fuente: 'panel' });
  const antes = posts().length;
  const r = await emitirAutofactura({ token: L.token, datosFiscales: MORAL });
  assert.equal(posts().length, antes);
  assert.equal(r.estado, 'facturada'); assert.equal(r.yaEmitida, true); assert.equal(r.factura_id, 'inv_panel_previa');
  const fila = await af(L.id);
  assert.equal(fila.estado, 'facturada'); assert.equal(fila.factura_id, 'inv_panel_previa'); assert.equal(fila.fuente_emision, 'panel');
  assert.equal((await ledger(NEG, F('LEDGER'))).length, 1, 'no se agregó un segundo renglón al ledger');
});

// ═══ Forma de pago ═══
await t('7b. la forma de pago SAT se deriva de la venta (terminal, transferencia, enlace)', async () => {
  assert.equal(formaPagoDeVenta({ forma_pago: 'terminal' }), '28');
  assert.equal(formaPagoDeVenta({ forma_pago: 'transferencia' }), '03');
  assert.equal(formaPagoDeVenta({ forma_pago: 'enlace_pago' }), '04');
  assert.equal(formaPagoDeVenta({ forma_pago: 'enlace de pago' }), '04');
  assert.equal(formaPagoDeVenta({ forma_pago: 'efectivo (billete $500)' }), '01');
});

await t('8. forma de pago no determinable (mixto, tarjeta sin tipo, vacía) se rechaza ANTES de la red y la liga sigue vigente', async () => {
  for (const [sufijo, formaPago] of [['MIXTO', 'mixto'], ['TARJETA', 'tarjeta'], ['SINFORMA', ''], ['RARA', 'pago_en_sucursal']]) {
    const L = await liga(NEG, sufijo, { formaPago });
    const antes = posts().length;
    const e = await rechaza(() => emitirAutofactura({ token: L.token, datosFiscales: MORAL }), 'FORMA_PAGO_NO_DETERMINADA');
    errores.push(e);
    assert.equal(posts().length, antes);
    const fila = await af(L.id);
    assert.equal(fila.estado, 'vigente'); assert.equal(fila.snapshot_cifrado, null); assert.equal(fila.intento_key, null);
  }
});

// ═══ 202 / pendiente ═══
const P = await liga(NEG, 'PEND', { formaPago: 'terminal' });
await t('23-24. 202 pending -> procesando, estado emitiendo, factura_id guardado, sin UUID', async () => {
  encolar({ status: 202, body: { id: 'inv_pend_P', status: 'pending' } });
  const r = await emitirAutofactura({ token: P.token, datosFiscales: MORAL });
  assert.equal(r.estado, 'procesando'); assert.equal(r.factura_id, 'inv_pend_P');
  const fila = await af(P.id);
  assert.equal(fila.estado, 'emitiendo'); assert.equal(fila.factura_id, 'inv_pend_P'); assert.equal(fila.proveedor_status, 'pending');
  assert.equal(fila.uuid, null); assert.equal(fila.intento_key, `xabor:af:${P.id}:1`);
  assert.equal((await ledger(NEG, F('PEND'))).length, 0);
  errores.push(r);
});

await t('25. reconciliar pending -> pending: sigue procesando, sin POST ni cambios destructivos', async () => {
  const antesP = posts().length; const antesG = gets().length;
  encolar({ status: 200, body: { id: 'inv_pend_P', status: 'pending' } });
  const r = await reconciliarAutofacturaPendiente(P.id);
  assert.equal(r.estado, 'procesando');
  assert.equal(posts().length, antesP); assert.equal(gets().length, antesG + 1);
  assert.match(gets().at(-1).url, /\/v2\/invoices\/inv_pend_P$/);
  const fila = await af(P.id);
  assert.equal(fila.estado, 'emitiendo'); assert.equal(fila.intento_key, `xabor:af:${P.id}:1`);
});

await t('26. reconciliar pending -> valid: facturada sin POST nuevo, con ledger y ficha', async () => {
  const antesP = posts().length;
  encolar({ status: 200, body: { id: 'inv_pend_P', status: 'valid', uuid: 'PPPPPPPP-0000-0000-0000-000000000001' } });
  const r = await reconciliarAutofacturaPendiente(P.id);
  assert.equal(r.estado, 'facturada'); assert.equal(r.uuid, 'PPPPPPPP-0000-0000-0000-000000000001');
  assert.equal(posts().length, antesP);
  const fila = await af(P.id);
  assert.equal(fila.estado, 'facturada'); assert.equal(fila.proveedor_status, 'valid'); assert.ok(fila.intento_cerrado_at);
  assert.equal((await ledger(NEG, F('PEND'))).length, 1);
  // Volver a emitir o reconciliar ya no hace nada hacia afuera.
  const r2 = await emitirAutofactura({ token: P.token, datosFiscales: MORAL });
  assert.equal(r2.yaEmitida, true);
  assert.equal((await reconciliarAutofacturaPendiente(P.id)).yaEmitida, true);
  assert.equal(posts().length, antesP);
});

await t('26b. reconciliar pending -> failed: error controlado sin crear otro documento', async () => {
  const X = await liga(NEG, 'PENDFAIL');
  encolar({ status: 202, body: { id: 'inv_pend_X', status: 'pending' } });
  await emitirAutofactura({ token: X.token, datosFiscales: MORAL });
  const antesP = posts().length;
  encolar({ status: 200, body: { id: 'inv_pend_X', status: 'failed' } });
  const r = await reconciliarAutofacturaPendiente(X.id);
  assert.equal(r.estado, 'error'); assert.equal(r.codigo, 'FACTURAPI_ESTADO_FAILED');
  assert.equal(posts().length, antesP);
  const fila = await af(X.id);
  assert.equal(fila.estado, 'error'); assert.equal((await ledger(NEG, F('PENDFAIL'))).length, 0);
  errores.push(r);
});

// ═══ Timeout / resultado desconocido ═══
const T = await liga(NEG, 'TIMEOUT');
await t('27. timeout: la liga se queda en emitiendo y conserva snapshot e intento_key', async () => {
  encolar(timeout);
  const r = await emitirAutofactura({ token: T.token, datosFiscales: MORAL });
  assert.equal(r.estado, 'emitiendo'); assert.equal(r.codigo, 'FACTURAPI_TIMEOUT'); assert.equal(r.reintentable, true);
  const fila = await af(T.id);
  assert.equal(fila.estado, 'emitiendo'); assert.ok(fila.snapshot_cifrado); assert.equal(fila.intento_key, `xabor:af:${T.id}:1`);
  assert.equal(fila.error_codigo, 'FACTURAPI_TIMEOUT');
  // Con el intento en curso no arranca uno nuevo ni con datos distintos.
  const antes = posts().length;
  const r2 = await emitirAutofactura({ token: T.token, datosFiscales: { ...MORAL, nombre: 'Otro Nombre Que No Debe Sustituir' } });
  assert.equal(r2.estado, 'procesando'); assert.equal(r2.codigo, 'EMISION_EN_CURSO');
  assert.equal(posts().length, antes);
  errores.push(r, r2);
});

await t('28. reanudar tras timeout reenvía el MISMO payload byte a byte con la MISMA idempotency_key', async () => {
  encolar(VALIDA('inv_ok_T', 'TTTTTTTT-0000-0000-0000-000000000001'));
  const antes = posts().length;
  const r = await reanudarEmisionAutofactura(T.id);
  assert.equal(r.estado, 'facturada'); assert.equal(r.factura_id, 'inv_ok_T');
  assert.equal(posts().length, antes + 1);
  const primero = posts()[antes - 1]; const segundo = posts()[antes];
  assert.equal(segundo.body, primero.body, 'el reenvío no es byte-equivalente');
  assert.equal(JSON.parse(segundo.body).idempotency_key, `xabor:af:${T.id}:1`);
  const fila = await af(T.id);
  assert.equal(fila.intento_numero, 1); assert.equal(fila.intento_key, `xabor:af:${T.id}:1`); assert.equal(fila.estado, 'facturada');
  assert.equal((await ledger(NEG, F('TIMEOUT'))).length, 1);
});

// ═══ 400 ═══
await t('29. 400 por datos fiscales: intento cerrado como error, sin ledger, sin datos sensibles guardados', async () => {
  const R = await liga(NEG, 'RECHAZO');
  encolar({ status: 400, body: { message: 'El RFC EMI010101AB1 no es válido para Emisora de Prueba', code: 'invalid_customer' } });
  const r = await emitirAutofactura({ token: R.token, datosFiscales: MORAL });
  assert.equal(r.estado, 'error'); assert.equal(r.codigo, 'DATOS_FISCALES_RECHAZADOS'); assert.equal(r.reintentable, false);
  const fila = await af(R.id);
  assert.equal(fila.estado, 'error'); assert.equal(fila.proveedor_status, 'rejected'); assert.ok(fila.intento_cerrado_at);
  assert.equal(fila.error_codigo, 'FACTURAPI_400_INVALID_CUSTOMER');
  for (const v of SENSIBLES) assert.equal(await enClaro(R.id, v), 0, `"${v}" quedó en claro tras el 400`);
  assert.equal((await ledger(NEG, F('RECHAZO'))).length, 0);
  // Documentado para la fase 4B: la liga en `error` no admite un intento
  // nuevo hasta que el negocio la revise (renovar/reabrir).
  const antes = posts().length;
  const e = await rechaza(() => emitirAutofactura({ token: R.token, datosFiscales: MORAL }), 'AUTOFACTURA_ERROR');
  assert.equal(posts().length, antes);
  errores.push(r, e);
});

// ═══ 401 / 429 / 500 ═══
for (const [nombre, sufijo, status, codigo] of [
  ['30. 401/403 se trata como configuración del negocio, sin exponer la llave', 'AUTH', 401, 'FACTURAPI_CREDENCIALES'],
  ['31. 429 mantiene el intento recuperable', 'RATE', 429, 'FACTURAPI_429'],
  ['32. 500 mantiene el intento recuperable', 'CINCO', 500, 'FACTURAPI_5XX'],
]) {
  await t(nombre, async () => {
    const L = await liga(NEG, sufijo);
    encolar({ status, body: { message: `simulado ${status}` } });
    const r = await emitirAutofactura({ token: L.token, datosFiscales: MORAL });
    assert.equal(r.estado, 'emitiendo'); assert.equal(r.codigo, codigo); assert.equal(r.reintentable, true);
    sinSecretos(r, ['sk_test_mock']);
    const fila = await af(L.id);
    assert.equal(fila.estado, 'emitiendo'); assert.equal(fila.error_codigo, codigo);
    assert.ok(!JSON.stringify(fila).includes('sk_test_mock'), 'la llave quedó en la fila');
    // Reanudar: mismo snapshot, misma clave, ahora con éxito.
    encolar(VALIDA(`inv_ok_${sufijo}`, `${sufijo.padEnd(8, 'X')}-0000-0000-0000-000000000009`));
    const antes = posts().length;
    const r2 = await reanudarEmisionAutofactura(L.id);
    assert.equal(r2.estado, 'facturada');
    assert.equal(posts()[antes].body, posts()[antes - 1].body);
    assert.equal(JSON.parse(posts()[antes].body).idempotency_key, `xabor:af:${L.id}:1`);
    errores.push(r);
  });
}

// ═══ Sin red: estados, venta, negocio ═══
await t('33. TOTAL_CAMBIO -> 0 POST y la liga sigue vigente', async () => {
  const L = await liga(NEG, 'TOTAL');
  await pool.query(`UPDATE pedidos_activos SET datos = jsonb_set(datos, '{total}', '199') WHERE folio=$1`, [F('TOTAL')]);
  const antes = posts().length;
  errores.push(await rechaza(() => emitirAutofactura({ token: L.token, datosFiscales: MORAL }), 'TOTAL_CAMBIO'));
  assert.equal(posts().length, antes); assert.equal((await af(L.id)).estado, 'vigente');
});

await t('33b. datos fiscales inválidos -> 422 con errores por campo y 0 POST', async () => {
  const L = await liga(NEG, 'INVALIDOS');
  const antes = posts().length;
  const e = await rechaza(() => emitirAutofactura({ token: L.token, datosFiscales: { ...MORAL, rfc: 'XAXX010101000', regimen: '616', uso_cfdi: 'G03' } }), 'DATOS_FISCALES_INVALIDOS');
  assert.ok(e.errores.rfc && e.errores.uso_cfdi);
  assert.equal(posts().length, antes); assert.equal((await af(L.id)).estado, 'vigente');
  await rechaza(() => emitirAutofactura({ token: L.token, datosFiscales: MORAL, fuente: 'bot' }), 'FUENTE_INVALIDA');
  errores.push(e);
});

await t('34. liga expirada o revocada -> 0 POST', async () => {
  const E = await liga(NEG, 'EXP');
  await pool.query(`UPDATE autofacturas SET expires_at = now() - interval '1 day' WHERE id=$1`, [E.id]);
  const V = await liga(NEG, 'REV'); await revocarAutofactura(NEG, F('REV'));
  const antes = posts().length;
  errores.push(await rechaza(() => emitirAutofactura({ token: E.token, datosFiscales: MORAL }), 'AUTOFACTURA_EXPIRADA'));
  errores.push(await rechaza(() => emitirAutofactura({ token: V.token, datosFiscales: MORAL }), 'AUTOFACTURA_REVOCADA'));
  const inventado = Buffer.from(Array.from({ length: 32 }, (_, i) => 100 + i)).toString('base64url');
  errores.push(await rechaza(() => emitirAutofactura({ token: inventado, datosFiscales: MORAL }), 'AUTOFACTURA_NO_ENCONTRADA'));
  errores.push(await rechaza(() => emitirAutofactura({ token: 'XAB-0001', datosFiscales: MORAL }), 'AUTOFACTURA_NO_ENCONTRADA'));
  assert.equal(posts().length, antes);
});

await t('35-36. negocio inactivo o módulo apagado -> 0 POST (404 genérico)', async () => {
  const B = await liga(NEG_B, 'NEGB');
  const antes = posts().length;
  await pool.query('UPDATE negocios SET activo=FALSE WHERE id=$1', [NEG_B]);
  try { errores.push(await rechaza(() => emitirAutofactura({ token: B.token, datosFiscales: MORAL }), 'AUTOFACTURA_NO_ENCONTRADA')); }
  finally { await pool.query('UPDATE negocios SET activo=TRUE WHERE id=$1', [NEG_B]); }
  await fijarModulo(NEG_B, 'suspendido');
  try { errores.push(await rechaza(() => emitirAutofactura({ token: B.token, datosFiscales: MORAL }), 'AUTOFACTURA_NO_ENCONTRADA')); }
  finally { await fijarModulo(NEG_B, 'activo'); }
  assert.equal(posts().length, antes); assert.equal((await af(B.id)).estado, 'vigente');
});

// ═══ Concurrencia real ═══
await t('37. diez emisiones simultáneas -> como máximo UN POST y una sola factura', async () => {
  const C = await liga(NEG, 'CARRERA');
  encolar(async () => { await new Promise((r) => setTimeout(r, 300)); return VALIDA('inv_ok_C', 'CCCCCCCC-0000-0000-0000-000000000001'); });
  const antes = posts().length;
  const resultados = await Promise.all(Array.from({ length: 10 }, () => emitirAutofactura({ token: C.token, datosFiscales: MORAL }).catch((e) => ({ estado: 'excepcion', codigo: e.codigo }))));
  assert.equal(posts().length, antes + 1, `se hicieron ${posts().length - antes} POST`);
  assert.ok(resultados.every((r) => ['facturada', 'procesando'].includes(r.estado)), JSON.stringify(resultados));
  assert.equal(resultados.filter((r) => r.estado === 'facturada' && !r.yaEmitida).length, 1, 'exactamente una llamada emitió');
  const fila = await af(C.id);
  assert.equal(fila.estado, 'facturada'); assert.equal(fila.factura_id, 'inv_ok_C'); assert.equal(fila.intento_numero, 1);
  assert.equal((await ledger(NEG, F('CARRERA'))).length, 1);
});

await t('39. ningún resultado ni error devuelve snapshot, material criptográfico, token ni llave', async () => {
  assert.ok(errores.length >= 12);
  const filaA = await af(A.id);
  for (const r of errores) sinSecretos(r, ['sk_test_mock', filaA.snapshot_cifrado, A.token]);
  sinSecretos(resultadoA, ['sk_test_mock', filaA.snapshot_cifrado, A.token]);
});

await t('40b. el transporte simulado no dejó llamadas sin consumir y ninguna fue a otra ruta que /invoices', async () => {
  assert.equal(cola.length, 0, 'quedaron respuestas encoladas sin usar');
  assert.ok(llamadas.every((c) => /\/v2\/invoices(\/[^/]+)?$/.test(c.url)), 'una llamada salió a una ruta inesperada');
  assert.ok(llamadas.every((c) => !/receipts/.test(c.url)), 'jamás E-Receipts');
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
