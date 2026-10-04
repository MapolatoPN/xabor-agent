// Fixtures puras del formulario «tienda» (tienda_v1) para las suites de la
// Fase 2: fotos con la forma de la de carrito_v1 (productos con categoría,
// líneas del pedido, entrega, pago, contrato de dirección y de nota), una
// vitrina falsa con miniaturas de bytes controlados y la validación de una
// respuesta del servidor contra la definición del Flow. Sin base de datos,
// sharp, red ni Meta.
import assert from 'node:assert/strict';
import { definicionFlowTienda, validarFlowTienda } from '../scripts/definicion-flow-tienda.mjs';
import { CONTRATO_DIRECCION } from '../src/mesero-agente/direccionFormulario.js';
import { CONTRATO_NOTA } from '../src/mesero-agente/notaDelPedido.js';

const op = (nombre, precio = 0) => ({ nombre, precio });
export const G_SALSA = { nombre: 'Salsa', minimo: 1, maximo: 1, opciones: [op('Roja'), op('Verde'), op('Chipotle', 10)] };
// 9 opciones: Dropdown (más de 8).
export const G_PROTEINA = { nombre: 'Proteína', minimo: 1, maximo: 1,
  opciones: ['Huevo estrellado', 'Huevo revuelto', 'Pollo', 'Prensado', 'Bistec', 'Panela', 'Cuerito', 'Chorizo', 'Arrachera']
    .map((n, i) => op(n, i >= 4 ? 30 : 0)) };
export const G_GUARNICION = { nombre: 'Guarniciones', minimo: 1, maximo: 2, opciones: [op('Frijoles'), op('Papas'), op('Ensalada'), op('Arroz')] };
export const G_EXTRAS = { nombre: 'Extras', minimo: 0, maximo: 3, opciones: [op('Aguacate', 15.5), op('Queso', 12), op('Crema', 8), op('Tocino', 20)] };
export const G_TORTILLA = { nombre: 'Tortilla', minimo: 1, maximo: 1, opciones: [op('Harina'), op('Maíz')] };

const producto = (id, nombre, precio, categoria, categoriaId, grupos = []) => ({ id: String(id), nombre, precio, grupos, categoria, categoriaId });
/** p0..p6 en tres categorías (c0 Desayunos, c1 Bebidas, c2 Tacos con lote). */
export const PRODUCTOS = [
  producto(10, 'Chilaquiles', 145, 'Desayunos', 'd', [G_SALSA, G_PROTEINA, G_GUARNICION, G_EXTRAS]),
  producto(11, 'Hotcakes', 139, 'Desayunos', 'd'),
  producto(12, 'Café americano', 45, 'Bebidas', 'b'),
  producto(13, 'Jugo de naranja', 55.5, 'Bebidas', 'b'),
  producto(14, 'Taco de Barbacoa', 30, 'Tacos', 't', [G_TORTILLA]),
  producto(15, 'Taco de Pastor', 28, 'Tacos', 't', [G_TORTILLA]),
  producto(16, 'Taco especial', 45, 'Tacos', 't', [G_TORTILLA, G_SALSA]),
];
const ficha = (p) => ({ id: p.id, nombre: p.nombre, precio: p.precio, grupos: p.grupos });
export const ZONAS = [{ nombre: 'UTNC', costo: 150 }];
/** Las dos líneas del pedido: 2 × Chilaquiles (Verde, Pollo, Frijoles y Papas, «Sin cebolla») y 1 × Café. */
export const LINEAS = [
  { linea_id: 'L1', cantidad: 2, ficha: ficha(PRODUCTOS[0]), nota: 'Sin cebolla',
    seleccion: [{ grupo: 'Salsa', opcion: 'Verde' }, { grupo: 'Proteína', opcion: 'Pollo' }, { grupo: 'Guarniciones', opcion: 'Frijoles' },
      { grupo: 'Guarniciones', opcion: 'Papas' }] },
  { linea_id: 'L2', cantidad: 1, ficha: ficha(PRODUCTOS[2]), nota: '', seleccion: [] },
];

/**
 * La foto de la tienda: la de carrito_v1 con dirección y nota (decisión de
 * fondo 2 y 3 de la propuesta), con su versión propia. `extra` la ajusta.
 */
