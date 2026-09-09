// EL "SÍ" QUE SE PIERDE DENTRO DE UN TURNO AGRUPADO.
//
// Smoke real 2026-09-09 (negocio 5de544d8…, 13:52 y 14:35 CDT): la clienta armó
// el pedido bien —dos platillos, guarniciones distintas, promoción aplicada—,
// respondió la forma de pago, dijo "si", y NO se creó ningún folio. Dos veces.
// Los logs de producción muestran la secuencia completa:
//
//   [Meta WA] efectivo
//   [Meta WA] si                       <- sin ningún evento de proceso entre medias
//   [TXN] descuento_ignorado llm=195
//   [TXN] promo_aplicada descuento=195
//   (y NINGÚN confirmacion_desde_snapshot para ese negocio)
//
// Dos mensajes recibidos y UN solo turno procesado: los agrupó `colaMensajes`,
// que une lo que llegue en la misma ventana con '\n'. Lo que llega a clasificar
// no es "si" sino "efectivo\nsi", y eso hace match con la consulta segura de
// formas de pago, nunca con la confirmación.
//
// El resultado para la clienta es el peor de los posibles: ve un resumen que
// termina en "¿Confirmas que todo está correcto?" cuando ELLA YA DIJO QUE SÍ.
// Desde su lado el bot la ignoró. Si no lo repite —no lo repitió— no hay pedido.
//
// Esta suite reproduce el mecanismo y deja fijado por qué el arreglo evidente
// (clasificar línea por línea) NO basta: ver A4.
//
// Uso: DATABASE_URL=... node test/fase-confirmacion-agrupada.mjs
import assert from 'assert';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const mock = await arrancarAnthropicMock();
process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-agrupada';
process.env.PORT = process.env.PORT || '4253';

