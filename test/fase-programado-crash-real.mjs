// ─── P0-15E: muerte REAL del proceso, no solo un throw capturado ───────────
//
// Las pruebas de recovery de fase-folio-programados-identidad (15/16) inyectan
// el fallo dentro de la MISMA sentencia SQL y demuestran que Postgres revierte
// la transaccion entera -- prueba suficiente porque toda la transicion vive en
// una sola llamada a `xabor_activo_a_programado`, y Postgres no distingue
// "el cliente lanzo una excepcion capturable" de "el cliente murio de verdad":
// en ambos casos la conexion se corta sin COMMIT y la transaccion se descarta.
//
// Pero el pedido explicito fue mas alla: "Matar el proceso. Arrancar servidor
// nuevo. No hacer reparacion manual desde el test." Esta suite hace justo eso,
// literal: un `src/server.js` real como proceso hijo (mismo arnes que usa
// fase-compra-operacional-critica para P0-9), `process.exit(137)` de verdad en
// el mismo punto ya probado a nivel SQL, un proceso NUEVO con OTRO PID, y un
// retry contra la MISMA ruta HTTP que usan los canales -- sin tocar la base a
// mano en ningun momento.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4951';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}

const NEG = SEED.negocioA;
const cookie = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG, rol: 'admin' }))}`;
const ENV_BASE = { PORT: PUERTO, XABOR_RUTAS_PRUEBA: '1' };

async function crearPedidoActivo(base) {
  const r = await fetch(base + '/test/pedido', { method: 'POST', headers: { Cookie: cookie } });
  const body = await r.json();
  assert.strictEqual(r.status, 200, `no se pudo crear el pedido de prueba: ${JSON.stringify(body)}`);
  return body.pedido.id;
}

function esperarSalida(proc, timeoutMs = 8000) {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), timeoutMs);
    proc.once('exit', (code) => { clearTimeout(to); resolve(code); });
  });
}

const reclamado = async (folio) =>
  (await pool.query(`SELECT * FROM folios_pedido_usados WHERE folio=$1`, [folio])).rows[0] || null;

try {
  for (const punto of ['tras_insert_programado', 'tras_conversion_claim', 'antes_eliminar_activo', 'despues_eliminar_activo']) {
    await t(`muerte REAL del proceso en '${punto}': converge sin reparacion manual`, async () => {
      const srv = await arrancarServidor(
        { ...ENV_BASE, XABOR_PROGRAMADOS_FALLA_EN: punto, XABOR_PROGRAMADOS_MATAR_PROCESO: '1' },
        { timeoutMs: 90000 });
      const folio = await crearPedidoActivo(srv.base);
      const programadoPara = new Date(Date.now() + 3600e3).toISOString();

      let seCortoLaConexion = false;
      try {
        await fetch(srv.base + '/test/pedido-programar', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ folio, programadoPara }),
        });
      } catch {
        seCortoLaConexion = true;   // el proceso murio a mitad de la respuesta
      }

      const codigoSalida = await esperarSalida(srv.proc);
      assert.strictEqual(codigoSalida, 137,
        `el proceso no murio de verdad en '${punto}' (exit=${codigoSalida}): la prueba no probo nada real`);
      assert.ok(seCortoLaConexion,
        `la respuesta HTTP llego completa pese a que el proceso murio: revisar el orden de exit() vs res.json()`);

      // Toda la transicion vive en UNA llamada a xabor_activo_a_programado:
      // si el proceso muere en CUALQUIERA de los 4 puntos, Postgres nunca vio
      // un COMMIT, asi que el resultado es identico en los cuatro casos --
      // el activo sigue siendo el UNICO estado observable, nunca hibrido y
      // nunca "desaparecido".
      const activo = (await pool.query(`SELECT 1 FROM pedidos_activos WHERE folio=$1`, [folio])).rowCount;
      const programado = (await pool.query(`SELECT 1 FROM pedidos_programados WHERE folio=$1`, [folio])).rowCount;
      assert.strictEqual(activo, 1, `el activo no sobrevivio a la muerte real en '${punto}'`);
      assert.strictEqual(programado, 0, `quedo un programado durable pese a que el proceso murio antes de confirmar ('${punto}')`);
      const claimTrasMuerte = await reclamado(folio);
      assert.strictEqual(claimTrasMuerte?.estado, 'usado',
        `el claim se movio pese a que el proceso murio antes de confirmar ('${punto}')`);

      // Proceso NUEVO -- PID distinto, cero env de fallo -- y el MISMO retry
      // que haria un canal real. Nada de SQL manual desde el test.
      const srvNuevo = await arrancarServidor({ ...ENV_BASE }, { timeoutMs: 90000 });
      assert.notStrictEqual(srvNuevo.proc.pid, srv.proc.pid,
        'el "proceso nuevo" comparte PID con el que murio: no hubo reinicio real');

      try {
        const r = await fetch(srvNuevo.base + '/test/pedido-programar', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ folio, programadoPara }),
        });
        const body = await r.json();
        assert.strictEqual(body.ok, true, `el retry en el proceso nuevo no convergio: ${JSON.stringify(body)}`);

        const activoFinal = (await pool.query(`SELECT 1 FROM pedidos_activos WHERE folio=$1`, [folio])).rowCount;
        const progFinal = (await pool.query(`SELECT 1 FROM pedidos_programados WHERE folio=$1`, [folio])).rowCount;
        assert.strictEqual(activoFinal, 0, 'el activo sigue en el tablero tras el retry en el proceso nuevo');
        assert.strictEqual(progFinal, 1, 'no quedo programado tras el retry en el proceso nuevo');
        const claimFinal = await reclamado(folio);
        assert.strictEqual(claimFinal?.estado, 'reserva_programado',
          'el claim no convergio a reserva tras el retry en el proceso nuevo');
      } finally {
        await srvNuevo.detener();
      }
    });
  }
} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL');
} finally {
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-programado-crash-real: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
