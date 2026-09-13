// LA CARTA ES DEL NEGOCIO, Y LA PREGUNTA LA HACE EL CÓDIGO.
//
// Fases H, J, K, M y N del Mesero Digital. Módulos puros.
//
// Dos cartas DISTINTAS y sin nada en común, a propósito: cualquier acierto que
// dependiera del nombre de un platillo se caería en la segunda. Los negocios de
// esta suite son inventados; ninguno existe en producción.
//
// Lo que defiende:
//
//   · nada se recomienda que no esté en el catálogo, y nada agotado;
//   · el bot no recomienda mientras el cliente corrige, ni después de «es todo»;
//   · una palabra que cubre dos productos se pregunta, no se resuelve;
//   · «creo que quieres X» no es una respuesta que este sistema pueda dar;
//   · la fase orienta pero no encierra: todo en un mensaje también vale.
import assert from 'node:assert/strict';

const menu = await import('../src/mesero/consultasDelMenu.js');
const { responderConsulta, buscarProductos, buscarCategorias, indiceDeLaCarta,
  resolverTermino, fichaDeProducto, productosVendibles } = menu;

const { recomendar, recomendarPorPista, puedeRecomendarAhora, TOPE_POR_CONVERSACION } =
  await import('../src/mesero/recomendaciones.js');

const { recolectarAclaraciones, aPreguntarAhora, paraElModelo, preguntaDeRespaldo, bloquean } =
  await import('../src/mesero/aclaraciones.js');

const { faseDelTurno, loQueFalta, siguientePregunta, listoParaConfirmar } =
  await import('../src/mesero/faseConversacional.js');

const { contextoNuevo, anotarTurno } = await import('../src/mesero/contextoMesa.js');
const { proponer, leerRespuesta, aplicarDesenlace } = await import('../src/mesero/propuestasDelBot.js');

