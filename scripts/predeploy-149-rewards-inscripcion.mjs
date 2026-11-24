// 149: saneamiento de Clientes, fase 3 (Rewards solo para inscritos): la
// inscripción explícita en rewards_accounts, el inicio del vencimiento en
// rewards_config y la bitácora de ajustes. Va ANTES del binario nuevo: la
// acumulación, la caja, la tienda y las cifras leen lo nuevo.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-146:
//   - Necesita rewards_accounts, rewards_config y rewards_movements: si falta
//     algo, se detiene.
//   - "Ya aplicada" solo si están la tabla, las columnas con su tipo, las
//     reglas y los índices.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia cualquier cuenta, movimiento o configuración existente
//     (saldos, teléfonos, estado), o si la primera vez queda alguna cuenta
//     inscrita, algún vencimiento encendido o alguna fila en la bitácora.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const TABLAS = ['rewards_bitacora'];
// [tabla, columna, tipo de information_schema, ¿acepta NULL?]
const COLUMNAS = [
  ['rewards_accounts', 'inscrito_at', 'timestamp with time zone', 'YES'],
  ['rewards_accounts', 'inscripcion_origen', 'text', 'YES'],
  ['rewards_accounts', 'inscrito_por', 'text', 'YES'],
  ['rewards_config', 'vigencia_desde', 'timestamp with time zone', 'YES'],
  ['rewards_bitacora', 'tenant_id', 'text', 'NO'],
  ['rewards_bitacora', 'account_id', 'integer', 'YES'],
  ['rewards_bitacora', 'accion', 'text', 'NO'],
  ['rewards_bitacora', 'lote', 'uuid', 'YES'],
  ['rewards_bitacora', 'antes', 'jsonb', 'YES'],
  ['rewards_bitacora', 'despues', 'jsonb', 'YES'],
  ['rewards_bitacora', 'motivo', 'text', 'YES'],
  ['rewards_bitacora', 'usuario', 'text', 'YES'],
  ['rewards_bitacora', 'revertido_at', 'timestamp with time zone', 'YES'],
  ['rewards_bitacora', 'revertido_por', 'text', 'YES'],
  ['rewards_bitacora', 'created_at', 'timestamp with time zone', 'NO'],
];
// [tabla, regla, tipo (c=check), fragmentos que su definición debe contener]
const REGLAS = [
  ['rewards_accounts', 'rewards_accounts_inscripcion_origen', 'c', ["'caja'", "'tienda'", "'whatsapp'", "'admin'"]],
  ['rewards_accounts', 'rewards_accounts_inscripcion_completa', 'c', ['inscrito_at IS NULL', 'inscripcion_origen IS NULL']],
  ['rewards_bitacora', 'rewards_bitacora_accion', 'c', ["'inscripcion'", "'anulacion'", "'normalizacion'", "'fusion'"]],
];
// [tabla, índice, fragmentos que su definición debe contener]
const INDICES = [
  ['rewards_bitacora', 'rewards_bitacora_tenant', ['(tenant_id, created_at DESC)']],
  ['rewards_bitacora', 'rewards_bitacora_lote', ['(lote)', 'lote IS NOT NULL']],
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

// La huella de lo que ya había: si algo de esto cambia, la 149 tocó lo que no
// debía. Saldos, teléfonos, nombres y estado de cada cuenta; cada movimiento;
// la configuración de cada negocio.
const HUELLA = `SELECT (SELECT COUNT(*) FROM rewards_accounts)::int AS cuentas,
                       (SELECT COALESCE(SUM(puntos_balance), 0) FROM rewards_accounts)::int AS saldo,
                       (SELECT COUNT(*) FROM rewards_movements)::int AS movimientos,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, telefono, tenant_id, puntos_balance,
                                 puntos_acumulados_total, puntos_canjeados_total, activo, nombre, cliente_id,
                                 created_at, updated_at), ',' ORDER BY id)), '')
                          FROM rewards_accounts) AS cuentas_md5,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, account_id, tenant_id, tipo, puntos,
                                 balance_anterior, balance_posterior, folio_venta, created_at), ',' ORDER BY id)), '')
                          FROM rewards_movements) AS movimientos_md5,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, tenant_id, activo, monto_por_punto,
                                 puntos_por_peso, canje_minimo, vigencia_dias, updated_at), ',' ORDER BY id)), '')
                          FROM rewards_config) AS config_md5`;

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-149-rewards-inscripcion',0))");
  const { rows: [base] } = await db.query(
    `SELECT to_regclass('public.rewards_accounts') IS NOT NULL AS cuentas,
            to_regclass('public.rewards_config') IS NOT NULL AS config,
            to_regclass('public.rewards_movements') IS NOT NULL AS movimientos`);
  if (!base.cuentas || !base.config || !base.movimientos) {
    throw Error('La 149 necesita rewards_accounts, rewards_config y rewards_movements. Revisa por qué no están.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-149] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-149] Aplicando migrations/149_rewards_inscripcion.sql (faltaba: ${antes.join('; ')})...`);
    // El binario anterior sigue acumulando (y creando cuentas) mientras corre
    // esto: con las tablas tomadas, nada cae entre la huella y el ALTER.
    await db.query('LOCK TABLE rewards_accounts, rewards_movements, rewards_config IN ACCESS EXCLUSIVE MODE');
    const primeraVez = antes.includes('tabla rewards_bitacora');
    const { rows: [huellaAntes] } = await db.query(HUELLA);
    await db.query(await readFile(new URL('../migrations/149_rewards_inscripcion.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 149 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    await db.query('SELECT inscrito_at, inscripcion_origen, inscrito_por FROM rewards_accounts LIMIT 0');
    await db.query('SELECT vigencia_desde FROM rewards_config LIMIT 0');
    await db.query('SELECT tenant_id, account_id, accion, lote, antes, despues FROM rewards_bitacora LIMIT 0');
    const { rows: [huellaDespues] } = await db.query(HUELLA);
    if (JSON.stringify(huellaAntes) !== JSON.stringify(huellaDespues)) {
      throw Error(`La 149 cambió cuentas, movimientos o configuración existentes (${JSON.stringify(huellaAntes)} → ${JSON.stringify(huellaDespues)}): se revierte`);
    }
    if (primeraVez) {
      const { rows: [r] } = await db.query(
        `SELECT (SELECT COUNT(*) FROM rewards_accounts WHERE inscrito_at IS NOT NULL OR inscripcion_origen IS NOT NULL OR inscrito_por IS NOT NULL)::int AS inscritas,
                (SELECT COUNT(*) FROM rewards_config WHERE vigencia_desde IS NOT NULL)::int AS vencimientos,
                (SELECT COUNT(*) FROM rewards_bitacora)::int AS bitacora`);
      if (r.inscritas || r.vencimientos || r.bitacora) {
        throw Error(`La 149 dejó valores que deben nacer vacíos (${JSON.stringify(r)}). Se revierte.`);
      }
    }
    await db.query('COMMIT');
    console.log(primeraVez
      ? `[predeploy-149] Aplicada: ${huellaDespues.cuentas} cuenta(s) de Rewards sin cambios (${huellaDespues.saldo} pts), todas «sin inscribir»; ${huellaDespues.movimientos} movimiento(s) intactos.`
      : `[predeploy-149] Reparada (faltaba: ${antes.join('; ')}); ${huellaDespues.cuentas} cuenta(s) sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-149] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
