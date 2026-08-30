// Grounding comercial estricto (2026-08-30).
// El bot NUNCA convierte intención/imagen/descripción/giro en una afirmación
// comercial sin respaldo del catálogo REAL del negocio actual, y el contenido
// hard-codeado de Nonna Maye NO se filtra a ningún otro negocio.
//
// Mezcla contratos de FUENTE (composición del prompt, reglas presentes) con
// comportamiento REAL contra la DB (esNegocioNonna, fail-closed de
// menú/config, validador transaccional fail-closed). Requiere Postgres.
//
// Uso: DATABASE_URL=... node test/fase-grounding-comercial.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PROMPTS_SRC = readFileSync(join(RAIZ, 'src', 'agent', 'prompts.js'), 'utf8');
const DB_SRC = readFileSync(join(RAIZ, 'src', 'services', 'database.js'), 'utf8');

const { construirSystemPrompt, BLOQUE_REGLAS_CONTEXTO_VISUAL } = await import('../src/agent/prompts.js');
const { pool, esNegocioNonna, obtenerMenuCompleto, obtenerConfiguracion, obtenerNegocioIdPorSlug } = await import('../src/services/database.js');
const { validarOrdenPropuesta } = await import('../src/orders/validadorOrden.js');

const NEG_A = SEED.negocioA, NEG_B = SEED.negocioB;
const NONNA = await obtenerNegocioIdPorSlug('nonna-maye');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// Tokens comerciales inequívocos de Nonna que NUNCA deben aparecer para otro negocio.
const TOKENS_NONNA = ['Focaccia Bar', 'Chicken Louisiana', 'Chicken Parm', 'Chicken Fit',
  'focaccia', '878 104 2714', 'Repisas', 'Islas a $500', 'Lizbeth', 'Mapolato'];
const tieneAlguno = (p, toks) => toks.filter(x => p.toLowerCase().includes(x.toLowerCase()));

// ── Fixture: producto real en A y en B (para transaccional / aislamiento) ──
await pool.query(`DELETE FROM menu_productos WHERE codigo LIKE 'GC-%'`);
await pool.query(`DELETE FROM menu_categorias WHERE nombre LIKE 'GC Cat%'`);
const { rows: cA } = await pool.query(
  `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'GC Cat A',TRUE,0) RETURNING id`, [NEG_A]);
const { rows: cB } = await pool.query(
  `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'GC Cat B',TRUE,0) RETURNING id`, [NEG_B]);
await pool.query(
  `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, precio, disponible, orden)
   VALUES ($1,$2,'GC-A1','GC Producto Real A',120,TRUE,0)`, [NEG_A, cA[0].id]);
await pool.query(
  `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, precio, disponible, orden)
   VALUES ($1,$2,'GC-B1','GC Producto Solo B',300,TRUE,0)`, [NEG_B, cB[0].id]);

// ═══ 1. Identificación real de Nonna (nunca por fallback/giro) ═══════════════
await t('1. esNegocioNonna: solo el negocio real de Nonna, nunca null/otro', async () => {
  assert.strictEqual(await esNegocioNonna(NONNA), true, 'Nonna real = true');
  assert.strictEqual(await esNegocioNonna(NEG_A), false, 'otro negocio = false');
  assert.strictEqual(await esNegocioNonna(null), false, 'null = false (no fallback)');
  assert.strictEqual(await esNegocioNonna(''), false, 'vacío = false');
});

// ═══ 2. Fail-closed de menú/config: sin negocioId NO cae a Nonna ═════════════
await t('2. negocioId faltante NO devuelve menú/config de Nonna', async () => {
  assert.deepStrictEqual(await obtenerMenuCompleto(null), [], 'menú null = []');
  assert.deepStrictEqual(await obtenerMenuCompleto(undefined), [], 'menú undefined = []');
  assert.deepStrictEqual(await obtenerConfiguracion(null), {}, 'config null = {}');
  const menuNonna = await obtenerMenuCompleto(NONNA);
  assert.ok(menuNonna.length > 0, 'Nonna con negocioId sí trae su menú (no se rompió)');
  // el código ya no usa el fallback a slug en estas dos lecturas
  assert.ok(/if \(typeof negocioId !== 'string' \|\| !negocioId\.trim\(\)\) return \[\];/.test(DB_SRC), 'obtenerMenuCompleto fail-closed en fuente');
  assert.ok(/if \(typeof negocioId !== 'string' \|\| !negocioId\.trim\(\)\) return \{\};/.test(DB_SRC), 'obtenerConfiguracion fail-closed en fuente');
});

