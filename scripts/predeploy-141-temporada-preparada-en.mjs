// 141: pedidos de temporada — «se prepara en» (CEDIS).
// Va ANTES del binario nuevo: /temporada lee temporada_campanas.preparada_en.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-139:
//   - Necesita la 139 (y con ella la 135): si no está, se detiene.
//   - "Ya aplicada" solo si están la columna, su llave a negocios, la regla de
//     «otra sucursal» y el índice.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia cualquier campaña o pedido, o si la primera vez alguna
//     campaña queda con preparada_en (todas nacen en NULL).
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

// [restricción, tipo, fragmentos que su definición debe contener]
const RESTRICCIONES = [
  ['temporada_campanas_preparada_en_fkey', 'f', ['FOREIGN KEY (preparada_en)', 'REFERENCES negocios(id)', 'ON DELETE RESTRICT']],
  ['temporada_campanas_preparada_en_otra', 'c', ['preparada_en IS NULL', 'preparada_en <> negocio_id']],
];

async function estado() {
  const faltan = [];
  const { rows: [col] } = await db.query(
    `SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'temporada_campanas' AND column_name = 'preparada_en'`);
  if (!col) faltan.push('columna temporada_campanas.preparada_en');
  else if (col.data_type !== 'uuid' || col.is_nullable !== 'YES') faltan.push('columna preparada_en con otro tipo');
  for (const [nombre, tipo, fragmentos] of RESTRICCIONES) {
    const { rows: [r] } = await db.query(
      `SELECT c.contype, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = 'temporada_campanas' AND c.conname = $1`, [nombre]);
    if (!r || r.contype !== tipo || !fragmentos.every((f) => r.def.includes(f))) faltan.push(`restricción ${nombre}`);
  }
  const { rows: [i] } = await db.query(
    `SELECT ix.indisvalid, pg_get_indexdef(ix.indexrelid) AS def
       FROM pg_index ix JOIN pg_class ic ON ic.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = ic.relnamespace
      WHERE n.nspname = 'public' AND t.relname = 'temporada_campanas' AND ic.relname = 'temporada_campanas_preparada_en'`);
  if (!i || !i.indisvalid || !i.def.includes('(preparada_en)')) faltan.push('índice temporada_campanas_preparada_en');
  return faltan;
}

// La huella de lo que ya había: si algo de esto cambia, la 141 tocó lo que no debía.
const HUELLA = `SELECT (SELECT COUNT(*) FROM temporada_campanas)::int AS campanas,
                       (SELECT COUNT(*) FROM temporada_pedidos)::int AS pedidos,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, negocio_id, clave, fecha, hora_inicio, hora_fin,
                                 cupo_platillos, cupo_domicilio, activa, precio), ',' ORDER BY id)), '')
                          FROM temporada_campanas) AS campanas_md5,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, campana_id, numero, estado, platillos, modalidad,
                                 ventana_inicio, ventana_fin, telefono, cancelado_en, estado_entrega), ',' ORDER BY id)), '')
                          FROM temporada_pedidos) AS pedidos_md5`;

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-141-temporada-preparada-en',0))");
  const { rows: [base] } = await db.query(
    `SELECT to_regclass('public.temporada_campanas') IS NOT NULL AS campanas,
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                     AND table_name = 'temporada_pedidos' AND column_name = 'estado_entrega') AS la139`);
  if (!base.campanas || !base.la139) {
    throw Error('La 141 necesita la 139 (y la 135). El runner las aplica antes; revisa por qué no están.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-141] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-141] Aplicando migrations/141_temporada_preparada_en.sql (faltaba: ${antes.join('; ')})...`);
    // El binario anterior sigue recibiendo pedidos mientras corre esto: con
    // las tablas tomadas, ningún alta cae entre la huella y el ALTER.
    await db.query('LOCK TABLE temporada_campanas, temporada_pedidos IN ACCESS EXCLUSIVE MODE');
    const primeraVez = antes.includes('columna temporada_campanas.preparada_en');
    const { rows: [huellaAntes] } = await db.query(HUELLA);
    await db.query(await readFile(new URL('../migrations/141_temporada_preparada_en.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 141 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    await db.query('SELECT preparada_en FROM temporada_campanas LIMIT 0');
    const { rows: [huellaDespues] } = await db.query(HUELLA);
    if (JSON.stringify(huellaAntes) !== JSON.stringify(huellaDespues)) {
      throw Error(`La 141 cambió pedidos o campañas existentes (${JSON.stringify(huellaAntes)} → ${JSON.stringify(huellaDespues)}): se revierte`);
    }
    if (primeraVez) {
      const { rows: [r] } = await db.query(`SELECT COUNT(*)::int AS n FROM temporada_campanas WHERE preparada_en IS NOT NULL`);
      if (r.n) throw Error(`La 141 dejó ${r.n} campaña(s) con «se prepara en»: todas debían quedar en NULL. Se revierte.`);
    }
    await db.query('COMMIT');
    console.log(primeraVez
      ? `[predeploy-141] Aplicada: ${huellaDespues.campanas} campaña(s) de temporada se preparan en su propia sucursal (preparada_en NULL).`
      : `[predeploy-141] Reparada (faltaba: ${antes.join('; ')}); ${huellaDespues.campanas} campaña(s) sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-141] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
