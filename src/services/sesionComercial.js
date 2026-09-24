/**
 * sesionComercial.js — Estado conversacional DURABLE del Asistente Comercial
 * de Cotizaciones por WhatsApp (máquina de estados descrita en
 * docs/asistente-comercial-detalle-tecnico.md §1, adaptada a v1 solo-texto).
 *
 * Vive en Postgres (tabla sesiones_comerciales), no en el Map en memoria de
 * session.js -- una sesión comercial puede abarcar varios días de
 * conversación y no debe perderse si el proceso se reinicia.
 *
 * Contrato de seguridad (igual que integracionesService.js/memory.js Fase 0):
 * negocioId es obligatorio en toda función. Su ausencia o invalidez lanza
 * TenantContextRequiredError -- nunca hay fallback a Nonna Maye ni a
 * ningún otro negocio. Toda consulta que reciba un sesionId SIEMPRE agrega
 * `AND negocio_id = $x` -- nunca se confía en que un sesionId por sí solo
 * ya implica pertenencia correcta.
 */
import { pool } from './database.js';
import { TenantContextRequiredError } from './integracionesService.js';

const ESTADOS_ACTIVOS_SQL = `('finalizada', 'abandonada')`;

function exigirNegocioId(negocioId, detalle) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw new TenantContextRequiredError(detalle);
  }
  return negocioId.trim();
}

async function registrarEventoSesion(sesionId, negocioId, tipoEvento, detalle = {}) {
  // El log de auditoría nunca debe bloquear el flujo conversacional -- si
  // falla, se registra en consola pero no se relanza (mismo criterio que
  // memory.js registrarEvento).
  try {
    await pool.query(
      `INSERT INTO sesiones_comerciales_eventos (sesion_id, negocio_id, tipo_evento, detalle)
       VALUES ($1, $2, $3, $4)`,
      [sesionId, negocioId, tipoEvento, JSON.stringify(detalle)]
    );
  } catch (e) {
    console.error('[sesionComercial] Error registrando evento de auditoría:', e.message);
  }
}

// ─── UNA SESIÓN COMERCIAL TIENE QUE PODER TERMINARSE SOLA ─────────────────
//
// Nadie marcaba `abandonada` nunca. Ni un job, ni un barrido, ni el propio
// flujo: los seis sitios que escriben esta tabla cambian de estado por algo
// que PASÓ, y que el cliente deje de contestar no pasa en ningún sitio.
//
// Lo que eso provoca no se parece a su causa, y costó encontrarlo:
//
//   · `whatsapp-meta.js` desvía al bot anterior TODA conversación con sesión
//     comercial activa, antes del agente de herramientas y con `return`;
//   · así que una sesión abierta una vez y nunca cerrada ANCLA a ese cliente
//     al bot viejo para siempre, y lo vuelve invisible para el agente y para
//     su canario.
//
// Medido en producción el 23-sep-2026, Mapolato Obispado: **24 clientes**
// anclados, 6 con actividad esa semana. Los 24 con `campos_capturados = {}`,
// un solo evento y `updated_at = created_at` — abiertos una vez, sin capturar
// nada, algunos hacía tres semanas. Uno de ellos llevaba 129 mensajes en
// siete días pidiendo chilaquiles, y ninguno llegó al agente.
//
// ── La regla, y por qué sobre `updated_at` ───────────────────────────────
//
// Una sesión sin NOVEDAD en N horas se da por abandonada. No «sin mensajes»:
// sin novedad EN LA SESIÓN. El trigger `set_updated_at` (migración 028) la
// toca en cada cambio de estado y en cada campo capturado, así que una
// cotización que avanza sobrevive aunque el cliente tarde un día en
// contestar, y una que se abrió y no capturó nada caduca aunque el cliente
// siga escribiendo de otra cosa — que es exactamente la diferencia que hacía
// falta.
//
// Caducar sobre «último mensaje del cliente» habría sido lo contrario: a
// Mario, que escribe a diario, no le habría caducado nunca.
const TTL_HORAS_OMISION = 48;
export const CLAVE_TTL_SESION = 'cotizacion_sesion_ttl_horas';

