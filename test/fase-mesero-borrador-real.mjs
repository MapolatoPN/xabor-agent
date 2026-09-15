// ─── El borrador del modelo es una hipótesis, no una estructura ───────────
//
// B1–B20. Hasta ahora las suites inyectaban borradores IDEALES: el modelo
// devolvía el `lid` correcto, repetía las opciones ya puestas y no olvidaba
// ninguna entidad. El smoke real del 15-sep con GPT en producción devolvió otra
// cosa, y el resultado fue seis renglones para seis mensajes.
//
// ── La causa, medida ─────────────────────────────────────────────────────
//
//   carrito  «Chilaquiles Sencillos»   (nombre CANÓNICO, puesto por el anclaje)
//   modelo   «chilaquiles suizos»      (como lo dijo el cliente)
//   parecido -> -1  «nombres ajenos»   -> RENGLÓN NUEVO
//
// Canonizar el nombre rompió el puente entre turnos. Estas pruebas usan los
// patrones EXACTOS observados en producción, no versiones amables.
import assert from 'node:assert/strict';
import { atenderTurno } from '../src/mesero-whatsapp/meseroDigital.js';
import {
  compilarTurno, resolverObjetivo, opcionesDelTexto, resolverContraPendiente,
  reparaLaIntencion, esConsultaPura, mismaFamilia, pideOtraUnidad,
} from '../src/mesero-whatsapp/compilarTurno.js';
import { fichaDeProducto } from '../src/mesero-whatsapp/consultasDelMenu.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

const g = (nombre, minimo, maximo, opciones, requerido = true) => ({
  nombre, requerido, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});

// La carta REAL de Obispado, con la metadata de variantes ya aplicada.
const SALSAS = ['Roja', 'Suiza', 'Verde', 'Mole', 'Chipotle'];
const PROTS = ['Huevos Estrellados', 'Huevos Revueltos', 'Pechuga de pollo', 'Chicharron Prensado',
  'Bistec en Salsa', 'Queso Panela en Salsa', 'Chicharron Cuerito en Salsa'];
const GUARNS = ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas a la mexicana', 'Papas con chorizo',
  'Bistec en salsa', 'Queso panela en salsa', 'Chicharron cuerito en salsa'];
const CARTA = [
  { id: 26, nombre: 'CHILAQUILES', orden: 1, productos: [
    { id: 85, nombre: 'Chilaquiles Sencillos', orden: 0, precio: 195, disponible: true,
      opciones: { variante: { base: true } },
      modificadores: [g('Salsa', 1, 1, SALSAS), g('Proteína', 1, 1, PROTS), g('Guarniciones', 1, 2, GUARNS)] },
    { id: 107, nombre: 'Chilaquiles Mixtos', orden: 1, precio: 205, disponible: true,
      opciones: { variante: { discriminadores: ['mixto', 'mixtos'] } },
      modificadores: [g('Salsa', 1, 2, SALSAS), g('Proteína', 1, 2, PROTS), g('Guarniciones', 1, 2, GUARNS)] },
    { id: 108, nombre: 'Bowl de Chilaquiles', orden: 2, precio: 140, disponible: true,
      opciones: { variante: { requiere_mencion: true, discriminadores: ['bowl'] } },
      modificadores: [g('Salsa', 1, 1, SALSAS), g('Proteína', 1, 1, PROTS)] },
  ] },
  { id: 40, nombre: 'LICUADOS', orden: 3, productos: [
    { id: 200, nombre: 'Licuado de fresa', orden: 0, precio: 60, disponible: true, modificadores: [] },
    { id: 201, nombre: 'Licuado de platano', orden: 1, precio: 60, disponible: true, modificadores: [] },
  ] },
];

// Y una carta sin una palabra en común (B18).
const SUSHI = [
  { id: 1, nombre: 'ROLLOS', orden: 0, productos: [
    { id: 301, nombre: 'Rollo Sencillo', orden: 0, precio: 120, disponible: true,
      opciones: { variante: { base: true } },
      modificadores: [g('Salsa', 1, 1, ['Anguila', 'Spicy', 'Tampico']), g('Relleno', 1, 1, ['Camaron', 'Kanikama'])] },
    { id: 302, nombre: 'Rollo Doble', orden: 1, precio: 160, disponible: true,
      modificadores: [g('Salsa', 1, 2, ['Anguila', 'Spicy', 'Tampico']), g('Relleno', 1, 2, ['Camaron', 'Kanikama'])] },
  ] },
];

