// Pre-Deploy de la 047. Corrige la FK del actor de auditoria.
//
// No toca datos: solo sustituye ON DELETE SET NULL por ON DELETE RESTRICT,
// para que la FK y el CHECK de la 046 dejen de contradecirse.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '047_auditoria_actor_fk_restrict.sql');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// confdeltype: 'a' = NO ACTION, 'r' = RESTRICT, 'n' = SET NULL
const REGLA = `SELECT c.confdeltype AS tipo FROM pg_constraint c
                 JOIN pg_class t ON t.oid = c.conrelid
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
                WHERE t.relname='auditoria_plataforma' AND c.contype='f' AND a.attname='actor_usuario_id' LIMIT 1`;

try {
  const { rows: antes } = await pool.query(REGLA);
  if (!antes[0]) {
    console.log('[predeploy-047] No existe la FK del actor (046 no aplicada aqui) -- nada que hacer.');
  } else if (['a', 'r'].includes(antes[0].tipo)) {
    console.log('[predeploy-047] La FK ya retiene al actor -- no se ejecuta nada.');
  } else {
    const { rows: [f0] } = await pool.query(`SELECT count(*)::int AS n FROM auditoria_plataforma`);
    console.log(`[predeploy-047] Corrigiendo la FK (era '${antes[0].tipo}')...`);
    await pool.query(readFileSync(MIGRACION, 'utf8'));

    const { rows: despues } = await pool.query(REGLA);
    if (!['a', 'r'].includes(despues[0]?.tipo)) {
      throw new Error(`la FK sigue siendo '${despues[0]?.tipo}' tras la migracion`);
    }
    const { rows: [f1] } = await pool.query(`SELECT count(*)::int AS n FROM auditoria_plataforma`);
    if (f0.n !== f1.n) throw new Error(`la migracion altero filas (${f0.n} -> ${f1.n})`);
    console.log(`[predeploy-047] OK. ${f1.n} filas de auditoria intactas, la FK ahora retiene al actor.`);
  }
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-047] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
