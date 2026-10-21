// Factura por WhatsApp con Facturapi caído: el bot manda la liga de Xabor.
//
// Cuando el recibo de Facturapi no se podía crear (proveedor caído, cuenta
// suspendida), facturacionWhatsapp.js leía `recibo.expires_at` con recibo
// null: el TypeError caía al catch y el cliente recibía «No pude preparar la
// factura» aunque su liga de Xabor sí existía. Además la vigencia mostrada era
// la del recibo de Facturapi aunque la liga entregada fuera la de Xabor.
// Transporte de Facturapi SIMULADO (globalThis.fetch interceptado).
import assert from 'node:assert/strict';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida');
process.env.XABOR_URL_PUBLICA = process.env.XABOR_URL_PUBLICA || 'https://xabor.test';

const { pool } = await import('../src/services/database.js');
const { guardarCredencialesFacturapi, eliminarCredencialesFacturapi } = await import('../src/services/integracionesService.js');
const { guardarConfiguracionFacturacion } = await import('../src/services/facturacionService.js');
const { manejarFacturacionWhatsapp } = await import('../src/services/facturacionWhatsapp.js');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}

const llamadas = []; let cola = [];
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://www.facturapi.io/')) return fetchOriginal(url, init);
  llamadas.push(`${init.method || 'GET'} ${u.replace('https://www.facturapi.io/v2', '')}`);
  const h = cola.shift();
  if (!h) throw new Error(`mock Facturapi: sin respuesta encolada para ${u}`);
  return new Response(JSON.stringify(h.body ?? {}), { status: h.status, headers: { 'Content-Type': 'application/json' } });
};
const SUSPENDIDO = { status: 403, body: { message: 'El usuario está suspendido. Contacta a soporte para resolverlo.', code: 'user_suspended' } };

const { rows: [n] } = await pool.query('SELECT id FROM negocios ORDER BY created_at LIMIT 1');
const NEG = n.id;
const TEL = '5218780009871';
const FOLIOS = ['XAB-99871001', 'XAB-99871002'];
const previoModulo = (await pool.query(`SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG])).rows[0]?.estado ?? null;
const limpiar = async () => {
  for (const tabla of ['facturacion_recibos', 'autofacturas', 'pedidos_activos']) await pool.query(`DELETE FROM ${tabla} WHERE folio = ANY($1)`, [FOLIOS]);
  await pool.query('DELETE FROM facturacion_whatsapp_estado WHERE negocio_id=$1 AND telefono=$2', [NEG, TEL]);
};
async function venta(folio) {
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at) VALUES ($1,$2,'entregado',$3::jsonb, NOW())`,
    [NEG, folio, JSON.stringify({ total: 180, forma_pago: 'efectivo', pago_confirmado: true, modalidad: 'recoger en tienda',
      timestamp: new Date().toISOString(), cliente: { nombre: 'Cliente WA', telefono: TEL } })]);
}
const ligaDe = async (folio) => (await pool.query('SELECT expires_at FROM autofacturas WHERE negocio_id=$1 AND folio=$2', [NEG, folio])).rows[0];
const fechaMx = (d) => new Date(d).toLocaleDateString('es-MX', { timeZone: 'America/Matamoros' });

await limpiar();
await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'facturacion','activo')
  ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG]);
await guardarCredencialesFacturapi(NEG, 'sk_test_mock_wa_nunca_real', null);
await guardarConfiguracionFacturacion(NEG, { ivaTasa: 0.16, autoemitirRecibo: true });

try {
  await venta(FOLIOS[0]);
  await t('1. Facturapi suspendido: el bot manda la liga de Xabor, no escala', async () => {
    cola.push(SUSPENDIDO);
    const r = await manejarFacturacionWhatsapp({ negocioId: NEG, telefono: TEL, texto: `quiero factura del folio ${FOLIOS[0]}` });
    assert.equal(r.manejado, true);
    assert.ok(!r.escalar, `escaló: ${r.mensaje} ${r.error?.message || ''}`);
    assert.match(r.mensaje, /Para facturar la venta XAB-99871001/);
    assert.match(r.mensaje, /https:\/\/xabor\.test\/f\//);
    assert.ok(!/Clave:/.test(r.mensaje), 'con liga de Xabor no se manda la clave del recibo');
    assert.ok(llamadas.some((l) => l === 'POST /receipts'), 'sí intentó el recibo');
  });
  await t('2. la vigencia mostrada es la de la liga de Xabor', async () => {
    cola.push(SUSPENDIDO);
    const r = await manejarFacturacionWhatsapp({ negocioId: NEG, telefono: TEL, texto: `factura ${FOLIOS[0]}` });
    const liga = await ligaDe(FOLIOS[0]);
    assert.ok(liga?.expires_at, 'la liga tiene vencimiento');
    assert.ok(r.mensaje.includes(`Vigente en el portal hasta: ${fechaMx(liga.expires_at)}.`), r.mensaje);
  });
  await venta(FOLIOS[1]);
  await t('3. con Facturapi sano, la vigencia sigue siendo la de la liga de Xabor (no la del recibo)', async () => {
    cola.push({ status: 200, body: { id: 'rcp_wa', status: 'open', total: 180, key: 'k', self_invoice_url: 'https://factura.space/x/rcp_wa', expires_at: '2030-01-15T12:00:00.000Z' } });
    const r = await manejarFacturacionWhatsapp({ negocioId: NEG, telefono: TEL, texto: `factura ${FOLIOS[1]}` });
    const liga = await ligaDe(FOLIOS[1]);
    assert.ok(!r.escalar, r.mensaje);
    assert.ok(r.mensaje.includes(fechaMx(liga.expires_at)), r.mensaje);
    assert.ok(!r.mensaje.includes(fechaMx('2030-01-15T12:00:00.000Z')), 'mostró la vigencia del recibo de Facturapi');
  });
} finally {
  globalThis.fetch = fetchOriginal;
  await limpiar();
  await pool.query('DELETE FROM facturacion_configuracion WHERE negocio_id=$1', [NEG]).catch(() => {});
  await eliminarCredencialesFacturapi(NEG, null).catch(() => {});
  if (previoModulo === null) await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG]);
  else await pool.query(`UPDATE negocio_modulos SET estado=$2 WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG, previoModulo]);
  await pool.end().catch(() => {});
}
console.log(`\nPASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