const it = (nombre, modificadores = [], extra = {}) => ({ nombre, cantidad: 1, modificadores, notas: '', ...extra });
const grupo = (gr, ...opciones) => ({ grupo: gr, opciones });

let seq = 0;
async function conversar(guion, catalogo = CARTA) {
  seq += 1;
  let contexto = null; let carrito = null; const fuera = [];
  for (const paso of guion) {
    const r = await atenderTurno({
      negocioId: 'n-br', conversacionId: `c-br-${seq}`, mensaje: paso.cliente,
      catalogo, requierePago: false, contextoGuardado: contexto, carrito,
      proponer: async () => paso.borrador ?? null,
    });
    contexto = JSON.parse(JSON.stringify(r.contexto));
    carrito = r.carrito;
    fuera.push(r);
  }
  return fuera;
}
const items = (r) => r.carrito?.items || [];
const linea = (r, i = 0) => items(r)[i] || null;
const opcs = (r, gr, i = 0) => (linea(r, i)?.modificadores || [])
  .filter((m) => m.grupo.toLowerCase() === gr.toLowerCase())
  .flatMap((m) => (m.opciones || []).map((o) => (typeof o === 'string' ? o : o?.nombre))).sort();

// ═══════════════════════════════════════════════════════════════════════════
// LOS BORRADORES REALES (§18). Patrones EXACTOS observados en producción.
// ═══════════════════════════════════════════════════════════════════════════
const R1 = { items: [it('chilaquiles suizos')] };                       // sin Suiza, sin lid
const R2 = { items: [it('Chilaquiles suizos con frijolitos')] };        // lid=null
const R4 = { items: [it('chilaquiles con chipotle')] };                 // turno «OTRO»
const R5 = { items: [it('chilaquiles suizos con chipotle')] };          // draft mutante en consulta

await t('B1. T1: el modelo omite Suiza y Suiza entra por el texto real', async () => {
  const rs = await conversar([{ cliente: 'Quiero chilaquiles suizos', borrador: R1 }]);
  assert.equal(items(rs[0]).length, 1, `nacieron ${items(rs[0]).length} renglones`);
  assert.equal(linea(rs[0]).nombre, 'Chilaquiles Sencillos', linea(rs[0]).nombre);
  assert.equal(linea(rs[0]).id, 85, `id=${linea(rs[0]).id}`);
  assert.deepEqual(opcs(rs[0], 'Salsa'), ['Suiza'],
    `el modelo no la propuso y el texto sí la sostiene: ${JSON.stringify(opcs(rs[0], 'Salsa'))}`);
});

await t('B2. CAMBIAR_MODIFICADOR + lid null + un solo objetivo → mismo lid', async () => {
  const rs = await conversar([
    { cliente: 'Quiero chilaquiles suizos', borrador: R1 },
    { cliente: 'Con frijolitos', borrador: R2 }]);
  assert.equal(items(rs[1]).length, 1, `se crearon ${items(rs[1]).length} renglones`);
  assert.equal(linea(rs[1]).lid, linea(rs[0]).lid, 'cambió el lid');
});

await t('B3. CAMBIAR_MODIFICADOR con dos objetivos posibles → se pregunta', async () => {
  const dos = { items: [{ lid: 'A', nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [grupo('Salsa', 'Roja')], notas: '' },
    { lid: 'B', nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [grupo('Salsa', 'Verde')], notas: '' }] };
  const r = resolverObjetivo({
    catalogo: CARTA, carrito: dos, contexto: { foco: null },
    intenciones: ['CAMBIAR_MODIFICADOR'], nombrePropuesto: 'chilaquiles', lidDelModelo: null, referencia: null,
  });
  assert.equal(r.lid, null, `eligió ${r.lid} en vez de preguntar`);
  assert.equal(r.candidatos.length, 2, JSON.stringify(r));
});

await t('B4. un lid inventado por el modelo no se usa a ciegas', async () => {
  const uno = { items: [{ lid: 'REAL', nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [], notas: '' }] };
  const r = resolverObjetivo({
    catalogo: CARTA, carrito: uno, contexto: { foco: 'REAL' },
    intenciones: ['CAMBIAR_MODIFICADOR'], nombrePropuesto: 'chilaquiles', lidDelModelo: 'INVENTADO', referencia: null,
  });
  assert.equal(r.lid, 'REAL', `uso un lid que no existe: ${r.lid}`);
  assert.notEqual(r.motivo, 'lid_del_modelo_verificado', r.motivo);
});

