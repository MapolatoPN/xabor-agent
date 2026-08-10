// Autoservicio de WhatsApp: lo que ve y puede hacer el propio negocio.
//
// ─── QUÉ CAMBIA RESPECTO A HOY ──────────────────────────────────────────────
//
// Hoy el panel del negocio muestra Access Token, Phone Number ID y Verify
// Token como campos de texto. Eso no es configuración: es pedirle al cliente
// que haga de integrador. Un restaurante no tiene por qué saber qué es un
// wamid, y cada campo que le pedimos copiar es una oportunidad de pegarlo mal
// o de mandárnoslo por WhatsApp en una captura.
//
// El backend de Embedded Signup ya existía y ya era seguro por tenant: el
// callback deriva el negocio del `state` firmado, nunca del cuerpo. Este
// módulo NO lo reescribe. Solo añade la cara que le faltaba -- el estado que
// puede ver un cliente, sin un solo secreto dentro.
//
// ─── LA REGLA DE ESTE ARCHIVO ───────────────────────────────────────────────
//
// Nada de lo que devuelva puede contener un token, un secreto ni un
// identificador técnico que el cliente no necesita. Si aparece uno, es un
// error, no un detalle.
import { pool } from './database.js';

// Solo el administrador del negocio conecta WhatsApp. Un mesero no puede
// tocar la integración del restaurante donde trabaja, y un operador tampoco.
const ROLES_QUE_PUEDEN_CONECTAR = new Set(['admin']);

export function puedeAdministrarWhatsapp(rol) {
  return ROLES_QUE_PUEDEN_CONECTAR.has(rol);
}

// Traducción de los estados de nombre visible de Meta. Si llega uno que no
// conocemos NO se inventa: se dice que no se sabe.
const ESTADOS_NOMBRE = {
  APPROVED: { etiqueta: 'Aprobado', tono: 'ok' },
  PENDING_REVIEW: { etiqueta: 'En revisión', tono: 'espera' },
  PENDING: { etiqueta: 'En revisión', tono: 'espera' },
  REJECTED: { etiqueta: 'Rechazado', tono: 'problema' },
  NONE: { etiqueta: 'Sin nombre visible', tono: 'espera' },
};

export function traducirEstadoNombre(valor) {
  if (!valor) return { etiqueta: 'Desconocido', tono: 'espera', crudo: null };
  const conocido = ESTADOS_NOMBRE[String(valor).toUpperCase()];
  return conocido
    ? { ...conocido, crudo: valor }
    : { etiqueta: 'Desconocido', tono: 'espera', crudo: valor };
}

/**
 * Traduce un error de Meta a algo que un dueño de restaurante pueda leer y
 * accionar.
 *
 * En los logs hemos visto cosas como "(#33) The requested phone number has
 * been deleted". Enseñar eso tal cual no ayuda a nadie; esconderlo del todo,
 * tampoco. Se traduce, y el detalle técnico se guarda para el log.
 */
export function traducirErrorMeta(error) {
  const codigo = error?.code ?? error?.error?.code ?? null;
  const subcodigo = error?.error_subcode ?? error?.error?.error_subcode ?? null;
  const mensaje = String(error?.message ?? error?.error?.message ?? error ?? '');

  const porCodigo = {
    33: 'El número ya no existe en esa cuenta de WhatsApp. Revísalo en Meta y vuelve a intentar.',
    100: 'Meta rechazó la operación con los datos recibidos.',
    190: 'El permiso que diste a Xabor caducó. Vuelve a conectar tu WhatsApp.',
    200: 'Tu usuario de Meta no tiene permisos suficientes sobre esa cuenta.',
    10: 'Meta no permite esta operación con la configuración actual de la cuenta.',
    4: 'Meta está limitando las peticiones ahora mismo. Inténtalo en unos minutos.',
    80007: 'Meta está limitando las peticiones ahora mismo. Inténtalo en unos minutos.',
  };
  if (codigo && porCodigo[codigo]) {
    return { mensaje: porCodigo[codigo], codigo, subcodigo, accionable: true };
  }
  if (/already.*registered|ya.*registrado/i.test(mensaje)) {
    return { mensaje: 'Ese número ya está registrado en otra configuración.', codigo, subcodigo, accionable: true };
  }
  if (/verification|verify|verificaci/i.test(mensaje)) {
    return { mensaje: 'Falta completar la verificación del número en Meta.', codigo, subcodigo, accionable: true };
  }
  // Nada reconocido: no se inventa un motivo. Se dice lo que sabemos, que es
  // que no funcionó, y el detalle técnico queda en el log.
  return { mensaje: 'No pudimos completar la conexión con Meta.', codigo, subcodigo, accionable: false };
}

