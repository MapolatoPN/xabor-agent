// Contrato del turno: una consulta no autoriza escrituras y una respuesta
// corta pertenece a la pregunta pendiente, no a todos los grupos homónimos.
import { distingueLaEleccion } from '../orders/evidenciaDeEleccion.js';
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

export function politicaDelTurno(mensaje = '') {
  const t = normalizarEleccion(mensaje);
  const consulta = /\b(?:tienen|venden|manejan|cuanto cuesta|cuanto vale|que sabores|que opciones|cuales son|que incluye|que lleva)\b/.test(t)
    || /^(?:(?:hola|buenos dias|buenas tardes|buenas noches)\s+)?(?:(?:aun|todavia)\s+)?hay\b/.test(t);
  const sinConsultaCortesia = t.replace(/\b(?:quiero|quisiera)\s+(?:saber|consultar|preguntar)\b/g, '');
  const seleccion = /\b(?:quiero|agrega|agregame|anade|anademe|dame|deme|ponme|ponle|quita|quitame|cambia|cambiame|pido|confirmo|confirmalo|cancela|cancelalo|prefiero|elijo|para recoger|pago en)\b/.test(sinConsultaCortesia);
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

export function separarOpcionesAmbiguas({ estado, mensaje, ficha, lineaId, opciones = [], actuales = [] }) {
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

export function validarAlcanceOpciones({ estado, mensaje, ficha, lineaId, opciones, actuales = [], iniciales = actuales }) {
  const cambios = (opciones || []).filter((o) => !actuales.some((a) =>
    normalizarEleccion(a.grupo) === normalizarEleccion(o.grupo)
      && normalizarEleccion(a.opcion) === normalizarEleccion(o.opcion)));
  const { ambiguas } = separarOpcionesAmbiguas({ estado, mensaje, ficha, lineaId, opciones, actuales });
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

export function respuestaDeConsulta(operaciones = []) {
  const consulta = [...operaciones].reverse().find((op) =>
    op.herramienta === 'buscar_producto' && op.resultado?.aplicado === true)?.resultado;
  if (consulta?.encontrados?.length) {
    return `Sí, contamos con ${consulta.encontrados.map((p) => p.nombre
      + (Number.isFinite(Number(p.precio)) ? ` (precio base $${Number(p.precio)})` : '')).join(', ')}. ¿Te gustaría agregar alguno a tu pedido?`;
  }
  if (consulta?.existe === false) return 'No encuentro ese producto disponible en nuestro menú. ¿Te gustaría consultar otra opción?';
  return 'Disculpa, no pude completar esa consulta. ¿Puedes decirme qué producto o información deseas consultar?';
}
