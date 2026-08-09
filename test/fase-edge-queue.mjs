// Cola local de Xabor Edge: persistencia, deduplicación de entrega,
// reintentos con espera creciente, aislamiento entre impresoras y
// recuperación tras un reinicio brusco.
//
// Sin Postgres y sin red: aquí se prueba lo que tiene que seguir funcionando
// cuando se cae internet. Cada caso corre contra los DOS almacenes (SQLite y
// JSON) porque los dos van a existir en campo según la versión de Node del
// equipo del restaurante.
import assert from 'assert';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearAlmacenSqlite, sqliteDisponible, rutaPorDefectoSqlite } from '../edge/storage/sqlite.js';
import { crearAlmacenJson, rutaPorDefectoJson } from '../edge/storage/jsonFile.js';
import { crearWorker, recuperarInterrumpidos } from '../edge/worker.js';
import { crearTransporteMock } from '../edge/transports/mock.js';
import { crearEdge } from '../edge/index.js';
import { cargarConfig, calcularEspera } from '../edge/config.js';
import { loggerSilencioso } from '../edge/logger.js';

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const temporales = [];
function dirTemporal() {
  const d = mkdtempSync(join(tmpdir(), 'xabor-edge-'));
  temporales.push(d);
  return d;
}

// Los dos almacenes se prueban con el mismo código: si alguno se desvía del
// contrato, los casos fallan solo para él y se ve cuál.
const BACKENDS = [];
if (sqliteDisponible()) BACKENDS.push(['sqlite', (dir) => crearAlmacenSqlite({ ruta: rutaPorDefectoSqlite(dir) })]);
BACKENDS.push(['json', (dir) => crearAlmacenJson({ ruta: rutaPorDefectoJson(dir) })]);

const CONFIG = {
  ...cargarConfig({ env: {} }),
  reintentoBaseMs: 10, reintentoMaximoMs: 40, maxIntentos: 3,
  intervaloColaMs: 10, timeoutImpresoraMs: 100,
};

function trabajo(id, impresora = 'COCINA', extra = {}) {
  return {
    id, documento: 'comanda', impresoraId: `id-${impresora}`, impresoraNombre: impresora,
    transporte: 'mock', anchoColumnas: 42,
    payload: { negocio: 'Demo', mesa: 4, items: [{ producto: 'Chilaquiles', cantidad: 1, modificadores: [] }] },
    ...extra,
  };
}

for (const [nombre, abrir] of BACKENDS) {
  await t('ALMACEN', `1.${nombre} registra un trabajo y lo devuelve como pendiente`, async () => {
    const almacen = abrir(dirTemporal());
    assert.strictEqual(almacen.registrarTrabajo(trabajo('j1')), true);
    const pendientes = almacen.pendientes();
    assert.strictEqual(pendientes.length, 1);
    assert.strictEqual(pendientes[0].id, 'j1');
    assert.strictEqual(pendientes[0].payload.mesa, 4, 'el snapshot sobrevive al viaje por el almacén');
    almacen.cerrar();
  });

  await t('ALMACEN', `2.${nombre} el MISMO trabajo entregado dos veces se registra UNA vez`, async () => {
    const almacen = abrir(dirTemporal());
    assert.strictEqual(almacen.registrarTrabajo(trabajo('j1')), true, 'primera entrega: nuevo');
    assert.strictEqual(almacen.registrarTrabajo(trabajo('j1')), false, 'segunda entrega: ya conocido');
    assert.strictEqual(almacen.todos().length, 1, 'nunca dos filas para el mismo job');
    almacen.cerrar();
  });

  await t('ALMACEN', `3.${nombre} la cola sobrevive a cerrar y reabrir el almacén`, async () => {
    const dir = dirTemporal();
    const a1 = abrir(dir);
    a1.registrarTrabajo(trabajo('persistente'));
    a1.cerrar();

    const a2 = abrir(dir);   // simula el reinicio del proceso
    const recuperado = a2.obtener('persistente');
    assert.ok(recuperado, 'el trabajo tiene que seguir ahí tras reiniciar');
    assert.strictEqual(recuperado.payload.items[0].producto, 'Chilaquiles');
    a2.cerrar();
  });

  await t('ALMACEN', `4.${nombre} un trabajo esperando su reintento no se sirve antes de tiempo`, async () => {
    const almacen = abrir(dirTemporal());
    almacen.registrarTrabajo(trabajo('j1'));
    almacen.actualizar('j1', { estado: 'fallido', proximoIntentoEn: Date.now() + 60_000 });
    assert.strictEqual(almacen.pendientes().length, 0, 'todavía no toca');
    assert.strictEqual(almacen.pendientes(Date.now() + 61_000).length, 1, 'cuando vence, vuelve a la cola');
    almacen.cerrar();
  });

  await t('ALMACEN', `5.${nombre} purgar limpia lo enviado viejo y NUNCA lo pendiente`, async () => {
    const almacen = abrir(dirTemporal());
    almacen.registrarTrabajo(trabajo('viejo'));
    almacen.registrarTrabajo(trabajo('pendiente'));
    almacen.registrarTrabajo(trabajo('agotado'));
    almacen.actualizar('viejo', { estado: 'enviado' });
    almacen.actualizar('agotado', { estado: 'agotado' });
    const borrados = almacen.purgar({ antesDe: Date.now() + 1000 });
    assert.strictEqual(borrados, 1, 'solo el enviado');
    assert.ok(almacen.obtener('pendiente'), 'lo pendiente no se toca');
    assert.ok(almacen.obtener('agotado'), 'lo que necesita atención NUNCA se borra');
    almacen.cerrar();
  });
}

