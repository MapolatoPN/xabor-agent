// Transporte TCP contra un simulador de impresora térmica.
//
// Aquí se fija la SEMÁNTICA del transporte, que es la decisión más delicada de
// todo Xabor Edge. Con RAW TCP no hay protocolo de aplicación: se vuelcan
// bytes y la impresora no contesta. Hay cinco cosas distintas y solo tres son
// observables:
//
//   A) write() aceptó los bytes            observable
//   B) el buffer local se vació            observable
//   C) el TCP remoto los aceptó            observable solo por ausencia de RST
//   D) la impresora los procesó            NO observable
//   E) salió papel                         NO observable
//
// Por eso el transporte nunca dice "impreso": dice `enviado`, `incierto` o
// `fallido`. Todo lo que sigue prueba que esa línea está bien trazada.
import assert from 'assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearImpresoraSimulada } from './simulador-impresora.mjs';
import { crearTransporteTcpRaw } from '../edge/transports/tcpRaw.js';
import { crearAlmacenJson, rutaPorDefectoJson } from '../edge/storage/jsonFile.js';
import { crearWorker } from '../edge/worker.js';
import { loggerSilencioso } from '../edge/logger.js';
import { renderizar } from '../edge/renderers/index.js';

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const temporales = [];
const dirTemporal = () => { const d = mkdtempSync(join(tmpdir(), 'xabor-tcp-')); temporales.push(d); return d; };

// Gracia corta para que la suite no tarde: en producción es de ~1.2 s.
const tcp = crearTransporteTcpRaw({ logger: loggerSilencioso, timeoutMs: 1500, graciaMs: 250 });
const BYTES = renderizar('comanda', {
  negocio: 'Mapolato Demo', mesa: 4, mesero: 'ANGEL', ronda: 1,
  items: [{ producto: 'Chilaquiles', cantidad: 1, modificadores: [{ grupo: 'Salsa', opcion: 'Verde' }], notas: 'Sin cebolla' }],
});

// ─── LA prueba que faltaba ──────────────────────────────────────────────────
//
// Muchas térmicas de red NO cierran la conexión después de un trabajo: la
// dejan abierta. La primera versión del transporte exigía el FIN del otro
// extremo para dar el envío por bueno, así que contra una impresora así
// TODOS los trabajos habrían quedado inciertos. Funcionaba contra el
// simulador solo porque el simulador cerraba: era diseñar contra el
// simulador, y el fallo se habría visto en Obispado con el hardware delante.
await t('SEMANTICA', '1. una impresora que NUNCA cierra la conexión da envío correcto', async () => {
  const imp = crearImpresoraSimulada({ nombre: 'SILENCIOSA' });
  const puerto = await imp.encender();
  imp.modo('silenciosa');            // lee todo y jamás cierra
  try {
    const inicio = Date.now();
    const r = await tcp.enviar({ host: '127.0.0.1', puerto }, BYTES, { jobId: 'j1' });
    assert.strictEqual(r.resultado, 'enviado',
      `una impresora que mantiene la conexión abierta es normal, no un fallo (devolvió ${r.resultado}: ${r.detalle})`);
    assert.ok(Date.now() - inicio < 1400, 'no debe esperar al timeout completo: basta la ventana de gracia');
    assert.strictEqual(imp.recibidos.length, 1, 'y los bytes llegaron enteros');
    assert.ok(imp.recibidos[0].bytes.equals(BYTES));
  } finally { await imp.apagar(); }
});

await t('SEMANTICA', '2. una impresora que SÍ cierra ordenadamente también da envío correcto', async () => {
  const imp = crearImpresoraSimulada({ nombre: 'COCINA' });
  const puerto = await imp.encender();
  try {
    const r = await tcp.enviar({ host: '127.0.0.1', puerto }, BYTES, { jobId: 'j2' });
    assert.strictEqual(r.resultado, 'enviado');
    assert.ok(imp.recibidos[0].texto.includes('CHILAQUILES'));
    assert.ok(imp.recibidos[0].texto.includes('Salsa: Verde'));
    assert.ok(imp.recibidos[0].texto.includes('NOTA: Sin cebolla'));
  } finally { await imp.apagar(); }
});

await t('SEMANTICA', '3. el transporte NUNCA devuelve "impreso"', async () => {
  const imp = crearImpresoraSimulada({ nombre: 'X' });
  const puerto = await imp.encender();
  try {
    const r = await tcp.enviar({ host: '127.0.0.1', puerto }, BYTES, { jobId: 'j3' });
    assert.ok(['enviado', 'incierto', 'fallido'].includes(r.resultado));
    const fs = await import('node:fs');
    const src = fs.readFileSync('edge/transports/tcpRaw.js', 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/'impreso'/.test(src), 'afirmar que salió papel sería inventar una certeza');
  } finally { await imp.apagar(); }
});

