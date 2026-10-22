// scripts/ops/facturapi-freno-2026-10/freno.mjs detiene TODA llamada de Xabor
// a Facturapi sin despliegue, y la reversa regresa exactamente lo que frenó.
//
// Se mide con el barrido real (reconciliarRecibosFacturacion) contra un
// Facturapi falso que cuenta las peticiones: antes del freno hay llamadas,
// con el freno cero, al reanudar vuelven. El script corre como proceso
// aparte, igual que lo correría Mario contra producción.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida');

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const { pool } = await import('../src/services/database.js');
const { guardarCredencialesFacturapi } = await import('../src/services/integracionesService.js');
const { reconciliarRecibosFacturacion } = await import('../src/services/facturacionService.js');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}

// Facturapi falso: cuenta TODO lo que sale hacia facturapi.io.
const llamadas = [];
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://www.facturapi.io/')) return fetchOriginal(url, init);
  llamadas.push(`${init.method || 'GET'} ${u.replace('https://www.facturapi.io/v2', '')}`);
  const id = u.split('/receipts/')[1]?.split(/[/?]/)[0] || 'rec_nuevo';
  return new Response(JSON.stringify({ id, status: 'open', total: 150, key: `clave-${id}`,
    self_invoice_url: `https://factura.space/prueba/${id}`, expires_at: '2026-11-30T00:00:00.000Z' }),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { rows: [neg] } = await pool.query('SELECT id, slug FROM negocios WHERE slug IS NOT NULL ORDER BY created_at LIMIT 1');
const NEG = neg.id;
const FOLIOS = ['XAB-FRENOA', 'XAB-FRENOB', 'XAB-FRENOC'];
const RESPALDO = mkdtempSync(join(tmpdir(), 'freno-facturapi-'));

// El barrido revisa todas las integraciones activas de la base de pruebas;
// se recuerdan para dejarlas como estaban.
const { rows: previas } = await pool.query(
  `SELECT id, estado, activo FROM integraciones_canal WHERE canal='facturacion' AND proveedor='facturapi'`);
const { rows: [previaNeg] } = await pool.query(
  `SELECT id FROM integraciones_canal WHERE canal='facturacion' AND proveedor='facturapi' AND negocio_id=$1`, [NEG]);
const { rows: [cfgPrevia] } = await pool.query('SELECT autoemitir_recibo FROM facturacion_configuracion WHERE negocio_id=$1', [NEG]);

const freno = (...args) => {
  const r = spawnSync(process.execPath, ['scripts/ops/facturapi-freno-2026-10/freno.mjs', ...args, `--respaldo=${RESPALDO}`],
    { cwd: RAIZ, encoding: 'utf8', env: process.env, timeout: 60000 });
  return { status: r.status, salida: (r.stdout || '') + (r.stderr || '') };
};
const estadoNeg = async () => (await pool.query(
  `SELECT estado, activo FROM integraciones_canal WHERE canal='facturacion' AND proveedor='facturapi' AND negocio_id=$1`, [NEG])).rows[0];
const envejecer = () => pool.query(
  `UPDATE facturacion_recibos SET updated_at = NOW() - INTERVAL '2 days' WHERE folio = ANY($1)`, [FOLIOS]);
async function barrer() {
  const antes = llamadas.length;
  await reconciliarRecibosFacturacion(200);
  return llamadas.slice(antes);
}

try {
  await pool.query(`DELETE FROM facturacion_recibos WHERE folio = ANY($1)`, [FOLIOS]);
  // Aislamiento: el barrido de ligas no debe crear recibos de otras ventas.
  await pool.query(`INSERT INTO facturacion_configuracion (negocio_id, autoemitir_recibo) VALUES ($1, false)
    ON CONFLICT (negocio_id) DO UPDATE SET autoemitir_recibo=false`, [NEG]);
  await guardarCredencialesFacturapi(NEG, 'sk_test_freno_000000000000', null);
  for (const [i, folio] of FOLIOS.entries()) {
    await pool.query(
      `INSERT INTO facturacion_recibos (negocio_id, folio, recibo_id, estado, total, idempotency_key, expires_at, updated_at)
       VALUES ($1,$2,$3,'abierto',150,$4, NOW() + INTERVAL '20 days', NOW() - INTERVAL '2 days')`,
      [NEG, folio, `rec_freno_${i}`, `${NEG}:${folio}`]);
  }

  await t('1. sin freno, el barrido consulta los recibos abiertos en Facturapi', async () => {
    const hechas = await barrer();
    const nuestras = hechas.filter((l) => /rec_freno_/.test(l));
    assert.ok(nuestras.length >= 1, `no consultó los recibos de prueba: ${hechas.join(' | ') || 'ninguna llamada'}`);
  });

  await t('2. «estado» informa la integración y los recibos del barrido, sin escribir', async () => {
    const r = freno('estado');
    assert.equal(r.status, 0, r.salida);
    assert.match(r.salida, new RegExp(`\\(${neg.slug}\\): integración activo`));
    assert.match(r.salida, /recibos en el barrido: \d+/);
    assert.equal((await estadoNeg()).estado, 'activo');
  });

  await t('3. «frenar» sin --aplicar es simulacro: no cambia nada ni deja respaldo', async () => {
    const r = freno('frenar');
    assert.equal(r.status, 0, r.salida);
    assert.match(r.salida, /SIMULACRO/);
    assert.equal((await estadoNeg()).estado, 'activo');
    assert.equal(readdirSync(RESPALDO).length, 0);
  });

  let archivo;
  await t('4. «frenar --aplicar» suspende las integraciones activas y deja el respaldo', async () => {
    const r = freno('frenar', '--aplicar');
    assert.equal(r.status, 0, r.salida);
    assert.deepEqual(await estadoNeg(), { estado: 'suspendido', activo: false });
    const archivos = readdirSync(RESPALDO);
    assert.equal(archivos.length, 1);
    archivo = join(RESPALDO, archivos[0]);
    assert.match(r.salida, /para reanudar: node scripts\/ops\/facturapi-freno-2026-10\/freno\.mjs reanudar/);
  });

  await t('5. con el freno puesto, el barrido completo no hace NI UNA llamada a Facturapi', async () => {
    await envejecer();
    const hechas = await barrer();
    assert.deepEqual(hechas, [], `salieron llamadas con el freno puesto: ${hechas.join(' | ')}`);
  });

  await t('6. «reanudar» se niega si alguien cambió la integración después del freno', async () => {
    await pool.query(`UPDATE integraciones_canal SET estado='error' WHERE id=$1`, [previaNeg?.id
      || (await pool.query(`SELECT id FROM integraciones_canal WHERE canal='facturacion' AND proveedor='facturapi' AND negocio_id=$1`, [NEG])).rows[0].id]);
    const r = freno('reanudar', `--desde=${archivo}`, '--aplicar');
    assert.notEqual(r.status, 0, 'reanudó una integración que ya no estaba suspendida');
    assert.match(r.salida, /ABORTADO/);
    assert.equal((await estadoNeg()).estado, 'error');
    await pool.query(`UPDATE integraciones_canal SET estado='suspendido' WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi'`, [NEG]);
  });

  await t('7. «reanudar --aplicar» regresa exactamente el estado anterior y el barrido vuelve a consultar', async () => {
    const r = freno('reanudar', `--desde=${archivo}`, '--aplicar');
    assert.equal(r.status, 0, r.salida);
    assert.deepEqual(await estadoNeg(), { estado: 'activo', activo: true });
    await envejecer();
    const hechas = await barrer();
    assert.ok(hechas.some((l) => /rec_freno_/.test(l)), 'tras reanudar no volvió a consultar');
  });
} finally {
  globalThis.fetch = fetchOriginal;
  await pool.query(`DELETE FROM facturacion_recibos WHERE folio = ANY($1)`, [FOLIOS]).catch(() => {});
  for (const p of previas) {
    await pool.query(`UPDATE integraciones_canal SET estado=$2, activo=$3 WHERE id=$1`, [p.id, p.estado, p.activo]).catch(() => {});
  }
  if (!previaNeg) {
    await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN
      (SELECT id FROM integraciones_canal WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi')`, [NEG]).catch(() => {});
    await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi'`, [NEG]).catch(() => {});
  }
  if (cfgPrevia) await pool.query('UPDATE facturacion_configuracion SET autoemitir_recibo=$2 WHERE negocio_id=$1', [NEG, cfgPrevia.autoemitir_recibo]).catch(() => {});
  else await pool.query('DELETE FROM facturacion_configuracion WHERE negocio_id=$1', [NEG]).catch(() => {});
  rmSync(RESPALDO, { recursive: true, force: true });
  await pool.end().catch(() => {});
}
console.log(`\nPASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
