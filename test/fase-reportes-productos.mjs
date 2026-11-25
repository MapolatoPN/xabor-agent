// ─── Fase 3: Reportes → Productos y el detalle de Ventas ────────────────────
//
// Contra una COPIA local test_botones_* con la 161 (nunca producción). Lo que
// se protege:
//   A. Reglas sin base: el reparto al centavo, el cuadre (productos + otros +
//      envíos + sin desglose − descuentos = venta neta), los filtros, las
//      franjas, la forma de pago con las reglas de la Caja y el usuario.
//   B. Con Postgres y el servidor de verdad:
//      · el cuadre da la MISMA venta neta que /api/reportes/ventas;
//      · productos, categorías, opciones, combinaciones, pares, sin
//        movimiento, por franja y la comparación con el periodo anterior;
//      · el registro de la Fase 2 viejo o ausente va a «Sin desglose»;
//      · el día se corta en la zona del negocio;
//      · filtros de canal, modalidad, día y franja;
//      · multi-negocio: cada negocio ve lo suyo; «Todas» son solo las
//        sucursales donde el MISMO usuario es administrador, con la bandera;
//        una sucursal ajena por id da 403;
//      · sin la bandera, 403 y Ventas igual que antes;
//      · solo administradores.
//
// Uso: correr-suite.ps1 -Suite fase-reportes-productos -Plantilla <tpl con la 161>
import assert from 'node:assert/strict';
import { arrancarServidor } from './lib-servidor.mjs';

