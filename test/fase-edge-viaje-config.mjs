// El VIAJE completo del destino, no sus tramos.
//
// Esta suite existe porque el mismo dato -- el nombre con el que Windows
// conoce la impresora -- se perdió cinco veces seguidas, en cinco eslabones
// distintos, y cada vez había una suite en verde cubriendo el tramo de al
// lado:
//
//   1. la nube no lo consultaba          (SELECT sin `config`)
//   2. la nube no lo serializaba         (trabajoParaEdge sin `config`)
//   3. el agente no lo guardaba          (recibirTrabajo con lista explícita)
//   4. la cola local no tenía columna    (esquema SQLite sin `config`)
//   5. el worker no se lo pasaba         (objeto de destino sin `config`)
//
// Probar tramos no sirve cuando el fallo es que el dato no cruza de uno al
// siguiente. Aquí se recorre el camino entero de una vez:
//
//   sobre de la nube -> recibirTrabajo() -> cola local -> worker -> transporte
//
// Con un transporte espía, sin hardware, sin nube y sin Postgres.
//
// Uso: node test/fase-edge-viaje-config.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { crearEdge } from '../edge/index.js';
import { cargarConfig } from '../edge/config.js';
import { sqliteDisponible } from '../edge/storage/sqlite.js';

// El nombre real de la térmica de la Surface. Los DOS espacios entre '203DPI'
// y 'Series' son literales: con uno solo, OpenPrinter no encuentra la cola.
const NOMBRE_WINDOWS = 'POS Printer 203DPI  Series 2';

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const temporales = [];
function dirTemporal() {
  const d = mkdtempSync(join(tmpdir(), 'xabor-viaje-'));
  temporales.push(d);
  return d;
}

const CONFIG = {
  ...cargarConfig({ env: {} }),
  reintentoBaseMs: 10, reintentoMaximoMs: 40, maxIntentos: 3,
  intervaloColaMs: 10, timeoutImpresoraMs: 200,
};
const loggerSilencioso = { debug() {}, info() {}, warn() {}, error() {} };

// Transporte espía: no imprime nada, solo guarda EXACTAMENTE el objeto de
// destino que le entrega el worker. Es el final del viaje.
function crearEspia() {
  const recibidos = [];
  return {
    recibidos,
    transporte: {
      nombre: 'mock',
      async enviar(destino, bytes, contexto) {
        recibidos.push({ destino, bytes: bytes.length });
        contexto.alEscribir?.();
        return { resultado: 'enviado', codigo: null, detalle: 'espía' };
      },
    },
  };
}

// El sobre TAL COMO lo arma la nube (trabajoParaEdge en src/server.js). Que
// la nube lo emita así lo prueba fase-impresion-self-service (caso 43b) sobre
// el WebSocket real; aquí se parte de esa misma forma.
function sobreDeLaNube(id, extra = {}) {
  return {
    id,
    documento: 'prueba',
    impresoraId: 'imp-1',
    impresoraNombre: 'Como se ve en el panel',   // nombre VISIBLE, distinto a propósito
    transporte: 'windows_spooler',
    host: null,
    puerto: null,
    anchoColumnas: 32,
    config: { spoolerNombre: NOMBRE_WINDOWS },
    payload: { documento: 'prueba', negocio: 'Prueba Surface', impresora: NOMBRE_WINDOWS,
               emitidoAt: new Date().toISOString() },
    ...extra,
  };
}