// ─── Matriz de desenlaces ───────────────────────────────────────────────────
await t('MATRIZ', '4. puerto cerrado -> FALLIDO (se sabe que no llegó nada: reintentable)', async () => {
  const imp = crearImpresoraSimulada({ nombre: 'BEBIDAS' });
  const puerto = await imp.encender();
  await imp.apagar();
  const r = await tcp.enviar({ host: '127.0.0.1', puerto }, BYTES, { jobId: 'j4' });
  assert.strictEqual(r.resultado, 'fallido');
  assert.strictEqual(r.codigo, 'ECONNREFUSED');
  assert.match(r.detalle, /rechaz/i, 'el mensaje debe servirle a un técnico, no solo el código');
});

await t('MATRIZ', '5. RST antes de que salga un solo byte -> FALLIDO, no incierto', async () => {
  const imp = crearImpresoraSimulada({ nombre: 'RECHAZA' });
  const puerto = await imp.encender();
  imp.modo('rechazar_al_conectar');
  try {
    const r = await tcp.enviar({ host: '127.0.0.1', puerto }, BYTES, { jobId: 'j5' });
    assert.strictEqual(r.resultado, 'fallido',
      'si no salió un byte no hay ambigüedad: reintentar es seguro');
    assert.strictEqual(imp.recibidos.length, 0);
  } finally { await imp.apagar(); }
});

await t('MATRIZ', '6. RST después de escribir -> INCIERTO (puede haber papel)', async () => {
  const imp = crearImpresoraSimulada({ nombre: 'INESTABLE' });
  const puerto = await imp.encender();
  imp.modo('cortar');
  try {
    const r = await tcp.enviar({ host: '127.0.0.1', puerto }, BYTES, { jobId: 'j6' });
    assert.strictEqual(r.resultado, 'incierto',
      'los bytes salieron y se perdió la confirmación: no se puede reintentar a ciegas');
  } finally { await imp.apagar(); }
});

await t('MATRIZ', '7. una impresora lenta termina bien si está dentro del tiempo', async () => {
  const imp = crearImpresoraSimulada({ nombre: 'LENTA' });
  const puerto = await imp.encender();
  imp.modo('lento', { retraso: 120 });
  try {
    const r = await tcp.enviar({ host: '127.0.0.1', puerto }, BYTES, { jobId: 'j7' });
    assert.strictEqual(r.resultado, 'enviado');
    assert.strictEqual(imp.recibidos.length, 1);
  } finally { await imp.apagar(); }
});

await t('MATRIZ', '8. sin host o sin puerto no se intenta nada -> FALLIDO de configuración', async () => {
  for (const config of [{}, { host: '127.0.0.1' }, { puerto: 9100 }, { host: '127.0.0.1', puerto: 0 }, { host: '127.0.0.1', puerto: 99999 }]) {
    const r = await tcp.enviar(config, BYTES, { jobId: 'jx' });
    assert.strictEqual(r.resultado, 'fallido', `config ${JSON.stringify(config)} debía rechazarse`);
    assert.strictEqual(r.codigo, 'CONFIG_INVALIDA');
  }
});

await t('MATRIZ', '9. el puerto NO tiene valor por defecto: 9100 no está hardcodeado', async () => {
  const fs = await import('node:fs');
  for (const archivo of ['edge/transports/tcpRaw.js', 'edge/config.js', 'src/services/impresionService.js']) {
    const src = fs.readFileSync(archivo, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\b9100\b/.test(src),
      `${archivo}: suponer el 9100 es lo que hace perder una tarde cuando el modelo escucha en otro puerto`);
  }
});

// ─── Retry: qué se reintenta y qué no ───────────────────────────────────────
function montar(dir) {
  const almacen = crearAlmacenJson({ ruta: rutaPorDefectoJson(dir) });
  const worker = crearWorker({
    almacen, transportes: { tcp_raw: tcp },
    config: { reintentoBaseMs: 10, reintentoMaximoMs: 40, maxIntentos: 4, intervaloColaMs: 10, timeoutImpresoraMs: 1500 },
    logger: loggerSilencioso,
  });
  return { almacen, worker };
}

const trabajoTcp = (id, impresora, puerto) => ({
  id, documento: 'comanda', impresoraId: `id-${impresora}`, impresoraNombre: impresora,
  transporte: 'tcp_raw', host: '127.0.0.1', puerto, anchoColumnas: 42,
  payload: { negocio: 'Demo', mesa: 4, items: [{ producto: impresora, cantidad: 1, modificadores: [] }] },
});

