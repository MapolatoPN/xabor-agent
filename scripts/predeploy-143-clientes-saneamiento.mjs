// 143: saneamiento de Clientes, fase 1 (teléfonos del negocio, internos,
// bitácora, campañas por tandas y bajas guardadas en el cliente). Va ANTES del
// binario nuevo: la Lista, Campañas y la cola leen las columnas nuevas.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-142:
//   - Necesita clientes_negocio y cliente_consentimientos (080), whatsapp_entradas
//     (078) y campanas/campana_envios con la 142: si falta algo, se detiene.
//   - "Ya aplicada" solo si están todas las tablas, columnas con su tipo,
//     reglas e índices.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia cualquier cliente, campaña o envío existente, o si la
//     primera vez queda algún cliente marcado como interno o alguna campaña
//     con tope, umbral o pausa.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const TABLAS = ['negocio_telefonos_propios', 'clientes_bitacora', 'campanas_wa_cursor'];
// [tabla, columna, tipo de information_schema, ¿acepta NULL?]
const COLUMNAS = [
  ['negocio_telefonos_propios', 'negocio_id', 'uuid', 'NO'],
  ['negocio_telefonos_propios', 'telefono', 'text', 'NO'],
  ['negocio_telefonos_propios', 'etiqueta', 'text', 'YES'],
  ['negocio_telefonos_propios', 'origen', 'text', 'NO'],
  ['negocio_telefonos_propios', 'activo', 'boolean', 'NO'],
  ['negocio_telefonos_propios', 'creado_por', 'text', 'YES'],
  ['negocio_telefonos_propios', 'updated_at', 'timestamp with time zone', 'NO'],
  ['clientes_negocio', 'es_interno', 'boolean', 'NO'],
  ['clientes_negocio', 'interno_motivo', 'text', 'YES'],
  ['clientes_negocio', 'interno_at', 'timestamp with time zone', 'YES'],
  ['clientes_negocio', 'interno_por', 'text', 'YES'],
  ['clientes_bitacora', 'negocio_id', 'uuid', 'NO'],
  ['clientes_bitacora', 'entidad', 'text', 'NO'],
  ['clientes_bitacora', 'entidad_id', 'text', 'NO'],
  ['clientes_bitacora', 'accion', 'text', 'NO'],
  ['clientes_bitacora', 'antes', 'jsonb', 'YES'],
  ['clientes_bitacora', 'despues', 'jsonb', 'YES'],
  ['clientes_bitacora', 'ejecutor', 'text', 'YES'],
  ['campanas', 'tope_24h', 'integer', 'YES'],
  ['campanas', 'umbral_rechazo_pct', 'integer', 'YES'],
  ['campanas', 'pausada_at', 'timestamp with time zone', 'YES'],
  ['campanas', 'pausada_motivo', 'text', 'YES'],
  ['campanas', 'reanudada_at', 'timestamp with time zone', 'YES'],
  ['campana_envios', 'cliente_id', 'uuid', 'YES'],
  ['campana_envios', 'baja_at', 'timestamp with time zone', 'YES'],
  ['campanas_wa_cursor', 'nombre', 'text', 'NO'],
  ['campanas_wa_cursor', 'ultimo_id', 'bigint', 'NO'],
];
// [tabla, regla, tipo (c=check, u=unique), fragmentos que su definición debe contener]
const REGLAS = [
  ['negocio_telefonos_propios', 'negocio_telefonos_propios_unico', 'u', ['(negocio_id, telefono)']],
  ['negocio_telefonos_propios', 'negocio_telefonos_propios_telefono_10', 'c', ['telefono', '[0-9]{10}']],
  ['negocio_telefonos_propios', 'negocio_telefonos_propios_origen', 'c', ["'whatsapp'", "'manual'"]],
  ['clientes_bitacora', 'clientes_bitacora_entidad', 'c', ["'cliente'", "'telefono_negocio'"]],
  ['campanas', 'campanas_tope_24h_check', 'c', ['tope_24h', '1', '100000']],
  ['campanas', 'campanas_umbral_rechazo_check', 'c', ['umbral_rechazo_pct', '1', '100']],
];
// [tabla, índice, fragmentos que su definición debe contener]
const INDICES = [
  ['clientes_bitacora', 'clientes_bitacora_por_entidad', ['(negocio_id, entidad, entidad_id, created_at DESC)']],
  ['campana_envios', 'campana_envios_baja_pendiente', ['(campana_id)', '131050', 'baja_at IS NULL']],
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

// La huella de lo que ya había: si algo de esto cambia, la 143 tocó lo que no debía.
const HUELLA = `SELECT (SELECT COUNT(*) FROM clientes_negocio)::int AS clientes,
                       (SELECT COUNT(*) FROM campanas)::int AS campanas,
                       (SELECT COUNT(*) FROM campana_envios)::int AS envios,
                       (SELECT COUNT(*) FROM cliente_consentimientos)::int AS consentimientos,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, negocio_id, telefono, telefono_original, nombre, email,
                                 origen, ultima_compra_at, created_at, updated_at), ',' ORDER BY id)), '')
                          FROM clientes_negocio) AS clientes_md5,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, negocio_id, nombre, segmento, mensaje, total_destinatarios,
                                 enviados, fallidos, respondidos, estado, creada_at, completada_at, tipo, plantilla::text,
                                 creada_por, detenida_at, detenida_motivo, reanudar_at), ',' ORDER BY id)), '')
                          FROM campanas) AS campanas_md5,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, campana_id, telefono, nombre, estado, enviado_at,
                                 respondio_at, cola_at, telefono_envio, intento_at, wamid, error_codigo, entregado_at, leido_at,
                                 no_entregado_at), ',' ORDER BY id)), '')
                          FROM campana_envios) AS envios_md5`;

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-143-clientes-saneamiento',0))");
  const { rows: [base] } = await db.query(
    `SELECT to_regclass('public.negocios') IS NOT NULL AS negocios,
            to_regclass('public.clientes_negocio') IS NOT NULL AS clientes,
            to_regclass('public.cliente_consentimientos') IS NOT NULL AS consentimientos,
            to_regclass('public.whatsapp_entradas') IS NOT NULL AS entradas,
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'campana_envios' AND column_name = 'error_codigo') AS con_142`);
  if (!base.negocios || !base.clientes || !base.consentimientos || !base.entradas || !base.con_142) {
    throw Error('La 143 necesita clientes_negocio y cliente_consentimientos (080), whatsapp_entradas (078) y la 142. Revisa por qué no están.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-143] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-143] Aplicando migrations/143_clientes_saneamiento.sql (faltaba: ${antes.join('; ')})...`);
    // El binario anterior sigue dando de alta clientes y mandando campañas
    // mientras corre esto: con las tablas tomadas, nada cae entre la huella y el ALTER.
    await db.query('LOCK TABLE clientes_negocio, campanas, campana_envios IN ACCESS EXCLUSIVE MODE');
    const primeraVez = antes.includes('columna clientes_negocio.es_interno');
    const { rows: [huellaAntes] } = await db.query(HUELLA);
    await db.query(await readFile(new URL('../migrations/143_clientes_saneamiento.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 143 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    await db.query('SELECT telefono, origen, activo FROM negocio_telefonos_propios LIMIT 0');
    await db.query('SELECT es_interno, interno_motivo FROM clientes_negocio LIMIT 0');
    await db.query('SELECT tope_24h, umbral_rechazo_pct, pausada_at, reanudada_at FROM campanas LIMIT 0');
    await db.query('SELECT cliente_id, baja_at FROM campana_envios LIMIT 0');
    const { rows: [huellaDespues] } = await db.query(HUELLA);
    if (JSON.stringify(huellaAntes) !== JSON.stringify(huellaDespues)) {
      throw Error(`La 143 cambió clientes, campañas o envíos existentes (${JSON.stringify(huellaAntes)} → ${JSON.stringify(huellaDespues)}): se revierte`);
    }
    if (primeraVez) {
      const { rows: [r] } = await db.query(
        `SELECT (SELECT COUNT(*) FROM clientes_negocio WHERE es_interno)::int AS internos,
                (SELECT COUNT(*) FROM campanas WHERE tope_24h IS NOT NULL OR umbral_rechazo_pct IS NOT NULL OR pausada_at IS NOT NULL)::int AS campanas,
                (SELECT COUNT(*) FROM campana_envios WHERE cliente_id IS NOT NULL OR baja_at IS NOT NULL)::int AS envios`);
      if (r.internos || r.campanas || r.envios) {
        throw Error(`La 143 dejó valores en filas existentes (${JSON.stringify(r)}): todas deben nacer vacías. Se revierte.`);
      }
    }
    await db.query('COMMIT');
    console.log(primeraVez
      ? `[predeploy-143] Aplicada: ${huellaDespues.clientes} cliente(s) sin marcar como internos; ${huellaDespues.campanas} campaña(s) y ${huellaDespues.envios} envío(s) sin cambios.`
      : `[predeploy-143] Reparada (faltaba: ${antes.join('; ')}); ${huellaDespues.clientes} cliente(s) sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-143] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
