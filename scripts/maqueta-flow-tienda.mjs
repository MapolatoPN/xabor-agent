// Maqueta de la tienda (tienda_v1): el Flow SOLO con navigate y la carta real
// embebida como datos de ejemplo, para subirlo como DRAFT y verlo en el
// teléfono. No llama a Meta ni a la base: lee una carta (y, si se pide, una
// carpeta de fotos), escribe un archivo por variante de carrito y reporta bytes.
//
//   node scripts/maqueta-flow-tienda.mjs <carta.json> <salida> [opciones]
//     --carrito A|B|AB   variantes a escribir (por omisión AB; el servidor usa B)
//     --interactiva      MENU con sus listas literales y sin data: la vista
//                        previa interactiva de Meta arranca sin payload en la URL
//     --fotos <carpeta>  fotos reales con la receta del servidor (miniaturasMenu.js)
//     --indice <json>    [{id, nombre}]: en la carpeta, cada foto se llama <id>.<ext>;
//                        sin índice, el nombre del archivo es el del platillo
//     --gz               escribe además <archivo>.gz (para pasarlo al contenedor)
//
// <salida> es una carpeta (escribe maqueta-tienda-A.json y maqueta-tienda-B.json)
// o un archivo .json (escribe <nombre>-A.json y <nombre>-B.json).
//
// Qué cambia respecto de definicion-flow-tienda.mjs, porque un Flow sin
// endpoint no admite data_exchange, routing_model, data_api_version ni
// refresh_on_back:
//  - tocar un platillo navega a PERSONALIZAR con su ficha ya armada (en el
//    formulario real es data_exchange «ver»);
//  - lo que en el real va al servidor y regresa (Agregar, Guardar, Quitar,
//    Seguir pidiendo, Deshacer, Varios tacos) navega a FIN_MAQUETA, que lo explica;
//  - ENTREGA termina con complete; DIRECCION y TACOS (pantallas de hoy, ya
//    publicadas) no entran;
//  - carrito B: el selector «Editar o quitar» no puede navegar (un Dropdown solo
//    admite data_exchange y update_data), así que en la maqueta solo se elige y
//    EDITAR no entra; EDITAR se ve desde la maqueta del carrito A.
// Sin --fotos, las miniaturas son JPEG de color sólido por categoría. Con o sin
// fotos, un platillo sin foto va sin imagen (sin start.image, con_foto=false).
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, extname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { definicionFlowTienda, armarTienda, declarar, validarFlowTienda, recorrerComponentes, bytesJson, ACCIONES,
  GRUPOS_CHILAQUILES_SENCILLOS, LIMITES_TIENDA, RANURAS, VARIANTES_CARRITO } from './definicion-flow-tienda.mjs';
import { VARIANTES, TOPE_DURO, generarMiniatura } from '../src/services/miniaturasMenu.js';

const COLORES = ['#c0392b', '#d35400', '#f39c12', '#27ae60', '#16a085', '#2980b9', '#8e44ad', '#2c3e50', '#7f8c8d', '#e84393',
  '#6c5ce7', '#00b894', '#e17055', '#0984e3', '#b33939', '#218c74', '#cc8e35', '#706fd3', '#34ace0', '#ff5252'];
// Tipo de imagen de la definición → variante del servidor (sección 3 de la propuesta).
export const VARIANTE_DE = Object.freeze({ lista: 'lista96', categoria: 'cat128', ficha: 'ficha480' });
// [ancho, alto, calidad JPEG] de cada tipo, tomados de miniaturasMenu.js.
export const TAMANOS = Object.fromEntries(Object.entries(VARIANTE_DE).map(([t, v]) => [t, [VARIANTES[v].ancho, VARIANTES[v].alto, VARIANTES[v].calidad]]));

