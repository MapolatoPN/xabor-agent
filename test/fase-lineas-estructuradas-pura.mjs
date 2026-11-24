// ─── Fase 2: líneas estructuradas — la lectura, sin base ────────────────────
//
// Sin Postgres ni servidor. Lo que se protege:
//   · 2.1 todos los canales (POS, mostrador, tienda, WhatsApp, Mesas, Rappi,
//     Temporada) salen en el MISMO formato: producto, tipo, cantidad, precio,
//     nota y modificadores como registros (grupo, opción, cantidad, precio
//     extra, referencia al menú);
//   · 2.2 Rappi: «Pechuga de pollo: 1» se empareja con su grupo del menú (por
//     SKU, por emparejamiento a mano o por nombre único) y lo que no, queda en
//     «Sin clasificar» con su texto y sus unidades;
//   · 2.3 la nota libre («T HARINA», el nombre del comensal) queda aparte, sin
//     las opciones repetidas;
//   · 2.4 el tipo de producto (envío, extra, bebida) y la marca inicial;
//   · nada se adivina: un nombre repetido o una opción de OTRO producto no se
//     empareja.
//
// Uso: node test/fase-lineas-estructuradas-pura.mjs
import assert from 'assert';
import {
  indexarCatalogo, estructurarLinea, estructurarVenta, estructurarTemporada, resumenDeLineas,
  claveEmparejamiento, normalizarTexto, tipoDeProducto, esProductoDeEnvio, tipoPropuestoInicial,
  CATEGORIAS_A_REVISAR, GRUPO_SIN_CLASIFICAR, CANAL_MESA, CANAL_RAPPI, TIPOS_PRODUCTO,
} from '../src/services/lineasEstructuradas.js';
import { datosEstructuradosRappi } from '../src/channels/rappiOpciones.js';
import { menuSinEnvios } from '../src/services/envioComoCargo.js';

let pasadas = 0, fallidas = 0;
function t(nombre, fn) {
  try { fn(); console.log('  OK  ' + nombre); pasadas++; }
  catch (e) { console.log('FALLO ' + nombre + ': ' + e.message); fallidas++; }
}

// ─── Un menú chico, con las trampas de verdad ────────────────────────────
const productos = [
  { id: 10, nombre: 'Chilaquiles', tipo: 'platillo', opciones: null },
  { id: 11, nombre: 'TACOS', tipo: 'platillo', opciones: null },
  { id: 12, nombre: 'ENVIO 60', tipo: 'envio', opciones: null },
  { id: 13, nombre: 'Agua de horchata', tipo: 'bebida', opciones: null },
  { id: 14, nombre: 'Enchiladas', tipo: 'platillo', opciones: null, codigo: 'ENC001' },
  { id: 15, nombre: 'Café', tipo: 'platillo', opciones: null },
  { id: 16, nombre: 'Cafe', tipo: 'platillo', opciones: null }, // mismo nombre sin acento: ambiguo
  { id: 17, nombre: 'Envío foráneo', tipo: 'platillo', opciones: { tipo_item: 'envio' } }, // marca vieja
];
const grupos = [
  { id: 100, producto_id: 10, nombre: 'Salsa', opciones: [
    { id: 1001, nombre: 'Verde', precio_extra: 0 }, { id: 1002, nombre: 'Roja', precio_extra: 0 },
    { id: 1003, nombre: 'Mole', precio_extra: 15 }] },
  { id: 101, producto_id: 10, nombre: 'Proteína', opciones: [
    { id: 1011, nombre: 'Pollo', precio_extra: 20 }, { id: 1012, nombre: 'Huevo', precio_extra: 15 },
    { id: 1013, nombre: 'Pechuga de pollo', precio_extra: 25 }] },
  { id: 110, producto_id: 11, nombre: 'Tacos', opciones: [
    { id: 1101, nombre: 'Asada', precio_extra: 25 }, { id: 1102, nombre: 'Pastor', precio_extra: 30 }] },
];
const catalogo = indexarCatalogo({ productos, grupos });
const sinEmparejar = new Map();

