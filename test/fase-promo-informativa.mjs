// Path INFORMATIVO de promociones (describirPromocionesVigentes).
//
// Regresión del bug de producción: el webhook de WhatsApp pasaba canal=null y
// el filtro canales.includes(canal) descartaba TODAS las promos estructuradas
// ("hoy no tenemos promociones" pese a una promo vigente). Aquí se certifica
// que una promoción automática vigente aparece como INFORMACIÓN aunque no haya
// carrito, con los filtros correctos de canal/día/horario, y que el cálculo
// real sigue siendo del motor (separación consulta vs cálculo).
//
// Determinista: se inyecta `ahora` (UTC) y timezone='UTC' para fijar el día y
// la hora sin depender de DST. 2024-01-02 = martes; 2024-01-03 = miércoles.
//
// Uso: DATABASE_URL=... node test/fase-promo-informativa.mjs
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { guardarPromocion, describirPromocionesVigentes, calcularPromociones } =
  await import('../src/services/tiendaPromociones.js');
const { validarOrdenPropuesta } = await import('../src/orders/validadorOrden.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
async function montarNegocio(slug, nombre) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET nombre=$1 RETURNING id`, [nombre, slug]);
  return n.id;
}
async function categoria(negocioId, nombre) {
  const { rows } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, orden) VALUES ($1,$2,0) ON CONFLICT DO NOTHING RETURNING id`, [negocioId, nombre]);
  if (rows[0]) return rows[0].id;
  return (await pool.query(`SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre=$2 LIMIT 1`, [negocioId, nombre])).rows[0].id;
}
async function producto(negocioId, catId, nombre, precio) {
  const { rows } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio) VALUES ($1,$2,$3,$4) RETURNING id`, [negocioId, catId, nombre, precio]);
  return rows[0].id;
}
async function limpiar(negocioId) {
  await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1`, [negocioId]).catch(() => {});
}

const NEG = await montarNegocio('promo-info-a', 'Promo Info A');
await limpiar(NEG);
const cat = await categoria(NEG, 'DESAYUNOS');
const pHotcakes = await producto(NEG, cat, 'Hotcakes Tradicionales', 150);
const pProtein  = await producto(NEG, cat, 'Protein Pancakes', 170);

const TZ = 'UTC';
const MAR_10 = new Date('2024-01-02T10:00:00Z'); // martes 10:00
const MAR_16 = new Date('2024-01-02T16:00:00Z'); // martes 16:00 (fuera 07-15)
const MIE_10 = new Date('2024-01-03T10:00:00Z'); // miércoles 10:00

async function crearMartes2x1(over = {}) {
  return (await guardarPromocion(NEG, {
    nombre: over.nombre || 'Martes 2x1', tipo: '2x1', automatica: true,
    cantidadRequerida: 2, cantidadBeneficiada: 1,
    diasSemana: over.diasSemana ?? [2],           // martes
    horaInicio: over.horaInicio ?? '07:00', horaFin: over.horaFin ?? '15:00',
    canales: over.canales ?? ['whatsapp', 'pos'],
    productos: over.productos ?? [pHotcakes, pProtein],
    codigo: over.codigo, // undefined ⇒ automática sin cupón
  })).id;
}
async function borra() { await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [NEG]); }
const describir = (canal, ahora) => describirPromocionesVigentes(NEG, { canal, ahora, timezone: TZ });

// ═══════════ TESTS ═══════════

await t('TEST 1 · martes dentro de horario + WhatsApp activa → la promo aparece (informativa)', async () => {
  await crearMartes2x1();
  const promos = await describir('whatsapp', MAR_10);
  assert.strictEqual(promos.length, 1, `esperaba 1 promo; fueron ${promos.length}`);
  assert.strictEqual(promos[0].nombre, 'Martes 2x1');
  assert.ok(/2x1|menor precio|gratis/i.test(promos[0].descripcion), 'debe traer descripción legible');
  await borra();
});

await t('TEST 2 · martes FUERA de horario (16:00) → no aparece', async () => {
  await crearMartes2x1();
  assert.strictEqual((await describir('whatsapp', MAR_16)).length, 0);
  await borra();
});