// ── Worker ──────────────────────────────────────────────────────────────────
function montarWorker({ almacen, mock }) {
  const resultados = [];
  const worker = crearWorker({
    almacen, transportes: { mock }, config: CONFIG, logger: loggerSilencioso,
    alResolver: (r) => resultados.push(r),
  });
  return { worker, resultados };
}

await t('WORKER', '6. un trabajo con la impresora en línea sale a la primera', async () => {
  const almacen = BACKENDS[0][1](dirTemporal());
  const mock = crearTransporteMock();
  const { worker } = montarWorker({ almacen, mock });
  almacen.registrarTrabajo(trabajo('j1', 'COCINA'));

  await worker.pasada();

  assert.strictEqual(almacen.obtener('j1').estado, 'enviado');
  assert.strictEqual(mock.porImpresora('COCINA').length, 1);
  // El renderer pone el platillo en mayúsculas para que se lea de lejos.
  assert.ok(mock.enviados[0].texto.includes('CHILAQUILES'), 'salieron los bytes del platillo');
  almacen.cerrar();
});

await t('WORKER', '7. una impresora caída reintenta con espera creciente y no martillea', async () => {
  const almacen = BACKENDS[0][1](dirTemporal());
  const mock = crearTransporteMock();
  mock.programarFallo('COCINA', { codigo: 'ECONNREFUSED' });
  const { worker } = montarWorker({ almacen, mock });
  almacen.registrarTrabajo(trabajo('j1', 'COCINA'));

  await worker.pasada();
  const tras1 = almacen.obtener('j1');
  assert.strictEqual(tras1.estado, 'fallido');
  assert.strictEqual(tras1.intentos, 1);
  assert.ok(tras1.proximoIntentoEn > Date.now(), 'tiene que esperar antes del siguiente intento');
  assert.match(tras1.ultimoError, /ECONNREFUSED/);

  // Sin esperar, la cola no lo devuelve: eso es lo que evita el bucle
  // apretado contra una impresora apagada.
  await worker.pasada();
  assert.strictEqual(almacen.obtener('j1').intentos, 1, 'no debe reintentar antes de tiempo');
  almacen.cerrar();
});

await t('WORKER', '8. tras agotar los intentos el trabajo queda "agotado", no perdido', async () => {
  const almacen = BACKENDS[0][1](dirTemporal());
  const mock = crearTransporteMock();
  mock.programarFallo('COCINA', { codigo: 'ETIMEDOUT' });
  const { worker, resultados } = montarWorker({ almacen, mock });
  almacen.registrarTrabajo(trabajo('j1', 'COCINA'));

  for (let i = 0; i < CONFIG.maxIntentos; i++) {
    await worker.pasada(Date.now() + 999_999);
  }
  const final = almacen.obtener('j1');
  assert.strictEqual(final.estado, 'agotado');
  assert.strictEqual(final.intentos, CONFIG.maxIntentos);
  assert.ok(almacen.obtener('j1'), 'sigue existiendo: se puede revisar y reimprimir');
  assert.ok(resultados.some(r => r.trabajo.estado === 'agotado'));
  almacen.cerrar();
});

