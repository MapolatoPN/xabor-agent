// metaFormularios.js — diagnóstico de los formularios (WhatsApp Flows) de UN
// negocio, comparando lo que Xabor tiene configurado con lo que Meta dice.
// Solo lectura: no crea, no publica, no cambia ninguna clave.
//
// Los ids de los formularios viven en `configuracion` como
// `whatsapp_flow_<tipo>_id`. Hoy se dan de alta con scripts manuales y no
// hay ningún lugar donde ver si siguen sanos. Aquí se cruzan con:
//   - GET /{WABA_ID}/flows            → nombre, estado y errores de validación
//   - GET /{PHONE_NUMBER_ID}/whatsapp_business_encryption → si la llave
//     pública del endpoint de formularios está registrada en ese número
// con la credencial que el propio negocio concedió.
//
// Nunca devuelve el token. Nunca lanza por un rechazo de Meta.
import { pool as poolApp } from './database.js';
import { descifrarSecretoIntegracion } from './cifradoIntegraciones.js';
import { llamarGraph, listarGraph, esIdGraph } from './metaGraph.js';

const PATRON_CLAVE = /^whatsapp_flow_[a-z0-9_]+_id$/;
const ESTADOS_SANOS = new Set(['PUBLISHED']);

/** Problema de un formulario configurado, en palabras de soporte. Pura. */
export function problemaDeFormulario(conf, enMeta) {
  if (!esIdGraph(String(conf.flowId || ''))) return 'El id configurado no tiene forma de id de Meta.';
  if (!enMeta) return 'Meta no lo tiene en la cuenta de WhatsApp de este negocio.';
  if (enMeta.erroresValidacion > 0) return `Meta reporta ${enMeta.erroresValidacion} error(es) de validación.`;
  if (!ESTADOS_SANOS.has(enMeta.estado)) {
    return ({
      DRAFT: 'Está en borrador: los clientes no lo pueden abrir.',
      DEPRECATED: 'Está retirado (deprecated): ya no se puede enviar.',
      BLOCKED: 'Meta lo bloqueó.',
      THROTTLED: 'Meta lo está limitando.',
    })[enMeta.estado] || `Estado en Meta: ${enMeta.estado || 'desconocido'}.`;
  }
  return null;
}

async function credencialDelNegocio(db, negocioId) {
  const { rows } = await db.query(
    `SELECT ic.identificador, ic.waba_id, ic.estado,
            cc.access_token_cifrado, cc.token_iv, cc.token_auth_tag, cc.token_formato_version
       FROM integraciones_canal ic
       JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id
      WHERE ic.negocio_id = $1 AND ic.canal = 'whatsapp' AND ic.proveedor = 'meta'`,
    [negocioId]);
  const f = rows[0];
  if (!f) return null;
  try {
    return {
      phoneNumberId: f.identificador, wabaId: f.waba_id, estado: f.estado,
      accessToken: descifrarSecretoIntegracion({ cifrado: f.access_token_cifrado, iv: f.token_iv, authTag: f.token_auth_tag, version: f.token_formato_version }),
    };
  } catch {
    return { phoneNumberId: f.identificador, wabaId: f.waba_id, estado: f.estado, accessToken: null };
  }
}

/**
 * @param {string} negocioId
 * @param {object} [o] { db, fetchImpl }
 * @returns {Promise<{ok:boolean, motivo?:string, configurados:object[], sinUsar:number,
 *   llaveCifrado:object|null, resumen:object}>}
 */
export async function diagnosticarFormularios(negocioId, { db = poolApp, fetchImpl } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return { ok: false, motivo: 'negocio_invalido', configurados: [] };
  const id = negocioId.trim();

  const { rows: claves } = await db.query(
    `SELECT clave, valor FROM configuracion WHERE negocio_id = $1 AND clave LIKE 'whatsapp\\_flow\\_%' ORDER BY clave`, [id]);
  const configurados = claves
    .filter(c => PATRON_CLAVE.test(c.clave) && String(c.valor || '').trim())
    .map(c => ({ clave: c.clave, flowId: String(c.valor).trim() }));

  const cred = await credencialDelNegocio(db, id);
  if (!cred || !cred.accessToken || !esIdGraph(String(cred.wabaId || ''))) {
    return {
      ok: false, motivo: !cred ? 'sin_whatsapp' : !cred.accessToken ? 'credencial_ilegible' : 'sin_waba',
      configurados: configurados.map(c => ({ ...c, problema: 'No se pudo consultar a Meta.' })),
      sinUsar: 0, llaveCifrado: null,
      resumen: { configurados: configurados.length, sanos: 0, conProblema: configurados.length },
    };
  }

  const lista = await listarGraph({
    ruta: `${cred.wabaId}/flows`, token: cred.accessToken,
    params: { fields: 'id,name,status,validation_errors' }, fetchImpl,
  });
  if (!lista.ok) {
    return {
      ok: false, motivo: 'meta_no_respondio', error: lista.error,
      configurados: configurados.map(c => ({ ...c, problema: 'Meta no respondió la consulta.' })),
      sinUsar: 0, llaveCifrado: null,
      resumen: { configurados: configurados.length, sanos: 0, conProblema: configurados.length },
    };
  }
  const porId = new Map(lista.elementos.map(f => [String(f.id), {
    nombre: typeof f.name === 'string' ? f.name : null,
    estado: typeof f.status === 'string' ? f.status : null,
    erroresValidacion: Array.isArray(f.validation_errors) ? f.validation_errors.length : 0,
  }]));

  const filas = configurados.map(c => {
    const enMeta = porId.get(c.flowId) || null;
    return { ...c, enMeta, problema: problemaDeFormulario(c, enMeta) };
  });
  const usados = new Set(configurados.map(c => c.flowId));
  const sinUsar = lista.elementos.filter(f => !usados.has(String(f.id)) && f.status === 'PUBLISHED').length;

  // Llave pública del endpoint de formularios en el número del negocio.
  let llaveCifrado = null;
  if (esIdGraph(String(cred.phoneNumberId || ''))) {
    const r = await llamarGraph({ ruta: `${cred.phoneNumberId}/whatsapp_business_encryption`, token: cred.accessToken, fetchImpl });
    const d = Array.isArray(r.datos?.data) ? r.datos.data[0] : r.datos;
    llaveCifrado = r.ok
      ? { consultada: true, registrada: Boolean(d?.business_public_key), estadoFirma: typeof d?.business_public_key_signature_status === 'string' ? d.business_public_key_signature_status : null }
      : { consultada: false, error: r.error };
  }

  const conProblema = filas.filter(f => f.problema).length;
  return {
    ok: true, configurados: filas, sinUsar, llaveCifrado,
    resumen: { configurados: filas.length, sanos: filas.length - conProblema, conProblema, enMeta: lista.elementos.length },
  };
}
