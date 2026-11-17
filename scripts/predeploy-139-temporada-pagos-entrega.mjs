// 139: pedidos de temporada — pagos, entrega, captura en el panel y bitácora.
// Va ANTES del binario nuevo: /temporada lee el estado de pago y de entrega.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-138:
//   - Necesita la 135 (las tablas de temporada): si no está, se detiene.
//   - "Ya aplicada" solo si están TODAS sus garantías: columnas nuevas, reglas,
//     las dos tablas nuevas con sus llaves e índices, y sus triggers
//     HABILITADOS (pagos que solo se anulan, bitácora de solo inserción).
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia el número de campañas o de pedidos, si algún pedido
//     cambia de estado, de platillos o de horario, o si el precio congelado
//     no quedó igual al de su campaña.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const COLUMNAS = {
  temporada_campanas: ['anticipo_tipo', 'anticipo_valor', 'mensaje_confirmacion', 'mensaje_recordatorio'],
  temporada_pedidos: ['precio_unitario', 'estado_entrega', 'entrega_cambiada_en', 'origen', 'creado_por',
    'actualizado_en', 'motivo_cancelacion'],
  temporada_pagos: ['id', 'pedido_id', 'negocio_id', 'monto', 'metodo', 'referencia', 'registrado_por',
    'registrado_en', 'anulado_en', 'anulado_por', 'motivo_anulacion'],
  temporada_bitacora: ['id', 'negocio_id', 'campana_id', 'pedido_id', 'usuario_id', 'accion', 'detalle', 'creado_en'],
};

// [tabla, restricción, tipo, fragmentos que su definición debe contener]
const RESTRICCIONES = [
  ['temporada_campanas', 'temporada_campanas_anticipo', 'c', ["'ninguno'", "'porcentaje'", "'monto'", 'precio IS NOT NULL', '100']],
  ['temporada_campanas', 'temporada_campanas_mensajes', 'c', ['mensaje_confirmacion', 'mensaje_recordatorio', '1500']],
  ['temporada_pedidos', 'temporada_pedidos_precio', 'c', ['precio_unitario']],
  ['temporada_pedidos', 'temporada_pedidos_entrega', 'c', ["'agendado'", "'en_preparacion'", "'listo'", "'entregado'"]],
  ['temporada_pedidos', 'temporada_pedidos_origen', 'c', ["'formulario'", "'panel'"]],
  ['temporada_pedidos', 'temporada_pedidos_creado_por_fkey', 'f', ['REFERENCES usuarios(id)', 'ON DELETE RESTRICT']],
  ['temporada_pedidos', 'temporada_pedidos_motivo', 'c', ["'cancelado'", 'motivo_cancelacion', '300']],
  // Las de la 135 siguen ahí: la 139 no las toca, pero el código nuevo cuenta con ellas.
  ['temporada_pedidos', 'temporada_pedidos_estado', 'c', ["'confirmado'", "'cancelado'", 'cancelado_en IS NOT NULL']],
  ['temporada_pagos', 'temporada_pagos_pkey', 'p', ['PRIMARY KEY (id)']],
  ['temporada_pagos', 'temporada_pagos_pedido_fkey', 'f', ['REFERENCES temporada_pedidos(id)', 'ON DELETE RESTRICT']],
  ['temporada_pagos', 'temporada_pagos_negocio_fkey', 'f', ['REFERENCES negocios(id)', 'ON DELETE RESTRICT']],
  ['temporada_pagos', 'temporada_pagos_registrado_por_fkey', 'f', ['REFERENCES usuarios(id)']],
  ['temporada_pagos', 'temporada_pagos_anulado_por_fkey', 'f', ['REFERENCES usuarios(id)']],
  ['temporada_pagos', 'temporada_pagos_monto', 'c', ['monto > ', '1000000']],
  ['temporada_pagos', 'temporada_pagos_metodo', 'c', ["'efectivo'", "'transferencia'", "'tarjeta'"]],
  ['temporada_pagos', 'temporada_pagos_referencia', 'c', ['referencia', '120']],
  ['temporada_pagos', 'temporada_pagos_anulacion', 'c', ['anulado_en IS NULL', 'anulado_por IS NOT NULL', 'motivo_anulacion']],
  ['temporada_bitacora', 'temporada_bitacora_pkey', 'p', ['PRIMARY KEY (id)']],
  ['temporada_bitacora', 'temporada_bitacora_negocio_fkey', 'f', ['REFERENCES negocios(id)']],
  ['temporada_bitacora', 'temporada_bitacora_campana_fkey', 'f', ['REFERENCES temporada_campanas(id)']],
  ['temporada_bitacora', 'temporada_bitacora_pedido_fkey', 'f', ['REFERENCES temporada_pedidos(id)']],
  ['temporada_bitacora', 'temporada_bitacora_usuario_fkey', 'f', ['REFERENCES usuarios(id)']],
  ['temporada_bitacora', 'temporada_bitacora_accion', 'c', ['accion']],
  ['temporada_bitacora', 'temporada_bitacora_detalle', 'c', ['jsonb_typeof(detalle)', '8192']],
];

const INDICES = [
  ['temporada_pagos', 'temporada_pagos_pedido', '(pedido_id)'],
  ['temporada_pagos', 'temporada_pagos_negocio', '(negocio_id)'],
  ['temporada_bitacora', 'temporada_bitacora_pedido', '(pedido_id, creado_en)'],
  ['temporada_bitacora', 'temporada_bitacora_campana', '(campana_id, creado_en)'],
];