await t('WORKER', '9. la impresora que vuelve imprime lo que quedó esperando', async () => {
  const almacen = BACKENDS[0][1](dirTemporal());
  const mock = crearTransporteMock();
  mock.programarFallo('COCINA', { codigo: 'ECONNREFUSED', veces: 1 });
  const { worker } = montarWorker({ almacen, mock });
  almacen.registrarTrabajo(trabajo('j1', 'COCINA'));

  await worker.pasada();
  assert.strictEqual(almacen.obtener('j1').estado, 'fallido');
  await worker.pasada(Date.now() + 999_999);       // ya venció la espera
  assert.strictEqual(almacen.obtener('j1').estado, 'enviado');
  assert.strictEqual(mock.porImpresora('COCINA').length, 1, 'una sola impresión, no dos');
  almacen.cerrar();
});

await t('WORKER', '10. una impresora caída NO detiene a las demás (fan-out real)', async () => {
  const almacen = BACKENDS[0][1](dirTemporal());
  const mock = crearTransporteMock();
  mock.programarFallo('CHILAQUILES', { codigo: 'ECONNREFUSED' });
  const { worker } = montarWorker({ almacen, mock });

  almacen.registrarTrabajo(trabajo('j-chila', 'CHILAQUILES'));
  almacen.registrarTrabajo(trabajo('j-general', 'COCINA GENERAL'));
  almacen.registrarTrabajo(trabajo('j-bebidas', 'BEBIDAS'));

  await worker.pasada();

  assert.strictEqual(almacen.obtener('j-general').estado, 'enviado', 'cocina general imprime igual');
  assert.strictEqual(almacen.obtener('j-bebidas').estado, 'enviado', 'bebidas imprime igual');
  assert.strictEqual(almacen.obtener('j-chila').estado, 'fallido', 'chilaquiles queda pendiente');
  assert.strictEqual(mock.enviados.length, 2);
  almacen.cerrar();
});

await t('WORKER', '11. un resultado incierto NO se reintenta solo', async () => {
  const almacen = BACKENDS[0][1](dirTemporal());
  const mock = crearTransporteMock();
  // Los bytes salieron y se cortó la conexión: puede haber papel o no.
  mock.programarFallo('COCINA', { codigo: 'ECONNRESET', incierto: true });
  const { worker } = montarWorker({ almacen, mock });
  almacen.registrarTrabajo(trabajo('j1', 'COCINA'));

  await worker.pasada();
  assert.strictEqual(almacen.obtener('j1').estado, 'incierto');
  await worker.pasada(Date.now() + 999_999);
  assert.strictEqual(almacen.obtener('j1').intentos, 1,
    'reintentar a ciegas podría sacar el mismo platillo dos veces: lo decide una persona');
  almacen.cerrar();
});

await t('WORKER', '12. dos trabajos para la MISMA impresora se imprimen en serie y en orden', async () => {
  const almacen = BACKENDS[0][1](dirTemporal());
  const mock = crearTransporteMock();
  const { worker } = montarWorker({ almacen, mock });
  almacen.registrarTrabajo(trabajo('j1', 'COCINA'));
  await new Promise(r => setTimeout(r, 5));
  almacen.registrarTrabajo(trabajo('j2', 'COCINA'));

  await worker.pasada();
  assert.deepStrictEqual(mock.enviados.map(e => e.jobId), ['j1', 'j2'],
    'dos comandas simultáneas por el mismo cabezal se mezclarían en el papel');
  almacen.cerrar();
});

