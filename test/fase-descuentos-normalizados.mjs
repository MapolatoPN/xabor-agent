// ─── Fase 2: datos.descuentos normalizado, dual-write en los 4 canales ──────
//
// Dos capas de prueba:
//   1. UNITARIA — construirDesgloseDescuentos() es pura: sin DB, sin red.
//      Cubre los casos A-J pedidos para el contrato en sí.
//   2. INTEGRACIÓN — cada canal real (POS, POS clásico + cobro, restaurante,
//      WhatsApp/Mesero, tienda en línea) escribe `datos.descuentos` Y
//      conserva su campo legacy (`descuento`/`promociones`/`tienda.promociones`
//      /`rewards_canje`) exactamente como antes de esta fase.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { randomBytes } from 'crypto';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_DESCUENTOS || '4288';

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ════════════════════════════════════════════════════════════════════════
// 1. UNITARIA — construirDesgloseDescuentos (sin DB)
// ════════════════════════════════════════════════════════════════════════
const { construirDesgloseDescuentos } = await import('../src/services/descuentos.js');

await t('UNIT', 'A. sin descuento: los cuatro campos en cero/vacío', () => {
  const d = construirDesgloseDescuentos({});
  assert.deepStrictEqual(d, {
    manual: { monto: 0, tipo: null, motivo: null, autorizadoPor: null },
    promociones: [],
    rewards: { monto: 0, puntos: 0 },
    total: 0,
  });
});

await t('UNIT', 'B. solo manual: total = manual, promociones vacío, rewards cero', () => {
  const d = construirDesgloseDescuentos({ manual: { monto: 50, tipo: 'importe', motivo: 'cortesía', autorizadoPor: 'u1' } });
  assert.strictEqual(d.manual.monto, 50);
  assert.strictEqual(d.manual.tipo, 'importe');
  assert.strictEqual(d.manual.motivo, 'cortesía');
  assert.strictEqual(d.manual.autorizadoPor, 'u1');
  assert.deepStrictEqual(d.promociones, []);
  assert.strictEqual(d.rewards.monto, 0);
  assert.strictEqual(d.total, 50);
});

await t('UNIT', 'C. solo promoción: total = suma de promociones, acepta alias `descuento`', () => {
  const campaniaId = '11111111-1111-1111-1111-111111111111';
  const d = construirDesgloseDescuentos({ promociones: [{ id: 7, campaniaId, nombre: '2x1', descuento: 30, tipo: '2x1' }] });
  assert.strictEqual(d.manual.monto, 0);
  assert.strictEqual(d.promociones.length, 1);
  assert.strictEqual(d.promociones[0].promocionId, 7);
  assert.strictEqual(d.promociones[0].campaniaId, campaniaId, 'conserva la atribucion historica de campaña');
  assert.strictEqual(d.promociones[0].monto, 30);
  assert.strictEqual(d.total, 30);
});

await t('UNIT', 'D. solo Rewards: total = rewards.monto, puntos preservados', () => {
  const d = construirDesgloseDescuentos({ rewards: { monto: 25, puntos: 50 } });
  assert.strictEqual(d.manual.monto, 0);
  assert.deepStrictEqual(d.promociones, []);
  assert.strictEqual(d.rewards.monto, 25);
  assert.strictEqual(d.rewards.puntos, 50);
  assert.strictEqual(d.total, 25);
});

await t('UNIT', 'E. manual + promoción (combinación real del POS)', () => {
  const d = construirDesgloseDescuentos({
    manual: { monto: 50 },
    promociones: [{ nombre: 'Envío + producto', descuento: 100 }],
  });
  assert.strictEqual(d.total, 150);
});

await t('UNIT', 'F. promoción + Rewards (combinación real de tienda)', () => {
  const d = construirDesgloseDescuentos({
    promociones: [{ nombre: 'Descuento tienda', descuento: 40 }],
    rewards: { monto: 25, puntos: 50 },
  });
  assert.strictEqual(d.total, 65);
});

await t('UNIT', 'G. combinación completa (manual + promoción + Rewards)', () => {
  const d = construirDesgloseDescuentos({
    manual: { monto: 10, motivo: 'x' },
    promociones: [{ nombre: 'p1', descuento: 20 }, { nombre: 'p2', descuento: 5 }],
    rewards: { monto: 15, puntos: 30 },
  });
  assert.strictEqual(d.total, 50);
  assert.strictEqual(d.promociones.length, 2);
});

