// ─── DÍAS CERRADOS (CIERRES ESPECIALES) ─────────────────────────────────────
//
// Lo que el panel guarda en `reglas_atencion.cierres_especiales` (Configuración
// → Horarios, panel/cierres-especiales.js) y leen el bot, la tienda y el
// descuento tras cierre a través de horarioSemanal.js:
//
//   { fecha: 'YYYY-MM-DD', motivo: 'Día festivo', hora_cierre?: 'HH:MM' }
//
// Sin `hora_cierre` ese día no se abre; con ella, se cierra temprano.
//
// Esta revisión corre SOLO al guardar (PUT /api/config). A propósito NO vive
// en validarEstructuraReglas (prompts.js): esa la usa también el bot al LEER
// las reglas, y una regla guardada antes que no pasara haría que el bot cayera
// a los horarios por omisión en vez de a los del negocio.
import { minutosDeHorario } from './horarioSemanal.js';

export const MAX_CIERRES_ESPECIALES = 60;
export const MAX_MOTIVO = 80;

function fechaReal(valor) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const d = new Date(`${valor}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === valor;
}

const vacio = (v) => v === undefined || v === null || v === '';

/** { ok: true } o { ok: false, error } con un texto que se le puede mostrar al negocio. */
export function validarCierresEspeciales(lista) {
  if (!Array.isArray(lista)) return { ok: false, error: 'Los días cerrados deben venir en una lista.' };
  if (lista.length > MAX_CIERRES_ESPECIALES) {
    return { ok: false, error: `Son demasiados días cerrados (máximo ${MAX_CIERRES_ESPECIALES}).` };
  }
  const vistas = new Set();
  for (const e of lista) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      return { ok: false, error: 'Un día cerrado no tiene el formato esperado.' };
    }
    if (!fechaReal(e.fecha)) {
      return { ok: false, error: `La fecha «${String(e.fecha ?? '').slice(0, 20)}» de un día cerrado no es válida.` };
    }
    if (vistas.has(e.fecha)) return { ok: false, error: `El ${e.fecha} aparece dos veces en los días cerrados.` };
    vistas.add(e.fecha);
    if (!vacio(e.hora_cierre)) {
      // 00:00 cerraría el día entero con otro nombre: para eso es «todo el día».
      const m = typeof e.hora_cierre === 'string' ? minutosDeHorario(e.hora_cierre) : null;
      if (m === null || m === 0) return { ok: false, error: `La hora de cierre del ${e.fecha} no es válida.` };
    }
    if (!vacio(e.motivo) && (typeof e.motivo !== 'string' || e.motivo.length > MAX_MOTIVO)) {
      return { ok: false, error: `El motivo del ${e.fecha} debe ser un texto de máximo ${MAX_MOTIVO} letras.` };
    }
  }
  return { ok: true };
}
