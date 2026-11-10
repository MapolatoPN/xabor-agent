// 133: Xecador, «Revisada» para las alertas de secuencia. Va ANTES del binario
// nuevo: «Para revisar» lee y escribe estas revisiones.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-131:
//   - Necesita la 131 (revisiones): si no está, se detiene.
//   - "Ya aplicada" solo si están TODAS sus garantías: la tabla con sus
//     columnas, llaves y reglas, y sus triggers de solo inserción HABILITADOS.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia el número de expedientes, de checadas o de revisiones.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const TABLA = 'xecador_revisiones_secuencia';
const COLUMNAS = ['id', 'negocio_id', 'empleado_id', 'motivo', 'ancla', 'revisada_por', 'nota', 'created_at'];

// [restricción, tipo, fragmentos que su definición debe contener]
const RESTRICCIONES = [
  ['xecador_revisiones_secuencia_pkey', 'p', ['PRIMARY KEY (id)']],
  ['xecador_revisiones_secuencia_unica', 'u', ['UNIQUE (negocio_id, motivo, ancla)']],
  ['xecador_revisiones_secuencia_empleado_fkey', 'f',
    ['FOREIGN KEY (negocio_id, empleado_id)', 'REFERENCES xecador_empleados(negocio_id, id)', 'ON DELETE RESTRICT']],
  ['xecador_revisiones_secuencia_revisada_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE RESTRICT']],
  ['xecador_revisiones_secuencia_motivo_check', 'c',
    ["'sin_salida'", "'descanso_sin_cerrar'", "'repetida'", "'turno_largo'", "'reentrada'", "'sin_entrada'", "'fin_sin_inicio'"]],
  ['xecador_revisiones_secuencia_ancla_check', 'c', ["ancla ~ '^[ca]:[1-9][0-9]{0,17}$'"]],
  ['xecador_revisiones_secuencia_nota_check', 'c', ['300']],
];

// tgtype: ROW = 1, BEFORE = 2, DELETE = 8, UPDATE = 16, TRUNCATE = 32.
const TRIGGERS = [
  ['xecador_revisiones_secuencia_sin_cambios', 27, 'xecador_revisiones_secuencia_inmutable'],
  ['xecador_revisiones_secuencia_sin_truncate', 2 | 32, 'xecador_revisiones_secuencia_inmutable'],
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
                        (SELECT COUNT(*) FROM xecador_revisiones)::int AS revisiones`;
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-133-xecador-revisiones-secuencia',0))");
  const { rows: [base] } = await db.query(`SELECT to_regclass('public.xecador_revisiones') IS NOT NULL AS revisiones`);
  if (!base.revisiones) {
    throw Error('La 133 necesita la 131 (revisiones). El runner aplica la 131 antes; revisa por qué no está.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-133] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-133] Aplicando migrations/133_xecador_revisiones_secuencia.sql (faltaba: ${antes.join('; ')})...`);
    const { rows: [conteoAntes] } = await db.query(CONTEOS);
    await db.query(await readFile(new URL('../migrations/133_xecador_revisiones_secuencia.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 133 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    await db.query(`SELECT ${COLUMNAS.join(', ')} FROM ${TABLA} LIMIT 0`);
    const { rows: [conteoDespues] } = await db.query(CONTEOS);
    if (JSON.stringify(conteoAntes) !== JSON.stringify(conteoDespues)) {
      throw Error(`La 133 cambió filas existentes (${JSON.stringify(conteoAntes)} → ${JSON.stringify(conteoDespues)}): se revierte`);
    }
    await db.query('COMMIT');
    console.log(`[predeploy-133] Aplicada: revisiones de secuencia listas; ${conteoDespues.checadas} checada(s) sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-133] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