const CLAVES_LINEA = ['cantidad', 'estado', 'modificadores', 'nombre', 'nota', 'precio_unitario', 'producto_id', 'tipo'];
const CLAVES_MOD = ['cantidad', 'clasificado', 'grupo', 'grupo_id', 'opcion', 'opcion_id', 'orden', 'precio_estimado', 'precio_extra'];
const formaDe = (l) => {
  assert.deepStrictEqual(Object.keys(l).filter((k) => k !== 'linea').sort(), CLAVES_LINEA);
  for (const m of l.modificadores) assert.deepStrictEqual(Object.keys(m).sort(), CLAVES_MOD);
};

const modsVenta = [
  { grupo_id: 100, grupo: 'Salsa', opcion_id: 1003, opcion: 'Mole', precio_extra: 15 },
  { grupo_id: 101, grupo: 'Proteína', opcion_id: 1011, opcion: 'Pollo', precio_extra: 20 },
];

console.log('\n2.1 / 2.3 — POS, mostrador, tienda, WhatsApp');

t('POS: opciones como registros y la nota sin ellas («T HARINA»)', () => {
  const l = estructurarLinea({ producto_id: 10, nombre: 'Chilaquiles', cantidad: 2, precio_unitario: 135,
    modificadores: modsVenta, notas: 'Salsa: Mole · Proteína: Pollo · T HARINA' }, { canal: 'pos', catalogo });
  formaDe(l);
  assert.strictEqual(l.producto_id, 10);
  assert.strictEqual(l.estado, 'completa');
  assert.strictEqual(l.nota, 'T HARINA');
  assert.strictEqual(l.cantidad, 2);
  assert.strictEqual(l.precio_unitario, 135);
  assert.deepStrictEqual(l.modificadores.map((m) => [m.grupo_id, m.grupo, m.opcion_id, m.opcion, m.cantidad, m.precio_extra, m.clasificado, m.orden]),
    [[100, 'Salsa', 1003, 'Mole', 1, 15, true, 1], [101, 'Proteína', 1011, 'Pollo', 1, 20, true, 2]]);
});

t('tienda: el nombre del comensal queda como nota de la línea', () => {
  const l = estructurarLinea({ producto_id: 10, nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 135,
    modificadores: modsVenta, notas: 'Salsa: Mole, Proteína: Pollo, Para Juan' }, { canal: 'tienda_online', catalogo });
  assert.strictEqual(l.nota, 'Para Juan');
  assert.strictEqual(l.modificadores.length, 2);
});

t('WhatsApp: sin nota, la nota es null (no la cadena vacía)', () => {
  const l = estructurarLinea({ producto_id: 10, nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 135, modificadores: modsVenta },
    { canal: 'whatsapp', catalogo });
  assert.strictEqual(l.nota, null);
  assert.strictEqual(l.estado, 'completa');
});

t('una nota que solo dice lo mismo que las opciones no se duplica', () => {
  const l = estructurarLinea({ producto_id: 10, nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 135,
    modificadores: modsVenta, notas: 'Salsa: Mole · Proteína: Pollo' }, { canal: 'presencial', catalogo });
  assert.strictEqual(l.nota, null);
});

t('una opción guardada como objeto SIN id se busca en el menú (sin acentos ni mayúsculas)', () => {
  const l = estructurarLinea({ producto_id: 10, nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 135,
    modificadores: [{ grupo: 'proteina', opcion: 'HUEVO' }] }, { canal: 'pos', catalogo });
  assert.deepStrictEqual([l.modificadores[0].grupo_id, l.modificadores[0].opcion_id, l.modificadores[0].clasificado], [101, 1012, true]);
  assert.strictEqual(l.modificadores[0].precio_estimado, true, 'sin precio en la venta, el del menú es estimado');
});

