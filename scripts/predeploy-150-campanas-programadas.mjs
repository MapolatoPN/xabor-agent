// 150: campañas de WhatsApp programadas (Fase 0.1). Va ANTES del binario
// nuevo: la cola y el historial leen campanas.programada_para.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-146:
//   - Necesita la 142 (campanas.tipo): si falta, se detiene.
//   - "Ya aplicada" solo si están la columna con su tipo y el índice válido.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; si después
//     sigue faltando, se revierte.
//   - Aborta si cambia cualquier campaña existente, o si la primera vez queda
//     alguna con fecha programada.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

// [tabla, columna, tipo de information_schema, ¿acepta NULL?]
const COLUMNAS = [['campanas', 'programada_para', 'timestamp with time zone', 'YES']];
// [tabla, índice, fragmentos que su definición debe contener]
const INDICES = [['campanas', 'campanas_programadas_por_hora', ['(programada_para)', "'plantilla'", "'programada'"]]];

async function estado() {
  const faltan = [];
  for (const [tabla, columna, tipo, nulo] of COLUMNAS) {
    const { rows: [c] } = await db.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [tabla, columna]);
    if (!c) faltan.push(`columna ${tabla}.${columna}`);
    else if (c.data_type !== tipo || c.is_nullable !== nulo) faltan.push(`columna ${tabla}.${columna} con otro tipo`);
  }
  for (const [tabla, nombre, fragmentos] of INDICES) {
    const { rows: [i] } = await db.query(
      `SELECT ix.indisvalid, pg_get_indexdef(ix.indexrelid) AS def
         FROM pg_index ix JOIN pg_class ic ON ic.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = ic.relnamespace
        WHERE n.nspname = 'public' AND t.relname = $1 AND ic.relname = $2`, [tabla, nombre]);
    if (!i || !i.indisvalid || !fragmentos.every((f) => i.def.includes(f))) faltan.push(`índice ${nombre}`);
  }
  return faltan;
}

// La huella de lo que ya había: si algo de esto cambia, la 150 tocó lo que no debía.
const HUELLA = `SELECT (SELECT COUNT(*) FROM campanas)::int AS campanas,
                       (SELECT COUNT(*) FROM campanas WHERE estado = 'enviando')::int AS enviando,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, negocio_id, tipo, estado, total_destinatarios, enviados,
                                 fallidos, creada_at, completada_at, detenida_at, pausada_at), ',' ORDER BY id)), '')
                          FROM campanas) AS campanas_md5`;

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-150-campanas-programadas',0))");
  const { rows: [base] } = await db.query(
    `SELECT to_regclass('public.campanas') IS NOT NULL AS campanas,
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'campanas' AND column_name = 'tipo') AS con_142,
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'campanas' AND column_name = 'pausada_at') AS con_143`);
  if (!base.campanas || !base.con_142 || !base.con_143) {
    throw Error('La 150 necesita la tabla campanas con la 142 y la 143. Revisa por qué no están.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-150] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-150] Aplicando migrations/150_campanas_programadas.sql (faltaba: ${antes.join('; ')})...`);
    // La cola del binario anterior actualiza campanas cada 10 s: con la tabla
    // tomada, nada cae entre la huella y el ALTER.
    await db.query('LOCK TABLE campanas IN ACCESS EXCLUSIVE MODE');
    const primeraVez = antes.includes('columna campanas.programada_para');
    const { rows: [huellaAntes] } = await db.query(HUELLA);
    await db.query(await readFile(new URL('../migrations/150_campanas_programadas.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 150 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    await db.query('SELECT programada_para FROM campanas LIMIT 0');
    const { rows: [huellaDespues] } = await db.query(HUELLA);
    if (JSON.stringify(huellaAntes) !== JSON.stringify(huellaDespues)) {
      throw Error(`La 150 cambió campañas existentes (${JSON.stringify(huellaAntes)} → ${JSON.stringify(huellaDespues)}): se revierte`);
    }
    if (primeraVez) {
      const { rows: [r] } = await db.query(
        `SELECT COUNT(*) FILTER (WHERE programada_para IS NOT NULL)::int AS con_fecha,
                COUNT(*) FILTER (WHERE estado = 'programada')::int AS programadas FROM campanas`);
      if (r.con_fecha || r.programadas) {
        throw Error(`La 150 dejó valores que deben nacer vacíos (${JSON.stringify(r)}). Se revierte.`);
      }
    }
    await db.query('COMMIT');
    console.log(primeraVez
      ? `[predeploy-150] Aplicada: ${huellaDespues.campanas} campaña(s) sin cambios (${huellaDespues.enviando} mandándose); programar nace apagado en cada negocio (campanas_wa_programar).`
      : `[predeploy-150] Reparada (faltaba: ${antes.join('; ')}); ${huellaDespues.campanas} campaña(s) sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-150] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
