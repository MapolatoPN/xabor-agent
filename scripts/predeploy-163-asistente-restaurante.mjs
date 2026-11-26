// 163: asistente del restaurante, Fase 1 (avisos de la campanita). Cuatro
// tablas nuevas y vacías que el binario nuevo usa solo en la sucursal con la
// bandera asistente_restaurante_v1 encendida. Va ANTES del binario nuevo: con
// la bandera encendida y sin las tablas, la revisión de la mañana falla (y solo
// ella: nunca toca pedidos, cobros ni impresión).
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-160:
//   - Necesita negocios, usuarios y configuracion: si faltan, se detiene.
//   - "Ya aplicada" solo si están las tablas, las columnas con su tipo, las
//     reglas y los índices.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia cualquier negocio, usuario o configuración, o si la
//     primera vez las tablas quedan con filas.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const C = 'asistente_restaurante_corridas';
const H = 'asistente_restaurante_hallazgos';
const O = 'asistente_restaurante_opiniones';
const S = 'asistente_restaurante_silenciados';
const TABLAS = [C, H, O, S];
const TZ = 'timestamp with time zone';
// [tabla, columna, tipo de information_schema, ¿acepta NULL?]
const COLUMNAS = [
  [C, 'id', 'bigint', 'NO'], [C, 'negocio_id', 'uuid', 'NO'], [C, 'fecha', 'date', 'NO'], [C, 'modo', 'text', 'NO'],
  [C, 'estado', 'text', 'NO'], [C, 'candidatos', 'integer', 'NO'], [C, 'elegidos', 'integer', 'NO'], [C, 'error', 'text', 'YES'],
  [C, 'iniciada_en', TZ, 'NO'], [C, 'terminada_en', TZ, 'YES'],
  [H, 'id', 'bigint', 'NO'], [H, 'negocio_id', 'uuid', 'NO'], [H, 'corrida_id', 'bigint', 'NO'], [H, 'tipo', 'text', 'NO'],
  [H, 'firma', 'text', 'NO'], [H, 'impacto', 'numeric', 'NO'], [H, 'titulo', 'text', 'NO'], [H, 'contenido', 'jsonb', 'NO'],
  [H, 'elegido', 'boolean', 'NO'], [H, 'motivo', 'text', 'YES'], [H, 'mostrado', 'boolean', 'NO'], [H, 'creado_en', TZ, 'NO'],
  [H, 'visto_en', TZ, 'YES'], [H, 'visto_por', 'uuid', 'YES'],
  [O, 'id', 'bigint', 'NO'], [O, 'negocio_id', 'uuid', 'NO'], [O, 'hallazgo_id', 'bigint', 'NO'], [O, 'usuario_id', 'uuid', 'NO'],
  [O, 'opinion', 'text', 'NO'], [O, 'tipo', 'text', 'NO'], [O, 'firma', 'text', 'NO'], [O, 'creado_en', TZ, 'NO'], [O, 'actualizado_en', TZ, 'NO'],
  [S, 'negocio_id', 'uuid', 'NO'], [S, 'firma', 'text', 'NO'], [S, 'usuario_id', 'uuid', 'YES'], [S, 'creado_en', TZ, 'NO'],
];
// [tabla, regla, tipo (c=check, f=llave foránea, u=única, p=primaria), fragmentos que su definición debe contener]
const REGLAS = [
  [C, `${C}_modo`, 'c', ["'ensayo'", "'visible'"]],
  [C, `${C}_estado`, 'c', ["'corriendo'", "'lista'", "'fallo'"]],
  [C, `${C}_negocio_id_fecha_key`, 'u', ['(negocio_id, fecha)']],
  [C, `${C}_negocio_id_id_key`, 'u', ['(negocio_id, id)']],
  [C, `${C}_negocio_id_fkey`, 'f', ['REFERENCES negocios(id)', 'ON DELETE CASCADE']],
  [H, `${H}_tipo`, 'c', ["'^[a-z_]{3,40}$'"]],
  [H, `${H}_contenido`, 'c', ['jsonb_typeof(contenido)', "'object'"]],
  [H, `${H}_mostrado`, 'c', ['mostrado', 'elegido']],
  [H, `${H}_visto`, 'c', ['visto_por IS NULL', 'visto_en IS NOT NULL']],
  [H, `${H}_negocio_id_id_key`, 'u', ['(negocio_id, id)']],
  [H, `${H}_negocio_id_fkey`, 'f', ['REFERENCES negocios(id)', 'ON DELETE CASCADE']],
  [H, `${H}_negocio_id_corrida_id_fkey`, 'f', [`REFERENCES ${C}(negocio_id, id)`, 'ON DELETE CASCADE']],
  [H, `${H}_visto_por_fkey`, 'f', ['REFERENCES usuarios(id)', 'ON DELETE SET NULL']],
  [O, `${O}_opinion`, 'c', ["'util'", "'no_util'", "'no_avisar'"]],
  [O, `${O}_hallazgo_id_usuario_id_key`, 'u', ['(hallazgo_id, usuario_id)']],
  [O, `${O}_negocio_id_hallazgo_id_fkey`, 'f', [`REFERENCES ${H}(negocio_id, id)`, 'ON DELETE CASCADE']],
  [O, `${O}_usuario_id_fkey`, 'f', ['REFERENCES usuarios(id)', 'ON DELETE CASCADE']],
  [S, `${S}_pkey`, 'p', ['(negocio_id, firma)']],
  [S, `${S}_negocio_id_fkey`, 'f', ['REFERENCES negocios(id)', 'ON DELETE CASCADE']],
];
// [tabla, índice, fragmentos que su definición debe contener]
const INDICES = [
  [H, `${H}_mostrados`, ['(negocio_id, creado_en DESC, id DESC)', 'WHERE mostrado']],
  [H, `${H}_firma`, ['(negocio_id, firma, creado_en DESC)', 'WHERE elegido']],
  [H, `${H}_corrida`, ['(corrida_id)']],
  [O, `${O}_tipo`, ['(negocio_id, tipo, opinion)']],
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

// La huella de lo que ya había: la 163 solo crea; si algo de esto cambia,
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
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-163-asistente-restaurante',0))");
  const { rows: [base] } = await db.query(
    `SELECT to_regclass('public.negocios') IS NOT NULL AS negocios,
            to_regclass('public.usuarios') IS NOT NULL AS usuarios,
            to_regclass('public.configuracion') IS NOT NULL AS configuracion`);
  if (!base.negocios || !base.usuarios || !base.configuracion) {
    throw Error('La 163 necesita negocios, usuarios y configuracion. Revisa por qué no están.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-163] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-163] Aplicando migrations/163_asistente_restaurante.sql (faltaba: ${antes.join('; ')})...`);
    const nuevas = TABLAS.filter((t) => antes.includes(`tabla ${t}`));
    const { rows: [huellaAntes] } = await db.query(HUELLA);
    await db.query(await readFile(new URL('../migrations/163_asistente_restaurante.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 163 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    const { rows: [huellaDespues] } = await db.query(HUELLA);
    if (JSON.stringify(huellaAntes) !== JSON.stringify(huellaDespues)) {
      throw Error(`La 163 cambió negocios, usuarios o configuración existentes (${JSON.stringify(huellaAntes)} → ${JSON.stringify(huellaDespues)}): se revierte`);
    }
    for (const t of nuevas) {
      const { rows: [r] } = await db.query(`SELECT COUNT(*)::int AS filas FROM ${t}`);
      if (r.filas) throw Error(`La 163 dejó ${r.filas} fila(s) en ${t}, que debe nacer vacía. Se revierte.`);
    }
    await db.query('COMMIT');
    console.log(nuevas.length === TABLAS.length
      ? `[predeploy-163] Aplicada: 4 tablas del asistente vacías; ${huellaDespues.negocios} negocio(s) y su configuración sin cambios.`
      : `[predeploy-163] Reparada (faltaba: ${antes.join('; ')}).`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-163] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
