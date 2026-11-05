// El chequeo de agenda (scripts/check-programados-agenda.mjs) no puede depender
// del día en que corre: es parte de predeploy-check-incidentes, y el runner lo
// corre ANTES de migrar. El 5-nov-2026 falló con el reloj real (525 y luego
// 630 en vez de 480) porque la fecha fija de su prueba se volvió «hoy», y eso
// detenía cualquier despliegue ese día aunque nada estuviera mal.
//
// Esta suite corre el chequeo como proceso aparte con el reloj del PROCESO
// fijado (test/lib-reloj-fijo.mjs) alrededor de ese día: el anterior, varias
// horas del propio día (antes de abrir, la hora del primer fallo real, media
// mañana, ya cerrado, casi medianoche) y el siguiente. En todos tiene que pasar
// igual. Primero comprueba que la precarga de verdad fija el reloj del hijo:
// si no, «pasar» no probaría nada.
//
// Sin Postgres ni red. Uso: node test/fase-programados-agenda-reloj.mjs
//   AGENDA_CHECKOUT=<otro checkout> corre el chequeo de ese checkout con la
//   misma precarga (para comparar contra otra versión).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = process.env.AGENDA_CHECKOUT || join(__dirname, '..');
const PRECARGA = pathToFileURL(join(__dirname, 'lib-reloj-fijo.mjs')).href;
const CHEQUEO = join(RAIZ, 'scripts', 'check-programados-agenda.mjs');

// America/Matamoros: UTC-6 desde el 1-nov-2026.
const INSTANTES = [
  ['R1', 'día anterior: 4-nov 12:00 en Matamoros', '2026-11-04T18:00:00Z'],
  ['R2', 'el día: 5-nov 06:00, antes de abrir', '2026-11-05T12:00:00Z'],
  ['R3', 'el día: 5-nov 07:44, la hora del primer fallo real', '2026-11-05T13:44:00Z'],
  ['R4', 'el día: 5-nov 09:10, a media mañana', '2026-11-05T15:10:00Z'],
  ['R5', 'el día: 5-nov 10:30', '2026-11-05T16:30:00Z'],
  ['R6', 'el día: 5-nov 15:30, ya cerrado', '2026-11-05T21:30:00Z'],
  ['R7', 'el día: 5-nov 23:59', '2026-11-06T05:59:00Z'],
  ['R8', 'día siguiente: 6-nov 12:00', '2026-11-06T18:00:00Z'],
];

let pasadas = 0, fallidas = 0; const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message.split('\n')[0]}`); fallidas++; fallos.push(nombre); }
}
const hijo = (iso, args) => spawnSync(process.execPath, ['--import', PRECARGA, ...args], {
  cwd: RAIZ, encoding: 'utf8', timeout: 60000,
  env: { ...process.env, RELOJ_FIJO_PRUEBA: iso, NODE_OPTIONS: '' },
});

t('R0. la precarga fija el reloj del proceso hijo (si no, pasar no probaría nada)', () => {
  const r = hijo('2026-11-05T15:10:00Z', ['-e', 'console.log(new Date().toISOString(), new Date(Date.now()).toISOString())']);
  assert.equal(r.status, 0, r.stderr);
  const [a, b] = r.stdout.trim().split(' ');
  for (const v of [a, b]) assert.ok(v.startsWith('2026-11-05T15:10:0'), `el hijo ve ${v}`);
});

for (const [id, que, iso] of INSTANTES) {
  t(`${id}. ${que} (${iso}): el chequeo de agenda pasa`, () => {
    const r = hijo(iso, [CHEQUEO]);
    const salida = `${r.stdout || ''}${r.stderr || ''}`;
    assert.equal(r.status, 0, salida.split('\n').find((l) => /Error|!==|expected/i.test(l)) || salida.slice(-300));
    assert.match(r.stdout, /Agenda de programados: \d+ grupos correctos\./);
  });
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach((f) => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
