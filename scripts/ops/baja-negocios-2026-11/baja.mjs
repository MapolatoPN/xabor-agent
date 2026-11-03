// Baja reversible de los negocios que ya no operan en Xabor.
//
//   node scripts/ops/baja-negocios-2026-11/baja.mjs estado
//   node scripts/ops/baja-negocios-2026-11/baja.mjs desactivar                 (simulacro)
//   node scripts/ops/baja-negocios-2026-11/baja.mjs desactivar --aplicar
//   node scripts/ops/baja-negocios-2026-11/baja.mjs revertir --desde=<respaldo.json> [--aplicar]
//
// Decisión de Mario (2-nov-2026): en Xabor solo se quedan Mapolato Obispado y
// Mapolato Acuña. `desactivar` hace con cada negocio de BAJA lo mismo que los
// botones de Superadmin, con la misma auditoría:
//   · «Desactivar negocio»: estado 'suspendido', activo FALSE
//     (cambiar_estado_negocio);
//   · «Suspender» de cada integración en 'activo': estado 'suspendido',
//     activo FALSE (integracion_estado_actualizado).
// NO borra nada: pedidos, clientes, mensajes, usuarios e historial se quedan.
//
// Nonna Maye NO está en la lista a propósito. Tiene integraciones vivas
// (WhatsApp, Rappi, pagos) y variables globales del servidor ligadas a ella:
// va aparte, después de revisar que Obispado y Acuña no dependan de nada suyo.
// Si un negocio de SE_QUEDAN apareciera en la baja, el script aborta.
//
// El actor de la auditoría es el único superadmin activo; si hay cero o más
// de uno, aborta. SIMULACRO por omisión (la transacción termina en ROLLBACK).
// Con --aplicar, `desactivar` guarda antes el estado anterior en
// --respaldo=<dir> (por omisión C:/xabor-respaldos/baja-negocios-2026-11).
// `revertir` regresa exactamente lo que guardó ese respaldo, solo si sigue
// como lo dejó la baja; si alguien cambió algo, aborta sin tocar nada.
import pg from 'pg';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SE_QUEDAN = Object.freeze(['mapolato-obispado', 'mapolato-acuna']);
export const BAJA = Object.freeze([
  'alora-floreria-y-eventos', 'carnitas-moreno', 'dcheve-para-llevar',
  'fase3a-neg-a', 'fase3a-neg-b',
  'faseb-negocio-a', 'faseb-negocio-b', 'faseb-negocio-c', 'faseb-negocio-d',
  'promo-cond-a', 'promo-cond-b', 'promo-eng-a', 'promo-eng-b', 'promo-guiado-a', 'promo-guiado-b',
  'promo-info-a', 'promo-info-b', 'promo-prod-a', 'promo-prod-b',
]);
export const RESPALDO_POR_OMISION = 'C:/xabor-respaldos/baja-negocios-2026-11';
const ORIGEN = 'scripts/ops/baja-negocios-2026-11';

/** El único superadmin activo (usuarios.id). Cero o varios: no se adivina. */
export async function buscarActor(c) {
  const { rows } = await c.query(
    `SELECT ap.usuario_id FROM administradores_plataforma ap JOIN usuarios u ON u.id = ap.usuario_id
      WHERE ap.activo AND u.activo`);
  if (rows.length !== 1) throw new Error(`se esperaba exactamente 1 superadmin activo y hay ${rows.length}`);
  return rows[0].usuario_id;
}

async function leer(c, slugs) {
  const { rows: negocios } = await c.query(
    `SELECT id, slug, nombre, estado, activo FROM negocios WHERE slug = ANY($1) ORDER BY nombre`, [slugs]);
  const { rows: integraciones } = await c.query(
    `SELECT ic.id, ic.negocio_id, n.slug, ic.canal, ic.proveedor, ic.estado, ic.activo
       FROM integraciones_canal ic JOIN negocios n ON n.id = ic.negocio_id
      WHERE n.slug = ANY($1) ORDER BY n.nombre, ic.canal`, [slugs]);
  return { negocios, integraciones };
}

