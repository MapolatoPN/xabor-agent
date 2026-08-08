// Verifica que panel/superadmin.html conozca TODOS los módulos válidos
// del backend (MODULOS_VALIDOS_API en server.js) -- bug real encontrado
// en producción: negocio_modulos/el endpoint ya tenían chat_documentos_pdf/
// cotizaciones/generador_cotizaciones (y otros) desde hace varias
// migraciones, pero el arreglo MODULOS del frontend de Superadmin estaba
// congelado desde antes de la migración 011 (Rewards) y nunca los
// renderizaba -- el admin no podía verlos ni activarlos aunque el
// backend los aceptara perfectamente. Checks estáticos (regex), mismo
// criterio que fase-controles-atencion-frontend.mjs -- no requieren
// servidor ni navegador.
import { readFileSync } from 'fs';
import assert from 'assert';

const htmlSuperadmin = readFileSync(new URL('../panel/superadmin.html', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// Extrae MODULOS_VALIDOS_API directamente del código fuente -- fuente de
// verdad real del backend, nunca una copia hardcodeada en el test que
// podría desincronizarse igual que le pasó al frontend.
const matchBackend = serverSrc.match(/const MODULOS_VALIDOS_API = \[([\s\S]*?)\];/);
assert.ok(matchBackend, 'no se encontró MODULOS_VALIDOS_API en server.js');
const modulosBackend = [...matchBackend[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);

// `let` desde que la lista del frontend pasó a ser solo un FALLBACK que se
// reemplaza con la que devuelve la API. La suite buscaba `const` y llevaba
// tiempo abortando sin comprobar nada; acepta las dos formas.
const matchFrontendModulos = htmlSuperadmin.match(/(?:const|let) MODULOS = \[([\s\S]*?)\];/);
assert.ok(matchFrontendModulos, 'no se encontró MODULOS en superadmin.html');
const modulosFrontend = [...matchFrontendModulos[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);

t('MODULOS_VALIDOS_API tiene al menos los 16 módulos conocidos', () => {
  assert.ok(modulosBackend.length >= 16, `esperaba >=16, encontré ${modulosBackend.length}`);
});

t('superadmin.html MODULOS incluye TODOS los módulos válidos del backend', () => {
  const faltantes = modulosBackend.filter(m => !modulosFrontend.includes(m));
  assert.deepStrictEqual(faltantes, [], `módulos del backend ausentes en el frontend: ${faltantes.join(', ')}`);
});

t('NOMBRES_MODULO tiene una entrada para cada módulo del backend', () => {
  const matchNombres = htmlSuperadmin.match(/(?:const|let) NOMBRES_MODULO = \{([\s\S]*?)\};/);
  assert.ok(matchNombres, 'no se encontró NOMBRES_MODULO');
  const faltantes = modulosBackend.filter(m => !new RegExp(`\\b${m}\\s*:`).test(matchNombres[1]));
  assert.deepStrictEqual(faltantes, [], `sin nombre legible: ${faltantes.join(', ')}`);
});

t('el selector de estado incluye no_contratado y pendiente_configuracion (vocabulario real del CHECK de la BD)', () => {
  assert.match(htmlSuperadmin, /'no_contratado'/);
  assert.match(htmlSuperadmin, /'pendiente_configuracion'/);
});

t('cotizaciones, generador_cotizaciones y chat_documentos_pdf específicamente presentes (el bug reportado)', () => {
  for (const m of ['cotizaciones', 'generador_cotizaciones', 'chat_documentos_pdf']) {
    assert.ok(modulosFrontend.includes(m), `falta ${m} en MODULOS del frontend`);
  }
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