await t('B5. «también chipotle» clasificado OTRO se repara como acto', async () => {
  const ficha = fichaDeProducto(CARTA[0].productos[0], 'CHILAQUILES');
  const opciones = opcionesDelTexto({ ficha, texto: 'También chipotle' });
  assert(opciones.some((o) => o.opcion === 'Chipotle'), JSON.stringify(opciones));
  assert.equal(reparaLaIntencion({ intenciones: ['OTRO'], texto: 'También chipotle', opciones, objetivo: 'L1' }), true);
});

await t('B6. «perfecto» clasificado OTRO NO muta', async () => {
  const ficha = fichaDeProducto(CARTA[0].productos[0], 'CHILAQUILES');
  for (const frase of ['perfecto', 'qué rico', 'ok gracias']) {
    const opciones = opcionesDelTexto({ ficha, texto: frase });
    assert.equal(reparaLaIntencion({ intenciones: ['OTRO'], texto: frase, opciones, objetivo: 'L1' }), false,
      `reparó «${frase}» sin evidencia`);
  }
  // ── Y EL CASO QUE DE VERDAD VIGILA LA REGLA ────────────────────────────
  //
  // Las tres frases de arriba no nombran ninguna opción, así que se caen en la
  // guarda de «sin opciones» y nunca llegan a la de evidencia: la mordida Q6
  // —«repara todo OTRO»— no las tumbaba, y una prueba que una mordida no puede
  // tumbar no vigila nada.
  //
  // Éste sí nombra una opción REAL del producto y aun así no pide nada: es un
  // comentario sobre el chipotle, no una orden de ponerlo. Aquí lo único que
  // separa reparar de inventar es el marcador de acto.
  const comentario = 'el chipotle está bueno';
  const conOpcion = opcionesDelTexto({ ficha, texto: comentario });
  assert(conOpcion.some((o) => o.opcion === 'Chipotle'),
    `el caso no ejercita la regla: no encontró la opción en «${comentario}»`);
  assert.equal(reparaLaIntencion({ intenciones: ['OTRO'], texto: comentario, opciones: conOpcion, objetivo: 'L1' }),
    false, 'convirtió un comentario en una mutación');
});

await t('B7. consulta pura con borrador mutante → pedido idéntico', async () => {
  assert.equal(esConsultaPura({ intenciones: ['CONSULTA_PRODUCTO'], texto: 'Que licuados tienen?' }), true);
  const compilado = compilarTurno({
    catalogo: CARTA, carrito: { items: [{ lid: 'L1', nombre: 'Chilaquiles Mixtos', cantidad: 1, modificadores: [], notas: '' }] },
    contexto: { foco: 'L1' }, borrador: R5, intenciones: ['CONSULTA_PRODUCTO'], dicho: 'Que licuados tienen?',
    propuestasBase: [{ accion: 'agregar', lid: null, valorNuevo: { nombre: 'chilaquiles', modificadores: [] } }],
  });
  assert.equal(compilado.inerte, true, JSON.stringify(compilado));
  assert.deepEqual(compilado.propuestas, [], JSON.stringify(compilado.propuestas));
});

await t('B8. consulta + orden explícita: sólo lo ordenado puede mutar', async () => {
  assert.equal(esConsultaPura({ intenciones: ['CONSULTA_PRODUCTO'], texto: 'que licuados tienen y ponme uno de fresa' }), false,
    'una frase mixta no puede quedar inerte');
});

await t('B9. pendiente de frijolitos + «con chorizo» → Frijolitos con chorizo', async () => {
  const r = resolverContraPendiente({
    pendientes: [{ tipo: 'opcion_ambigua', grupo: 'Guarniciones', clave: 'k',
      candidatos: ['Frijolitos naturales', 'Frijolitos con chorizo'] }],
    texto: 'Con chorizo',
  });
  assert(r, 'no resolvió contra el pendiente');
  assert.equal(r.opcion, 'Frijolitos con chorizo', JSON.stringify(r));
  // Y la prueba de que importa: en la carta entera «chorizo» también sostiene
  // «Papas con chorizo», así que la búsqueda global no resolvería.
  const ficha = fichaDeProducto(CARTA[0].productos[0], 'CHILAQUILES');
  const global = opcionesDelTexto({ ficha, texto: 'Con chorizo' });
  assert.equal(global.length, 0, `la busqueda global sí resolvía: ${JSON.stringify(global)}`);
});

