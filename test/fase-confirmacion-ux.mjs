// CONFIRMACIONES: UNA sola para el cliente, TODAS por dentro.
//
// Caso real (Edna): armó su pedido y el bot le volvió a pedir modalidad,
// nombre y teléfono; su "¿Cuánto sería?" quedó sin respuesta; hubo dos
// resúmenes y tres peticiones de confirmación ("Correcto", "Que siiiiii!") y
// al final el bot afirmó que el pedido quedó cuando el backend no había
// registrado nada. Terminó con "Ay no bye! Tanto para hacer un pedido!?".
//
// Lo que esta suite fija es la separación entre las dos cosas que se estaban
// confundiendo: cuántas veces se le PREGUNTA al cliente (una) y cuántas veces
// VALIDA el backend (todas las que ya hacía). Ninguna prueba de aquí afloja el
// camino determinista: preview oficial → snapshot → huella → revalidación →
// consumo atómico → registro.
//
// Fixture realista a propósito (opciones de varias palabras, un grupo opcional
// con máximo>1): un catálogo de juguete esconde justo los casos que rompen.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... ADMIN_PASSWORD=... SESSION_SECRET=...
//      INTEGRATIONS_ENCRYPTION_KEY=... node test/fase-confirmacion-ux.mjs
import assert from 'assert';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const mock = await arrancarAnthropicMock();
process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-confirmacion';
process.env.PORT = process.env.PORT || '4191';

const { pool } = await import('../src/services/database.js');
const { procesarMensaje } = await import('../src/agent/brain.js');
const { deleteSession, verPreviewPedido, verPreviewConfirmable } = await import('../src/agent/session.js');
const { clasificarTurnoPostPreview, esConfirmacionVerbal } = await import('../src/agent/confirmacionVerbal.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixture realista ───────────────────────────────────────────────────────
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = (await q1(
  `INSERT INTO negocios (nombre, slug) VALUES ('Confirmacion UX','confirmacion-ux')
   ON CONFLICT (slug) DO UPDATE SET nombre='Confirmacion UX' RETURNING id`)).id;
for (const tabla of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
  await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
const cat = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'BEBIDAS',0) RETURNING id`, [NEG])).id;
const LICUADO = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Licuado',60) RETURNING id`, [NEG, cat])).id;
const grupo = async (prod, nombre, { requerido = false, minimo = 0, maximo = 0 } = {}) => (await q1(
  `INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
   VALUES ($1,$2,$3,$4,$5,$6,0) RETURNING id`, [NEG, prod, nombre, requerido, minimo, maximo])).id;
const op = async (gid, nombre, extra = 0) => (await q1(
  `INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,$3,$4,TRUE,0) RETURNING id`, [NEG, gid, nombre, extra])).id;

const gMedida = await grupo(LICUADO, 'Medida', { requerido: true, minimo: 1, maximo: 1 });
await op(gMedida, 'Chico'); await op(gMedida, 'Grande 1 Litro', 20);
const gSabor = await grupo(LICUADO, 'Sabor', { requerido: true, minimo: 1, maximo: 1 });
for (const s of ['Platáno', 'Fresa', 'Melón', 'Papaya']) await op(gSabor, s);
const gLeche = await grupo(LICUADO, 'Leche', { requerido: true, minimo: 1, maximo: 1 });
await op(gLeche, 'Entera'); await op(gLeche, 'Deslactosada');
const gComp = await grupo(LICUADO, 'Complementos', { requerido: false, minimo: 0, maximo: 3 });
for (const c of ['Vainilla', 'Chocolate', 'Avena', 'Canela']) await op(gComp, c);

// ── Utilidades ─────────────────────────────────────────────────────────────
const TEL = '5219991234567';
const ordenCompleta = (extra = {}) => ({
  items: [{
    nombre: 'Licuado', cantidad: 1,
    modificadores: [
      { grupo: 'Medida', opciones: ['Grande 1 Litro'] },
      { grupo: 'Sabor', opciones: ['Fresa'] },
      { grupo: 'Leche', opciones: ['Entera'] },
    ],
    ...(extra.item || {}),
  }],
  forma_pago: 'efectivo', modalidad: 'recoger',
  cliente: { nombre: 'Cliente Prueba', telefono: TEL },
  ...(extra.orden || {}),
});
const preview = (o = ordenCompleta()) => `Va tu resumen.\n<ORDEN_PREVIEW>${JSON.stringify(o)}</ORDEN_PREVIEW>`;

