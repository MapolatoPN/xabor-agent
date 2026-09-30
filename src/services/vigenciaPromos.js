// ─── Vigencia de promociones en la zona del negocio ─────────────────────────
//
// Módulo PURO (sin `pool`), mismo criterio que `zonaHoraria.js`.
//
// ── Por qué existe ────────────────────────────────────────────────────────
//
// El panel captura la vigencia con `<input type="date">` y manda solo el día:
// "2026-09-30". Guardado tal cual en una columna `timestamptz`, Postgres lo
// lee como la medianoche UTC de ese día, que en Matamoros (UTC-5 en verano)
// son las 19:00 DEL DÍA ANTERIOR. El 30-sep-2026 el «Miércoles de
// Chilaquiles» de Obispado, capturado «hasta el 30», dejó de aplicar el 29 a
// las 7 de la noche y el POS tomó pedidos sin la promoción.
//
// La regla que el operador entiende al elegir un día es de calendario LOCAL:
//   · «desde el D» → desde las 00:00 del día D en la zona del negocio;
//   · «hasta el D» → hasta el último instante del día D (23:59:59.999).
// Aquí se traduce esa regla a instantes, y de vuelta al día para el panel.

import { desdeHoraLocal, instanteDesdeEntrada, esZonaValida, TZ_DEFAULT } from './zonaHoraria.js';

const SOLO_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

export class VigenciaError extends Error {
  constructor(mensaje) { super(mensaje); this.codigo = 'VIGENCIA_INVALIDA'; }
}

function zonaSegura(zona) {
  return esZonaValida(zona) ? zona : TZ_DEFAULT;
}

// 'YYYY-MM-DD' del día siguiente, sin pasar por la zona del proceso.
function diaSiguiente(Y, M, D) {
  const d = new Date(Date.UTC(Y, M - 1, D + 1));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * Convierte lo que manda el panel en el instante que se guarda.
 *
 * @param {string|null} valor  'YYYY-MM-DD' (lo normal), una hora local sin
 *                             zona o un ISO con zona (se respeta tal cual).
 * @param {string} zona        zona IANA del negocio.
 * @param {'desde'|'hasta'} extremo
 * @returns {string|null} ISO UTC, o null si no hay vigencia en ese extremo.
 */
export function instanteDeVigencia(valor, zona, extremo) {
  if (valor == null) return null;
  const crudo = String(valor).trim();
  if (!crudo) return null;
  const tz = zonaSegura(zona);

  const m = SOLO_FECHA.exec(crudo);
  if (m) {
    const [, Y, M, D] = m.map(Number);
    const inicio = desdeHoraLocal(`${m[1]}-${m[2]}-${m[3]}T00:00`, tz);
    if (!inicio) throw new VigenciaError(`Fecha inválida: ${crudo}`);
    if (extremo === 'desde') return inicio.toISOString();
    // Fin del día = inicio del día siguiente menos un milisegundo. Se calcula
    // con el día siguiente real (y no sumando 24 h) porque el día del cambio
    // de horario dura 23 o 25 horas.
    const siguiente = desdeHoraLocal(`${diaSiguiente(Y, M, D)}T00:00`, tz);
    return new Date(siguiente.getTime() - 1).toISOString();
  }

  const instante = instanteDesdeEntrada(crudo, tz);
  if (!instante) throw new VigenciaError(`Fecha inválida: ${crudo}`);
  return instante.toISOString();
}

/**
 * El día de calendario ('YYYY-MM-DD') que el panel debe mostrar para un
 * extremo guardado. Es el inverso de `instanteDeVigencia` para las fechas
 * capturadas por día: el fin de día local vuelve a ser ese mismo día.
 */
export function fechaDeVigencia(instante, zona) {
  if (instante == null || instante === '') return null;
  const d = instante instanceof Date ? instante : new Date(instante);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: zonaSegura(zona) }).format(d);
}

/**
 * Normaliza el par desde/hasta y valida que no esté al revés.
 * @returns {{ desde: string|null, hasta: string|null }}
 */
export function normalizarVigencia(desde, hasta, zona) {
  const d = instanteDeVigencia(desde, zona, 'desde');
  const h = instanteDeVigencia(hasta, zona, 'hasta');
  if (d && h && new Date(d) > new Date(h)) {
    throw new VigenciaError('La fecha de inicio es posterior a la fecha de fin');
  }
  return { desde: d, hasta: h };
}