let ok = 0, fail = 0; const fallos = [];
function t(nombre, fn) {
  try { fn(); ok++; console.log(`  OK  ${nombre}`); }
  catch (e) { fail++; fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}

// ── Dos cartas ajenas entre sí ──────────────────────────────────────────────

const prod = (id, nombre, precio, extra = {}) => ({
  id, nombre, precio, disponible: true, agotado: false, descripcion: '', modificadores: [], ...extra,
});
const grupo = (nombre, opciones, requerido = false) => ({
  nombre, requerido, minimo: requerido ? 1 : 0, maximo: 1,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});

// Fonda: desayunos y bebidas. Dos refrescos, para que «refresco» no se resuelva.
const CARTA_A = [
  { id: 1, nombre: 'Desayunos', productos: [
    prod(11, 'Molletes de Frijol', 85, {
      descripcion: 'Pan bolillo con frijoles refritos y queso gratinado. Llenador.',
      modificadores: [grupo('Salsa', ['Salsa Verde', 'Salsa Roja'], true)] }),
    prod(12, 'Fruta con Yogur', 60, { descripcion: 'Ligero, para empezar el día.' }),
    prod(13, 'Huevo al Comal', 70, { destacado: true }),
  ] },
  { id: 2, nombre: 'Bebidas', productos: [
    prod(21, 'Refresco de Cola', 30),
    prod(22, 'Refresco de Toronja', 30),
    prod(23, 'Café de Olla', 25, { destacado: true }),
    prod(24, 'Jugo de Naranja', 40, { agotado: true }),
  ] },
];

// Ramen: otra estructura, otro vocabulario, un solo producto por familia.
const CARTA_B = [
  { id: 5, nombre: 'Tazones', productos: [
    prod(51, 'Tonkotsu Clasico', 190, { descripcion: 'Caldo de cerdo, denso y fuerte.' }),
    prod(52, 'Shoyu Ligero', 165, { descripcion: 'Caldo claro de soya.' }),
  ] },
  { id: 6, nombre: 'Entradas', productos: [prod(61, 'Gyoza de Cerdo', 95, { destacado: true })] },
];

// ── FASE J — consultas de menú ──────────────────────────────────────────────

t('J1. lo agotado no existe para el mesero', () => {
  const vendibles = productosVendibles(CARTA_A).map((p) => p.nombre);
  assert(!vendibles.includes('Jugo de Naranja'), 'se ofreció un producto agotado');
  assert(vendibles.includes('Café de Olla'));
});

t('J2. «¿qué bebidas tienes?» contesta la categoría entera, no un producto', () => {
  const r = responderConsulta({ catalogo: CARTA_A, texto: '¿qué bebidas tienes?',
    intenciones: ['CONSULTA_MENU'] });
  assert.equal(r.tipo, 'categoria');
  assert.equal(r.categoria.nombre, 'Bebidas');
  const nombres = r.categoria.productos.map((p) => p.nombre);
  assert(nombres.includes('Refresco de Cola') && nombres.includes('Café de Olla'));
  assert(!nombres.includes('Jugo de Naranja'), 'coló el agotado');
});

t('J3. «¿cuánto cuesta el tonkotsu?» contesta el precio de ESE producto', () => {
  const r = responderConsulta({ catalogo: CARTA_B, texto: '¿cuánto cuesta el tonkotsu?',
    intenciones: ['CONSULTA_PRECIO'] });
  assert.equal(r.tipo, 'precio');
  assert.equal(r.producto.nombre, 'Tonkotsu Clasico');
  assert.equal(r.producto.precio, 190);
});

t('J4. «¿qué trae?» de un producto identificable devuelve su ficha', () => {
  const r = responderConsulta({ catalogo: CARTA_A, texto: '¿qué trae los molletes?',
    intenciones: ['CONSULTA_INGREDIENTES'] });
  assert.equal(r.tipo, 'ingredientes');
  assert(/frijoles/i.test(r.producto.descripcion));
  assert.equal(r.producto.grupos[0].requerido, true);
  assert.deepEqual(r.producto.grupos[0].opciones.map((o) => o.nombre), ['Salsa Verde', 'Salsa Roja']);
});

t('J5. «¿qué tienen?» devuelve el índice de la carta, no la carta entera', () => {
  const r = responderConsulta({ catalogo: CARTA_A, texto: '¿qué tienen?', intenciones: ['CONSULTA_MENU'] });
  assert.equal(r.tipo, 'carta');
  assert.deepEqual(r.categorias.map((c) => c.nombre), ['Desayunos', 'Bebidas']);
  assert.equal(r.categorias[1].productos, 3, 'contó el agotado');
});

t('J6. un término que cubre DOS productos no se resuelve', () => {
  const r = resolverTermino(CARTA_A, 'un refresco');
  assert.equal(r.resuelto, false, 'eligió entre dos refrescos');
  assert.deepEqual(r.candidatos.map((c) => c.nombre).sort(),
    ['Refresco de Cola', 'Refresco de Toronja']);
});

t('J7. un término que cubre UNO sí se resuelve', () => {
  const r = resolverTermino(CARTA_A, 'un refresco de toronja');
  assert.equal(r.resuelto, true);
  assert.equal(r.producto.nombre, 'Refresco de Toronja');
});

t('J8. una categoría con un solo producto vendible resuelve al producto', () => {
  const r = resolverTermino(CARTA_B, 'unas entradas');
  assert.equal(r.resuelto, true);
  assert.equal(r.producto.nombre, 'Gyoza de Cerdo');
});

t('J9. un producto que no existe no se inventa', () => {
  assert.deepEqual(buscarProductos(CARTA_A, 'sushi de anguila'), []);
  const r = responderConsulta({ catalogo: CARTA_A, texto: '¿tienen sushi?',
    intenciones: ['CONSULTA_PRODUCTO'] });
  assert.equal(r.tipo, 'no_identificado');
  assert.deepEqual(r.candidatos, []);
});

t('J10. la misma pregunta sobre la otra carta da la otra respuesta', () => {
  const a = responderConsulta({ catalogo: CARTA_A, texto: '¿qué tienen?', intenciones: ['CONSULTA_MENU'] });
  const b = responderConsulta({ catalogo: CARTA_B, texto: '¿qué tienen?', intenciones: ['CONSULTA_MENU'] });
  assert.notDeepEqual(a.categorias, b.categorias);
  assert.deepEqual(b.categorias.map((c) => c.nombre), ['Tazones', 'Entradas']);
});

// ── FASE M y N — recomendaciones y su moderación ────────────────────────────

const ctxCon = (fase = 'tomando_orden', turno = 5) => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'c1' });
  c.fase = fase; c.contador = turno;
  return c;
};

t('M1. sin promociones ni complementos, se recomienda lo destacado del negocio', () => {
  const r = recomendar({ catalogo: CARTA_A, carrito: { items: [] } });
  assert(r.length > 0);
  assert(r.every((x) => x.motivo === 'destacado'), JSON.stringify(r));
  assert.deepEqual(r.map((x) => x.nombre).sort(), ['Café de Olla', 'Huevo al Comal']);
});

