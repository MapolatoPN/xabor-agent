// Rappi → Xabor POS, de punta a punta, contra un servidor real y un DOBLE de
// la API de Rappi (test/lib-rappi-mock.mjs). Nada sale a Rappi de verdad.
//
// Cubre: PING, NEW_ORDER válido (pedido + take + Edge por estación), store
// desconocido, SKU válido/inexistente, modificadores, comentarios, duplicado
// secuencial, duplicado concurrente, reentrega tras entregar, cancelación
// (incluido pedido ya listo), ready-for-pickup una sola vez, dos negocios a la
// vez con credenciales distintas, firma exigida vs. registrada, y un fallo
// interno que NO rechaza la orden en Rappi y se recupera al reiniciar.
//
// Uso: DATABASE_URL=postgres://...@localhost:.../edged1_x INTEGRATIONS_ENCRYPTION_KEY=... \
//      PANEL_SECRET=... SESSION_SECRET=... node test/fase-rappi-pos-obispado.mjs
// Puertos propios: TEST_PORT_RAPPI (servidor, 4851) y TEST_PORT_RAPPI_MOCK (doble, 4852).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarRappiMock } from './lib-rappi-mock.mjs';

if (!/^postgres(?:ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):/.test(process.env.DATABASE_URL || '')) throw Error('Solo base local de prueba');
const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_RAPPI || '4851';
const PUERTO_MOCK = Number(process.env.TEST_PORT_RAPPI_MOCK || '4852');

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { vincularTiendaRappi, guardarCredencialesRappi } = await import('../src/services/rappiIntegracion.js');
const { skuDeOpcion } = await import('../src/services/rappi-api.js');
await pool.query(readFileSync(join(__dirname, '..', 'migrations', '080_pedidos_externos.sql'), 'utf8'));

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
async function esperar(fn, { ms = 10000, cada = 150, desc = 'condición' } = {}) {
  const fin = Date.now() + ms;
  let ultimo;
  while (Date.now() < fin) {
    try { ultimo = await fn(); if (ultimo) return ultimo; } catch (e) { ultimo = e; }
    await new Promise(r => setTimeout(r, cada));
  }
  throw new Error(`timeout esperando ${desc}${ultimo instanceof Error ? ': ' + ultimo.message : ''}`);
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const suf = Date.now().toString().slice(-6);
const STORE_A = `RPS-A-${suf}`;
const STORE_B = `RPS-B-${suf}`;
const SECRETO_ENV = `hook-env-${suf}`;
const SECRETO_B = `hook-b-${suf}`;
const CLIENT_ENV = `cli-entorno-${suf}`;
const CLIENT_B = `cli-negocio-b-${suf}`;
const cookieA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG_A, rol: 'admin' }))}`;

// ── Limpieza ──
async function del(sql, params) { try { await pool.query(sql, params); } catch (e) { console.warn('[limpieza] omitido:', e.message.slice(0, 90)); } }
async function limpiar() {
  for (const neg of [NEG_A, NEG_B]) {
    await del(`DELETE FROM impresion_trabajos WHERE negocio_id = $1 AND impresora_nombre LIKE 'RP %'`, [neg]);
    await del(`DELETE FROM impresion_rutas WHERE negocio_id = $1 AND impresora_id IN (SELECT id FROM impresoras WHERE negocio_id = $1 AND nombre LIKE 'RP %')`, [neg]);
    await del(`DELETE FROM impresoras WHERE negocio_id = $1 AND nombre LIKE 'RP %'`, [neg]);
    await del(`DELETE FROM pedidos_externos WHERE negocio_id = $1 AND id_externo LIKE 'RPE-%'`, [neg]);
    await del(`DELETE FROM pedido_emisiones WHERE negocio_id = $1 AND folio IN (SELECT folio FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'rappi_order_id' LIKE 'RPE-%')`, [neg]);
    await del(`DELETE FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'rappi_order_id' LIKE 'RPE-%'`, [neg]);
    await del(`DELETE FROM pedidos WHERE negocio_id = $1 AND telefono LIKE 'rappi-RPE-%'`, [neg]);
    await del(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'rappi')`, [neg]);
    await del(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'rappi'`, [neg]);
    await del(`DELETE FROM menu_modificadores_opciones WHERE negocio_id = $1 AND nombre LIKE 'RP %'`, [neg]);
    await del(`DELETE FROM menu_modificadores_grupos WHERE negocio_id = $1 AND nombre LIKE 'RP %'`, [neg]);
    await del(`DELETE FROM menu_productos WHERE negocio_id = $1 AND nombre LIKE 'RP %'`, [neg]);
    await del(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre LIKE 'RP %'`, [neg]);
  }
  await del(`DELETE FROM terminales WHERE nombre LIKE 'RP Edge %'`, []);
  await del(`DELETE FROM clientes WHERE telefono LIKE 'rappi-RPE-%'`, []);
}

