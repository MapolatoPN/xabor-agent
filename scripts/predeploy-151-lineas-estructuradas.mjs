// 151: datos estructurados de producto y modificadores (Fase 2). Va ANTES
// del binario nuevo: el editor del Menú, la captura de Mesas y el proceso
// del registro de líneas leen y escriben lo nuevo.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-146:
//   - Necesita menu_productos, restaurante_cuenta_items (039),
//     menu_modificadores_* y negocios: si falta algo, se detiene.
//   - "Ya aplicada" solo si están las tablas, las columnas con su tipo, las
//     reglas y los índices.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; si después
//     sigue faltando, se revierte.
//   - Aborta si cambia cualquier producto o artículo de mesa existente (las
//     ventas no se nombran en el SQL ni se toman: tomarlas pararía los
//     pedidos), o si la primera vez queda algún producto con otro tipo que no sea
//     'platillo', algún artículo de mesa con las columnas nuevas llenas o
//     alguna fila en las tablas nuevas.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const TABLAS = ['pedido_lineas_pedidos', 'pedido_lineas', 'pedido_linea_modificadores', 'rappi_emparejamientos'];
// [tabla, columna, tipo de information_schema, ¿acepta NULL?]
const COLUMNAS = [
  ['menu_productos', 'tipo', 'text', 'NO'],
  ['restaurante_cuenta_items', 'producto_id', 'integer', 'YES'],
  ['restaurante_cuenta_items', 'modificadores_det', 'jsonb', 'YES'],
  ['pedido_lineas_pedidos', 'firma', 'text', 'NO'],
  ['pedido_lineas', 'nota', 'text', 'YES'],
  ['pedido_lineas', 'estado', 'text', 'NO'],
  ['pedido_linea_modificadores', 'cantidad', 'numeric', 'NO'],
  ['pedido_linea_modificadores', 'clasificado', 'boolean', 'NO'],
  ['rappi_emparejamientos', 'opcion_rappi', 'text', 'NO'],
];
// [tabla, regla, tipo (c=check, f=llave foránea, u=única, p=primaria), fragmentos que su definición debe contener]
const REGLAS = [
  ['menu_productos', 'menu_productos_tipo', 'c', ["'platillo'", "'bebida'", "'extra'", "'envio'", "'otro'"]],
  ['pedido_lineas_pedidos', 'pedido_lineas_pedidos_pkey', 'p', ['(negocio_id, folio)']],
  ['pedido_lineas', 'pedido_lineas_pedido_fkey', 'f', ['REFERENCES pedido_lineas_pedidos(negocio_id, folio)', 'ON DELETE CASCADE']],
  ['pedido_lineas', 'pedido_lineas_unica', 'u', ['(negocio_id, folio, linea)']],
  ['pedido_lineas', 'pedido_lineas_estado', 'c', ["'completa'", "'parcial'", "'sin_estructurar'"]],
  ['pedido_linea_modificadores', 'pedido_linea_modificadores_linea_id_fkey', 'f', ['REFERENCES pedido_lineas(id)', 'ON DELETE CASCADE']],
  ['rappi_emparejamientos', 'rappi_emparejamientos_unico', 'u', ['(negocio_id, producto_rappi, opcion_rappi)']],
  ['rappi_emparejamientos', 'rappi_emparejamientos_forma', 'c', ['opcion_rappi', 'grupo_id IS NULL']],
];
// [tabla, índice, fragmentos que su definición debe contener]
const INDICES = [
  ['pedido_lineas', 'pedido_lineas_producto', ['(negocio_id, producto_id)']],
  ['pedido_linea_modificadores', 'pedido_linea_modificadores_linea', ['(linea_id)']],
  ['pedido_linea_modificadores', 'pedido_linea_modificadores_sin_clasificar', ['(negocio_id)', 'NOT clasificado']],
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

// La huella de lo que ya había: si algo de esto cambia, la 151 tocó lo que no debía.
// pedidos_activos no entra: la 151 no la nombra (el registro se llena
// después, desde el binario nuevo) y tomarla bloquearía los pedidos.
const HUELLA = `SELECT (SELECT COUNT(*) FROM menu_productos)::int AS productos,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, negocio_id, categoria_id, nombre, precio,
                                 disponible, agotado, opciones::text), ',' ORDER BY id)), '')
                          FROM menu_productos) AS productos_md5,
                       (SELECT COUNT(*) FROM restaurante_cuenta_items)::int AS articulos_mesa,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, cuenta_id, producto, cantidad, precio_unitario,
                                 modificadores::text, notas, estado), ',' ORDER BY id)), '')
                          FROM restaurante_cuenta_items) AS articulos_mesa_md5`;

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-151-lineas-estructuradas',0))");
  const { rows: [base] } = await db.query(
    `SELECT to_regclass('public.negocios') IS NOT NULL AS negocios,
            to_regclass('public.menu_productos') IS NOT NULL AS productos,
            to_regclass('public.menu_modificadores_grupos') IS NOT NULL AS grupos,
            to_regclass('public.menu_modificadores_opciones') IS NOT NULL AS opciones,
            to_regclass('public.restaurante_cuenta_items') IS NOT NULL AS mesa,
            to_regclass('public.pedidos_activos') IS NOT NULL AS ventas`);
  if (!Object.values(base).every(Boolean)) {
    throw Error(`La 151 necesita negocios, el menú con modificadores, restaurante_cuenta_items (039) y pedidos_activos (${JSON.stringify(base)}). Revisa por qué no están.`);
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-151] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-151] Aplicando migrations/151_lineas_estructuradas.sql (faltaba: ${antes.join('; ')})...`);
    // El binario anterior agrega artículos a las mesas y edita el menú mientras
    // corre esto: con las tablas tomadas, nada cae entre la huella y el ALTER.
    await db.query('LOCK TABLE menu_productos, restaurante_cuenta_items IN ACCESS EXCLUSIVE MODE');
    const primeraVez = antes.includes('columna menu_productos.tipo');
    const { rows: [huellaAntes] } = await db.query(HUELLA);
    await db.query(await readFile(new URL('../migrations/151_lineas_estructuradas.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 151 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    await db.query('SELECT tipo FROM menu_productos LIMIT 0');
    await db.query('SELECT producto_id, modificadores_det FROM restaurante_cuenta_items LIMIT 0');
    const { rows: [huellaDespues] } = await db.query(HUELLA);
    if (JSON.stringify(huellaAntes) !== JSON.stringify(huellaDespues)) {
      throw Error(`La 151 cambió productos o artículos de mesa existentes (${JSON.stringify(huellaAntes)} → ${JSON.stringify(huellaDespues)}): se revierte`);
    }
    if (primeraVez) {
      const { rows: [r] } = await db.query(
        `SELECT (SELECT COUNT(*) FROM menu_productos WHERE tipo <> 'platillo')::int AS con_tipo,
                (SELECT COUNT(*) FROM restaurante_cuenta_items
                  WHERE producto_id IS NOT NULL OR modificadores_det IS NOT NULL)::int AS mesa_llena,
                (SELECT COUNT(*) FROM pedido_lineas_pedidos)::int AS pedidos,
                (SELECT COUNT(*) FROM rappi_emparejamientos)::int AS emparejamientos`);
      if (r.con_tipo || r.mesa_llena || r.pedidos || r.emparejamientos) {
        throw Error(`La 151 dejó valores que deben nacer vacíos (${JSON.stringify(r)}). Se revierte.`);
      }
    }
    await db.query('COMMIT');
    console.log(primeraVez
      ? `[predeploy-151] Aplicada: ${huellaDespues.productos} producto(s) y ${huellaDespues.articulos_mesa} artículo(s) de mesa sin cambios; todos los productos nacen 'platillo' y el registro de líneas nace apagado en cada negocio (lineas_estructuradas).`
      : `[predeploy-151] Reparada (faltaba: ${antes.join('; ')}); ${huellaDespues.productos} producto(s) sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-151] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
