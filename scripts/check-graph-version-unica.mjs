// Barrera de predeploy: la versión de la Graph API de Meta sale de UN lugar.
//
// Hasta el 27-nov-2026, `v20.0` estaba escrita a mano en más de veinte
// lugares. Caducó el 24-sep-2026 y nadie se enteró: Meta atiende una versión
// caducada con la vigente más antigua, así que la versión real cambiaba sola.
// Ahora toda URL de Graph se arma con versionGraph()
// (src/services/metaVersionGraph.js), y esta barrera falla si:
//
//  1. aparece una versión escrita a mano («v20.0», '/v25.0/', …) en src/,
//     scripts/ o panel/;
//  2. una URL de graph.facebook.com no lleva ${versionGraph()} justo después
//     del host (una llamada sin versión usa la que diga el App Dashboard);
//  3. una URL armada con META_GRAPH_BASE_URL no lleva ${versionGraph()};
//  4. vuelve la constante GRAPH_VERSION (la versión fija de antes).
//
// Excepciones, cada una con su razón:
//  - src/services/metaVersionGraph.js: ahí vive la versión por omisión.
//  - scripts/suscribir-avisos-flows.mjs: sus versiones son las de los CAMPOS
//    DEL WEBHOOK de la app (otra cosa; las elige el App Dashboard) y la de la
//    llamada que los suscribe, que fija la versión de un campo nuevo.
//  - este archivo.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const EXCEPCIONES = new Set([
  'src/services/metaVersionGraph.js',
  'scripts/suscribir-avisos-flows.mjs',
  'scripts/check-graph-version-unica.mjs',
]);

// Solo cuentan las líneas de código: los comentarios pueden contar la historia.
const esComentario = (l) => {
  const s = l.trim();
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('/*') || s.startsWith('<!--');
};

function archivos(dir) {
  const out = [];
  if (!existsSync(join(RAIZ, dir))) return out;
  for (const n of readdirSync(join(RAIZ, dir))) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const ruta = `${dir}/${n}`;
    if (statSync(join(RAIZ, ruta)).isDirectory()) out.push(...archivos(ruta));
    else if (/\.(m?js|cjs|html)$/.test(n)) out.push(ruta);
  }
  return out;
}

const VERSION_LITERAL = /["'`/]v\d{1,3}\.\d+(?![\d])/;
const HOST_SIN_VERSION = /graph\.facebook\.com\/(?!\$\{versionGraph\(\)\})/;
const BASE_SIN_VERSION = /\$\{[^}]*META_GRAPH_BASE_URL[^}]*\}\/(?!\$\{versionGraph\(\)\})/;
const CONSTANTE_VIEJA = /\bGRAPH_VERSION\b(?!_)/;

const faltas = [];
let revisados = 0;
for (const ruta of [...archivos('src'), ...archivos('scripts'), ...archivos('panel')]) {
  if (EXCEPCIONES.has(ruta)) continue;
  revisados += 1;
  const lineas = readFileSync(join(RAIZ, ruta), 'utf8').split('\n');
  lineas.forEach((l, i) => {
    if (esComentario(l)) return;
    const donde = `${ruta}:${i + 1}`;
    if (VERSION_LITERAL.test(l)) faltas.push(`${donde} versión escrita a mano`);
    if (HOST_SIN_VERSION.test(l)) faltas.push(`${donde} graph.facebook.com sin \${versionGraph()}`);
    if (BASE_SIN_VERSION.test(l)) faltas.push(`${donde} META_GRAPH_BASE_URL sin \${versionGraph()}`);
    if (CONSTANTE_VIEJA.test(l)) faltas.push(`${donde} constante GRAPH_VERSION`);
  });
}

assert.ok(revisados > 100, `la barrera revisó solo ${revisados} archivos: ¿cambió la estructura?`);
assert.deepEqual(faltas, [], `Versión de la Graph API fuera de metaVersionGraph.js:\n  ${faltas.join('\n  ')}`);

// La versión por omisión debe ser una versión con la forma que acepta Meta.
const fuente = readFileSync(join(RAIZ, 'src/services/metaVersionGraph.js'), 'utf8');
const omision = fuente.match(/GRAPH_VERSION_POR_OMISION = '(v\d{2,3}\.0)'/);
assert.ok(omision, 'metaVersionGraph.js debe declarar GRAPH_VERSION_POR_OMISION = \'vNN.0\'');

console.log(`OK: la versión de la Graph API sale solo de metaVersionGraph.js (${omision[1]} por omisión; ${revisados} archivos revisados).`);
