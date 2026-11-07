// 129: Xecador, Parte B1 (checadas y tablets). Va ANTES del binario nuevo: las
// rutas /api/checador/* y /api/personal/checador/* leen y escriben estas tablas.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-128:
//   - Necesita la 128 (PIN y jornadas del expediente): si no está, se detiene.
//   - "Ya aplicada" solo si están TODAS sus garantías: tablas y columnas, llaves
//     compuestas con el negocio, CHECK, token único y los triggers de solo
//     inserción de checadas y fotos HABILITADOS. Completa, no toca nada.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia el número de expedientes o de sucursales: la 129 no
//     crea ni borra filas existentes.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const COLUMNAS = {
  xecador_config: ['negocio_id', 'foto_al_checar', 'updated_at', 'updated_por'],
  xecador_dispositivos: ['id', 'negocio_id', 'sucursal_id', 'nombre', 'codigo_hash', 'codigo_expira_at', 'token_hash',
    'creado_por', 'created_at', 'vinculado_at', 'ultimo_uso_at', 'revocado_at', 'revocado_por'],
  xecador_empleados: ['pin_fallos', 'pin_ultimo_fallo_at', 'pin_bloqueado_hasta'],
  xecador_checadas: ['id', 'negocio_id', 'empleado_id', 'sucursal_id', 'dispositivo_id', 'tipo', 'hora_oficial',
    'hora_dispositivo', 'clave', 'foto', 'created_at'],
  xecador_checada_fotos: ['checada_id', 'negocio_id', 'mime', 'datos', 'created_at'],
  xecador_avisos: ['id', 'negocio_id', 'tipo', 'empleado_id', 'dispositivo_id', 'detalle', 'created_at', 'atendido_at', 'atendido_por'],
};

// [tabla, restricción, tipo, fragmentos que su definición debe contener]
const RESTRICCIONES = [
  ['xecador_config', 'xecador_config_pkey', 'p', ['PRIMARY KEY (negocio_id)']],
  ['xecador_config', 'xecador_config_negocio_id_fkey', 'f', ['REFERENCES negocios(id)', 'ON DELETE RESTRICT']],
  ['xecador_config', 'xecador_config_updated_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE SET NULL']],
  ['xecador_dispositivos', 'xecador_dispositivos_pkey', 'p', ['PRIMARY KEY (id)']],
  ['xecador_dispositivos', 'xecador_dispositivos_nombre_check', 'c', ['btrim(nombre)', '60']],
  ['xecador_dispositivos', 'xecador_dispositivos_creado_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE SET NULL']],
  ['xecador_dispositivos', 'xecador_dispositivos_revocado_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE SET NULL']],
  ['xecador_dispositivos', 'xecador_dispositivos_negocio_id_key', 'u', ['UNIQUE (negocio_id, id)']],
  ['xecador_dispositivos', 'xecador_dispositivos_token_unico', 'u', ['UNIQUE (token_hash)']],
  ['xecador_dispositivos', 'xecador_dispositivos_sucursal_fkey', 'f',
    ['FOREIGN KEY (sucursal_id, negocio_id)', 'REFERENCES sucursales(id, negocio_id)', 'ON DELETE RESTRICT']],
  ['xecador_dispositivos', 'xecador_dispositivos_codigo_vence', 'c', ['codigo_expira_at IS NOT NULL']],
  ['xecador_dispositivos', 'xecador_dispositivos_token_vinculado', 'c', ['vinculado_at IS NOT NULL']],
  ['xecador_empleados', 'xecador_empleados_pin_fallos_check', 'c', ['pin_fallos >= 0']],
  ['xecador_checadas', 'xecador_checadas_pkey', 'p', ['PRIMARY KEY (id)']],
  ['xecador_checadas', 'xecador_checadas_negocio_id_key', 'u', ['UNIQUE (negocio_id, id)']],
  ['xecador_checadas', 'xecador_checadas_clave_unica', 'u', ['UNIQUE (negocio_id, clave)']],
  ['xecador_checadas', 'xecador_checadas_tipo_check', 'c', ["'entrada'", "'salida'", "'inicio_descanso'", "'fin_descanso'"]],
  ['xecador_checadas', 'xecador_checadas_foto_check', 'c', ["'no_requerida'", "'tomada'", "'no_disponible'"]],
  ['xecador_checadas', 'xecador_checadas_empleado_fkey', 'f',
    ['FOREIGN KEY (negocio_id, empleado_id)', 'REFERENCES xecador_empleados(negocio_id, id)', 'ON DELETE RESTRICT']],
  ['xecador_checadas', 'xecador_checadas_sucursal_fkey', 'f',
    ['FOREIGN KEY (sucursal_id, negocio_id)', 'REFERENCES sucursales(id, negocio_id)', 'ON DELETE RESTRICT']],
  ['xecador_checadas', 'xecador_checadas_dispositivo_fkey', 'f',
    ['FOREIGN KEY (negocio_id, dispositivo_id)', 'REFERENCES xecador_dispositivos(negocio_id, id)', 'ON DELETE RESTRICT']],
  ['xecador_checada_fotos', 'xecador_checada_fotos_pkey', 'p', ['PRIMARY KEY (checada_id)']],
  ['xecador_checada_fotos', 'xecador_checada_fotos_checada_fkey', 'f',
    ['FOREIGN KEY (negocio_id, checada_id)', 'REFERENCES xecador_checadas(negocio_id, id)', 'ON DELETE RESTRICT']],
  ['xecador_checada_fotos', 'xecador_checada_fotos_mime_check', 'c', ["'image/jpeg'", "'image/webp'"]],
  ['xecador_checada_fotos', 'xecador_checada_fotos_datos_check', 'c', ['204800']],
  ['xecador_avisos', 'xecador_avisos_pkey', 'p', ['PRIMARY KEY (id)']],
  ['xecador_avisos', 'xecador_avisos_negocio_id_fkey', 'f', ['REFERENCES negocios(id)', 'ON DELETE RESTRICT']],
  ['xecador_avisos', 'xecador_avisos_atendido_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE SET NULL']],
  ['xecador_avisos', 'xecador_avisos_tipo_check', 'c', ["'pin_bloqueado'", "'dispositivo_pausado'", "'turno_sin_cerrar'",
    "'pin_no_valido'", "'checada_sin_empleado'"]],
  ['xecador_avisos', 'xecador_avisos_empleado_fkey', 'f',
    ['FOREIGN KEY (negocio_id, empleado_id)', 'REFERENCES xecador_empleados(negocio_id, id)', 'ON DELETE RESTRICT']],
  ['xecador_avisos', 'xecador_avisos_dispositivo_fkey', 'f',
    ['FOREIGN KEY (negocio_id, dispositivo_id)', 'REFERENCES xecador_dispositivos(negocio_id, id)', 'ON DELETE RESTRICT']],
];

