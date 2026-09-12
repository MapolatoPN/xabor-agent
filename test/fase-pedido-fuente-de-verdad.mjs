// EL PEDIDO ES DEL CLIENTE, NO DEL ÚLTIMO BORRADOR DEL MODELO.
//
// Origen: auditoría de Codex del 2026-09-12 (tres fallas reproducidas contra el
// código desplegado) unida a los hallazgos del 11-sep. Las reproducciones de
// Codex entran aquí TAL CUAL —AUDIT A, B y C— para que dejen de ser un archivo
// suelto y se vuelvan regresión obligatoria.
//
// La causa común de las tres: en cada turno, el borrador que emite el modelo ES
// el pedido. Identidad, cantidades y selecciones se derivan de esa emisión, así
// que si el modelo omite, se contradice o resuelve de más, el sistema lo toma
// por la voluntad del cliente.
//
// Lo que esta suite defiende, y que ninguna prueba de función aislada alcanza:
//
//   · omitir un artículo no lo borra
//   · contestar modalidad, nombre, dirección o pago no toca los artículos
//   · un ID que contradice el nombre no gana en silencio
//   · una palabra genérica no elige entre dos opciones hermanas
//   · y nada de lo anterior vuelve imposible una petición válida
//
// El catálogo es el de Obispado (fixture de Codex) porque es donde ocurrieron
// los incidentes, pero cada caso se apoya en la ESTRUCTURA de la carta, no en
// sus nombres: el negocio B de esta misma suite tiene otra carta y otras reglas.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const mock = await arrancarAnthropicMock();
process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-fuente-verdad';
process.env.PORT = process.env.PORT || '4298';

const { pool } = await import('../src/services/database.js');
assert(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname),
  'Solo base local de pruebas');

// El esquema de la conversación durable y de la recepción compartida se aplica
// aquí: esta suite reinicia sesiones a propósito y necesita esas tablas. Los
// .sql son idempotentes, así que correrla dos veces no rompe nada.
for (const m of ['076_conversacion_durable', '077_webhook_entrante_durable', '078_whatsapp_continuidad']) {
  await pool.query(readFileSync(new URL(`../migrations/${m}.sql`, import.meta.url), 'utf8'));
}

const { validarBorradorPedido, mensajeBorradorParaCliente } = await import('../src/orders/validadorOrden.js');
const { procesarMensaje } = await import('../src/agent/brain.js');
const { getSession, desalojarDeMemoria, verPreviewConfirmable, deleteSession, iniciarCicloPedido } = await import('../src/agent/session.js');

let ok = 0, fail = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); ok++; console.log(`  OK  ${nombre}`); }
  catch (e) { fail++; fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}
const q = async (s, p) => (await pool.query(s, p)).rows[0];
const mod = (grupo, ...opciones) => ({ grupo, opciones });

// ── Dos negocios con cartas DISTINTAS ───────────────────────────────────────
// Xabor es multiempresa: una corrección que dependa de los nombres de Obispado
// no sirve. El negocio B existe para que cada invariante se compruebe también
// contra otra estructura.
async function sembrarObispado() {
  const neg = (await q('INSERT INTO negocios(nombre,slug) VALUES ($1,$2) RETURNING id',
    ['Fuente A', 'fuente-a-' + randomUUID()])).id;
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/chilaquiles-obispado.json', import.meta.url)));
  const cat = (await q('INSERT INTO menu_categorias(negocio_id,nombre) VALUES($1,$2) RETURNING id', [neg, 'Desayunos'])).id;
  const ids = new Map();
  for (const p of fixture.catalogo) {
    ids.set(p.id, (await q(`INSERT INTO menu_productos(negocio_id,categoria_id,nombre,descripcion,precio,disponible)
      VALUES($1,$2,$3,$4,$5,true) RETURNING id`, [neg, cat, p.nombre, p.descripcion, p.precio])).id);
  }
  for (const g of fixture.grupos) {
    const gid = (await q(`INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [neg, ids.get(g.producto_id), g.nombre, g.requerido, g.minimo, g.maximo])).id;
    for (const o of g.opciones) {
      await pool.query(`INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible)
        VALUES($1,$2,$3,$4,$5)`, [neg, gid, o.nombre, o.precio_extra, o.disponible]);
    }
  }
  return { neg, ids };
}

// Carta B: otra familia con variantes, otras opciones hermanas, otros topes.
async function sembrarNegocioB() {
  const neg = (await q('INSERT INTO negocios(nombre,slug) VALUES ($1,$2) RETURNING id',
    ['Fuente B', 'fuente-b-' + randomUUID()])).id;
  const cat = (await q('INSERT INTO menu_categorias(negocio_id,nombre) VALUES($1,$2) RETURNING id', [neg, 'Carta'])).id;
  const prod = async (nombre, precio) => (await q(
    'INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,disponible) VALUES($1,$2,$3,$4,true) RETURNING id',
    [neg, cat, nombre, precio])).id;
  const grupo = async (pid, nombre, min, max, opciones) => {
    const gid = (await q(`INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [neg, pid, nombre, min > 0, min, max])).id;
    for (const o of opciones) {
      await pool.query(`INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible)
        VALUES($1,$2,$3,0,true)`, [neg, gid, o]);
    }
  };
  const chico = await prod('Ramen Chico', 130);
  const grande = await prod('Ramen Grande', 175);
  const gyoza = await prod('Gyozas', 90);
  for (const p of [chico, grande]) {
    await grupo(p, 'Caldo', 1, 1, ['Tonkotsu', 'Miso', 'Shoyu']);
    // Dos hermanas que una palabra genérica NO distingue: "pollo".
    await grupo(p, 'Proteína', 1, 1, ['Pollo asado', 'Pollo karaage', 'Cerdo chashu']);
  }
  await grupo(grande, 'Extras', 0, 2, ['Huevo marinado', 'Alga nori']);
  await grupo(gyoza, 'Relleno', 1, 1, ['Cerdo', 'Verdura']);
  return { neg, chico, grande, gyoza };
}

const A = await sembrarObispado();
const B = await sembrarNegocioB();

