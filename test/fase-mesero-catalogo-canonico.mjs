// ─── EL CLIENTE HABLA; EL CATÁLOGO IDENTIFICA ─────────────────────────────
//
// C1–C19. El estado del pedido sólo puede contener productos, grupos y opciones
// que existan en la carta del negocio — sin exigirle al cliente que diga el
// nombre del POS.
//
// ── El caso que lo originó, en tráfico real ──────────────────────────────
//
// 13-sep, Mapolato Obispado. «Quiero unos chilaquiles» acabó produciendo:
//
//   articulo  "chilaquiles"      tipo  Suizos      acompañamientos  Frijolitos
//   acompañamiento  frijolitos/frijoles con chorizo    proteína  huevo estrellado
//
// Ninguna de esas cinco entidades existe en esa carta. Ninguna prueba lo
// impedía, porque la única pregunta que se hacía era «¿lo dijo el cliente?».
//
// ── Y la mitad que importa igual: que siga siendo genérico ───────────────
//
// C19 corre el MISMO motor contra unas pizzas. Si alguna vez alguien resuelve
// esto con una regla sobre chilaquiles, C19 se cae.
import assert from 'node:assert/strict';
import {
  anclarLinea, anclarPropuestas, mencionesEnProducto, modificadoresCanonicos,
} from '../src/mesero-whatsapp/anclajeAlCatalogo.js';
import { atenderTurno } from '../src/mesero-whatsapp/meseroDigital.js';
import { loQueFalta } from '../src/mesero-whatsapp/faseConversacional.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

// ── DOS CARTAS SIN NADA EN COMÚN ─────────────────────────────────────────
const g = (nombre, minimo, maximo, opciones, requerido = true) => ({
  nombre, requerido, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});

// La estructura real de Obispado, leída de producción (nombres reales, mismos
// mínimos y máximos). No hay ninguna regla en el código sobre ella.
const SALSAS = ['Roja', 'Suiza', 'Verde', 'Mole', 'Chipotle'];
const PROTS = ['Huevos Estrellados', 'Huevos Revueltos', 'Pechuga de pollo', 'Chicharron Prensado'];
const GUARNS = ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas a la mexicana', 'Papas con chorizo'];
const CARTA = [
  { id: 1, nombre: 'CHILAQUILES', productos: [
    { id: 11, nombre: 'Chilaquiles Sencillos', precio: 195, disponible: true,
      modificadores: [g('Salsa', 1, 1, SALSAS), g('Proteína', 1, 1, PROTS), g('Guarniciones', 1, 2, GUARNS)] },
    { id: 12, nombre: 'Chilaquiles Mixtos', precio: 205, disponible: true,
      modificadores: [g('Salsa', 1, 2, SALSAS), g('Proteína', 1, 2, PROTS), g('Guarniciones', 1, 2, GUARNS)] },
    { id: 13, nombre: 'Bowl de Chilaquiles', precio: 140, disponible: true,
      modificadores: [g('Salsa', 1, 1, SALSAS), g('Proteína', 1, 1, PROTS)] },
    { id: 14, nombre: 'Combito de Chilaquiles', precio: 195, disponible: true,
      modificadores: [g('Salsa', 1, 1, SALSAS), g('Proteína', 1, 1, PROTS),
        g('Hotcakes o Waffles', 1, 1, ['Hotcakes', 'Waffles']), g('Topping', 1, 1, ['Nutella', 'Cajeta'])] },
  ] },
  { id: 2, nombre: 'BEBIDAS', productos: [
    { id: 21, nombre: 'Licuado de fresa', precio: 60, disponible: true, modificadores: [] },
    { id: 22, nombre: 'Licuado de platano', precio: 60, disponible: true, modificadores: [] },
  ] },
];

