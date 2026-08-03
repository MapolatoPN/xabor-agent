// Fase 2 del Asistente Comercial: parsing de marcadores
// (comercialMarkers.js) -- extracción de campos, detección de borrador
// listo, limpieza del texto visible, fusión con acumulación de items.
//
// Puramente funcional -- sin base de datos, sin red, sin servidor. No se
// prueba aquí la integración con brain.js/Claude real (ver razón en
// docs/asistente-comercial-plan.md Fase 2: llamar al modelo real de
// Anthropic en una prueba automatizada tendría costo y sería no
// determinista, mismo criterio ya aplicado a Clip en
// fase-pagos-multiempresa.mjs). La integración completa brain.js -> DB
// se prueba end-to-end en la Fase 5 con un mock HTTP local de Anthropic.
//
// Uso: node test/fase-asistente-comercial-2-extraccion.mjs
import assert from 'assert';
import {
  extraerCamposComerciales, tieneBorradorListo, limpiarBloqueComercial,
  fusionarCamposCapturados, camposObligatoriosCompletos, camposSecundariosFaltantes,
} from '../src/agent/comercialMarkers.js';
import { construirBloqueModoComercial } from '../src/agent/prompts.js';

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

t('extrae un único campo simple', () => {
  const texto = 'Claro, ¿me confirmas el nombre?<CAMPO_COMERCIAL_CAPTURADO>{"campo":"nombre","valor":"Juan Pérez"}</CAMPO_COMERCIAL_CAPTURADO>';
  const campos = extraerCamposComerciales(texto);
  assert.deepStrictEqual(campos, [{ campo: 'nombre', valor: 'Juan Pérez' }]);
});

t('extrae múltiples campos en el mismo turno', () => {
  const texto = `Perfecto.
<CAMPO_COMERCIAL_CAPTURADO>{"campo":"numero_personas","valor":150}</CAMPO_COMERCIAL_CAPTURADO>
<CAMPO_COMERCIAL_CAPTURADO>{"campo":"fecha_evento","valor":"2026-09-20"}</CAMPO_COMERCIAL_CAPTURADO>`;
  const campos = extraerCamposComerciales(texto);
  assert.strictEqual(campos.length, 2);
  assert.deepStrictEqual(campos[0], { campo: 'numero_personas', valor: 150 });
  assert.deepStrictEqual(campos[1], { campo: 'fecha_evento', valor: '2026-09-20' });
});

t('ignora un marcador con campo no válido, sin descartar los demás', () => {
  const texto = `<CAMPO_COMERCIAL_CAPTURADO>{"campo":"precio_final","valor":5000}</CAMPO_COMERCIAL_CAPTURADO><CAMPO_COMERCIAL_CAPTURADO>{"campo":"nombre","valor":"Ana"}</CAMPO_COMERCIAL_CAPTURADO>`;
  const campos = extraerCamposComerciales(texto);
  assert.deepStrictEqual(campos, [{ campo: 'nombre', valor: 'Ana' }]);
});

t('ignora un marcador con JSON inválido, sin lanzar', () => {
  const texto = '<CAMPO_COMERCIAL_CAPTURADO>{campo: nombre sin comillas}</CAMPO_COMERCIAL_CAPTURADO>';
  assert.deepStrictEqual(extraerCamposComerciales(texto), []);
});

t('sin marcadores devuelve []', () => {
  assert.deepStrictEqual(extraerCamposComerciales('Hola, ¿en qué te ayudo?'), []);
});

t('tieneBorradorListo detecta el marcador', () => {
  assert.strictEqual(tieneBorradorListo('Preparo tu propuesta.<BORRADOR_LISTO>'), true);
  assert.strictEqual(tieneBorradorListo('Aún faltan datos.'), false);
});

t('limpiarBloqueComercial quita todos los marcadores del texto visible', () => {
  const texto = 'Con gusto.<CAMPO_COMERCIAL_CAPTURADO>{"campo":"nombre","valor":"Ana"}</CAMPO_COMERCIAL_CAPTURADO> Ya casi terminamos.<BORRADOR_LISTO>';
  const limpio = limpiarBloqueComercial(texto);
  assert.strictEqual(limpio.includes('CAMPO_COMERCIAL_CAPTURADO'), false);
  assert.strictEqual(limpio.includes('BORRADOR_LISTO'), false);
  assert.strictEqual(limpio, 'Con gusto. Ya casi terminamos.');
});

t('fusionarCamposCapturados no pierde campos previos', () => {
  const actuales = { nombre: 'Ana', numero_personas: 150 };
  const resultado = fusionarCamposCapturados(actuales, [{ campo: 'fecha_evento', valor: '2026-09-20' }]);
  assert.strictEqual(resultado.nombre, 'Ana');
  assert.strictEqual(resultado.numero_personas, 150);
  assert.strictEqual(resultado.fecha_evento, '2026-09-20');
});

