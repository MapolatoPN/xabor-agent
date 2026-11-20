// 142: campañas de WhatsApp con plantilla aprobada por Meta (cola + acuses).
// Va ANTES del binario nuevo: el trabajo de la cola y el panel leen las
// columnas nuevas de campanas y campana_envios.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-141:
//   - Necesita las tablas campanas y campana_envios (002): si no están, se detiene.
//   - "Ya aplicada" solo si están todas las columnas con su tipo, las dos
//     reglas y los cuatro índices.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia cualquier campaña o envío existente, o si la primera
//     vez alguna campaña queda con un tipo distinto de 'texto'.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

// [tabla, columna, tipo de information_schema, ¿acepta NULL?]
const COLUMNAS = [
  ['campanas', 'tipo', 'text', 'NO'],
  ['campanas', 'plantilla', 'jsonb', 'YES'],
  ['campanas', 'creada_por', 'text', 'YES'],
  ['campanas', 'detenida_at', 'timestamp with time zone', 'YES'],
  ['campanas', 'detenida_motivo', 'text', 'YES'],
  ['campanas', 'reanudar_at', 'timestamp with time zone', 'YES'],
  ['campana_envios', 'cola_at', 'timestamp with time zone', 'YES'],
  ['campana_envios', 'telefono_envio', 'text', 'YES'],
  ['campana_envios', 'intento_at', 'timestamp with time zone', 'YES'],
  ['campana_envios', 'wamid', 'text', 'YES'],
  ['campana_envios', 'error_codigo', 'integer', 'YES'],
  ['campana_envios', 'entregado_at', 'timestamp with time zone', 'YES'],
  ['campana_envios', 'leido_at', 'timestamp with time zone', 'YES'],
  ['campana_envios', 'no_entregado_at', 'timestamp with time zone', 'YES'],
];
// [tabla, regla, fragmentos que su definición debe contener]
const REGLAS = [
  ['campanas', 'campanas_tipo_check', ["'texto'", "'plantilla'"]],
  ['campana_envios', 'campana_envios_estado_check', ["'pendiente'", "'enviando'", "'enviado'", "'fallido'", "'incierto'", "'cancelado'"]],
];
// [tabla, índice, fragmentos que su definición debe contener]
const INDICES = [
  ['campana_envios', 'campana_envios_cola_unica', ['UNIQUE', '(campana_id, telefono_envio)', 'cola_at IS NOT NULL']],
  ['campana_envios', 'campana_envios_cola_por_mandar', ['(campana_id, id)', "'pendiente'", "'enviando'"]],
  ['campana_envios', 'campana_envios_wamid', ['(wamid)', 'wamid IS NOT NULL']],
  ['campanas', 'campanas_plantilla_enviando', ['(creada_at)', "'plantilla'", "'enviando'"]],
];

async function estado() {
  const faltan = [];
  for (const [tabla, columna, tipo, nulo] of COLUMNAS) {
    const { rows: [c] } = await db.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [tabla, columna]);
    if (!c) faltan.push(`columna ${tabla}.${columna}`);
    else if (c.data_type !== tipo || c.is_nullable !== nulo) faltan.push(`columna ${tabla}.${columna} con otro tipo`);
  }
  for (const [tabla, nombre, fragmentos] of REGLAS) {
    const { rows: [r] } = await db.query(
      `SELECT c.contype, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = $1 AND c.conname = $2`, [tabla, nombre]);
    if (!r || r.contype !== 'c' || !fragmentos.every((f) => r.def.includes(f))) faltan.push(`regla ${nombre}`);
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

// La huella de lo que ya había: si algo de esto cambia, la 142 tocó lo que no debía.
const HUELLA = `SELECT (SELECT COUNT(*) FROM campanas)::int AS campanas,
                       (SELECT COUNT(*) FROM campana_envios)::int AS envios,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, negocio_id, nombre, segmento, mensaje, total_destinatarios,
                                 enviados, fallidos, respondidos, estado, creada_at, completada_at), ',' ORDER BY id)), '')
                          FROM campanas) AS campanas_md5,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, campana_id, telefono, nombre, estado, enviado_at,
                                 respondio_at), ',' ORDER BY id)), '')
                          FROM campana_envios) AS envios_md5`;

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-142-campanas-whatsapp-plantilla',0))");
  const { rows: [base] } = await db.query(
    `SELECT to_regclass('public.campanas') IS NOT NULL AS campanas,
            to_regclass('public.campana_envios') IS NOT NULL AS envios`);
  if (!base.campanas || !base.envios) {
    throw Error('La 142 necesita las tablas campanas y campana_envios (002). Revisa por qué no están.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-142] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-142] Aplicando migrations/142_campanas_whatsapp_plantilla.sql (faltaba: ${antes.join('; ')})...`);
    // El binario anterior sigue contando respuestas a campañas mientras corre
    // esto: con las tablas tomadas, nada cae entre la huella y el ALTER.
    await db.query('LOCK TABLE campanas, campana_envios IN ACCESS EXCLUSIVE MODE');
    const primeraVez = antes.includes('columna campanas.tipo');
    const { rows: [huellaAntes] } = await db.query(HUELLA);
    await db.query(await readFile(new URL('../migrations/142_campanas_whatsapp_plantilla.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 142 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    await db.query('SELECT tipo, plantilla, reanudar_at FROM campanas LIMIT 0');
    await db.query('SELECT cola_at, telefono_envio, wamid, entregado_at FROM campana_envios LIMIT 0');
    const { rows: [huellaDespues] } = await db.query(HUELLA);
    if (JSON.stringify(huellaAntes) !== JSON.stringify(huellaDespues)) {
      throw Error(`La 142 cambió campañas o envíos existentes (${JSON.stringify(huellaAntes)} → ${JSON.stringify(huellaDespues)}): se revierte`);
    }
    if (primeraVez) {
      const { rows: [r] } = await db.query(`SELECT COUNT(*)::int AS n FROM campanas WHERE tipo <> 'texto'`);
      if (r.n) throw Error(`La 142 dejó ${r.n} campaña(s) con un tipo distinto de 'texto': todas las existentes son de texto. Se revierte.`);
    }
    await db.query('COMMIT');
    console.log(primeraVez
      ? `[predeploy-142] Aplicada: ${huellaDespues.campanas} campaña(s) existentes quedan como «texto»; ${huellaDespues.envios} envío(s) sin cambios.`
      : `[predeploy-142] Reparada (faltaba: ${antes.join('; ')}); ${huellaDespues.campanas} campaña(s) sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-142] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
