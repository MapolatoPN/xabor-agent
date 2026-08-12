// El instalador ante un servicio XaborEdge que YA existe.
//
// Defecto real (Acuña, 2026-08-11): actualizar una instalación existente
// moría con "A service with ID 'XaborEdge' already exists" -- el .iss hacía
// `install` incondicional. Y debajo había un segundo defecto que ese error
// tapaba: nadie detenía el servicio antes de copiar, así que los binarios se
// reemplazaban con el proceso viejo todavía usándolos.
//
// Registrar un servicio de Windows real exige elevación y ensuciaría el
// equipo de desarrollo, así que aquí se prueba el CONTRATO del .iss -- las
// decisiones que tiene que contener y el orden en que tienen que ocurrir --
// igual que fase-edge-discovery-timeouts prueba el contrato de los timeouts.
// La matriz manual sobre una VM queda documentada aparte.
//
// Uso: node test/fase-instalador-upgrade.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ISS = readFileSync(join(__dirname, '..', 'installer', 'XaborEdge.iss'), 'utf8');

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// Secciones del script, para poder afirmar QUE pasa y DONDE.
const prepare = ISS.slice(ISS.indexOf('function PrepareToInstall'), ISS.indexOf('procedure CurStepChanged'));
const postInstall = ISS.slice(ISS.indexOf('procedure CurStepChanged'));

t('1. la existencia del servicio se pregunta con sc.exe, no con el wrapper', () => {
  assert.ok(/function\s+ServicioExiste/i.test(ISS));
  const fn = ISS.slice(ISS.indexOf('function ServicioExiste'), ISS.indexOf('function ServicioEnEstado'));
  assert.ok(/sc\.exe/.test(fn),
    'en un upgrade, el wrapper es justo uno de los archivos a reemplazar: no se le puede preguntar a el');
});

t('2. antes de copiar, el servicio corriendo se detiene y se ESPERA a STOPPED', () => {
  assert.ok(/sc\.exe',\s*'stop\s+\{#ServicioId\}/.test(prepare),
    'el stop tiene que ocurrir en PrepareToInstall: es lo que corre ANTES de la fase de copia de archivos');
  assert.ok(/EsperarEstadoServicio\('STOPPED'/.test(prepare),
    'mandar stop y seguir de largo deja la copia compitiendo con un proceso que aun tiene los binarios abiertos');
});

t('3. la espera es real: bucle con Sleep y tope, no una sola mirada', () => {
  const fn = ISS.slice(ISS.indexOf('function EsperarEstadoServicio'), ISS.indexOf('function PrepareToInstall'));
  assert.ok(/while/.test(fn) && /Sleep\(/.test(fn), 'sin bucle no hay espera');
  assert.ok(/MaxMs/.test(fn), 'sin tope, un servicio colgado congelaria el instalador para siempre');
});

t('4. si el stop expira, se aborta ANTES de copiar y sin instalacion a medias', () => {
  const bloqueStop = prepare.slice(prepare.indexOf("EsperarEstadoServicio('STOPPED'"));
  assert.ok(/Result\s*:=/.test(bloqueStop.slice(0, 400)),
    'el timeout de stop tiene que devolver un error de PrepareToInstall (que cancela sin haber escrito nada)');
  assert.ok(/sigue intacta/i.test(bloqueStop.slice(0, 600)),
    'y decirle a quien instala que la instalacion actual no se toco');
});

t('5. install SOLO si el servicio no existe: un upgrade no re-registra', () => {
  assert.ok(/if\s+not\s+ServicioExiste\s+then/i.test(postInstall),
    'el install incondicional es exactamente lo que moria con "already exists"');
  // Y el install sigue existiendo para la instalacion limpia.
  assert.ok(/'install'/.test(postInstall));
});

t('6. tras arrancar, se CONFIRMA RUNNING en vez de asumirlo', () => {
  assert.ok(/'start'/.test(postInstall));
  assert.ok(/EsperarEstadoServicio\('RUNNING'/.test(postInstall),
    'start puede volver con 0 y el proceso morirse al segundo: hay que mirar el estado de verdad');
});

t('7. nada de matar procesos como camino normal', () => {
  assert.ok(!/taskkill|Stop-Process|KillProc/i.test(ISS),
    'el camino normal es stop limpio del servicio; matar el proceso corrompe la cola SQLite');
});

t('8. los datos de ProgramData no se tocan en el camino de upgrade', () => {
  // La unica eliminacion del arbol de datos permitida es la del uninstall,
  // detras de la pregunta explicita al usuario.
  const antesDeUninstall = ISS.slice(0, ISS.indexOf('CurUninstallStepChanged'));
  assert.ok(!/DelTree/.test(antesDeUninstall),
    'ninguna rama de instalacion/upgrade puede borrar ProgramData: ahi viven la vinculacion y la cola');
});

t('9. los nombres de estado consultados son los de la API (no localizables)', () => {
  assert.ok(/findstr \/C:"/.test(ISS), 'la deteccion parsea la salida de sc query');
  assert.ok(/'STOPPED'/.test(ISS) && /'RUNNING'/.test(ISS),
    'STOPPED/RUNNING son constantes de la API y no cambian con el idioma de Windows; los textos descriptivos de sc si');
});

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach((f) => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