t('fusionarCamposCapturados acumula items_solicitados en un array, sin reemplazar', () => {
  let campos = fusionarCamposCapturados({}, [{ campo: 'item_solicitado', valor: { descripcion: 'Arreglo floral grande', cantidad: 10 } }]);
  assert.deepStrictEqual(campos.items, [{ descripcion: 'Arreglo floral grande', cantidad: 10 }]);

  campos = fusionarCamposCapturados(campos, [{ campo: 'item_solicitado', valor: { descripcion: 'Centros de mesa', cantidad: 20 } }]);
  assert.strictEqual(campos.items.length, 2);
  assert.deepStrictEqual(campos.items[0], { descripcion: 'Arreglo floral grande', cantidad: 10 });
  assert.deepStrictEqual(campos.items[1], { descripcion: 'Centros de mesa', cantidad: 20 });
});

t('fusionarCamposCapturados: el cliente cambia de idea -- el nuevo valor reemplaza al anterior (no acumula, salvo items)', () => {
  const actuales = { nombre: 'Ana', fecha_evento: '2026-09-20' };
  const resultado = fusionarCamposCapturados(actuales, [{ campo: 'fecha_evento', valor: '2026-10-05' }]);
  assert.strictEqual(resultado.fecha_evento, '2026-10-05', 'debe quedar la fecha corregida, no la original');
  assert.strictEqual(resultado.nombre, 'Ana', 'los demas campos no capturados de nuevo no se pierden');
});

t('fusionarCamposCapturados ignora un item_solicitado sin descripcion', () => {
  const campos = fusionarCamposCapturados({}, [{ campo: 'item_solicitado', valor: { cantidad: 5 } }]);
  assert.strictEqual(campos.items, undefined);
});

t('camposObligatoriosCompletos: false si falta cualquier obligatorio (nombre/fecha/items)', () => {
  assert.strictEqual(camposObligatoriosCompletos({}), false);
  assert.strictEqual(camposObligatoriosCompletos({ nombre: 'Ana' }), false);
  assert.strictEqual(camposObligatoriosCompletos({ nombre: 'Ana', fecha_evento: '2026-09-20' }), false, 'falta items');
  assert.strictEqual(camposObligatoriosCompletos({ fecha_evento: '2026-09-20', items: [{ descripcion: 'Banquete', cantidad: 1 }] }), false, 'falta nombre');
});

t('camposObligatoriosCompletos: true con solo los 3 obligatorios (nombre+fecha+items) -- numero_personas/lugar/presupuesto NUNCA bloquean', () => {
  const completos = {
    nombre: 'Ana', fecha_evento: '2026-09-20',
    items: [{ descripcion: 'Banquete', cantidad: 150 }],
  };
  assert.strictEqual(camposObligatoriosCompletos(completos), true, 'debe crear borrador aunque falten numero_personas/lugar/presupuesto');
});

t('camposSecundariosFaltantes: lista los que faltan sin bloquear', () => {
  const parcial = { nombre: 'Ana', fecha_evento: '2026-09-20', items: [{ descripcion: 'x', cantidad: 1 }] };
  assert.deepStrictEqual(camposSecundariosFaltantes(parcial).sort(), ['lugar', 'numero_personas', 'presupuesto']);
});

t('camposSecundariosFaltantes: vacío si ya se capturaron todos', () => {
  const completo = { numero_personas: 10, lugar: 'Salón X', presupuesto: '5000' };
  assert.deepStrictEqual(camposSecundariosFaltantes(completo), []);
});

// El comportamiento de "menos fricción" del modelo (una pregunta por
// turno, no repetir, no bloquear por secundarios) se instruye via
// prompt, no via código que se pueda invocar deterministicamente sin
// una llamada real a Claude (mismo criterio documentado arriba sobre no
// probar el modelo real aquí) -- lo que SÍ se puede probar sin llamar al
// modelo es que el texto del prompt efectivamente contiene esas
// instrucciones, para detectar una regresión si alguien las borra sin
// querer en un refactor futuro.
t('construirBloqueModoComercial: instruye una pregunta por turno y no bloquear por secundarios', () => {
  const prompt = construirBloqueModoComercial({});
  assert.ok(prompt.includes('Una sola pregunta por turno'), 'debe instruir una pregunta a la vez');
  assert.ok(/NUNCA.*bloquean/.test(prompt) || /nunca bloquean/i.test(prompt), 'debe aclarar que los secundarios nunca bloquean');
  assert.ok(prompt.includes('NUNCA repitas una pregunta'), 'debe instruir no repetir preguntas ya capturadas');
});

t('construirBloqueModoComercial: incluye los campos ya capturados para no volver a preguntarlos', () => {
  const prompt = construirBloqueModoComercial({ nombre: 'Ana', fecha_evento: '2026-09-20' });
  assert.ok(prompt.includes('"nombre":"Ana"'), 'debe listar el campo ya capturado en el prompt');
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
