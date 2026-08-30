// Importar menú desde PDF — Fase 1 (PDF nativo con texto).
// Determinista: extracción de texto REAL (pdfjs) + IA MOCKEADA (stub) + DB real
// (pg-noche). Cubre los 24 casos del encargo a nivel de función (los endpoints
// solo cablean estas funciones + auth de sesión + límite de tamaño).
//
// Uso: DATABASE_URL=... node test/fase-importar-menu-pdf.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const NEG_A = SEED.negocioA, NEG_B = SEED.negocioB;

const { extraerTextoPorPagina } = await import('../src/services/pdfTexto.js');
const { validarPdfReal } = await import('../src/services/documentos.js');
const {
  LIMITE_PDF_BYTES, SCHEMA_MENU, construirPromptExtraccion, extraerMenuConIA,
  validarYnormalizarDraft, compararConMenuActual, revalidarConfirmacion,
} = await import('../src/services/menuImport.js');
const { pool, importarMenuAtomico, obtenerMenuCompleto } = await import('../src/services/database.js');

// ── Generador mínimo de PDF nativo con texto (fixtures) ────────────────────
function construirPdf(paginas) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const nPag = paginas.length; const kids = []; let obj = 4;
  const pageObjs = [], contentObjs = [];
  for (let k = 0; k < nPag; k++) { pageObjs[k] = obj++; contentObjs[k] = obj++; kids.push(`${pageObjs[k]} 0 R`); }
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${nPag} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  for (let k = 0; k < nPag; k++) {
    let ops = 'BT /F1 12 Tf 50 760 Td ';
    paginas[k].forEach((ln, i) => { if (i > 0) ops += '0 -16 Td '; ops += `(${esc(ln)}) Tj `; });
    ops += 'ET';
    objs[pageObjs[k]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjs[k]} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objs[contentObjs[k]] = `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`;
  }
  let out = '%PDF-1.4\n'; const offsets = []; const maxObj = obj - 1;
  for (let i = 1; i <= maxObj; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xrefPos = out.length;
  out += `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxObj; i++) { out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'; }
  out += `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}
// Stub del cliente Anthropic: devuelve un JSON fijo (no llama a la red).
const stubIA = (json) => ({ messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(json) }] }) } });
const prodIA = (nombre, precio, extra = {}) => ({
  nombre, descripcion: extra.descripcion ?? null, precio,
  modificadores: extra.modificadores ?? [],
  pagina_origen: extra.pagina_origen ?? 1, texto_origen: extra.texto_origen ?? nombre,
  confidence: extra.confidence ?? 0.9, advertencias: extra.advertencias ?? [],
});

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const PROMPT = construirPromptExtraccion();

