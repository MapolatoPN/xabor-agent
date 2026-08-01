/**
 * integracionesService.js — Fase B de WhatsApp multiempresa.
 *
 * Gestión de integraciones de canal por negocio (hoy: WhatsApp/Meta),
 * con credenciales cifradas (AES-256-GCM, ver cifradoIntegraciones.js).
 *
 * Todas las funciones son fail-closed: negocioId/canal/proveedor
 * inválidos u omitidos devuelven null/false/lista vacía, nunca
 * asumen ni adivinan. Ninguna función de este archivo, salvo
 * obtenerCredencialesDescifradas (uso interno exclusivo del motor de
 * envío), devuelve el token en texto plano ni ningún campo cifrado --
 * los controladores nunca deben pasar esos campos hacia una respuesta
 * HTTP.
 */

import { pool, registrarAuditoriaPlataforma } from './database.js';
import { cifrarSecretoIntegracion, descifrarSecretoIntegracion } from './cifradoIntegraciones.js';

const ESTADOS_VALIDOS = ['no_configurado', 'pendiente_configuracion', 'activo', 'suspendido', 'error'];

function validarParams(negocioId, canal, proveedor) {
  return typeof negocioId === 'string' && negocioId.trim()
    && typeof canal === 'string' && canal.trim()
    && typeof proveedor === 'string' && proveedor.trim();
}

// Campos seguros -- nunca incluye access_token_cifrado, token_iv ni
// token_auth_tag, aunque el llamador use SELECT * por error en el
// futuro esto seguiría siendo responsabilidad del propio query, que
// aquí siempre los excluye explícitamente.
const COLUMNAS_SEGURAS = `
  id, negocio_id, canal, proveedor, estado, identificador,
  waba_id, business_id, display_phone_number, nombre,
  activo, conectado_at, created_at, updated_at, actualizado_por,
  ultimo_error_codigo, ultimo_error_at
`;

/**
 * Lectura segura de la integración (nunca secretos). Retorna null si
 * no existe o si los parámetros son inválidos.
 */
export async function obtenerIntegracionNegocio(negocioId, canal, proveedor) {
  if (!validarParams(negocioId, canal, proveedor)) return null;
  try {
    const { rows } = await pool.query(
      `SELECT ${COLUMNAS_SEGURAS} FROM integraciones_canal
       WHERE negocio_id = $1 AND canal = $2 AND proveedor = $3`,
      [negocioId.trim(), canal.trim(), proveedor.trim()]
    );
    return rows[0] || null;
  } catch (e) {
    console.error('[Integraciones] Error obtenerIntegracionNegocio:', e.message);
    return null;
  }
}

/**
 * Lista todas las integraciones (cualquier canal/proveedor) de un
 * negocio, columnas seguras únicamente. Usada por la pantalla
 * Superadmin para el resumen general "Integraciones" de un negocio.
 */
export async function obtenerIntegracionesNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  try {
    const { rows } = await pool.query(
      `SELECT ${COLUMNAS_SEGURAS} FROM integraciones_canal
       WHERE negocio_id = $1 ORDER BY canal, proveedor NULLS FIRST`,
      [negocioId.trim()]
    );
    return rows;
  } catch (e) {
    console.error('[Integraciones] Error obtenerIntegracionesNegocio:', e.message);
    return [];
  }
}

export async function obtenerEstadoIntegracion(negocioId, canal, proveedor) {
  const row = await obtenerIntegracionNegocio(negocioId, canal, proveedor);
  return row?.estado || 'no_configurado';
}

/**
 * Guarda (crea o actualiza) las credenciales de una integración,
 * cifradas. `datos`: { phoneNumberId, wabaId, businessId,
 * displayPhoneNumber, accessToken, nombre }. `accessToken` es el único
 * campo que se cifra; el resto son identificadores/metadatos no
 * sensibles.
 *
 * Estado resultante: 'activo' si phoneNumberId + accessToken están
 * presentes (integración completa y usable); 'pendiente_configuracion'
 * si falta alguno (guardado parcial, aún no operable).
 *
 * Transaccional: la fila de integraciones_canal y la de credenciales se
 * escriben juntas o no se escribe ninguna.
 */