export function fotoTienda(extra = {}) {
  return structuredClone({ tipo: 'flow_configurar', version: 'tienda_v1', flowId: '44444444444', productos: PRODUCTOS, lineas: LINEAS,
    modalidades: [{ valor: 'recoger en tienda', titulo: 'Recoger en tienda' }, { valor: 'entrega a domicilio', titulo: 'Entrega a domicilio' }],
    pagos: [{ valor: 'efectivo', titulo: 'Efectivo' }, { valor: 'tarjeta', titulo: 'Tarjeta al recibir' }], modalidad: '', pago: '',
    contrato: CONTRATO_DIRECCION, zonas: ZONAS, costo_envio: 60, direccion_inicial: { calle: '', colonia: '', referencias: '', zona: '' },
    contrato_nota: CONTRATO_NOTA, nota_inicial: '', ...extra });
}
/** La misma foto como la de «Tu carrito» (carrito_v1): para comparar borradores y recibos. */
export const comoCarrito = (foto) => ({ ...foto, version: 'carrito_v1' });

// ── Imágenes falsas: JPEG por la cabecera, del tamaño exacto pedido ───────
/** base64 de exactamente `caracteres` (múltiplo de 4) que empieza como JPEG. */
export function jpegFalso(caracteres, semilla = 0) {
  const bytes = Math.max(4, Math.floor(caracteres / 4) * 3), b = Buffer.alloc(bytes, 65 + (semilla % 20));
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  return b.toString('base64');
}
/**
 * Vitrina falsa: descripción y llave por id de producto, y `miniatura`
 * síncrona que anota cada pedido. `tamanos` = caracteres por variante (0 = no
 * está en la caché). `sinFoto`: ids sin llave.
 */
export function vitrinaFalsa({ productos = PRODUCTOS, tamanos = { lista96: 3600, lista80: 2700, cat128: 5600, ficha480: 40000 }, sinFoto = [],
  descripciones = {}, lanza = false } = {}) {
  const pedidas = [];
  const vitrina = { categorias: [], error: null, productos: Object.fromEntries(productos.map((p) => [String(p.id), {
    id: String(p.id), descripcion: descripciones[p.id] ?? `Descripción de ${p.nombre}.`, storageKey: sinFoto.includes(String(p.id)) ? null : `n/productos/${p.id}.jpg` }])),
  miniatura(llave, variante) {
    pedidas.push(`${llave}|${variante}`);
    if (lanza) throw new Error('caché rota');
    const n = tamanos[variante] || 0;
    return n ? jpegFalso(n, Number(String(llave).match(/(\d+)\.jpg$/)?.[1] || 0)) : null;
  } };
  return { vitrina, pedidas };
}

// ── La respuesta contra la definición del Flow ───────────────────────────
const DEF = definicionFlowTienda();
export const pantallaDef = (id) => DEF.screens.find((s) => s.id === id);
/**
 * La respuesta del servidor con la forma que el Flow declara: las mismas
 * claves de data, y que puesta como __example__ de su pantalla pase el
 * validador entero (cada cadena en su límite, listas de 1–20, imágenes, cada
 * dato dentro de su esquema y los payload de cada navigate).
 */
export function exigirForma(r, donde = '') {
  if (r.screen === 'SUCCESS') return;
  const s = pantallaDef(r.screen);
  assert(s, `${donde}: pantalla desconocida ${r.screen}`);
  assert.deepEqual(Object.keys(r.data).sort(), Object.keys(s.data).sort(), `${donde}: claves de ${r.screen}`);
  const f = structuredClone(DEF), p = f.screens.find((x) => x.id === r.screen);
  for (const [k, v] of Object.entries(r.data)) p.data[k].__example__ = structuredClone(v);
  const errores = validarFlowTienda(f);
  assert.deepEqual(errores, [], `${donde}: ${errores.slice(0, 3).join(' | ')}`);
}

/** Atajos de solicitudes del endpoint. */
export const dx = (screen, data) => ({ action: 'data_exchange', screen, data });
export const atras = (screen) => ({ action: 'BACK', screen });
export const INIT = { action: 'INIT' };
/** Las 18 claves de las ranuras, vacías, como las manda la ficha. */
export const RANURAS_VACIAS = Object.fromEntries(Array.from({ length: 6 }, (_, g) => [[`g${g}_r`, ''], [`g${g}_s`, ''], [`g${g}_m`, []]]).flat());
/** Las claves de una pantalla sin la vista (lo que el adaptador guarda menos lo que solo dibuja). */
export const sinVista = (b) => { const { vista, ...resto } = b; return resto; };
