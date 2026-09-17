// ─── «MI CALLE ES REFORMA» NO ES UNA PREGUNTA ────────────────────────────
//
// El clasificador decidía que una cláusula era consulta con esto:
//
//   return interroga || verboDeConsulta;          intencionesDelCliente.js:193
//
// `verboDeConsulta` BASTABA por sí solo, y `V_CONSULTA` incluye `\bes\b`
// —está ahí por «¿cuánto es?», «¿de qué es?»—. Así que una declaración normal
// de dato caía por la rama de consulta:
//
//   «mi calle es Reforma»   verbo=es · signo=false · pronombre=false
//                           -> esConsulta=true
//                           -> textoQueAutoriza = ""
//                           -> elTextoRespaldaElValor('Reforma','') = false
//                           -> carrito.datos = {} y cliente:calle sin respaldo
//
// Mientras que «vivo en Reforma» —la misma información, otra sintaxis— entraba
// perfectamente. El cliente perdía su dirección por usar el verbo ser.
//
// ── LA REGLA ────────────────────────────────────────────────────────────
//
// No se quita `verboDeConsulta`: «tienes coca» y «hay agua» son consultas de
// verdad y no llevan ni signo ni pronombre. Lo que se añade es la forma que el
// español da a una ATRIBUCIÓN:
//
//   <determinante> <sustantivo> (es|son) <valor>
//
// «mi calle es Reforma», «la referencia es portón negro». Esa forma no
// pregunta nada... salvo que haya marca de interrogación, y entonces manda la
// marca: «¿mi calle es Reforma?» sigue siendo una pregunta.
//
// Y la negación no declara: «mi calle no es Reforma» no asigna Reforma.
import assert from 'node:assert/strict';
import { atenderTurno } from '../src/mesero-whatsapp/meseroDigital.js';
import { clasificarIntenciones, textoQueAutoriza } from '../src/mesero-whatsapp/intencionesDelCliente.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

const CARTA = [
  { id: 26, nombre: 'CHILAQUILES', orden: 1, productos: [
    { id: 85, nombre: 'Chilaquiles Sencillos', orden: 0, precio: 195, disponible: true }] },
  { id: 40, nombre: 'BEBIDAS', orden: 2, productos: [
    { id: 90, nombre: 'Coca Cola', orden: 0, precio: 35, disponible: true }] },
];
const LINEA = () => ({ lid: 'L1', nombre: 'Chilaquiles Sencillos', id: 85,
  cantidad: 1, notas: '', modificadores: [] });

let n = 0;
function conversacion(id, datos = {}) {
  let contexto = null;
  let carrito = { items: [LINEA()], datos: { ...datos } };
  return {
    get carrito() { return carrito; },
    async turno(mensaje, borrador = null, extra = {}) {
      const r = await atenderTurno({
        negocioId: 'n-decl', conversacionId: id, mensaje,
        catalogo: CARTA, requierePago: true,
        contextoGuardado: contexto, carrito,
        proponer: async () => borrador,
        ...extra,
      });
      contexto = r.contexto;
      carrito = r.carrito;
      return r;
    },
  };
}
// Un turno suelto, para lo que no necesita historia.
const turno = (mensaje, borrador, extra = {}) =>
  conversacion(`c${n += 1}`).turno(mensaje, borrador, extra);

const esConsultaDe = (f) => clasificarIntenciones(f, { fase: 'tomando_orden' })
  .porClausula.every((c) => c.esConsulta);

console.log('\n══ K1-K5. DECLARACIONES DE DATO ══');

const DECLARACIONES = [
  ['K1', 'mi calle es Reforma', 'calle', 'Reforma'],
  ['K2', 'mi colonia es Centro', 'colonia', 'Centro'],
  ['K3', 'mi numero interior es 5B', 'numero_interior', '5B'],
  ['K4', 'mi telefono es 878 123 4567', 'telefono', '8781234567'],
  ['K5', 'mi nombre es Mario', 'nombre', 'Mario'],
  ['K5b', 'mi numero exterior es 200', 'numero_exterior', '200'],
  ['K5c', 'la referencia es porton negro', 'referencia', 'porton negro'],
];

for (const [id, frase, campo, valor] of DECLARACIONES) {
  await t(`${id}. «${frase}» declara ${campo}`, async () => {
    assert.equal(esConsultaDe(frase), false, 'se clasificó como consulta');
    assert.notEqual(textoQueAutoriza(frase, { fase: 'inicio' }), '',
      'la cláusula no autoriza nada: se perdió el texto del cliente');
    const r = await turno(frase, { items: [], cliente: { [campo]: valor } });
    assert.equal(r.carrito.datos.cliente?.[campo], valor,
      `el dato no entró: ${JSON.stringify(r.carrito.datos.cliente)}`);
  });
}