// El turno real del incidente, y el borrador que el modelo emitió.
const TEXTO_ORIGINAL = 'Si quiero unos chilaquiles suizos con pollo, bistec en salsa y queso panela Además una orden de hotcakes de sartén';
const DOBLE = { items: [
  { nombre: 'Chilaquiles', cantidad: 1, modificadores: [
    mod('Salsa', 'Suiza'), mod('Proteína', 'pollo'), mod('Guarniciones', 'bistec en salsa', 'queso panela')] },
  { nombre: 'Hotcakes de Sarten', cantidad: 1, modificadores: [] },
] };

const encolarTurno = (borrador, menciones = []) => {
  mock.drenar();
  mock.encolarRespuesta('Claro. <PEDIDO_BORRADOR>' + JSON.stringify(borrador) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones }));
};

try {

// ═══ AUDIT A — un ID contradictorio no sustituye al producto nombrado ═══════
//
// El borrador trae nombre "Chilaquiles Sencillos" y el identificador de
// "Hotcakes de Sarten". Pertenecer al catálogo del negocio no demuestra que el
// cliente eligiera ese producto: la identidad y la evidencia de elección son
// cosas distintas, y aquí se contradicen.
await t('A1. un ID que contradice el nombre no gana en silencio', async () => {
  const r = await validarBorradorPedido(
    { items: [{ id: A.ids.get(79), nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [] }] },
    A.neg, { textoCiclo: 'Quiero chilaquiles sencillos' });
  assert.notEqual(r.productos[0]?.producto, 'Hotcakes de Sarten',
    'el validador aceptó hotcakes ante un nombre de chilaquiles');
});

await t('A2. el mismo choque en otro negocio, con otra carta', async () => {
  const r = await validarBorradorPedido(
    { items: [{ id: B.gyoza, nombre: 'Ramen Grande', cantidad: 1, modificadores: [] }] },
    B.neg, { textoCiclo: 'quiero un ramen grande' });
  assert.notEqual(r.productos[0]?.producto, 'Gyozas',
    'la invariante no puede depender del catálogo de Obispado');
});

await t('A3. un ID que CONCUERDA con el nombre sigue resolviendo (no se rompe lo bueno)', async () => {
  const r = await validarBorradorPedido(
    { items: [{ id: A.ids.get(85), nombre: 'Chilaquiles Sencillos', cantidad: 1,
      modificadores: [mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
        mod('Guarniciones', 'Frijolitos naturales', 'Papas a la mexicana')] }] },
    A.neg, { textoCiclo: 'chilaquiles sencillos suizos con pechuga de pollo, frijolitos naturales y papas a la mexicana' });
  assert.equal(r.productos[0]?.producto, 'Chilaquiles Sencillos', JSON.stringify(r.productosNoExisten));
});

// ═══ AUDIT B — una palabra genérica no elige entre hermanas ════════════════
//
// El cliente dijo "frijoles". Existen "Frijolitos naturales" y "Frijolitos con
// chorizo". Que el modelo escriba uno de los dos no es una elección del
// cliente. La protección no puede depender de cuál de las dos formas redacte.
await t('B1. "frijoles" no autoriza "Frijolitos naturales" habiendo también con chorizo', async () => {
  const r = await validarBorradorPedido(
    { items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
      mod('Salsa', 'Suiza'), mod('Proteína', 'Huevos Estrellados'),
      mod('Guarniciones', 'Frijolitos naturales', 'Papas a la mexicana')] }] },
    A.neg, { textoCiclo: 'quiero unos chilaquiles suizos con huevos estrellados y le pones frijoles y papas a la mexicana Sencillos' });
  assert.equal(r.ok, false, 'aceptó frijoles naturales sin que el cliente eligiera entre las dos');
});

await t('B2. la misma regla en el negocio B: "pollo" no elige entre asado y karaage', async () => {
  const r = await validarBorradorPedido(
    { items: [{ nombre: 'Ramen Chico', cantidad: 1, modificadores: [
      mod('Caldo', 'Miso'), mod('Proteína', 'Pollo asado')] }] },
    B.neg, { textoCiclo: 'un ramen chico de miso con pollo' });
  assert.equal(r.ok, false, '"pollo" sostiene asado Y karaage: no puede elegirse solo');
});

await t('B3. cuando el cliente SÍ distingue, se acepta (no se vuelve imposible pedir)', async () => {
  const r = await validarBorradorPedido(
    { items: [{ nombre: 'Ramen Chico', cantidad: 1, modificadores: [
      mod('Caldo', 'Miso'), mod('Proteína', 'Pollo karaage')] }] },
    B.neg, { textoCiclo: 'un ramen chico de miso con pollo karaage' });
  assert.equal(r.ok, true, `decir "karaage" distingue y debe bastar — ${JSON.stringify(r.productos?.[0])}`);
});

await t('B4. una opción sin hermanas parecidas se sigue aceptando con la palabra del cliente', async () => {
  const r = await validarBorradorPedido(
    { items: [{ nombre: 'Gyozas', cantidad: 1, modificadores: [mod('Relleno', 'Verdura')] }] },
    B.neg, { textoCiclo: 'unas gyozas de verdura' });
  assert.equal(r.ok, true, 'no hay ambigüedad: "verdura" solo puede ser una');
});

// ═══ AUDIT C — el pedido sobrevive al turno ════════════════════════════════
//
// La falla de prioridad alta: el cliente contesta un dato operativo, el modelo
// omite el segundo platillo en su borrador, y el sistema presenta media cuenta.
await t('C1. responder modalidad/pago/nombre no borra el segundo platillo', async () => {
  const sid = 'audit-c1-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000101');

  encolarTurno(DOBLE);
  const segundo = await procesarMensaje(sid, 'Los sencillos', null, 'whatsapp', A.neg, '5210000000101');
  assert.match(segundo.texto || '', /recoger|domicilio|falta/i, `esperaba avanzar — ${segundo.texto}`);

  // El modelo OLVIDA los hotcakes en el turno del dato operativo.
  const incompleto = { items: [{ ...DOBLE.items[0], nombre: 'Chilaquiles Sencillos' }],
    modalidad: 'recoger', forma_pago: 'efectivo', cliente: { nombre: 'Ana' } };
  encolarTurno(incompleto);
  const tercero = await procesarMensaje(sid, 'Para recoger, efectivo, a nombre de Ana', null, 'whatsapp', A.neg, '5210000000101');
  assert.match(tercero.texto || '', /Hotcakes/i,
    `se perdió el segundo platillo al responder un dato operativo — ${tercero.texto}`);
});

