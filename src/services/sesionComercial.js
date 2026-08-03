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

/** Sesión activa (no finalizada/abandonada) de este negocio+teléfono, o null. */
export async function obtenerSesionActiva(negocioId, telefono) {
  const nid = exigirNegocioId(negocioId, 'obtenerSesionActiva');
  if (typeof telefono !== 'string' || !telefono.trim()) return null;
  const { rows } = await pool.query(
    `SELECT * FROM sesiones_comerciales
     WHERE negocio_id = $1 AND telefono = $2 AND estado NOT IN ${ESTADOS_ACTIVOS_SQL}`,
    [nid, telefono.trim()]
  );
  return rows[0] || null;
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

const ESTADOS_VALIDOS = ['descubriendo_necesidad', 'construyendo_borrador', 'esperando_aprobacion', 'finalizada', 'abandonada'];

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