// ── Fixture ──
async function modulo(neg, m) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) SELECT $1, $2, 'activo' WHERE NOT EXISTS (SELECT 1 FROM negocio_modulos WHERE negocio_id = $1 AND modulo = $2)`, [neg, m]);
  await pool.query(`UPDATE negocio_modulos SET estado = 'activo' WHERE negocio_id = $1 AND modulo = $2`, [neg, m]);
}
async function categoria(neg, nombre) {
  const { rows: [c] } = await pool.query(`INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,960) RETURNING id`, [neg, nombre]);
  return c.id;
}
async function producto(neg, catId, { nombre, precio, codigo = null }) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, precio, disponible, agotado, orden) VALUES ($1,$2,$3,$4,$5,TRUE,FALSE,1) RETURNING id, codigo, nombre, precio`,
    [neg, catId, codigo, nombre, precio]);
  return p;
}
async function grupo(neg, prodId, nombre, opciones) {
  const { rows: [g] } = await pool.query(
    `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden) VALUES ($1,$2,$3,TRUE,1,1,1) RETURNING id`, [neg, prodId, nombre]);
  const ops = {};
  for (const [i, [n, extra]] of opciones.entries()) {
    const { rows: [o] } = await pool.query(
      `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden) VALUES ($1,$2,$3,$4,TRUE,$5) RETURNING id, nombre`, [neg, g.id, n, extra, i + 1]);
    ops[n] = o;
  }
  return { id: g.id, opciones: ops };
}

await limpiar();
for (const m of ['pos', 'rappi', 'impresion']) { await modulo(NEG_A, m); await modulo(NEG_B, m); }

// Menú A (estilo Obispado) y B (ajeno)
const catChilA = await categoria(NEG_A, `RP Chilaquiles ${suf}`);
const catBebA = await categoria(NEG_A, `RP Bebidas ${suf}`);
const chil = await producto(NEG_A, catChilA, { nombre: `RP Chilaquiles Sencillos ${suf}`, precio: 195, codigo: `RPCH${suf}` });
const salsa = await grupo(NEG_A, chil.id, `RP Salsa ${suf}`, [[`RP Roja ${suf}`, 0], [`RP Verde ${suf}`, 0]]);
const cafe = await producto(NEG_A, catBebA, { nombre: `RP Cafe ${suf}`, precio: 39 });
const catB = await categoria(NEG_B, `RP Menu B ${suf}`);
const prodB = await producto(NEG_B, catB, { nombre: `RP Producto B ${suf}`, precio: 100, codigo: `RPB${suf}` });

// Integraciones: A = escenario A (credenciales del entorno, firma 'registrar');
//                B = escenario B (credenciales propias cifradas, firma 'exigir').
await vincularTiendaRappi(NEG_A, { storeId: STORE_A, nombre: 'RP tienda A', configuracion: { cooking_time: 25 } }, SEED.superadminUsuarioId);
await vincularTiendaRappi(NEG_B, { storeId: STORE_B, nombre: 'RP tienda B', configuracion: { rappi_firma: 'exigir', rappi_webhook_secret: SECRETO_B } }, SEED.superadminUsuarioId);
await guardarCredencialesRappi(NEG_B, { clientId: CLIENT_B, clientSecret: `sec-b-${suf}` }, SEED.superadminUsuarioId);

// Edge de A: tres estaciones como en Obispado, en la sucursal que resolverá el servidor.
const { rows: [suc] } = await pool.query(`SELECT id FROM sucursales WHERE negocio_id = $1 AND activo ORDER BY created_at LIMIT 1`, [NEG_A]);
const { rows: [term] } = await pool.query(`INSERT INTO terminales (sucursal_id, nombre, codigo, activo, tipo) VALUES ($1, $2, $3, TRUE, 'edge') RETURNING id`, [suc.id, `RP Edge ${suf}`, `RPEDGE${suf}`]);
const impresoras = {};
for (const n of ['RP COCINA', 'RP Bebidas', 'RP Chilaquil']) {
  const { rows: [i] } = await pool.query(
    `INSERT INTO impresoras (negocio_id, sucursal_id, terminal_id, nombre, transporte, ancho_columnas, activa, config) VALUES ($1,$2,$3,$4,'mock',42,TRUE,'{}') RETURNING id`,
    [NEG_A, suc.id, term.id, `${n} ${suf}`]);
  impresoras[n] = i.id;
}
async function ruta(ambito, clave, imp) {
  await pool.query(`INSERT INTO impresion_rutas (negocio_id, sucursal_id, impresora_id, ambito, clave, modo, activa) VALUES ($1,$2,$3,$4,$5,'agregar',TRUE)`, [NEG_A, suc.id, impresoras[imp], ambito, clave]);
}
await ruta('categoria', `RP Chilaquiles ${suf}`, 'RP Chilaquil');
await ruta('categoria', `RP Chilaquiles ${suf}`, 'RP COCINA');
await ruta('categoria', `RP Bebidas ${suf}`, 'RP Bebidas');
await ruta('documento', 'comanda', 'RP COCINA');

