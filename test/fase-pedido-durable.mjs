// EL PEDIDO EN CURSO SOBREVIVE AL REINICIO.
//
// `session.js` guardaba las conversaciones en un `Map` del proceso. Ahí vive
// TODO lo acordado antes de registrar el pedido: carrito, modalidad,
// dirección, forma de pago, qué dato se espera y el preview confirmable.
//
// Un reinicio lo borraba. Y los reinicios no son raros: cada despliegue es
// uno. El 2026-09-11, desplegando tres correcciones del asistente, se
// reiniciaron procesos con conversaciones en curso. El cliente escribe "sí,
// confirmo" y el bot ya no sabe de qué.
//
// Lo que esta suite demuestra:
//   · perder la memoria y volver NO pierde el carrito;
//   · hidratar no pisa una conversación viva (la memoria es más reciente);
//   · el estado se guarda AUNQUE el turno falle -- es cuando más duele;
//   · un negocio no ve la conversación de otro;
//   · el recorte del historial no desplaza el ciclo del pedido;
//   · olvidar borra las dos copias, no solo la de memoria.
//
// Uso: DATABASE_URL=... node test/fase-pedido-durable.mjs
import assert from 'assert';
import { randomUUID } from 'node:crypto';

const { pool } = await import('../src/services/database.js');
const { getSession, deleteSession, agregarMensaje, recordarDatoPedido,
  anotarPreguntaPendiente, guardarPreviewPedido } = await import('../src/agent/session.js');
