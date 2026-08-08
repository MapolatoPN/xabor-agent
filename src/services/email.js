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

// ─── Restablecer contraseña ─────────────────────────────────────────────────
// Misma infraestructura que la invitación (Resend por fetch, mismo
// remitente, mismo manejo de fallos): no se agrega proveedor nuevo. El correo
// NUNCA lleva contraseña, hash, datos del negocio ni nada interno — solo el
// enlace y cuánto dura.
function plantillaResetPassword({ nombre, enlace, minutos }) {
  const saludo = nombre ? `Hola ${escapeHtml(nombre)},` : 'Hola,';
  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;line-height:1.5;">
  <p>${saludo}</p>
  <p>Recibimos una solicitud para cambiar la contraseña de tu cuenta de Xabor.</p>
  <p style="text-align:center;margin:28px 0;">
    <a href="${enlace}" style="background:#111;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:bold;">Restablecer contraseña</a>
  </p>
  <p style="font-size:0.85rem;color:#666;">Este enlace vence en ${minutos} minutos y solo puede usarse una vez.</p>
  <p style="font-size:0.85rem;color:#666;">Si no fuiste tú, ignora este mensaje: tu contraseña sigue igual.</p>
  <p style="font-size:0.85rem;color:#666;">¿Dudas? Escríbenos a hola@xabor.mx</p>
</div>`.trim();
  return { subject: 'Restablecer tu contraseña de Xabor', html };
}

// Nunca lanza y NUNCA imprime el enlace ni el token, en ningún entorno: la
// respuesta HTTP tampoco los devuelve, así que el correo es el único camino
// por el que ese enlace sale del servidor.
export async function enviarCorreoResetPassword({ to, nombre, enlace, minutos = 60 }) {
  const esProduccion = process.env.NODE_ENV === 'production';

  if (!esProduccion) {
    console.log(`[email:dev] Enlace de recuperación preparado para ${nombre || 'un usuario'} (fuera de producción no se envía correo, y el enlace no se imprime)`);
    return { enviado: false, modo: 'consola-local' };
  }
  if (!RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY no configurada -- no se envió el enlace de recuperación.');
    return { enviado: false, motivo: 'proveedor_no_configurado' };
  }
  const { subject, html } = plantillaResetPassword({ nombre, enlace, minutos });
  const resultado = await enviarViaResend({ to, subject, html });
  if (resultado.enviado) console.log('[email] Enlace de recuperación enviado');
  return resultado;
}

// ─── Notificación de nuevo prospecto comercial ──────────────────────────────
// Secundaria por diseño: la persistencia en `prospectos_comerciales` (ver
// crearProspectoComercial en database.js) YA ocurrió antes de llamar esta
// función y es la fuente de verdad. Si el correo falla o no hay proveedor
// configurado, el prospecto sigue guardado -- el llamador nunca debe
// bloquear la respuesta HTTP 201 esperando esto. Nunca incluye IP, user
// agent, tokens ni ningún dato técnico -- solo lo que el propio visitante
// escribió en el formulario.
const LEADS_NOTIFICATION_EMAIL = process.env.LEADS_NOTIFICATION_EMAIL || 'hola@xabor.mx';
const PUBLIC_URL_BASE = process.env.PUBLIC_URL || 'https://xabor.mx';

function plantillaNuevoProspecto(p) {
  const filas = [
    ['Nombre', p.nombre],
    ['Negocio', p.negocio],
    ['Ciudad', p.ciudad],
    ['Teléfono', p.telefono],
    ['Tipo de negocio', p.tipoNegocio],
    ['Volumen aproximado de mensajes', p.volumenMensajes || 'No especificado'],
    ['Comentario', p.comentario || 'Sin comentarios adicionales'],
    ['Fecha', new Date(p.createdAt || Date.now()).toLocaleString('es-MX', { timeZone: 'America/Matamoros' })],
  ];
  const enlace = `${PUBLIC_URL_BASE}/superadmin?prospecto=${encodeURIComponent(p.id)}`;

  const filasHtml = filas.map(([k, v]) => `
    <tr>
      <td style="padding:6px 12px 6px 0;color:#666;font-size:0.85rem;white-space:nowrap;">${escapeHtml(k)}</td>
      <td style="padding:6px 0;color:#111;font-size:0.9rem;">${escapeHtml(v)}</td>
    </tr>`).join('');

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;line-height:1.5;">
  <p>Nuevo prospecto capturado desde la landing de Xabor:</p>
  <table style="border-collapse:collapse;width:100%;margin:16px 0;">${filasHtml}</table>
  <p style="text-align:center;margin:28px 0;">
    <a href="${enlace}" style="background:#111;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:bold;">Ver en Superadmin</a>
  </p>
  <p style="font-size:0.8rem;color:#888;">Este correo es solo una notificación. El registro completo ya está guardado en Xabor.</p>
</div>`.trim();

  const texto = [
    'Nuevo prospecto capturado desde la landing de Xabor:',
    '',
    ...filas.map(([k, v]) => `${k}: ${v}`),
    '',
    `Ver en Superadmin: ${enlace}`,
  ].join('\n');

  return { subject: `Nuevo prospecto de Xabor — ${p.negocio}`, html, texto };
}

// Nunca lanza -- un fallo de correo no debe tumbar la request que ya guardó
// al prospecto en base. Devuelve { enviado, motivo? } igual que
// enviarCorreoInvitacion, para que el llamador pueda registrar el estado
// (columna correo_notificacion_enviado) sin depender de excepciones.
export async function enviarNotificacionNuevoProspecto(prospecto) {
  try {
    const esProduccion = process.env.NODE_ENV === 'production';
    if (!esProduccion) {
      console.log(`[email:dev] Notificación de prospecto preparada para ${LEADS_NOTIFICATION_EMAIL} — negocio "${prospecto.negocio}" (no se envía correo real fuera de producción)`);
      return { enviado: false, modo: 'consola-local' };
    }
    if (!RESEND_API_KEY) {
      console.warn('[email] RESEND_API_KEY no configurada -- no se notificó el nuevo prospecto (el registro ya está guardado).');
      return { enviado: false, motivo: 'proveedor_no_configurado' };
    }
    const { subject, html } = plantillaNuevoProspecto(prospecto);
    const resultado = await enviarViaResend({ to: LEADS_NOTIFICATION_EMAIL, subject, html });
    if (resultado.enviado) console.log(`[email] Notificación de nuevo prospecto enviada (negocio: ${prospecto.negocio})`);
    return resultado;
  } catch (e) {
    console.error('[email] Fallo inesperado notificando nuevo prospecto:', e.message);
    return { enviado: false, motivo: 'error_inesperado' };
  }
}

// ─── Pendiente, fuera de alcance de esta fase ───────────────────────────────
// No existe ningún flujo de "recuperar contraseña" en el código (confirmado
// por auditoría: sin rutas /forgot-password ni similares). Este servicio ya
// queda listo para reutilizarse ahí (mismo remitente, mismo transporte
// Resend) el día que se decida construirlo -- pero esa ruta y su plantilla
// no se agregan en esta tarea.