await t('C2. sobrevive a DOS reinicios y llega entero a la preconfirmacion', async () => {
  const sid = 'audit-c2-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000102');

  desalojarDeMemoria(sid);                       // reinicio del proceso
  const soloChilaquiles = { items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
    mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
    mod('Guarniciones', 'Bistec en salsa', 'Queso panela en salsa')] }] };
  encolarTurno(soloChilaquiles);
  await procesarMensaje(sid, 'Los sencillos', null, 'whatsapp', A.neg, '5210000000102');
  // El turno que elige presentación no enseña la cuenta todavía: lo que hay que
  // comprobar aquí es la FUENTE DE VERDAD, que es lo que el reinicio amenaza.
  assert.equal(getSession(sid).carrito?.items?.length, 2,
    `el carrito debe traer los dos platillos — ${JSON.stringify(getSession(sid).carrito)}`);

  desalojarDeMemoria(sid);                       // segundo reinicio, ya con el pedido resuelto
  encolarTurno({ ...soloChilaquiles, modalidad: 'recoger', forma_pago: 'efectivo', cliente: { nombre: 'Ana' } });
  const r = await procesarMensaje(sid, 'Para recoger, efectivo, a nombre de Ana', null, 'whatsapp', A.neg, '5210000000102');
  assert.match(r.texto || '', /Hotcakes/i,
    `la cuenta que ve el cliente perdió un platillo tras el reinicio — ${r.texto}`);
});
await t('C3. y el mismo olvido en el negocio B', async () => {
  const sid = 'audit-c3-' + randomUUID();
  deleteSession(sid);
  const dos = { items: [
    { nombre: 'Ramen Grande', cantidad: 1, modificadores: [mod('Caldo', 'Tonkotsu'), mod('Proteína', 'Cerdo chashu')] },
    { nombre: 'Gyozas', cantidad: 1, modificadores: [mod('Relleno', 'Cerdo')] },
  ] };
  encolarTurno(dos);
  await procesarMensaje(sid, 'un ramen grande tonkotsu con cerdo chashu y unas gyozas de cerdo', null, 'whatsapp', B.neg, '5210000000103');
  encolarTurno({ items: [dos.items[0]], modalidad: 'recoger', forma_pago: 'efectivo', cliente: { nombre: 'Ana' } });
  const r = await procesarMensaje(sid, 'para recoger, efectivo, a nombre de Ana', null, 'whatsapp', B.neg, '5210000000103');
  assert.match(r.texto || '', /Gyozas/i, `se perdieron las gyozas — ${r.texto}`);
});

// ═══ Lo contrario: que el carrito no vuelva imposible cambiar de opinión ═══
//
// Un carrito que nunca suelta nada sería tan malo como uno que lo pierde todo.
// Estos casos son la otra mitad del contrato.
await t('D1. quitar un artículo explícitamente SÍ lo quita', async () => {
  const sid = 'audit-d1-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000104');
  encolarTurno({ items: [{ ...DOBLE.items[0], nombre: 'Chilaquiles Sencillos' }] });
  const r = await procesarMensaje(sid, 'quita los hotcakes por favor', null, 'whatsapp', A.neg, '5210000000104');
  assert.doesNotMatch(r.texto || '', /Hotcakes/i, `el cliente pidió quitarlos — ${r.texto}`);
});

await t('D2. cambiar la cantidad se respeta y no duplica el renglón', async () => {
  const sid = 'audit-d2-' + randomUUID();
  deleteSession(sid);
  encolarTurno({ items: [{ nombre: 'Gyozas', cantidad: 1, modificadores: [mod('Relleno', 'Cerdo')] }] });
  await procesarMensaje(sid, 'unas gyozas de cerdo', null, 'whatsapp', B.neg, '5210000000105');
  encolarTurno({ items: [{ nombre: 'Gyozas', cantidad: 3, modificadores: [mod('Relleno', 'Cerdo')] }] });
  await procesarMensaje(sid, 'mejor que sean tres', null, 'whatsapp', B.neg, '5210000000105');
  const carrito = getSession(sid).carrito;
  // Dos riesgos opuestos, y el carrito tiene que esquivar los dos: quedarse en 1
  // (el carrito manda sobre el cliente) o abrir un segundo renglón de gyozas
  // (conservar donde tocaba actualizar).
  assert.equal(carrito?.items?.length, 1, `debe seguir siendo un renglón — ${JSON.stringify(carrito)}`);
  assert.equal(carrito.items[0].cantidad, 3, `la cantidad nueva debe mandar — ${JSON.stringify(carrito)}`);
});
await t('D3. dos unidades del MISMO producto con preparaciones distintas conviven', async () => {
  const dos = { items: [
    { nombre: 'Ramen Chico', cantidad: 1, modificadores: [mod('Caldo', 'Miso'), mod('Proteína', 'Pollo karaage')] },
    { nombre: 'Ramen Chico', cantidad: 1, modificadores: [mod('Caldo', 'Shoyu'), mod('Proteína', 'Cerdo chashu')] },
  ] };
  const r = await validarBorradorPedido(dos, B.neg,
    { textoCiclo: 'un ramen chico de miso con pollo karaage y otro de shoyu con cerdo chashu' });
  assert.equal(r.ok, true, JSON.stringify(r.productosNoExisten));
  assert.equal(r.productos.length, 2, 'son dos artículos distintos, no una cantidad 2');
});


// ═══ E — la conversación completa, no el caso aislado ══════════════════════
//
// El mandato es explícito: la garantía tiene que aguantar sustituciones,
// respuestas de dos palabras, apodos y erratas, respuestas del modelo en prosa
// o vacías, mensajes agrupados, reentregas y dos instancias. Cada uno de estos
// casos rompía —o podía romper— de una forma distinta.

