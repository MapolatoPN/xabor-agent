// ─── Invariante de la integración de WhatsApp ───────────────────────────────
//
// Para canal='whatsapp' la columna `activo` NO es una segunda opinión: se
// DERIVA siempre del estado. La regla completa es
//
//     activo === (estado === 'activo')
//
// y debe cumplirse después de TODA transición. Este módulo existe para que
// ningún writer de WhatsApp decida `activo` a mano con una semántica propia
// (los dos incidentes reales: una integración 'pendiente_activacion' con
// activo=TRUE reclamaba el routing de webhooks sin poder responder, y una
// 'desconectado' seguía enrutando como si nada). Es deliberadamente un
// módulo hoja sin imports: lo consumen integracionesService.js y
// database.js sin riesgo de dependencia circular.
//
// OJO: esto es SOLO para WhatsApp. Pagos mantiene su propia semántica
// (suspender/reactivar de pagos no tocan `activo` y su routing se gobierna
// por `estado`); Rappi/voz no tienen writers de runtime. No generalizar.

/** Máquina de estados válida de la integración de WhatsApp. */
export const ESTADOS_WHATSAPP = Object.freeze([
  'no_configurado',        // sin nada utilizable
  'pendiente_configuracion', // guardado parcial
  'pendiente_activacion',  // credenciales completas, activación Meta pendiente
  'activo',                // operable: routing y envío habilitados
  'suspendido',            // bloqueada a propósito, credenciales conservadas
  'desconectado',          // Meta desconectó (o token revocado) → UI "Requiere reconexión"
  'error',                 // fallo que requiere intervención
]);

/**
 * Única fuente de verdad para `activo` en WhatsApp. Pura a propósito:
 * los writers la llaman en el MISMO UPDATE/INSERT que escribe `estado`.
 */
export function activoParaEstadoWhatsapp(estado) {
  return estado === 'activo';
}
