// El número del encargado para los avisos por WhatsApp, y qué avisos quiere.
//
// El panel (Config › Integraciones › «Número para reportes internos») guarda
// el número como `int_wa_admin_numero`: PUT /api/admin/integraciones antepone
// `int_` a todas sus claves. Los avisos leían `wa_admin_numero`, sin prefijo,
// así que en un negocio configurado desde el panel no encontraban número y se
// omitían sin avisar a nadie. Aquí se lee primero lo que guarda el panel y, si
// falta, la clave vieja (la que ya tenga escrita algún negocio a mano).
//
// Cada aviso tiene además su interruptor por negocio. Sin fila vale el valor
// por omisión: encendidos los avisos de poco volumen e importantes, apagado
// «cliente esperando», que se dispara varias veces al día. Encender o apagar:
//   INSERT INTO configuracion (negocio_id, clave, valor)
//   VALUES ('<negocio>', 'aviso_dueno_wa_cliente_esperando', 'true')
//   ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor;
//
// Los dos avisos que ya tenían su propia bandera (el traspaso del agente,
// `whatsapp_rescate_aviso_whatsapp_v1`, y el resumen de pausas vencidas,
// `whatsapp_pausa_vence_aviso_whatsapp`) la conservan: de aquí solo toman el
// número.

const CLAVES_NUMERO = ['int_wa_admin_numero', 'wa_admin_numero'];

export function numeroAdminNegocio(cfg) {
  for (const clave of CLAVES_NUMERO) {
    const v = cfg?.[clave];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

export const AVISOS_DUENO = Object.freeze({
  // 3 errores del bot en 5 minutos.
  fallas_bot:         Object.freeze({ clave: 'aviso_dueno_wa_fallas_bot', porOmision: true }),
  // Una conversación pasó a una persona (el cliente lo pidió, comprobante…).
  revision_humana:    Object.freeze({ clave: 'aviso_dueno_wa_revision_humana', porOmision: true }),
  // El bot iba a negar algo que sí se vende.
  negativa_falsa:     Object.freeze({ clave: 'aviso_dueno_wa_negativa_falsa', porOmision: true }),
  // El bot retomó una conversación que nadie atendió.
  bot_retomo:         Object.freeze({ clave: 'aviso_dueno_wa_bot_retomo', porOmision: true }),
  // Un cliente quiso pagar y el negocio no tiene proveedor de pagos.
  pago_sin_proveedor: Object.freeze({ clave: 'aviso_dueno_wa_pago_sin_proveedor', porOmision: true }),
  // Un cliente lleva más de 5 minutos esperando respuesta.
  cliente_esperando:  Object.freeze({ clave: 'aviso_dueno_wa_cliente_esperando', porOmision: false }),
});

export function avisoDuenoEncendido(cfg, tipo) {
  const aviso = AVISOS_DUENO[tipo];
  if (!aviso) return false;   // un tipo que no está en la lista no avisa
  const v = String(cfg?.[aviso.clave] ?? '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return aviso.porOmision;
}

/** El número al que va el aviso `tipo`, o '' si está apagado o no hay número. */
export function numeroParaAvisoDueno(cfg, tipo) {
  return avisoDuenoEncendido(cfg, tipo) ? numeroAdminNegocio(cfg) : '';
}
