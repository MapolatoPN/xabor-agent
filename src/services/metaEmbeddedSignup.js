// Cliente mínimo de Meta para Embedded Signup (Fase C). Solo implementa
// el intercambio de código OAuth -- único paso cuyo endpoint/parámetros
// están confirmados y documentados de forma estable en la API de Meta.
// El resto de los identificadores (phone_number_id, waba_id, business_id,
// display_phone_number) los entrega el SDK de Embedded Signup al
// frontend directamente (postMessage), no se vuelven a consultar aquí --
// evita inventar llamadas/parámetros de Graph API no confirmados en
// este repositorio (p. ej. suscripción de la app al WABA vía
// /{waba_id}/subscribed_apps, necesaria antes de operar en vivo, pero
// fuera del alcance mínimo de esta fase: no se activa el bot todavía).
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

function logRechazoMeta(etapa, detalles) {
  const { codigo, tipo, mensaje, httpStatus } = detalles;
  console.error(
    `[MetaEmbeddedSignup] Intercambio code->token rechazado -- etapa=${etapa}` +
    (httpStatus != null ? ` http_status=${httpStatus}` : '') +
    ` codigo=${codigo} tipo=${tipo} mensaje="${mensaje}"`
  );
}

export async function intercambiarCodigoPorToken(code) {
  if (typeof code !== 'string' || !code.trim()) {
    throw new Error('intercambiarCodigoPorToken: code requerido');
  }
  if (process.env.META_EMBEDDED_SIGNUP_MOCK === 'true') {
    if (CODIGOS_SIMULADOS_EXITO.has(code)) return { accessToken: 'SIMULATED_ACCESS_TOKEN_TEST' };
    const errorSimulado = CODIGOS_SIMULADOS_ERROR_META[code];
    if (errorSimulado) {
      logRechazoMeta('token_exchange_simulado', resumirErrorMeta({ error: errorSimulado }));
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
    logRechazoMeta('token_exchange', { ...resumirErrorMeta(body), httpStatus: resp.status });
    throw new Error('intercambiarCodigoPorToken: Meta rechazó el intercambio de código');
  }
  return { accessToken: body.access_token };
}
