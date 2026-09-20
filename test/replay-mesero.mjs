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
import { correrFixture, comparar, CRITICAS } from './replay/motor.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DIR = join(AQUI, 'replay', 'fixtures');

const fixtures = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')));

let pasadas = 0;
const fallos = [];
const criticas = [];

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