await t('TEST 3 · miércoles → no aparece la de martes', async () => {
  await crearMartes2x1();
  assert.strictEqual((await describir('whatsapp', MIE_10)).length, 0);
  await borra();
});

await t('TEST 4 · promo solo POS → no aparece para WhatsApp', async () => {
  await crearMartes2x1({ canales: ['pos'] });
  assert.strictEqual((await describir('whatsapp', MAR_10)).length, 0, 'una promo POS no debe salir en WhatsApp');
  assert.strictEqual((await describir('pos', MAR_10)).length, 1, 'sí debe salir en POS');
  await borra();
});

await t('TEST 5 · promoción automática sin cupón → sí aparece', async () => {
  const id = await crearMartes2x1(); // sin codigo
  const { rows } = await pool.query('SELECT codigo, automatica FROM tienda_promociones WHERE id=$1', [id]);
  assert.strictEqual(rows[0].codigo, null, 'sin cupón');
  assert.strictEqual(rows[0].automatica, true, 'automática');
  assert.strictEqual((await describir('whatsapp', MAR_10)).length, 1);
  await borra();
});

await t('TEST 6 · promo con PRODUCTOS específicos y SIN carrito → sí aparece como vigente', async () => {
  await crearMartes2x1({ productos: [pHotcakes] });
  const promos = await describir('whatsapp', MAR_10);
  assert.strictEqual(promos.length, 1, 'la existencia de la promo no depende de que haya carrito');
  await borra();
});

await t('TEST 7 · normalización de canal: undefined⇒default, mayúsc⇒ok, null/""/desconocido⇒fail-closed', async () => {
  await crearMartes2x1(); // canales ['whatsapp','pos']
  // undefined (omitir la clave) toma el default 'whatsapp' por compatibilidad:
  assert.strictEqual((await describirPromocionesVigentes(NEG, { ahora: MAR_10, timezone: TZ })).length, 1, 'canal omitido ⇒ default whatsapp');
  assert.strictEqual((await describir(undefined, MAR_10)).length, 1, 'canal: undefined ⇒ default whatsapp');
  // Solo se normaliza la FORMA (mayúsculas/espacios):
  assert.strictEqual((await describir('WhatsApp', MAR_10)).length, 1, "'WhatsApp' ⇒ whatsapp");
  assert.strictEqual((await describir('  WHATSAPP  ', MAR_10)).length, 1, 'espacios + mayúsculas ⇒ whatsapp');
  // FAIL-CLOSED: null / '' / no-string / desconocido NO asumen ningún canal:
  assert.strictEqual((await describir(null, MAR_10)).length, 0, 'null ⇒ fail-closed (NO se convierte en whatsapp)');
  assert.strictEqual((await describir('', MAR_10)).length, 0, "'' ⇒ fail-closed");
  assert.strictEqual((await describir('   ', MAR_10)).length, 0, 'solo espacios ⇒ fail-closed');
  assert.strictEqual((await describir('telegram', MAR_10)).length, 0, 'canal desconocido ⇒ fail-closed');
  await borra();
});

await t('TEST 8 · separación consulta vs cálculo: describir NO trae montos; el motor SÍ calcula', async () => {
  await crearMartes2x1({ productos: [pHotcakes, pProtein] });
  // Consulta informativa: solo describe, sin descuento ni total.
  const info = (await describir('whatsapp', MAR_10))[0];
  assert.ok(!('descuento' in info) && !('total' in info), 'la consulta informativa no expone montos');
  // Pedido: el motor calcula el descuento real (2x1 regala el más barato = 150).
  const items = [
    { producto_id: pHotcakes, categoria_id: cat, precio_unitario: 150, precio_base: 150, cantidad: 1 },
    { producto_id: pProtein,  categoria_id: cat, precio_unitario: 170, precio_base: 170, cantidad: 1 },
  ];
  const r = await calcularPromociones({
    negocioId: NEG, subtotal: 320, items, canal: 'whatsapp', modalidad: 'recoger', timezone: TZ, ahora: MAR_10,
  });
  assert.strictEqual(r.descuento, 150, `el motor calcula 150; fue ${r.descuento}`);
  await borra();
});

