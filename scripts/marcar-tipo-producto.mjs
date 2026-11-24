#!/usr/bin/env node
// ─── Marca inicial del «Tipo» de producto (Fase 2.4) ────────────────────────
//
// La migración 151 deja todos los productos como «platillo». Este script
// propone (y con --aplicar, guarda) la marca de los que no lo son, con las
// reglas aprobadas el 23-nov-2026 (lineasEstructuradas.tipoPropuestoInicial):
//   · envío  — los de la categoría «ENVIO» (ENVIO 60, ENVIO 70) y cualquiera
//              que ya tuviera la marca vieja opciones.tipo_item = 'envio';
//   · extra  — por nombre exacto: EXTRA, EXTRA 20, EXTRA FRUTA, EXTRA HUEVO,
//              EXTRA TOPPING, TORTILLAS y SALSAS;
//   · bebida — todos los de la categoría «BEBIDAS»;
//   · el resto sigue «platillo» (TACOS incluido: se vende por sus opciones).
// Lo demás de la categoría EXTRAS (o ENVIO) que no entra en esas reglas se
// LISTA como «sin marcar» para decidirlo a mano en Menú › editar › Tipo.
//
// Solo cambia productos que siguen en «platillo»: lo que alguien ya marcó a
// mano en el panel no se toca. Idempotente: la segunda corrida no cambia nada.
// Toca solo menu_productos.tipo, y solo del negocio indicado; ninguna venta.
//
// Uso (SOLO LECTURA por defecto):
//   DATABASE_URL=… node scripts/marcar-tipo-producto.mjs --negocio <uuid|slug|todos> [--aplicar]
import pg from 'pg';
import { normalizarTexto, tipoValido, tipoPropuestoInicial, CATEGORIAS_A_REVISAR } from '../src/services/lineasEstructuradas.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function argumento(nombre) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const negocioArg = argumento('negocio');
const aplicar = process.argv.includes('--aplicar');

function fallar(msg) {
  console.error(`[tipo-producto] ${msg}`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) fallar('DATABASE_URL requerida');
if (!negocioArg) fallar('--negocio <uuid|slug|todos> requerido');

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function negociosAProcesar() {
  if (negocioArg === 'todos') {
    const { rows } = await db.query(
      'SELECT id::text AS id, nombre, slug FROM negocios WHERE activo IS NOT FALSE ORDER BY nombre');
    return rows;
  }
  const { rows } = await db.query(
    UUID.test(negocioArg)
      ? 'SELECT id::text AS id, nombre, slug FROM negocios WHERE id = $1'
      : 'SELECT id::text AS id, nombre, slug FROM negocios WHERE slug = $1',
    [negocioArg]);
  if (!rows.length) fallar(`no existe el negocio «${negocioArg}»`);
  return rows;
}

async function hayColumnaTipo() {
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS n FROM pg_attribute
      WHERE attrelid = to_regclass('menu_productos') AND attname = 'tipo' AND NOT attisdropped`);
  return r.n === 1;
}

async function main() {
  await db.connect();
  const conColumna = await hayColumnaTipo();
  if (aplicar && !conColumna) fallar('falta la migración 151 (menu_productos.tipo): aplícala antes de --aplicar');
  console.log(`[tipo-producto] ${aplicar ? 'APLICANDO' : 'MODO DE PRUEBA (solo lectura, no se escribe nada)'}`
    + `${conColumna ? '' : ' · base sin la 151: todos cuentan como «platillo»'}`);
  if (!aplicar) await db.query('BEGIN TRANSACTION READ ONLY');

  let totalPropuestos = 0;
  for (const neg of await negociosAProcesar()) {
    const { rows: productos } = await db.query(
      `SELECT p.id, p.nombre, COALESCE(to_jsonb(p)->>'tipo', 'platillo') AS tipo, p.opciones, c.nombre AS categoria
         FROM menu_productos p
         LEFT JOIN menu_categorias c ON c.id = p.categoria_id AND c.negocio_id = p.negocio_id
        WHERE p.negocio_id = $1
        ORDER BY c.nombre NULLS LAST, p.nombre, p.id`, [neg.id]);
    const cambios = [];
    const yaMarcados = [];
    const sinMarcar = [];
    for (const p of productos) {
      const propuesto = tipoPropuestoInicial(p);
      if (propuesto && tipoValido(propuesto) && p.tipo === 'platillo') cambios.push({ ...p, propuesto });
      else if (propuesto && p.tipo !== 'platillo') yaMarcados.push(p);
      else if (!propuesto && p.tipo === 'platillo' && CATEGORIAS_A_REVISAR.has(normalizarTexto(p.categoria))) sinMarcar.push(p);
    }
    totalPropuestos += cambios.length;

    console.log(`\n══ ${neg.nombre} (${neg.slug || neg.id}) · ${productos.length} productos ══`);
    for (const tipo of ['envio', 'extra', 'bebida']) {
      const de = cambios.filter((c) => c.propuesto === tipo);
      if (!de.length) continue;
      console.log(`   → ${tipo} (${de.length}):`);
      for (const c of de) console.log(`       #${c.id}  ${c.nombre}  [${c.categoria ?? 'sin categoría'}]`);
    }
    if (!cambios.length) console.log('   Nada que marcar: ya está como debe.');
    if (yaMarcados.length) {
      console.log(`   Ya marcados (no se tocan): ${yaMarcados.map((c) => `#${c.id} ${c.nombre} = ${c.tipo}`).join(' · ')}`);
    }
    if (sinMarcar.length) {
      console.log('   Sin marcar en EXTRAS/ENVIO (siguen «platillo»; decidir a mano en Menú › editar › Tipo):');
      for (const p of sinMarcar) console.log(`       #${p.id}  ${p.nombre}  [${p.categoria}]`);
    }

    if (!aplicar || !cambios.length) continue;
    await db.query('BEGIN');
    try {
      let total = 0;
      for (const tipo of ['envio', 'extra', 'bebida']) {
        const ids = cambios.filter((c) => c.propuesto === tipo).map((c) => Number(c.id));
        if (!ids.length) continue;
        const { rowCount } = await db.query(
          `UPDATE menu_productos SET tipo = $1
            WHERE negocio_id = $2 AND id = ANY($3::int[]) AND tipo = 'platillo'`, [tipo, neg.id, ids]);
        if (rowCount !== ids.length) throw new Error(`«${tipo}»: se cambiaron ${rowCount} y se esperaban ${ids.length} (¿alguien editó el menú a la vez?)`);
        total += rowCount;
      }
      await db.query('COMMIT');
      console.log(`   Aplicado: ${total} producto(s) marcados.`);
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      throw e;
    }
  }
  if (!aplicar) {
    await db.query('ROLLBACK');
    console.log(`\n[tipo-producto] MODO DE PRUEBA: no se cambió nada (${totalPropuestos} propuestos). Repite con --aplicar para guardarlo.`);
  }
}

main()
  .catch((e) => { console.error(`[tipo-producto] ABORTADO: ${e.message}`); process.exitCode = 1; })
  .finally(() => db.end().catch(() => {}));
