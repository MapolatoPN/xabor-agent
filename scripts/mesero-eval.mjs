// ─── EL SCORECARD DEL MESERO ──────────────────────────────────────────────
//
//   npm run mesero:eval                      con guion (determinista, gratis)
//   npm run mesero:eval -- --modelo          con el modelo de verdad
//   npm run mesero:eval -- --base informes/mesero-eval-<algo>.json
//
// Dos bloques de métricas, y la diferencia entre ellos es el encargo entero:
//
//   CRÍTICAS   tienen que ser CERO. No son una nota, son una puerta. Si una
//              sube de cero, el candidato no pasa, por muy bien que esté el
//              resto. Son las que describen un pedido estropeado.
//
//   CALIDAD    se miran para mejorar: pedido correcto, aclaraciones por pedido,
//              handoff, latencia, coste. Un número peor aquí es una discusión;
//              un número peor allá es un bloqueo.
//
// El informe se guarda en `informes/` para poder comparar builds. Con `--base`
// se imprime la comparación y el proceso falla si una crítica empeora — que es
// lo que convierte el ciclo «cambia, mide, conserva o revierte» en algo que no
// depende de acordarse.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { correrFixture, comparar, CRITICAS } from '../test/replay/motor.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const FIXTURES = join(RAIZ, 'test', 'replay', 'fixtures');
const INFORMES = join(RAIZ, 'informes');

const args = process.argv.slice(2);
const conModelo = args.includes('--modelo');
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;
const silencioso = args.includes('--silencioso');

// ── El modelo de verdad, solo si se pide y solo si hay llave ─────────────
let llamarModeloReal = null;
if (conModelo) {
  const clave = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[mesero-eval] --modelo necesita ANTHROPIC_API_KEY. Sin ella no se corre: '
      + 'una evaluación que se salta el modelo y no lo dice es peor que ninguna.');
    process.exit(2);
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const cliente = new Anthropic({ apiKey: clave });
  llamarModeloReal = (params) => cliente.messages.create(params);
}

const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')));

const filas = [];
for (const fixture of fixtures) {
  const t0 = Date.now();
  let corrida = null; let error = null;
  try {
    corrida = await correrFixture(fixture, { modo: conModelo ? 'modelo' : 'guion', llamarModeloReal });
  } catch (e) { error = String(e?.message || e); }

  const diferencias = corrida ? comparar(corrida) : [`reventó: ${error}`];
  const hallazgos = corrida?.hallazgos || [];
  const turnos = corrida?.turnos || [];

  filas.push({
    id: fixture.id,
    ok: diferencias.length === 0 && !hallazgos.some((h) => h.critica),
    diferencias,
    criticas: hallazgos.filter((h) => h.critica).map((h) => h.tipo),
    turnos: turnos.length,
    // Aclaraciones abiertas al final: cuántas veces el pedido se quedó sin
    // poder decidirse solo. Bajarlo es el objetivo de calidad más directo.
    aclaraciones: turnos.reduce((s, t) => s + (t.pedido?.aclaraciones?.length || 0), 0),
    escalado: !!corrida?.estado?.hechos?.escalado,
    confirmado: !!corrida?.estado?.hechos?.confirmado,
    herramientas: turnos.flatMap((t) => (t.operaciones || []).map((o) => o.herramienta)),
    rechazos: turnos.flatMap((t) => (t.operaciones || []))
      .filter((o) => o.resultado?.aplicado === false).length,
    llamadasAlModelo: turnos.reduce((s, t) => s + (t.llamadasAlModelo || 0), 0),
    tokens: turnos.reduce((s, t) => s + 0, 0),
    ms: Date.now() - t0,
  });
}

// ── Cuentas ──────────────────────────────────────────────────────────────
const n = filas.length;
const criticasPorTipo = Object.fromEntries(CRITICAS.map((c) => [c, 0]));
for (const f of filas) for (const c of f.criticas) criticasPorTipo[c] += 1;

const usoDeHerramienta = {};
for (const f of filas) for (const h of f.herramientas) usoDeHerramienta[h] = (usoDeHerramienta[h] || 0) + 1;