const { pool } = await import('../src/services/database.js');
const { procesarMensaje } = await import('../src/agent/brain.js');
const { encolarMensaje, VENTANA_AGRUPAMIENTO_MS } = await import('../src/utils/colaMensajes.js');
const { clasificarTurnoPostPreview } = await import('../src/agent/confirmacionVerbal.js');
const { getSession, deleteSession, guardarPreviewPedido, consumirPreviewPedido,
        verPreviewPedido, verPreviewConfirmable, marcarPreviewNoConfirmable } =
  await import('../src/agent/session.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const SNAP = { ordenCanonica: { items: [] }, total: 195, promociones: [], ts: Date.now(), fingerprint: 'fp-smoke' };
const nueva = (id) => { deleteSession(id); return getSession(id); };
const agrupar = (mensajes, ventanaMs = 20) => new Promise((resolve) => {
  for (const m of mensajes) encolarMensaje('smoke:5551234567', m, resolve, ventanaMs);
});

// ═══ A. El agrupamiento y lo que llega a clasificar ═════════════════════════
await t('A1. la ventana agrupa los dos mensajes en UN turno unido por salto de línea', async () => {
  const turno = await agrupar(['efectivo', 'si']);
  assert.strictEqual(turno, 'efectivo\nsi',
    'es el texto EXACTO que recibe el clasificador cuando el cliente contesta rápido');
  assert.strictEqual(VENTANA_AGRUPAMIENTO_MS, 6000, 'la ventana de producción es de 6 s');
});

await t('A2. "si" a solas SÍ confirma (el reconocedor no es el problema)', () => {
  assert.strictEqual(clasificarTurnoPostPreview('si'), 'confirmacion');
  assert.strictEqual(clasificarTurnoPostPreview('efectivo'), 'consulta_segura');
});

await t('A3. pero el turno AGRUPADO deja de ser confirmación — aquí se pierde el pedido', () => {
  const clase = clasificarTurnoPostPreview('efectivo\nsi');
  assert.strictEqual(clase, 'confirmacion',
    `"efectivo\\nsi" se clasifica '${clase}': el "si" de la clienta no confirma nada`);
});

// ═══ A4. Por qué clasificar línea por línea NO basta ════════════════════════
// Documentado como prueba para que no se intente ese atajo creyéndolo completo.
// En el caso real el turno anterior ("verde pollo frijoles…") quedó
// indeterminado y marcó el snapshot NO confirmable. Aunque el turno agrupado se
// clasificara bien, `confirmarDesdeSnapshot` sale por `verPreviewConfirmable`
// == null y no registra igual.
await t('A4. con el snapshot ya marcado no-confirmable, clasificar bien tampoco registra', () => {
  const sid = 'smoke-a4';
  nueva(sid);
  guardarPreviewPedido(sid, SNAP);
  marcarPreviewNoConfirmable(sid);              // lo que hizo el turno anterior
  assert.ok(verPreviewPedido(sid), 'el snapshot sigue existiendo');
  assert.strictEqual(verPreviewConfirmable(sid), null,
    'y por eso ninguna confirmación puede autorizarlo: el arreglo tiene que estar antes');
});

// ═══ B. El estado en que queda la clienta ═══════════════════════════════════
await t('B1. HUECO ABIERTO: el "sí" que llega en el MISMO turno que crea el preview', () => {
  // Orden real de operaciones en brain.js: primero se clasifica el turno (con
  // el snapshot que dejó el turno ANTERIOR), y solo después el camino del
  // modelo produce y guarda el preview nuevo. En el smoke, el turno anterior
  // había quedado indeterminado, así que al clasificar no había nada
  // confirmable.
  const sid = 'smoke-b1';
  nueva(sid);
  guardarPreviewPedido(sid, SNAP);
  marcarPreviewNoConfirmable(sid);                 // lo dejó el turno anterior

  // 1) Empieza el turno agrupado "efectivo\nsi".
  const clase = clasificarTurnoPostPreview('efectivo\nsi');
  assert.strictEqual(clase, 'confirmacion', 'con el arreglo del clasificador, se reconoce');
  const autoriza = verPreviewConfirmable(sid);
  assert.strictEqual(autoriza, null,
    'pero no hay snapshot confirmable: no se registra, y eso es CORRECTO');

  // 2) El mismo turno calcula el pedido y guarda el preview nuevo.
  guardarPreviewPedido(sid, SNAP);

  // Estado en que queda la clienta: hay un preview pendiente de confirmar y
  // ella ya dijo que sí. El backend hace lo correcto al no cobrar un total que
  // no vio; lo que falta es DECÍRSELO, en vez de preguntarle algo que acaba de
  // responder. Sin eso, se va — y se fue dos veces.
  assert.ok(verPreviewConfirmable(sid), 'queda un preview esperando confirmación');
  assert.strictEqual(verPreviewPedido(sid).consumido, false, 'y ningún pedido creado');
});

await t('B2. si la clienta repite el "si" a solas, el pedido SÍ se cierra', () => {
  const sid = 'smoke-b2';
  nueva(sid);
  guardarPreviewPedido(sid, SNAP);
  assert.strictEqual(clasificarTurnoPostPreview('si'), 'confirmacion');
  const tomado = consumirPreviewPedido(sid);
  assert.ok(tomado, 'el camino funciona: lo que falla es que el "si" venga acompañado');
  assert.strictEqual(tomado.total, 195);
});

// ═══ C. Controles de seguridad — el arreglo no puede aflojar esto ═══════════
await t('C1. un turno agrupado que ADEMÁS cambia el pedido sigue siendo mutación', () => {
  for (const turno of ['si\ncambiame la salsa a roja', 'efectivo\nquitale el queso']) {
    assert.notStrictEqual(clasificarTurnoPostPreview(turno), 'confirmacion',
      `"${turno}" jamás puede registrar: el cliente cambió el pedido`);
  }
});

await t('C2. un turno agrupado con una línea indeterminada NO confirma', () => {
  const turno = 'efectivo\nlos quiero rojos';
  assert.notStrictEqual(clasificarTurnoPostPreview(turno), 'confirmacion',
    'fail-closed: si una parte del turno no se entiende, no se registra');
});

await t('C3. una negación agrupada nunca confirma', () => {
  assert.notStrictEqual(clasificarTurnoPostPreview('efectivo\nno'), 'confirmacion');
  assert.notStrictEqual(clasificarTurnoPostPreview('efectivo\nno, asi no'), 'confirmacion');
});

// ═══ D. El acuse, de punta a punta ═════════════════════════════════════════
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = (await q1(`INSERT INTO negocios (nombre, slug) VALUES ('Confirmacion Agrupada','confirmacion-agrupada')
   ON CONFLICT (slug) DO UPDATE SET nombre='Confirmacion Agrupada' RETURNING id`)).id;
for (const tb of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
  await pool.query(`DELETE FROM ${tb} WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
const catD = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'GENERAL',0) RETURNING id`, [NEG])).id;
await pool.query(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Plato Simple',150)`, [NEG, catD]);
const borrador = (formaPago) => 'Va.\n<PEDIDO_BORRADOR>' + JSON.stringify({
  items: [{ nombre: 'Plato Simple', cantidad: 1, modificadores: [] }],
  modalidad: 'recoger', forma_pago: formaPago, cliente: { nombre: 'Ana' },
}) + '</PEDIDO_BORRADOR>';

await t('D1. el cliente que confirma en el mismo turno recibe ACUSE, no la pregunta a secas', async () => {
  const SID = 'agrup-e2e'; nueva(SID); mock.drenar();
  // Turno 1: pide sin forma de pago -> no hay preview (forma_pago_faltante).
  mock.encolarRespuesta(borrador(null));
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  await procesarMensaje(SID, 'un plato simple para recoger, a nombre de Ana', null, 'whatsapp', NEG, '5210000000077');
  assert.strictEqual(verPreviewConfirmable(SID), null, 'sin forma de pago no hay nada confirmable');

  // Turno 2: contesta la forma de pago y confirma de un tirón — la cola los
  // entrega como UN turno unido por '\n', igual que en producción.
  mock.drenar();
  mock.encolarRespuesta(borrador('efectivo'));
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r = await procesarMensaje(SID, 'efectivo\nsi', null, 'whatsapp', NEG, '5210000000077');

  assert.match(r.texto, /ya me confirmaste/i,
    `debe reconocer su "sí" en vez de preguntar como si no hubiera dicho nada — ${r.texto}`);
  assert.match(r.texto, /\$/, 'y seguir mostrando el total oficial');
  assert.ok(verPreviewConfirmable(SID), 'el preview queda confirmable para su siguiente "sí"');
});

await t('D2. sin confirmación anticipada, el resumen NO lleva acuse', async () => {
  const SID = 'agrup-e2e-2'; nueva(SID); mock.drenar();
  mock.encolarRespuesta(borrador('efectivo'));
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r = await procesarMensaje(SID, 'un plato simple para recoger, efectivo, a nombre de Ana',
    null, 'whatsapp', NEG, '5210000000078');
  assert.doesNotMatch(r.texto, /ya me confirmaste/i,
    `quien no confirmó no puede leer que confirmó — ${r.texto}`);
  assert.match(r.texto, /\$/, 'el camino normal sigue intacto');
});

mock.detener();
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
// Importar brain.js levanta el servidor y sus jobs: sin `exit` el proceso no
// termina nunca. Mismo cierre que fase-negaciones-injustas.
await pool.end().catch(() => {});
process.exit(fallidas === 0 ? 0 : 1);
