// Cliente mínimo de Meta para Embedded Signup (Fase C) y para la
// activación real posterior (Fase de activación Cloud API).
//
// El intercambio de código OAuth entrega un access_token, pero eso NO
// deja al número operable en Meta -- confirmado con un segundo incidente
// real (negocio Alora, 2 de agosto de 2026): Xabor guardó token +
// phone_number_id + waba_id correctamente, pero el número quedó en Meta
// con estado "Pendiente" (una sola palomita al enviar, cero webhooks
// recibidos) porque faltaban dos llamadas adicionales, obligatorias y
// documentadas por Meta para Cloud API:
//   1. POST /{PHONE_NUMBER_ID}/register -- registra el número para Cloud
//      API con un PIN de verificación en dos pasos.
//   2. POST /{WABA_ID}/subscribed_apps -- suscribe esta app a la WABA;
//      sin esto Meta nunca envía webhooks entrantes.
// Por eso guardarCredencialesCifradas() ya NO marca 'activo' solo por
// tener token + phone_number_id (ver integracionesService.js) -- ambos
// pasos deben confirmarse antes.
//
// El resto de los identificadores (phone_number_id, waba_id, business_id,
// display_phone_number) los entrega el SDK de Embedded Signup al
// frontend directamente (postMessage), no se vuelven a consultar aquí.
//
// Variables requeridas (nunca se imprime su valor):
// - META_APP_ID: ID de la app de Meta registrada para Xabor.
// - META_APP_SECRET: secreto de esa app, usado para firmar el intercambio OAuth.
//
// El `code` de Embedded Signup lo entrega el SDK de JavaScript (FB.login)
// dentro de la misma página -- a diferencia del OAuth clásico basado en
// redirección HTTP, este código no está atado a un redirect_uri. Enviar
// redirect_uri en este intercambio (como se hacía antes) provoca que Meta
// lo rechace; confirmado como causa raíz de un incidente real en
// producción (negocio Alora, 1 de agosto de 2026 -- Meta completaba el
// flujo del lado del usuario pero el intercambio code->token siempre
// fallaba con "Meta rechazó el intercambio de código", reproducido dos
// veces seguidas). Por eso ya no se envía aquí.

export const GRAPH_VERSION = 'v20.0';

// Simulación explícita para pruebas (Fase C, punto 7) -- solo se activa
// con META_EMBEDDED_SIGNUP_MOCK='true', nunca en producción. Nunca llama
// a la red real cuando está activa.
const CODIGOS_SIMULADOS_EXITO = new Set(['SIMULAR_EXITO']);
// Simula la FORMA real de un rechazo de Meta (código/tipo/mensaje) para
// poder probar el logging seguro sin depender de la red real ni de
// reproducir el incidente contra Meta de nuevo.
const CODIGOS_SIMULADOS_ERROR_META = {
  SIMULAR_ERROR_META: { code: 100, type: 'OAuthException', message: 'Error validating verification code.' },
};

// Extrae solo lo necesario para diagnosticar (código numérico, tipo,
// mensaje truncado) del cuerpo de error que devuelve Meta. Deliberadamente
// NUNCA se propaga el cuerpo completo -- puede incluir fbtrace_id u otros
// campos no pensados para quedar en logs, y el mensaje se trunca por si
// Meta algún día decide incluir algo más largo de lo esperado.
function resumirErrorMeta(body) {
  const err = (body && typeof body === 'object' && body.error) || {};
  return {
    codigo: typeof err.code === 'number' ? err.code : null,
    tipo: typeof err.type === 'string' ? err.type.slice(0, 60) : null,
    mensaje: typeof err.message === 'string' ? err.message.slice(0, 200) : null,
  };
}

function logRechazoMeta(accion, etapa, detalles) {
  const { codigo, tipo, mensaje, httpStatus } = detalles;
  console.error(
    `[MetaEmbeddedSignup] ${accion} -- etapa=${etapa}` +
    (httpStatus != null ? ` http_status=${httpStatus}` : '') +
    ` codigo=${codigo} tipo=${tipo} mensaje="${mensaje}"`
  );
}