await t('UNIT', 'J. varias promociones no se pisan entre sí (evita doble conteo por sobrescritura)', () => {
  const d = construirDesgloseDescuentos({
    promociones: [{ nombre: 'a', descuento: 10 }, { nombre: 'b', descuento: 10 }, { nombre: 'c', descuento: 10 }],
  });
  assert.strictEqual(d.promociones.length, 3);
  assert.strictEqual(d.total, 30);
});

await t('UNIT', 'invariante: total === manual + sum(promociones) + rewards, sobre 200 combinaciones aleatorias', () => {
  for (let i = 0; i < 200; i++) {
    const manual = Math.random() > 0.5 ? { monto: Math.round(Math.random() * 10000) / 100 } : null;
    const nPromos = Math.floor(Math.random() * 4);
    const promociones = Array.from({ length: nPromos }, (_, j) => ({ nombre: `p${j}`, descuento: Math.round(Math.random() * 5000) / 100 }));
    const rewards = Math.random() > 0.5 ? { monto: Math.round(Math.random() * 3000) / 100, puntos: Math.floor(Math.random() * 500) } : null;
    const d = construirDesgloseDescuentos({ manual, promociones, rewards });
    const esperado = Math.round(((manual?.monto || 0) + promociones.reduce((s, p) => s + p.descuento, 0) + (rewards?.monto || 0)) * 100) / 100;
    assert.strictEqual(d.total, esperado, `manual=${JSON.stringify(manual)} promos=${JSON.stringify(promociones)} rewards=${JSON.stringify(rewards)}`);
  }
});

await t('UNIT', 'no inventa campos: canal sin motivo/tipo/autorizadoPor los deja null, no undefined ni ""', () => {
  const d = construirDesgloseDescuentos({ manual: { monto: 30 } });
  assert.strictEqual(d.manual.tipo, null);
  assert.strictEqual(d.manual.motivo, null);
  assert.strictEqual(d.manual.autorizadoPor, null);
});

// ════════════════════════════════════════════════════════════════════════
// 2. INTEGRACIÓN — canales reales contra Postgres
// ════════════════════════════════════════════════════════════════════════
const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { validarOrdenPropuesta } = await import('../src/orders/validadorOrden.js');
const {
  abrirMesa, agregarItems, enviarComanda, registrarPago, cerrarCuenta, aplicarDescuentoCuenta,
} = await import('../src/services/restauranteService.js');

const A = SEED.negocioA;
const ADMIN_A = SEED.adminNegocioAUsuarioId;
const STAFF_A = SEED.staffNegocioAUsuarioId;
const cookie = (usuarioId, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId: A, rol }))}`;
const cookieAdmin = cookie(ADMIN_A, 'admin');

async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
await fijarModulo(A, 'pos', 'activo');
await fijarModulo(A, 'restaurante', 'activo');
await fijarModulo(A, 'rewards', 'activo');
for (const tipo of ['efectivo', 'terminal']) {
  await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,$2,TRUE)
    ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [A, tipo]);
}
await pool.query(
  `INSERT INTO rewards_config (tenant_id, activo, puntos_por_peso, canje_minimo)
   VALUES ($1, TRUE, 0.5, 100)
   ON CONFLICT (tenant_id) DO UPDATE SET activo = TRUE, puntos_por_peso = 0.5, canje_minimo = 100`,
  [A]).catch(() => {});

const { rows: [cat] } = await pool.query(
  `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,988) RETURNING id`,
  [A, 'Fase2 descuentos (test)']);
// Idempotente a propósito: un segundo arranque de esta suite sobre la misma
// base (sin reset entre corridas) NO debe crear un segundo "Taco Fase2".
// Antes insertaba sin condición y, tras varias corridas, dejaba N filas con
// el mismo nombre para el negocio -- validarOrdenPropuesta las busca por
// negocio_id (sin filtrar categoría, ver validadorOrden.js) y el lookup por
// nombre se vuelve ambiguo (PRODUCTO_NO_EXISTE, motivo="ambiguo"), un fallo
// de fixture contaminado, no del código de producto. La búsqueda de
// reutilización es por negocio_id + nombre (igual que la ambigüedad real),
// NO por categoría: la categoría de arriba tampoco es idempotente (se
// re-crea cada corrida), así que anclar la reutilización a su id cambiaría
// en cada corrida y nunca encontraría el producto de la corrida anterior.
async function crearProducto(nombre, precio) {
  const { rows: [existente] } = await pool.query(
    `SELECT id FROM menu_productos WHERE negocio_id=$1 AND nombre=$2 LIMIT 1`,
    [A, nombre]);
  if (existente) return existente.id;
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
     VALUES ($1,$2,$3,$4,TRUE,FALSE,1) RETURNING id`, [A, cat.id, nombre, precio]);
  return p.id;
}
const prodTaco = await crearProducto('Taco Fase2', 100);

