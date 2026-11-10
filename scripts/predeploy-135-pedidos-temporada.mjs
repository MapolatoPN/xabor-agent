// 135: pedidos de temporada (formulario de Thanksgiving por ventana de entrega).
// Va ANTES del binario nuevo: las rutas /api/temporada/* leen estas tablas.
//
// Aditiva y fail-closed, con el mismo contrato que los predeploy anteriores:
//   - "Ya aplicada" solo si están TODAS sus garantías: las dos tablas, sus
//     restricciones de cupo/estado y el índice del cupo (válido).
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia el número de negocios (la 135 no toca ninguna fila).
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const RESTRICCIONES = {
  temporada_campanas: ['temporada_campanas_clave_unica', 'temporada_campanas_clave_formato', 'temporada_campanas_cupos',
    'temporada_campanas_horario', 'temporada_campanas_modalidades'],
  temporada_pedidos: ['temporada_pedidos_numero_unico', 'temporada_pedidos_envio_unico', 'temporada_pedidos_telefono',
    'temporada_pedidos_modalidad', 'temporada_pedidos_direccion', 'temporada_pedidos_estado'],
};
const INDICE = 'temporada_pedidos_cupo';

async function estado() {
  const faltan = [];
  for (const [tabla, nombres] of Object.entries(RESTRICCIONES)) {
    const { rows: [t] } = await db.query(`SELECT to_regclass($1) IS NOT NULL AS existe`, [`public.${tabla}`]);
    if (!t.existe) { faltan.push(`tabla ${tabla}`); continue; }
    const { rows } = await db.query(
      `SELECT c.conname FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = $1`, [tabla]);
    const hay = new Set(rows.map((r) => r.conname));
    for (const r of nombres) if (!hay.has(r)) faltan.push(`restricción ${r}`);
  }
  const { rows: [idx] } = await db.query(
    `SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_namespace n ON n.oid = ic.relnamespace
      WHERE n.nspname = 'public' AND ic.relname = $1`, [INDICE]);
  if (!idx) faltan.push(`índice ${INDICE}`);
  else if (!idx.indisvalid) faltan.push(`índice ${INDICE} inválido`);
  else if (!idx.def.includes('(campana_id, ventana_inicio)')) faltan.push(`índice ${INDICE} con otra definición`);
  return faltan;
}

const CONTEO = `SELECT (SELECT COUNT(*) FROM negocios)::int AS negocios`;
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-135-pedidos-temporada',0))");
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-135] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-135] Aplicando migrations/135_pedidos_temporada.sql (faltaba: ${antes.join('; ')})...`);
    const { rows: [conteoAntes] } = await db.query(CONTEO);
    await db.query(await readFile(new URL('../migrations/135_pedidos_temporada.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 135 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    const { rows: [conteoDespues] } = await db.query(CONTEO);
    if (conteoAntes.negocios !== conteoDespues.negocios) {
      throw Error(`La 135 cambió filas existentes (negocios ${conteoAntes.negocios} → ${conteoDespues.negocios}): se revierte`);
    }
    await db.query('COMMIT');
    console.log('[predeploy-135] Aplicada: tablas de pedidos de temporada listas (sin campañas; nacen apagadas).');
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-135] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
