// Formulario «tienda» (contrato tienda_v1): menú por categorías con fotos, ficha
// del platillo, «Tu pedido» como lista y la entrega y la dirección de hoy.
// Artefacto local de la Fase 0: no crea, publica ni activa nada en Meta.
//
// Rutas (propuesta tienda_v1, sección 1), árbol sin ciclos:
//   MENU → CATEGORIA | CARRITO | CARRITO_B
//   CATEGORIA → PERSONALIZAR | TACOS | CARRITO | CARRITO_B   (la barra «Tu pedido»)
//   TACOS → PERSONALIZAR                                      («Elegir y personalizar un taco»)
//   CARRITO | CARRITO_B → EDITAR | ENTREGA;  ENTREGA → DIRECCION
// Respecto del mapa de la propuesta se agregan dos aristas hacia adelante que
// sus propias pantallas necesitan: la barra de CATEGORIA abre el carrito (no es
// un ancestro) y la pantalla TACOS reutilizada trae «Elegir y personalizar».
// Los regresos (Agregar → MENU, EDITAR → CARRITO, «Seguir pidiendo» → MENU)
// llegan por la respuesta del data_exchange, sin arista: igual que carrito_v1.
//
// Límites de Meta: [V] verificado en la documentación de Flows; [NV] no
// verificado, y se toma la opción conservadora. validarFlowTienda los aplica a
// la definición, a sus datos de ejemplo y a la maqueta.
import { createHash } from 'node:crypto';
import { definicionFlowCategorias } from './definicion-flow-categorias.mjs';
import { pantallaDireccion } from './definicion-pantalla-direccion.mjs';
import { MAX_CANTIDAD_FLOW } from '../src/mesero-agente/catalogoFlowCategorias.js';
import { MAX_OBSERVACIONES_PLATILLO } from '../src/mesero-agente/observacionesDelPlatillo.js';
import { GRUPOS_POR_LINEA_FLOW } from '../src/mesero-agente/formularioAgrupado.js';

const dato = (k) => '${data.' + k + '}', campo = (k) => '${form.' + k + '}';

export const RANURAS = GRUPOS_POR_LINEA_FLOW; // g0..g5, como el formulario de hoy
export const MAX_RADIO = 8; // una sola elección con 8 opciones o menos → RadioButtonsGroup; más → Dropdown
export const PANTALLAS_CARRITO = { A: ['CARRITO'], B: ['CARRITO_B'], AB: ['CARRITO', 'CARRITO_B'] };

export const LIMITES_TIENDA = {
  pantallas: 100, // [V]
  tituloPantalla: 30, // [NV] la doc no da el tope; 30 es conservador (hoy el más largo mide 23)
  salidasPorPantalla: 10, // [V] «Number of branches exceeds the max limit of 10»
  componentesPorPantalla: 50, // [V] aquí se cuentan Form, If y las dos ramas: conservador
  footerPorPantalla: 1, // [V]
  imagenesPorPantalla: 3, // [V]
  enlacesPorPantalla: 2, // [V] EmbeddedLink
  listasPorPantalla: 2, // [V] NavigationList, sola en su pantalla y nunca terminal
  elementosLista: [1, 20], // [V] fuera de rango la lista no se dibuja
  elementoLista: { title: 30, description: 20, metadata: 80, end: 10, badge: 15, tag: 15, tags: 3 }, // [V] lo que se pasa no se dibuja
  imagenLista: 100_000, // [V] «100KB»; se toma 100 000 B (conservador). Solo JPEG/PNG
  imagen: 300_000, // [V] Image: «Recommended image size Up to 300kb»
  opcion: { title: 30, description: 300, metadata: 20 }, // [V] Radio, Checkbox y Dropdown
  opciones: { RadioButtonsGroup: 20, CheckboxGroup: 20, Dropdown: 200 }, // [V]
  label: { Dropdown: 20, RadioButtonsGroup: 30, CheckboxGroup: 30, TextArea: 20, TextInput: 20, NavigationList: 80, Footer: 35 }, // [V]
  description: { RadioButtonsGroup: 300, CheckboxGroup: 300, NavigationList: 300 }, // [V]
  texto: { TextHeading: 80, TextSubheading: 80, TextBody: 4096, TextCaption: 409, EmbeddedLink: 25 }, // [V]; EmbeddedLink 25 [NV]
  helperText: 80, // [V]
  footerCaption: 15, // [V]
  presupuestoJson: 600_000, // tope duro propio (sección 2): la doc dice «1 Mb» y el changelog «10MB» [NV]
};

// PNG de 1×1 (el del ejemplo de Meta). Documenta el tipo en __example__ y ocupa
// `foto` cuando el platillo no tiene foto: con con_foto=false el If no lo dibuja.
export const IMAGEN_VACIA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

// ── Textos ───────────────────────────────────────────────────────────────
// Meta no trunca: un texto de más NO se dibuja. Todo se corta antes de mandarlo.
// Se mide en unidades UTF-16 (String.length), que nunca es menor que la cuenta
// en caracteres: conservador con emojis. Nunca parte un par sustituto.
function cortar(s, limite) {
  if (s.length <= limite) return s;
  let out = '';
  for (const ch of s) { if (out.length + ch.length > limite - 1) break; out += ch; }
  return `${out.trimEnd()}…`;
}
/** Una línea: colapsa espacios y saltos y corta con «…». */
export const recortar = (texto, limite) => cortar(String(texto ?? '').normalize('NFC').replace(/\s+/g, ' ').trim(), limite);
/** Un bloque (TextBody): conserva los párrafos. */
export const bloque = (texto, limite) => cortar(String(texto ?? '').normalize('NFC').replace(/[^\S\n]+/g, ' ')
  .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim(), limite);
