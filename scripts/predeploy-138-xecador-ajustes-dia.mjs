// 138: Xecador, Parte B4 — extra autorizada y faltas justificadas por día. Va
// ANTES del binario nuevo: «Horas de la semana» lee y escribe estos ajustes.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-133:
//   - Necesita la 128 (expedientes y jornadas): si no está, se detiene.
//   - "Ya aplicada" solo si están TODAS sus garantías: la tabla con sus
//     columnas, llaves, reglas e índice, y sus triggers de solo inserción
//     HABILITADOS.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia el número de expedientes, de checadas o de jornadas.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const TABLA = 'xecador_ajustes_dia';
const COLUMNAS = ['id', 'negocio_id', 'empleado_id', 'fecha', 'tipo', 'minutos', 'justificada', 'motivo', 'creado_por', 'created_at'];
const INDICE = 'idx_xecador_ajustes_dia_semana';

// [restricción, tipo, fragmentos que su definición debe contener]
const RESTRICCIONES = [
  ['xecador_ajustes_dia_pkey', 'p', ['PRIMARY KEY (id)']],
  ['xecador_ajustes_dia_empleado_fkey', 'f',
    ['FOREIGN KEY (negocio_id, empleado_id)', 'REFERENCES xecador_empleados(negocio_id, id)', 'ON DELETE RESTRICT']],
  ['xecador_ajustes_dia_creado_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE RESTRICT']],
  ['xecador_ajustes_dia_tipo_check', 'c', ["'extra'", "'falta'"]],
  ['xecador_ajustes_dia_forma_check', 'c', ['1440', 'justificada IS NULL', 'justificada IS NOT NULL', 'minutos IS NULL']],
  ['xecador_ajustes_dia_motivo_check', 'c', ['btrim(motivo)', '300']],
];

// tgtype: ROW = 1, BEFORE = 2, DELETE = 8, UPDATE = 16, TRUNCATE = 32.
const TRIGGERS = [
  ['xecador_ajustes_dia_sin_cambios', 27, 'xecador_ajustes_dia_inmutable'],
  ['xecador_ajustes_dia_sin_truncate', 2 | 32, 'xecador_ajustes_dia_inmutable'],
];

async function estado() {
  const faltan = [];
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [TABLA]);
  if (!rows.length) return [`tabla ${TABLA}`];
  const hay = new Set(rows.map((r) => r.column_name));
  for (const c of COLUMNAS) if (!hay.has(c)) faltan.push(`columna ${TABLA}.${c}`);
  const { rows: defs } = await db.query(
    `SELECT c.conname, c.contype, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = $1`, [TABLA]);
  for (const [nombre, tipo, fragmentos] of RESTRICCIONES) {
    const r = defs.find((d) => d.conname === nombre);
    if (!r || r.contype !== tipo || !fragmentos.every((f) => r.def.includes(f))) faltan.push(`restricción ${nombre}`);
  }
  const { rows: idx } = await db.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 AND indexname = $2`, [TABLA, INDICE]);
  if (!idx.length || !idx[0].indexdef.includes('(negocio_id, fecha, empleado_id, id)')) faltan.push(`índice ${INDICE}`);
  const { rows: trg } = await db.query(
    `SELECT t.tgname, t.tgtype, t.tgenabled, p.proname
       FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = 'public' AND cl.relname = $1`, [TABLA]);
  for (const [nombre, bits, funcion] of TRIGGERS) {
    const t = trg.find((x) => x.tgname === nombre);
    if (!t) faltan.push(`trigger ${nombre}`);
    else if (!['O', 'A'].includes(t.tgenabled)) faltan.push(`trigger ${nombre} deshabilitado`);
    else if ((t.tgtype & bits) !== bits || t.proname !== funcion) faltan.push(`trigger ${nombre} con otra definición`);
  }
  return faltan;
}

const CONTEOS = `SELECT (SELECT COUNT(*) FROM xecador_empleados)::int AS empleados,
                        (SELECT COUNT(*) FROM xecador_checadas)::int AS checadas,
                        (SELECT COUNT(*) FROM xecador_jornadas)::int AS jornadas`;
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-138-xecador-ajustes-dia',0))");
  const { rows: [base] } = await db.query(
    `SELECT to_regclass('public.xecador_jornadas') IS NOT NULL AS jornadas, to_regclass('public.xecador_checadas') IS NOT NULL AS checadas`);
  if (!base.jornadas || !base.checadas) {
    throw Error('La 138 necesita la 128 (jornadas) y la 129 (checadas). El runner las aplica antes; revisa por qué no están.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-138] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-138] Aplicando migrations/138_xecador_ajustes_dia.sql (faltaba: ${antes.join('; ')})...`);
    const { rows: [conteoAntes] } = await db.query(CONTEOS);
    await db.query(await readFile(new URL('../migrations/138_xecador_ajustes_dia.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 138 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    await db.query(`SELECT ${COLUMNAS.join(', ')} FROM ${TABLA} LIMIT 0`);
    const { rows: [conteoDespues] } = await db.query(CONTEOS);
    if (JSON.stringify(conteoAntes) !== JSON.stringify(conteoDespues)) {
      throw Error(`La 138 cambió filas existentes (${JSON.stringify(conteoAntes)} → ${JSON.stringify(conteoDespues)}): se revierte`);
    }
    await db.query('COMMIT');
    console.log(`[predeploy-138] Aplicada: ajustes por día listos; ${conteoDespues.empleados} expediente(s) y ${conteoDespues.jornadas} jornada(s) sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-138] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
