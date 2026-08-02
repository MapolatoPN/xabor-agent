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

import crypto from 'crypto';
import { pool, registrarAuditoriaPlataforma, habilitarMetodoPagoPorProveedorPrincipal } from './database.js';
import { cifrarSecretoIntegracion, descifrarSecretoIntegracion } from './cifradoIntegraciones.js';
import { esProveedorValido, validarPuedeActivarse, obtenerAdaptador } from './paymentProviders.js';

const ESTADOS_VALIDOS = ['no_configurado', 'pendiente_configuracion', 'pendiente_activacion', 'activo', 'suspendido', 'error'];

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
  ultimo_error_codigo, ultimo_error_at,
  numero_registrado_cloud_api, app_suscrita_waba, ultimo_intento_activacion_at
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
 * Estado resultante: 'pendiente_activacion' si phoneNumberId + accessToken
 * están presentes (credenciales completas, pero AÚN NO confirmado que el
 * número esté registrado en Cloud API ni que la app esté suscrita a la
 * WABA -- ver completarActivacionWhatsapp); 'pendiente_configuracion' si
 * falta alguno (guardado parcial, aún no operable).
 *
 * Nunca pasa a 'activo' aquí: tener token + phone_number_id NO significa
 * que el número esté operable en Meta (incidente real, negocio Alora, 2
 * de agosto de 2026 -- Meta completaba Embedded Signup, Xabor guardaba
 * las credenciales, pero el número quedaba en Meta con estado
 * "Pendiente" porque faltaban /register y /subscribed_apps). Ver
 * metaEmbeddedSignup.js para el detalle de esos dos pasos.
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

  const nuevoEstado = 'pendiente_activacion'; // ambos campos obligatorios ya están validados arriba -- falta confirmar activación real (ver completarActivacionWhatsapp)
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

/**
 * Uso interno exclusivo de completarActivacionWhatsapp -- a diferencia de
 * obtenerCredencialesDescifradas, también acepta 'pendiente_activacion'
 * (todavía no promovida a 'activo'), porque para completar la
 * activación necesariamente hay que leer el token ANTES de que el
 * estado sea 'activo'. Nunca expuesta fuera de este archivo.
 */
async function obtenerCredencialesParaActivacion(negocioId, canal, proveedor) {
  const { rows } = await pool.query(
    `SELECT ic.id, ic.identificador, ic.waba_id, ic.estado,
            cc.access_token_cifrado, cc.token_iv, cc.token_auth_tag, cc.token_formato_version,
            cc.pin_verificacion_cifrado, cc.pin_iv, cc.pin_auth_tag, cc.pin_formato_version
     FROM integraciones_canal ic
     JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id
     WHERE ic.negocio_id = $1 AND ic.canal = $2 AND ic.proveedor = $3`,
    [negocioId.trim(), canal.trim(), proveedor.trim()]
  );
  const row = rows[0];
  if (!row || !['pendiente_activacion', 'activo'].includes(row.estado) || !row.identificador || !row.waba_id) return null;

  const accessToken = descifrarSecretoIntegracion({
    cifrado: row.access_token_cifrado, iv: row.token_iv,
    authTag: row.token_auth_tag, version: row.token_formato_version,
  });
  let pin = null;
  if (row.pin_verificacion_cifrado) {
    pin = descifrarSecretoIntegracion({
      cifrado: row.pin_verificacion_cifrado, iv: row.pin_iv,
      authTag: row.pin_auth_tag, version: row.pin_formato_version,
    });
  }
  return { integracionId: row.id, phoneNumberId: row.identificador, wabaId: row.waba_id, accessToken, pin };
}

/**
 * Completa la activación real de una integración de WhatsApp ya
 * guardada (estado 'pendiente_activacion' o 'activo'): registra el
 * número para Cloud API (POST /register) y suscribe la app a la WABA
 * (POST /subscribed_apps). Solo pasa a estado 'activo' si AMBOS pasos
 * terminan en éxito -- si cualquiera falla, se queda en
 * 'pendiente_activacion' con el detalle (sanitizado) del error
 * guardado, para poder reintentar más tarde sin repetir el Embedded
 * Signup completo (ver ruta "Completar activación" en Superadmin).
 *
 * El PIN de verificación en dos pasos se genera una sola vez (la
 * primera vez que se llama para esta integración) y se guarda cifrado
 * para reutilizarse en reintentos -- Meta exige el mismo PIN en
 * llamadas posteriores a /register una vez que el número ya tiene 2FA
 * activado.
 *
 * Nunca borra ni toca las credenciales existentes (access_token,
 * identificadores) -- solo actualiza estado/flags/auditoría.
 */
