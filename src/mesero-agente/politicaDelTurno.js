// Contrato del turno: una consulta no autoriza escrituras y una respuesta
// corta pertenece a la pregunta pendiente, no a todos los grupos homónimos.
import { distingueLaEleccion } from '../orders/evidenciaDeEleccion.js';
import { textoParaPlatillo } from './alcanceDePlatillos.js';
export const normalizarEleccion = (s) => String(s || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// «Sin azúcar» puede ser una elección del catálogo, no una petición de
// borrar esa elección. Conservamos la polaridad que el cotejo léxico omite.
export function opcionNegativaExplicita(opcion, mensaje) {
  const o = normalizarEleccion(opcion);
  const t = normalizarEleccion(mensaje);
  if (!o.startsWith('sin ')) return false;
  const indice = ` ${t} `.indexOf(` ${o} `);
  if (indice < 0) return false;
  return !/\b(?:quita|quitame|elimina|borra|no quiero|ya no)(?:\s+(?:la|opcion))*$/.test(t.slice(0, indice).trim());
}

// Señal de enrutamiento, NO autorización para ejecutar un cambio. Una pregunta
// mezclada con una decisión debe llegar al intérprete y a las validaciones de
// Xabor; el canal híbrido y el ejecutor no deben mantener listas divergentes.
export function contieneDecisionDePedido(mensaje = '') {
  const t = normalizarEleccion(mensaje);
  const sinConsultaCortesia = t.replace(/\b(?:quiero|quisiera)\s+(?:saber|consultar|preguntar)\b/g, '');
  return /\b(?:quiero|agrega|agregame|anade|anademe|dame|deme|ponme|ponle|quita|quitame|elimina|eliminame|borra|borrame|cambia|cambiame|pido|confirmo|confirmalo|cancela|cancelalo|prefiero|elijo|para recoger|pago en)\b/.test(sinConsultaCortesia);
}

// «¿Qué trae / contiene / incluye X?» pregunta por el contenido, no lo pide.
// El 2-oct «El desayuno sorpresa q contiene?» se convirtió en «¿Agregamos
// Desayuno Sorpresa a tu pedido?» y la descripción del platillo nunca salió.
const PREGUNTA_DE_CONTENIDO = /\b(?:(?:que|q|k) (?:trae|traen|contiene|contienen|incluye|incluyen|lleva|llevan|tiene|tienen|viene|vienen)|contiene|contienen|con (?:que|q) (?:viene|vienen)|de (?:que|q) (?:es|son|esta hecho|estan hechos)|como (?:es|son) (?:el|la|los|las)|ingredientes)\b/;
export const preguntaDeContenido = (mensaje = '') => !contieneDecisionDePedido(mensaje)
  && PREGUNTA_DE_CONTENIDO.test(normalizarEleccion(mensaje));

export function politicaDelTurno(mensaje = '') {
  const t = normalizarEleccion(mensaje);
  const consulta = /\b(?:tienen|venden|manejan|cuanto cuesta|cuanto vale|que sabores|que opciones|cuales son|que incluye|que lleva)\b/.test(t)
    || PREGUNTA_DE_CONTENIDO.test(t)
    || /^(?:(?:hola|buenos dias|buenas tardes|buenas noches)\s+)?(?:(?:aun|todavia)\s+)?hay\b/.test(t);
  const seleccion = contieneDecisionDePedido(mensaje);
  return { tipo: consulta && !seleccion ? 'consulta' : 'pedido', soloLectura: consulta && !seleccion };
}

export function respuestaCortaEnFoco({ estado, mensaje, grupos = [] }) {
  if (estado?.foco?.tipo !== 'opcion') return false;
  const t = normalizarEleccion(mensaje).replace(/\s+por favor$/, '');
  const grupo = grupos.find((g) => normalizarEleccion(g.nombre) === normalizarEleccion(estado.foco.grupo));
  return (grupo?.opciones || []).some((o) => normalizarEleccion(o.nombre ?? o) === t);
}

export function gruposConEvidenciaCompartida(aclaraciones, mensaje) {
  const t = ` ${normalizarEleccion(mensaje)} `;
  const destinos = new Map();
  for (const a of aclaraciones) for (const c of a.candidatos || []) {
    const opcion = normalizarEleccion(c);
    if (!opcion || !t.includes(` ${opcion} `)) continue;
    const clave = opcion;
    const grupos = destinos.get(clave) || new Set();
    grupos.add(`${a.lid}|${a.grupo}`); destinos.set(clave, grupos);
  }
  const conflicto = new Set();
  for (const grupos of destinos.values()) if (grupos.size > 1) {
    for (const grupo of grupos) conflicto.add(grupo);
  }
  return conflicto;
}

export function separarOpcionesAmbiguas({ estado, mensaje, ficha, lineaId, opciones = [], actuales = [], catalogo = [] }) {
  mensaje = textoParaPlatillo({estado,mensaje,ficha,lineaId,catalogo}).texto;
  const seguras = [], ambiguas = [];
  for (const cambio of opciones) {
    const grupo = ficha?.grupos?.find((g) => normalizarEleccion(g.nombre) === normalizarEleccion(cambio.grupo));
    const pendiente = (estado?.opcionesPendientes || []).find((p) => p.lid === lineaId
      && normalizarEleccion(p.grupo) === normalizarEleccion(cambio.grupo)
      && p.candidatos.some((c) => normalizarEleccion(c) === normalizarEleccion(cambio.opcion)));
    const yaGuardada = actuales.some((a) => normalizarEleccion(a.grupo) === normalizarEleccion(cambio.grupo)
      && normalizarEleccion(a.opcion) === normalizarEleccion(cambio.opcion));
    const eleccion = distingueLaEleccion(cambio.opcion, pendiente?.candidatos || (grupo?.opciones || []).map((o) => o.nombre), mensaje);
    (eleccion.empatan.length && !yaGuardada && !opcionNegativaExplicita(cambio.opcion, mensaje) ? ambiguas : seguras).push(cambio);
  }
  return { seguras, ambiguas };
}

export function validarAlcanceOpciones({ estado, mensaje, ficha, lineaId, opciones, actuales = [], iniciales = actuales, catalogo = [] }) {
  const cambios = (opciones || []).filter((o) => !actuales.some((a) =>
    normalizarEleccion(a.grupo) === normalizarEleccion(o.grupo)
      && normalizarEleccion(a.opcion) === normalizarEleccion(o.opcion)));
  const alcance = textoParaPlatillo({estado,mensaje,ficha,lineaId,catalogo});
  if (alcance.acotado && cambios.some(o => !distingueLaEleccion(o.opcion,
    ficha?.grupos?.find(g=>normalizarEleccion(g.nombre)===normalizarEleccion(o.grupo))?.opciones.map(x=>x.nombre) || [],
    alcance.texto).distingue)) return 'La elección no está indicada para ese platillo. Conserva las preferencias de los otros renglones y aclara a cuál corresponde.';
  const { ambiguas } = separarOpcionesAmbiguas({ estado, mensaje, ficha, lineaId, opciones, actuales, catalogo });
  if (ambiguas.length) return `Hay elecciones ambiguas en ${[...new Set(ambiguas.map(o => o.grupo))].join(', ')}. Conserva las opciones inequívocas y pregunta cuál desea.`;
  if (respuestaCortaEnFoco({ estado, mensaje, grupos: ficha?.grupos })) {
    if (cambios.some((o) => lineaId !== estado.foco.linea_id
      || normalizarEleccion(o.grupo) !== normalizarEleccion(estado.foco.grupo))) {
      return 'La respuesta corresponde únicamente a la línea y al grupo de la última pregunta. Conserva las demás elecciones.';
    }
  }
  const usos = new Map();
  const previasDelTurno = actuales.filter((a) => !iniciales.some((i) =>
    normalizarEleccion(i.grupo) === normalizarEleccion(a.grupo)
      && normalizarEleccion(i.opcion) === normalizarEleccion(a.opcion))
    && !cambios.some((c) => normalizarEleccion(c.grupo) === normalizarEleccion(a.grupo)));
  for (const o of [...previasDelTurno, ...cambios]) {
    const k = normalizarEleccion(o.opcion);
    const grupos = usos.get(k) || new Set(); grupos.add(o.grupo); usos.set(k, grupos);
  }
  const t = ` ${normalizarEleccion(mensaje)} `;
  for (const [opcion, grupos] of usos) {
    if (grupos.size < 2) continue;
    const menciones = t.split(` ${opcion} `).length - 1;
    if (menciones < grupos.size) return 'Una misma mención no elige esa opción en varios grupos. Pregunta en cuál la quiere el cliente.';
  }
  return null;
}

export function esContinuacionDeLinea({ estado, mensaje, ficha }) {
  if (estado?.foco?.tipo !== 'opcion') return false;
  const item = estado.carrito?.items?.find((i) => i.lid === estado.foco.linea_id);
  if (!item || normalizarEleccion(item.nombre) !== normalizarEleccion(ficha?.nombre)) return false;
  const t = normalizarEleccion(mensaje);
  return !/\b(?:otro|otra|adicional|agrega|agregame|anade|anademe|uno mas|una mas)\b/.test(t);
}

const precioBase = (p) => (Number.isFinite(Number(p?.precio)) ? ` Precio base: $${Number(p.precio)}.` : '');

export function respuestaDeConsulta(operaciones = [], mensaje = '') {
  const consulta = [...operaciones].reverse().find((op) =>
    op.herramienta === 'buscar_producto' && op.resultado?.aplicado === true)?.resultado;
  // Una pregunta de contenido se contesta con la descripción de la carta, tal
  // cual, y sin ofrecer agregarlo: el cliente todavía no lo pidió.
  if (preguntaDeContenido(mensaje) && consulta?.encontrados?.length === 1) {
    const p = consulta.encontrados[0];
    const descripcion = String(p.descripcion || '').trim();
    return descripcion
      ? `${p.nombre}: ${descripcion}${/[.!?]$/.test(descripcion) ? '' : '.'}${precioBase(p)}`
      : `No tengo una descripción de ${p.nombre} en la carta.${precioBase(p)} Si quieres, te comunico con alguien del equipo para darte el detalle.`;
  }
  if (consulta?.encontrados?.length) {
    return `Sí, contamos con ${consulta.encontrados.map((p) => p.nombre
      + (Number.isFinite(Number(p.precio)) ? ` (precio base $${Number(p.precio)})` : '')).join(', ')}. ¿Te gustaría agregar alguno a tu pedido?`;
  }
  if (consulta?.existe === false) {
    // Sin callejón sin salida: lo que sí hay, con nombres publicados de la carta.
    const opciones = (consulta.categorias || []).filter((c) => c?.nombre && c.ejemplos?.length).slice(0, 4)
      .map((c) => `${c.nombre} (${c.ejemplos.join(', ')})`);
    return opciones.length
      ? `No encuentro ese producto en nuestra carta. Lo que sí tenemos: ${opciones.join('; ')}. ¿Te interesa alguno?`
      : 'No encuentro ese producto disponible en nuestro menú. ¿Te gustaría consultar otra opción?';
  }
  return 'Disculpa, no pude completar esa consulta. ¿Puedes decirme qué producto o información deseas consultar?';
}
