// metaActivos.js — qué activos de WhatsApp concedió DE VERDAD el negocio al
// terminar Embedded Signup, preguntándoselo a Meta con la credencial recién
// obtenida.
//
// El callback recibe `phoneNumberId` y `wabaId` del navegador (los manda el
// SDK de Meta por postMessage). Son buenos datos, pero llegan por el cliente.
// Este módulo los contrasta con lo que Meta dice del token:
//
//   1. GET /debug_token (con la credencial de la APP): que el token sea
//      válido, que sea de ESTA app, qué permisos trae, qué cuentas de
//      WhatsApp Business (WABA) cubre (`granular_scopes[].target_ids`) y
//      cuándo vence (`expires_at`; 0 = no vence).
//   2. GET /{WABA_ID}/phone_numbers (con el token del negocio): que el número
//      exista dentro de esa WABA, y su número visible y nombre aprobado.
//
// Si el navegador no mandó los ids (el postMessage llega tarde o no llega),
// se pueden DESCUBRIR por las mismas dos lecturas: la WABA es la primera de
// `target_ids` (como indica la guía de Embedded Signup) y el número, el único
// de esa WABA; con varios números no se adivina.
//
// Nunca lanza por un rechazo de Meta y nunca devuelve el token. Las llamadas
// a Meta son solo lecturas.
import { llamarGraph, tokenDeApp, esIdGraph } from './metaGraph.js';

export const PERMISOS_WHATSAPP = Object.freeze(['whatsapp_business_management', 'whatsapp_business_messaging']);

// Motivos cerrados: la ruta los traduce para el cliente y la auditoría los
// guarda tal cual. Un motivo nuevo se agrega aquí, no se inventa en la ruta.
export const MOTIVOS = Object.freeze({
  SIN_CREDENCIAL_APP: 'sin_credencial_app',
  META_NO_RESPONDE: 'meta_no_responde',
  TOKEN_INVALIDO: 'token_invalido',
  TOKEN_DE_OTRA_APP: 'token_de_otra_app',
  SIN_PERMISO_WHATSAPP: 'sin_permiso_whatsapp',
  WABA_NO_CONCEDIDA: 'waba_no_concedida',
  NUMEROS_ILEGIBLES: 'numeros_ilegibles',
  NUMERO_NO_PERTENECE: 'numero_no_pertenece',
  NUMERO_AMBIGUO: 'numero_ambiguo',
  ID_MALFORMADO: 'id_malformado',
});

export const MENSAJE_CLIENTE = Object.freeze({
  [MOTIVOS.SIN_CREDENCIAL_APP]: 'La conexión con Meta no está configurada en Xabor. Avísanos para revisarla.',
  [MOTIVOS.META_NO_RESPONDE]: 'Meta no respondió a tiempo. Intenta de nuevo en unos minutos.',
  [MOTIVOS.TOKEN_INVALIDO]: 'Meta no confirmó el permiso que diste. Vuelve a intentar la conexión.',
  [MOTIVOS.TOKEN_DE_OTRA_APP]: 'El permiso no corresponde a Xabor. Vuelve a intentar desde Xabor.',
  [MOTIVOS.SIN_PERMISO_WHATSAPP]: 'No se concedieron los permisos de WhatsApp. Vuelve a conectar y acepta todos los permisos.',
  [MOTIVOS.WABA_NO_CONCEDIDA]: 'La cuenta de WhatsApp elegida no está entre las que autorizaste. Vuelve a conectar.',
  [MOTIVOS.NUMEROS_ILEGIBLES]: 'No pudimos leer los números de tu cuenta de WhatsApp. Intenta de nuevo.',
  [MOTIVOS.NUMERO_NO_PERTENECE]: 'Ese número no pertenece a la cuenta de WhatsApp que autorizaste.',
  [MOTIVOS.NUMERO_AMBIGUO]: 'Tu cuenta de WhatsApp tiene varios números. Vuelve a conectar eligiendo uno.',
  [MOTIVOS.ID_MALFORMADO]: 'La respuesta de Meta llegó incompleta. Vuelve a intentar la conexión.',
});

const limpio = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Lee /debug_token. Devuelve lo útil, nunca el token.
 * { ok, motivo?, appId, tipo, venceAt, nunca, permisos[], wabasConcedidas[] }
 */
