// PREGUNTAR NO ES PEDIR, Y SEÑALAR NO ES ADIVINAR.
//
// Fases F y G del Mesero Digital. Módulos puros.
//
// Lo que defiende:
//
//   · «¿qué bebidas tienes?» no puede agregar una bebida, aunque la nombre;
//   · «¿me das dos cocas?» sí pide, aunque lleve signo de interrogación;
//   · un mensaje puede ser cuatro actos a la vez y ninguno se traga a los otros;
//   · las cláusulas de consulta NO llegan al reconciliador como evidencia;
//   · «el primero» sigue siendo el primero después de borrar el segundo;
//   · con dos candidatos no se elige el más probable: se pregunta.
//
// Ni un nombre de producto de ningún negocio aparece en el código que se prueba.
import assert from 'node:assert/strict';

const {
  clasificarIntenciones, textoQueAutoriza, puedeTocarElPedido, tiene,
  partirEnClausulas, SON_CONSULTA,
} = await import('../src/mesero/intencionesDelCliente.js');

const {
  resolverReferencia, hayReferencia, renglonesEnOrden, aclaracionDeReferencia,
} = await import('../src/mesero/referenciasDelCliente.js');

const { contextoNuevo, anotarTurno, sincronizarLineas, tocarLinea } =
  await import('../src/mesero/contextoMesa.js');