await t('E1. sustituir un artículo por otro: sale el viejo, entra el nuevo', async () => {
  const sid = 'audit-e1-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000106');
  // El cliente cambia de idea: fuera hotcakes, dentro un bowl.
  encolarTurno({ items: [
    { nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
      mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
      mod('Guarniciones', 'Bistec en salsa', 'Queso panela en salsa')] },
    { nombre: 'Bowl de Chilaquiles', cantidad: 1, modificadores: [
      mod('Salsa', 'Roja'), mod('Proteína', 'Huevos Revueltos')] },
  ] });
  await procesarMensaje(sid, 'quita los hotcakes y mejor ponme un bowl de chilaquiles con salsa roja y huevos revueltos',
    null, 'whatsapp', A.neg, '5210000000106');
  const nombres = (getSession(sid).carrito?.items || []).map((i) => i.nombre).join(' | ');
  assert.doesNotMatch(nombres, /Hotcakes/i, `los hotcakes se sustituyeron, no pueden seguir — ${nombres}`);
  assert.match(nombres, /Bowl/i, `el artículo nuevo tiene que entrar — ${nombres}`);
  assert.match(nombres, /Chilaquiles Sencillos/i, `sustituir uno no arrastra al otro — ${nombres}`);
});

await t('E2. "ambos" a una aclaración: suma las dos, sin perder lo demás', async () => {
  const sid = 'audit-e2-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000107');
  encolarTurno({ items: [
    { nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
      mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
      mod('Guarniciones', 'Bistec en salsa', 'Queso panela en salsa')] },
    { nombre: 'Chilaquiles Mixtos', cantidad: 1, modificadores: [
      mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
      mod('Guarniciones', 'Bistec en salsa')] },
  ] });
  await procesarMensaje(sid, 'ambos', null, 'whatsapp', A.neg, '5210000000107');
  const nombres = (getSession(sid).carrito?.items || []).map((i) => i.nombre);
  assert.equal(nombres.length, 3, `dos chilaquiles y los hotcakes — ${nombres.join(' | ')}`);
  assert.ok(nombres.some((n) => /Hotcakes/i.test(n)),
    `"ambos" habla de la aclaración, no del pedido entero — ${nombres.join(' | ')}`);
});

await t('E3. una errata en el turno siguiente no abre un renglón nuevo', async () => {
  const sid = 'audit-e3-' + randomUUID();
  deleteSession(sid);
  encolarTurno({ items: [{ nombre: 'Gyozas', cantidad: 1, modificadores: [mod('Relleno', 'Cerdo')] }] });
  await procesarMensaje(sid, 'unas gyosas de cerdo porfa', null, 'whatsapp', B.neg, '5210000000108');
  encolarTurno({ items: [{ nombre: 'Gyozas', cantidad: 2, modificadores: [mod('Relleno', 'Cerdo')] }] });
  await procesarMensaje(sid, 'mejor dos gyosas', null, 'whatsapp', B.neg, '5210000000108');
  const items = getSession(sid).carrito?.items || [];
  assert.equal(items.length, 1, `el modelo normalizó el nombre; es el mismo renglón — ${JSON.stringify(items)}`);
  assert.equal(items[0].cantidad, 2, JSON.stringify(items));
});

await t('E4. el modelo responde en PROSA: no se pierde el pedido ni se secuestra el turno', async () => {
  const sid = 'audit-e4-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000109');
  // Sin bloque <PEDIDO_BORRADOR>: el cliente pregunta otra cosa.
  mock.drenar();
  mock.encolarRespuesta('Cerramos a las 11 de la noche.');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r = await procesarMensaje(sid, 'oigan a que hora cierran?', null, 'whatsapp', A.neg, '5210000000109');
  assert.equal(getSession(sid).carrito?.items?.length, 2,
    `una respuesta en prosa no borra el pedido — ${JSON.stringify(getSession(sid).carrito)}`);
  assert.match(r.texto || '', /11|noche/i,
    `el backend no debe secuestrar un turno que no es del pedido — ${r.texto}`);
});

await t('E5. el modelo emite items vacíos: tampoco borra', async () => {
  const sid = 'audit-e5-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000110');
  encolarTurno({ items: [] });
  await procesarMensaje(sid, 'si', null, 'whatsapp', A.neg, '5210000000110');
  assert.equal(getSession(sid).carrito?.items?.length, 2,
    `un borrador vacío no es una orden de vaciar — ${JSON.stringify(getSession(sid).carrito)}`);
});

await t('E6. mensajes agrupados en un solo turno entran completos', async () => {
  const sid = 'audit-e6-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid,
    'Si quiero unos chilaquiles suizos con pollo, bistec en salsa y queso panela\nAdemás una orden de hotcakes de sartén',
    null, 'whatsapp', A.neg, '5210000000111');
  assert.equal(getSession(sid).carrito?.items?.length, 2, JSON.stringify(getSession(sid).carrito));
});

await t('E7. reentrega del MISMO turno: reconciliar no duplica', async () => {
  const sid = 'audit-e7-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000112');
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000112');
  assert.equal(getSession(sid).carrito?.items?.length, 2,
    `el mismo turno dos veces no son cuatro platillos — ${JSON.stringify(getSession(sid).carrito)}`);
});

await t('E8. dos instancias alternándose sobre la misma conversación', async () => {
  const sid = 'audit-e8-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000113');
  // Cada turno lo atiende un proceso distinto: el que llega hidrata de la fila
  // antes de pensar, que es lo que hace `procesarMensaje` en producción.
  const sencillos = { items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
    mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
    mod('Guarniciones', 'Bistec en salsa', 'Queso panela en salsa')] }] };
  desalojarDeMemoria(sid);
  encolarTurno(sencillos);
  await procesarMensaje(sid, 'Los sencillos', null, 'whatsapp', A.neg, '5210000000113');
  desalojarDeMemoria(sid);
  encolarTurno({ ...sencillos, modalidad: 'recoger' });
  const r = await procesarMensaje(sid, 'para recoger', null, 'whatsapp', A.neg, '5210000000113');
  assert.match(JSON.stringify(r) + JSON.stringify(getSession(sid).carrito), /Hotcakes/i,
    `turnarse de instancia no puede perder un platillo — ${r.texto}`);
});

await t('E9. el carrito del pedido cerrado no se filtra al siguiente', async () => {
  const sid = 'audit-e9-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000114');
  assert.ok(getSession(sid).carrito?.items?.length, 'debía haber carrito');
  iniciarCicloPedido(sid);                       // es lo que hace registrar
  assert.equal(getSession(sid).carrito, null,
    'cerrar el ciclo tiene que vaciar el carrito o el siguiente cliente paga de más');
});