t('un producto que ya no está en el menú conserva el id que guardó la venta', () => {
  const l = estructurarLinea({ producto_id: 999, nombre: 'Platillo retirado', cantidad: 1, precio_unitario: 90 }, { canal: 'pos', catalogo });
  assert.strictEqual(l.producto_id, 999);
  assert.strictEqual(l.estado, 'completa');
});

t('un producto desconocido queda «sin estructurar», con su nombre', () => {
  const l = estructurarLinea({ nombre: 'Pizza hawaiana', cantidad: 1, precio_unitario: 200 }, { canal: 'pos', catalogo });
  assert.strictEqual(l.producto_id, null);
  assert.strictEqual(l.estado, 'sin_estructurar');
  assert.strictEqual(l.nombre, 'Pizza hawaiana');
});

t('un nombre repetido en el menú no se adivina («Café» y «Cafe»)', () => {
  const l = estructurarLinea({ nombre: 'café', cantidad: 1, precio_unitario: 30 }, { canal: 'pos', catalogo });
  assert.strictEqual(l.producto_id, null);
  assert.strictEqual(l.estado, 'sin_estructurar');
});

t('«Pollo» y «Pechuga de pollo» no se confunden', () => {
  const l = estructurarLinea({ producto_id: 10, nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 135,
    modificadores: [{ grupo: 'Proteína', opcion: 'Pollo' }] }, { canal: 'pos', catalogo });
  assert.strictEqual(l.modificadores[0].opcion_id, 1011);
});

t('una opción que no existe en ese producto queda en «Sin clasificar» y la línea es parcial', () => {
  const l = estructurarLinea({ producto_id: 10, nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 135,
    modificadores: [{ grupo: 'Tacos', opcion: 'Asada' }] }, { canal: 'pos', catalogo });
  assert.strictEqual(l.modificadores[0].clasificado, false);
  assert.strictEqual(l.modificadores[0].grupo, GRUPO_SIN_CLASIFICAR);
  assert.strictEqual(l.modificadores[0].opcion, 'Tacos: Asada');
  assert.strictEqual(l.estado, 'parcial');
});

console.log('\n2.1 / 2.3 — Mesas');

const cuentaChilaquiles = { producto: 'Chilaquiles', cantidad: 1, precio_unitario: 150,
  modificadores: ['Salsa: Verde', 'Proteína: Huevo'], notas: 'T HARINA', producto_id: null, modificadores_det: null };

t('venta de mesa sin la cuenta: «nota, G: O» se parte (nota y opciones de ESE producto)', () => {
  const [l] = estructurarVenta({ canal: CANAL_MESA, catalogo,
    items: [{ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 150, notas: 'sin cebolla, Salsa: Verde, Proteína: Huevo' }] });
  formaDe(l);
  assert.strictEqual(l.nota, 'sin cebolla');
  assert.deepStrictEqual(l.modificadores.map((m) => m.opcion_id), [1001, 1012]);
  assert.strictEqual(l.estado, 'completa');
});

t('venta de mesa sin la cuenta: un «X: Y» que no es grupo del producto se queda en la nota', () => {
  const [l] = estructurarVenta({ canal: CANAL_MESA, catalogo,
    items: [{ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 150, notas: 'Para: Ana, Salsa: Roja' }] });
  assert.strictEqual(l.nota, 'Para: Ana');
  assert.deepStrictEqual(l.modificadores.map((m) => m.opcion_id), [1002]);
});

t('venta de mesa con su cuenta: la nota y las opciones salen de la cuenta', () => {
  const [l] = estructurarVenta({ canal: CANAL_MESA, catalogo, cuentaItems: [cuentaChilaquiles],
    items: [{ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 150, notas: 'T HARINA, Salsa: Verde, Proteína: Huevo' }] });
  assert.strictEqual(l.nota, 'T HARINA');
  assert.deepStrictEqual(l.modificadores.map((m) => [m.grupo, m.opcion, m.opcion_id]), [['Salsa', 'Verde', 1001], ['Proteína', 'Huevo', 1012]]);
});

