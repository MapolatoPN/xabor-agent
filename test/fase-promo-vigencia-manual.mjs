// ─── Vigencia en el día local + promoción aplicada a mano ────────────────────
//
// Incidente del 30-sep-2026: el «Miércoles de Chilaquiles» de Obispado,
// capturado «hasta el 30», vencía el 29 a las 19:00 de Matamoros porque la
// fecha del panel se guardaba como medianoche UTC. Y un pedido que entró sin
// la promoción no tenía forma de recibirla después (el mostrador tampoco pasa
// por el motor: XAB-1007 llevó un «descuento manual» con motivo «2x1»).
//
//   V — vigencia: el día local entra completo, y la 108 corrige lo guardado.
//   M — aplicar promoción a un pedido abierto: importe del servidor, permisos
//       por horario, idempotencia, aislamiento, canales y pedidos que no.
//   C — el cobro del mostrador respeta la promoción aplicada.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_PROMO_MANUAL || '4731';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');
const { instanteDeVigencia, fechaDeVigencia, normalizarVigencia } = await import('../src/services/vigenciaPromos.js');
const { evaluarPromocionSobrePedido } = await import('../src/services/tiendaPromociones.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;

const TZ = 'America/Matamoros';
const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const ADMIN_A = cookie(SEED.adminNegocioAUsuarioId, NEG_A, 'admin');
const STAFF_A = cookie(SEED.staffNegocioAUsuarioId, NEG_A, 'staff');
const ADMIN_B = cookie(SEED.adminNegocioAUsuarioId, NEG_B, 'admin');

// ════════════════════════════════════════════════════════════════════════════
// V — Vigencia (puro)
// ════════════════════════════════════════════════════════════════════════════
await t('V', '1. «hasta el 30» dura todo el 30 en Matamoros (verano, UTC-5)', async () => {
  assert.strictEqual(instanteDeVigencia('2026-09-30', TZ, 'hasta'), '2026-10-01T04:59:59.999Z');
});
await t('V', '2. «desde el 1» empieza a las 00:00 locales, no la víspera', async () => {
  assert.strictEqual(instanteDeVigencia('2026-09-01', TZ, 'desde'), '2026-09-01T05:00:00.000Z');
});
await t('V', '3. en invierno (UTC-6) el fin de día se corre una hora', async () => {
  assert.strictEqual(instanteDeVigencia('2026-12-15', TZ, 'hasta'), '2026-12-16T05:59:59.999Z');
});
await t('V', '4. el día del cambio de horario (1-nov, 25 h) termina a la medianoche real', async () => {
  // 1-nov-2026: 00:00 CDT = 05:00Z; 2-nov 00:00 CST = 06:00Z.
  assert.strictEqual(instanteDeVigencia('2026-11-01', TZ, 'desde'), '2026-11-01T05:00:00.000Z');
  assert.strictEqual(instanteDeVigencia('2026-11-01', TZ, 'hasta'), '2026-11-02T05:59:59.999Z');
});
await t('V', '5. ida y vuelta: el panel vuelve a ver el mismo día que capturó', async () => {
  for (const f of ['2026-09-01', '2026-09-30', '2026-11-01', '2026-12-31']) {
    assert.strictEqual(fechaDeVigencia(instanteDeVigencia(f, TZ, 'desde'), TZ), f, `desde ${f}`);
    assert.strictEqual(fechaDeVigencia(instanteDeVigencia(f, TZ, 'hasta'), TZ), f, `hasta ${f}`);
  }
});
await t('V', '6. fechas imposibles y rango al revés se rechazan', async () => {
  assert.throws(() => instanteDeVigencia('2026-02-31', TZ, 'hasta'), /inválida/);
  assert.throws(() => normalizarVigencia('2026-10-05', '2026-10-01', TZ), /posterior/);
  assert.deepStrictEqual(normalizarVigencia('', null, TZ), { desde: null, hasta: null });
});

// El incidente, con la fila tal como estaba en producción.
const CHILA = {
  id: '00000000-0000-4000-8000-000000000001', nombre: 'Miercoles de Chilaquiles', tipo: '2x1',
  activa: true, automatica: true, canales: ['pos', 'whatsapp', 'tienda_online'], dias_semana: [3],
  hora_inicio: '00:00:00', hora_fin: '15:00:00', productos: [85], cantidad_requerida: 2,
  cantidad_beneficiada: 1, valor: 0, minimo_compra: 0, usos: 0, acumulable: true, prioridad: 100,
};
const ITEMS_CHILA = [{ producto_id: 85, cantidad: 2, precio_unitario: 195, precio_base: 195, modificadores: [] }];
const MIERCOLES_0814 = new Date('2026-09-30T13:14:00Z');

await t('V', '7. el 30-sep a las 08:14 la promo guardada «hasta el 30» SÍ aplica', async () => {
  const promo = { ...CHILA, vigencia_desde: instanteDeVigencia('2026-09-01', TZ, 'desde'),
    vigencia_hasta: instanteDeVigencia('2026-09-30', TZ, 'hasta') };
  const ev = evaluarPromocionSobrePedido(promo, { items: ITEMS_CHILA, subtotal: 390, timezone: TZ, ahora: MIERCOLES_0814 });
  assert.strictEqual(ev.motivoHorario, null, ev.motivoHorario);
  assert.strictEqual(ev.aplicada.descuento, 195);
});
await t('V', '8. (testigo) guardada como medianoche UTC, el 30 a las 08:14 ya «venció»', async () => {
  const promo = { ...CHILA, vigencia_desde: '2026-09-01T00:00:00Z', vigencia_hasta: '2026-09-30T00:00:00Z' };
  const ev = evaluarPromocionSobrePedido(promo, { items: ITEMS_CHILA, subtotal: 390, timezone: TZ, ahora: MIERCOLES_0814 });
  assert.strictEqual(ev.motivoHorario, 'Esta promoción ya venció');
});
await t('V', '9. el jueves la promo de miércoles sale «fuera de horario», pero con su importe calculado', async () => {
  const ev = evaluarPromocionSobrePedido(CHILA, { items: ITEMS_CHILA, subtotal: 390, timezone: TZ,
    ahora: new Date('2026-10-01T15:00:00Z') });
  assert.strictEqual(ev.motivoHorario, 'Esta promoción no aplica hoy');
  assert.strictEqual(ev.aplicada.descuento, 195);
});
await t('V', '10. un solo chilaquil no completa el 2x1: no aplica, con motivo', async () => {
  const ev = evaluarPromocionSobrePedido(CHILA, { items: [{ ...ITEMS_CHILA[0], cantidad: 1 }], subtotal: 195,
    timezone: TZ, ahora: MIERCOLES_0814 });
  assert.strictEqual(ev.aplicada, null);
  assert.match(ev.motivo, /no tiene productos/);
});

// ════════════════════════════════════════════════════════════════════════════
// Preparación con base y servidor
// ════════════════════════════════════════════════════════════════════════════
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
for (const m of ['pos', 'caja', 'menu']) await fijarModulo(NEG_A, m, 'activo');
await fijarModulo(NEG_B, 'pos', 'activo');

const sufijo = Date.now().toString(36);
const PROD = {};
{
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,988) RETURNING id`,
    [NEG_A, `Promo manual ${sufijo}`]);
  for (const [clave, nombre, precio] of [['chila', `Chila ${sufijo}`, 195], ['agua', `Agua ${sufijo}`, 25]]) {
    const { rows: [p] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
       VALUES ($1,$2,$3,$4,TRUE,FALSE,1) RETURNING id`, [NEG_A, cat.id, nombre, precio]);
    PROD[clave] = p.id;
  }
}

