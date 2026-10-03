// Maqueta de la tienda (Fase 0 de tienda_v1): el Flow SOLO con navigate y la
// carta real embebida como datos de ejemplo, para subirlo como DRAFT y verlo en
// el teléfono. No llama a Meta ni a la base: lee una carta, escribe dos
// archivos (carrito A y carrito B) y reporta bytes.
//
//   node scripts/maqueta-flow-tienda.mjs <carta.json> <salida>
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
//    EDITAR no entra; EDITAR se ve desde el carrito A.
// Miniaturas: JPEG de color sólido por categoría (sin texto) en 96 px (lista),
// 128 px (categoría) y 480×320 (ficha). Los platillos sin foto van sin
// start.image. El color sólido pesa mucho menos que una foto: el reporte da
// además la cota con miniaturas de ruido (peor caso) para el INIT.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { definicionFlowTienda, armarTienda, declarar, validarFlowTienda, recorrerComponentes, bytesJson, ACCIONES,
  GRUPOS_CHILAQUILES_SENCILLOS, LIMITES_TIENDA, RANURAS } from './definicion-flow-tienda.mjs';

const COLORES = ['#c0392b', '#d35400', '#f39c12', '#27ae60', '#16a085', '#2980b9', '#8e44ad', '#2c3e50', '#7f8c8d', '#e84393',
  '#6c5ce7', '#00b894', '#e17055', '#0984e3', '#b33939', '#218c74', '#cc8e35', '#706fd3', '#34ace0', '#ff5252'];
// [ancho, alto, calidad JPEG] de cada variante (sección 3 de la propuesta).
export const TAMANOS = { lista: [96, 96, 65], categoria: [128, 128, 70], ficha: [480, 320, 70] };

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

/** El Flow de la maqueta (sin endpoint) con la carta embebida. carrito: 'A' | 'B'. */
export function construirMaqueta(carta, { carrito = 'A', imagen }) {
  if (!['A', 'B'].includes(carrito)) throw new Error(`carrito debe ser A o B: ${carrito}`);
  const def = definicionFlowTienda({ carrito });
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
  return flow;
}

/** Lo que mandaría el INIT real (Fase 2) con esta carta: {screen:'MENU', data}. */
export const initEquivalente = (carta, imagen) => ({ screen: 'MENU', data: armarTienda(carta, { modo: 'endpoint', carrito: 'A', imagen }).menu });

const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
const cable = (b) => kb(Math.ceil(b / 3) * 4); // el cifrado viaja en base64

async function main() {
  const [rutaCarta, salida] = process.argv.slice(2);
  if (!rutaCarta || !salida) { console.error('Uso: node scripts/maqueta-flow-tienda.mjs <carta.json> <salida (carpeta o archivo .json)>'); process.exit(2); }
  const carta = normalizarCarta(JSON.parse(readFileSync(rutaCarta, 'utf8')));
  const solidas = await imagenesSolidas(carta.length), ruido = await imagenesRuido();
  let carpeta = false;
  try { carpeta = statSync(salida).isDirectory(); } catch { /* no existe: se toma como nombre de archivo */ }
  const destino = (v) => (carpeta || !salida.endsWith('.json') ? join(salida, `maqueta-tienda-${v}.json`) : salida.replace(/\.json$/, `-${v}.json`));
  const platillos = carta.flatMap((c) => c.platillos);
  console.log(`carta: ${carta.length} categorías, ${platillos.length} platillos, ${platillos.filter((p) => p.foto).length} con foto, `
    + `${platillos.filter((p) => p.grupos.length).length} con grupos${carta.excluidos.length ? `, ${carta.excluidos.length} fuera (más de 6 grupos o 20 opciones): ${carta.excluidos.join(', ')}` : ''}`);
  const largos = platillos.filter((p) => p.nombre.length > LIMITES_TIENDA.elementoLista.title).map((p) => p.nombre);
  if (largos.length) console.log(`nombres cortados a ${LIMITES_TIENDA.elementoLista.title} con «…»: ${largos.join(' | ')}`);
  let fallas = 0;
  for (const v of ['A', 'B']) {
    const flow = construirMaqueta(carta, { carrito: v, imagen: solidas });
    const errores = validarFlowTienda(flow, { endpoint: false }), bytes = bytesJson(flow);
    if (errores.length || bytes > LIMITES_TIENDA.presupuestoJson) {
      fallas++;
      console.error(`maqueta ${v}: NO se escribe (${bytes} bytes; ${errores.length} violaciones)`);
      for (const e of errores.slice(0, 30)) console.error(`  ${e}`);
      continue;
    }
    writeFileSync(destino(v), JSON.stringify(flow));
    console.log(`maqueta ${v}: ${destino(v)} · ${bytes.toLocaleString('es-MX')} bytes de JSON (${kb(bytes)}; presupuesto ${kb(LIMITES_TIENDA.presupuestoJson)}) · `
      + `${flow.screens.length} pantallas: ${flow.screens.map((s) => s.id).join(', ')}`);
  }
  const init = bytesJson(initEquivalente(carta, solidas)), peor = bytesJson(initEquivalente(carta, ruido));
  console.log(`INIT equivalente (MENU con toda la carta, como lo mandaría el servidor): ${init.toLocaleString('es-MX')} bytes de JSON `
    + `(${kb(init)}; ~${cable(init)} en el cable)`);
  console.log(`  cota con miniaturas de ruido (peor caso de foto real): ${peor.toLocaleString('es-MX')} bytes (${kb(peor)}; ~${cable(peor)} en el cable)`);
  const muestra = Object.fromEntries(Object.keys(TAMANOS).map((t) => [t, [solidas(t, 0).length, ruido(t).length]]));
  console.log(`  base64 por miniatura, sólida / ruido: ${Object.entries(muestra).map(([t, [s, r]]) => `${t} ${s} / ${r} B`).join(' · ')}`);
  process.exitCode = fallas ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
