/**
 * notificacionBorradorAdmin.js — Cuando el Asistente Comercial genera un
 * borrador de cotización, envía el PDF (marcado "BORRADOR — NO ENVIAR AL
 * CLIENTE") al WhatsApp del administrador configurado para ESE negocio,
 * nunca al cliente ni a un número global compartido entre negocios.
 *
 * Multiempresa por diseño: negocioId es obligatorio en toda función.
 * `configuracion.admin_whatsapp_telefono` (clave/valor scoped por
 * negocio_id, mismo patrón que int_wa_phone_id/logo_base64 -- sin tabla
 * nueva) es la única fuente del teléfono del administrador. Si un
 * negocio no lo configuró, o no tiene credenciales de WhatsApp propias,
 * esta función NUNCA falla el flujo del Asistente Comercial (el borrador
 * ya quedó creado en la base de datos de todos modos) -- solo registra
 * por qué no se pudo notificar, para diagnóstico.
 *
 * Nunca importa nada de server.js (mismo criterio que draftBuilder.js) --
 * se puede probar de forma aislada, solo con DB + mock de Meta.
 */
import { obtenerConfiguracion, obtenerCredencialesWhatsappNegocio, crearDocumentoSaliente, guardarMensaje } from './database.js';
import { enviarDocumento } from './metaEnvioDocumentos.js';
import { generarPdfBorradorParaAdmin } from './cotizaciones.js';
import { TenantContextRequiredError } from './integracionesService.js';

const CAMPOS_SECUNDARIOS = { numero_personas: 'número de personas', lugar: 'lugar', presupuesto: 'presupuesto' };

function listarPendientes(camposCapturados = {}) {
  return Object.entries(CAMPOS_SECUNDARIOS)
    .filter(([campo]) => !camposCapturados[campo])
    .map(([, etiqueta]) => etiqueta);
}

function construirMensajeAdmin(cotizacion, camposCapturados) {
  const pendientes = listarPendientes(camposCapturados);
  const baseUrl = process.env.PUBLIC_URL || 'https://xabor.mx';
  const lineas = [
    '⚠️ BORRADOR — NO ENVIAR AL CLIENTE',
    '',
    'El Asistente Comercial generó una propuesta pendiente de tu revisión:',
    `Cliente: ${camposCapturados?.nombre || '(sin nombre capturado)'}`,
    `Teléfono: ${cotizacion.telefono}`,
    `Folio: ${cotizacion.folio}`,
    `Total estimado: $${Number(cotizacion.total || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`,
  ];
  if (pendientes.length > 0) lineas.push(`Pendiente de confirmar: ${pendientes.join(', ')}`);
  lineas.push('', `Revísala y apruébala aquí: ${baseUrl}/app`);
  return lineas.join('\n');
}

/**
 * Punto de entrada. Nunca lanza -- cualquier fallo (admin no
 * configurado, WhatsApp no configurado, error de Meta) se devuelve como
 * {ok:false, motivo}, nunca como excepción, para que el llamador
 * (brain.js, en background) nunca vea interrumpido el resto del flujo
 * de mensajería por esto.
 */
export async function notificarBorradorAlAdmin({ cotizacion, negocioId, camposCapturados = {} }) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw new TenantContextRequiredError('notificarBorradorAlAdmin');
  }
  if (!cotizacion?.id) return { ok: false, motivo: 'cotizacion_invalida' };

  try {
    const config = await obtenerConfiguracion(negocioId);
    const telefonoAdmin = config.admin_whatsapp_telefono;
    if (!telefonoAdmin) {
      console.log(`[notificacionBorradorAdmin] Negocio ${negocioId} sin admin_whatsapp_telefono configurado -- borrador ${cotizacion.folio} creado, sin notificar por WhatsApp.`);
      return { ok: false, motivo: 'admin_no_configurado' };
    }

    const credenciales = await obtenerCredencialesWhatsappNegocio(negocioId);
    if (!credenciales?.accessToken) {
      console.log(`[notificacionBorradorAdmin] Negocio ${negocioId} sin WhatsApp configurado -- borrador ${cotizacion.folio} creado, sin notificar por WhatsApp.`);
      return { ok: false, motivo: 'whatsapp_no_configurado' };
    }

    const { buffer } = await generarPdfBorradorParaAdmin(cotizacion.id, negocioId);
    const filename = `BORRADOR-${cotizacion.folio}.pdf`;
    const mensaje = construirMensajeAdmin(cotizacion, camposCapturados);

    const envio = await enviarDocumento(telefonoAdmin, buffer, filename, mensaje, credenciales);
    const wamid = envio?.messages?.[0]?.id || null;

    // Se registra como documento/mensaje saliente bajo el telefono del
    // ADMINISTRADOR (una conversación propia, separada de la del
    // cliente por la columna telefono) -- mismo mecanismo de auditoría
    // que cualquier otro documento enviado, sin tabla nueva. A propósito
    // NUNCA se vincula a cotizacion_id: ese campo en otros lugares del
    // código se interpreta como "documento enviado al cliente" -- este
    // documento va al administrador, no al cliente, y no debe aparecer
    // donde se listan los envíos reales de la cotización.
    const documento = await crearDocumentoSaliente({
      negocioId, telefono: telefonoAdmin, filename, sizeBytes: buffer.length,
      storageKey: null, caption: mensaje, wamid, createdBy: null,
    });
    await guardarMensaje(telefonoAdmin, null, 'saliente', `📄 ${filename}`, negocioId, 'humano', wamid, 'documento', documento.id);

    console.log(`[notificacionBorradorAdmin] Borrador ${cotizacion.folio} notificado al admin de ${negocioId} (wamid=${wamid || 'sin-wamid'}).`);
    return { ok: true, wamid, telefonoAdmin };
  } catch (e) {
    console.error(`[notificacionBorradorAdmin] Error notificando borrador ${cotizacion.folio} al admin de ${negocioId}:`, e.message);
    return { ok: false, motivo: 'error_envio', detalle: e.message };
  }
}
