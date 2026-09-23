// Pre-Deploy Command de Railway para la 089 (fecha de cambio en configuracion).
//
// Añade UNA columna con default y su trigger. Lo que se verifica —y lo que
// aborta— es que ni una clave, ni un valor, ni un negocio cambien: esta tabla
// es donde viven todos los interruptores del producto, y una migración que
// los toque apaga o enciende negocios enteros sin que nadie lo pida.
//
// Se comprueba además que el trigger quedó puesto: sin él la columna existe,
// se queda congelada en la fecha de la migración, y mentiría —que es peor que
// no tenerla.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const aplicada = async () => (await db.query(
  `SELECT (SELECT count(*) FROM information_schema.columns
            WHERE table_name = 'configuracion' AND column_name = 'updated_at')::int
        + (SELECT count(*) FROM pg_trigger
            WHERE tgname = 'set_updated_at' AND tgrelid = 'configuracion'::regclass AND NOT tgisinternal)::int AS n`
)).rows[0].n === 2;

// La huella de la tabla: cuántas claves hay y qué dicen. Si la migración
// alterara un solo valor, este hash cambia y el despliegue se detiene.
const huella = async () => (await db.query(
  `SELECT count(*)::int AS filas,
          md5(string_agg(negocio_id::text || '|' || clave || '|' || COALESCE(valor, ''), E'\n'
              ORDER BY negocio_id, clave)) AS hash
     FROM configuracion`)).rows[0];

try {
  await db.connect();
  const yaEstaba = await aplicada();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('089-configuracion-fechada',0))");
  const antes = await huella();
  await db.query(await readFile(new URL('../migrations/089_configuracion_fechada.sql', import.meta.url), 'utf8'));
  if (!(await aplicada())) throw new Error('la 089 no dejó la columna updated_at y su trigger en configuracion');
  const despues = await huella();
  if (antes.filas !== despues.filas || antes.hash !== despues.hash) {
    throw new Error(`la 089 alteró configuracion (${antes.filas} -> ${despues.filas} filas) -- se aborta`);
  }
  const { rows: [b] } = await db.query(
    `SELECT count(*)::int AS sin_fecha FROM configuracion WHERE updated_at IS NULL`);
  if (b.sin_fecha) throw new Error(`${b.sin_fecha} claves quedaron sin fecha`);
  await db.query('COMMIT');
  console.log(`[predeploy-089] ${yaEstaba ? 'Ya aplicada' : 'Aplicada'}. `
    + `${despues.filas} claves de configuración intactas; a partir de ahora cada cambio queda fechado.`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {}); process.exitCode = 1;
  console.error('[predeploy-089] FALLO:', e.message);
} finally {
  await db.end().catch(() => {});
}
