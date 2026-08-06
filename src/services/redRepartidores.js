// ─── Red de repartidores por negocio (Frente B del MVP de escala) ───────────
// Convierte la red existente (tokens de aceptación, notificaciones por
// plantilla, métricas, aislamiento multiempresa) en un SERVICIO activable y
// configurable por negocio, sin reconstruir nada del motor:
//   - red_repartidores_config (migración 038) guarda la configuración.
//   - evaluarSolicitudRed decide si un pedido puede ofrecerse a la red
//     (activa, horario, cobertura, modo de solicitud) ANTES de notificar.
//   - Un negocio SIN fila de configuración conserva el comportamiento
//     actual EXACTO (retrocompatibilidad: nada cambia hasta configurar).
// La escritura/oferta real sigue viviendo en whatsapp-meta.js
// (notificarRepartidoresPorWA) -- este módulo solo decide y configura.
import { pool } from './database.js';

export const CAMPOS_CONFIG_RED = [
  'red_activa', 'fuentes', 'horario_inicio', 'horario_fin', 'zonas', 'radio_km',
  'costo_base', 'costo_por_km', 'quien_absorbe', 'tiempo_max_aceptacion_min',
  'politica_reasignacion', 'contacto', 'instrucciones_recogida',
  'tiempo_preparacion_min', 'solicitud_automatica', 'prioridad_modalidad',
];

// Contrato de retorno de tres estados (revisión de integración):
//   fila      => el negocio configuró su red -> se evalúa esa config.
//   null      => el negocio NUNCA configuró su red -> comportamiento legado
//                (el motor de notificación decide solo por repartidor_notif_modo).
//   undefined => ERROR real leyendo la configuración (base caída, etc.) --
//                distinto de "sin fila": no sabemos si el negocio tenía la
//                red desactivada, así que el gate debe fallar hacia NO
//                ofertar (nunca hacia el legado, que sí oferta). Nunca lanza.
export async function obtenerConfigRed(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  try {
    const { rows } = await pool.query('SELECT * FROM red_repartidores_config WHERE negocio_id = $1', [negocioId.trim()]);
    return rows[0] || null;
  } catch (e) {
    console.error('[RedNegocio] Error obtenerConfigRed:', e.message);
    return undefined; // error real -> el gate falla hacia no ofertar
  }
}

// Campos de red_repartidores_config que hoy son DECLARATIVOS: el panel los
// captura y persiste, pero el motor de ofertas todavía NO los ejecuta.
// Cualquier interfaz que los muestre debe marcarlos como "configuración
// declarativa, sin ejecución automática todavía" -- nunca presentarlos como
// plenamente funcionales. GET /api/config/red-repartidores los expone para
// que el consumidor de la API no tenga que adivinarlo.
export const CAMPOS_DECLARATIVOS_RED = ['radio_km', 'fuentes.red_xabor', 'fuentes.externas', 'politica_reasignacion:reofertar'];

const VALIDA_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function guardarConfigRed(negocioId, cambios) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw Object.assign(new Error('negocioId requerido'), { code: 'TENANT_CONTEXT_REQUIRED' });
  }
  const limpio = {};
  for (const campo of CAMPOS_CONFIG_RED) {
    if (cambios[campo] !== undefined) limpio[campo] = cambios[campo];
  }
  if (limpio.horario_inicio != null && limpio.horario_inicio !== '' && !VALIDA_HHMM.test(limpio.horario_inicio)) {
    throw Object.assign(new Error('horario_inicio debe ser HH:MM (24h)'), { code: 'CONFIG_INVALIDA' });
  }
  if (limpio.horario_fin != null && limpio.horario_fin !== '' && !VALIDA_HHMM.test(limpio.horario_fin)) {
    throw Object.assign(new Error('horario_fin debe ser HH:MM (24h)'), { code: 'CONFIG_INVALIDA' });
  }
  if (limpio.zonas !== undefined && !Array.isArray(limpio.zonas)) {
    throw Object.assign(new Error('zonas debe ser una lista'), { code: 'CONFIG_INVALIDA' });
  }
  const columnas = Object.keys(limpio);
  if (!columnas.length) {
    // Upsert vacío legítimo: crea la fila con defaults (activar la pantalla
    // de configuración por primera vez).
    const { rows } = await pool.query(
      `INSERT INTO red_repartidores_config (negocio_id) VALUES ($1)
       ON CONFLICT (negocio_id) DO UPDATE SET updated_at = NOW() RETURNING *`,
      [negocioId.trim()]
    );
    return rows[0];
  }
  const valores = columnas.map(c => (typeof limpio[c] === 'object' && limpio[c] !== null) ? JSON.stringify(limpio[c]) : limpio[c]);
  const sets = columnas.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const { rows } = await pool.query(
    `INSERT INTO red_repartidores_config (negocio_id, ${columnas.join(', ')})
     VALUES ($1, ${columnas.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (negocio_id) DO UPDATE SET ${sets}, updated_at = NOW()
     RETURNING *`,
    [negocioId.trim(), ...valores]
  );
  return rows[0];
}