export async function guardarCredencialesCifradas(negocioId, canal, proveedor, datos, actualizadoPor) {
  if (!validarParams(negocioId, canal, proveedor)) {
    throw new Error('guardarCredencialesCifradas: negocioId/canal/proveedor inválidos u omitidos');
  }
  const { phoneNumberId, wabaId, businessId, displayPhoneNumber, accessToken, nombre } = datos || {};
  if (typeof phoneNumberId !== 'string' || !phoneNumberId.trim()) {
    throw new Error('guardarCredencialesCifradas: phoneNumberId requerido');
  }
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('guardarCredencialesCifradas: accessToken requerido');
  }

  const nuevoEstado = 'activo'; // ambos campos obligatorios ya están validados arriba
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existente = await client.query(
      `SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal = $2 AND proveedor = $3`,
      [negocioId.trim(), canal.trim(), proveedor.trim()]
    );

    let integracionId;
    if (existente.rows[0]) {
      integracionId = existente.rows[0].id;
      await client.query(
        `UPDATE integraciones_canal SET
           identificador = $1, waba_id = $2, business_id = $3, display_phone_number = $4,
           nombre = COALESCE($5, nombre), estado = $6, activo = TRUE,
           actualizado_por = $7, updated_at = NOW(), ultimo_error_codigo = NULL, ultimo_error_at = NULL
         WHERE id = $8`,
        [phoneNumberId.trim(), wabaId || null, businessId || null, displayPhoneNumber || null,
         nombre || null, nuevoEstado, actualizadoPor || null, integracionId]
      );
    } else {
      const { rows: [nueva] } = await client.query(
        `INSERT INTO integraciones_canal
           (negocio_id, canal, proveedor, identificador, waba_id, business_id, display_phone_number,
            nombre, estado, activo, conectado_at, actualizado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,NOW(),$10)
         RETURNING id`,
        [negocioId.trim(), canal.trim(), proveedor.trim(), phoneNumberId.trim(),
         wabaId || null, businessId || null, displayPhoneNumber || null,
         nombre || null, nuevoEstado, actualizadoPor || null]
      );
      integracionId = nueva.id;
    }

    const { cifrado, iv, authTag, version } = cifrarSecretoIntegracion(accessToken.trim());
    await client.query(
      `INSERT INTO integraciones_canal_credenciales
         (integracion_id, access_token_cifrado, token_iv, token_auth_tag, token_formato_version)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (integracion_id) DO UPDATE SET
         access_token_cifrado = $2, token_iv = $3, token_auth_tag = $4,
         token_formato_version = $5, actualizado_at = NOW()`,
      [integracionId, cifrado, iv, authTag, version]
    );

    // Auditoría: nunca el token ni ningún campo cifrado -- solo
    // identificadores no sensibles y el estado resultante.
    await registrarAuditoriaPlataforma({
      superadminId: actualizadoPor,
      accion: existente.rows[0] ? 'integracion_credenciales_actualizadas' : 'integracion_credenciales_creadas',
      negocioId: negocioId.trim(),
      estadoAnterior: existente.rows[0] ? { estado: existente.rows[0].estado } : null,
      estadoNuevo: { estado: nuevoEstado, canal: canal.trim(), proveedor: proveedor.trim() },
      contexto: { phoneNumberId: phoneNumberId.trim(), wabaId: wabaId || null, businessId: businessId || null },
    }, client);

    await client.query('COMMIT');
    return { id: integracionId, estado: nuevoEstado };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Cambia el estado técnico. Reglas:
 * - 'activo': exige que ya existan identificador (phone_number_id) y
 *   una fila de credenciales -- nunca se activa una integración
 *   incompleta.
 * - 'suspendido': conserva credenciales, solo bloquea uso (ver
 *   obtenerCredencialesDescifradas).
 * - 'pendiente_configuracion'/'no_configurado'/'error': sin
 *   requisitos adicionales.
 */