const srv = await arrancarServidor({ PORT: PUERTO, TZ }, { timeoutMs: 90000 });
const BASE = srv.base;
const api = (ruta, opts = {}, ck = ADMIN_A) => fetch(BASE + ruta, {
  ...opts,
  headers: { 'Content-Type': 'application/json', Cookie: ck, ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return {}; } };
const leerFila = async (folio, negocioId = NEG_A) => (await pool.query(
  `SELECT datos, estado FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, negocioId])).rows[0];

// Día de hoy en Matamoros (0 = domingo) para armar una promo «de otro día».
const hoyDia = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())}T12:00:00Z`).getUTCDay();
const otroDia = (hoyDia + 3) % 7;

async function crearPromo(cuerpo) {
  const r = await api('/api/admin/tienda/promociones', { method: 'POST', body: JSON.stringify({
    tipo: '2x1', automatica: false, canales: ['whatsapp'], productos: [PROD.chila],
    cantidadRequerida: 2, cantidadBeneficiada: 1, activa: true, ...cuerpo,
  }) });
  const d = await json(r);
  assert.strictEqual(r.status, 200, `crear promo: ${r.status} ${JSON.stringify(d)}`);
  return d.id;
}
async function crearMostrador(items, ck = ADMIN_A) {
  const r = await api('/api/pedido-presencial', { method: 'POST',
    body: JSON.stringify({ items, nombre: 'Cliente promo manual' }) }, ck);
  const d = await json(r);
  assert.strictEqual(r.status, 200, `crear mostrador: ${r.status} ${JSON.stringify(d)}`);
  return d.pedido.id;
}
const aplicar = (folio, promocionId, ck = STAFF_A, motivo = '') => api(`/api/pedidos/${folio}/promocion`,
  { method: 'POST', body: JSON.stringify({ promocionId, motivo }) }, ck);

let P_HOY, P_OTRO_DIA;
try {

// ─── V (con base): el formulario guarda y relee el día local ───────────────
await t('V', '11. guardar «hasta 2026-09-30» desde el panel escribe el fin del día local', async () => {
  const id = await crearPromo({ nombre: `Vigencia ${sufijo}`, codigo: `VIG${sufijo}`.toUpperCase().slice(0, 20),
    vigenciaDesde: '2026-09-01', vigenciaHasta: '2026-09-30' });
  const { rows: [f] } = await pool.query(
    `SELECT vigencia_desde, vigencia_hasta FROM tienda_promociones WHERE id = $1`, [id]);
  assert.strictEqual(new Date(f.vigencia_desde).toISOString(), '2026-09-01T05:00:00.000Z');
  assert.strictEqual(new Date(f.vigencia_hasta).toISOString(), '2026-10-01T04:59:59.999Z');
  const lista = await json(await api('/api/admin/tienda/promociones'));
  const p = lista.promociones.find(x => x.id === id);
  assert.strictEqual(p.vigenciaDesde, '2026-09-01');
  assert.strictEqual(p.vigenciaHasta, '2026-09-30');
  await pool.query(`DELETE FROM tienda_promociones WHERE id = $1`, [id]);
});

await t('V', '12. la migración 108 corrige filas guardadas a medianoche UTC y es idempotente', async () => {
  const { rows: [f] } = await pool.query(
    `INSERT INTO tienda_promociones (negocio_id, nombre, tipo, codigo, automatica, valor, canales,
       vigencia_desde, vigencia_hasta, activa)
     VALUES ($1,$2,'porcentaje',$3,FALSE,10,'["pos"]','2026-09-01','2026-09-30',FALSE) RETURNING id`,
    [NEG_A, `Legado ${sufijo}`, `LEG${sufijo}`.toUpperCase().slice(0, 20)]);
  const correr = () => execFileSync(process.execPath,
    [join(__dirname, '..', 'scripts', 'predeploy-108-promociones-vigencia-local.mjs')],
    { env: process.env, encoding: 'utf8' });
  correr();
  const leer = async () => (await pool.query(
    `SELECT vigencia_desde, vigencia_hasta FROM tienda_promociones WHERE id = $1`, [f.id])).rows[0];
  const a = await leer();
  assert.strictEqual(new Date(a.vigencia_desde).toISOString(), '2026-09-01T05:00:00.000Z');
  assert.strictEqual(new Date(a.vigencia_hasta).toISOString(), '2026-10-01T04:59:59.999Z');
  correr();
  const b = await leer();
  assert.strictEqual(new Date(b.vigencia_hasta).toISOString(), '2026-10-01T04:59:59.999Z', 'la segunda corrida movió la fila');
  await pool.query(`DELETE FROM tienda_promociones WHERE id = $1`, [f.id]);
});

// ─── M — aplicar a mano ────────────────────────────────────────────────────
P_HOY = await crearPromo({ nombre: `2x1 hoy ${sufijo}`, codigo: `HOY${sufijo}`.toUpperCase().slice(0, 20) });
P_OTRO_DIA = await crearPromo({ nombre: `2x1 otro dia ${sufijo}`, codigo: `OTRO${sufijo}`.toUpperCase().slice(0, 20),
  diasSemana: [otroDia] });

let folioM;
await t('M', '1. el mostrador lista la promo con el importe que le daría a ESTE pedido', async () => {
  folioM = await crearMostrador([{ producto_id: PROD.chila, cantidad: 2 }, { producto_id: PROD.agua, cantidad: 1 }], STAFF_A);
  const d = await json(await api(`/api/pedidos/${folioM}/promociones-aplicables`, {}, STAFF_A));
  assert.strictEqual(d.pedido.motivoNoAdmite, null);
  const hoy = d.promociones.find(p => p.id === P_HOY);
  const otro = d.promociones.find(p => p.id === P_OTRO_DIA);
  assert.strictEqual(hoy.descuento, 195);
  assert.strictEqual(hoy.motivo, null);
  assert.strictEqual(hoy.motivoHorario, null);
  assert.strictEqual(otro.motivoHorario, 'Esta promoción no aplica hoy');
});

await t('M', '2. staff la aplica: total y descuento del servidor, con huella de quién', async () => {
  const r = await aplicar(folioM, P_HOY);
  const d = await json(r);
  assert.strictEqual(r.status, 200, JSON.stringify(d));
  assert.strictEqual(d.descuento, 195);
  const f = await leerFila(folioM);
  assert.strictEqual(Number(f.datos.descuento), 195);
  assert.strictEqual(Number(f.datos.total), 390 + 25 - 195);
  const pr = f.datos.promociones.find(p => p.id === P_HOY);
  assert.strictEqual(pr.manual, true);
  assert.strictEqual(pr.aplicada_por, SEED.staffNegocioAUsuarioId);
  assert.strictEqual(pr.fuera_de_horario, false);
  assert.strictEqual(f.datos.descuentos.promociones[0].monto, 195);
  const { rows } = await pool.query(
    `SELECT monto_descuento FROM tienda_promocion_usos WHERE negocio_id=$1 AND promocion_id=$2 AND pedido_folio=$3`,
    [NEG_A, P_HOY, folioM]);
  assert.strictEqual(rows.length, 1, 'no quedó el uso registrado');
});

await t('M', '3. la misma promoción dos veces: 409 y el total no se mueve', async () => {
  const r = await aplicar(folioM, P_HOY);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(Number((await leerFila(folioM)).datos.total), 220);
});

await t('M', '4. dos clics simultáneos aplican UNA sola vez', async () => {
  const folio = await crearMostrador([{ producto_id: PROD.chila, cantidad: 2 }]);
  const rs = await Promise.all([aplicar(folio, P_HOY), aplicar(folio, P_HOY), aplicar(folio, P_HOY)]);
  assert.deepStrictEqual(rs.map(r => r.status).sort(), [200, 409, 409]);
  const f = await leerFila(folio);
  assert.strictEqual(f.datos.promociones.length, 1);
  assert.strictEqual(Number(f.datos.total), 195);
});

await t('M', '5. fuera de horario: staff recibe 403 y el pedido no cambia', async () => {
  const folio = await crearMostrador([{ producto_id: PROD.chila, cantidad: 2 }]);
  const r = await aplicar(folio, P_OTRO_DIA, STAFF_A, 'me lo pidió el cliente');
  assert.strictEqual(r.status, 403);
  assert.strictEqual((await json(r)).codigo, 'FUERA_DE_HORARIO');
  assert.ok(!(await leerFila(folio)).datos.promociones?.length);
});

await t('M', '6. fuera de horario: admin sin motivo 400; con motivo aplica y queda marcado', async () => {
  const folio = await crearMostrador([{ producto_id: PROD.chila, cantidad: 2 }]);
  const sin = await aplicar(folio, P_OTRO_DIA, ADMIN_A, '');
  assert.strictEqual(sin.status, 400);
  assert.strictEqual((await json(sin)).codigo, 'MOTIVO_REQUERIDO');
  const con = await aplicar(folio, P_OTRO_DIA, ADMIN_A, 'Pedido tomado el miércoles antes del arreglo');
  assert.strictEqual(con.status, 200);
  const pr = (await leerFila(folio)).datos.promociones[0];
  assert.strictEqual(pr.fuera_de_horario, true);
  assert.strictEqual(pr.motivo, 'Pedido tomado el miércoles antes del arreglo');
});

await t('M', '7. productos que no cumplen: 400 NO_APLICA, sin tocar el pedido', async () => {
  const folio = await crearMostrador([{ producto_id: PROD.agua, cantidad: 3 }]);
  const r = await aplicar(folio, P_HOY);
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await json(r)).codigo, 'NO_APLICA');
  assert.strictEqual(Number((await leerFila(folio)).datos.total), 75);
});

await t('M', '8. otro negocio no ve ni toca el pedido', async () => {
  const folio = await crearMostrador([{ producto_id: PROD.chila, cantidad: 2 }]);
  // Por HTTP la sesión cruzada ni siquiera pasa la autenticación…
  assert.ok([403, 404].includes((await api(`/api/pedidos/${folio}/promociones-aplicables`, {}, ADMIN_B)).status));
  assert.ok([403, 404].includes((await aplicar(folio, P_HOY, ADMIN_B)).status));
  // …y el servicio, llamado con el negocio B, tampoco encuentra el pedido de A.
  const { aplicarPromocionManual, listarPromocionesParaPedido } = await import('../src/services/promocionManual.js');
  await assert.rejects(listarPromocionesParaPedido(NEG_B, folio), e => e.status === 404);
  await assert.rejects(aplicarPromocionManual(NEG_B, folio, { promocionId: P_HOY, rol: 'admin', motivo: 'x' }),
    e => e.status === 404);
  assert.ok(!(await leerFila(folio)).datos.promociones?.length);
});

await t('M', '9. promoción de OTRO negocio: 404 aunque el pedido sea propio', async () => {
  const { rows: [pb] } = await pool.query(
    `INSERT INTO tienda_promociones (negocio_id, nombre, tipo, codigo, automatica, valor, canales, productos, activa,
       cantidad_requerida, cantidad_beneficiada)
     VALUES ($1,$2,'2x1',$3,FALSE,0,'["pos"]',$4,TRUE,2,1) RETURNING id`,
    [NEG_B, `Ajena ${sufijo}`, `AJ${sufijo}`.toUpperCase().slice(0, 20), JSON.stringify([PROD.chila])]);
  const folio = await crearMostrador([{ producto_id: PROD.chila, cantidad: 2 }]);
  assert.strictEqual((await aplicar(folio, pb.id, ADMIN_A, 'x')).status, 404);
  await pool.query(`DELETE FROM tienda_promociones WHERE id = $1`, [pb.id]);
});

await t('M', '10. pedido ya cobrado, cancelado o con enlace de pago: 409', async () => {
  const cobrado = await crearMostrador([{ producto_id: PROD.chila, cantidad: 2 }]);
  const rc = await api(`/pedidos/${cobrado}/cobro`, { method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo' }) });
  assert.strictEqual(rc.status, 200);
  assert.strictEqual((await aplicar(cobrado, P_HOY)).status, 409, 'cobrado');

  const cancelado = await crearMostrador([{ producto_id: PROD.chila, cantidad: 2 }]);
  await pool.query(`UPDATE pedidos_activos SET estado='cancelado' WHERE folio=$1 AND negocio_id=$2`, [cancelado, NEG_A]);
  assert.strictEqual((await aplicar(cancelado, P_HOY)).status, 409, 'cancelado');

  const enlace = await crearMostrador([{ producto_id: PROD.chila, cantidad: 2 }]);
  await pool.query(`UPDATE pedidos_activos SET datos = datos || '{"forma_pago":"enlace_pago","pago_confirmado":null}'
    WHERE folio=$1 AND negocio_id=$2`, [enlace, NEG_A]);
  assert.strictEqual((await aplicar(enlace, P_HOY)).status, 409, 'enlace de pago');
});

await t('M', '11. un pedido del POS que entró sin la promo la recibe después (caso XAB-1011)', async () => {
  const r = await api('/api/pos/pedidos', { method: 'POST', body: JSON.stringify({
    tipo: 'recoger', cliente: { nombre: 'Cliente POS', telefono: '8780000011' },
    items: [{ producto_id: PROD.chila, cantidad: 2 }], formaPago: 'efectivo' }) }, STAFF_A);
  const d = await json(r);
  assert.strictEqual(r.status, 200, JSON.stringify(d));
  const folio = d.pedido.id;
  // La promo es solo de WhatsApp: el motor no la aplicó al capturar por POS.
  assert.strictEqual(Number((await leerFila(folio)).datos.descuento || 0), 0);
  const ra = await aplicar(folio, P_HOY);
  assert.strictEqual(ra.status, 200, JSON.stringify(await json(ra)));
  const f = await leerFila(folio);
  assert.strictEqual(Number(f.datos.total), 195);
  assert.strictEqual(Number(f.datos.descuento), 195);
});

// ─── C — cobro del mostrador ───────────────────────────────────────────────
await t('C', '1. el cobro respeta la promo aplicada (antes la borraba del total)', async () => {
  const folio = await crearMostrador([{ producto_id: PROD.chila, cantidad: 2 }, { producto_id: PROD.agua, cantidad: 1 }]);
  assert.strictEqual((await aplicar(folio, P_HOY)).status, 200);
  const r = await api(`/pedidos/${folio}/cobro`, { method: 'PATCH',
    body: JSON.stringify({ forma_pago: 'efectivo', billete: 500 }) }, STAFF_A);
  const d = await json(r);
  assert.strictEqual(r.status, 200, JSON.stringify(d));
  assert.strictEqual(d.total, 220);
  assert.strictEqual(d.cambio, 280);
  const f = await leerFila(folio);
  assert.strictEqual(Number(f.datos.total), 220);
  assert.strictEqual(Number(f.datos.descuento), 195);
  assert.strictEqual(f.datos.descuentos.promociones[0].monto, 195);
  assert.strictEqual(f.datos.descuentos.total, 195);
});

await t('C', '2. promo + descuento manual se suman; el manual no puede pasar lo que queda', async () => {
  const folio = await crearMostrador([{ producto_id: PROD.chila, cantidad: 2 }]);
  assert.strictEqual((await aplicar(folio, P_HOY)).status, 200);
  const excesivo = await api(`/pedidos/${folio}/cobro`, { method: 'PATCH',
    body: JSON.stringify({ forma_pago: 'efectivo', descuento: 200, motivo_descuento: 'cortesía' }) }, ADMIN_A);
  assert.strictEqual(excesivo.status, 400);
  const r = await api(`/pedidos/${folio}/cobro`, { method: 'PATCH',
    body: JSON.stringify({ forma_pago: 'efectivo', descuento: 15, motivo_descuento: 'cortesía' }) }, ADMIN_A);
  const d = await json(r);
  assert.strictEqual(r.status, 200, JSON.stringify(d));
  assert.strictEqual(d.total, 180);
  const f = await leerFila(folio);
  assert.strictEqual(Number(f.datos.descuento), 210);
  assert.strictEqual(f.datos.descuentos.manual.monto, 15);
  assert.strictEqual(f.datos.descuentos.total, 210);
});

await t('C', '3. sin promo el cobro queda igual que siempre (no regresión)', async () => {
  const folio = await crearMostrador([{ producto_id: PROD.chila, cantidad: 1 }]);
  const r = await api(`/pedidos/${folio}/cobro`, { method: 'PATCH',
    body: JSON.stringify({ forma_pago: 'terminal (tarjeta presente)' }) });
  const d = await json(r);
  assert.strictEqual(r.status, 200, JSON.stringify(d));
  assert.strictEqual(d.total, 195);
  assert.strictEqual(Number((await leerFila(folio)).datos.descuento), 0);
});

} finally {
  srv.detener();
  if (P_HOY || P_OTRO_DIA) {
    await pool.query(`DELETE FROM tienda_promocion_usos WHERE promocion_id = ANY($1)`, [[P_HOY, P_OTRO_DIA].filter(Boolean)]).catch(() => {});
    await pool.query(`DELETE FROM tienda_promociones WHERE id = ANY($1)`, [[P_HOY, P_OTRO_DIA].filter(Boolean)]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log(fallos.join('\n')); process.exit(1); }
process.exit(0);
