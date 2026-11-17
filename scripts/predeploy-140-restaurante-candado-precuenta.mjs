// 140: precuentas registradas, bitácora de la cuenta de mesa y autorizaciones
// de supervisor dadas a distancia.
// Va ANTES del binario nuevo: imprimir una precuenta escribe en
// restaurante_precuentas, y mover de mesa en restaurante_cuenta_bitacora.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-139:
//   - Necesita la 039 (cuentas de mesa): si no está, se detiene.
//   - "Ya aplicada" solo si están TODAS sus garantías: columnas, reglas,
//     llaves e índices de las tres tablas nuevas.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia el número o el importe de cuentas, platillos, pagos o
//     ventas de mesa: la 140 no toca nada de lo que ya existe.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const COLUMNAS = {
  restaurante_precuentas: ['id', 'negocio_id', 'cuenta_id', 'numero', 'tipo', 'solicitud_id', 'subtotal', 'descuento',
    'total', 'pagado', 'firma', 'solicitada_por', 'created_at'],
  restaurante_cuenta_bitacora: ['id', 'negocio_id', 'cuenta_id', 'tipo', 'detalle', 'solicitado_por', 'autorizado_por',
    'sesion_usuario_id', 'created_at'],
  restaurante_autorizaciones_remotas: ['id', 'negocio_id', 'cuenta_id', 'accion', 'detalle', 'huella', 'estado',
    'solicitada_por', 'resuelta_por', 'resuelta_at', 'usada_at', 'expira_at', 'created_at'],
};

// [tabla, restricción, tipo, fragmentos que su definición debe contener]
const RESTRICCIONES = [
  ['restaurante_precuentas', 'restaurante_precuentas_pkey', 'p', ['PRIMARY KEY (id)']],
  ['restaurante_precuentas', 'restaurante_precuentas_negocio_id_fkey', 'f', ['REFERENCES negocios(id)', 'ON DELETE CASCADE']],
  ['restaurante_precuentas', 'restaurante_precuentas_cuenta_id_fkey', 'f', ['REFERENCES restaurante_cuentas(id)', 'ON DELETE CASCADE']],
  ['restaurante_precuentas', 'restaurante_precuentas_solicitada_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE SET NULL']],
  ['restaurante_precuentas', 'restaurante_precuentas_numero_check', 'c', ['numero >= 1', 'numero <= 10000']],
  ['restaurante_precuentas', 'restaurante_precuentas_tipo_check', 'c', ["'completa'", "'division'"]],
  ['restaurante_precuentas', 'restaurante_precuentas_solicitud_id_check', 'c', ['char_length(solicitud_id)', '120']],
  ['restaurante_precuentas', 'restaurante_precuentas_firma_check', 'c', ['char_length(firma)', '128']],
  ['restaurante_precuentas', 'uq_restaurante_precuentas_numero', 'u', ['UNIQUE (cuenta_id, numero)']],
  ['restaurante_precuentas', 'uq_restaurante_precuentas_solicitud', 'u', ['UNIQUE (cuenta_id, solicitud_id)']],
  ['restaurante_cuenta_bitacora', 'restaurante_cuenta_bitacora_pkey', 'p', ['PRIMARY KEY (id)']],
  ['restaurante_cuenta_bitacora', 'restaurante_cuenta_bitacora_negocio_id_fkey', 'f', ['REFERENCES negocios(id)', 'ON DELETE CASCADE']],
  ['restaurante_cuenta_bitacora', 'restaurante_cuenta_bitacora_cuenta_id_fkey', 'f', ['REFERENCES restaurante_cuentas(id)', 'ON DELETE CASCADE']],
  ['restaurante_cuenta_bitacora', 'restaurante_cuenta_bitacora_solicitado_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE SET NULL']],
  ['restaurante_cuenta_bitacora', 'restaurante_cuenta_bitacora_autorizado_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE SET NULL']],
  ['restaurante_cuenta_bitacora', 'restaurante_cuenta_bitacora_sesion_usuario_id_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE SET NULL']],
  ['restaurante_cuenta_bitacora', 'restaurante_cuenta_bitacora_tipo_check', 'c', ["'mesa_movida'", "'autorizacion_supervisor'", "'cobro_identificado'"]],
  ['restaurante_cuenta_bitacora', 'restaurante_cuenta_bitacora_detalle_check', 'c', ['jsonb_typeof(detalle)', '4096']],
  ['restaurante_autorizaciones_remotas', 'restaurante_autorizaciones_remotas_pkey', 'p', ['PRIMARY KEY (id)']],
  ['restaurante_autorizaciones_remotas', 'restaurante_autorizaciones_remotas_negocio_id_fkey', 'f', ['REFERENCES negocios(id)', 'ON DELETE CASCADE']],
  ['restaurante_autorizaciones_remotas', 'restaurante_autorizaciones_remotas_cuenta_id_fkey', 'f', ['REFERENCES restaurante_cuentas(id)', 'ON DELETE CASCADE']],
  ['restaurante_autorizaciones_remotas', 'restaurante_autorizaciones_remotas_solicitada_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE SET NULL']],
  ['restaurante_autorizaciones_remotas', 'restaurante_autorizaciones_remotas_resuelta_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE SET NULL']],
  ['restaurante_autorizaciones_remotas', 'restaurante_autorizaciones_remotas_accion_check', 'c',
    ["'quitar_platillo'", "'reducir_cantidad'", "'cancelar_platillo'", "'descuento'", "'cerrar_vencida'"]],
  ['restaurante_autorizaciones_remotas', 'restaurante_autorizaciones_remotas_detalle_check', 'c', ['jsonb_typeof(detalle)', '4096']],
  ['restaurante_autorizaciones_remotas', 'restaurante_autorizaciones_remotas_huella_check', 'c', ['char_length(huella)', '128']],
  ['restaurante_autorizaciones_remotas', 'restaurante_autorizaciones_remotas_estado_check', 'c', ["'pendiente'", "'autorizada'", "'rechazada'", "'usada'"]],
  ['restaurante_autorizaciones_remotas', 'restaurante_autorizaciones_remotas_resuelta_check', 'c', ["'pendiente'", 'resuelta_at IS NOT NULL']],
  ['restaurante_autorizaciones_remotas', 'restaurante_autorizaciones_remotas_usada_check', 'c', ["'usada'", 'usada_at IS NOT NULL']],
];

