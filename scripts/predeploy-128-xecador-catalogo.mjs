// 128: Xecador, Parte A (catálogo completo). Va ANTES del binario nuevo: las
// rutas /api/personal/* leen sucursal, fecha de ingreso, NSS, jornada, PIN y
// versión del expediente.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-127:
//   - Necesita la 127: si no están sus tablas, se detiene (no la aplica por su
//     cuenta: cada migración tiene su propio paso en el runner).
//   - "Ya aplicada" solo si están TODAS sus garantías: columnas nuevas, la
//     llave compuesta a la sucursal (sobre el índice único (id, negocio_id) de
//     sucursales que existe desde la 043; la 128 no toca esa tabla), los CHECK (NSS de 11 dígitos, tipo de baja, «otro» con motivo, activo sin
//     datos de baja, PIN con hash, versión), los tipos nuevos de la bitácora y
//     las jornadas con sus triggers de solo inserción HABILITADOS. Completa, no
//     toca nada.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia el número de expedientes o de sucursales: la 128 no
//     crea ni borra filas existentes.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const COLUMNAS = {
  xecador_empleados: ['sucursal_id', 'puede_checar_otras_sucursales', 'fecha_ingreso', 'nss', 'baja_fecha',
    'baja_tipo', 'pin_hash', 'pin_actualizado_at', 'version'],
  xecador_jornadas: ['id', 'negocio_id', 'empleado_id', 'vigente_desde', 'tipo', 'creado_por', 'created_at'],
  xecador_jornada_dias: ['jornada_id', 'dia', 'entrada', 'salida'],
};

// [tabla, restricción, tipo, fragmentos que su definición debe contener]
const RESTRICCIONES = [
  ['xecador_empleados', 'xecador_empleados_sucursal_fkey', 'f',
    ['FOREIGN KEY (sucursal_id, negocio_id)', 'REFERENCES sucursales(id, negocio_id)', 'ON DELETE RESTRICT']],
  ['xecador_empleados', 'xecador_empleados_nss_check', 'c', ['[0-9]{11}']],
  ['xecador_empleados', 'xecador_empleados_baja_tipo_check', 'c', ["'renuncia'", "'despido'", "'termino_contrato'", "'otro'"]],
  ['xecador_empleados', 'xecador_empleados_baja_otro_motivo', 'c', ["'otro'", 'baja_motivo IS NOT NULL']],
  ['xecador_empleados', 'xecador_empleados_activo_sin_baja', 'c', ['baja_fecha IS NULL', 'baja_tipo IS NULL']],
  ['xecador_empleados', 'xecador_empleados_pin_check', 'c', ["'scrypt$%'"]],
  ['xecador_empleados', 'xecador_empleados_version_check', 'c', ['version >= 1']],
  ['xecador_empleado_eventos', 'xecador_empleado_eventos_tipo_check', 'c',
    ["'alta'", "'edicion'", "'baja'", "'reactivacion'", "'jornada'", "'pin'"]],
  ['xecador_jornadas', 'xecador_jornadas_pkey', 'p', ['PRIMARY KEY (id)']],
  ['xecador_jornadas', 'xecador_jornadas_empleado_fkey', 'f',
    ['FOREIGN KEY (negocio_id, empleado_id)', 'REFERENCES xecador_empleados(negocio_id, id)', 'ON DELETE RESTRICT']],
  ['xecador_jornadas', 'xecador_jornadas_creado_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE RESTRICT']],
  ['xecador_jornadas', 'xecador_jornadas_tipo_check', 'c', ["'diurna'", "'nocturna'", "'mixta'"]],
  ['xecador_jornada_dias', 'xecador_jornada_dias_pkey', 'p', ['PRIMARY KEY (jornada_id, dia)']],
  ['xecador_jornada_dias', 'xecador_jornada_dias_jornada_fkey', 'f', ['REFERENCES xecador_jornadas(id)', 'ON DELETE RESTRICT']],
  ['xecador_jornada_dias', 'xecador_jornada_dias_dia_check', 'c', ['dia >= 1', 'dia <= 7']],
  ['xecador_jornada_dias', 'xecador_jornada_dias_duracion', 'c', ['salida <> entrada']],
];

// tgtype: ROW = 1, BEFORE = 2, DELETE = 8, UPDATE = 16, TRUNCATE = 32.
const TRIGGERS = [
  ['xecador_jornadas', 'xecador_jornadas_sin_cambios', 27, 'xecador_jornadas_inmutable'],
  ['xecador_jornadas', 'xecador_jornadas_sin_truncate', 2 | 32, 'xecador_jornadas_inmutable'],
  ['xecador_jornada_dias', 'xecador_jornada_dias_sin_cambios', 27, 'xecador_jornadas_inmutable'],
  ['xecador_jornada_dias', 'xecador_jornada_dias_sin_truncate', 2 | 32, 'xecador_jornadas_inmutable'],
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
      WHERE NOT t.tgisinternal AND cl.relname = ANY($1::text[])`, [Object.keys(COLUMNAS)]);
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
                        (SELECT COUNT(*) FROM sucursales)::int AS sucursales,
                        (SELECT COUNT(*) FROM xecador_empleado_eventos)::int AS eventos`;
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-128-xecador-catalogo',0))");
  const { rows: [base] } = await db.query(
    `SELECT to_regclass('public.xecador_empleados') IS NOT NULL AS empleados,
            to_regclass('public.xecador_empleado_eventos') IS NOT NULL AS eventos`);
  if (!base.empleados || !base.eventos) {
    throw Error('La 128 necesita la 127 (xecador_empleados y su bitácora). El runner aplica la 127 antes; revisa por qué no está.');
  }
  // La llave a la sucursal se apoya en el índice único (id, negocio_id) de la 043.
  const { rows: [indice] } = await db.query(
    `SELECT i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
            AND pg_get_indexdef(i.indexrelid) LIKE '%(id, negocio_id)%' AS sirve
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'idx_sucursales_id_negocio'`);
  if (!indice?.sirve) {
    throw Error('La 128 necesita el índice único idx_sucursales_id_negocio (id, negocio_id) de la 043, y no está como se espera.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-128] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-128] Aplicando migrations/128_xecador_catalogo.sql (faltaba: ${antes.join('; ')})...`);
    const { rows: [conteoAntes] } = await db.query(CONTEOS);
    await db.query(await readFile(new URL('../migrations/128_xecador_catalogo.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 128 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    for (const [tabla, columnas] of Object.entries(COLUMNAS)) {
      await db.query(`SELECT ${columnas.join(', ')} FROM ${tabla} LIMIT 0`);
    }
    const { rows: [conteoDespues] } = await db.query(CONTEOS);
    if (JSON.stringify(conteoAntes) !== JSON.stringify(conteoDespues)) {
      throw Error(`La 128 cambió filas existentes (${JSON.stringify(conteoAntes)} → ${JSON.stringify(conteoDespues)}): se revierte`);
    }
    await db.query('COMMIT');
    console.log(`[predeploy-128] Aplicada: catálogo listo; ${conteoDespues.empleados} expediente(s) y ${conteoDespues.sucursales} sucursal(es) sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-128] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