{
  const url = new URL(process.env.DATABASE_URL);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'solo base local');
  assert.match(url.pathname, /^\/test_botones_/, 'solo una base test_botones_*');
}
const PUERTO = process.env.TEST_PORT_REPPROD || '4987';
const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const RP = await import('../src/services/reporteProductos.js');
const RVD = await import('../src/services/reporteVentasDetalle.js');
const { procesarNegocio } = await import('../src/services/lineasEstructuradasProceso.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function t(cat, nombre, fn) {
  if (SOLO.length && !SOLO.some((p) => nombre.startsWith(p))) return;
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 300)} · esperado=${JSON.stringify(e.expected)?.slice(0, 200)}` : '';
    const linea = `[${cat}] ${nombre}: ${String(e?.message || e).split('\n')[0]}${detalle}`;
    console.log(`FALLO ${linea}`); fallos.push(linea);
  }
}
const c = (n) => Math.round(Number(n) * 100);

// ─── A. Reglas, sin base ────────────────────────────────────────────────────
await t('REGLA', '1. el reparto proporcional suma exacto, nunca deja negativos y avisa lo que no cupo', async () => {
  assert.deepEqual(RP.repartirProporcional([100, 300], 40), { partes: [10, 30], sinRepartir: 0 });
  assert.deepEqual(RP.repartirProporcional([1, 1, 1], 2), { partes: [1, 1, 0], sinRepartir: 0 });
  const r = RP.repartirProporcional([333, 333, 334], 1001);
  assert.equal(r.partes.reduce((s, x) => s + x, 0), 1001);
  assert.deepEqual(RP.repartirProporcional([100, 300], -1000), { partes: [-100, -300], sinRepartir: -600 },
    'una línea no baja de cero; lo que sobra se dice');
  assert.deepEqual(RP.repartirProporcional([0, 0], 50), { partes: [0, 0], sinRepartir: 50 }, 'sin base, todo sin repartir');
});

const lineaDe = (producto_id, nombre, tipo, cantidad, precio_unitario, modificadores = []) => ({ producto_id, nombre, tipo, cantidad, precio_unitario, modificadores });
await t('REGLA', '2. el cuadre cierra al centavo con envíos, otros, toppings de Rappi, sin registro y descuentos', async () => {
  const ventas = [
    { folio: 'Q1', estado: 'entregado', creado_at: '2026-11-10T14:00:00Z', registro: 'vigente',
      datos: { total: 0.3, subtotal: 0.2, costo_envio: 0.1, canal: 'pos', items: [{}, {}] } },
    { folio: 'Q2', estado: 'entregado', creado_at: '2026-11-10T15:00:00Z', registro: 'vigente',
      datos: { total: 99.99, subtotal: 99.99, canal: 'rappi', items: [{}] } },
    { folio: 'Q3', estado: 'entregado', creado_at: '2026-11-10T15:00:00Z', registro: 'viejo',
      datos: { total: 50, subtotal: 60, descuento: 10, canal: 'pos', items: [{}] } },
    { folio: 'Q4', estado: 'cancelado', creado_at: '2026-11-10T15:00:00Z', registro: 'vigente', datos: { total: 1000, subtotal: 1000, items: [{}] } },
    { folio: 'Q5', estado: 'entregado', creado_at: '2026-11-10T15:00:00Z', registro: 'vigente',
      datos: { total: 70, subtotal: 70, forma_pago: 'por_cobrar', canal: 'pos', items: [{}] } },
  ];
  const lineas = new Map([
    ['Q1', [lineaDe(1, 'Taco', 'platillo', 1, 0.1), lineaDe(9, 'Bolsa', 'otro', 1, 0.1)]],
    ['Q2', [lineaDe(1, 'Taco', 'platillo', 3, 11.11), lineaDe(2, 'Agua', 'bebida', 1, 33.33)]],
    ['Q4', [lineaDe(1, 'Taco', 'platillo', 100, 10)]],
  ]);
  const r = RP.construirReporteProductos({ fuentes: [{ negocio: { id: 'n', nombre: 'N' }, tz: 'America/Matamoros',
    catalogo: [{ id: 1, nombre: 'Taco', disponible: true }, { id: 2, nombre: 'Agua', tipo: 'bebida', disponible: true }],
    actual: { ventas, lineas }, anterior: null }] });
  const k = r.cuadre;
  assert.equal(k.cuadra, true);
  assert.equal(c(k.productos) + c(k.otros) + c(k.envios) + c(k.sin_desglose) - c(k.descuentos), c(k.venta_neta));
  assert.equal(k.venta_neta, 150.29, 'solo ventas: ni el cancelado ni el por cobrar');
  assert.equal(k.tickets, 3);
  assert.deepEqual(k.sin_registro, { ventas: 1, monto: 60 }, 'el registro viejo no se adivina');
  assert.equal(k.otros, 0.1);
  assert.equal(c(r.productos.reduce((s, p) => s + c(p.venta), 0) / 100), c(k.productos), 'Σ tabla = productos del cuadre');
  assert.equal(k.repartido, 33.33, '99.99 − 66.66 se reparte entre Taco y Agua de esa venta');
  assert.equal(r.productos.reduce((s, p) => s + p.pct_venta, 0).toFixed(1), '100.0');
  assert.deepEqual(r.fuera_del_reporte, { cancelado: 1, por_cobrar: 1, sin_consumo: 0 });
});

await t('REGLA', '3. filtros: lo válido pasa, lo raro da error con mensaje', async () => {
  assert.deepEqual(RP.filtrosDeReporte({}), { filtros: { canal: null, modalidad: null, dia: null, franja: null }, minimo: 3 });
  assert.deepEqual(RP.filtrosDeReporte({ canal: 'otro:uber eats', modalidad: 'mesa', dia: '0', franja: '13-15', minimo: '7' }),
    { filtros: { canal: 'otro:uber eats', modalidad: 'mesa', dia: 0, franja: '13-15' }, minimo: 7 });
  for (const q of [{ canal: "x' OR 1=1" }, { modalidad: 'avion' }, { dia: '7' }, { franja: '15-17' }, { minimo: '0' }, { minimo: 'mil' }]) {
    assert.ok(RP.filtrosDeReporte(q).error, `${JSON.stringify(q)} no dio error`);
  }
  assert.deepEqual([6, 7, 8, 9, 12, 13, 14, 15, 23].map(RP.franjaDeHora), ['otras', '7-9', '7-9', '9-11', '11-13', '13-15', '13-15', 'otras', 'otras']);
  assert.equal(RP.modalidadDe({ modalidad: 'entrega a domicilio' }), 'domicilio');
  assert.equal(RP.modalidadDe({ modalidad: 'recoger en tienda' }), 'recoger');
  assert.equal(RP.modalidadDe({ canal: 'restaurante_mesa', modalidad: '' }), 'mesa');
  assert.equal(RP.modalidadDe({}), 'otra');
});

await t('REGLA', '4. forma de pago con las reglas de la Caja: mixto repartido, Rappi a Plataformas, Σ = venta neta', async () => {
  const filas = [
    { folio: 'F1', estado: 'entregado', datos: { total: 100, forma_pago: 'efectivo' } },
    { folio: 'F2', estado: 'entregado', datos: { total: 80, forma_pago: 'terminal (tarjeta presente)' } },
    { folio: 'F3', estado: 'entregado', datos: { total: 145, canal: 'rappi' } },
    { folio: 'F4', estado: 'entregado', datos: { total: 180, forma_pago: 'mixto', pagos: [{ metodo: 'efectivo', monto: 100 }, { metodo: 'terminal', monto: 80 }] } },
    { folio: 'F5', estado: 'entregado', datos: { total: 50, forma_pago: 'mixto', mixto_terminal: 20 } },
    { folio: 'F6', estado: 'entregado', datos: { total: 70, forma_pago: 'enlace de pago' } },
    { folio: 'F7', estado: 'cancelado', datos: { total: 999, forma_pago: 'efectivo' } },
  ];
  const r = RVD.ventaPorFormaDePago(filas, null);
  const por = Object.fromEntries(r.clases.map((x) => [x.clase, x.venta]));
  assert.deepEqual(por, { efectivo: 230, tarjeta: 180, enlace: 70, plataformas: 145 });
  assert.equal(c(r.clases.reduce((s, x) => s + c(x.venta), 0) / 100), c(r.venta_neta));
  assert.equal(r.venta_neta, 625);
  assert.equal(r.cobros_mixtos, 2);
  // Un mixto cuyas partes quedan a un centavo del total (dentro de la tolerancia
  // de la Caja): el centavo va a la parte mayor y Σ sigue siendo la venta neta.
  const m = RVD.ventaPorFormaDePago([{ folio: 'F8', estado: 'entregado', datos: { total: 10.01, forma_pago: 'mixto',
    pagos: [{ metodo: 'efectivo', monto: 6 }, { metodo: 'terminal', monto: 4 }] } }], null);
  assert.deepEqual(Object.fromEntries(m.clases.map((x) => [x.clase, x.venta])), { efectivo: 6.01, tarjeta: 4 });
  const u = RVD.ventaPorUsuario([
    { folio: 'RM-1', estado: 'entregado', datos: { total: 90, canal: 'restaurante_mesa', cuenta_id: 'c1', mesero: 'Ana' } },
    { folio: 'RM-2', estado: 'entregado', datos: { total: 10, canal: 'restaurante_mesa', mesero: 'Ana' } },
    { folio: 'P-1', estado: 'entregado', datos: { total: 40, canal: 'pos' } },
  ], new Map([['c1', { mesero_id: 'u1', mesero: 'Ana B.', cerro_id: 'u2', cerro: 'Luis' }]]));
  assert.equal(c(u.usuarios.reduce((s, x) => s + c(x.atendidas.venta), 0) / 100) + c(u.sin_registrar.venta), c(u.venta_neta));
  assert.deepEqual(u.sin_registrar, { tickets: 1, venta: 40, pct_venta: 28.6 });
  assert.deepEqual(u.usuarios.find((x) => x.nombre === 'Luis').cerradas, { tickets: 1, venta: 90 });
});

// ─── B. Con Postgres y el servidor ─────────────────────────────────────────
const TAG = 'RP3' + (Date.now() % 1e8).toString(36).toUpperCase();
const SLUGS = ['a', 'b', 'c', 'd', 'x'].map((l) => `${TAG.toLowerCase()}-rep-prod-${l}`);
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];

async function limpiar() {
  const { rows } = await q(`SELECT id FROM negocios WHERE slug LIKE '%-rep-prod-_'`);
  for (const { id } of rows) {
    const del = (sql) => q(sql, [id]).catch(() => {});
    await del('DELETE FROM pedidos_activos WHERE negocio_id = $1');
    await del('DELETE FROM pedido_lineas_pedidos WHERE negocio_id = $1');
    await del('DELETE FROM restaurante_cuentas WHERE negocio_id = $1');
    await del('DELETE FROM menu_modificadores_opciones WHERE negocio_id = $1');
    await del('DELETE FROM menu_modificadores_grupos WHERE negocio_id = $1');
    await del('DELETE FROM menu_productos WHERE negocio_id = $1');
    await del('DELETE FROM menu_categorias WHERE negocio_id = $1');
    await del('DELETE FROM configuracion WHERE negocio_id = $1');
    await del('DELETE FROM negocio_modulos WHERE negocio_id = $1');
    await del('DELETE FROM usuario_negocios WHERE negocio_id = $1');
  }
  for (const { id } of rows) {
    await q('DELETE FROM usuarios WHERE negocio_id = $1', [id]).catch(() => {});
    await q('DELETE FROM negocios WHERE id = $1', [id]).catch(() => {});
  }
}
await limpiar();

async function negocio(slug, nombre, { bandera = true } = {}) {
  const n = await uno('INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id', [nombre, slug]);
  for (const m of ['pos', 'caja']) await q(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [n.id, m]);
  if (bandera) await q(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reportes_productos_v1','true')`, [n.id]);
  return n.id;
}
async function usuario(neg, nombre) {
  return (await uno(`INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
    [neg, nombre, `${TAG.toLowerCase()}-${nombre.replace(/\W+/g, '').toLowerCase()}-${Date.now()}@test.local`])).id;
}
const miembro = (u, neg, rol) => q('INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,$3)', [u, neg, rol]);
const galleta = (usuarioId, negocioId, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
const categoria = async (neg, nombre) => (await uno('INSERT INTO menu_categorias (nombre, negocio_id, activa, orden) VALUES ($1,$2,TRUE,1) RETURNING id', [nombre, neg])).id;
const producto = async (neg, cat, nombre, precio, { disponible = true, opciones = null } = {}) => (await uno(
  `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, opciones) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
  [neg, cat, nombre, precio, disponible, opciones ? JSON.stringify(opciones) : null])).id;