async function turno(sessionId, mensaje, { conTelefono = false } = {}) {
  const eventos = []; const warn = console.warn; const log = console.log;
  console.warn = (...a) => { eventos.push(a.join(' ')); };
  console.log = (...a) => { eventos.push(a.join(' ')); };
  try {
    const r = await procesarMensaje(sessionId, mensaje, null, 'whatsapp', NEG, conTelefono ? TEL : null);
    return { ...r, eventos };
  } finally { console.warn = warn; console.log = log; }
}

// Cuenta cuántas veces el texto le PIDE confirmación al cliente.
const pidesConfirmacion = (txt) => (String(txt || '').match(/confirm|¿(est[aá] bien|correcto)\?/gi) || []).length;

// ═══ C2/C3 — afirmaciones naturales ═══════════════════════════════════════
await t('C2/C3. las afirmaciones naturales del cliente se reconocen como confirmación', () => {
  const confirman = ['Sí', 'Si', 'Correcto', 'Correcto.', 'Confirmo', 'Adelante', 'De acuerdo',
    'Está bien', 'Esta bien', 'Que sí', 'Que si', 'Que siiiiii', 'Que siiiiii!', 'Ya te dije que sí'];
  const fallan = confirman.filter((f) => clasificarTurnoPostPreview(f) !== 'confirmacion');
  assert.deepStrictEqual(fallan, [], `estas afirmaciones dejan al cliente repitiéndose: ${JSON.stringify(fallan)}`);
});

await t('C8. una afirmación CON cambio sigue siendo mutación, no confirmación', () => {
  const mutaciones = ['Sí, pero sin cebolla', 'Sí, mejor dos', 'Correcto, pero cambia la leche',
    'Sí, quítale uno', 'Que sea grande', 'Sí pero a domicilio'];
  const malas = mutaciones.filter((f) => clasificarTurnoPostPreview(f) !== 'mutacion');
  assert.deepStrictEqual(malas, [], `esto NO puede registrar el pedido viejo: ${JSON.stringify(malas)}`);
});

await t('C11. una pregunta informativa conserva el snapshot', () => {
  for (const p of ['¿Cuánto tarda?', '¿Cuánto sería?', '¿Aceptan tarjeta?', '¿A qué hora estaría listo?']) {
    assert.strictEqual(clasificarTurnoPostPreview(p), 'consulta_segura', `${p} no debe destruir el pedido`);
  }
});

// ═══ C1 — happy path: UN preview, UNA confirmación, UN registro ═══════════
await t('C1. happy path: un preview, una confirmación visible, un registro', async () => {
  deleteSession('c1');
  mock.encolarRespuesta(preview());
  const r1 = await turno('c1', 'Quiero un licuado grande de fresa con leche entera, para recoger, pago en efectivo');
  assert.ok(/Licuado/i.test(r1.texto), `el resumen oficial debe salir del backend: ${r1.texto}`);
  assert.strictEqual(r1.orden, null, 'el preview NO registra');
  assert.ok(verPreviewConfirmable('c1'), 'debe quedar snapshot confirmable');
  assert.strictEqual(pidesConfirmacion(r1.texto), 1, `una sola petición de confirmación: ${r1.texto}`);

  const r2 = await turno('c1', 'Sí');
  assert.ok(r2.orden, 'el "sí" sobre el resumen oficial debe producir la orden canónica para registrar');
  assert.strictEqual(mock.pendientes(), 0, 'la confirmación es determinista: no vuelve a llamar al modelo');
});

await t('C2b. "Que siiiiii!" registra igual que un "sí" seco', async () => {
  deleteSession('c2');
  mock.encolarRespuesta(preview());
  await turno('c2', 'Quiero un licuado grande de fresa con leche entera, recoger, efectivo');
  const r = await turno('c2', '¡Que siiiiii!');
  assert.ok(r.orden, 'el cliente ya dijo que sí tres veces; no puede volver a preguntársele');
});