const miles = (entero) => String(entero).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** «$145», «$7.50», «$1,234»; sin centavos desde $10,000 (cabe en end.title: 10). */
export function precioCorto(n) {
  const v = Number(n);
  if (Number.isInteger(v) || v >= 10000) return `$${miles(Math.round(v))}`;
  const [e, c] = v.toFixed(2).split('.');
  return `$${miles(e)}.${c}`;
}
/** «$450.00»: el subtotal del carrito, con centavos. */
export function precioCentavos(n) {
  const [e, c] = Number(n).toFixed(2).split('.');
  return `$${miles(e)}.${c}`;
}
const normal = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ── Datos de un platillo (PERSONALIZAR y EDITAR) ─────────────────────────
const opcionFlow = (id, nombre, precio) => ({ id, title: recortar(nombre, 30),
  description: String(nombre).length > 30 ? recortar(nombre, 300) : '', metadata: precio > 0 ? recortar(`+${precioCorto(precio)}`, 20) : '' });
function ayuda(grupo, max) {
  if (!grupo) return 'Opcional';
  if (grupo.minimo <= 0) return max > 1 ? `Opcional · hasta ${max}` : 'Opcional';
  return grupo.minimo === max ? `Elige ${max}` : `Elige ${grupo.minimo} a ${max}`;
}
/**
 * Las 6 ranuras. Cada una tiene tres variantes y solo una visible:
 * Radio (una elección, ≤ 8 opciones), Dropdown (una elección, más de 8) y
 * Checkbox (varias, con min/max dinámicos). `seleccion`: {indiceGrupo: [indicesOpcion]}.
 */
export function datosRanuras(grupos = [], seleccion = {}) {
  const d = {};
  for (let g = 0; g < RANURAS; g++) {
    const k = `g${g}`, grupo = grupos[g];
    const multiple = !!grupo && grupo.maximo > 1, radio = !!grupo && !multiple && grupo.opciones.length <= MAX_RADIO;
    const max = grupo ? Math.min(grupo.maximo, grupo.opciones.length) : 1;
    const elegidas = (seleccion[g] || []).map((i) => `o${i}`);
    Object.assign(d, {
      [`${k}_radio`]: radio, [`${k}_simple`]: !!grupo && !multiple && !radio, [`${k}_multiple`]: multiple,
      [`${k}_requerido`]: !!grupo && grupo.minimo > 0,
      [`${k}_label`]: recortar(grupo?.nombre || 'Opciones', LIMITES_TIENDA.label.RadioButtonsGroup),
      [`${k}_label_corto`]: recortar(grupo?.nombre || 'Opciones', LIMITES_TIENDA.label.Dropdown),
      [`${k}_min`]: grupo?.minimo || 0, [`${k}_max`]: max, [`${k}_ayuda`]: ayuda(grupo, max),
      [`${k}_opciones`]: grupo ? grupo.opciones.map((o, i) => opcionFlow(`o${i}`, o.nombre, o.precio))
        : [{ id: 'oculto', title: 'No aplica', description: '', metadata: '' }],
      [`${k}_inicial_r`]: radio ? (elegidas[0] || '') : '',
      [`${k}_inicial_s`]: !!grupo && !multiple && !radio ? (elegidas[0] || '') : '',
      [`${k}_inicial_m`]: multiple ? elegidas : [],
    });
  }
  return d;
}
const tieneExtras = (p) => p.grupos.some((g) => g.opciones.some((o) => o.precio > 0));
/** Lo común de PERSONALIZAR y EDITAR. `foto` es base64 o null. */
export function datosPlatillo(p, { foto = null, seleccion = {}, cantidad = 1, observaciones = '' } = {}) {
  const base = precioCorto(p.precio), descripcion = bloque(p.descripcion, LIMITES_TIENDA.texto.TextBody);
  return { nombre: recortar(p.nombre, LIMITES_TIENDA.texto.TextSubheading), descripcion, con_descripcion: !!descripcion,
    precio_texto: tieneExtras(p) ? `Precio base ${base} · los extras se suman` : base,
    con_foto: !!foto, foto: foto || IMAGEN_VACIA, error: '', error_visible: false,
    cantidad_inicial: String(cantidad), observaciones_inicial: observaciones, ...datosRanuras(p.grupos, seleccion) };
}

// ── Carta de ejemplo ─────────────────────────────────────────────────────
// Los grupos reales de «Chilaquiles Sencillos» en Obispado (los dio Mario).
const opciones = (lista) => lista.map((o) => (Array.isArray(o) ? { nombre: o[0], precio: o[1] } : { nombre: o, precio: 0 }));
export const GRUPOS_CHILAQUILES_SENCILLOS = [
  { nombre: 'Salsa', minimo: 1, maximo: 1, opciones: opciones(['Roja', 'Suiza', 'Verde', 'Mole', 'Chipotle']) },
  { nombre: 'Proteína', minimo: 1, maximo: 1, opciones: opciones(['Huevos Estrellados', 'Huevos Revueltos', 'Pechuga de pollo',
    'Chicharron Prensado', ['Bistec en Salsa', 30], ['Queso Panela en Salsa', 30], ['Chicharron Cuerito en Salsa', 30]]) },
  { nombre: 'Guarniciones', minimo: 1, maximo: 2, opciones: opciones(['Frijolitos naturales', 'Frijolitos con chorizo',
    'Papas a la mexicana', 'Papas con chorizo', ['Bistec en salsa', 30], ['Queso panela en salsa', 30],
    ['Chicharron cuerito en salsa', 30], ['Prensado', 30]]) },
];
// Solo documenta tipos en __example__: cubre con y sin foto, con y sin
// descripción, con grupos y una categoría de tacos.
export const CARTA_EJEMPLO = [
  { nombre: 'CHILAQUILES', platillos: [
    { nombre: 'Chilaquiles Sencillos', precio: 195, foto: true, grupos: GRUPOS_CHILAQUILES_SENCILLOS,
      descripcion: 'Los chilaquiles van servidos con una salsa, una proteína y 2 guarniciones.' },
    { nombre: 'Bowl de Chilaquiles', precio: 140, foto: false, grupos: [], descripcion: '' }] },
  { nombre: 'DESAYUNOS', platillos: [{ nombre: 'Hotcakes', precio: 139, foto: true, grupos: [],
    descripcion: 'La orden incluye 2 piezas acompañadas de fruta fresca de temporada.' }] },
  { nombre: 'TACOS', platillos: [{ nombre: 'Taco de Barbacoa', precio: 30, foto: false, grupos: [], descripcion: '' }] },
];

