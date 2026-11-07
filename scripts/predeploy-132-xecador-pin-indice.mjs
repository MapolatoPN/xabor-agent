// 132: Xecador, checar solo con el PIN. Va ANTES del binario nuevo: la tablet
// identifica al empleado por el índice del PIN y el panel lo guarda al generar
// cada PIN.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-131:
//   - Necesita la 131 (sin conexión): si no está, se detiene.
//   - "Ya aplicada" solo si están TODAS sus garantías: la columna, su regla de
//     formato y el índice único por negocio (válido).
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia el número de expedientes o de checadas, o cualquier PIN
//     guardado (pin_hash).
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const INDICE = 'xecador_empleados_pin_indice_unico';
const REGLA = 'xecador_empleados_pin_indice_check';

async function estado() {
  const faltan = [];
  const { rows: [col] } = await db.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'xecador_empleados' AND column_name = 'pin_indice'`);
  if (!col) faltan.push('columna xecador_empleados.pin_indice');
  else if (col.data_type !== 'text') faltan.push(`columna xecador_empleados.pin_indice de tipo ${col.data_type}`);
  const { rows: [regla] } = await db.query(
    `SELECT c.contype, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = 'xecador_empleados' AND c.conname = $1`, [REGLA]);
  if (!regla || regla.contype !== 'c' || !['pin_hash IS NOT NULL', "pin_indice ~ '^[0-9a-f]{8}"].every((f) => regla.def.includes(f))) {
    faltan.push(`restricción ${REGLA}`);
  }
  const { rows: [idx] } = await db.query(
    `SELECT i.indisunique, i.indisvalid, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_namespace n ON n.oid = ic.relnamespace
      WHERE n.nspname = 'public' AND ic.relname = $1`, [INDICE]);
  if (!idx) faltan.push(`índice ${INDICE}`);
  else if (!idx.indisvalid) faltan.push(`índice ${INDICE} inválido`);
  else if (!idx.indisunique || !idx.def.includes('ON public.xecador_empleados') || !idx.def.includes('(negocio_id, pin_indice)')
    || !idx.def.includes('WHERE (pin_indice IS NOT NULL)')) faltan.push(`índice ${INDICE} con otra definición`);
  return faltan;
}

const CONTEOS = `SELECT (SELECT COUNT(*) FROM xecador_empleados)::int AS empleados,
                        (SELECT COUNT(*) FROM xecador_checadas)::int AS checadas,
                        (SELECT COALESCE(md5(string_agg(id::text || ':' || COALESCE(pin_hash, '-'), ',' ORDER BY id)), '')
                           FROM xecador_empleados) AS pines`;
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-132-xecador-pin-indice',0))");
  const { rows: [base] } = await db.query(`SELECT to_regclass('public.xecador_revisiones') IS NOT NULL AS sin_conexion`);
  if (!base.sin_conexion) {
    throw Error('La 132 necesita la 131 (sin conexión). El runner aplica la 131 antes; revisa por qué no está.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-132] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-132] Aplicando migrations/132_xecador_pin_indice.sql (faltaba: ${antes.join('; ')})...`);
    const { rows: [conteoAntes] } = await db.query(CONTEOS);
    await db.query(await readFile(new URL('../migrations/132_xecador_pin_indice.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 132 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    await db.query(`SELECT pin_indice FROM xecador_empleados LIMIT 0`);
    const { rows: [conteoDespues] } = await db.query(CONTEOS);
    if (JSON.stringify(conteoAntes) !== JSON.stringify(conteoDespues)) {
      throw Error(`La 132 cambió filas existentes (${conteoAntes.empleados}/${conteoAntes.checadas} → ${conteoDespues.empleados}/${conteoDespues.checadas}, PIN ${conteoAntes.pines === conteoDespues.pines ? 'iguales' : 'distintos'}): se revierte`);
    }
    await db.query('COMMIT');
    console.log(`[predeploy-132] Aplicada: índice del PIN listo; ${conteoDespues.empleados} expediente(s) y sus PIN sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-132] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
