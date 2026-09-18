// Rappi → Xabor: mapeo de orden, firma del webhook y ledger de idempotencia.
//
// Sin servidor HTTP: ejercita directamente rappiMapeo.js, rappiFirma.js y
// pedidosExternos.js contra la base local. La suite end-to-end (webhook real,
// take/cancel/ready contra un doble de Rappi) es fase-rappi-pos-obispado.mjs.
//
// Uso: DATABASE_URL=postgres://...@localhost:.../edged1_x node test/fase-rappi-mapeo.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

if (!/^postgres(?:ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):/.test(process.env.DATABASE_URL || '')) throw Error('Solo base local de prueba');
const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const { pool } = await import('../src/services/database.js');
const { normalizarSobreRappi, cargarCatalogoParaRappi, mapearOrdenRappi } = await import('../src/channels/rappiMapeo.js');
const { verificarFirmaRappi, calcularFirmaRappi, parsearHeaderFirma } = await import('../src/channels/rappiFirma.js');
const {
  reclamarPedidoExterno, retomarPedidoExterno, marcarPedidoExternoCreado, marcarPedidoExternoFallido,
  marcarPedidoExternoCancelado, marcarListoNotificado, obtenerPedidoExterno, pedidosExternosPendientes, MAX_INTENTOS,
} = await import('../src/services/pedidosExternos.js');
const { skuDeProducto, skuDeOpcion } = await import('../src/services/rappi-api.js');

// Migración 080 aplicada de forma idempotente (misma práctica que fase-whatsapp-continuidad).
await pool.query(readFileSync(join(__dirname, '..', 'migrations', '080_pedidos_externos.sql'), 'utf8'));

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const suf = Date.now().toString().slice(-6);

async function limpiar() {
  for (const neg of [NEG_A, NEG_B]) {
    await pool.query(`DELETE FROM pedidos_externos WHERE negocio_id = $1 AND id_externo LIKE 'RPT-%'`, [neg]);
    await pool.query(`DELETE FROM menu_modificadores_opciones WHERE negocio_id = $1 AND nombre LIKE 'RP %'`, [neg]);
    await pool.query(`DELETE FROM menu_modificadores_grupos WHERE negocio_id = $1 AND nombre LIKE 'RP %'`, [neg]);
    await pool.query(`DELETE FROM menu_productos WHERE negocio_id = $1 AND nombre LIKE 'RP %'`, [neg]);
    await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre LIKE 'RP %'`, [neg]);
  }
}

// ── Fixture: un menú al estilo Mapolato (chilaquiles con grupos, bebida) ──
async function categoria(neg, nombre) {
  const { rows: [c] } = await pool.query(`INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,950) RETURNING id`, [neg, nombre]);
  return c.id;
}
async function producto(neg, catId, { nombre, precio, codigo = null, disponible = true, agotado = false }) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, precio, disponible, agotado, orden) VALUES ($1,$2,$3,$4,$5,$6,$7,1) RETURNING id, codigo, nombre, precio, categoria_id`,
    [neg, catId, codigo, nombre, precio, disponible, agotado]);
  return p;
}
async function grupo(neg, prodId, nombre, opciones, { minimo = 1, maximo = 1 } = {}) {
  const { rows: [g] } = await pool.query(
    `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden) VALUES ($1,$2,$3,TRUE,$4,$5,1) RETURNING id`,
    [neg, prodId, nombre, minimo, maximo]);
  const ops = {};
  for (const [i, [n, extra]] of opciones.entries()) {
    const { rows: [o] } = await pool.query(
      `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden) VALUES ($1,$2,$3,$4,TRUE,$5) RETURNING id, nombre, precio_extra`,
      [neg, g.id, n, extra, i + 1]);
    ops[n] = o;
  }
  return { id: g.id, opciones: ops };
}

