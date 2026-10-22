// ─── «Quitar promoción» de un pedido abierto: solo administrador ─────────────
//
// Desde el 22-oct-2026 el mostrador aplica solas las promociones al crear el
// pedido. Si una no correspondía, la única salida era cancelar y recapturar.
// Decisión de Mario (22-oct): la quita un administrador, con motivo.
// (services/promocionManual.js → quitarPromocionDePedido;
//  DELETE /api/pedidos/:folio/promociones/:promocionId)
//
//   S — servidor: importe exacto, huella, permisos, pedidos que no, uso.
//   B — el panel real: el admin la quita desde el modal; staff no ve el botón.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_QUITAR_PROMO || '4736';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
const NEG_A = SEED.negocioA, NEG_B = SEED.negocioB;
const tok = (u, n, rol) => crearTokenSesion({ usuarioId: u, negocioId: n, rol });
const ck = (token) => `xabor_sesion=${encodeURIComponent(token)}`;
const ADMIN_A = ck(tok(SEED.adminNegocioAUsuarioId, NEG_A, 'admin'));
const STAFF_A = ck(tok(SEED.staffNegocioAUsuarioId, NEG_A, 'staff'));
const ADMIN_B = ck(tok(SEED.adminNegocioAUsuarioId, NEG_B, 'admin'));

for (const [n, m] of [[NEG_A, 'pos'], [NEG_A, 'caja'], [NEG_A, 'menu'], [NEG_B, 'pos']]) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [n, m]);
}
await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'mostrador_promos_automaticas'`, [NEG_A]);
const sufijo = Date.now().toString(36);
const PROD = {};
{
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,0) RETURNING id`, [NEG_A, `Quitar ${sufijo}`]);
  for (const [clave, nombre, precio] of [['chila', `Chila ${sufijo}`, 195], ['agua', `Agua ${sufijo}`, 25]]) {
    const { rows: [p] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
       VALUES ($1,$2,$3,$4,TRUE,FALSE,1) RETURNING id`, [NEG_A, cat.id, nombre, precio]);
    PROD[clave] = p.id;
  }
}

const srv = await arrancarServidor({ PORT: PUERTO, TZ: 'America/Matamoros' }, { timeoutMs: 90000 });
const api = (ruta, opts = {}, c = ADMIN_A) => fetch(srv.base + ruta, {
  ...opts, headers: { 'Content-Type': 'application/json', Cookie: c, ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return {}; } };
const leer = async (folio) => (await pool.query(`SELECT datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, NEG_A])).rows[0].datos;
const quitar = (folio, id, motivo, c = ADMIN_A) => api(`/api/pedidos/${folio}/promociones/${id}`,
  { method: 'DELETE', body: JSON.stringify({ motivo }) }, c);
async function mostrador(items = [{ producto_id: PROD.chila, cantidad: 2 }, { producto_id: PROD.agua, cantidad: 1 }]) {
  const r = await api('/api/pedido-presencial', { method: 'POST', body: JSON.stringify({ items, nombre: 'Quitar promo' }) }, STAFF_A);
  const d = await json(r);
  assert.strictEqual(r.status, 200, JSON.stringify(d));
  return d.pedido.id;
}
const PROMOS = [];
async function crearPromo(cuerpo) {
  const r = await api('/api/admin/tienda/promociones', { method: 'POST', body: JSON.stringify({
    tipo: '2x1', automatica: true, canales: ['pos'], cantidadRequerida: 2, cantidadBeneficiada: 1,
    activa: true, acumulable: true, ...cuerpo }) });
  const d = await json(r);
  assert.strictEqual(r.status, 200, `crear promo: ${JSON.stringify(d)}`);
  PROMOS.push(d.id);
  return d.id;
}

let navegador;
try {
const P_CHILA = await crearPromo({ nombre: `2x1 chila ${sufijo}`, productos: [PROD.chila] });
const P_AGUA = await crearPromo({ nombre: `Agua 10 ${sufijo}`, tipo: 'porcentaje', valor: 10, automatica: false,
  codigo: `AG${sufijo}`.toUpperCase().slice(0, 20), productos: [PROD.agua], cantidadRequerida: null, cantidadBeneficiada: null });

// ─── S — servidor ───────────────────────────────────────────────────────────
let folio1;
await t('S', '1. el listado trae las promociones que el pedido ya lleva', async () => {
  folio1 = await mostrador();
  const d = await json(await api(`/api/pedidos/${folio1}/promociones-aplicables`, {}, STAFF_A));
  assert.strictEqual(d.aplicadas.length, 1);
  assert.strictEqual(d.aplicadas[0].id, P_CHILA);
  assert.strictEqual(d.aplicadas[0].automatica, true);
  assert.strictEqual(d.aplicadas[0].descuento, 195);
});

await t('S', '2. staff no puede quitarla (403) y el pedido no cambia', async () => {
  const r = await quitar(folio1, P_CHILA, 'no la quería', STAFF_A);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(Number((await leer(folio1)).total), 220);
});

await t('S', '3. sin motivo: 400 y el pedido no cambia', async () => {
  const r = await quitar(folio1, P_CHILA, '   ');
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await json(r)).codigo, 'MOTIVO_REQUERIDO');
  assert.strictEqual(Number((await leer(folio1)).total), 220);
});

