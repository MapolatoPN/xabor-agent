// metaGraph.js — único punto de salida hacia la Graph API de Meta para los
// módulos NUEVOS del programa Tech Provider (verificación de activos,
// desconexión, diagnóstico de formularios, tablero de Superadmin).
//
// Por qué existe: la versión de la Graph API está escrita a mano en ~15
// lugares (`v20.0`), varios dentro de archivos protegidos
// (whatsapp-meta.js). Este módulo NO los toca: los módulos nuevos salen por
// aquí y la migración de los viejos queda como trabajo aparte, con su propia
// aprobación (ver META_INTEGRATION.md, «Versión de la Graph API»).
//
// Versión por omisión: v25.0. La v20.0 que usa el resto del código CADUCÓ
// el 24-sep-2026; Meta contesta esas llamadas con la versión vigente más
// antigua (v21.0, que caduca el 21-ene-2027, después v22.0). Para los
// módulos nuevos se fija una versión vigente y explícita (v25.0 vence el
// 29-jul-2028), en vez de heredar una que Meta cambia por su cuenta. Lo que
// llaman (debug_token, phone_numbers, flows, subscribed_apps) es estable
// entre esas versiones.
//
// Reglas:
// - Nunca registra ni devuelve un access token, el secreto de la app ni la
//   URL completa de una llamada (las de /debug_token llevan credenciales).
// - Nunca lanza por un rechazo de Meta: devuelve { ok:false, error } con el
//   código/subcódigo/tipo y un mensaje truncado. Solo lanza por parámetros
//   inválidos (error de programación).
// - En producción solo habla con https://graph.facebook.com. La variable
//   META_GRAPH_BASE_URL (servidor simulado de las pruebas) se ignora ahí:
//   apuntarla a otro host le mandaría las credenciales de los negocios.

export const GRAPH_VERSION_POR_OMISION = 'v25.0';
const BASE_OFICIAL = 'https://graph.facebook.com';
const TIEMPO_MAXIMO_MS = 15 * 1000;

/** Versión efectiva. META_GRAPH_VERSION solo se acepta con forma vNN.0. */
export function versionGraph() {
  const v = String(process.env.META_GRAPH_VERSION || '').trim();
  return /^v\d{2,3}\.0$/.test(v) ? v : GRAPH_VERSION_POR_OMISION;
}

export function baseGraph() {
  if (process.env.NODE_ENV === 'production') return BASE_OFICIAL;
  const b = String(process.env.META_GRAPH_BASE_URL || '').trim().replace(/\/+$/, '');
  return b || BASE_OFICIAL;
}

/** Credencial de app para /debug_token. null si falta alguna variable. */
export function tokenDeApp() {
  const id = process.env.META_APP_ID, secreto = process.env.META_APP_SECRET;
  return id && secreto ? `${id}|${secreto}` : null;
}

// Un id de Graph es numérico. Validarlo impide que un valor que llega del
// navegador (phone_number_id, waba_id) arme una ruta distinta a la esperada
// (`123/../me`, `123?fields=...`).
export function esIdGraph(v) {
  return typeof v === 'string' && /^\d{5,30}$/.test(v.trim());
}

/** Resumen apto para log y para la base: nunca el cuerpo crudo. */
export function resumirErrorMeta(body, status = null) {
  const err = (body && typeof body === 'object' && body.error) || {};
  return {
    status,
    codigo: Number.isFinite(err.code) ? err.code : null,
    subcodigo: Number.isFinite(err.error_subcode) ? err.error_subcode : null,
    tipo: typeof err.type === 'string' ? err.type.slice(0, 60) : null,
    mensaje: typeof err.message === 'string' ? redactar(err.message).slice(0, 200) : null,
  };
}

/**
 * Quita de un texto lo que parezca credencial o dato personal antes de que
 * llegue a un log: tokens de Meta (EAA…), cadenas largas tipo secreto y
 * números de teléfono completos (se deja la cola de 4 dígitos).
 */
export function redactar(texto) {
  return String(texto ?? '')
    .replace(/EAA[A-Za-z0-9]{20,}/g, '[token]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[secreto]')
    .replace(/\+?\d{6,}(\d{4})\b/g, '…$1');
}

/**
 * Llamada a la Graph API.
 * @param {object} o
 * @param {'GET'|'POST'|'DELETE'} [o.metodo]
 * @param {string} o.ruta    sin versión ni barra inicial, p. ej. `123/phone_numbers`
 * @param {string} [o.token] Bearer; para /debug_token va en params
 * @param {object} [o.params] query string
 * @param {object} [o.cuerpo] JSON
 * @param {Function} [o.fetchImpl] inyectable para pruebas sin red
 */
export async function llamarGraph({ metodo = 'GET', ruta, token = null, params = null, cuerpo = null, timeoutMs = TIEMPO_MAXIMO_MS, fetchImpl = fetch } = {}) {
  if (typeof ruta !== 'string' || !ruta || ruta.startsWith('/') || /\.\.|[?#\s]/.test(ruta)) {
    throw new Error('llamarGraph: ruta inválida');
  }
  if (!['GET', 'POST', 'DELETE'].includes(metodo)) throw new Error('llamarGraph: método inválido');
  const url = new URL(`${baseGraph()}/${versionGraph()}/${ruta}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cuerpo) headers['Content-Type'] = 'application/json';
  let resp, body;
  try {
    resp = await fetchImpl(url.toString(), {
      method: metodo, headers,
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await resp.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, status: null, datos: null, error: { status: null, codigo: null, subcodigo: null, tipo: e?.name === 'TimeoutError' ? 'tiempo' : 'red', mensaje: 'no se pudo contactar a Meta' } };
  }
  if (!resp.ok || (body && body.error)) {
    return { ok: false, status: resp.status, datos: null, error: resumirErrorMeta(body, resp.status) };
  }
  return { ok: true, status: resp.status, datos: body, error: null };
}

/** Recorre una lista paginada de Graph (data + paging.next), con tope. */
export async function listarGraph({ ruta, token, params = {}, maxPaginas = 5, fetchImpl = fetch }) {
  const elementos = [];
  let despues = null;
  for (let i = 0; i < maxPaginas; i++) {
    const r = await llamarGraph({ ruta, token, params: { limit: 100, ...params, ...(despues ? { after: despues } : {}) }, fetchImpl });
    if (!r.ok) return { ok: false, elementos, error: r.error };
    elementos.push(...(Array.isArray(r.datos?.data) ? r.datos.data : []));
    despues = r.datos?.paging?.cursors?.after && r.datos?.paging?.next ? r.datos.paging.cursors.after : null;
    if (!despues) break;
  }
  return { ok: true, elementos, error: null };
}