t('M2. nunca se recomienda lo agotado ni lo que ya está en el pedido', () => {
  const conTodo = [{ id: 2, nombre: 'Bebidas', productos: [
    prod(24, 'Jugo de Naranja', 40, { agotado: true, destacado: true }),
    prod(23, 'Café de Olla', 25, { destacado: true }),
  ] }];
  const r = recomendar({ catalogo: conTodo, carrito: { items: [{ nombre: 'Café de Olla' }] } });
  assert.deepEqual(r, [], 'recomendó algo agotado o ya pedido');
});

t('M3. el complemento sale de la configuración del negocio, no de una tabla nuestra', () => {
  const carrito = { items: [{ nombre: 'Molletes de Frijol' }] };
  const sinConfig = recomendar({ catalogo: CARTA_A, carrito });
  assert(sinConfig.every((x) => x.motivo !== 'complemento'),
    'inventó una relación entre categorías sin que nadie la configurara');

  const conConfig = recomendar({ catalogo: CARTA_A, carrito, complementos: { Desayunos: ['Bebidas'] } });
  assert.equal(conConfig[0].motivo, 'complemento');
  assert.equal(conConfig[0].categoria, 'Bebidas');
});

t('M4. si el pedido ya lleva algo de esa familia, no se insiste con la familia', () => {
  const carrito = { items: [{ nombre: 'Molletes de Frijol' }, { nombre: 'Café de Olla' }] };
  const r = recomendar({ catalogo: CARTA_A, carrito, complementos: { Desayunos: ['Bebidas'] } });
  assert(r.every((x) => x.motivo !== 'complemento'), 'ofreció bebida a quien ya pidió bebida');
});

t('M5. una recomendación rechazada no vuelve nunca', () => {
  const ctx = ctxCon();
  anotarTurno(ctx, 'bot', '¿un café?');
  proponer(ctx, { clase: 'producto', referencia: 'Café de Olla' });
  anotarTurno(ctx, 'cliente', 'no');
  aplicarDesenlace(ctx, leerRespuesta(ctx, 'no'));
  const r = recomendar({ catalogo: CARTA_A, carrito: { items: [] }, contexto: ctx });
  assert(!r.some((x) => x.nombre === 'Café de Olla'), 'volvió a ofrecer lo rechazado');
});

t('N1. no se recomienda mientras el cliente corrige', () => {
  for (const i of ['QUITAR', 'CAMBIAR_CANTIDAD', 'CAMBIAR_MODIFICADOR', 'CANCELAR']) {
    const d = puedeRecomendarAhora(ctxCon(), { intenciones: [i] });
    assert.equal(d.puede, false, `recomendó durante ${i}`);
    assert.equal(d.motivo, i === 'CANCELAR' ? 'esta_corrigiendo' : 'esta_corrigiendo');
  }
});

t('N2. no se recomienda después de «eso es todo» ni al confirmar', () => {
  assert.equal(puedeRecomendarAhora(ctxCon(), { intenciones: ['CONFIRMAR'] }).puede, false);
  assert.equal(puedeRecomendarAhora(ctxCon('confirmando'), { intenciones: [] }).puede, false);
  assert.equal(puedeRecomendarAhora(ctxCon('confirmado'), { intenciones: [] }).puede, false);
});

t('N3. no se recomienda dos turnos seguidos', () => {
  const ctx = ctxCon('tomando_orden', 5);
  anotarTurno(ctx, 'bot', '¿un café?');
  proponer(ctx, { clase: 'producto', referencia: 'Café de Olla' });
  assert.equal(puedeRecomendarAhora(ctx, { intenciones: ['AGREGAR_PRODUCTO'] }).puede, false);
  ctx.contador += 4;
  assert.equal(puedeRecomendarAhora(ctx, { intenciones: ['AGREGAR_PRODUCTO'] }).puede, true);
});

t('N4. hay un tope por conversación', () => {
  const ctx = ctxCon('tomando_orden', 1);
  for (let i = 0; i < TOPE_POR_CONVERSACION; i++) {
    ctx.contador += 10;
    anotarTurno(ctx, 'bot', 'oferta');
    proponer(ctx, { clase: 'producto', referencia: `Producto ${i}` });
  }
  ctx.contador += 10;
  const d = puedeRecomendarAhora(ctx, { intenciones: ['AGREGAR_PRODUCTO'] });
  assert.equal(d.puede, false);
  assert.equal(d.motivo, 'tope_alcanzado');
});

