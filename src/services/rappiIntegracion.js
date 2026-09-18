// Integración Rappi POR NEGOCIO.
//
// Único lugar donde se responde "¿con qué store y con qué credenciales habla
// Xabor con Rappi para este negocio?". La respuesta sale de
// `integraciones_canal` (canal='rappi'), nunca de una variable global:
//
//   store.internal_id (webhook)  ──┐
//                                  ├─→ integraciones_canal ─→ negocio_id ─→ credenciales
//   negocio de la sesión (panel) ──┘
//
// Dos escenarios soportados, sin duplicar rappi-api.js:
//   A. Un mismo client_id para varios stores (el integrador es Xabor): la
//      integración solo trae su `identificador` (store) y las credenciales
//      salen del entorno (RAPPI_CLIENT_ID / RAPPI_CLIENT_SECRET).
//   B. Credenciales propias por tienda: `configuracion.rappi_client_id` en la
//      integración y el client_secret CIFRADO en
//      integraciones_canal_credenciales (mismo cifrado AES-256-GCM que
//      WhatsApp/Clip; nunca en texto plano, nunca en el JSONB).
//
// Fail closed: sin integración activa no hay cliente; sin credenciales de
// ningún origen tampoco. Nunca se cae al store de otro negocio.
import { pool, registrarAuditoriaPlataforma, normalizarActor } from './database.js';
import { cifrarSecretoIntegracion, descifrarSecretoIntegracion } from './cifradoIntegraciones.js';
import { crearClienteRappi } from './rappi-api.js';

export const CANAL_RAPPI = 'rappi';
export const PROVEEDOR_RAPPI = 'rappi';
export const COOKING_TIME_DEFAULT = 20;
export const MODOS_FIRMA = ['registrar', 'exigir'];

const COLUMNAS = `
  ic.id AS integracion_id, ic.negocio_id, n.slug AS negocio_slug, n.nombre AS negocio_nombre,
  ic.sucursal_id, ic.identificador, ic.nombre, ic.configuracion, ic.activo, ic.estado, ic.proveedor,
  (cc.integracion_id IS NOT NULL) AS tiene_credenciales`;
const DESDE = `
  FROM integraciones_canal ic
  JOIN negocios n ON n.id = ic.negocio_id
  LEFT JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id`;

function formar(row) {
  if (!row) return null;
  const cfg = (row.configuracion && typeof row.configuracion === 'object' && !Array.isArray(row.configuracion)) ? row.configuracion : {};
  return {
    integracionId: row.integracion_id,
    negocioId: row.negocio_id,
    negocioSlug: row.negocio_slug,
    negocioNombre: row.negocio_nombre,
    sucursalId: row.sucursal_id,
    storeId: row.identificador,
    nombre: row.nombre,
    configuracion: cfg,
    activo: row.activo === true,
    estado: row.estado,
    // Escenario B solo cuando hay client_id declarado Y secreto cifrado.
    tieneCredencialesPropias: row.tiene_credenciales === true && typeof cfg.rappi_client_id === 'string' && cfg.rappi_client_id.trim() !== '',
  };
}

function esUuid(v) { return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v); }

/** Integración ACTIVA dueña de un store.internal_id (webhook entrante). */
export async function obtenerIntegracionRappiPorStore(storeId) {
  const sid = storeId != null ? String(storeId).trim() : '';
  if (!sid) return null;
  const { rows } = await pool.query(
    `SELECT ${COLUMNAS} ${DESDE} WHERE ic.canal = $1 AND ic.identificador = $2 AND ic.activo = TRUE`,
    [CANAL_RAPPI, sid]);
  if (rows.length > 1) {
    console.error(`[Rappi] store ${sid.slice(-4)} tiene ${rows.length} integraciones activas — se rechaza (fail closed)`);
    return null;
  }
  return formar(rows[0]);
}

/** Integración de Rappi de un negocio (la primera creada si hubiera varias). */
export async function obtenerIntegracionRappi(negocioId, { soloActiva = true } = {}) {
  if (!esUuid(negocioId)) return null;
  const { rows } = await pool.query(
    `SELECT ${COLUMNAS} ${DESDE} WHERE ic.canal = $1 AND ic.negocio_id = $2 ${soloActiva ? 'AND ic.activo = TRUE' : ''}
      ORDER BY ic.created_at ASC LIMIT 1`,
    [CANAL_RAPPI, negocioId]);
  return formar(rows[0]);
}

