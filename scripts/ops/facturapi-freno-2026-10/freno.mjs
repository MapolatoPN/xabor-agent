// Freno de las llamadas de Xabor a Facturapi, sin despliegue.
//
//   node scripts/ops/facturapi-freno-2026-10/freno.mjs estado
//   node scripts/ops/facturapi-freno-2026-10/freno.mjs frenar                (simulacro)
//   node scripts/ops/facturapi-freno-2026-10/freno.mjs frenar --aplicar
//   node scripts/ops/facturapi-freno-2026-10/freno.mjs reanudar --desde=<respaldo.json> --aplicar
//
// Xabor lee la llave de Facturapi de la base en cada llamada
// (obtenerCredencialesFacturapiDescifradas) y, si la integración no está en
// 'activo', corta ANTES de salir a la red. `frenar` pasa a 'suspendido' las
// integraciones de Facturapi activas (todas, o la de --negocio=<slug>): desde
// la siguiente llamada Xabor no consulta, crea ni cierra recibos. La llave
// cifrada se conserva. `reanudar` regresa exactamente las integraciones que
// guardó el respaldo de `frenar`, ni una más.
//
// SIMULACRO por omisión (la transacción termina en ROLLBACK). Con --aplicar,
// `frenar` guarda antes el estado anterior en --respaldo=<dir>
// (por omisión C:/xabor-respaldos/facturapi-freno-2026-10).
import pg from 'pg';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const valor = (k) => (argv.find(a => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const comando = argv.find(a => !a.startsWith('--')) || 'estado';
const aplicar = argv.includes('--aplicar');
const negocioArg = valor('negocio').trim();
const respaldo = valor('respaldo') || 'C:/xabor-respaldos/facturapi-freno-2026-10';
const desde = valor('desde');

if (!['estado', 'frenar', 'reanudar'].includes(comando)) {
  console.error(`Comando desconocido: ${comando}. Usa estado | frenar | reanudar`);
  process.exit(2);
}
if (comando === 'reanudar' && !desde) {
  console.error('reanudar necesita --desde=<archivo de respaldo que dejó frenar --aplicar>');
  process.exit(2);
}
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL requerida'); process.exit(2); }

const host = new URL(process.env.DATABASE_URL).hostname;
const local = ['localhost', '127.0.0.1', '::1'].includes(host);
console.log(`[facturapi-freno] base: ${host}${local ? ' (local)' : ''}`);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
await c.connect();

// Cuántos recibos tocaría el barrido de reconciliación (abierto/creando/error)
// y cuántos ya vencieron: los vencidos no pueden cambiar y aun así se consultan.
const SQL_ESTADO = `
  SELECT ic.id, n.slug, n.nombre, ic.estado, ic.activo,
         (SELECT count(*) FROM facturacion_recibos r
           WHERE r.negocio_id = n.id AND r.estado IN ('abierto','creando','error'))::int AS recibos_en_barrido,
         (SELECT count(*) FROM facturacion_recibos r
           WHERE r.negocio_id = n.id AND r.estado IN ('abierto','creando','error')
             AND r.expires_at < NOW())::int AS vencidos
    FROM integraciones_canal ic
    JOIN negocios n ON n.id = ic.negocio_id
   WHERE ic.canal = 'facturacion' AND ic.proveedor = 'facturapi'
     AND ($1 = '' OR n.slug = $1)
   ORDER BY n.nombre`;

function pintar(filas) {
  if (!filas.length) { console.log('  (sin integraciones de Facturapi)'); return; }
  for (const f of filas) {
    console.log(`- ${f.nombre} (${f.slug}): integración ${f.estado}${f.activo ? '' : ' (inactiva)'}`
      + ` · recibos en el barrido: ${f.recibos_en_barrido} (vencidos: ${f.vencidos})`);
  }
}

try {
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout = '5s'");
  const { rows } = await c.query(SQL_ESTADO, [negocioArg]);
  if (negocioArg && !rows.length) throw new Error(`no existe integración de Facturapi para ${negocioArg}`);

  if (comando === 'estado') {
    pintar(rows);
    await c.query('ROLLBACK');
  } else {
    let objetivo;
    if (comando === 'frenar') {
      objetivo = rows.filter(f => f.estado === 'activo').map(f => ({ id: f.id, slug: f.slug, estado: f.estado, activo: f.activo }));
      if (!objetivo.length) throw new Error('no hay integraciones de Facturapi activas: nada que frenar');
    } else {
      const guardado = JSON.parse(readFileSync(desde, 'utf8'));
      if (guardado?.comando !== 'frenar' || !Array.isArray(guardado.integraciones)) throw new Error(`${desde} no es un respaldo de frenar`);
      objetivo = guardado.integraciones;
      const actuales = new Map(rows.map(f => [f.id, f]));
      for (const o of objetivo) {
        const a = actuales.get(o.id);
        if (!a) throw new Error(`la integración ${o.id} (${o.slug}) ya no existe`);
        if (a.estado !== 'suspendido') throw new Error(`${o.slug} está en '${a.estado}', no en 'suspendido': alguien la cambió; no se toca`);
      }
    }
    console.log('ANTES:'); pintar(rows);
    for (const o of objetivo) {
      const [estado, activo] = comando === 'frenar' ? ['suspendido', false] : [o.estado, o.activo];
      await c.query('UPDATE integraciones_canal SET estado = $2, activo = $3, updated_at = NOW() WHERE id = $1', [o.id, estado, activo]);
    }
    const { rows: despues } = await c.query(SQL_ESTADO, [negocioArg]);
    console.log('DESPUÉS:'); pintar(despues);
    if (aplicar) {
      if (comando === 'frenar') {
        mkdirSync(respaldo, { recursive: true });
        const ruta = join(respaldo, `frenar-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        writeFileSync(ruta, JSON.stringify({ comando: 'frenar', integraciones: objetivo }, null, 2));
        console.log(`respaldo: ${ruta}`);
        console.log(`para reanudar: node scripts/ops/facturapi-freno-2026-10/freno.mjs reanudar --desde="${ruta}" --aplicar`);
      }
      await c.query('COMMIT');
      console.log('[facturapi-freno] APLICADO. Surte efecto en la siguiente llamada: no requiere despliegue ni reinicio.');
    } else {
      await c.query('ROLLBACK');
      console.log('[facturapi-freno] SIMULACRO: nada se guardó. Repite con --aplicar para confirmar.');
    }
  }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`[facturapi-freno] ABORTADO, nada se guardó: ${e.message}`);
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
