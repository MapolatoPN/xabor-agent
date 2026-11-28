// 165: asistente del restaurante, Fase 3 (la IA redacta y el resumen por
// WhatsApp). Una columna nueva en las corridas (NULL), dos tablas nuevas y
// vacías, y dos tipos más en la lista cerrada de la campanita. Va ANTES del
// binario nuevo: con «Redactar con IA» o el resumen encendidos y sin esto, la
// revisión de la mañana y el resumen fallan (y solo ellos: nunca tocan
// pedidos, cobros ni impresión).
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-164:
//   - Necesita la 160 (avisos_panel) y la 164 (las tablas del asistente): si
//     faltan, se detiene.
//   - "Ya aplicada" solo si están la columna, las tablas, las reglas y los
//     índices, y la lista de la campanita trae los 8 tipos.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia cualquier negocio, usuario, configuración, aviso de la
//     campanita o corrida, o si la primera vez las tablas quedan con filas.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const C = 'asistente_restaurante_corridas';
const R = 'asistente_restaurante_resumenes';
const G = 'asistente_restaurante_gasto_ia';
const TABLAS = [R, G];
const TZ = 'timestamp with time zone';
// [tabla, columna, tipo de information_schema, ¿acepta NULL?]
const COLUMNAS = [
  [C, 'ia', 'text', 'YES'],
  [R, 'id', 'bigint', 'NO'], [R, 'negocio_id', 'uuid', 'NO'], [R, 'tipo', 'text', 'NO'], [R, 'fecha', 'date', 'NO'],
  [R, 'estado', 'text', 'NO'], [R, 'con_ia', 'boolean', 'NO'], [R, 'variables', 'jsonb', 'NO'], [R, 'destino', 'text', 'YES'],
  [R, 'wamid', 'text', 'YES'], [R, 'error_codigo', 'integer', 'YES'], [R, 'error', 'text', 'YES'],
  [R, 'creado_en', TZ, 'NO'], [R, 'enviado_en', TZ, 'YES'],
  [G, 'id', 'bigint', 'NO'], [G, 'negocio_id', 'uuid', 'NO'], [G, 'proposito', 'text', 'NO'], [G, 'modelo', 'text', 'NO'],
  [G, 'tokens_entrada', 'integer', 'NO'], [G, 'tokens_salida', 'integer', 'NO'], [G, 'tokens_cache', 'integer', 'NO'],
  [G, 'costo_usd', 'numeric', 'NO'], [G, 'resultado', 'text', 'NO'], [G, 'creado_en', TZ, 'NO'],
];
const TIPOS_CAMPANITA = ['cliente_esperando', 'revision_humana', 'bot_retomo', 'fallas_bot', 'negativa_falsa',
  'pago_sin_proveedor', 'asistente_resumen_fallo', 'asistente_tope_ia'];