await limpiar();
const catChil = await categoria(NEG_A, `RP Chilaquiles ${suf}`);
const catBeb = await categoria(NEG_A, `RP Bebidas ${suf}`);
const chil = await producto(NEG_A, catChil, { nombre: `RP Chilaquiles Sencillos ${suf}`, precio: 195, codigo: `RPCH${suf}` });
const salsa = await grupo(NEG_A, chil.id, `RP Salsa ${suf}`, [[`RP Roja ${suf}`, 0], [`RP Verde ${suf}`, 0]]);
const prote = await grupo(NEG_A, chil.id, `RP Proteina ${suf}`, [[`RP Huevo ${suf}`, 0], [`RP Bistec ${suf}`, 30]]);
const cafe = await producto(NEG_A, catBeb, { nombre: `RP Cafe Americano ${suf}`, precio: 39 });
const leche = await grupo(NEG_A, cafe.id, `RP Leche ${suf}`, [[`RP Deslactosada ${suf}`, 8]]);
const agotado = await producto(NEG_A, catBeb, { nombre: `RP Jugo ${suf}`, precio: 70, agotado: true });
await producto(NEG_A, catBeb, { nombre: `RP Duplicado ${suf}`, precio: 10 });
await producto(NEG_A, catBeb, { nombre: `RP Duplicado ${suf}`, precio: 12 });
const catB = await categoria(NEG_B, `RP Otros ${suf}`);
const ajeno = await producto(NEG_B, catB, { nombre: `RP Ajeno ${suf}`, precio: 777, codigo: `RPAJ${suf}` });
const grupoAjeno = await grupo(NEG_B, ajeno.id, `RP Extra ajeno ${suf}`, [[`RP Opcion ajena ${suf}`, 5]]);

function sobreDe(items, { orderId = `RPT-${suf}-1`, storeId = 'STORE-X', delivery_method = 'delivery', totals, customer } = {}) {
  return {
    order_detail: {
      order_id: orderId, delivery_method, payment_method: 'cc', cooking_time: 15, created_at: '2026-09-18T10:00:00.000Z',
      delivery_information: { complete_address: 'Calle 1 #2', neighborhood: 'Centro', complement: 'Porton' },
      items,
      totals: totals || { total_products: 0, total_discounts: 0, total_order: 0 },
    },
    customer: customer || { first_name: 'Ana', last_name: 'Prueba', phone_number: '0000000000' },
    store: { internal_id: storeId, external_id: 'ext', name: 'Store' },
  };
}