// Y una carta que no comparte ni una palabra con la anterior.
const PIZZAS = [
  { id: 1, nombre: 'PIZZAS', productos: [
    { id: 31, nombre: 'Pizza Individual', precio: 120, disponible: true,
      modificadores: [g('Sabor', 1, 1, ['Pepperoni', 'Hawaiana', 'Mexicana', 'Cuatro Quesos'])] },
    // «Mitad y mitad» son DOS mitades: el negocio lo modela con mínimo 2, y eso
    // —y no una regla sobre pizzas— es lo que hace que un solo sabor no sea
    // ésta y dos sabores no sean la individual.
    { id: 32, nombre: 'Pizza Mitad y Mitad', precio: 160, disponible: true,
      modificadores: [g('Sabor', 2, 2, ['Pepperoni', 'Hawaiana', 'Mexicana', 'Cuatro Quesos'])] },
  ] },
  { id: 2, nombre: 'ENTRADAS', productos: [
    { id: 41, nombre: 'Pan de ajo', precio: 55, disponible: true, modificadores: [] },
  ] },
];

const anclar = (catalogo, pista, evidencia = pista) => anclarLinea({ catalogo, nombrePropuesto: pista, evidencia });
const nombres = (r) => r.candidatos.map((c) => c.nombre).sort();
const grupoDe = (r, grupo) => r.grupos.find((m) => m.grupo.toLowerCase() === grupo.toLowerCase()) || null;

// ═══════════════════════════════════════════════════════════════════════════
// C1–C6 · RESOLUCIÓN 0 / 1 / N
// ═══════════════════════════════════════════════════════════════════════════

await t('C1. mención exacta de un único producto → se resuelve', async () => {
  const r = anclar(CARTA, 'Licuado de fresa');
  assert.equal(r.estado, 'resuelto', JSON.stringify(r));
  assert.equal(r.producto.nombre, 'Licuado de fresa');
  assert.equal(r.producto.id, 21, 'no viaja el id real del catálogo');
});

await t('C2. mención genérica con N compatibles → candidatos, no elección', async () => {
  const r = anclar(CARTA, 'chilaquiles');
  assert.equal(r.estado, 'ambiguo');
  assert.deepEqual(nombres(r),
    ['Bowl de Chilaquiles', 'Chilaquiles Mixtos', 'Chilaquiles Sencillos', 'Combito de Chilaquiles']);
  assert.equal(r.producto, null, 'eligió uno por su cuenta');
});

await t('C3. cero candidatos → no se inventa un producto', async () => {
  const r = anclar(CARTA, 'sushi');
  assert.equal(r.estado, 'sin_candidatos');
  assert.equal(r.producto, null);
  assert.deepEqual(r.candidatos, []);
});

await t('C4. las opciones del cliente reducen los candidatos', async () => {
  // «frijolitos» es una guarnición: Bowl y Combito no tienen ese grupo.
  const r = anclar(CARTA, 'chilaquiles', 'chilaquiles con frijolitos');
  assert.equal(r.estado, 'ambiguo');
  assert.deepEqual(nombres(r), ['Chilaquiles Mixtos', 'Chilaquiles Sencillos']);
  assert(r.descartados.some((d) => d.nombre === 'Bowl de Chilaquiles'), JSON.stringify(r.descartados));
});

await t('C5. cuando las restricciones dejan exactamente uno, se resuelve solo', async () => {
  const r = anclar(CARTA, 'chilaquiles', 'chilaquiles suizos con chipotle');
  assert.equal(r.estado, 'resuelto', JSON.stringify(nombres(r)));
  assert.equal(r.producto.nombre, 'Chilaquiles Mixtos');
  assert.equal(r.motivo, 'unico_compatible');
});

await t('C6. cuando dejan varios, se pregunta', async () => {
  const r = anclar(CARTA, 'chilaquiles', 'chilaquiles suizos');
  assert.equal(r.estado, 'ambiguo');
  assert(r.candidatos.length >= 2, 'eligió con una sola salsa, que no separa nada');
});

// ═══════════════════════════════════════════════════════════════════════════
// C7–C10 · GRUPOS Y OPCIONES CANÓNICOS
// ═══════════════════════════════════════════════════════════════════════════

const propuestaDelModelo = (nombre, modificadores) => ({
  accion: 'agregar', lid: null, campo: null, valorAnterior: null,
  valorNuevo: { nombre, cantidad: 1, modificadores, notas: '' }, evidencia: '',
});

