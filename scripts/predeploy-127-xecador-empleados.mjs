// 127: Xecador, directorio de empleados con número. Va ANTES del binario nuevo:
// las rutas /api/personal/* leen xecador_empleados y xecador_numeros_empleado.
//
// Aditiva y fail-closed:
//   - "Ya aplicada" solo si están TODAS las garantías de la migración (regla
//     de los gates de este repo, ver predeploy-051): tablas y columnas que el
//     código usa, la llave primaria del registro de números, la llave triple
//     que ata número y empleado, los CHECK, la llave del autor, el trigger de
//     solo inserción HABILITADO y con sus eventos, y el CHECK de módulos con
//     'personal' sin haber perdido ninguno. Si está completa, no se toca nada
//     (no vuelve a tomar el candado de negocio_modulos en cada despliegue).
//   - Si falta algo, dice qué y aplica el SQL dentro de una transacción. Lo que
//     el SQL puede reconstruir (una tabla que falta, el trigger, el CHECK de
//     módulos, la llave del autor) queda reparado; lo que no puede (p. ej. la
//     llave primaria de una tabla que ya existe) hace fallar la verificación
//     posterior: se revierte todo y el despliegue se detiene.
//   - Aborta si cambia una sola fila de negocio_modulos: la 127 NO enciende ni
//     apaga el módulo para nadie. Al final informa, consultándolos, cuántos
//     negocios lo tienen encendido.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

// Los módulos que el CHECK tiene que seguir aceptando (la lista de la 051) más
// el nuevo. Si el CHECK perdiera uno, un negocio que lo tiene quedaría fuera
// de la restricción en el siguiente ALTER.
const MODULOS = [
  'pos', 'usuarios', 'caja', 'menu', 'impresion', 'whatsapp', 'voz', 'rappi',
  'facturacion', 'rewards', 'chat_imagenes', 'chat_documentos_pdf', 'cotizaciones',
  'generador_cotizaciones', 'pagos', 'repartidores', 'asistente_comercial_cotizaciones',
  'restaurante', 'tienda_online', 'personal',
];

// Columnas que el código lee o escribe (personalService.js).
const COLUMNAS = {
  xecador_numeros_empleado: ['negocio_id', 'numero', 'empleado_id', 'creado_por', 'created_at'],
  xecador_empleados: ['id', 'negocio_id', 'numero_empleado', 'nombre', 'puesto', 'telefono', 'estatus',
    'baja_at', 'baja_motivo', 'baja_por', 'creado_por', 'created_at', 'updated_at'],
};

// [tabla, restricción, tipo, fragmentos que su definición debe contener]
const RESTRICCIONES = [
  ['xecador_numeros_empleado', 'xecador_numeros_empleado_pkey', 'p', ['PRIMARY KEY (negocio_id, numero)']],
  ['xecador_numeros_empleado', 'xecador_numeros_empleado_negocio_id_numero_empleado_id_key', 'u', ['UNIQUE (negocio_id, numero, empleado_id)']],
  ['xecador_numeros_empleado', 'xecador_numeros_empleado_numero_check', 'c', ['numero >= 1', 'numero <= 999999999']],
  ['xecador_numeros_empleado', 'xecador_numeros_empleado_negocio_id_fkey', 'f', ['REFERENCES negocios(id)']],
  ['xecador_numeros_empleado', 'xecador_numeros_empleado_creado_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE RESTRICT']],
  ['xecador_empleados', 'xecador_empleados_pkey', 'p', ['PRIMARY KEY (id)']],
  ['xecador_empleados', 'xecador_empleados_numero_unico', 'u', ['UNIQUE (negocio_id, numero_empleado)']],
  ['xecador_empleados', 'xecador_empleados_numero_registrado', 'f',
    ['FOREIGN KEY (negocio_id, numero_empleado, id)', 'REFERENCES xecador_numeros_empleado(negocio_id, numero, empleado_id)']],
  ['xecador_empleados', 'xecador_empleados_negocio_id_key', 'u', ['UNIQUE (negocio_id, id)']],
  ['xecador_empleados', 'xecador_empleados_negocio_id_fkey', 'f', ['REFERENCES negocios(id)']],
  ['xecador_empleados', 'xecador_empleados_baja_coherente', 'c', ['baja_at IS NOT NULL']],
  ['xecador_empleados', 'xecador_empleados_estatus_check', 'c', ["'activo'", "'baja'"]],
  ['xecador_empleados', 'xecador_empleados_nombre_check', 'c', ['btrim(nombre)']],
];

// tgtype: ROW = 1, BEFORE = 2, DELETE = 8, UPDATE = 16 → 27. tgenabled 'D' =
// deshabilitado; 'O'/'A' = dispara en uso normal.
const TRIGGERS = [
  ['xecador_numeros_empleado', 'xecador_numeros_empleado_sin_cambios', 27, 'xecador_numeros_empleado_inmutable'],
  ['xecador_empleados', 'set_updated_at', 1 | 2 | 16, 'set_updated_at'],
];

async function estado() {
  const faltan = [];
  // Si falta una tabla, se reporta la tabla y no cada pieza suya.
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
      WHERE n.nspname = 'public' AND cl.relname = ANY($1::text[])`, [Object.keys(COLUMNAS)]);
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
  const { rows: [chk] } = await db.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'negocio_modulos_modulo_check'`);
  const sinModulo = MODULOS.filter((m) => !(chk?.def || '').includes(`'${m}'`));
  if (sinModulo.length) faltan.push(`CHECK de negocio_modulos sin: ${sinModulo.join(', ')}`);
  return faltan;
}

const FILAS_MODULOS = `SELECT COALESCE(string_agg(negocio_id::text || ':' || modulo || ':' || estado, ',' ORDER BY negocio_id, modulo), '') AS f
                         FROM negocio_modulos`;
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-127-xecador-empleados',0))");
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-127] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-127] Aplicando migrations/127_xecador_empleados.sql (faltaba: ${antes.join('; ')})...`);
    const { rows: [modulosAntes] } = await db.query(FILAS_MODULOS);
    await db.query(await readFile(new URL('../migrations/127_xecador_empleados.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 127 sigue faltando: ${despues.join('; ')}. `
        + 'La migración no puede reconstruirlo sobre una tabla existente: requiere revisión manual. Se revierte.');
    }
    // Utilizables, no solo existentes.
    await db.query(`SELECT ${COLUMNAS.xecador_empleados.join(', ')} FROM xecador_empleados LIMIT 0`);
    await db.query(`SELECT ${COLUMNAS.xecador_numeros_empleado.join(', ')} FROM xecador_numeros_empleado LIMIT 0`);
    const { rows: [modulosDespues] } = await db.query(FILAS_MODULOS);
    if (modulosAntes.f !== modulosDespues.f) throw Error('La 127 cambió módulos de algún negocio: se revierte');
    await db.query('COMMIT');
    console.log('[predeploy-127] Aplicada: directorio de empleados listo; ninguna fila de negocio_modulos cambió.');
  }
  // Se informa lo que HAY, consultado, no lo que se supone.
  const { rows: [m] } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE estado IN ('activo','configurado'))::int AS encendido,
            COUNT(*) FILTER (WHERE estado NOT IN ('activo','configurado'))::int AS apagado
       FROM negocio_modulos WHERE modulo = 'personal'`);
  console.log(`[predeploy-127] Módulo personal: ${m.encendido} negocio(s) con el módulo encendido (activo/configurado), `
    + `${m.apagado} con fila apagada.`);
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-127] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