// ── Path REAL WhatsApp → PRICING ──────────────────────────────────────────
// registrarPedido(orden, 'whatsapp')  [whatsapp-meta.js:1059]
//   → validarOrdenPropuesta(orden, negocioId, { canal: 'whatsapp' })  [orderManager:195]
//   → calcularPromociones({ ..., canal: canalPromo })  [validadorOrden:311-318]
// donde canalPromo = String(opts.canal || orden.canal || 'whatsapp')...  [validadorOrden:141]
// Es un call-site DISTINTO del informativo (procesarMensaje, línea 995). Se crea
// una promo SIN restricción de día/hora (validarOrdenPropuesta no inyecta `ahora`)
// para aislar la dimensión CANAL sin flakiness temporal.
async function crearWppSiempre(canales = ['whatsapp']) {
  return (await guardarPromocion(NEG, {
    nombre: 'WA 2x1 siempre', tipo: '2x1', automatica: true,
    cantidadRequerida: 2, cantidadBeneficiada: 1,
    canales, productos: [pHotcakes, pProtein], // sin diasSemana / horario
  })).id;
}
const ordenWA = (canal) => ({
  canal, modalidad: 'recoger', forma_pago: 'efectivo',
  items: [{ nombre: 'Hotcakes Tradicionales', cantidad: 1 }, { nombre: 'Protein Pancakes', cantidad: 1 }],
});

await t('TEST 9 · PATH REAL WhatsApp→pricing: canal "whatsapp" (como registrarPedido) aplica el descuento', async () => {
  await crearWppSiempre(['whatsapp']);
  const v = await validarOrdenPropuesta(ordenWA('whatsapp'), NEG, { canal: 'whatsapp' });
  assert.ok(v.ok, 'la orden debe validar');
  assert.strictEqual(v.orden.subtotal, 320, 'precios reales de catálogo (150+170)');
  assert.strictEqual(v.orden.descuento, 150, `2x1 regala el más barato (150); fue ${v.orden.descuento}`);
  assert.strictEqual(v.orden.total, 170);
  assert.strictEqual(v.orden.promociones[0].tipo, '2x1');
  await borra();
});

await t('TEST 10 · pricing NUNCA recibió el null del path informativo (respuesta A)', async () => {
  await crearWppSiempre(['whatsapp']);
  // (a) Sin opts.canal, pero orden.canal="whatsapp": canalPromo hace fallback y
  //     el descuento SÍ aplica — el pricing jamás quedó en "ningún canal".
  const vFallback = await validarOrdenPropuesta(ordenWA('whatsapp'), NEG, {});
  assert.strictEqual(vFallback.orden.descuento, 150, 'fallback opts→orden.canal→whatsapp: aplica');
  // (b) Aun sin canal por ningún lado, el `|| "whatsapp"` de validadorOrden lo
  //     resuelve a whatsapp (el pricing por defecto nunca se queda sin canal).
  const ordenSinCanal = { modalidad: 'recoger', forma_pago: 'efectivo',
    items: [{ nombre: 'Hotcakes Tradicionales', cantidad: 1 }, { nombre: 'Protein Pancakes', cantidad: 1 }] };
  const vDefault = await validarOrdenPropuesta(ordenSinCanal, NEG, {});
  assert.strictEqual(vDefault.orden.descuento, 150, 'sin canal en ningún lado ⇒ default whatsapp ⇒ aplica');
  // (c) Filtro de canal también rige en pricing: promo whatsapp-only NO aplica en POS.
  const vPos = await validarOrdenPropuesta(ordenWA('pos'), NEG, { canal: 'pos' });
  assert.strictEqual(vPos.orden.descuento, 0, 'una promo whatsapp-only no aplica en canal pos');
  await borra();
});

// ═══════════ RESUMEN ═══════════
await limpiar(NEG);
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  - ' + fallos.join('\n  - ')); process.exit(1); }
