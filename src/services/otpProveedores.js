// ─── Proveedores de envío del código de acceso (OTP) ──────────────────────
//
// Una sola abstracción: `canalDisponible()` decide POR QUÉ vía sale el
// código y `enviarCodigo()` lo manda. El resto del sistema no sabe si fue
// SMS, WhatsApp o un log de desarrollo.
//
// REGLA DE SELECCIÓN (fail-closed a propósito):
//   · OTP_PROVEEDOR fija el canal: 'sms' | 'whatsapp' | 'dev'. Si el elegido
//     no tiene su configuración completa, NO hay OTP (y el login dice que no
//     está disponible), nunca se cae a otro canal en silencio.
//   · Sin OTP_PROVEEDOR: en producción NO hay OTP. Fuera de producción se
//     usa 'dev'. Así un despliegue nunca empieza a mandar mensajes (que
//     cuestan dinero) sin que alguien lo haya decidido con una variable.
//
// NINGÚN proveedor inventa credenciales: 'sms' usa la cuenta de Twilio que
// Xabor ya tiene configurada (TWILIO_*), 'whatsapp' usa las credenciales
// cifradas del propio negocio y una plantilla de AUTENTICACIÓN aprobada por
// Meta cuyo nombre viene en OTP_WA_PLANTILLA. Si esa plantilla no existe
// todavía, el canal simplemente no está disponible.
const META_GRAPH_BASE_URL = process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com';

const esProduccion = () => process.env.NODE_ENV === 'production';

const dev = {
  nombre: 'dev',
  disponible: () => !esProduccion(),
  async enviar({ negocioId, telefono, codigo, nombreNegocio }) {
    // Solo fuera de producción (disponible() lo impide allá). El código se
    // imprime para poder probar a mano; las suites lo leen por la API cuando
    // XABOR_OTP_DEV_EXPONER está puesta.
    console.log(`[OTP dev] ${nombreNegocio || negocioId} → ${telefono}: código ${codigo}`);
    return { canal: 'dev' };
  },
};

const sms = {
  nombre: 'sms',
  disponible: () => Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_SMS_NUMBER),
  async enviar({ telefono, codigo, nombreNegocio }) {
    const { default: twilio } = await import('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    // E.164 para un móvil mexicano: +52 + 10 dígitos.
    const to = `+${process.env.OTP_SMS_PREFIJO || '52'}${telefono}`;
    const r = await client.messages.create({
      from: process.env.TWILIO_SMS_NUMBER, to,
      body: `${nombreNegocio || 'Xabor'}: tu código de acceso es ${codigo}. Vence en 5 minutos. No lo compartas.`,
    });
    if (!r?.sid) throw new Error('Twilio no confirmó el envío');
    return { canal: 'sms' };
  },
};

const whatsapp = {
  nombre: 'whatsapp',
  disponible: () => Boolean(process.env.OTP_WA_PLANTILLA),
  async enviar({ negocioId, telefono, codigo }) {
    const { obtenerCredencialesWhatsappNegocio } = await import('./database.js');
    const cred = await obtenerCredencialesWhatsappNegocio(negocioId);
    if (!cred?.phoneNumberId || !cred?.accessToken) throw new Error('El negocio no tiene WhatsApp conectado');
    // Plantilla de categoría AUTHENTICATION (Meta): el cuerpo lleva el código
    // y el botón "copiar código" también. Un texto libre no serviría: fuera
    // de la ventana de 24 h Meta no lo entrega.
    const to = `${process.env.OTP_WA_PREFIJO || '521'}${telefono}`;
    const resp = await fetch(`${META_GRAPH_BASE_URL}/v20.0/${cred.phoneNumberId}/messages`, {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${cred.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
        template: {
          name: process.env.OTP_WA_PLANTILLA,
          language: { code: process.env.OTP_WA_IDIOMA || 'es_MX' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: codigo }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: codigo }] },
          ],
        },
      }),
    });
    if (!resp.ok) {
      // Nunca se registra el cuerpo (trae el destinatario); solo el status.
      throw new Error(`Meta respondió ${resp.status} al enviar la plantilla OTP`);
    }
    const j = await resp.json();
    if (!j?.messages?.[0]?.id) throw new Error('Meta no confirmó el envío del OTP');
    return { canal: 'whatsapp' };
  },
};

const PROVEEDORES = { dev, sms, whatsapp };

export function canalDisponible() {
  const pedido = String(process.env.OTP_PROVEEDOR || '').trim().toLowerCase();
  if (pedido) {
    const p = PROVEEDORES[pedido];
    return p && p.disponible() ? p.nombre : null;
  }
  if (esProduccion()) return null;
  return 'dev';
}

export async function enviarCodigo({ canal, negocioId, telefono, codigo, nombreNegocio }) {
  const p = PROVEEDORES[canal];
  if (!p || !p.disponible()) throw new Error(`Canal OTP no disponible: ${canal}`);
  return p.enviar({ negocioId, telefono, codigo, nombreNegocio });
}

// Para diagnóstico (nunca expone credenciales): qué canal saldría y por qué.
export function diagnosticoOtp() {
  return {
    proveedorPedido: process.env.OTP_PROVEEDOR || null,
    canal: canalDisponible(),
    sms: sms.disponible(), whatsapp: whatsapp.disponible(), dev: dev.disponible(),
  };
}