await t('C7. un grupo inventado por el modelo no se almacena nunca', async () => {
  // Exactamente lo que produjo el modelo en producción.
  const r = anclarPropuestas({
    catalogo: CARTA, carrito: { items: [] }, evidencia: 'chilaquiles sencillos suizos',
    propuestas: [propuestaDelModelo('Chilaquiles Sencillos', [
      { grupo: 'tipo', opciones: ['Suizos'] },
      { grupo: 'proteína', opciones: ['huevo estrellado'] },
      { grupo: 'acompañamiento', opciones: ['frijoles con chorizo'] },
    ])],
  });
  assert.equal(r.propuestas.length, 1, JSON.stringify(r));
  const grupos = r.propuestas[0].valorNuevo.modificadores.map((m) => m.grupo).sort();
  assert.deepEqual(grupos, ['Guarniciones', 'Proteína', 'Salsa'],
    `se guardó un grupo que no existe en la carta: ${JSON.stringify(grupos)}`);
  for (const m of r.propuestas[0].valorNuevo.modificadores) {
    assert(!['tipo', 'acompañamiento', 'acompañamientos'].includes(m.grupo.toLowerCase()),
      `sobrevivió el nombre del modelo: ${m.grupo}`);
  }
});

await t('C7b. una opción que no existe en la carta se cae', async () => {
  const r = anclarPropuestas({
    catalogo: CARTA, carrito: { items: [] }, evidencia: 'chilaquiles con unicornio',
    propuestas: [propuestaDelModelo('Chilaquiles Sencillos', [{ grupo: 'Salsa', opciones: ['Unicornio'] }])],
  });
  assert.deepEqual(r.propuestas[0].valorNuevo.modificadores, []);
  assert(r.descartados.some((d) => d.opcion === 'Unicornio' && d.motivo === 'no_existe'), JSON.stringify(r.descartados));
});

await t('C8. una opción genérica con dos reales queda ambigua, no elegida', async () => {
  const r = anclar(CARTA, 'Chilaquiles Sencillos', 'Chilaquiles Sencillos con frijolitos');
  assert.equal(r.estado, 'resuelto');
  const guarn = grupoDe(r, 'Guarniciones');
  assert(guarn, 'no vio el grupo');
  assert.deepEqual(guarn.elegidas, [], 'eligió una de las dos de frijolitos');
  assert.deepEqual(guarn.ambiguas.sort(), ['Frijolitos con chorizo', 'Frijolitos naturales']);
  assert.deepEqual(modificadoresCanonicos(r).filter((m) => m.grupo === 'Guarniciones'), [],
    'una ambigüedad no puede viajar como selección');
});

await t('C9. la respuesta posterior resuelve la opción exacta', async () => {
  const r = anclar(CARTA, 'Chilaquiles Sencillos', 'Chilaquiles Sencillos con frijolitos los frijoles con chorizo');
  const guarn = grupoDe(r, 'Guarniciones');
  assert.deepEqual(guarn.elegidas, ['Frijolitos con chorizo']);
  assert.deepEqual(guarn.ambiguas, []);
});

await t('C10. singular y plural no crean dos grupos', async () => {
  const r = anclarPropuestas({
    catalogo: CARTA, carrito: { items: [] }, evidencia: 'con frijoles con chorizo',
    propuestas: [propuestaDelModelo('Chilaquiles Sencillos', [
      { grupo: 'acompañamiento', opciones: ['frijoles con chorizo'] },
      { grupo: 'acompañamientos', opciones: ['Frijolitos con chorizo'] },
    ])],
  });
  const mods = r.propuestas[0].valorNuevo.modificadores;
  assert.equal(mods.length, 1, `se crearon ${mods.length} grupos: ${JSON.stringify(mods)}`);
  assert.equal(mods[0].grupo, 'Guarniciones');
  assert.deepEqual(mods[0].opciones, ['Frijolitos con chorizo']);
});

// ═══════════════════════════════════════════════════════════════════════════
// C11–C13 · EN LA CONVERSACIÓN COMPLETA
// ═══════════════════════════════════════════════════════════════════════════

