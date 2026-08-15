// Pre-Deploy Command de Railway para la 051 exclusivamente.
//
// Aplica migrations/051_tienda_online.sql: las seis tablas del módulo Tienda
// Online MÁS el reemplazo del CHECK de negocio_modulos (sin ese CHECK, dar de
// alta la primera tienda falla con violación de restricción).
//
// Fail-closed: si la migración corre pero la verificación posterior no ve las
// seis tablas Y el CHECK actualizado, se aborta el deploy con exit 1. La
// aplicación no arranca sobre un esquema a medias.
//
// Idempotente por partida doble: se comprueba antes (y si ya está aplicada no
// se toca nada), y el SQL en sí es re-ejecutable — CREATE TABLE IF NOT EXISTS,
// CREATE INDEX IF NOT EXISTS y DROP CONSTRAINT IF EXISTS antes del ADD. Un
// deploy repetido sobre una base ya migrada no cambia nada ni falla.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACION = join(__dirname, '..', 'migrations', '051_tienda_online.sql');

// Las seis tablas que crea la 051. Se listan explícitamente: si alguien
// agrega una tabla al SQL y olvida esta lista, la verificación no la exigirá
// y el deploy pasaría con el esquema incompleto.
const TABLAS = [
  'tienda_config',
  'tienda_productos',
  'tienda_campanas',
  'tienda_promociones',
  'tienda_promocion_usos',
  'tienda_pedidos',
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Las cuatro FKs compuestas que impiden asociaciones entre negocios distintos.
// Van en la comprobación: si no estuvieran, la migración TIENE que volver a
// correr aunque las tablas ya existan -- justo el caso de una base que se
// migró antes de que existieran.
const FKS_COMPUESTAS = [
  'tienda_productos_negocio_producto_fkey',
  'tienda_promociones_negocio_campania_fkey',
  'tienda_promocion_usos_negocio_promocion_fkey',
  'tienda_promocion_usos_negocio_campania_fkey',
];

// Regla de este gate: tiene que comprobar TODO lo que la migración garantiza.
// Ya pasó dos veces que una comprobación incompleta dejaba fuera cambios sobre
// una base que ya tenía las tablas -- el gate decía "ya aplicada" y la garantía
// nueva no llegaba nunca. Si se agrega algo a la 051, se agrega aquí.
async function estado() {
  const { rows: [r] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1::text[]))::int AS tablas,
       (SELECT COUNT(*) FROM pg_constraint
         WHERE conname = 'negocio_modulos_modulo_check'
           AND pg_get_constraintdef(oid) LIKE '%tienda_online%')::int AS modulo_en_check,
       (SELECT COUNT(*) FROM pg_constraint WHERE conname = ANY($2::text[]))::int AS fks,
       -- Índice único que impide dos pedidos para el mismo checkout.
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'idx_pedido_activo_checkout_token')::int AS idx_checkout,
       -- Las FKs de campaña deben nulear SOLO campania_id: negocio_id es
       -- NOT NULL y un SET NULL sin lista de columnas rompería el DELETE.
       (SELECT COUNT(*) FROM pg_constraint
         WHERE conname IN ('tienda_promociones_negocio_campania_fkey',
                           'tienda_promocion_usos_negocio_campania_fkey')
           AND pg_get_constraintdef(oid) LIKE '%SET NULL (campania_id)%')::int AS set_null_columna,
       -- Ledger de derivaciones: sin el, un reintento tras un crash volveria
       -- a imprimir por el camino legacy y a anunciar el pedido como nuevo.
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name = 'tienda_pedidos' AND column_name = 'derivaciones')::int AS ledger`,
    [TABLAS, FKS_COMPUESTAS]
  );
  return {
    tablas: r.tablas,
    moduloEnCheck: r.modulo_en_check === 1,
    fks: r.fks,
    idxCheckout: r.idx_checkout === 1,
    setNullColumna: r.set_null_columna === 2,
    ledger: r.ledger === 1,
  };
}

async function yaAplicada() {
  const e = await estado();
  return e.tablas === TABLAS.length && e.moduloEnCheck && e.fks === FKS_COMPUESTAS.length
    && e.idxCheckout && e.setNullColumna && e.ledger;
}

try {
  if (await yaAplicada()) {
    console.log('[predeploy-051] Ya aplicada -- no se ejecuta nada.');
  } else {
    const antes = await estado();
    console.log(`[predeploy-051] Aplicando migrations/051_tienda_online.sql ` +
      `(tablas: ${antes.tablas}/${TABLAS.length}, modulo en CHECK: ${antes.moduloEnCheck}, ` +
      `FKs por negocio: ${antes.fks}/${FKS_COMPUESTAS.length}, ` +
      `indice de checkout: ${antes.idxCheckout}, SET NULL por columna: ${antes.setNullColumna})...`);
    await pool.query(readFileSync(MIGRACION, 'utf8'));

    const despues = await estado();
    if (despues.tablas !== TABLAS.length) {
      throw new Error(`faltan tablas tras migrar: ${despues.tablas}/${TABLAS.length}`);
    }
    if (!despues.moduloEnCheck) {
      throw new Error(`el CHECK de negocio_modulos no acepta 'tienda_online'`);
    }
    if (despues.fks !== FKS_COMPUESTAS.length) {
      throw new Error(
        `faltan FKs compuestas por negocio: ${despues.fks}/${FKS_COMPUESTAS.length} ` +
        `-- el esquema no impediria una asociacion entre negocios distintos`);
    }
    if (!despues.idxCheckout) {
      throw new Error(
        `falta idx_pedido_activo_checkout_token -- sin el, un crash a media creacion ` +
        `podria dejar dos pedidos para el mismo checkout`);
    }
    if (!despues.setNullColumna) {
      throw new Error(
        `las FKs de campana no nulean solo campania_id -- borrar una campana fallaria`);
    }
    if (!despues.ledger) {
      throw new Error(
        `falta tienda_pedidos.derivaciones -- un reintento tras crash repetiria ` +
        `efectos que no son idempotentes (impresion legacy, aviso al panel)`);
    }
    console.log(`[predeploy-051] Verificacion OK: ${TABLAS.length} tablas, CHECK actualizado, ` +
      `${FKS_COMPUESTAS.length} FKs con aislamiento por negocio, indice de checkout unico ` +
      `y SET NULL acotado a campania_id.`);
  }

  // El módulo nace APAGADO para todos: la 051 no lo activa a nadie. Cada
  // negocio lo contrata desde Superadmin. Se reporta para que el deploy deje
  // constancia de que nadie quedó con una tienda encendida por accidente.
  const { rows: [c] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM negocio_modulos WHERE modulo = 'tienda_online'`);
  console.log(`[predeploy-051] Negocios con el modulo contratado: ${c.n}`);

  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[predeploy-051] FALLO -- se aborta el deploy:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