const informe = {
  generado: new Date().toISOString(),
  modo: conModelo ? 'modelo' : 'guion',
  commit: gitSha(),
  fixtures: n,
  criticas: criticasPorTipo,
  criticasTotal: Object.values(criticasPorTipo).reduce((a, b) => a + b, 0),
  calidad: {
    pedido_correcto: filas.filter((f) => f.ok).length,
    tasa_pedido_correcto: n ? +(filas.filter((f) => f.ok).length / n).toFixed(4) : 0,
    conversaciones_completadas: filas.filter((f) => f.confirmado).length,
    handoff: filas.filter((f) => f.escalado).length,
    tasa_handoff: n ? +(filas.filter((f) => f.escalado).length / n).toFixed(4) : 0,
    aclaraciones_por_conversacion: n
      ? +(filas.reduce((s, f) => s + f.aclaraciones, 0) / n).toFixed(3) : 0,
    rechazos_de_herramienta: filas.reduce((s, f) => s + f.rechazos, 0),
    llamadas_al_modelo: filas.reduce((s, f) => s + f.llamadasAlModelo, 0),
    ms_por_conversacion: n ? Math.round(filas.reduce((s, f) => s + f.ms, 0) / n) : 0,
  },
  uso_de_herramienta: usoDeHerramienta,
  fallidos: filas.filter((f) => !f.ok).map((f) => ({ id: f.id, criticas: f.criticas, diferencias: f.diferencias })),
};

function gitSha() {
  try { return execSync('git rev-parse --short HEAD', { cwd: RAIZ }).toString().trim(); }
  catch { return null; }
}

// ── Salida ───────────────────────────────────────────────────────────────
if (!silencioso) {
  console.log(`\n═══ SCORECARD DEL MESERO ═══  modo=${informe.modo}  commit=${informe.commit || '?'}  fixtures=${n}\n`);
  console.log('CRÍTICAS (tienen que ser 0)');
  for (const [k, v] of Object.entries(informe.criticas)) {
    console.log(`  ${v === 0 ? ' ok ' : 'ROTA'}  ${k.padEnd(26)} ${v}`);
  }
  console.log('\nCALIDAD');
  for (const [k, v] of Object.entries(informe.calidad)) console.log(`        ${k.padEnd(30)} ${v}`);
  console.log('\nUSO DE HERRAMIENTAS');
  for (const [k, v] of Object.entries(usoDeHerramienta).sort((a, b) => b[1] - a[1])) {
    console.log(`        ${k.padEnd(26)} ${v}`);
  }
  if (informe.fallidos.length) {
    console.log('\nFALLIDOS');
    for (const f of informe.fallidos) console.log(`  · ${f.id}: ${[...f.criticas, ...f.diferencias].join('; ')}`);
  }
}

mkdirSync(INFORMES, { recursive: true });
const salida = join(INFORMES, `mesero-eval-${informe.modo}-${informe.commit || 'local'}.json`);
writeFileSync(salida, `${JSON.stringify(informe, null, 2)}\n`, 'utf8');
console.log(`\ninforme: ${salida}`);

// ── Comparación contra un build anterior ─────────────────────────────────
let peorEnCritica = false;
if (base) {
  if (!existsSync(base)) {
    console.error(`[mesero-eval] no existe el informe base: ${base}`);
    process.exit(2);
  }
  const anterior = JSON.parse(readFileSync(base, 'utf8'));
  console.log(`\n═══ CONTRA ${anterior.commit || base} (${anterior.modo}) ═══`);
  for (const [k, v] of Object.entries(informe.criticas)) {
    const antes = anterior.criticas?.[k] ?? 0;
    if (v !== antes) {
      console.log(`  ${v > antes ? 'PEOR' : 'mejor'}  ${k}: ${antes} -> ${v}`);
      if (v > antes) peorEnCritica = true;
    }
  }
  for (const [k, v] of Object.entries(informe.calidad)) {
    const antes = anterior.calidad?.[k];
    if (antes !== undefined && antes !== v) console.log(`        ${k}: ${antes} -> ${v}`);
  }
  if (peorEnCritica) {
    console.log('\n> UNA INVARIANTE CRÍTICA EMPEORÓ. Este cambio se revierte; no se discute.');
  }
}

// La puerta: críticas a cero y todos los fixtures en verde.
const pasa = informe.criticasTotal === 0 && informe.fallidos.length === 0 && !peorEnCritica;
console.log(pasa ? '\n  PUERTA: ABIERTA' : '\n> PUERTA: CERRADA');
process.exit(pasa ? 0 : 1);