const INDICES = [
  ['restaurante_precuentas', 'idx_restaurante_precuentas_dia', '(negocio_id, created_at)'],
  ['restaurante_cuenta_bitacora', 'idx_restaurante_cuenta_bitacora_cuenta', '(cuenta_id, created_at)'],
  ['restaurante_cuenta_bitacora', 'idx_restaurante_cuenta_bitacora_dia', '(negocio_id, created_at)'],
  ['restaurante_autorizaciones_remotas', 'idx_restaurante_autorizaciones_remotas_pendientes', '(negocio_id, estado, expira_at)'],
  ['restaurante_autorizaciones_remotas', 'idx_restaurante_autorizaciones_remotas_cuenta', '(cuenta_id, created_at)'],
];

async function estado() {
  const faltan = [];
  for (const [tabla, columnas] of Object.entries(COLUMNAS)) {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [tabla]);
    if (!rows.length) { faltan.push(`tabla ${tabla}`); continue; }
    const hay = new Set(rows.map((r) => r.column_name));
    for (const c of columnas) if (!hay.has(c)) faltan.push(`columna ${tabla}.${c}`);
  }
  for (const [tabla, nombre, tipo, fragmentos] of RESTRICCIONES) {
    const { rows: [r] } = await db.query(
      `SELECT c.contype, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = $1 AND c.conname = $2`, [tabla, nombre]);
    if (!r || r.contype !== tipo || !fragmentos.every((f) => r.def.includes(f))) faltan.push(`restricción ${nombre}`);
  }
  for (const [tabla, nombre, columnas] of INDICES) {
    const { rows: [i] } = await db.query(
      `SELECT ix.indisvalid, pg_get_indexdef(ix.indexrelid) AS def
         FROM pg_index ix JOIN pg_class ic ON ic.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = ic.relnamespace
        WHERE n.nspname = 'public' AND t.relname = $1 AND ic.relname = $2`, [tabla, nombre]);
    if (!i || !i.indisvalid || !i.def.includes(columnas)) faltan.push(`índice ${nombre}`);
  }
  return faltan;
}

// La huella de lo que ya había: si algo de esto cambia, la 140 tocó lo que no debía.
const HUELLA = `SELECT (SELECT COUNT(*) FROM restaurante_cuentas)::int AS cuentas,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, estado, mesa_numero, venta_folio, descuento_monto), ',' ORDER BY id)), '')
                          FROM restaurante_cuentas) AS cuentas_md5,
                       (SELECT COUNT(*) FROM restaurante_cuenta_items)::int AS items,
                       (SELECT COALESCE(SUM(cantidad * precio_unitario), 0)::text FROM restaurante_cuenta_items) AS items_importe,
                       (SELECT COUNT(*) FROM restaurante_cuenta_pagos)::int AS pagos,
                       (SELECT COALESCE(SUM(monto), 0)::text FROM restaurante_cuenta_pagos) AS pagos_importe,
                       (SELECT COUNT(*) FROM pedidos_activos WHERE folio LIKE 'RM-%')::int AS ventas_mesa`;

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-140-restaurante-candado-precuenta',0))");
  const { rows: [base] } = await db.query(`SELECT to_regclass('public.restaurante_cuentas') IS NOT NULL AS cuentas`);
  if (!base.cuentas) throw Error('La 140 necesita la 039 (cuentas de mesa). El runner la aplica antes; revisa por qué no está.');
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-140] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-140] Aplicando migrations/140_restaurante_candado_precuenta.sql (faltaba: ${antes.join('; ')})...`);
    const { rows: [huellaAntes] } = await db.query(HUELLA);
    await db.query(await readFile(new URL('../migrations/140_restaurante_candado_precuenta.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 140 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    for (const [tabla, columnas] of Object.entries(COLUMNAS)) await db.query(`SELECT ${columnas.join(', ')} FROM ${tabla} LIMIT 0`);
    const { rows: [huellaDespues] } = await db.query(HUELLA);
    if (JSON.stringify(huellaAntes) !== JSON.stringify(huellaDespues)) {
      throw Error(`La 140 cambió cuentas, pagos o ventas existentes (${JSON.stringify(huellaAntes)} → ${JSON.stringify(huellaDespues)}): se revierte`);
    }
    await db.query('COMMIT');
    console.log(`[predeploy-140] Aplicada: ${huellaDespues.cuentas} cuenta(s), ${huellaDespues.pagos} pago(s) y ${huellaDespues.ventas_mesa} venta(s) de mesa sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-140] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
