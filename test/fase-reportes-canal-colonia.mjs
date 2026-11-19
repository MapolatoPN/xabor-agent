// Reportes → Ventas: ventas por canal y colonias con más envíos.
//
// Origen (18-nov-2026): el dueño preguntó a qué colonias se envía más y qué
// porcentaje de las compras entra por cada canal. Los dos datos se guardaban
// en cada pedido, pero ningún reporte los juntaba. Salen de la MISMA lista de
// ventas que la tarjeta (services/reporteVentas.js → construirReporteVentas):
//   · Σ venta por canal = venta neta; Σ pedidos por canal = Pedidos;
//   · Σ envíos por colonia (con «sin colonia») = Domicilios;
//   · los porcentajes suman exactamente 100;
//   · la colonia es texto libre: se agrupa sin mayúsculas, acentos ni «Col.»;
//   · WhatsApp guarda la dirección en un solo texto: la colonia se lee solo
//     cuando la dirección la NOMBRA o un tramo entre comas ES una colonia ya
//     vista; nunca se adivina por parecido.
// Desde el 19-nov-2026 (casos 17–23): un nombre de zona de envío no es una
// colonia; «sin colonia» dice su motivo; hay envíos por zona y cada colonia y
// zona se compara con el periodo anterior.
//
// Los importes, colonias y direcciones son inventados: el repo es público.
//
// Uso: DATABASE_URL=... (y el resto de variables de las suites) node test/fase-reportes-canal-colonia.mjs
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT_REPCANAL || '4978';
const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const {
  construirReporteVentas, armarReporteVentas, canalDeVenta, porcentajes, limpiarColonia, coloniaNombradaEn,
} = await import('../src/services/reporteVentas.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const c = (n) => Math.round(Number(n) * 100);
const decimas = (lista) => lista.reduce((s, x) => s + Math.round(x * 10), 0);
const DOM = 'entrega a domicilio';
const fila = (folio, datos, estado = 'entregado') => ({ folio, estado, datos: { forma_pago: 'efectivo', ...datos }, creado_at: new Date('2026-10-07T17:00:00Z') });
const reporte = (filas) => construirReporteVentas(filas);
const colonia = (r, nombre) => r.por_colonia.colonias.find(x => x.colonia === nombre);

// ─── A. Por canal, sin base ────────────────────────────────────────────────
const MEZCLA = [
  fila('RC-1', { canal: 'whatsapp', modalidad: DOM, total: 150 }),
  fila('RC-2', { canal: 'whatsapp', modalidad: 'recoger en tienda', total: 90.5 }),
  fila('RC-3', { canal: 'pos', modalidad: DOM, total: 100, cliente: { colonia: 'Centro' } }),
  fila('RC-4', { canal: 'presencial', modalidad: 'recoger en tienda', total: 49.99 }),
  fila('RM-RC000001-0', { canal: 'restaurante_mesa', modalidad: 'mesa', total: 300, items: [{ nombre: 'Comida', cantidad: 1, precio_unitario: 300 }] }),
  fila('RC-6', { canal: 'tienda_online', modalidad: DOM, total: 210, forma_pago: 'enlace_pago', pago_confirmado: true }),
  fila('RC-7', { canal: 'rappi', pago: 'rappi_pay', forma_pago: undefined, modalidad: DOM, total: 80 }),
  // Fuera de la venta: no cuentan en ningún canal.
  fila('RC-8', { canal: 'whatsapp', modalidad: DOM, total: 999 }, 'cancelado'),
  fila('RC-9', { canal: 'tienda_online', modalidad: DOM, total: 888, forma_pago: 'enlace_pago' }, 'pendiente_pago'),
];

await t('CANAL', '1. las palabras del panel: pos y presencial son Mostrador; mesa es Restaurante; lo raro se muestra tal cual', async () => {
  const e = (datos) => canalDeVenta(datos);
  assert.deepStrictEqual(e({ canal: 'pos' }), { clave: 'mostrador', etiqueta: 'Mostrador' });
  assert.deepStrictEqual(e({ canal: 'presencial' }), { clave: 'mostrador', etiqueta: 'Mostrador' });
  assert.deepStrictEqual(e({ canal: 'WhatsApp ' }), { clave: 'whatsapp', etiqueta: 'WhatsApp' }, 'mayúsculas y espacios no inventan otro canal');
  assert.deepStrictEqual(e({ canal: 'restaurante_mesa' }), { clave: 'restaurante', etiqueta: 'Restaurante (mesas)' });
  assert.deepStrictEqual(e({ modalidad: 'mesa' }), { clave: 'restaurante', etiqueta: 'Restaurante (mesas)' }, 'mesa vieja sin canal');
  assert.deepStrictEqual(e({}), { clave: 'sin_canal', etiqueta: 'Sin canal registrado' });
  assert.deepStrictEqual(e({ canal: 'kiosko' }), { clave: 'otro:kiosko', etiqueta: 'kiosko' });
  assert.deepStrictEqual(e({ canal: 'constructor' }), { clave: 'otro:constructor', etiqueta: 'constructor' }, 'un nombre de Object.prototype no es un canal conocido');
});

await t('CANAL', '2. Σ venta por canal = venta neta y Σ pedidos = Pedidos; cancelados y por cobrar no entran', async () => {
  const r = reporte(MEZCLA);
  const pc = r.por_canal;
  assert.strictEqual(pc.reduce((s, x) => s + c(x.venta), 0), c(r.resumen.total_ventas), 'Σ venta por canal ≠ tarjeta');
  assert.strictEqual(pc.reduce((s, x) => s + x.pedidos, 0), r.resumen.num_pedidos, 'Σ pedidos por canal ≠ Pedidos');
  const wa = pc.find(x => x.canal === 'whatsapp');
  assert.deepStrictEqual([wa.pedidos, wa.venta, wa.ticket_promedio], [2, 240.5, 120.25], 'el cancelado de WhatsApp se contó');
  const mos = pc.find(x => x.canal === 'mostrador');
  assert.deepStrictEqual([mos.pedidos, mos.venta], [2, 149.99], 'pos y presencial no se juntaron');
  assert.strictEqual(pc.find(x => x.canal === 'tienda_online').pedidos, 1, 'el pendiente de pago de la tienda se contó');
  assert.deepStrictEqual(pc.map(x => x.canal), ['restaurante', 'whatsapp', 'tienda_online', 'mostrador', 'rappi'], 'de mayor a menor venta');
});

await t('CANAL', '3. los porcentajes suman exactamente 100.0 (pedidos y venta), también en un empate de tres', async () => {
  const pc = reporte(MEZCLA).por_canal;
  assert.strictEqual(decimas(pc.map(x => x.pct_pedidos)), 1000, `pedidos: ${pc.map(x => x.pct_pedidos)}`);
  assert.strictEqual(decimas(pc.map(x => x.pct_venta)), 1000, `venta: ${pc.map(x => x.pct_venta)}`);
  assert.deepStrictEqual(porcentajes([1, 1, 1]), [33.4, 33.3, 33.3], 'redondear cada uno daría 99.9');
  assert.deepStrictEqual(porcentajes([2, 1]), [66.7, 33.3]);
  assert.deepStrictEqual(porcentajes([0, 0]), [0, 0], 'sin nada no divide entre cero');
  assert.deepStrictEqual(porcentajes([5]), [100]);
  // Un mes de verdad trae miles de centavos: la suma sigue cerrando.
  const muchos = Array.from({ length: 9 }, (_, i) => 12345 + i * 7919);
  assert.strictEqual(decimas(porcentajes(muchos)), 1000);
});

await t('CANAL', '4. sin ventas no hay renglones (ni divisiones entre cero)', async () => {
  const r = reporte([fila('RC-X', { canal: 'pos', total: 10 }, 'cancelado')]);
  assert.deepStrictEqual(r.por_canal, []);
  assert.deepStrictEqual(r.por_colonia, { domicilios: 0, identificados: 0, del_texto: 0, colonias: [],
    sin_colonia: { pedidos: 0, venta: 0, pct_pedidos: 0, canales: [], motivos: [] } });
  assert.strictEqual(r.por_zona, null, 'sin zonas configuradas ni guardadas no hay tabla de zonas');
});

// ─── B. Por colonia, sin base ──────────────────────────────────────────────
await t('COLONIA', '5. «Col. Centro», «centro», «CENTRO» y «Céntro» son UNA colonia, con la forma más escrita', async () => {
  const r = reporte([
    fila('K1', { canal: 'pos', modalidad: DOM, total: 100, cliente: { colonia: 'Col. Centro' } }),
    fila('K2', { canal: 'tienda_online', modalidad: DOM, total: 200, cliente: { colonia: 'centro' } }),
    fila('K3', { canal: 'rappi', modalidad: DOM, total: 50, cliente: { colonia: 'CENTRO' } }),
    fila('K4', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Colonia  Céntro ' } }),
    fila('K5', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Centro' } }),
    // La primera forma vista no gana: gana la más escrita.
    fila('K6', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Fracc. Las fuentes' } }),
    fila('K7', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Las Fuentes' } }),
    fila('K7b', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Col. Las Fuentes' } }),
  ]);
  assert.deepStrictEqual(r.por_colonia.colonias.map(x => [x.colonia, x.pedidos]), [['Centro', 5], ['Las Fuentes', 3]]);
  assert.strictEqual(colonia(r, 'Centro').venta, 370);
  assert.strictEqual(r.por_colonia.del_texto, 0, 'todas venían del campo');
  assert.deepStrictEqual(limpiarColonia('Col. Centro 26000'), { clave: 'centro', nombre: 'Centro' }, 'el código postal no es parte del nombre');
  assert.deepStrictEqual(limpiarColonia('Peñitas'), { clave: 'penitas', nombre: 'Peñitas' }, 'se muestra con su ñ');
});

await t('COLONIA', '6. solo ventas a domicilio, las mismas que la tarjeta: Σ envíos (con «sin colonia») = Domicilios', async () => {
  const r = reporte([
    ...MEZCLA,
    fila('K8', { canal: 'pos', modalidad: 'recoger en tienda', total: 70, cliente: { colonia: 'Centro' } }),
  ]);
  const pc = r.por_colonia;
  assert.strictEqual(pc.domicilios, r.resumen.domicilios, `${pc.domicilios} ≠ tarjeta ${r.resumen.domicilios}`);
  assert.strictEqual(pc.colonias.reduce((s, x) => s + x.pedidos, 0) + pc.sin_colonia.pedidos, r.resumen.domicilios);
  assert.strictEqual(colonia(r, 'Centro').pedidos, 1, 'el pedido para recoger con colonia se contó como envío');
  assert.strictEqual(decimas([...pc.colonias.map(x => x.pct_pedidos), pc.sin_colonia.pct_pedidos]), 1000, 'los % de envíos no suman 100');
  assert.ok(!r.ventas.some(v => v.folio === 'RC-8'), 'precondición: el cancelado no es venta');
});

await t('COLONIA', '7. la dirección escrita que NOMBRA la colonia se lee, y se corta donde ya no es colonia', async () => {
  const casos = [
    ['Roble 12 col. Las Fuentes entre Pino y Cedro', 'Las Fuentes'],
    ['Calle 5 Col Centro CP 26000', 'Centro'],
    ['Roble 12, colonia 1ro de Mayo, ref casa verde', '1ro de Mayo'],
    ['Fraccionamiento Los Pinos esq. Olmo', 'Los Pinos'],
    ['Olmo 3 (Fracc. Villa Real) frente a la tienda', 'Villa Real'],
  ];
  for (const [dir, esperada] of casos) {
    assert.strictEqual(coloniaNombradaEn(dir)?.nombre, esperada, `«${dir}» → ${JSON.stringify(coloniaNombradaEn(dir))}`);
  }
  const r = reporte([
    fila('K9', { canal: 'whatsapp', modalidad: DOM, total: 120, cliente: { direccion: casos[0][0] } }),
    // La tienda en línea guarda el texto libre en `calle` cuando no hay colonia.
    fila('K9b', { canal: 'tienda_online', modalidad: DOM, total: 40, cliente: { calle: 'Pino 4 col. Roma', colonia: '' } }),
  ]);
  assert.deepStrictEqual(r.por_colonia.colonias.map(x => x.colonia), ['Las Fuentes', 'Roma']);
  assert.strictEqual(r.por_colonia.del_texto, 2);
});

await t('COLONIA', '8. el formulario de WhatsApp («calle, colonia, zona»): el tramo cuenta solo si ES una colonia ya vista', async () => {
  const conocida = fila('K10', { canal: 'pos', modalidad: DOM, total: 100, cliente: { colonia: 'Centro' } });
  const wa = fila('K11', { canal: 'whatsapp', modalidad: DOM, total: 150, cliente: { direccion: 'Hidalgo 405, centro, Zona Norte' } });
  const r = reporte([conocida, wa]);
  assert.deepStrictEqual(r.por_colonia.colonias.map(x => [x.colonia, x.pedidos]), [['Centro', 2]]);
  assert.strictEqual(r.ventas.find(v => v.folio === 'K11').colonia, 'Centro', 'el renglón no dice su colonia');
  // Sin una colonia conocida que coincida, no se toma el segundo tramo a ciegas
  // (aunque haya OTRAS colonias conocidas en el periodo).
  const otra = fila('K10b', { canal: 'pos', modalidad: DOM, total: 100, cliente: { colonia: 'Roma' } });
  const solo = reporte([otra, wa]);
  assert.deepStrictEqual(solo.por_colonia.colonias.map(x => x.colonia), ['Roma'], `se adivinó: ${JSON.stringify(solo.por_colonia.colonias)}`);
  assert.strictEqual(solo.por_colonia.sin_colonia.pedidos, 1);
  assert.strictEqual(reporte([wa]).por_colonia.sin_colonia.pedidos, 1, 'sin ninguna conocida');
});

await t('COLONIA', '9. nunca se adivina por parecido: «frente al centro comercial» NO es la colonia Centro', async () => {
  const r = reporte([
    fila('K12', { canal: 'pos', modalidad: DOM, total: 100, cliente: { colonia: 'Centro' } }),
    fila('K13', { canal: 'whatsapp', modalidad: DOM, total: 90, cliente: { direccion: 'Frente al centro comercial, casa azul' } }),
    fila('K14', { canal: 'whatsapp', modalidad: DOM, total: 90, cliente: { direccion: 'Av. Colón 12' } }),
    fila('K15', { canal: 'whatsapp', modalidad: DOM, total: 90, cliente: { direccion: 'Colegio Militar 5' } }),
  ]);
  assert.deepStrictEqual(r.por_colonia.colonias.map(x => [x.colonia, x.pedidos]), [['Centro', 1]]);
  assert.strictEqual(r.por_colonia.sin_colonia.pedidos, 3);
  for (const t of ['Av. Colón 12', 'Colegio Militar 5', 'Calle Colinas 4']) assert.strictEqual(coloniaNombradaEn(t), null, `«${t}» no nombra colonia`);
});

await t('COLONIA', '10. lo que no es colonia («n/a», «S/N», «—», «Colonia», vacío) cae en «sin colonia»', async () => {
  for (const basura of ['n/a', 'S/N', '—', '---', 'Colonia', 'col.', 'ninguna', '', '   ', '12345']) {
    assert.strictEqual(limpiarColonia(basura), null, `«${basura}» pasó como colonia`);
  }
  const r = reporte([
    fila('K16', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'S/N' } }),
    fila('K17', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: null } }),
    fila('K18', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 7 } }),
  ]);
  assert.deepStrictEqual([r.por_colonia.colonias.length, r.por_colonia.sin_colonia.pedidos], [0, 3]);
});