t('mesa desde la 151: producto_id y modificadores_det de la cuenta ganan', () => {
  const [l] = estructurarVenta({ canal: CANAL_MESA, catalogo,
    cuentaItems: [{ ...cuentaChilaquiles, producto_id: 10,
      modificadores_det: [{ grupo_id: 100, grupo: 'Salsa', opcion_id: 1001, opcion: 'Verde', precio_extra: 0 }] }],
    items: [{ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 150, notas: 'T HARINA, Salsa: Verde' }] });
  assert.strictEqual(l.producto_id, 10);
  assert.deepStrictEqual(l.modificadores.map((m) => [m.opcion_id, m.precio_estimado]), [[1001, false]]);
  assert.strictEqual(l.nota, 'T HARINA');
});

t('mesa: el emparejamiento con la cuenta es por nombre/cantidad/precio, no por posición', () => {
  const lineas = estructurarVenta({ canal: CANAL_MESA, catalogo,
    cuentaItems: [{ producto: 'TACOS', cantidad: 2, precio_unitario: 25, modificadores: ['Tacos: Asada'], notas: 'Comensal Luis' }, cuentaChilaquiles],
    items: [
      { nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 150, notas: 'T HARINA, Salsa: Verde, Proteína: Huevo' },
      { nombre: 'TACOS', cantidad: 2, precio_unitario: 25, notas: 'Comensal Luis, Tacos: Asada' },
    ] });
  assert.deepStrictEqual(lineas.map((l) => [l.linea, l.nombre, l.nota]), [[1, 'Chilaquiles', 'T HARINA'], [2, 'TACOS', 'Comensal Luis']]);
  assert.strictEqual(lineas[1].modificadores[0].opcion_id, 1101);
});

t('mesa: «Salsa: Verde, Roja» (agrupado) sale como dos opciones si las dos existen', () => {
  const [l] = estructurarVenta({ canal: CANAL_MESA, catalogo,
    cuentaItems: [{ ...cuentaChilaquiles, modificadores: ['Salsa: Verde, Roja'], notas: null }],
    items: [{ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 150 }] });
  assert.deepStrictEqual(l.modificadores.map((m) => m.opcion_id), [1001, 1002]);
  assert.strictEqual(l.nota, null);
});

console.log('\n2.2 — Rappi');

t('Rappi (texto de antes): «Pechuga de pollo: 1» va a su grupo; lo desconocido a «Sin clasificar» con sus unidades', () => {
  const l = estructurarLinea({ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 140, notas: 'Pechuga de pollo: 1, Salsa Diabla: 2' },
    { canal: CANAL_RAPPI, catalogo, emparejamientos: sinEmparejar });
  formaDe(l);
  assert.strictEqual(l.producto_id, 10);
  assert.deepStrictEqual(l.modificadores.map((m) => [m.grupo, m.opcion, m.opcion_id, m.cantidad, m.clasificado]),
    [['Proteína', 'Pechuga de pollo', 1013, 1, true], [GRUPO_SIN_CLASIFICAR, 'Salsa Diabla', null, 2, false]]);
  assert.strictEqual(l.estado, 'parcial');
  assert.strictEqual(l.nota, null);
});

t('Rappi: lo que no tiene forma «nombre: unidades» es nota', () => {
  const l = estructurarLinea({ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 140, notas: 'Pollo: 1, sin crema' },
    { canal: CANAL_RAPPI, catalogo, emparejamientos: sinEmparejar });
  assert.strictEqual(l.nota, 'sin crema');
  assert.strictEqual(l.modificadores[0].opcion_id, 1011);
});

