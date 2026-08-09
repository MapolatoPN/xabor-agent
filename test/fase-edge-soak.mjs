// Prueba prolongada del Edge: muchos trabajos, fallos periódicos y una
// impresora que se cae y vuelve una y otra vez.
//
// No busca velocidad: busca lo que solo aparece con volumen y tiempo -- fugas
// de memoria, temporizadores que se acumulan, sockets que no se cierran,
// promesas sin capturar y, sobre todo, un trabajo que se pierda o salga dos
// veces entre miles.
import assert from 'assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearEdge } from '../edge/index.js';
import { cargarConfig } from '../edge/config.js';
import { loggerSilencioso } from '../edge/logger.js';
import { crearTransporteMock } from '../edge/transports/mock.js';

const TRABAJOS = Number(process.env.SOAK_TRABAJOS || 2000);
const IMPRESORAS = ['CHILAQUILES', 'COCINA GENERAL', 'BEBIDAS', 'TICKETS'];

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  [SOAK] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [SOAK] ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'xabor-soak-'));
const sinCapturar = [];
process.on('unhandledRejection', (e) => sinCapturar.push(String(e?.message || e)));

const mock = crearTransporteMock();
const edge = crearEdge({
  config: {
    ...cargarConfig({ env: {} }),
    rutaDatos: dir, almacen: 'sqlite',
    reintentoBaseMs: 5, reintentoMaximoMs: 30, maxIntentos: 6,
    intervaloColaMs: 5, timeoutImpresoraMs: 200,
  },
  logger: loggerSilencioso,
  transportes: { mock },
});
await edge.iniciar({ conectar: false });

const memoriaInicial = process.memoryUsage().heapUsed;
const t0 = Date.now();
const latencias = [];

await t(`${TRABAJOS} trabajos con fallos periódicos: 0 perdidos, 0 duplicados`, async () => {
  const esperados = new Set();

  for (let i = 0; i < TRABAJOS; i++) {
    const impresora = IMPRESORAS[i % IMPRESORAS.length];
    const id = `soak-${i}`;
    esperados.add(id);
    edge._recibirTrabajo({
      id, documento: 'comanda', impresoraId: `id-${impresora}`, impresoraNombre: impresora,
      transporte: 'mock', anchoColumnas: 42,
      payload: { negocio: 'Soak', mesa: (i % 30) + 1, ronda: 1, mesero: 'SOAK',
                 items: [{ producto: `Platillo ${i % 12}`, cantidad: (i % 3) + 1, modificadores: [] }] },
    });

    // Cada 250 trabajos, una impresora se cae durante unos intentos: es lo
    // que hace que la cola se acumule y los reintentos se solapen.
    if (i % 250 === 0 && i > 0) {
      mock.programarFallo(IMPRESORAS[(i / 250) % IMPRESORAS.length], { codigo: 'ECONNREFUSED', veces: 5 });
    }

    if (i % 100 === 0) {
      const inicio = Date.now();
      await edge.worker.pasada(Date.now() + 9_999_999);
      latencias.push(Date.now() - inicio);
    }
  }

  // Se vacía la cola: se avanza el reloj para que venzan todas las esperas.
  for (let vuelta = 0; vuelta < 40; vuelta++) {
    const inicio = Date.now();
    await edge.worker.pasada(Date.now() + 9_999_999);
    latencias.push(Date.now() - inicio);
    const conteo = edge.almacen.contarPorEstado();
    if (!conteo.pendiente && !conteo.fallido && !conteo.procesando) break;
  }

  const conteo = edge.almacen.contarPorEstado();
  const impresos = conteo.impreso || 0;
  const agotados = conteo.agotado || 0;

  assert.strictEqual(impresos + agotados, TRABAJOS,
    `se esperaban ${TRABAJOS} trabajos resueltos y hay ${impresos} impresos + ${agotados} agotados`);
  assert.strictEqual(agotados, 0, `ningún trabajo debía agotarse: los fallos eran temporales (hay ${agotados})`);

  // Ni uno perdido, ni uno duplicado.
  const enviados = mock.enviados.map(e => e.jobId);
  assert.strictEqual(new Set(enviados).size, enviados.length,
    `hay ${enviados.length - new Set(enviados).size} impresiones duplicadas`);
  const faltantes = [...esperados].filter(id => !enviados.includes(id));
  assert.strictEqual(faltantes.length, 0, `se perdieron ${faltantes.length} trabajos`);
  assert.strictEqual(enviados.length, TRABAJOS, `salieron ${enviados.length} papeles y se esperaban ${TRABAJOS}`);
});

await t('cada impresora recibió exactamente su parte', async () => {
  for (const imp of IMPRESORAS) {
    const suyos = mock.porImpresora(imp).length;
    assert.strictEqual(suyos, TRABAJOS / IMPRESORAS.length,
      `${imp} recibió ${suyos} y le tocaban ${TRABAJOS / IMPRESORAS.length}`);
  }
});

await t('sin promesas sin capturar', async () => {
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(sinCapturar, [], 'una promesa sin capturar puede matar el proceso en producción');
});

await t('la memoria no crece de forma descontrolada', async () => {
  global.gc?.();
  const crecimiento = (process.memoryUsage().heapUsed - memoriaInicial) / 1024 / 1024;
  // Umbral generoso a propósito: sin --expose-gc esto mide sobre todo basura
  // aún no recogida. Lo que detecta es una fuga de verdad, no ruido.
  assert.ok(crecimiento < 250, `el heap creció ${crecimiento.toFixed(1)} MB procesando ${TRABAJOS} trabajos`);
});

await t('el ritmo es razonable para una cocina', async () => {
  latencias.sort((a, b) => a - b);
  const p50 = latencias[Math.floor(latencias.length * 0.5)];
  const p95 = latencias[Math.floor(latencias.length * 0.95)];
  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`      ${TRABAJOS} trabajos en ${total}s · pasada de cola p50 ${p50}ms · p95 ${p95}ms`);
  assert.ok(p95 < 20000, `una pasada de la cola tardó ${p95}ms en el p95: hay algo absurdamente lento`);
});

await t('el proceso queda limpio al detenerse', async () => {
  await edge.detener();
  assert.strictEqual(edge.worker.activo, false);
  const pendientesDeNode = process.getActiveResourcesInfo?.() || [];
  const temporizadores = pendientesDeNode.filter(r => r === 'Timeout').length;
  assert.ok(temporizadores <= 2, `quedaron ${temporizadores} temporizadores vivos tras detener el Edge`);
});

try { rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