await t('COLONIA', '11. «sin colonia» dice cuántos y de qué canal; identificados y leídos del texto cuadran', async () => {
  const r = reporte([
    fila('K19', { canal: 'pos', modalidad: DOM, total: 100, cliente: { colonia: 'Centro' } }),
    fila('K20', { canal: 'whatsapp', modalidad: DOM, total: 50, cliente: { direccion: 'Pino 1 col. Centro' } }),
    fila('K21', { canal: 'whatsapp', modalidad: DOM, total: 60, cliente: { direccion: 'Pino 2' } }),
    fila('K22', { canal: 'whatsapp', modalidad: DOM, total: 70, cliente: {} }),
    fila('K23', { canal: 'rappi', modalidad: DOM, total: 80, cliente: { colonia: '' } }),
  ]);
  const pc = r.por_colonia;
  assert.deepStrictEqual([pc.domicilios, pc.identificados, pc.del_texto], [5, 2, 1]);
  assert.deepStrictEqual(pc.sin_colonia, { pedidos: 3, venta: 210, pct_pedidos: 60,
    canales: [{ etiqueta: 'WhatsApp', pedidos: 2 }, { etiqueta: 'Rappi', pedidos: 1 }],
    motivos: [
      { motivo: 'sin_direccion', etiqueta: 'Sin dirección registrada', pedidos: 2,
        canales: [{ etiqueta: 'Rappi', pedidos: 1 }, { etiqueta: 'WhatsApp', pedidos: 1 }] },
      { motivo: 'sin_colonia', etiqueta: 'La dirección no dice la colonia', pedidos: 1,
        canales: [{ etiqueta: 'WhatsApp', pedidos: 1 }] },
    ] });
});