await t('RETRY', '10. FALLIDO se reintenta; INCIERTO no', async () => {
  const refusa = crearImpresoraSimulada({ nombre: 'REFUSA' });
  const puertoRefusa = await refusa.encender();
  await refusa.apagar();                       // puerto cerrado: fallido

  const corta = crearImpresoraSimulada({ nombre: 'CORTA' });
  await corta.encender();
  corta.modo('cortar');                        // incierto

  const { almacen, worker } = montar(dirTemporal());
  try {
    almacen.registrarTrabajo(trabajoTcp('j-fallido', 'REFUSA', puertoRefusa));
    almacen.registrarTrabajo(trabajoTcp('j-incierto', 'CORTA', corta.puerto));

    await worker.pasada();
    assert.strictEqual(almacen.obtener('j-fallido').estado, 'fallido');
    assert.strictEqual(almacen.obtener('j-incierto').estado, 'incierto');

    await worker.pasada(Date.now() + 999_999);
    assert.strictEqual(almacen.obtener('j-fallido').intentos, 2, 'lo fallido SÍ se reintenta');
    assert.strictEqual(almacen.obtener('j-incierto').intentos, 1, 'lo incierto NO se reintenta solo');
  } finally { await refusa.apagar(); await corta.apagar(); almacen.cerrar(); }
});

await t('E2E', '11. cuatro impresoras a la vez: cada una recibe SOLO lo suyo', async () => {
  const impresoras = {};
  for (const nombre of ['TICKETS', 'CHILAQUILES', 'COCINA GENERAL', 'BEBIDAS']) {
    impresoras[nombre] = crearImpresoraSimulada({ nombre });
    await impresoras[nombre].encender();
  }
  const { almacen, worker } = montar(dirTemporal());
  try {
    for (const [nombre, imp] of Object.entries(impresoras)) {
      almacen.registrarTrabajo(trabajoTcp(`j-${nombre}`, nombre, imp.puerto));
    }
    await worker.pasada();
    for (const [nombre, imp] of Object.entries(impresoras)) {
      assert.strictEqual(imp.recibidos.length, 1, `${nombre} debía recibir exactamente 1`);
      assert.ok(imp.recibidos[0].texto.includes(nombre.toUpperCase()), `${nombre} recibió lo de otra impresora`);
      assert.strictEqual(almacen.obtener(`j-${nombre}`).estado, 'enviado');
    }
  } finally {
    for (const imp of Object.values(impresoras)) await imp.apagar();
    almacen.cerrar();
  }
});

await t('E2E', '12. la impresora que se apaga y vuelve imprime UNA vez, sin duplicar', async () => {
  const buena = crearImpresoraSimulada({ nombre: 'GENERAL' });
  const mala = crearImpresoraSimulada({ nombre: 'CHILAQUILES' });
  await buena.encender();
  await mala.encender();
  const puertoMala = mala.puerto;
  await mala.apagar();

  const { almacen, worker } = montar(dirTemporal());
  try {
    almacen.registrarTrabajo(trabajoTcp('j-buena', 'GENERAL', buena.puerto));
    almacen.registrarTrabajo(trabajoTcp('j-mala', 'CHILAQUILES', puertoMala));

    await worker.pasada();
    assert.strictEqual(almacen.obtener('j-buena').estado, 'enviado', 'la que sí está imprime igual');
    assert.strictEqual(almacen.obtener('j-mala').estado, 'fallido');
    assert.strictEqual(buena.recibidos.length, 1);

    await mala.reencender();
    await worker.pasada(Date.now() + 999_999);

    assert.strictEqual(almacen.obtener('j-mala').estado, 'enviado');
    assert.strictEqual(mala.recibidos.length, 1, 'una sola impresión tras recuperarse');
    assert.strictEqual(buena.recibidos.length, 1, 'y la otra no reimprime nada');
  } finally { await buena.apagar(); await mala.apagar(); almacen.cerrar(); }
});

await t('SEGURIDAD', '13. la nube no importa NUNCA el transporte TCP ni abre sockets', async () => {
  const fs = await import('node:fs');
  for (const archivo of ['src/server.js', 'src/services/impresionService.js',
                         'src/printing/routingEngine.js', 'src/services/edgeService.js']) {
    const src = fs.readFileSync(archivo, 'utf8');
    assert.ok(!/from ['"].*transports\/tcpRaw/.test(src), `${archivo} no debe importar el transporte TCP`);
    assert.ok(!/net\.(connect|createConnection)/.test(src), `${archivo} no debe abrir sockets`);
    assert.ok(!/require\(['"]net['"]\)|from ['"]node:net['"]/.test(src), `${archivo} no debe importar 'net'`);
  }
});

for (const d of temporales) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
