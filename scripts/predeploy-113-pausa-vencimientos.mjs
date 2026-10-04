// 113: bitácora del vencimiento de pausas del bot. Va ANTES del binario
// nuevo: el job de vencimiento escribe aquí y /estado-bot lee de aquí el
// último vencimiento. Aditiva: una tabla vacía. Aborta si la 113 cambia una
// sola pausa, revisión o entrada de WhatsApp.
//
// REPEATABLE READ (revisión del 3-oct): el binario VIEJO sigue atendiendo
// mientras corre el predeploy. En READ COMMITTED cada conteo es una foto
// nueva, y un solo mensaje de WhatsApp entre las dos (`ejecutar` hace
// revision+1; las entradas pasan de pendiente a procesando y a completado)
// abortaba el despliegue con «La 113 alteró pausas o revisiones», más aún si
// el CREATE TABLE … REFERENCES negocios/usuarios espera su candado. Con una
// sola foto para la transacción, los dos conteos solo difieren si la propia
// 113 escribiera en esas tablas, que es lo único que este control debe ver.
//
// lock_timeout corto (revisión de publicación del 3-oct): el CREATE TABLE …
// REFERENCES negocios/usuarios pide SHARE ROW EXCLUSIVE sobre las dos, y con
// una transacción viva que había escrito en `negocios` esperó 9 s con las
// escrituras del binario vivo formadas detrás. Si no hay lock en 3 s, el
// despliegue se aborta y se reintenta; nunca deja una fila de espera larga
// delante de esas escrituras.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });
const CONTEO = `SELECT
  (SELECT COUNT(*) FROM conversaciones_control)::int AS controles,
  (SELECT COUNT(*) FROM conversaciones_control WHERE bot_pausado)::int AS pausadas,
  (SELECT COUNT(*) FROM whatsapp_conversaciones WHERE requiere_revision)::int AS en_revision,
  (SELECT COALESCE(SUM(revision),0) FROM whatsapp_conversaciones)::text AS suma_revisiones,
  (SELECT COUNT(*) FROM whatsapp_entradas WHERE estado IN ('pendiente','procesando','revision'))::int AS entradas_abiertas`;
try {
  await db.connect(); await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-113-pausa-vencimientos',0))");
  const { rows: [antes] } = await db.query(CONTEO);
  await db.query(await readFile(new URL('../migrations/113_conversaciones_pausa_vencimientos.sql', import.meta.url), 'utf8'));
  const { rows: [despues] } = await db.query(CONTEO);
  if (JSON.stringify(antes) !== JSON.stringify(despues)) throw Error('La 113 alteró pausas o revisiones: se revierte');
  const { rows: [t] } = await db.query(`SELECT to_regclass('public.conversaciones_pausa_vencimientos') IS NOT NULL AS ok,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_pausa_vencimiento_identidad') AS unico`);
  if (!t.ok || !t.unico) throw Error('conversaciones_pausa_vencimientos no quedó creada con su UNIQUE');
  await db.query('COMMIT');
  console.log(`[predeploy-113] Bitácora de vencimiento de pausas lista; ${antes.pausadas} pausas y ${antes.en_revision} revisiones intactas.`);
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(e.message); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