const conversar = async (guion, catalogo = CARTA) => {
  let contexto = null; let carrito = null;
  const fuera = [];
  for (const paso of guion) {
    const r = await atenderTurno({
      negocioId: 'n-cat', conversacionId: 'c-cat', mensaje: paso.cliente,
      catalogo, requierePago: false, contextoGuardado: contexto, carrito,
      proponer: async () => paso.borrador ?? null,
    });
    contexto = JSON.parse(JSON.stringify(r.contexto));
    carrito = r.carrito;
    fuera.push(r);
  }
  return fuera;
};
const it = (nombre, modificadores = []) => ({ nombre, cantidad: 1, modificadores, notas: '' });

await t('C11. una consulta sobre otro producto no altera la línea', async () => {
  const rs = await conversar([
    { cliente: 'Quiero unos Chilaquiles Sencillos', borrador: { items: [it('Chilaquiles Sencillos')] } },
    { cliente: '¿Qué licuados tienen?', borrador: null },
  ]);
  assert.deepEqual(rs[1].carrito.items.map((i) => i.nombre), ['Chilaquiles Sencillos']);
  assert(rs[1].consulta, 'no entendió la consulta');
});

await t('C12. un producto sin identidad suficiente NO pasa al pedido', async () => {
  const [r] = await conversar([
    { cliente: 'Quiero unos chilaquiles', borrador: { items: [it('chilaquiles')] } },
  ]);
  assert.deepEqual(r.carrito.items, [], `entró una línea libre: ${JSON.stringify(r.carrito.items)}`);
  const amb = r.aclaraciones.find((a) => a.tipo === 'producto_ambiguo');
  assert(amb, `no se preguntó cuál: ${JSON.stringify(r.aclaraciones)}`);
  assert.equal(amb.candidatos.length, 4);
});

await t('C13. no se pregunta la modalidad mientras una línea siga sin identidad', async () => {
  // Con el carrito VACÍO la pregunta tampoco sale, pero por otro motivo (no hay
  // pedido), así que ese caso no prueba la regla. El que la prueba es este: un
  // renglón ya resuelto —hay pedido— y otro todavía sin identificar.
  const rs = await conversar([
    { cliente: 'Un Licuado de fresa', borrador: { items: [it('Licuado de fresa')] } },
    { cliente: 'Y unos chilaquiles', borrador: { items: [it('Licuado de fresa'), it('chilaquiles')] } },
  ]);
  const r = rs[1];
  assert.equal(r.carrito.items.length, 1, `entró una línea sin identidad: ${JSON.stringify(r.carrito.items)}`);
  assert(r.aclaraciones.some((a) => a.tipo === 'producto_ambiguo'), 'no quedó la pregunta de identidad');
  assert(!r.falta.includes('modalidad'),
    `preguntó logística con una línea sin resolver: ${JSON.stringify(r.falta)}`);
  assert(!r.falta.includes('pago'), JSON.stringify(r.falta));
  assert(String(r.siguiente || '').startsWith('producto:'),
    `lo siguiente que preguntaría es ${r.siguiente}`);

  // Y la regla, aislada: con pedido y con identidad pendiente, no hay logística.
  const falta = loQueFalta({
    carrito: { items: [{ lid: 'L1', nombre: 'Licuado de fresa' }] }, datos: {},
    aclaraciones: [{ tipo: 'producto_ambiguo', termino: 'chilaquiles', candidatos: ['a', 'b'] }],
  });
  assert(!falta.includes('modalidad'), JSON.stringify(falta));
  assert(falta.some((f) => f.startsWith('producto:')), JSON.stringify(falta));
});

// ═══════════════════════════════════════════════════════════════════════════
// C14–C17 · CARDINALIDAD Y RECLASIFICACIÓN
// ═══════════════════════════════════════════════════════════════════════════

await t('C14. una salsa → una presentación que admite una salsa', async () => {
  const r = anclar(CARTA, 'chilaquiles', 'chilaquiles suizos');
  const compatibles = r.estado === 'resuelto' ? [r.producto] : r.candidatos;
  for (const c of compatibles) {
    const salsa = c.grupos.find((x) => x.nombre === 'Salsa');
    assert(salsa.maximo >= 1, `${c.nombre} no admite ni una salsa`);
  }
  assert.equal(grupoDe(r, 'Salsa').elegidas[0], 'Suiza');
});