/**
 * Horas de vida de una sesión sin novedad, según el negocio.
 *
 * Un valor raro, ausente o no positivo cae al default. No se acepta `0`
 * —que caducaría toda sesión al instante y dejaría el asistente comercial
 * inservible sin que nadie tocara su módulo— ni un valor negativo.
 */
export function ttlDeSesionHoras(cfg) {
  const n = Number(String(cfg?.[CLAVE_TTL_SESION] ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : TTL_HORAS_OMISION;
}

/**
 * Sesión activa (no finalizada/abandonada, y CON NOVEDAD RECIENTE) de este
 * negocio+teléfono, o null.
 *
 * Una sesión caducada no solo se deja fuera: se marca `abandonada`, con su
 * evento de auditoría. Dejarla abierta y solo ignorarla aquí haría que el
 * panel siguiera enseñando oportunidades que ya no existen, y que el
 * siguiente que lea la tabla por su cuenta vuelva a tropezar con lo mismo.
 *
 * El marcado no bloquea la respuesta: si falla, se registra y la sesión
 * igualmente se trata como inactiva. Lo que no puede pasar es lo contrario
 * —tratarla como activa porque no se pudo cerrar—, que es el fallo que esto
 * viene a cerrar.
 */
export async function obtenerSesionActiva(negocioId, telefono, { ahora = null, ttlHoras = null } = {}) {
  const nid = exigirNegocioId(negocioId, 'obtenerSesionActiva');
  if (typeof telefono !== 'string' || !telefono.trim()) return null;
  const { rows } = await pool.query(
    `SELECT * FROM sesiones_comerciales
     WHERE negocio_id = $1 AND telefono = $2 AND estado NOT IN ${ESTADOS_ACTIVOS_SQL}`,
    [nid, telefono.trim()]
  );
  const sesion = rows[0] || null;
  if (!sesion) return null;

  let horas = ttlHoras;
  if (horas === null) {
    // Se lee aquí y no se cachea: cambiar el TTL tiene que valer para el
    // mensaje siguiente. `obtenerConfiguracion` ya se traga sus errores y
    // devuelve `{}`, así que un fallo de lectura cae al default, no a
    // «sin caducidad».
    const { obtenerConfiguracion } = await import('./database.js');
    horas = ttlDeSesionHoras(await obtenerConfiguracion(nid).catch(() => ({})));
  }

  const referencia = ahora ? new Date(ahora) : new Date();
  const ultima = new Date(sesion.updated_at || sesion.created_at);
  const caducada = (referencia - ultima) > horas * 3600 * 1000;
  if (!caducada) return sesion;

  console.log(`[sesionComercial] evento=sesion_caducada negocio=${nid} sesion=${String(sesion.id).slice(0, 8)} `
    + `estado=${sesion.estado} sin_novedad_horas=${Math.round((referencia - ultima) / 3600000)} ttl=${horas}`);
  try {
    await pool.query(
      `UPDATE sesiones_comerciales SET estado = 'abandonada'
        WHERE id = $1 AND negocio_id = $2 AND estado NOT IN ${ESTADOS_ACTIVOS_SQL}`,
      [sesion.id, nid]);
    await registrarEventoSesion(sesion.id, nid, 'sesion_abandonada_por_caducidad',
      { ttl_horas: horas, estado_previo: sesion.estado });
  } catch (e) {
    console.error('[sesionComercial] no se pudo cerrar una sesión caducada:', e.message);
  }
  return null;
}

/**
 * Obtiene la sesión por id, siempre tenant-scoped -- si existe pero
 * pertenece a otro negocio, devuelve null (nunca revela su existencia).
 */
export async function obtenerSesion(sesionId, negocioId) {
  const nid = exigirNegocioId(negocioId, 'obtenerSesion');
  if (typeof sesionId !== 'string' || !sesionId.trim()) return null;
  const { rows } = await pool.query(
    `SELECT * FROM sesiones_comerciales WHERE id = $1 AND negocio_id = $2`,
    [sesionId.trim(), nid]
  );
  return rows[0] || null;
}

/**
 * Punto de entrada usado por brain.js: reutiliza la sesión activa si
 * existe, o crea una nueva -- atómico vía ON CONFLICT sobre el índice
 * único parcial (evita una condición de carrera con dos webhooks casi
 * simultáneos del mismo cliente creando dos sesiones activas).
 */
export async function obtenerOCrearSesionActiva(negocioId, telefono) {
  const nid = exigirNegocioId(negocioId, 'obtenerOCrearSesionActiva');
  if (typeof telefono !== 'string' || !telefono.trim()) {
    throw new Error('obtenerOCrearSesionActiva: telefono requerido');
  }
  const tel = telefono.trim();
  const existente = await obtenerSesionActiva(nid, tel);
  if (existente) return existente;

  const { rows } = await pool.query(
    `INSERT INTO sesiones_comerciales (negocio_id, telefono)
     VALUES ($1, $2)
     ON CONFLICT (negocio_id, telefono) WHERE estado NOT IN ${ESTADOS_ACTIVOS_SQL} DO NOTHING
     RETURNING *`,
    [nid, tel]
  );
  if (rows[0]) {
    await registrarEventoSesion(rows[0].id, nid, 'sesion_creada', { telefono: tel });
    return rows[0];
  }
  // Alguien más ganó la carrera -- la sesión activa ya existe, se reutiliza.
  return obtenerSesionActiva(nid, tel);
}

/**
 * Fusiona campos nuevos sobre `campos_capturados` (nunca reemplaza el
 * objeto completo -- un campo ya capturado en un turno previo no se
 * pierde si el turno actual solo aporta uno nuevo).
 */
export async function actualizarCamposSesion(sesionId, negocioId, camposNuevos) {
  const nid = exigirNegocioId(negocioId, 'actualizarCamposSesion');
  if (!camposNuevos || typeof camposNuevos !== 'object') return null;
  const { rows } = await pool.query(
    `UPDATE sesiones_comerciales
     SET campos_capturados = campos_capturados || $3::jsonb
     WHERE id = $1 AND negocio_id = $2
     RETURNING *`,
    [sesionId, nid, JSON.stringify(camposNuevos)]
  );
  if (!rows[0]) return null;
  await registrarEventoSesion(sesionId, nid, 'campos_actualizados', { campos: camposNuevos });
  return rows[0];
}

/**
 * Reemplaza el documento completo. Se reserva para saneamientos en los que
 * omitir una clave debe borrarla (por ejemplo, purgar campos de catering
 * anteriores a la barrera de procedencia). `actualizarCamposSesion` conserva
 * deliberadamente sus semánticas de merge para los turnos normales.
 */
export async function reemplazarCamposSesion(sesionId, negocioId, campos) {
  const nid = exigirNegocioId(negocioId, 'reemplazarCamposSesion');
  if (!campos || typeof campos !== 'object' || Array.isArray(campos)) return null;
  const { rows } = await pool.query(
    `UPDATE sesiones_comerciales
     SET campos_capturados = $3::jsonb
     WHERE id = $1 AND negocio_id = $2
     RETURNING *`,
    [sesionId, nid, JSON.stringify(campos)]
  );
  if (!rows[0]) return null;
  await registrarEventoSesion(sesionId, nid, 'campos_reemplazados', { campos });
  return rows[0];
}

const ESTADOS_VALIDOS = ['descubriendo_necesidad', 'construyendo_borrador', 'esperando_aprobacion', 'error_recuperable', 'finalizada', 'abandonada'];

export async function cambiarEstadoSesion(sesionId, negocioId, nuevoEstado, detalle = {}) {
  const nid = exigirNegocioId(negocioId, 'cambiarEstadoSesion');
  if (!ESTADOS_VALIDOS.includes(nuevoEstado)) {
    throw new Error(`cambiarEstadoSesion: estado inválido "${nuevoEstado}"`);
  }
  const { rows } = await pool.query(
    `UPDATE sesiones_comerciales SET estado = $3 WHERE id = $1 AND negocio_id = $2 RETURNING *`,
    [sesionId, nid, nuevoEstado]
  );
  if (!rows[0]) return null;
  await registrarEventoSesion(sesionId, nid, 'cambio_estado', { ...detalle, estado: nuevoEstado });
  return rows[0];
}

/**
 * Transición segura ante un error real construyendo el borrador (fecha
 * inválida que se coló, fallo de DB, catálogo, etc.) -- NUNCA deja la
 * sesión atorada en un estado intermedio (p.ej. 'construyendo_borrador')
 * sin salida. 'error_recuperable' sigue contando como sesión ACTIVA (no
 * está en finalizada/abandonada), así que obtenerSesionActiva() la sigue
 * encontrando en el siguiente mensaje del mismo cliente -- el mismo
 * teléfono retoma la MISMA sesión (nunca crea una segunda), con
 * campos_capturados intactos, y generarBorradorDesdeSesion() puede
 * reintentar sin duplicar nada porque solo se salta como "yaExistia"
 * cuando cotizacion_id YA está poblado (ver draftBuilder.js).
 */
export async function marcarSesionComoErrorRecuperable(sesionId, negocioId, error) {
  const nid = exigirNegocioId(negocioId, 'marcarSesionComoErrorRecuperable');
  const codigo = String(error?.code || error?.motivo || error?.message || 'error_desconocido').slice(0, 200);
  const { rows } = await pool.query(
    `UPDATE sesiones_comerciales
     SET estado = 'error_recuperable',
         ultimo_error_codigo = $3,
         ultimo_error_at = NOW(),
         intentos_fallidos = intentos_fallidos + 1
     WHERE id = $1 AND negocio_id = $2
     RETURNING *`,
    [sesionId, nid, codigo]
  );
  if (!rows[0]) return null;
  await registrarEventoSesion(sesionId, nid, 'error_recuperable', { codigo, intentosFallidos: rows[0].intentos_fallidos });
  return rows[0];
}

export async function vincularCotizacion(sesionId, negocioId, cotizacionId) {
  const nid = exigirNegocioId(negocioId, 'vincularCotizacion');
  const { rows } = await pool.query(
    `UPDATE sesiones_comerciales SET cotizacion_id = $3 WHERE id = $1 AND negocio_id = $2 RETURNING *`,
    [sesionId, nid, cotizacionId]
  );
  if (!rows[0]) return null;
  await registrarEventoSesion(sesionId, nid, 'cotizacion_vinculada', { cotizacionId });
  return rows[0];
}

/** Finaliza la sesión (motivo: 'aprobada' | 'cancelada' | 'abandonada' | ...). */
export async function finalizarSesion(sesionId, negocioId, motivo) {
  const nid = exigirNegocioId(negocioId, 'finalizarSesion');
  const estadoFinal = motivo === 'abandonada' ? 'abandonada' : 'finalizada';
  const { rows } = await pool.query(
    `UPDATE sesiones_comerciales SET estado = $3
     WHERE id = $1 AND negocio_id = $2 AND estado NOT IN ${ESTADOS_ACTIVOS_SQL}
     RETURNING *`,
    // La sesión puede estar en cualquier estado activo al finalizar --
    // la cláusula NOT IN de arriba en realidad excluye las YA finalizadas,
    // así que esto es una finalización idempotente (no falla si ya lo
    // estaba, simplemente no vuelve a escribir).
    [sesionId, nid, estadoFinal]
  );
  if (!rows[0]) return await obtenerSesion(sesionId, nid); // ya estaba finalizada -- no es un error
  await registrarEventoSesion(sesionId, nid, 'sesion_finalizada', { motivo });
  return rows[0];
}

/** Sesión (si existe, tenant-scoped) vinculada a una cotización dada. */
export async function obtenerSesionPorCotizacion(cotizacionId, negocioId) {
  const nid = exigirNegocioId(negocioId, 'obtenerSesionPorCotizacion');
  const { rows } = await pool.query(
    `SELECT * FROM sesiones_comerciales WHERE cotizacion_id = $1 AND negocio_id = $2`,
    [cotizacionId, nid]
  );
  return rows[0] || null;
}