await t('S', '4. el admin la quita: el total sube lo que descontaba y queda la huella', async () => {
  const r = await quitar(folio1, P_CHILA, 'el cliente pidió sin salsa');
  const d = await json(r);
  assert.strictEqual(r.status, 200, JSON.stringify(d));
  assert.strictEqual(d.descuento, 195);
  assert.strictEqual(d.total, 415);
  const f = await leer(folio1);
  assert.strictEqual(Number(f.total), 415);
  assert.strictEqual(Number(f.descuento), 0);
  assert.deepStrictEqual(f.promociones, []);
  assert.deepStrictEqual(f.descuentos.promociones, []);
  assert.strictEqual(f.descuentos.total, 0);
  const h = f.promociones_quitadas[0];
  assert.strictEqual(h.id, P_CHILA);
  assert.strictEqual(h.motivo_quitada, 'el cliente pidió sin salsa');
  assert.strictEqual(h.quitada_por, SEED.adminNegocioAUsuarioId);
  assert.ok(h.quitada_at);
});

await t('S', '5. su uso deja de contar en las métricas de la promoción', async () => {
  const { rows } = await pool.query(`SELECT 1 FROM tienda_promocion_usos WHERE negocio_id=$1 AND promocion_id=$2 AND pedido_folio=$3`,
    [NEG_A, P_CHILA, folio1]);
  assert.strictEqual(rows.length, 0);
});

await t('S', '6. quitarla dos veces: 404 y nada cambia', async () => {
  const r = await quitar(folio1, P_CHILA, 'otra vez');
  assert.strictEqual(r.status, 404);
  assert.strictEqual((await json(r)).codigo, 'NO_APLICADA');
  assert.strictEqual(Number((await leer(folio1)).total), 415);
});