export async function leerConcesion({ accessToken, fetchImpl } = {}) {
  const app = tokenDeApp();
  if (!app) return { ok: false, motivo: MOTIVOS.SIN_CREDENCIAL_APP };
  const r = await llamarGraph({ ruta: 'debug_token', params: { input_token: accessToken, access_token: app }, fetchImpl });
  if (!r.ok) return { ok: false, motivo: r.status ? MOTIVOS.TOKEN_INVALIDO : MOTIVOS.META_NO_RESPONDE, error: r.error };
  const d = r.datos?.data;
  if (!d || d.is_valid !== true) return { ok: false, motivo: MOTIVOS.TOKEN_INVALIDO };
  if (String(d.app_id || '') !== String(process.env.META_APP_ID || '')) return { ok: false, motivo: MOTIVOS.TOKEN_DE_OTRA_APP };

  const permisos = Array.isArray(d.scopes) ? d.scopes.filter(s => typeof s === 'string') : [];
  // Las cuentas concedidas salen SOLO del permiso de administración: es el
  // que se otorga por WABA. Mezclar los target_ids de otro permiso podría
  // contar como «cuenta» un id que no lo es y volver ambigua una concesión
  // de una sola cuenta.
  const wabas = new Set();
  for (const g of Array.isArray(d.granular_scopes) ? d.granular_scopes : []) {
    if (g?.scope !== 'whatsapp_business_management') continue;
    for (const t of Array.isArray(g.target_ids) ? g.target_ids : []) if (esIdGraph(String(t))) wabas.add(String(t));
  }
  const vence = Number(d.expires_at);
  return {
    ok: true,
    appId: String(d.app_id),
    tipo: typeof d.type === 'string' ? d.type : null,
    venceAt: vence > 0 ? new Date(vence * 1000).toISOString() : null,
    nunca: vence === 0,
    permisos,
    tienePermisosWhatsapp: PERMISOS_WHATSAPP.every(p => permisos.includes(p)),
    wabasConcedidas: [...wabas],
  };
}

const CAMPOS_NUMERO = 'id,display_phone_number,verified_name,name_status,quality_rating,code_verification_status,platform_type';

/** Números de una WABA, leídos con el token del negocio. */
export async function leerNumerosWaba({ wabaId, accessToken, fetchImpl } = {}) {
  if (!esIdGraph(wabaId)) return { ok: false, motivo: MOTIVOS.ID_MALFORMADO };
  const r = await llamarGraph({ ruta: `${wabaId.trim()}/phone_numbers`, token: accessToken, params: { fields: CAMPOS_NUMERO, limit: 100 }, fetchImpl });
  if (!r.ok) return { ok: false, motivo: r.status ? MOTIVOS.NUMEROS_ILEGIBLES : MOTIVOS.META_NO_RESPONDE, error: r.error };
  const numeros = (Array.isArray(r.datos?.data) ? r.datos.data : [])
    .filter(n => esIdGraph(String(n?.id ?? '')))
    .map(n => ({
      id: String(n.id),
      displayPhoneNumber: limpiarNumeroVisible(n.display_phone_number),
      verifiedName: limpiarNombreVisible(n.verified_name),
      nameStatus: limpio(n.name_status),
      qualityRating: limpio(n.quality_rating),
      platformType: limpio(n.platform_type),
    }));
  return { ok: true, numeros };
}

/**
 * Contrasta (o descubre) WABA y número contra lo que Meta concedió.
 *
 * @param {object} o
 * @param {string} o.accessToken   credencial recién intercambiada
 * @param {string} [o.phoneNumberId] lo que mandó el navegador (puede faltar)
 * @param {string} [o.wabaId]        lo que mandó el navegador (puede faltar)
 * @returns {Promise<{ok:boolean, motivo?:string, wabaId?:string, phoneNumberId?:string,
 *   displayPhoneNumber?:string|null, verifiedName?:string|null, tipoToken?:string|null,
 *   venceAt?:string|null, nunca?:boolean, permisos?:string[], coincideConNavegador?:boolean,
 *   descubierto?:boolean}>}
 */
