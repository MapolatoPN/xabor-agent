// 127: Xecador, directorio de empleados con número. Va ANTES del binario nuevo:
// las rutas /api/personal/* leen xecador_empleados y xecador_numeros_empleado.
//
// Aditiva y fail-closed:
//   - si ya está aplicada completa, no se toca nada (no vuelve a tomar el
//     candado de negocio_modulos en cada despliegue);
//   - si no, aplica el SQL dentro de una transacción y comprueba TODO lo que la
//     migración garantiza: las dos tablas, la llave del número, la llave que
//     ata el número al empleado, el trigger de solo inserción y el CHECK con
//     'personal' sin haber perdido ningún módulo anterior;
//   - aborta si cambia una sola fila de negocio_modulos: la 127 NO enciende el
//     módulo para nadie.
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

async function estado() {
  const { rows: [r] } = await db.query(
    `SELECT
       to_regclass('public.xecador_empleados') IS NOT NULL AS empleados,
       to_regclass('public.xecador_numeros_empleado') IS NOT NULL AS numeros,
       (SELECT pg_get_constraintdef(oid) FROM pg_constraint
         WHERE conname = 'negocio_modulos_modulo_check') AS check_modulos,
       (SELECT COUNT(*) FROM pg_constraint
         WHERE conname IN ('xecador_empleados_numero_unico',
                           'xecador_empleados_numero_registrado',
                           'xecador_empleados_negocio_id_key',
                           'xecador_empleados_baja_coherente'))::int AS restricciones,
       (SELECT COUNT(*) FROM pg_trigger
         WHERE tgname = 'xecador_numeros_empleado_sin_cambios' AND NOT tgisinternal)::int AS trigger_numeros`);
  const def = r.check_modulos || '';
  const faltan = MODULOS.filter((m) => !def.includes(`'${m}'`));
  return {
    empleados: r.empleados, numeros: r.numeros, faltan,
    restricciones: r.restricciones, trigger: r.trigger_numeros === 1,
  };
}
const completa = (e) => e.empleados && e.numeros && !e.faltan.length && e.restricciones === 4 && e.trigger;

const FILAS_MODULOS = `SELECT COALESCE(string_agg(negocio_id::text || ':' || modulo || ':' || estado, ',' ORDER BY negocio_id, modulo), '') AS f
                         FROM negocio_modulos`;
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-127-xecador-empleados',0))");
  if (completa(await estado())) {
    await db.query('COMMIT');
    console.log('[predeploy-127] Ya aplicada -- no se ejecuta nada.');
  } else {
    const { rows: [antes] } = await db.query(FILAS_MODULOS);
    await db.query(await readFile(new URL('../migrations/127_xecador_empleados.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (!despues.empleados || !despues.numeros) throw Error('La 127 no dejó xecador_empleados y xecador_numeros_empleado');
    if (despues.faltan.length) throw Error(`El CHECK de negocio_modulos no acepta: ${despues.faltan.join(', ')}`);
    if (despues.restricciones !== 4) throw Error(`Faltan restricciones de xecador_empleados (${despues.restricciones}/4)`);
    if (!despues.trigger) throw Error('Falta el trigger que impide liberar números de empleado');
    // Utilizables, no solo existentes.
    await db.query('SELECT id, negocio_id, numero_empleado, nombre, puesto, telefono, estatus, baja_at FROM xecador_empleados LIMIT 0');
    await db.query('SELECT negocio_id, numero, empleado_id FROM xecador_numeros_empleado LIMIT 0');
    const { rows: [tras] } = await db.query(FILAS_MODULOS);
    if (antes.f !== tras.f) throw Error('La 127 cambió módulos de algún negocio: se revierte');
    await db.query('COMMIT');
    console.log('[predeploy-127] Xecador: directorio de empleados listo; el módulo personal sigue apagado para todos los negocios.');
  }
  const { rows: [n] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM negocio_modulos WHERE modulo = 'personal' AND estado IN ('activo','configurado')`);
  console.log(`[predeploy-127] Negocios con el módulo personal encendido: ${n.n}.`);
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(e.message); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