await t('E10. sustituir la preparación del MISMO renglón no lo deja sin nada', async () => {
  const sid = 'audit-e10-' + randomUUID();
  deleteSession(sid);
  encolarTurno({ items: [{ nombre: 'Gyozas', cantidad: 1, modificadores: [mod('Relleno', 'Cerdo')] }] });
  await procesarMensaje(sid, 'unas gyozas de cerdo', null, 'whatsapp', B.neg, '5210000000115');
  // El mensaje nombra las gyozas dos veces: para quitarlas y para volver a
  // pedirlas de otra forma. Quitar el renglón dejaría al cliente sin nada.
  encolarTurno({ items: [{ nombre: 'Gyozas', cantidad: 1, modificadores: [mod('Relleno', 'Verdura')] }] });
  await procesarMensaje(sid, 'quita las gyozas de cerdo y ponme unas gyozas de verdura',
    null, 'whatsapp', B.neg, '5210000000115');
  const items = getSession(sid).carrito?.items || [];
  assert.equal(items.length, 1, `debe quedar el renglón sustituido — ${JSON.stringify(items)}`);
  assert.match(JSON.stringify(items[0].modificadores), /Verdura/i, JSON.stringify(items));
});

await t('E11. y si el modelo repite el pedido entero, quitar sigue funcionando', async () => {
  const sid = 'audit-e11-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000116');
  // El modelo reescribe el pedido COMPLETO, hotcakes incluidos, ignorando lo
  // que el cliente acaba de pedir. La voluntad del cliente manda.
  encolarTurno({ items: [
    { nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
      mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
      mod('Guarniciones', 'Bistec en salsa', 'Queso panela en salsa')] },
    { nombre: 'Hotcakes de Sarten', cantidad: 1, modificadores: [] },
  ] });
  await procesarMensaje(sid, 'quita los hotcakes', null, 'whatsapp', A.neg, '5210000000116');
  const nombres = (getSession(sid).carrito?.items || []).map((i) => i.nombre).join(' | ');
  assert.doesNotMatch(nombres, /Hotcakes/i, `el cliente pidió quitarlos — ${nombres}`);
});


// ═══ F — el modelo PROPONE cambios; no los autoriza ════════════════════════
//
// Segunda auditoría de Codex (12-sep) sobre esta misma rama. El carrito
// protegía el artículo y nada de lo que lleva dentro, así que una respuesta
// operativa seguía pudiendo vaciarle la salsa, cambiarle la cantidad o meterle
// productos que nadie pidió.
//
// Las tres reproducciones entran TAL CUAL —F1, F3, F5— y después los recorridos
// completos, donde se comprueban las tres cosas que ve el negocio: el carrito,
// el resumen que lee el cliente y la orden que se confirmaría.

const soloChilaquilesA = () => ({ items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
  mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
  mod('Guarniciones', 'Bistec en salsa', 'Queso panela en salsa')] }] });

// Lo que ve el cliente Y lo que se confirmaría, no solo el nombre de un plato.
const cuentaDe = (sid) => JSON.stringify(verPreviewConfirmable(sid)?.ordenCanonica || null);
const nombresDelCarrito = (sid) => (getSession(sid).carrito?.items || []).map((i) => i.nombre);
const itemDelCarrito = (sid, re) => (getSession(sid).carrito?.items || []).find((i) => re.test(i.nombre));

await t('F1. REPRO Codex 1: una respuesta operativa no cambia cantidad, salsa ni notas', async () => {
  const sid = 'audit-f1-' + randomUUID();
  deleteSession(sid);
  encolarTurno({ items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 2, modificadores: [
    mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo')], notas: 'sin cebolla' }] });
  await procesarMensaje(sid, 'quiero dos chilaquiles sencillos con salsa suiza y pechuga de pollo, sin cebolla',
    null, 'whatsapp', A.neg, '5210000000201');
  // El modelo vuelve con el MISMO plato desnudo: cantidad 1, sin modificadores
  // y sin la nota. El cliente solo dijo cómo lo recoge.
  encolarTurno({ items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1 }], modalidad: 'recoger' });
  await procesarMensaje(sid, 'Para recoger', null, 'whatsapp', A.neg, '5210000000201');
  const it = itemDelCarrito(sid, /Chilaquiles/i);
  assert.equal(it?.cantidad, 2, `la cantidad no se toca — ${JSON.stringify(it)}`);
  assert.match(JSON.stringify(it?.modificadores), /Suiza/i, `la salsa no se borra — ${JSON.stringify(it)}`);
  assert.match(JSON.stringify(it?.modificadores), /Pechuga/i, `la proteína tampoco — ${JSON.stringify(it)}`);
  assert.match(it?.notas || '', /sin cebolla/i, `la nota tampoco — ${JSON.stringify(it)}`);
});

await t('F2. el modelo cambia la cantidad mientras el cliente da su DIRECCIÓN', async () => {
  const sid = 'audit-f2-' + randomUUID();
  deleteSession(sid);
  encolarTurno({ items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 2, modificadores: [
    mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
    mod('Guarniciones', 'Bistec en salsa')] }] });
  await procesarMensaje(sid, 'dos chilaquiles sencillos suizos con pechuga de pollo y bistec en salsa',
    null, 'whatsapp', A.neg, '5210000000202');
  encolarTurno({ ...soloChilaquilesA(), modalidad: 'entrega a domicilio' });
  await procesarMensaje(sid, 'a domicilio porfa', null, 'whatsapp', A.neg, '5210000000202');
  // El número de la calle no es una cantidad, y el 1 que propone el modelo no
  // lo dijo nadie.
  encolarTurno({ items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
    mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
    mod('Guarniciones', 'Bistec en salsa')] }], cliente: { direccion: 'Nogal 900 col Acoros' } });
  await procesarMensaje(sid, 'Nogal 900 acoros ai', null, 'whatsapp', A.neg, '5210000000202');
  assert.equal(itemDelCarrito(sid, /Chilaquiles/i)?.cantidad, 2,
    `dar la dirección no cambia cuánta comida hay — ${JSON.stringify(getSession(sid).carrito)}`);
});

