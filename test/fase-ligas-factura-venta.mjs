// Toda venta pagada recibe su liga de autofactura.
//
// Antes la liga solo se creaba si antes salía bien el recibo de Facturapi, y
// las ventas que solo son facturables al entregarse (POS, WhatsApp en
// efectivo, Rappi) se quedaban sin liga porque el disparador leía la venta
// antes de que se guardara «entregado». Facturapi SIMULADO como suspendido
// (globalThis.fetch interceptado): la liga se crea igual.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida');
process.env.XABOR_URL_PUBLICA = process.env.XABOR_URL_PUBLICA || 'https://xabor.test';

const { pool } = await import('../src/services/database.js');
const { guardarCredencialesFacturapi, eliminarCredencialesFacturapi } = await import('../src/services/integracionesService.js');
const { guardarConfiguracionFacturacion, reconciliarRecibosFacturacion } = await import('../src/services/facturacionService.js');
const { asegurarLigaYReciboVenta, barrerVentasSinLiga, _olvidarEsperas } = await import('../src/services/ligasFacturaVenta.js');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}

// Facturapi suspendido para todo, como el 20-oct.
const llamadas = [];
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://www.facturapi.io/')) return fetchOriginal(url, init);
  llamadas.push(`${init.method || 'GET'} ${u.replace('https://www.facturapi.io/v2', '')}`);
  return new Response(JSON.stringify({ message: 'El usuario está suspendido.', code: 'user_suspended' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
};

const { rows: negocios } = await pool.query('SELECT id FROM negocios ORDER BY created_at LIMIT 2');
const [NEG, NEG_B] = negocios.map((n) => n.id);
const PREFIJO = 'XAB-9988';
const folio = (n) => `${PREFIJO}${String(n).padStart(4, '0')}`;
const previo = {};
for (const n of [NEG, NEG_B]) previo[n] = (await pool.query(`SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [n])).rows[0]?.estado ?? null;
const limpiar = async () => {
  for (const tabla of ['facturacion_recibos', 'autofacturas', 'pedidos_activos']) await pool.query(`DELETE FROM ${tabla} WHERE folio LIKE $1`, [`${PREFIJO}%`]);
};
async function venta(negocioId, n, { estado = 'entregado', canal = 'pos', formaPago = 'efectivo', total = 150, pagada = false, dias = 0 } = {}) {
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, created_at, entregado_at)
     VALUES ($1,$2,$3,$4::jsonb, NOW() - make_interval(days => $5) - INTERVAL '5 minutes', NOW())`,
    [negocioId, folio(n), estado, JSON.stringify({ total, canal, forma_pago: formaPago, ...(pagada ? { pago_confirmado: true } : {}),
      modalidad: 'recoger en tienda', timestamp: new Date().toISOString(), cliente: { nombre: 'Cliente', telefono: '5218780000222' } }), dias]);
  return folio(n);
}
const tieneLiga = async (negocioId, f) => (await pool.query('SELECT 1 FROM autofacturas WHERE negocio_id=$1 AND folio=$2', [negocioId, f])).rowCount > 0;

await limpiar();
await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'facturacion','activo') ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG]);
await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'facturacion','configurado') ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='configurado'`, [NEG_B]);
await guardarCredencialesFacturapi(NEG, 'sk_test_mock_ligas_nunca_real', null);
await guardarConfiguracionFacturacion(NEG, { ivaTasa: 0.08, autoemitirRecibo: true });
await guardarCredencialesFacturapi(NEG_B, 'sk_test_mock_ligas_nunca_real_b', null);
await guardarConfiguracionFacturacion(NEG_B, { ivaTasa: 0.08, autoemitirRecibo: true });

try {
  await t('1. con Facturapi suspendido la liga se crea igual; el recibo queda en error para reintentar', async () => {
    const f = await venta(NEG, 1);
    const r = await asegurarLigaYReciboVenta(NEG, f, 'prueba');
    assert.match(r?.url_xabor || '', /^https:\/\/xabor\.test\/f\//, JSON.stringify(r));
    assert.ok(await tieneLiga(NEG, f));
    assert.ok(llamadas.includes('POST /receipts'), 'sí intentó el recibo');
    const { rows: [rec] } = await pool.query('SELECT estado FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2', [NEG, f]);
    assert.equal(rec?.estado, 'error');
  });

  const buenas = [await venta(NEG, 10), await venta(NEG, 11, { canal: 'whatsapp', formaPago: 'terminal' }),
    await venta(NEG, 12, { canal: 'tienda_online', estado: 'nuevo', pagada: true, formaPago: 'enlace_pago' })];
  const fuera = {
    rappi: await venta(NEG, 20, { canal: 'rappi', formaPago: '' }),
    forma_rappi: await venta(NEG, 21, { formaPago: 'rappi' }),
    por_cobrar: await venta(NEG, 22, { estado: 'listo', formaPago: 'por_cobrar' }),
    cancelada: await venta(NEG, 23, { estado: 'cancelado' }),
    total_cero: await venta(NEG, 24, { total: 0 }),
    sin_entregar: await venta(NEG, 25, { estado: 'listo' }),
    mes_pasado: await venta(NEG, 26, { dias: 45 }),
    modulo_configurado: await venta(NEG_B, 27),
  };
  await t('2. el barrido prepara las ventas pagadas o entregadas del mes que no tenían liga', async () => {
    _olvidarEsperas();
    const r = await barrerVentasSinLiga(50);
    for (const f of buenas) assert.ok(await tieneLiga(NEG, f), `sin liga: ${f}`);
    assert.ok(r.preparadas >= 3, JSON.stringify(r));
  });
  await t('3. y deja fuera Rappi, por cobrar, canceladas, total cero, sin entregar, de otro mes y negocios sin el módulo activo', async () => {
    for (const [motivo, f] of Object.entries(fuera)) {
      const neg = motivo === 'modulo_configurado' ? NEG_B : NEG;
      assert.equal(await tieneLiga(neg, f), false, `se preparó ${motivo}`);
    }
  });
  await t('4. una venta cuya liga no se pudo crear espera 6 h antes de reintentarse', async () => {
    const f = await venta(NEG, 30);
    // Sin la llave de cifrado no se puede cifrar el token de la liga ni leer
    // la llave de Facturapi: falla sin dejar fila, como un error real.
    const llave = process.env.INTEGRATIONS_ENCRYPTION_KEY;
    delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    try {
      _olvidarEsperas();
      const a = await barrerVentasSinLiga(50);
      assert.ok(a.fallidas >= 1, JSON.stringify(a));
      assert.equal(await tieneLiga(NEG, f), false);
      const b = await barrerVentasSinLiga(50);
      assert.ok(b.en_espera >= 1 && b.fallidas === 0, JSON.stringify(b));
    } finally { process.env.INTEGRATIONS_ENCRYPTION_KEY = llave; }
    const c = await barrerVentasSinLiga(50, { ahora: Date.now() + 7 * 3600 * 1000 });
    assert.ok(c.preparadas >= 1, JSON.stringify(c));
    assert.ok(await tieneLiga(NEG, f));
  });
  await t('5. el barrido respeta el límite por ciclo', async () => {
    for (let i = 40; i < 46; i++) await venta(NEG, i);
    _olvidarEsperas();
    const r = await barrerVentasSinLiga(2);
    assert.equal(r.preparadas + r.fallidas, 2, JSON.stringify(r));
  });
  await t('6. la reconciliación de cada 5 min corre el barrido', async () => {
    _olvidarEsperas();
    const r = await reconciliarRecibosFacturacion();
    assert.ok(r.ligas && typeof r.ligas.candidatas === 'number', JSON.stringify(r.ligas));
  });
  await t('7. server.js delega la autoemisión en el módulo (la liga ya no depende del recibo)', async () => {
    const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    const cuerpo = server.slice(server.indexOf('async function autoemitirReciboSilencioso'), server.indexOf('async function prepararAutofacturaParaTicket'));
    assert.match(cuerpo, /return await asegurarLigaYReciboVenta\(negocioId, folio, origen\);/);
    assert.ok(!/asegurarReciboPedido\(/.test(cuerpo), 'la autoemisión volvió a crear el recibo antes que la liga');
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