// [tabla, regla, tipo (c=check, f=llave foránea, u=única, p=primaria), fragmentos que su definición debe contener]
const REGLAS = [
  [C, `${C}_ia`, 'c', ["'ok'", "'parcial'", "'invalida'", "'error'", "'tope'", "'sin_clave'", "'sin_avisos'"]],
  [R, `${R}_tipo`, 'c', ["'diario'", "'semanal'", "'prueba'"]],
  [R, `${R}_estado`, 'c', ["'preparando'", "'enviando'", "'enviado'", "'fallo'", "'incierto'", "'omitido'"]],
  [R, `${R}_variables`, 'c', ['jsonb_typeof(variables)', "'array'"]],
  [R, `${R}_destino`, 'c', ['destino IS NULL', "'^[0-9]{4}$'"]],
  [R, `${R}_negocio_id_id_key`, 'u', ['(negocio_id, id)']],
  [R, `${R}_negocio_id_fkey`, 'f', ['REFERENCES negocios(id)', 'ON DELETE CASCADE']],
  [G, `${G}_proposito`, 'c', ["'avisos'", "'resumen_diario'", "'resumen_semanal'"]],
  [G, `${G}_resultado`, 'c', ["'ok'", "'invalida'", "'error'", "'rechazo'"]],
  [G, `${G}_costo`, 'c', ['costo_usd >=', 'tokens_entrada >=', 'tokens_salida >=', 'tokens_cache >=']],
  [G, `${G}_negocio_id_fkey`, 'f', ['REFERENCES negocios(id)', 'ON DELETE CASCADE']],
  ['avisos_panel', 'avisos_panel_tipo', 'c', TIPOS_CAMPANITA.map((t) => `'${t}'`)],
];
// [tabla, índice, fragmentos que su definición debe contener]
const INDICES = [
  [R, `${R}_uno_al_dia`, ['UNIQUE', '(negocio_id, tipo, fecha)', "'diario'", "'semanal'"]],
  [R, `${R}_recientes`, ['(negocio_id, creado_en DESC)']],
  [G, `${G}_mes`, ['(negocio_id, creado_en)']],
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

// La huella de lo que ya había: la 165 solo agrega; si algo de esto cambia,
// tocó lo que no debía.
const HUELLA = `SELECT (SELECT COUNT(*) FROM negocios)::int AS negocios,
                       (SELECT COUNT(*) FROM usuarios)::int AS usuarios,
                       (SELECT COUNT(*) FROM configuracion)::int AS configuracion,
                       (SELECT COUNT(*) FROM avisos_panel)::int AS avisos,
                       (SELECT COUNT(*) FROM ${C})::int AS corridas,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, slug, activo), ',' ORDER BY id)), '')
                          FROM negocios) AS negocios_md5,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', negocio_id, clave, valor), ',' ORDER BY negocio_id, clave)), '')
                          FROM configuracion) AS configuracion_md5,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, negocio_id, fecha, modo, estado, candidatos, elegidos), ',' ORDER BY id)), '')
                          FROM ${C}) AS corridas_md5`;

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-165-asistente-ia-resumen',0))");
  const { rows: [base] } = await db.query(
    `SELECT to_regclass('public.negocios') IS NOT NULL AS negocios,
            to_regclass('public.usuarios') IS NOT NULL AS usuarios,
            to_regclass('public.configuracion') IS NOT NULL AS configuracion,
            to_regclass('public.avisos_panel') IS NOT NULL AS avisos,
            to_regclass('public.${C}') IS NOT NULL AS corridas`);
  if (!base.negocios || !base.usuarios || !base.configuracion || !base.avisos || !base.corridas) {
    throw Error('La 165 necesita la 160 (avisos_panel) y la 164 (asistente_restaurante_corridas). Revisa por qué no están.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-165] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-165] Aplicando migrations/165_asistente_ia_resumen.sql (faltaba: ${antes.join('; ')})...`);
    const nuevas = TABLAS.filter((t) => antes.includes(`tabla ${t}`));
    const { rows: [huellaAntes] } = await db.query(HUELLA);
    await db.query(await readFile(new URL('../migrations/165_asistente_ia_resumen.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 165 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    const { rows: [huellaDespues] } = await db.query(HUELLA);
    if (JSON.stringify(huellaAntes) !== JSON.stringify(huellaDespues)) {
      throw Error(`La 165 cambió negocios, usuarios, configuración, avisos o corridas existentes (${JSON.stringify(huellaAntes)} → ${JSON.stringify(huellaDespues)}): se revierte`);
    }
    for (const t of nuevas) {
      const { rows: [r] } = await db.query(`SELECT COUNT(*)::int AS filas FROM ${t}`);
      if (r.filas) throw Error(`La 165 dejó ${r.filas} fila(s) en ${t}, que debe nacer vacía. Se revierte.`);
    }
    await db.query('COMMIT');
    console.log(nuevas.length === TABLAS.length
      ? `[predeploy-165] Aplicada: 2 tablas del asistente vacías, la columna ia en las corridas y 8 tipos en la campanita; ${huellaDespues.negocios} negocio(s), sus avisos y sus corridas sin cambios.`
      : `[predeploy-165] Reparada (faltaba: ${antes.join('; ')}).`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-165] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
