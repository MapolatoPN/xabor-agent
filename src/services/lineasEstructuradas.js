// ─── Registro estructurado de líneas de pedido (Fase 2, 23-nov-2026) ──────
//
// Pedido de Mario (Fase 2, plan aprobado el 23-nov): cada línea vendida con
// sus modificadores como registros (grupo, opción, cantidad, precio extra y
// referencia al menú), la nota libre aparte y el tipo de producto, en UN solo
// formato para todos los canales (punto de venta, mostrador, envíos, tienda,
// WhatsApp, Mesas, Rappi y Temporada).
//
// Este módulo es PURO: recibe la línea tal como la guardó su canal y el menú
// del negocio, y devuelve la línea en el formato único. No lee ni escribe la
// base (eso es lineasEstructuradasProceso.js). La venta original nunca se
// modifica: esto alimenta un registro aparte (tabla pedido_lineas).
//
// Hoy cada canal guarda la línea a su manera:
//   · POS, mostrador, envíos, tienda, WhatsApp: `modificadores` como objetos
//     {grupo_id, grupo, opcion_id, opcion, precio_extra}. POS, mostrador y
//     tienda además pegan el texto de las opciones dentro de `notas`
//     («Salsas: Verde · sin cebolla»).
//   · Mesas: la cuenta guarda las opciones como texto «Grupo: Opción» y el
//     comentario aparte; la venta cerrada lo pega todo en `notas`
//     («sin cebolla, Salsas: Verde»).
//   · Rappi: sin producto ni opciones del menú; las opciones llegan como
//     «Pechuga de pollo: 1» dentro de `notas` (y, desde la 161, también como
//     `toppings_rappi`, lo que mandó Rappi).
//   · Temporada: no guarda líneas; un pedido es «N platillos» del producto de
//     su campaña.
//
// Reglas que no se negocian:
//   · Nada se adivina por parecido: una opción se empareja con el menú solo
//     si su nombre coincide (sin acentos ni mayúsculas) con UNA sola opción
//     de ese producto. Lo que no, queda en «Sin clasificar» con su texto.
//   · Ante la duda, la nota se conserva entera (misma regla que la comanda:
//     notaSinModificadores solo quita repeticiones literales).
import { notaSinModificadores } from '../../edge/renderers/modificadores.js';

// Cambiar cómo se lee una línea obliga a rehacer el registro: la versión va
// dentro de la firma de cada pedido, así que subirla hace que el proceso
// vuelva a pasar por todos.
export const VERSION_REGISTRO = 'v1';

export const TIPOS_PRODUCTO = Object.freeze(['platillo', 'bebida', 'extra', 'envio', 'otro']);
export const ETIQUETAS_TIPO = Object.freeze({
  platillo: 'Platillo', bebida: 'Bebida', extra: 'Extra', envio: 'Envío', otro: 'Otro',
});
export const GRUPO_SIN_CLASIFICAR = 'Sin clasificar';
export const CANAL_MESA = 'restaurante_mesa';
export const CANAL_RAPPI = 'rappi';
export const CANAL_TEMPORADA = 'temporada';

const LARGO_NOMBRE = 200;
const LARGO_NOTA = 500;