await t('C15. dos salsas → sólo la presentación que admite dos', async () => {
  const r = anclar(CARTA, 'chilaquiles', 'chilaquiles suizos con chipotle');
  assert.equal(r.estado, 'resuelto');
  assert.equal(r.producto.nombre, 'Chilaquiles Mixtos');
  assert.deepEqual(grupoDe(r, 'Salsa').elegidas.sort(), ['Chipotle', 'Suiza']);
  // Y las descartadas lo fueron por cardinalidad, no por casualidad.
  assert(r.descartados.some((d) => d.nombre === 'Chilaquiles Sencillos' && d.motivo.startsWith('cardinalidad')),
    JSON.stringify(r.descartados));
});

await t('C16. una línea con dos salsas SE RECLASIFICA a la presentación que las admite', async () => {
  // La mitad del recorrido que sí está cerrada: dado un renglón que YA tiene
  // las dos salsas, el motor lo reclasifica solo, conservando lid y cantidad.
  const linea = { lid: 'L1', nombre: 'Chilaquiles Sencillos', cantidad: 2, notas: 'sin cebolla',
    modificadores: [{ grupo: 'Salsa', opciones: ['Suiza', 'Chipotle'] }] };
  const a = anclarLinea({
    catalogo: CARTA, nombrePropuesto: linea.nombre,
    evidencia: `${linea.nombre} Suiza Chipotle`, ampliarFamilia: true,
  });
  assert.equal(a.estado, 'resuelto', JSON.stringify(a.candidatos?.map((c) => c.nombre)));
  assert.equal(a.producto.nombre, 'Chilaquiles Mixtos');
  assert(a.descartados.some((d) => d.nombre === 'Chilaquiles Sencillos' && d.motivo.startsWith('cardinalidad')),
    'no se descartó la presentación de una salsa por cardinalidad');
});

await t('C16b. PENDIENTE: la segunda salsa no sobrevive al reconciliador, y sin ella no hay qué reclasificar', async () => {
  // ESTA PRUEBA FALLA A PROPÓSITO. Documenta el único tramo del mandato que no
  // quedó cerrado, y falla en el sitio exacto en el que está el problema.
  //
  // «También chipotle» llega como `cambiar_modificador` con las dos salsas. El
  // reconciliador conserva sólo la que el cliente nombró EN ESTE TURNO, porque
  // un grupo de modificadores se sustituye, no se acumula. Con una sola salsa
  // en la línea, la reclasificación de C16 no tiene nada que hacer: una salsa
  // es compatible con las cuatro presentaciones.
  //
  // Acumular opciones dentro de un grupo entre turnos es una regla del
  // RECONCILIADOR (`src/orders/carritoDelPedido.js`), que es componente
  // protegido y otro trabajo. Desde la capa de anclaje no se puede: se probó
  // mandando la unión con lo ya puesto y el reconciliador la vuelve a filtrar,
  // con razón — no es él quien está mal.
  const rs = await conversar([
    { cliente: 'Quiero unos Chilaquiles Sencillos suizos',
      borrador: { items: [it('Chilaquiles Sencillos', [{ grupo: 'Salsa', opciones: ['Suiza'] }])] } },
    { cliente: 'También chipotle',
      borrador: { items: [it('Chilaquiles Sencillos', [{ grupo: 'Salsa', opciones: ['Suiza', 'Chipotle'] }])] } },
  ]);
  const despues = rs[1].carrito.items[0];
  const salsas = (despues.modificadores || []).flatMap((m) => m.opciones).sort();
  assert.deepEqual(salsas, ['Chipotle', 'Suiza'],
    `el reconciliador dejó ${JSON.stringify(salsas)}: sin las dos salsas no hay reclasificación posible`);
  assert.equal(despues.nombre, 'Chilaquiles Mixtos');
});

await t('C17. quitar la segunda salsa puede reclasificar en sentido inverso', async () => {
  // El catálogo NO lo determina inequívocamente: con una salsa, cuatro
  // presentaciones siguen siendo compatibles. Así que NO se reclasifica sola, y
  // eso es lo correcto: elegir una sería inventar.
  const r = anclar(CARTA, 'Chilaquiles Mixtos', 'Chilaquiles Mixtos suizos');
  assert.equal(r.estado, 'resuelto');
  assert.equal(r.producto.nombre, 'Chilaquiles Mixtos',
    'se cambió de presentación sin que el catálogo lo obligara');
});

