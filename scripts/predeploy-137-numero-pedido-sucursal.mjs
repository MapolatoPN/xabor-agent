// 137: número consecutivo por sucursal (OB-152), además del folio XAB-.
// Va ANTES del binario nuevo: la Caja lee la columna y el ledger.
//
// Aditiva y fail-closed, con el mismo contrato que los predeploy anteriores:
//   - "Ya aplicada" solo si están TODAS sus garantías: la columna, las dos
//     tablas con sus restricciones, el índice (válido), la función en su
//     versión y el trigger con su definición exacta.
//   - El trigger tiene que ser el ÚLTIMO BEFORE INSERT y el último BEFORE
//     UPDATE de pedidos_activos (orden alfabético): si otro corriera después y
//     descartara el INSERT, se gastaría un número; si reescribiera datos, el
//     pedido perdería su etiqueta. Si aparece uno así, falla y pide revisión.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambian negocios, la configuración de la numeración o los
//     números ya dados (la 137 no escribe ninguna fila ni enciende nada).
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

const RESTRICCIONES = {
  pedido_numero_sucursal_contador: ['pedido_numero_sucursal_contador_pkey', 'pedido_numero_sucursal_contador_ultimo'],
  pedido_numeros_sucursal: ['pedido_numeros_sucursal_pkey', 'pedido_numeros_sucursal_folio_unico',
    'pedido_numeros_sucursal_numero_positivo'],
};
const INDICE = 'pedido_numeros_sucursal_asignado';
const TRIGGER = 'trg_zz_numero_sucursal';
const DEF_TRIGGER = 'BEFORE INSERT OR UPDATE OF numero_sucursal, datos ON public.pedidos_activos FOR EACH ROW EXECUTE FUNCTION xabor_numero_sucursal()';
const MARCA = 'xabor-137-v3';

async function columnaExiste() {
  const { rows: [c] } = await db.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pedidos_activos' AND column_name = 'numero_sucursal'`);
  return c ? c.data_type : null;
}

async function estado() {
  const faltan = [];
  const tipo = await columnaExiste();
  if (!tipo) faltan.push('columna pedidos_activos.numero_sucursal');
  else if (tipo !== 'integer') faltan.push(`columna pedidos_activos.numero_sucursal es ${tipo}, no integer`);

  for (const [tabla, nombres] of Object.entries(RESTRICCIONES)) {
    const { rows: [t] } = await db.query(`SELECT to_regclass($1) IS NOT NULL AS existe`, [`public.${tabla}`]);
    if (!t.existe) { faltan.push(`tabla ${tabla}`); continue; }
    const { rows } = await db.query(
      `SELECT c.conname FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = $1`, [tabla]);
    const hay = new Set(rows.map((r) => r.conname));
    for (const r of nombres) if (!hay.has(r)) faltan.push(`restricción ${r}`);
  }

  const { rows: [idx] } = await db.query(
    `SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_namespace n ON n.oid = ic.relnamespace
      WHERE n.nspname = 'public' AND ic.relname = $1`, [INDICE]);
  if (!idx) faltan.push(`índice ${INDICE}`);
  else if (!idx.indisvalid) faltan.push(`índice ${INDICE} inválido`);
  else if (!idx.def.includes('(negocio_id, asignado_at)')) faltan.push(`índice ${INDICE} con otra definición`);

  const { rows: [fn] } = await db.query(
    `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'xabor_numero_sucursal' AND p.pronargs = 0`);
  if (!fn) faltan.push('función xabor_numero_sucursal');
  else if (!fn.def.includes(MARCA)) faltan.push(`función xabor_numero_sucursal sin la marca ${MARCA}`);
  else if (!fn.def.includes('EXCEPTION WHEN others')) faltan.push('función xabor_numero_sucursal sin su bloque EXCEPTION');

  const { rows: triggers } = await db.query(
    `SELECT t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS def,
            (t.tgtype & 2) <> 0 AS before, (t.tgtype & 4) <> 0 AS al_insertar,
            (t.tgtype & 16) <> 0 AS al_actualizar
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'pedidos_activos' AND NOT t.tgisinternal`);
  const tr = triggers.find((t) => t.tgname === TRIGGER);
  if (!tr) faltan.push(`trigger ${TRIGGER}`);
  else {
    if (tr.tgenabled !== 'O') faltan.push(`trigger ${TRIGGER} deshabilitado (tgenabled=${tr.tgenabled})`);
    if (!tr.def.includes(DEF_TRIGGER)) faltan.push(`trigger ${TRIGGER} con otra definición: ${tr.def}`);
  }
  // Orden: ningún BEFORE INSERT ni BEFORE UPDATE después de este.
  for (const t of triggers) {
    if (t.before && t.al_insertar && t.tgname > TRIGGER) {
      faltan.push(`el BEFORE INSERT ${t.tgname} corre después de ${TRIGGER} (revisión manual: podría descartar pedidos ya numerados)`);
    }
    if (t.before && t.al_actualizar && !t.al_insertar && t.tgname > TRIGGER) {
      faltan.push(`el BEFORE UPDATE ${t.tgname} corre después de ${TRIGGER} (revisión manual: podría quitarle la etiqueta a datos)`);
    }
  }
  return faltan;
}

async function conteo() {
  const { rows: [c] } = await db.query(
    `SELECT (SELECT COUNT(*) FROM negocios)::int AS negocios,
            (SELECT COUNT(*) FROM configuracion WHERE clave LIKE 'numero_sucursal%')::int AS claves`);
  // Los números ya dados (si la columna existe: reaplicar tras una reversa).
  c.numerados = await columnaExiste()
    ? (await db.query(`SELECT COUNT(*)::int AS n FROM pedidos_activos WHERE numero_sucursal IS NOT NULL`)).rows[0].n
    : 0;
  return c;
}

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-137-numero-pedido-sucursal',0))");
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-137] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-137] Aplicando migrations/137_numero_pedido_sucursal.sql (faltaba: ${antes.join('; ')})...`);
    const conteoAntes = await conteo();
    await db.query(await readFile(new URL('../migrations/137_numero_pedido_sucursal.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 137 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    const conteoDespues = await conteo();
    for (const k of ['negocios', 'claves', 'numerados']) {
      if (conteoAntes[k] !== conteoDespues[k]) {
        throw Error(`La 137 cambió filas existentes (${k} ${conteoAntes[k]} → ${conteoDespues[k]}): se revierte`);
      }
    }
    await db.query('COMMIT');
    console.log('[predeploy-137] Aplicada: numeración por sucursal lista y APAGADA en todos los negocios.');
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-137] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
