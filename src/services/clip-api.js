// Clip — generación de enlaces de pago
// Docs: https://developer.clip.mx/reference/createnewpaymentlink
// Auth: Basic base64(CLIP_API_KEY:CLIP_API_SECRET)
//
// negocioId OBLIGATORIO en todas las funciones (Incidente P0, 2 de agosto
// de 2026): antes, este archivo resolvía las credenciales Clip desde una
// única variable/config GLOBAL (getIntegracion, server.js) -- causa raíz
// confirmada de que un cliente de WhatsApp de Alora recibiera un enlace
// de pago generado con la cuenta Clip real de Nonna Maye. Las credenciales
// ahora se resuelven exclusivamente por negocio (integracionesService.js,
// canal='pagos' proveedor='clip'). Sin negocioId, o sin Clip configurado
// para ESE negocio, estas funciones fallan cerrado -- nunca caen a otra
// cuenta ni a una variable de entorno global.
import { obtenerCredencialesClipDescifradas, TenantContextRequiredError } from './integracionesService.js';

export { TenantContextRequiredError };

// CLIP_API_BASE_URL: override EXCLUSIVO de pruebas (mock local de Clip,
// mismo patrón que META_GRAPH_BASE_URL/ANTHROPIC_BASE_URL). Producción no
// define la variable y usa la API real.
const CLIP_API_BASE = process.env.CLIP_API_BASE_URL || 'https://api.payclip.com';
const CLIP_CHECKOUT_URL = `${CLIP_API_BASE}/v2/checkout`;

// Código de error estable para que los llamadores (whatsapp-meta.js, voice.js)
// distingan "Clip no configurado para este negocio" (transferir a humano,
// conservar el pedido) de un error real de red/Clip (reintentable), y de
// TenantContextRequiredError (negocioId ausente/inválido -- bug del
// llamador, nunca un estado de negocio legítimo).
export class ClipNoConfiguradoError extends Error {
  constructor(negocioId) {
    super(`ClipNoConfiguradoError: no hay integración Clip activa para el negocio ${negocioId}`);
    this.code = 'CLIP_NO_CONFIGURADO';
  }
}

// Una expiración que no cumple el contrato de Clip se rechaza ANTES de mandar
// el POST: mandar un valor que el propio adaptador ya sabe inválido solo puede
// terminar en un 400 del proveedor o -- peor -- en un checkout con una
// expiración que no es la que Xabor cree.
export class ExpiracionInvalidaError extends Error {
  constructor(motivo) {
    super(`ExpiracionInvalidaError: ${motivo}`);
    this.code = 'EXPIRACION_INVALIDA';
  }
}

// ─── Expiración del checkout (contrato oficial de Clip) ─────────────────────
//
// Fuente: https://developer.clip.mx/reference/createnewpaymentlink
//   · `expires_at`: string "YYYY-MM-DDTHH:MM:SSZ" (UTC, maxLength 20 --
//     SEGUNDOS, sin milisegundos).
//   · "debe ser mayor a 00:01:00 minuto de la hora de creación de la
//     solicitud y menor a las 23:59:59 (hora de CDMX) del mismo día de
//     creación". Si se omite: default de 3 días.
//   · La respuesta de creación (y la reconsulta) devuelven `expired_at`.
//
// TODO el cálculo de aquí es independiente del timezone del proceso: se
// trabaja en épocas UTC y la única conversión de zona (el fin del día en
// CDMX) usa Intl con 'America/Mexico_City' explícito -- nunca la zona de
// Windows/Node/Postgres. Este proyecto ya pagó dos bugs reales de timezone
// (migración 063); no habrá un tercero por esta vía.

const TZ_CDMX = 'America/Mexico_City';
const CLIP_EXPIRACION_MARGEN_MIN_MS = 61 * 1000; // "> 00:01:00" + 1s de margen

/** Formatea un instante al formato EXACTO de Clip: UTC, segundos, 20 chars. */
export function formatearExpiracionClip(fecha) {
  const d = new Date(fecha);
  if (Number.isNaN(d.getTime())) throw new ExpiracionInvalidaError(`fecha no válida: ${fecha}`);
  // Piso a segundos: Clip no acepta milisegundos (maxLength 20).
  return new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function partesEnTZ(epochMs, tz) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(epochMs));
  const v = (t) => Number(p.find(x => x.type === t)?.value);
  // Intl puede dar hour '24' para medianoche en algunos entornos: normalizar.
  return { y: v('year'), mo: v('month'), d: v('day'), h: v('hour') % 24, mi: v('minute'), s: v('second') };
}

