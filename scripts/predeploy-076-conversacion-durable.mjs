// Predeploy 076 — estado conversacional durable.
//
// Mismo patrón que el resto: aplica la migración dentro de una transacción con
// lock de aviso (dos instancias arrancando a la vez no compiten), y COMPRUEBA
// que la tabla quedó utilizable antes de confirmar. Si algo falla, sale con
// código 1 y el despliegue no continúa.
//
// Esta va ANTES de que el binario nuevo atienda tráfico: `sesionDurable.js`
// escribe en cada turno, y un backend que guarda en una tabla inexistente
// perdería el carrito exactamente igual que antes — solo que además llenando
// el log de errores.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-conversacion-076',0))");
  await db.query(await readFile(new URL('../migrations/076_conversacion_durable.sql', import.meta.url), 'utf8'));
  await db.query('SELECT negocio_id, session_id, estado, revision, creado_at, actualizado_at '
    + 'FROM conversacion_estado LIMIT 0');
  await db.query('COMMIT');
  console.log('[conversacion] Migración 076 verificada.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('[conversacion] Falló la migración 076:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
