// metaVerificacionCallback.js — la verificación de activos (metaActivos.js)
// aplicada al callback de Embedded Signup, según el interruptor
// `meta_verificar_activos` / META_VERIFICAR_ACTIVOS.
//
// La ruta (server.js) solo pregunta tres cosas: ¿se rechaza?, ¿con qué ids se
// guarda? y ¿qué datos extra se guardan? Toda la decisión vive aquí, para
// poder probarla sin levantar el servidor.
//
//   apagado  : ninguna llamada a Meta; ids y datos tal como llegaron del
//              navegador. Es el comportamiento de siempre.
//   observar : verifica y deja la auditoría `integracion_activos_verificados`,
//              pero NUNCA cambia el resultado. Si Meta confirma el MISMO
//              número que mandó el navegador, se guardan además su número
//              visible, su nombre aprobado y el vencimiento de la credencial.
//   exigir   : si la verificación falla, se rechaza antes de guardar nada (y
//              sin tocar la integración que ya tuviera el negocio). Si pasa,
//              se guardan los ids que confirmó Meta, aunque el navegador no
//              los haya mandado (Embedded Signup v5 ya no manda `waba_id`).
import { pool } from './database.js';
import {
  CLAVE_CONFIG_VERIFICACION, MENSAJE_CLIENTE, MOTIVOS,
  resolverModoVerificacion, verificarActivosConcedidos,
} from './metaActivos.js';

const limpio = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Modo efectivo para un negocio. Si la base falla, vale el de la plataforma. */
export async function modoVerificacionNegocio(negocioId, { db = pool } = {}) {
  try {
    const { rows } = await db.query(
      `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2`,
      [negocioId, CLAVE_CONFIG_VERIFICACION]);
    return resolverModoVerificacion(rows[0]?.valor);
  } catch {
    return resolverModoVerificacion(null);
  }
}

/** Resumen para la bitácora: nunca el token, nunca la respuesta cruda. */
function resumenAuditoria(modo, v, pnidNav, wabaNav) {
  return {
    modo,
    ok: Boolean(v?.ok),
    motivo: v?.motivo || null,
    descubierto: Boolean(v?.descubierto),
    numeroDistintoAlNavegador: Boolean(v?.ok && pnidNav && v.phoneNumberId !== pnidNav),
    wabaDistintaAlNavegador: Boolean(v?.ok && wabaNav && v.wabaId !== wabaNav),
    phoneNumberId: v?.phoneNumberId || null,
    wabaId: v?.wabaId || null,
    tipoToken: v?.tipoToken || null,
    venceAt: v?.venceAt || null,
    nunca: Boolean(v?.nunca),
    platformType: v?.platformType || null,
  };
}

function estatusDeRechazo(motivo) {
  if (motivo === MOTIVOS.META_NO_RESPONDE) return 502;
  if (motivo === MOTIVOS.SIN_CREDENCIAL_APP) return 503;
  return 400;
}

/**
 * @param {object} o
 * @param {'apagado'|'observar'|'exigir'} o.modo
 * @param {string} o.accessToken  la credencial recién intercambiada
 * @param {string} [o.phoneNumberId] del navegador
 * @param {string} [o.wabaId]        del navegador
 * @param {Function} [o.fetchImpl]
 * @returns {Promise<{ rechazo: null|{status:number, error:string, motivo:string},
 *   ids: {phoneNumberId:string|null, wabaId:string|null},
 *   extras: object, auditoria: object|null }>}
 */
export async function aplicarVerificacion({ modo, accessToken, phoneNumberId, wabaId, fetchImpl } = {}) {
  const pnidNav = limpio(phoneNumberId);
  const wabaNav = limpio(wabaId);
  const comoLlego = { phoneNumberId: pnidNav, wabaId: wabaNav };
  if (modo !== 'observar' && modo !== 'exigir') {
    // Exactamente lo de antes: los valores sin tocar (guardarCredencialesCifradas
    // los recorta y valida como siempre).
    return { rechazo: null, ids: { phoneNumberId, wabaId }, extras: {}, auditoria: null };
  }

  let v;
  try {
    v = await verificarActivosConcedidos({ accessToken, phoneNumberId: pnidNav, wabaId: wabaNav, fetchImpl });
  } catch {
    v = { ok: false, motivo: MOTIVOS.TOKEN_INVALIDO };
  }
  const auditoria = resumenAuditoria(modo, v, pnidNav, wabaNav);
  const extrasDe = (r) => ({
    displayPhoneNumber: r.displayPhoneNumber || null,
    verifiedName: r.verifiedName || null,
    estadoNombre: r.estadoNombre || null,
    // null = Meta dijo que no vence (o no lo dijo): la vigilancia de la
    // credencial lo vuelve a leer en sus pasadas.
    tokenExpiraAt: r.venceAt || null,
  });

  if (modo === 'observar') {
    const mismoNumero = v.ok && pnidNav && v.phoneNumberId === pnidNav && (!wabaNav || v.wabaId === wabaNav);
    return {
      rechazo: null,
      ids: { phoneNumberId, wabaId },
      extras: mismoNumero ? extrasDe(v) : {},
      auditoria,
    };
  }

  // exigir
  if (!v.ok) {
    return {
      rechazo: { status: estatusDeRechazo(v.motivo), error: MENSAJE_CLIENTE[v.motivo] || MENSAJE_CLIENTE[MOTIVOS.TOKEN_INVALIDO], motivo: v.motivo },
      ids: comoLlego, extras: {}, auditoria,
    };
  }
  return { rechazo: null, ids: { phoneNumberId: v.phoneNumberId, wabaId: v.wabaId }, extras: extrasDe(v), auditoria };
}
