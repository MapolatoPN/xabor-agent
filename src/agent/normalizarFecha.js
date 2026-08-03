/**
 * normalizarFecha.js — Validación determinista de la fecha de evento que un
 * cliente escribe en lenguaje natural durante la conversación con el
 * Asistente Comercial. NUNCA se confía en el modelo para decidir el
 * formato final: esta función es la única autorizada a producir el valor
 * que se persiste en una columna DATE (siempre `YYYY-MM-DD`, o ningún
 * valor si no hay confianza suficiente).
 *
 * Sin dependencias de server.js/database.js a propósito (mismo criterio
 * que comercialMarkers.js/intentDetector.js) -- se puede probar de forma
 * aislada, solo con Date.
 *
 * Zona horaria: America/Matamoros -- la misma que usa el resto del
 * proyecto para "qué día es hoy" (ver src/server.js, src/agent/prompts.js,
 * CLAUDE.md). Hoy no existe una zona horaria configurable por negocio en
 * ninguna otra parte del código -- este módulo sigue esa misma convención
 * en vez de inventar una nueva.
 *
 * Reglas documentadas (y cubiertas por test/fase-normalizar-fecha.mjs):
 *  - "20 de septiembre" (sin año): se asume el año actual si esa fecha
 *    todavía no ha pasado; si ya pasó, se asume el año siguiente. Nunca
 *    se asume silenciosamente un año más lejano que ese.
 *  - "este <día>"/"esta <día>": la próxima ocurrencia de ese día de la
 *    semana, INCLUYENDO hoy si hoy es ese día.
 *  - "el próximo <día>"/"la próxima <día>": la próxima ocurrencia
 *    EXCLUYENDO hoy (1 a 7 días adelante) -- interpretación deliberada
 *    para evitar la ambigüedad regional de "saltar una semana completa".
 *  - "mañana"/"pasado mañana"/"hoy": desplazamiento relativo a hoy.
 *  - Fechas explícitas (ISO `YYYY-MM-DD` o `DD/MM/YYYY`) nunca "ruedan" de
 *    año -- si ya pasaron, se rechazan como 'pasada'.
 *  - Cualquier fecha calendáricamente imposible (31 de febrero, mes>12,
 *    etc.) se rechaza como 'imposible', nunca se "corrige" en silencio.
 *  - Texto reconocible pero sin día concreto ("en septiembre", "la
 *    próxima semana", "pronto") se rechaza como 'ambigua' -- nunca se
 *    adivina un día arbitrario.
 *  - Cualquier otro texto no reconocido se rechaza como 'no_reconocida'.
 */

const TIMEZONE = 'America/Matamoros';

const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};

const DIAS_SEMANA = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
};

function quitarAcentos(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** 'YYYY-MM-DD' del día calendario actual en America/Matamoros. */
function hoyISO(ahora) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(ahora);
}

/** Date a medianoche UTC representando el día calendario de `ahora` en Matamoros -- solo para aritmética de días, nunca para horas. */
function anchorUTC(ahora) {
  return new Date(`${hoyISO(ahora)}T00:00:00Z`);
}

function diasEnMes(year, month) {
  // Date.UTC(year, month, 0) = último día del mes anterior a `month` (1-indexado) -> día 0 de `month+1` en índice 0 = último día de `month`.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function calendarioValido(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  return day <= diasEnMes(year, month);
}

