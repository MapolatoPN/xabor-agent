// El Edge, corriendo SOLO, tiene que sobrevivir a que Xabor se caiga.
//
// Esta suite existe porque ninguna de las otras podía detectar el defecto que
// dejó a Mapolato Acuña sin impresión: todas embeben el agente dentro del
// proceso de pruebas, que ya tiene un servidor HTTP y un pool de Postgres
// manteniendo vivo el event loop. Ahí el agente nunca se queda solo.
//
// En un restaurante sí. Y cuando el WebSocket se cerraba, no quedaba ni un
// handle referenciado -- todos los temporizadores del Edge llevan .unref() --
// así que Node se daba por terminado y el proceso salía con código 0 justo
// después de escribir "conexion.reintento intento=1". El reintento nunca
// llegaba a ocurrir.
//
// Por eso aquí se lanza `node edge/index.js` como PROCESO DE VERDAD, con su
// propio event loop y nada más dentro. Es la única forma de probar esto.
//
// No necesita Postgres ni el servidor de Xabor: la nube se simula con un
// WebSocket mínimo que responde el handshake de autenticación.
//
// Uso: node test/fase-edge-standalone-supervivencia.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const PUERTO = Number(process.env.TEST_PORT_EDGE || 45871);
const TERMINAL_ID = '00000000-0000-0000-0000-0000000000e1';
const TOKEN = 'e'.repeat(64);

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const vive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ─── El agente, como proceso independiente ──────────────────────────────────

const dirDatos = mkdtempSync(join(tmpdir(), 'xabor-standalone-'));
let salida = '';
const agente = spawn(process.execPath, [join(RAIZ, 'edge', 'index.js')], {
  cwd: RAIZ,
  env: {
    ...process.env,
    XABOR_EDGE_WS_URL: `ws://127.0.0.1:${PUERTO}/ws/print-agent`,
    XABOR_TERMINAL_ID: TERMINAL_ID,
    XABOR_TERMINAL_TOKEN: TOKEN,
    XABOR_EDGE_DATOS: dirDatos,
    // Reintentos cortos para que la prueba no dure minutos. No se toca la
    // semántica: solo la escala del backoff.
    XABOR_EDGE_RECONEXION_MS: '300',
    XABOR_EDGE_RECONEXION_MAX_MS: '900',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
agente.stdout.on('data', (d) => { salida += d.toString(); });
agente.stderr.on('data', (d) => { salida += d.toString(); });

let salioSolo = false;
let codigoSalida = null;
agente.on('exit', (c) => { salioSolo = true; codigoSalida = c; });

// Espera a que aparezca un texto en la salida del agente, o se agota.
async function hastaVerEnLog(patron, { limiteMs = 8000, que = patron } = {}) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) {
    if (new RegExp(patron).test(salida)) return true;
    if (salioSolo) throw new Error(`el agente MURIÓ (código ${codigoSalida}) esperando "${que}"`);
    await esperar(100);
  }
  throw new Error(`no apareció "${que}" en ${limiteMs}ms`);
}

try {
  // ─── 1. Con la nube caída, reintenta y NO se muere ────────────────────────

  await t('1. arranca sin nube y programa el primer reintento', async () => {
    await hastaVerEnLog('conexion\\.reintento intento=1', { que: 'intento=1' });
    assert.ok(vive(agente.pid), 'el agente tiene que seguir vivo tras programar el reintento');
  });

  await t('2. el reintento SÍ ocurre: llega al intento 2', async () => {
    await hastaVerEnLog('conexion\\.reintento intento=2', { que: 'intento=2' });
    assert.strictEqual(salioSolo, false, 'el proceso no puede terminar entre reintentos');
  });

  await t('3. y sigue: intento 3, con la espera creciendo', async () => {
    await hastaVerEnLog('conexion\\.reintento intento=3', { que: 'intento=3' });
    const esperas = [...salida.matchAll(/conexion\.reintento intento=(\d+) esperaMs=(\d+)/g)]
      .map((m) => Number(m[2]));
    assert.ok(esperas.length >= 3, `se esperaban 3 reintentos y hubo ${esperas.length}`);
    assert.ok(esperas[1] > esperas[0],
      `la espera debe crecer para no martillear a la nube: ${esperas.join(', ')}`);
  });

  await t('4. el PID sigue siendo el mismo: nadie lo reinició', async () => {
    assert.ok(vive(agente.pid), `el PID ${agente.pid} tiene que seguir vivo`);
    assert.strictEqual(salioSolo, false,
      'ESTE es el defecto que dejó a Acuña sin impresión: el proceso salía con código 0 ' +
      'justo después de programar el reintento, porque todos sus temporizadores llevan .unref()');
  });

  // ─── 2. Vuelve la nube: reconecta solo, sin tocar nada ────────────────────

  let autenticado = null;
  const servidor = new WebSocketServer({ port: PUERTO, path: '/ws/print-agent' });
  servidor.on('connection', (ws) => {
    ws.on('message', (crudo) => {
      let msg = null; try { msg = JSON.parse(crudo.toString()); } catch { return; }
      if (msg.tipo !== 'autenticar_terminal') return;
      // La nube simulada solo comprueba lo justo para responder el handshake.
      if (msg.terminalId !== TERMINAL_ID || msg.token !== TOKEN) { ws.close(4003); return; }
      autenticado = { terminalId: msg.terminalId, instalacionId: msg.instalacionId };
      ws.send(JSON.stringify({
        tipo: 'terminal_autenticada', terminalId: TERMINAL_ID,
        negocioId: '00000000-0000-0000-0000-0000000000b1',
        sucursalId: '00000000-0000-0000-0000-0000000000c1',
      }));
    });
  });

  await t('5. al volver la nube, el MISMO proceso conecta y se autentica', async () => {
    await hastaVerEnLog('conexion\\.autenticada', { que: 'conexion.autenticada', limiteMs: 15000 });
    assert.ok(autenticado, 'la nube simulada tiene que haber recibido el handshake');
    assert.ok(vive(agente.pid), 'y todo sin que nadie reiniciara el agente');
    assert.strictEqual(salioSolo, false);
  });

  await t('6. el token nunca aparece en la salida del agente', () => {
    assert.ok(!salida.includes(TOKEN),
      'el token de la terminal JAMÁS puede quedar en un log: es la credencial del equipo');
  });

  servidor.close();
} finally {
  try { agente.kill(); } catch { /* ya no está */ }
  await esperar(300);
  try { rmSync(dirDatos, { recursive: true, force: true }); } catch { /* en uso */ }
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach((f) => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