// ═══════════════════════════════════════════════════════════════════════════
// C18–C19 · DOS LÍNEAS, Y OTRO RESTAURANTE
// ═══════════════════════════════════════════════════════════════════════════

await t('C18. dos líneas distintas no se mezclan', async () => {
  const [r] = await conversar([
    { cliente: 'Un Licuado de fresa y un Licuado de platano',
      borrador: { items: [it('Licuado de fresa'), it('Licuado de platano')] } },
  ]);
  assert.deepEqual(r.carrito.items.map((i) => i.nombre).sort(),
    ['Licuado de fresa', 'Licuado de platano']);
  assert.equal(new Set(r.carrito.items.map((i) => i.lid)).size, 2, 'comparten lid');
});

await t('C19. el MISMO motor, con una carta que no comparte una palabra', async () => {
  // Si alguien resuelve esto con una regla sobre chilaquiles, esta prueba cae.
  const uno = anclar(PIZZAS, 'pizza', 'quiero una pizza de pepperoni');
  assert.equal(uno.estado, 'resuelto', JSON.stringify(nombres(uno)));
  assert.equal(uno.producto.nombre, 'Pizza Individual');
  assert.deepEqual(grupoDe(uno, 'Sabor').elegidas, ['Pepperoni']);

  const dos = anclar(PIZZAS, 'pizza', 'quiero una pizza de pepperoni y hawaiana');
  assert.equal(dos.estado, 'resuelto', JSON.stringify(nombres(dos)));
  assert.equal(dos.producto.nombre, 'Pizza Mitad y Mitad');
  assert.deepEqual(grupoDe(dos, 'Sabor').elegidas.sort(), ['Hawaiana', 'Pepperoni']);

  // Y las tres respuestas del 0/1/N, en esta carta.
  assert.equal(anclar(PIZZAS, 'Pan de ajo').estado, 'resuelto');
  assert.equal(anclar(PIZZAS, 'tacos').estado, 'sin_candidatos');
});

await t('C19b. y reclasifica igual en la otra carta: dos sabores → Mitad y Mitad', async () => {
  const a = anclarLinea({
    catalogo: PIZZAS, nombrePropuesto: 'Pizza Individual',
    evidencia: 'Pizza Individual Pepperoni Hawaiana', ampliarFamilia: true,
  });
  assert.equal(a.estado, 'resuelto');
  assert.equal(a.producto.nombre, 'Pizza Mitad y Mitad',
    'el mismo motor que reclasifica chilaquiles no reclasifica pizzas');
  // Y al revés: un solo sabor NO la convierte en mitad y mitad.
  const uno = anclarLinea({
    catalogo: PIZZAS, nombrePropuesto: 'Pizza Individual',
    evidencia: 'Pizza Individual Pepperoni', ampliarFamilia: true,
  });
  assert.equal(uno.producto?.nombre, 'Pizza Individual', JSON.stringify(uno.candidatos?.map((c) => c.nombre)));
});

// ═══════════════════════════════════════════════════════════════════════════
// C21–C23 · EL GRUPO INVENTADO NO ES UNA PUERTA
// ═══════════════════════════════════════════════════════════════════════════
//
// Canonizar el grupo y preguntar por lo que no se distingue son dos garantías
// que existían por separado y se anulaban entre sí: el guardia de la ambigüedad
// buscaba las hermanas de la opción por el nombre de grupo QUE ESCRIBIÓ EL
// MODELO, y con «tipo» o «acompañamiento» no encontraba ninguna. Sin hermanas
// no hay empate, y sin empate no hay pregunta: la opción entraba sola. Un paso
// después, el anclaje le ponía su grupo real y la dejaba en el pedido.