/** Miniaturas de color sólido, una por categoría. → (tipo, indiceCategoria) => base64 */
export async function imagenesSolidas(categorias) {
  const cache = new Map();
  for (let ci = 0; ci < categorias; ci++) for (const [tipo, [ancho, alto, calidad]] of Object.entries(TAMANOS)) {
    const b = await sharp({ create: { width: ancho, height: alto, channels: 3, background: COLORES[ci % COLORES.length] } })
      .jpeg({ quality: calidad, mozjpeg: true }).toBuffer();
    cache.set(`${tipo}|${ci}`, b.toString('base64'));
  }
  return (tipo, ci) => cache.get(`${tipo}|${ci}`);
}
/** Peor caso: ruido difuminado (textura máxima, como el banco de miniaturas), determinista. */
export async function imagenesRuido() {
  const cache = new Map();
  let semilla = 20261003;
  const azar = () => { semilla = (semilla * 1103515245 + 12345) >>> 0; return semilla >>> 24; };
  for (const [tipo, t] of Object.entries(TAMANOS)) {
    const crudo = Buffer.alloc(t[0] * t[1] * 3);
    for (let i = 0; i < crudo.length; i++) crudo[i] = azar();
    const b = await sharp(crudo, { raw: { width: t[0], height: t[1], channels: 3 } }).blur(1.2).jpeg({ quality: t[2], mozjpeg: true }).toBuffer();
    cache.set(tipo, b.toString('base64'));
  }
  return (tipo) => cache.get(tipo);
}

const EXTENSIONES_FOTO = new Set(['.jpg', '.jpeg', '.png', '.webp', '.img']);
const claveNombre = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/**
 * Fotos reales desde una carpeta, con la receta del servidor (generarMiniatura).
 * Sin índice, el nombre del archivo sin extensión es el del platillo; con
 * `indice` ([{id, nombre}]) la foto se llama <id>.<ext>. Falla si un platillo
 * con foto no tiene archivo, si un archivo no es de ningún platillo con foto o
 * si dos archivos son del mismo platillo: así ninguna foto se pierde en silencio.
 * → { imagen(tipo, indiceCategoria, platillo), reporte: [{nombre, lista, categoria, ficha}] }
 */
export async function fotosDeCarpeta(carpeta, carta, { indice = null } = {}) {
  const nombreDeId = new Map((indice || []).map((x) => [String(x.id), String(x.nombre)]));
  const archivoDe = new Map(), errores = [];
  for (const f of readdirSync(carpeta).filter((x) => EXTENSIONES_FOTO.has(extname(x).toLowerCase())).sort()) {
    const base = basename(f, extname(f)), nombre = indice ? nombreDeId.get(base) : base;
    if (nombre === undefined) { errores.push(`${f} no está en el índice`); continue; }
    if (archivoDe.has(claveNombre(nombre))) errores.push(`dos fotos para «${nombre}»`);
    archivoDe.set(claveNombre(nombre), join(carpeta, f));
  }
  const platillos = carta.flatMap((c) => c.platillos), conFoto = platillos.filter((p) => p.foto);
  const deFoto = new Set(conFoto.map((p) => claveNombre(p.nombre)));
  for (const p of conFoto) if (!archivoDe.has(claveNombre(p.nombre))) errores.push(`«${p.nombre}» tiene foto en la carta y no en la carpeta`);
  for (const k of archivoDe.keys()) if (!deFoto.has(k)) errores.push(`la foto de «${k}» no es de ningún platillo con foto de la carta`);
  if (errores.length) throw new Error(`Fotos de ${carpeta}: ${errores.join('; ')}`);
  const miniaturas = new Map(), reporte = [];
  for (const p of conFoto) {
    const k = claveNombre(p.nombre);
    if (miniaturas.has(k)) continue;
    const bytes = readFileSync(archivoDe.get(k)), m = {};
    for (const [tipo, variante] of Object.entries(VARIANTE_DE)) {
      const r = await generarMiniatura(bytes, variante);
      if (!r) throw new Error(`«${p.nombre}»: su ${variante} pasa de ${TOPE_DURO} caracteres aun en la calidad mínima`);
      m[tipo] = r.base64;
    }
    miniaturas.set(k, m);
    reporte.push({ nombre: p.nombre, lista: m.lista.length, categoria: m.categoria.length, ficha: m.ficha.length });
  }
  return { imagen: (tipo, _ci, platillo) => (platillo ? miniaturas.get(claveNombre(platillo.nombre))?.[tipo] ?? null : null), reporte };
}