console.log('\n══ K6-K8. PREGUNTAS QUE NO PUEDEN ROMPERSE ══');

const PREGUNTAS = [
  ['K6', '¿cuál es mi calle?'],
  ['K7', '¿mi calle es Reforma?'],
  ['K8', '¿es Reforma?'],
  ['K8b', '¿qué dirección tienes?'],
  ['K8c', '¿esa es mi dirección?'],
  ['K8d', '¿el número es 200?'],
];

for (const [id, frase] of PREGUNTAS) {
  await t(`${id}. «${frase}» sigue siendo consulta y no muta`, async () => {
    assert.equal(esConsultaDe(frase), true, 'dejó de clasificarse como consulta');
    const r = await turno(frase, { items: [], cliente: { calle: 'Reforma', numero_exterior: '200' } });
    assert.equal(r.carrito.datos.cliente, undefined,
      `una pregunta mutó el pedido: ${JSON.stringify(r.carrito.datos.cliente)}`);
  });
}

await t('K8e. y las consultas de carta de siempre no se tocan', async () => {
  // El arreglo no puede convertir en declaración lo que lleva verbo de
  // consulta sin atribución. Son las que no llevan ni signo ni pronombre, que
  // es justo donde `verboDeConsulta` tiene que seguir mandando.
  for (const f of ['tienes coca', 'hay agua mineral', 'que bebidas tienes', 'cuanto cuesta']) {
    assert.equal(esConsultaDe(f), true, `«${f}» dejó de ser consulta`);
  }
});

await t('K8f. declaración y pregunta en el mismo mensaje: cada una lo suyo', async () => {
  // La razón de mirar los signos POR CLÁUSULA y no por mensaje. Con un flag
  // global, la declaración de la izquierda se volvería pregunta por culpa de
  // la de la derecha, y el cliente perdería la calle que acaba de dictar.
  const cl = clasificarIntenciones('mi calle es Reforma. ¿tienes coca?', { fase: 'tomando_orden' });
  const decl = cl.porClausula.find((x) => /reforma/i.test(x.fragmento));
  const preg = cl.porClausula.find((x) => /coca/i.test(x.fragmento));
  assert.equal(decl?.esConsulta, false, `la declaración se contagió: ${JSON.stringify(cl.porClausula)}`);
  assert.equal(preg?.esConsulta, true, `la pregunta dejó de serlo: ${JSON.stringify(cl.porClausula)}`);

  const r = await turno('mi calle es Reforma. ¿tienes coca?', { items: [], cliente: { calle: 'Reforma' } });
  assert.equal(r.carrito.datos.cliente?.calle, 'Reforma', JSON.stringify(r.carrito.datos.cliente));
});

await t('K8g. y al revés, la pregunta primero', async () => {
  const cl = clasificarIntenciones('¿tienes coca? mi calle es Reforma', { fase: 'tomando_orden' });
  const decl = cl.porClausula.find((x) => /reforma/i.test(x.fragmento));
  const preg = cl.porClausula.find((x) => /coca/i.test(x.fragmento));
  assert.equal(preg?.esConsulta, true, JSON.stringify(cl.porClausula));
  assert.equal(decl?.esConsulta, false, JSON.stringify(cl.porClausula));
});

console.log('\n══ K9-K10. EL PENDIENTE ══');

await t('K9. pendiente de calle + «Reforma» lo resuelve', async () => {
  const r = await turno('Reforma', { items: [], cliente: { calle: 'Reforma' } },
    { datoOperativoPendiente: 'calle' });
  assert.equal(r.carrito.datos.cliente?.calle, 'Reforma', JSON.stringify(r.carrito.datos.cliente));
});

await t('K10. pendiente de calle + «mi calle es Reforma» también', async () => {
  const r = await turno('mi calle es Reforma', { items: [], cliente: { calle: 'Reforma' } },
    { datoOperativoPendiente: 'calle' });
  assert.equal(r.carrito.datos.cliente?.calle, 'Reforma', JSON.stringify(r.carrito.datos.cliente));
});

await t('K10b. y el pendiente sigue cargando peso donde el texto no llega', async () => {
  // K9 y K10 NO prueban la puerta del pendiente: desde este arreglo, «Reforma»
  // y «mi calle es Reforma» sostienen el valor por sí solos. Lo delató la
  // mordida Z5 al dejar de morder, que es la tercera vez que un arreglo mío
  // vuelve vacua una prueba del pendiente.
  //
  // Éste sí lo aísla: un nombre de dos letras no tiene ninguna palabra
  // significativa —ni larga ni con dígitos—, así que sin la pregunta se cae.
  const r = await turno('Jo', { items: [], cliente: { nombre: 'Jo' } },
    { datoOperativoPendiente: 'nombre' });
  assert.equal(r.carrito.datos.cliente?.nombre, 'Jo',
    `se preguntó el nombre, lo contestó, y se descartó: ${JSON.stringify(r.carrito.datos.cliente)}`);
});

