// 146: saneamiento de Clientes, fase 2 (consentimiento de promociones): las
// versiones del aviso de la tienda y, en cada aceptación, el folio y la
// versión que vio el cliente. Va ANTES del binario nuevo: la tienda, la Lista
// y el reconciliador leen lo nuevo.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-143:
//   - Necesita negocios y cliente_consentimientos (080) y la 143: si falta
//     algo, se detiene.
//   - "Ya aplicada" solo si están la tabla, las columnas con su tipo, las
//     reglas y los índices.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia cualquier consentimiento o cliente existente (los que
//     hoy dicen «aceptó» deben seguir diciéndolo), o si la primera vez queda
//     alguna versión del aviso o algún consentimiento con folio o versión.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const TABLAS = ['aviso_promociones'];
// [tabla, columna, tipo de information_schema, ¿acepta NULL?]
const COLUMNAS = [
  ['aviso_promociones', 'negocio_id', 'uuid', 'NO'],
  ['aviso_promociones', 'texto', 'text', 'NO'],
  ['aviso_promociones', 'en_tienda', 'boolean', 'NO'],
  ['aviso_promociones', 'en_whatsapp', 'boolean', 'NO'],
  ['aviso_promociones', 'creado_por', 'text', 'YES'],
  ['aviso_promociones', 'created_at', 'timestamp with time zone', 'NO'],
  ['cliente_consentimientos', 'referencia', 'text', 'YES'],
  ['cliente_consentimientos', 'aviso_id', 'bigint', 'YES'],
];
// [tabla, regla, tipo (c=check, f=llave foránea), fragmentos que su definición debe contener]
const REGLAS = [
  ['aviso_promociones', 'aviso_promociones_texto', 'c', ['btrim(texto)', '1', '300']],
  ['aviso_promociones', 'aviso_promociones_negocio_id_fkey', 'f', ['REFERENCES negocios(id)']],
  ['cliente_consentimientos', 'cliente_consentimientos_aviso_id_fkey', 'f', ['(aviso_id)', 'REFERENCES aviso_promociones(id)']],
];
// [tabla, índice, fragmentos que su definición debe contener]
const INDICES = [
  ['aviso_promociones', 'aviso_promociones_vigente', ['(negocio_id, created_at DESC, id DESC)']],
  ['cliente_consentimientos', 'cliente_consentimientos_tienda_pedido_unica',
    ['UNIQUE', '(negocio_id, cliente_id, canal)', "'tienda_pedido'"]],
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

// La huella de lo que ya había: si algo de esto cambia, la 146 tocó lo que no debía.
const HUELLA = `SELECT (SELECT COUNT(*) FROM clientes_negocio)::int AS clientes,
                       (SELECT COUNT(*) FROM cliente_consentimientos)::int AS consentimientos,
                       (SELECT COUNT(*) FROM cliente_consentimientos WHERE otorgado)::int AS aceptaron,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, negocio_id, cliente_id, canal, otorgado, fuente,
                                 created_at), ',' ORDER BY id)), '')
                          FROM cliente_consentimientos) AS consentimientos_md5,
                       (SELECT COALESCE(md5(string_agg(concat_ws('|', id, negocio_id, telefono, nombre, es_interno,
                                 created_at, updated_at), ',' ORDER BY id)), '')
                          FROM clientes_negocio) AS clientes_md5`;

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-146-aviso-promociones',0))");
  const { rows: [base] } = await db.query(
    `SELECT to_regclass('public.negocios') IS NOT NULL AS negocios,
            to_regclass('public.cliente_consentimientos') IS NOT NULL AS consentimientos,
            to_regclass('public.negocio_telefonos_propios') IS NOT NULL AS con_143`);
  if (!base.negocios || !base.consentimientos || !base.con_143) {
    throw Error('La 146 necesita negocios, cliente_consentimientos (080) y la 143. Revisa por qué no están.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-146] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-146] Aplicando migrations/146_aviso_promociones.sql (faltaba: ${antes.join('; ')})...`);
    // El binario anterior sigue anotando consentimientos (la cuenta de la
    // tienda, las bajas de campañas) mientras corre esto: con la tabla
    // tomada, nada cae entre la huella y el ALTER.
    await db.query('LOCK TABLE cliente_consentimientos, clientes_negocio IN ACCESS EXCLUSIVE MODE');
    const primeraVez = antes.includes('tabla aviso_promociones');
    const { rows: [huellaAntes] } = await db.query(HUELLA);
    await db.query(await readFile(new URL('../migrations/146_aviso_promociones.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 146 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    await db.query('SELECT texto, en_tienda, en_whatsapp, creado_por FROM aviso_promociones LIMIT 0');
    await db.query('SELECT referencia, aviso_id FROM cliente_consentimientos LIMIT 0');
    const { rows: [huellaDespues] } = await db.query(HUELLA);
    if (JSON.stringify(huellaAntes) !== JSON.stringify(huellaDespues)) {
      throw Error(`La 146 cambió consentimientos o clientes existentes (${JSON.stringify(huellaAntes)} → ${JSON.stringify(huellaDespues)}): se revierte`);
    }
    if (primeraVez) {
      // (Tras una reversa a mano pueden quedar aceptaciones con fuente
      // 'tienda_pedido': la reversa no borra filas. Esas no se revisan aquí.)
      const { rows: [r] } = await db.query(
        `SELECT (SELECT COUNT(*) FROM aviso_promociones)::int AS avisos,
                (SELECT COUNT(*) FROM cliente_consentimientos WHERE referencia IS NOT NULL OR aviso_id IS NOT NULL)::int AS con_aviso`);
      if (r.avisos || r.con_aviso) {
        throw Error(`La 146 dejó valores que deben nacer vacíos (${JSON.stringify(r)}). Se revierte.`);
      }
    }
    await db.query('COMMIT');
    console.log(primeraVez
      ? `[predeploy-146] Aplicada: ${huellaDespues.consentimientos} consentimiento(s) sin cambios (${huellaDespues.aceptaron} aceptado(s)); el aviso de la tienda lo siembra el servidor al arrancar.`
      : `[predeploy-146] Reparada (faltaba: ${antes.join('; ')}); ${huellaDespues.consentimientos} consentimiento(s) sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-146] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