// created_at es timestamp SIN zona que guarda UTC.
async function pedido(neg, folio, estado, datos, utc) {
  await q('INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at) VALUES ($1,$2,$3,$4,$5::timestamp)',
    [folio, estado, JSON.stringify({ id: folio, ...datos }), neg, utc]);
}

const A = await negocio(SLUGS[0], `${TAG} Sucursal A`);
const B = await negocio(SLUGS[1], `${TAG} Sucursal B`);
const C = await negocio(SLUGS[2], `${TAG} Sucursal C`);
const D = await negocio(SLUGS[3], `${TAG} Sucursal D`, { bandera: false });
const X = await negocio(SLUGS[4], `${TAG} Otro dueño`);
// El dueño administra A, B y D; en C es operador. X es de otra persona.
const DUENO = await usuario(A, `${TAG} Dueño`);
await miembro(DUENO, A, 'admin'); await miembro(DUENO, B, 'admin'); await miembro(DUENO, C, 'staff'); await miembro(DUENO, D, 'admin');
const STAFF_A = await usuario(A, `${TAG} Cajera`); await miembro(STAFF_A, A, 'staff');
const MESERO = await usuario(A, `${TAG} Mesero`); await miembro(MESERO, A, 'staff');
const AJENO = await usuario(X, `${TAG} Ajeno`); await miembro(AJENO, X, 'admin');
const S = {
  duenoA: galleta(DUENO, A, 'admin'), duenoD: galleta(DUENO, D, 'admin'),
  staffA: galleta(STAFF_A, A, 'staff'), ajeno: galleta(AJENO, X, 'admin'),
};