await t('REINICIO', '13. un trabajo interrumpido a media impresión se recupera al arrancar', async () => {
  const dir = dirTemporal();
  const a1 = BACKENDS[0][1](dir);
  a1.registrarTrabajo(trabajo('j1'));
  a1.actualizar('j1', { estado: 'procesando' });   // el proceso muere justo aquí
  a1.cerrar();

  const a2 = BACKENDS[0][1](dir);
  const recuperados = recuperarInterrumpidos(a2, loggerSilencioso);
  assert.strictEqual(recuperados, 1);
  const t1 = a2.obtener('j1');
  assert.strictEqual(t1.estado, 'fallido', 'vuelve a la cola en vez de darse por enviado');
  assert.strictEqual(t1.intentos, 1, 'el intento a medias cuenta: si no, podría girar para siempre');
  assert.match(t1.ultimoError, /reinici/i);

  const mock = crearTransporteMock();
  const { worker } = montarWorker({ almacen: a2, mock });
  await worker.pasada(Date.now() + 999_999);
  assert.strictEqual(a2.obtener('j1').estado, 'enviado', 'y termina imprimiéndose');
  a2.cerrar();
});

await t('REINICIO', '14. la cola completa sobrevive a matar el proceso: nada se pierde', async () => {
  const dir = dirTemporal();
  const a1 = BACKENDS[0][1](dir);
  for (let i = 0; i < 25; i++) a1.registrarTrabajo(trabajo(`j${i}`, i % 2 ? 'A' : 'B'));
  a1.cerrar();                                      // equivalente a kill -9

  const a2 = BACKENDS[0][1](dir);
  assert.strictEqual(a2.todos().length, 25, 'los 25 trabajos siguen ahí');
  const mock = crearTransporteMock();
  const { worker } = montarWorker({ almacen: a2, mock });
  await worker.pasada();
  assert.strictEqual(mock.enviados.length, 25);
  assert.strictEqual(new Set(mock.enviados.map(e => e.jobId)).size, 25, 'ninguno duplicado');
  a2.cerrar();
});

// ── Backoff ─────────────────────────────────────────────────────────────────
await t('BACKOFF', '15. la espera crece con cada intento y tiene tope', async () => {
  const opciones = { baseMs: 1000, maximoMs: 10000 };
  const esperas = [1, 2, 3, 4, 5, 6].map(i => calcularEspera(i, opciones));
  for (let i = 1; i < 4; i++) {
    assert.ok(esperas[i] > esperas[i - 1], `el intento ${i + 1} debe esperar más que el ${i}`);
  }
  assert.ok(Math.max(...esperas) <= opciones.maximoMs, 'nunca por encima del tope');
  assert.ok(esperas[0] >= opciones.baseMs, 'el primer reintento no es inmediato');
});

await t('BACKOFF', '16. el jitter evita que cuatro impresoras reintenten en el mismo milisegundo', async () => {
  const muestras = new Set(Array.from({ length: 40 }, () => calcularEspera(3, { baseMs: 1000, maximoMs: 60000 })));
  assert.ok(muestras.size > 1, 'sin jitter, un corte de luz haría reintentar todo a la vez');
});

// ── Edge completo, sin nube ─────────────────────────────────────────────────
await t('EDGE', '17. el Edge arranca y procesa su cola sin necesidad de internet', async () => {
  const dir = dirTemporal();
  const mock = crearTransporteMock();
  const edge = crearEdge({
    config: { ...CONFIG, rutaDatos: dir, almacen: BACKENDS[0][0] },
    logger: loggerSilencioso,
    transportes: { mock },
  });
  await edge.iniciar({ conectar: false });          // sin conexión a la nube

  edge._recibirTrabajo(trabajo('j1', 'COCINA'));
  await edge.worker.pasada();

  assert.strictEqual(edge.almacen.obtener('j1').estado, 'enviado');
  assert.strictEqual(mock.enviados.length, 1);
  await edge.detener();
});

await t('EDGE', '18. una entrega duplicada de la nube no imprime dos veces', async () => {
  const dir = dirTemporal();
  const mock = crearTransporteMock();
  const edge = crearEdge({ config: { ...CONFIG, rutaDatos: dir, almacen: BACKENDS[0][0] }, logger: loggerSilencioso, transportes: { mock } });
  await edge.iniciar({ conectar: false });

  // La nube manda ABC, no recibe ACK y lo vuelve a mandar.
  edge._recibirTrabajo(trabajo('ABC', 'COCINA'));
  edge._recibirTrabajo(trabajo('ABC', 'COCINA'));
  edge._recibirTrabajo(trabajo('ABC', 'COCINA'));
  await edge.worker.pasada();

  assert.strictEqual(edge.almacen.todos().length, 1);
  assert.strictEqual(mock.enviados.length, 1, 'un solo papel, aunque llegara tres veces');
  await edge.detener();
});