const EXPLICACIONES = {
  agregar: 'En el formulario real, «Agregar» guarda el platillo en el servidor y regresa al Menú con «Tu pedido» al día.',
  aplicar: 'En el formulario real, «Guardar cambios» actualiza el renglón y regresa a «Tu pedido».',
  quitar: 'En el formulario real, «Quitar del pedido» borra el renglón y regresa a «Tu pedido».',
  seguir: 'En el formulario real, «Seguir pidiendo» regresa al Menú.',
  deshacer: 'En el formulario real, «Deshacer» revierte el último cambio y regresa a «Tu pedido».',
  ver_tacos: 'En el formulario real, aquí se abre «Varios tacos a la vez», la pantalla de tacos de hoy.',
};

/**
 * Arma los datos de cada pantalla a partir de una carta
 * ([{nombre, platillos:[{nombre, precio, descripcion, foto, grupos}]}]).
 * modo 'endpoint': el INIT real (explorar es navigate; ver, agregar y el carrito, data_exchange).
 * modo 'maqueta': todo es navigate con su payload ya armado (sin servidor).
 * imagen(tipo, indiceCategoria) → base64 | null, con tipo 'categoria' | 'lista' | 'ficha'.
 * Devuelve las instancias de datos que llegan a cada pantalla.
 */
export function armarTienda(carta, { modo = 'endpoint', carrito = 'AB', imagen = () => null, revision = '3' } = {}) {
  const maqueta = modo === 'maqueta', instancias = new Map();
  const anotar = (pantalla, datos) => { if (!instancias.has(pantalla)) instancias.set(pantalla, []); instancias.get(pantalla).push(datos); return datos; };
  const ir = (pantalla, payload) => ({ name: 'navigate', next: { type: 'screen', name: pantalla }, payload: anotar(pantalla, payload) });
  const servidor = (payload) => ({ name: 'data_exchange', payload });
  const fin = (operacion) => ir('FIN_MAQUETA', { explicacion: EXPLICACIONES[operacion] });
  let n = 0;
  const categorias = carta.filter((c) => c.platillos?.length).map((c, indice) => ({ indice, nombre: String(c.nombre),
    platillos: c.platillos.map((p) => ({ ...p, id: `p${n++}`, grupos: p.grupos || [] })) }));
  const platillos = categorias.flatMap((c) => c.platillos);
  const categoriaDe = new Map(categorias.flatMap((c) => c.platillos.map((p) => [p.id, c.indice])));
  const foto = (p, tipo) => (p.foto ? imagen(tipo, categoriaDe.get(p.id)) || null : null);
  const personalizar = (p) => ({ producto: p.id, apertura: `r${revision}.${p.id}`, ...datosPlatillo(p, { foto: foto(p, 'ficha') }),
    boton: recortar(`Agregar · ${tieneExtras(p) ? 'desde ' : ''}${precioCorto(p.precio)}`, LIMITES_TIENDA.label.Footer) });

  // Carrito de ejemplo: el primer platillo con grupos y dos más.
  const conGrupos = platillos.find((p) => p.grupos.length);
  const filas = [...(conGrupos ? [conGrupos] : []), ...platillos.filter((p) => p !== conGrupos).slice(0, conGrupos ? 2 : 3)].map((p, i) => {
    const seleccion = Object.fromEntries(p.grupos.map((g, gi) => [gi, Array.from({ length: Math.max(0, g.minimo) }, (_, k) => k)]));
    const extras = p.grupos.reduce((s, g, gi) => s + seleccion[gi].reduce((t, o) => t + (g.opciones[o].precio || 0), 0), 0);
    const cantidad = i === 1 ? 2 : 1, observaciones = i === 0 ? 'Sin cebolla' : '';
    const detalle = [...p.grupos.flatMap((g, gi) => seleccion[gi].map((o) => g.opciones[o].nombre)), observaciones].filter(Boolean).join(' · ');
    return { key: `n${i}`, p, cantidad, seleccion, observaciones, detalle, importe: (p.precio + extras) * cantidad };
  });
  const unidades = filas.reduce((s, f) => s + f.cantidad, 0), subtotal = filas.reduce((s, f) => s + f.importe, 0);
  const aviso = `Productos: ${precioCentavos(subtotal)}. Envío y promociones se calculan al revisar; no es el total final.`;
  const editar = (f) => ({ revision, fila: f.key, ...datosPlatillo(f.p, { foto: foto(f.p, 'ficha'), seleccion: f.seleccion,
    cantidad: f.cantidad, observaciones: f.observaciones }) });
  const entrega = { revision, resumen: `Tu pedido: ${unidades} platillos · ${precioCorto(subtotal)}`, error: '', error_visible: false,
    modalidades: [{ id: 'm0', title: 'Recoger en tienda', description: '', metadata: '' },
      { id: 'm1', title: 'Entrega a domicilio', description: '', metadata: 'Envío $60' }],
    pagos: [{ id: 'p0', title: 'Efectivo', description: '', metadata: '' },
      { id: 'p1', title: 'Tarjeta al recibir', description: 'Terminal en la entrega', metadata: '' }],
    modalidad_inicial: '', pago_inicial: '', nota_inicial: '' };
  const carritoA = () => ({ carrito_aviso: aviso,
    renglones: filas.map((f) => ({ id: f.key, 'main-content': { title: recortar(f.p.nombre, 30), description: `x${f.cantidad}`,
      ...(f.detalle ? { metadata: recortar(f.detalle, 80) } : {}) }, end: { title: recortar(precioCorto(f.importe), 10) },
    'on-click-action': maqueta ? ir('EDITAR', editar(f)) : servidor({ operacion: 'editar', fila: f.key }) })),
    pasos: [
      { id: 'continuar', 'main-content': { title: recortar(`Continuar · ${precioCentavos(subtotal)}`, 30), description: 'Entrega y pago' },
        'on-click-action': maqueta ? ir('ENTREGA', entrega) : servidor({ operacion: 'continuar', revision }) },
      { id: 'seguir', 'main-content': { title: 'Seguir pidiendo', description: 'Volver al menú' },
        'on-click-action': maqueta ? fin('seguir') : servidor({ operacion: 'seguir' }) },
      { id: 'deshacer', 'main-content': { title: 'Deshacer último cambio' },
        'on-click-action': maqueta ? fin('deshacer') : servidor({ operacion: 'deshacer', revision }) }] });
  const carritoB = () => ({ revision, resumen: entrega.resumen, error: '', error_visible: false,
    renglones_md: bloque(filas.map((f) => `**${f.cantidad} × ${f.p.nombre}** · ${precioCorto(f.importe)}${f.detalle ? `\n${f.detalle}` : ''}`)
      .join('\n\n'), LIMITES_TIENDA.texto.TextBody),
    importe: aviso,
    filas: filas.map((f) => ({ id: f.key, title: recortar(`${f.cantidad} × ${f.p.nombre}`, 30),
      description: recortar(f.detalle, 300), metadata: recortar(precioCorto(f.importe), 20) })),
    hay_items: filas.length > 0, puede_deshacer: true, boton: recortar(`Continuar · ${precioCorto(subtotal)}`, LIMITES_TIENDA.label.Footer) });

  let accionBarra;
  if (maqueta) accionBarra = carrito === 'B' ? ir('CARRITO_B', carritoB()) : ir('CARRITO', carritoA());
  else {
    accionBarra = servidor({ operacion: 'ver_carrito' });
    for (const id of PANTALLAS_CARRITO[carrito]) anotar(id, id === 'CARRITO' ? carritoA() : carritoB());
    anotar('PERSONALIZAR', personalizar(conGrupos || platillos[0]));
    if (filas.length) anotar('EDITAR', editar(filas[0]));
  }
  const barra = [{ id: 'pedido', 'main-content': { title: 'Tu pedido', description: unidades ? `${unidades} platillo${unidades === 1 ? '' : 's'}` : 'Vacío',
    metadata: unidades ? 'Toca para revisar o continuar' : 'Elige una categoría para empezar' },
  ...(unidades ? { end: { title: recortar(precioCorto(subtotal), 10) } } : {}), 'on-click-action': accionBarra }];

  // Una categoría de más de 20 elementos se parte en páginas «Bebidas (1/2)».
  const { elementosLista: [, maxElementos] } = LIMITES_TIENDA;
  const lista = [];
  for (const c of categorias) {
    const tacos = normal(c.nombre) === 'tacos';
    const items = [...(tacos ? [null] : []), ...c.platillos], paginas = Math.ceil(items.length / maxElementos);
    for (let k = 0; k < paginas; k++) {
      const pagina = items.slice(k * maxElementos, (k + 1) * maxElementos), propios = pagina.filter(Boolean);
      const sufijo = paginas > 1 ? ` (${k + 1}/${paginas})` : '';
      const nombre = (limite) => `${recortar(c.nombre, limite - sufijo.length)}${sufijo}`;
      const primeraFoto = propios.find((p) => p.foto), portada = primeraFoto ? imagen('categoria', c.indice) : null;
      const datosCategoria = { categoria_titulo: nombre(LIMITES_TIENDA.label.NavigationList),
        categoria_aviso: 'Toca un platillo para elegir sus opciones.', barra,
        platillos: pagina.map((p) => (p === null ? { id: 'tacos', 'main-content': { title: 'Varios tacos a la vez',
          metadata: 'Elige cuántos quieres de cada guiso' },
        'on-click-action': maqueta ? fin('ver_tacos') : servidor({ operacion: 'ver_tacos', categoria: `c${c.indice}` }) } : {
          id: p.id, 'main-content': { title: recortar(p.nombre, 30), ...(recortar(p.descripcion, 80) ? { metadata: recortar(p.descripcion, 80) } : {}) },
          ...(foto(p, 'lista') ? { start: { image: foto(p, 'lista') } } : {}), end: { title: recortar(precioCorto(p.precio), 10) },
          'on-click-action': maqueta ? ir('PERSONALIZAR', personalizar(p)) : servidor({ operacion: 'ver', producto: p.id }) })) };
      lista.push({ id: paginas > 1 ? `c${c.indice}_${k + 1}` : `c${c.indice}`,
        'main-content': { title: nombre(30), description: recortar(`${propios.length} platillo${propios.length === 1 ? '' : 's'}`, 20),
          metadata: recortar(`Desde ${precioCorto(Math.min(...propios.map((p) => p.precio)))}`, 80) },
        ...(portada ? { start: { image: portada } } : {}), 'on-click-action': ir('CATEGORIA', datosCategoria) });
    }
  }
  if (lista.length > maxElementos) throw new Error(`La tienda admite hasta ${maxElementos} categorías con sus páginas; esta carta da ${lista.length}`);
  const menu = anotar('MENU', { barra, categorias: lista, menu_titulo: 'Menú', menu_aviso: 'Toca una categoría para ver sus platillos.' });
  return { instancias, menu, entrega, ir, fin, filas };
}