// ── Helpers HTTP ──
function firmar(cuerpo, secreto) {
  const ts = Math.floor(Date.now() / 1000);
  return `t=${ts},sign=${createHmac('sha256', secreto).update(`${ts}.`).update(cuerpo).digest('hex')}`;
}
let base = null;
async function webhook(body, { secreto = null, header = undefined } = {}) {
  const cuerpo = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (header !== undefined) headers['Rappi-Signature'] = header;
  else if (secreto) headers['Rappi-Signature'] = firmar(cuerpo, secreto);
  const r = await fetch(`${base}/webhook/rappi`, { method: 'POST', headers, body: cuerpo });
  let json = null; try { json = await r.json(); } catch { /* sin json */ }
  return { status: r.status, body: json };
}
async function api(path, { method = 'GET', body, cookie = cookieA } = {}) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* sin json */ }
  return { status: r.status, body: json };
}
let n = 0;
const ordenId = () => `RPE-${suf}-${++n}`;
function orden({ storeId = STORE_A, orderId = ordenId(), items, delivery_method = 'delivery', totals } = {}) {
  return {
    order_detail: {
      order_id: orderId, delivery_method, payment_method: 'cc', cooking_time: 15, created_at: new Date().toISOString(),
      delivery_information: { complete_address: 'Calle 1', neighborhood: 'Centro' },
      items: items || [{ id: 'i1', sku: chil.codigo, name: 'Chilaquiles', quantity: 1, price: 195, comments: 'sin cebolla',
        subitems: [{ id: 's1', sku: skuDeOpcion(salsa.opciones[`RP Roja ${suf}`]), name: 'Roja', quantity: 1, price: 0 }] },
        { id: 'i2', sku: `XB-${cafe.id}`, name: 'Cafe', quantity: 2, price: 39 }],
      totals: totals || { total_products: 273, total_discounts: 0, total_order: 273 },
    },
    customer: { first_name: 'Ana', last_name: 'Prueba', phone_number: '0000000000' },
    store: { internal_id: storeId, external_id: 'ext', name: 'Store' },
  };
}
const ledger = (neg, id) => pool.query(`SELECT * FROM pedidos_externos WHERE negocio_id=$1 AND canal='rappi' AND id_externo=$2`, [neg, id]).then(r => r.rows[0] || null);
const pedidosDe = (neg, id) => pool.query(`SELECT folio, estado, datos FROM pedidos_activos WHERE negocio_id=$1 AND datos->>'rappi_order_id'=$2`, [neg, id]).then(r => r.rows);
const trabajosDe = (folio, documento = 'comanda') => pool.query(`SELECT impresora_nombre, payload FROM impresion_trabajos WHERE negocio_id=$1 AND origen_id=$2 AND documento=$3`, [NEG_A, folio, documento]).then(r => r.rows);
const esperarPedido = (neg, id) => esperar(async () => { const p = await pedidosDe(neg, id); return p.length ? p : null; }, { desc: `pedido ${id}` });

const mock = await arrancarRappiMock({ puerto: PUERTO_MOCK });
const ENV = {
  PORT: PUERTO, RAPPI_BASE_URL: mock.base, RAPPI_AUTH_URL: mock.authUrl,
  RAPPI_CLIENT_ID: CLIENT_ENV, RAPPI_CLIENT_SECRET: `sec-env-${suf}`, RAPPI_WEBHOOK_SECRET: SECRETO_ENV,
};
let srv = null;
// `omitir` borra la clave DESPUÉS de mezclar `extra`: solo se omite lo que
// esta fase no está inyectando a propósito.
const arrancar = (extra = {}) => arrancarServidor({ ...ENV, ...extra }, {
  omitir: ['RAPPI_STORE_ID', 'RAPPI_FIRMA_MODO', 'NODE_ENV', ...(extra.RAPPI_PRUEBA_FALLO ? [] : ['RAPPI_PRUEBA_FALLO'])],
});