// tgtype: ROW = 1, BEFORE = 2, DELETE = 8, UPDATE = 16, TRUNCATE = 32.
const TRIGGERS = [
  ['xecador_checadas', 'xecador_checadas_sin_cambios', 27, 'xecador_checadas_inmutable'],
  ['xecador_checadas', 'xecador_checadas_sin_truncate', 2 | 32, 'xecador_checadas_inmutable'],
  ['xecador_checada_fotos', 'xecador_checada_fotos_sin_cambios', 27, 'xecador_checadas_inmutable'],
  ['xecador_checada_fotos', 'xecador_checada_fotos_sin_truncate', 2 | 32, 'xecador_checadas_inmutable'],
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
                        (SELECT COUNT(*) FROM sucursales)::int AS sucursales,
                        (SELECT COUNT(*) FROM xecador_empleado_eventos)::int AS eventos`;
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-129-xecador-checadas',0))");
  const { rows: [base] } = await db.query(
    `SELECT to_regclass('public.xecador_jornadas') IS NOT NULL AS jornadas,
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'xecador_empleados' AND column_name = 'pin_hash') AS pin`);
  if (!base.jornadas || !base.pin) {
    throw Error('La 129 necesita la 128 (PIN y jornadas del expediente). El runner aplica la 128 antes; revisa por qué no está.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-129] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-129] Aplicando migrations/129_xecador_checadas.sql (faltaba: ${antes.join('; ')})...`);
    const { rows: [conteoAntes] } = await db.query(CONTEOS);
    await db.query(await readFile(new URL('../migrations/129_xecador_checadas.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 129 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    for (const [tabla, columnas] of Object.entries(COLUMNAS)) {
      await db.query(`SELECT ${columnas.join(', ')} FROM ${tabla} LIMIT 0`);
    }
    const { rows: [conteoDespues] } = await db.query(CONTEOS);
    if (JSON.stringify(conteoAntes) !== JSON.stringify(conteoDespues)) {
      throw Error(`La 129 cambió filas existentes (${JSON.stringify(conteoAntes)} → ${JSON.stringify(conteoDespues)}): se revierte`);
    }
    await db.query('COMMIT');
    console.log(`[predeploy-129] Aplicada: checador listo; ${conteoDespues.empleados} expediente(s) sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-129] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