t('Rappi (desde la 151): el SKU XB-<id> y XB-op-<id> ganan, con unidades y precio de Rappi', () => {
  const l = estructurarLinea({ nombre: 'Chilaquiles (Rappi)', cantidad: 1, precio_unitario: 160, sku_rappi: 'XB-10',
    toppings_rappi: [{ sku: 'XB-op-1013', nombre: 'Pechuguita', unidades: 2, precio: 30, categoria: 'Elige proteína' }] },
  { canal: CANAL_RAPPI, catalogo, emparejamientos: sinEmparejar });
  assert.strictEqual(l.producto_id, 10);
  assert.deepStrictEqual(l.modificadores.map((m) => [m.grupo_id, m.opcion_id, m.opcion, m.cantidad, m.precio_extra, m.precio_estimado]),
    [[101, 1013, 'Pechuga de pollo', 2, 30, false]]);
});

t('Rappi: el código propio del producto (PAN001…) también es su SKU', () => {
  const l = estructurarLinea({ nombre: 'Enchis', cantidad: 1, precio_unitario: 120, sku_rappi: 'enc001', toppings_rappi: [] },
    { canal: CANAL_RAPPI, catalogo, emparejamientos: sinEmparejar });
  assert.strictEqual(l.producto_id, 14);
});

t('Rappi: un XB-op de OTRO producto no se acepta', () => {
  const l = estructurarLinea({ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 140, sku_rappi: 'XB-10',
    toppings_rappi: [{ sku: 'XB-op-1101', nombre: 'Algo', unidades: 1 }] }, { canal: CANAL_RAPPI, catalogo, emparejamientos: sinEmparejar });
  assert.strictEqual(l.modificadores[0].clasificado, false);
});

t('Rappi: el emparejamiento a mano liga producto y opción; uno a OTRO producto se ignora', () => {
  const emp = new Map([
    [claveEmparejamiento('Chilakiles especiales'), { producto_id: 10, grupo_id: null, opcion_id: null }],
    [claveEmparejamiento('Chilakiles especiales', 'Pollito'), { producto_id: 10, grupo_id: 101, opcion_id: 1011 }],
    [claveEmparejamiento('Chilakiles especiales', 'Taquito'), { producto_id: 10, grupo_id: 110, opcion_id: 1101 }],
  ]);
  const l = estructurarLinea({ nombre: 'CHILAKILES  especiales', cantidad: 1, precio_unitario: 140, notas: 'Pollito: 1, Taquito: 1' },
    { canal: CANAL_RAPPI, catalogo, emparejamientos: emp });
  assert.strictEqual(l.producto_id, 10);
  assert.deepStrictEqual(l.modificadores.map((m) => [m.opcion_id, m.clasificado]), [[1011, true], [null, false]]);
});

t('Rappi: un producto que no se reconoce queda sin estructurar y sus opciones en «Sin clasificar»', () => {
  const l = estructurarLinea({ nombre: 'Combo misterioso', cantidad: 1, precio_unitario: 99, notas: 'Refresco: 1' },
    { canal: CANAL_RAPPI, catalogo, emparejamientos: sinEmparejar });
  assert.strictEqual(l.estado, 'sin_estructurar');
  assert.strictEqual(l.modificadores[0].grupo, GRUPO_SIN_CLASIFICAR);
});

