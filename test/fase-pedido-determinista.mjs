// LA FASE DE PEDIDO ES DEL BACKEND.
//
// Dos días de fallos con la misma forma: el modelo inventó una opción que no
// participaba en la promoción, productos participantes que no existían, y un
// grupo entero prestado del platillo vecino. Cada arreglo tapó un eje y el
// modelo se salió por el siguiente, porque el hueco no estaba en los ejes:
// estaba en que el modelo podía escribir sobre el catálogo.
//
// El intento de corregir su prosa a posteriori —detectar que preguntaba algo
// indebido y sustituirlo— produjo algo peor: un bucle sin salida en el flujo
// principal, que hubo que revertir en caliente.
//
// La conclusión medida de esos dos días: cuando el backend escribe el mensaje
// completo, funciona. Cuando se intenta influir en la prosa del modelo o
// repararla después, no. Esta suite fija esa frontera.
//
// Mientras el cliente arma su pedido, el backend tiene TODA la información
// estructurada y es quien escribe. Cuatro estados deterministas:
//   1. algo inválido/ambiguo        → mensaje de catálogo
//   2. faltan grupos obligatorios   → pregunta de qué falta
//   3. completo, sin modalidad/pago → se pide ese dato
//   4. completo con todo            → resumen oficial + UNA confirmación
//
// Y la propiedad que hace segura la #4: NO se repite. Un snapshot vigente con
// la misma huella significa que el cliente ya vio ese resumen, y el turno se le
// deja al modelo. Sin eso, cualquier pregunta posterior reimprimiría el resumen
// y se realimentaría — exactamente el bucle que costó un rollback.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... ADMIN_PASSWORD=... SESSION_SECRET=...
//      INTEGRATIONS_ENCRYPTION_KEY=... node test/fase-pedido-determinista.mjs
import assert from 'assert';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const mock = await arrancarAnthropicMock();
process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-determinista';
process.env.PORT = process.env.PORT || '4195';

const { pool } = await import('../src/services/database.js');
const { procesarMensaje } = await import('../src/agent/brain.js');
const { deleteSession, verPreviewPedido, verPreviewConfirmable } = await import('../src/agent/session.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixture: los dos vecinos del menú real ─────────────────────────────────
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = (await q1(
  `INSERT INTO negocios (nombre, slug) VALUES ('Pedido Determinista','pedido-determinista')
   ON CONFLICT (slug) DO UPDATE SET nombre='Pedido Determinista' RETURNING id`)).id;
for (const tabla of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
  await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
const cat = async (n, o) => (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,$2,$3) RETURNING id`, [NEG, n, o])).id;
const prod = async (c, n, p) => (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,$3,$4) RETURNING id`, [NEG, c, n, p])).id;
const grupo = async (pr, n, { min = 1, max = 1, orden = 0 } = {}) => (await q1(
  `INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
   VALUES ($1,$2,$3,TRUE,$4,$5,$6) RETURNING id`, [NEG, pr, n, min, max, orden])).id;
const op = async (g, n, extra = 0) => pool.query(
  `INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,$3,$4,TRUE,0)`, [NEG, g, n, extra]);

// El vecino que SÍ tiene Guarniciones — la trampa del caso real.
const catA = await cat('CHILAQUILES', 0);
const SENCILLOS = await prod(catA, 'Chilaquiles Sencillos', 145);
const s1 = await grupo(SENCILLOS, 'Salsa', { orden: 0 }); for (const x of ['Suiza', 'Roja']) await op(s1, x);
const s2 = await grupo(SENCILLOS, 'Guarniciones', { min: 1, max: 2, orden: 1 });
for (const x of ['Frijolitos naturales', 'Papas a la mexicana']) await op(s2, x);

const catB = await cat('Combitos', 1);
const COMBITO = await prod(catB, 'Combito de Chilaquiles', 195);
const c1 = await grupo(COMBITO, 'Salsa', { orden: 0 }); for (const x of ['Suiza', 'Roja']) await op(c1, x);
const c2 = await grupo(COMBITO, 'Proteína', { orden: 1 }); for (const x of ['Pechuga de pollo', 'Huevos estrellados']) await op(c2, x);
const c3 = await grupo(COMBITO, 'Topping', { orden: 2 }); await op(c3, 'Miel'); await op(c3, 'Nutella', 30);