try {
  const catalogo = await cargarCatalogoParaRappi(NEG_A);
  const negocio = { negocioId: NEG_A, negocioSlug: 'a', sucursalId: null };

  // ── Sobre ──
  await t('normalizarSobreRappi reconoce order_detail, el formato plano, y rechaza una cancelación', () => {
    const s = normalizarSobreRappi(sobreDe([{ sku: 'x', name: 'y', quantity: 1, price: 1 }]));
    assert.equal(s.formato, 'order_detail'); assert.equal(s.storeId, 'STORE-X'); assert.equal(s.orderId, `RPT-${suf}-1`);
    const p = normalizarSobreRappi({ id: 99, items: [{ name: 'a', units: 2, unit_price: 5 }], store_id: 'S' });
    assert.equal(p.formato, 'plano'); assert.equal(p.storeId, 'S'); assert.equal(p.orderId, '99');
    assert.equal(normalizarSobreRappi({ event: 'canceled_with_charge', order_id: '1', store_id: 'S' }), null);
    assert.equal(normalizarSobreRappi({ store_id: 999 }), null);
    assert.equal(normalizarSobreRappi(null), null);
  });

  await t('el ejemplo de la doc de Rappi se reconoce como orden (forma del contrato)', () => {
    const doc = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'rappi', 'ejemplo-doc-rappi.json'), 'utf8'));
    const s = normalizarSobreRappi(doc);
    assert.equal(s.orderId, '392625'); assert.equal(s.storeId, '30000011'); assert.equal(s.items[0].quantity, 3);
    const { orden, auditoria } = mapearOrdenRappi(s, catalogo, negocio);
    assert.equal(orden.items[0].cantidad, 3); assert.equal(orden.items[0].notas, 'No vinegar');
    assert.equal(orden.items[0].mapeo, 'sin_resolver'); assert.equal(auditoria.requiere_revision, true);
  });

  // ── Items ──
  await t('SKU = codigo del producto → producto_id real, mapeo sku, precio de Rappi y precio de catálogo al lado', () => {
    const { orden } = mapearOrdenRappi(normalizarSobreRappi(sobreDe([{ id: 'i1', sku: chil.codigo, name: 'Otro nombre', quantity: 2, price: 210, comments: 'sin cebolla' }])), catalogo, negocio);
    const it = orden.items[0];
    assert.equal(it.producto_id, chil.id); assert.equal(it.mapeo, 'sku'); assert.equal(it.nombre, chil.nombre);
    assert.equal(it.nombre_recibido, 'Otro nombre'); assert.equal(it.cantidad, 2);
    assert.equal(it.precio_unitario, 210); assert.equal(it.precio_base_catalogo, 195);
    assert.equal(it.notas, 'sin cebolla'); assert.equal(it.categoria_id, catChil);
    assert.equal(it.rappi.sku, chil.codigo); assert.equal(it.rappi.id, 'i1');
    assert.equal(orden.mapeo.requiere_revision, false);
  });

  await t('SKU XB-<id> (producto sin codigo) → producto_id real', () => {
    assert.equal(skuDeProducto(cafe), `XB-${cafe.id}`);
    const { orden } = mapearOrdenRappi(normalizarSobreRappi(sobreDe([{ sku: `xb-${cafe.id}`, name: 'Cafe', quantity: 1, price: 45 }])), catalogo, negocio);
    assert.equal(orden.items[0].producto_id, cafe.id); assert.equal(orden.items[0].mapeo, 'sku');
  });

  await t('sin SKU: nombre único del catálogo → mapeo por nombre (compatibilidad controlada)', () => {
    const { orden } = mapearOrdenRappi(normalizarSobreRappi(sobreDe([{ name: `  rp CAFÉ americano ${suf} `, quantity: 1, price: 39 }])), catalogo, negocio);
    assert.equal(orden.items[0].producto_id, cafe.id); assert.equal(orden.items[0].mapeo, 'nombre');
    assert.equal(orden.mapeo.por_nombre, 1);
  });

  await t('nombre AMBIGUO en el catálogo no se adivina: sin_resolver + requiere_revision', () => {
    const { orden, auditoria } = mapearOrdenRappi(normalizarSobreRappi(sobreDe([{ name: `RP Duplicado ${suf}`, quantity: 1, price: 10 }])), catalogo, negocio);
    assert.equal(orden.items[0].producto_id, null); assert.equal(orden.items[0].mapeo, 'sin_resolver');
    assert.equal(auditoria.requiere_revision, true); assert.equal(auditoria.sin_resolver.length, 1);
  });

  await t('SKU inexistente y nombre desconocido: se conserva todo lo recibido, sin producto_id', () => {
    const { orden } = mapearOrdenRappi(normalizarSobreRappi(sobreDe([{ sku: 'NOEXISTE', name: 'Platillo fantasma', quantity: 4, price: 99, comments: 'x' }])), catalogo, negocio);
    const it = orden.items[0];
    assert.equal(it.producto_id, null); assert.equal(it.nombre, 'Platillo fantasma'); assert.equal(it.cantidad, 4);
    assert.equal(it.precio_unitario, 99); assert.equal(it.notas, 'x'); assert.equal(it.mapeo, 'sin_resolver');
  });

  await t('SKU de un producto de OTRO negocio no se resuelve aquí', () => {
    const { orden } = mapearOrdenRappi(normalizarSobreRappi(sobreDe([{ sku: ajeno.codigo, name: 'Ajeno', quantity: 1, price: 1 }])), catalogo, negocio);
    assert.equal(orden.items[0].producto_id, null); assert.equal(orden.items[0].mapeo, 'sin_resolver');
  });

  await t('producto agotado se resuelve igual (la venta ya está cobrada) y queda marcado no_disponible', () => {
    const { orden, auditoria } = mapearOrdenRappi(normalizarSobreRappi(sobreDe([{ sku: `XB-${agotado.id}`, name: 'Jugo', quantity: 1, price: 70 }])), catalogo, negocio);
    assert.equal(orden.items[0].producto_id, agotado.id); assert.equal(orden.items[0].no_disponible, true);
    assert.deepEqual(auditoria.no_disponibles, [agotado.nombre]); assert.equal(auditoria.requiere_revision, true);
  });

  // ── Subitems / modificadores ──
  await t('subitem XB-op-<id> → modificador canónico {grupo_id, grupo, opcion_id, opcion, precio_extra}', () => {
    const roja = salsa.opciones[`RP Roja ${suf}`];
    const bistec = prote.opciones[`RP Bistec ${suf}`];
    const { orden } = mapearOrdenRappi(normalizarSobreRappi(sobreDe([{
      sku: chil.codigo, name: 'Chil', quantity: 1, price: 195,
      subitems: [{ id: 's1', sku: skuDeOpcion(roja), name: 'Roja', quantity: 1, price: 0 }, { id: 's2', sku: skuDeOpcion(bistec), name: 'Bistec', quantity: 1, price: 35 }],
    }])), catalogo, negocio);
    const mods = orden.items[0].modificadores;
    assert.equal(mods.length, 2);
    assert.deepEqual({ g: mods[0].grupo_id, gn: mods[0].grupo, o: mods[0].opcion_id, on: mods[0].opcion, p: mods[0].precio_extra, m: mods[0].mapeo },
      { g: salsa.id, gn: `RP Salsa ${suf}`, o: roja.id, on: roja.nombre, p: 0, m: 'sku' });
    assert.equal(mods[1].opcion_id, bistec.id); assert.equal(mods[1].precio_extra, 35); assert.equal(Number(mods[1].precio_extra_catalogo), 30);
    assert.equal(orden.items[0].precio_extras, 35);
    assert.equal(orden.items[0].modificadores_sin_resolver, undefined);
    assert.equal(orden.mapeo.requiere_revision, false);
  });

  await t('subitem por NOMBRE único dentro de los grupos del producto → canónico, mapeo nombre', () => {
    const verde = salsa.opciones[`RP Verde ${suf}`];
    const { orden } = mapearOrdenRappi(normalizarSobreRappi(sobreDe([{ sku: chil.codigo, name: 'Chil', quantity: 1, price: 195, subitems: [{ name: `rp verde ${suf}`, quantity: 1, price: 0 }] }])), catalogo, negocio);
    assert.equal(orden.items[0].modificadores[0].opcion_id, verde.id); assert.equal(orden.items[0].modificadores[0].mapeo, 'nombre');
  });

  await t('subitem con XB-op de OTRO producto, de OTRO negocio o desconocido: se conserva como sin_catalogo y queda auditado', () => {
    const ajena = grupoAjeno.opciones[`RP Opcion ajena ${suf}`];        // otro negocio: no existe en este catálogo
    const delCafe = leche.opciones[`RP Deslactosada ${suf}`];           // mismo negocio, otro producto
    const { orden, auditoria } = mapearOrdenRappi(normalizarSobreRappi(sobreDe([{
      sku: chil.codigo, name: 'Chil', quantity: 1, price: 195,
      subitems: [
        { sku: skuDeOpcion(delCafe), name: 'Deslactosada', quantity: 1, price: 8 },
        { sku: skuDeOpcion(ajena), name: 'Ajena', quantity: 1, price: 5 },
        { name: 'Extra queso', quantity: 2, price: 10 },
      ],
    }])), catalogo, negocio);
    const mods = orden.items[0].modificadores;
    assert.equal(mods.length, 3);
    assert.equal(mods[0].sin_catalogo, true); assert.equal(mods[0].opcion, 'Deslactosada'); assert.equal(mods[0].motivo, 'opcion_de_otro_producto');
    assert.equal(mods[1].sin_catalogo, true); assert.equal(mods[1].opcion, 'Ajena'); assert.equal(mods[1].motivo, 'no_en_catalogo');
    assert.equal(mods[2].sin_catalogo, true); assert.equal(mods[2].opcion, 'Extra queso'); assert.equal(mods[2].motivo, 'no_en_catalogo');
    assert.equal(orden.items[0].modificadores_sin_resolver.length, 3);
    assert.equal(auditoria.modificadores_sin_resolver.length, 3); assert.equal(auditoria.requiere_revision, true);
    assert.equal(orden.items[0].precio_extras, 33);
  });

  // ── Orden ──
  await t('totales, cliente, modalidad e identificadores externos se conservan', () => {
    const s = normalizarSobreRappi(sobreDe([{ sku: chil.codigo, name: 'Chil', quantity: 1, price: 195 }], {
      orderId: `RPT-${suf}-tot`, delivery_method: 'pickup', totals: { total_products: 195, total_discounts: 20, total_order: 175 },
      customer: { first_name: 'Luis', last_name: 'Gómez', phone_number: '8180000000' },
    }));
    const { orden } = mapearOrdenRappi(s, catalogo, negocio);
    assert.equal(orden.total, 175); assert.equal(orden.subtotal, 195); assert.equal(orden.descuento, 20); assert.equal(orden.costo_envio, 0);
    assert.equal(orden.modalidad, 'recoger en tienda'); assert.equal(orden.pago, 'rappi_pay'); assert.equal(orden.canal, 'rappi');
    assert.equal(orden.rappi_order_id, `RPT-${suf}-tot`); assert.equal(orden.rappi.order_id, `RPT-${suf}-tot`); assert.equal(orden.rappi.store_id, 'STORE-X');
    assert.equal(orden.cliente.nombre, 'Luis Gómez'); assert.equal(orden.cliente.telefono, `rappi-RPT-${suf}-tot`);
    assert.equal(orden.rappi.customer.phone_number, '8180000000'); assert.equal(orden.rappi.payment_method, 'cc');
    assert.equal(orden.negocioId, NEG_A);
  });

  await t('sin totales de Rappi, el total es la suma de lo recibido (nunca un precio nuestro)', () => {
    const s = normalizarSobreRappi({ id: `RPT-${suf}-plano`, items: [{ name: 'X', units: 2, unit_price: 50 }], store_id: 'S' });
    const { orden } = mapearOrdenRappi(s, catalogo, negocio);
    assert.equal(orden.total, 100); assert.equal(orden.modalidad, 'entrega a domicilio');
  });

  await t('sin negocioId no se mapea (fail closed)', () => {
    assert.throws(() => mapearOrdenRappi(normalizarSobreRappi(sobreDe([])), catalogo, { negocioId: '' }), /negocioId/);
  });

  // ── Cliente por store ──
  await t('un cliente atado a un store se niega a publicar un catálogo dirigido a otro store', async () => {
    const { crearClienteRappi } = await import('../src/services/rappi-api.js');
    const c = crearClienteRappi({ storeId: 'S-A', clientId: 'cli', clientSecret: 'sec' });
    await assert.rejects(() => c.subirCatalogo({ storeId: 'S-B', items: [] }), (e) => e.codigo === 'RAPPI_STORE_NO_COINCIDE');
    assert.throws(() => crearClienteRappi({ storeId: 'S-A', clientId: '', clientSecret: 'x' }), (e) => e.codigo === 'RAPPI_NO_CONFIGURADO');
    const sinStore = crearClienteRappi({ storeId: null, clientId: 'cli', clientSecret: 'sec' });
    await assert.rejects(() => sinStore.actualizarEstadoTienda(true), (e) => e.codigo === 'RAPPI_STORE_REQUERIDO');
  });

  // ── Firma ──
  await t('firma válida (t en segundos y en milisegundos) pasa; secreto distinto, no', () => {
    const raw = Buffer.from('{"a":1, "b":[1,2]}');
    const ahora = Date.now();
    const tSeg = Math.floor(ahora / 1000);
    const h1 = `t=${tSeg},sign=${calcularFirmaRappi('S3', tSeg, raw)}`;
    assert.deepEqual(verificarFirmaRappi({ header: h1, rawBody: raw, secret: 'S3', ahoraMs: ahora }), { valida: true, motivo: 'ok' });
    const h2 = `t=${ahora},sign=${calcularFirmaRappi('S3', ahora, raw)}`;
    assert.equal(verificarFirmaRappi({ header: h2, rawBody: raw, secret: 'S3', ahoraMs: ahora }).valida, true);
    assert.equal(verificarFirmaRappi({ header: h1, rawBody: raw, secret: 'OTRO', ahoraMs: ahora }).motivo, 'no_coincide');
    // Un byte distinto en el cuerpo (re-serialización) rompe la firma.
    assert.equal(verificarFirmaRappi({ header: h1, rawBody: Buffer.from('{"a":1,"b":[1,2]}'), secret: 'S3', ahoraMs: ahora }).motivo, 'no_coincide');
  });

  await t('firma: sin secreto, sin header, header malformado, fuera de ventana', () => {
    const raw = Buffer.from('{}');
    const t0 = Math.floor(Date.now() / 1000);
    const h = `t=${t0},sign=${calcularFirmaRappi('S', t0, raw)}`;
    assert.equal(verificarFirmaRappi({ header: h, rawBody: raw, secret: null }).motivo, 'sin_secreto');
    assert.equal(verificarFirmaRappi({ header: null, rawBody: raw, secret: 'S' }).motivo, 'sin_header');
    assert.equal(verificarFirmaRappi({ header: 'basura', rawBody: raw, secret: 'S' }).motivo, 'header_invalido');
    assert.equal(verificarFirmaRappi({ header: h, rawBody: raw, secret: 'S', ahoraMs: Date.now() + 10 * 60 * 1000 }).motivo, 'fuera_de_ventana');
    assert.equal(verificarFirmaRappi({ header: h, rawBody: Buffer.alloc(0), secret: 'S' }).motivo, 'sin_cuerpo');
    assert.deepEqual(parsearHeaderFirma(' T=1 , SIGN=ABC '), { t: '1', sign: 'abc' });
  });

  // ── Ledger ──
  const ext = (n) => `RPT-${suf}-${n}`;
  await t('reclamar: primera vez procesar; mientras está en curso, en_curso; creado → duplicado', async () => {
    const r1 = await reclamarPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L1'), payload: { a: 1 } });
    assert.equal(r1.accion, 'procesar'); assert.equal(r1.registro.intentos, 1);
    const r2 = await reclamarPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L1'), payload: { a: 2 } });
    assert.equal(r2.accion, 'en_curso'); assert.equal(r2.registro.reentregas, 1);
    await marcarPedidoExternoCreado(r1.registro.id, { folio: 'XAB-TEST-1', aceptado: true });
    const r3 = await reclamarPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L1'), payload: { a: 3 } });
    assert.equal(r3.accion, 'duplicado'); assert.equal(r3.registro.folio, 'XAB-TEST-1'); assert.equal(r3.registro.estado, 'creado');
    const fila = await obtenerPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L1') });
    assert.equal(fila.reentregas, 2); assert.equal(fila.aceptado_en_proveedor, true);
  });

  await t('la misma orden en OTRO negocio es otra fila (aislamiento por negocio)', async () => {
    const r = await reclamarPedidoExterno({ negocioId: NEG_B, canal: 'rappi', idExterno: ext('L1'), payload: {} });
    assert.equal(r.accion, 'procesar');
  });

  await t('fallido → un nuevo reclamo lo retoma (intentos+1); creado NUNCA se retoma', async () => {
    const r1 = await reclamarPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L2'), payload: {} });
    await marcarPedidoExternoFallido(r1.registro.id, new Error('boom'));
    const r2 = await reclamarPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L2'), payload: {} });
    assert.equal(r2.accion, 'procesar'); assert.equal(r2.registro.intentos, 2);
    await marcarPedidoExternoCreado(r2.registro.id, { folio: 'XAB-TEST-2' });
    // marcarFallido sobre una fila ya 'creado' no la degrada.
    await marcarPedidoExternoFallido(r2.registro.id, new Error('tarde'));
    assert.equal((await obtenerPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L2') })).estado, 'creado');
  });

  await t('reclamado caducado (proceso muerto) se retoma; reciente no', async () => {
    const r1 = await reclamarPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L3'), payload: {} });
    assert.equal((await reclamarPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L3'), payload: {} })).accion, 'en_curso');
    await pool.query(`UPDATE pedidos_externos SET actualizado_at = NOW() - interval '10 minutes' WHERE id = $1`, [r1.registro.id]);
    const pend = await pedidosExternosPendientes('rappi', { limite: 100 });
    assert.ok(pend.some(p => p.id === r1.registro.id), 'debe listarse como pendiente');
    const r2 = await reclamarPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L3'), payload: {} });
    assert.equal(r2.accion, 'procesar'); assert.equal(r2.registro.intentos, 2);
    assert.equal(await retomarPedidoExterno(r1.registro.id), null, 'recién retomada: nadie más la toma');
  });

  await t('tope de intentos: tras MAX_INTENTOS fallos ya no se retoma', async () => {
    const r1 = await reclamarPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L4'), payload: {} });
    let id = r1.registro.id;
    await pool.query(`UPDATE pedidos_externos SET estado='fallido', intentos=$2 WHERE id=$1`, [id, MAX_INTENTOS]);
    assert.equal((await reclamarPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L4'), payload: {} })).accion, 'en_curso');
    assert.equal(await retomarPedidoExterno(id), null);
  });

  await t('CONCURRENCIA: 12 reclamos simultáneos de la misma orden → exactamente uno procesa', async () => {
    const res = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      reclamarPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L5'), payload: { i } })));
    const procesar = res.filter(r => r.accion === 'procesar');
    assert.equal(procesar.length, 1, `procesar=${procesar.length} acciones=${res.map(r => r.accion).join(',')}`);
    assert.equal(res.filter(r => r.accion === 'en_curso').length, 11);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM pedidos_externos WHERE negocio_id=$1 AND id_externo=$2`, [NEG_A, ext('L5')]);
    assert.equal(rows[0].n, 1);
  });

  await t('cancelación y "listo" quedan trazados; listo se marca una sola vez', async () => {
    const r = await reclamarPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L6'), payload: {} });
    await marcarPedidoExternoCreado(r.registro.id, { folio: 'XAB-TEST-6' });
    assert.equal(await marcarListoNotificado(NEG_A, 'rappi', 'XAB-TEST-6'), true);
    assert.equal(await marcarListoNotificado(NEG_A, 'rappi', 'XAB-TEST-6'), false);
    await marcarPedidoExternoCancelado(r.registro.id, { evento: 'canceled_with_charge', resultado: 'cancelado' });
    const fila = await obtenerPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L6') });
    assert.equal(fila.estado, 'cancelado'); assert.equal(fila.cancelacion.resultado, 'cancelado'); assert.ok(fila.listo_notificado_at);
    assert.equal((await reclamarPedidoExterno({ negocioId: NEG_A, canal: 'rappi', idExterno: ext('L6'), payload: {} })).accion, 'duplicado');
  });

  // ── Fixtures reales (si existen) ──
  const reales = readdirSync(join(__dirname, 'fixtures', 'rappi')).filter(f => f.endsWith('.real.json'));
  for (const f of reales) {
    await t(`fixture real ${f}: se reconoce como orden y cada item queda resuelto o auditado`, () => {
      const s = normalizarSobreRappi(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'rappi', f), 'utf8')));
      assert.ok(s, 'no es una orden');
      const { orden, auditoria } = mapearOrdenRappi(s, catalogo, negocio);
      assert.equal(orden.items.length, s.items.length);
      for (const it of orden.items) assert.ok(['sku', 'nombre', 'sin_resolver'].includes(it.mapeo));
      console.log(`      ${f}: ${auditoria.resueltos} por sku, ${auditoria.por_nombre} por nombre, ${auditoria.sin_resolver.length} sin resolver`);
    });
  }
  if (!reales.length) console.log('  (sin fixtures *.real.json todavía — ver test/fixtures/rappi/README.md)');
} finally {
  await limpiar();
  await pool.end();
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { for (const f of fallos) console.log(' - ' + f); process.exit(1); }
