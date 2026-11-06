// 130: Xecador, Parte B2 (correcciones de checadas). Va ANTES del binario
// nuevo: las rutas del checador leen y escriben las correcciones, y la tablet
// calcula con ellas qué le toca registrar a cada empleado.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-129:
//   - Necesita la 129 (checadas): si no está, se detiene.
//   - "Ya aplicada" solo si están TODAS sus garantías: la tabla y sus
//     columnas, las llaves compuestas con negocio y empleado, la forma de cada
//     acción, y los triggers (solo inserción y objetivo válido) HABILITADOS.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia el número de checadas o de expedientes.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const COLUMNAS = {
  xecador_correcciones: ['id', 'negocio_id', 'empleado_id', 'accion', 'objetivo_checada_id', 'objetivo_correccion_id',
    'tipo', 'hora', 'motivo', 'creado_por', 'created_at'],
};

// [tabla, restricción, tipo, fragmentos que su definición debe contener]
const RESTRICCIONES = [
  ['xecador_checadas', 'xecador_checadas_empleado_id_key', 'u', ['UNIQUE (negocio_id, empleado_id, id)']],
  ['xecador_correcciones', 'xecador_correcciones_pkey', 'p', ['PRIMARY KEY (id)']],
  ['xecador_correcciones', 'xecador_correcciones_empleado_id_key', 'u', ['UNIQUE (negocio_id, empleado_id, id)']],
  ['xecador_correcciones', 'xecador_correcciones_accion_check', 'c', ["'agregar'", "'modificar'", "'anular'", "'restaurar'"]],
  ['xecador_correcciones', 'xecador_correcciones_tipo_check', 'c', ["'entrada'", "'salida'", "'inicio_descanso'", "'fin_descanso'"]],
  ['xecador_correcciones', 'xecador_correcciones_motivo_check', 'c', ['btrim(motivo)', '300']],
  ['xecador_correcciones', 'xecador_correcciones_forma', 'c', ['num_nonnulls(objetivo_checada_id, objetivo_correccion_id) = 1']],
  ['xecador_correcciones', 'xecador_correcciones_creado_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE RESTRICT']],
  ['xecador_correcciones', 'xecador_correcciones_empleado_fkey', 'f',
    ['FOREIGN KEY (negocio_id, empleado_id)', 'REFERENCES xecador_empleados(negocio_id, id)', 'ON DELETE RESTRICT']],
  ['xecador_correcciones', 'xecador_correcciones_checada_fkey', 'f',
    ['FOREIGN KEY (negocio_id, empleado_id, objetivo_checada_id)', 'REFERENCES xecador_checadas(negocio_id, empleado_id, id)', 'ON DELETE RESTRICT']],
  ['xecador_correcciones', 'xecador_correcciones_objetivo_fkey', 'f',
    ['FOREIGN KEY (negocio_id, empleado_id, objetivo_correccion_id)', 'REFERENCES xecador_correcciones(negocio_id, empleado_id, id)', 'ON DELETE RESTRICT']],
];

// tgtype: ROW = 1, BEFORE = 2, INSERT = 4, DELETE = 8, UPDATE = 16, TRUNCATE = 32.
const TRIGGERS = [
  ['xecador_correcciones', 'xecador_correcciones_sin_cambios', 27, 'xecador_correcciones_inmutable'],
  ['xecador_correcciones', 'xecador_correcciones_sin_truncate', 2 | 32, 'xecador_correcciones_inmutable'],
  ['xecador_correcciones', 'xecador_correcciones_objetivo', 1 | 2 | 4, 'xecador_correcciones_objetivo_valido'],
];

const TABLAS = [...new Set([...Object.keys(COLUMNAS), ...RESTRICCIONES.map((r) => r[0])])];

async function estado() {
  const faltan = [];
  const sinTabla = new Set();
  for (const [tabla, columnas] of Object.entries(COLUMNAS)) {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [tabla]);
    if (!rows.length) { faltan.push(`tabla ${tabla}`); sinTabla.add(tabla); continue; }
    const hay = new Set(rows.map((r) => r.column_name));
    for (const c of columnas) if (!hay.has(c)) faltan.push(`columna ${tabla}.${c}`);
  }
  const { rows: defs } = await db.query(
    `SELECT c.conname, c.contype, cl.relname, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = ANY($1::text[])`, [TABLAS]);
  for (const [tabla, nombre, tipo, fragmentos] of RESTRICCIONES) {
    if (sinTabla.has(tabla)) continue;
    const r = defs.find((d) => d.relname === tabla && d.conname === nombre);
    if (!r || r.contype !== tipo || !fragmentos.every((f) => r.def.includes(f))) faltan.push(`restricción ${nombre}`);
  }
  const { rows: trg } = await db.query(
    `SELECT cl.relname, t.tgname, t.tgtype, t.tgenabled, p.proname
       FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND cl.relname = ANY($1::text[])`, [TRIGGERS.map((x) => x[0])]);
  for (const [tabla, nombre, bits, funcion] of TRIGGERS) {
    if (sinTabla.has(tabla)) continue;
    const t = trg.find((x) => x.relname === tabla && x.tgname === nombre);
    if (!t) faltan.push(`trigger ${nombre}`);
    else if (!['O', 'A'].includes(t.tgenabled)) faltan.push(`trigger ${nombre} deshabilitado`);
    else if ((t.tgtype & bits) !== bits || t.proname !== funcion) faltan.push(`trigger ${nombre} con otra definición`);
  }
  return faltan;
}

const CONTEOS = `SELECT (SELECT COUNT(*) FROM xecador_empleados)::int AS empleados,
                        (SELECT COUNT(*) FROM xecador_checadas)::int AS checadas`;
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-130-xecador-correcciones',0))");
  const { rows: [base] } = await db.query(`SELECT to_regclass('public.xecador_checadas') IS NOT NULL AS checadas`);
  if (!base.checadas) {
    throw Error('La 130 necesita la 129 (checadas). El runner aplica la 129 antes; revisa por qué no está.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-130] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-130] Aplicando migrations/130_xecador_correcciones.sql (faltaba: ${antes.join('; ')})...`);
    const { rows: [conteoAntes] } = await db.query(CONTEOS);
    await db.query(await readFile(new URL('../migrations/130_xecador_correcciones.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 130 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    for (const [tabla, columnas] of Object.entries(COLUMNAS)) {
      await db.query(`SELECT ${columnas.join(', ')} FROM ${tabla} LIMIT 0`);
    }
    const { rows: [conteoDespues] } = await db.query(CONTEOS);
    if (JSON.stringify(conteoAntes) !== JSON.stringify(conteoDespues)) {
      throw Error(`La 130 cambió filas existentes (${JSON.stringify(conteoAntes)} → ${JSON.stringify(conteoDespues)}): se revierte`);
    }
    await db.query('COMMIT');
    console.log(`[predeploy-130] Aplicada: correcciones listas; ${conteoDespues.checadas} checada(s) sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-130] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
