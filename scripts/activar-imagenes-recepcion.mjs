// Operación explícita del dueño: enciende (o revierte) que el bot del modo
// formulario conteste fotos (recepcionista.js §4b). Escribe juntas, en una
// transacción y con respaldo, las dos claves que hacen falta:
//
//   vision_imagenes           el lector general de imágenes (vision.js)
//   whatsapp_ia_imagenes_v1   la regla de fotos del recepcionista (R2)
//
// No envía mensajes ni toca Meta. Sin --aplicar es un SIMULACRO: hace todo
// dentro de la transacción, imprime el resultado y la deshace (ROLLBACK).
//
//   node scripts/activar-imagenes-recepcion.mjs <negocioId> estado
//   node scripts/activar-imagenes-recepcion.mjs <negocioId> activar  [--aplicar]
//   node scripts/activar-imagenes-recepcion.mjs <negocioId> revertir [--aplicar]
//
// Activar exige el modo formulario o recepcionista encendido: sin él, las
// fotos irían al bot anterior con el lector general, que no es lo aprobado.
// El respaldo (whatsapp_ia_imagenes_respaldo) guarda los valores de antes y se
// escribe una sola vez; revertir los restaura y no pisa una clave que alguien
// haya cambiado después (si ya no vale 'true', se deja como está).
import { pathToFileURL } from 'node:url';
import { pool } from '../src/services/database.js';
import { CLAVES_IA, MODOS_IA } from '../src/mesero-agente/recepcionista.js';

export const CLAVES = Object.freeze(['vision_imagenes', CLAVES_IA.IMAGENES]);
export const CLAVE_RESPALDO = 'whatsapp_ia_imagenes_respaldo';
const INFORMATIVAS = [CLAVES_IA.MODO, CLAVES_IA.ALCANCE, 'whatsapp_comprobantes_vision_v1'];
const USO = 'uso: node scripts/activar-imagenes-recepcion.mjs <negocioId> estado|activar|revertir [--aplicar]';

async function leer(db, negocioId) {
  const { rows } = await db.query(`SELECT clave, valor FROM configuracion WHERE negocio_id=$1 AND clave = ANY($2) FOR UPDATE`,
    [negocioId, [...CLAVES, CLAVE_RESPALDO, ...INFORMATIVAS]]);
  return Object.fromEntries(rows.map((r) => [r.clave, r.valor]));
}
const poner = (db, negocioId, clave, valor) => db.query(`INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)
  ON CONFLICT(negocio_id,clave) DO UPDATE SET valor=EXCLUDED.valor`, [negocioId, clave, valor]);
const mostrar = (titulo, cfg) => console.log(`${titulo}\n${[...CLAVES, CLAVE_RESPALDO, ...INFORMATIVAS]
  .map((k) => `  ${k} = ${cfg[k] ?? '(sin valor)'}`).join('\n')}`);

export async function activar(db, negocioId) {
  const cfg = await leer(db, negocioId);
  if (!MODOS_IA.includes(cfg[CLAVES_IA.MODO])) {
    throw new Error(`el modo formulario no está encendido (${CLAVES_IA.MODO}=${cfg[CLAVES_IA.MODO] ?? 'sin valor'}): no se activa`);
  }
  if (!cfg[CLAVE_RESPALDO]) {
    await poner(db, negocioId, CLAVE_RESPALDO, JSON.stringify({ fecha: new Date().toISOString(),
      antes: Object.fromEntries(CLAVES.map((k) => [k, cfg[k] ?? null])) }));
  }
  for (const k of CLAVES) await poner(db, negocioId, k, 'true');
}

export async function revertir(db, negocioId) {
  const cfg = await leer(db, negocioId);
  if (!cfg[CLAVE_RESPALDO]) throw new Error('no hay respaldo: nada que revertir');
  const { antes = {} } = JSON.parse(cfg[CLAVE_RESPALDO]);
  for (const k of CLAVES) {
    if (cfg[k] !== 'true') { console.log(`  ${k} ya no vale 'true' (${cfg[k] ?? 'sin valor'}): no se toca`); continue; }
    if (antes[k] === null || antes[k] === undefined) {
      await db.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [negocioId, k]);
    } else await poner(db, negocioId, k, antes[k]);
  }
  await db.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [negocioId, CLAVE_RESPALDO]);
}

async function main() {
  const [negocioId, accion = 'estado', ...resto] = process.argv.slice(2);
  const aplicar = resto.includes('--aplicar');
  if (!/^[0-9a-f-]{36}$/i.test(negocioId || '') || !['estado', 'activar', 'revertir'].includes(accion)) {
    console.error(USO); process.exitCode = 2; return;
  }
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: [n] } = await db.query('SELECT nombre FROM negocios WHERE id=$1', [negocioId]);
    if (!n) throw new Error('negocio no encontrado');
    mostrar(`${n.nombre} · antes:`, await leer(db, negocioId));
    if (accion === 'estado') { await db.query('ROLLBACK'); return; }
    if (accion === 'activar') await activar(db, negocioId);
    else await revertir(db, negocioId);
    mostrar(`${n.nombre} · después de ${accion}${aplicar ? '' : ' (SIMULACRO: se deshace)'}:`, await leer(db, negocioId));
    await db.query(aplicar ? 'COMMIT' : 'ROLLBACK');
    console.log(aplicar ? `${accion}: APLICADO` : `${accion}: simulacro, no cambió nada. Repite con --aplicar para hacerlo.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error(`FALLO: ${e.message}`); process.exitCode = 1;
  } finally {
    db.release(); await pool.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