let ok = 0, fail = 0; const fallos = [];
function t(nombre, fn) {
  try { fn(); ok++; console.log(`  OK  ${nombre}`); }
  catch (e) { fail++; fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}

const clas = (txt, fase) => clasificarIntenciones(txt, { fase });
const tieneAlguna = (c, ...is) => is.some((i) => tiene(c, i));

// ── FASE F — intenciones ────────────────────────────────────────────────────

t('F1. «¿Qué bebidas tienes?» consulta y NO agrega', () => {
  const c = clas('¿Qué bebidas tienes?');
  assert(tieneAlguna(c, 'CONSULTA_MENU', 'CONSULTA_PRODUCTO'), JSON.stringify(c.intenciones));
  assert.equal(tiene(c, 'AGREGAR_PRODUCTO'), false, 'una pregunta agregó producto');
  assert.equal(c.soloConsulta, true);
  assert.equal(puedeTocarElPedido(c), false);
});

t('F2. «Ponme una coca» sí pide', () => {
  const c = clas('Ponme una coca');
  assert(tiene(c, 'AGREGAR_PRODUCTO'));
  assert.equal(c.soloConsulta, false);
  assert.equal(puedeTocarElPedido(c), true);
});

t('F3. «¿me das dos cocas?» es una orden con signo de interrogación', () => {
  const c = clas('¿me das dos cocas?');
  assert(tiene(c, 'AGREGAR_PRODUCTO'), `la cortesía se leyó como consulta: ${c.intenciones}`);
  assert.equal(c.soloConsulta, false);
});

t('F4. un mensaje con cuatro actos devuelve los cuatro', () => {
  const c = clas('Dame dos chilaquiles verdes con pollo, uno sin cebolla, para recoger y pago en efectivo');
  for (const i of ['AGREGAR_PRODUCTO', 'CAMBIAR_MODIFICADOR', 'DEFINIR_MODALIDAD', 'DEFINIR_PAGO']) {
    assert(tiene(c, i), `falta ${i} en ${JSON.stringify(c.intenciones)}`);
  }
});

t('F5. precio, ingredientes y promociones son consultas distintas', () => {
  assert(tiene(clas('¿cuánto cuesta?'), 'CONSULTA_PRECIO'));
  assert(tiene(clas('¿qué trae?'), 'CONSULTA_INGREDIENTES'));
  assert(tiene(clas('¿qué promociones tienen?'), 'CONSULTA_PROMOCION'));
  assert(tiene(clas('¿qué incluye?'), 'CONSULTA_INGREDIENTES'));
  for (const txt of ['¿cuánto cuesta?', '¿qué trae?', '¿qué promociones tienen?']) {
    assert.equal(clas(txt).soloConsulta, true, `${txt} tocó el pedido`);
  }
});

t('F6. pedir recomendación es consulta, no orden', () => {
  for (const txt of ['¿qué me recomiendas?', 'qué me recomiendas', 'algo llenador', 'recomiéndame algo']) {
    const c = clas(txt);
    assert(tiene(c, 'PEDIR_RECOMENDACION'), `${txt} -> ${c.intenciones}`);
    assert.equal(tiene(c, 'AGREGAR_PRODUCTO'), false, `${txt} agregó producto`);
  }
});

t('F7. «Me pasas el menú?» pide el menú, no comida', () => {
  const c = clas('Me pasas el menú?');
  assert(tiene(c, 'CONSULTA_MENU'), JSON.stringify(c.intenciones));
  assert.equal(tiene(c, 'AGREGAR_PRODUCTO'), false);
});

t('F8. saludo, despedida y petición de humano se reconocen', () => {
  assert(tiene(clas('Hola'), 'SALUDO'));
  assert(tiene(clas('buenas noches'), 'SALUDO'));
  assert(tiene(clas('gracias, hasta luego'), 'DESPEDIR'));
  assert(tiene(clas('quiero hablar con una persona'), 'PEDIR_HUMANO'));
});

t('F9. «Quiero ordenar» inicia, no agrega un producto fantasma', () => {
  const c = clas('Quiero ordenar');
  assert(tiene(c, 'INICIAR_ORDEN'), JSON.stringify(c.intenciones));
  assert.equal(tiene(c, 'AGREGAR_PRODUCTO'), false, 'ordenar se leyó como un producto');
});

t('F10. quitar, cantidad y modificador se distinguen entre sí', () => {
  assert(tiene(clas('quita los hotcakes'), 'QUITAR'));
  assert(tiene(clas('mejor dos'), 'CAMBIAR_CANTIDAD'));
  assert(tiene(clas('hazlos tres'), 'CAMBIAR_CANTIDAD'));
  assert(tiene(clas('mejor sin cebolla'), 'CAMBIAR_MODIFICADOR'));
  assert.equal(tiene(clas('quita los hotcakes'), 'AGREGAR_PRODUCTO'), false,
    'quitar se leyó también como agregar');
});

t('F11. confirmar y cancelar no se confunden', () => {
  assert(tiene(clas('sí, así está bien'), 'CONFIRMAR'));
  assert(tiene(clas('cancela el pedido'), 'CANCELAR'));
  assert.equal(tiene(clas('cancela el pedido'), 'CONFIRMAR'), false);
});

// ── LA GARANTÍA: la consulta no llega al reconciliador ──────────────────────

t('F12. una consulta que NOMBRA un producto no autoriza nada', () => {
  // Este es el caso que hoy se cuela: el cliente pregunta si hay algo, el
  // modelo lo mete al borrador, y el reconciliador ve la palabra en lo que
  // dijo el cliente y la aprueba. Con razón: nadie le dijo que era pregunta.
  assert.equal(textoQueAutoriza('¿tienes coca?'), '');
  assert.equal(textoQueAutoriza('¿qué bebidas tienes?'), '');
  assert.equal(textoQueAutoriza('¿cuánto cuesta la hamburguesa?'), '');
});

t('F13. lo que sí pide sobrevive, y con las letras del cliente', () => {
  assert.equal(textoQueAutoriza('¿tienes coca? ponme una'), 'ponme una');
  assert.equal(textoQueAutoriza('Ponme una coca'), 'Ponme una coca');
  // Los acentos del cliente no se tocan: esto viaja al reconciliador.
  assert.equal(textoQueAutoriza('ponme un café'), 'ponme un café');
});

t('F14. un turno mixto conserva la parte que pide y tira la que pregunta', () => {
  const txt = '¿qué bebidas tienes? dame dos cocas para recoger';
  const autoriza = textoQueAutoriza(txt);
  assert(/dame dos cocas/.test(autoriza), autoriza);
  assert(!/qué bebidas/.test(autoriza), `la pregunta se coló: ${autoriza}`);
});

t('F15. las cláusulas se parten por puntuación y por «y», no por «con»', () => {
  const cl = partirEnClausulas('dame dos chilaquiles con pollo, uno sin cebolla y para recoger');
  assert(cl.some((c) => /con pollo/.test(c)), `«con» partió la cláusula: ${JSON.stringify(cl)}`);
  assert(cl.length >= 3, JSON.stringify(cl));
});

t('F16. la taxonomía de consultas es la que dice ser', () => {
  for (const i of SON_CONSULTA) assert(/^(CONSULTA_|PEDIR_RECOMENDACION)/.test(i), i);
});

// ── FASE G — referencias ────────────────────────────────────────────────────

function escena(nombres, { foco = null, turnos = null } = {}) {
  const ctx = contextoNuevo({ negocioId: 'n1', conversacionId: 'c1' });
  anotarTurno(ctx, 'cliente', 'pido cosas');
  const carrito = { items: nombres.map((n, i) => ({ lid: `L${i + 1}`, nombre: n, cantidad: 1 })), datos: {} };
  sincronizarLineas(ctx, carrito);
  if (turnos) ctx.lineas.forEach((l, i) => { l.turnoUltimoCambio = turnos[i]; });
  if (foco) tocarLinea(ctx, foco);
  return { ctx, carrito };
}

t('G1. «el primero» y «el segundo» apuntan al orden en que se pidieron', () => {
  const { ctx, carrito } = escena(['Chilaquiles', 'Hotcakes', 'Café']);
  assert.deepEqual(resolverReferencia('el primero', { contexto: ctx, carrito }).lids, ['L1']);
  assert.deepEqual(resolverReferencia('el segundo', { contexto: ctx, carrito }).lids, ['L2']);
  assert.deepEqual(resolverReferencia('el último', { contexto: ctx, carrito }).lids, ['L3']);
});

t('G2. «el primero» sobrevive a que se borre el segundo', () => {
  const { ctx } = escena(['Chilaquiles', 'Hotcakes', 'Café']);
  const carrito2 = { items: [{ lid: 'L1', nombre: 'Chilaquiles', cantidad: 1 },
    { lid: 'L3', nombre: 'Café', cantidad: 1 }], datos: {} };
  sincronizarLineas(ctx, carrito2);
  assert.deepEqual(resolverReferencia('el primero', { contexto: ctx, carrito: carrito2 }).lids, ['L1']);
  assert.deepEqual(resolverReferencia('el segundo', { contexto: ctx, carrito: carrito2 }).lids, ['L3'],
    'el segundo debe ser el segundo de los que quedan');
});

t('G3. «el tercero» con dos renglones NO se estira al último: pregunta', () => {
  const { ctx, carrito } = escena(['Chilaquiles', 'Hotcakes']);
  const r = resolverReferencia('el tercero', { contexto: ctx, carrito });
  assert.equal(r.resuelta, false);
  assert.equal(r.motivo, 'sin_candidatos');
});

t('G4. «ese» sin foco y con dos renglones no elige', () => {
  const { ctx, carrito } = escena(['Chilaquiles', 'Hotcakes']);
  const r = resolverReferencia('quítale la cebolla a ese', { contexto: ctx, carrito });
  assert.equal(r.resuelta, false, 'eligió sin saber a cuál');
  assert.equal(r.candidatos.length, 2);
  const ac = aclaracionDeReferencia(r);
  assert.equal(ac.tipo, 'referencia_ambigua');
  assert.equal(ac.candidatos.length, 2);
});

t('G5. «ese» con foco resuelve al del foco', () => {
  const { ctx, carrito } = escena(['Chilaquiles', 'Hotcakes'], { foco: 'L2' });
  assert.deepEqual(resolverReferencia('ese sin cebolla', { contexto: ctx, carrito }).lids, ['L2']);
});

t('G6. «hazlos tres» señala por clítico al renglón en foco', () => {
  const { ctx, carrito } = escena(['Chilaquiles', 'Hotcakes'], { foco: 'L1' });
  const r = resolverReferencia('hazlos tres', { contexto: ctx, carrito });
  assert.deepEqual(r.lids, ['L1']);
  assert.equal(r.tipo, 'deictico');
});

t('G7. «el otro» con dos renglones y uno en foco resuelve al que falta', () => {
  const { ctx, carrito } = escena(['Chilaquiles', 'Hotcakes'], { foco: 'L1' });
  assert.deepEqual(resolverReferencia('quita el otro', { contexto: ctx, carrito }).lids, ['L2']);
});

t('G8. «el otro» con TRES renglones no resuelve', () => {
  const { ctx, carrito } = escena(['Chilaquiles', 'Hotcakes', 'Café'], { foco: 'L1' });
  const r = resolverReferencia('quita el otro', { contexto: ctx, carrito });
  assert.equal(r.resuelta, false);
  assert.equal(r.candidatos.length, 2);
});

t('G9. «los dos» resuelve solo si hay exactamente dos', () => {
  const dos = escena(['Chilaquiles', 'Hotcakes']);
  assert.deepEqual(resolverReferencia('los dos sin cebolla', { contexto: dos.ctx, carrito: dos.carrito }).lids,
    ['L1', 'L2']);
  const tres = escena(['A', 'B', 'C']);
  assert.equal(resolverReferencia('los dos sin cebolla', { contexto: tres.ctx, carrito: tres.carrito }).resuelta,
    false, '«los dos» eligió dos de tres');
});

t('G10. «otra igual» duplica el renglón en foco, y lo dice', () => {
  const { ctx, carrito } = escena(['Coca Cola'], { foco: 'L1' });
  const r = resolverReferencia('otra igual', { contexto: ctx, carrito });
  assert.equal(r.resuelta, true);
  assert.equal(r.accion, 'duplicar', 'duplicar y señalar no son lo mismo');
  assert.deepEqual(r.lids, ['L1']);
});

t('G11. «otra igual» sin foco y con dos renglones pregunta', () => {
  const { ctx, carrito } = escena(['Coca Cola', 'Chilaquiles']);
  const r = resolverReferencia('otra igual', { contexto: ctx, carrito });
  assert.equal(r.resuelta, false);
  assert.equal(r.candidatos.length, 2);
});

t('G12. «el de ella» no se adivina: con dos renglones se pregunta', () => {
  const dos = escena(['Chilaquiles', 'Hotcakes']);
  const r = resolverReferencia('el de ella sin fruta', { contexto: dos.ctx, carrito: dos.carrito });
  assert.equal(r.resuelta, false, 'el sistema supuso de quién era un platillo');
  const uno = escena(['Hotcakes']);
  assert.deepEqual(resolverReferencia('el de ella sin fruta', { contexto: uno.ctx, carrito: uno.carrito }).lids,
    ['L1'], 'con un solo renglón no hay nada que confundir');
});

t('G13. «el anterior» es el tocado antes del que está en foco', () => {
  const { ctx, carrito } = escena(['Chilaquiles', 'Hotcakes', 'Café'],
    { foco: 'L3', turnos: [1, 5, 9] });
  const r = resolverReferencia('igual que el anterior', { contexto: ctx, carrito });
  assert.deepEqual(r.lids, ['L2']);
});

t('G14. sin renglones no hay a qué apuntar, y se dice con ese motivo', () => {
  const { ctx, carrito } = escena([]);
  const r = resolverReferencia('quítale la cebolla a ese', { contexto: ctx, carrito });
  assert.equal(r.resuelta, false);
  assert.equal(r.motivo, 'sin_candidatos');
});

t('G15. una frase sin referencia devuelve tipo null, que no es lo mismo que fallar', () => {
  const { ctx, carrito } = escena(['Chilaquiles']);
  const r = resolverReferencia('quiero unos hotcakes', { contexto: ctx, carrito });
  assert.equal(r.tipo, null);
  assert.equal(r.resuelta, false);
  assert.equal(hayReferencia('quiero unos hotcakes'), false);
});

t('G16. nombrar un producto con artículo no cuenta como señalar', () => {
  // «los chilaquiles» lleva «los», pero nombra. Si esto se leyera como
  // referencia, cada vez que el cliente repite el nombre del platillo el
  // sistema creería que está apuntando a otro renglón.
  assert.equal(hayReferencia('los chilaquiles mejor rojos'), false,
    'un artículo se confundió con un pronombre');
  assert.equal(hayReferencia('quítalos'), true);
});

t('G17. los renglones se listan por orden de aparición, no por el del carrito', () => {
  const { ctx } = escena(['A', 'B', 'C']);
  const revuelto = { items: [{ lid: 'L3', nombre: 'C' }, { lid: 'L1', nombre: 'A' }, { lid: 'L2', nombre: 'B' }] };
  assert.deepEqual(renglonesEnOrden(ctx, revuelto).map((l) => l.lid), ['L1', 'L2', 'L3']);
});

console.log(`\n${fail === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${ok} pasadas, ${fail} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
process.exit(fail ? 1 : 0);
