// E2E del PROMPT: promoción vigente → construirSystemPrompt → texto final.
//
// El test unitario prueba que describirPromocionesVigentes puede generar los
// nombres; esto prueba lo que faltaba: que esos nombres LLEGAN al system prompt
// que recibe el modelo (sección "PROMOCIONES ACTIVAS AHORA"), que la
// PROMOTION INFORMATION RULE está presente, y que el prompt se reconstruye por
// turno (una promo cambiada a mitad de conversación se refleja sin reiniciar).
//
// No invoca al LLM (no hay API key en pruebas): valida el INSUMO exacto que se
// le manda. Determinista salvo la hora → la promo se crea SIN restricción de
// día/horario para estar siempre vigente.
//
// Uso: DATABASE_URL=... node test/fase-promo-prompt-e2e.mjs
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { guardarPromocion } = await import('../src/services/tiendaPromociones.js');
const { construirSystemPrompt } = await import('../src/agent/prompts.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

async function montarNegocio(slug, nombre) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET nombre=$1 RETURNING id`, [nombre, slug]);
  return n.id;
}
async function categoria(negocioId, nombre) {
  const { rows } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, orden) VALUES ($1,$2,0) ON CONFLICT DO NOTHING RETURNING id`, [negocioId, nombre]);
  if (rows[0]) return rows[0].id;
  return (await pool.query(`SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre=$2 LIMIT 1`, [negocioId, nombre])).rows[0].id;
}
async function producto(negocioId, catId, nombre, precio) {
  const { rows } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio) VALUES ($1,$2,$3,$4) RETURNING id`, [negocioId, catId, nombre, precio]);
  return rows[0].id;
}
async function limpiar(negocioId) {
  await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1`, [negocioId]).catch(() => {});
}

const NEG = await montarNegocio('promo-e2e-a', 'Promo E2E A');
await limpiar(NEG);
const cat = await categoria(NEG, 'DESAYUNOS');
const pHotcakes = await producto(NEG, cat, 'Hotcakes Tradicionales', 149);
const pWaffles  = await producto(NEG, cat, 'Waffles', 160);
const pAlmuerzo = await producto(NEG, cat, 'Almuerzo Americano', 189);

async function crear2x1(productos) {
  return (await guardarPromocion(NEG, {
    nombre: 'Martes 2x1', tipo: '2x1', automatica: true,
    cantidadRequerida: 2, cantidadBeneficiada: 1,
    canales: ['whatsapp', 'pos'], productos, // sin diasSemana/horario ⇒ siempre vigente
  })).id;
}
async function borra() { await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [NEG]); }

// ═══════════ TESTS ═══════════

// La línea de participantes hay que buscarla DENTRO de la sección de promos:
// el MENÚ completo también nombra todos los productos, y la PROMOTION
// INFORMATION RULE (en REGLAS CRÍTICAS) menciona la etiqueta entre comillas.
// Se acota a "## PROMOCIONES ACTIVAS AHORA" … hasta el siguiente "## ".
const seccionPromos = (prompt) => (prompt.match(/## PROMOCIONES ACTIVAS AHORA\n([\s\S]*?)\n## /) || ['', ''])[1];
const lineaParticipantes = (prompt) => (seccionPromos(prompt).match(/Productos participantes:[^\n]*/) || [''])[0];

await t('E2E 1 · el SYSTEM PROMPT final contiene "Productos participantes:" con los nombres reales', async () => {
  await crear2x1([pHotcakes, pWaffles, pAlmuerzo]);
  const prompt = await construirSystemPrompt(null, 'whatsapp', NEG);
  assert.ok(prompt.includes('PROMOCIONES ACTIVAS AHORA'), 'debe existir la sección de promos');
  assert.ok(prompt.includes('Martes 2x1'), 'la promo aparece');
  const linea = lineaParticipantes(prompt);
  assert.ok(linea, 'debe incluir la línea "Productos participantes:"');
  for (const n of ['Hotcakes Tradicionales', 'Waffles', 'Almuerzo Americano']) {
    assert.ok(linea.includes(n), `el nombre "${n}" debe estar en la línea de participantes`);
  }
  await borra();
});

await t('E2E 2 · la PROMOTION INFORMATION RULE está en el prompt (instruye a responder los nombres)', async () => {
  await crear2x1([pHotcakes, pWaffles]);
  const prompt = await construirSystemPrompt(null, 'whatsapp', NEG);
  assert.ok(prompt.includes('PROMOTION INFORMATION RULE'), 'la regla debe estar presente');
  assert.ok(/respóndelos DIRECTAMENTE|usa EXCLUSIVAMENTE los nombres/.test(prompt), 'la regla debe instruir a responder los nombres');
  await borra();
});

await t('E2E 3 · reconstrucción por turno: cambiar la promo se refleja sin reiniciar la sesión', async () => {
  // Turno 1: promo con 2 productos. Se inspecciona la LÍNEA de participantes
  // (no todo el prompt: el menú también nombra 'Almuerzo Americano').
  const id = await crear2x1([pHotcakes, pWaffles]);
  const linea1 = lineaParticipantes(await construirSystemPrompt(null, 'whatsapp', NEG));
  assert.ok(linea1.includes('Waffles') && !linea1.includes('Almuerzo Americano'), 'turno 1: solo los 2 iniciales en la línea de participantes');
  // A mitad de conversación se AGREGA un producto a la misma promo (mismo id).
  await guardarPromocion(NEG, {
    nombre: 'Martes 2x1', tipo: '2x1', automatica: true, cantidadRequerida: 2, cantidadBeneficiada: 1,
    canales: ['whatsapp', 'pos'], productos: [pHotcakes, pWaffles, pAlmuerzo],
  }, id);
  // Turno 2: el prompt se reconstruye y refleja el cambio (no hay caché).
  const linea2 = lineaParticipantes(await construirSystemPrompt(null, 'whatsapp', NEG));
  assert.ok(linea2.includes('Almuerzo Americano'), 'turno 2: el producto agregado ya aparece en la línea de participantes');
  await borra();
});

await t('E2E 4 · sin promos activas: el prompt NO afirma participantes ni rompe', async () => {
  await borra(); // aislar: sin promos vigentes
  const prompt = await construirSystemPrompt(null, 'whatsapp', NEG);
  assert.ok(!lineaParticipantes(prompt), 'sin promos, no debe listar participantes');
});

// ═══════════ RESUMEN ═══════════
await limpiar(NEG);
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  - ' + fallos.join('\n  - ')); process.exit(1); }
