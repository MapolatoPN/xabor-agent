// Transporte TCP contra un simulador de impresora térmica.
//
// Aquí se prueban los fallos que de verdad van a pasar en Obispado: la
// impresora apagada, la IP equivocada, el cable que se suelta a media
// comanda, la que tarda. Todo contra sockets reales en 127.0.0.1 -- nunca
// contra la red del restaurante ni contra hardware.
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

const tcp = crearTransporteTcpRaw({ logger: loggerSilencioso, timeoutMs: 800 });
const BYTES = renderizar('comanda', {
  negocio: 'Mapolato Demo', mesa: 4, mesero: 'ANGEL', ronda: 1,
  items: [{ producto: 'Chilaquiles', cantidad: 1, modificadores: [{ grupo: 'Salsa', opcion: 'Verde' }], notas: 'Sin cebolla' }],
});

await t('TCP', '1. la impresora en línea recibe los bytes exactos que se le mandaron', async () => {
  const imp = crearImpresoraSimulada({ nombre: 'COCINA' });
  const puerto = await imp.encender();
  try {
    const r = await tcp.enviar({ host: '127.0.0.1', puerto }, BYTES, { jobId: 'j1' });
    assert.strictEqual(r.ok, true, `debía imprimir y devolvió ${JSON.stringify(r)}`);
    assert.strictEqual(imp.recibidos.length, 1);
    assert.ok(imp.recibidos[0].bytes.equals(BYTES), 'los bytes tienen que llegar íntegros');
    assert.ok(imp.recibidos[0].texto.includes('CHILAQUILES'));
    assert.ok(imp.recibidos[0].texto.includes('Salsa: Verde'));
    assert.ok(imp.recibidos[0].texto.includes('NOTA: Sin cebolla'));
  } finally { await imp.apagar(); }
});

await t('TCP', '2. impresora apagada -> ECONNREFUSED explicado, sin ambigüedad', async () => {
  const imp = crearImpresoraSimulada({ nombre: 'BEBIDAS' });
  const puerto = await imp.encender();
  await imp.apagar();                       // el puerto deja de escuchar de verdad
  const r = await tcp.enviar({ host: '127.0.0.1', puerto }, BYTES, { jobId: 'j2' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.codigo, 'ECONNREFUSED');
  assert.match(r.detalle, /rechaz/i, 'el mensaje tiene que servirle a un técnico, no solo el código');
  assert.ok(!r.incierto, 'si no llegó a conectar, no hay duda: no salió papel');
});

await t('TCP', '3. impresora que no responde -> ETIMEDOUT y no se queda colgado', async () => {
  const imp = crearImpresoraSimulada({ nombre: 'MUDA' });
  const puerto = await imp.encender();
  imp.modo('timeout');
  try {
    const inicio = Date.now();
    const r = await tcp.enviar({ host: '127.0.0.1', puerto }, BYTES, { jobId: 'j3' });
    const tardanza = Date.now() - inicio;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.codigo, 'ETIMEDOUT');
    assert.ok(tardanza < 3000, `el timeout debe cortar solo (tardó ${tardanza}ms)`);
  } finally { await imp.apagar(); }
});