export async function verificarActivosConcedidos({ accessToken, phoneNumberId = null, wabaId = null, fetchImpl } = {}) {
  if (typeof accessToken !== 'string' || !accessToken.trim()) throw new Error('verificarActivosConcedidos: accessToken requerido');
  const pnidNav = limpio(phoneNumberId);
  const wabaNav = limpio(wabaId);
  if ((pnidNav && !esIdGraph(pnidNav)) || (wabaNav && !esIdGraph(wabaNav))) return { ok: false, motivo: MOTIVOS.ID_MALFORMADO };

  const concesion = await leerConcesion({ accessToken: accessToken.trim(), fetchImpl });
  if (!concesion.ok) return { ok: false, motivo: concesion.motivo };
  const base = { tipoToken: concesion.tipo, venceAt: concesion.venceAt, nunca: concesion.nunca, permisos: concesion.permisos };
  if (!concesion.tienePermisosWhatsapp) return { ok: false, motivo: MOTIVOS.SIN_PERMISO_WHATSAPP, ...base };

  // WABA: la del navegador tiene que estar concedida. Sin ella, la PRIMERA de
  // `target_ids` del permiso de administración: la guía oficial de Embedded
  // Signup («Get shared Messaging account ID with access token», página
  // manage-accounts) indica tomar ese primer id, y la cuenta más reciente
  // aparece primero. Un negocio que reconecta con una cuenta nueva conserva
  // la concesión de la anterior, así que exigir «una sola» lo bloquearía.
  let waba;
  if (wabaNav) {
    if (!concesion.wabasConcedidas.includes(wabaNav)) return { ok: false, motivo: MOTIVOS.WABA_NO_CONCEDIDA, ...base };
    waba = wabaNav;
  } else if (concesion.wabasConcedidas.length) {
    waba = concesion.wabasConcedidas[0];
  } else {
    return { ok: false, motivo: MOTIVOS.WABA_NO_CONCEDIDA, ...base };
  }

  const lectura = await leerNumerosWaba({ wabaId: waba, accessToken: accessToken.trim(), fetchImpl });
  if (!lectura.ok) return { ok: false, motivo: lectura.motivo, wabaId: waba, ...base };

  let numero;
  if (pnidNav) {
    numero = lectura.numeros.find(n => n.id === pnidNav);
    if (!numero) return { ok: false, motivo: MOTIVOS.NUMERO_NO_PERTENECE, wabaId: waba, ...base };
  } else if (lectura.numeros.length === 1) {
    numero = lectura.numeros[0];
  } else {
    return { ok: false, motivo: lectura.numeros.length ? MOTIVOS.NUMERO_AMBIGUO : MOTIVOS.NUMERO_NO_PERTENECE, wabaId: waba, ...base };
  }

  return {
    ok: true,
    wabaId: waba,
    phoneNumberId: numero.id,
    displayPhoneNumber: numero.displayPhoneNumber,
    verifiedName: numero.verifiedName,
    estadoNombre: numero.nameStatus,
    platformType: numero.platformType,
    ...base,
    wabasConcedidas: concesion.wabasConcedidas.length,
    coincideConNavegador: Boolean(pnidNav && wabaNav),
    descubierto: !pnidNav || !wabaNav,
  };
}

// ── Interruptor ──────────────────────────────────────────────────────────
// apagado  : el callback se comporta exactamente como antes (por omisión).
// observar : verifica y deja constancia en la auditoría, pero NO cambia el
//            resultado de la conexión. Guarda el vencimiento si Meta lo dio.
// exigir   : si la verificación falla, la conexión se rechaza antes de
//            guardar nada; si pasa, se guardan los ids que confirmó Meta.
export const MODOS_VERIFICACION = Object.freeze(['apagado', 'observar', 'exigir']);
export const CLAVE_CONFIG_VERIFICACION = 'meta_verificar_activos';

/**
 * Modo para un negocio: el MÁS ESTRICTO entre la variable
 * META_VERIFICAR_ACTIVOS (toda la plataforma) y la clave del negocio en
 * `configuracion`. La clave del negocio solo puede ENDURECER el modo (para
 * probar en un negocio antes que en todos), nunca relajar el de la plataforma.
 * Un valor desconocido no cuenta.
 */
export function resolverModoVerificacion(valorNegocio, valorEntorno = process.env.META_VERIFICAR_ACTIVOS) {
  const nivel = (v) => MODOS_VERIFICACION.indexOf(String(v ?? '').trim().toLowerCase());
  const n = Math.max(nivel(valorNegocio), nivel(valorEntorno), 0);
  return MODOS_VERIFICACION[n];
}

// El nombre visible y el número salen de Meta y se pintan en paneles. Se
// guardan sin caracteres de marcado: ninguna vista debe depender de que el
// dato llegue limpio.
export function limpiarNumeroVisible(v) {
  const s = String(v ?? '').replace(/[^\d+\-() ]/g, '').trim();
  return s ? s.slice(0, 32) : null;
}
export function limpiarNombreVisible(v) {
  const s = String(v ?? '').replace(/[<>"'`&\u0000-\u001f]/g, '').trim();
  return s ? s.slice(0, 120) : null;
}