t('rappiOpciones: el formato clásico y el productivo dan los mismos datos; un payload raro no lanza', () => {
  const clasico = datosEstructuradosRappi({ id: 'XB-10', toppings: [{ name: 'Pechuga de pollo', units: 1, price: 25, sku: 'XB-op-1013' }] });
  assert.deepStrictEqual(clasico, { sku_rappi: 'XB-10', toppings_rappi: [{ sku: 'XB-op-1013', nombre: 'Pechuga de pollo', unidades: 1, precio: 25, categoria: null }] });
  const productivo = datosEstructuradosRappi({ sku: 'XB-10', subitems: [{ sku: 'XB-op-1013', name: 'Pechuga de pollo', quantity: 3, unit_price: 25, category: 'Proteína' }] });
  assert.deepStrictEqual(productivo.toppings_rappi[0], { sku: 'XB-op-1013', nombre: 'Pechuga de pollo', unidades: 3, precio: 25, categoria: 'Proteína' });
  assert.deepStrictEqual(datosEstructuradosRappi(null), { sku_rappi: null, toppings_rappi: [] });
  assert.deepStrictEqual(datosEstructuradosRappi({ toppings: 'no es lista' }).toppings_rappi, []);
  const trampa = { get toppings() { throw new Error('boom'); } };
  assert.deepStrictEqual(datosEstructuradosRappi(trampa), {});
  const muchos = datosEstructuradosRappi({ toppings: Array.from({ length: 500 }, (_, i) => ({ name: 'x'.repeat(1000) + i })) });
  assert.strictEqual(muchos.toppings_rappi.length, 40);
  assert.ok(muchos.toppings_rappi.every((x) => x.nombre.length <= 120));
});

console.log('\n2.1 — Temporada');

t('Temporada: una línea «N platillos» del producto de su campaña, completa por diseño', () => {
  const [l] = estructurarTemporada({ pedido: { platillos: 3, notas: 'recoge 5 pm' }, campana: { producto: 'Pavo de Thanksgiving', precio: 1200 }, catalogo });
  formaDe(l);
  assert.deepStrictEqual([l.nombre, l.cantidad, l.precio_unitario, l.nota, l.estado, l.modificadores.length], ['Pavo de Thanksgiving', 3, 1200, 'recoge 5 pm', 'completa', 0]);
});

t('el mismo formato en todos los canales', () => {
  const lineas = [
    estructurarLinea({ producto_id: 10, nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 1, modificadores: modsVenta }, { canal: 'pos', catalogo }),
    estructurarLinea({ producto_id: 10, nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 1, modificadores: modsVenta }, { canal: 'tienda_online', catalogo }),
    estructurarLinea({ producto_id: 10, nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 1, modificadores: modsVenta }, { canal: 'whatsapp', catalogo }),
    ...estructurarVenta({ canal: CANAL_MESA, catalogo, items: [{ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 1, notas: 'Salsa: Mole' }] }),
    estructurarLinea({ nombre: 'Chilaquiles', cantidad: 1, precio_unitario: 1, notas: 'Mole: 1' }, { canal: CANAL_RAPPI, catalogo, emparejamientos: sinEmparejar }),
    ...estructurarTemporada({ pedido: { platillos: 1 }, campana: { producto: 'Pavo', precio: 1 }, catalogo }),
  ];
  lineas.forEach(formaDe);
});

t('resumenDeLineas cuenta completas, parciales y sin estructurar', () => {
  assert.deepStrictEqual(resumenDeLineas([{ estado: 'completa' }, { estado: 'parcial' }, { estado: 'sin_estructurar' }, { estado: 'completa' }]),
    { lineas: 4, completas: 2, parciales: 1, sin_estructurar: 1 });
});

console.log('\n2.4 — Tipo de producto');

t('el tipo viaja con la línea (envío, bebida, platillo)', () => {
  const tipoDe = (id, nombre) => estructurarLinea({ producto_id: id, nombre, cantidad: 1, precio_unitario: 60 }, { canal: 'pos', catalogo }).tipo;
  assert.deepStrictEqual([tipoDe(12, 'ENVIO 60'), tipoDe(13, 'Agua de horchata'), tipoDe(10, 'Chilaquiles'), tipoDe(17, 'Envío foráneo')],
    ['envio', 'bebida', 'platillo', 'envio']);
});