function logExitoMeta(accion, etapa, httpStatus) {
  console.log(`[MetaEmbeddedSignup] ${accion} -- etapa=${etapa} http_status=${httpStatus} resultado=ok`);
}

export async function intercambiarCodigoPorToken(code) {
  if (typeof code !== 'string' || !code.trim()) {
    throw new Error('intercambiarCodigoPorToken: code requerido');
  }
  if (process.env.META_EMBEDDED_SIGNUP_MOCK === 'true') {
    if (CODIGOS_SIMULADOS_EXITO.has(code)) return { accessToken: 'SIMULATED_ACCESS_TOKEN_TEST' };
    const errorSimulado = CODIGOS_SIMULADOS_ERROR_META[code];
    if (errorSimulado) {
      logRechazoMeta('Intercambio code->token rechazado', 'token_exchange_simulado', resumirErrorMeta({ error: errorSimulado }));
      throw new Error('intercambiarCodigoPorToken: Meta rechazó el intercambio de código');
    }
    throw new Error('intercambiarCodigoPorToken (simulado): Meta rechazó el intercambio de código');
  }
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('intercambiarCodigoPorToken: META_APP_ID/META_APP_SECRET no configuradas');
  }

  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('code', code.trim());

  let resp, body;
  try {
    resp = await fetch(url.toString());
    body = await resp.json();
  } catch (e) {
    console.error('[MetaEmbeddedSignup] Fallo de red al contactar a Meta -- etapa=token_exchange_red');
    throw new Error('intercambiarCodigoPorToken: no se pudo contactar a Meta');
  }
  if (!resp.ok || !body.access_token) {
    // Nunca se incluye `code`, el access_token, ni el cuerpo crudo
    // completo de Meta en el log ni en el error -- solo el
    // código/tipo/mensaje resumido, que es información de diagnóstico,
    // no una credencial ni un dato de autenticación.
    logRechazoMeta('Intercambio code->token rechazado', 'token_exchange', { ...resumirErrorMeta(body), httpStatus: resp.status });
    throw new Error('intercambiarCodigoPorToken: Meta rechazó el intercambio de código');
  }
  return { accessToken: body.access_token };
}

// ── Registro del número para Cloud API (POST /{PHONE_NUMBER_ID}/register) ──
// Requiere un PIN de verificación en dos pasos: la PRIMERA vez que se
// registra un número, cualquier PIN de 6 dígitos que se envíe queda fijo
// como el PIN de 2FA de ese número en Meta; en registros posteriores
// (p. ej. tras una reactivación) Meta exige exactamente el MISMO PIN --
// por eso el llamador (completarActivacionWhatsapp) genera el PIN una
// sola vez y lo reutiliza cifrado en reintentos, nunca uno nuevo cada vez.
//
// Nunca lanza por un rechazo de Meta -- devuelve {ok:false, ...} para que
// el llamador pueda seguir con el paso de suscripción y reportar ambos
// resultados juntos. Solo lanza por parámetros inválidos (error de
// programación, no de Meta).
const IDS_SIMULADOS_REGISTRO_ERROR = new Set(['PNID_REGISTRO_RECHAZADO']);
const ERROR_SIMULADO_REGISTRO = { code: 100, type: 'OAuthException', message: 'Phone number needs to be verified before registering.' };

