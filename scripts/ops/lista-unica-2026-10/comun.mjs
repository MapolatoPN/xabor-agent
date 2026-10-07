// Utilidades del emparejamiento de la lista única (oct-2026).
// Cada script hace SIMULACRO por omisión (todo dentro de una transacción que
// termina en ROLLBACK) y solo confirma con --aplicar. Antes de confirmar
// escribe el estado anterior en el directorio de respaldo (--respaldo=<dir>,
// por omisión C:\xabor-respaldos\lista-unica-2026-10), fuera de la base.
import pg from 'pg';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function opciones(argv = process.argv.slice(2)) {
  const valor = (k) => (argv.find(a => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
  const negocios = argv.filter(a => a.startsWith('--negocio=')).flatMap(a => a.slice(10).split(','))
    .map(s => s.trim()).filter(Boolean);
  return {
    aplicar: argv.includes('--aplicar'),
    forzar: argv.includes('--forzar'),
    negocios,
    respaldo: valor('respaldo') || 'C:/xabor-respaldos/lista-unica-2026-10',
    posicionales: argv.filter(a => !a.startsWith('--')),
  };
}

export async function conectar() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
  const host = new URL(process.env.DATABASE_URL).hostname;
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  console.log(`[lista-unica] base: ${host}${local ? ' (local)' : ''}`);
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

export function guardar(dir, nombre, datos) {
  mkdirSync(dir, { recursive: true });
  const ruta = join(dir, nombre);
  writeFileSync(ruta, JSON.stringify(datos, null, 2));
  return ruta;
}

export const sello = () => new Date().toISOString().replace(/[:.]/g, '-');

// Corre `trabajo(c, opts)` dentro de una transacción. Sin --aplicar, ROLLBACK.
export async function enTransaccion(nombre, trabajo, opts = opciones()) {
  const c = await conectar();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout = '5s'");
    await trabajo(c, opts);
    await c.query(opts.aplicar ? 'COMMIT' : 'ROLLBACK');
    console.log(opts.aplicar ? `[${nombre}] APLICADO.` : `[${nombre}] SIMULACRO: nada se guardó. Repite con --aplicar para confirmar.`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error(`[${nombre}] ABORTADO, nada se guardó: ${e.message}`);
    process.exitCode = 1;
  } finally { await c.end().catch(() => {}); }
}

// Productos cuya marca de WhatsApp no coincide con la de la tienda.
export const SQL_DIFERENCIAS = `
  SELECT n.slug, p.negocio_id, p.id AS producto_id, p.nombre, c.nombre AS categoria,
         COALESCE(tp.publicado, FALSE) AS tienda,
         (wp.producto_id IS NOT NULL) AS existia, wp.publicado, wp.origen, wp.actualizado_por,
         wp.created_at, wp.updated_at
    FROM menu_productos p
    JOIN negocios n ON n.id = p.negocio_id
    JOIN menu_categorias c ON c.id = p.categoria_id AND c.negocio_id = p.negocio_id
    LEFT JOIN tienda_productos tp ON tp.negocio_id = p.negocio_id AND tp.producto_id = p.id
    LEFT JOIN whatsapp_productos wp ON wp.negocio_id = p.negocio_id AND wp.producto_id = p.id
   WHERE COALESCE(tp.publicado, FALSE) <> COALESCE(wp.publicado, FALSE)
     AND (cardinality($1::text[]) = 0 OR n.slug = ANY($1::text[]))
   ORDER BY n.slug, c.orden, p.orden, p.id`;
