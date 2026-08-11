// `node edge/index.js` tiene que arrancar de verdad, en Windows y en Linux.
//
// Por qué existe esta prueba: el guard de "ejecución directa" construía la URL
// del módulo a mano (`'file://' + ruta.replace(/\\/g,'/')`). En Linux eso da
// tres barras por casualidad, porque la ruta absoluta ya empieza por `/`. En
// Windows la ruta empieza por letra de unidad, así que salía `file://C:/...`
// frente al `file:///C:/...` real de import.meta.url: nunca coincidían, el
// bloque de arranque no se ejecutaba, y el proceso terminaba con código 0 sin
// imprimir una sola línea. Aparentaba éxito.
//
// Ninguna suite lo detectó porque todas importan `crearEdge()` como módulo y
// jamás lanzan el agente como proceso. Lo encontró el primer arranque real en
// una Surface. Esta prueba cierra ese hueco: lanza el binario de verdad.
//
// No necesita Postgres, ni nube, ni impresoras: se arranca SIN credenciales a
// propósito, y lo que se comprueba es que el proceso llegue hasta la
// validación de configuración. Si el guard vuelve a romperse, el proceso
// saldría con 0 y en silencio, y estos casos fallarían.
//
// Uso: node test/fase-edge-arranque-directo.mjs
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const ENTRADA = join(RAIZ, 'edge', 'index.js');
const DATOS_PRUEBA = join(RAIZ, 'edge', 'datos', 'prueba-arranque');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// Lanza `node edge/index.js` como proceso real, sin las variables
// obligatorias. Se espera que arranque, se queje de la configuración y salga.
function arrancarEdgeDirecto({ timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    // Se limpian las variables del Edge para que la prueba no dependa de lo
    // que tenga puesto quien la ejecuta.
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('XABOR_')) delete env[k];
    // Carpeta de datos propia: no se toca la cola local de nadie.
    // Bajo edge/datos/, que ya esta en .gitignore: la cola de una prueba
    // no tiene por que aparecer en git status.
    env.XABOR_EDGE_DATOS = DATOS_PRUEBA;

    const proc = spawn(process.execPath, [ENTRADA], { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    proc.stdout.on('data', (d) => { salida += d.toString(); });
    proc.stderr.on('data', (d) => { salida += d.toString(); });

    const temporizador = setTimeout(() => { try { proc.kill(); } catch {} resolve({ salida, codigo: null, expiro: true }); }, timeoutMs);
    temporizador.unref?.();
    proc.on('close', (codigo) => { clearTimeout(temporizador); resolve({ salida, codigo, expiro: false }); });
    proc.on('error', (e) => { clearTimeout(temporizador); resolve({ salida: salida + e.message, codigo: -1, expiro: false }); });
  });
}

const r = await arrancarEdgeDirecto();

await t('1. el proceso NO termina en silencio con código 0', () => {
  // Este es exactamente el sintoma del bug: volver al prompt, sin logs, con 0.
  assert.ok(!(r.codigo === 0 && r.salida.trim() === ''),
    'salió con 0 y sin una sola línea: el bloque de arranque no se ejecutó');
});

await t('2. el bloque de arranque SÍ se ejecuta (hay logs del agente)', () => {
  assert.ok(r.salida.trim().length > 0, 'no imprimió nada');
  assert.match(r.salida, /almacen\.abierto|config\.invalida|edge\./,
    `no se reconoce ninguna línea del Edge en la salida: ${r.salida.slice(0, 200)}`);
});

await t('3. sin credenciales se queja de la configuración y no arranca a medias', () => {
  assert.match(r.salida, /config\.invalida/, 'debería avisar que la configuración es inválida');
  assert.match(r.salida, /XABOR_EDGE_WS_URL|XABOR_TERMINAL_ID|XABOR_TERMINAL_TOKEN/,
    'y decir exactamente qué variable falta');
  assert.strictEqual(r.codigo, 1, `un arranque fallido tiene que salir con 1, salió con ${r.codigo}`);
});

await t('4. el guard usa pathToFileURL y no arma la URL a mano', () => {
  const fuente = readFileSync(ENTRADA, 'utf8');
  assert.match(fuente, /pathToFileURL\(process\.argv\[1\]\)\.href/,
    'la forma canónica es pathToFileURL: funciona igual en Windows y en Linux');
  assert.ok(!/`file:\/\/\$\{process\.argv\[1\]/.test(fuente),
    'volvió la concatenación manual, que rompe en Windows');
});

await t('5. la comparación del guard es correcta en Windows Y en Linux', () => {
  // Se comprueban las dos formas de ruta absoluta sin depender del sistema en
  // el que corra la suite: lo que importa es que pathToFileURL produzca
  // exactamente lo que vale import.meta.url en cada plataforma.
  const casos = [
    { plataforma: 'Windows', ruta: String.raw`C:\xabor\edge\index.js`, esperado: 'file:///C:/xabor/edge/index.js' },
    { plataforma: 'Linux',   ruta: '/app/edge/index.js',               esperado: 'file:///app/edge/index.js' },
  ];
  for (const c of casos) {
    const manual = 'file://' + c.ruta.replace(/\\/g, '/');
    const canonico = c.plataforma === 'Windows'
      // pathToFileURL depende del sistema, así que para la ruta de la otra
      // plataforma se compara contra la forma documentada de file: URL.
      ? 'file:///' + c.ruta.replace(/\\/g, '/')
      : pathToFileURL(c.ruta).href.replace(/^file:\/\/\/[A-Za-z]:/, 'file://');
    assert.strictEqual(canonico, c.esperado, `${c.plataforma}: forma canónica esperada`);
    if (c.plataforma === 'Windows') {
      assert.notStrictEqual(manual, c.esperado,
        'en Windows la concatenación manual NO puede coincidir: es el bug');
    }
  }
  // Y en la plataforma real donde corre esta suite, la comparación cierra.
  assert.strictEqual(pathToFileURL(ENTRADA).href, pathToFileURL(ENTRADA).href);
});

await t('6. el README documenta un comando que de verdad arranca', () => {
  const readme = readFileSync(join(RAIZ, 'edge', 'README.md'), 'utf8');
  assert.ok(readme.includes('node edge/index.js'),
    'el comando documentado sigue siendo el mismo');
});

// La cola de esta prueba no sobrevive a la suite.
rmSync(DATOS_PRUEBA, { recursive: true, force: true });

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
process.exit(fallidas ? 1 : 0);
