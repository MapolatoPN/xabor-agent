// Asistente del restaurante, Fase 1: de todos los hallazgos del día, cuáles
// se muestran. Función PURA (sin base ni reloj).
//
// Reglas del pedido (5.4):
//   · máximo 3 al día, ordenados por pesos en juego;
//   · no se repite el mismo aviso en 7 días, salvo que haya empeorado
//     (20 % más de pesos en juego que la última vez que se mostró);
//   · los informativos (sin pesos claros) solo ocupan un lugar que sobre, y
//     no se repiten en 28 días;
//   · «No avisar de esto» calla esa firma para siempre (hasta que se reactive);
//   · cada 2 «No útil» de un tipo suben a la mitad más su mínimo de pesos
//     (hasta 3 veces); un informativo con 2 «No útil» ya no sale.
// Todos los candidatos se guardan con su motivo: así se puede auditar por
// qué salió uno y no otro.
import { TIPOS_HALLAZGO, TIPOS_INFORMATIVOS, faltasDeHallazgo } from './reglas.js';

export const MAXIMO_AL_DIA = 3;
export const DIAS_SIN_REPETIR = 7;
export const DIAS_SIN_REPETIR_INFORMATIVO = 28;
export const EMPEORA_FACTOR = 1.2;
// Pesos mínimos en juego para mostrar un aviso con impacto (antes del ajuste
// por «No útil»). Las reglas ya exigen sus propios mínimos; este es el piso.
export const MINIMO_IMPACTO = 500;
// Calidad de las ventas: una sola venta sin forma de pago o fuera de horario
// ya vale la pena revisarla. Sin piso propio (igual se ordenan por pesos).
export const MINIMOS_POR_TIPO = Object.freeze({ ventas_sin_forma_pago: 0.01, ventas_fuera_horario: 0.01, ventas_incompletas: 0.01 });

const DIA_MS = 24 * 60 * 60 * 1000;
const diasEntre = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DIA_MS);
const orden = (t) => { const i = TIPOS_HALLAZGO.indexOf(t); return i < 0 ? 999 : i; };

/** Cuánto sube el mínimo de un tipo con sus «No útil»: 1, 1.5, 2, 2.5, 3 (tope). */
export function factorPorNoUtil(noUtil) {
  return Math.min(3, 1 + 0.5 * Math.floor((Number(noUtil) || 0) / 2));
}

/**
 * candidatos: hallazgos de reglas.buscarHallazgos.
 * memoria: {
 *   hoy: 'AAAA-MM-DD',
 *   mostrados: [{ firma, impacto, fecha }]   — los elegidos de corridas anteriores,
 *   noUtilPorTipo: { tipo: n },              — «No útil» del negocio,
 *   silenciados: [firma],                    — «No avisar de esto»,
 *   tiposApagados: [tipo],                   — configuración (Fase 2),
 *   minimos: { tipo: pesos },                — configuración (Fase 2),
 *   maximo: 3,
 * }
 * Devuelve { elegidos: [h], todos: [{ ...h, elegido, motivo }] }.
 */
export function priorizar(candidatos = [], memoria = {}) {
  const hoy = memoria.hoy;
  const maximo = Number.isInteger(memoria.maximo) && memoria.maximo > 0 ? Math.min(memoria.maximo, MAXIMO_AL_DIA) : MAXIMO_AL_DIA;
  const silenciados = new Set(memoria.silenciados || []);
  const apagados = new Set(memoria.tiposApagados || []);
  const noUtil = memoria.noUtilPorTipo || {};
  const minimos = { ...MINIMOS_POR_TIPO, ...(memoria.minimos || {}) };
  // La última vez que se mostró cada firma.
  const ultima = new Map();
  for (const m of memoria.mostrados || []) {
    const u = ultima.get(m.firma);
    if (!u || m.fecha > u.fecha) ultima.set(m.firma, m);
  }
  const todos = [];
  const vivos = [];
  for (const h of candidatos) {
    const informativo = TIPOS_INFORMATIVOS.includes(h.tipo);
    let motivo = null;
    const faltas = faltasDeHallazgo(h);
    if (faltas.length) motivo = `forma: ${faltas[0]}`;
    else if (apagados.has(h.tipo)) motivo = 'tipo apagado';
    else if (silenciados.has(h.firma)) motivo = 'no avisar de esto';
    else if (informativo && (noUtil[h.tipo] || 0) >= 2) motivo = 'no útil (informativo)';
    else if (!informativo) {
      const piso = (Number(minimos[h.tipo]) > 0 ? Number(minimos[h.tipo]) : MINIMO_IMPACTO) * factorPorNoUtil(noUtil[h.tipo]);
      if (h.impacto < piso) motivo = `menos de $${Math.round(piso)} en juego`;
    }
    if (!motivo) {
      const u = ultima.get(h.firma);
      if (u && hoy) {
        const dias = diasEntre(u.fecha, hoy);
        if (informativo && dias < DIAS_SIN_REPETIR_INFORMATIVO) motivo = `ya se mostró hace ${dias} días`;
        else if (!informativo && dias < DIAS_SIN_REPETIR && !(h.impacto >= EMPEORA_FACTOR * (Number(u.impacto) || 0))) motivo = `ya se mostró hace ${dias} días y no empeoró`;
      }
    }
    const fila = { ...h, elegido: false, motivo };
    todos.push(fila);
    if (!motivo) vivos.push(fila);
  }
  // Primero los que tienen pesos en juego, de mayor a menor; los informativos al final.
  vivos.sort((a, b) => {
    const ia = TIPOS_INFORMATIVOS.includes(a.tipo) ? 1 : 0, ib = TIPOS_INFORMATIVOS.includes(b.tipo) ? 1 : 0;
    return ia - ib || b.impacto - a.impacto || orden(a.tipo) - orden(b.tipo) || String(a.firma).localeCompare(String(b.firma));
  });
  vivos.forEach((f, i) => {
    if (i < maximo) { f.elegido = true; f.motivo = 'elegido'; } else f.motivo = 'no cupo (máximo 3 al día)';
  });
  return { elegidos: vivos.filter((f) => f.elegido), todos };
}
