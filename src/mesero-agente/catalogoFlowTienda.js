// Formulario «tienda» (contrato tienda_v1): lo que el servidor DIBUJA. Arma los
// datos de MENU, CATEGORIA, PERSONALIZAR, EDITAR y CARRITO (opción B) a partir
// de la foto (lo comercial), la vitrina (descripciones y llaves de foto) y el
// borrador ya resumido. Puro: sin base de datos, sin sharp, sin Meta; las
// miniaturas llegan por un lector síncrono que solo consulta la caché.
//
// Aquí viven también los textos, precios y ranuras que comparte con la
// definición del Flow (scripts/definicion-flow-tienda.mjs los reexporta): una
// sola fuente, así lo que el servidor manda tiene la forma que el Flow declara.
//
// Meta no trunca: un texto que pasa de su límite NO se dibuja. Todo se corta
// antes de mandarlo. Un precio que no cabe en su lugar no se corta (un «$1,00…»
// engaña): se omite.
//
// Presupuesto (propuesta, sección 2): cada respuesta mide a lo más 600 KB de
// JSON. El MENU baja por una escalera determinista:
//   0  miniaturas de platillo de 96 px
//   1  miniaturas de platillo de 80 px (q55)
//   2  sin miniaturas de platillo, desde la última categoría hacia la primera
//   3  modo B: el MENU sin catálogo; cada categoría se pide por data_exchange
//   4  modo B sin portadas (guarda final: solo texto)
import { categoriasFlow, loteTacos, cantidadFlow } from './catalogoFlowCategorias.js';
import { leerObservacionesPlatillo } from './observacionesDelPlatillo.js';
import { POR_OMISION_TIENDA } from './contratoTienda.js';

// g0..g5, como el formulario de hoy (= GRUPOS_POR_LINEA_FLOW; la prueba lo
// exige). No se importa de formularioAgrupado.js para no crear un ciclo.
export const RANURAS = 6;
export const MAX_RADIO = 8; // una sola elección con 8 opciones o menos → RadioButtonsGroup; más → Dropdown
// Un carrito de más renglones (o una cantidad de más de 20) no abre la tienda:
// sale «Tu carrito» (carrito_v1). Dentro de la tienda, agregar respeta el tope.
export const MAX_RENGLONES_TIENDA = 20;

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
  presupuestoJson: 600_000, // tope duro propio para cada RESPUESTA del servidor (sección 2): la doc dice «1 Mb» y el changelog «10MB» [NV]
  // El flow.json de la maqueta no es una respuesta del servidor: embebe la ficha
  // (con su foto de 480×320) de cada platillo. [M] Meta validó el 3-oct un
  // borrador de 1.40 MB (maqueta A con fotos reales); su tope real no está documentado [NV].
  maquetaJson: 1_500_000,
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
/** Un precio para un lugar de `limite` letras, o null si no cabe (nunca se corta). */
export const precioQueCabe = (n, limite) => { const p = precioCorto(n); return p.length <= limite ? p : null; };
const unir = (l) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} y ${l.at(-1)}`);
const plural = (n, palabra) => `${n} ${palabra}${n === 1 ? '' : 's'}`;
// Lo que el cliente o el menú escriben y sale en un TextBody con markdown: sin
// marcas que cambien el formato ni armen un enlace.
const sinMarcas = (s) => String(s ?? '').replace(/[*_~`[\]]/g, '');

// ── Datos de un platillo (PERSONALIZAR y EDITAR) ─────────────────────────
const opcionFlow = (id, nombre, precio) => ({ id, title: recortar(nombre, 30),
  description: String(nombre).length > 30 ? recortar(nombre, 300) : '', metadata: precio > 0 ? recortar(`+${precioCorto(precio)}`, 20) : '' });
function ayuda(grupo, max) {
  if (!grupo) return 'Opcional';
  if (grupo.minimo <= 0) return max > 1 ? `Opcional · hasta ${max}` : 'Opcional';
  return grupo.minimo === max ? `Elige ${max}` : `Elige ${grupo.minimo} a ${max}`;
}
/** Qué variante dibuja una ranura: 'r' (Radio), 's' (Dropdown) o 'm' (Checkbox). */
export const varianteDeGrupo = (grupo) => (grupo.maximo > 1 ? 'm' : grupo.opciones.length <= MAX_RADIO ? 'r' : 's');
/**
 * Las 6 ranuras. Cada una tiene tres variantes y solo una visible:
 * Radio (una elección, ≤ 8 opciones), Dropdown (una elección, más de 8) y
 * Checkbox (varias, con min/max dinámicos). `seleccion`: {indiceGrupo: [indicesOpcion]}.
 */