// tgtype: ROW = 1, BEFORE = 2, DELETE = 8, UPDATE = 16, TRUNCATE = 32.
const TRIGGERS = [
  ['temporada_pagos', 'temporada_pagos_sin_cambios', 1 | 2 | 8 | 16, 'temporada_pagos_solo_anular'],
  ['temporada_pagos', 'temporada_pagos_sin_truncate', 2 | 32, 'temporada_pagos_solo_anular'],
  ['temporada_bitacora', 'temporada_bitacora_sin_cambios', 1 | 2 | 8 | 16, 'temporada_bitacora_inmutable'],
  ['temporada_bitacora', 'temporada_bitacora_sin_truncate', 2 | 32, 'temporada_bitacora_inmutable'],
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
  for (const [tabla, nombre, bits, funcion] of TRIGGERS) {
    const { rows: [t] } = await db.query(
      `SELECT t.tgtype, t.tgenabled, p.proname
         FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE NOT t.tgisinternal AND n.nspname = 'public' AND cl.relname = $1 AND t.tgname = $2`, [tabla, nombre]);
    if (!t) faltan.push(`trigger ${nombre}`);
    else if (!['O', 'A'].includes(t.tgenabled)) faltan.push(`trigger ${nombre} deshabilitado`);
    else if ((t.tgtype & bits) !== bits || t.proname !== funcion) faltan.push(`trigger ${nombre} con otra definición`);
  }
  return faltan;
}

// La huella de lo que ya había: si algo de esto cambia, la 139 tocó lo que no debía.
const HUELLA = `SELECT (SELECT COUNT(*) FROM temporada_campanas)::int AS campanas,
                       (SELECT COUNT(*) FROM temporada_pedidos)::int AS pedidos,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, campana_id, numero, estado, platillos, modalidad,
                                 ventana_inicio, ventana_fin, telefono, cancelado_en), ',' ORDER BY id)), '')
                          FROM temporada_pedidos) AS pedidos_md5`;

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-139-temporada-pagos-entrega',0))");
  const { rows: [base] } = await db.query(
    `SELECT to_regclass('public.temporada_campanas') IS NOT NULL AS campanas, to_regclass('public.temporada_pedidos') IS NOT NULL AS pedidos`);
  if (!base.campanas || !base.pedidos) {
    throw Error('La 139 necesita la 135 (tablas de temporada). El runner la aplica antes; revisa por qué no está.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-139] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-139] Aplicando migrations/139_temporada_pagos_entrega.sql (faltaba: ${antes.join('; ')})...`);
    // El binario anterior sigue recibiendo pedidos mientras corre esto: con
    // las tablas tomadas, ningún alta cae entre la huella y el ALTER.
    await db.query('LOCK TABLE temporada_campanas, temporada_pedidos IN ACCESS EXCLUSIVE MODE');
    const primeraVez = antes.includes('columna temporada_pedidos.precio_unitario');
    const { rows: [huellaAntes] } = await db.query(HUELLA);
    await db.query(await readFile(new URL('../migrations/139_temporada_pagos_entrega.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 139 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    for (const [tabla, columnas] of Object.entries(COLUMNAS)) await db.query(`SELECT ${columnas.join(', ')} FROM ${tabla} LIMIT 0`);
    const { rows: [huellaDespues] } = await db.query(HUELLA);
    if (JSON.stringify(huellaAntes) !== JSON.stringify(huellaDespues)) {
      throw Error(`La 139 cambió pedidos o campañas existentes (${JSON.stringify(huellaAntes)} → ${JSON.stringify(huellaDespues)}): se revierte`);
    }
    // La primera vez, el precio congelado es el de su campaña (o NULL si la
    // campaña no tiene precio). En una reaplicación parcial ya puede haber
    // pedidos con el precio de antes de un cambio: esos no se revisan.
    if (primeraVez) {
      const { rows: [precio] } = await db.query(
        `SELECT COUNT(*)::int AS distintos FROM temporada_pedidos p JOIN temporada_campanas c ON c.id = p.campana_id
          WHERE p.precio_unitario IS DISTINCT FROM c.precio`);
      if (precio.distintos) throw Error(`La 139 dejó ${precio.distintos} pedido(s) con un precio distinto al de su campaña: se revierte`);
      // Y todo lo que ya existía queda «Agendado», del formulario y sin pagos.
      const { rows: [nuevos] } = await db.query(
        `SELECT (SELECT COUNT(*) FROM temporada_pedidos WHERE estado_entrega <> 'agendado' OR origen <> 'formulario')::int AS movidos,
                (SELECT COUNT(*) FROM temporada_pagos)::int AS pagos, (SELECT COUNT(*) FROM temporada_bitacora)::int AS bitacora`);
      if (nuevos.movidos || nuevos.pagos || nuevos.bitacora) {
        throw Error(`La 139 no debía dejar entregas, pagos ni bitácora: ${JSON.stringify(nuevos)}. Se revierte.`);
      }
    }
    await db.query('COMMIT');
    console.log(primeraVez
      ? `[predeploy-139] Aplicada: ${huellaDespues.pedidos} pedido(s) de temporada quedan «Sin pago» y «Agendado», con su precio congelado.`
      : `[predeploy-139] Reparada (faltaba: ${antes.join('; ')}); ${huellaDespues.pedidos} pedido(s) sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-139] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