// ── Esquema de datos a partir de las instancias ──────────────────────────
export const ACCIONES = new Set(['on-click-action', 'on-select-action', 'on-unselect-action']);
function tipo(v, esAccion = false) {
  if (Array.isArray(v)) return { type: 'array', items: v.length ? v.map((x) => tipo(x)).reduce(fusionar) : null };
  if (v && typeof v === 'object') return { type: 'object', properties: Object.fromEntries(Object.entries(v).map(([k, x]) =>
    [k, esAccion && k === 'name' ? { const: x } : tipo(x, ACCIONES.has(k))])) };
  return { type: typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : 'string' };
}
function fusionar(a, b) {
  if (a === null) return b; if (b === null) return a;
  if ('const' in a || 'const' in b) {
    // Una lista con acciones de distinto nombre no se declara: cada lista lleva una sola clase de acción.
    if (a.const !== b.const) throw new Error(`Acciones distintas en la misma lista: ${a.const} / ${b.const}`);
    return a;
  }
  if (a.type !== b.type) throw new Error(`Tipos distintos en la misma clave: ${a.type} / ${b.type}`);
  if (a.type === 'array') return { type: 'array', items: fusionar(a.items, b.items) };
  if (a.type !== 'object') return a;
  const properties = { ...a.properties };
  for (const [k, t] of Object.entries(b.properties)) properties[k] = k in properties ? fusionar(properties[k], t) : t;
  return { type: 'object', properties };
}
const cerrar = (t) => (t === null ? { type: 'string' } : t.type === 'array' ? { type: 'array', items: cerrar(t.items) }
  : t.type === 'object' ? { type: 'object', properties: Object.fromEntries(Object.entries(t.properties).map(([k, x]) => [k, cerrar(x)])) } : t);