try {
  srv = await arrancar();
  base = srv.base;

  await t('PING responde status OK (contrato de Rappi para tienda disponible)', async () => {
    const r = await webhook({ store_id: 999 });
    assert.equal(r.status, 200); assert.equal(r.body.status, 'OK');
  });

  let folio1 = null; const id1 = ordenId();
  await t('NEW_ORDER válido: pedido con producto_id, modificador canónico, notas; take en Rappi; ledger creado', async () => {
    const r = await webhook(orden({ orderId: id1 }));
    assert.equal(r.status, 200); assert.equal(r.body.status, 'OK');
    const [p] = await esperarPedido(NEG_A, id1);
    folio1 = p.folio;
    assert.equal(p.datos.canal, 'rappi'); assert.equal(p.datos.pago, 'rappi_pay'); assert.equal(p.datos.total, 273);
    const it = p.datos.items;
    assert.equal(it[0].producto_id, chil.id); assert.equal(it[0].mapeo, 'sku'); assert.equal(it[0].notas, 'sin cebolla');
    assert.equal(it[0].modificadores[0].opcion_id, salsa.opciones[`RP Roja ${suf}`].id); assert.equal(it[0].modificadores[0].grupo_id, salsa.id);
    assert.equal(it[1].producto_id, cafe.id); assert.equal(it[1].cantidad, 2);
    assert.equal(p.datos.mapeo.requiere_revision, false);
    const l = await esperar(async () => { const x = await ledger(NEG_A, id1); return x?.aceptado_en_proveedor === true ? x : null; }, { desc: 'aceptación' });
    assert.equal(l.estado, 'creado'); assert.equal(l.folio, folio1);
    const tomas = mock.tomas(id1);
    assert.equal(tomas.length, 1); assert.equal(tomas[0].clientId, CLIENT_ENV);
    assert.ok(tomas[0].ruta.endsWith('/take/25'), `cooking_time de la integración (25): ${tomas[0].ruta}`);
    assert.equal(mock.rechazos(id1).length, 0);
    assert.ok((await esperar(async () => { const x = await pedidosDe(NEG_A, id1); return x[0].datos.rappi?.aceptacion?.aceptado ? x : null; }, { desc: 'marca de aceptación' })));
  });

  await t('Edge: la comanda sale por estación (chilaquiles → Chilaquil y COCINA, café → Bebidas) con destino RAPPI #id', async () => {
    const trabajos = await esperar(async () => { const x = await trabajosDe(folio1); return x.length >= 3 ? x : null; }, { desc: 'trabajos Edge' });
    const porImp = Object.fromEntries(trabajos.map(x => [x.impresora_nombre, x.payload]));
    assert.ok(porImp[`RP Chilaquil ${suf}`].items.some(i => i.producto === chil.nombre));
    assert.ok(porImp[`RP COCINA ${suf}`].items.some(i => i.producto === chil.nombre));
    assert.ok(porImp[`RP Bebidas ${suf}`].items.some(i => i.producto === cafe.nombre));
    assert.ok(!porImp[`RP Bebidas ${suf}`].items.some(i => i.producto === chil.nombre), 'los chilaquiles no van a bebidas');
    assert.equal(porImp[`RP Chilaquil ${suf}`].destino, `RAPPI #${id1}`);
    assert.deepEqual(porImp[`RP Chilaquil ${suf}`].items[0].modificadores[0].opcion, `RP Roja ${suf}`);
  });

  await t('el pedido aparece en el tablero del negocio A (GET /pedidos) y no en el de otro', async () => {
    const r = await api('/pedidos');
    assert.equal(r.status, 200);
    assert.ok(r.body.some(p => p.id === folio1 && p.rappi_order_id === id1));
  });

  await t('store desconocido: 200 ignorado, sin pedido, sin ledger, sin llamada a Rappi', async () => {
    const id = ordenId();
    const r = await webhook(orden({ orderId: id, storeId: 'STORE-DESCONOCIDO' }));
    assert.equal(r.status, 200); assert.equal(r.body.ignorado, 'store_no_registrado');
    await new Promise(r => setTimeout(r, 400));
    assert.equal((await pedidosDe(NEG_A, id)).length, 0); assert.equal((await pedidosDe(NEG_B, id)).length, 0);
    assert.equal(await ledger(NEG_A, id), null); assert.equal(mock.tomas(id).length, 0);
  });

  await t('SKU inexistente: el pedido igual nace (venta cobrada), sin producto_id, marcado para revisión, y se toma en Rappi', async () => {
    const id = ordenId();
    await webhook(orden({ orderId: id, items: [{ id: 'z', sku: 'NOEXISTE', name: 'Platillo fantasma', quantity: 1, price: 50, comments: 'urgente' }], totals: { total_products: 50, total_discounts: 0, total_order: 50 } }));
    const [p] = await esperarPedido(NEG_A, id);
    assert.equal(p.datos.items[0].producto_id, null); assert.equal(p.datos.items[0].mapeo, 'sin_resolver');
    assert.equal(p.datos.items[0].nombre, 'Platillo fantasma'); assert.equal(p.datos.items[0].notas, 'urgente');
    assert.equal(p.datos.mapeo.requiere_revision, true);
    await esperar(async () => mock.tomas(id).length === 1, { desc: 'take' });
    assert.equal(mock.rechazos(id).length, 0);
  });

  await t('duplicado secuencial: la reentrega responde duplicado y no crea otro pedido ni otro take', async () => {
    const antes = mock.tomas(id1).length;
    const r = await webhook(orden({ orderId: id1 }));
    assert.equal(r.status, 200); assert.equal(r.body.duplicado, true); assert.equal(r.body.folio, folio1);
    await new Promise(r => setTimeout(r, 400));
    assert.equal((await pedidosDe(NEG_A, id1)).length, 1); assert.equal(mock.tomas(id1).length, antes);
    assert.equal((await ledger(NEG_A, id1)).reentregas, 1);
  });

  await t('duplicado CONCURRENTE: 8 webhooks simultáneos → un pedido, un take, una fila', async () => {
    const id = ordenId();
    const cuerpo = orden({ orderId: id });
    const rs = await Promise.all(Array.from({ length: 8 }, () => webhook(cuerpo)));
    assert.ok(rs.every(r => r.status === 200));
    await esperarPedido(NEG_A, id);
    await esperar(async () => mock.tomas(id).length >= 1, { desc: 'take' });
    await new Promise(r => setTimeout(r, 600));
    assert.equal((await pedidosDe(NEG_A, id)).length, 1);
    assert.equal(mock.tomas(id).length, 1);
    const { rows } = await pool.query(`SELECT count(*)::int c FROM pedidos_externos WHERE negocio_id=$1 AND id_externo=$2`, [NEG_A, id]);
    assert.equal(rows[0].c, 1);
    assert.equal(rs.filter(r => r.body.en_curso || r.body.duplicado).length, 7);
  });

  await t('reentrega DESPUÉS de entregar el pedido (ya fuera de memoria): sigue siendo duplicado', async () => {
    const id = ordenId();
    await webhook(orden({ orderId: id }));
    const [p] = await esperarPedido(NEG_A, id);
    const e = await api(`/pedidos/${p.folio}/estado`, { method: 'PATCH', body: { estado: 'entregado' } });
    assert.equal(e.status, 200);
    await esperar(async () => (await pedidosDe(NEG_A, id))[0].estado === 'entregado', { desc: 'entregado' });
    const r = await webhook(orden({ orderId: id }));
    assert.equal(r.body.duplicado, true);
    await new Promise(r => setTimeout(r, 400));
    assert.equal((await pedidosDe(NEG_A, id)).length, 1);
  });

  await t('cancelación desde Rappi: pedido cancelado, aviso en papel a las estaciones de la comanda, ledger cancelado; reentrega idempotente', async () => {
    const id = ordenId();
    await webhook(orden({ orderId: id }));
    const [p] = await esperarPedido(NEG_A, id);
    await esperar(async () => (await trabajosDe(p.folio)).length >= 3, { desc: 'comanda impresa' });
    const c = await webhook({ event: 'canceled_with_charge', order_id: id, store_id: STORE_A });
    assert.equal(c.status, 200);
    await esperar(async () => (await pedidosDe(NEG_A, id))[0].estado === 'cancelado', { desc: 'cancelado' });
    const [pc] = await pedidosDe(NEG_A, id);
    assert.equal(pc.datos.cancelacion.motivo.includes('canceled_with_charge'), true);
    assert.equal(pc.datos.rappi.cancelacion.evento, 'canceled_with_charge');
    const avisos = await esperar(async () => { const x = await trabajosDe(p.folio, 'cancelacion'); return x.length >= 3 ? x : null; }, { desc: 'papel de cancelación' });
    assert.deepEqual(new Set(avisos.map(a => a.impresora_nombre)), new Set([`RP Chilaquil ${suf}`, `RP COCINA ${suf}`, `RP Bebidas ${suf}`]));
    assert.ok(avisos[0].payload.motivo.includes(`RAPPI #${id}`));
    const l = await ledger(NEG_A, id);
    assert.equal(l.estado, 'cancelado'); assert.equal(l.cancelacion.resultado, 'cancelado'); assert.equal(l.cancelacion.folio, p.folio);
    await webhook({ event: 'canceled_with_charge', order_id: id, store_id: STORE_A });
    await new Promise(r => setTimeout(r, 400));
    assert.equal((await trabajosDe(p.folio, 'cancelacion')).length, 3, 'un solo papel por estación');
    const tab = await api('/pedidos');
    assert.equal(tab.body.find(x => x.id === p.folio)?.estado, 'cancelado');
  });

  await t('cancelación de un pedido YA LISTO: se cancela igual y queda marcado cancelado_ya_preparado', async () => {
    const id = ordenId();
    await webhook(orden({ orderId: id }));
    const [p] = await esperarPedido(NEG_A, id);
    assert.equal((await api(`/pedidos/${p.folio}/estado`, { method: 'PATCH', body: { estado: 'listo' } })).status, 200);
    await webhook({ event: 'canceled_with_charge', order_id: id, store_id: STORE_A });
    const l = await esperar(async () => { const x = await ledger(NEG_A, id); return x?.estado === 'cancelado' ? x : null; }, { desc: 'ledger cancelado' });
    assert.equal(l.cancelacion.resultado, 'cancelado_ya_preparado');
    assert.equal((await pedidosDe(NEG_A, id))[0].estado, 'cancelado');
  });

  await t('cancelación de un pedido YA ENTREGADO: no cambia el estado, deja la marca y el resultado ya_entregado', async () => {
    const id = ordenId();
    await webhook(orden({ orderId: id }));
    const [p] = await esperarPedido(NEG_A, id);
    await api(`/pedidos/${p.folio}/estado`, { method: 'PATCH', body: { estado: 'entregado' } });
    await esperar(async () => (await pedidosDe(NEG_A, id))[0].estado === 'entregado', { desc: 'entregado' });
    await webhook({ event: 'canceled_with_charge', order_id: id, store_id: STORE_A });
    const l = await esperar(async () => { const x = await ledger(NEG_A, id); return x?.estado === 'cancelado' ? x : null; }, { desc: 'ledger' });
    assert.equal(l.cancelacion.resultado, 'ya_entregado');
    const [pe] = await pedidosDe(NEG_A, id);
    assert.equal(pe.estado, 'entregado'); assert.equal(pe.datos.rappi.cancelacion.estado_previo, 'entregado');
  });

  await t('cancelación de una orden nunca vista: queda constancia (sin_pedido) y no rompe nada', async () => {
    const id = ordenId();
    await webhook({ event: 'canceled_with_charge', order_id: id, store_id: STORE_A });
    const l = await esperar(async () => { const x = await ledger(NEG_A, id); return x?.estado === 'cancelado' ? x : null; }, { desc: 'ledger' });
    assert.equal(l.cancelacion.resultado, 'sin_pedido');
  });

  await t('READY: marcar "listo" en el panel manda ready-for-pickup UNA vez, aunque se marque dos veces', async () => {
    const id = ordenId();
    await webhook(orden({ orderId: id }));
    const [p] = await esperarPedido(NEG_A, id);
    assert.equal((await api(`/pedidos/${p.folio}/estado`, { method: 'PATCH', body: { estado: 'listo' } })).status, 200);
    await esperar(async () => mock.listos(id).length === 1, { desc: 'ready-for-pickup' });
    assert.equal((await api(`/pedidos/${p.folio}/estado`, { method: 'PATCH', body: { estado: 'listo' } })).status, 200);
    await new Promise(r => setTimeout(r, 500));
    assert.equal(mock.listos(id).length, 1);
    assert.ok((await ledger(NEG_A, id)).listo_notificado_at);
    assert.equal(mock.listos(id)[0].clientId, CLIENT_ENV);
  });

  await t('firma EXIGIDA (negocio B): sin firma 401 y sin rastro; firma mala 401; firma buena crea el pedido con las credenciales de B', async () => {
    const id = ordenId();
    const cuerpo = orden({ orderId: id, storeId: STORE_B, items: [{ sku: prodB.codigo, name: 'B', quantity: 1, price: 100 }], totals: { total_products: 100, total_discounts: 0, total_order: 100 } });
    const sin = await webhook(cuerpo);
    assert.equal(sin.status, 401); assert.equal(sin.body.motivo, 'sin_header');
    const mala = await webhook(cuerpo, { secreto: 'otro' });
    assert.equal(mala.status, 401); assert.equal(mala.body.motivo, 'no_coincide');
    assert.equal(await ledger(NEG_B, id), null);
    const ok = await webhook(cuerpo, { secreto: SECRETO_B });
    assert.equal(ok.status, 200);
    const [p] = await esperarPedido(NEG_B, id);
    assert.equal(p.datos.items[0].producto_id, prodB.id);
    await esperar(async () => mock.tomas(id).length === 1, { desc: 'take B' });
    assert.equal(mock.tomas(id)[0].clientId, CLIENT_B, 'B habla con Rappi con SUS credenciales, no con las del entorno');
  });

  await t('firma REGISTRADA (negocio A): sin firma se acepta y queda en el log; con firma válida del entorno también', async () => {
    const id = ordenId();
    assert.equal((await webhook(orden({ orderId: id }))).status, 200);
    await esperarPedido(NEG_A, id);
    const id2 = ordenId();
    assert.equal((await webhook(orden({ orderId: id2 }), { secreto: SECRETO_ENV })).status, 200);
    await esperarPedido(NEG_A, id2);
    assert.ok(/firma sin_header \(modo registrar\)/.test(srv.obtenerSalida()), 'la firma ausente queda registrada en el log');
  });

  await t('DOS NEGOCIOS a la vez: cada orden cae en su negocio y cada take usa sus credenciales; Mapolato nunca usa el store de otro', async () => {
    const idA = ordenId(); const idB = ordenId();
    const cuerpoB = orden({ orderId: idB, storeId: STORE_B, items: [{ sku: prodB.codigo, name: 'B', quantity: 1, price: 100 }], totals: { total_products: 100, total_discounts: 0, total_order: 100 } });
    await Promise.all([webhook(orden({ orderId: idA })), webhook(cuerpoB, { secreto: SECRETO_B })]);
    const [[pa], [pb]] = await Promise.all([esperarPedido(NEG_A, idA), esperarPedido(NEG_B, idB)]);
    assert.equal(pa.datos.negocioId, NEG_A); assert.equal(pb.datos.negocioId, NEG_B);
    assert.equal((await pedidosDe(NEG_B, idA)).length, 0); assert.equal((await pedidosDe(NEG_A, idB)).length, 0);
    await esperar(async () => mock.tomas(idA).length === 1 && mock.tomas(idB).length === 1, { desc: 'takes' });
    assert.equal(mock.tomas(idA)[0].clientId, CLIENT_ENV); assert.equal(mock.tomas(idB)[0].clientId, CLIENT_B);
    assert.equal(pa.datos.rappi.store_id, STORE_A); assert.equal(pb.datos.rappi.store_id, STORE_B);
    // Publicar el menú desde la sesión de A va al store de A, nunca al de B ni al del entorno (que no existe aquí).
    mock.limpiar();
    const r = await api('/api/admin/rappi/subir-menu', { method: 'POST' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const menu = mock.llamadas.find(l => l.ruta === '/menu');
    assert.equal(menu.body.storeId, STORE_A); assert.equal(menu.clientId, CLIENT_ENV);
    assert.ok(menu.body.items.some(i => i.sku === chil.codigo));
    assert.ok(!menu.body.items.some(i => i.sku === prodB.codigo), 'el menú de B no se publica desde A');
  });

  await t('GET /api/admin/rappi/integracion devuelve el store del negocio sin secretos', async () => {
    const r = await api('/api/admin/rappi/integracion');
    assert.equal(r.status, 200); assert.equal(r.body.integracion.storeId, STORE_A); assert.equal(r.body.integracion.credenciales, 'entorno');
    assert.equal(JSON.stringify(r.body).includes(SECRETO_ENV), false);
  });

  await t('Superadmin: vincular store (alta explícita), store ocupado → 409, credenciales cifradas, respuesta sin secretos', async () => {
    const cookieSA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.superadminUsuarioId, negocioId: NEG_A, rol: 'admin' }))}`;
    const C = SEED.negocioC, D = SEED.negocioD, STORE_C = `RPS-C-${suf}`;
    await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = ANY($1) AND canal='rappi')`, [[C, D]]);
    await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id = ANY($1) AND canal = 'rappi'`, [[C, D]]);
    try {
      const alta = await api(`/api/superadmin/negocios/${C}/integraciones/rappi`, { method: 'PUT', cookie: cookieSA, body: { storeId: STORE_C, nombre: 'RP C', configuracion: { cooking_time: 18, rappi_firma: 'exigir', rappi_webhook_secret: `secreto-hook-c-${suf}` } } });
      assert.equal(alta.status, 200, JSON.stringify(alta.body));
      assert.equal(alta.body.integracion.storeId, STORE_C); assert.equal(alta.body.integracion.cookingTime, 18);
      assert.equal(alta.body.integracion.firma, 'exigir'); assert.equal(alta.body.integracion.secretoWebhookConfigurado, true);
      assert.equal(JSON.stringify(alta.body).includes(`secreto-hook-c-${suf}`), false, 'el secreto del webhook nunca sale en la respuesta');
      const ocupado = await api(`/api/superadmin/negocios/${D}/integraciones/rappi`, { method: 'PUT', cookie: cookieSA, body: { storeId: STORE_C } });
      assert.equal(ocupado.status, 409);
      const malo = await api(`/api/superadmin/negocios/${C}/integraciones/rappi`, { method: 'PUT', cookie: cookieSA, body: { storeId: STORE_C, configuracion: { rappi_firma: 'siempre' } } });
      assert.equal(malo.status, 400);
      const cred = await api(`/api/superadmin/negocios/${C}/integraciones/rappi/credenciales`, { method: 'PUT', cookie: cookieSA, body: { clientId: 'cli-c', clientSecret: 'sec-c' } });
      assert.equal(cred.status, 200); assert.equal(cred.body.integracion.credenciales, 'negocio');
      assert.equal(JSON.stringify(cred.body).includes('sec-c'), false);
      const { rows } = await pool.query(`SELECT cc.access_token_cifrado FROM integraciones_canal_credenciales cc JOIN integraciones_canal ic ON ic.id = cc.integracion_id WHERE ic.negocio_id = $1 AND ic.canal = 'rappi'`, [C]);
      assert.equal(rows.length, 1); assert.notEqual(rows[0].access_token_cifrado, 'sec-c');
      assert.equal((await api(`/api/superadmin/negocios/${C}/integraciones/rappi/credenciales`, { method: 'DELETE', cookie: cookieSA })).status, 200);
      assert.equal((await api(`/api/superadmin/negocios/${C}/integraciones/rappi`, { cookie: cookieSA })).body.integracion.credenciales, 'entorno');
      assert.equal((await api(`/api/superadmin/negocios/${C}/integraciones/rappi`, { method: 'PUT', body: { storeId: 'x' } })).status, 403, 'un admin de negocio no vincula stores');
    } finally {
      await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = ANY($1) AND canal='rappi')`, [[C, D]]);
      await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id = ANY($1) AND canal = 'rappi'`, [[C, D]]);
    }
  });

  // ── Fallo interno: la orden NO se rechaza en Rappi y se recupera ──
  srv.detener();
  srv = await arrancar({ RAPPI_PRUEBA_FALLO: 'antes_de_persistir' });
  base = srv.base;
  const idFallo = ordenId();
  await t('un error interno de Xabor deja la orden en fallido, SIN rechazarla en Rappi y sin pedido', async () => {
    const r = await webhook(orden({ orderId: idFallo }));
    assert.equal(r.status, 200);
    const l = await esperar(async () => { const x = await ledger(NEG_A, idFallo); return x?.estado === 'fallido' ? x : null; }, { desc: 'ledger fallido' });
    assert.match(l.ultimo_error, /fallo inyectado/);
    assert.equal((await pedidosDe(NEG_A, idFallo)).length, 0);
    assert.equal(mock.rechazos(idFallo).length, 0, 'NUNCA reject por un bug nuestro');
    assert.equal(mock.tomas(idFallo).length, 0);
    assert.ok(/rappi_orden_fallida/.test(srv.obtenerSalida()));
  });

  srv.detener();
  srv = await arrancar();
  base = srv.base;
  await t('al reiniciar sin el fallo, la reconciliación crea el pedido por el mismo camino y lo toma en Rappi', async () => {
    const [p] = await esperarPedido(NEG_A, idFallo);
    assert.equal(p.datos.items[0].producto_id, chil.id);
    const l = await esperar(async () => { const x = await ledger(NEG_A, idFallo); return x?.estado === 'creado' && x.aceptado_en_proveedor ? x : null; }, { desc: 'ledger creado' });
    assert.equal(l.intentos, 2); assert.equal(l.folio, p.folio);
    assert.equal(mock.tomas(idFallo).length, 1);
    assert.equal(mock.rechazos(idFallo).length, 0);
  });

  await t('Rappi caído al aceptar: el pedido nace igual, queda marcado no aceptado y NO se rechaza', async () => {
    const id = ordenId();
    mock.forzarFallo(`PUT /orders/${id}/take/`, 500);
    await webhook(orden({ orderId: id }));
    const [p] = await esperarPedido(NEG_A, id);
    const l = await esperar(async () => { const x = await ledger(NEG_A, id); return x?.aceptado_en_proveedor === false ? x : null; }, { desc: 'no aceptado' });
    assert.match(l.aceptacion_error, /500/);
    assert.equal((await esperar(async () => { const x = await pedidosDe(NEG_A, id); return x[0].datos.rappi?.aceptacion?.aceptado === false ? x : null; }, { desc: 'marca' }))[0].folio, p.folio);
    assert.equal(mock.rechazos(id).length, 0);
    await esperar(async () => (await trabajosDe(p.folio)).length >= 3, { desc: 'la comanda igual sale' });
    mock.quitarFallo(`PUT /orders/${id}/take/`);
  });

  // ── Fixtures reales ──
  const reales = readdirSync(join(__dirname, 'fixtures', 'rappi')).filter(f => f.endsWith('.real.json'));
  for (const f of reales) {
    await t(`fixture real ${f}: entra por el webhook con el store de A y crea un pedido`, async () => {
      const cuerpo = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'rappi', f), 'utf8'));
      cuerpo.store = { ...(cuerpo.store || {}), internal_id: STORE_A };
      cuerpo.order_detail.order_id = ordenId();
      assert.equal((await webhook(cuerpo)).status, 200);
      const [p] = await esperarPedido(NEG_A, cuerpo.order_detail.order_id);
      assert.equal(p.datos.items.length, cuerpo.order_detail.items.length);
    });
  }
} finally {
  if (srv) srv.detener();
  await mock.detener();
  await limpiar();
  await pool.end();
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { for (const f of fallos) console.log(' - ' + f); process.exit(1); }
