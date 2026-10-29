// scripts/activar-imagenes-recepcion.mjs contra Postgres local: activa las dos
// claves con respaldo, se niega sin el modo formulario, no pisa el respaldo al
// repetir, revierte a los valores de antes y no toca lo que alguien cambió.
// Base local test_botones_*. Cada caso crea su negocio.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/services/database.js';
import { exigirBaseBotonesLocal } from './lib-botones-local.mjs';
import { activar, revertir, CLAVES, CLAVE_RESPALDO } from '../scripts/activar-imagenes-recepcion.mjs';

exigirBaseBotonesLocal();
let n = 0, fallidas = 0;
async function caso(nombre, fn) {
  try { await fn(); console.log(`OK activar-imagenes ${++n}: ${nombre}`); }
  catch (e) { fallidas++; console.log(`FALLA activar-imagenes: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}`); }
}
async function negocio(cfg = { whatsapp_ia_modo_v1: 'formulario' }) {
  const { rows: [r] } = await pool.query('INSERT INTO negocios(nombre,slug) VALUES($1,$2) RETURNING id', ['Fotos', `fotos-${randomUUID()}`]);
  for (const [k, v] of Object.entries(cfg)) await pool.query('INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)', [r.id, k, v]);
  return r.id;
}
const cfg = async (id) => Object.fromEntries((await pool.query(`SELECT clave, valor FROM configuracion WHERE negocio_id=$1
  AND clave = ANY($2)`, [id, [...CLAVES, CLAVE_RESPALDO]])).rows.map((r) => [r.clave, r.valor]));
async function enTx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await fn(c); await c.query('COMMIT'); }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

try {
  await caso('activa las dos claves y guarda los valores de antes', async () => {
    const id = await negocio({ whatsapp_ia_modo_v1: 'formulario', vision_imagenes: 'false' });
    await enTx((c) => activar(c, id));
    const v = await cfg(id);
    assert.equal(v.vision_imagenes, 'true'); assert.equal(v.whatsapp_ia_imagenes_v1, 'true');
    assert.deepEqual(JSON.parse(v[CLAVE_RESPALDO]).antes, { vision_imagenes: 'false', whatsapp_ia_imagenes_v1: null });
  });
  await caso('sin el modo formulario se niega y no escribe nada', async () => {
    const id = await negocio({});
    await assert.rejects(enTx((c) => activar(c, id)), /modo formulario no está encendido/);
    assert.deepEqual(await cfg(id), {});
  });
  await caso('activar dos veces conserva el primer respaldo; revertir regresa a lo de antes', async () => {
    const id = await negocio({ whatsapp_ia_modo_v1: 'formulario', vision_imagenes: 'false' });
    await enTx((c) => activar(c, id));
    await enTx((c) => activar(c, id));
    assert.deepEqual(JSON.parse((await cfg(id))[CLAVE_RESPALDO]).antes.vision_imagenes, 'false');
    await enTx((c) => revertir(c, id));
    assert.deepEqual(await cfg(id), { vision_imagenes: 'false' });
  });
  await caso('revertir no pisa una clave que alguien cambió después', async () => {
    const id = await negocio();
    await enTx((c) => activar(c, id));
    await pool.query(`UPDATE configuracion SET valor='false' WHERE negocio_id=$1 AND clave='vision_imagenes'`, [id]);
    await enTx((c) => revertir(c, id));
    assert.deepEqual(await cfg(id), { vision_imagenes: 'false' });
  });
  await caso('revertir sin respaldo se niega', async () => {
    const id = await negocio();
    await assert.rejects(enTx((c) => revertir(c, id)), /no hay respaldo/);
  });
} finally { await pool.end().catch(() => {}); }
console.log(`\n${n} pasadas, ${fallidas} fallidas`);
process.exit(fallidas ? 1 : 0);