// ═══ 3. Aislamiento: contenido de Nonna NO se filtra a otros ════════════════
await t('3. otro negocio (Alora/NEG_A) recibe CERO tokens comerciales de Nonna', async () => {
  const p = await construirSystemPrompt(null, 'whatsapp', NEG_A);
  assert.deepStrictEqual(tieneAlguno(p, TOKENS_NONNA), [], 'sin focaccias/chicken/Mapolato/etc.');
});
await t('4. negocioId NULL recibe CERO tokens de Nonna (whatsapp y voz)', async () => {
  const pw = await construirSystemPrompt(null, 'whatsapp', null);
  const pv = await construirSystemPrompt(null, 'voz', null);
  assert.deepStrictEqual(tieneAlguno(pw, TOKENS_NONNA), [], 'whatsapp null sin tokens Nonna');
  assert.deepStrictEqual(tieneAlguno(pv, TOKENS_NONNA), [], 'voz null sin tokens Nonna');
});
await t('5. canal de voz de otro negocio no recibe el guion de restaurante de Nonna', async () => {
  const pv = await construirSystemPrompt(null, 'voz', NEG_A);
  assert.ok(!pv.includes('XABOR Voice'), 'sin identidad de voz de Nonna');
  assert.deepStrictEqual(tieneAlguno(pv, TOKENS_NONNA), [], 'voz otro negocio sin tokens Nonna');
});

// ═══ 6. Nonna NO pierde su información comercial válida (regresión) ══════════
await t('6. Nonna conserva su menú/Focaccia Bar y su formato de orden', async () => {
  const p = await construirSystemPrompt(null, 'whatsapp', NONNA);
  assert.ok(p.includes('Focaccia Bar'), 'Nonna sí tiene Focaccia Bar');
  assert.ok(p.includes('HECHOS COMERCIALES DEL NEGOCIO'), 'sección de menú real');
  assert.ok(p.includes('<ORDEN_CONFIRMADA>'), 'sigue emitiendo la orden');
});
await t('7. contenido ambiguo (ganadores/teléfono Mapolato/Repisas) desactivado incluso para Nonna', async () => {
  const p = await construirSystemPrompt(null, 'whatsapp', NONNA);
  for (const tok of ['878 104 2714', 'Lizbeth', 'Repisas a $400', 'Islas a $500']) {
    assert.ok(!p.includes(tok), `desactivado: ${tok}`);
  }
});

// ═══ 8. Reglas de grounding presentes en TODO prompt ════════════════════════
await t('8. regla de verdad comercial + provenance presentes (todos los negocios)', async () => {
  const p = await construirSystemPrompt(null, 'whatsapp', NEG_A);
  assert.ok(p.includes('REGLA DE VERDAD COMERCIAL'), 'regla de verdad comercial');
  assert.ok(p.includes('PETICIÓN ≠ OFERTA'), 'provenance: petición != oferta');
  assert.ok(p.includes('IMAGEN ≠ CATÁLOGO') && p.includes('PRESUPUESTO ≠ PRECIO') && p.includes('GIRO ≠ SERVICIO'), 'las 4 no-equivalencias');
});
await t('9. prosa: prohibido inventar precio/servicio/margen (fuente del prompt)', async () => {
  const p = await construirSystemPrompt(null, 'whatsapp', NEG_A);
  assert.ok(p.includes('tenemos buen margen'), 'lista prohibida incluye "buen margen"');
  assert.ok(/NUNCA hables de margen/.test(p), 'prohíbe hablar de margen');
  assert.ok(/podemos preparar algo así/.test(p), 'prohíbe prometer preparar');
});
await t('10. fuera de catálogo = solicitud a confirmación humana (no promesa)', async () => {
  const p = await construirSystemPrompt(null, 'whatsapp', NEG_A);
  assert.ok(p.includes('PENDIENTE DE CONFIRMACIÓN HUMANA'), 'estado pendiente humano');
  assert.ok(/el equipo confirma si es posible/.test(p), 'frase de solicitud');
});
await t('11. presupuesto NO implica compatibilidad sin cálculo real', async () => {
  const p = await construirSystemPrompt(null, 'whatsapp', NEG_A);
  assert.ok(/PRESUPUESTO —/.test(p), 'sección de presupuesto');
  assert.ok(/combinación es posible dentro de ese monto/.test(p), 'no afirma compatibilidad sin datos');
});