await t('C21. «con frijolitos» con el grupo INVENTADO por el modelo sigue preguntando', async () => {
  const rs = await conversar([
    { cliente: 'Quiero unos Chilaquiles Sencillos suizos',
      borrador: { items: [it('Chilaquiles Sencillos', [{ grupo: 'tipo', opciones: ['suiza'] }])] } },
    { cliente: 'Con frijolitos',
      borrador: { items: [it('Chilaquiles Sencillos', [{ grupo: 'tipo', opciones: ['suiza'] },
        { grupo: 'acompañamiento', opciones: ['Frijolitos naturales'] }])] } },
  ]);
  const puestas = (rs[1].carrito.items[0].modificadores || [])
    .filter((m) => /guarnicion/i.test(m.grupo)).flatMap((m) => m.opciones);
  assert.deepEqual(puestas, [], `eligió por el cliente: ${JSON.stringify(puestas)}`);
  const amb = (rs[1].aclaraciones || []).filter((a) => a.tipo === 'opcion_ambigua');
  assert.equal(amb.length, 1, JSON.stringify(rs[1].aclaraciones));
  assert.deepEqual(amb[0].candidatos.slice().sort(), ['Frijolitos con chorizo', 'Frijolitos naturales'],
    JSON.stringify(amb[0].candidatos));
});

await t('C22. y con el grupo inventado, lo YA elegido tampoco se pierde al sumar', async () => {
  // La otra mitad del mismo error: «lo que ya está puesto» se buscaba en el
  // renglón por el nombre de grupo del modelo. Con «tipo», la Suiza que sí
  // estaba puesta no se encontraba, se trataba como elección nueva, y «también
  // chipotle» —que no dice «suiza»— la tumbaba.
  const rs = await conversar([
    { cliente: 'Quiero unos Chilaquiles Sencillos suizos',
      borrador: { items: [it('Chilaquiles Sencillos', [{ grupo: 'tipo', opciones: ['suiza'] }])] } },
    { cliente: 'También chipotle',
      borrador: { items: [it('Chilaquiles Sencillos', [{ grupo: 'tipo', opciones: ['suiza', 'chipotle'] }])] } },
  ]);
  const salsas = (rs[1].carrito.items[0].modificadores || [])
    .filter((m) => m.grupo === 'Salsa').flatMap((m) => m.opciones).sort();
  assert.deepEqual(salsas, ['Chipotle', 'Suiza'], `quedó ${JSON.stringify(salsas)}`);
});

await t('C23. un renglón NUEVO se mide con la misma vara que uno que ya existe', async () => {
  // El filtro de ambigüedad sólo miraba los cambios sobre líneas existentes.
  // En un renglón nuevo nadie comprobaba que la palabra separase la opción de
  // sus hermanas, y la que el modelo hubiera escrito entraba tal cual.
  const rs = await conversar([
    { cliente: 'Quiero unos Chilaquiles Sencillos con frijolitos',
      borrador: { items: [it('Chilaquiles Sencillos', [{ grupo: 'acompañamiento', opciones: ['Frijolitos naturales'] }])] } },
  ]);
  const puestas = (rs[0].carrito.items[0]?.modificadores || [])
    .filter((m) => /guarnicion/i.test(m.grupo)).flatMap((m) => m.opciones);
  assert.deepEqual(puestas, [], `entró sin que el cliente la distinguiera: ${JSON.stringify(puestas)}`);
  const amb = (rs[0].aclaraciones || []).filter((a) => a.tipo === 'opcion_ambigua');
  assert.equal(amb.length, 1, JSON.stringify(rs[0].aclaraciones));
  assert.deepEqual(amb[0].candidatos.slice().sort(), ['Frijolitos con chorizo', 'Frijolitos naturales'],
    JSON.stringify(amb[0].candidatos));
});

// ── El módulo no sabe de ningún restaurante ──────────────────────────────
await t('C20. el resolver no menciona ningún producto, grupo ni negocio', async () => {
  const { readFileSync } = await import('node:fs');
  const fuente = readFileSync(new URL('../src/mesero-whatsapp/anclajeAlCatalogo.js', import.meta.url), 'utf8');
  const codigo = fuente.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const palabra of ['chilaquil', 'mapolato', 'frijol', 'suiza', 'chipotle', 'pizza', 'pepperoni',
    'salsa', 'guarnicion', 'proteina', 'licuado', 'obispado']) {
    assert(!new RegExp(palabra, 'i').test(codigo),
      `el resolver menciona "${palabra}" fuera de los comentarios: deja de ser genérico`);
  }
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
