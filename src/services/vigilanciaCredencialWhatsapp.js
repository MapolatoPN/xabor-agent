/**
 * vigilanciaCredencialWhatsapp.js — que una credencial de WhatsApp rechazada
 * por Meta se sepa en minutos, y que avise antes de vencer.
 *
 * Cada 10 minutos (server.js, después de arrancar) y en cada «Verificar
 * conexión», por cada integración whatsapp/meta activa de un negocio activo:
 *   1. consulta el número a Meta con la credencial del negocio (una lectura,
 *      jamás un mensaje a nadie);
 *   2. si Meta la rechaza, lo anota en integraciones_canal.ultimo_error_codigo
 *      (`credencial:190`): la tarjeta de WhatsApp del panel pasa a «Requiere
 *      reconexión» (whatsappAutoservicio.js) y se manda una notificación push
 *      a los equipos del negocio, con recordatorios de día;
 *   3. si funciona, borra esa marca y, cada 6 h, pregunta a Meta cuándo vence
 *      (/debug_token): lo guarda en token_expira_at y avisa 7, 3 y 1 días antes.
 *
 * Por qué así (decisión del 31-oct-2026): no toca whatsapp-meta.js ni el
 * camino del webhook. NO cambia `estado`: una integración que deja de estar
 * 'activo' deja de recibir y de enviar, y aquí solo se avisa. Los avisos
 * nunca salen por WhatsApp, que es justo lo que está roto.
 *
 * Nunca lanza hacia el job. Nunca registra la credencial, el secreto de la
 * app ni las URLs que los llevan. Los efectos (push, reloj, llamadas a Meta)
 * llegan por parámetro para probarse sin red.
 */
import { pool as poolApp, obtenerConfiguracion } from './database.js';
import { obtenerCredencialesDescifradas } from './integracionesService.js';
import { GRAPH_VERSION } from './metaEmbeddedSignup.js';
import { TZ_DEFAULT } from './zonaHoraria.js';
import {
  CLAVE_APAGAR, clasificarSonda, codigoDeRechazo, debeAvisarRechazo, dentroDeHorarioDeAvisos,
  textoRechazo, textoVencimiento, tocaConsultarVencimiento, umbralDeVencimiento,
} from './credencialWhatsappPolitica.js';

const TIEMPO_MAXIMO_MS = 15 * 1000;
export const TAG_PUSH = 'xabor-whatsapp-credencial';

const resumirError = (body) => {
  const err = (body && typeof body === 'object' && body.error) || {};
  return {
    codigo: typeof err.code === 'number' ? err.code : null,
    tipo: typeof err.type === 'string' ? err.type.slice(0, 60) : null,
  };
};
const corto = (id) => String(id || '').slice(0, 8);
const iso = (v) => (v ? new Date(v).toISOString() : null);

/** GET /{phone_number_id}?fields=id con la credencial del negocio. */
export async function sondearCredencial({ phoneNumberId, accessToken }) {
  if (process.env.META_EMBEDDED_SIGNUP_MOCK === 'true') return { ok: true, status: 200 };
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(String(phoneNumberId))}?fields=id`, {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
    });
    if (r.ok) return { ok: true, status: r.status };
    return { ok: false, status: r.status, resumen: resumirError(await r.json().catch(() => ({}))) };
  } catch {
    return { ok: false, status: null, resumen: { codigo: null, tipo: 'red' } };
  }
}

/**
 * Cuándo vence la credencial, según Meta (/debug_token con el token de la
 * app). { ok: false } si no se pudo saber; venceAt null + nunca = no vence.
 */
export async function consultarVencimiento({ accessToken }) {
  const appId = process.env.META_APP_ID, appSecret = process.env.META_APP_SECRET;
  if (process.env.META_EMBEDDED_SIGNUP_MOCK === 'true' || !appId || !appSecret) return { ok: false };
  try {
    const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/debug_token`);
    url.searchParams.set('input_token', accessToken);
    url.searchParams.set('access_token', `${appId}|${appSecret}`);
    const r = await fetch(url.toString(), { signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS) });
    const d = (await r.json().catch(() => ({})))?.data;
    if (!r.ok || !d || typeof d !== 'object') return { ok: false };
    if (d.is_valid !== true) return { ok: true, valida: false };
    const vence = Number(d.expires_at);
    return { ok: true, valida: true, venceAt: vence > 0 ? new Date(vence * 1000).toISOString() : null, nunca: vence === 0 };
  } catch {
    return { ok: false };
  }
}

