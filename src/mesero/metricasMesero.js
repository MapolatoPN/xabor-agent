// ─── Medir el mesero sin coleccionar a los clientes ───────────────────────
//
// Módulo puro. Produce eventos estructurados, uno por línea, con el prefijo que
// ya usa el resto del sistema para lo transaccional (`[TXN]` / `[MESERO]`) para
// que se puedan buscar en los logs de Railway sin herramienta nueva.
//
// ── Qué se mide, y por qué esas cosas ────────────────────────────────────
//
// Las preguntas que hay que poder contestar en dos semanas son:
//
//   ¿el mesero entiende?            intenciones por turno, aclaraciones
//   ¿recomienda o molesta?          recomendadas vs aceptadas vs rechazadas
//   ¿bloquea lo que debe?           cambios bloqueados, invenciones frenadas
//   ¿acaba en pedido?               confirmados, handoffs
//
// Todo por negocio, porque la respuesta puede ser distinta en cada uno y una
// media de los tres no diría nada de ninguno.
//
// ── Y qué NO se escribe ──────────────────────────────────────────────────
//
// Ni teléfonos, ni nombres, ni el texto del cliente. La conversación se
// identifica por un hash corto y estable dentro del proceso, que sirve para
// contar turnos de una misma atención y no sirve para nada más. Los nombres de
// PRODUCTO sí se escriben: son del negocio, están en su carta pública, y sin
// ellos «recomendación rechazada» no se puede accionar.
import { createHash } from 'node:crypto';

export const EVENTOS = Object.freeze([
  'whatsapp_mesero_turno',
  'whatsapp_mesero_intencion',
  'whatsapp_mesero_aclaracion',
  'whatsapp_mesero_recomendacion',
  'whatsapp_mesero_recomendacion_aceptada',
  'whatsapp_mesero_recomendacion_rechazada',
  'whatsapp_mesero_cambio_bloqueado',
  'whatsapp_mesero_invento_bloqueado',
  'whatsapp_mesero_referencia_ambigua',
  'whatsapp_mesero_handoff',
  'whatsapp_mesero_confirmado',
]);

/** Identificador corto y estable de la conversación. No reversible a teléfono. */
export const idConversacion = (s) => createHash('sha256').update(String(s || '')).digest('hex').slice(0, 10);

const valor = (v) => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => String(x)).join('|');
  return String(v).replace(/\s+/g, '_');
};

/** Una línea de evento. Devuelve el texto; no imprime. */
export function linea(evento, negocioId, campos = {}) {
  const pares = Object.entries(campos)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${valor(v)}`);
  return `[MESERO] evento=${evento} negocio=${negocioId} ${pares.join(' ')}`.trim();
}

/**
 * Todos los eventos de un turno, en orden.
 *
 * Se devuelven como lista y no se imprimen aquí: quien llama decide si van al
 * log, a una prueba o a ningún lado. Un módulo puro que escribe en la consola
 * no se puede probar sin leer la consola.
 */
export function eventosDelTurno({
  negocioId, conversacion, intenciones = [], aclaraciones = [], recomendaciones = [],
  desenlace = null, decisiones = [], cambios = null, handoff = null, confirmado = false,
  fase = null, modo = 'mesero',
} = {}) {
  const conv = idConversacion(conversacion);
  const fuera = [];
  fuera.push(linea('whatsapp_mesero_turno', negocioId, { conv, fase, modo, intenciones: intenciones.length }));
  for (const i of intenciones) fuera.push(linea('whatsapp_mesero_intencion', negocioId, { conv, intencion: i }));
  for (const a of aclaraciones) fuera.push(linea('whatsapp_mesero_aclaracion', negocioId, { conv, tipo: a.tipo }));
  for (const r of recomendaciones) {
    fuera.push(linea('whatsapp_mesero_recomendacion', negocioId, { conv, producto: r.nombre, motivo: r.motivo }));
  }
  for (const p of desenlace?.aceptadas || []) {
    fuera.push(linea('whatsapp_mesero_recomendacion_aceptada', negocioId, { conv, producto: p.referencia }));
  }
  for (const p of desenlace?.rechazadas || []) {
    fuera.push(linea('whatsapp_mesero_recomendacion_rechazada', negocioId, { conv, producto: p.referencia }));
  }
  for (const d of decisiones) {
    if (d.decision !== 'rechazada') continue;
    fuera.push(linea('whatsapp_mesero_cambio_bloqueado', negocioId, {
      conv, accion: d.propuesta?.accion, campo: d.propuesta?.campo, motivo: d.motivo,
    }));
  }
  // Lo que el modelo se sacó de la manga y el reconciliador frenó. Es la
  // métrica que dice si la capa de seguridad sigue haciendo falta.
  for (const s of cambios?.sinRespaldo || []) {
    if (s.campo !== 'articulo') continue;
    fuera.push(linea('whatsapp_mesero_invento_bloqueado', negocioId, { conv, producto: s.nombre }));
  }
  for (const a of aclaraciones) {
    if (a.tipo === 'referencia_ambigua') {
      fuera.push(linea('whatsapp_mesero_referencia_ambigua', negocioId, { conv, motivo: a.motivo }));
    }
  }
  if (handoff?.escalar) fuera.push(linea('whatsapp_mesero_handoff', negocioId, { conv, motivo: handoff.motivo }));
  if (confirmado) fuera.push(linea('whatsapp_mesero_confirmado', negocioId, { conv }));
  return fuera;
}

/** ¿Se coló algo que no debería estar en un log? Para poder afirmarlo con una prueba. */
export function pareceSensible(lineas) {
  const texto = Array.isArray(lineas) ? lineas.join('\n') : String(lineas || '');
  // Rachas de dígitos que parecen teléfono, y correos.
  return /\d{7,}/.test(texto) || /[\w.+-]+@[\w-]+\.\w+/.test(texto);
}