export async function actualizarEstadoIntegracion(negocioId, canal, proveedor, nuevoEstado, actualizadoPor) {
  if (!validarParams(negocioId, canal, proveedor)) return { ok: false, error: 'negocioId/canal/proveedor inválidos' };
  if (!ESTADOS_VALIDOS.includes(nuevoEstado)) return { ok: false, error: 'Estado inválido' };

  const actual = await obtenerIntegracionNegocio(negocioId, canal, proveedor);
  if (!actual) return { ok: false, error: 'Integración no encontrada' };

  if (nuevoEstado === 'activo') {
    const { rows } = await pool.query(
      `SELECT 1 FROM integraciones_canal_credenciales WHERE integracion_id = $1`,
      [actual.id]
    );
    if (!actual.identificador || !rows[0]) {
      return { ok: false, error: 'No se puede activar: faltan identificadores o credenciales configuradas' };
    }
  }

  const estadoAnterior = actual.estado;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE integraciones_canal SET estado = $1, activo = $2, actualizado_por = $3, updated_at = NOW()
       WHERE id = $4`,
      [nuevoEstado, nuevoEstado === 'activo', actualizadoPor || null, actual.id]
    );
    await registrarAuditoriaPlataforma({
      superadminId: actualizadoPor,
      accion: 'integracion_estado_actualizado',
      negocioId: negocioId.trim(),
      estadoAnterior: { estado: estadoAnterior },
      estadoNuevo: { estado: nuevoEstado },
      contexto: { canal: canal.trim(), proveedor: proveedor.trim() },
    }, client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { ok: true, estadoAnterior, estadoNuevo: nuevoEstado };
}

export async function suspenderIntegracion(negocioId, canal, proveedor, actualizadoPor) {
  return actualizarEstadoIntegracion(negocioId, canal, proveedor, 'suspendido', actualizadoPor);
}

/**
 * Elimina el material cifrado (acción explícita y distinta de
 * suspender -- suspender preserva credenciales, esto las borra). El
 * routing (identificador/waba_id/business_id) se conserva -- solo se
 * borra el secreto y se baja el estado a 'no_configurado'.
 */
export async function eliminarCredencialesIntegracion(negocioId, canal, proveedor, actualizadoPor) {
  if (!validarParams(negocioId, canal, proveedor)) return { ok: false, error: 'negocioId/canal/proveedor inválidos' };
  const actual = await obtenerIntegracionNegocio(negocioId, canal, proveedor);
  if (!actual) return { ok: false, error: 'Integración no encontrada' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id = $1`, [actual.id]);
    await client.query(
      `UPDATE integraciones_canal SET estado = 'no_configurado', activo = FALSE, actualizado_por = $1, updated_at = NOW()
       WHERE id = $2`,
      [actualizadoPor || null, actual.id]
    );
    await registrarAuditoriaPlataforma({
      superadminId: actualizadoPor,
      accion: 'integracion_credenciales_eliminadas',
      negocioId: negocioId.trim(),
      estadoAnterior: { estado: actual.estado },
      estadoNuevo: { estado: 'no_configurado' },
      contexto: { canal: canal.trim(), proveedor: proveedor.trim() },
    }, client);
    await client.query('COMMIT');
    return { ok: true, estadoAnterior: actual.estado, estadoNuevo: 'no_configurado' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * ÚNICA función de este archivo que devuelve el secreto en texto
 * plano -- uso exclusivo del motor de envío de WhatsApp (nunca un
 * controlador HTTP). Devuelve null si la integración no existe, no
 * está en estado 'activo' (suspendida/error/pendiente no son
 * usables aunque tengan credenciales guardadas), o si el descifrado
 * falla (auth tag inválido, clave incorrecta) -- fail-closed, nunca
 * lanza hacia arriba para no tumbar el flujo de envío.
 */
export async function obtenerCredencialesDescifradas(negocioId, canal, proveedor) {
  if (!validarParams(negocioId, canal, proveedor)) return null;
  try {
    const { rows } = await pool.query(
      `SELECT ic.id, ic.identificador, ic.estado,
              cc.access_token_cifrado, cc.token_iv, cc.token_auth_tag, cc.token_formato_version
       FROM integraciones_canal ic
       JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id
       WHERE ic.negocio_id = $1 AND ic.canal = $2 AND ic.proveedor = $3`,
      [negocioId.trim(), canal.trim(), proveedor.trim()]
    );
    const row = rows[0];
    if (!row || row.estado !== 'activo' || !row.identificador) return null;

    const accessToken = descifrarSecretoIntegracion({
      cifrado: row.access_token_cifrado,
      iv: row.token_iv,
      authTag: row.token_auth_tag,
      version: row.token_formato_version,
    });
    return { phoneNumberId: row.identificador, accessToken };
  } catch (e) {
    console.error('[Integraciones] Error obtenerCredencialesDescifradas (negocio ocultado):', e.message);
    return null;
  }
}
