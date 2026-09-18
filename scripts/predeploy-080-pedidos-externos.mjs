// Predeploy 080 — identidad durable de pedidos externos (Rappi).
//
// Mismo patrón que la 077: transacción con lock de aviso y comprobación de
// que la tabla quedó utilizable antes de confirmar.
//
// Va ANTES de que el binario nuevo atienda tráfico: el webhook de Rappi
// escribe aquí ANTES de acusar recibo. Si la tabla no existiera, cada orden
// entrante fallaría en el punto exacto que este cambio quiere hacer seguro.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-pedidos-externos-080',0))");
  await db.query(await readFile(new URL('../migrations/080_pedidos_externos.sql', import.meta.url), 'utf8'));
  await db.query('SELECT id, negocio_id, canal, id_externo, estado, folio, payload, aceptado_en_proveedor, '
    + 'aceptacion_error, listo_notificado_at, cancelacion, ultimo_error, intentos, reentregas, recibido_at, actualizado_at '
    + 'FROM pedidos_externos LIMIT 0');
  await db.query('COMMIT');
  console.log('[rappi] Migración 080 verificada.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('[rappi] Falló la migración 080:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
