// UN `lid` IDENTIFICA EL OBJETIVO; NO ES EVIDENCIA PARA MODIFICARLO.
//
// Auditoría en frío de toda la autoridad que se le agregó a `reconciliar` desde
// `203b059`. Cada capacidad nueva tiene aquí su prueba de que NO alcanza por sí
// sola para cambiar el pedido:
//
//   emparejamiento por lid   señala a quién, no autoriza qué
//   quitarPorLid             sigue exigiendo el verbo de quitar, de este turno
//   atribuidoPorLid          sigue exigiendo el número, en el mensaje
//   dichoDelTurno/Ciclo      solo puede RECORTAR lo que el cliente escribió
//   evidenciaAceptada        alcanza al renglón, no a sus campos
//   hermanos+reciennombrados endurece; no puede aflojar
//
// Todas las pruebas llaman a `reconciliar` DIRECTAMENTE, con las opciones a
// mano, porque lo que se audita es el contrato de la función y no la buena
// educación de su único llamador de hoy.
import assert from 'node:assert/strict';

const carrito = await import('../src/orders/carritoDelPedido.js');
const { reconciliar, carritoVacio } = carrito;

let ok = 0, fail = 0; const fallos = [];
function t(nombre, fn) {
  try { fn(); ok++; console.log(`  OK  ${nombre}`); }
  catch (e) { fail++; fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}

const it = (lid, nombre, extra = {}) => ({ lid, nombre, cantidad: 1, modificadores: [], notas: '', ...extra });
const mod = (grupo, ...opciones) => ({ grupo, opciones });
const car = (...items) => ({ items, datos: {} });
const porLid = (c, lid) => (c.items || []).find((i) => i.lid === lid);
const nombres = (c) => (c.items || []).map((i) => i.nombre);
const opcionesDe = (i) => (i?.modificadores || []).flatMap((m) => m.opciones || []).sort();

// ── EL EMPAREJAMIENTO POR `lid` ─────────────────────────────────────────────

t('A1. un lid correcto NO basta: el cambio sigue necesitando evidencia', () => {
  // El lid apunta bien. El modelo propone cantidad 3 y una guarnición. El
  // cliente no dijo ni el número ni la guarnición.
  const previo = car(it('L1', 'Chilaquiles'), it('L2', 'Hotcakes'));
  const { carrito: c, cambios } = reconciliar(previo, {
    items: [{ lid: 'L1', nombre: 'Chilaquiles', cantidad: 3, modificadores: [mod('Guarnicion', 'Papas')] }],
  }, { mensaje: 'gracias', textoCiclo: 'unos chilaquiles y unos hotcakes gracias' });

  assert.equal(porLid(c, 'L1').cantidad, 1, 'el lid autorizó una cantidad por sí solo');
  assert.deepEqual(opcionesDe(porLid(c, 'L1')), [], 'el lid autorizó una guarnición por sí sola');
  assert.equal(cambios.congelados.length + cambios.sinRespaldo.length > 0, true, 'no quedó traza del rechazo');
});

t('A2. UN LID EQUIVOCADO NO REDIRIGE UN CAMBIO AUTORIZADO', () => {
  // Este es el caso que motivó la corrección. El cliente habla de sus
  // chilaquiles; la propuesta lleva el lid de los hotcakes. Antes, el
  // emparejamiento forzado renombraba los hotcakes a «Chilaquiles» —porque el
  // cliente sí había dicho esa palabra— y el platillo desaparecía.
  const previo = car(it('L1', 'Chilaquiles'), it('L2', 'Hotcakes'));
  const { carrito: c } = reconciliar(previo, {
    items: [{ lid: 'L2', nombre: 'Chilaquiles', modificadores: [mod('Extras', 'sin cebolla')] }],
  }, { mensaje: 'los chilaquiles sin cebolla', textoCiclo: 'unos chilaquiles y unos hotcakes los chilaquiles sin cebolla' });

  assert.equal(nombres(c).sort().join(','), 'Chilaquiles,Hotcakes', `se perdió un platillo: ${nombres(c)}`);
  assert.equal(porLid(c, 'L2').nombre, 'Hotcakes', 'el lid equivocado renombró la línea del cliente');
  // Y el cambio sí llegó a quien le tocaba, por parecido, como siempre.
  assert.deepEqual(opcionesDe(porLid(c, 'L1')), ['sin cebolla']);
});

t('A3. con dos renglones IGUALES, el lid sí manda (es para lo que existe)', () => {
  const previo = car(it('L1', 'Coca Cola'), it('L2', 'Coca Cola'));
  const { carrito: c } = reconciliar(previo, {
    items: [it('L1', 'Coca Cola'), { lid: 'L2', nombre: 'Coca Cola', notas: 'sin hielo' }],
  }, { mensaje: 'la segunda sin hielo', textoCiclo: 'dos cocas la segunda sin hielo' });

  assert.equal(porLid(c, 'L1').notas, '', 'la nota se aplicó al renglón equivocado');
  assert.equal(porLid(c, 'L2').notas, 'sin hielo');
});

t('A4. un lid inexistente se ignora y el artículo cae al camino normal', () => {
  const previo = car(it('L1', 'Chilaquiles'));
  const { carrito: c } = reconciliar(previo, {
    items: [{ lid: 'NO-EXISTE', nombre: 'Chilaquiles', cantidad: 2 }],
  }, { mensaje: 'mejor dos', textoCiclo: 'unos chilaquiles mejor dos' });
  // Emparejó por parecido con L1, y la cantidad pasó porque el cliente dijo dos
  // y no hay hermanos que compitan.
  assert.equal(c.items.length, 1, `se duplicó el renglón: ${nombres(c)}`);
  assert.equal(c.items[0].lid, 'L1', 'perdió la identidad del renglón');
  assert.equal(c.items[0].cantidad, 2);
});

t('A5. un lid inexistente con un producto nuevo sigue exigiendo que lo nombren', () => {
  const previo = car(it('L1', 'Chilaquiles'));
  const { carrito: c, cambios } = reconciliar(previo, {
    items: [it('L1', 'Chilaquiles'), { lid: 'FANTASMA', nombre: 'Coca Cola', cantidad: 1 }],
  }, { mensaje: 'para recoger', textoCiclo: 'unos chilaquiles para recoger' });
  assert.deepEqual(nombres(c), ['Chilaquiles'], 'un lid inventado metió un producto al pedido');
  assert(cambios.sinRespaldo.some((s) => s.nombre === 'Coca Cola'));
});

// ── quitarPorLid ────────────────────────────────────────────────────────────

t('A6. quitarPorLid sin verbo de quitar NO quita nada', () => {
  const previo = car(it('L1', 'Chilaquiles'), it('L2', 'Hotcakes'));
  const { carrito: c } = reconciliar(previo, { items: [it('L1', 'Chilaquiles'), it('L2', 'Hotcakes')] },
    { mensaje: 'para recoger', textoCiclo: 'unos chilaquiles y unos hotcakes para recoger',
      quitarPorLid: ['L2'] });
  assert.equal(c.items.length, 2, 'un lid quitó un platillo sin que el cliente pidiera quitarlo');
});

t('A7. quitarPorLid con el verbo en un turno VIEJO tampoco quita', () => {
  // El verbo está en el ciclo, no en este turno. Quitar es un acto de ahora.
  const previo = car(it('L1', 'Chilaquiles'), it('L2', 'Hotcakes'));
  const { carrito: c } = reconciliar(previo, { items: [it('L1', 'Chilaquiles'), it('L2', 'Hotcakes')] },
    { mensaje: 'y para recoger',
      textoCiclo: 'quita los hotcakes ... perdon no, dejalos ... y para recoger',
      quitarPorLid: ['L2'] });
  assert.equal(c.items.length, 2, 'un verbo de hace tres turnos autorizó una baja de ahora');
});

t('A8. quitarPorLid con verbo de ESTE turno sí quita, y lo deja anotado', () => {
  const previo = car(it('L1', 'Chilaquiles'), it('L2', 'Hotcakes'));
  const { carrito: c, cambios } = reconciliar(previo, { items: [it('L1', 'Chilaquiles'), it('L2', 'Hotcakes')] },
    { mensaje: 'quita el otro', textoCiclo: 'unos chilaquiles y unos hotcakes quita el otro',
      quitarPorLid: ['L2'] });
  assert.deepEqual(nombres(c), ['Chilaquiles']);
  assert(cambios.autorizados.some((a) => a.lid === 'L2' && a.via === 'la_referencia_lo_identifica'),
    JSON.stringify(cambios.autorizados));
});

t('A9. quitarPorLid no alcanza a un renglón que este turno cambió', () => {
  // La línea no está intacta: el mismo turno le puso una opción. `quitables`
  // la excluye, y eso vale igual para la vía por referencia.
  const previo = car(it('L1', 'Chilaquiles'), it('L2', 'Hotcakes'));
  const { carrito: c } = reconciliar(previo, {
    items: [it('L1', 'Chilaquiles'), { lid: 'L2', nombre: 'Hotcakes', modificadores: [mod('Extras', 'miel')] }],
  }, { mensaje: 'quitalo, con miel', textoCiclo: 'unos chilaquiles y unos hotcakes quitalo, con miel',
    quitarPorLid: ['L2'] });
  assert.equal(c.items.length, 2, 'se quitó un renglón que el mismo turno estaba cambiando');
});

t('A10. quitarPorLid con un lid inexistente no quita otra cosa en su lugar', () => {
  const previo = car(it('L1', 'Chilaquiles'), it('L2', 'Hotcakes'));
  const { carrito: c } = reconciliar(previo, { items: [it('L1', 'Chilaquiles'), it('L2', 'Hotcakes')] },
    { mensaje: 'quitalo', textoCiclo: 'quitalo', quitarPorLid: ['NO-EXISTE'] });
  assert.equal(c.items.length, 2);
});

t('A11. un «sin cebolla» no habilita quitar la LÍNEA entera por lid', () => {
  // «sin» está en QUITA_OPCION y también en PIDE_QUITAR («sin el/la/los/las»),
  // pero «sin cebolla» no casa con ninguna de esas formas de PIDE_QUITAR.
  const previo = car(it('L1', 'Chilaquiles'), it('L2', 'Hotcakes'));
  const { carrito: c } = reconciliar(previo, { items: [it('L1', 'Chilaquiles'), it('L2', 'Hotcakes')] },
    { mensaje: 'sin cebolla', textoCiclo: 'unos chilaquiles y unos hotcakes sin cebolla',
      quitarPorLid: ['L2'] });
  assert.equal(c.items.length, 2, 'quitar un ingrediente se llevó un platillo entero');
});

// ── atribuidoPorLid ─────────────────────────────────────────────────────────

t('A12. atribuidoPorLid sin el número en el mensaje NO cambia la cantidad', () => {
  const previo = car(it('L1', 'Chilaquiles'), it('L2', 'Hotcakes'));
  const { carrito: c, cambios } = reconciliar(previo, {
    items: [{ lid: 'L1', nombre: 'Chilaquiles', cantidad: 5 }, it('L2', 'Hotcakes')],
  }, { mensaje: 'ese', textoCiclo: 'unos chilaquiles y unos hotcakes ese', atribuidoPorLid: ['L1'] });
  assert.equal(porLid(c, 'L1').cantidad, 1, 'la atribución autorizó un número que nadie dijo');
  assert(cambios.congelados.some((x) => x.campo === 'cantidad'));
});

t('A13. atribuidoPorLid sustituye la atribución, no la comprobación del número', () => {
  const previo = car(it('L1', 'Chilaquiles'), it('L2', 'Hotcakes'));
  // Sin atribución: «mejor dos» no dice de cuál, y con hermanos no pasa.
  const sin = reconciliar(previo, { items: [{ lid: 'L1', nombre: 'Chilaquiles', cantidad: 2 }, it('L2', 'Hotcakes')] },
    { mensaje: 'mejor dos', textoCiclo: 'unos chilaquiles y unos hotcakes mejor dos' });
  assert.equal(porLid(sin.carrito, 'L1').cantidad, 1);
  // Con atribución: la capa de arriba resolvió a cuál, y el número sigue estando.
  const con = reconciliar(previo, { items: [{ lid: 'L1', nombre: 'Chilaquiles', cantidad: 2 }, it('L2', 'Hotcakes')] },
    { mensaje: 'mejor dos', textoCiclo: 'unos chilaquiles y unos hotcakes mejor dos', atribuidoPorLid: ['L1'] });
  assert.equal(porLid(con.carrito, 'L1').cantidad, 2);
  assert.equal(porLid(con.carrito, 'L2').cantidad, 1, 'se contagió al otro renglón');
});

t('A14. atribuidoPorLid no sirve contra una pregunta con números ajenos', () => {
  const previo = car(it('L1', 'Chilaquiles'), it('L2', 'Hotcakes'));
  const { carrito: c } = reconciliar(previo, {
    items: [{ lid: 'L1', nombre: 'Chilaquiles', cantidad: 4 }, it('L2', 'Hotcakes')],
  }, { mensaje: 'Nogal 4, colonia centro', textoCiclo: 'unos chilaquiles y unos hotcakes Nogal 4',
    datoOperativoPendiente: 'direccion', atribuidoPorLid: ['L1'] });
  assert.equal(porLid(c, 'L1').cantidad, 1, 'un número de una dirección se volvió una cantidad');
});

t('A15. atribuidoPorLid solo toca la cantidad, no los modificadores ni la nota', () => {
  const previo = car(it('L1', 'Chilaquiles'), it('L2', 'Hotcakes'));
  const { carrito: c } = reconciliar(previo, {
    items: [{ lid: 'L1', nombre: 'Chilaquiles', cantidad: 2, modificadores: [mod('Salsa', 'Salsa Roja')], notas: 'bien dorados' },
      it('L2', 'Hotcakes')],
  }, { mensaje: 'mejor dos', textoCiclo: 'unos chilaquiles y unos hotcakes mejor dos', atribuidoPorLid: ['L1'] });
  assert.equal(porLid(c, 'L1').cantidad, 2);
  assert.deepEqual(opcionesDe(porLid(c, 'L1')), [], 'la atribución coló un modificador');
  assert.equal(porLid(c, 'L1').notas, '', 'la atribución coló una nota');
});

// ── dichoDelTurno / dichoDelCiclo ───────────────────────────────────────────

t('A16. el acotamiento solo puede RECORTAR: palabras ajenas se rechazan', () => {
  // Un llamador roto —o malicioso— intenta autorizar una Coca Cola metiéndola
  // en el texto que dice ser «lo que el cliente dijo».
  const { carrito: c, cambios } = reconciliar(carritoVacio(), {
    items: [{ nombre: 'Coca Cola', cantidad: 1 }],
  }, { mensaje: 'hola buenas tardes', textoCiclo: 'hola buenas tardes',
    dichoDelCiclo: 'hola buenas tardes ponme una Coca Cola',
    dichoDelTurno: 'ponme una Coca Cola' });

  assert.deepEqual(c.items, [], 'se autorizó un producto con texto que el cliente nunca escribió');
  assert(cambios.sinRespaldo.some((s) => String(s.campo).startsWith('texto_autorizante')),
    `no quedó traza del acotamiento rechazado: ${JSON.stringify(cambios.sinRespaldo)}`);
});

t('A17. un acotamiento legítimo sí se aplica', () => {
  // El mesero quita la cláusula que es pregunta. Todas sus palabras están en lo
  // que el cliente escribió, así que se acepta y la coca NO entra.
  const { carrito: c, cambios } = reconciliar(carritoVacio(), {
    items: [{ nombre: 'Coca Cola', cantidad: 1 }],
  }, { mensaje: 'tienes coca cola? ponme unos chilaquiles',
    textoCiclo: 'tienes coca cola? ponme unos chilaquiles',
    dichoDelTurno: 'ponme unos chilaquiles', dichoDelCiclo: 'ponme unos chilaquiles' });
  assert.deepEqual(c.items, [], 'la coca de una pregunta entró al pedido');
  assert.equal(cambios.sinRespaldo.some((s) => String(s.campo).startsWith('texto_autorizante')), false,
    'se rechazó un acotamiento que era legítimo');
});

t('A18. rechazar el acotamiento cae al comportamiento anterior, no a uno nuevo', () => {
  // Con el acotamiento inválido se usa el texto derivado — que aquí SÍ nombra
  // los chilaquiles — así que el pedido legítimo del cliente no se pierde.
  const { carrito: c } = reconciliar(carritoVacio(), {
    items: [{ nombre: 'Chilaquiles', cantidad: 1 }],
  }, { mensaje: 'ponme unos chilaquiles', textoCiclo: 'ponme unos chilaquiles',
    dichoDelCiclo: 'ponme unos chilaquiles y una Coca Cola' });
  assert.deepEqual(nombres(c), ['Chilaquiles'], 'el rechazo del acotamiento se comió un pedido válido');
});

t('A19. una cadena vacía es una respuesta, no una ausencia', () => {
  const { carrito: c } = reconciliar(carritoVacio(), { items: [{ nombre: 'Coca Cola', cantidad: 1 }] },
    { mensaje: 'tienes coca?', textoCiclo: 'tienes coca?', dichoDelTurno: '', dichoDelCiclo: '' });
  assert.deepEqual(c.items, [], 'con texto autorizante vacío se usó el mensaje entero');
});

// ── evidenciaAceptada ───────────────────────────────────────────────────────

t('A20. un «sí» a una sugerencia mete el producto, y solo el producto', () => {
  const { carrito: c, cambios } = reconciliar(carritoVacio(), {
    items: [{ nombre: 'Cafe de Olla', cantidad: 3, modificadores: [mod('Extras', 'con canela')], notas: 'bien caliente' }],
  }, { mensaje: 'si', textoCiclo: 'unos chilaquiles si',
    evidenciaAceptada: ['Cafe de Olla'] });

  assert.deepEqual(nombres(c), ['Cafe de Olla'], 'el sí no autorizó el producto que se le ofreció');
  assert.equal(c.items[0].cantidad, 1, 'el sí autorizó una cantidad');
  assert.deepEqual(opcionesDe(c.items[0]), [], 'el sí autorizó un modificador');
  assert.equal(c.items[0].notas, '', 'el sí autorizó una nota');
  assert(cambios.congelados.length + cambios.sinRespaldo.length > 0);
});

t('A21. la evidencia aceptada NO respalda otro producto que comparta palabras', () => {
  const { carrito: c } = reconciliar(carritoVacio(), {
    items: [{ nombre: 'Cafe de Olla', cantidad: 1 }, { nombre: 'Cafe Americano', cantidad: 1 }],
  }, { mensaje: 'si', textoCiclo: 'si', evidenciaAceptada: ['Cafe de Olla'] });
  assert.deepEqual(nombres(c), ['Cafe de Olla', 'Cafe Americano'].slice(0, 1).concat(
    nombres(c).includes('Cafe Americano') ? ['Cafe Americano'] : []),
  `entró un producto que no se ofreció: ${nombres(c)}`);
  assert.equal(nombres(c).includes('Cafe Americano'), false,
    'aceptar «Cafe de Olla» autorizó «Cafe Americano» por compartir una palabra');
});

t('A22. sin evidenciaAceptada, el comportamiento es exactamente el de antes', () => {
  const { carrito: c } = reconciliar(carritoVacio(), { items: [{ nombre: 'Cafe de Olla', cantidad: 1 }] },
    { mensaje: 'si', textoCiclo: 'unos chilaquiles si' });
  assert.deepEqual(c.items, [], 'un sí pelado metió un producto sin que nadie lo hubiera ofrecido');
});

// ── hermanos + recién nombrados ─────────────────────────────────────────────

t('A23. un producto que el cliente acaba de nombrar compite por la frase', () => {
  const previo = car(it('L1', 'Chilaquiles'));
  const { carrito: c } = reconciliar(previo, {
    items: [{ lid: 'L1', nombre: 'Chilaquiles', cantidad: 2 }, { nombre: 'Coca Cola', cantidad: 2 }],
  }, { mensaje: 'ponme dos cocas', textoCiclo: 'unos chilaquiles ponme dos cocas' });
  assert.equal(porLid(c, 'L1').cantidad, 1, 'el «dos» de las cocas subió los chilaquiles');
  assert.equal((c.items.find((x) => x.nombre === 'Coca Cola') || {}).cantidad, 2);
});

t('A24. un producto que el MODELO se inventa no puede bloquear un cambio legítimo', () => {
  const previo = car(it('L1', 'Chilaquiles'));
  const { carrito: c } = reconciliar(previo, {
    items: [{ lid: 'L1', nombre: 'Chilaquiles', cantidad: 2 }, { nombre: 'Agua Mineral', cantidad: 1 }],
  }, { mensaje: 'mejor dos', textoCiclo: 'unos chilaquiles mejor dos' });
  assert.equal(porLid(c, 'L1').cantidad, 2,
    'un producto inventado por el modelo bloqueó un cambio que el cliente sí pidió');
  assert.equal(nombres(c).includes('Agua Mineral'), false);
});

// ── nada de esto cambia el camino sin opciones ──────────────────────────────

t('A25. sin ninguna opción nueva, reconciliar se comporta como antes del mesero', () => {
  const previo = car(it('L1', 'Chilaquiles', { cantidad: 2, modificadores: [mod('Salsa', 'Salsa Verde')] }));
  const { carrito: c } = reconciliar(previo, { items: [{ nombre: 'Chilaquiles', cantidad: 1 }] },
    { mensaje: 'para recoger', textoCiclo: 'dos chilaquiles con salsa verde para recoger' });
  assert.equal(c.items[0].cantidad, 2, 'la omisión del modelo bajó la cantidad');
  assert.deepEqual(opcionesDe(c.items[0]), ['Salsa Verde']);
  assert.equal(c.items[0].lid, 'L1');
});

console.log(`\n${fail === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${ok} pasadas, ${fail} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
process.exit(fail ? 1 : 0);
