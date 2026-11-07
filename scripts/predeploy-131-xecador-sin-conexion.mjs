// 131: Xecador, Parte B3 (checadas sin conexión y «para revisar»). Va ANTES
// del binario nuevo: la tablet sincroniza checadas sin conexión y el panel lee
// y escribe revisiones.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-130:
//   - Necesita la 130 (correcciones): si no está, se detiene.
//   - "Ya aplicada" solo si están TODAS sus garantías: columnas nuevas de las
//     checadas con sus reglas, la tabla de revisiones con sus llaves y sus
//     triggers de solo inserción HABILITADOS.
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
  xecador_checadas: ['origen', 'revision', 'ip', 'sincronizada_at', 'ref_servidor', 'transcurrido_ms'],
  xecador_revisiones: ['id', 'negocio_id', 'checada_id', 'revisada_por', 'nota', 'created_at'],
};

// [tabla, restricción, tipo, fragmentos que su definición debe contener]
const RESTRICCIONES = [
  ['xecador_checadas', 'xecador_checadas_origen_check', 'c', ["'en_linea'", "'sin_conexion'"]],
  ['xecador_checadas', 'xecador_checadas_revision_check', 'c',
    ["'reloj_desfasado'", "'sin_referencia'", "'pin_no_valido'", "'otra_sucursal'", "'empleado_de_baja'", "'ip_distinta'"]],
  ['xecador_checadas', 'xecador_checadas_datos_sin_conexion', 'c', ['sincronizada_at IS NULL', 'transcurrido_ms IS NULL']],
  ['xecador_checadas', 'xecador_checadas_transcurrido_check', 'c', ['transcurrido_ms >= 0']],
  ['xecador_revisiones', 'xecador_revisiones_pkey', 'p', ['PRIMARY KEY (id)']],
  ['xecador_revisiones', 'xecador_revisiones_checada_unica', 'u', ['UNIQUE (negocio_id, checada_id)']],
  ['xecador_revisiones', 'xecador_revisiones_checada_fkey', 'f',
    ['FOREIGN KEY (negocio_id, checada_id)', 'REFERENCES xecador_checadas(negocio_id, id)', 'ON DELETE RESTRICT']],
  ['xecador_revisiones', 'xecador_revisiones_revisada_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE RESTRICT']],
  ['xecador_revisiones', 'xecador_revisiones_nota_check', 'c', ['300']],
];

// tgtype: ROW = 1, BEFORE = 2, DELETE = 8, UPDATE = 16, TRUNCATE = 32.
const TRIGGERS = [
  ['xecador_revisiones', 'xecador_revisiones_sin_cambios', 27, 'xecador_revisiones_inmutable'],
  ['xecador_revisiones', 'xecador_revisiones_sin_truncate', 2 | 32, 'xecador_revisiones_inmutable'],
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
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-131-xecador-sin-conexion',0))");
  const { rows: [base] } = await db.query(`SELECT to_regclass('public.xecador_correcciones') IS NOT NULL AS correcciones`);
  if (!base.correcciones) {
    throw Error('La 131 necesita la 130 (correcciones). El runner aplica la 130 antes; revisa por qué no está.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-131] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-131] Aplicando migrations/131_xecador_sin_conexion.sql (faltaba: ${antes.join('; ')})...`);
    const { rows: [conteoAntes] } = await db.query(CONTEOS);
    await db.query(await readFile(new URL('../migrations/131_xecador_sin_conexion.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 131 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    for (const [tabla, columnas] of Object.entries(COLUMNAS)) {
      await db.query(`SELECT ${columnas.join(', ')} FROM ${tabla} LIMIT 0`);
    }
    const { rows: [conteoDespues] } = await db.query(CONTEOS);
    if (JSON.stringify(conteoAntes) !== JSON.stringify(conteoDespues)) {
      throw Error(`La 131 cambió filas existentes (${JSON.stringify(conteoAntes)} → ${JSON.stringify(conteoDespues)}): se revierte`);
    }
    await db.query('COMMIT');
    console.log(`[predeploy-131] Aplicada: sin conexión lista; ${conteoDespues.checadas} checada(s) sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-131] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
