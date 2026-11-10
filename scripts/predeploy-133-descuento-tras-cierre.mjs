// 133: bitácora del descuento a quien escribió con el negocio cerrado. Va
// ANTES del binario nuevo: el job aparta en esta tabla cada envío antes de
// mandarlo, y sin ella falla cerrado (no manda nada).
//
// Aditiva y fail-closed, con el mismo contrato que los predeploy recientes:
//   - "Ya aplicada" solo si están TODAS sus garantías: la tabla, la regla del
//     estado y el UNIQUE por negocio y teléfono.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; si después
//     sigue faltando, se revierte.
//   - Aborta si cambia el número de mensajes o de promociones.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const TABLA = 'descuento_tras_cierre_envios';
const UNICO = 'uq_descuento_tras_cierre_telefono';

async function estado() {
  const faltan = [];
  const { rows: [t] } = await db.query(`SELECT to_regclass('public.${TABLA}') IS NOT NULL AS existe`);
  if (!t.existe) return [`tabla ${TABLA}`];
  const { rows: cols } = await db.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`, [TABLA]);
  const col = Object.fromEntries(cols.map((c) => [c.column_name, c]));
  for (const [nombre, tipo] of [['negocio_id', 'uuid'], ['telefono', 'text'], ['codigo', 'text'],
    ['mensaje_cliente_at', 'timestamp with time zone'], ['estado', 'text'], ['wamid', 'text'], ['error', 'text']]) {
    if (!col[nombre]) faltan.push(`columna ${TABLA}.${nombre}`);
    else if (col[nombre].data_type !== tipo) faltan.push(`columna ${TABLA}.${nombre} de tipo ${col[nombre].data_type}`);
  }
  const { rows: restricciones } = await db.query(
    `SELECT c.conname, c.contype, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public' AND cl.relname = $1`, [TABLA]);
  const unico = restricciones.find((r) => r.conname === UNICO);
  if (!unico || unico.contype !== 'u' || !unico.def.includes('(negocio_id, telefono)')) faltan.push(`restricción ${UNICO}`);
  const regla = restricciones.find((r) => r.contype === 'c' && r.def.includes('estado')
    && ['enviando', 'aceptado', 'fallido'].every((v) => r.def.includes(`'${v}'`)));
  if (!regla) faltan.push(`regla del estado de ${TABLA}`);
  return faltan;
}

const CONTEOS = `SELECT (SELECT COUNT(*) FROM mensajes)::int AS mensajes,
                        (SELECT COUNT(*) FROM tienda_promociones)::int AS promociones`;
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-133-descuento-tras-cierre',0))");
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-133] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-133] Aplicando migrations/133_descuento_tras_cierre.sql (faltaba: ${antes.join('; ')})...`);
    const { rows: [conteoAntes] } = await db.query(CONTEOS);
    await db.query(await readFile(new URL('../migrations/133_descuento_tras_cierre.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 133 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    const { rows: [conteoDespues] } = await db.query(CONTEOS);
    if (JSON.stringify(conteoAntes) !== JSON.stringify(conteoDespues)) {
      throw Error(`La 133 cambió filas existentes (${JSON.stringify(conteoAntes)} → ${JSON.stringify(conteoDespues)}): se revierte`);
    }
    await db.query('COMMIT');
    console.log('[predeploy-133] Aplicada: bitácora del descuento tras cierre lista (vacía).');
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-133] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
