// 166: asistente del restaurante, Mejora 1 (el botón de cada tarjeta). Una
// tabla nueva y vacía que anota qué botón se usó. Va ANTES del binario nuevo:
// sin ella, pulsar un botón no queda anotado (el botón igual abre su pantalla,
// y nada de esto toca pedidos, cobros ni impresión).
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-165:
//   - Necesita la 164 (las tablas del asistente): si falta, se detiene.
//   - "Ya aplicada" solo si están la tabla, sus columnas, reglas e índice.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia cualquier negocio, configuración, campaña o hallazgo,
//     o si la primera vez la tabla queda con filas.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const A = 'asistente_restaurante_acciones';
const H = 'asistente_restaurante_hallazgos';
const TZ = 'timestamp with time zone';
// [columna, tipo de information_schema, ¿acepta NULL?]
const COLUMNAS = [
  ['id', 'bigint', 'NO'], ['negocio_id', 'uuid', 'NO'], ['hallazgo_id', 'bigint', 'NO'], ['usuario_id', 'uuid', 'YES'],
  ['accion', 'text', 'NO'], ['paso', 'text', 'NO'], ['campana_id', 'integer', 'YES'], ['creado_en', TZ, 'NO'],
];
// [regla, tipo (c=check, f=llave foránea), fragmentos que su definición debe contener]
const REGLAS = [
  [`${A}_accion`, 'c', ["'^[a-z_]{3,40}$'"]],
  [`${A}_paso`, 'c', ["'abrio'", "'creo_campana'"]],
  [`${A}_campana`, 'c', ["'creo_campana'", 'campana_id IS NOT NULL']],
  [`${A}_negocio_id_fkey`, 'f', ['REFERENCES negocios(id)', 'ON DELETE CASCADE']],
  [`${A}_negocio_id_hallazgo_id_fkey`, 'f', [`REFERENCES ${H}(negocio_id, id)`, 'ON DELETE CASCADE']],
  [`${A}_usuario_id_fkey`, 'f', ['REFERENCES usuarios(id)', 'ON DELETE SET NULL']],
];
const INDICE = [`${A}_hallazgo`, ['(negocio_id, hallazgo_id, creado_en DESC)']];

async function estado() {
  const { rows: [t] } = await db.query('SELECT to_regclass($1) IS NOT NULL AS hay', [`public.${A}`]);
  if (!t.hay) return [`tabla ${A}`];
  const faltan = [];
  for (const [columna, tipo, nulo] of COLUMNAS) {
    const { rows: [c] } = await db.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [A, columna]);
    if (!c) faltan.push(`columna ${columna}`);
    else if (c.data_type !== tipo || c.is_nullable !== nulo) faltan.push(`columna ${columna} con otro tipo`);
  }
  for (const [nombre, tipo, fragmentos] of REGLAS) {
    const { rows: [r] } = await db.query(
      `SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = $1 AND c.conname = $2`, [A, nombre]);
    if (!r || r.contype !== tipo || !r.convalidated || !fragmentos.every((f) => r.def.includes(f))) faltan.push(`regla ${nombre}`);
  }
  const [nombre, fragmentos] = INDICE;
  const { rows: [i] } = await db.query(
    `SELECT ix.indisvalid, pg_get_indexdef(ix.indexrelid) AS def
       FROM pg_index ix JOIN pg_class ic ON ic.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = ic.relnamespace
      WHERE n.nspname = 'public' AND t.relname = $1 AND ic.relname = $2`, [A, nombre]);
  if (!i || !i.indisvalid || !fragmentos.every((f) => i.def.includes(f))) faltan.push(`índice ${nombre}`);
  return faltan;
}

// La huella de lo que ya había: la 166 solo agrega; si algo de esto cambia,
// tocó lo que no debía.
const HUELLA = `SELECT (SELECT COUNT(*) FROM negocios)::int AS negocios,
                       (SELECT COUNT(*) FROM configuracion)::int AS configuracion,
                       (SELECT COUNT(*) FROM campanas)::int AS campanas,
                       (SELECT COUNT(*) FROM ${H})::int AS hallazgos,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, slug, activo), ',' ORDER BY id)), '')
                          FROM negocios) AS negocios_md5,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', negocio_id, clave, valor), ',' ORDER BY negocio_id, clave)), '')
                          FROM configuracion) AS configuracion_md5,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, estado, total_destinatarios), ',' ORDER BY id)), '')
                          FROM campanas) AS campanas_md5,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, negocio_id, tipo, elegido, mostrado), ',' ORDER BY id)), '')
                          FROM ${H}) AS hallazgos_md5`;

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-166-asistente-acciones',0))");
  const { rows: [base] } = await db.query(
    `SELECT to_regclass('public.negocios') IS NOT NULL AS negocios,
            to_regclass('public.usuarios') IS NOT NULL AS usuarios,
            to_regclass('public.campanas') IS NOT NULL AS campanas,
            to_regclass('public.${H}') IS NOT NULL AS hallazgos`);
  if (!base.negocios || !base.usuarios || !base.campanas || !base.hallazgos) {
    throw Error(`La 166 necesita la 164 (${H}) y la tabla campanas. Revisa por qué no están.`);
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-166] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-166] Aplicando migrations/166_asistente_acciones.sql (faltaba: ${antes.join('; ')})...`);
    const nueva = antes.includes(`tabla ${A}`);
    const { rows: [huellaAntes] } = await db.query(HUELLA);
    await db.query(await readFile(new URL('../migrations/166_asistente_acciones.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 166 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    const { rows: [huellaDespues] } = await db.query(HUELLA);
    if (JSON.stringify(huellaAntes) !== JSON.stringify(huellaDespues)) {
      throw Error(`La 166 cambió negocios, configuración, campañas o hallazgos existentes (${JSON.stringify(huellaAntes)} → ${JSON.stringify(huellaDespues)}): se revierte`);
    }
    if (nueva) {
      const { rows: [r] } = await db.query(`SELECT COUNT(*)::int AS filas FROM ${A}`);
      if (r.filas) throw Error(`La 166 dejó ${r.filas} fila(s) en ${A}, que debe nacer vacía. Se revierte.`);
    }
    await db.query('COMMIT');
    console.log(nueva
      ? `[predeploy-166] Aplicada: la tabla de botones del asistente, vacía; ${huellaDespues.negocios} negocio(s), sus campañas y sus hallazgos sin cambios.`
      : `[predeploy-166] Reparada (faltaba: ${antes.join('; ')}).`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-166] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
