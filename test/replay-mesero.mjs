// ─── LA SUITE DE REPLAY ───────────────────────────────────────────────────
//
// Corre TODOS los fixtures de `test/replay/fixtures/` por el flujo real del
// agente y comprueba dos cosas distintas:
//
//   · lo que ESE fixture espera (el pedido final, el estado, las herramientas);
//   · las INVARIANTES, en todos, digan lo que digan. Una invariante que solo
//     se mira donde se espera un fallo no es una invariante.
//
// Determinista: sin red, sin base, sin API key, sin puertos. Corre en
// cualquier máquina y en cualquier worktree.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { correrFixture, comparar, CRITICAS } from './replay/motor.mjs';
import { NEGOCIOS, idDe } from './replay/cartas.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DIR = join(AQUI, 'replay', 'fixtures');

const fixtures = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')));

let pasadas = 0;
const fallos = [];
const criticas = [];

try {
  const corrida = (modalidad, esperada) => ({
    fixture: { esperado: { modalidad: esperada } },
    pedidoFinal: { modalidad }, estado: { hechos: {} }, turnos: [],
  });
  assert.deepEqual(comparar(corrida('domicilio', 'entrega a domicilio')), []);
  assert.deepEqual(comparar(corrida('a domicilio', 'entrega a domicilio')), []);
  assert.deepEqual(comparar(corrida('para recoger', 'recoger en tienda')), []);
  assert.equal(comparar(corrida('domicilio', 'recoger en tienda')).length, 1);
  const filas = (lineas, esperado) => ({
    fixture: { esperado: { lineas: esperado } },
    pedidoFinal: { lineas }, estado: { hechos: {} }, turnos: [],
  });
  const bowl = { producto: 'Bowl', opciones: [{ grupo: 'Salsa', opcion: 'Roja' }] };
  assert.deepEqual(comparar(filas([{ ...bowl, cantidad: 1 }, { ...bowl, cantidad: 1 }],
    [{ ...bowl, cantidad: 2 }])), []);
  assert.equal(comparar(filas([{ ...bowl, cantidad: 2 }],
    [{ ...bowl, cantidad: 1 }, { producto: 'Bowl', cantidad: 1,
      opciones: [{ grupo: 'Salsa', opcion: 'Verde' }] }])).length, 1);
  console.log('    OK  modalidades equivalentes en el medidor');
} catch (e) {
  fallos.push(`modalidades en el medidor: ${e.message}`);
  console.log(`> FALLO modalidades en el medidor: ${e.message}`);
}

// La primera entrega aplica el producto y la segunda solo responde. El
// medidor debe ver ambas ejecuciones antes de acusar una mutación sin permiso.
try {
  const fixture = fixtures.find((f) => f.id === 'mensaje-duplicado-de-meta');
  const productoId = idDe(NEGOCIOS.obispado.catalogo, 'Café Americano');
  const respuestas = [
    { content: [{ type: 'tool_use', id: 'primera', name: 'agregar_producto',
      input: { producto_id: productoId, cantidad: 1 } }] },
    { content: [{ type: 'text', text: 'Va un café.' }] },
    { content: [{ type: 'text', text: 'Va un café.' }] },
  ];
  let llamada = 0;
  const corrida = await correrFixture(fixture, {
    modo: 'modelo', llamarModeloReal: async () => respuestas[llamada++],
  });
  assert.equal(llamada, 3);
  assert.equal(corrida.turnos.length, 2);
  assert.equal(corrida.turnos[0].operaciones.some((o) => o.resultado?.aplicado), true);
  assert.equal(corrida.turnos[1].operaciones.length, 0);
  assert.deepEqual(corrida.hallazgos.filter((h) => h.critica), []);
  console.log('    OK  medidor de reentrega con modelo variable');
} catch (e) {
  fallos.push(`medidor de reentrega: ${e.message}`);
  console.log(`> FALLO medidor de reentrega: ${e.message}`);
}

for (const fixture of fixtures) {
  let corrida;
  try {
    corrida = await correrFixture(fixture);
  } catch (e) {
    fallos.push(`${fixture.id}: reventó — ${e.message}`);
    console.log(`> FALLO ${fixture.id}: reventó — ${e.message}`);
    continue;
  }

  const diferencias = comparar(corrida);
  const rotas = corrida.hallazgos.filter((h) => h.critica);
  const avisos = corrida.hallazgos.filter((h) => !h.critica);
  for (const r of rotas) criticas.push(`${fixture.id}: ${r.tipo} — ${r.detalle}`);

  // Un fixture con el guion agotado está mal escrito: el bucle pidió más pasos
  // de los que el fixture tenía. Se cuenta como fallo aunque el pedido final
  // coincida, porque el turno acabó por agotamiento y no por respuesta.
  const agotados = corrida.turnos.filter((t) => (t.avisos || []).some((a) => a.tipo === 'guion_agotado'));
  if (agotados.length) diferencias.push(`guion agotado en ${agotados.length} turno(s)`);

  if (diferencias.length || rotas.length) {
    const detalle = [...rotas.map((r) => `CRÍTICA ${r.tipo}: ${r.detalle}`), ...diferencias].join('; ');
    fallos.push(`${fixture.id}: ${detalle}`);
    console.log(`> FALLO ${fixture.id}: ${detalle}`);
  } else {
    pasadas += 1;
    console.log(`    OK  ${fixture.id}${avisos.length ? `  (avisos: ${avisos.length})` : ''}`);
  }
}

console.log(`\n  invariantes críticas rotas: ${criticas.length}`);
for (const c of criticas) console.log(`    · ${c}`);
console.log(`  (las críticas son: ${CRITICAS.join(', ')})`);

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas de ${fixtures.length}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas de ${fixtures.length}`);
process.exit(fallos.length ? 1 : 0);