await t('F3. REPRO Codex 2: quitar uno de dos nombres parecidos quita SOLO ese', async () => {
  const sid = 'audit-f3-' + randomUUID();
  deleteSession(sid);
  encolarTurno({ items: [
    { nombre: 'Hotcakes Tradicionales', cantidad: 1, modificadores: [mod('Topping', 'Tradicional')] },
    { nombre: 'Hotcakes de Sarten', cantidad: 1, modificadores: [] },
  ] });
  await procesarMensaje(sid, 'quiero unos hotcakes tradicionales con topping tradicional y unos hotcakes de sarten',
    null, 'whatsapp', A.neg, '5210000000203');
  assert.equal(nombresDelCarrito(sid).length, 2, JSON.stringify(nombresDelCarrito(sid)));
  // Propuesta VACÍA, como en la reproducción: el carrito decide solo.
  encolarTurno({ items: [] });
  await procesarMensaje(sid, 'Quita los hotcakes tradicionales', null, 'whatsapp', A.neg, '5210000000203');
  const quedan = nombresDelCarrito(sid);
  assert.equal(quedan.length, 1, `solo se iba uno — ${JSON.stringify(quedan)}`);
  assert.match(quedan[0], /Sarten/i, `se fue el que no era — ${JSON.stringify(quedan)}`);
});

await t('F4. quitar de forma AMBIGUA no borra nada y pregunta cuál', async () => {
  const sid = 'audit-f4-' + randomUUID();
  deleteSession(sid);
  encolarTurno({ items: [
    { nombre: 'Hotcakes Tradicionales', cantidad: 1, modificadores: [mod('Topping', 'Tradicional')] },
    { nombre: 'Hotcakes de Sarten', cantidad: 1, modificadores: [] },
  ] });
  await procesarMensaje(sid, 'unos hotcakes tradicionales con topping tradicional y unos hotcakes de sarten',
    null, 'whatsapp', A.neg, '5210000000204');
  encolarTurno({ items: [] });
  const r = await procesarMensaje(sid, 'quita los hotcakes', null, 'whatsapp', A.neg, '5210000000204');
  assert.equal(nombresDelCarrito(sid).length, 2,
    `dos caben igual de bien: no se borra ninguno — ${JSON.stringify(nombresDelCarrito(sid))}`);
  assert.match(r.texto || '', /cu[aá]l quito/i, `y hay que preguntarlo — ${r.texto}`);
});

await t('F5. REPRO Codex 3: el modelo inventa tres Coca-Colas y no entran', async () => {
  const sid = 'audit-f5-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000205');
  encolarTurno({ items: [...soloChilaquilesA().items, { nombre: 'Coca Cola', cantidad: 3 }],
    modalidad: 'recoger' });
  const r = await procesarMensaje(sid, 'Para recoger', null, 'whatsapp', A.neg, '5210000000205');
  const nombres = nombresDelCarrito(sid).join(' | ');
  assert.doesNotMatch(nombres, /Coca/i, `nadie pidió refrescos — ${nombres}`);
  assert.doesNotMatch(r.texto || '', /Coca/i, `y tampoco pueden aparecer en la cuenta — ${r.texto}`);
  assert.doesNotMatch(cuentaDe(sid), /Coca/i, `ni en la orden que se confirmaría — ${cuentaDe(sid)}`);
  assert.match(nombres, /Hotcakes/i, `y lo que sí pidió sigue — ${nombres}`);
});

await t('F6. invención al responder la FORMA DE PAGO, en el negocio B', async () => {
  const sid = 'audit-f6-' + randomUUID();
  deleteSession(sid);
  encolarTurno({ items: [{ nombre: 'Ramen Grande', cantidad: 1, modificadores: [
    mod('Caldo', 'Tonkotsu'), mod('Proteína', 'Cerdo chashu')] }] });
  await procesarMensaje(sid, 'un ramen grande tonkotsu con cerdo chashu', null, 'whatsapp', B.neg, '5210000000206');
  encolarTurno({ items: [
    { nombre: 'Ramen Grande', cantidad: 1, modificadores: [mod('Caldo', 'Tonkotsu'), mod('Proteína', 'Cerdo chashu')] },
    { nombre: 'Gyozas', cantidad: 2, modificadores: [mod('Relleno', 'Cerdo')] },
  ], forma_pago: 'efectivo' });
  await procesarMensaje(sid, 'en efectivo', null, 'whatsapp', B.neg, '5210000000206');
  const nombres = nombresDelCarrito(sid).join(' | ');
  assert.doesNotMatch(nombres, /Gyozas/i, `la regla no puede depender de la carta de Obispado — ${nombres}`);
});

await t('F7. agregar otro producto SÍ funciona cuando el cliente lo pide', async () => {
  const sid = 'audit-f7-' + randomUUID();
  deleteSession(sid);
  encolarTurno({ items: [{ nombre: 'Ramen Chico', cantidad: 1, modificadores: [
    mod('Caldo', 'Miso'), mod('Proteína', 'Pollo karaage')] }] });
  await procesarMensaje(sid, 'un ramen chico de miso con pollo karaage', null, 'whatsapp', B.neg, '5210000000207');
  encolarTurno({ items: [
    { nombre: 'Ramen Chico', cantidad: 1, modificadores: [mod('Caldo', 'Miso'), mod('Proteína', 'Pollo karaage')] },
    { nombre: 'Gyozas', cantidad: 1, modificadores: [mod('Relleno', 'Verdura')] },
  ] });
  await procesarMensaje(sid, 'agregame unas gyozas de verdura', null, 'whatsapp', B.neg, '5210000000207');
  const nombres = nombresDelCarrito(sid).join(' | ');
  assert.match(nombres, /Gyozas/i, `pedirlo es evidencia de sobra — ${nombres}`);
  assert.match(nombres, /Ramen Chico/i, nombres);
});

await t('F8. sustitución legítima: sale lo sustituido y NADA más', async () => {
  const sid = 'audit-f8-' + randomUUID();
  deleteSession(sid);
  encolarTurno({ items: [
    { nombre: 'Ramen Grande', cantidad: 1, modificadores: [mod('Caldo', 'Tonkotsu'), mod('Proteína', 'Cerdo chashu')] },
    { nombre: 'Gyozas', cantidad: 1, modificadores: [mod('Relleno', 'Cerdo')] },
  ] });
  await procesarMensaje(sid, 'un ramen grande tonkotsu con cerdo chashu y unas gyozas de cerdo',
    null, 'whatsapp', B.neg, '5210000000208');
  encolarTurno({ items: [
    { nombre: 'Ramen Grande', cantidad: 1, modificadores: [mod('Caldo', 'Tonkotsu'), mod('Proteína', 'Cerdo chashu')] },
    { nombre: 'Ramen Chico', cantidad: 1, modificadores: [mod('Caldo', 'Miso'), mod('Proteína', 'Pollo karaage')] },
  ] });
  await procesarMensaje(sid, 'quita las gyozas y mejor ponme un ramen chico de miso con pollo karaage',
    null, 'whatsapp', B.neg, '5210000000208');
  const nombres = nombresDelCarrito(sid).join(' | ');
  assert.doesNotMatch(nombres, /Gyozas/i, `lo sustituido se va — ${nombres}`);
  assert.match(nombres, /Ramen Chico/i, `lo nuevo entra — ${nombres}`);
  assert.match(nombres, /Ramen Grande/i, `y lo que nadie tocó se queda — ${nombres}`);
});