await t('B10. una opción sacada del mensaje pasa el matching seguro', async () => {
  const ficha = fichaDeProducto(CARTA[0].productos[0], 'CHILAQUILES');
  assert.deepEqual(opcionesDelTexto({ ficha, texto: 'con huevo estrellado' }).map((o) => o.opcion),
    ['Huevos Estrellados']);
  // «frijolitos» no separa a sus dos hermanas: no entra sola.
  assert.deepEqual(opcionesDelTexto({ ficha, texto: 'con frijolitos' }), []);
});

await t('B11. una opción inexistente no entra por extracción directa', async () => {
  const ficha = fichaDeProducto(CARTA[0].productos[0], 'CHILAQUILES');
  for (const frase of ['con queso azul', 'con salsa de cacahuate', 'con salmon']) {
    const o = opcionesDelTexto({ ficha, texto: frase });
    assert.deepEqual(o, [], `entró algo con «${frase}»: ${JSON.stringify(o)}`);
  }
});

await t('B15. lo heredado no se marca como dicho en el turno actual', async () => {
  const rs = await conversar([
    { cliente: 'Quiero chilaquiles suizos', borrador: R1 },
    { cliente: 'Con frijolitos', borrador: R2 }]);
  const autorizado = rs[1].metricas?.autorizado || rs[1].autorizado || [];
  const articulo = autorizado.find((a) => String(a).includes('articulo'));
  assert(!articulo, `T2 volvió a marcar el artículo como dicho en este turno: ${JSON.stringify(autorizado)}`);
});

await t('B16. dos renglones iguales + modificador ambiguo → pregunta, no el último', async () => {
  const dos = { items: [
    { lid: 'A', nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [], notas: '' },
    { lid: 'B', nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [], notas: '' }] };
  // Con dos renglones iguales el objetivo no es único: el compilador NO puede
  // elegir, así que el alta se queda como alta y la decide la capa de
  // ambigüedad de siempre — nunca «el último».
  const r = resolverObjetivo({
    catalogo: CARTA, carrito: dos, contexto: { foco: null }, intenciones: ['CAMBIAR_MODIFICADOR'],
    nombrePropuesto: 'chilaquiles', lidDelModelo: null, referencia: null,
  });
  assert.equal(r.lid, null, `eligió ${r.lid} entre dos iguales`);
  assert.equal(r.candidatos.length, 2, JSON.stringify(r));
});

await t('B17. una referencia explícita elige el renglón correcto', async () => {
  const dos = { items: [
    { lid: 'A', nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [], notas: '' },
    { lid: 'B', nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [], notas: '' }] };
  const r = resolverObjetivo({
    catalogo: CARTA, carrito: dos, contexto: { foco: 'A' }, intenciones: ['CAMBIAR_MODIFICADOR'],
    nombrePropuesto: 'chilaquiles', referencia: { resuelta: true, lids: ['B'] },
  });
  assert.equal(r.lid, 'B', `la referencia no mandó: ${r.lid} por ${r.motivo}`);
});

await t('B18. el mismo motor sobre una carta sin una palabra en común', async () => {
  const rs = await conversar([
    { cliente: 'Quiero un rollo con salsa anguila', borrador: { items: [it('rollo con anguila')] } }], SUSHI);
  assert.equal(items(rs[0]).length, 1, JSON.stringify(items(rs[0])));
  assert.equal(linea(rs[0]).nombre, 'Rollo Sencillo', linea(rs[0]).nombre);
  assert.deepEqual(opcs(rs[0], 'Salsa'), ['Anguila'], JSON.stringify(opcs(rs[0], 'Salsa')));
  assert.equal(mismaFamilia(SUSHI, 'Rollo Sencillo', 'rollo con anguila'), true);
  assert.equal(mismaFamilia(CARTA, 'Chilaquiles Sencillos', 'Licuado de fresa'), false);
});

