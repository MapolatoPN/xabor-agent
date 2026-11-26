// Fase 0 del asistente con IA (26-nov-2026): se quita «Lo que te diría un
// consejero» de Reportes › Ventas, por pedido del dueño. Lo sustituye el
// asistente (avisos en la campanita, Fase 1 en adelante).
//
//   · El panel ya no carga reportes-consejero.js ni lo llama.
//   · El servidor ya no tiene /api/reportes/consejero y el estado de Reportes
//     ya no habla del consejero.
//   · Los cálculos (reporteConsejero.js y reporteConsejeroV2.js) se quedan,
//     sin ruta: el asistente los reutiliza. Se comprueba que siguen cargando.
// La parte del navegador está en fase-reportes-ventas-visual-panel (VV9).
//
// Sin base de datos. Uso: node test/fase-asistente-f0-sin-consejero.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const leer = (p) => readFileSync(join(RAIZ, p), 'utf8');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

await t('F0-1. index.html no carga reportes-consejero.js', () => {
  const html = leer('panel/index.html');
  assert(!/reportes-consejero\.js/.test(html), 'index.html todavía carga reportes-consejero.js');
  assert(!/XaborConsejero|ventas-consejero/.test(html), 'index.html todavía nombra el consejero');
  assert(/<script src="\/reportes-productos\.js\?v=[0-9a-f]{8}"><\/script>/.test(html), 'se perdió reportes-productos.js');
});

await t('F0-2. el archivo del consejero ya no existe en el panel', () => {
  assert(!existsSync(join(RAIZ, 'panel', 'reportes-consejero.js')), 'panel/reportes-consejero.js sigue ahí');
});

await t('F0-3. reportes-productos.js ya no llama al consejero', () => {
  const js = leer('panel/reportes-productos.js');
  assert(!/XaborConsejero/.test(js), 'reportes-productos.js todavía llama a XaborConsejero');
  assert(!/estado\.consejero/.test(js), 'reportes-productos.js todavía lee la bandera del consejero');
});

// Las rutas se registran en una app de mentira: solo se anotan.
const rutas = new Map();
const app = { get: (ruta, ...fns) => rutas.set(`GET ${ruta}`, fns[fns.length - 1]), post: (ruta, ...fns) => rutas.set(`POST ${ruta}`, fns[fns.length - 1]) };
const noop = (_req, _res, next) => next && next();
const { registrarRutasReporteProductos } = await import('../src/services/reporteProductosRutas.js');
registrarRutasReporteProductos(app, { requireAdminSeguro: noop, requireModulo: () => noop });

await t('F0-4. el servidor ya no tiene /api/reportes/consejero', () => {
  assert(![...rutas.keys()].some((r) => /consejero/.test(r)), `rutas: ${[...rutas.keys()].join(', ')}`);
  for (const r of ['GET /api/reportes/productos/estado', 'GET /api/reportes/productos', 'GET /api/reportes/ventas/detalle']) {
    assert(rutas.has(r), `falta ${r}`);
  }
});

await t('F0-5. el estado de Reportes ya no habla del consejero', () => {
  const fuente = String(rutas.get('GET /api/reportes/productos/estado'));
  assert(!/consejero/i.test(fuente), 'la ruta de estado todavía arma la bandera del consejero');
  assert(!/^\s*import[^;]*reporteConsejero/m.test(leer('src/services/reporteProductosRutas.js')), 'reporteProductosRutas.js todavía importa el consejero');
});

await t('F0-6. los cálculos del consejero siguen cargando (los reutiliza el asistente)', async () => {
  const V1 = await import('../src/services/reporteConsejero.js');
  const V2 = await import('../src/services/reporteConsejeroV2.js');
  assert(typeof V1.consejosDeReporte === 'function' && V1.MINIMO_TICKETS === 100, 'reporteConsejero.js cambió');
  assert(typeof V2.consejosV2 === 'function' && V2.UMBRALES_V2.subgrupo === 30, 'reporteConsejeroV2.js cambió');
});

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log(`FALLOS:\n${fallos.map((f) => ` - ${f}`).join('\n')}`); process.exit(1); }
process.exit(0);
