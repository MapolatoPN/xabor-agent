// Resolución de expresiones temporales para CONSULTAS de promociones ("hoy",
// "mañana", "miércoles", "esta semana", "próximo viernes", "2026-09-02",
// opcionalmente "a las 16:00"). PURA y determinista — sin I/O — para poder
// probarla en aislamiento. Trabaja en la ZONA HORARIA del negocio: la fecha
// objetivo se ancla al mediodía UTC de ese día calendario, de modo que
// partesEnZona() del backend devuelva su día de la semana correcto.
import { partesEnZona } from './tiendaOnline.js';

const DIAS = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
const NOMBRE_DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Ancla de un día calendario (YYYY-MM-DD) al mediodía UTC — instante seguro para
// derivar el día de la semana en cualquier TZ de México (nunca cruza medianoche).
function anclaDia(fechaISO) { return new Date(`${fechaISO}T12:00:00Z`); }
function sumarDias(fechaISO, n) {
  const d = new Date(anclaDia(fechaISO).getTime() + n * 86400000);
  const p = { y: d.getUTCFullYear(), m: String(d.getUTCMonth() + 1).padStart(2, '0'), d: String(d.getUTCDate()).padStart(2, '0') };
  return `${p.y}-${p.m}-${p.d}`;
}

// Extrae una hora del día (minutos 0-1439) si el texto la menciona; si no, null.
export function parseHora(s) {
  const t = norm(s);
  let m = t.match(/a\s*las?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?m\.?|p\.?m\.?)?/);
  if (!m) m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0);
  const ap = (m[3] || '').replace(/[.\s]/g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Devuelve { ok, esSemana, minutos, dias:[{fechaISO, ahora, etiqueta, diaNombre}] }.
// `ahora` de cada día es el instante ancla (mediodía UTC) para pasar al backend.
export function resolverCuandoPromo(cuando, { ahora = new Date(), timezone = 'America/Matamoros' } = {}) {
  const t = norm(cuando);
  if (!t) return { ok: false };
  const hoyISO = partesEnZona(ahora, timezone).fechaISO;
  const minutos = parseHora(t);
  const armarDia = (fechaISO, etiqueta) => {
    const a = anclaDia(fechaISO);
    return { fechaISO, ahora: a, etiqueta: etiqueta || null, diaNombre: NOMBRE_DIA[partesEnZona(a, timezone).diaSemana] };
  };

  // Semana completa
  if (/\bsemana\b/.test(t)) {
    const dias = [];
    for (let i = 0; i < 7; i++) dias.push(armarDia(sumarDias(hoyISO, i)));
    return { ok: true, esSemana: true, minutos, dias };
  }
  // Fecha ISO explícita
  const iso = t.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return { ok: true, esSemana: false, minutos, dias: [armarDia(iso[1])] };
  // Relativos
  if (/pasado\s*manana/.test(t)) return { ok: true, esSemana: false, minutos, dias: [armarDia(sumarDias(hoyISO, 2), 'pasado mañana')] };
  if (/\bmanana\b/.test(t)) return { ok: true, esSemana: false, minutos, dias: [armarDia(sumarDias(hoyISO, 1), 'mañana')] };
  if (/\bhoy\b/.test(t)) return { ok: true, esSemana: false, minutos, dias: [armarDia(hoyISO, 'hoy')] };
  // Día de la semana (próxima ocurrencia; si hoy es ese día, hoy)
  for (const [nombre, idx] of Object.entries(DIAS)) {
    if (new RegExp(`\\b${nombre}\\b`).test(t)) {
      const hoyDia = partesEnZona(ahora, timezone).diaSemana;
      const delta = (idx - hoyDia + 7) % 7;
      const etiqueta = delta === 0 ? 'hoy' : (delta === 1 ? 'mañana' : (delta === 2 ? 'pasado mañana' : null));
      return { ok: true, esSemana: false, minutos, dias: [armarDia(sumarDias(hoyISO, delta), etiqueta)] };
    }
  }
  return { ok: false };
}