t('N5. si el cliente PIDE recomendación, se recomienda aunque toque callar', () => {
  const ctx = ctxCon('tomando_orden', 5);
  anotarTurno(ctx, 'bot', '¿un café?');
  proponer(ctx, { clase: 'producto', referencia: 'Café de Olla' });
  const d = puedeRecomendarAhora(ctx, { intenciones: ['PEDIR_RECOMENDACION'] });
  assert.equal(d.puede, true, 'no contestó a quien le pidió una recomendación');
});

t('M6. «algo llenador» y «algo ligero» dan cosas distintas, y de la carta', () => {
  const llenador = recomendarPorPista({ catalogo: CARTA_A, pista: 'algo llenador' });
  const ligero = recomendarPorPista({ catalogo: CARTA_A, pista: 'algo ligero' });
  assert.equal(llenador[0].nombre, 'Molletes de Frijol', JSON.stringify(llenador));
  assert.equal(ligero[0].nombre, 'Fruta con Yogur', JSON.stringify(ligero));
  const enCarta = productosVendibles(CARTA_A).map((p) => p.nombre);
  for (const x of [...llenador, ...ligero]) assert(enCarta.includes(x.nombre), `${x.nombre} no está en la carta`);
});

t('M7. «algo barato» ordena por el precio real del negocio', () => {
  const r = recomendarPorPista({ catalogo: CARTA_B, pista: 'algo barato', limite: 1 });
  assert.equal(r[0].nombre, 'Gyoza de Cerdo');
  assert.equal(r[0].motivo, 'pista_precio_bajo');
});

// ── FASE K — aclaraciones ───────────────────────────────────────────────────

t('K1. un término genérico produce una pregunta, no una elección', () => {
  const ac = recolectarAclaraciones({
    terminos: [{ termino: 'refresco', candidatos: ['Refresco de Cola', 'Refresco de Toronja'] }],
  });
  assert.equal(ac.length, 1);
  assert.equal(ac[0].tipo, 'termino_ambiguo');
  assert(/cuál/i.test(ac[0].pregunta), ac[0].pregunta);
  assert(!/creo que/i.test(ac[0].pregunta), 'el sistema adivinó en voz educada');
});

t('K2. una cantidad sin objetivo y un modificador sin renglón se preguntan', () => {
  const ac = recolectarAclaraciones({
    referencia: { tipo: 'deictico', frase: 'hazlos tres', resuelta: false,
      motivo: 'varios_candidatos', candidatos: [{ lid: 'L1', nombre: 'A' }, { lid: 'L2', nombre: 'B' }] },
  });
  assert.equal(ac[0].tipo, 'referencia_ambigua');
  assert.equal(ac[0].candidatos.length, 2);
});

t('K3. un «sí» ambiguo se pregunta', () => {
  const ac = recolectarAclaraciones({
    propuestas: { ambigua: true, candidatas: [{ etiqueta: 'un café' }, { etiqueta: 'pan dulce' }] },
  });
  assert.equal(ac[0].tipo, 'respuesta_ambigua');
  assert(/café/.test(ac[0].pregunta) && /pan/.test(ac[0].pregunta));
});

t('K4. un «quita» que cabe en dos artículos no quita ninguno', () => {
  const ac = recolectarAclaraciones({
    cambios: { ambiguos: [{ nombre: 'Hotcakes Tradicionales', empatan: ['Hotcakes de Sartén'], frase: 'los hotcakes' }] },
  });
  assert.equal(ac[0].tipo, 'quitar_ambiguo');
  assert(/dejo los dos/i.test(ac[0].pregunta), ac[0].pregunta);
});

t('K5. un grupo requerido sin elegir bloquea, y se pregunta primero', () => {
  const ac = recolectarAclaraciones({
    terminos: [{ termino: 'refresco', candidatos: ['Refresco de Cola', 'Refresco de Toronja'] }],
    gruposFaltantes: [{ lid: 'L1', producto: 'Molletes de Frijol', grupo: 'Salsa',
      opciones: ['Salsa Verde', 'Salsa Roja'] }],
  });
  assert.equal(bloquean(ac).length, 2);
  const ahora = aPreguntarAhora(ac, { maximo: 1 });
  assert.equal(ahora.length, 1);
  assert.equal(ahora[0].tipo, 'termino_ambiguo');
});

t('K6. se preguntan dos cosas como mucho', () => {
  const muchas = recolectarAclaraciones({
    terminos: [
      { termino: 'a', candidatos: ['a1', 'a2'] },
      { termino: 'b', candidatos: ['b1', 'b2'] },
      { termino: 'c', candidatos: ['c1', 'c2'] },
    ],
  });
  assert.equal(muchas.length, 3);
  assert.equal(aPreguntarAhora(muchas).length, 2);
});