await t('TCP', '4. conexión cortada a media transmisión -> se marca INCIERTO, no fallo limpio', async () => {
  const imp = crearImpresoraSimulada({ nombre: 'INESTABLE' });
  const puerto = await imp.encender();
  imp.modo('cortar');
  try {
    const r = await tcp.enviar({ host: '127.0.0.1', puerto }, BYTES, { jobId: 'j4' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.incierto, true,
      'los bytes salieron y se perdió la confirmación: puede haber papel, no se puede reintentar a ciegas');
  } finally { await imp.apagar(); }
});

await t('TCP', '5. una impresora lenta termina imprimiendo si está dentro del timeout', async () => {
  const imp = crearImpresoraSimulada({ nombre: 'LENTA' });
  const puerto = await imp.encender();
  imp.modo('lento', { retraso: 200 });
  try {
    const r = await tcp.enviar({ host: '127.0.0.1', puerto }, BYTES, { jobId: 'j5' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(imp.recibidos.length, 1);
  } finally { await imp.apagar(); }
});

await t('TCP', '6. sin host o sin puerto no se intenta nada: es un error de configuración', async () => {
  for (const config of [{}, { host: '127.0.0.1' }, { puerto: 9100 }, { host: '127.0.0.1', puerto: 0 }, { host: '127.0.0.1', puerto: 99999 }]) {
    const r = await tcp.enviar(config, BYTES, { jobId: 'jx' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.codigo, 'CONFIG_INVALIDA', `config ${JSON.stringify(config)} debía rechazarse`);
  }
});

await t('TCP', '7. el puerto NO tiene valor por defecto: 9100 no está hardcodeado', async () => {
  const fuentes = await Promise.all([
    import('node:fs').then(fs => fs.readFileSync('edge/transports/tcpRaw.js', 'utf8')),
    import('node:fs').then(fs => fs.readFileSync('edge/config.js', 'utf8')),
    import('node:fs').then(fs => fs.readFileSync('src/services/impresionService.js', 'utf8')),
  ]);
  for (const src of fuentes) {
    assert.ok(!/\b9100\b/.test(src.replace(/^\s*\/\/.*$/gm, '')),
      'suponer el 9100 es lo que hace perder una tarde en sitio cuando el modelo escucha en otro puerto');
  }
});

// ── Camino completo con el worker ───────────────────────────────────────────
function montar(dir) {
  const almacen = crearAlmacenJson({ ruta: rutaPorDefectoJson(dir) });
  const worker = crearWorker({
    almacen, transportes: { tcp_raw: tcp },
    config: { reintentoBaseMs: 10, reintentoMaximoMs: 40, maxIntentos: 4, intervaloColaMs: 10, timeoutImpresoraMs: 800 },
    logger: loggerSilencioso,
  });
  return { almacen, worker };
}

const trabajoTcp = (id, impresora, puerto) => ({
  id, documento: 'comanda', impresoraId: `id-${impresora}`, impresoraNombre: impresora,
  transporte: 'tcp_raw', host: '127.0.0.1', puerto, anchoColumnas: 42,
  payload: { negocio: 'Demo', mesa: 4, items: [{ producto: impresora, cantidad: 1, modificadores: [] }] },
});

await t('E2E', '8. cuatro impresoras a la vez: cada una recibe SOLO lo suyo', async () => {
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
      assert.strictEqual(almacen.obtener(`j-${nombre}`).estado, 'impreso');
    }
  } finally {
    for (const imp of Object.values(impresoras)) await imp.apagar();
    almacen.cerrar();
  }
});

await t('E2E', '9. la impresora que se apaga y vuelve imprime UNA vez, sin duplicar', async () => {
  const buena = crearImpresoraSimulada({ nombre: 'GENERAL' });
  const mala = crearImpresoraSimulada({ nombre: 'CHILAQUILES' });
  await buena.encender();
  await mala.encender();
  const puertoMala = mala.puerto;
  await mala.apagar();                                  // se apaga antes de la ronda

  const { almacen, worker } = montar(dirTemporal());
  try {
    almacen.registrarTrabajo(trabajoTcp('j-buena', 'GENERAL', buena.puerto));
    almacen.registrarTrabajo(trabajoTcp('j-mala', 'CHILAQUILES', puertoMala));

    await worker.pasada();
    assert.strictEqual(almacen.obtener('j-buena').estado, 'impreso', 'la que sí está imprime igual');
    assert.strictEqual(almacen.obtener('j-mala').estado, 'fallido', 'la caída queda pendiente');
    assert.strictEqual(buena.recibidos.length, 1);

    await mala.reencender();                            // alguien la enciende
    await worker.pasada(Date.now() + 999_999);

    assert.strictEqual(almacen.obtener('j-mala').estado, 'impreso');
    assert.strictEqual(mala.recibidos.length, 1, 'una sola impresión tras recuperarse');
    assert.strictEqual(buena.recibidos.length, 1, 'y la otra no reimprime nada');
  } finally {
    await buena.apagar(); await mala.apagar(); almacen.cerrar();
  }
});

await t('E2E', '10. un corte a media transmisión deja el trabajo en incierto y NO reintenta', async () => {
  const imp = crearImpresoraSimulada({ nombre: 'INESTABLE' });
  await imp.encender();
  imp.modo('cortar');
  const { almacen, worker } = montar(dirTemporal());
  try {
    almacen.registrarTrabajo(trabajoTcp('j1', 'INESTABLE', imp.puerto));
    await worker.pasada();
    assert.strictEqual(almacen.obtener('j1').estado, 'incierto');

    imp.modo('online');
    await worker.pasada(Date.now() + 999_999);
    assert.strictEqual(almacen.obtener('j1').intentos, 1, 'no se reintenta solo un caso ambiguo');
  } finally { await imp.apagar(); almacen.cerrar(); }
});

await t('SEGURIDAD', '11. el servidor de la nube no importa NUNCA el transporte TCP', async () => {
  const fs = await import('node:fs');
  const server = fs.readFileSync('src/server.js', 'utf8');
  const servicio = fs.readFileSync('src/services/impresionService.js', 'utf8');
  for (const [nombre, src] of [['server.js', server], ['impresionService.js', servicio]]) {
    assert.ok(!/from ['"].*transports\/tcpRaw/.test(src), `${nombre} no debe importar el transporte TCP`);
    assert.ok(!/net\.(connect|createConnection)/.test(src), `${nombre} no debe abrir sockets: la LAN es cosa del Edge`);
    assert.ok(!/require\(['"]net['"]\)|from ['"]node:net['"]/.test(src), `${nombre} no debe importar 'net'`);
  }
});

for (const d of temporales) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