async function guardarVigilancia(db, integracionId, cambios) {
  await db.query(
    `UPDATE integraciones_canal
        SET configuracion = jsonb_set(COALESCE(configuracion, '{}'::jsonb), '{vigilancia_credencial}',
              COALESCE(configuracion->'vigilancia_credencial', '{}'::jsonb) || $2::jsonb, true)
      WHERE id = $1`,
    [integracionId, JSON.stringify(cambios)]);
}

/**
 * Anota (o borra) el rechazo según la sonda. Devuelve la clase y si el
 * rechazo es NUEVO. Lo usan el job y «Verificar conexión».
 */
async function anotarSonda(db, integracionId, sonda) {
  const clase = clasificarSonda(sonda);
  if (clase === 'rechazada') {
    const { rows } = await db.query(
      `UPDATE integraciones_canal SET ultimo_error_codigo = $2, ultimo_error_at = NOW()
        WHERE id = $1 AND (ultimo_error_codigo IS NULL OR ultimo_error_codigo NOT LIKE 'credencial:%')
        RETURNING ultimo_error_at`,
      [integracionId, codigoDeRechazo(sonda)]);
    return { clase, nuevo: rows.length > 0 };
  }
  if (clase === 'ok') {
    const { rows } = await db.query(
      `UPDATE integraciones_canal SET ultimo_error_codigo = NULL, ultimo_error_at = NULL
        WHERE id = $1 AND ultimo_error_codigo LIKE 'credencial:%'
        RETURNING id`,
      [integracionId]);
    return { clase, recuperada: rows.length > 0 };
  }
  return { clase };
}

/** «Verificar conexión»: anota lo que dijo Meta para ESTE negocio. Nunca lanza. */
export async function registrarSondaDeNegocio(negocioId, sonda, { db = poolApp } = {}) {
  try {
    const { rows: [fila] } = await db.query(
      `SELECT id FROM integraciones_canal
        WHERE negocio_id = $1 AND canal = 'whatsapp' AND proveedor = 'meta' AND estado = 'activo' LIMIT 1`,
      [negocioId]);
    if (!fila) return clasificarSonda(sonda);
    const r = await anotarSonda(db, fila.id, sonda);
    if (r.nuevo) console.error(`[WA-CREDENCIAL] RECHAZADA negocio=${corto(negocioId)} codigo=${codigoDeRechazo(sonda)} origen=verificar`);
    return r.clase;
  } catch (e) {
    console.error(`[WA-CREDENCIAL] verificar negocio=${corto(negocioId)} :: ${String(e.message).slice(0, 160)}`);
    return clasificarSonda(sonda);
  }
}

