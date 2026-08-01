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
// - META_REDIRECT_URI: debe coincidir exactamente con la configurada en Meta.

export const GRAPH_VERSION = 'v20.0';

// Simulación explícita para pruebas (Fase C, punto 7) -- solo se activa
// con META_EMBEDDED_SIGNUP_MOCK='true', nunca en producción. Nunca llama
// a la red real cuando está activa.
const CODIGOS_SIMULADOS = new Set(['SIMULAR_EXITO']);

export async function intercambiarCodigoPorToken(code) {
  if (typeof code !== 'string' || !code.trim()) {
    throw new Error('intercambiarCodigoPorToken: code requerido');
  }
  if (process.env.META_EMBEDDED_SIGNUP_MOCK === 'true') {
    if (CODIGOS_SIMULADOS.has(code)) return { accessToken: 'SIMULATED_ACCESS_TOKEN_TEST' };
    throw new Error('intercambiarCodigoPorToken (simulado): Meta rechazó el intercambio de código');
  }
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI;
  if (!appId || !appSecret || !redirectUri) {
    throw new Error('intercambiarCodigoPorToken: META_APP_ID/META_APP_SECRET/META_REDIRECT_URI no configuradas');
  }

  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code', code.trim());

  const resp = await fetch(url.toString());
  const body = await resp.json();
  if (!resp.ok || !body.access_token) {
    // Nunca se incluye `code` ni ningún campo del cuerpo crudo de Meta en
    // el error -- podría contener datos sensibles del intercambio.
    throw new Error('intercambiarCodigoPorToken: Meta rechazó el intercambio de código');
  }
  return { accessToken: body.access_token };
}