const { hidratarSesion, persistirSesion, olvidarSesion,
  purgarConversacionesViejas } = await import('../src/agent/sesionDurable.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const NEG = (await q1(`INSERT INTO negocios (nombre, slug, estado, activo)
   VALUES ('Pedido Durable','pedido-durable','activo',true)
   ON CONFLICT (slug) DO UPDATE SET activo=true RETURNING id`)).id;
const OTRO = (await q1(`INSERT INTO negocios (nombre, slug, estado, activo)
   VALUES ('Durable Ajeno','pedido-durable-ajeno','activo',true)
   ON CONFLICT (slug) DO UPDATE SET activo=true RETURNING id`)).id;

const limpiar = () => pool.query(
  `DELETE FROM conversacion_estado WHERE negocio_id = ANY($1::uuid[])`, [[NEG, OTRO]]);
await limpiar();

/** Arma una conversación con carrito, dato pendiente y preview. */
function armarCarrito(sid) {
  deleteSession(sid);
  const s = getSession(sid);
  agregarMensaje(sid, 'user', 'quiero dos chilaquiles');
  agregarMensaje(sid, 'assistant', '¿para recoger o a domicilio?');
  agregarMensaje(sid, 'user', 'a domicilio');
  s.pedido.items = [{ nombre: 'Chilaquiles', cantidad: 2, precio_unitario: 195 }];
  s.pedido.modalidad = 'entrega a domicilio';
  s.pedido.total = 390;
  recordarDatoPedido(sid, 'direccion', 'Nogal 900, col. Álamos');
  anotarPreguntaPendiente(sid, 'forma_pago');
  return s;
}

// ═══ R. El reinicio ════════════════════════════════════════════════════════
await t('R1. tras PERDER la memoria, el carrito vuelve entero', async () => {
  const sid = `meta-${NEG}-5218780000001`;
  armarCarrito(sid);
  await persistirSesion(sid, NEG);

  // Esto ES el reinicio: el proceso nuevo no tiene nada en su Map.
  deleteSession(sid);
  assert.strictEqual(getSession(sid).pedido.items.length, 0, 'la memoria arranca vacía');

  const r = await hidratarSesion(sid, NEG);
  assert.strictEqual(r.hidratada, true, 'tiene que recuperarse de la base');
  const s = getSession(sid);
  assert.strictEqual(s.pedido.items.length, 1, 'el carrito');
  assert.strictEqual(s.pedido.items[0].cantidad, 2);
  assert.strictEqual(s.pedido.modalidad, 'entrega a domicilio', 'la modalidad ya elegida');
  assert.strictEqual(s.datosPedido.direccion, 'Nogal 900, col. Álamos', 'la dirección que ya dio');
  assert.strictEqual(s.esperandoDato, 'forma_pago', 'y qué se le estaba preguntando');
  assert.strictEqual(s.mensajes.length, 3, 'con su historial, para que el respaldo siga valiendo');
});

await t('R2. hidratar NO pisa una conversación viva', async () => {
  const sid = `meta-${NEG}-5218780000002`;
  armarCarrito(sid);
  await persistirSesion(sid, NEG);
  // El cliente sigue hablando: la memoria avanza y la fila se queda atrás.
  getSession(sid).pedido.items.push({ nombre: 'Refresco', cantidad: 1, precio_unitario: 45 });

  const r = await hidratarSesion(sid, NEG);
  assert.strictEqual(r.hidratada, false, 'la memoria es más reciente por definición');
  assert.strictEqual(getSession(sid).pedido.items.length, 2, 'no puede perder lo último que dijo');
});

await t('R3. el estado se guarda AUNQUE el turno falle', async () => {
  // Es el caso que más duele: el cliente acordó algo y luego revienta el
  // proveedor. Ese acuerdo no puede irse con la excepción.
  const sid = `meta-${NEG}-5218780000003`;
  armarCarrito(sid);
  let exploto = false;
  try {
    // Se imita el envoltorio de `procesarMensaje`: el finally persiste.
    try { throw new Error('529 del proveedor'); }
    finally { await persistirSesion(sid, NEG); }
  } catch { exploto = true; }
  assert.ok(exploto, 'el error sigue propagándose: no se traga');

  deleteSession(sid);
  await hidratarSesion(sid, NEG);
  assert.strictEqual(getSession(sid).pedido.items.length, 1,
    'lo acordado antes del fallo tiene que estar');
});

// ═══ A. Aislamiento ════════════════════════════════════════════════════════
await t('A1. un negocio no ve la conversación de otro', async () => {
  const sid = `meta-${NEG}-5218780000004`;
  armarCarrito(sid);
  await persistirSesion(sid, NEG);
  deleteSession(sid);

  const r = await hidratarSesion(sid, OTRO);
  assert.strictEqual(r.hidratada, false, 'la misma clave en otro negocio no existe');
  assert.strictEqual(getSession(sid).pedido.items.length, 0);
});

await t('A2. la clave lleva el negocio: el mismo teléfono en dos sucursales no se mezcla', async () => {
  const tel = '5218780000005';
  const sidA = `meta-${NEG}-${tel}`;
  const sidB = `meta-${OTRO}-${tel}`;
  armarCarrito(sidA);
  await persistirSesion(sidA, NEG);
  deleteSession(sidB);
  getSession(sidB).pedido.items = [{ nombre: 'Otra cosa', cantidad: 9, precio_unitario: 10 }];
  await persistirSesion(sidB, OTRO);

  deleteSession(sidA); deleteSession(sidB);
  await hidratarSesion(sidA, NEG);
  await hidratarSesion(sidB, OTRO);
  assert.strictEqual(getSession(sidA).pedido.items[0].nombre, 'Chilaquiles');
  assert.strictEqual(getSession(sidB).pedido.items[0].nombre, 'Otra cosa');
});

// ═══ H. El historial ═══════════════════════════════════════════════════════
await t('H1. recortar el historial NO desplaza el ciclo del pedido', async () => {
  // El ciclo es un ÍNDICE dentro de `mensajes`. Si se recorta el historial sin
  // moverlo, apunta a otro sitio y el respaldo de una selección mira mensajes
  // equivocados: "mejor de fresa" dejaría de valer.
  const sid = `meta-${NEG}-5218780000006`;
  deleteSession(sid);
  const s = getSession(sid);
  for (let i = 0; i < 100; i++) agregarMensaje(sid, i % 2 ? 'assistant' : 'user', `turno ${i}`);
  s.cicloPedido = 90;                       // el ciclo empezó cerca del final
  const marcaDelCiclo = s.mensajes[90].content;
  await persistirSesion(sid, NEG);

  deleteSession(sid);
  await hidratarSesion(sid, NEG);
  const r = getSession(sid);
  assert.ok(r.mensajes.length <= 60, `el historial se recorta: ${r.mensajes.length}`);
  assert.strictEqual(r.mensajes[r.cicloPedido]?.content, marcaDelCiclo,
    'el ciclo tiene que seguir apuntando al MISMO mensaje tras el recorte');
});

// ═══ O. Olvidar ════════════════════════════════════════════════════════════
await t('O1. olvidar borra las DOS copias, no solo la de memoria', async () => {
  const sid = `meta-${NEG}-5218780000007`;
  armarCarrito(sid);
  await persistirSesion(sid, NEG);
  await olvidarSesion(sid, NEG);

  const fila = await q1(`SELECT 1 FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2`, [NEG, sid]);
  assert.ok(!fila, 'una fila huérfana resucitaría el carrito viejo en el siguiente mensaje');
  await hidratarSesion(sid, NEG);
  assert.strictEqual(getSession(sid).pedido.items.length, 0);
});

await t('O2. el barrido exige que alguien decida cuántos días', async () => {
  await assert.rejects(() => purgarConversacionesViejas(), /días > 0/);
  await assert.rejects(() => purgarConversacionesViejas(0), /días > 0/);
  const borradas = await purgarConversacionesViejas(3650);
  assert.strictEqual(typeof borradas, 'number', 'y devuelve cuántas borró');
});

// ═══ F. Fallos de la base ══════════════════════════════════════════════════
await t('F1. si la base no responde, el turno NO se cae', async () => {
  // Perder la durabilidad es malo; tumbarle el turno a un cliente por eso,
  // peor. Las dos funciones tienen que degradar sin lanzar.
  const sid = `meta-${NEG}-5218780000008`;
  armarCarrito(sid);
  const original = pool.query.bind(pool);
  pool.query = async () => { throw new Error('base caída'); };
  try {
    const g = await persistirSesion(sid, NEG);
    assert.strictEqual(g.guardada, false, 'lo dice, pero no lanza');
    const h = await hidratarSesion(`meta-${NEG}-nuevo`, NEG);
    assert.strictEqual(h.hidratada, false);
  } finally { pool.query = original; }
  assert.strictEqual(getSession(sid).pedido.items.length, 1, 'y la conversación sigue viva en memoria');
});

await limpiar();
await pool.end();
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach((f) => console.log(' - ' + f)); }
process.exit(fallidas === 0 ? 0 : 1);