await t('B19. el modelo dice «agregar» durante CAMBIAR_MODIFICADOR → no hay segunda línea', async () => {
  const uno = { items: [{ lid: 'L1', nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [grupo('Salsa', 'Suiza')], notas: '' }] };
  const c = compilarTurno({
    catalogo: CARTA, carrito: uno, contexto: { foco: 'L1' },
    borrador: { items: [it('chilaquiles suizos con frijolitos')] },
    intenciones: ['CAMBIAR_MODIFICADOR'], dicho: 'Con frijolitos',
    propuestasBase: [{ accion: 'agregar', lid: null,
      valorNuevo: { nombre: 'chilaquiles suizos con frijolitos', cantidad: 1, modificadores: [], notas: '' } }],
  });
  assert(!c.propuestas.some((p) => p.accion === 'agregar'), JSON.stringify(c.propuestas));
  assert(c.propuestas.every((p) => p.lid === 'L1'), JSON.stringify(c.propuestas));
});

await t('B20. con información parcial se conserva el estado autorizado anterior', async () => {
  const rs = await conversar([
    { cliente: 'Quiero chilaquiles suizos', borrador: R1 },
    // El modelo devuelve el renglón SIN la salsa que ya estaba.
    { cliente: 'Con huevo estrellado', borrador: { items: [it('chilaquiles con huevo estrellado')] } }]);
  assert.equal(items(rs[1]).length, 1, `${items(rs[1]).length} renglones`);
  assert(opcs(rs[1], 'Salsa').includes('Suiza'),
    `se perdió la Suiza autorizada en T1: ${JSON.stringify(opcs(rs[1], 'Salsa'))}`);
});


// ═══════════════════════════════════════════════════════════════════════════
// EL SMOKE REAL, ENTERO (§19) — con los borradores que devolvió GPT
// ═══════════════════════════════════════════════════════════════════════════
//
// Seis mensajes reales del 15-sep contra producción. Los borradores son los
// patrones observados: el modelo repite el pedido como lo dijo el cliente, sin
// lid, sin las opciones ya puestas, y sigue emitiendo artículo incluso cuando
// el turno es una consulta.

await t('E2E. los seis turnos reales terminan en UNA línea con UN lid', async () => {
  const rs = await conversar([
    { cliente: 'Quiero chilaquiles suizos',
      borrador: { items: [it('chilaquiles suizos')] } },
    { cliente: 'Con frijolitos',
      borrador: { items: [it('Chilaquiles suizos con frijolitos')] } },
    { cliente: 'Con chorizo',
      borrador: { items: [it('Chilaquiles con chorizo')] } },
    { cliente: 'También chipotle',
      borrador: { items: [it('chilaquiles con chipotle')] } },
    { cliente: 'Con huevo estrellado',
      borrador: { items: [it('chilaquiles con huevo estrellado')] } },
    { cliente: 'Que licuados tienen?',
      borrador: { items: [it('chilaquiles suizos con chipotle')] } },
  ]);

  const L1 = linea(rs[0]).lid;
  for (const [i, r] of rs.entries()) {
    assert.equal(items(r).length, 1, `T${i + 1}: ${items(r).length} renglones (debe ser 1)`);
    assert.equal(linea(r).lid, L1, `T${i + 1}: cambió el lid`);
  }

  // T1: Sencillos con la Suiza que el modelo no propuso.
  assert.equal(linea(rs[0]).nombre, 'Chilaquiles Sencillos');
  assert.equal(linea(rs[0]).id, 85, `T1 id=${linea(rs[0]).id}`);
  assert.deepEqual(opcs(rs[0], 'Salsa'), ['Suiza']);

  // T3: el pendiente de frijolitos resuelto, sin Papas con chorizo.
  assert(opcs(rs[2], 'Guarniciones').includes('Frijolitos con chorizo'),
    `T3 Guarniciones=${JSON.stringify(opcs(rs[2], 'Guarniciones'))}`);
  assert(!opcs(rs[2], 'Guarniciones').some((o) => /papas/i.test(o)), 'se coló una papa');

  // T4: reclasificación con el MISMO lid y el id nuevo.
  assert.equal(linea(rs[3]).nombre, 'Chilaquiles Mixtos', `T4 ${linea(rs[3]).nombre}`);
  assert.equal(linea(rs[3]).id, 107, `T4 id=${linea(rs[3]).id}`);
  assert.deepEqual(opcs(rs[3], 'Salsa'), ['Chipotle', 'Suiza']);

  // T5: la proteína, conservando todo lo anterior.
  assert.deepEqual(opcs(rs[4], 'Proteína'), ['Huevos Estrellados']);
  assert.deepEqual(opcs(rs[4], 'Salsa'), ['Chipotle', 'Suiza']);

  // T6: la consulta no toca nada.
  assert.deepEqual(
    JSON.parse(JSON.stringify(items(rs[5]))), JSON.parse(JSON.stringify(items(rs[4]))),
    'la consulta modificó el pedido');
  assert(rs[5].consulta, 'no se entendió como consulta');

  // Y el pedido final es el del enunciado.
  const f = linea(rs[5]);
  assert.equal(f.nombre, 'Chilaquiles Mixtos');
  assert.equal(f.id, 107);
  assert.deepEqual(opcs(rs[5], 'Salsa'), ['Chipotle', 'Suiza']);
  assert.deepEqual(opcs(rs[5], 'Proteína'), ['Huevos Estrellados']);
  assert(opcs(rs[5], 'Guarniciones').includes('Frijolitos con chorizo'));
});