async function revisarIntegracion(fila, { db, enviarPush, sondear, consultarVence, ahora }) {
  const negocioId = fila.negocio_id;
  const cfg = await obtenerConfiguracion(negocioId).catch(() => ({}));
  if (String(cfg?.[CLAVE_APAGAR] ?? '').trim().toLowerCase() === 'false') return { negocioId, resultado: 'apagada' };
  const zona = cfg?.timezone || TZ_DEFAULT;
  const vig = fila.vigilancia && typeof fila.vigilancia === 'object' ? fila.vigilancia : {};

  const cred = await obtenerCredencialesDescifradas(negocioId, 'whatsapp', 'meta');
  if (!cred?.accessToken) return { negocioId, resultado: 'sin_credencial' };

  const sonda = await sondear(cred);
  const r = await anotarSonda(db, fila.id, sonda);
  const t = ahora();

  if (r.clase === 'rechazada') {
    const { rows: [m] } = await db.query(`SELECT ultimo_error_at FROM integraciones_canal WHERE id = $1`, [fila.id]);
    if (r.nuevo) console.error(`[WA-CREDENCIAL] RECHAZADA negocio=${corto(negocioId)} codigo=${codigoDeRechazo(sonda)}`);
    let avisado = false;
    if (enviarPush && debeAvisarRechazo({ detectadoAt: m?.ultimo_error_at, ultimoAvisoAt: vig.aviso_rechazo_at, ahora: t, zona })) {
      const { titulo, cuerpo } = textoRechazo(fila.nombre);
      await enviarPush(negocioId, titulo, cuerpo, { tipo: 'whatsapp_credencial' }, { tag: TAG_PUSH });
      await guardarVigilancia(db, fila.id, { aviso_rechazo_at: new Date(t).toISOString() });
      avisado = true;
    }
    return { negocioId, resultado: 'rechazada', nuevo: !!r.nuevo, avisado };
  }
  if (r.clase !== 'ok') return { negocioId, resultado: 'incierta' };
  if (r.recuperada) console.log(`[WA-CREDENCIAL] recuperada negocio=${corto(negocioId)}`);

  // Vencimiento: lo que ya se sabe, y a Meta cada 6 h o si cambió la credencial.
  let venceAt = iso(fila.token_expira_at);
  if (tocaConsultarVencimiento({ revisadoAt: vig.vencimiento_revisado_at, credencialAt: fila.credencial_at, ahora: t })) {
    const c = await consultarVence(cred);
    if (c?.ok && c.valida) {
      const nuevo = c.venceAt || null;
      if (nuevo !== venceAt) {
        await db.query(`UPDATE integraciones_canal_credenciales SET token_expira_at = $2 WHERE integracion_id = $1`, [fila.id, nuevo]);
        venceAt = nuevo;
      }
      await guardarVigilancia(db, fila.id, { vencimiento_revisado_at: new Date(t).toISOString() });
    }
  }
  const umbral = umbralDeVencimiento({ venceAt, ahora: t,
    avisado: { para: vig.aviso_vence_para, umbral: vig.aviso_vence_umbral } });
  if (umbral && enviarPush && dentroDeHorarioDeAvisos(t, zona)) {
    const { titulo, cuerpo } = textoVencimiento(venceAt, zona, fila.nombre);
    await enviarPush(negocioId, titulo, cuerpo, { tipo: 'whatsapp_credencial_vence' }, { tag: TAG_PUSH });
    await guardarVigilancia(db, fila.id, { aviso_vence_para: venceAt, aviso_vence_umbral: umbral });
    return { negocioId, resultado: 'ok', venceAt, avisoVence: umbral };
  }
  return { negocioId, resultado: 'ok', venceAt };
}

/**
 * Una corrida del job. `negocioId` la limita a uno (pruebas). Devuelve un
 * resumen por integración; nunca lanza.
 */
export async function vigilarCredencialesWhatsapp({
  enviarPush = null, sondear = sondearCredencial, consultarVence = consultarVencimiento,
  ahora = () => Date.now(), negocioId = null, db = poolApp,
} = {}) {
  let filas = [];
  try {
    ({ rows: filas } = await db.query(
      `SELECT ic.id, ic.negocio_id, n.nombre, ic.configuracion->'vigilancia_credencial' AS vigilancia,
              cc.token_expira_at, cc.actualizado_at AS credencial_at
         FROM integraciones_canal ic
         JOIN negocios n ON n.id = ic.negocio_id AND n.activo = TRUE
         JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id
        WHERE ic.canal = 'whatsapp' AND ic.proveedor = 'meta' AND ic.estado = 'activo'
          AND ($1::uuid IS NULL OR ic.negocio_id = $1::uuid)
        ORDER BY ic.negocio_id`,
      [negocioId]));
  } catch (e) {
    console.error(`[WA-CREDENCIAL] lectura :: ${String(e.message).slice(0, 160)}`);
    return [];
  }
  const resumen = [];
  for (const fila of filas) {
    try {
      resumen.push(await revisarIntegracion(fila, { db, enviarPush, sondear, consultarVence, ahora }));
    } catch (e) {
      console.error(`[WA-CREDENCIAL] negocio=${corto(fila.negocio_id)} :: ${String(e.message).slice(0, 160)}`);
      resumen.push({ negocioId: fila.negocio_id, resultado: 'error' });
    }
  }
  return resumen;
}