t('K7. al modelo se le dan HECHOS, no la frase ya hecha', () => {
  const ac = recolectarAclaraciones({
    terminos: [{ termino: 'refresco', candidatos: ['Refresco de Cola', 'Refresco de Toronja'] }],
  });
  const paraEl = paraElModelo(ac);
  assert.equal(paraEl[0].pregunta, undefined, 'se le pasó la redacción hecha y la va a copiar');
  assert.deepEqual(paraEl[0].candidatos, ['Refresco de Cola', 'Refresco de Toronja']);
  assert(preguntaDeRespaldo(ac).length > 0, 'sin respaldo, un fallo del modelo deja al cliente en silencio');
});

// ── FASE H — la fase conversacional ─────────────────────────────────────────

const carritoCon = (...n) => ({ items: n.map((x, i) => ({ lid: `L${i}`, nombre: x, cantidad: 1 })) });

t('H1. sin pedido y preguntando, la fase es explorar', () => {
  assert.equal(faseDelTurno({ intenciones: ['CONSULTA_MENU'] }), 'explorando_menu');
  assert.equal(faseDelTurno({ intenciones: ['PEDIR_RECOMENDACION'] }), 'explorando_menu');
  assert.equal(faseDelTurno({ intenciones: ['SALUDO'] }), 'inicio');
  assert.equal(faseDelTurno({ intenciones: ['INICIAR_ORDEN'] }), 'tomando_orden');
});

t('H2. todo en un mensaje salta hasta revisar, sin pasar por los pasos', () => {
  const f = faseDelTurno({
    intenciones: ['AGREGAR_PRODUCTO', 'DEFINIR_MODALIDAD', 'DEFINIR_PAGO'],
    carrito: carritoCon('Molletes de Frijol'),
    datos: { modalidad: 'recoger', pago: 'efectivo' },
  });
  assert.equal(f, 'revisando', 'la fase se comportó como un formulario');
});

t('H3. un grupo requerido pendiente manda sobre todo lo demás', () => {
  const f = faseDelTurno({
    intenciones: ['AGREGAR_PRODUCTO', 'DEFINIR_MODALIDAD'],
    carrito: carritoCon('Molletes de Frijol'),
    datos: { modalidad: 'recoger', pago: 'efectivo' },
    aclaraciones: [{ tipo: 'grupo_requerido', grupo: 'Salsa' }],
  });
  assert.equal(f, 'completando_producto');
});

t('H4. pedir humano gana sobre cualquier otra cosa del turno', () => {
  assert.equal(faseDelTurno({
    intenciones: ['AGREGAR_PRODUCTO', 'PEDIR_HUMANO'], carrito: carritoCon('X'),
  }), 'escalado_humano');
});

t('H5. lo que falta se pide en orden y no se repite', () => {
  const entrada = { carrito: carritoCon('Molletes de Frijol'), datos: {}, aclaraciones: [] };
  assert.deepEqual(loQueFalta(entrada), ['modalidad', 'pago']);
  assert.equal(siguientePregunta(entrada, []), 'modalidad');
  assert.equal(siguientePregunta(entrada, ['modalidad']), 'pago',
    'volvió a preguntar lo que ya había preguntado');
  assert.equal(siguientePregunta(entrada, ['modalidad', 'pago']), 'modalidad',
    'si todo se preguntó y nada se contestó, se insiste por lo primero');
});

t('H6. un negocio que no pide forma de pago no la espera', () => {
  const entrada = { carrito: carritoCon('X'), datos: { modalidad: 'recoger' }, requierePago: false };
  assert.deepEqual(loQueFalta(entrada), []);
  assert.equal(listoParaConfirmar({ ...entrada, aclaraciones: [] }), true);
});

t('H7. con una aclaración abierta no se puede confirmar', () => {
  const entrada = {
    carrito: carritoCon('X'), datos: { modalidad: 'recoger', pago: 'efectivo' },
    aclaraciones: [{ tipo: 'termino_ambiguo' }],
  };
  assert.equal(listoParaConfirmar(entrada), false);
  assert.equal(faseDelTurno({ ...entrada, intenciones: ['CONFIRMAR'] }), 'completando_producto');
});

console.log(`\n${fail === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${ok} pasadas, ${fail} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
process.exit(fail ? 1 : 0);