function pintar({ negocios, integraciones }, log) {
  for (const n of negocios) {
    const integ = integraciones.filter((i) => i.negocio_id === n.id)
      .map((i) => `${i.canal}/${i.proveedor ?? '-'}:${i.estado}${i.activo ? '' : '(inactiva)'}`).join(', ');
    log(`- ${n.nombre} (${n.slug}): ${n.estado}${n.activo ? '' : ' (inactivo)'}${integ ? ` · ${integ}` : ''}`);
  }
}

async function auditar(c, actor, accion, negocioId, anterior, nuevo, contexto = {}) {
  await c.query(
    `INSERT INTO auditoria_plataforma (superadmin_id, actor_usuario_id, accion, negocio_id, estado_anterior, estado_nuevo, contexto)
     VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
    [actor, accion, negocioId, JSON.stringify(anterior), JSON.stringify(nuevo), JSON.stringify({ ...contexto, origen: ORIGEN })]);
}

/**
 * Corre un comando dentro de UNA transacción. Devuelve { ruta } con el
 * respaldo si `desactivar --aplicar` lo escribió. Lanza (y deja ROLLBACK)
 * ante cualquier guarda.
 */
export async function ejecutar(c, {
  comando, aplicar = false, desde = null, respaldo = RESPALDO_POR_OMISION,
  baja = BAJA, seQuedan = SE_QUEDAN, log = console.log, ahora = () => new Date(),
} = {}) {
  if (!['estado', 'desactivar', 'revertir'].includes(comando)) throw new Error(`comando desconocido: ${comando}`);
  const prohibidos = baja.filter((s) => seQuedan.includes(s));
  if (prohibidos.length) throw new Error(`${prohibidos.join(', ')} está en SE_QUEDAN: no se da de baja`);
  let resultado = {};
  await c.query('BEGIN');
  try {
    await c.query("SET LOCAL lock_timeout = '5s'");
    if (comando === 'estado') {
      log('SE QUEDAN:'); pintar(await leer(c, [...seQuedan]), log);
      log('BAJA:'); pintar(await leer(c, [...baja]), log);
      await c.query('ROLLBACK');
      return resultado;
    }
    const actor = await buscarActor(c);
    const quedan = await leer(c, [...seQuedan]);
    if (quedan.negocios.length !== seQuedan.length) {
      throw new Error(`no se encontraron todos los negocios que se quedan (${quedan.negocios.map((n) => n.slug).join(', ') || 'ninguno'})`);
    }

    if (comando === 'desactivar') {
      const antes = await leer(c, [...baja]);
      const faltan = baja.filter((s) => !antes.negocios.some((n) => n.slug === s));
      if (faltan.length) throw new Error(`no existen en esta base: ${faltan.join(', ')}`);
      log('ANTES:'); pintar(antes, log);
      const negocios = antes.negocios.filter((n) => n.estado !== 'suspendido' || n.activo);
      const integraciones = antes.integraciones.filter((i) => i.estado === 'activo');
      if (!negocios.length && !integraciones.length) {
        log('Nada que hacer: todos ya están dados de baja.');
        await c.query('ROLLBACK');
        return resultado;
      }
      for (const n of negocios) {
        await c.query(`UPDATE negocios SET estado = 'suspendido', activo = FALSE WHERE id = $1`, [n.id]);
        await auditar(c, actor, 'cambiar_estado_negocio', n.id, { estado: n.estado, activo: n.activo },
          { estado: 'suspendido', activo: false });
      }
      for (const i of integraciones) {
        await c.query(`UPDATE integraciones_canal SET estado = 'suspendido', activo = FALSE, actualizado_por = $2, updated_at = NOW()
          WHERE id = $1`, [i.id, actor]);
        await auditar(c, actor, 'integracion_estado_actualizado', i.negocio_id, { estado: i.estado },
          { estado: 'suspendido' }, { canal: i.canal, proveedor: i.proveedor });
      }
      log('DESPUÉS:'); pintar(await leer(c, [...baja]), log);
      log(`${negocios.length} negocio(s) y ${integraciones.length} integración(es) a 'suspendido'.`);
      if (aplicar) {
        mkdirSync(respaldo, { recursive: true });
        const ruta = join(respaldo, `desactivar-${ahora().toISOString().replace(/[:.]/g, '-')}.json`);
        writeFileSync(ruta, JSON.stringify({
          comando: 'desactivar',
          negocios: negocios.map(({ id, slug, estado, activo }) => ({ id, slug, estado, activo })),
          integraciones: integraciones.map(({ id, negocio_id, slug, canal, proveedor, estado, activo }) =>
            ({ id, negocio_id, slug, canal, proveedor, estado, activo })),
        }, null, 2));
        resultado = { ruta };
        log(`respaldo: ${ruta}`);
        log(`para revertir: node ${ORIGEN}/baja.mjs revertir --desde="${ruta}" --aplicar`);
      }
    } else {
      if (!desde) throw new Error('revertir necesita --desde=<respaldo que dejó desactivar --aplicar>');
      const guardado = JSON.parse(readFileSync(desde, 'utf8'));
      if (guardado?.comando !== 'desactivar' || !Array.isArray(guardado.negocios) || !Array.isArray(guardado.integraciones)) {
        throw new Error(`${desde} no es un respaldo de desactivar`);
      }
      const ajenos = guardado.negocios.map((n) => n.slug).filter((s) => seQuedan.includes(s));
      if (ajenos.length) throw new Error(`el respaldo trae ${ajenos.join(', ')}, que se quedan: no se toca`);
      const ids = guardado.negocios.map((n) => n.id);
      const idsInteg = guardado.integraciones.map((i) => i.id);
      const { rows: negActuales } = await c.query(`SELECT id, slug, estado, activo FROM negocios WHERE id = ANY($1::uuid[])`, [ids]);
      const { rows: intActuales } = await c.query(`SELECT id, estado, activo FROM integraciones_canal WHERE id = ANY($1::uuid[])`, [idsInteg]);
      const nMap = new Map(negActuales.map((n) => [n.id, n]));
      const iMap = new Map(intActuales.map((i) => [i.id, i]));
      for (const n of guardado.negocios) {
        const a = nMap.get(n.id);
        if (!a) throw new Error(`el negocio ${n.slug} ya no existe`);
        if (a.estado !== 'suspendido' || a.activo) throw new Error(`${n.slug} está en '${a.estado}': alguien lo cambió; no se toca nada`);
      }
      for (const i of guardado.integraciones) {
        const a = iMap.get(i.id);
        if (!a) throw new Error(`la integración ${i.canal} de ${i.slug} ya no existe`);
        if (a.estado !== 'suspendido' || a.activo) throw new Error(`la integración ${i.canal} de ${i.slug} está en '${a.estado}': alguien la cambió; no se toca nada`);
      }
      for (const n of guardado.negocios) {
        await c.query(`UPDATE negocios SET estado = $2, activo = $3 WHERE id = $1`, [n.id, n.estado, n.activo]);
        await auditar(c, actor, 'cambiar_estado_negocio', n.id, { estado: 'suspendido', activo: false },
          { estado: n.estado, activo: n.activo }, { revierte: desde });
      }
      for (const i of guardado.integraciones) {
        await c.query(`UPDATE integraciones_canal SET estado = $2, activo = $3, actualizado_por = $4, updated_at = NOW() WHERE id = $1`,
          [i.id, i.estado, i.activo, actor]);
        await auditar(c, actor, 'integracion_estado_actualizado', i.negocio_id, { estado: 'suspendido' },
          { estado: i.estado }, { canal: i.canal, proveedor: i.proveedor, revierte: desde });
      }
      log(`Se regresan ${guardado.negocios.length} negocio(s) y ${guardado.integraciones.length} integración(es) a como estaban.`);
    }

    if (aplicar) {
      await c.query('COMMIT');
      log('APLICADO.');
    } else {
      await c.query('ROLLBACK');
      log('SIMULACRO: nada se guardó. Repite con --aplicar para confirmar.');
    }
    return resultado;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const valor = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
  const comando = argv.find((a) => !a.startsWith('--')) || 'estado';
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL requerida'); process.exit(2); }
  const host = new URL(process.env.DATABASE_URL).hostname;
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  console.log(`[baja-negocios] base: ${host}${local ? ' (local)' : ''} · comando: ${comando}${argv.includes('--aplicar') ? ' · APLICAR' : ''}`);
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
  await c.connect();
  try {
    await ejecutar(c, { comando, aplicar: argv.includes('--aplicar'), desde: valor('desde') || null,
      respaldo: valor('respaldo') || RESPALDO_POR_OMISION });
  } catch (e) {
    console.error(`[baja-negocios] ABORTADO, nada se guardó: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await c.end().catch(() => {});
  }
}