/** Época UTC del instante local (y,mo,d,h,mi,s) en la zona dada. */
function instanteUTCDeLocal(tz, y, mo, d, h, mi, s) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  // Punto fijo: converge en 1-2 pasos (CDMX no tiene DST desde 2022, pero no
  // se hardcodea el offset -- si el país lo vuelve a cambiar, esto sigue bien).
  for (let i = 0; i < 3; i++) {
    const p = partesEnTZ(guess, tz);
    const delta = Date.UTC(y, mo - 1, d, h, mi, s) - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

/** Época UTC de las 23:59:00 (hora CDMX) del día CDMX en que cae `ahora`. */
export function finDelDiaCDMXComoUTC(ahora = new Date()) {
  const hoy = partesEnTZ(new Date(ahora).getTime(), TZ_CDMX);
  // 23:59:00, no :59:59 -- margen de 59s por debajo del límite documentado
  // para que un redondeo del proveedor jamás lo rebase.
  return instanteUTCDeLocal(TZ_CDMX, hoy.y, hoy.mo, hoy.d, 23, 59, 0);
}

/**
 * Valida y acota una expiración contra los límites oficiales de Clip.
 * Devuelve { texto, epochMs, ajustadaPorLimite } listo para el POST.
 *
 * Lanza ExpiracionInvalidaError SIEMPRE que no exista un expires_at válido:
 *   · entrada inválida o ya no futura (bug del llamador);
 *   · creación en el último minuto del día CDMX, donde NINGÚN valor cumple
 *     simultáneamente "> creación + 1 min" y "< 23:59:59 CDMX del mismo
 *     día" (CLIP-A, auditoría independiente). La versión anterior aquí
 *     OMITÍA el campo y dejaba que Clip creara el checkout con su default
 *     de 3 DÍAS -- exactamente el bug original que este bloque vino a
 *     cerrar, reproducido en rojo con el flujo productivo real (POST
 *     capturado sin expires_at). Sin ventana válida: CERO POST, CERO
 *     checkout, ninguna URL al cliente -- y sin esperar el 400 de Clip.
 */
export function prepararExpiracionClip(expiresAt, ahora = new Date()) {
  const d = new Date(expiresAt);
  if (expiresAt == null || Number.isNaN(d.getTime())) {
    throw new ExpiracionInvalidaError(`expiresAt no es una fecha válida: ${expiresAt}`);
  }
  const ahoraMs = new Date(ahora).getTime();
  if (d.getTime() <= ahoraMs + CLIP_EXPIRACION_MARGEN_MIN_MS) {
    throw new ExpiracionInvalidaError(
      `expiresAt (${d.toISOString()}) no queda al menos 61s en el futuro: Clip exige > 1 minuto desde la creación`);
  }
  const tope = finDelDiaCDMXComoUTC(ahora);
  if (tope <= ahoraMs + CLIP_EXPIRACION_MARGEN_MIN_MS) {
    throw new ExpiracionInvalidaError(
      `sin_ventana_valida_clip: en este instante (${new Date(ahoraMs).toISOString()}) no existe ningún expires_at que cumpla a la vez "> creación + 1 min" y "< fin del día CDMX" -- no se crea el checkout (jamás se deja el default de 3 días del proveedor)`);
  }
  if (d.getTime() > tope) {
    return { texto: formatearExpiracionClip(tope), epochMs: Math.floor(tope / 1000) * 1000, ajustadaPorLimite: true };
  }
  return { texto: formatearExpiracionClip(d), epochMs: Math.floor(d.getTime() / 1000) * 1000, ajustadaPorLimite: false };
}

async function obtenerAuthHeader(negocioId) {
  // Chequeo explícito aquí ADEMÁS del que ya hace
  // obtenerCredencialesClipDescifradas (defensa en profundidad, falla
  // antes de tocar la base de datos) -- misma clase de error tipado en
  // ambas capas, nunca un Error genérico ni un null silencioso.
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw new TenantContextRequiredError('clip-api.obtenerAuthHeader');
  }
  const credenciales = await obtenerCredencialesClipDescifradas(negocioId.trim());
  if (!credenciales) {
    throw new ClipNoConfiguradoError(negocioId.trim());
  }
  const b64 = Buffer.from(`${credenciales.apiKey}:${credenciales.apiSecret}`).toString('base64');
  return `Basic ${b64}`;
}

/**
 * Consulta el estado actual de un link de pago en Clip. Devuelve
 * { resource_status, me_reference_id } o null si falla o no hay
 * integración configurada para ese negocio (no lanza -- uso desde jobs
 * de reconciliación en background, nunca debe tumbar el proceso).
 */