// ── Utilidades ─────────────────────────────────────────────────────────────
const TEL = '5219990001234';
const mod = (g, ...o) => ({ grupo: g, opciones: o });
const COMPLETO = [mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'), mod('Topping', 'Nutella')];
const borrador = (mods, extra = {}) => `Listo.\n<PEDIDO_BORRADOR>${JSON.stringify({
  items: [{ nombre: 'Combito de Chilaquiles', cantidad: 1, modificadores: mods }], ...extra,
})}</PEDIDO_BORRADOR>`;
const CON_DATOS = { modalidad: 'recoger', forma_pago: 'efectivo', cliente: { nombre: 'Mario', telefono: TEL } };
const menciones = (...ms) => JSON.stringify({ menciones: ms });
const attr = (x) => ({ tipo: 'atributo', texto_fuente: x });

const DIJO = 'quiero un combito con salsa suiza, pechuga de pollo y nutella, para recoger, pago en efectivo';
async function turno(sid, msg = DIJO) {
  const ev = []; const w = console.warn; const l = console.log;
  console.warn = (...a) => ev.push(a.join(' ')); console.log = (...a) => ev.push(a.join(' '));
  try { return { ...(await procesarMensaje(sid, msg, null, 'whatsapp', NEG, TEL)), eventos: ev }; }
  finally { console.warn = w; console.log = l; }
}

// ═══ D1 — estado 4: el backend emite el resumen, no el modelo ═════════════
await t('D1. pedido completo con todos los datos → resumen OFICIAL del backend', async () => {
  deleteSession('d1');
  mock.encolarRespuesta(borrador(COMPLETO, CON_DATOS));
  mock.encolarRespuesta(menciones(attr('suiza'), attr('nutella')));
  const r = await turno('d1');
  assert.match(r.texto, /Combito de Chilaquiles/, r.texto);
  assert.match(r.texto, /\$/, `el total lo pone el backend: ${r.texto}`);
  assert.ok(verPreviewConfirmable('d1'), 'queda snapshot confirmable');
  assert.ok(r.eventos.some((e) => e.includes('preview_desde_borrador')), JSON.stringify(r.eventos));
});

// ═══ D2 — LA PROPIEDAD CRÍTICA: el estado 4 no se repite ══════════════════
await t('D2. el resumen NO se reimprime turno tras turno (sin bucle)', async () => {
  // El cliente pregunta algo después de ver el resumen. El modelo repite el
  // mismo borrador —como debe—, pero el resumen ya lo vio: el turno es suyo.
  mock.encolarRespuesta(borrador(COMPLETO, CON_DATOS));
  mock.encolarRespuesta(menciones());
  const r = await turno('d1', '¿Cuánto tarda?');
  assert.doesNotMatch(r.texto, /Tu pedido queda/i, `no puede reimprimir el resumen: ${r.texto}`);
  assert.match(r.texto, /Listo/, `el turno vuelve al modelo: ${r.texto}`);
  assert.ok(verPreviewConfirmable('d1'), 'y el pedido sigue confirmable');
});

await t('D2b. tres consultas seguidas NO reimprimen tres veces el resumen', async () => {
  // Consultas seguras: conservan el snapshot y no cambian el pedido. Es el
  // escenario donde el bucle anterior se realimentaba.
  const vistos = [];
  for (const q of ['¿Cuánto tarda?', '¿A qué hora estaría listo?', '¿Aceptan tarjeta?']) {
    mock.encolarRespuesta(borrador(COMPLETO, CON_DATOS));
    mock.encolarRespuesta(menciones());
    vistos.push((await turno('d1', q)).texto);
  }
  for (const v of vistos) {
    assert.match(v, /Listo/, `el turno es del modelo, no del backend: ${v}`);
    assert.doesNotMatch(v, /Tu pedido queda/i, `el resumen no se repite: ${v}`);
  }
  assert.ok(verPreviewConfirmable('d1'), 'y el pedido sigue confirmable todo el tiempo');
});

// ═══ D3 — estado 3: falta un dato operativo ══════════════════════════════
await t('D3. completo pero SIN forma de pago → se pide el dato, no la confirmación', async () => {
  deleteSession('d3');
  const sinPago = { ...CON_DATOS }; delete sinPago.forma_pago;
  mock.encolarRespuesta(borrador(COMPLETO, sinPago));
  mock.encolarRespuesta(menciones(attr('suiza')));
  const r = await turno('d3');
  assert.match(r.texto, /forma de pago/i, r.texto);
  assert.doesNotMatch(r.texto, /confirm/i, `no se pide confirmar algo incompleto: ${r.texto}`);
  assert.strictEqual(verPreviewConfirmable('d3'), null, 'ni queda snapshot confirmable');
});

// ═══ D3b — la modalidad NO se asume ══════════════════════════════════════
await t('D3b. sin modalidad se PREGUNTA: no se da por hecho que pasa a recoger', async () => {
  deleteSession('d3b');
  const sinModalidad = { ...CON_DATOS }; delete sinModalidad.modalidad;
  mock.encolarRespuesta(borrador(COMPLETO, sinModalidad));
  mock.encolarRespuesta(menciones(attr('suiza')));
  const r = await turno('d3b');
  assert.match(r.texto, /recoger|domicilio/i, r.texto);
  assert.strictEqual(verPreviewConfirmable('d3b'), null, 'nada confirmable sin saber cómo la recibe');
});

await t('D3c. a domicilio SIN dirección se pide la dirección, no el pago', async () => {
  deleteSession('d3c');
  mock.encolarRespuesta(borrador(COMPLETO, { ...CON_DATOS, modalidad: 'entrega a domicilio' }));
  mock.encolarRespuesta(menciones(attr('suiza')));
  const r = await turno('d3c');
  assert.match(r.texto, /direcci[óo]n/i, r.texto);
  assert.strictEqual(verPreviewConfirmable('d3c'), null, 'ni resumen ni confirmación sin dirección');
});

// ═══ D4 — estado 2: falta un grupo obligatorio ═══════════════════════════
await t('D4. falta un grupo obligatorio → lo pregunta el backend, con SUS opciones', async () => {
  deleteSession('d4');
  mock.encolarRespuesta(borrador([mod('Salsa', 'Suiza')], CON_DATOS));
  mock.encolarRespuesta(menciones(attr('suiza')));
  const r = await turno('d4', 'quiero un combito con salsa suiza, para recoger, efectivo');
  assert.match(r.texto, /falta saber/i, r.texto);
  assert.match(r.texto, /prote[íi]na/i, r.texto);
  assert.match(r.texto, /topping/i, r.texto);
  assert.doesNotMatch(r.texto, /guarnici/i, `jamás el grupo del platillo vecino: ${r.texto}`);
});

// ═══ D5 — LA PROSA INVENTADA NO LLEGA AL CLIENTE ═════════════════════════
await t('D5. aunque el modelo pida Guarniciones, el cliente NO las ve', async () => {
  deleteSession('d5');
  // El modelo hace exactamente lo que hizo en producción: exigir un grupo que
  // pertenece al platillo vecino, con el pedido ya completo.
  mock.encolarRespuesta('Para cada Combito necesito las guarniciones (1 o 2): Frijolitos '
    + `naturales o Papas a la mexicana. ¿Cuáles prefieres?\n<PEDIDO_BORRADOR>${JSON.stringify({
      items: [{ nombre: 'Combito de Chilaquiles', cantidad: 1, modificadores: COMPLETO }], ...CON_DATOS,
    })}</PEDIDO_BORRADOR>`);
  mock.encolarRespuesta(menciones(attr('suiza')));
  const r = await turno('d5');
  assert.doesNotMatch(r.texto, /guarnici/i, `la prosa inventada no puede salir: ${r.texto}`);
  assert.match(r.texto, /Combito de Chilaquiles/, `sale el resumen del backend: ${r.texto}`);
});

// ═══ D6 — estado 1: algo que no existe ═══════════════════════════════════
await t('D6. una opción inexistente se responde con el catálogo real', async () => {
  deleteSession('d6');
  mock.encolarRespuesta(borrador([mod('Salsa', 'Chimichurri')], CON_DATOS));
  mock.encolarRespuesta(menciones(attr('chimichurri')));
  const r = await turno('d6', 'quiero un combito con salsa chimichurri, recoger, efectivo');
  assert.match(r.texto, /Chimichurri/i, r.texto);
  assert.match(r.texto, /Suiza/, `con las opciones REALES: ${r.texto}`);
  assert.strictEqual(verPreviewConfirmable('d6'), null, 'nada confirmable con algo imposible');
});

// ═══ D7 — el ciclo completo termina en registro, una sola vez ════════════
await t('D7. resumen → "Sí" → UN registro, sin repreguntar', async () => {
  deleteSession('d7');
  mock.encolarRespuesta(borrador(COMPLETO, CON_DATOS));
  mock.encolarRespuesta(menciones(attr('suiza'), attr('nutella')));
  const r1 = await turno('d7');
  assert.ok(verPreviewConfirmable('d7'), r1.texto);
  const r2 = await turno('d7', 'Sí');
  assert.ok(r2.orden, 'el "sí" produce la orden canónica para registrar');
  assert.strictEqual(r2.texto, '', 'brain no afirma éxito: lo redacta el canal tras escribir');
  assert.strictEqual(mock.pendientes(), 0, 'la confirmación es determinista, sin llamar al modelo');
});

// ═══ D7b — el resumen del camino VIEJO tampoco se duplica ════════════════
await t('D7b. si el resumen vino de <ORDEN_PREVIEW>, la fase NO lo repite', async () => {
  deleteSession('d7b');
  const items = [{ nombre: 'Combito de Chilaquiles', cantidad: 1, modificadores: COMPLETO }];
  const ordenModelo = { items, ...CON_DATOS };
  // Turno 1: el modelo emite el marcador viejo. Ese snapshot no lleva huella de
  // borrador, así que sin la comprobación de huella canónica el turno siguiente
  // reimprimiría el mismo resumen.
  mock.encolarRespuesta(`Va tu resumen.\n<ORDEN_PREVIEW>${JSON.stringify(ordenModelo)}</ORDEN_PREVIEW>`);
  const r1 = await turno('d7b');
  assert.match(r1.texto, /Combito de Chilaquiles/, r1.texto);
  assert.ok(verPreviewConfirmable('d7b'), 'queda confirmable');

  // Turno 2: consulta segura; el modelo repite el borrador con el MISMO pedido.
  mock.encolarRespuesta(borrador(COMPLETO, CON_DATOS));
  mock.encolarRespuesta(menciones());
  const r2 = await turno('d7b', '¿Cuánto tarda?');
  assert.doesNotMatch(r2.texto, /Tu pedido queda/i, `no se repite el resumen: ${r2.texto}`);
  assert.match(r2.texto, /Listo/, `el turno es del modelo: ${r2.texto}`);
  assert.ok(verPreviewConfirmable('d7b'), 'y el pedido sigue confirmable');
});

// ═══ D8 — una mutación exige resumen nuevo ═══════════════════════════════
await t('D8. cambiar el pedido invalida el resumen y produce uno nuevo', async () => {
  deleteSession('d8');
  mock.encolarRespuesta(borrador(COMPLETO, CON_DATOS));
  mock.encolarRespuesta(menciones(attr('suiza')));
  await turno('d8');
  const antes = verPreviewConfirmable('d8');
  assert.ok(antes);

  mock.encolarRespuesta(borrador([mod('Salsa', 'Roja'), mod('Proteína', 'Pechuga de pollo'), mod('Topping', 'Nutella')], CON_DATOS));
  mock.encolarRespuesta(menciones(attr('roja')));
  const r = await turno('d8', 'mejor salsa roja');
  const despues = verPreviewConfirmable('d8');
  assert.ok(despues, 'debe haber un resumen NUEVO');
  assert.notStrictEqual(despues.fingerprint, antes.fingerprint, 'con huella distinta');
  assert.match(r.texto, /Roja/, r.texto);
});

// ═══ D9 — una consulta pura no entra en la fase de pedido ════════════════
await t('D9. sin borrador con artículos, el turno es del modelo', async () => {
  deleteSession('d9');
  // Sin producto mencionado no hay extracción forzada: una sola llamada.
  mock.encolarRespuesta('Abrimos de 7:30 a 14:45.');
  const r = await turno('d9', '¿A qué hora abren?');
  assert.match(r.texto, /7:30/, `una consulta la responde el modelo: ${r.texto}`);
  assert.strictEqual(verPreviewPedido('d9'), null, 'y no nace ningún pedido');
});

// ── Resumen ────────────────────────────────────────────────────────────────
mock.detener();
console.log(`\n${fallidas === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
await pool.end().catch(() => {});
process.exit(fallidas === 0 ? 0 : 1);
