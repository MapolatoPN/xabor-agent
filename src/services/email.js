// ─── Servicio de correo ─────────────────────────────────────────────────────
// Proveedor: Resend, llamado directo por fetch a su API REST (sin agregar
// una dependencia npm nueva). RESEND_API_KEY se lee únicamente de la
// variable de entorno -- nunca se escribe en código, logs, pruebas ni
// reportes. Si falta, producción falla cerrado (no se envía nada, nunca se
// marca como entregado).
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const REMITENTE = 'Xabor <acceso@xabor.mx>';
const REPLY_TO = 'hola@xabor.mx';
const RESEND_TIMEOUT_MS = 10_000;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function plantillaInvitacion({ nombre, negocioNombre, enlace }) {
  const saludo = nombre ? `Hola ${escapeHtml(nombre)},` : 'Hola,';
  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;line-height:1.5;">
  <p>${saludo}</p>
  <p>Te invitaron a acceder al panel de <strong>${escapeHtml(negocioNombre)}</strong> en Xabor.</p>
  <p style="text-align:center;margin:28px 0;">
    <a href="${enlace}" style="background:#111;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:bold;">Crear contraseña</a>
  </p>
  <p style="font-size:0.85rem;color:#666;">Este enlace expira pronto y solo puede usarse una vez.</p>
  <p style="font-size:0.85rem;color:#666;">Si no esperabas este correo, puedes ignorarlo con confianza.</p>
  <p style="font-size:0.85rem;color:#666;">¿Dudas? Escríbenos a hola@xabor.mx</p>
</div>`.trim();
  return { subject: 'Configura tu acceso a Xabor', html };
}

async function enviarViaResend({ to, subject, html }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: REMITENTE, to: [to], reply_to: REPLY_TO, subject, html }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Nunca se logea el body de la respuesta de error (puede incluir el
      // destinatario u otros datos) -- solo el status HTTP.
      console.error(`[email] Resend respondió ${res.status} al intentar enviar la invitación`);
      return { enviado: false, motivo: 'resend_error' };
    }
    return { enviado: true };
  } catch (e) {
    const motivo = e.name === 'AbortError' ? 'timeout' : 'error_red';
    console.error(`[email] Fallo al enviar vía Resend: ${motivo}`);
    return { enviado: false, motivo };
  } finally {
    clearTimeout(timeoutId);
  }
}

// El enlace/token NUNCA se imprime en ningún log, ni en producción ni en
// local -- ni siquiera enmascarado. La única superficie donde el enlace
// crudo es visible es la respuesta de la API a un Superadmin autenticado
// cuando enviado=false (ver /api/superadmin/negocios en server.js, que ya
// implementa ese fallback de "copiar enlace" independientemente de este
// servicio).
export async function enviarCorreoInvitacion({ to, nombre, negocioNombre, enlace }) {
  const esProduccion = process.env.NODE_ENV === 'production';

  if (!esProduccion) {
    // Nunca se manda correo real en local/dev, sea cual sea la
    // configuración de RESEND_API_KEY.
    console.log(`[email:dev] Invitación preparada para ${nombre || 'usuario'} <${to}> — negocio "${negocioNombre}" (enlace disponible solo en la respuesta de la API, no en este log)`);
    return { enviado: false, modo: 'consola-local' };
  }

  if (!RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY no configurada -- no se envió la invitación.');
    return { enviado: false, motivo: 'proveedor_no_configurado' };
  }

  const { subject, html } = plantillaInvitacion({ nombre, negocioNombre, enlace });
  const resultado = await enviarViaResend({ to, subject, html });
  if (resultado.enviado) {
    console.log(`[email] Invitación enviada a ${to}`);
  }
  return resultado;
}

// ─── Pendiente, fuera de alcance de esta fase ───────────────────────────────
// No existe ningún flujo de "recuperar contraseña" en el código (confirmado
// por auditoría: sin rutas /forgot-password ni similares). Este servicio ya
// queda listo para reutilizarse ahí (mismo remitente, mismo transporte
// Resend) el día que se decida construirlo -- pero esa ruta y su plantilla
// no se agregan en esta tarea.
