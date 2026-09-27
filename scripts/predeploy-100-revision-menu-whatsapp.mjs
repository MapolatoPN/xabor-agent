// Predeploy 100: el menú en imagen solo sale revisado contra la carta vigente.
//
// Aplica la migración y verifica las columnas de la revisión y las funciones
// de huella con valores fijos (una carta vacía y un negocio sin menú). Aditiva
// e idempotente: no aprueba ningún menú existente.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const ssl = ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl });
const exigir = (ok, msg) => { if (!ok) throw new Error(msg); };
const SIN_NEGOCIO = '00000000-0000-0000-0000-000000000000';

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-100-revision-menu-whatsapp',0))");
  await db.query(await readFile(new URL('../migrations/100_revision_menu_whatsapp.sql', import.meta.url), 'utf8'));
  await db.query(`SELECT revision_carta_huella, revision_imagenes_huella, revision_carta, revisado_at, revisado_por
                    FROM whatsapp_menu_automatico LIMIT 0`);
  const { rows: [f] } = await db.query(
    `SELECT huella_carta_whatsapp($1::uuid)            AS huella_vacia,
            'c1:' || md5('[]')                          AS esperada,
            estado_revision_menu_whatsapp($1::uuid)    AS estado,
            huella_imagenes_menu(ARRAY['b','a'])        AS h1,
            huella_imagenes_menu(ARRAY['a','b','a'])    AS h2`, [SIN_NEGOCIO]);
  exigir(f.huella_vacia === f.esperada, `huella de carta vacía inesperada: ${f.huella_vacia}`);
  exigir(f.estado === 'sin_menu', `un negocio sin menú debe dar sin_menu, dio ${f.estado}`);
  exigir(f.h1 === f.h2, 'la huella de imágenes debe ser de un CONJUNTO (sin orden ni repetidos)');
  await db.query('COMMIT');
  console.log('[predeploy-100] Revisión del menú en imagen contra la carta verificada.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('[predeploy-100] FALLO:', e.message);
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}