await t('F9. cambiar UN ingrediente conserva los demás', async () => {
  const sid = 'audit-f9-' + randomUUID();
  deleteSession(sid);
  encolarTurno({ items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
    mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
    mod('Guarniciones', 'Frijolitos naturales')] }] });
  await procesarMensaje(sid, 'chilaquiles sencillos suizos con pechuga de pollo y frijolitos naturales',
    null, 'whatsapp', A.neg, '5210000000209');
  encolarTurno({ items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
    mod('Salsa', 'Roja'), mod('Proteína', 'Pechuga de pollo'),
    mod('Guarniciones', 'Frijolitos naturales')] }] });
  await procesarMensaje(sid, 'mejor la salsa roja', null, 'whatsapp', A.neg, '5210000000209');
  const mods = JSON.stringify(itemDelCarrito(sid, /Chilaquiles/i)?.modificadores);
  assert.match(mods, /Roja/i, `el ingrediente que cambió, cambia — ${mods}`);
  assert.doesNotMatch(mods, /Suiza/i, `y el viejo se va — ${mods}`);
  assert.match(mods, /Pechuga/i, `los demás no se tocan — ${mods}`);
  assert.match(mods, /Frijolitos/i, mods);
});

await t('F10. el modelo omite un modificador y una nota: se conservan los dos', async () => {
  const sid = 'audit-f10-' + randomUUID();
  deleteSession(sid);
  encolarTurno({ items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
    mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo'),
    mod('Guarniciones', 'Papas a la mexicana')], notas: 'bien remojados' }] });
  await procesarMensaje(sid, 'chilaquiles sencillos suizos con pechuga de pollo y papas a la mexicana, bien remojados',
    null, 'whatsapp', A.neg, '5210000000210');
  // Solo la salsa sobrevive en la propuesta; la guarnición y la nota desaparecen.
  encolarTurno({ items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
    mod('Salsa', 'Suiza'), mod('Proteína', 'Pechuga de pollo')] }], modalidad: 'recoger' });
  await procesarMensaje(sid, 'para recoger', null, 'whatsapp', A.neg, '5210000000210');
  const it = itemDelCarrito(sid, /Chilaquiles/i);
  assert.match(JSON.stringify(it?.modificadores), /Papas/i, `la guarnición elegida sigue — ${JSON.stringify(it)}`);
  assert.match(it?.notas || '', /remojados/i, `y la nota también — ${JSON.stringify(it)}`);
});

await t('F11. dos unidades del mismo producto con preparaciones distintas, de punta a punta', async () => {
  const sid = 'audit-f11-' + randomUUID();
  deleteSession(sid);
  const dos = { items: [
    { nombre: 'Ramen Chico', cantidad: 1, modificadores: [mod('Caldo', 'Miso'), mod('Proteína', 'Pollo karaage')] },
    { nombre: 'Ramen Chico', cantidad: 1, modificadores: [mod('Caldo', 'Shoyu'), mod('Proteína', 'Cerdo chashu')] },
  ] };
  encolarTurno(dos);
  await procesarMensaje(sid, 'un ramen chico de miso con pollo karaage y otro de shoyu con cerdo chashu',
    null, 'whatsapp', B.neg, '5210000000211');
  assert.equal(getSession(sid).carrito?.items?.length, 2,
    `son dos renglones, no una cantidad 2 — ${JSON.stringify(getSession(sid).carrito)}`);
  // Y un turno operativo no los fusiona ni los desnuda.
  encolarTurno({ ...dos, modalidad: 'recoger' });
  await procesarMensaje(sid, 'para recoger', null, 'whatsapp', B.neg, '5210000000211');
  const carrito = JSON.stringify(getSession(sid).carrito);
  assert.equal(getSession(sid).carrito.items.length, 2, carrito);
  assert.match(carrito, /karaage/i, carrito);
  assert.match(carrito, /chashu/i, carrito);
});

await t('F12. reinicio ENTRE la aclaración y la respuesta', async () => {
  const sid = 'audit-f12-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000212');
  desalojarDeMemoria(sid);                      // el proceso se cae con la pregunta en el aire
  encolarTurno(soloChilaquilesA());
  await procesarMensaje(sid, 'Los sencillos', null, 'whatsapp', A.neg, '5210000000212');
  const it = itemDelCarrito(sid, /Chilaquiles/i);
  assert.match(JSON.stringify(it?.modificadores), /Suiza/i,
    `la salsa elegida antes del reinicio sigue — ${JSON.stringify(getSession(sid).carrito)}`);
  assert.equal(getSession(sid).carrito?.items?.length, 2,
    `y el segundo platillo también — ${JSON.stringify(nombresDelCarrito(sid))}`);
});