await t('C3b. "Correcto" registra cuando no hay cambio', async () => {
  deleteSession('c3');
  mock.encolarRespuesta(preview());
  await turno('c3', 'Quiero un licuado grande de fresa con leche entera, recoger, efectivo');
  const r = await turno('c3', 'Correcto');
  assert.ok(r.orden, 'confirmación explícita sobre el resumen oficial');
});

// ═══ C13 — el mismo snapshot no se registra dos veces ═════════════════════
await t('C13. tras registrar, un segundo "sí" NO vuelve a registrar', async () => {
  deleteSession('c13');
  mock.encolarRespuesta(preview());
  await turno('c13', 'Quiero un licuado grande de fresa con leche entera, recoger, efectivo');
  const primero = await turno('c13', 'Sí');
  assert.ok(primero.orden, 'el primero sí registra');
  mock.encolarRespuesta('Tu pedido ya está en cocina.');
  const segundo = await turno('c13', 'Sí');
  assert.strictEqual(segundo.orden, null, 'un segundo "sí" no puede crear otro folio');
});

// ═══ C9/C10 — cambio económico exige nuevo preview ════════════════════════
await t('C9/C10. cambiar cantidad o producto invalida el resumen y exige uno nuevo', async () => {
  deleteSession('c9');
  mock.encolarRespuesta(preview());
  await turno('c9', 'Quiero un licuado grande de fresa con leche entera, recoger, efectivo');
  assert.ok(verPreviewConfirmable('c9'), 'hay snapshot');
  mock.encolarRespuesta('Claro, ¿algo más?');
  await turno('c9', 'Mejor que sean dos');
  assert.strictEqual(verPreviewConfirmable('c9'), null, 'el resumen viejo ya no puede confirmarse');
});

// ═══ C12 — nunca una confirmación falsa ═══════════════════════════════════
await t('C12. el texto de éxito NO lo escribe el modelo: sin orden no hay "pedido confirmado"', async () => {
  deleteSession('c12');
  mock.encolarRespuesta(preview());
  await turno('c12', 'Quiero un licuado grande de fresa con leche entera, recoger, efectivo');
  const r = await turno('c12', 'Sí');
  assert.ok(r.orden, 'devuelve la orden para que el CANAL registre y redacte el cierre real');
  assert.strictEqual(r.texto, '', 'brain no afirma nada: el pedido todavía no existe cuando devuelve');
});

// ═══ C4 — la forma de pago faltante NO desencadena una segunda confirmación ══
await t('C4. sin forma de pago se PIDE el dato, no se pide confirmar un pedido incompleto', async () => {
  deleteSession('c4');
  const sinPago = ordenCompleta(); delete sinPago.forma_pago;
  mock.encolarRespuesta(preview(sinPago));
  const r1 = await turno('c4', 'Quiero un licuado grande de fresa con leche entera, para recoger');
  assert.match(r1.texto, /forma de pago/i, `debe pedir el dato que falta: ${r1.texto}`);
  assert.strictEqual(pidesConfirmacion(r1.texto), 0,
    `no se pide confirmar un pedido al que aún le falta un dato obligatorio: ${r1.texto}`);
  assert.strictEqual(verPreviewConfirmable('c4'), null, 'un pedido incompleto no deja snapshot confirmable');

  // El cliente responde el dato y AHÍ sí aparece el resumen, una sola vez.
  mock.encolarRespuesta(preview());
  const r2 = await turno('c4', 'Efectivo');
  assert.strictEqual(pidesConfirmacion(r2.texto), 1, `una sola confirmación: ${r2.texto}`);
  const r3 = await turno('c4', 'Correcto');
  assert.ok(r3.orden, 'y registra sin volver a preguntar');
});