const grupoNormal = (g) => ({ nombre: String(g.nombre ?? g.grupo), minimo: Number(g.minimo ?? g.min ?? 0), maximo: Number(g.maximo ?? g.max ?? 1),
  opciones: (g.opciones || []).map((o) => ({ nombre: String(o.nombre ?? o.n), precio: Number(o.precio ?? o.precio_extra ?? o.p ?? 0) })) });
/**
 * La carta de carta-obispado.json no trae grupos (la consulta no los leyó):
 * «Chilaquiles Sencillos» recibe los suyos reales para ver la ficha completa.
 * Como en fichaGuardable, un platillo con más de 6 grupos o más de 20 opciones
 * en un grupo queda fuera (se reporta).
 */
export function normalizarCarta(carta) {
  const excluidos = [];
  const categorias = carta.map((c) => ({ nombre: String(c.nombre), platillos: (c.platillos || []).map((p) => ({
    nombre: String(p.nombre), precio: Number(p.precio), descripcion: String(p.descripcion || ''), foto: !!p.foto,
    grupos: p.grupos?.length ? p.grupos.map(grupoNormal) : p.nombre === 'Chilaquiles Sencillos' ? GRUPOS_CHILAQUILES_SENCILLOS : [] }))
    .filter((p) => { const fuera = p.grupos.length > RANURAS || p.grupos.some((g) => g.opciones.length > 20); if (fuera) excluidos.push(p.nombre); return !fuera; }) }))
    .filter((c) => c.platillos.length);
  return Object.assign(categorias, { excluidos });
}

const PANTALLA_FIN = () => ({ id: 'FIN_MAQUETA', title: 'Fin de la maqueta', terminal: true, data: {}, layout: { type: 'SingleColumnLayout', children: [
  { type: 'TextHeading', text: 'Hasta aquí llega la maqueta' },
  { type: 'TextBody', text: '${data.explicacion}' },
  { type: 'TextCaption', text: 'Esta vista previa no guarda nada ni manda pedidos.' },
  { type: 'Footer', label: 'Cerrar', 'on-click-action': { name: 'complete', payload: { maqueta: 'fin' } } }] } });

const ENLACE_DATO = /^\$\{data\.([A-Za-z0-9_]+)\}$/;
/**
 * Vista previa interactiva de Meta: arranca la primera pantalla sin payload en
 * la URL, y el de MENU con la carta entera no cabe ahí. MENU lleva sus listas
 * como literales en el layout y ningún data; va primero. Solo para la maqueta:
 * en el formulario real el MENU llega por el INIT del endpoint.
 */
export function hacerInteractiva(flow) {
  const menu = flow.screens.find((s) => s.id === 'MENU');
  if (!menu) throw new Error('La maqueta no tiene MENU');
  const literal = (v) => {
    const m = typeof v === 'string' && v.match(ENLACE_DATO);
    if (!m) return v;
    if (!menu.data?.[m[1]] || !('__example__' in menu.data[m[1]])) throw new Error(`MENU.data.${m[1]} sin __example__`);
    return menu.data[m[1]].__example__;
  };
  for (const c of menu.layout.children) for (const k of ['list-items', 'label', 'description']) if (k in c) c[k] = literal(c[k]);
  if (JSON.stringify(menu.layout).includes('${data.')) throw new Error('MENU sigue usando datos dinámicos');
  delete menu.data;
  flow.screens.sort((a, b) => (a.id === 'MENU' ? -1 : b.id === 'MENU' ? 1 : 0));
  return flow;
}

