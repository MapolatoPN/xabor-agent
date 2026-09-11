// Predeploy 072 — informes de reconciliación de sala.
//
// Mismo patrón que el resto: aplica la migración dentro de una transacción con
// lock de aviso (dos instancias arrancando a la vez no compiten), y COMPRUEBA
// que la tabla quedó utilizable antes de confirmar. Si algo falla, sale con
// código 1 y el despliegue no continúa: es preferible no desplegar a desplegar
// un backend que va a fallar al primer corte.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-sala-072',0))");
  await db.query(await readFile(new URL('../migrations/072_sala_reconciliaciones.sql', import.meta.url), 'utf8'));
  await db.query('SELECT id, negocio_id, lote_id, aplicadas, conflictos, reporte, pendientes, revisado_at '
    + 'FROM sala_reconciliaciones LIMIT 0');
  await db.query('COMMIT');
  console.log('[sala] Migración 072 verificada.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('[sala] Falló la migración 072:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