/**
 * Estado de la integración tal como lo puede ver un cliente.
 *
 * Deliberadamente NO devuelve access token, verify token, app secret, ni el
 * phone_number_id o el waba_id: son identificadores de nuestra plomería y el
 * cliente no los necesita para nada. Lo que sí ve es su número, su nombre
 * visible y si está recibiendo mensajes.
 */
export async function estadoWhatsappNegocio(negocioId) {
  const { rows } = await pool.query(
    `SELECT id, estado, display_phone_number, verified_name, estado_nombre, waba_id,
            identificador, numero_registrado_cloud_api, app_suscrita_waba,
            conectado_at, ultima_prueba_at, ultima_prueba_ok,
            ultimo_error_codigo, ultimo_error_at, ambiente
       FROM integraciones_canal
      WHERE negocio_id = $1 AND canal = 'whatsapp'
      ORDER BY principal DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [negocioId]);

  const fila = rows[0];
  if (!fila) {
    return {
      conectado: false,
      estado: 'no_conectado',
      numero: null,
      nombreVisible: null,
      estadoNombre: traducirEstadoNombre(null),
      wabaConfigurada: false,
      appSuscrita: false,
      numeroRegistrado: false,
      botActivo: false,
      ultimaVerificacion: null,
    };
  }

  const { rows: negocioRows } = await pool.query(
    `SELECT bot_whatsapp_activo FROM negocios WHERE id = $1`, [negocioId]);

  // 'conectado' significa que hay credenciales utilizables y la WABA está
  // suscrita. Un nombre visible en revisión NO lo desmiente: Meta permite
  // operar mientras revisa, y decirle al cliente que está roto cuando no lo
  // está es peor que no decir nada.
  // 'activo' es el unico estado en el que la integracion opera de verdad.
  // pendiente_activacion, error, suspendido y eliminado NO son conexiones
  // vivas, por mas que exista la fila.
  const conectado = Boolean(fila.waba_id) && fila.estado === 'activo';

  return {
    conectado,
    estado: fila.estado || 'desconocido',
    numero: fila.display_phone_number || null,
    nombreVisible: fila.verified_name || null,
    estadoNombre: traducirEstadoNombre(fila.estado_nombre),
    wabaConfigurada: Boolean(fila.waba_id),
    appSuscrita: Boolean(fila.app_suscrita_waba),
    numeroRegistrado: Boolean(fila.numero_registrado_cloud_api),
    botActivo: Boolean(negocioRows[0]?.bot_whatsapp_activo),
    conectadoEn: fila.conectado_at || null,
    ultimaVerificacion: fila.ultima_prueba_at || null,
    ultimaVerificacionOk: fila.ultima_prueba_ok ?? null,
    ambiente: fila.ambiente || null,
    // Se expone que HUBO un error y cuándo, nunca su contenido crudo.
    hayError: Boolean(fila.ultimo_error_codigo),
    ultimoErrorEn: fila.ultimo_error_at || null,
  };
}

// Claves que jamás pueden salir hacia el panel del negocio. La prueba
// automática recorre esta lista contra la respuesta real.
export const CLAVES_PROHIBIDAS = Object.freeze([
  'access_token', 'accessToken', 'token', 'verify_token', 'verifyToken',
  'app_secret', 'appSecret', 'client_secret', 'anthropic', 'api_key', 'apiKey',
  'pin', 'phone_number_id', 'phoneNumberId', 'waba_id', 'wabaId',
]);

/**
 * Recorre un objeto buscando cualquier cosa que huela a secreto. Existe para
 * que la prueba pueda afirmar "esta respuesta no filtra nada" sin depender de
 * que alguien recuerde revisarlo a mano cada vez que se añade un campo.
 */
export function buscarFugas(objeto, prohibidas = CLAVES_PROHIBIDAS) {
  const encontradas = [];
  const visitar = (valor, ruta) => {
    if (valor === null || typeof valor !== 'object') return;
    for (const [k, v] of Object.entries(valor)) {
      const rutaHija = ruta ? `${ruta}.${k}` : k;
      if (prohibidas.some(p => k.toLowerCase() === p.toLowerCase())) {
        encontradas.push(rutaHija);
      }
      visitar(v, rutaHija);
    }
  };
  visitar(objeto, '');
  return encontradas;
}