console.log('\n══ K11. NUNCA UNA CADENA VACÍA ══');

await t('K11. ninguna clasificación puede dejar un dato de cliente en ""', async () => {
  // El defecto producía `autoriza = ""`. Lo que NO puede pasar es que ese vacío
  // se convierta en un valor: una dirección en blanco es peor que ninguna,
  // porque parece un dato.
  for (const campo of ['calle', 'nombre', 'telefono', 'direccion', 'colonia']) {
    const r = await turno('mi calle es Reforma', { items: [], cliente: { [campo]: '' } });
    const v = r.carrito.datos.cliente?.[campo];
    assert.ok(v === undefined || v !== '', `${campo} quedó en cadena vacía: ${JSON.stringify(r.carrito.datos.cliente)}`);
  }
});

await t('K11b. y tampoco borra por encima de un dato bueno', async () => {
  const c = conversacion('k11b');
  await c.turno('mi calle es Reforma', { items: [], cliente: { calle: 'Reforma' } });
  const r = await c.turno('gracias', { items: [], cliente: { calle: '' } });
  assert.equal(r.carrito.datos.cliente?.calle, 'Reforma',
    `un vacío pisó la calle buena: ${JSON.stringify(r.carrito.datos.cliente)}`);
});

console.log('\n══ K12. NEGACIÓN ══');

await t('K12. «mi calle no es Reforma» NO asigna Reforma', async () => {
  const r = await turno('mi calle no es Reforma', { items: [], cliente: { calle: 'Reforma' } });
  assert.notEqual(r.carrito.datos.cliente?.calle, 'Reforma',
    `la negación entró como afirmación: ${JSON.stringify(r.carrito.datos.cliente)}`);
});

await t('K12b. «ya no es Reforma» tampoco', async () => {
  const r = await turno('ya no es Reforma', { items: [], cliente: { calle: 'Reforma' } });
  assert.notEqual(r.carrito.datos.cliente?.calle, 'Reforma', JSON.stringify(r.carrito.datos.cliente));
});

await t('K12c. y negar no borra lo que ya estaba', async () => {
  const c = conversacion('k12c', { cliente: { calle: 'Juarez' } });
  const r = await c.turno('mi calle no es Reforma', { items: [], cliente: { calle: 'Reforma' } });
  assert.equal(r.carrito.datos.cliente?.calle, 'Juarez',
    `perdió la calle buena al negar otra: ${JSON.stringify(r.carrito.datos.cliente)}`);
});

console.log('\n══ K13. CORRECCIÓN EXPLÍCITA ══');

await t('K13. «me equivoqué, mi calle es Juárez» actualiza', async () => {
  const c = conversacion('k13');
  await c.turno('mi calle es Reforma', { items: [], cliente: { calle: 'Reforma' } });
  const r = await c.turno('me equivoqué, mi calle es Juárez', { items: [], cliente: { calle: 'Juárez' } });
  assert.equal(r.carrito.datos.cliente?.calle, 'Juárez',
    `no corrigió: ${JSON.stringify(r.carrito.datos.cliente)}`);
  assert.equal(Object.keys(r.carrito.datos.cliente).length, 1, 'duplicó campos');
});

console.log('\n══ K14. FORMA: MAYÚSCULAS, PUNTUACIÓN, ESPACIOS ══');

await t('K14. las cuatro variantes dan el mismo resultado', async () => {
  for (const f of ['mi calle es: Reforma', 'mi calle es Reforma.', 'Mi Calle Es Reforma', 'mi calle   es   Reforma']) {
    assert.equal(esConsultaDe(f), false, `«${f}» se clasificó como consulta`);
    const r = await turno(f, { items: [], cliente: { calle: 'Reforma' } });
    assert.equal(r.carrito.datos.cliente?.calle, 'Reforma',
      `«${f}» no dejó el dato: ${JSON.stringify(r.carrito.datos.cliente)}`);
  }
});

await t('K14b. el «es» de dentro del valor no lo parte', async () => {
  // «casa beige» tiene que llegar entero, y «Heroes» no puede romperse por
  // parecerse a un token funcional.
  const r1 = await turno('mi referencia es casa beige', { items: [], cliente: { referencia: 'casa beige' } });
  assert.equal(r1.carrito.datos.cliente?.referencia, 'casa beige', JSON.stringify(r1.carrito.datos.cliente));
  const r2 = await turno('mi calle es Heroes', { items: [], cliente: { calle: 'Heroes' } });
  assert.equal(r2.carrito.datos.cliente?.calle, 'Heroes', JSON.stringify(r2.carrito.datos.cliente));
});

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
