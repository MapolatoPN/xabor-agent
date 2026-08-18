// Pre-Deploy Command de Railway para la 059 exclusivamente.
//
// Aplica migrations/059_folio_durable.sql: la secuencia durable que impide que
// XAB-#### se recicle.
//
// Fail-closed: sin esta secuencia el folio lo genera un contador en memoria
// sembrado desde `pedidos_activos`, que retrocede en cuanto el tablero se purga
// -- y el folio es la identidad de la que cuelgan el dedupe del panel, la
// idempotencia de Edge, los pagos, las promociones y las compras reales.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '059_folio_durable.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const existe = async () => (await pool.query(
  `SELECT COUNT(*)::int AS n FROM pg_class
    WHERE relkind='S' AND relname='folio_pedido_seq'`)).rows[0].n === 1;

// El maximo historico REAL, mirando todas las tablas que pueden conservar el
// folio de un pedido ya purgado del tablero.
async function maximoHistorico() {
  const fuentes = [
    ['pedidos_activos', 'folio'], ['pedidos', 'folio'], ['pagos', 'pedido_folio'],
    ['compras_reales', 'folio'], ['tienda_pedidos', 'pedido_folio'],
    ['tienda_promocion_usos', 'pedido_folio'], ['notificaciones_repartidor', 'pedido_folio'],
    ['rewards_movements', 'folio_venta'], ['oportunidades', 'folio_pedido'],
    ['pedidos_programados', 'folio'], ['restaurante_cuentas', 'venta_folio'],
    ['impresion_trabajos', 'origen_id'],
  ];
  const detalle = {};
  let max = 0;
  for (const [tabla, col] of fuentes) {
    try {
      const { rows: [r] } = await pool.query(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(${col} FROM '^XAB-([0-9]+)$') AS bigint)),0)::bigint AS m
           FROM ${tabla} WHERE ${col} ~ '^XAB-[0-9]+$'`);
      const n = Number(r.m);
      detalle[`${tabla}.${col}`] = n;
      if (n > max) max = n;
    } catch { detalle[`${tabla}.${col}`] = null; }   // la tabla no existe aqui
  }
  return { max, detalle };
}

try {
  if (await existe()) {
    console.log('[predeploy-059] La secuencia ya existe; se reejecuta el SQL (solo puede avanzar).');
  } else {
    console.log('[predeploy-059] Creando folio_pedido_seq...');
  }
  await pool.query(readFileSync(MIGRACION, 'utf8'));
  if (!await existe()) throw new Error('la secuencia folio_pedido_seq no quedo creada');

  const { max, detalle } = await maximoHistorico();
  const { rows: [s] } = await pool.query(`SELECT last_value, is_called FROM folio_pedido_seq`);
  const proximo = s.is_called ? Number(s.last_value) + 1 : Number(s.last_value);

  console.log('[predeploy-059] Maximos historicos por fuente:');
  for (const [k, v] of Object.entries(detalle)) {
    console.log(`  ${k.padEnd(38)} ${v === null ? '(tabla ausente)' : v}`);
  }
  console.log(`[predeploy-059] Maximo historico global: ${max}`);
  console.log(`[predeploy-059] Proximo folio que entregara la secuencia: XAB-${String(proximo).padStart(4,'0')}`);

  // LA GARANTIA: el proximo folio no puede ser uno que ya existio.
  if (proximo <= max) {
    throw new Error(
      `la secuencia entregaria XAB-${proximo}, que ya existe en el historico (maximo ${max}): ` +
      `el cutover habria reciclado folios vivos`);
  }
  console.log('[predeploy-059] Verificacion OK: el proximo folio esta por encima de todo el historico.');

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-059] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
