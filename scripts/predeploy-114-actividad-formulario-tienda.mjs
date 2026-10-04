// 114: la telemetría de formularios acepta los pasos de la tienda (TIENDA y
// DIRECCION). Va ANTES del binario nuevo, aunque sin ella nada se rompe: un
// paso que la regla no admite se pierde dentro de su SAVEPOINT y el borrador
// se guarda igual. Solo amplía un CHECK: aborta si cambia una sola fila.
//
// lock_timeout corto: la tabla la escribe el endpoint de Flows del binario que
// sigue vivo. Si no hay lock en 3 s, el despliegue se aborta y se reintenta;
// nunca deja una fila de espera larga delante de esas escrituras.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });
const CONTEO = `SELECT count(*)::int AS filas, count(paso)::int AS con_paso,
  COALESCE(md5(string_agg(pregunta_id::text || clave || tipo || COALESCE(paso,'') || revision, ',' ORDER BY pregunta_id, clave)), '') AS huella
  FROM agente_actividad_formulario`;
try {
  await db.connect(); await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-114-actividad-formulario-tienda',0))");
  const { rows: [tabla] } = await db.query(`SELECT to_regclass('public.agente_actividad_formulario') IS NOT NULL AS ok`);
  if (!tabla.ok) throw Error('Falta agente_actividad_formulario (110): la 114 va después');
  // El candado que el ALTER tomaría de todos modos, ANTES del primer conteo: un
  // evento que el binario vivo escriba en medio ya no cambia el «después» y no
  // aborta el despliegue en falso. Tomarlo de una vez (y no uno menor que luego
  // sube) evita un interbloqueo con quien lee la tabla y después escribe en ella.
  await db.query('LOCK TABLE agente_actividad_formulario IN ACCESS EXCLUSIVE MODE');
  const { rows: [antes] } = await db.query(CONTEO);
  await db.query(await readFile(new URL('../migrations/114_actividad_formulario_tienda.sql', import.meta.url), 'utf8'));
  const { rows: [despues] } = await db.query(CONTEO);
  if (JSON.stringify(antes) !== JSON.stringify(despues)) throw Error('La 114 alteró eventos de formularios: se revierte');
  const { rows: [regla] } = await db.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'agente_actividad_formulario'::regclass AND conname = 'agente_actividad_formulario_paso_check'`);
  for (const paso of ['MENU', 'PLATILLO', 'TACOS', 'ENTREGA', 'CARRITO', 'EDITAR', 'FINAL', 'TIENDA', 'DIRECCION']) {
    if (!regla?.def?.includes(`'${paso}'`)) throw Error(`La regla de pasos no admite ${paso}`);
  }
  await db.query('COMMIT'); console.log('[predeploy-114] Pasos de la tienda admitidos en la telemetría; ningún evento cambió; ninguna bandera activada.');
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(e.message); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
