// Baja reversible de negocios (scripts/ops/baja-negocios-2026-11/baja.mjs).
//
// El 2-nov-2026 Mario decidió quedarse solo con Mapolato Obispado y Acuña. El
// script desactiva los demás como los botones de Superadmin. Esto defiende:
//   · el simulacro no guarda nada;
//   · los negocios que se quedan no se tocan, ni aunque alguien los ponga en
//     la lista;
//   · solo se suspenden integraciones en 'activo'; nada se borra;
//   · cada cambio deja su auditoría con el único superadmin activo;
//   · el respaldo permite revertir exactamente, pero no pisa un cambio ajeno.
//
// Base local (test_botones_*). Listas propias con slugs únicos, nunca las reales.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exigirBaseBotonesLocal } from './lib-botones-local.mjs';

exigirBaseBotonesLocal();
const { pool } = await import('../src/services/database.js');
const { ejecutar, buscarActor, BAJA, SE_QUEDAN } = await import('../scripts/ops/baja-negocios-2026-11/baja.mjs');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const suf = randomUUID().slice(0, 8);
const s = (n) => `${n}-${suf}`;
const QUEDAN = [s('queda-a'), s('queda-b')];
const BAJA_T = [s('baja-wa'), s('baja-pagos'), s('baja-sola'), s('baja-ya-suspendido')];
const respaldo = mkdtempSync(join(tmpdir(), 'baja-negocios-'));
const salida = [];
const log = (m) => salida.push(String(m));

let c;
const ids = {};
async function crearNegocio(slug, { estado = 'activo' } = {}) {
  const { rows: [n] } = await pool.query(`INSERT INTO negocios (nombre, slug, estado, activo) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`Prueba ${slug}`, slug, estado, estado === 'activo']);
  ids[slug] = n.id;
  return n.id;
}
async function crearIntegracion(negocioId, canal, proveedor, estado, activo) {
  const { rows: [i] } = await pool.query(
    `INSERT INTO integraciones_canal (negocio_id, canal, proveedor, identificador, estado, activo)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [negocioId, canal, proveedor, `ID-${randomUUID()}`, estado, activo]);
  return i.id;
}
async function negocio(slug) {
  return (await pool.query(`SELECT estado, activo FROM negocios WHERE slug = $1`, [slug])).rows[0];
}
async function integraciones(slug) {
  return (await pool.query(`SELECT ic.canal, ic.estado, ic.activo, ic.actualizado_por FROM integraciones_canal ic
    JOIN negocios n ON n.id = ic.negocio_id WHERE n.slug = $1 ORDER BY ic.canal`, [slug])).rows;
}
async function auditorias() {
  return (await pool.query(`SELECT accion, superadmin_id, negocio_id, estado_anterior, estado_nuevo, contexto
    FROM auditoria_plataforma WHERE contexto->>'origen' = 'scripts/ops/baja-negocios-2026-11'
      AND negocio_id = ANY($1::uuid[]) ORDER BY created_at, id`, [Object.values(ids)])).rows;
}
const correr = (opciones) => ejecutar(c, { baja: BAJA_T, seQuedan: QUEDAN, respaldo, log, ...opciones });