/** data de una pantalla: tipos fusionados de todas las instancias que le llegan; __example__ = la primera. */
export function declarar(instancias) {
  const [primera] = instancias, claves = Object.keys(primera);
  for (const i of instancias) if (Object.keys(i).join() !== claves.join()) throw new Error(`Instancias con claves distintas: ${Object.keys(i)} / ${claves}`);
  return Object.fromEntries(claves.map((k) => [k, { ...cerrar(instancias.map((i) => tipo(i[k])).reduce(fusionar)), __example__: primera[k] }]));
}

// ── Pantallas ────────────────────────────────────────────────────────────
const SOLO_LISTAS = (children) => ({ type: 'SingleColumnLayout', children });
const CANTIDADES = Array.from({ length: MAX_CANTIDAD_FLOW }, (_, i) => ({ id: String(i + 1), title: String(i + 1) }));

/** PERSONALIZAR y EDITAR: el mismo generador. EDITAR agrega revisión, fila y «Quitar». */
function pantallaPlatillo({ id, title, edicion }) {
  const ranuras = [], iniciales = {}, campos = {};
  for (let g = 0; g < RANURAS; g++) {
    const k = `g${g}`, comun = { required: dato(`${k}_requerido`), 'data-source': dato(`${k}_opciones`) };
    ranuras.push(
      { type: 'RadioButtonsGroup', name: `${k}_r`, label: dato(`${k}_label`), description: dato(`${k}_ayuda`), visible: dato(`${k}_radio`), ...comun },
      { type: 'Dropdown', name: `${k}_s`, label: dato(`${k}_label_corto`), visible: dato(`${k}_simple`), ...comun },
      { type: 'CheckboxGroup', name: `${k}_m`, label: dato(`${k}_label`), description: dato(`${k}_ayuda`), visible: dato(`${k}_multiple`), ...comun,
        'min-selected-items': dato(`${k}_min`), 'max-selected-items': dato(`${k}_max`) });
    for (const v of ['r', 's', 'm']) { iniciales[`${k}_${v}`] = dato(`${k}_inicial_${v}`); campos[`${k}_${v}`] = campo(`${k}_${v}`); }
  }
  Object.assign(iniciales, { observaciones: dato('observaciones_inicial'), cantidad: dato('cantidad_inicial') });
  const eleccion = { cantidad: campo('cantidad'), observaciones: campo('observaciones'), ...campos };
  const fila = { revision: dato('revision'), fila: dato('fila') };
  const children = [
    { type: 'If', condition: dato('con_foto'), then: [{ type: 'Image', src: dato('foto'), 'scale-type': 'cover', 'aspect-ratio': 1.5, 'alt-text': 'Foto del platillo' }] },
    { type: 'TextSubheading', text: dato('nombre') },
    { type: 'TextBody', text: dato('descripcion'), visible: dato('con_descripcion') },
    { type: 'TextCaption', text: dato('precio_texto') },
    { type: 'TextBody', text: dato('error'), visible: dato('error_visible') },
    ...ranuras,
    { type: 'TextArea', name: 'observaciones', label: 'Nota para cocina', required: false, 'max-length': MAX_OBSERVACIONES_PLATILLO,
      'helper-text': 'Ej.: sin crema, huevos bien cocidos. Extras: usa las opciones.' },
    { type: 'Dropdown', name: 'cantidad', label: 'Cantidad', required: true, 'data-source': CANTIDADES },
    ...(edicion ? [{ type: 'EmbeddedLink', text: 'Quitar del pedido', 'on-click-action': { name: 'data_exchange', payload: { operacion: 'quitar', ...fila } } }] : []),
    edicion
      ? { type: 'Footer', label: 'Guardar cambios', 'on-click-action': { name: 'data_exchange', payload: { operacion: 'aplicar', ...fila, ...eleccion } } }
      : { type: 'Footer', label: dato('boton'), 'on-click-action': { name: 'data_exchange',
        payload: { operacion: 'agregar', apertura: dato('apertura'), producto: dato('producto'), ...eleccion } } },
  ];
  return { id, title, refresh_on_back: false, data: {}, layout: { type: 'SingleColumnLayout', children: [
    { type: 'Form', name: 'form', 'init-values': iniciales, children }] } };
}

function pantallas() {
  const menu = { id: 'MENU', title: 'Menú', refresh_on_back: false, data: {}, layout: SOLO_LISTAS([
    { type: 'NavigationList', name: 'pedido', 'list-items': dato('barra') },
    { type: 'NavigationList', name: 'categorias', label: dato('menu_titulo'), description: dato('menu_aviso'), 'list-items': dato('categorias') }]) };
  const categoria = { id: 'CATEGORIA', title: 'Platillos', refresh_on_back: false, data: {}, layout: SOLO_LISTAS([
    { type: 'NavigationList', name: 'platillos', label: dato('categoria_titulo'), description: dato('categoria_aviso'), 'list-items': dato('platillos') },
    { type: 'NavigationList', name: 'pedido', 'list-items': dato('barra') }]) };
  const carritoA = { id: 'CARRITO', title: 'Tu pedido', refresh_on_back: true, data: {}, layout: SOLO_LISTAS([
    { type: 'NavigationList', name: 'renglones', label: 'Tu pedido', description: dato('carrito_aviso'), 'list-items': dato('renglones') },
    { type: 'NavigationList', name: 'pasos', label: 'Siguiente paso', 'list-items': dato('pasos') }]) };
  const revision = { revision: dato('revision') };
  const carritoB = { id: 'CARRITO_B', title: 'Tu pedido', refresh_on_back: true, data: {}, layout: { type: 'SingleColumnLayout', children: [
    { type: 'Form', name: 'form', children: [
      { type: 'TextSubheading', text: dato('resumen') },
      { type: 'TextBody', text: dato('error'), visible: dato('error_visible') },
      { type: 'TextBody', text: dato('renglones_md'), markdown: true },
      { type: 'TextCaption', text: dato('importe') },
      { type: 'Dropdown', name: 'fila', label: 'Editar o quitar', required: false, visible: dato('hay_items'), 'data-source': dato('filas'),
        'on-select-action': { name: 'data_exchange', payload: { operacion: 'editar', fila: campo('fila') } } },
      { type: 'EmbeddedLink', text: 'Seguir pidiendo', 'on-click-action': { name: 'data_exchange', payload: { operacion: 'seguir' } } },
      { type: 'EmbeddedLink', text: 'Deshacer último cambio', visible: dato('puede_deshacer'),
        'on-click-action': { name: 'data_exchange', payload: { operacion: 'deshacer', ...revision } } },
      { type: 'TextCaption', text: 'Continuar no confirma ni cobra: después eliges entrega y pago.' },
      { type: 'Footer', label: dato('boton'), 'on-click-action': { name: 'data_exchange', payload: { operacion: 'continuar', ...revision } } }] }] } };
  return { menu, categoria, carritoA, carritoB,
    personalizar: pantallaPlatillo({ id: 'PERSONALIZAR', title: 'Personaliza tu platillo', edicion: false }),
    editar: pantallaPlatillo({ id: 'EDITAR', title: 'Edita tu platillo', edicion: true }) };
}

