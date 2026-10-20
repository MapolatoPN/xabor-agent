// Trabajos de impresión que esperan a un equipo desconectado desde hace más de
// una hora. Desde la Fase 0 ya no se entregan al reconectar (ver
// VIGENCIA_TRABAJO_MIN en impresionService.js), pero siguen contando como
// «pendientes». Este script los marca como cancelados, dejando el motivo.
// Ver docs/impresion-sin-perdidas.md.
//
//   node scripts/ops/impresion-sin-perdidas-2026-10/pendientes-viejos.mjs estado
//   node scripts/ops/impresion-sin-perdidas-2026-10/pendientes-viejos.mjs cancelar --negocio=mapolato-acuna            (simulacro)
//   node scripts/ops/impresion-sin-perdidas-2026-10/pendientes-viejos.mjs cancelar --negocio=mapolato-acuna --aplicar
//   node scripts/ops/impresion-sin-perdidas-2026-10/pendientes-viejos.mjs revertir --archivo=<respaldo.json> --aplicar
//
// Solo toca filas de `impresion_trabajos` del negocio indicado, en estado
// pendiente/entregado/fallido, con más de --minutos (60) de antigüedad y cuyo
// equipo no da señal hace más de 2 minutos. Nada se borra: cambia `estado` a
// 'cancelado' y `motivo`. SIMULACRO por omisión (ROLLBACK); con --aplicar
// guarda antes el estado de cada fila en --respaldo=<dir> (por omisión
// C:/xabor-respaldos/impresion-sin-perdidas-2026-10). `revertir` devuelve a
// cada fila el estado y motivo que tenía.
import pg from 'pg';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MOTIVO = 'Vencido: esperaba a un equipo sin conexión (limpieza Fase 0, 2026-10)';
const argv = process.argv.slice(2);
const valor = (k) => (argv.find(a => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const comando = argv.find(a => !a.startsWith('--')) || 'estado';
const aplicar = argv.includes('--aplicar');
const negocioArg = valor('negocio').trim();
const minutos = Number(valor('minutos') || 60);
const respaldo = valor('respaldo') || 'C:/xabor-respaldos/impresion-sin-perdidas-2026-10';
const archivo = valor('archivo');

if (!['estado', 'cancelar', 'revertir'].includes(comando)) {
  console.error(`Comando desconocido: ${comando}. Usa estado | cancelar | revertir`); process.exit(2);
}
if (comando === 'cancelar' && !negocioArg) { console.error('Falta --negocio=<slug>'); process.exit(2); }
if (comando === 'revertir' && !archivo) { console.error('Falta --archivo=<respaldo.json>'); process.exit(2); }
if (!Number.isInteger(minutos) || minutos < 60) { console.error('--minutos debe ser un entero de 60 o más'); process.exit(2); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL requerida'); process.exit(2); }

const host = new URL(process.env.DATABASE_URL).hostname;
const local = ['localhost', '127.0.0.1', '::1'].includes(host);
console.log(`[pendientes-viejos] base: ${host}${local ? ' (local)' : ''} · ${aplicar ? 'APLICAR' : 'simulacro'}`);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
await c.connect();

// Los mismos criterios que la entrega: vencido por antigüedad y equipo sin
// señal en los últimos 2 minutos (si vuelve, no se le quita nada nuevo).
const SQL_VIEJOS = `
  SELECT j.id, j.estado, j.motivo, j.documento, j.impresora_nombre, n.nombre AS negocio, n.slug,
         coalesce(t.nombre, '(sin equipo)') AS equipo,
         to_char(j.created_at AT TIME ZONE 'America/Matamoros', 'YYYY-MM-DD HH24:MI') AS creado_local
    FROM impresion_trabajos j
    JOIN negocios n ON n.id = j.negocio_id
    LEFT JOIN terminales t ON t.id = j.terminal_id
   WHERE ($1 = '' OR n.slug = $1)
     AND j.estado IN ('pendiente','entregado','fallido')
     AND j.created_at < NOW() - make_interval(mins => $2)
     AND (t.ultima_conexion IS NULL OR t.ultima_conexion < NOW() - INTERVAL '2 minutes')
   ORDER BY n.nombre, equipo, j.created_at`;

function pintar(filas) {
  const grupos = new Map();
  for (const f of filas) {
    const k = `${f.negocio} · ${f.equipo} · ${f.documento} · ${f.estado}`;
    const g = grupos.get(k) || { n: 0, desde: f.creado_local, hasta: f.creado_local };
    g.n++; g.hasta = f.creado_local; grupos.set(k, g);
  }
  if (!grupos.size) console.log('- nada que limpiar');
  for (const [k, g] of grupos) console.log(`- ${k}: ${g.n} (del ${g.desde} al ${g.hasta})`);
}

try {
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout = '5s'");

  if (comando === 'estado') {
    const { rows } = await c.query(SQL_VIEJOS, [negocioArg, minutos]);
    pintar(rows);
    await c.query('ROLLBACK');
  } else if (comando === 'cancelar') {
    const { rows } = await c.query(SQL_VIEJOS, [negocioArg, minutos]);
    if (!rows.length) { console.log(`- ${negocioArg}: nada que limpiar`); await c.query('ROLLBACK'); }
    else {
      pintar(rows);
      const ids = rows.map(r => r.id);
      const { rowCount } = await c.query(
        `UPDATE impresion_trabajos SET estado = 'cancelado', motivo = $2, updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND estado IN ('pendiente','entregado','fallido')`, [ids, MOTIVO]);
      if (rowCount !== ids.length) throw new Error(`se esperaban ${ids.length} filas y cambiaron ${rowCount}: no se aplica nada`);
      if (aplicar) {
        mkdirSync(respaldo, { recursive: true });
        const ruta = join(respaldo, `pendientes-viejos-${negocioArg}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        writeFileSync(ruta, JSON.stringify(rows.map(r => ({ id: r.id, estado: r.estado, motivo: r.motivo })), null, 2));
        await c.query('COMMIT');
        console.log(`APLICADO: ${rowCount} trabajo(s) cancelados. Respaldo para revertir: ${ruta}`);
      } else {
        await c.query('ROLLBACK');
        console.log(`SIMULACRO: cambiarían ${rowCount} trabajo(s). Repite con --aplicar para confirmar.`);
      }
    }
  } else {
    const filas = JSON.parse(readFileSync(archivo, 'utf8'));
    let n = 0;
    for (const f of filas) {
      const r = await c.query(
        `UPDATE impresion_trabajos SET estado = $2, motivo = $3, updated_at = NOW()
          WHERE id = $1 AND estado = 'cancelado' AND motivo = $4`, [f.id, f.estado, f.motivo, MOTIVO]);
      n += r.rowCount;
    }
    if (aplicar) { await c.query('COMMIT'); console.log(`REVERTIDO: ${n} de ${filas.length} trabajo(s).`); }
    else { await c.query('ROLLBACK'); console.log(`SIMULACRO: se revertirían ${n} de ${filas.length}. Repite con --aplicar.`); }
  }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`ERROR: ${e.message} (no se aplicó nada)`);
  process.exitCode = 1;
} finally {
  await c.end();
}