// Menú de A.
const M = {};
M.des = await categoria(A, `${TAG} Desayunos`);
M.beb = await categoria(A, `${TAG} Bebidas`);
M.env = await categoria(A, 'ENVIO');
M.var = await categoria(A, `${TAG} Varios`);
M.chil = await producto(A, M.des, `${TAG} Chilaquiles`, 120);
M.agua = await producto(A, M.beb, `${TAG} Agua`, 30);
M.envio = await producto(A, M.env, `${TAG} ENVIO 60`, 60, { opciones: { tipo_item: 'envio' } });
M.bolsa = await producto(A, M.var, `${TAG} Bolsa`, 5);
await q(`UPDATE menu_productos SET tipo = 'otro' WHERE id = $1`, [M.bolsa]);
M.molletes = await producto(A, M.des, `${TAG} Molletes`, 90);
M.oculto = await producto(A, M.des, `${TAG} Oculto`, 50, { disponible: false });
M.salsa = (await uno('INSERT INTO menu_modificadores_grupos (producto_id, nombre, negocio_id) VALUES ($1,$2,$3) RETURNING id', [M.chil, 'Salsa', A])).id;
M.verde = (await uno('INSERT INTO menu_modificadores_opciones (grupo_id, nombre, precio_extra, negocio_id, orden) VALUES ($1,$2,0,$3,1) RETURNING id', [M.salsa, 'Verde', A])).id;
M.mole = (await uno('INSERT INTO menu_modificadores_opciones (grupo_id, nombre, precio_extra, negocio_id, orden) VALUES ($1,$2,15,$3,2) RETURNING id', [M.salsa, 'Mole', A])).id;
// Menú de B (mismo nombre, otro id) y de X.
const chilB = await producto(B, await categoria(B, `${TAG} Desayunos`), `${TAG} Chilaquiles`, 100);
const tortaX = await producto(X, await categoria(X, `${TAG} Tortas`), `${TAG} Torta secreta`, 77);

const it = (producto_id, nombre, cantidad, precio_unitario, extra = {}) => ({ producto_id, nombre, cantidad, precio_unitario, ...extra });
const MOLE = { grupo_id: M.salsa, grupo: 'Salsa', opcion_id: M.mole, opcion: 'Mole', precio_extra: 15 };
const VERDE = { grupo_id: M.salsa, grupo: 'Salsa', opcion_id: M.verde, opcion: 'Verde', precio_extra: 0 };
const NCHIL = `${TAG} Chilaquiles`, NAGUA = `${TAG} Agua`;
const f = (s) => `${TAG}-${s}`;

// 7-oct-2020 (miércoles): Matamoros en horario de verano (UTC-5). Hora local + 5 = UTC.
const DIA = '2020-10-07';
await pedido(A, f('P1'), 'entregado', { canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', subtotal: 300, descuento: 30, total: 270,
  items: [it(M.chil, NCHIL, 2, 135, { modificadores: [MOLE] }), it(M.agua, NAGUA, 1, 30)] }, '2020-10-07 13:30:00');
await pedido(A, f('P2'), 'entregado', { canal: 'presencial', modalidad: 'recoger en tienda', forma_pago: 'dolares', subtotal: 125, total: 125,
  items: [it(M.bolsa, `${TAG} Bolsa`, 1, 5), it(M.chil, NCHIL, 1, 120)] }, '2020-10-07 13:45:00');
await pedido(A, f('W1'), 'entregado', { canal: 'whatsapp', modalidad: 'entrega a domicilio', forma_pago: 'terminal (tarjeta presente)', subtotal: 180, costo_envio: 40, total: 220,
  items: [it(M.chil, NCHIL, 1, 120, { modificadores: [VERDE] }), it(M.envio, `${TAG} ENVIO 60`, 1, 60)] }, '2020-10-07 15:00:00');
await pedido(A, f('R1'), 'entregado', { canal: 'rappi', pago: 'rappi_pay', modalidad: 'entrega a domicilio', subtotal: 145, total: 145,
  items: [it(M.chil, NCHIL, 1, 120)] }, '2020-10-07 17:15:00');
const cuenta = (await uno(`INSERT INTO restaurante_cuentas (negocio_id, mesa_numero, mesero_usuario_id, abierta_por, estado, cerrada_por, cerrada_at)
                           VALUES ($1, 7, $2, $2, 'cerrada', $3, now()) RETURNING id`, [A, MESERO, DUENO])).id;
