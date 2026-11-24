// ─── Sesiones cerradas que sobreviven a un despliegue (Fase 1, bloque 2) ────
//
// session.js cierra el token en memoria al instante (verificarTokenSesion es
// síncrono y lo usan cientos de rutas). Aquí se guarda además su HUELLA en
// sesiones_revocadas (migración 145) y, al arrancar, se recargan las que aún
// no vencen. Antes, cada despliegue revivía las sesiones cerradas hasta sus
// 12 h.
import { pool } from './database.js';
import { revocarTokenSesion, marcarRevocada } from './session.js';

/**
 * Cierra la sesión: en memoria primero (nunca falla) y después en la base.
 * Si la base falla, la sesión queda cerrada en este proceso igual y el error
 * se anota: el usuario sale de todos modos.
 */
export async function cerrarSesion(token) {
  const r = revocarTokenSesion(token);
  if (!r) return;
  try {
    await pool.query(
      `INSERT INTO sesiones_revocadas (huella, vence_at) VALUES ($1, to_timestamp($2::double precision / 1000))
       ON CONFLICT (huella) DO NOTHING`,
      [r.huella, r.exp]);
  } catch (e) {
    console.error('[Sesiones] No se pudo guardar el cierre de sesión en la base:', e.message);
  }
}

/** Recarga en memoria las sesiones cerradas que aún no vencen. Al arrancar. */
export async function cargarSesionesRevocadas() {
  const { rows } = await pool.query(
    `SELECT huella, (extract(epoch from vence_at) * 1000)::bigint AS exp
       FROM sesiones_revocadas WHERE vence_at > now()`);
  for (const f of rows) marcarRevocada(f.huella, Number(f.exp));
  return rows.length;
}

/** Borra las que ya vencieron solas. Lo corre el mismo job que los límites. */
export async function purgarSesionesRevocadas() {
  const { rowCount } = await pool.query('DELETE FROM sesiones_revocadas WHERE vence_at < now()');
  return rowCount;
}