export async function completarActivacionWhatsapp(negocioId, actualizadoPor) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    return { ok: false, error: 'negocioId inválido' };
  }
  const datos = await obtenerCredencialesParaActivacion(negocioId.trim(), 'whatsapp', 'meta');
  if (!datos) {
    return { ok: false, error: 'No hay credenciales completas para activar (falta phone_number_id, waba_id o token)' };
  }

  const { registrarNumeroCloudApi, suscribirAppWaba } = await import('./metaEmbeddedSignup.js');

  const pin = datos.pin || crypto.randomInt(100000, 1000000).toString();
  const pinEsNuevo = !datos.pin;

  const resultadoRegistro = await registrarNumeroCloudApi(datos.phoneNumberId, datos.accessToken, pin);
  const resultadoSuscripcion = await suscribirAppWaba(datos.wabaId, datos.accessToken);
  const ambosOk = resultadoRegistro.ok && resultadoSuscripcion.ok;
  const nuevoEstado = ambosOk ? 'activo' : 'pendiente_activacion';

  // Identificador controlado del error (nunca el mensaje crudo de Meta),
  // mismo criterio que el resto de este archivo para ultimo_error_codigo.
  const codigoErrorControlado = ambosOk ? null
    : !resultadoRegistro.ok ? `registro:${resultadoRegistro.resumen?.codigo ?? 'red'}`
    : `subscribed_apps:${resultadoSuscripcion.resumen?.codigo ?? 'red'}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // El PIN solo se persiste si el registro tuvo éxito con él -- un PIN
    // que Meta rechazó no quedó fijado como 2FA del número, guardarlo
    // haría que el próximo reintento fallara por un PIN incorrecto en
    // vez de por la causa real.
    if (pinEsNuevo && resultadoRegistro.ok) {
      const { cifrado, iv, authTag, version } = cifrarSecretoIntegracion(pin);
      await client.query(
        `UPDATE integraciones_canal_credenciales SET
           pin_verificacion_cifrado = $1, pin_iv = $2, pin_auth_tag = $3, pin_formato_version = $4,
           actualizado_at = NOW()
         WHERE integracion_id = $5`,
        [cifrado, iv, authTag, version, datos.integracionId]
      );
    }

    await client.query(
      `UPDATE integraciones_canal SET
         estado = $1,
         numero_registrado_cloud_api = $2, app_suscrita_waba = $3,
         ultimo_intento_activacion_at = NOW(),
         ultimo_error_codigo = $4, ultimo_error_at = $5,
         actualizado_por = $6, updated_at = NOW()
       WHERE id = $7`,
      [nuevoEstado, resultadoRegistro.ok, resultadoSuscripcion.ok,
       codigoErrorControlado, ambosOk ? null : new Date(),
       actualizadoPor || null, datos.integracionId]
    );

    await registrarAuditoriaPlataforma({
      superadminId: actualizadoPor,
      accion: 'integracion_activacion_completada',
      negocioId: negocioId.trim(),
      estadoNuevo: { estado: nuevoEstado, numeroRegistrado: resultadoRegistro.ok, appSuscrita: resultadoSuscripcion.ok },
      // Solo status HTTP + código/tipo de error resumidos -- nunca el
      // access_token, el PIN, ni el cuerpo crudo de la respuesta de Meta.
      contexto: {
        registro: { ok: resultadoRegistro.ok, status: resultadoRegistro.status, codigo: resultadoRegistro.resumen?.codigo ?? null, tipo: resultadoRegistro.resumen?.tipo ?? null },
        suscripcion: { ok: resultadoSuscripcion.ok, status: resultadoSuscripcion.status, codigo: resultadoSuscripcion.resumen?.codigo ?? null, tipo: resultadoSuscripcion.resumen?.tipo ?? null },
      },
    }, client);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return {
    ok: ambosOk,
    estado: nuevoEstado,
    numeroRegistrado: resultadoRegistro.ok,
    appSuscrita: resultadoSuscripcion.ok,
    errorRegistro: resultadoRegistro.ok ? null : resultadoRegistro.resumen,
    errorSuscripcion: resultadoSuscripcion.ok ? null : resultadoSuscripcion.resumen,
  };
}

/**
 * Clip por negocio (Incidente P0, 2 de agosto de 2026): antes de esto,
 * crearLinkDePago() (clip-api.js) usaba una única credencial GLOBAL
 * (getIntegracion('clip_api_key'), server.js) sin ningún negocioId --
 * causa raíz confirmada de que un cliente de WhatsApp de Alora recibiera
 * un enlace de pago generado con la cuenta Clip de Nonna Maye. Se
 * reutilizan integraciones_canal/integraciones_canal_credenciales
 * (canal='pagos', proveedor='clip') -- mismo modelo que WhatsApp/Meta,
 * mismo cifrado AES-256-GCM. Clip requiere DOS secretos (api_key +
 * api_secret) en vez de uno solo: se serializan como un único JSON y se
 * cifran juntos en la columna access_token_cifrado existente -- no hace
 * falta ninguna columna ni migración nueva para esto.
 */
export async function guardarCredencialesClip(negocioId, apiKey, apiSecret, actualizadoPor) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw new Error('guardarCredencialesClip: negocioId requerido');
  }
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('guardarCredencialesClip: apiKey requerido');
  }
  if (typeof apiSecret !== 'string' || !apiSecret.trim()) {
    throw new Error('guardarCredencialesClip: apiSecret requerido');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existente = await client.query(
      `SELECT id, estado FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos' AND proveedor = 'clip'`,
      [negocioId.trim()]
    );

    let integracionId;
    if (existente.rows[0]) {
      integracionId = existente.rows[0].id;
      await client.query(
        `UPDATE integraciones_canal SET estado = 'activo', activo = TRUE,
           actualizado_por = $1, updated_at = NOW(), ultimo_error_codigo = NULL, ultimo_error_at = NULL
         WHERE id = $2`,
        [actualizadoPor || null, integracionId]
      );
    } else {
      // identificador es NOT NULL en integraciones_canal (migración 008) --
      // Clip no tiene un identificador público natural como el
      // phone_number_id de WhatsApp, así que se usa un valor sintético
      // determinístico ('clip:<negocioId>'), único por negocio por
      // construcción -- nunca colisiona entre negocios ni con otros
      // canales, y satisface también el UNIQUE(canal, identificador).
      const { rows: [nueva] } = await client.query(
        `INSERT INTO integraciones_canal (negocio_id, canal, proveedor, identificador, estado, activo, conectado_at, actualizado_por)
         VALUES ($1,'pagos','clip',$2,'activo',TRUE,NOW(),$3)
         RETURNING id`,
        [negocioId.trim(), `clip:${negocioId.trim()}`, actualizadoPor || null]
      );
      integracionId = nueva.id;
    }

    const { cifrado, iv, authTag, version } = cifrarSecretoIntegracion(JSON.stringify({ apiKey: apiKey.trim(), apiSecret: apiSecret.trim() }));
    await client.query(
      `INSERT INTO integraciones_canal_credenciales
         (integracion_id, access_token_cifrado, token_iv, token_auth_tag, token_formato_version)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (integracion_id) DO UPDATE SET
         access_token_cifrado = $2, token_iv = $3, token_auth_tag = $4,
         token_formato_version = $5, actualizado_at = NOW()`,
      [integracionId, cifrado, iv, authTag, version]
    );

    // Auditoría: nunca apiKey/apiSecret, solo el hecho de que se guardaron.
    await registrarAuditoriaPlataforma({
      superadminId: actualizadoPor,
      accion: existente.rows[0] ? 'integracion_clip_actualizada' : 'integracion_clip_creada',
      negocioId: negocioId.trim(),
      estadoNuevo: { estado: 'activo', canal: 'pagos', proveedor: 'clip' },
      contexto: {},
    }, client);

    await client.query('COMMIT');
    return { id: integracionId, estado: 'activo' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * ÚNICA función que devuelve las credenciales de Clip en texto plano --
 * uso exclusivo de clip-api.js (nunca un controlador HTTP). Fail-closed:
 * devuelve null si negocioId falta, si la integración no existe, no está
 * 'activo', o si el descifrado falla -- nunca cae a una credencial de
 * otro negocio ni a una variable de entorno global. El llamador debe
 * transferir a atención humana cuando esto devuelve null, nunca usar
 * un valor de respaldo.
 */
export async function obtenerCredencialesClipDescifradas(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  try {
    const { rows } = await pool.query(
      `SELECT ic.estado, cc.access_token_cifrado, cc.token_iv, cc.token_auth_tag, cc.token_formato_version
       FROM integraciones_canal ic
       JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id
       WHERE ic.negocio_id = $1 AND ic.canal = 'pagos' AND ic.proveedor = 'clip'`,
      [negocioId.trim()]
    );
    const row = rows[0];
    if (!row || row.estado !== 'activo') return null;

    const json = descifrarSecretoIntegracion({
      cifrado: row.access_token_cifrado,
      iv: row.token_iv,
      authTag: row.token_auth_tag,
      version: row.token_formato_version,
    });
    const { apiKey, apiSecret } = JSON.parse(json);
    if (!apiKey || !apiSecret) return null;
    return { apiKey, apiSecret };
  } catch (e) {
    console.error('[Integraciones] Error obtenerCredencialesClipDescifradas (negocio ocultado):', e.message);
    return null;
  }
}

// ─── Arquitectura genérica de proveedores de pago (Fase 2/3) ────────────────
// Generaliza el patrón de guardarCredencialesClip/obtenerCredencialesClipDescifradas
// (arriba) a cualquier proveedor registrado en paymentProviders.js.
// guardarCredencialesClip/obtenerCredencialesClipDescifradas se conservan tal
// cual (clip-api.js ya las usa) por compatibilidad -- son ahora casos
// concretos de estas funciones genéricas, no un mecanismo paralelo.

const COLUMNAS_PAGO_SEGURAS = `
  id, negocio_id, canal, proveedor, estado, identificador, principal, ambiente,
  ultima_prueba_at, ultima_prueba_ok, activo, conectado_at, created_at, updated_at,
  actualizado_por, ultimo_error_codigo, ultimo_error_at
`;

/** Guarda/actualiza credenciales de un proveedor de pago para un negocio. Nunca activa un proveedor sin adaptador real. */
export async function guardarIntegracionPago(negocioId, proveedor, credenciales, { ambiente = 'sandbox', actualizadoPor = null } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new Error('guardarIntegracionPago: negocioId requerido');
  if (!esProveedorValido(proveedor)) throw new Error(`guardarIntegracionPago: proveedor "${proveedor}" no reconocido`);
  if (!validarPuedeActivarse(proveedor)) throw new Error(`guardarIntegracionPago: "${proveedor}" todavía no tiene adaptador implementado`);
  if (ambiente === 'produccion') {
    // No permitir ambiente producción sin credenciales completas (instrucción
    // explícita del encargo) -- credenciales ya se validaron como no-vacías
    // más abajo antes de cifrar; aquí solo se re-afirma la intención.
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existente = await client.query(
      `SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos' AND proveedor = $2`,
      [negocioId.trim(), proveedor]
    );
    let integracionId;
    if (existente.rows[0]) {
      integracionId = existente.rows[0].id;
      await client.query(
        `UPDATE integraciones_canal SET estado = 'activo', activo = TRUE, ambiente = $2,
           actualizado_por = $3, updated_at = NOW(), ultimo_error_codigo = NULL, ultimo_error_at = NULL
         WHERE id = $1`,
        [integracionId, ambiente, actualizadoPor]
      );
    } else {
      const { rows: [nueva] } = await client.query(
        `INSERT INTO integraciones_canal (negocio_id, canal, proveedor, identificador, estado, activo, ambiente, conectado_at, actualizado_por)
         VALUES ($1,'pagos',$2,$3,'activo',TRUE,$4,NOW(),$5)
         RETURNING id`,
        [negocioId.trim(), proveedor, `${proveedor}:${negocioId.trim()}`, ambiente, actualizadoPor]
      );
      integracionId = nueva.id;
    }
    const { cifrado, iv, authTag, version } = cifrarSecretoIntegracion(JSON.stringify(credenciales || {}));
    await client.query(
      `INSERT INTO integraciones_canal_credenciales (integracion_id, access_token_cifrado, token_iv, token_auth_tag, token_formato_version)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (integracion_id) DO UPDATE SET
         access_token_cifrado = $2, token_iv = $3, token_auth_tag = $4, token_formato_version = $5, actualizado_at = NOW()`,
      [integracionId, cifrado, iv, authTag, version]
    );
    await registrarAuditoriaPlataforma({
      superadminId: actualizadoPor, negocioId: negocioId.trim(),
      accion: existente.rows[0] ? 'integracion_pago_actualizada' : 'integracion_pago_creada',
      estadoNuevo: { proveedor, estado: 'activo', ambiente }, contexto: {},
    }, client);
    await client.query('COMMIT');
    return { id: integracionId, estado: 'activo' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Lectura segura (nunca secretos) de UNA integración de pago. */
export async function obtenerIntegracionPago(negocioId, proveedor) {
  if (typeof negocioId !== 'string' || !negocioId.trim() || !esProveedorValido(proveedor)) return null;
  const { rows } = await pool.query(
    `SELECT ${COLUMNAS_PAGO_SEGURAS} FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos' AND proveedor = $2 AND estado != 'eliminado'`,
    [negocioId.trim(), proveedor]
  );
  return rows[0] || null;
}

/** Lista todas las integraciones de pago del negocio (nunca secretos). */
export async function listarIntegracionesPago(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  const { rows } = await pool.query(
    `SELECT ${COLUMNAS_PAGO_SEGURAS} FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos' AND estado != 'eliminado' ORDER BY principal DESC, created_at`,
    [negocioId.trim()]
  );
  return rows;
}

/** Resuelve el proveedor PRINCIPAL activo de un negocio (o null). Nunca cae a otro negocio. */
export async function obtenerProveedorPrincipal(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const { rows } = await pool.query(
    `SELECT ${COLUMNAS_PAGO_SEGURAS} FROM integraciones_canal
     WHERE negocio_id = $1 AND canal = 'pagos' AND principal = TRUE AND estado = 'activo'`,
    [negocioId.trim()]
  );
  return rows[0] || null;
}

// Devuelve { ok, estadoNuevo } -- mismo formato que actualizarEstadoIntegracion
// (el equivalente para WhatsApp/Meta), para que los endpoints HTTP puedan
// tratar ambos caminos igual sin adivinar si el valor es un boolean crudo.
async function cambiarEstadoIntegracionPago(negocioId, proveedor, nuevoEstado, actualizadoPor) {
  if (typeof negocioId !== 'string' || !negocioId.trim() || !esProveedorValido(proveedor)) {
    return { ok: false, error: 'negocioId/proveedor inválidos' };
  }
  const { rows } = await pool.query(
    `UPDATE integraciones_canal SET estado = $3, actualizado_por = $4, updated_at = NOW()
     WHERE negocio_id = $1 AND canal = 'pagos' AND proveedor = $2 AND estado != 'eliminado'
     RETURNING id`,
    [negocioId.trim(), proveedor, nuevoEstado, actualizadoPor || null]
  );
  if (!rows[0]) return { ok: false, error: 'Integración no encontrada' };
  await registrarAuditoriaPlataforma({
    superadminId: actualizadoPor, negocioId: negocioId.trim(),
    accion: `integracion_pago_${nuevoEstado}`, estadoNuevo: { proveedor, estado: nuevoEstado }, contexto: {},
  });
  return { ok: true, estadoNuevo: nuevoEstado };
}

export async function suspenderIntegracionPago(negocioId, proveedor, actualizadoPor) {
  // Suspender el principal lo desmarca -- un proveedor suspendido nunca
  // debe seguir resolviéndose como principal para generar enlaces nuevos.
  await pool.query(
    `UPDATE integraciones_canal SET principal = FALSE WHERE negocio_id = $1 AND canal = 'pagos' AND proveedor = $2`,
    [negocioId?.trim?.(), proveedor]
  );
  return cambiarEstadoIntegracionPago(negocioId, proveedor, 'suspendido', actualizadoPor);
}

export async function reactivarIntegracionPago(negocioId, proveedor, actualizadoPor) {
  return cambiarEstadoIntegracionPago(negocioId, proveedor, 'activo', actualizadoPor);
}

/** Soft-delete: nunca borra la fila físicamente (auditoría), y jamás puede quedar como principal. */
export async function eliminarCredencialesPago(negocioId, proveedor, actualizadoPor) {
  if (typeof negocioId !== 'string' || !negocioId.trim() || !esProveedorValido(proveedor)) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE integraciones_canal SET estado = 'eliminado', activo = FALSE, principal = FALSE, actualizado_por = $3, updated_at = NOW()
       WHERE negocio_id = $1 AND canal = 'pagos' AND proveedor = $2
       RETURNING id`,
      [negocioId.trim(), proveedor, actualizadoPor || null]
    );
    if (rows[0]) {
      await client.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id = $1`, [rows[0].id]);
      await registrarAuditoriaPlataforma({
        superadminId: actualizadoPor, negocioId: negocioId.trim(),
        accion: 'integracion_pago_eliminada', estadoNuevo: { proveedor, estado: 'eliminado' }, contexto: {},
      }, client);
    }
    await client.query('COMMIT');
    return !!rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Marca un proveedor como principal para enlaces automáticos. Transaccional:
 * el índice único parcial (migración 025) impide dos principales a la vez,
 * pero se desmarca el anterior explícitamente dentro de la misma
 * transacción para nunca depender solo del constraint ante una carrera.
 */
export async function marcarProveedorPrincipal(negocioId, proveedor, actualizadoPor) {
  if (typeof negocioId !== 'string' || !negocioId.trim() || !esProveedorValido(proveedor)) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const objetivo = await client.query(
      `SELECT id, estado FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos' AND proveedor = $2`,
      [negocioId.trim(), proveedor]
    );
    if (!objetivo.rows[0] || objetivo.rows[0].estado !== 'activo') {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `UPDATE integraciones_canal SET principal = FALSE WHERE negocio_id = $1 AND canal = 'pagos' AND principal = TRUE`,
      [negocioId.trim()]
    );
    await client.query(
      `UPDATE integraciones_canal SET principal = TRUE, actualizado_por = $2, updated_at = NOW() WHERE id = $1`,
      [objetivo.rows[0].id, actualizadoPor || null]
    );
    await registrarAuditoriaPlataforma({
      superadminId: actualizadoPor, negocioId: negocioId.trim(),
      accion: 'integracion_pago_marcada_principal', estadoNuevo: { proveedor }, contexto: {},
    }, client);
    await client.query('COMMIT');

    // Habilita automáticamente el método de pago que este proveedor hace
    // posible (enlace_pago para proveedores con checkout real, transferencia
    // para manual_transfer) -- fuera de la transacción anterior a propósito
    // (tabla distinta, no crítica para la atomicidad de "quién es principal");
    // si esto falla, el proveedor ya quedó marcado principal correctamente y
    // el admin puede habilitar el método a mano desde el panel del negocio.
    const adaptador = obtenerAdaptador(proveedor);
    const tipo = adaptador?.getCapabilities?.().createLink ? 'enlace_pago' : 'transferencia';
    await habilitarMetodoPagoPorProveedorPrincipal(negocioId, tipo, objetivo.rows[0].id).catch(e =>
      console.error('[Integraciones] No se pudo auto-habilitar metodos_pago tras marcar principal:', e.message)
    );
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Descifra credenciales de CUALQUIER proveedor de pago -- uso exclusivo de
 * los propios adaptadores (nunca un controlador HTTP). Fail-closed: null si
 * no existe, no está activo, o el descifrado falla.
 */
export async function obtenerCredencialesPagoDescifradas(negocioId, proveedor) {
  if (typeof negocioId !== 'string' || !negocioId.trim() || !esProveedorValido(proveedor)) return null;
  try {
    const { rows } = await pool.query(
      `SELECT ic.estado, cc.access_token_cifrado, cc.token_iv, cc.token_auth_tag, cc.token_formato_version
       FROM integraciones_canal ic JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id
       WHERE ic.negocio_id = $1 AND ic.canal = 'pagos' AND ic.proveedor = $2`,
      [negocioId.trim(), proveedor]
    );
    const row = rows[0];
    if (!row || row.estado !== 'activo') return null;
    const json = descifrarSecretoIntegracion({
      cifrado: row.access_token_cifrado, iv: row.token_iv, authTag: row.token_auth_tag, version: row.token_formato_version,
    });
    return JSON.parse(json);
  } catch (e) {
    console.error('[Integraciones] Error obtenerCredencialesPagoDescifradas (negocio ocultado):', e.message);
    return null;
  }
}

/**
 * Prueba de conexión: delega en el adaptador. Nunca crea un cargo real
 * (el encargo lo prohíbe explícitamente) -- cada adaptador decide qué
 * cuenta como "prueba" segura (ver clipProvider.js). Registra el
 * resultado (sin secretos) en integraciones_canal para la UI.
 */
export async function probarIntegracionPago(negocioId, proveedor) {
  const adaptador = obtenerAdaptador(proveedor);
  if (!adaptador) return { ok: false, motivo: 'proveedor sin adaptador implementado' };
  const credenciales = await obtenerCredencialesPagoDescifradas(negocioId, proveedor);
  if (!credenciales) return { ok: false, motivo: 'sin credenciales configuradas' };
  const resultado = await adaptador.testConnection(credenciales);
  await pool.query(
    `UPDATE integraciones_canal SET ultima_prueba_at = NOW(), ultima_prueba_ok = $3
     WHERE negocio_id = $1 AND canal = 'pagos' AND proveedor = $2`,
    [negocioId.trim(), proveedor, !!resultado.ok]
  );
  return resultado;
}