t('la marca vieja opciones.tipo_item=envio gana; un tipo inválido es «platillo»', () => {
  assert.strictEqual(tipoDeProducto({ tipo: 'bebida', opciones: { tipo_item: 'envio' } }), 'envio');
  assert.strictEqual(tipoDeProducto({ tipo: 'postre' }), 'platillo');
  assert.strictEqual(tipoDeProducto(null), 'platillo');
  assert.ok(esProductoDeEnvio({ tipo: 'envio' }));
  assert.ok(!esProductoDeEnvio({ tipo: 'extra' }));
  assert.deepStrictEqual([...TIPOS_PRODUCTO], ['platillo', 'bebida', 'extra', 'envio', 'otro']);
});

t('marca inicial aprobada: ENVIO, EXTRA…, TORTILLAS, SALSAS, BEBIDAS; TACOS sigue platillo', () => {
  const casos = [
    [{ nombre: 'ENVIO 60', categoria: 'ENVIO' }, 'envio'],
    [{ nombre: 'ENVIO 70', categoria: 'Envíos' }, 'envio'],
    [{ nombre: 'Envio Fuera de la CD', categoria: 'Otros', opciones: { tipo_item: 'envio' } }, 'envio'],
    [{ nombre: 'EXTRA', categoria: 'EXTRAS' }, 'extra'],
    [{ nombre: 'Extra 20', categoria: 'EXTRAS' }, 'extra'],
    [{ nombre: 'EXTRA FRUTA', categoria: 'EXTRAS' }, 'extra'],
    [{ nombre: 'EXTRA HUEVO', categoria: 'EXTRAS' }, 'extra'],
    [{ nombre: 'EXTRA TOPPING', categoria: 'EXTRAS' }, 'extra'],
    [{ nombre: 'TORTILLAS', categoria: 'EXTRAS' }, 'extra'],
    [{ nombre: 'SALSAS', categoria: 'EXTRAS' }, 'extra'],
    [{ nombre: 'Coca Cola', categoria: 'BEBIDAS' }, 'bebida'],
    [{ nombre: 'TACOS', categoria: 'TACOS' }, null],
    [{ nombre: 'EXTRA QUESO', categoria: 'EXTRAS' }, null],
    [{ nombre: 'Chilaquiles', categoria: 'DESAYUNOS' }, null],
  ];
  for (const [p, esperado] of casos) assert.strictEqual(tipoPropuestoInicial(p), esperado, `${p.nombre} [${p.categoria}]`);
  assert.ok(CATEGORIAS_A_REVISAR.has(normalizarTexto('EXTRAS')), 'lo no marcado de EXTRAS se lista para decidir a mano');
});

t('menuSinEnvios quita los productos de envío (y las categorías que quedan vacías) sin tocar el original', () => {
  const menu = [
    { id: 1, nombre: 'Desayunos', productos: [{ id: 10, nombre: 'Chilaquiles', tipo: 'platillo' }] },
    { id: 2, nombre: 'ENVIO', productos: [{ id: 12, nombre: 'ENVIO 60', tipo: 'envio' }] },
    { id: 3, nombre: 'Otros', productos: [{ id: 17, nombre: 'Envío foráneo', opciones: { tipo_item: 'envio' } }, { id: 18, nombre: 'Bolsa', tipo: 'otro' }] },
    { id: 4, nombre: 'Vacía', productos: [] },
  ];
  const copia = JSON.stringify(menu);
  const r = menuSinEnvios(menu);
  assert.deepStrictEqual(r.map((c) => [c.nombre, c.productos.map((p) => p.id)]), [['Desayunos', [10]], ['Otros', [18]], ['Vacía', []]]);
  assert.strictEqual(JSON.stringify(menu), copia);
});

t('normalizarTexto: acentos, mayúsculas y espacios', () => {
  assert.strictEqual(normalizarTexto('  Extra  de Salsa MOLCAJETEADA á ñ '), 'extra de salsa molcajeteada a n');
  assert.strictEqual(normalizarTexto(null), '');
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) process.exit(1);