export async function consultarEstadoPago(linkId, negocioId) {
  try {
    const auth = await obtenerAuthHeader(negocioId);
    const resp = await fetch(`${CLIP_CHECKOUT_URL}/${linkId}`, {
      headers: { 'Authorization': auth }
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Crea un link de pago en Clip y devuelve la URL lista para enviar al cliente.
 *
 * @param {object} opts
 * @param {string}  opts.negocioId       - Negocio dueño del pedido (obligatorio)
 * @param {string}  opts.pedidoId        - ID del pedido (referencia interna)
 * @param {number}  opts.total           - Monto a cobrar (MXN)
 * @param {string}  [opts.descripcion]   - Texto visible para el cliente en el checkout
 * @param {object}  [opts.cliente]       - { nombre, telefono }
 * @returns {Promise<{ linkId: string, url: string, status: string }>}
 * @throws {ClipNoConfiguradoError} si el negocio no tiene Clip configurado/activo
 */
export async function crearLinkDePago({ negocioId, pedidoId, total, descripcion, cliente = {}, referenciaExterna, expiresAt = null }) {
  // La expiración se valida ANTES de resolver credenciales o salir a la red:
  // un expiresAt inválido es un bug del llamador y jamás debe producir un
  // POST. Si el llamador no manda expiresAt (caminos legacy: programados aún
  // no activados), el campo se omite y Clip aplica su default -- comportamiento
  // idéntico al histórico, sin fingir una frontera que nadie calculó.
  // Reloj inyectable SOLO en pruebas (mismo doble candado que el resto de la
  // inyeccion de fallos del proyecto): las suites de fin-de-dia CDMX serian
  // no deterministas si dependieran de la hora real a la que corre el test.
  // Produccion nunca define la variable y usa el reloj real.
  const ahoraClip = (process.env.NODE_ENV !== 'production' && process.env.XABOR_TEST_CLIP_AHORA)
    ? new Date(process.env.XABOR_TEST_CLIP_AHORA) : new Date();

  let expiracion = null;
  if (expiresAt != null) {
    expiracion = prepararExpiracionClip(expiresAt, ahoraClip); // lanza ExpiracionInvalidaError
  }

  // Clip metadata.external_reference: String, MAXIMO 36 caracteres (contrato
  // oficial v2). Se valida ANTES de resolver credenciales o salir a la red, y
  // JAMAS se trunca: una referencia recortada dejaria de identificar la fila.
  const externalReference = String(referenciaExterna || pedidoId || '');
  if (!externalReference || externalReference.length > 36) {
    const e = new Error(`external_reference invalida para Clip (${externalReference.length} caracteres, maximo 36): no se manda el POST`);
    e.code = 'REFERENCIA_PROVEEDOR_INVALIDA';
    throw e;
  }

  const auth = await obtenerAuthHeader(negocioId);

  const baseUrl    = process.env.PUBLIC_URL || 'https://xabor.up.railway.app';
  const webhookUrl = `${baseUrl}/webhook/clip`;
  const paginaGracias = `${baseUrl}/pago/gracias`;

  const body = {
    amount: Number(total),
    currency: 'MXN',
    purchase_description: descripcion || 'Pedido Xabor',
    redirection_url: {
      success: paginaGracias,
      error:   paginaGracias,
      default: paginaGracias
    },
    webhook_url: webhookUrl,
    metadata: {
      // Clip metadata.external_reference: maximo 36 caracteres (contrato
      // oficial). El camino moderno (pagosService via clipProvider) manda
      // pagos.id (UUID, exactamente 36); los llamadores legacy (programados
      // aun no activados en whatsapp-meta.js) siguen mandando el folio.
      // Validada arriba antes de salir a la red; nunca truncada.
      external_reference: externalReference,
      customer_info: {}
    }
  };

  if (cliente.nombre)   body.metadata.customer_info.name  = cliente.nombre;
  if (cliente.telefono) body.metadata.customer_info.phone = Number(String(cliente.telefono).replace(/\D/g, ''));
  if (expiracion) body.expires_at = expiracion.texto;

  const resp = await fetch(CLIP_CHECKOUT_URL, {
    method:  'POST',
    headers: {
      'Authorization': auth,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Clip ${resp.status}: ${err.message || JSON.stringify(err)}`);
  }

  const data = await resp.json();
  console.log(`[Clip] Link creado para pedido ${pedidoId} (negocio ${negocioId}): ${data.payment_request_url}`);

  return {
    linkId: data.payment_request_id,
    url:    data.payment_request_url,
    status: data.status,
    // Rastro de expiración para el llamador (clipProvider): lo SOLICITADO
    // (ya acotado a los límites de Clip), lo que el proveedor DEVOLVIÓ como
    // frontera PROGRAMADA, y si hubo que acotar por el tope del día CDMX.
    //
    // CLIP-D (auditoría independiente): el objeto checkout v2 documenta
    // `expires_at` (frontera programada -- ejemplo oficial
    // "2024-10-26T13:17:00Z" en la introducción de Clip Checkout);
    // `expired_at` es OTRO campo, del contrato del WEBHOOK, que significa
    // "instante en que YA expiró". La versión anterior leía `data.expired_at`
    // aquí y trataba una respuesta v2 real (solo expires_at) como
    // "expiración no verificable", ocultando una URL perfectamente válida.
    // NOTA de compatibilidad documentada: los schemas de REFERENCIA de
    // creación/GET (createnewpaymentlink / checkpaymentlinkstatus) todavía
    // listan `expired_at` con ejemplo antiguo ("2020-04-30...") y
    // descripción de frontera programada -- una inconsistencia interna de la
    // documentación. Se obedece el contrato v2 (`expires_at`) y NO se usa
    // `expired_at` como alias silencioso: si una respuesta trajera solo el
    // nombre viejo, el flujo cae al camino verificado (reconsulta y, en
    // última instancia, fail-closed con revisión) -- nunca fail-open.
    expiracionSolicitada: expiracion ? expiracion.texto : null,
    expiracionAjustadaPorLimite: expiracion?.ajustadaPorLimite === true,
    expiracionProveedor: data.expires_at || null,
  };
}