/**
 * Flow JSON 7.3 (Data API 3.0) de tienda_v1.
 * carrito: 'AB' (las dos pantallas; el servidor elige cuál responder), 'A' o 'B'.
 */
export function definicionFlowTienda({ carrito = 'AB' } = {}) {
  if (!PANTALLAS_CARRITO[carrito]) throw new Error(`carrito debe ser A, B o AB: ${carrito}`);
  const p = pantallas();
  // TACOS y ENTREGA tal cual del formulario con dirección y nota (ENTREGA es
  // entregaConNota de definicion-nota-pedido.mjs); DIRECCION, pantallaDireccion().
  const base = definicionFlowCategorias({ direccion: true, nota: true });
  const tacos = { ...base.screens.find((s) => s.id === 'TACOS'), refresh_on_back: false };
  tacos.layout.children[0].children.find((c) => c.type === 'Footer').label = 'Agregar';
  const entrega = base.screens.find((s) => s.id === 'ENTREGA'), direccion = pantallaDireccion();
  const carritos = PANTALLAS_CARRITO[carrito];
  const propias = [p.menu, p.categoria, p.personalizar, ...carritos.map((id) => (id === 'CARRITO' ? p.carritoA : p.carritoB)), p.editar];
  const { instancias } = armarTienda(CARTA_EJEMPLO, { modo: 'endpoint', carrito, imagen: () => IMAGEN_VACIA });
  for (const s of propias) s.data = declarar(instancias.get(s.id));
  const [menu, categoria, personalizar, ...resto] = propias, editar = resto.pop();
  return { version: '7.3', data_api_version: '3.0', routing_model: {
    MENU: ['CATEGORIA', ...carritos], CATEGORIA: ['PERSONALIZAR', 'TACOS', ...carritos], PERSONALIZAR: [], TACOS: ['PERSONALIZAR'],
    ...Object.fromEntries(carritos.map((id) => [id, ['EDITAR', 'ENTREGA']])), EDITAR: [], ENTREGA: ['DIRECCION'], DIRECCION: [] },
  screens: [menu, categoria, personalizar, tacos, ...resto, editar, entrega, direccion] };
}

// ── Huella ───────────────────────────────────────────────────────────────
// La misma regla que publicar-flows-pedido.mjs: sha256 del JSON y nombre
// xabor_<tipo>_agrupado_<12 hex>. Cambiar la definición es publicar otro Flow.
export const huellaFlow = (definicion) => createHash('sha256').update(JSON.stringify(definicion)).digest('hex');
export const nombreFlowTienda = (definicion) => `xabor_tienda_agrupado_${huellaFlow(definicion).slice(0, 12)}`;
/** Dos construcciones de la misma fábrica dan la misma huella. */
export const huellaEstable = (fabrica) => huellaFlow(fabrica()) === huellaFlow(fabrica());
export const bytesJson = (valor) => Buffer.byteLength(JSON.stringify(valor));
export const dentroDelPresupuesto = (valor) => bytesJson(valor) <= LIMITES_TIENDA.presupuestoJson;

// ── Validador estático ───────────────────────────────────────────────────
const ENLACE = /^\$\{data\.([A-Za-z0-9_]+)\}$/;
const esDinamica = (v) => typeof v === 'string' && (v.includes('${') || v.includes('`'));
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const hijos = (c) => (c.type === 'If' ? [...(c.then || []), ...(c.else || [])] : c.type === 'Switch'
  ? Object.values(c.cases || {}).flat() : c.children || []);
export function recorrerComponentes(lista, fn, dentro = []) {
  for (const c of lista || []) { fn(c, dentro); recorrerComponentes(hijos(c), fn, [...dentro, c]); }
}
// Footer: en un If cuenta la rama con más (Meta exige el Footer en las dos ramas).
const footers = (lista) => (lista || []).reduce((n, c) => n + (c.type === 'Footer' ? 1 : c.type === 'If'
  ? Math.max(footers(c.then), footers(c.else)) : c.type === 'Switch' ? Math.max(0, ...Object.values(c.cases || {}).map(footers))
    : footers(c.children)), 0);
function accionesEnDatos(v, fn, ruta = '') {
  if (Array.isArray(v)) return v.forEach((x, i) => accionesEnDatos(x, fn, `${ruta}[${i}]`));
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) if (ACCIONES.has(k)) fn(x, `${ruta}.${k}`); else accionesEnDatos(x, fn, `${ruta}.${k}`);
}

/**
 * Devuelve la lista de violaciones (vacía si el Flow cumple). Revisa la
 * estructura de cada pantalla, el grafo de rutas y CADA instancia de datos que
 * llega a cada pantalla: el __example__ y los payload de cada navigate (en la
 * maqueta, la carta real entera).
 */
