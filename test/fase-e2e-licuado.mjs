// E2E con el catálogo REAL que rompió en producción.
//
// El smoke que obligó a revertir un deploy fue "Quiero un licuado grande de
// mango" contra un menú con Medida: Chico / Grande 1 Litro. Aquí ese catálogo
// se reproduce tal cual —opciones de varias palabras, un grupo opcional con
// máximo 3, acentos en los sabores— porque el fixture anterior, con opciones
// de UNA palabra, no podía ver el caso que falló: el cliente abrevia.
//
// Cubre además lo que nadie había probado: qué pasa DESPUÉS de que el backend
// rechaza algo. Un rechazo del que no se puede salir es tan malo como aceptar
// lo imposible.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... ADMIN_PASSWORD=... SESSION_SECRET=...
//      INTEGRATIONS_ENCRYPTION_KEY=... node test/fase-e2e-licuado.mjs
import assert from 'assert';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const mock = await arrancarAnthropicMock();
process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-e2e';
process.env.PORT = process.env.PORT || '4193';

const { pool } = await import('../src/services/database.js');
const { procesarMensaje } = await import('../src/agent/brain.js');
const { deleteSession, verPreviewPedido, getSession } = await import('../src/agent/session.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Catálogo real ──────────────────────────────────────────────────────────
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = (await q1(
  `INSERT INTO negocios (nombre, slug) VALUES ('E2E Licuado','e2e-licuado')
   ON CONFLICT (slug) DO UPDATE SET nombre='E2E Licuado' RETURNING id`)).id;
for (const tabla of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
  await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
const cat = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'BEBIDAS',0) RETURNING id`, [NEG])).id;
const LIC = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Licuado',60) RETURNING id`, [NEG, cat])).id;
const grupo = async (nombre, { requerido = false, minimo = 0, maximo = 0, orden = 0 } = {}) => (await q1(
  `INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
   VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [NEG, LIC, nombre, requerido, minimo, maximo, orden])).id;
const op = async (gid, nombre, extra = 0) => (await q1(
  `INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,$3,$4,TRUE,0) RETURNING id`, [NEG, gid, nombre, extra])).id;

const gMedida = await grupo('Medida', { requerido: true, minimo: 1, maximo: 1, orden: 0 });
await op(gMedida, 'Chico'); await op(gMedida, 'Grande 1 Litro', 20);
const gSabor = await grupo('Sabor', { requerido: true, minimo: 1, maximo: 1, orden: 1 });
for (const s of ['Platáno', 'Fresa', 'Melón', 'Papaya']) await op(gSabor, s);
const gLeche = await grupo('Leche', { requerido: true, minimo: 1, maximo: 1, orden: 2 });
await op(gLeche, 'Entera'); await op(gLeche, 'Deslactosada');
const gComp = await grupo('Complementos', { requerido: false, minimo: 0, maximo: 3, orden: 3 });
for (const c of ['Vainilla', 'Chocolate', 'Avena', 'Canela']) await op(gComp, c);

// ── Utilidades de mock ─────────────────────────────────────────────────────
const borrador = (mods, extra = {}) => `Con gusto.\n<PEDIDO_BORRADOR>${JSON.stringify({
  items: [{ nombre: 'Licuado', cantidad: 1, modificadores: mods, ...extra }],
})}</PEDIDO_BORRADOR>`;
const menciones = (...ms) => JSON.stringify({ menciones: ms });
const attr = (texto) => ({ tipo: 'atributo', texto_fuente: texto });
const prod = (texto) => ({ tipo: 'producto', texto_fuente: texto });
const mod = (g, ...o) => ({ grupo: g, opciones: o });

const turno = (sid, msg) => procesarMensaje(sid, msg, null, 'whatsapp', NEG, null);

// ═══ E2E 1 — el caso literal que rompió producción ════════════════════════
let e2e1;
await t('E2E1. "Quiero un licuado grande de mango": resuelve la medida y bloquea el sabor inexistente', async () => {
  deleteSession('e1');
  mock.encolarRespuesta(borrador([]));
  mock.encolarRespuesta(menciones(prod('licuado'), attr('grande'), attr('mango')));
  e2e1 = await turno('e1', 'Quiero un licuado grande de mango');

  assert.match(e2e1.texto, /no manejamos "mango" en Licuado/,
    `debe decir la verdad sobre mango, sin inventarle grupo: ${e2e1.texto}`);
  assert.doesNotMatch(e2e1.texto, /no tenemos grande|grande en medida/i,
    `JAMÁS negar "grande": el catálogo sí tiene Grande 1 Litro — ${e2e1.texto}`);
  assert.doesNotMatch(e2e1.texto, /mango en (medida|sabor)/i,
    `atribución de grupo sin evidencia: ${e2e1.texto}`);
  assert.strictEqual((e2e1.texto.match(/Chico/g) || []).length <= 1, true,
    `listas duplicadas: ${e2e1.texto}`);
  assert.strictEqual(e2e1.orden, null, 'no se registra nada');
  assert.strictEqual(verPreviewPedido('e1'), null, 'ni preview ni snapshot confirmable');
});

// ═══ CONTINUIDAD — se puede salir del rechazo ═════════════════════════════
await t('E2E1b. tras el rechazo el pedido CONTINÚA: conserva Licuado y la medida, sin resucitar mango', async () => {
  // El cliente insiste ("Sí"). El modelo ya ve en el historial lo que el
  // cliente REALMENTE leyó (el backend sustituyó su texto), así que retoma el
  // pedido con la medida ya elegida y pregunta lo que falta.
  mock.encolarRespuesta(borrador([mod('Medida', 'Grande 1 Litro')]));
  mock.encolarRespuesta(menciones());
  const r = await turno('e1', 'Sí');

  assert.doesNotMatch(r.texto, /mango/i, `mango no puede volver como válido: ${r.texto}`);
  assert.match(r.texto, /falta saber/i, `debe seguir armando el pedido, no reiniciarlo: ${r.texto}`);
  assert.match(r.texto, /sabor/i, r.texto);
  assert.match(r.texto, /Platáno|Fresa|Melón|Papaya/, `con las opciones REALES: ${r.texto}`);
  assert.doesNotMatch(r.texto, /medida/i, `la medida ya estaba elegida en este ciclo: ${r.texto}`);
  assert.doesNotMatch(r.texto, /complementos/i, `un grupo OPCIONAL nunca se exige: ${r.texto}`);
  assert.strictEqual(verPreviewPedido('e1'), null, 'sigue sin registrar nada');
});

// ═══ E2E 2 — pedido válido: no se exige lo opcional ═══════════════════════
await t('E2E2. "licuado grande de fresa": elige medida y sabor, y solo pregunta lo obligatorio pendiente', async () => {
  deleteSession('e2');
  mock.encolarRespuesta(borrador([]));
  mock.encolarRespuesta(menciones(prod('licuado'), attr('grande'), attr('fresa')));
  const r = await turno('e2', 'Quiero un licuado grande de fresa');

  assert.doesNotMatch(r.texto, /no manejamos|no tenemos/i, `todo lo pedido existe: ${r.texto}`);
  assert.match(r.texto, /falta saber/i, r.texto);
  assert.match(r.texto, /leche/i, `lo único obligatorio pendiente es la leche: ${r.texto}`);
  assert.doesNotMatch(r.texto, /complementos/i, `Complementos es opcional (min 0): ${r.texto}`);
  assert.doesNotMatch(r.texto, /medida|sabor/i, `medida y sabor ya quedaron resueltos: ${r.texto}`);
});

// ═══ E2E 3 — el cliente rechaza lo opcional explícitamente ════════════════
await t('E2E3. "sin complementos" se acepta y no se insiste', async () => {
  deleteSession('e3');
  mock.encolarRespuesta(borrador(
    [mod('Medida', 'Grande 1 Litro'), mod('Sabor', 'Fresa'), mod('Leche', 'Entera')],
    { notas: 'sin complementos' }));
  mock.encolarRespuesta(menciones(prod('licuado'), attr('grande'), attr('fresa')));
  const r = await turno('e3', 'Quiero un licuado grande de fresa con leche entera, sin complementos');

  assert.doesNotMatch(r.texto, /complementos/i, `no se insiste en un grupo opcional rechazado: ${r.texto}`);
  assert.doesNotMatch(r.texto, /no manejamos|no tenemos/i,
    `"sin complementos" es una NOTA, no una selección inexistente: ${r.texto}`);
  // El producto quedó completo: el backend toma el turno y avanza al siguiente
  // dato que falta, en vez de dejar que el modelo improvise.
  assert.match(r.texto, /recoger|domicilio/i, `pide la modalidad sin asumirla: ${r.texto}`);
});

// ═══ E2E 4 — un sabor real abreviado con acento ═══════════════════════════
await t('E2E4. el acento y la abreviación no impiden reconocer una opción real', async () => {
  deleteSession('e4');
  mock.encolarRespuesta(borrador([]));
  mock.encolarRespuesta(menciones(prod('licuado'), attr('platano')));
  const r = await turno('e4', 'Quiero un licuado de platano');
  assert.doesNotMatch(r.texto, /no manejamos "platano"/i,
    `"platano" sin acento es "Platáno" del catálogo: ${r.texto}`);
});

// ── Resumen ────────────────────────────────────────────────────────────────
mock.detener();
console.log(`\n${fallidas === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
await pool.end().catch(() => {});
process.exit(fallidas === 0 ? 0 : 1);
