// Checkout embebido de Clip en la tienda en línea: encender, apagar y revisar
// la bandera POR NEGOCIO. Ver docs/tienda-clip-embebido.md.
//
//   node scripts/ops/clip-embebido-2026-10/bandera.mjs estado
//   node scripts/ops/clip-embebido-2026-10/bandera.mjs estado --negocio=mapolato-acuna
//   node scripts/ops/clip-embebido-2026-10/bandera.mjs activar --negocio=mapolato-acuna              (simulacro)
//   node scripts/ops/clip-embebido-2026-10/bandera.mjs activar --negocio=mapolato-acuna --aplicar
//   node scripts/ops/clip-embebido-2026-10/bandera.mjs desactivar --negocio=mapolato-acuna --aplicar
//   node scripts/ops/clip-embebido-2026-10/bandera.mjs apagar-verificacion --negocio=... --aplicar
//   node scripts/ops/clip-embebido-2026-10/bandera.mjs encender-verificacion --negocio=... --aplicar
//
// Solo escribe UNA fila de `configuracion` del negocio indicado:
//   tienda_clip_checkout_embebido      'true' = embebido; sin fila = redireccionado (como antes)
//   tienda_pago_verificar_al_regresar  'false' = sin consulta a Clip al regresar; sin fila = encendida
// Nada de credenciales, pagos ni pedidos. SIMULACRO por omisión (la
// transacción termina en ROLLBACK); con --aplicar confirma y antes guarda el
// valor anterior en --respaldo=<dir> (por omisión C:/xabor-respaldos/clip-embebido-2026-10).
// `desactivar` borra la fila: el negocio queda exactamente como antes de activarlo.
import pg from 'pg';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAVE_EMBEBIDO = 'tienda_clip_checkout_embebido';
const CLAVE_VERIFICACION = 'tienda_pago_verificar_al_regresar';

const argv = process.argv.slice(2);
const valor = (k) => (argv.find(a => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const comando = argv.find(a => !a.startsWith('--')) || 'estado';
const aplicar = argv.includes('--aplicar');
const negocioArg = valor('negocio').trim();
const respaldo = valor('respaldo') || 'C:/xabor-respaldos/clip-embebido-2026-10';

const ACCIONES = {
  activar: { clave: CLAVE_EMBEBIDO, valor: 'true' },
  desactivar: { clave: CLAVE_EMBEBIDO, valor: null },
  'apagar-verificacion': { clave: CLAVE_VERIFICACION, valor: 'false' },
  'encender-verificacion': { clave: CLAVE_VERIFICACION, valor: null },
};
if (comando !== 'estado' && !ACCIONES[comando]) {
  console.error(`Comando desconocido: ${comando}. Usa estado | ${Object.keys(ACCIONES).join(' | ')}`);
  process.exit(2);
}
if (comando !== 'estado' && !negocioArg) {
  console.error('Falta --negocio=<slug del negocio o de su tienda>');
  process.exit(2);
}
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL requerida'); process.exit(2); }

const host = new URL(process.env.DATABASE_URL).hostname;
const local = ['localhost', '127.0.0.1', '::1'].includes(host);
console.log(`[clip-embebido] base: ${host}${local ? ' (local)' : ''}`);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
await c.connect();

const SQL_ESTADO = `
  SELECT n.id, n.slug, n.nombre, tc.slug_publico, tc.estado AS tienda,
         ic.proveedor AS proveedor_principal, ic.estado AS integracion,
         (SELECT valor FROM configuracion WHERE negocio_id = n.id AND clave = '${CLAVE_EMBEBIDO}') AS embebido,
         (SELECT valor FROM configuracion WHERE negocio_id = n.id AND clave = '${CLAVE_VERIFICACION}') AS verificacion
    FROM negocios n
    LEFT JOIN tienda_config tc ON tc.negocio_id = n.id
    LEFT JOIN integraciones_canal ic ON ic.negocio_id = n.id AND ic.canal = 'pagos' AND ic.principal = TRUE AND ic.estado = 'activo'
   WHERE ($1 = '' AND tc.negocio_id IS NOT NULL) OR n.slug = $1 OR tc.slug_publico = $1
   ORDER BY n.nombre`;

function pintar(filas) {
  for (const f of filas) {
    const emb = f.embebido === 'true' ? 'EMBEBIDO' : 'redireccionado';
    const ver = f.verificacion === 'false' ? 'APAGADA' : 'encendida';
    console.log(`- ${f.nombre} (${f.slug}${f.slug_publico && f.slug_publico !== f.slug ? ` / tienda ${f.slug_publico}` : ''})`
      + `: tienda ${f.tienda || 'sin tienda'} · proveedor principal ${f.proveedor_principal || 'ninguno'}`
      + ` · checkout ${emb} · verificación al regresar ${ver}`);
  }
}

try {
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout = '5s'");
  const { rows } = await c.query(SQL_ESTADO, [negocioArg]);
  if (!rows.length) throw new Error(negocioArg ? `no existe el negocio ${negocioArg}` : 'no hay negocios con tienda');

  if (comando === 'estado') {
    pintar(rows);
    await c.query('ROLLBACK');
  } else {
    if (rows.length !== 1) throw new Error(`--negocio=${negocioArg} resuelve a ${rows.length} negocios: debe ser uno`);
    const [n] = rows;
    const accion = ACCIONES[comando];
    if (comando === 'activar' && n.proveedor_principal !== 'clip') {
      throw new Error(`${n.slug} no tiene Clip como proveedor principal activo (tiene: ${n.proveedor_principal || 'ninguno'}). `
        + 'Sin Clip la bandera no haría nada: no se activa.');
    }
    console.log('ANTES:'); pintar(rows);
    const anterior = (await c.query('SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2', [n.id, accion.clave])).rows[0]?.valor ?? null;
    if (accion.valor === null) {
      await c.query('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [n.id, accion.clave]);
    } else {
      await c.query(
        `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)
         ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $3`, [n.id, accion.clave, accion.valor]);
    }
    const { rows: despues } = await c.query(SQL_ESTADO, [n.slug]);
    console.log('DESPUÉS:'); pintar(despues);
    if (aplicar) {
      mkdirSync(respaldo, { recursive: true });
      const ruta = join(respaldo, `${comando}-${n.slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      writeFileSync(ruta, JSON.stringify({ negocio_id: n.id, slug: n.slug, clave: accion.clave, valor_anterior: anterior, valor_nuevo: accion.valor }, null, 2));
      console.log(`respaldo: ${ruta}`);
      await c.query('COMMIT');
      console.log('[clip-embebido] APLICADO. Surte efecto en la siguiente petición: no requiere despliegue ni reinicio.');
    } else {
      await c.query('ROLLBACK');
      console.log('[clip-embebido] SIMULACRO: nada se guardó. Repite con --aplicar para confirmar.');
    }
  }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`[clip-embebido] ABORTADO, nada se guardó: ${e.message}`);
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