export function validarFlowTienda(flow, { endpoint = 'data_api_version' in flow } = {}) {
  const L = LIMITES_TIENDA, errores = new Set(), mal = (m) => errores.add(m);
  const pantallasPorId = new Map(flow.screens.map((s) => [s.id, s]));
  if (pantallasPorId.size !== flow.screens.length) mal('ids de pantalla repetidos');
  if (flow.screens.length > L.pantallas) mal(`${flow.screens.length} pantallas (máximo ${L.pantallas})`);
  const aristas = new Map(flow.screens.map((s) => [s.id, new Set()]));

  const medir = (x, limite, que, noVacia = false) => {
    if (typeof x !== 'string') return;
    if (noVacia && !x.length) mal(`${que}: cadena vacía`);
    if (x.length > limite) mal(`${que}: ${x.length} > ${limite} caracteres («${x.slice(0, 40)}»)`);
  };
  const imagenValida = (b64, max, que) => {
    if (typeof b64 !== 'string') return;
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length || buf.toString('base64').replace(/=+$/, '') !== b64.replace(/=+$/, '')) return mal(`${que}: no es base64 válido`);
    if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) && !buf.subarray(0, 8).equals(PNG)) mal(`${que}: solo JPEG o PNG`);
    if (buf.length > max) mal(`${que}: ${buf.length} bytes > ${max}`);
  };

  function accion(s, a, donde, componente, estatica) {
    if (!a || typeof a !== 'object') return mal(`${donde}: acción vacía`);
    if (a.name === 'navigate') {
      const t = pantallasPorId.get(a.next?.name);
      if (!t) return mal(`${donde}: navigate a una pantalla inexistente (${a.next?.name})`);
      if (s.terminal && componente?.type === 'Footer') mal(`${donde}: navigate en el Footer de una pantalla terminal`);
      aristas.get(s.id).add(t.id);
      if (endpoint && !(flow.routing_model?.[s.id] || []).includes(t.id)) mal(`${donde}: navigate ${s.id} → ${t.id} fuera del routing_model`);
      const esperadas = Object.keys(t.data || {}).sort().join(','), dadas = Object.keys(a.payload || {}).sort().join(',');
      if (esperadas !== dadas) mal(`${donde}: payload de navigate a ${t.id} no coincide con su data (${dadas} ≠ ${esperadas})`);
      if (!(estatica && JSON.stringify(a.payload ?? {}).includes('${'))) visitar(t, a.payload || {}, `${donde} → ${t.id}`);
    } else if (a.name === 'data_exchange') {
      if (!endpoint) mal(`${donde}: data_exchange en un Flow sin endpoint`);
    } else if (a.name === 'complete') {
      if (!s.terminal) mal(`${donde}: complete fuera de una pantalla terminal`);
    } else if (!['update_data', 'open_url'].includes(a.name)) mal(`${donde}: acción desconocida (${a.name})`);
  }

  const vistos = new Set();
  function visitar(s, datos, donde) {
    const clave = `${s.id}:${createHash('sha1').update(JSON.stringify(datos)).digest('hex')}`;
    if (vistos.has(clave)) return;
    vistos.add(clave);
    instancia(s, datos, donde);
    accionesEnDatos(datos, (a, ruta) => accion(s, a, `${donde}${ruta}`, null, false));
  }
  function instancia(s, datos, donde) {
    const valor = (v) => { if (typeof v !== 'string') return v; const m = v.match(ENLACE); return m ? datos[m[1]] : esDinamica(v) ? undefined : v; };
    const prop = (v, limite, que, noVacia = false) => medir(valor(v), limite, `${donde} ${que}`, noVacia || (typeof v === 'string' && !esDinamica(v)));
    const ids = new Set();
    recorrerComponentes(s.layout?.children, (c) => {
      const que = `${c.type}${c.name ? `(${c.name})` : ''}`;
      if (L.texto[c.type]) prop(c.text, L.texto[c.type], `${que}.text`);
      if (c.type === 'Footer') {
        prop(c.label, L.label.Footer, 'Footer.label');
        for (const k of ['left-caption', 'right-caption', 'center-caption']) if (c[k] != null) prop(c[k], L.footerCaption, `Footer.${k}`);
      }
      if (['Dropdown', 'RadioButtonsGroup', 'CheckboxGroup', 'TextArea', 'TextInput'].includes(c.type)) prop(c.label, L.label[c.type], `${que}.label`);
      if (c['helper-text'] != null) prop(c['helper-text'], L.helperText, `${que}.helper-text`);
      if (L.description[c.type] && c.description != null) prop(c.description, L.description[c.type], `${que}.description`, c.type === 'NavigationList');
      if (L.opciones[c.type]) {
        const ds = valor(c['data-source']);
        if (Array.isArray(ds)) {
          if (ds.length < 1 || ds.length > L.opciones[c.type]) mal(`${donde} ${que}: ${ds.length} opciones (1–${L.opciones[c.type]})`);
          ds.forEach((o, i) => {
            medir(o.title, L.opcion.title, `${donde} ${que}[${i}].title`, true);
            medir(o.description, L.opcion.description, `${donde} ${que}[${i}].description`);
            medir(o.metadata, L.opcion.metadata, `${donde} ${que}[${i}].metadata`);
            if (o.image != null) imagenValida(o.image, L.imagenLista, `${donde} ${que}[${i}].image`);
          });
        }
      }
      if (c.type === 'Image') imagenValida(valor(c.src), L.imagen, `${donde} ${que}.src`);
      if (c.type !== 'NavigationList') return;
      if (c.label != null) prop(c.label, L.label.NavigationList, `${que}.label`, true);
      const items = valor(c['list-items']);
      if (!Array.isArray(items)) { if (!esDinamica(c['list-items'])) mal(`${donde} ${que}: list-items no es una lista`); return; }
      const [min, max] = L.elementosLista, E = L.elementoLista;
      if (items.length < min || items.length > max) mal(`${donde} ${que}: ${items.length} elementos (${min}–${max})`);
      let badges = 0;
      items.forEach((it, i) => {
        const q = `${donde} ${que}[${i}]`, mc = it?.['main-content'] || {};
        if (typeof it?.id !== 'string' || !it.id) mal(`${q}: id obligatorio`);
        else if (ids.has(it.id)) mal(`${q}: id repetido en la pantalla (${it.id})`); else ids.add(it.id);
        if (typeof mc.title !== 'string') mal(`${q}: main-content.title obligatorio`);
        medir(mc.title, E.title, `${q} main-content.title`, true);
        medir(mc.description, E.description, `${q} main-content.description`);
        medir(mc.metadata, E.metadata, `${q} main-content.metadata`);
        for (const k of ['title', 'description', 'metadata']) medir(it.end?.[k], E.end, `${q} end.${k}`);
        if (it.end && c['media-size'] === 'large') mal(`${q}: end con media-size large`);
        if (it.badge != null) { badges++; medir(it.badge, E.badge, `${q} badge`); }
        if (it.tags != null) { if (it.tags.length > E.tags) mal(`${q}: ${it.tags.length} tags (máximo ${E.tags})`); it.tags.forEach((t, j) => medir(t, E.tag, `${q} tags[${j}]`)); }
        if (it.start) { if (typeof it.start.image !== 'string') mal(`${q}: start sin image`); else imagenValida(it.start.image, L.imagenLista, `${q} start.image`); }
        const a = it['on-click-action'];
        if (a && c['on-click-action']) mal(`${q}: on-click-action en el componente y en el elemento`);
        if (!a && !c['on-click-action']) mal(`${q}: sin on-click-action`);
        if (a && !['navigate', 'data_exchange'].includes(a.name)) mal(`${q}: on-click-action solo admite navigate o data_exchange (${a.name})`);
      });
      if (badges > 1) mal(`${donde} ${que}: ${badges} badges (máximo 1 por lista)`);
    });
  }

  // Estructura de cada pantalla (independiente de los datos) y sus acciones fijas.
  for (const s of flow.screens) {
    const raiz = s.layout?.children || [];
    medir(s.title, L.tituloPantalla, `${s.id}.title`, true);
    let total = 0, imagenes = 0, enlaces = 0, listas = 0, otros = 0, anidada = false;
    const nombres = new Set(), fijas = [];
    recorrerComponentes(raiz, (c, dentro) => {
      total++; if (c.name) nombres.add(c.name);
      if (c.type === 'Image') imagenes++;
      if (c.type === 'EmbeddedLink') enlaces++;
      if (c.type === 'NavigationList') { listas++; if (dentro.length) anidada = true; } else otros++;
      for (const k of ACCIONES) if (c[k]) fijas.push([c[k], c]);
    });
    if (total > L.componentesPorPantalla) mal(`${s.id}: ${total} componentes (máximo ${L.componentesPorPantalla})`);
    const f = footers(raiz);
    if (f > L.footerPorPantalla) mal(`${s.id}: ${f} Footer (máximo ${L.footerPorPantalla})`);
    if (imagenes > L.imagenesPorPantalla) mal(`${s.id}: ${imagenes} Image (máximo ${L.imagenesPorPantalla})`);
    if (enlaces > L.enlacesPorPantalla) mal(`${s.id}: ${enlaces} EmbeddedLink (máximo ${L.enlacesPorPantalla})`);
    if (listas) {
      if (otros) mal(`${s.id}: NavigationList con otros componentes en su pantalla (${otros})`);
      if (listas > L.listasPorPantalla) mal(`${s.id}: ${listas} NavigationList (máximo ${L.listasPorPantalla})`);
      if (s.terminal) mal(`${s.id}: NavigationList en una pantalla terminal`);
      if (anidada) mal(`${s.id}: NavigationList dentro de otro componente (Form, If o Switch)`);
    }
    const json = JSON.stringify(s.layout);
    for (const [, k] of json.matchAll(/\$\{data\.([A-Za-z0-9_]+)\}/g)) if (!(k in (s.data || {}))) mal(`${s.id}: \${data.${k}} sin declarar`);
    for (const [, k] of json.matchAll(/\$\{form\.([A-Za-z0-9_]+)\}/g)) if (!nombres.has(k)) mal(`${s.id}: \${form.${k}} sin componente`);
    if (!endpoint && 'refresh_on_back' in s) mal(`${s.id}: refresh_on_back en un Flow sin endpoint`);
    for (const [a, c] of fijas) accion(s, a, `${s.id}.${c.type}${c.name ? `(${c.name})` : ''}`, c, true);
  }
  if (!endpoint) for (const k of ['routing_model', 'data_api_version']) if (k in flow) mal(`${k} en un Flow sin endpoint`);
  for (const s of flow.screens) visitar(s, Object.fromEntries(Object.entries(s.data || {}).map(([k, v]) => [k, v?.__example__])), `${s.id}.__example__`);

  // Grafo: con endpoint, el routing_model (todo navigate debe caber en él); sin endpoint, los navigate.
  let grafo = aristas;
  if (endpoint) {
    const rm = flow.routing_model || {};
    grafo = new Map(Object.entries(rm).map(([k, v]) => [k, new Set(v)]));
    for (const [k, v] of Object.entries(rm)) {
      if (!pantallasPorId.has(k)) mal(`routing_model: pantalla inexistente ${k}`);
      for (const t of v) if (!pantallasPorId.has(t)) mal(`routing_model: ${k} → pantalla inexistente ${t}`);
    }
    for (const s of flow.screens) if (!(s.id in rm)) mal(`routing_model: falta la pantalla ${s.id}`);
  }
  for (const [k, v] of grafo) if (v.size > L.salidasPorPantalla) mal(`${k}: ${v.size} salidas (máximo ${L.salidasPorPantalla})`);
  const estado = new Map();
  const dfs = (nodo, pila) => {
    estado.set(nodo, 1);
    for (const sig of grafo.get(nodo) || []) {
      if (estado.get(sig) === 1) mal(`ciclo en las rutas: ${[...pila.slice(pila.indexOf(sig)), sig].join(' → ')}`);
      else if (!estado.get(sig)) dfs(sig, [...pila, sig]);
    }
    estado.set(nodo, 2);
  };
  for (const nodo of grafo.keys()) if (!estado.get(nodo)) dfs(nodo, [nodo]);
  return [...errores];
}