export async function registrarNumeroCloudApi(phoneNumberId, accessToken, pin) {
  if (typeof phoneNumberId !== 'string' || !phoneNumberId.trim()) {
    throw new Error('registrarNumeroCloudApi: phoneNumberId requerido');
  }
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('registrarNumeroCloudApi: accessToken requerido');
  }
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
    throw new Error('registrarNumeroCloudApi: pin requerido (6 dígitos)');
  }

  if (process.env.META_EMBEDDED_SIGNUP_MOCK === 'true') {
    if (IDS_SIMULADOS_REGISTRO_ERROR.has(phoneNumberId.trim())) {
      logRechazoMeta('Registro de número (Cloud API) rechazado', 'registro_numero_simulado', resumirErrorMeta({ error: ERROR_SIMULADO_REGISTRO }));
      return { ok: false, status: 400, resumen: resumirErrorMeta({ error: ERROR_SIMULADO_REGISTRO }) };
    }
    logExitoMeta('Registro de número (Cloud API)', 'registro_numero_simulado', 200);
    return { ok: true, status: 200, resumen: { success: true } };
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(phoneNumberId.trim())}/register`;
  let resp, body;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken.trim()}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
    body = await resp.json();
  } catch (e) {
    console.error('[MetaEmbeddedSignup] Fallo de red al contactar a Meta -- etapa=registro_numero_red');
    return { ok: false, status: null, resumen: { codigo: null, tipo: 'red', mensaje: 'no se pudo contactar a Meta' } };
  }
  if (!resp.ok || body.success !== true) {
    const resumen = resumirErrorMeta(body);
    logRechazoMeta('Registro de número (Cloud API) rechazado', 'registro_numero', { ...resumen, httpStatus: resp.status });
    return { ok: false, status: resp.status, resumen };
  }
  logExitoMeta('Registro de número (Cloud API)', 'registro_numero', resp.status);
  return { ok: true, status: resp.status, resumen: { success: true } };
}

// ── Suscripción de la app a la WABA (POST /{WABA_ID}/subscribed_apps) ──
// Sin este paso Meta nunca envía webhooks entrantes a la app, aunque el
// número esté correctamente registrado -- son dos requisitos
// independientes. Mismas reglas de logging que registrarNumeroCloudApi:
// nunca lanza por un rechazo de Meta, nunca registra el access_token.
const IDS_SIMULADOS_SUSCRIPCION_ERROR = new Set(['WABA_SUSCRIPCION_RECHAZADA']);
const ERROR_SIMULADO_SUSCRIPCION = { code: 200, type: 'OAuthException', message: 'Insufficient permission to subscribe app to this WABA.' };

export async function suscribirAppWaba(wabaId, accessToken) {
  if (typeof wabaId !== 'string' || !wabaId.trim()) {
    throw new Error('suscribirAppWaba: wabaId requerido');
  }
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('suscribirAppWaba: accessToken requerido');
  }

  if (process.env.META_EMBEDDED_SIGNUP_MOCK === 'true') {
    if (IDS_SIMULADOS_SUSCRIPCION_ERROR.has(wabaId.trim())) {
      logRechazoMeta('Suscripción de app a WABA rechazada', 'subscribed_apps_simulado', resumirErrorMeta({ error: ERROR_SIMULADO_SUSCRIPCION }));
      return { ok: false, status: 400, resumen: resumirErrorMeta({ error: ERROR_SIMULADO_SUSCRIPCION }) };
    }
    logExitoMeta('Suscripción de app a WABA', 'subscribed_apps_simulado', 200);
    return { ok: true, status: 200, resumen: { success: true } };
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(wabaId.trim())}/subscribed_apps`;
  let resp, body;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken.trim()}` },
    });
    body = await resp.json();
  } catch (e) {
    console.error('[MetaEmbeddedSignup] Fallo de red al contactar a Meta -- etapa=subscribed_apps_red');
    return { ok: false, status: null, resumen: { codigo: null, tipo: 'red', mensaje: 'no se pudo contactar a Meta' } };
  }
  if (!resp.ok || body.success !== true) {
    const resumen = resumirErrorMeta(body);
    logRechazoMeta('Suscripción de app a WABA rechazada', 'subscribed_apps', { ...resumen, httpStatus: resp.status });
    return { ok: false, status: resp.status, resumen };
  }
  logExitoMeta('Suscripción de app a WABA', 'subscribed_apps', resp.status);
  return { ok: true, status: resp.status, resumen: { success: true } };
}