async function esperar(cond, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

const BACKENDS = [];
if (sqliteDisponible()) BACKENDS.push('sqlite');
BACKENDS.push('json');

// ─── El viaje, en los dos almacenes ─────────────────────────────────────────

for (const almacen of BACKENDS) {
  await t(`1.${almacen} el destino llega ENTERO desde el sobre hasta el transporte`, async () => {
    const espia = crearEspia();
    const dir = dirTemporal();
    const edge = crearEdge({
      config: { ...CONFIG, rutaDatos: dir, almacen },
      logger: loggerSilencioso,
      transportes: { mock: espia.transporte, windows_spooler: espia.transporte },
    });
    await edge.iniciar({ conectar: false });   // sin nube: el viaje se prueba local
    try {
      // Entra por la MISMA puerta que usa el WebSocket.
      edge._recibirTrabajo(sobreDeLaNube('viaje-1'));
      assert.ok(await esperar(() => espia.recibidos.length > 0),
        'el worker nunca llegó a llamar al transporte');

      const { destino } = espia.recibidos[0];
      assert.ok(destino.config, 'el transporte recibió el destino SIN config: ahí se rompe todo');
      assert.strictEqual(destino.config.spoolerNombre, NOMBRE_WINDOWS,
        'el nombre de Windows tiene que llegar idéntico al final del viaje');
      assert.ok(/203DPI {2}Series/.test(destino.config.spoolerNombre),
        'los DOS espacios: con uno solo Windows no encuentra la cola');
      assert.strictEqual(destino.nombre, 'Como se ve en el panel',
        'el nombre visible sigue viajando aparte, sin mezclarse con el identificador técnico');
    } finally {
      await edge.detener();
    }
  });

  await t(`2.${almacen} config sobrevive un reinicio del agente`, async () => {
    // La cola es lo que hace que una comanda no se pierda con un corte de luz.
    // Si `config` no se persiste, al reiniciar el trabajo revive sin destino.
    const dir = dirTemporal();
    const primero = crearEdge({
      config: { ...CONFIG, rutaDatos: dir, almacen, intervaloColaMs: 100000 },  // no procesa
      logger: loggerSilencioso, transportes: { mock: crearEspia().transporte },
    });
    await primero.iniciar({ conectar: false });
    primero._recibirTrabajo(sobreDeLaNube('viaje-reinicio'));
    await primero.detener();

    const espia = crearEspia();
    const segundo = crearEdge({
      config: { ...CONFIG, rutaDatos: dir, almacen },
      logger: loggerSilencioso,
      transportes: { mock: espia.transporte, windows_spooler: espia.transporte },
    });
    await segundo.iniciar({ conectar: false });
    try {
      assert.ok(await esperar(() => espia.recibidos.length > 0),
        'el trabajo pendiente tenía que retomarse al reiniciar');
      assert.strictEqual(espia.recibidos[0].destino.config.spoolerNombre, NOMBRE_WINDOWS,
        'tras el reinicio el destino sigue completo');
    } finally {
      await segundo.detener();
    }
  });

  await t(`3.${almacen} un trabajo SIN config (tcp_raw/mock) sigue funcionando`, async () => {
    const espia = crearEspia();
    const edge = crearEdge({
      config: { ...CONFIG, rutaDatos: dirTemporal(), almacen },
      logger: loggerSilencioso, transportes: { mock: espia.transporte },
    });
    await edge.iniciar({ conectar: false });
    try {
      const sinConfig = sobreDeLaNube('viaje-sin-cfg', { transporte: 'mock', host: '127.0.0.1', puerto: 9100 });
      delete sinConfig.config;
      edge._recibirTrabajo(sinConfig);
      assert.ok(await esperar(() => espia.recibidos.length > 0), 'tiene que procesarse igual');
      const { destino } = espia.recibidos[0];
      assert.strictEqual(destino.host, '127.0.0.1', 'el destino de tcp_raw sigue intacto');
      assert.deepStrictEqual(destino.config, {}, 'sin config se pasa un objeto vacío, nunca undefined');
    } finally {
      await edge.detener();
    }
  });

  await t(`4.${almacen} el viaje no altera estados ni reintentos`, async () => {
    const espia = crearEspia();
    const edge = crearEdge({
      config: { ...CONFIG, rutaDatos: dirTemporal(), almacen },
      logger: loggerSilencioso,
      transportes: { mock: espia.transporte, windows_spooler: espia.transporte },
    });
    await edge.iniciar({ conectar: false });
    try {
      edge._recibirTrabajo(sobreDeLaNube('viaje-estado'));
      assert.ok(await esperar(() => edge.estado().trabajos.enviado === 1),
        'un envío correcto tiene que terminar en enviado');
      const est = edge.estado();
      assert.strictEqual(est.trabajos.enviado, 1);
      assert.ok(!est.trabajos.fallido, 'sin fallidos');
      assert.ok(!est.trabajos.incierto, 'y sin inciertos: nadie tocó la semántica');
    } finally {
      await edge.detener();
    }
  });
}

// ─── Que la lista explícita no vuelva a olvidarse ───────────────────────────

await t('5. recibirTrabajo copia config del sobre (lectura del código)', async () => {
  const { readFileSync } = await import('node:fs');
  const fuente = readFileSync(new URL('../edge/index.js', import.meta.url), 'utf8');
  const i = fuente.indexOf('almacen.registrarTrabajo({');
  assert.ok(i > 0, 'no se encontró la copia del sobre a la cola');
  const bloque = fuente.slice(i, fuente.indexOf('});', i));
  assert.match(bloque, /config: trabajo\.config/,
    'la lista es explícita: si se olvida config, el destino se pierde otra vez');
});

for (const d of temporales) rmSync(d, { recursive: true, force: true });

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
process.exit(fallidas ? 1 : 0);