/** El Flow de la maqueta (sin endpoint) con la carta embebida. carrito: 'A' | 'B'. */
export function construirMaqueta(carta, { carrito = 'B', imagen, interactiva = false }) {
  if (!VARIANTES_CARRITO.includes(carrito)) throw new Error(`carrito debe ser A o B: ${carrito}`);
  const def = definicionFlowTienda({ carrito, maqueta: true });
  const armado = armarTienda(carta, { modo: 'maqueta', carrito, imagen });
  const fuera = new Set(['TACOS', 'DIRECCION', ...(carrito === 'B' ? ['EDITAR'] : [])]);
  const flow = { version: def.version, screens: [] };
  for (const original of def.screens.filter((s) => !fuera.has(s.id))) {
    const s = structuredClone(original);
    delete s.refresh_on_back;
    recorrerComponentes(s.layout.children, (c) => {
      for (const k of ACCIONES) {
        const a = c[k];
        if (a?.name !== 'data_exchange') continue;
        if (k !== 'on-click-action') delete c[k]; // un Dropdown no navega: en la maqueta solo se elige
        else if (s.terminal) c[k] = { name: 'complete', payload: a.payload };
        else if (a.payload.operacion === 'continuar') c[k] = armado.ir('ENTREGA', armado.entrega);
        else c[k] = armado.fin(a.payload.operacion);
      }
    });
    flow.screens.push(s);
  }
  flow.screens.push(PANTALLA_FIN());
  for (const s of flow.screens) {
    const lista = armado.instancias.get(s.id);
    if (!lista) throw new Error(`${s.id}: ningún camino de la maqueta llega a esta pantalla`);
    const original = def.screens.find((x) => x.id === s.id);
    // Misma forma que el Flow real: las claves de cada pantalla no cambian.
    if (original && Object.keys(lista[0]).sort().join() !== Object.keys(original.data).sort().join())
      throw new Error(`${s.id}: la maqueta manda claves distintas de la definición`);
    s.data = declarar(lista);
  }
  return interactiva ? hacerInteractiva(flow) : flow;
}

/** Lo que mandaría el INIT real (Fase 2) con esta carta: {screen:'MENU', data}. */
export const initEquivalente = (carta, imagen) => ({ screen: 'MENU', data: armarTienda(carta, { modo: 'endpoint', imagen }).menu });

const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
const cable = (b) => kb(Math.ceil(b / 3) * 4); // el cifrado viaja en base64

export function leerOpciones(argv) {
  const [rutaCarta, salida, ...resto] = argv, o = { rutaCarta, salida, carritos: ['A', 'B'], interactiva: false, fotos: null, indice: null, gz: false };
  for (let i = 0; i < resto.length; i++) {
    const a = resto[i];
    if (a === '--interactiva') o.interactiva = true;
    else if (a === '--gz') o.gz = true;
    else if (a === '--carrito') { const v = resto[++i]; if (!['A', 'B', 'AB'].includes(v)) throw new Error(`--carrito A, B o AB: ${v}`); o.carritos = v === 'AB' ? ['A', 'B'] : [v]; }
    else if (a === '--fotos') { o.fotos = resto[++i]; if (!o.fotos) throw new Error('--fotos pide una carpeta'); }
    else if (a === '--indice') { o.indice = resto[++i]; if (!o.indice) throw new Error('--indice pide un archivo'); }
    else throw new Error(`Opción desconocida: ${a}`);
  }
  if (o.indice && !o.fotos) throw new Error('--indice va con --fotos');
  return o;
}

