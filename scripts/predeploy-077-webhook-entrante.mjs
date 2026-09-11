// Predeploy 077 — constancia durable del webhook.
//
// Mismo patrón que el resto: transacción con lock de aviso y comprobación de
// que la tabla quedó utilizable antes de confirmar.
//
// Va ANTES de que el binario nuevo atienda tráfico: el webhook escribe en esta
// tabla ANTES de acusar recibo a Meta. Si no existiera, cada mensaje entrante
// fallaría en el punto exacto que este cambio quiere hacer seguro.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-webhook-077',0))");
  await db.query(await readFile(new URL('../migrations/077_webhook_entrante_durable.sql', import.meta.url), 'utf8'));
  await db.query('SELECT id, canal, referencia, payload, estado, intentos, ultimo_error, recibido_at, procesado_at '
    + 'FROM webhook_entrante LIMIT 0');
  await db.query('COMMIT');
  console.log('[webhook] Migración 077 verificada.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('[webhook] Falló la migración 077:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
