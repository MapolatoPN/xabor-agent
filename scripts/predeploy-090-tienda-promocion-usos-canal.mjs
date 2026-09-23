// Pre-Deploy Command de Railway para la 090 exclusivamente.
//
// Agrega tienda_promocion_usos.canal (nullable, sin CHECK a proposito) y
// hace backfill de las filas existentes a 'tienda_online' -- confirmado por
// codigo que hasta esta fecha es la unica canal que escribe en esta tabla.
// No toca ninguna otra columna, no cambia limite_usos ni el ciclo
// reserva/consumo, no cambia ningun monto.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '090_tienda_promocion_usos_canal.sql');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  // Se detecta ANTES de aplicar nada: si la columna ya existia (deploys
  // posteriores al primero, con trafico real ya escribiendo canal='pos'/
  // 'whatsapp'), el backfill a 'tienda_online' NO aplica -- ese backfill es
  // solo para el historico pre-090, una sola vez. Verificar "todo es
  // tienda_online" en una corrida posterior rechazaria filas legitimas de
  // POS/WhatsApp y rompería cada deploy futuro.
  const { rows: [colAntes] } = await pool.query(`
    SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE table_name = 'tienda_promocion_usos' AND column_name = 'canal'`);
  const columnaYaExistia = colAntes.n > 0;

  // Si la columna ya existia, cualquier fila con canal NULL a estas alturas
  // NO es historico pendiente de backfill -- es corrupcion semantica real
  // (un canal que debio escribirse y no se escribio). La migracion 090
  // trae su propio `UPDATE ... SET canal='tienda_online' WHERE canal IS
  // NULL`, y si se dejara correr la convertiria en silencio antes de que
  // esta verificacion pudiera quejarse. Por eso se revisa ANTES de aplicar
  // nada, y se aborta sin tocar una sola fila si aparece alguna.
  if (columnaYaExistia) {
    const { rows: [nulos] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM tienda_promocion_usos WHERE canal IS NULL`);
    if (nulos.n > 0) {
      throw new Error(
        `la columna canal ya existia y hay ${nulos.n} fila(s) con canal NULL -- ` +
        `eso no es historico pre-090 (ya se backfilleo), es corrupcion real. ` +
        `Se aborta SIN aplicar la migracion para no convertirlas en silencio a 'tienda_online'; revisar a mano.`);
    }
  }

  const antes = (await pool.query(`SELECT COUNT(*)::int AS n FROM tienda_promocion_usos`)).rows[0].n;

  console.log('[predeploy-090] Aplicando migrations/090_tienda_promocion_usos_canal.sql...');
  await pool.query(readFileSync(MIGRACION, 'utf8'));

  const { rows: [e] } = await pool.query(`
    SELECT COUNT(*)::int AS c_canal
      FROM information_schema.columns
     WHERE table_name = 'tienda_promocion_usos' AND column_name = 'canal'`);
  if (e.c_canal < 1) throw new Error('tienda_promocion_usos.canal no quedo creada');

  // Verificaciones que SIEMPRE aplican, sin importar si la columna ya existia:
  // la columna esta, nadie quedo sin canal, y esta migracion no toco filas
  // mas alla de rellenar esa columna.
  const { rows: [r] } = await pool.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE canal IS NULL)::int AS sin_canal
      FROM tienda_promocion_usos`);
  if (r.sin_canal > 0) throw new Error(`quedaron ${r.sin_canal} fila(s) con canal NULL`);

  const despues = (await pool.query(`SELECT COUNT(*)::int AS n FROM tienda_promocion_usos`)).rows[0].n;
  if (despues !== antes) throw new Error(`el conteo de usos cambio (${antes} -> ${despues}): la migracion NO debe tocar filas mas alla del backfill de canal`);

  // SOLO la primera vez (la columna no existia antes de esta corrida): las
  // filas que ya estaban ahi son el historico -- hasta esta fecha el unico
  // canal que escribe en esta tabla es tienda en linea, asi que TODAS deben
  // haber quedado 'tienda_online'. En corridas posteriores esto no se
  // vuelve a exigir: canal='pos'/'whatsapp'/cualquier valor no nulo es
  // esperado y valido, sin CHECK ni allowlist rigida.
  let historicoTiendaOnline = null;
  if (!columnaYaExistia) {
    const { rows: [h] } = await pool.query(`
      SELECT COUNT(*)::int AS n FROM tienda_promocion_usos WHERE canal <> 'tienda_online'`);
    if (h.n > 0) {
      throw new Error(`primera corrida: el backfill esperaba solo 'tienda_online' en el historico pre-090 pero hay ${h.n} fila(s) con otro canal -- revisar antes de continuar`);
    }
    historicoTiendaOnline = antes - h.n;
  }

  console.log('[predeploy-090] Reporte:');
  console.log(`  columna canal ya existia antes de esta corrida ... ${columnaYaExistia}`);
  console.log(`  usos existentes .................................. ${r.total}`);
  if (!columnaYaExistia) {
    console.log(`  historico backfilleado a 'tienda_online' ......... ${historicoTiendaOnline}`);
  } else {
    console.log(`  backfill histórico: N/A (ya se aplicó en un deploy anterior)`);
  }
  console.log('[predeploy-090] Verificacion OK.');
  process.exit(0);
} catch (err) {
  console.error('[predeploy-090] FALLO:', err.message);
  process.exit(1);
}