// ═══ 12. Imagen = referencia, no promesa (Vision block) ═════════════════════
await t('12. bloque visual: referencia + confirmación humana, sin "podemos hacerlo"', async () => {
  const b = BLOQUE_REGLAS_CONTEXTO_VISUAL;
  assert.ok(/referencia/i.test(b), 'trata la imagen como referencia');
  assert.ok(/el equipo/i.test(b) && /confirme|confirma/i.test(b), 'remite a confirmación del equipo');
  assert.ok(/PROHIBIDO afirmar/.test(b) && /podemos hacerlo/.test(b), 'prohíbe "podemos hacerlo"');
  // ya no ofrece la promesa suave anterior como frase PREFERIDA
  assert.ok(!/Prefiere: "podemos hacer algo inspirado en ese estilo"/.test(b), 'sin promesa suave como preferida');
});

// ═══ 13. Transaccional: sigue fail-closed con los códigos existentes ════════
await t('13. producto REAL del negocio actual sí se valida (se vende)', async () => {
  const orden = { items: [{ nombre: 'GC Producto Real A', cantidad: 1, precio_unitario: 120 }], forma_pago: 'efectivo', modalidad: 'recoger en tienda' };
  const v = await validarOrdenPropuesta(orden, NEG_A);
  assert.strictEqual(v.ok, true, 'orden con producto real = ok');
});
await t('14. producto INVENTADO = fail-closed con PRODUCTO_NO_EXISTE (o MENU_VACIO)', async () => {
  const orden = { items: [{ nombre: 'Ramo Euforia Inventado XYZ', cantidad: 1, precio_unitario: 1200 }], forma_pago: 'efectivo', modalidad: 'recoger en tienda' };
  const v = await validarOrdenPropuesta(orden, NEG_A);
  assert.strictEqual(v.ok, false, 'orden con producto inventado = rechazada');
  const cods = (v.rechazos || []).map(r => r.codigo);
  assert.ok(cods.includes('PRODUCTO_NO_EXISTE') || cods.includes('MENU_VACIO'), `código fail-closed presente (${cods.join(',')})`);
});
await t('15. mezcla real + inventado = falla TODA la orden (fail-closed)', async () => {
  const orden = { items: [
    { nombre: 'GC Producto Real A', cantidad: 1, precio_unitario: 120 },
    { nombre: 'Waffle De Cumpleaños Inventado', cantidad: 1, precio_unitario: 90 },
  ], forma_pago: 'efectivo', modalidad: 'recoger en tienda' };
  const v = await validarOrdenPropuesta(orden, NEG_A);
  assert.strictEqual(v.ok, false, 'un item inválido tira toda la orden');
});
await t('16. producto de OTRO negocio jamás valida en el negocio actual (aislamiento transaccional)', async () => {
  const orden = { items: [{ nombre: 'GC Producto Solo B', cantidad: 1, precio_unitario: 300 }], forma_pago: 'efectivo', modalidad: 'recoger en tienda' };
  const v = await validarOrdenPropuesta(orden, NEG_A); // el producto vive en B, se valida contra A
  assert.strictEqual(v.ok, false, 'producto de B no existe para A');
  const cods = (v.rechazos || []).map(r => r.codigo);
  assert.ok(cods.includes('PRODUCTO_NO_EXISTE'), 'PRODUCTO_NO_EXISTE (no se resuelve cruzado)');
});

// ── Limpieza ──
await pool.query(`DELETE FROM menu_productos WHERE codigo LIKE 'GC-%'`);
await pool.query(`DELETE FROM menu_categorias WHERE nombre LIKE 'GC Cat%'`);

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end?.().catch(() => {});
process.exit(fallidas ? 1 : 0);