await t('EDGE', '19. un trabajo ya enviado que se reenvía no vuelve a salir', async () => {
  const dir = dirTemporal();
  const mock = crearTransporteMock();
  const edge = crearEdge({ config: { ...CONFIG, rutaDatos: dir, almacen: BACKENDS[0][0] }, logger: loggerSilencioso, transportes: { mock } });
  await edge.iniciar({ conectar: false });

  edge._recibirTrabajo(trabajo('ABC'));
  await edge.worker.pasada();
  assert.strictEqual(mock.enviados.length, 1);

  edge._recibirTrabajo(trabajo('ABC'));            // reenvío tras reconectar
  await edge.worker.pasada();
  assert.strictEqual(mock.enviados.length, 1, 'la reconexión no puede reimprimir lo ya enviado');
  await edge.detener();
});

await t('EDGE', '20. el estado del Edge informa de la cola sin exponer secretos', async () => {
  const dir = dirTemporal();
  const edge = crearEdge({ config: { ...CONFIG, rutaDatos: dir, almacen: BACKENDS[0][0], terminalToken: 'secreto-que-no-debe-salir' }, logger: loggerSilencioso, transportes: { mock: crearTransporteMock() } });
  await edge.iniciar({ conectar: false });
  edge._recibirTrabajo(trabajo('j1'));

  const estado = edge.estado();
  assert.strictEqual(estado.conectado, false);
  assert.strictEqual(estado.trabajos.pendiente, 1);
  assert.ok(!JSON.stringify(estado).includes('secreto-que-no-debe-salir'), 'el token jamás sale en el estado');
  await edge.detener();
});

await t('EDGE', '21. el archivo de datos se crea dentro de la ruta configurada', async () => {
  const dir = dirTemporal();
  const edge = crearEdge({ config: { ...CONFIG, rutaDatos: dir, almacen: BACKENDS[0][0] }, logger: loggerSilencioso, transportes: { mock: crearTransporteMock() } });
  await edge.iniciar({ conectar: false });
  edge._recibirTrabajo(trabajo('j1'));
  const ruta = BACKENDS[0][0] === 'sqlite' ? rutaPorDefectoSqlite(dir) : rutaPorDefectoJson(dir);
  assert.ok(existsSync(ruta), `debe existir ${ruta}`);
  await edge.detener();
});

// ── Concurrencia ────────────────────────────────────────────────────────────
await t('CONCURRENCIA', '22. 20 rondas simultáneas: 60 trabajos exactos, 0 duplicados, 0 perdidos', async () => {
  const dir = dirTemporal();
  const mock = crearTransporteMock();
  const edge = crearEdge({ config: { ...CONFIG, rutaDatos: dir, almacen: BACKENDS[0][0] }, logger: loggerSilencioso, transportes: { mock } });
  await edge.iniciar({ conectar: false });

  // 20 mesas, cada una con tres destinos (chilaquiles + general + bebidas).
  const esperados = [];
  for (let mesa = 1; mesa <= 20; mesa++) {
    for (const imp of ['CHILAQUILES', 'COCINA GENERAL', 'BEBIDAS']) {
      const id = `mesa${mesa}-${imp}`;
      esperados.push(id);
      edge._recibirTrabajo(trabajo(id, imp));
    }
  }
  assert.strictEqual(esperados.length, 60);

  // Varias pasadas concurrentes, como pasaría con el temporizador real.
  await Promise.all([edge.worker.pasada(), edge.worker.pasada(), edge.worker.pasada()]);
  await edge.worker.pasada();

  const enviados = edge.almacen.todos().filter(x => x.estado === 'enviado');
  assert.strictEqual(enviados.length, 60, `se esperaban 60 enviados y hay ${enviados.length}`);
  assert.strictEqual(mock.enviados.length, 60, 'ni uno de más');
  assert.strictEqual(new Set(mock.enviados.map(e => e.jobId)).size, 60, 'ni un duplicado');
  const faltantes = esperados.filter(id => !mock.enviados.some(e => e.jobId === id));
  assert.deepStrictEqual(faltantes, [], 'ni uno perdido');
  await edge.detener();
});

for (const d of temporales) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