// Minúsculas, sin acentos y sin espacios de más: «Extra  de Crema» y
// «extra de crema» son la misma opción; «Pollo» y «Pechuga de pollo», no.
export function normalizarTexto(t) {
  return String(t ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const redondear = (n) => Math.round(Number(n) * 100) / 100;
const numeroONulo = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const recortar = (t, n) => String(t ?? '').trim().slice(0, n);

export function tipoValido(t) {
  return TIPOS_PRODUCTO.includes(t);
}

// El tipo de un producto del menú. La marca vieja del cargo de envío
// (opciones.tipo_item = 'envio', P0 XAB-0176) sigue valiendo: un producto
// marcado así es envío aunque su columna diga otra cosa.
export function tipoDeProducto(p) {
  if (!p) return 'platillo';
  const opciones = p.opciones && typeof p.opciones === 'object' ? p.opciones : null;
  if (opciones?.tipo_item === 'envio') return 'envio';
  return tipoValido(p.tipo) ? p.tipo : 'platillo';
}

export function esProductoDeEnvio(p) {
  return tipoDeProducto(p) === 'envio';
}

// La marca INICIAL que propone scripts/marcar-tipo-producto.mjs (reglas
// aprobadas el 23-nov-2026). null = no se propone nada (sigue «platillo»).
//   · envío: categoría «ENVIO» o la marca vieja opciones.tipo_item='envio';
//   · extra: por nombre exacto (EXTRA, EXTRA 20, EXTRA FRUTA, EXTRA HUEVO,
//     EXTRA TOPPING, TORTILLAS, SALSAS);
//   · bebida: categoría «BEBIDAS».
// TACOS ($0) queda «platillo»: se vende por sus opciones.
const EXTRAS_POR_NOMBRE = new Set(['EXTRA', 'EXTRA 20', 'EXTRA FRUTA', 'EXTRA HUEVO', 'EXTRA TOPPING', 'TORTILLAS', 'SALSAS']
  .map((t) => normalizarTexto(t)));
const CATEGORIAS_ENVIO = new Set(['envio', 'envios']);
const CATEGORIAS_BEBIDA = new Set(['bebidas', 'bebida']);
export const CATEGORIAS_A_REVISAR = new Set(['extras', 'extra', ...CATEGORIAS_ENVIO]);

export function tipoPropuestoInicial({ nombre, categoria, opciones } = {}) {
  const cat = normalizarTexto(categoria);
  if (opciones && typeof opciones === 'object' && opciones.tipo_item === 'envio') return 'envio';
  if (CATEGORIAS_ENVIO.has(cat)) return 'envio';
  if (EXTRAS_POR_NOMBRE.has(normalizarTexto(nombre))) return 'extra';
  if (CATEGORIAS_BEBIDA.has(cat)) return 'bebida';
  return null;
}

// ─── El menú del negocio, indexado ───────────────────────────────────────
// productos: [{ id, nombre, tipo, opciones, codigo }]
// grupos:    [{ id, producto_id, nombre, opciones: [{ id, nombre, precio_extra }] }]
// `codigo` es el SKU propio que algunos productos ya tenían en Rappi
// (rappi-api.skuDeProducto); solo cuenta si es único en el negocio.
export function indexarCatalogo({ productos = [], grupos = [] } = {}) {
  const porId = new Map();
  const porNombre = new Map();
  const porCodigo = new Map();
  const codigosRepetidos = new Set();
  const gruposPorProducto = new Map();
  const opcionPorId = new Map();
  for (const p of productos) {
    porId.set(Number(p.id), p);
    const codigo = typeof p.codigo === 'string' ? p.codigo.trim().toUpperCase() : '';
    if (codigo && !codigo.startsWith('XB-')) {
      if (porCodigo.has(codigo)) codigosRepetidos.add(codigo);
      else porCodigo.set(codigo, p);
    }
    const k = normalizarTexto(p.nombre);
    if (!k) continue;
    if (!porNombre.has(k)) porNombre.set(k, []);
    porNombre.get(k).push(p);
  }
  for (const g of grupos) {
    const pid = Number(g.producto_id);
    if (!gruposPorProducto.has(pid)) gruposPorProducto.set(pid, []);
    gruposPorProducto.get(pid).push(g);
    for (const o of g.opciones || []) opcionPorId.set(Number(o.id), { grupo: g, opcion: o });
  }
  for (const c of codigosRepetidos) porCodigo.delete(c);
  return { porId, porNombre, porCodigo, gruposPorProducto, opcionPorId };
}

// Por su id si el menú lo tiene; si no, por nombre exacto (sin acentos ni
// mayúsculas) y solo si hay UNO con ese nombre.
export function resolverProducto(catalogo, { productoId, nombre } = {}) {
  const id = Number(productoId);
  if (Number.isInteger(id) && id > 0 && catalogo.porId.has(id)) return catalogo.porId.get(id);
  const lista = catalogo.porNombre.get(normalizarTexto(nombre));
  return lista && lista.length === 1 ? lista[0] : null;
}

// Una opción de ESE producto por su nombre (y el de su grupo, si se sabe).
// Solo si hay exactamente una que coincide.
export function buscarOpcion(grupos, { grupo, opcion } = {}) {
  const ko = normalizarTexto(opcion);
  if (!ko) return null;
  const kg = normalizarTexto(grupo);
  const encontradas = [];
  for (const g of grupos || []) {
    if (kg && normalizarTexto(g.nombre) !== kg) continue;
    for (const o of g.opciones || []) {
      if (normalizarTexto(o.nombre) === ko) encontradas.push({ grupo: g, opcion: o });
    }
  }
  return encontradas.length === 1 ? encontradas[0] : null;
}

function clasificado(grupo, opcion, { cantidad = 1, precioExtra = null } = {}) {
  const precioVenta = numeroONulo(precioExtra);
  return {
    grupo_id: Number(grupo.id),
    grupo: recortar(grupo.nombre, LARGO_NOMBRE) || GRUPO_SIN_CLASIFICAR,
    opcion_id: Number(opcion.id),
    opcion: recortar(opcion.nombre, LARGO_NOMBRE),
    cantidad: cantidad > 0 ? redondear(cantidad) : 1,
    precio_extra: redondear(precioVenta ?? numeroONulo(opcion.precio_extra) ?? 0),
    precio_estimado: precioVenta === null,
    clasificado: true,
  };
}

function sinClasificar(texto, { cantidad = 1, precioExtra = null } = {}) {
  return {
    grupo_id: null,
    grupo: GRUPO_SIN_CLASIFICAR,
    opcion_id: null,
    opcion: recortar(texto, LARGO_NOMBRE) || '(vacío)',
    cantidad: cantidad > 0 ? redondear(cantidad) : 1,
    precio_extra: redondear(numeroONulo(precioExtra) ?? 0),
    precio_estimado: false,
    clasificado: false,
  };
}

// "Salsa: Mole" → { grupo: 'Salsa', opcion: 'Mole' }; sin ": " es solo opción.
function partir(texto) {
  const t = String(texto ?? '').trim();
  const i = t.indexOf(': ');
  return i > 0 ? { grupo: t.slice(0, i).trim(), opcion: t.slice(i + 2).trim() } : { grupo: '', opcion: t };
}

// Una opción escrita como texto («Grupo: Opción», la forma de Mesas). Si el
// texto agrupa varias («Salsas: Verde, Roja») y TODAS existen en ese grupo,
// salen todas; si no, queda entera en «Sin clasificar».
function modsDeTexto(texto, grupos) {
  const { grupo, opcion } = partir(texto);
  const una = buscarOpcion(grupos, { grupo, opcion });
  if (una) return [clasificado(una.grupo, una.opcion)];
  if (opcion.includes(', ')) {
    const partes = opcion.split(', ').map((o) => buscarOpcion(grupos, { grupo, opcion: o }));
    if (partes.length > 1 && partes.every(Boolean)) return partes.map((p) => clasificado(p.grupo, p.opcion));
  }
  return [sinClasificar(texto)];
}

// Las opciones que guardó la venta (objetos o textos), una por una.
function modsDeLaVenta(modificadores, grupos, catalogo) {
  const salida = [];
  for (const m of Array.isArray(modificadores) ? modificadores : []) {
    if (m === null || m === undefined) continue;
    if (typeof m === 'string') { if (m.trim()) salida.push(...modsDeTexto(m, grupos)); continue; }
    if (typeof m !== 'object') continue;
    const cantidad = numeroONulo(m.cantidad) ?? 1;
    const opcionTexto = String(m.opcion ?? m.nombre ?? '').trim();
    const opcionId = Number(m.opcion_id);
    // La venta guardó la opción con su id: es la referencia al menú de ese
    // momento, aunque hoy ya no exista.
    if (Number.isInteger(opcionId) && opcionId > 0 && opcionTexto) {
      const grupoId = Number(m.grupo_id);
      salida.push({
        grupo_id: Number.isInteger(grupoId) && grupoId > 0 ? grupoId : (catalogo.opcionPorId.get(opcionId)?.grupo?.id ?? null),
        grupo: recortar(m.grupo, LARGO_NOMBRE) || recortar(catalogo.opcionPorId.get(opcionId)?.grupo?.nombre, LARGO_NOMBRE) || GRUPO_SIN_CLASIFICAR,
        opcion_id: opcionId,
        opcion: recortar(opcionTexto, LARGO_NOMBRE),
        cantidad: cantidad > 0 ? redondear(cantidad) : 1,
        precio_extra: redondear(numeroONulo(m.precio_extra) ?? numeroONulo(catalogo.opcionPorId.get(opcionId)?.opcion?.precio_extra) ?? 0),
        precio_estimado: numeroONulo(m.precio_extra) === null,
        clasificado: true,
      });
      continue;
    }
    if (!opcionTexto) continue;
    const r = buscarOpcion(grupos, { grupo: m.grupo, opcion: opcionTexto });
    salida.push(r
      ? clasificado(r.grupo, r.opcion, { cantidad, precioExtra: m.precio_extra ?? m.precio })
      : sinClasificar(m.grupo ? `${m.grupo}: ${opcionTexto}` : opcionTexto, { cantidad, precioExtra: m.precio_extra ?? m.precio }));
  }
  return salida;
}

// La venta cerrada de una mesa (sin la cuenta a la mano): «nota, G: O, G2: O2».
// Un pedazo es opción solo si su grupo es de ese producto; todo lo demás es
// la nota, en el orden en que estaba.
function partirNotaDeMesa(notas, grupos) {
  const nota = [];
  const mods = [];
  const gruposDelProducto = new Set((grupos || []).map((g) => normalizarTexto(g.nombre)));
  for (const pedazo of String(notas ?? '').split(', ')) {
    const t = pedazo.trim();
    if (!t) continue;
    const { grupo, opcion } = partir(t);
    if (grupo && gruposDelProducto.has(normalizarTexto(grupo))) {
      const r = buscarOpcion(grupos, { grupo, opcion });
      mods.push(r ? clasificado(r.grupo, r.opcion) : sinClasificar(t));
    } else {
      nota.push(t);
    }
  }
  return { mods, nota: nota.join(', ') || null };
}

// ─── Rappi ───────────────────────────────────────────────────────────────
export function claveEmparejamiento(productoRappi, opcionRappi = '') {
  return `${normalizarTexto(productoRappi)}|${normalizarTexto(opcionRappi)}`;
}

// Lo que mandó Rappi de cada opción. Las ventas de antes de la 161 solo
// tienen el texto «Nombre: unidades» en la nota; lo que no tenga esa forma
// es nota.
function toppingsDeRappi(item) {
  if (Array.isArray(item.toppings_rappi) && item.toppings_rappi.length) {
    return { toppings: item.toppings_rappi, nota: null };
  }
  const toppings = [];
  const nota = [];
  for (const pedazo of String(item.notas ?? '').split(', ')) {
    const t = pedazo.trim();
    if (!t) continue;
    const m = /^(.+?):\s*(\d+)$/.exec(t);
    if (m) toppings.push({ nombre: m[1].trim(), unidades: Number(m[2]) });
    else nota.push(t);
  }
  return { toppings, nota: nota.join(', ') || null };
}

function productoDeRappi(item, catalogo, emparejamientos) {
  // 1) El SKU con que Xabor publicó el producto: `XB-<id>` o el código propio.
  const textoSku = String(item.sku_rappi ?? '').trim();
  const sku = /^XB-(\d+)$/i.exec(textoSku);
  if (sku && catalogo.porId.has(Number(sku[1]))) return catalogo.porId.get(Number(sku[1]));
  if (textoSku && !sku && catalogo.porCodigo?.has(textoSku.toUpperCase())) return catalogo.porCodigo.get(textoSku.toUpperCase());
  // 2) Lo que alguien ya corrigió a mano. 3) Por nombre, si es único.
  const manual = emparejamientos?.get(claveEmparejamiento(item.nombre ?? item.producto));
  if (manual && catalogo.porId.has(Number(manual.producto_id))) return catalogo.porId.get(Number(manual.producto_id));
  return resolverProducto(catalogo, { nombre: item.nombre ?? item.producto });
}

function modsDeRappi(toppings, { producto, grupos, catalogo, emparejamientos, nombreRappi }) {
  const salida = [];
  for (const t of toppings) {
    const nombre = String(t?.nombre ?? t?.name ?? '').trim();
    if (!nombre) continue;
    const cantidad = numeroONulo(t.unidades ?? t.units) ?? 1;
    const precioRappi = numeroONulo(t.precio ?? t.price);
    let r = null;
    // 1) El código que Xabor le puso al subir el menú (XB-op-<id>).
    const sku = /^XB-op-(\d+)$/.exec(String(t.sku ?? '').trim());
    if (sku) {
      const o = catalogo.opcionPorId.get(Number(sku[1]));
      if (o && (!producto || Number(o.grupo.producto_id) === Number(producto.id))) r = o;
    }
    // 2) Lo que alguien ya corrigió a mano para ese producto de Rappi.
    if (!r) {
      const manual = emparejamientos?.get(claveEmparejamiento(nombreRappi, nombre));
      const o = manual ? catalogo.opcionPorId.get(Number(manual.opcion_id)) : null;
      if (o && (!producto || Number(o.grupo.producto_id) === Number(producto.id))) r = o;
    }
    // 3) Por nombre, dentro de los grupos de ese producto.
    if (!r && t.categoria) r = buscarOpcion(grupos, { grupo: t.categoria, opcion: nombre });
    if (!r) r = buscarOpcion(grupos, { opcion: nombre });
    salida.push(r
      ? clasificado(r.grupo, r.opcion, { cantidad, precioExtra: precioRappi })
      : sinClasificar(nombre, { cantidad, precioExtra: precioRappi }));
  }
  return salida;
}

// ─── Una línea ───────────────────────────────────────────────────────────
function estadoDe(productoId, mods) {
  if (!productoId) return 'sin_estructurar';
  return mods.some((m) => !m.clasificado) ? 'parcial' : 'completa';
}

/**
 * Una línea en el formato único.
 *   item: la línea como la guardó su canal (de la venta o de la cuenta de mesa)
 *   ctx:  { canal, catalogo (indexarCatalogo), emparejamientos (Map), deCuenta }
 *         deCuenta = la línea viene de restaurante_cuenta_items (nota y
 *         opciones ya separadas).
 */
export function estructurarLinea(item, ctx) {
  const { canal, catalogo, emparejamientos, deCuenta = false } = ctx;
  const nombre = recortar(item?.nombre ?? item?.producto ?? item?.name, LARGO_NOMBRE) || 'Sin nombre';
  const cantidad = numeroONulo(item?.cantidad) ?? 1;
  const precio = numeroONulo(item?.precio_unitario ?? item?.precioUnitario ?? item?.precio) ?? 0;

  let producto;
  let mods;
  let nota;
  if (canal === CANAL_RAPPI && !deCuenta) {
    producto = productoDeRappi(item, catalogo, emparejamientos);
    const grupos = producto ? (catalogo.gruposPorProducto.get(Number(producto.id)) || []) : [];
    const { toppings, nota: resto } = toppingsDeRappi(item);
    mods = modsDeRappi(toppings, { producto, grupos, catalogo, emparejamientos, nombreRappi: nombre });
    nota = resto;
  } else {
    producto = resolverProducto(catalogo, { productoId: item?.producto_id, nombre });
    const grupos = producto ? (catalogo.gruposPorProducto.get(Number(producto.id)) || []) : [];
    const detalle = Array.isArray(item?.modificadores_det) && item.modificadores_det.length
      ? item.modificadores_det : item?.modificadores;
    if (Array.isArray(detalle) && detalle.length) {
      mods = modsDeLaVenta(detalle, grupos, catalogo);
      nota = deCuenta ? (String(item?.notas ?? '').trim() || null) : notaSinModificadores(item?.notas, detalle);
    } else if (canal === CANAL_MESA && !deCuenta) {
      ({ mods, nota } = partirNotaDeMesa(item?.notas, grupos));
    } else {
      mods = [];
      nota = String(item?.notas ?? '').trim() || null;
    }
  }

  // Sin producto en el menú de hoy, el id que guardó la venta sigue siendo
  // su referencia (un producto que se borró después).
  const idVenta = Number(item?.producto_id);
  const productoId = producto ? Number(producto.id) : (Number.isInteger(idVenta) && idVenta > 0 ? idVenta : null);
  return {
    producto_id: productoId,
    nombre,
    tipo: producto ? tipoDeProducto(producto) : 'platillo',
    cantidad: cantidad > 0 ? redondear(cantidad) : 1,
    precio_unitario: redondear(precio),
    nota: nota ? recortar(nota, LARGO_NOTA) : null,
    estado: estadoDe(productoId, mods),
    modificadores: mods.map((m, i) => ({ ...m, orden: i + 1 })),
  };
}

// Las líneas de la venta de una mesa salen de su cuenta (que guarda el
// comentario y las opciones por separado). Se emparejan por nombre, cantidad
// y precio, no por posición: los artículos que entraron juntos comparten la
// misma hora y el cierre no garantiza su orden. La que no encuentre pareja se
// lee de la venta.
function emparejarConCuenta(items, cuentaItems) {
  const libres = [...(cuentaItems || [])];
  return items.map((it) => {
    const i = libres.findIndex((c) =>
      normalizarTexto(c.producto) === normalizarTexto(it?.nombre ?? it?.producto)
      && Number(c.cantidad) === Number(it?.cantidad)
      && redondear(c.precio_unitario) === redondear(it?.precio_unitario));
    if (i < 0) return null;
    return libres.splice(i, 1)[0];
  });
}

/**
 * Todas las líneas de una venta (pedidos_activos.datos.items).
 *   { canal, items, cuentaItems?, catalogo, emparejamientos }
 */
export function estructurarVenta({ canal, items, cuentaItems = null, catalogo, emparejamientos = new Map() }) {
  const lista = Array.isArray(items) ? items : [];
  const deCuenta = canal === CANAL_MESA && Array.isArray(cuentaItems) ? emparejarConCuenta(lista, cuentaItems) : [];
  return lista.map((it, i) => {
    const fila = deCuenta[i];
    const linea = fila
      ? estructurarLinea(fila, { canal, catalogo, emparejamientos, deCuenta: true })
      : estructurarLinea(it || {}, { canal, catalogo, emparejamientos });
    return { linea: i + 1, ...linea };
  });
}

/**
 * La línea única de un pedido de Temporada: «N platillos» del producto de su
 * campaña. No hay opciones que clasificar y el producto de la campaña es un
 * texto propio, no uno del menú: está completa por diseño. Si el menú tiene
 * un producto con ese mismo nombre, se liga.
 */
export function estructurarTemporada({ pedido, campana, catalogo }) {
  const producto = resolverProducto(catalogo, { nombre: campana?.producto });
  return [{
    linea: 1,
    producto_id: producto ? Number(producto.id) : null,
    nombre: recortar(campana?.producto, LARGO_NOMBRE) || 'Platillo',
    tipo: producto ? tipoDeProducto(producto) : 'platillo',
    cantidad: Math.max(1, Number(pedido?.platillos) || 1),
    precio_unitario: redondear(numeroONulo(campana?.precio) ?? 0),
    nota: recortar(pedido?.notas, LARGO_NOTA) || null,
    estado: 'completa',
    modificadores: [],
  }];
}

export function resumenDeLineas(lineas) {
  const r = { lineas: lineas.length, completas: 0, parciales: 0, sin_estructurar: 0 };
  for (const l of lineas) {
    if (l.estado === 'completa') r.completas++;
    else if (l.estado === 'parcial') r.parciales++;
    else r.sin_estructurar++;
  }
  return r;
}
