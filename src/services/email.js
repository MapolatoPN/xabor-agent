// ─── Servicio de correo (Fase 7) ────────────────────────────────────────────
// Capa desacoplada. Hoy no hay ningún proveedor conectado (confirmado por
// auditoría: sin dependencia de resend/sendgrid/mailgun/nodemailer en
// package.json, sin variables de entorno de correo en Railway salvo
// VAPID_EMAIL, que es de push notifications, no de envío de correo).
//
// EMAIL_PROVIDER queda como punto de extensión futuro -- mientras no esté
// configurado, esta capa nunca intenta enviar nada por una API externa.
const PROVEEDOR = process.env.EMAIL_PROVIDER || null;

// El enlace SOLO se imprime fuera de producción (para poder probar el flujo
// completo en local sin proveedor real). En producción sin proveedor, el
// enlace nunca llega a ningún log -- ni siquiera enmascarado -- solo se deja
// constancia de que el envío no ocurrió.
export async function enviarCorreoInvitacion({ to, nombre, negocioNombre, enlace }) {
  if (PROVEEDOR) {
    // Ningún proveedor real implementado todavía en esta tarea -- nunca se
    // inventa una integración a medias. Falla explícito, no silencioso.
    throw new Error(`EMAIL_PROVIDER='${PROVEEDOR}' configurado pero sin implementación todavía en email.js`);
  }

  const esProduccion = process.env.NODE_ENV === 'production';
  if (!esProduccion) {
    console.log(`[email:dev] Invitación para ${nombre} <${to}> — negocio "${negocioNombre}": ${enlace}`);
    return { enviado: false, modo: 'consola-local' };
  }

  console.warn('[email] Correo pendiente de configuración -- ningún proveedor conectado. No se envió la invitación.');
  return { enviado: false, motivo: 'proveedor_no_configurado' };
}