export async function listarIntegracionesRappi({ soloActivas = true } = {}) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNAS} ${DESDE} WHERE ic.canal = $1 ${soloActivas ? 'AND ic.activo = TRUE' : ''} ORDER BY ic.created_at ASC`,
    [CANAL_RAPPI]);
  return rows.map(formar);
}

/**
 * Credenciales con las que habla esta integración:
 *   { clientId, clientSecret, origen: 'negocio' | 'entorno' } o null.
 * Nunca devuelve el secreto cifrado ni lo loguea.
 */
export async function resolverCredencialesRappi(integracion) {
  if (!integracion) return null;
  if (integracion.tieneCredencialesPropias) {
    const { rows: [cc] } = await pool.query(
      `SELECT access_token_cifrado, token_iv, token_auth_tag, token_formato_version
         FROM integraciones_canal_credenciales WHERE integracion_id = $1`,
      [integracion.integracionId]);
    if (cc) {
      try {
        const clientSecret = descifrarSecretoIntegracion({
          cifrado: cc.access_token_cifrado, iv: cc.token_iv, authTag: cc.token_auth_tag, version: cc.token_formato_version,
        });
        return { clientId: String(integracion.configuracion.rappi_client_id).trim(), clientSecret, origen: 'negocio' };
      } catch (e) {
        // Un secreto que no descifra NO cae al entorno: sería hablar con
        // Rappi con la identidad de otro integrador sin que nadie lo pidiera.
        console.error(`[Rappi] credenciales propias ilegibles (negocio ${integracion.negocioId.slice(0, 8)}…): ${e.message}`);
        return null;
      }
    }
  }
  const clientId = process.env.RAPPI_CLIENT_ID;
  const clientSecret = process.env.RAPPI_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret, origen: 'entorno' };
  return null;
}

/** Cliente de rappi-api.js atado al store y credenciales de la integración. */
export async function crearClienteRappiParaIntegracion(integracion) {
  const cred = await resolverCredencialesRappi(integracion);
  if (!cred) return null;
  return crearClienteRappi({
    storeId: integracion.storeId,
    clientId: cred.clientId,
    clientSecret: cred.clientSecret,
    etiqueta: `${integracion.negocioSlug || integracion.negocioId.slice(0, 8)} store …${String(integracion.storeId).slice(-4)} (${cred.origen})`,
  });
}

/** Atajo para las rutas del panel: negocio de la sesión → { integracion, cliente }. */
export async function clienteRappiDeNegocio(negocioId) {
  const integracion = await obtenerIntegracionRappi(negocioId);
  if (!integracion) return { integracion: null, cliente: null, razon: 'sin_integracion' };
  const cliente = await crearClienteRappiParaIntegracion(integracion);
  if (!cliente) return { integracion, cliente: null, razon: 'sin_credenciales' };
  return { integracion, cliente, razon: null };
}

// ─── Preferencias por integración (metadatos NO sensibles) ─────────────────
export function cookingTimeDe(integracion) {
  const v = Number(integracion?.configuracion?.cooking_time);
  if (Number.isInteger(v) && v > 0 && v <= 180) return v;
  const env = parseInt(process.env.RAPPI_COOKING_TIME || '', 10);
  return Number.isInteger(env) && env > 0 ? env : COOKING_TIME_DEFAULT;
}

/**
 * Secreto con el que Rappi firma los webhooks de este store. El secreto lo
 * devuelve `POST /webhook` y es del integrador (client_id), así que en el
 * escenario A vive en el entorno (RAPPI_WEBHOOK_SECRET) y en el B puede
 * declararse por integración (`configuracion.rappi_webhook_secret`).
 *
 * ⚠ El JSONB `configuracion` no está cifrado. Hoy no hay una segunda ranura
 * cifrada por integración (integraciones_canal_credenciales guarda UN
 * secreto: el client_secret). Se documenta como riesgo restante; mientras,
 * el valor por entorno es el recomendado.
 */
export function secretoWebhookDe(integracion) {
  const propio = integracion?.configuracion?.rappi_webhook_secret;
  if (typeof propio === 'string' && propio.trim()) return propio.trim();
  const env = process.env.RAPPI_WEBHOOK_SECRET;
  return (typeof env === 'string' && env.trim()) ? env.trim() : null;
}

/** 'exigir' rechaza firmas inválidas; 'registrar' solo deja constancia. */
export function modoFirmaDe(integracion) {
  const propio = integracion?.configuracion?.rappi_firma;
  if (MODOS_FIRMA.includes(propio)) return propio;
  const env = process.env.RAPPI_FIRMA_MODO;
  if (MODOS_FIRMA.includes(env)) return env;
  return 'registrar';
}

// ─── Alta y credenciales (Superadmin) ───────────────────────────────────────

/**
 * Vincula (o re-vincula) el store de Rappi de un negocio. Una integración
 * Rappi por negocio; el store no puede pertenecer a dos negocios (UNIQUE).
 */
export async function vincularTiendaRappi(negocioId, { storeId, nombre = null, sucursalId = null, configuracion = {} } = {}, actor = null) {
  if (!esUuid(negocioId)) throw Object.assign(new Error('negocioId inválido'), { codigo: 'NEGOCIO_INVALIDO' });
  const sid = storeId != null ? String(storeId).trim() : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sid)) throw Object.assign(new Error('storeId inválido'), { codigo: 'STORE_INVALIDO' });
  if (sucursalId != null && !esUuid(sucursalId)) throw Object.assign(new Error('sucursalId inválido'), { codigo: 'SUCURSAL_INVALIDA' });
  const cfg = (configuracion && typeof configuracion === 'object' && !Array.isArray(configuracion)) ? configuracion : {};
  if (cfg.rappi_firma !== undefined && !MODOS_FIRMA.includes(cfg.rappi_firma)) {
    throw Object.assign(new Error('rappi_firma debe ser "registrar" o "exigir"'), { codigo: 'FIRMA_INVALIDA' });
  }
  if (cfg.cooking_time !== undefined && !(Number.isInteger(Number(cfg.cooking_time)) && Number(cfg.cooking_time) > 0 && Number(cfg.cooking_time) <= 180)) {
    throw Object.assign(new Error('cooking_time debe ser un entero entre 1 y 180'), { codigo: 'COOKING_TIME_INVALIDO' });
  }
  const { superadminId, actorUsuarioId, actualizadoPorId } = normalizarActor(actor);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [dueno] } = await client.query(
      `SELECT negocio_id FROM integraciones_canal WHERE canal = $1 AND identificador = $2`, [CANAL_RAPPI, sid]);
    if (dueno && dueno.negocio_id !== negocioId) {
      throw Object.assign(new Error('Ese store de Rappi ya está vinculado a otro negocio'), { codigo: 'STORE_OCUPADO' });
    }
    const { rows: [existente] } = await client.query(
      `SELECT id, identificador, estado FROM integraciones_canal WHERE canal = $1 AND negocio_id = $2 ORDER BY created_at ASC LIMIT 1`,
      [CANAL_RAPPI, negocioId]);
    let integracionId;
    if (existente) {
      integracionId = existente.id;
      await client.query(
        `UPDATE integraciones_canal
            SET identificador = $1, nombre = COALESCE($2, nombre), sucursal_id = $3,
                configuracion = COALESCE(configuracion, '{}'::jsonb) || $4::jsonb,
                estado = 'activo', activo = TRUE, actualizado_por = $5, updated_at = NOW(),
                ultimo_error_codigo = NULL, ultimo_error_at = NULL
          WHERE id = $6`,
        [sid, nombre, sucursalId, JSON.stringify(cfg), actualizadoPorId, integracionId]);
    } else {
      const { rows: [nueva] } = await client.query(
        `INSERT INTO integraciones_canal (negocio_id, sucursal_id, canal, identificador, nombre, configuracion, estado, activo, conectado_at, actualizado_por)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'activo', TRUE, NOW(), $7) RETURNING id`,
        [negocioId, sucursalId, CANAL_RAPPI, sid, nombre, JSON.stringify(cfg), actualizadoPorId]);
      integracionId = nueva.id;
    }
    await registrarAuditoriaPlataforma({
      superadminId, actorUsuarioId,
      accion: existente ? 'integracion_rappi_actualizada' : 'integracion_rappi_creada',
      negocioId,
      estadoAnterior: existente ? { storeId: existente.identificador, estado: existente.estado } : null,
      estadoNuevo: { storeId: sid, estado: 'activo' },
      contexto: { claves: Object.keys(cfg).filter(k => k !== 'rappi_webhook_secret') },
    }, client);
    await client.query('COMMIT');
    return obtenerIntegracionRappi(negocioId);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Escenario B: credenciales propias, secreto cifrado. */
export async function guardarCredencialesRappi(negocioId, { clientId, clientSecret } = {}, actor = null) {
  if (!esUuid(negocioId)) throw Object.assign(new Error('negocioId inválido'), { codigo: 'NEGOCIO_INVALIDO' });
  if (typeof clientId !== 'string' || !clientId.trim()) throw Object.assign(new Error('clientId requerido'), { codigo: 'CLIENT_ID_REQUERIDO' });
  if (typeof clientSecret !== 'string' || !clientSecret.trim()) throw Object.assign(new Error('clientSecret requerido'), { codigo: 'CLIENT_SECRET_REQUERIDO' });
  const integracion = await obtenerIntegracionRappi(negocioId, { soloActiva: false });
  if (!integracion) throw Object.assign(new Error('El negocio no tiene store de Rappi vinculado'), { codigo: 'SIN_INTEGRACION' });
  const { superadminId, actorUsuarioId } = normalizarActor(actor);

  const { cifrado, iv, authTag, version } = cifrarSecretoIntegracion(clientSecret.trim());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO integraciones_canal_credenciales (integracion_id, access_token_cifrado, token_iv, token_auth_tag, token_formato_version)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (integracion_id) DO UPDATE SET
         access_token_cifrado = $2, token_iv = $3, token_auth_tag = $4, token_formato_version = $5, actualizado_at = NOW()`,
      [integracion.integracionId, cifrado, iv, authTag, version]);
    await client.query(
      `UPDATE integraciones_canal
          SET proveedor = $2, configuracion = COALESCE(configuracion, '{}'::jsonb) || $3::jsonb, updated_at = NOW()
        WHERE id = $1`,
      [integracion.integracionId, PROVEEDOR_RAPPI, JSON.stringify({ rappi_client_id: clientId.trim() })]);
    await registrarAuditoriaPlataforma({
      superadminId, actorUsuarioId, accion: 'integracion_rappi_credenciales_guardadas', negocioId,
      estadoNuevo: { origen: 'negocio' }, contexto: { clientIdSufijo: clientId.trim().slice(-4) },
    }, client);
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function eliminarCredencialesRappi(negocioId, actor = null) {
  if (!esUuid(negocioId)) return false;
  const integracion = await obtenerIntegracionRappi(negocioId, { soloActiva: false });
  if (!integracion) return false;
  const { superadminId, actorUsuarioId } = normalizarActor(actor);
  await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id = $1`, [integracion.integracionId]);
  await pool.query(
    `UPDATE integraciones_canal SET configuracion = COALESCE(configuracion, '{}'::jsonb) - 'rappi_client_id', updated_at = NOW() WHERE id = $1`,
    [integracion.integracionId]);
  await registrarAuditoriaPlataforma({ superadminId, actorUsuarioId, accion: 'integracion_rappi_credenciales_eliminadas', negocioId });
  return true;
}

/** Vista segura para respuestas HTTP: nunca secretos. */
export function integracionRappiParaRespuesta(integracion) {
  if (!integracion) return null;
  const { rappi_webhook_secret: _omitido, ...cfg } = integracion.configuracion || {};
  return {
    integracionId: integracion.integracionId,
    negocioId: integracion.negocioId,
    storeId: integracion.storeId,
    nombre: integracion.nombre,
    sucursalId: integracion.sucursalId,
    activo: integracion.activo,
    estado: integracion.estado,
    credenciales: integracion.tieneCredencialesPropias ? 'negocio' : 'entorno',
    firma: modoFirmaDe(integracion),
    secretoWebhookConfigurado: secretoWebhookDe(integracion) !== null,
    cookingTime: cookingTimeDe(integracion),
    configuracion: cfg,
  };
}
