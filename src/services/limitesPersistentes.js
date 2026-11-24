// ─── Límites de intentos guardados en la base (Fase 1, bloque 2) ────────────
//
// Un solo mecanismo para todo lo que se puede adivinar o abusar: la
// contraseña del login, el PIN de meseros, la clave de quien autoriza, el
// segundo factor de Superadmin y los pedidos de las formas públicas. Antes
// cada uno contaba en la memoria del proceso y un despliegue lo reiniciaba.
//
// Cuenta INTENTOS, no fallos: el lugar se TOMA antes de comprobar nada y se
// DEVUELVE si el intento salió bien (o si no creó nada). Así cien peticiones
// simultáneas no pasan todas antes de que se anote el primer fallo: la toma
// es atómica (candado consultivo por llave dentro de una transacción).
//
// La llave se guarda como huella sha256: el correo, la IP o el mesero nunca
// quedan en claro en limites_acceso (migración 145).
import { createHash } from 'crypto';
import { pool } from './database.js';

export const huellaClave = (clave) => createHash('sha256').update(String(clave)).digest('hex');

/**
 * Toma un lugar en cada una de las llaves, todas o ninguna. Cada llave es
 * { clave, limite, ventanaMs }. Devuelve null si alguna ya está llena (no
 * toma ninguna), o una función async que DEVUELVE los lugares tomados.
 */
export async function tomarLugares(llaves) {
  const lista = llaves.map((l) => {
    if (!Number.isInteger(l.limite) || l.limite <= 0) throw new Error('tomarLugares: limite debe ser un entero positivo');
    if (!Number.isInteger(l.ventanaMs) || l.ventanaMs <= 0) throw new Error('tomarLugares: ventanaMs debe ser un entero positivo');
    return { ...l, huella: huellaClave(l.clave) };
  });
  // Siempre en el mismo orden: dos peticiones con las mismas llaves no se
  // bloquean una a la otra.
  const ordenadas = [...lista].sort((a, b) => (a.huella < b.huella ? -1 : a.huella > b.huella ? 1 : 0));
  const client = await pool.connect();
  const ids = [];
  try {
    await client.query('BEGIN');
    for (const l of ordenadas) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('limite:' || $1, 0))", [l.huella]);
      const { rows: [c] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM limites_acceso
          WHERE clave = $1 AND creado_at > now() - make_interval(secs => $2::double precision / 1000)`,
        [l.huella, l.ventanaMs]);
      if (c.n >= l.limite) { await client.query('ROLLBACK'); return null; }
    }
    for (const l of ordenadas) {
      const { rows: [r] } = await client.query(
        `INSERT INTO limites_acceso (clave, vence_at)
         VALUES ($1, now() + make_interval(secs => $2::double precision / 1000)) RETURNING id`,
        [l.huella, l.ventanaMs]);
      ids.push(r.id);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  let devuelto = false;
  return async () => {
    // Devolver dos veces no libera dos lugares.
    if (devuelto) return;
    devuelto = true;
    await pool.query('DELETE FROM limites_acceso WHERE id = ANY($1::bigint[])', [ids]);
  };
}

/** Borra todos los intentos de una llave: la cuenta entró bien. */
export async function limpiarLlave(clave) {
  await pool.query('DELETE FROM limites_acceso WHERE clave = $1', [huellaClave(clave)]);
}

/** Cuántos lugares ocupa una llave en su ventana (para las pruebas). */
export async function usados(clave, ventanaMs) {
  const { rows: [c] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM limites_acceso
      WHERE clave = $1 AND creado_at > now() - make_interval(secs => $2::double precision / 1000)`,
    [huellaClave(clave), ventanaMs]);
  return c.n;
}

/** Borra los renglones vencidos. Lo corre un job cada media hora. */
export async function purgarLimitesVencidos() {
  const { rowCount } = await pool.query('DELETE FROM limites_acceso WHERE vence_at < now()');
  return rowCount;
}
