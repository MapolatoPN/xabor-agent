// /facturacion: la liga de autofactura se entrega solo con sucursal, folio Y
// total del ticket.
//
// El total confirma que quien factura tiene el ticket. Un total que no
// coincide responde EXACTAMENTE igual que un folio inexistente, y no crea la
// liga. Las rutas reales del portal se montan
// en un Express mínimo y se llaman por HTTP; sin Facturapi.
import assert from 'node:assert/strict';
import express from 'express';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida');
process.env.XABOR_URL_PUBLICA = process.env.XABOR_URL_PUBLICA || 'https://xabor.test';

const { pool } = await import('../src/services/database.js');
const { registrarRutasAutofactura } = await import('../src/services/autofacturaRutas.js');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}

const { rows: [n] } = await pool.query('SELECT id, slug FROM negocios WHERE slug IS NOT NULL ORDER BY created_at LIMIT 1');
const NEG = n.id, SLUG = n.slug;
const FOLIOS = { pagada: 'XAB-99872001', grande: 'XAB-99872002', sinPagar: 'XAB-99872003' };
const previoModulo = (await pool.query(`SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG])).rows[0]?.estado ?? null;
const previoActivo = (await pool.query('SELECT activo FROM negocios WHERE id=$1', [NEG])).rows[0].activo;
const limpiar = async () => {
  for (const tabla of ['autofacturas', 'pedidos_activos']) await pool.query(`DELETE FROM ${tabla} WHERE folio = ANY($1)`, [Object.values(FOLIOS)]);
};
async function venta(folio, total, { pagada = true } = {}) {
  await pool.query(`INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at) VALUES ($1,$2,$3,$4::jsonb, NOW())`,
    [NEG, folio, pagada ? 'entregado' : 'nuevo', JSON.stringify({ total, forma_pago: pagada ? 'efectivo' : 'por_cobrar', pago_confirmado: pagada,
      modalidad: 'recoger en tienda', timestamp: new Date().toISOString(), cliente: { nombre: 'Cliente Portal', telefono: '5218780009872' } })]);
}
const ligas = async (folio) => (await pool.query('SELECT count(*)::int n FROM autofacturas WHERE negocio_id=$1 AND folio=$2', [NEG, folio])).rows[0].n;

await limpiar();
await pool.query('UPDATE negocios SET activo=TRUE WHERE id=$1', [NEG]);
await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'facturacion','activo')
  ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG]);
await venta(FOLIOS.pagada, 245);
await venta(FOLIOS.grande, 1245.5);
await venta(FOLIOS.sinPagar, 180, { pagada: false });

const app = express();
registrarRutasAutofactura(app);
const servidor = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${servidor.address().port}`;
const pedir = async (cuerpo) => {
  const r = await fetch(`${BASE}/api/autofactura/portal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

try {
  let noEncontrado;
  await t('1. folio inexistente: 404 genérico', async () => {
    const r = await pedir({ slug: SLUG, folio: 'XAB-99872999', total: '245.00' });
    assert.equal(r.status, 404);
    noEncontrado = r.body;
    assert.match(noEncontrado.error, /sucursal, el folio y el total/);
  });
  await t('2. sin total: 400 y no se crea la liga', async () => {
    const r = await pedir({ slug: SLUG, folio: FOLIOS.pagada });
    assert.equal(r.status, 400);
    assert.equal(await ligas(FOLIOS.pagada), 0);
  });
  await t('3. total equivocado: la MISMA respuesta que un folio inexistente, sin liga y sin datos de la venta', async () => {
    const r = await pedir({ slug: SLUG, folio: FOLIOS.pagada, total: '244.99' });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, noEncontrado);
    assert.ok(!JSON.stringify(r.body).includes('245'), 'reveló el total');
    assert.equal(await ligas(FOLIOS.pagada), 0, 'creó la liga con un total equivocado');
  });
  await t('4. total correcto: entrega la liga', async () => {
    const r = await pedir({ slug: SLUG, folio: FOLIOS.pagada, total: '245.00' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.url, /^https:\/\/xabor\.test\/f\//);
    assert.equal(await ligas(FOLIOS.pagada), 1);
  });
  await t('5. formatos del total: "$1,245.50", "1245.5" y número; "245" equivale a 245.00', async () => {
    for (const total of ['$1,245.50', '1245.5', 1245.5]) {
      const r = await pedir({ slug: SLUG, folio: FOLIOS.grande, total });
      assert.equal(r.status, 200, `${JSON.stringify(total)} → ${r.status}`);
    }
    assert.equal((await pedir({ slug: SLUG, folio: FOLIOS.pagada, total: '245' })).status, 200);
  });
  await t('6. el folio corto también se acepta, siempre con el total', async () => {
    assert.equal((await pedir({ slug: SLUG, folio: '99872001', total: '245.00' })).status, 200);
    assert.equal((await pedir({ slug: SLUG, folio: '99872001', total: '246.00' })).status, 404);
  });
  await t('7. venta sin pagar: el mismo 404 aunque el total coincida', async () => {
    const r = await pedir({ slug: SLUG, folio: FOLIOS.sinPagar, total: '180.00' });
    assert.equal(r.status, 404); assert.deepEqual(r.body, noEncontrado);
  });
  await t('8. totales inválidos (negativo, cero, texto, más de dos decimales): 400', async () => {
    for (const total of ['-245', '0', 'doscientos', '245.001']) {
      assert.equal((await pedir({ slug: SLUG, folio: FOLIOS.pagada, total })).status, 400, `aceptó ${total}`);
    }
  });
} finally {
  servidor.close();
  await limpiar();
  await pool.query('UPDATE negocios SET activo=$2 WHERE id=$1', [NEG, previoActivo]);
  if (previoModulo === null) await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG]);
  else await pool.query(`UPDATE negocio_modulos SET estado=$2 WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG, previoModulo]);
  await pool.end().catch(() => {});
}
console.log(`\nPASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
