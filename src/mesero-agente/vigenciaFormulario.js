// Vigencia de un formulario de pedido de WhatsApp (Flow): hasta cuándo lo dan
// por vivo el endpoint, el envío final, la ayuda del personal y el panel.
// Fuente única: los cuatro deben decir lo mismo o el formulario se rompe en
// el siguiente paso.
//
// Antes eran 30 minutos desde el ENVÍO, aunque el cliente lo estuviera usando.
// El 23-oct-2026 una clienta de Acuña navegó el menú de 10:00 a 10:06, volvió a
// las 10:32 y le salió «Este formulario ya no está disponible». En 14 días, 4
// de los 23 rechazos de Obispado y Acuña fueron así.
//
// Ahora: 30 minutos SIN ACTIVIDAD (cada llamada del formulario al servidor la
// renueva: flowRepetibleSql.js toca el borrador) y nunca más de 2 horas desde
// el envío. El dinero no se arriesga: el resumen final se recalcula con la
// carta del momento y el cliente lo confirma.
export const MINUTOS_SIN_ACTIVIDAD = 30;
export const MINUTOS_MAXIMOS = 120;

/**
 * Expresión SQL booleana: ¿sigue vigente la pregunta con alias `q`? Usa la
 * última actividad de su borrador (agente_flows_borradores.actualizado_at); sin
 * borrador, el envío. Pura: no escribe nada.
 */
export function sqlFormularioVigente(q = 'q') {
  if (!/^[a-z_][a-z0-9_]*$/i.test(q)) throw new Error('alias inválido');
  return `(${q}.created_at > clock_timestamp() - interval '${MINUTOS_MAXIMOS} minutes'
    AND GREATEST(${q}.created_at, COALESCE((SELECT fbv.actualizado_at FROM agente_flows_borradores fbv
      WHERE fbv.pregunta_id = ${q}.id), ${q}.created_at)) > clock_timestamp() - interval '${MINUTOS_SIN_ACTIVIDAD} minutes')`;
}

const ms = (v) => { const n = v instanceof Date ? v.getTime() : Date.parse(v); return Number.isFinite(n) ? n : null; };

/** La misma regla en JS. `actividadAt`: el `actualizado_at` del borrador, si hay. */
export function dentroDeVigenciaFormulario({ creadoAt, actividadAt = null, ahora = Date.now() } = {}) {
  const creado = ms(creadoAt);
  if (creado === null) return false;
  const ultima = Math.max(creado, ms(actividadAt) ?? creado);
  return ahora - creado < MINUTOS_MAXIMOS * 60_000 && ahora - ultima < MINUTOS_SIN_ACTIVIDAD * 60_000;
}