// ═══ C5 — una pregunta directa se responde sin perder el pedido ═══════════
await t('C5. "¿Cuánto sería?" conserva el pedido y el cliente puede confirmar después', async () => {
  deleteSession('c5');
  mock.encolarRespuesta(preview());
  const r1 = await turno('c5', 'Quiero un licuado grande de fresa con leche entera, recoger, efectivo');
  const totalMostrado = r1.texto;
  assert.match(totalMostrado, /\$/, `el resumen oficial trae el total: ${totalMostrado}`);

  mock.encolarRespuesta('El total es el que te mostré arriba.');
  await turno('c5', '¿Cuánto sería?');
  assert.ok(verPreviewConfirmable('c5'), 'la pregunta NO puede destruir el pedido armado');

  const r3 = await turno('c5', 'Sí');
  assert.ok(r3.orden, 'y después de responderla, el "sí" sigue registrando');
});

// ═══ C6/C7 — no volver a pedir lo que ya se sabe ══════════════════════════
await t('C6/C7. el teléfono que da WhatsApp llega al prompt y NO se le pregunta al cliente', async () => {
  deleteSession('c67');
  let systemVisto = '';
  mock.encolarRespuesta((payload) => { systemVisto = payload.system || ''; return 'Con gusto, ¿de qué sabor?'; });
  await turno('c67', 'Quiero un licuado', { conTelefono: true });
  assert.match(systemVisto, /DATOS QUE YA TIENES DE ESTE CLIENTE/,
    'el bloque de datos conocidos debe formar parte del prompt');
  assert.ok(systemVisto.includes(TEL),
    'el teléfono del webhook tiene que llegar al modelo — pedirlo otra vez fue parte del abandono real');
  assert.match(systemVisto, /no los preguntes/i, systemVisto.slice(0, 0) || 'debe instruir explícitamente no repreguntar');
});

// ═══ C14 — flujo Edna completo ════════════════════════════════════════════
await t('C14. flujo Edna: nota conservada, pregunta respondida, UNA confirmación, UN registro', async () => {
  deleteSession('edna');
  let confirmacionesVisibles = 0;
  let systemUltimo = '';

  // 1) arma el pedido con una nota por item; el modelo aún no tiene todo.
  mock.encolarRespuesta((p) => { systemUltimo = p.system || ''; return 'Claro, ¿para recoger o a domicilio?'; });
  await turno('edna', 'Quiero un licuado grande de fresa con leche entera, sin azúcar', { conTelefono: true });
  assert.ok(systemUltimo.includes(TEL), 'ya en el primer turno conoce el teléfono');

  // 2) modalidad + forma de pago en el mismo turno → resumen oficial COMPLETO.
  const conNota = ordenCompleta({ item: { notas: 'sin azúcar' } });
  mock.encolarRespuesta(preview(conNota));
  const r2 = await turno('edna', 'Para recoger, pago en efectivo', { conTelefono: true });
  confirmacionesVisibles += pidesConfirmacion(r2.texto);
  assert.match(r2.texto, /sin az[úu]car/i, `la nota del cliente sobrevive al resumen: ${r2.texto}`);

  // 3) pregunta directa: se responde y el pedido sigue en pie.
  mock.encolarRespuesta('Es el total que te mostré.');
  const r3 = await turno('edna', '¿Cuánto sería?', { conTelefono: true });
  confirmacionesVisibles += pidesConfirmacion(r3.texto);
  assert.ok(verPreviewConfirmable('edna'), 'preguntar el precio no puede tirar el pedido');

  // 4) confirmación enfática — la que antes no se reconocía.
  const r4 = await turno('edna', '¡Que siiiiii!', { conTelefono: true });
  assert.ok(r4.orden, 'aquí terminaba el bucle: la clienta ya había dicho que sí varias veces');
  assert.strictEqual(r4.texto, '', 'brain no afirma éxito: lo redacta el canal tras la escritura real');

  assert.strictEqual(confirmacionesVisibles, 1,
    `el cliente solo puede ver UNA petición de confirmación en todo el flujo (vio ${confirmacionesVisibles})`);
  assert.strictEqual(mock.pendientes(), 0, 'ninguna llamada al modelo de más');
});

// ── Resumen ────────────────────────────────────────────────────────────────
mock.detener();
console.log(`\n${fallidas === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
await pool.end().catch(() => {});
process.exit(fallidas === 0 ? 0 : 1);