await t('B12/B13/B14. el mismo lid T1–T5, el id 85→107 en T4, y T6 sin cambiar el conteo', async () => {
  // Cubiertos por E2E; se nombran aparte para que el enunciado tenga su prueba.
  assert.ok(true);
});


// ═══════════════════════════════════════════════════════════════════════════
// B21–B30 · LO QUE DESTAPÓ INTEGRAR LA CAPA
// ═══════════════════════════════════════════════════════════════════════════

await t('B21. una ambigüedad real produce UN solo pendiente', async () => {
  const rs = await conversar([
    { cliente: 'Quiero chilaquiles suizos', borrador: R1 },
    { cliente: 'Con frijolitos', borrador: R2 }]);
  const amb = (rs[1].aclaraciones || []).filter((x) => x.tipo === 'opcion_ambigua');
  assert.equal(amb.length, 1, `${amb.length} aclaraciones para la misma duda: ${JSON.stringify(amb)}`);
  const vivos = (rs[1].contexto?.pendientes || [])
    .filter((x) => x.tipo === 'opcion_ambigua' && !x.resuelto && !x.cancelado && !x.obsoleto);
  assert.equal(vivos.length, 1, `${vivos.length} pendientes: ${JSON.stringify(vivos.map((v) => v.clave))}`);
});

await t('B22. la omisión del borrador NO elimina lo que ya estaba', async () => {
  const rs = await conversar([
    { cliente: 'Quiero chilaquiles suizos', borrador: R1 },
    // El modelo devuelve el renglón SIN la salsa y hablando de otra cosa.
    { cliente: 'para llevar porfa', borrador: { items: [it('chilaquiles')] } }]);
  assert(opcs(rs[1], 'Salsa').includes('Suiza'),
    `la omisión borró la Suiza: ${JSON.stringify(opcs(rs[1], 'Salsa'))}`);
});

await t('B32. al reescribir un alta en «también», lo ya autorizado sobrevive', async () => {
  // La mordida Q10 —«omitir es borrar»— no tumbaba nada: ninguna prueba llegaba
  // a la fusión que hace el compilador al reescribir un alta. Los borradores
  // del smoke sólo traen NOMBRE, así que ese grupo llegaba vacío y las opciones
  // entraban por el otro camino, el del texto del cliente.
  //
  // Para llegar hasta ahí hacen falta las tres cosas a la vez: que el modelo
  // mande el GRUPO, que el cliente diga «también», y que el nombre NO empareje
  // con el renglón —«chilaquiles suizos» contra «Chilaquiles Mixtos»—, que es
  // justo el patrón del smoke y lo que convierte la propuesta en un alta.
  // Con el nombre canónico no pasa por aquí: lo resuelve el reconciliador de
  // siempre, y ése reemplaza el grupo en vez de sumarlo.
  const rs = await conversar([
    { cliente: 'Quiero chilaquiles mixtos suizos', borrador: { items: [it('chilaquiles mixtos suizos')] } },
    { cliente: 'También chipotle',
      borrador: { items: [it('chilaquiles suizos', [grupo('Salsa', 'Chipotle')])] } }]);
  assert.equal(items(rs[1]).length, 1, `se crearon ${items(rs[1]).length} renglones`);
  assert.deepEqual(opcs(rs[1], 'Salsa'), ['Chipotle', 'Suiza'],
    `sumar borró lo anterior: ${JSON.stringify(opcs(rs[1], 'Salsa'))}`);
});