async function main() {
  let o;
  try { o = leerOpciones(process.argv.slice(2)); if (!o.rutaCarta || !o.salida) throw new Error('Faltan la carta y la salida'); } catch (e) {
    console.error(`${e.message}\nUso: node scripts/maqueta-flow-tienda.mjs <carta.json> <salida> [--carrito A|B|AB] [--interactiva] [--fotos <carpeta> [--indice <json>]] [--gz]`);
    process.exit(2);
  }
  const carta = normalizarCarta(JSON.parse(readFileSync(o.rutaCarta, 'utf8')));
  let imagen, reporteFotos = null;
  if (o.fotos) {
    const r = await fotosDeCarpeta(o.fotos, carta, { indice: o.indice ? JSON.parse(readFileSync(o.indice, 'utf8')) : null });
    imagen = r.imagen; reporteFotos = r.reporte;
  } else imagen = await imagenesSolidas(carta.length);
  const ruido = await imagenesRuido();
  let carpeta = false;
  try { carpeta = statSync(o.salida).isDirectory(); } catch { /* no existe: se toma como nombre de archivo */ }
  const destino = (v) => (carpeta || !o.salida.endsWith('.json') ? join(o.salida, `maqueta-tienda-${v}.json`) : o.salida.replace(/\.json$/, `-${v}.json`));
  const platillos = carta.flatMap((c) => c.platillos);
  console.log(`carta: ${carta.length} categorías, ${platillos.length} platillos, ${platillos.filter((p) => p.foto).length} con foto, `
    + `${platillos.filter((p) => p.grupos.length).length} con grupos${carta.excluidos.length ? `, ${carta.excluidos.length} fuera (más de 6 grupos o 20 opciones): ${carta.excluidos.join(', ')}` : ''}`);
  const largos = platillos.filter((p) => p.nombre.length > LIMITES_TIENDA.elementoLista.title).map((p) => p.nombre);
  if (largos.length) console.log(`nombres cortados a ${LIMITES_TIENDA.elementoLista.title} con «…»: ${largos.join(' | ')}`);
  if (reporteFotos) console.log(`fotos reales (${reporteFotos.length}), base64 lista/categoría/ficha: `
    + reporteFotos.map((r) => `${r.nombre} ${r.lista}/${r.categoria}/${r.ficha}`).join(' · '));
  let fallas = 0;
  for (const v of o.carritos) {
    const flow = construirMaqueta(carta, { carrito: v, imagen, interactiva: o.interactiva });
    const errores = validarFlowTienda(flow, { endpoint: false }), bytes = bytesJson(flow);
    if (errores.length || bytes > LIMITES_TIENDA.maquetaJson) {
      fallas++;
      console.error(`maqueta ${v}: NO se escribe (${bytes} bytes; ${errores.length} violaciones)`);
      for (const e of errores.slice(0, 30)) console.error(`  ${e}`);
      continue;
    }
    const json = JSON.stringify(flow);
    writeFileSync(destino(v), json);
    if (o.gz) writeFileSync(`${destino(v)}.gz`, gzipSync(json));
    console.log(`maqueta ${v}${o.interactiva ? ' (interactiva)' : ''}: ${destino(v)} · ${bytes.toLocaleString('es-MX')} bytes de JSON (${kb(bytes)}; `
      + `tope de maqueta ${kb(LIMITES_TIENDA.maquetaJson)}) · ${flow.screens.length} pantallas: ${flow.screens.map((s) => s.id).join(', ')}`);
  }
  const init = bytesJson(initEquivalente(carta, imagen)), peor = bytesJson(initEquivalente(carta, ruido));
  console.log(`INIT equivalente (MENU con toda la carta, como lo mandaría el servidor): ${init.toLocaleString('es-MX')} bytes de JSON `
    + `(${kb(init)}; ~${cable(init)} en el cable)`);
  console.log(`  cota con miniaturas de ruido en todo platillo con foto: ${peor.toLocaleString('es-MX')} bytes (${kb(peor)}; ~${cable(peor)} en el cable)`);
  process.exitCode = fallas ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
