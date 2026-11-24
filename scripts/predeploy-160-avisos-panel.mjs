// 160: avisos del panel (la campanita). Una tabla nueva y vacía que el
// binario nuevo usa solo en el negocio con la bandera avisos_panel_v1
// encendida. Va ANTES del binario nuevo: con la bandera encendida y sin la
// tabla, los avisos se perderían (nunca detienen al bot ni a los pedidos).
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-149:
//   - Necesita negocios y usuarios (las llaves de la tabla): si faltan, se
//     detiene.
//   - "Ya aplicada" solo si están la tabla, las columnas con su tipo, las
//     reglas y los índices.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia cualquier negocio, usuario o configuración, o si la
//     primera vez la tabla queda con filas.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const TABLAS = ['avisos_panel'];
// [tabla, columna, tipo de information_schema, ¿acepta NULL?]
const COLUMNAS = [
  ['avisos_panel', 'id', 'bigint', 'NO'],
  ['avisos_panel', 'negocio_id', 'uuid', 'NO'],
  ['avisos_panel', 'tipo', 'text', 'NO'],
  ['avisos_panel', 'telefono', 'text', 'YES'],
  ['avisos_panel', 'datos', 'jsonb', 'NO'],
  ['avisos_panel', 'creado_en', 'timestamp with time zone', 'NO'],
  ['avisos_panel', 'visto_en', 'timestamp with time zone', 'YES'],
  ['avisos_panel', 'visto_por', 'uuid', 'YES'],
];
// [tabla, regla, tipo (c=check, f=llave foránea), fragmentos que su definición debe contener]
const REGLAS = [
  ['avisos_panel', 'avisos_panel_tipo', 'c', ["'cliente_esperando'", "'revision_humana'", "'bot_retomo'",
    "'fallas_bot'", "'negativa_falsa'", "'pago_sin_proveedor'"]],
  ['avisos_panel', 'avisos_panel_visto', 'c', ['visto_por IS NULL', 'visto_en IS NOT NULL']],
  ['avisos_panel', 'avisos_panel_datos_objeto', 'c', ['jsonb_typeof(datos)', "'object'"]],
  ['avisos_panel', 'avisos_panel_negocio_id_fkey', 'f', ['REFERENCES negocios(id)', 'ON DELETE CASCADE']],
  ['avisos_panel', 'avisos_panel_visto_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE SET NULL']],
];
// [tabla, índice, fragmentos que su definición debe contener]
const INDICES = [
  ['avisos_panel', 'avisos_panel_negocio', ['(negocio_id, creado_en DESC, id DESC)']],
  ['avisos_panel', 'avisos_panel_sin_ver', ['(negocio_id, tipo, telefono)', 'visto_en IS NULL']],
];

async function estado() {
  const faltan = [];
  for (const t of TABLAS) {
    const { rows: [r] } = await db.query('SELECT to_regclass($1) IS NOT NULL AS hay', [`public.${t}`]);
    if (!r.hay) faltan.push(`tabla ${t}`);
  }
  for (const [tabla, columna, tipo, nulo] of COLUMNAS) {
    const { rows: [c] } = await db.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [tabla, columna]);
    if (!c) faltan.push(`columna ${tabla}.${columna}`);
    else if (c.data_type !== tipo || c.is_nullable !== nulo) faltan.push(`columna ${tabla}.${columna} con otro tipo`);
  }
  for (const [tabla, nombre, tipo, fragmentos] of REGLAS) {
    const { rows: [r] } = await db.query(
      `SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = $1 AND c.conname = $2`, [tabla, nombre]);
    if (!r || r.contype !== tipo || !r.convalidated || !fragmentos.every((f) => r.def.includes(f))) faltan.push(`regla ${nombre}`);
  }
  for (const [tabla, nombre, fragmentos] of INDICES) {
    const { rows: [i] } = await db.query(
      `SELECT ix.indisvalid, pg_get_indexdef(ix.indexrelid) AS def
         FROM pg_index ix JOIN pg_class ic ON ic.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = ic.relnamespace
        WHERE n.nspname = 'public' AND t.relname = $1 AND ic.relname = $2`, [tabla, nombre]);
    if (!i || !i.indisvalid || !fragmentos.every((f) => i.def.includes(f))) faltan.push(`índice ${nombre}`);
  }
  return faltan;
}

// La huella de lo que ya había: la 160 solo crea; si algo de esto cambia,
// tocó lo que no debía.
const HUELLA = `SELECT (SELECT COUNT(*) FROM negocios)::int AS negocios,
                       (SELECT COUNT(*) FROM usuarios)::int AS usuarios,
                       (SELECT COUNT(*) FROM configuracion)::int AS configuracion,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, slug, activo), ',' ORDER BY id)), '')
                          FROM negocios) AS negocios_md5,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', negocio_id, clave, valor), ',' ORDER BY negocio_id, clave)), '')
                          FROM configuracion) AS configuracion_md5`;

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-160-avisos-panel',0))");
  const { rows: [base] } = await db.query(
    `SELECT to_regclass('public.negocios') IS NOT NULL AS negocios,
            to_regclass('public.usuarios') IS NOT NULL AS usuarios,
            to_regclass('public.configuracion') IS NOT NULL AS configuracion`);
  if (!base.negocios || !base.usuarios || !base.configuracion) {
    throw Error('La 160 necesita negocios, usuarios y configuracion. Revisa por qué no están.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-160] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-160] Aplicando migrations/160_avisos_panel.sql (faltaba: ${antes.join('; ')})...`);
    const primeraVez = antes.includes('tabla avisos_panel');
    const { rows: [huellaAntes] } = await db.query(HUELLA);
    await db.query(await readFile(new URL('../migrations/160_avisos_panel.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 160 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    await db.query('SELECT id, negocio_id, tipo, telefono, datos, creado_en, visto_en, visto_por FROM avisos_panel LIMIT 0');
    const { rows: [huellaDespues] } = await db.query(HUELLA);
    if (JSON.stringify(huellaAntes) !== JSON.stringify(huellaDespues)) {
      throw Error(`La 160 cambió negocios, usuarios o configuración existentes (${JSON.stringify(huellaAntes)} → ${JSON.stringify(huellaDespues)}): se revierte`);
    }
    if (primeraVez) {
      const { rows: [r] } = await db.query('SELECT COUNT(*)::int AS filas FROM avisos_panel');
      if (r.filas) throw Error(`La 160 dejó ${r.filas} aviso(s) en una tabla que debe nacer vacía. Se revierte.`);
    }
    await db.query('COMMIT');
    console.log(primeraVez
      ? `[predeploy-160] Aplicada: tabla avisos_panel vacía; ${huellaDespues.negocios} negocio(s) y su configuración sin cambios.`
      : `[predeploy-160] Reparada (faltaba: ${antes.join('; ')}).`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-160] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
