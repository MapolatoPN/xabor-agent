// Únicamente bloquea las cuentas creadas por registro público.
// NEGOCIOS EXISTENTES: si no existe fila en solicitudes_registro_basico,
// no se alteran su acceso, sus planes ni su configuración.
// La fecha de prueba es la verificación real (used_at) + 7 días exactos.
// Un pago todavía NO se automatiza: para activar, debe existir un cobro
// asentado por una implementación futura y el plan comercial actualizado.
import { pool } from './database.js';

const SQL = `
  SELECT CASE
    WHEN pc.estado = 'prueba' THEN s.used_at + INTERVAL '7 days' > NOW()
    WHEN pc.estado = 'activo' THEN pc.proxima_fecha_pago > CURRENT_DATE
    ELSE FALSE
  END AS permitido
  FROM solicitudes_registro_basico s
  LEFT JOIN negocio_plan_comercial pc ON pc.negocio_id = s.negocio_id
  WHERE s.negocio_id = $1 AND s.used_at IS NOT NULL
  LIMIT 1`;

export async function accesoComercialBasico(negocioId, { consultar = (sql, p) => pool.query(sql, p) } = {}) {
  if (!negocioId || typeof negocioId !== 'string') return false;
  try {
    const { rows } = await consultar(SQL, [negocioId]);
    // Sin fila: negocio previo que NO vino de este registro. No tocar.
    if (!rows.length) return true;
    // Con fila pero sin plan comercial válido: BLOQUEAR.
    return rows[0].permitido === true;
  } catch (e) {
    // Compatibilidad de despliegue: un entorno sin migración 143 solo
    // contiene negocios previos, porque el alta nueva no podría funcionar.
    if (e.code === '42P01') return true;
    console.error('[acceso-basico] Error comprobando suscripción:', e.code || 'desconocido');
    return false; // Si la verificación falla, no se concede acceso extra.
  }
}

export const SUSCRIPCION_BASICO_VENCIDA = Object.freeze({
  error: 'Tu prueba o suscripción venció. Conservamos tus datos; contacta a soporte para reactivar.',
  code: 'SUSCRIPCION_BASICO_VENCIDA',
});