await t('B23. una eliminación EXPLÍCITA sí elimina', async () => {
  const rs = await conversar([
    { cliente: 'Quiero chilaquiles suizos', borrador: R1 },
    { cliente: 'También chipotle', borrador: { items: [it('chilaquiles con chipotle')] } },
    { cliente: 'quítale el chipotle', borrador: { items: [it('chilaquiles suizos')] } }]);
  assert(!opcs(rs[2], 'Salsa').includes('Chipotle'),
    `no quitó lo que el cliente pidió quitar: ${JSON.stringify(opcs(rs[2], 'Salsa'))}`);
  assert(opcs(rs[2], 'Salsa').includes('Suiza'), 'se llevó también la que no se pidió quitar');
});

await t('B24. consulta pura con borrador mutante: pedido idéntico', async () => {
  const rs = await conversar([
    { cliente: 'Quiero chilaquiles suizos', borrador: R1 },
    { cliente: 'Que licuados tienen?', borrador: R5 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(items(rs[1]))), JSON.parse(JSON.stringify(items(rs[0]))),
    'la consulta movió el pedido');
});

await t('B25. consulta + orden: sólo lo ordenado puede mutar', async () => {
  assert.equal(esConsultaPura({ intenciones: ['CONSULTA_PRODUCTO'], texto: 'que licuados tienen y ponme uno de fresa' }), false);
  assert.equal(esConsultaPura({ intenciones: ['CONSULTA_PRODUCTO'], texto: 'que licuados tienen?' }), true);
});

await t('B28. repetir el nombre con un modificador NO crea línea nueva', async () => {
  const rs = await conversar([
    { cliente: 'Quiero chilaquiles suizos', borrador: R1 },
    { cliente: 'los chilaquiles con huevo estrellado',
      borrador: { items: [it('chilaquiles con huevo estrellado')] } }]);
  assert.equal(items(rs[1]).length, 1, `${items(rs[1]).length} renglones`);
  assert.equal(linea(rs[1]).lid, linea(rs[0]).lid, 'cambió el lid');
});

await t('B29. «agrégame otros chilaquiles» SÍ crea línea nueva', async () => {
  assert.equal(pideOtraUnidad('agrégame otros chilaquiles'), true);
  assert.equal(pideOtraUnidad('dos chilaquiles más'), true);
  assert.equal(pideOtraUnidad('los chilaquiles con huevo'), false);
  const uno = { items: [{ lid: 'L1', nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [], notas: '' }] };
  const r = resolverObjetivo({
    catalogo: CARTA, carrito: uno, contexto: { foco: 'L1' }, intenciones: ['AGREGAR_PRODUCTO'],
    nombrePropuesto: 'chilaquiles', referencia: null, esAlta: true,
  });
  assert.equal(r.lid, null, `«otro» no creó renglón: ${r.motivo}`);

  // ── Y EL CABLE ENTRE LAS DOS MITADES ───────────────────────────────────
  //
  // Arriba se prueba el detector por un lado y la regla por el otro, pero
  // pasándole `esAlta: true` a mano. Con eso, cortar el cable —que el
  // compilador le PREGUNTE al texto del cliente si pide otra unidad— no rompía
  // nada: la mordida Q13 («nunca hay alta») dejaba la suite entera en verde.
  // Este turno completo sí lo recorre.
  const rs = await conversar([
    { cliente: 'Quiero chilaquiles suizos', borrador: R1 },
    { cliente: 'agrégame otros chilaquiles suizos', borrador: { items: [it('chilaquiles suizos')] } }]);
  assert.equal(items(rs[1]).length, 2, `«otros» no abrió renglón: ${items(rs[1]).length}`);
  assert.notEqual(items(rs[1])[1].lid, items(rs[1])[0].lid, 'el segundo renglón repitió el lid del primero');
});

await t('B30. el estado heredado no se marca como dicho en el turno actual', async () => {
  const rs = await conversar([
    { cliente: 'Quiero chilaquiles suizos', borrador: R1 },
    { cliente: 'Con frijolitos', borrador: R2 }]);
  const aut = rs[1].metricas?.autorizado || rs[1].autorizado || [];
  assert(!aut.some((x) => String(x).includes('articulo')),
    `T2 marcó el artículo como dicho en este turno: ${JSON.stringify(aut)}`);
});

// ── X21, en su propio terreno: el nombre explícito le gana al foco ───────
await t('X21a/c. con otro producto nombrado, el foco NO recibe la cantidad', async () => {
  const uno = { items: [{ lid: 'L1', nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [], notas: '' }] };
  const r = resolverObjetivo({
    catalogo: CARTA, carrito: uno, contexto: { foco: 'L1' }, intenciones: ['CAMBIAR_CANTIDAD'],
    nombrePropuesto: 'Licuado de fresa', referencia: { resuelta: true, lids: ['L1'] },
  });
  assert.equal(r.lid, null, `la referencia se aplicó a otro producto: ${r.motivo}`);
  assert.equal(r.motivo, 'nombre_explicito_gana_al_foco', r.motivo);
  // Y cuando SÍ habla del mismo, la referencia manda.
  const mismo = resolverObjetivo({
    catalogo: CARTA, carrito: uno, contexto: { foco: 'L1' }, intenciones: ['CAMBIAR_CANTIDAD'],
    nombrePropuesto: 'chilaquiles', referencia: { resuelta: true, lids: ['L1'] },
  });
  assert.equal(mismo.lid, 'L1', mismo.motivo);
});

// ── B31 · UN ADAPTADOR NO ENSUCIA LO QUE LE PRESTAN ─────────────────────
//
// `compilarTurno` recibe estructuras que NO son suyas: el carrito vivo, el
// catálogo del negocio —compartido entre conversaciones—, los pendientes y el
// borrador del modelo. Si las muta, el daño no aparece aquí: aparece en otro
// turno, en otra conversación, o en el camino legacy que nunca pidió nada de
// esto. Un `.sort()` sobre un array recibido basta para eso.
//
// Se comprueba por comparación total antes/después. La prueba existe para que
// una mordida pueda tumbarla: sin ella, «es puro» sería sólo una afirmación.
await t('B31. no muta ninguna de las estructuras que recibe', async () => {
  // Todas las colecciones llegan con DOS elementos y en un orden que no es el
  // alfabético: con una sola línea y una sola propuesta, un `sort()` o un
  // `reverse()` en el sitio no se vería, y la mordida Q17 —mutar lo que se
  // recibe— pasaría inadvertida.
  const carrito = { items: [
    { lid: 'L1', nombre: 'Chilaquiles Sencillos', id: 85, cantidad: 1,
      modificadores: [grupo('Salsa', 'Suiza', 'Roja')], notas: '' },
    { lid: 'L2', nombre: 'Licuado de fresa', id: 200, cantidad: 2, modificadores: [], notas: '' },
  ], datos: {} };
  const borrador = { items: [it('chilaquiles con chipotle'), it('licuado de platano')] };
  const pendientes = [
    { tipo: 'opcion_ambigua', grupo: 'Guarniciones', clave: 'k',
      candidatos: ['Frijolitos naturales', 'Frijolitos con chorizo'] },
    { tipo: 'opcion_ambigua', grupo: 'Salsa', clave: 'a', candidatos: ['Verde', 'Mole'] },
  ];
  const contexto = { foco: 'L1', pendientes };
  const base = [
    { accion: 'agregar', lid: null, campo: null, valorAnterior: null,
      valorNuevo: { nombre: 'chilaquiles con chipotle', cantidad: 1, modificadores: [], notas: '' },
      evidencia: 'también chipotle' },
    { accion: 'cambiar_cantidad', lid: 'L2', campo: 'cantidad', valorAnterior: 2, valorNuevo: 3,
      evidencia: 'también chipotle' },
  ];

  const copia = (x) => JSON.parse(JSON.stringify(x));
  const antes = {
    carrito: copia(carrito), borrador: copia(borrador), pendientes: copia(pendientes),
    contexto: copia(contexto), catalogo: copia(CARTA), base: copia(base),
  };

  compilarTurno({
    catalogo: CARTA, carrito, contexto, borrador, intenciones: ['OTRO'],
    dicho: 'también chipotle', referencia: null, pendientes, propuestasBase: base,
  });

  assert.deepEqual(copia(carrito), antes.carrito, 'mutó el carrito');
  assert.deepEqual(copia(borrador), antes.borrador, 'mutó el borrador del modelo');
  assert.deepEqual(copia(pendientes), antes.pendientes, 'mutó los pendientes');
  assert.deepEqual(copia(contexto), antes.contexto, 'mutó el contexto');
  assert.deepEqual(copia(CARTA), antes.catalogo, 'mutó el CATÁLOGO, que es compartido');
  assert.deepEqual(copia(base), antes.base, 'mutó las propuestas que recibió');
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