await t('S', '7. el cobro ya no la descuenta', async () => {
  const r = await api(`/pedidos/${folio1}/cobro`, { method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo' }) }, STAFF_A);
  const d = await json(r);
  assert.strictEqual(r.status, 200, JSON.stringify(d));
  assert.strictEqual(d.total, 415);
});

await t('S', '8. con dos promociones, quitar una deja la otra y el descuento manual intactos', async () => {
  const folio = await mostrador();
  const ra = await api(`/api/pedidos/${folio}/promocion`, { method: 'POST', body: JSON.stringify({ promocionId: P_AGUA }) });
  assert.strictEqual(ra.status, 200, JSON.stringify(await json(ra)));
  assert.strictEqual(Number((await leer(folio)).total), 217.5);
  const r = await quitar(folio, P_CHILA, 'no aplicaba');
  assert.strictEqual(r.status, 200);
  const f = await leer(folio);
  assert.strictEqual(Number(f.total), 412.5);
  assert.strictEqual(Number(f.descuento), 2.5);
  assert.deepStrictEqual(f.promociones.map(p => p.id), [P_AGUA]);
  assert.strictEqual(f.descuentos.promociones.length, 1);
  const rc = await api(`/pedidos/${folio}/cobro`, { method: 'PATCH',
    body: JSON.stringify({ forma_pago: 'efectivo', descuento: 10, motivo_descuento: 'cortesía' }) });
  const dc = await json(rc);
  assert.strictEqual(rc.status, 200, JSON.stringify(dc));
  assert.strictEqual(dc.total, 402.5, '415 − 2.5 de la promo que quedó − 10 manual');
});

await t('S', '9. pedido ya cobrado: 409', async () => {
  const folio = await mostrador();
  await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo' }) });
  const r = await quitar(folio, P_CHILA, 'tarde');
  assert.strictEqual(r.status, 409);
  assert.strictEqual(Number((await leer(folio)).total), 220);
});

await t('S', '10. otro negocio no toca el pedido', async () => {
  const folio = await mostrador();
  const r = await quitar(folio, P_CHILA, 'ajeno', ADMIN_B);
  assert.ok([403, 404].includes(r.status), `respondió ${r.status}`);
  const { quitarPromocionDePedido } = await import('../src/services/promocionManual.js');
  await assert.rejects(quitarPromocionDePedido(NEG_B, folio, { promocionId: P_CHILA, motivo: 'x', rol: 'admin' }), e => e.status === 404);
  assert.strictEqual(Number((await leer(folio)).total), 220);
});

await t('S', '11. el servicio también exige administrador (no solo la ruta)', async () => {
  const folio = await mostrador();
  const { quitarPromocionDePedido } = await import('../src/services/promocionManual.js');
  await assert.rejects(quitarPromocionDePedido(NEG_A, folio, { promocionId: P_CHILA, motivo: 'x', rol: 'staff' }), e => e.status === 403);
  assert.strictEqual(Number((await leer(folio)).total), 220);
});

await t('S', '12. después de quitarla, «Aplicar promoción» la vuelve a ofrecer', async () => {
  const folio = await mostrador();
  assert.strictEqual((await quitar(folio, P_CHILA, 'probar')).status, 200);
  const d = await json(await api(`/api/pedidos/${folio}/promociones-aplicables`));
  assert.deepStrictEqual(d.aplicadas, []);
  assert.strictEqual(d.promociones.find(p => p.id === P_CHILA).motivo, null);
  const r = await api(`/api/pedidos/${folio}/promocion`, { method: 'POST', body: JSON.stringify({ promocionId: P_CHILA }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(Number((await leer(folio)).total), 220);
});

await t('S', '13. el envío gratis no se quita desde aquí', async () => {
  const folio = await mostrador();
  await pool.query(`UPDATE pedidos_activos SET datos = jsonb_set(datos, '{promociones}',
      (datos->'promociones') || '[{"id":"00000000-0000-4000-8000-0000000000e9","nombre":"Envío","descuento":0,"envio_gratis":true}]'::jsonb)
    WHERE folio = $1 AND negocio_id = $2`, [folio, NEG_A]);
  const r = await quitar(folio, '00000000-0000-4000-8000-0000000000e9', 'probar');
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await json(r)).codigo, 'ENVIO_GRATIS');
});

// ─── B — el panel real ─────────────────────────────────────────────────────
navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
async function abrirPanel(token) {
  const pagina = await navegador.newPage();
  const errores = [];
  pagina.on('pageerror', e => errores.push(e.message));
  pagina.on('dialog', d => (d.type() === 'prompt' ? d.accept('la promo no correspondía') : d.accept()).catch(() => {}));
  await pagina.setCookie({ name: 'xabor_sesion', value: encodeURIComponent(token), domain: 'localhost', path: '/' });
  await pagina.goto(srv.base + '/app', { waitUntil: 'networkidle0' });
  await pagina.evaluate(() => { window.open = () => ({ document: { write() {}, close() {} }, print() {}, close() {} }); });
  return { pagina, errores };
}

await t('B', '1. el admin la quita desde el modal y la tarjeta se actualiza', async () => {
  const { pagina, errores } = await abrirPanel(tok(SEED.adminNegocioAUsuarioId, NEG_A, 'admin'));
  const folio = await mostrador();
  await pagina.waitForFunction((f) => !!pedidos[f], { timeout: 8000 }, folio);
  await pagina.evaluate((f) => abrirPromoManual(f), folio);
  await pagina.waitForSelector(`#modal-promo-manual [data-promo-aplicada] button`, { timeout: 5000 });
  await pagina.click(`#modal-promo-manual [data-promo-aplicada] button`);
  await pagina.waitForFunction((f) => Number(pedidos[f].total) === 415, { timeout: 5000 }, folio);
  const f = await leer(folio);
  assert.strictEqual(Number(f.total), 415);
  assert.strictEqual(f.promociones_quitadas[0].motivo_quitada, 'la promo no correspondía');
  assert.deepStrictEqual(errores, []);
  await pagina.close();
});

await t('B', '2. staff ve las promociones aplicadas, pero no el botón «Quitar»', async () => {
  const { pagina, errores } = await abrirPanel(tok(SEED.staffNegocioAUsuarioId, NEG_A, 'staff'));
  const folio = await mostrador();
  await pagina.waitForFunction((f) => !!pedidos[f], { timeout: 8000 }, folio);
  await pagina.evaluate((f) => abrirPromoManual(f), folio);
  await pagina.waitForSelector(`#modal-promo-manual [data-promo-aplicada]`, { timeout: 5000 });
  await esperar(200);
  const botones = await pagina.$$eval(`#modal-promo-manual [data-promo-aplicada] button`, b => b.length);
  assert.strictEqual(botones, 0);
  assert.deepStrictEqual(errores, []);
  await pagina.close();
});

} finally {
  if (navegador) await navegador.close().catch(() => {});
  srv.detener();
  if (PROMOS.length) {
    await pool.query(`DELETE FROM tienda_promocion_usos WHERE promocion_id = ANY($1)`, [PROMOS]).catch(() => {});
    await pool.query(`DELETE FROM tienda_promociones WHERE id = ANY($1)`, [PROMOS]).catch(() => {});
  }
  await pool.query(`UPDATE menu_productos SET disponible = FALSE WHERE id = ANY($1)`, [Object.values(PROD)]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log(fallos.join('\n')); process.exit(1); }
process.exit(0);