await pedido(A, `RM-${TAG}M1-0`, 'entregado', { canal: 'restaurante_mesa', modalidad: 'mesa', mesero: `${TAG} Mesero`, cuenta_id: cuenta,
  forma_pago: 'mixto', subtotal: 180, total: 180, propinas: 10,
  pagos: [{ metodo: 'efectivo', monto: 100, propina: 0 }, { metodo: 'terminal (tarjeta presente)', monto: 80, propina: 10 }],
  items: [{ nombre: NAGUA, cantidad: 2, precio_unitario: 30 }, { nombre: NCHIL, cantidad: 1, precio_unitario: 120, notas: 'Salsa: Verde' }] }, '2020-10-07 19:00:00');
await pedido(A, f('X1'), 'cancelado', { canal: 'pos', forma_pago: 'efectivo', subtotal: 120, total: 120, items: [it(M.chil, NCHIL, 1, 120)] }, '2020-10-07 14:00:00');
await pedido(A, f('PC1'), 'entregado', { canal: 'presencial', forma_pago: 'por_cobrar', pago_confirmado: false, subtotal: 99, total: 99, items: [it(M.agua, NAGUA, 3, 33)] }, '2020-10-07 14:10:00');
await pedido(A, f('V1'), 'entregado', { canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', subtotal: 30, total: 30, items: [it(M.agua, NAGUA, 1, 30)] }, '2020-10-07 16:00:00');
// 23:30 locales del 7 = 04:30Z del 8: es del 7, en «Otras horas».
await pedido(A, f('N1'), 'entregado', { canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', subtotal: 30, total: 30, items: [it(M.agua, NAGUA, 1, 30)] }, '2020-10-08 04:30:00');
// 00:30 locales del 8: no es del 7.
await pedido(A, f('N2'), 'entregado', { canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', subtotal: 1000, total: 1000, items: [it(M.chil, NCHIL, 1, 1000)] }, '2020-10-08 05:30:00');
// El periodo anterior (6-oct).
await pedido(A, f('ANT1'), 'entregado', { canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', subtotal: 210, total: 210,
  items: [it(M.agua, NAGUA, 3, 30), it(M.chil, NCHIL, 1, 120)] }, '2020-10-06 17:00:00');
// Las otras sucursales, el mismo día.
await pedido(B, f('B1'), 'entregado', { canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', subtotal: 100, total: 100, items: [it(chilB, NCHIL, 1, 100)] }, '2020-10-07 15:00:00');
await pedido(C, f('C1'), 'entregado', { canal: 'pos', forma_pago: 'efectivo', subtotal: 300, total: 300, items: [{ nombre: 'C', cantidad: 1, precio_unitario: 300 }] }, '2020-10-07 15:00:00');
await pedido(D, f('D1'), 'entregado', { canal: 'pos', forma_pago: 'efectivo', subtotal: 400, total: 400, items: [{ nombre: 'D', cantidad: 1, precio_unitario: 400 }] }, '2020-10-07 15:00:00');
await pedido(X, f('XX1'), 'entregado', { canal: 'pos', forma_pago: 'efectivo', subtotal: 77, total: 77, items: [it(tortaX, `${TAG} Torta secreta`, 1, 77)] }, '2020-10-07 15:00:00');

// El registro de la Fase 2, como lo deja el proceso de cada 5 minutos.
for (const neg of [A, B, C, D, X]) await procesarNegocio(neg);
// V1 cambia DESPUÉS de registrarse (su registro queda viejo) y S1 llega
// después del proceso (sin registro): las dos van a «Sin desglose».
await q(`UPDATE pedidos_activos SET datos = jsonb_set(jsonb_set(jsonb_set(datos, '{items}', $2::jsonb), '{subtotal}', '60'), '{total}', '60') WHERE folio = $1`,
  [f('V1'), JSON.stringify([it(M.agua, NAGUA, 2, 30)])]);
await pedido(A, f('S1'), 'entregado', { canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'transferencia', subtotal: 120, total: 120, items: [it(M.chil, NCHIL, 1, 120)] }, '2020-10-07 16:30:00');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
async function api(path, cookie) {
  const r = await fetch(srv.base + path, { headers: cookie ? { Cookie: cookie } : {} });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}
const prods = (r) => Object.fromEntries(r.body.productos.map((p) => [p.nombre, p]));
const DIA_Q = `desde=${DIA}&hasta=${DIA}`;

try {
  await t('HTTP', '5. el cuadre da la MISMA venta neta que la pestaña Ventas, al centavo', async () => {
    const r = await api(`/api/reportes/productos?${DIA_Q}`, S.duenoA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const v = await api(`/api/reportes/ventas?${DIA_Q}`, S.duenoA);
    assert.equal(v.status, 200);
    const k = r.body.cuadre;
    assert.equal(k.venta_neta, v.body.desglose.venta_neta);
    assert.equal(k.venta_neta, 1150);
    assert.equal(k.descuentos, v.body.desglose.descuentos);
    assert.equal(k.envios_cobrados, v.body.desglose.envios_cobrados);
    assert.equal(k.tickets, v.body.resumen.num_pedidos);
    assert.equal(k.cuadra, true);
    assert.deepEqual({ productos: k.productos, otros: k.otros, envios: k.envios, en_productos: k.envios_en_productos, sin: k.sin_desglose, desc: k.descuentos },
      { productos: 895, otros: 5, envios: 100, en_productos: 60, sin: 180, desc: 30 });
    assert.equal(c(r.body.productos.reduce((s, p) => s + c(p.venta), 0) / 100), c(k.productos), 'Σ productos ≠ cuadre');
    assert.equal(k.con_filtros, false);
  });

  await t('HTTP', '6. el registro viejo o ausente va a «Sin desglose», contado', async () => {
    const r = await api(`/api/reportes/productos?${DIA_Q}`, S.duenoA);
    assert.deepEqual(r.body.cuadre.sin_registro, { ventas: 2, monto: 180 }, 'V1 (cambió) y S1 (llegó después)');
    assert.equal(r.body.registro_disponible, true);
  });

  await t('HTTP', '7. productos: piezas, venta, tickets, precio promedio, toppings repartidos y comparación', async () => {
    const r = await api(`/api/reportes/productos?${DIA_Q}`, S.duenoA);
    const p = prods(r);
    assert.deepEqual(Object.keys(p).sort(), [NAGUA, NCHIL].sort(), 'ni el envío, ni la bolsa (otro), ni lo cancelado');
    assert.deepEqual([p[NCHIL].unidades, p[NCHIL].venta, p[NCHIL].tickets, p[NCHIL].repartido], [6, 775, 5, 25]);
    assert.equal(p[NCHIL].precio_promedio, 129.17);
    assert.equal(p[NCHIL].categoria, `${TAG} Desayunos`);
    assert.deepEqual([p[NAGUA].unidades, p[NAGUA].venta, p[NAGUA].tickets], [4, 120, 3]);
    assert.deepEqual([p[NAGUA].venta_anterior, p[NAGUA].cambio_pct], [90, 33.3]);
    assert.deepEqual([p[NCHIL].venta_anterior, p[NCHIL].cambio_pct], [120, 545.8]);
    assert.equal(p[NCHIL].pct_venta + p[NAGUA].pct_venta, 100);
    assert.equal(r.body.comparacion.productos, 210);
    assert.equal(r.body.periodo_anterior.desde, '2020-10-06');
  });

  await t('HTTP', '8. categorías con sus productos', async () => {
    const r = await api(`/api/reportes/productos?${DIA_Q}`, S.duenoA);
    const cats = Object.fromEntries(r.body.categorias.map((x) => [x.nombre, x]));
    assert.deepEqual([cats[`${TAG} Desayunos`].venta, cats[`${TAG} Desayunos`].pct_venta], [775, 86.6]);
    assert.deepEqual([cats[`${TAG} Bebidas`].venta, cats[`${TAG} Bebidas`].unidades], [120, 4]);
    assert.deepEqual(cats[`${TAG} Desayunos`].productos, [`p:${M.chil}`]);
  });

  await t('HTTP', '9. opciones por grupo, extras, combinaciones y pares en el mismo ticket', async () => {
    const r = await api(`/api/reportes/productos?${DIA_Q}`, S.duenoA);
    const g = r.body.modificadores.find((x) => x.grupo === 'Salsa');
    assert.ok(g, 'falta el grupo Salsa');
    const ops = Object.fromEntries(g.opciones.map((o) => [o.opcion, o]));
    assert.deepEqual([ops.Mole.veces, ops.Mole.extras, ops.Mole.pct_grupo], [2, 30, 50]);
    assert.deepEqual([ops.Verde.veces, ops.Verde.pct_grupo], [2, 50], 'WhatsApp y la mesa («Salsa: Verde» de la nota)');
    const cmb = r.body.combinaciones.find((x) => x.producto_nombre === NCHIL);
    assert.deepEqual([cmb.veces, cmb.sin_opciones, cmb.distintas], [6, 2, 2]);
    assert.deepEqual(cmb.combinaciones.map((x) => [x.opciones, x.veces]).sort(), [['Salsa: Mole', 2], ['Salsa: Verde', 2]]);
    assert.equal(r.body.pares.length, 1);
    assert.deepEqual([r.body.pares[0].productos.map((x) => x.nombre).sort(), r.body.pares[0].tickets], [[NAGUA, NCHIL].sort(), 2]);
  });

  await t('HTTP', '10. sin movimiento: activos del menú con menos de N piezas; N se cambia', async () => {
    const r = await api(`/api/reportes/productos?${DIA_Q}`, S.duenoA);
    assert.deepEqual(r.body.sin_movimiento.productos.map((x) => x.nombre), [`${TAG} Molletes`],
      'ni el oculto, ni el envío, ni la bolsa');
    assert.equal(r.body.sin_movimiento.activos, 3);
    const r5 = await api(`/api/reportes/productos?${DIA_Q}&minimo=5`, S.duenoA);
    assert.deepEqual(r5.body.sin_movimiento.productos.map((x) => [x.nombre, x.unidades]), [[`${TAG} Molletes`, 0], [NAGUA, 4]]);
  });

  await t('HTTP', '11. por franja, con el día cortado en la zona del negocio', async () => {
    const r = await api(`/api/reportes/productos?${DIA_Q}`, S.duenoA);
    const fr = Object.fromEntries(r.body.por_franja.map((x) => [x.franja, x]));
    assert.deepEqual(Object.fromEntries(Object.entries(fr).map(([k, x]) => [k, x.tickets])), { '7-9': 2, '9-11': 1, '11-13': 3, '13-15': 1, otras: 1 });
    assert.deepEqual(fr['7-9'].productos.map((x) => [x.nombre, x.unidades]), [[NCHIL, 3], [NAGUA, 1]]);
    assert.deepEqual(fr.otras.productos.map((x) => x.nombre), [NAGUA], 'las 23:30 locales son del 7; las 00:30 del 8 no');
  });

  await t('HTTP', '12. filtros de canal, modalidad, día y franja; el cuadre sigue cerrando', async () => {
    const neta = async (qs) => {
      const r = await api(`/api/reportes/productos?${DIA_Q}&${qs}`, S.duenoA);
      assert.equal(r.status, 200, `${qs}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.cuadre.cuadra, true, `${qs} no cuadra`);
      assert.equal(r.body.cuadre.con_filtros, true);
      return [r.body.cuadre.tickets, r.body.cuadre.venta_neta];
    };
    assert.deepEqual(await neta('canal=rappi'), [1, 145]);
    assert.deepEqual(await neta('canal=mostrador'), [5, 605]);
    assert.deepEqual(await neta('modalidad=mesa'), [1, 180]);
    assert.deepEqual(await neta('modalidad=domicilio'), [2, 365]);
    assert.deepEqual(await neta('dia=3'), [8, 1150]);
    assert.deepEqual(await neta('dia=4'), [0, 0]);
    assert.deepEqual(await neta('franja=7-9'), [2, 395]);
    const r = await api(`/api/reportes/productos?${DIA_Q}`, S.duenoA);
    assert.deepEqual(r.body.filtros_disponibles.canales.map((x) => x.clave).sort(), ['mostrador', 'rappi', 'restaurante', 'whatsapp']);
    for (const mal of ['canal=%27%3B--', 'modalidad=avion', 'dia=9', 'franja=0-24', 'minimo=0']) {
      const x = await api(`/api/reportes/productos?${DIA_Q}&${mal}`, S.duenoA);
      assert.equal(x.status, 400, `${mal} dio ${x.status}`);
    }
  });

  await t('SEGURIDAD', '13. cada negocio ve lo suyo; el query no puede pedir otro negocio', async () => {
    const r = await api(`/api/reportes/productos?${DIA_Q}`, S.ajeno);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.productos.map((p) => p.nombre), [`${TAG} Torta secreta`]);
    assert.equal(r.body.cuadre.venta_neta, 77);
    for (const extra of [`negocioId=${A}`, `negocio_id=${A}`, `sucursal=${A}`]) {
      const x = await api(`/api/reportes/productos?${DIA_Q}&${extra}`, S.ajeno);
      if (extra.startsWith('sucursal')) assert.equal(x.status, 403, 'una sucursal ajena por id');
      else assert.deepEqual(x.body.productos.map((p) => p.nombre), [`${TAG} Torta secreta`], `${extra} cruzó de negocio`);
    }
    const a = await api(`/api/reportes/productos?${DIA_Q}`, S.duenoA);
    assert.ok(!a.body.productos.some((p) => p.nombre.includes('Torta secreta')), 'A vio el producto de X');
    const est = await api('/api/reportes/productos/estado', S.ajeno);
    assert.deepEqual(est.body.sucursales.map((s) => s.id), [X]);
    // Una venta de A que apunta (por error de datos) a una cuenta de mesa de X:
    // el detalle no trae al mesero de X. Otro día, para no mover los demás casos.
    const cuentaX = (await uno(`INSERT INTO restaurante_cuentas (negocio_id, mesa_numero, mesero_usuario_id, abierta_por, estado, cerrada_por, cerrada_at)
                                VALUES ($1, 3, $2, $2, 'cerrada', $2, now()) RETURNING id`, [X, AJENO])).id;
    await pedido(A, `RM-${TAG}MX-0`, 'entregado', { canal: 'restaurante_mesa', modalidad: 'mesa', cuenta_id: cuentaX,
      forma_pago: 'efectivo', subtotal: 50, total: 50, items: [{ nombre: NAGUA, cantidad: 1, precio_unitario: 50 }] }, '2020-10-20 15:00:00');
    const det = await api('/api/reportes/ventas/detalle?desde=2020-10-20&hasta=2020-10-20', S.duenoA);
    assert.equal(det.status, 200);
    const u = det.body.detalles[0].por_usuario;
    assert.ok(!u.usuarios.some((x) => x.nombre === `${TAG} Ajeno`), 'A vio al mesero de X');
    assert.equal(c(u.usuarios.reduce((s, x) => s + c(x.atendidas.venta), 0) / 100) + c(u.sin_registrar.venta), c(50));
  });

  await t('SEGURIDAD', '14. «Todas» son las sucursales que el MISMO usuario administra y tienen la bandera', async () => {
    const est = await api('/api/reportes/productos/estado', S.duenoA);
    assert.deepEqual(est.body.sucursales.map((s) => s.id), [A, B], 'ni C (ahí es operador) ni D (sin bandera)');
    const r = await api(`/api/reportes/productos?${DIA_Q}&sucursal=todas`, S.duenoA);
    assert.equal(r.status, 200);
    assert.equal(r.body.sucursal, 'todas');
    assert.deepEqual(r.body.por_sucursal.map((s) => [s.negocio.id, s.venta_neta, s.cuadra]), [[A, 1150, true], [B, 100, true]]);
    assert.equal(r.body.cuadre.venta_neta, 1250);
    const ch = prods(r)[NCHIL];
    assert.deepEqual([ch.unidades, ch.venta, ch.sucursales.length], [7, 875, 2], 'se juntan por nombre');
    const soloB = await api(`/api/reportes/productos?${DIA_Q}&sucursal=${B}`, S.duenoA);
    assert.deepEqual([soloB.status, soloB.body.cuadre.venta_neta], [200, 100]);
    for (const ajena of [C, D, X, '00000000-0000-0000-0000-000000000000', 'cualquiera']) {
      const x = await api(`/api/reportes/productos?${DIA_Q}&sucursal=${ajena}`, S.duenoA);
      assert.equal(x.status, 403, `sucursal=${ajena} dio ${x.status}`);
    }
  });

  await t('SEGURIDAD', '15. sin la bandera: 403 y Ventas igual que antes', async () => {
    const est = await api('/api/reportes/productos/estado', S.duenoD);
    assert.deepEqual([est.status, est.body.activo], [200, false]);
    for (const ruta of [`/api/reportes/productos?${DIA_Q}`, `/api/reportes/ventas/detalle?${DIA_Q}`]) {
      const x = await api(ruta, S.duenoD);
      assert.deepEqual([x.status, x.body.code], [403, 'REPORTE_APAGADO'], ruta);
    }
    const v = await api(`/api/reportes/ventas?${DIA_Q}`, S.duenoD);
    assert.deepEqual([v.status, v.body.resumen.total_ventas], [200, 400]);
    assert.ok(!('por_forma_pago' in v.body), 'Ventas no cambió de forma');
  });

  await t('SEGURIDAD', '16. solo administradores: el operador 403 y sin sesión 401', async () => {
    for (const ruta of ['/api/reportes/productos/estado', `/api/reportes/productos?${DIA_Q}`, `/api/reportes/ventas/detalle?${DIA_Q}`]) {
      assert.equal((await api(ruta, S.staffA)).status, 403, `operador en ${ruta}`);
      assert.equal((await api(ruta)).status, 401, `sin sesión en ${ruta}`);
    }
  });

  await t('HTTP', '17. Ventas → forma de pago y usuario: Σ = venta neta de Ventas', async () => {
    const r = await api(`/api/reportes/ventas/detalle?${DIA_Q}`, S.duenoA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.detalles.length, 1);
    assert.deepEqual(r.body.sucursales.map((x) => x.id), [A, B], "«sucursales» es la lista para elegir");
    const s = r.body.detalles[0];
    assert.equal(s.desglose.venta_neta, 1150);
    const fp = Object.fromEntries(s.por_forma_pago.clases.map((x) => [x.clase, [x.pedidos, x.venta]]));
    assert.deepEqual(fp, { efectivo: [4, 460], tarjeta: [2, 300], plataformas: [1, 145], dolares: [1, 125], otros: [1, 120] });
    const u = s.por_usuario;
    assert.deepEqual(u.usuarios.map((x) => [x.nombre, x.atendidas.tickets, x.atendidas.venta, x.cerradas.tickets]),
      [[`${TAG} Mesero`, 1, 180, 0], [`${TAG} Dueño`, 0, 0, 1]]);
    assert.deepEqual([u.sin_registrar.tickets, u.sin_registrar.venta], [7, 970]);
  });

  await t('HTTP', '18. Ventas → sucursales lado a lado: cada columna es su Ventas y «Todas» la suma', async () => {
    const r = await api(`/api/reportes/ventas/detalle?${DIA_Q}&sucursal=todas`, S.duenoA);
    assert.deepEqual(r.body.detalles.map((s) => [s.negocio.id, s.desglose.venta_neta]), [[A, 1150], [B, 100]]);
    assert.deepEqual(r.body.sucursales.map((x) => x.id), [A, B]);
    assert.deepEqual([r.body.total.venta_neta, r.body.total.num_pedidos], [1250, 9]);
    const efectivo = r.body.total.por_forma_pago.find((x) => x.clase === 'efectivo');
    assert.equal(efectivo.venta, 560);
    const ajena = await api(`/api/reportes/ventas/detalle?${DIA_Q}&sucursal=${C}`, S.duenoA);
    assert.equal(ajena.status, 403);
  });

  await t('HTTP', '19. parámetros de fecha inválidos dan 400 con mensaje', async () => {
    for (const qs of ['periodo=mañana', 'desde=2026-13-01', 'desde=2026-10-31&hasta=2026-10-01', '']) {
      const r = await api(`/api/reportes/productos?${qs}`, S.duenoA);
      assert.equal(r.status, 400, `${qs || '(vacío)'} dio ${r.status}`);
      assert.ok(r.body?.error);
    }
    const hoy = await api('/api/reportes/productos?periodo=hoy', S.duenoA);
    assert.equal(hoy.status, 200);
    assert.equal(hoy.body.rango.desde, new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Matamoros' }).format(new Date()));
  });
} finally {
  srv.detener();
}

await limpiar().catch(() => {});
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