let actor;
try {
  for (const q of QUEDAN) await crearNegocio(q);
  // Exactamente un superadmin activo: el de esta suite.
  const { rows: [u] } = await pool.query(`INSERT INTO usuarios (negocio_id, nombre, email, activo) VALUES ($1, 'SA baja', $2, TRUE) RETURNING id`,
    [ids[QUEDAN[0]], `sa-baja-${suf}@test.local`]);
  actor = u.id;
  await pool.query(`UPDATE administradores_plataforma SET activo = FALSE WHERE activo`);
  await pool.query(`INSERT INTO administradores_plataforma (usuario_id, activo) VALUES ($1, TRUE)`, [actor]);

  await crearIntegracion(ids[QUEDAN[0]], 'whatsapp', 'meta', 'activo', true);
  await crearNegocio(BAJA_T[0]);
  await crearIntegracion(ids[BAJA_T[0]], 'whatsapp', 'meta', 'activo', true);
  await crearNegocio(BAJA_T[1]);
  // Como Carnitas: pagos ya 'suspendido' (con activo TRUE): no se toca.
  await crearIntegracion(ids[BAJA_T[1]], 'pagos', 'clip', 'suspendido', true);
  await crearNegocio(BAJA_T[2]);
  await crearNegocio(BAJA_T[3], { estado: 'suspendido' });
  c = await pool.connect();

  await t('01. las listas reales: Obispado y Acuña se quedan, Nonna va aparte, 19 salen', () => {
    assert.deepEqual([...SE_QUEDAN].sort(), ['mapolato-acuna', 'mapolato-obispado']);
    assert.equal(BAJA.length, 19);
    assert.ok(!BAJA.includes('nonna-maye'), 'Nonna entró a la baja sin revisar sus dependencias');
    assert.ok(!BAJA.some((x) => SE_QUEDAN.includes(x)));
    assert.equal(new Set(BAJA).size, BAJA.length, 'slug repetido');
  });

  await t('02. buscarActor: exige exactamente un superadmin activo', async () => {
    assert.equal(await buscarActor(c), actor);
    const falso = (n) => ({ query: async () => ({ rows: Array.from({ length: n }, (_, i) => ({ usuario_id: `u${i}` })) }) });
    await assert.rejects(buscarActor(falso(0)), /exactamente 1/);
    await assert.rejects(buscarActor(falso(2)), /exactamente 1/);
  });

  await t('03. «estado» no cambia nada', async () => {
    await correr({ comando: 'estado' });
    assert.equal((await negocio(BAJA_T[0])).activo, true);
    assert.ok(salida.some((l) => l.includes(BAJA_T[0])));
  });

  await t('04. simulacro: muestra el antes y el después, pero no guarda nada ni deja respaldo', async () => {
    const r = await correr({ comando: 'desactivar' });
    assert.equal(r.ruta, undefined);
    assert.deepEqual(await negocio(BAJA_T[0]), { estado: 'activo', activo: true });
    assert.equal((await integraciones(BAJA_T[0]))[0].estado, 'activo');
    assert.equal((await auditorias()).length, 0);
    assert.ok(salida.some((l) => /SIMULACRO/.test(l)));
  });

  await t('05. un negocio que se queda puesto en la baja: aborta antes de tocar nada', async () => {
    await assert.rejects(correr({ comando: 'desactivar', aplicar: true, baja: [...BAJA_T, QUEDAN[0]] }), /SE_QUEDAN/);
    assert.equal((await negocio(BAJA_T[0])).activo, true);
  });

  await t('06. un slug que no existe: aborta sin guardar', async () => {
    await assert.rejects(correr({ comando: 'desactivar', aplicar: true, baja: [...BAJA_T, s('no-existe')] }), /no existen/);
    assert.equal((await negocio(BAJA_T[0])).activo, true);
    assert.equal((await auditorias()).length, 0);
  });

  await t('06b. si faltan los negocios que se quedan (¿otra base?): aborta sin guardar', async () => {
    await assert.rejects(correr({ comando: 'desactivar', aplicar: true, seQuedan: [...QUEDAN, s('queda-fantasma')] }),
      /todos los negocios que se quedan/);
    assert.equal((await negocio(BAJA_T[0])).activo, true);
  });

  await t('07. sin el superadmin único: aborta sin guardar', async () => {
    await pool.query(`UPDATE administradores_plataforma SET activo = FALSE WHERE usuario_id = $1`, [actor]);
    try {
      await assert.rejects(correr({ comando: 'desactivar', aplicar: true }), /superadmin/);
      assert.equal((await negocio(BAJA_T[0])).activo, true);
    } finally {
      await pool.query(`UPDATE administradores_plataforma SET activo = TRUE WHERE usuario_id = $1`, [actor]);
    }
  });

  let ruta;
  await t('08. aplicar: baja de los negocios y de sus integraciones activas, con respaldo', async () => {
    ({ ruta } = await correr({ comando: 'desactivar', aplicar: true }));
    assert.ok(ruta && existsSync(ruta), 'sin respaldo');
    for (const b of BAJA_T) assert.deepEqual(await negocio(b), { estado: 'suspendido', activo: false }, b);
    const [wa] = await integraciones(BAJA_T[0]);
    assert.equal(wa.estado, 'suspendido');
    assert.equal(wa.activo, false);
    assert.equal(wa.actualizado_por, actor);
    const [pagos] = await integraciones(BAJA_T[1]);
    assert.deepEqual({ estado: pagos.estado, activo: pagos.activo }, { estado: 'suspendido', activo: true },
      'tocó una integración que no estaba en activo');
    const g = JSON.parse(readFileSync(ruta, 'utf8'));
    assert.deepEqual(g.negocios.map((n) => n.slug).sort(), BAJA_T.slice(0, 3).sort(), 'el ya suspendido entró al respaldo');
    assert.deepEqual(g.integraciones.map((i) => i.canal), ['whatsapp']);
  });

  await t('09. los negocios que se quedan siguen igual', async () => {
    for (const q of QUEDAN) assert.deepEqual(await negocio(q), { estado: 'activo', activo: true }, q);
    const [wa] = await integraciones(QUEDAN[0]);
    assert.deepEqual({ estado: wa.estado, activo: wa.activo }, { estado: 'activo', activo: true });
  });

  await t('10. nada se borró: siguen las filas', async () => {
    const { rows: [n] } = await pool.query(`SELECT count(*)::int n FROM negocios WHERE slug = ANY($1)`, [[...BAJA_T, ...QUEDAN]]);
    assert.equal(n.n, BAJA_T.length + QUEDAN.length);
    assert.equal((await integraciones(BAJA_T[0])).length, 1);
  });

  await t('11. auditoría: un registro por cambio, con el superadmin como actor', async () => {
    const a = await auditorias();
    assert.equal(a.filter((x) => x.accion === 'cambiar_estado_negocio').length, 3);
    assert.equal(a.filter((x) => x.accion === 'integracion_estado_actualizado').length, 1);
    assert.ok(a.every((x) => x.superadmin_id === actor));
    const wa = a.find((x) => x.accion === 'integracion_estado_actualizado');
    assert.deepEqual(wa.estado_anterior, { estado: 'activo' });
    assert.equal(wa.contexto.canal, 'whatsapp');
  });

  await t('12. otra corrida: nada que hacer, sin auditoría repetida', async () => {
    const antes = (await auditorias()).length;
    const r = await correr({ comando: 'desactivar', aplicar: true });
    assert.equal(r.ruta, undefined);
    assert.equal((await auditorias()).length, antes);
  });

  await t('13. revertir en simulacro no cambia nada', async () => {
    await correr({ comando: 'revertir', desde: ruta });
    assert.deepEqual(await negocio(BAJA_T[0]), { estado: 'suspendido', activo: false });
  });

  await t('14. revertir con un cambio ajeno: aborta sin tocar nada', async () => {
    await pool.query(`UPDATE negocios SET estado = 'activo', activo = TRUE WHERE slug = $1`, [BAJA_T[2]]);
    try {
      await assert.rejects(correr({ comando: 'revertir', desde: ruta, aplicar: true }), /alguien lo cambió/);
      assert.deepEqual(await negocio(BAJA_T[0]), { estado: 'suspendido', activo: false });
    } finally {
      await pool.query(`UPDATE negocios SET estado = 'suspendido', activo = FALSE WHERE slug = $1`, [BAJA_T[2]]);
    }
  });

  await t('15. un respaldo que trae un negocio que se queda: aborta', async () => {
    const malo = join(respaldo, 'malo.json');
    const g = JSON.parse(readFileSync(ruta, 'utf8'));
    g.negocios.push({ id: ids[QUEDAN[0]], slug: QUEDAN[0], estado: 'activo', activo: true });
    (await import('node:fs')).writeFileSync(malo, JSON.stringify(g));
    await assert.rejects(correr({ comando: 'revertir', desde: malo, aplicar: true }), /se quedan/);
  });

  await t('16. revertir: todo vuelve exactamente como estaba, con su auditoría', async () => {
    const antes = (await auditorias()).length;
    await correr({ comando: 'revertir', desde: ruta, aplicar: true });
    for (const b of BAJA_T.slice(0, 3)) assert.deepEqual(await negocio(b), { estado: 'activo', activo: true }, b);
    assert.deepEqual(await negocio(BAJA_T[3]), { estado: 'suspendido', activo: false }, 'el que ya estaba suspendido se reactivó');
    const [wa] = await integraciones(BAJA_T[0]);
    assert.deepEqual({ estado: wa.estado, activo: wa.activo }, { estado: 'activo', activo: true });
    const [pagos] = await integraciones(BAJA_T[1]);
    assert.deepEqual({ estado: pagos.estado, activo: pagos.activo }, { estado: 'suspendido', activo: true });
    assert.equal((await auditorias()).length, antes + 4);
  });
} finally {
  c?.release();
  rmSync(respaldo, { recursive: true, force: true });
  await pool.end().catch(() => {});
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { for (const f of fallos) console.log(` - ${f}`); process.exit(1); }
process.exit(0);
