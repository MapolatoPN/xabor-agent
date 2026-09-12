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
const { getSession, desalojarDeMemoria, verPreviewConfirmable, deleteSession } = await import('../src/agent/session.js');

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