export function datosRanuras(grupos = [], seleccion = {}) {
  const d = {};
  for (let g = 0; g < RANURAS; g++) {
    const k = `g${g}`, grupo = grupos[g], variante = grupo ? varianteDeGrupo(grupo) : null; // una sola regla con itemDeFicha
    const multiple = variante === 'm', radio = variante === 'r';
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
export const tieneExtras = (p) => p.grupos.some((g) => g.opciones.some((o) => o.precio > 0));
/** Lo común de PERSONALIZAR y EDITAR. `foto` es base64 o null. */
export function datosPlatillo(p, { foto = null, seleccion = {}, cantidad = 1, observaciones = '' } = {}) {
  const base = precioCorto(p.precio), descripcion = bloque(p.descripcion, LIMITES_TIENDA.texto.TextBody);
  return { nombre: recortar(p.nombre, LIMITES_TIENDA.texto.TextSubheading), descripcion, con_descripcion: !!descripcion,
    precio_texto: tieneExtras(p) ? `Precio base ${base} · los extras se suman` : base,
    con_foto: !!foto, foto: foto || IMAGEN_VACIA, error: '', error_visible: false,
    cantidad_inicial: String(cantidad), observaciones_inicial: observaciones, ...datosRanuras(p.grupos, seleccion) };
}
/** «Agregar · $X» o «Agregar · desde $X» (con extras); sin precio en vivo en v1. */
export const botonAgregar = (p) => recortar(`Agregar · ${tieneExtras(p) ? 'desde ' : ''}${precioCorto(p.precio)}`, LIMITES_TIENDA.label.Footer);

// ── Medidas ──────────────────────────────────────────────────────────────
export const bytesJson = (valor) => Buffer.byteLength(JSON.stringify(valor));
const cabe = (screen, data, presupuesto) => bytesJson({ screen, data }) <= presupuesto;

// ── El menú de la foto: categorías, páginas y tacos ──────────────────────
/**
 * La categoría que lleva «Varios tacos a la vez»: la primera, en orden
 * comercial, que se llama Tacos y tiene tacos por cantidad (loteTacos). Una sola,
 * así el lote que llega de TACOS (que no dice de qué categoría es) no es ambiguo.
 */
export function categoriaDeTacos(foto, { variosTacos = POR_OMISION_TIENDA.variosTacos } = {}) {
  if (!variosTacos) return null;
  return categoriasFlow(foto).find((c) => loteTacos(foto, c).length) || null;
}
/**
 * Los renglones de la lista «Menú»: una entrada por categoría, o varias
 * «Bebidas (1/2)» si pasa de 20 elementos (el renglón de tacos cuenta).
 * → [{id:'c3'|'c3_1', categoria, indice, pagina, paginas, elementos:[null|i…]}]
 * null es el renglón «Varios tacos a la vez».
 */
export function entradasMenu(foto, opciones = {}) {
  const [, max] = LIMITES_TIENDA.elementosLista, tacos = categoriaDeTacos(foto, opciones), entradas = [];
  categoriasFlow(foto).forEach((categoria, indice) => {
    const elementos = [...(tacos?.id === categoria.id ? [null] : []), ...categoria.indices];
    const paginas = Math.ceil(elementos.length / max);
    for (let pagina = 0; pagina < paginas; pagina++) {
      entradas.push({ id: paginas > 1 ? `${categoria.id}_${pagina + 1}` : categoria.id, categoria, indice, pagina, paginas,
        elementos: elementos.slice(pagina * max, (pagina + 1) * max) });
    }
  });
  return entradas;
}

/**
 * Por qué una foto NO puede abrirse como tienda (null si puede). Sin tienda, el
 * formulario es el de hoy («Arma tu pedido» o «Tu carrito»).
 */
export function motivoSinTienda(foto, opciones = {}) {
  if (!Array.isArray(foto?.productos) || !foto.productos.length) return 'sin_productos';
  const lineas = Array.isArray(foto.lineas) ? foto.lineas : [];
  if (lineas.length > MAX_RENGLONES_TIENDA) return 'renglones';
  if (lineas.some((l) => !cantidadFlow(String(l?.cantidad)))) return 'cantidad';
  if (lineas.some((l) => !foto.productos.some((p) => p.id === l?.ficha?.id))) return 'producto_fuera';
  if (entradasMenu(foto, opciones).length > LIMITES_TIENDA.elementosLista[1]) return 'categorias';
  return null;
}
export const admiteTienda = (foto, opciones) => motivoSinTienda(foto, opciones) === null;

// ── Vitrina ──────────────────────────────────────────────────────────────
// `vitrina` = la de vitrinaTienda.js ({productos:{id:{descripcion, storageKey}}})
// más, opcional, `miniatura(storageKey, variante)`: síncrona, solo la caché
// (miniaturasMenu.obtener encola lo que falta). Sin vitrina el formulario se
// dibuja sin fotos ni descripciones, que es exactamente lo de hoy.
export const MINIATURA = Object.freeze({ categoria: 'cat128', lista: 'lista96', listaChica: 'lista80', ficha: 'ficha480' });
const visualDe = (vitrina, p) => vitrina?.productos?.[String(p.id)] || null;
export const descripcionDe = (vitrina, p) => String(visualDe(vitrina, p)?.descripcion ?? '').trim();
export const llaveDe = (vitrina, p) => (typeof visualDe(vitrina, p)?.storageKey === 'string' ? visualDe(vitrina, p).storageKey : null);
/** Lector memoizado por respuesta: la misma miniatura se pide una vez. */
function lectorDeMiniaturas(vitrina) {
  const memo = new Map();
  return (llave, variante) => {
    if (!llave || typeof vitrina?.miniatura !== 'function') return null;
    const k = `${llave}|${variante}`;
    if (!memo.has(k)) {
      let b = null;
      try { b = vitrina.miniatura(llave, variante); } catch { b = null; }
      // start.image admite 100 KB; nada más grande ni que no sea texto.
      memo.set(k, typeof b === 'string' && b.length > 0 && b.length <= LIMITES_TIENDA.imagenLista ? b : null);
    }
    return memo.get(k);
  };
}

// ── Barra «Tu pedido» ────────────────────────────────────────────────────
/**
 * `pedido` = {renglones:[{key, nombre, cantidad, detalle, importeCentavos, faltan}], unidades, subtotalCentavos}
 * (lo arma flowTienda.js desde el borrador). `agregado`: keys recién agregadas.
 */
export function barraPedido(pedido, { agregado = null } = {}) {
  const n = pedido.unidades, total = n ? precioQueCabe(pedido.subtotalCentavos / 100, LIMITES_TIENDA.elementoLista.end) : null;
  const nuevos = (agregado || []).map((k) => pedido.renglones.find((r) => r.key === k)).filter(Boolean);
  const metadata = nuevos.length === 1 ? `Agregaste: ${nuevos[0].cantidad} × ${nuevos[0].nombre}`
    : nuevos.length > 1 ? `Agregaste ${nuevos.length} platillos` : n ? 'Toca para revisar o continuar' : 'Elige una categoría para empezar';
  return [{ id: 'pedido', 'main-content': { title: 'Tu pedido', description: n ? recortar(plural(n, 'platillo'), LIMITES_TIENDA.elementoLista.description) : 'Vacío',
    metadata: recortar(metadata, LIMITES_TIENDA.elementoLista.metadata) }, ...(total ? { end: { title: total } } : {}),
  'on-click-action': { name: 'data_exchange', payload: { operacion: 'ver_carrito' } } }];
}

// ── CATEGORIA ────────────────────────────────────────────────────────────
const nombreDeEntrada = (e, limite) => {
  const sufijo = e.paginas > 1 ? ` (${e.pagina + 1}/${e.paginas})` : '';
  return `${recortar(e.categoria.nombre, limite - sufijo.length) || 'Menú'}${sufijo}`;
};
function renglonPlatillo(foto, i, vitrina, leer, variante) {
  const p = foto.productos[i], E = LIMITES_TIENDA.elementoLista;
  const metadata = recortar(descripcionDe(vitrina, p), E.metadata), precio = precioQueCabe(p.precio, E.end);
  const imagen = variante ? leer(llaveDe(vitrina, p), variante) : null;
  return { id: `p${i}`, 'main-content': { title: recortar(p.nombre, E.title) || 'Platillo', ...(metadata ? { metadata } : {}) },
    ...(imagen ? { start: { image: imagen } } : {}), ...(precio ? { end: { title: precio } } : {}),
    'on-click-action': { name: 'data_exchange', payload: { operacion: 'ver', producto: `p${i}` } } };
}
const renglonTacos = (categoria) => ({ id: 'tacos', 'main-content': { title: 'Varios tacos a la vez', metadata: 'Elige cuántos quieres de cada guiso' },
  'on-click-action': { name: 'data_exchange', payload: { operacion: 'ver_tacos', categoria: categoria.id } } });
/** Datos de CATEGORIA para una entrada del menú. `variante`: 'lista96' | 'lista80' | null (sin miniaturas). */
function armarCategoria(foto, entrada, barra, vitrina, leer, { variante = MINIATURA.lista, aviso = '' } = {}) {
  return { categoria_titulo: nombreDeEntrada(entrada, LIMITES_TIENDA.label.NavigationList),
    categoria_aviso: recortar(aviso || 'Toca un platillo para elegir sus opciones.', LIMITES_TIENDA.description.NavigationList),
    barra, platillos: entrada.elementos.map((i) => (i === null ? renglonTacos(entrada.categoria) : renglonPlatillo(foto, i, vitrina, leer, variante))) };
}
/**
 * CATEGORIA por data_exchange (modo B, o «Elegir y personalizar un taco»):
 * con miniaturas de 96, de 80 o sin ellas, lo primero que quepa.
 */
export function datosCategoria(foto, entradaId, pedido, vitrina, { aviso = '', presupuesto = LIMITES_TIENDA.presupuestoJson } = {}) {
  const entrada = entradasMenu(foto).find((e) => e.id === entradaId);
  if (!entrada) return null;
  const leer = lectorDeMiniaturas(vitrina), barra = barraPedido(pedido);
  let data;
  for (const variante of [MINIATURA.lista, MINIATURA.listaChica, null]) {
    data = armarCategoria(foto, entrada, barra, vitrina, leer, { variante, aviso });
    if (cabe('CATEGORIA', data, presupuesto)) break;
  }
  return data;
}

// ── MENU ─────────────────────────────────────────────────────────────────
export const NIVELES_MENU = Object.freeze(['miniaturas_96', 'miniaturas_80', 'sin_miniaturas_desde_el_final', 'modo_b', 'modo_b_sin_portadas']);
/**
 * El MENU (INIT, después de «Agregar», «Seguir pidiendo» y Atrás desde el
 * carrito) con la escalera de bytes. → {data, nivel, sinMiniaturas, bytes}
 * `sinMiniaturas`: cuántas categorías, contando desde la última, van sin
 * miniaturas de platillo (nivel 2).
 */
export function datosMenu(foto, pedido, vitrina, { aviso = '', agregado = null, presupuesto = LIMITES_TIENDA.presupuestoJson } = {}) {
  const entradas = entradasMenu(foto).slice(0, LIMITES_TIENDA.elementosLista[1]); // motivoSinTienda impide que pase
  const leer = lectorDeMiniaturas(vitrina), barra = barraPedido(pedido, { agregado }), E = LIMITES_TIENDA.elementoLista;
  const categorias = Math.max(0, ...entradas.map((e) => e.indice + 1));
  const armar = ({ variante, sinDesde = Infinity, modoB = false, portadas = true }) => ({
    barra,
    categorias: entradas.map((e) => {
      const propios = e.elementos.filter((i) => i !== null), productos = propios.map((i) => foto.productos[i]);
      // La portada es la del primer platillo con foto de esa página: nunca la de
      // uno que el formulario no muestra. Solo se pide esa (si aún no está, la
      // categoría sale sin portada y se encola): no se encola una por platillo.
      const conFoto = portadas ? productos.find((p) => llaveDe(vitrina, p)) : null;
      const portada = conFoto ? leer(llaveDe(vitrina, conFoto), MINIATURA.categoria) : null;
      const desde = productos.length ? precioQueCabe(Math.min(...productos.map((p) => p.precio)), E.metadata - 'Desde '.length) : null;
      return { id: e.id, 'main-content': { title: nombreDeEntrada(e, E.title), description: recortar(plural(propios.length, 'platillo'), E.description),
        ...(desde ? { metadata: `Desde ${desde}` } : {}) }, ...(portada ? { start: { image: portada } } : {}),
      'on-click-action': modoB ? { name: 'data_exchange', payload: { operacion: 'categoria', categoria: e.id } }
        : { name: 'navigate', next: { type: 'screen', name: 'CATEGORIA' },
          payload: armarCategoria(foto, e, barra, vitrina, leer, { variante: e.indice >= sinDesde ? null : variante }) } };
    }),
    menu_titulo: 'Menú',
    menu_aviso: recortar(aviso || 'Toca una categoría para ver sus platillos.', LIMITES_TIENDA.description.NavigationList),
  });
  const intentos = [
    () => [0, { variante: MINIATURA.lista }],
    () => [1, { variante: MINIATURA.listaChica }],
    ...Array.from({ length: categorias }, (_, k) => () => [2, { variante: MINIATURA.listaChica, sinDesde: categorias - 1 - k }]),
    () => [3, { modoB: true }],
  ];
  for (const intento of intentos) {
    const [nivel, o] = intento(), data = armar(o), bytes = bytesJson({ screen: 'MENU', data });
    if (bytes <= presupuesto) return { data, nivel, sinMiniaturas: nivel === 2 ? categorias - o.sinDesde : 0, bytes };
  }
  const data = armar({ modoB: true, portadas: false });
  return { data, nivel: 4, sinMiniaturas: 0, bytes: bytesJson({ screen: 'MENU', data }) };
}

// ── PERSONALIZAR y EDITAR ────────────────────────────────────────────────
/** Lo que el cliente ya eligió en un intento rechazado (ids «oN» de su ficha). */
function conIntento(data, intento) {
  if (!intento) return data;
  if (cantidadFlow(intento.cantidad)) data.cantidad_inicial = intento.cantidad;
  const nota = leerObservacionesPlatillo(intento.observaciones);
  if (nota !== null && typeof intento.observaciones === 'string') data.observaciones_inicial = nota;
  for (let g = 0; g < RANURAS; g++) {
    const ids = new Set(data[`g${g}_opciones`].map((o) => o.id).filter((id) => id !== 'oculto'));
    if (data[`g${g}_radio`] && ids.has(intento[`g${g}_r`])) data[`g${g}_inicial_r`] = intento[`g${g}_r`];
    if (data[`g${g}_simple`] && ids.has(intento[`g${g}_s`])) data[`g${g}_inicial_s`] = intento[`g${g}_s`];
    if (data[`g${g}_multiple`] && Array.isArray(intento[`g${g}_m`])) {
      data[`g${g}_inicial_m`] = [...new Set(intento[`g${g}_m`].filter((id) => ids.has(id)))].slice(0, data[`g${g}_max`]);
    }
  }
  return data;
}
function fichaConFoto(p, vitrina, armar, presupuesto, screen) {
  const leer = lectorDeMiniaturas(vitrina), ficha = leer(llaveDe(vitrina, p), MINIATURA.ficha);
  const con = armar(ficha && ficha.length <= LIMITES_TIENDA.imagen ? ficha : null);
  return con.con_foto && !cabe(screen, con, presupuesto) ? armar(null) : con;
}
const conError = (data, error) => Object.assign(data, { error: error ? bloque(error, LIMITES_TIENDA.texto.TextBody) : '', error_visible: !!error });
/** PERSONALIZAR del platillo `i` de la foto, con su apertura (r{revision}.p{i}). */
export function datosPersonalizar(foto, i, vitrina, { apertura, error = '', intento = null, presupuesto = LIMITES_TIENDA.presupuestoJson } = {}) {
  const p = foto.productos[i], visible = { ...p, descripcion: descripcionDe(vitrina, p) };
  return fichaConFoto(p, vitrina, (imagen) => conError(conIntento({ producto: `p${i}`, apertura,
    ...datosPlatillo(visible, { foto: imagen }), boton: botonAgregar(p) }, intento), error), presupuesto, 'PERSONALIZAR');
}
/**
 * EDITAR de un renglón del borrador: `item` con la forma de carrito_v1
 * ({producto0, cantidad, observaciones, gG_s|gG_m con ids p{i}g{G}o{N}}).
 */
export function datosEditar(foto, fila, vitrina, { revision, error = '', intento = null, presupuesto = LIMITES_TIENDA.presupuestoJson } = {}) {
  const i = Number(String(fila.item.producto0).slice(1)), p = foto.productos[i], visible = { ...p, descripcion: descripcionDe(vitrina, p) };
  const seleccion = {};
  p.grupos.forEach((g, gi) => {
    const v = fila.item[`g${gi}_${g.maximo > 1 ? 'm' : 's'}`], prefijo = `p${i}g${gi}o`;
    seleccion[gi] = (Array.isArray(v) ? v : v ? [v] : []).filter((id) => typeof id === 'string' && id.startsWith(prefijo))
      .map((id) => Number(id.slice(prefijo.length))).filter((k) => Number.isInteger(k) && g.opciones[k]);
  });
  const cantidad = cantidadFlow(String(fila.item.cantidad)) || 1, observaciones = leerObservacionesPlatillo(fila.item.observaciones) ?? '';
  return fichaConFoto(p, vitrina, (imagen) => conError(conIntento({ revision: String(revision), fila: fila.key,
    ...datosPlatillo(visible, { foto: imagen, seleccion, cantidad, observaciones }) }, intento), error), presupuesto, 'EDITAR');
}

// ── CARRITO (opción B) ───────────────────────────────────────────────────
export const resumenDelPedido = (pedido) => (pedido.unidades
  ? recortar(`Tu pedido: ${plural(pedido.unidades, 'platillo')} · ${precioCorto(pedido.subtotalCentavos / 100)}`, LIMITES_TIENDA.texto.TextSubheading)
  : 'Tu pedido está vacío');
const detalleRenglon = (r) => [r.detalle, r.faltan.length ? `Falta elegir: ${r.faltan.join(', ')}` : ''].filter(Boolean).join(' · ');
// Un renglón del carrito en markdown. El nombre y el detalle se cortan aparte
// (y sin marcas): un corte nunca deja abierto un ** que tiña el resto.
export const MAX_NOMBRE_RENGLON = 120, MAX_DETALLE_RENGLON = 300;
const renglonMd = (r) => {
  const detalle = recortar(sinMarcas(detalleRenglon(r)), MAX_DETALLE_RENGLON);
  return `**${recortar(sinMarcas(`${r.cantidad} × ${r.nombre}`), MAX_NOMBRE_RENGLON)}** · ${precioCorto(r.importeCentavos / 100)}${detalle ? `\n${detalle}` : ''}`;
};
/**
 * El TextBody con los renglones. Si no caben todos en su límite, van los que
 * caben enteros y una última línea dice cuántos faltan (están en «Editar o
 * quitar»): nunca se corta un renglón a la mitad.
 */
export function renglonesMarkdown(renglones, limite = LIMITES_TIENDA.texto.TextBody) {
  const partes = renglones.map(renglonMd), cola = (n) => `…y ${n === 1 ? '1 renglón' : `${n} renglones`} más: los ves en «Editar o quitar».`;
  let texto = '';
  for (let k = 0; k < partes.length; k++) {
    const siguiente = texto ? `${texto}\n\n${partes[k]}` : partes[k], resto = partes.length - k - 1;
    if (siguiente.length + (resto ? cola(resto).length + 2 : 0) > limite) return texto ? `${texto}\n\n${cola(partes.length - k)}` : cola(partes.length);
    texto = siguiente;
  }
  return texto;
}
/** CARRITO B: el resumen, «Editar o quitar», «Deshacer» si hay algo, y el Footer «Continuar · $X». */
export function datosCarrito(pedido, { revision, error = '', puedeDeshacer = false } = {}) {
  const hay = pedido.renglones.length > 0, L = LIMITES_TIENDA;
  return { revision: String(revision), resumen: resumenDelPedido(pedido), error: error ? bloque(error, L.texto.TextBody) : '', error_visible: !!error,
    renglones_md: hay ? renglonesMarkdown(pedido.renglones) : 'Aún no tienes platillos. Toca «Seguir pidiendo» para ver el menú.',
    importe: recortar(`Productos: ${precioCentavos(pedido.subtotalCentavos / 100)}. Envío y promociones se calculan al revisar; no es el total final.`, L.texto.TextCaption),
    // Un Dropdown sin opciones no se publica: con el carrito vacío va oculto y con una de relleno.
    filas: hay ? pedido.renglones.map((r) => ({ id: r.key, title: recortar(`${r.cantidad} × ${r.nombre}`, L.opcion.title) || 'Platillo',
      description: recortar(detalleRenglon(r), L.opcion.description), metadata: precioQueCabe(r.importeCentavos / 100, L.opcion.metadata) || '' }))
      : [{ id: 'ninguna', title: 'Sin platillos', description: '', metadata: '' }],
    hay_items: hay, puede_deshacer: !!puedeDeshacer,
    boton: recortar(hay ? `Continuar · ${precioCorto(pedido.subtotalCentavos / 100)}` : 'Continuar', L.label.Footer) };
}

