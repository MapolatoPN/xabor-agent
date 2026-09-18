#!/usr/bin/env node
// ─── Fallback de comanda a UNA sola impresora (Cocina) ──────────────────────
//
// Qué corrige. Cuando desde Config → Impresoras se asigna el destino «Cocina»
// a varias impresoras, cada una recibe una regla `documento:comanda`. Esa
// regla es el DEFAULT del motor de ruteo (routingEngine.resolverDestinosDeItem):
// todo ítem SIN regla de categoría ni de producto sale en TODAS las impresoras
// que la tengan. En Mapolato Obispado eso mandaba un producto sin regla a
// Bebidas, Chilaquil y COCINA a la vez.
//
// Qué hace. Deja `documento:comanda` únicamente en la impresora indicada y
// borra esa regla -- solo esa: ambito='documento', clave='comanda' -- de las
// demás impresoras del negocio. Las reglas de categoría y de producto no se
// tocan jamás: las estaciones siguen recibiendo lo suyo.
//
// Uso (SOLO LECTURA por defecto):
//   DATABASE_URL=… node scripts/impresion-fallback-solo-cocina.mjs --negocio <uuid> --cocina "COCINA"
//   … --aplicar      ejecuta el borrado en una transacción y lo verifica con el motor
//
// Idempotente: si el fallback ya apunta solo a esa impresora, no hace nada.
// Nunca crea reglas: si la impresora de cocina no tiene todavía su
// `documento:comanda`, se aborta y se pide asignarla desde el panel.
import pg from 'pg';
import { indexarReglas, resolverDestinosDeItem } from '../src/printing/routingEngine.js';

function argumento(nombre) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const negocioId = argumento('negocio');
const nombreCocina = argumento('cocina');
const aplicar = process.argv.includes('--aplicar');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
if (!negocioId || !UUID.test(negocioId)) throw new Error('--negocio <uuid> requerido');
if (!nombreCocina || !nombreCocina.trim()) throw new Error('--cocina "<nombre de la impresora>" requerido');

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const norm = (s) => String(s || '').trim().toLowerCase();

// Simula el motor con un conjunto de reglas: ¿a dónde iría un ítem sin regla?
function destinosDeUnItemSinRegla(filasRutas) {
  const reglas = indexarReglas(filasRutas);
  const { destinos } = resolverDestinosDeItem({ producto: '(producto sin regla)', categoria: null, cantidad: 1 }, reglas);
  return destinos.map((d) => d.impresoraNombre);
}

async function reglasVigentes() {
  const { rows } = await db.query(
    `SELECT r.id, r.ambito, r.clave, r.modo, r.activa, r.impresora_id, i.nombre AS impresora_nombre, i.activa AS impresora_activa
       FROM impresion_rutas r JOIN impresoras i ON i.id = r.impresora_id
      WHERE r.negocio_id = $1 AND r.activa AND i.activa
      ORDER BY r.ambito, r.clave, i.nombre`, [negocioId]);
  return rows;
}

async function main() {
  await db.connect();
  const { rows: [negocio] } = await db.query(`SELECT nombre FROM negocios WHERE id = $1`, [negocioId]);
  if (!negocio) throw new Error(`negocio ${negocioId} no existe`);
  console.log(`[fallback-cocina] negocio «${negocio.nombre}» (${negocioId})`);

  const { rows: impresoras } = await db.query(
    `SELECT i.id, i.nombre, i.activa, t.activo AS terminal_activa
       FROM impresoras i JOIN terminales t ON t.id = i.terminal_id
      WHERE i.negocio_id = $1 ORDER BY i.nombre`, [negocioId]);
  const cocina = impresoras.find((i) => norm(i.nombre) === norm(nombreCocina));
  if (!cocina) throw new Error(`no hay impresora «${nombreCocina}» en este negocio (hay: ${impresoras.map((i) => i.nombre).join(', ') || 'ninguna'})`);
  if (!cocina.activa || !cocina.terminal_activa) throw new Error(`la impresora «${cocina.nombre}» o su Edge están desactivados: no puede ser el único fallback`);

  const antes = await reglasVigentes();
  const fallbackAntes = antes.filter((r) => r.ambito === 'documento' && norm(r.clave) === 'comanda');
  console.log(`[fallback-cocina] reglas documento:comanda hoy: ${fallbackAntes.map((r) => `«${r.impresora_nombre}»`).join(', ') || 'ninguna'}`);
  console.log(`[fallback-cocina] un producto sin regla saldría HOY en: ${destinosDeUnItemSinRegla(antes).join(', ') || 'ninguna impresora'}`);
  console.log(`[fallback-cocina] reglas de categoría/producto (no se tocan): ${antes.filter((r) => r.ambito !== 'documento').length}`);

  if (!fallbackAntes.some((r) => r.impresora_id === cocina.id)) {
    throw new Error(`«${cocina.nombre}» no tiene la regla documento:comanda. Asígnale el destino Cocina desde el panel antes de correr esto; este script solo quita fallbacks sobrantes, nunca crea reglas.`);
  }

  const sobrantes = fallbackAntes.filter((r) => r.impresora_id !== cocina.id);
  if (!sobrantes.length) {
    console.log(`[fallback-cocina] Ya está como debe: el fallback apunta solo a «${cocina.nombre}». Nada que hacer.`);
    return;
  }

  const proyectadas = antes.filter((r) => !sobrantes.some((s) => s.id === r.id));
  const proyeccion = destinosDeUnItemSinRegla(proyectadas);
  if (proyeccion.length !== 1 || norm(proyeccion[0]) !== norm(cocina.nombre)) {
    throw new Error(`la proyección no deja un único destino (${proyeccion.join(', ')}): no se aplica nada`);
  }

  console.log(`[fallback-cocina] se ${aplicar ? 'borran' : 'borrarían'} ${sobrantes.length} regla(s) documento:comanda: ${sobrantes.map((r) => `«${r.impresora_nombre}» (${r.id})`).join(', ')}`);
  console.log(`[fallback-cocina] después, un producto sin regla saldrá solo en: «${proyeccion[0]}»`);
  if (!aplicar) {
    console.log('[fallback-cocina] DRY RUN: no se cambió nada. Repite con --aplicar para ejecutarlo.');
    return;
  }

  await db.query('BEGIN');
  try {
    const { rowCount } = await db.query(
      `DELETE FROM impresion_rutas
        WHERE id = ANY($1::uuid[]) AND negocio_id = $2 AND ambito = 'documento' AND clave = 'comanda'`,
      [sobrantes.map((r) => r.id), negocioId]);
    if (rowCount !== sobrantes.length) throw new Error(`se borraron ${rowCount} filas y se esperaban ${sobrantes.length}`);
    const despues = await reglasVigentes();
    const real = destinosDeUnItemSinRegla(despues);
    if (real.length !== 1 || norm(real[0]) !== norm(cocina.nombre)) throw new Error(`verificación fallida tras el borrado: ${real.join(', ')}`);
    const categorias = despues.filter((r) => r.ambito !== 'documento').length;
    if (categorias !== antes.filter((r) => r.ambito !== 'documento').length) throw new Error('cambió el número de reglas de categoría/producto: se revierte');
    await db.query('COMMIT');
    console.log(`[fallback-cocina] Aplicado. Fallback = «${real[0]}». Reglas de categoría/producto intactas (${categorias}).`);
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

main()
  .catch((e) => { console.error(`[fallback-cocina] ABORTADO: ${e.message}`); process.exitCode = 1; })
  .finally(() => db.end().catch(() => {}));