await t('F13. confirmación final: sin pérdidas, sin agregados y sin duplicar', async () => {
  const sid = 'audit-f13-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000213');
  encolarTurno(soloChilaquilesA());
  await procesarMensaje(sid, 'Los sencillos', null, 'whatsapp', A.neg, '5210000000213');
  // El modelo aprovecha el turno operativo para olvidar un plato Y meter otro.
  encolarTurno({ items: [...soloChilaquilesA().items, { nombre: 'Coca Cola', cantidad: 2 }],
    modalidad: 'recoger', forma_pago: 'efectivo', cliente: { nombre: 'Ana' } });
  const resumen = await procesarMensaje(sid, 'Para recoger, efectivo, a nombre de Ana',
    null, 'whatsapp', A.neg, '5210000000213');
  assert.match(resumen.texto || '', /Hotcakes/i, `la cuenta la ve el cliente completa — ${resumen.texto}`);
  assert.doesNotMatch(resumen.texto || '', /Coca/i, `y sin lo que nadie pidió — ${resumen.texto}`);

  const snap = verPreviewConfirmable(sid);
  assert.ok(snap, 'debía quedar un preview confirmable');
  const orden = JSON.stringify(snap.ordenCanonica);
  assert.match(orden, /Hotcakes/i, `la orden final tampoco pierde nada — ${orden}`);
  assert.doesNotMatch(orden, /Coca/i, `ni gana nada — ${orden}`);

  // Confirmar dos veces no son dos pedidos. El turno puede resolverse sin
  // modelo (confirmación determinista desde el snapshot) o con él, así que se
  // le deja respuesta preparada por si la pide.
  const encolarTexto = (t) => { mock.drenar(); mock.encolarRespuesta(t); mock.encolarRespuesta('{"menciones":[]}'); };
  encolarTexto('Listo, tu pedido queda registrado.');
  const primera = await procesarMensaje(sid, 'si, confirmo', null, 'whatsapp', A.neg, '5210000000213');
  assert.ok(primera.orden, `la primera confirmación registra — ${primera.texto}`);
  encolarTexto('Tu pedido ya estaba registrado.');
  const segunda = await procesarMensaje(sid, 'si, confirmo', null, 'whatsapp', A.neg, '5210000000213');
  assert.ok(!segunda.orden, `la segunda NO puede registrar otra vez — ${JSON.stringify(segunda).slice(0, 200)}`);
});

await t('F14. recorrido completo en el negocio B: carrito, resumen y orden', async () => {
  const sid = 'audit-f14-' + randomUUID();
  deleteSession(sid);
  encolarTurno({ items: [
    { nombre: 'Ramen Grande', cantidad: 2, modificadores: [mod('Caldo', 'Tonkotsu'),
      mod('Proteína', 'Cerdo chashu'), mod('Extras', 'Huevo marinado')], notas: 'poco picante' },
    { nombre: 'Gyozas', cantidad: 1, modificadores: [mod('Relleno', 'Verdura')] },
  ] });
  await procesarMensaje(sid, 'dos ramen grande tonkotsu con cerdo chashu y huevo marinado, poco picante, y unas gyozas de verdura',
    null, 'whatsapp', B.neg, '5210000000214');
  // Turno operativo con el modelo en su peor día: olvida las gyozas, desnuda el
  // ramen, le baja la cantidad y añade algo que nadie pidió.
  encolarTurno({ items: [{ nombre: 'Ramen Grande', cantidad: 1 }, { nombre: 'Gyozas', cantidad: 5, modificadores: [mod('Relleno', 'Cerdo')] }],
    modalidad: 'recoger', forma_pago: 'efectivo', cliente: { nombre: 'Luis' } });
  const r = await procesarMensaje(sid, 'para recoger, efectivo, a nombre de Luis', null, 'whatsapp', B.neg, '5210000000214');
  const ramen = itemDelCarrito(sid, /Ramen Grande/i);
  assert.equal(ramen?.cantidad, 2, `la cantidad aguanta — ${JSON.stringify(ramen)}`);
  assert.match(JSON.stringify(ramen?.modificadores), /Huevo marinado/i, JSON.stringify(ramen));
  assert.match(ramen?.notas || '', /picante/i, JSON.stringify(ramen));
  const gyozas = itemDelCarrito(sid, /Gyozas/i);
  assert.equal(gyozas?.cantidad, 1, `nadie dijo cinco — ${JSON.stringify(gyozas)}`);
  assert.match(JSON.stringify(gyozas?.modificadores), /Verdura/i, `ni cambió el relleno — ${JSON.stringify(gyozas)}`);
  assert.match(r.texto || '', /Gyozas/i, `el cliente ve su pedido completo — ${r.texto}`);
});


await t('F15. la EXTRACCIÓN FORZADA también pasa por el carrito', async () => {
  const sid = 'audit-f15-' + randomUUID();
  deleteSession(sid);
  encolarTurno(DOBLE);
  await procesarMensaje(sid, TEXTO_ORIGINAL, null, 'whatsapp', A.neg, '5210000000215');
  encolarTurno(soloChilaquilesA());
  await procesarMensaje(sid, 'Los sencillos', null, 'whatsapp', A.neg, '5210000000215');
  encolarTurno({ ...soloChilaquilesA(), modalidad: 'recoger', forma_pago: 'efectivo', cliente: { nombre: 'Ana' } });
  const conCuenta = await procesarMensaje(sid, 'Para recoger, efectivo, a nombre de Ana', null, 'whatsapp', A.neg, '5210000000215');
  assert.match(conCuenta.texto || '', /Hotcakes/i, `la cuenta debía salir completa — ${conCuenta.texto}`);

  // Ahora el modelo contesta en PROSA —sin marcador— y el cliente nombra un
  // producto, así que entra la extracción forzada. Es OTRA fuente de borrador,
  // y durante un rato fue la ruta que rodeaba el carrito: lo que sale de ahí
  // iba directo a validarse y a cotizarse.
  mock.drenar();
  mock.encolarRespuesta('Claro que sí, bien remojados.');
  mock.encolarRespuesta(JSON.stringify({ items: [{ nombre: 'Chilaquiles Sencillos', cantidad: 1,
    modificadores: [{ grupo: 'Salsa', opciones: ['Suiza'] }], notas: 'bien remojados' }] }));
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  const r = await procesarMensaje(sid, 'los chilaquiles que sean bien remojados', null, 'whatsapp', A.neg, '5210000000215');
  assert.equal(getSession(sid).carrito?.items?.length, 2,
    `el carrito no puede perder el segundo platillo — ${JSON.stringify(nombresDelCarrito(sid))}`);
  assert.match(JSON.stringify(r) + cuentaDe(sid), /Hotcakes/i,
    `ni la cuenta que se recalcula por esa ruta — ${r.texto} | ${cuentaDe(sid)}`);
});

} finally {
  mock.detener();
  for (const neg of [A.neg, B.neg]) {
    for (const tabla of ['conversacion_estado', 'menu_modificadores_opciones', 'menu_modificadores_grupos',
      'menu_productos', 'menu_categorias']) {
      await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [neg]).catch(() => {});
    }
    await pool.query('DELETE FROM negocios WHERE id=$1', [neg]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(`\n${fail === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${ok} pasadas, ${fail} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
process.exit(fail ? 1 : 0);