// ─── Evaluación previa a ofrecer un pedido a la red ─────────────────────────
// origen: 'auto' (emitirPedido lo dispara solo) | 'manual' (el negocio pidió
// repartidor explícitamente para este pedido).
// Devuelve { procede, razon } -- NUNCA lanza: cualquier error interno cae a
// "no ofrecer" con razón registrable, jamás a ofrecer por accidente.
export function evaluarSolicitudRed(pedido, config, origen = 'auto', ahora = new Date()) {
  try {
    if (config === undefined) {
      // Error real leyendo la configuración (ver obtenerConfigRed): no
      // sabemos si el negocio tenía la red desactivada -- fallar hacia NO
      // ofertar, jamás hacia el legado (que sí oferta). El pedido principal
      // no se ve afectado: este gate solo decide la oferta de reparto.
      return { procede: false, razon: 'error_configuracion' };
    }
    if (config === null) {
      // Sin configuración => comportamiento legado intacto: el motor de
      // notificación decide solo (repartidor_notif_modo).
      return { procede: true, razon: 'sin_config_legado' };
    }
    if (!config.red_activa) return { procede: false, razon: 'red_inactiva' };
    if (origen === 'auto' && config.solicitud_automatica === false) {
      return { procede: false, razon: 'solicitud_manual_requerida' };
    }
    // Horario (huso del negocio -- hoy la plataforma opera en
    // America/Matamoros, mismo criterio que el resto del código de horarios).
    if (config.horario_inicio && config.horario_fin) {
      const hhmm = ahora.toLocaleTimeString('es-MX', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/Matamoros' });
      const dentro = config.horario_inicio <= config.horario_fin
        ? (hhmm >= config.horario_inicio && hhmm <= config.horario_fin)
        // Horario que cruza medianoche (p. ej. 18:00-02:00).
        : (hhmm >= config.horario_inicio || hhmm <= config.horario_fin);
      if (!dentro) return { procede: false, razon: 'fuera_de_horario' };
    }
    // Cobertura por zonas/colonias: lista vacía = sin restricción. La
    // comparación es por inclusión de texto normalizado -- deliberadamente
    // simple (sin geocoding) para el MVP.
    const zonas = Array.isArray(config.zonas) ? config.zonas.map(z => String(z).trim().toLowerCase()).filter(Boolean) : [];
    if (zonas.length) {
      const colonia = String(pedido?.cliente?.colonia || '').trim().toLowerCase();
      if (!colonia) return { procede: false, razon: 'sin_colonia_para_evaluar_cobertura' };
      if (!zonas.includes(colonia)) return { procede: false, razon: 'fuera_de_cobertura' };
    }
    return { procede: true, razon: 'ok' };
  } catch (e) {
    console.error('[RedNegocio] Error evaluarSolicitudRed:', e.message);
    return { procede: false, razon: 'error_evaluacion' };
  }
}

// Costo del servicio para un pedido según la configuración del negocio.
// distanciaKm es opcional (sin geocoding hoy): sin distancia solo aplica el
// costo base. Devuelve además quién lo absorbe, para que el llamador decida
// cómo presentarlo -- este módulo no toca precios del pedido.
export function calcularCostoRed(config, distanciaKm = null) {
  if (!config) return null;
  const base = Number(config.costo_base) || 0;
  const porKm = Number(config.costo_por_km) || 0;
  const km = Number(distanciaKm);
  const costo = base + (Number.isFinite(km) && km > 0 ? porKm * km : 0);
  return { costo: Math.round(costo * 100) / 100, quienAbsorbe: config.quien_absorbe || 'cliente' };
}

// ─── Central de reparto (Superadmin) ────────────────────────────────────────
// Vista operativa cross-negocio: cada servicio de reparto activo con su
// estado derivado (buscando/asignado/recogido/entregado/incidencia), tiempo
// transcurrido y filtros. Una sola consulta paginada -- sin N+1.
// Estado derivado (misma semántica que derivarEstadoServicioReparto de la
// fase C, expresada en SQL):
//   entregado  -> estado = 'entregado'
//   incidencia -> cancelado, o todas las notificaciones fallaron
//   recogido   -> estado = 'en_camino' (repartidor ya recogió)
//   asignado   -> datos->>'repartidor_id' presente
//   buscando   -> resto (elegible, sin asignar)
export async function obtenerCentralReparto({ estado = '', negocioId = '', repartidorId = '', desde = null, hasta = null, limit = 50, offset = 0 } = {}) {
  const limitSeguro = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const offsetSeguro = Math.max(Number(offset) || 0, 0);
  const params = [];
  const condiciones = [`(pa.datos->>'canal') IS DISTINCT FROM 'rappi'`, `(pa.datos->>'rappi_order_id') IS NULL`, `pa.datos->>'modalidad' = 'entrega a domicilio'`];
  if (negocioId) { params.push(negocioId); condiciones.push(`pa.negocio_id = $${params.length}`); }
  if (desde) { params.push(desde); condiciones.push(`pa.created_at >= $${params.length}`); }
  if (hasta) { params.push(hasta); condiciones.push(`pa.created_at <= $${params.length}`); }
  if (repartidorId) { params.push(String(repartidorId)); condiciones.push(`pa.datos->>'repartidor_id' = $${params.length}`); }

  const estadoDerivadoSQL = `
    CASE
      WHEN pa.estado = 'entregado' THEN 'entregado'
      WHEN pa.estado = 'cancelado' THEN 'incidencia'
      WHEN pa.estado = 'en_camino' THEN 'recogido'
      WHEN (pa.datos->>'repartidor_id') IS NOT NULL THEN 'asignado'
      WHEN EXISTS (SELECT 1 FROM notificaciones_repartidor nr WHERE nr.pedido_folio = pa.folio AND nr.negocio_id = pa.negocio_id)
        AND NOT EXISTS (SELECT 1 FROM notificaciones_repartidor nr WHERE nr.pedido_folio = pa.folio AND nr.negocio_id = pa.negocio_id AND nr.estado != 'error_envio')
        THEN 'incidencia'
      ELSE 'buscando'
    END`;

  if (estado && ['buscando', 'asignado', 'recogido', 'entregado', 'incidencia'].includes(estado)) {
    params.push(estado);
    condiciones.push(`(${estadoDerivadoSQL}) = $${params.length}`);
  }
  params.push(limitSeguro, offsetSeguro);

  const { rows } = await pool.query(`
    SELECT
      pa.folio, pa.negocio_id, n.nombre AS negocio_nombre,
      pa.estado AS estado_pedido,
      (${estadoDerivadoSQL}) AS estado_reparto,
      pa.datos->>'repartidor_id' AS repartidor_id,
      pa.datos->>'repartidor_nombre' AS repartidor_nombre,
      pa.datos->'cliente'->>'nombre' AS cliente_nombre,
      pa.datos->>'total' AS total,
      pa.datos->>'modalidad' AS modalidad,
      pa.created_at, pa.updated_at, pa.entregado_at,
      EXTRACT(EPOCH FROM (NOW() - pa.created_at))::int AS segundos_transcurridos,
      (SELECT count(*) FROM notificaciones_repartidor nr WHERE nr.pedido_folio = pa.folio AND nr.negocio_id = pa.negocio_id) AS ofertas_enviadas,
      count(*) OVER() AS total_filas
    FROM pedidos_activos pa
    JOIN negocios n ON n.id = pa.negocio_id
    WHERE ${condiciones.join(' AND ')}
    ORDER BY pa.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);
  const total = rows.length ? Number(rows[0].total_filas) : 0;
  return { total, servicios: rows.map(({ total_filas, ...r }) => r) };
}