// ── Fixtures DB ────────────────────────────────────────────────────────────
async function limpiar() {
  await pool.query(`DELETE FROM menu_modificadores_opciones WHERE negocio_id = ANY($1) AND nombre LIKE 'IMP %'`, [[NEG_A, NEG_B]]);
  await pool.query(`DELETE FROM menu_modificadores_grupos   WHERE negocio_id = ANY($1) AND nombre LIKE 'IMP %'`, [[NEG_A, NEG_B]]);
  await pool.query(`DELETE FROM menu_productos  WHERE negocio_id = ANY($1) AND nombre LIKE 'IMP %'`, [[NEG_A, NEG_B]]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = ANY($1) AND nombre LIKE 'IMP %'`, [[NEG_A, NEG_B]]);
}
await limpiar();
const contarMenu = async (neg) => {
  const c = await pool.query(`SELECT count(*) FROM menu_categorias WHERE negocio_id=$1`, [neg]);
  const p = await pool.query(`SELECT count(*) FROM menu_productos  WHERE negocio_id=$1`, [neg]);
  return { cat: +c.rows[0].count, prod: +p.rows[0].count };
};

// ═══ 1-3, 15 · Extracción de texto REAL (pdfjs) ═════════════════════════════
await t('1. PDF válido: 1 categoría/producto/precio se extrae', async () => {
  const r = await extraerTextoPorPagina(construirPdf([['TACOS', 'Taco al pastor $25']]));
  assert.strictEqual(r.totalPaginas, 1);
  assert.ok(/Taco al pastor \$25/.test(r.paginas[0].texto));
});
await t('2. varias páginas: texto por página con pagina_origen', async () => {
  const r = await extraerTextoPorPagina(construirPdf([['TACOS', 'Taco $25'], ['BEBIDAS', 'Agua $20']]));
  assert.strictEqual(r.totalPaginas, 2);
  assert.ok(/Taco/.test(r.paginas[0].texto) && r.paginas[0].pagina === 1);
  assert.ok(/Agua/.test(r.paginas[1].texto) && r.paginas[1].pagina === 2);
});
await t('3. descripción multilínea se conserva por líneas', async () => {
  const r = await extraerTextoPorPagina(construirPdf([['Focaccia $120', 'con jamón serrano,', 'arúgula y aceite de oliva']]));
  assert.ok(/jamón serrano/.test(r.paginas[0].texto) && /arúgula/.test(r.paginas[0].texto));
});
await t('15. PDF sin texto → PDF_REQUIERE_VISION', async () => {
  await assert.rejects(() => extraerTextoPorPagina(construirPdf([[]])), (e) => e.codigo === 'PDF_REQUIERE_VISION');
});
await t('16. archivo no-PDF → validarPdfReal lo rechaza (mime_invalido)', async () => {
  const noPdf = Buffer.from('esto no es un pdf, es texto plano cualquiera');
  const v = await validarPdfReal(noPdf);
  assert.strictEqual(v.valido, false);
  assert.strictEqual(v.motivo, 'mime_invalido');
});
await t('17. límite de archivo definido y por debajo del body de express', async () => {
  assert.ok(LIMITE_PDF_BYTES >= 10 * 1024 * 1024 && LIMITE_PDF_BYTES <= 12 * 1024 * 1024, 'límite 10–12MB');
  // base64 infla ~33%: el límite raw * 1.34 debe caber holgado en el body de 20mb.
  assert.ok(LIMITE_PDF_BYTES * 1.37 < 20 * 1024 * 1024, 'el base64 del límite cabe en el body de 20mb');
});

// ═══ IA → draft (mock) ══════════════════════════════════════════════════════
const paginas1 = [{ pagina: 1, texto: 'TACOS\nTaco al pastor $25' }];
await t('4. extras "+precio" → modificadores (precio_extra)', async () => {
  const json = { categorias: [{ nombre: 'Tacos', productos: [prodIA('IMP Taco', 25, {
    modificadores: [{ nombre: 'Extras', opciones: [{ nombre: 'Pollo', precio_extra: 35 }, { nombre: 'Huevo', precio_extra: 25 }] }] })] }] };
  const draft = validarYnormalizarDraft(await extraerMenuConIA(paginas1, { anthropic: stubIA(json) }));
  const p = draft.categorias[0].productos[0];
  assert.strictEqual(p.modificadores.length, 1);
  assert.deepStrictEqual(p.modificadores[0].opciones.map(o => o.precio_extra), [35, 25]);
});
await t('5. tamaños/precios ambiguos → warning VARIANTE_REQUIERE_REVISION', async () => {
  const json = { categorias: [{ nombre: 'Cafe', productos: [prodIA('IMP Latte', null, { advertencias: ['VARIANTE_REQUIERE_REVISION'] })] }] };
  const draft = validarYnormalizarDraft(await extraerMenuConIA(paginas1, { anthropic: stubIA(json) }));
  const p = draft.categorias[0].productos[0];
  assert.ok(p.advertencias.includes('VARIANTE_REQUIERE_REVISION'));
  const comp = compararConMenuActual(draft, []);
  assert.strictEqual(comp.categorias[0].productos[0].requiere_revision, true);
  assert.strictEqual(comp.categorias[0].productos[0].importar, false, 'no se importa por defecto si requiere revisión');
});
await t('6. precio ilegible → precio null + advertencia PRECIO_NO_DETECTADO', async () => {
  const json = { categorias: [{ nombre: 'X', productos: [prodIA('IMP SinPrecio', null)] }] };
  const draft = validarYnormalizarDraft(await extraerMenuConIA(paginas1, { anthropic: stubIA(json) }));
  const p = draft.categorias[0].productos[0];
  assert.strictEqual(p.precio, null);
  assert.ok(p.advertencias.includes('PRECIO_NO_DETECTADO'));
});
await t('13. texto decorativo no se convierte en producto (regla del prompt)', () => {
  assert.ok(/NO conviertas en producto: encabezados decorativos, eslóganes/.test(PROMPT));
  assert.ok(/el nombre del restaurante/.test(PROMPT));
});
await t('14. teléfono/redes/dirección no son productos (regla del prompt)', () => {
  assert.ok(/horarios, direcciones, teléfonos, redes sociales/.test(PROMPT));
});
await t('IA. el schema es estricto (additionalProperties:false + required)', () => {
  assert.strictEqual(SCHEMA_MENU.additionalProperties, false);
  assert.ok(SCHEMA_MENU.required.includes('categorias'));
  const prod = SCHEMA_MENU.properties.categorias.items.properties.productos.items;
  assert.strictEqual(prod.additionalProperties, false);
  for (const campo of ['nombre', 'descripcion', 'precio', 'modificadores', 'pagina_origen', 'texto_origen', 'confidence', 'advertencias']) {
    assert.ok(prod.required.includes(campo), `required incluye ${campo}`);
  }
});

// ═══ 7 · precio null no es importable ═══════════════════════════════════════
await t('7. producto con precio null NO puede confirmarse (revalidación rechaza)', () => {
  const plan = { categorias: [{ nombre: 'X', productos: [{ importar: true, decision: 'crear', nombre: 'IMP NullPrice', precio: null }] }] };
  assert.throws(() => revalidarConfirmacion(plan, new Set()), (e) => e.codigo === 'NADA_QUE_IMPORTAR');
});

// ═══ 8-12 · dedupe contra menú real + persistencia ══════════════════════════
async function sembrarProductoReal(neg, categoria, nombre, precio) {
  const c = await pool.query(`INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,0) RETURNING id`, [neg, categoria]);
  const p = await pool.query(`INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden) VALUES ($1,$2,$3,$4,TRUE,0) RETURNING id`, [neg, c.rows[0].id, nombre, precio]);
  return { catId: c.rows[0].id, prodId: p.rows[0].id };
}
await t('8. duplicado exacto → estado YA_EXISTE, decision default "omitir"', async () => {
  await sembrarProductoReal(NEG_A, 'IMP Cat8', 'IMP Enchiladas', 90);
  const menu = await obtenerMenuCompleto(NEG_A);
  const draft = { categorias: [{ nombre: 'IMP Cat8', productos: [prodIA('IMP Enchiladas', 90)].map(p => ({ ...p, precio: 90 })) }] };
  const comp = compararConMenuActual(validarYnormalizarDraft(draft), menu);
  const p = comp.categorias[0].productos[0];
  assert.strictEqual(p.estado, 'YA_EXISTE');
  assert.strictEqual(p.decision, 'omitir');
  assert.strictEqual(p.importar, false);
});
await t('9. mismo producto, precio distinto → estado PRECIO_CAMBIO', async () => {
  const menu = await obtenerMenuCompleto(NEG_A); // ya tiene IMP Enchiladas $90
  const draft = { categorias: [{ nombre: 'IMP Cat8', productos: [prodIA('IMP Enchiladas', 110)] }] };
  const comp = compararConMenuActual(validarYnormalizarDraft(draft), menu);
  const p = comp.categorias[0].productos[0];
  assert.strictEqual(p.estado, 'PRECIO_CAMBIO');
  assert.strictEqual(Number(p.precio_actual), 90);
  assert.strictEqual(p.precio, 110);
  assert.strictEqual(p.decision, 'omitir', 'nunca actualiza automáticamente');
});
await t('12. categoría existente se reutiliza (no se duplica)', async () => {
  const menu = await obtenerMenuCompleto(NEG_A);
  const comp = compararConMenuActual(validarYnormalizarDraft({ categorias: [{ nombre: 'IMP Cat8', productos: [prodIA('IMP Nuevo', 50)] }] }), menu);
  assert.strictEqual(comp.categorias[0].es_nueva, false, 'IMP Cat8 ya existe');
});
await t('10-11-22-23. crear como nuevo + actualizar + modificadores (persistencia atómica)', async () => {
  const menu = await obtenerMenuCompleto(NEG_A);
  const existente = menu.flatMap(c => c.productos).find(p => p.nombre === 'IMP Enchiladas');
  const idsNegocio = new Set(menu.flatMap(c => c.productos).map(p => Number(p.id)));
  const plan = { categorias: [{ nombre: 'IMP Nueva Cat', productos: [
    { importar: true, decision: 'crear', nombre: 'IMP Quesadilla', precio: 45,
      modificadores: [{ nombre: 'IMP Extras', opciones: [{ nombre: 'IMP Pollo', precio_extra: 20 }] }] },
    { importar: true, decision: 'actualizar', id_existente: existente.id, nombre: 'IMP Enchiladas', precio: 110 },
  ] }] };
  const { acciones } = revalidarConfirmacion(plan, idsNegocio);
  const resumen = await importarMenuAtomico(NEG_A, acciones);
  assert.strictEqual(resumen.productos_creados, 1);
  assert.strictEqual(resumen.productos_actualizados, 1);
  assert.strictEqual(resumen.modificadores_creados, 1);
  // 22: el producto nuevo existe con su precio
  const { rows: q } = await pool.query(`SELECT precio FROM menu_productos WHERE negocio_id=$1 AND nombre='IMP Quesadilla'`, [NEG_A]);
  assert.strictEqual(Number(q[0].precio), 45);
  // 11: el existente se actualizó a 110
  const { rows: e } = await pool.query(`SELECT precio FROM menu_productos WHERE id=$1`, [existente.id]);
  assert.strictEqual(Number(e[0].precio), 110);
  // 23: el modificador quedó asociado al producto nuevo
  const { rows: g } = await pool.query(
    `SELECT g.id FROM menu_modificadores_grupos g JOIN menu_productos p ON p.id=g.producto_id WHERE p.nombre='IMP Quesadilla' AND g.negocio_id=$1`, [NEG_A]);
  assert.strictEqual(g.length, 1);
  const { rows: o } = await pool.query(`SELECT precio_extra FROM menu_modificadores_opciones WHERE grupo_id=$1`, [g[0].id]);
  assert.strictEqual(Number(o[0].precio_extra), 20);
});

// ═══ 24 · usuario excluye producto → no se crea ═════════════════════════════
await t('24. producto excluido (importar:false) no se crea', async () => {
  const plan = { categorias: [{ nombre: 'IMP Cat24', productos: [
    { importar: false, decision: 'crear', nombre: 'IMP Excluido', precio: 30 },
    { importar: true, decision: 'crear', nombre: 'IMP Incluido', precio: 40 },
  ] }] };
  const { acciones } = revalidarConfirmacion(plan, new Set());
  assert.strictEqual(acciones.length, 1);
  await importarMenuAtomico(NEG_A, acciones);
  const { rows } = await pool.query(`SELECT nombre FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE 'IMP Excluido'`, [NEG_A]);
  assert.strictEqual(rows.length, 0, 'el excluido no se creó');
});

// ═══ 18 · multitenancy fail-closed ══════════════════════════════════════════
await t('18. negocioId ausente → importarMenuAtomico falla cerrado (TENANT_REQUERIDO)', async () => {
  await assert.rejects(() => importarMenuAtomico('', [{ decision: 'crear', categoria: 'X', producto: { nombre: 'Y', precio: 10 } }]),
    (e) => e.codigo === 'TENANT_REQUERIDO');
  await assert.rejects(() => importarMenuAtomico(null, []), (e) => e.codigo === 'TENANT_REQUERIDO');
});

// ═══ 19 · cross-tenant ══════════════════════════════════════════════════════
await t('19. actualizar un producto de OTRO negocio → rechazado (revalidación y DB)', async () => {
  const { prodId: idB } = await sembrarProductoReal(NEG_B, 'IMP CatB', 'IMP SoloB', 200);
  // Revalidación: id de B no está en el set de A → se descarta (y no queda nada).
  const plan = { categorias: [{ nombre: 'X', productos: [{ importar: true, decision: 'actualizar', id_existente: idB, nombre: 'IMP SoloB', precio: 999 }] }] };
  assert.throws(() => revalidarConfirmacion(plan, new Set([1, 2, 3])), (e) => e.codigo === 'NADA_QUE_IMPORTAR');
  // Defensa en DB: aunque se colara, el UPDATE scoped por negocio no matchea → CROSS_TENANT + rollback.
  await assert.rejects(() => importarMenuAtomico(NEG_A, [{ decision: 'actualizar', id_existente: idB, producto: { nombre: 'IMP SoloB', descripcion: '', precio: 999 } }]),
    (e) => e.codigo === 'CROSS_TENANT');
  const { rows } = await pool.query(`SELECT precio FROM menu_productos WHERE id=$1`, [idB]);
  assert.strictEqual(Number(rows[0].precio), 200, 'el producto de B quedó intacto');
});

// ═══ 20 · error a mitad → ROLLBACK total ════════════════════════════════════
await t('20. error a mitad de la importación → ROLLBACK total (nada parcial)', async () => {
  const antes = await contarMenu(NEG_A);
  const { prodId: idB } = await sembrarProductoReal(NEG_B, 'IMP CatB2', 'IMP SoloB2', 300);
  // Primera acción válida (crear) + segunda que revienta (actualizar cross-tenant).
  const acciones = [
    { decision: 'crear', categoria: 'IMP Cat Rollback', producto: { nombre: 'IMP NoDebeQuedar', descripcion: '', precio: 55, modificadores: [] } },
    { decision: 'actualizar', id_existente: idB, producto: { nombre: 'x', descripcion: '', precio: 1 } },
  ];
  await assert.rejects(() => importarMenuAtomico(NEG_A, acciones), (e) => e.codigo === 'CROSS_TENANT');
  const despues = await contarMenu(NEG_A);
  assert.strictEqual(despues.prod, antes.prod, 'ningún producto quedó (rollback)');
  assert.strictEqual(despues.cat, antes.cat, 'ninguna categoría quedó (rollback)');
  const { rows } = await pool.query(`SELECT 1 FROM menu_productos WHERE negocio_id=$1 AND nombre='IMP NoDebeQuedar'`, [NEG_A]);
  assert.strictEqual(rows.length, 0);
});

// ═══ 21 · el ANÁLISIS no toca menu_* ════════════════════════════════════════
await t('21. el análisis (extraer+IA+validar+comparar) NO escribe en menu_*', async () => {
  const antes = await contarMenu(NEG_A);
  const paginas = (await extraerTextoPorPagina(construirPdf([['CAT', 'IMP Analisis $99']]))).paginas;
  const json = { categorias: [{ nombre: 'CAT', productos: [prodIA('IMP Analisis', 99)] }] };
  const draft = validarYnormalizarDraft(await extraerMenuConIA(paginas, { anthropic: stubIA(json) }));
  compararConMenuActual(draft, await obtenerMenuCompleto(NEG_A));
  const despues = await contarMenu(NEG_A);
  assert.deepStrictEqual(despues, antes, 'el análisis no cambió el conteo del menú');
});

await limpiar();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end?.().catch(() => {});
process.exit(fallidas ? 1 : 0);