await t('COLONIA', '12. cada renglón de la tabla (y del CSV) lleva su colonia; los que no son envío, ninguna', async () => {
  const r = reporte([
    ...MEZCLA,
    fila('K24', { canal: 'whatsapp', modalidad: DOM, total: 10, cliente: { direccion: 'Olmo 1, CEntro' } }),
    // Para recoger, aunque el cliente tenga colonia guardada.
    fila('K24b', { canal: 'pos', modalidad: 'recoger en tienda', total: 10, cliente: { colonia: 'Centro' } }),
  ]);
  const de = (f) => r.ventas.find(v => v.folio === f).colonia;
  assert.strictEqual(de('RC-3'), 'Centro');
  assert.strictEqual(de('K24'), 'Centro', 'la que se leyó del texto lleva el nombre del grupo, no «CEntro»');
  assert.strictEqual(de('RC-4'), null, 'un pedido para recoger no lleva colonia');
  assert.strictEqual(de('K24b'), null, 'un pedido para recoger con colonia guardada se contó como envío');
  assert.strictEqual(de('RC-1'), null, 'un envío sin colonia no inventa una');
  assert.ok(r.ventas.every(v => 'colonia' in v), 'algún renglón no trae la llave colonia');
});

await t('COLONIA', '13. orden: más envíos primero; en empate, más venta; luego por nombre', async () => {
  const r = reporte([
    fila('K25', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Bravo' } }),
    fila('K26', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Alfa' } }),
    fila('K27', { canal: 'pos', modalidad: DOM, total: 90, cliente: { colonia: 'Delta' } }),
    fila('K28', { canal: 'pos', modalidad: DOM, total: 5, cliente: { colonia: 'Eco' } }),
    fila('K29', { canal: 'pos', modalidad: DOM, total: 5, cliente: { colonia: 'Eco' } }),
  ]);
  assert.deepStrictEqual(r.por_colonia.colonias.map(x => x.colonia), ['Eco', 'Delta', 'Alfa', 'Bravo']);
});

// ─── E. Zonas de envío, sin base ───────────────────────────────────────────
// Origen (19-nov-2026): la tienda guarda el nombre de la zona en `colonia`
// cuando el cliente no escribe una, y «Dentro de la Ciudad» encabezaba la
// lista de colonias. Zonas y colonias inventadas.
const ZONAS = [{ nombre: 'Zona Centro Amplia', costo: 30 }, { nombre: 'Campus Uno / C1', costo: 50 }, { nombre: 'Sin Tarifa' }];
const conZonas = (filas, zonas = ZONAS) => construirReporteVentas(filas, null, { zonas });
// Lo que guarda la tienda: la zona elegida en `tienda.zona` y, sin colonia escrita, la misma en `colonia`.
const tienda = (folio, zona, cliente, extra = {}) => fila(folio, { canal: 'tienda_online', modalidad: DOM, total: 100, costo_envio: 30,
  forma_pago: 'enlace_pago', pago_confirmado: true, tienda: { zona }, cliente, ...extra });

await t('ZONA', '17. el nombre de zona que la tienda copió en la colonia NO es una colonia (ni «conocida» para WhatsApp)', async () => {
  const filas = [
    tienda('Z1', 'Zona Centro Amplia', { calle: 'Pino 1', colonia: 'Zona Centro Amplia' }),
    tienda('Z2', 'Zona Centro Amplia', { calle: 'Pino 2', colonia: 'Zona Centro Amplia' }),
    tienda('Z3', 'Zona Centro Amplia', { calle: 'Pino 3', colonia: 'Roma' }),
    // Antes, el tramo «Zona Centro Amplia» coincidía con esa «colonia conocida».
    fila('Z4', { canal: 'whatsapp', modalidad: DOM, total: 80, cliente: { direccion: 'Hidalgo 4, Zona Centro Amplia' } }),
  ];
  const r = conZonas(filas);
  assert.deepStrictEqual(r.por_colonia.colonias.map(x => [x.colonia, x.pedidos]), [['Roma', 1]], JSON.stringify(r.por_colonia.colonias));
  assert.strictEqual(r.por_colonia.sin_colonia.pedidos, 3);
  assert.strictEqual(r.ventas.find(v => v.folio === 'Z4').colonia, null, 'el tramo de zona se tomó como colonia');
  assert.strictEqual(r.por_colonia.colonias.reduce((s, x) => s + x.pedidos, 0) + r.por_colonia.sin_colonia.pedidos, r.resumen.domicilios);
  // También sin la zona en la configuración: basta con que la tienda la haya guardado.
  const sinConfig = conZonas(filas, []);
  assert.deepStrictEqual(sinConfig.por_colonia.colonias.map(x => x.colonia), ['Roma'], 'una zona que ya no está configurada volvió a ser colonia');
});

await t('ZONA', '18. una zona configurada (con su alias «A / B») no es colonia en ningún canal; si la dirección nombra otra, esa sí', async () => {
  const r = conZonas([
    fila('Z5', { canal: 'pos', modalidad: DOM, total: 60, cliente: { calle: 'Olmo 1', colonia: 'campus uno' } }),
    fila('Z6', { canal: 'pos', modalidad: DOM, total: 60, cliente: { calle: 'Olmo 2', colonia: 'Col. C1' } }),
    fila('Z7', { canal: 'whatsapp', modalidad: DOM, total: 60, cliente: { direccion: 'Olmo 3, col. Zona Centro Amplia' } }),
    // La tienda con la zona copiada, pero la calle nombra la colonia: se usa la de la calle.
    tienda('Z8', 'Zona Centro Amplia', { calle: 'Pino 4 col. Las Fuentes', colonia: 'Zona Centro Amplia' }),
    // Una zona sin tarifa sigue siendo nombre de zona.
    fila('Z9', { canal: 'pos', modalidad: DOM, total: 60, cliente: { calle: 'Olmo 5', colonia: 'Sin Tarifa' } }),
  ]);
  assert.deepStrictEqual(r.por_colonia.colonias.map(x => [x.colonia, x.pedidos]), [['Las Fuentes', 1]], JSON.stringify(r.por_colonia.colonias));
  assert.strictEqual(r.ventas.find(v => v.folio === 'Z8').colonia, 'Las Fuentes');
  assert.strictEqual(r.por_colonia.del_texto, 1);
});

await t('ZONA', '19. «sin colonia» dice el motivo y el canal: solo eligió zona, la dirección no la dice, sin dirección', async () => {
  const r = conZonas([
    tienda('Z10', 'Zona Centro Amplia', { calle: 'Pino 1', colonia: 'Zona Centro Amplia' }),
    tienda('Z11', 'Campus Uno / C1', { calle: 'Edificio 2', colonia: 'Campus Uno / C1' }),
    fila('Z12', { canal: 'whatsapp', modalidad: DOM, total: 50, cliente: { direccion: 'Frente a la plaza' } }),
    fila('Z13', { canal: 'rappi', modalidad: DOM, total: 50, cliente: {} }),
    fila('Z14', { canal: 'pos', modalidad: DOM, total: 50, cliente: { calle: 'Roble 3', colonia: 'Centro' } }),
  ]);
  const sin = r.por_colonia.sin_colonia;
  assert.deepStrictEqual(sin.motivos.map(m => [m.motivo, m.pedidos, m.canales.map(c => `${c.etiqueta} ${c.pedidos}`).join()]), [
    ['solo_zona', 2, 'Tienda en línea 2'],
    ['sin_colonia', 1, 'WhatsApp 1'],
    ['sin_direccion', 1, 'Rappi 1'],
  ], JSON.stringify(sin.motivos));
  assert.strictEqual(sin.motivos.reduce((s, m) => s + m.pedidos, 0), sin.pedidos, 'Σ motivos ≠ sin colonia');
  assert.deepStrictEqual(sin.motivos.map(m => m.etiqueta), ['Solo eligió la zona de envío', 'La dirección no dice la colonia', 'Sin dirección registrada']);
});

await t('ZONA', '20. el % de cada colonia también sobre los envíos CON colonia (suma 100) y el de todos sigue sumando 100', async () => {
  const r = conZonas([
    fila('Z15', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Alfa' } }),
    fila('Z16', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Alfa' } }),
    fila('Z17', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Bravo' } }),
    fila('Z18', { canal: 'whatsapp', modalidad: DOM, total: 10, cliente: { direccion: 'Sin datos' } }),
  ]);
  const pc = r.por_colonia;
  assert.deepStrictEqual(pc.colonias.map(x => x.pct_con_colonia), [66.7, 33.3]);
  assert.deepStrictEqual(pc.colonias.map(x => x.pct_pedidos), [50, 25]);
  assert.strictEqual(decimas([...pc.colonias.map(x => x.pct_pedidos), pc.sin_colonia.pct_pedidos]), 1000);
});

await t('ZONA', '21. envíos por zona: tienda, formulario de WhatsApp («en la ciudad» = sin zona) y la que nombra la dirección', async () => {
  const r = conZonas([
    // Escrita distinto en el pedido: se muestra como está configurada.
    tienda('Z20', 'ZONA CENTRO AMPLIA', { calle: 'Pino 1', colonia: 'ZONA CENTRO AMPLIA' }),
    tienda('Z21', 'zona centro amplia', { calle: 'Pino 2', colonia: 'Roma' }),
    // El formulario: la zona elegida manda; vacía es «en la ciudad» aunque el texto nombre una.
    fila('Z22', { canal: 'whatsapp', modalidad: DOM, total: 90, costo_envio: 50,
      cliente: { direccion: 'Edificio 3, Centro, Campus Uno / C1', direccion_partes: { colonia: 'Centro', zona: 'Campus Uno / C1' } } }),
    fila('Z23', { canal: 'whatsapp', modalidad: DOM, total: 90, costo_envio: 25,
      cliente: { direccion: 'Roble 1, Centro, C1', direccion_partes: { colonia: 'Centro', zona: '' } } }),
    // Sin formulario: la zona que nombra la dirección (alias incluido), como la cobra el bot.
    fila('Z24', { canal: 'whatsapp', modalidad: DOM, total: 90, costo_envio: 50, cliente: { direccion: 'Biblioteca de C1' } }),
    fila('Z25', { canal: 'pos', modalidad: DOM, total: 90, costo_envio: 20, cliente: { calle: 'Olmo 1', colonia: 'Las Fuentes' } }),
    fila('Z26', { canal: 'pos', modalidad: 'recoger en tienda', total: 90, tienda: { zona: 'Zona Centro Amplia' } }),
  ]);
  const pz = r.por_zona;
  assert.deepStrictEqual(pz.zonas.map(z => [z.zona, z.pedidos, z.envio]), [['Campus Uno / C1', 2, 100], ['Zona Centro Amplia', 2, 60]], JSON.stringify(pz));
  assert.deepStrictEqual([pz.sin_zona.pedidos, pz.sin_zona.envio], [2, 45]);
  assert.strictEqual(pz.zonas.reduce((s, z) => s + z.pedidos, 0) + pz.sin_zona.pedidos, r.resumen.domicilios, 'Σ zonas ≠ Domicilios');
  assert.strictEqual(c(pz.zonas.reduce((s, z) => s + z.envio, 0) + pz.sin_zona.envio), c(r.resumen.total_envios), 'Σ envío cobrado ≠ tarjeta');
  assert.strictEqual(decimas([...pz.zonas.map(z => z.pct_pedidos), pz.sin_zona.pct_pedidos]), 1000);
  // Sin zonas configuradas, la que guardó la tienda igual se cuenta; sin ninguna, no hay tabla.
  assert.deepStrictEqual(conZonas([tienda('Z27', 'Zona Vieja', { calle: 'Pino 9', colonia: 'Zona Vieja' })], []).por_zona.zonas.map(z => z.zona), ['Zona Vieja']);
  assert.strictEqual(conZonas([fila('Z28', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Alfa' } })], []).por_zona, null);
});

await t('ZONA', '22. contra el periodo anterior: envíos de cada colonia y zona por la misma clave; 0 si no tuvo', async () => {
  const actual = [
    fila('Z30', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Centro' } }),
    fila('Z31', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Centro' } }),
    fila('Z32', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Roma' } }),
    tienda('Z33', 'Zona Centro Amplia', { calle: 'Pino 1', colonia: 'Zona Centro Amplia' }),
  ];
  const anterior = [
    fila('Z40', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'CENTRO' } }),
    fila('Z41', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'col. centro' } }),
    fila('Z42', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Centro' } }),
    fila('Z43', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Obrera' } }),
    tienda('Z44', 'Zona Centro Amplia', { calle: 'Pino 1', colonia: 'Zona Centro Amplia' }),
    tienda('Z45', 'Zona Centro Amplia', { calle: 'Pino 1', colonia: 'Zona Centro Amplia' }),
    // Cancelado: no cuenta tampoco en el anterior.
    fila('Z46', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'Roma' } }, 'cancelado'),
    // El anterior también conoce las zonas configuradas: «C1» es zona, no «sin zona».
    fila('Z47', { canal: 'pos', modalidad: DOM, total: 10, cliente: { colonia: 'C1' } }),
  ];
  const r = armarReporteVentas({ filas: actual, filasAnteriores: anterior, desde: '2026-10-01', hasta: '2026-10-31',
    tz: 'America/Matamoros', hoy: '2026-11-19', zonas: ZONAS });
  assert.deepStrictEqual(r.por_colonia.colonias.map(x => [x.colonia, x.pedidos, x.pedidos_anterior]), [['Centro', 2, 3], ['Roma', 1, 0]]);
  assert.deepStrictEqual(r.por_zona.zonas.map(z => [z.zona, z.pedidos, z.pedidos_anterior]), [['Zona Centro Amplia', 1, 2]]);
  assert.deepStrictEqual([r.por_zona.sin_zona.pedidos, r.por_zona.sin_zona.pedidos_anterior], [3, 4]);
  assert.strictEqual(r.comparacion.etiqueta, 'septiembre');
});

// ─── C. Con Postgres real y el servidor ────────────────────────────────────
const SLUGS = ['reportes-canal-colonia-a', 'reportes-canal-colonia-b', 'reportes-canal-colonia-c'];
async function limpiar() {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug = ANY($1)`, [SLUGS]);
  for (const { id } of rows) {
    const q = (sql) => pool.query(sql, [id]).catch(() => {});
    await q(`DELETE FROM pedidos_activos WHERE negocio_id = $1`);
    await q(`DELETE FROM configuracion WHERE negocio_id = $1`);
    await q(`DELETE FROM negocio_modulos WHERE negocio_id = $1`);
    await q(`DELETE FROM usuario_negocios WHERE negocio_id = $1`);
    await q(`DELETE FROM usuarios WHERE negocio_id = $1`);
    await q(`DELETE FROM negocios WHERE id = $1`);
  }
}
await limpiar();

async function negocio(slug, nombre) {
  const { rows: [n] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id`, [nombre, slug]);
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'pos','activo')`, [n.id]);
  const { rows: [u] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
    [n.id, `admin ${slug}`, `${slug}-admin-${Date.now()}@test.local`]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin')`, [u.id, n.id]);
  return { id: n.id, admin: `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: u.id, negocioId: n.id, rol: 'admin' }))}` };
}
const A = await negocio(SLUGS[0], 'Reportes Canal A');
const B = await negocio(SLUGS[1], 'Reportes Canal B');

// created_at es timestamp SIN zona que guarda UTC. 7-oct-2020 a mediodía de Matamoros (CDT) = 17:00Z.
async function pedido(neg, folio, datos, estado = 'entregado', creado = '2020-10-07 17:00:00') {
  await pool.query(`INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at) VALUES ($1,$2,$3,$4,$5::timestamp)`,
    [folio, estado, JSON.stringify({ id: folio, negocioId: neg, forma_pago: 'efectivo', ...datos }), neg, creado]);
}
const DIA = '2020-10-07';
// Campo (POS), calle con la colonia en otro campo (tienda), dirección escrita (WhatsApp) y Rappi.
await pedido(A.id, 'RCC-0001', { canal: 'pos', modalidad: DOM, total: 100, cliente: { nombre: 'Uno', calle: 'Pino', numero_exterior: '1', colonia: 'Col. Centro' } });
await pedido(A.id, 'RCC-0002', { canal: 'tienda_online', modalidad: DOM, total: 200, pago_confirmado: true, forma_pago: 'enlace_pago',
  cliente: { nombre: 'Dos', calle: 'Roble 12 cerca de la plaza', colonia: 'centro' } });
await pedido(A.id, 'RCC-0003', { canal: 'whatsapp', modalidad: DOM, total: 150, cliente: { nombre: 'Tres', direccion: 'Hidalgo 405, Centro, Zona Norte' } });
await pedido(A.id, 'RCC-0004', { canal: 'whatsapp', modalidad: DOM, total: 120, cliente: { nombre: 'Cuatro', direccion: 'Cedro 8 colonia Las Fuentes' } });
await pedido(A.id, 'RCC-0005', { canal: 'whatsapp', modalidad: DOM, total: 90, cliente: { nombre: 'Cinco', direccion: 'Frente al centro comercial' } });
await pedido(A.id, 'RCC-0006', { canal: 'rappi', pago: 'rappi_pay', forma_pago: undefined, modalidad: DOM, total: 80, cliente: { nombre: 'Seis', calle: 'Dirección Rappi', colonia: 'LAS FUENTES' } });
await pedido(A.id, 'RCC-0007', { canal: 'presencial', modalidad: 'recoger en tienda', total: 60 });
await pedido(A.id, 'RCC-0008', { canal: 'whatsapp', modalidad: DOM, total: 500, cliente: { colonia: 'Centro' } }, 'cancelado');
await pedido(A.id, 'RCC-0009', { canal: 'tienda_online', modalidad: DOM, total: 40, pago_confirmado: true, forma_pago: 'enlace_pago',
  cliente: { nombre: 'Nueve', calle: 'Pino 4 col. Roma', colonia: null } });
// Otro negocio, mismo día: su colonia no puede aparecer en A.
await pedido(B.id, 'RCCB-0001', { canal: 'pos', modalidad: DOM, total: 77, cliente: { colonia: 'Solo De B' } });
// C tiene zonas de envío configuradas: la tienda guarda la zona y la copia en la colonia.
const C = await negocio(SLUGS[2], 'Reportes Canal C');
await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, 'reglas_atencion', $2)`,
  [C.id, JSON.stringify({ pedidos: { costo_envio: 25, zonas_entrega: [{ nombre: 'Zona Centro Amplia', costo: 30 }, { nombre: 'Campus Uno / C1', costo: 50 }] } })]);
const tiendaC = (folio, zona, cliente, creado) => pedido(C.id, folio, { canal: 'tienda_online', modalidad: DOM, total: 130, costo_envio: 30,
  pago_confirmado: true, forma_pago: 'enlace_pago', tienda: { zona, checkout_token: `tok-${folio}` }, cliente: { nombre: folio, ...cliente } }, 'entregado', creado);
await tiendaC('RCCC-0001', 'Zona Centro Amplia', { calle: 'Pino 1', colonia: 'Zona Centro Amplia' });
await tiendaC('RCCC-0002', 'Zona Centro Amplia', { calle: 'Pino 2', colonia: 'Roma' });
await pedido(C.id, 'RCCC-0003', { canal: 'whatsapp', modalidad: DOM, total: 140, costo_envio: 50,
  cliente: { nombre: 'Tres', direccion: 'Edificio 3, Roma, Campus Uno / C1', direccion_partes: { calle: 'Edificio 3', colonia: 'Roma', zona: 'Campus Uno / C1' } } });
await pedido(C.id, 'RCCC-0004', { canal: 'whatsapp', modalidad: DOM, total: 140, costo_envio: 25, cliente: { nombre: 'Cuatro', direccion: 'Frente a la plaza' } });
// «En la ciudad» en el formulario aunque la calle nombre la zona: tarifa base, sin zona.
await pedido(C.id, 'RCCC-0005', { canal: 'whatsapp', modalidad: DOM, total: 140, costo_envio: 25,
  cliente: { nombre: 'Cinco', direccion: 'Frente a C1, Roma', direccion_partes: { calle: 'Frente a C1', colonia: 'Roma', zona: '' } } });
// Mostrador con la zona escrita como colonia: es zona solo porque está configurada.
await pedido(C.id, 'RCCC-0006', { canal: 'pos', modalidad: DOM, total: 140, costo_envio: 20, cliente: { nombre: 'Seis', calle: 'Olmo 2', colonia: 'C1' } });
// El día anterior (el periodo con el que se compara un día): Roma 3, la zona 1.
for (const f of ['RCCC-0101', 'RCCC-0102', 'RCCC-0103']) {
  await pedido(C.id, f, { canal: 'pos', modalidad: DOM, total: 50, costo_envio: 20, cliente: { nombre: f, calle: 'Olmo', colonia: 'ROMA' } }, 'entregado', '2020-10-06 17:00:00');
}
await tiendaC('RCCC-0104', 'Zona Centro Amplia', { calle: 'Pino 9', colonia: 'Zona Centro Amplia' }, '2020-10-06 17:00:00');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
async function api(path, galleta) {
  const r = await fetch(srv.base + path, { headers: galleta ? { Cookie: galleta } : {} });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}

try {
  await t('HTTP', '14. la ruta trae por canal y por colonia, leídos de la base (campo, calle y dirección escrita)', async () => {
    const r = await api(`/api/reportes/ventas?desde=${DIA}&hasta=${DIA}`, A.admin);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    assert.deepStrictEqual(b.por_colonia.colonias.map(x => [x.colonia, x.pedidos, x.venta]),
      [['Centro', 3, 450], ['Las Fuentes', 2, 200], ['Roma', 1, 40]], `colonias: ${JSON.stringify(b.por_colonia.colonias)}`);
    assert.deepStrictEqual([b.por_colonia.domicilios, b.por_colonia.identificados, b.por_colonia.del_texto], [7, 6, 3]);
    assert.strictEqual(b.por_colonia.domicilios, b.resumen.domicilios, 'colonias ≠ tarjeta Domicilios');
    assert.deepStrictEqual(b.por_colonia.sin_colonia.canales, [{ etiqueta: 'WhatsApp', pedidos: 1 }]);
    assert.strictEqual(b.por_canal.reduce((s, x) => s + c(x.venta), 0), c(b.resumen.total_ventas));
    assert.deepStrictEqual(b.por_canal.map(x => [x.etiqueta, x.pedidos]),
      [['WhatsApp', 3], ['Tienda en línea', 2], ['Mostrador', 2], ['Rappi', 1]], `canales: ${JSON.stringify(b.por_canal)}`);
    assert.strictEqual(decimas(b.por_canal.map(x => x.pct_venta)), 1000);
    assert.strictEqual(b.ventas.find(v => v.folio === 'RCC-0003').colonia, 'Centro');
  });

  await t('SEGURIDAD', '15. cada negocio ve solo sus colonias y sus canales', async () => {
    const a = await api(`/api/reportes/ventas?desde=${DIA}&hasta=${DIA}`, A.admin);
    assert.ok(!a.body.por_colonia.colonias.some(x => /Solo De B/i.test(x.colonia)), 'A vio la colonia de B');
    const b = await api(`/api/reportes/ventas?desde=${DIA}&hasta=${DIA}&negocioId=${A.id}`, B.admin);
    assert.deepStrictEqual(b.body.por_colonia.colonias.map(x => x.colonia), ['Solo De B'], 'el query cruzó de negocio');
    assert.deepStrictEqual(b.body.por_canal.map(x => [x.etiqueta, x.pedidos]), [['Mostrador', 1]]);
    assert.strictEqual(a.body.por_zona, null, 'A no tiene zonas y le salió tabla de zonas');
  });

  await t('HTTP', '23. con zonas en la base: la zona copiada no es colonia, envíos por zona y contra el día anterior', async () => {
    const r = await api(`/api/reportes/ventas?desde=${DIA}&hasta=${DIA}`, C.admin);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const { por_colonia: pc, por_zona: pz } = r.body;
    assert.deepStrictEqual(pc.colonias.map(x => [x.colonia, x.pedidos, x.pedidos_anterior, x.pct_con_colonia]), [['Roma', 3, 3, 100]],
      `colonias: ${JSON.stringify(pc.colonias)}`);
    assert.deepStrictEqual(pc.sin_colonia.motivos.map(m => [m.motivo, m.pedidos, m.canales.map(x => x.etiqueta).join()]),
      [['solo_zona', 2, 'Mostrador,Tienda en línea'], ['sin_colonia', 1, 'WhatsApp']], JSON.stringify(pc.sin_colonia.motivos));
    assert.deepStrictEqual(pz.zonas.map(z => [z.zona, z.pedidos, z.envio, z.pedidos_anterior]),
      [['Campus Uno / C1', 2, 70, 0], ['Zona Centro Amplia', 2, 60, 1]], `zonas: ${JSON.stringify(pz)}`);
    assert.deepStrictEqual([pz.sin_zona.pedidos, pz.sin_zona.envio, pz.sin_zona.pedidos_anterior], [2, 50, 3]);
    assert.strictEqual(pz.zonas.reduce((s, z) => s + z.pedidos, 0) + pz.sin_zona.pedidos, r.body.resumen.domicilios);
    assert.strictEqual(r.body.ventas.find(v => v.folio === 'RCCC-0001').colonia, null);
  });
} finally {
  srv.detener();
}

// ─── D. El panel: nombres nuevos una sola vez y la colonia siempre escapada ─
const PANEL = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
await t('PANEL', '16. los nombres nuevos se declaran una sola vez (en el panel el último pisa al primero)', async () => {
  for (const n of ['vaTarjetaCanales', 'vaTarjetaColonias', 'vaVerTodasColonias', 'vaTarjetaZonas', 'vaCambioEnvios']) {
    const veces = PANEL.match(new RegExp(`function ${n}\\(`, 'g'))?.length || 0;
    assert.strictEqual(veces, 1, `${n} declarada ${veces} veces`);
  }
  for (const n of ['vaPct', 'VA_COLONIAS_VISIBLES', 'vaEnvios', 'vaCanalesTexto']) {
    const veces = PANEL.match(new RegExp(`(let|const|var) ${n}\\b`, 'g'))?.length || 0;
    assert.strictEqual(veces, 1, `${n} declarada ${veces} veces`);
  }
});

await limpiar().catch(() => {});
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