function iso(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Normaliza el texto de una fecha de evento a `{ ok: true, iso, textoOriginal }`
 * o `{ ok: false, motivo, textoOriginal }` con motivo en
 * 'imposible' | 'pasada' | 'ambigua' | 'no_reconocida'.
 */
export function normalizarFechaEvento(textoOriginal, { ahora = new Date() } = {}) {
  if (typeof textoOriginal !== 'string' || !textoOriginal.trim()) {
    return { ok: false, motivo: 'no_reconocida', textoOriginal };
  }
  const texto = quitarAcentos(textoOriginal.trim().toLowerCase()).replace(/\s+/g, ' ');
  const anchor = anchorUTC(ahora);
  const hoyIsoStr = hoyISO(ahora);

  const resolver = (year, month, day) => {
    if (!calendarioValido(year, month, day)) return { ok: false, motivo: 'imposible', textoOriginal };
    const valor = iso(year, month, day);
    if (valor < hoyIsoStr) return { ok: false, motivo: 'pasada', textoOriginal };
    return { ok: true, iso: valor, textoOriginal };
  };

  const desdeAncla = (dias) => {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() + dias);
    return resolver(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  };

  // 1. ISO explícito
  let m = texto.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return resolver(+m[1], +m[2], +m[3]);

  // 2. DD/MM/YYYY (convención en español -- día primero)
  m = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return resolver(+m[3], +m[2], +m[1]);

  // 3. Relativos a hoy
  if (/^pasado\s+manana$/.test(texto)) return desdeAncla(2);
  if (/^manana$/.test(texto)) return desdeAncla(1);
  if (/^hoy$/.test(texto)) return desdeAncla(0);

  // 4. "este/esta <día>" | "el próximo/la próxima <día>"
  m = texto.match(/^(?:el\s+|la\s+)?(este|esta|proximo|proxima)\s+([a-z]+)$/);
  if (m) {
    const modo = m[1];
    const diaNombre = m[2];
    if (diaNombre in DIAS_SEMANA) {
      const objetivo = DIAS_SEMANA[diaNombre];
      const hoyDow = anchor.getUTCDay();
      let delta = (objetivo - hoyDow + 7) % 7;
      if (modo === 'proximo' || modo === 'proxima') {
        if (delta === 0) delta = 7; // "próximo" excluye hoy, siempre 1-7 días adelante
      }
      return desdeAncla(delta);
    }
  }

  // 5. "<día> de <mes>" [ "de <año>" ]
  m = texto.match(/^(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?$/);
  if (m) {
    const dia = +m[1];
    const mesNombre = m[2];
    if (!(mesNombre in MESES)) return { ok: false, motivo: 'no_reconocida', textoOriginal };
    const mes = MESES[mesNombre];
    if (m[3]) return resolver(+m[3], mes, dia);

    // Sin año explícito: se asume el año actual; si esa fecha ya pasó
    // este año, se rueda al siguiente (regla documentada arriba) -- nunca
    // más de un año hacia adelante.
    if (!calendarioValido(anchor.getUTCFullYear(), mes, dia)) return { ok: false, motivo: 'imposible', textoOriginal };
    const candidato = iso(anchor.getUTCFullYear(), mes, dia);
    if (candidato >= hoyIsoStr) return { ok: true, iso: candidato, textoOriginal };
    return resolver(anchor.getUTCFullYear() + 1, mes, dia);
  }

  // 6. Reconocible pero ambiguo -- nunca se adivina un día
  if (/^[a-z]+ de [a-z]+$/.test(texto) && !/\d/.test(texto)) {
    return { ok: false, motivo: 'ambigua', textoOriginal }; // p.ej. "mediados de septiembre"
  }
  if (/^en +([a-z]+)$/.test(texto)) {
    const soloMes = texto.match(/^en +([a-z]+)$/)[1];
    if (soloMes in MESES) return { ok: false, motivo: 'ambigua', textoOriginal }; // p.ej. "en septiembre" (sin día)
  }
  if (/semana|proximamente|pronto|en unos dias|por confirmar/.test(texto)) {
    return { ok: false, motivo: 'ambigua', textoOriginal };
  }
  if (texto in DIAS_SEMANA) {
    return { ok: false, motivo: 'ambigua', textoOriginal }; // "viernes" solo, sin "este"/"próximo" -- no se adivina cuál
  }

  return { ok: false, motivo: 'no_reconocida', textoOriginal };
}