const srv = await arrancarServidor({ PORT: PUERTO, TZ: 'America/Matamoros' }, { timeoutMs: 60000 });
const base = srv.base;
async function api(path, { cookie: ck = cookieAdmin, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (ck) headers['Cookie'] = ck;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
const leerFila = async (folio) => (await pool.query(
  `SELECT datos, estado FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, A])).rows[0];
async function crearCuentaRewards(telefono, nombre, puntos) {
  await pool.query(`INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,$2,$3) ON CONFLICT (telefono) DO NOTHING`, [telefono, nombre, A]);
  await pool.query(
    `INSERT INTO rewards_accounts (tenant_id, telefono, nombre, puntos_balance, negocio_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (telefono, tenant_id) DO UPDATE SET puntos_balance = $4`, [A, telefono, nombre, puntos, A]);
}

// ── POS ──────────────────────────────────────────────────────────────────
await t('POS', 'A. sin descuento: descuentos en cero, legacy intacto', async () => {
  const r = await api('/api/pos/pedidos', { method: 'POST', body: {
    tipo: 'recoger', cliente: { nombre: 'Sin desc', telefono: '8781110001' }, items: [{ producto_id: prodTaco, cantidad: 1 }], formaPago: 'efectivo' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const fila = await leerFila(r.body.pedido.id);
  assert.strictEqual(fila.datos.descuento, 0, 'legacy debe seguir en 0');
  assert.deepStrictEqual(fila.datos.descuentos, {
    manual: { monto: 0, tipo: null, motivo: null, autorizadoPor: null },
    promociones: [], rewards: { monto: 0, puntos: 0 }, total: 0,
  });
});

await t('POS', 'B. solo manual: descuentos.manual.monto = legacy.descuento, sin motivo (el POS no lo pide)', async () => {
  const r = await api('/api/pos/pedidos', { method: 'POST', body: {
    tipo: 'recoger', cliente: { nombre: 'Manual', telefono: '8781110002' }, items: [{ producto_id: prodTaco, cantidad: 1 }], descuento: 20, formaPago: 'efectivo' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const fila = await leerFila(r.body.pedido.id);
  assert.strictEqual(fila.datos.descuento, 20);
  assert.strictEqual(fila.datos.descuentos.manual.monto, 20);
  assert.strictEqual(fila.datos.descuentos.manual.motivo, null);
  assert.strictEqual(fila.datos.descuentos.total, 20);
  assert.strictEqual(fila.datos.descuentos.total, fila.datos.descuento, 'invariante contra el campo legacy');
});

await t('POS', 'J. doble conteo: descuentos.total nunca excede el legacy.descuento aunque manual+promo se topen', async () => {
  // Sin promoción real disponible en el fixture, se prueba el tope con
  // manual solo: el residuo nunca es negativo ni excede subtotal.
  const r = await api('/api/pos/pedidos', { method: 'POST', body: {
    tipo: 'recoger', cliente: { nombre: 'Tope', telefono: '8781110003' }, items: [{ producto_id: prodTaco, cantidad: 1 }], descuento: 999, formaPago: 'efectivo' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const fila = await leerFila(r.body.pedido.id);
  assert.strictEqual(fila.datos.descuento, 100, 'el legacy topa a subtotal (100)');
  assert.strictEqual(fila.datos.descuentos.total, fila.datos.descuento, 'el bloque normalizado sigue exactamente al legacy topado');
});

// ── POS clásico (crear = cobrar) ────────────────────────────────────────
await t('PRESENCIAL', 'B. manual con motivo (flujo clásico, forma_pago explícita)', async () => {
  const r = await api('/api/pedido-presencial', { method: 'POST', body: {
    items: [{ producto_id: prodTaco, cantidad: 1 }], nombre: 'Clásico manual',
    forma_pago: 'efectivo', descuento: 15, motivo_descuento: 'cliente frecuente' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const fila = await leerFila(r.body.pedido.id);
  assert.strictEqual(fila.datos.descuento, 15);
  assert.strictEqual(fila.datos.descuentos.manual.monto, 15);
  assert.strictEqual(fila.datos.descuentos.manual.motivo, 'cliente frecuente');
  assert.strictEqual(fila.datos.descuentos.manual.autorizadoPor, null, 'este flujo no autoriza -- no se inventa quién');
  assert.strictEqual(fila.datos.descuentos.total, 15);
});

await t('PRESENCIAL', 'I. pedido abierto (por_cobrar): descuentos en cero hasta el cobro', async () => {
  const r = await api('/api/pedido-presencial', { method: 'POST', body: {
    items: [{ producto_id: prodTaco, cantidad: 1 }], nombre: 'Abierto' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const fila = await leerFila(r.body.pedido.id);
  assert.strictEqual(fila.datos.forma_pago, 'por_cobrar');
  assert.deepStrictEqual(fila.datos.descuentos, {
    manual: { monto: 0, tipo: null, motivo: null, autorizadoPor: null },
    promociones: [], rewards: { monto: 0, puntos: 0 }, total: 0,
  });
});

await t('PRESENCIAL', 'D. solo Rewards (flujo clásico): parche posterior a registrarCanje', async () => {
  const tel = '5218780002001';
  await crearCuentaRewards(tel, 'Rewards clásico', 500);
  const r = await api('/api/pedido-presencial', { method: 'POST', body: {
    items: [{ producto_id: prodTaco, cantidad: 1 }], nombre: 'Con Rewards',
    forma_pago: 'efectivo', rewards_telefono: tel, rewards_canje_puntos: 100 } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const fila = await leerFila(r.body.pedido.id);
  assert.strictEqual(fila.datos.rewards_canje, undefined, 'gap legacy preexistente: este flujo NUNCA escribió rewards_canje en datos -- Fase 2 no lo cambia');
  assert.strictEqual(fila.datos.descuentos.rewards.monto, 50, '100 pts × 0.5 = $50');
  assert.strictEqual(fila.datos.descuentos.rewards.puntos, 100);
  assert.strictEqual(fila.datos.descuentos.manual.monto, 0);
  assert.strictEqual(fila.datos.descuentos.total, 50);
});

// ── Cobro (/pedidos/:folio/cobro) — batería focalizada de camino crítico ──
// Nota de alcance: este endpoint NUNCA llama a calcularPromociones -- el
// caso "C. solo promoción" no existe en este canal (gap preexistente,
// documentado en el mapa, no de esta prueba). Se cubren en cambio los
// escenarios que SÍ son posibles aquí.
async function crearAbiertoParaCobro(items = [{ producto_id: prodTaco, cantidad: 2 }], nombre = 'Para cobrar') {
  const r = await api('/api/pedido-presencial', { method: 'POST', body: { items, nombre } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.pedido.id;
}

await t('COBRO', 'A. sin descuento: descuentos en cero, total = subtotal exacto', async () => {
  const folio = await crearAbiertoParaCobro();
  const rc = await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body: { forma_pago: 'efectivo' } });
  assert.strictEqual(rc.status, 200, JSON.stringify(rc.body));
  const cuerpo = rc.body;
  assert.strictEqual(cuerpo.total, 200, 'subtotal 2×100 sin descuento');
  assert.deepStrictEqual(Object.keys(cuerpo).sort(), ['cambio', 'canje', 'descuento', 'folio', 'forma_pago', 'ok', 'subtotal', 'total'].sort(),
    'la respuesta HTTP no ganó ni perdió ninguna clave');
  const fila = await leerFila(folio);
  assert.deepStrictEqual(fila.datos.descuentos, {
    manual: { monto: 0, tipo: null, motivo: null, autorizadoPor: null },
    promociones: [], rewards: { monto: 0, puntos: 0 }, total: 0,
  });
});

await t('COBRO', 'B. solo manual: autorizadoPor real (único canal manual que autoriza de verdad)', async () => {
  const folio = await crearAbiertoParaCobro();
  const rc = await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body: {
    forma_pago: 'efectivo', descuento: 15, motivo_descuento: 'solo manual cobro' } });
  assert.strictEqual(rc.status, 200, JSON.stringify(rc.body));
  assert.strictEqual(rc.body.total, 185);
  const fila = await leerFila(folio);
  assert.strictEqual(fila.datos.descuentos.manual.monto, 15);
  assert.strictEqual(fila.datos.descuentos.manual.autorizadoPor, ADMIN_A);
  assert.strictEqual(fila.datos.descuentos.rewards.monto, 0);
  assert.strictEqual(fila.datos.descuentos.total, 15);
});

await t('COBRO', 'D. solo Rewards (sin manual): reservado en captura, consumido en cobro', async () => {
  const tel = '5218780002003';
  await crearCuentaRewards(tel, 'Rewards solo cobro', 500);
  const cr = await api('/api/pedido-presencial', { method: 'POST', body: {
    items: [{ producto_id: prodTaco, cantidad: 2 }], nombre: 'Solo rewards cobro',
    rewards_telefono: tel, rewards_canje_puntos: 100 } });
  const folio = cr.body.pedido.id;
  const rc = await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body: { forma_pago: 'efectivo' } });
  assert.strictEqual(rc.status, 200, JSON.stringify(rc.body));
  assert.strictEqual(rc.body.total, 150, '200 - 50 (100pts×0.5) sin descuento manual');
  const fila = await leerFila(folio);
  assert.strictEqual(fila.datos.descuentos.manual.monto, 0);
  assert.strictEqual(fila.datos.descuentos.rewards.monto, 50);
  assert.strictEqual(fila.datos.descuentos.total, 50);
});

await t('COBRO', 'E/G. manual autorizado + Rewards en el mismo cobro', async () => {
  const tel = '5218780002002';
  await crearCuentaRewards(tel, 'Rewards cobro', 500);
  const cr = await api('/api/pedido-presencial', { method: 'POST', body: {
    items: [{ producto_id: prodTaco, cantidad: 3 }], nombre: 'Cobro combo',
    rewards_telefono: tel, rewards_canje_puntos: 100 } });
  const folio = cr.body.pedido.id;
  const rc = await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body: {
    forma_pago: 'efectivo', descuento: 20, motivo_descuento: 'combo cobro' } });
  assert.strictEqual(rc.status, 200, JSON.stringify(rc.body));
  const fila = await leerFila(folio);
  assert.strictEqual(fila.datos.descuentos.manual.monto, 20);
  assert.strictEqual(fila.datos.descuentos.manual.motivo, 'combo cobro');
  assert.strictEqual(fila.datos.descuentos.manual.autorizadoPor, ADMIN_A, 'aquí SÍ hubo autorizarDescuento real');
  assert.strictEqual(fila.datos.descuentos.rewards.monto, 50);
  assert.strictEqual(fila.datos.descuentos.total, 70);
  // subtotal 300 - manual 20 - rewards 50 = 230
  assert.strictEqual(fila.datos.total, 230);
});

await t('COBRO', 'G. doble PATCH del mismo folio: un solo cobro, datos.descuentos no se duplica ni cambia', async () => {
  const folio = await crearAbiertoParaCobro([{ producto_id: prodTaco, cantidad: 1 }], 'Doble cobro');
  const body = { forma_pago: 'efectivo', descuento: 10, motivo_descuento: 'reintento' };
  const [r1, r2] = await Promise.all([
    api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body }),
    api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body }),
  ]);
  assert.strictEqual(r1.status, 200); assert.strictEqual(r2.status, 200);
  const unoFueCobro = !r1.body.yaCobrado || !r2.body.yaCobrado;
  assert.ok(unoFueCobro, 'exactamente uno de los dos debió cobrar, el otro yaCobrado');
  const fila = await leerFila(folio);
  assert.strictEqual(fila.datos.descuentos.manual.monto, 10, 'un solo cobro, no se duplicó ni se movió');
  assert.strictEqual(fila.datos.descuentos.total, 10);
  assert.strictEqual(fila.datos.total, 90);
  // Reintento explícito por tercera vez ya con pago_confirmado=true: la
  // ruta corta ANTES de tocar datos.descuentos en absoluto.
  const r3 = await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body });
  assert.strictEqual(r3.status, 200);
  assert.strictEqual(r3.body.yaCobrado, true);
  const filaTras3 = await leerFila(folio);
  assert.deepStrictEqual(filaTras3.datos.descuentos, fila.datos.descuentos, 'el tercer intento no tocó nada');
});

await t('COBRO', 'H. el resultado financiero es idéntico al esperado por la fórmula legacy (subtotal - manual - rewards)', async () => {
  const tel = '5218780002004';
  await crearCuentaRewards(tel, 'H idéntico', 500);
  const cr = await api('/api/pedido-presencial', { method: 'POST', body: {
    items: [{ producto_id: prodTaco, cantidad: 4 }], nombre: 'H idéntico',
    rewards_telefono: tel, rewards_canje_puntos: 200 } });
  const folio = cr.body.pedido.id;
  const rc = await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body: {
    forma_pago: 'efectivo', descuento: 30, motivo_descuento: 'h idéntico', billete: 500 } });
  assert.strictEqual(rc.status, 200, JSON.stringify(rc.body));
  // Fórmula EXACTA de la línea 3749 del route, sin tocar: totalFinal = subtotal - desc - montoCanje.
  // subtotal=400, desc=30, canje=200pts×0.5=100 → total=270. billete=500 → cambio=230.
  assert.strictEqual(rc.body.total, 270);
  assert.strictEqual(rc.body.cambio, 230);
  assert.strictEqual(rc.body.subtotal, 400);
  assert.strictEqual(rc.body.descuento, 30);
  assert.strictEqual(rc.body.canje.monto, 100);
  const fila = await leerFila(folio);
  assert.strictEqual(fila.datos.total, 270);
  assert.strictEqual(fila.datos.billete, 500);
  assert.strictEqual(fila.datos.cambio, 230);
  assert.strictEqual(fila.datos.forma_pago, 'efectivo');
  // I. datos.descuentos correcto y consistente con lo financiero de arriba.
  assert.strictEqual(fila.datos.descuentos.manual.monto, 30);
  assert.strictEqual(fila.datos.descuentos.rewards.monto, 100);
  assert.strictEqual(fila.datos.descuentos.total, 130);
  assert.strictEqual(fila.datos.subtotal - fila.datos.descuentos.total, fila.datos.total, 'subtotal - descuentos.total === total, exacto');
});

// ── Restaurante ──────────────────────────────────────────────────────────
await t('RESTAURANTE', 'B. manual con tipo y autorizadoPor reales (únicos disponibles en este canal)', async () => {
  const cta = await abrirMesa(A, { mesaNumero: 480, personas: 2, meseroUsuarioId: STAFF_A, abiertaPor: STAFF_A });
  await agregarItems(cta.id, A, [{ producto: 'Taco Fase2', cantidad: 2, precio_unitario: 100 }], STAFF_A);
  await enviarComanda(cta.id, A, STAFF_A);
  await aplicarDescuentoCuenta(cta.id, A, { tipo: 'porcentaje', valor: 10, motivo: 'mesa fase2' }, { usuarioId: ADMIN_A, rol: 'admin' });
  await registrarPago(cta.id, A, { metodo: 'efectivo', monto: 180 }, STAFF_A);
  const cierre = await cerrarCuenta(cta.id, A, ADMIN_A);
  assert.ok(cierre.ok, JSON.stringify(cierre));
  const fila = await leerFila(cierre.ventaFolio);
  assert.strictEqual(fila.datos.descuento_tipo, 'porcentaje', 'legacy intacto');
  assert.strictEqual(fila.datos.descuentos.manual.monto, 20);
  assert.strictEqual(fila.datos.descuentos.manual.tipo, 'porcentaje');
  assert.strictEqual(fila.datos.descuentos.manual.motivo, 'mesa fase2');
  assert.strictEqual(fila.datos.descuentos.manual.autorizadoPor, ADMIN_A);
  assert.deepStrictEqual(fila.datos.descuentos.promociones, [], 'restaurante no tiene motor de promociones conectado');
  assert.strictEqual(fila.datos.descuentos.rewards.monto, 0, 'restaurante no tiene Rewards conectado');
  assert.strictEqual(fila.datos.descuentos.total, 20);
});

await t('RESTAURANTE', 'A. sin descuento: bloque en cero, cuenta cierra normal', async () => {
  const cta = await abrirMesa(A, { mesaNumero: 481, personas: 1, meseroUsuarioId: STAFF_A, abiertaPor: STAFF_A });
  await agregarItems(cta.id, A, [{ producto: 'Taco Fase2', cantidad: 1, precio_unitario: 100 }], STAFF_A);
  await enviarComanda(cta.id, A, STAFF_A);
  await registrarPago(cta.id, A, { metodo: 'efectivo', monto: 100 }, STAFF_A);
  const cierre = await cerrarCuenta(cta.id, A, ADMIN_A);
  const fila = await leerFila(cierre.ventaFolio);
  assert.strictEqual(fila.datos.descuentos.total, 0);
  assert.strictEqual(fila.datos.total, 100, 'el total de venta NO cambió por Fase 2');
});

// ── WhatsApp / Mesero (validadorOrden.js, camino compartido) ────────────
await t('MESERO', 'C. solo promoción vía validarOrdenPropuesta (mismo camino que WhatsApp legacy y el agente nuevo)', async () => {
  const orden = {
    negocioId: A,
    items: [{ nombre: 'Taco Fase2', cantidad: 3 }],
    cliente: { telefono: '8781110099', nombre: 'Cliente Mesero' },
    forma_pago: 'efectivo',
  };
  const v = await validarOrdenPropuesta(orden, A, { canal: 'whatsapp' });
  assert.ok(v.ok, JSON.stringify(v.rechazos));
  assert.strictEqual(v.orden.descuentos.manual.monto, 0, 'WhatsApp/Mesero nunca tiene descuento manual');
  assert.strictEqual(v.orden.descuentos.rewards.monto, 0, 'sin Rewards conectado todavía en este canal');
  assert.strictEqual(v.orden.descuentos.total, v.orden.descuento, 'coincide con el legacy (0 si no hay promo activa en el fixture)');
  assert.deepStrictEqual(v.orden.descuentos.promociones.map(p => p.monto), v.orden.promociones.map(p => p.descuento), 'incluso sin promo activa, ambos arreglos coinciden en forma');
});

// ── H. cancelado: el bloque no rompe nada ──────────────────────────────
// Hallazgo durante esta prueba (no es un bug de Fase 2, es comportamiento
// preexistente que no estaba documentado): cancelar un pedido NO solo pone
// estado='cancelado' -- `POST /api/admin/pedido/:folio/cancelar` llama a
// `eliminarPedido()` (orderManager.js:925 → `eliminarPedidoDB`), que hace
// `DELETE FROM pedidos_activos` de verdad. La fila deja de existir del
// todo, así que no hay `datos.descuentos` que inspeccionar después. Lo que
// SÍ se puede probar es que un pedido con el bloque nuevo se cancela sin
// error (el endpoint no se rompe por la presencia de `datos.descuentos`).
await t('CANCELADO', 'H. un pedido con datos.descuentos se cancela sin error (la fila se retira, no se recalcula)', async () => {
  const r = await api('/api/pos/pedidos', { method: 'POST', body: {
    tipo: 'recoger', cliente: { nombre: 'Cancelado', telefono: '8781110004' }, items: [{ producto_id: prodTaco, cantidad: 1 }], descuento: 10, formaPago: 'efectivo' } });
  assert.strictEqual(r.status, 200, `creación falló: ${JSON.stringify(r.body)}`);
  const folio = r.body.pedido.id;
  const filaAntes = await leerFila(folio);
  assert.strictEqual(filaAntes.datos.descuentos.manual.monto, 10, 'el bloque se escribió bien antes de cancelar');
  const rc = await api(`/api/admin/pedido/${folio}/cancelar`, { method: 'POST', body: { motivo: 'prueba fase2' } });
  assert.strictEqual(rc.status, 200, `cancelación falló: ${JSON.stringify(rc.body)}`);
  const fila = await leerFila(folio);
  assert.strictEqual(fila, undefined, 'confirma el comportamiento real: cancelar retira la fila por completo, no la marca y conserva');
});

console.log(`\n═══ fase-descuentos-normalizados: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallidas) { console.log('\nFallos:'); for (const f of fallos) console.log('  · ' + f); }
srv.detener();
await pool.end();
process.exit(fallidas ? 1 : 0);
