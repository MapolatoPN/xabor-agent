// NOMBRAR NO ES CONSENTIR.
//
// Una propuesta solo pasa a aceptada si hay una señal INEQUÍVOCA de aceptación
// de ESA propuesta. La regla anterior decía «nombrarla y no negarla es
// aceptarla», y de esa sola línea salieron cinco fallas distintas que una
// auditoría adversarial reprodujo ejecutando el código:
//
//   H20/H27  un rechazo seguía siendo texto que autoriza («el café no»)
//   H22/H28  preguntar por lo ofrecido contaba como aceptarlo
//   H29      una palabra suelta del nombre ofrecido contaba como «sí»
//
// Aquí están las cinco, más los seis casos mínimos que se pidieron para el
// shadow (C1–C6). Las de consentimiento se prueban en los dos niveles: en
// `leerRespuesta`, que es donde vive la regla, y de punta a punta por
// `atenderTurno`, que es donde se paga el error.
import assert from 'node:assert/strict';

const { contextoNuevo, anotarTurno } = await import('../src/mesero-whatsapp/contextoMesa.js');
const { proponer, leerRespuesta, aplicarDesenlace, fueRechazada, fueConfirmada,
  evidenciaDeAceptacion, PROPUESTO } = await import('../src/mesero-whatsapp/propuestasDelBot.js');
const { atenderTurno, contextoSerializable } = await import('../src/mesero-whatsapp/meseroDigital.js');

let ok = 0, fail = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); ok++; console.log(`  OK  ${nombre}`); }
  catch (e) { fail++; fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}

// ── La carta ────────────────────────────────────────────────────────────────
const g = (nombre, opciones, requerido = false) => ({
  nombre, requerido, minimo: requerido ? 1 : 0, maximo: 1,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
const CATALOGO = [
  { id: 1, nombre: 'Desayunos', productos: [
    { id: 11, nombre: 'Chilaquiles', precio: 150, disponible: true, agotado: false, descripcion: '',
      modificadores: [g('Guarnicion', ['Frijoles naturales', 'Frijoles con chorizo',
        'Papas naturales', 'Papas con chorizo'])] },
  ] },
  { id: 2, nombre: 'Bebidas', productos: [
    { id: 21, nombre: 'Cafe de Olla', precio: 40, disponible: true, agotado: false, destacado: true, modificadores: [] },
    { id: 22, nombre: 'Cafe Americano', precio: 35, disponible: true, agotado: false, modificadores: [] },
    { id: 23, nombre: 'Agua de Horchata', precio: 45, disponible: true, agotado: false, modificadores: [] },
  ] },
];

/** Un contexto con UNA propuesta viva, como si el bot acabara de ofrecerla. */
function conUnaPropuesta(referencia = 'Cafe de Olla') {
  const ctx = contextoNuevo({ negocioId: 'nC', conversacionId: 'cC' });
  anotarTurno(ctx, 'cliente', 'unos chilaquiles');
  anotarTurno(ctx, 'bot', `¿te agrego un ${referencia}?`);
  proponer(ctx, { clase: 'producto', referencia });
  return ctx;
}
function conDosPropuestas(a = 'Cafe de Olla', b = 'Agua de Horchata') {
  const ctx = conUnaPropuesta(a);
  proponer(ctx, { clase: 'producto', referencia: b });
  return ctx;
}
/** Contesta al bot y devuelve el desenlace ya aplicado. */
function responde(ctx, texto) {
  anotarTurno(ctx, 'cliente', texto);
  const d = leerRespuesta(ctx, texto);
  aplicarDesenlace(ctx, d);
  return d;
}

const it = (nombre, cantidad = 1) => ({ nombre, cantidad, modificadores: [], notas: '' });
const linea = (carrito, nombre) => (carrito?.items || []).filter((i) => i.nombre === nombre);
const resumen = (c) => (c?.items || []).map((i) => `${i.cantidad}x ${i.nombre}`).join(' | ') || '—';

/** Conversación real por el orquestador, con el bot ofreciendo de verdad. */
async function conversar(guion, extra = {}) {
  let contexto = null, carrito = null;
  const turnos = [];
  for (const paso of guion) {
    const r = await atenderTurno({
      negocioId: 'nC', conversacionId: 'cC', mensaje: paso.cliente,
      contextoGuardado: contexto, carrito, catalogo: CATALOGO,
      complementos: { Desayunos: ['Bebidas'] }, ...extra,
      proponer: async () => (typeof paso.borrador === 'function' ? paso.borrador(carrito) : paso.borrador),
    });
    contexto = JSON.parse(JSON.stringify(contextoSerializable(r.contexto)));
    carrito = r.carrito;
    turnos.push(r);
  }
  return { turnos, carrito, contexto, ultimo: turnos.at(-1) };
}

// ── LOS CINCO HALLAZGOS ─────────────────────────────────────────────────────

await t('H20. «no, el café no» RECHAZA, no acepta', async () => {
  const ctx = conUnaPropuesta();
  const d = responde(ctx, 'no, el cafe no');
  assert.equal(d.aceptadas.length, 0, 'un rechazo entró como aceptación');
  assert.equal(d.rechazadas.length, 1);
  assert.equal(fueRechazada(ctx, 'Cafe de Olla'), true);
});

await t('H27. el «no» a mitad de frase también rechaza', async () => {
  // El ancla `^` de la negación no veía «el café no»: por ahí entraba al pedido
  // exactamente lo que el cliente acababa de rechazar.
  for (const frase of ['el cafe no', 'ese no lo quiero', 'el cafe de olla no', 'no lo quiero']) {
    const ctx = conUnaPropuesta();
    const d = responde(ctx, frase);
    assert.equal(d.aceptadas.length, 0, `"${frase}" se leyó como aceptación`);
    assert.equal(d.rechazadas.length, 1, `"${frase}" no se leyó como rechazo`);
  }
});

await t('H22. preguntar por lo ofrecido NO lo acepta', async () => {
  for (const frase of ['¿cuánto cuesta el café?', '¿el café es de olla?', '¿qué trae el café de olla?']) {
    const ctx = conUnaPropuesta();
    const d = responde(ctx, frase);
    assert.equal(d.aceptadas.length, 0, `"${frase}" compró lo que se estaba preguntando`);
    assert.equal(d.rechazadas.length, 0, `"${frase}" tampoco es un rechazo`);
    assert.equal(ctx.propuestas[0].estado, PROPUESTO, 'la propuesta debía quedar abierta');
  }
});

await t('H28. y de punta a punta: preguntar el precio no agrega el producto', async () => {
  const { carrito, turnos } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    // El bot recomienda. El cliente pregunta. El modelo, servicial, lo mete.
    { cliente: '¿cuánto cuesta el café de olla?',
      borrador: (c) => ({ items: [...(c?.items || []).map((x) => ({ ...x })), it('Cafe de Olla')] }) },
  ]);
  assert(turnos[0].recomendaciones.some((r) => r.nombre === 'Cafe de Olla'),
    `la escena necesita que el bot ofrezca el café: ${JSON.stringify(turnos[0].recomendaciones)}`);
  assert.equal(linea(carrito, 'Cafe de Olla').length, 0,
    `preguntar el precio compró el producto: ${resumen(carrito)}`);
  assert.equal(turnos[1].desenlace.aceptadas.length, 0);
});

await t('H22b. una PREGUNTA que empieza por «no» tampoco rechaza', async () => {
  // La otra mitad del filtro de consultas, y la que de verdad lo justifica:
  // sin él, «¿no es muy dulce?» casaba con la negación anclada y mataba la
  // propuesta. El cliente estaba averiguando, y el bot no podría volver a
  // ofrecérselo nunca.
  for (const frase of ['¿no es muy dulce?', '¿no lo tienes sin azúcar?']) {
    const ctx = conUnaPropuesta();
    const d = responde(ctx, frase);
    assert.equal(d.rechazadas.length, 0, `"${frase}" mató la propuesta`);
    assert.equal(d.aceptadas.length, 0, `"${frase}" tampoco la acepta`);
    assert.equal(fueRechazada(ctx, 'Cafe de Olla'), false,
      `"${frase}" dejó el café marcado como rechazado para siempre`);
  }
});

await t('H29. una palabra suelta del nombre ofrecido NO es un «sí»', async () => {
  // Se ofreció «Agua de Horchata»; el cliente pide un vaso de agua.
  const ctx = conUnaPropuesta('Agua de Horchata');
  const d = responde(ctx, 'me traes un vaso de agua simple');
  assert.equal(d.aceptadas.length, 0,
    'compartir la palabra «agua» se leyó como aceptar el Agua de Horchata');
  assert.equal(fueConfirmada(ctx, 'Agua de Horchata'), false);
});

// ── LOS EJEMPLOS DEL ENCARGO ────────────────────────────────────────────────

await t('E-a. «¿Cuánto cuesta?» → CONSULTA, no aceptación', async () => {
  const d = responde(conUnaPropuesta(), '¿cuánto cuesta?');
  assert.deepEqual([d.aceptadas.length, d.rechazadas.length, d.ambigua], [0, 0, false]);
});

await t('E-b. «No» → RECHAZADO', async () => {
  const ctx = conUnaPropuesta();
  const d = responde(ctx, 'no');
  assert.equal(d.rechazadas.length, 1);
  assert.equal(fueRechazada(ctx, 'Cafe de Olla'), true);
});

await t('E-c. «Mejor americano» → no acepta el de olla', async () => {
  const ctx = conUnaPropuesta();
  const d = responde(ctx, 'mejor americano');
  assert.equal(d.aceptadas.length, 0, 'elegir otra cosa se leyó como aceptar la ofrecida');
  assert.equal(fueConfirmada(ctx, 'Cafe de Olla'), false);
  // Y no se vuelve a ofrecer: el cliente ya dijo que quería otra cosa.
  assert.equal(fueRechazada(ctx, 'Cafe de Olla'), true);
});

await t('E-d. «Sí» → acepta solo si hay UNA propuesta pendiente', async () => {
  const uno = conUnaPropuesta();
  assert.equal(responde(uno, 'sí').aceptadas.length, 1);
  const dos = conDosPropuestas();
  const d = responde(dos, 'sí');
  assert.equal(d.aceptadas.length, 0);
  assert.equal(d.ambigua, true);
});

await t('E-e. «Sí, pero sin azúcar» acepta la propuesta y no bloquea la nota', async () => {
  const ctx = conUnaPropuesta();
  const d = responde(ctx, 'sí, pero sin azúcar');
  assert.equal(d.aceptadas.length, 1, 'la coletilla anuló el sí');
  assert.equal(d.aceptadas[0].referencia, 'Cafe de Olla');
  // La evidencia que produce el sí alcanza al PRODUCTO; «sin azúcar» son
  // palabras del cliente y las juzga el reconciliador, como cualquier nota.
  assert.equal(evidenciaDeAceptacion(d.aceptadas), 'Cafe de Olla');
});

await t('E-f. «¿Y qué otras bebidas tienes?» no acepta nada', async () => {
  const d = responde(conUnaPropuesta(), '¿y qué otras bebidas tienes?');
  assert.deepEqual([d.aceptadas.length, d.rechazadas.length], [0, 0]);
});

await t('E-g. «Va» acepta solo con una propuesta claramente pendiente', async () => {
  assert.equal(responde(conUnaPropuesta(), 'va').aceptadas.length, 1);
  assert.equal(responde(conDosPropuestas(), 'va').ambigua, true);
});

await t('E-h. un «sí» con un «no» en la misma frase no decide: pregunta', async () => {
  // «Sí, pero ese no» dice las dos cosas. Elegir una por él sería adivinar.
  const d = responde(conUnaPropuesta(), 'si, pero ese no');
  assert.equal(d.aceptadas.length, 0, 'se quedó con el sí e ignoró el no');
  assert.equal(d.ambigua, true);
});

// ── C1–C6, LOS CASOS MÍNIMOS DEL SHADOW ─────────────────────────────────────

const chil = (mods = []) => ({ nombre: 'Chilaquiles', cantidad: 1, modificadores: mods, notas: '' });
const guarnicion = (...o) => ({ grupo: 'Guarnicion', opciones: o });
const ambiguas = (r) => (r.aclaraciones || []).filter((a) => a.tipo === 'opcion_ambigua');

await t('C1. «frijoles» pregunta, no elige', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [chil()] } },
    { cliente: 'frijoles', borrador: { items: [chil([guarnicion('Frijoles naturales')])] } },
  ]);
  assert.equal(JSON.stringify(carrito).includes('Frijoles'), false,
    `eligió una guarnición: ${JSON.stringify(carrito.items)}`);
  assert.deepEqual(ambiguas(ultimo)[0].candidatos.slice().sort(),
    ['Frijoles con chorizo', 'Frijoles naturales']);
});

await t('C2. «con chorizo» después resuelve Frijoles con chorizo', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [chil()] } },
    { cliente: 'frijoles', borrador: { items: [chil([guarnicion('Frijoles naturales')])] } },
    { cliente: 'con chorizo', borrador: { items: [chil([guarnicion('Frijoles con chorizo')])] } },
  ]);
  const ops = (carrito.items[0].modificadores || []).flatMap((m) => m.opciones || []);
  assert.deepEqual(ops, ['Frijoles con chorizo'], JSON.stringify(ops));
  assert.deepEqual(ambiguas(ultimo), []);
});

await t('C3. bot recomienda café + «¿cuánto cuesta?» → NO lo agrega', async () => {
  const { carrito, turnos } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [chil()] } },
    { cliente: '¿cuánto cuesta?',
      borrador: (c) => ({ items: [...(c?.items || []).map((x) => ({ ...x })), it('Cafe de Olla')] }) },
  ]);
  assert(turnos[0].recomendaciones.some((r) => r.nombre === 'Cafe de Olla'));
  assert.equal(linea(carrito, 'Cafe de Olla').length, 0, resumen(carrito));
});

await t('C4. bot recomienda café + «no gracias» → no entra y queda rechazado', async () => {
  const { carrito, ultimo, contexto } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [chil()] } },
    { cliente: 'no gracias',
      borrador: (c) => ({ items: [...(c?.items || []).map((x) => ({ ...x })), it('Cafe de Olla')] }) },
  ]);
  assert.equal(linea(carrito, 'Cafe de Olla').length, 0, resumen(carrito));
  assert.equal(ultimo.desenlace.rechazadas.length >= 1, true);
  assert(contexto.propuestas.some((p) => p.referencia === 'Cafe de Olla' && p.estado === 'rechazado'),
    JSON.stringify(contexto.propuestas));
});

await t('C5. bot recomienda café + «sí» → autoriza ESA propuesta y nada más', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [chil()] } },
    { cliente: 'sí', borrador: (c) => ({ items: [...(c?.items || []).map((x) => ({ ...x })),
      { nombre: 'Cafe de Olla', cantidad: 3, modificadores: [], notas: 'bien cargado' },
      it('Cafe Americano')] }) },
  ]);
  assert.equal(linea(carrito, 'Cafe de Olla').length, 1, `no entró lo aceptado: ${resumen(carrito)}`);
  assert.equal(linea(carrito, 'Cafe de Olla')[0].cantidad, 1, 'el sí autorizó una cantidad');
  assert.equal(linea(carrito, 'Cafe de Olla')[0].notas, '', 'el sí autorizó una nota');
  assert.equal(linea(carrito, 'Cafe Americano').length, 0,
    'el sí autorizó un producto que nadie ofreció');
  assert.equal(ultimo.desenlace.aceptadas.length, 1);
});

await t('C6. dos propuestas pendientes + «sí» → pregunta cuál', async () => {
  const ctx = conDosPropuestas();
  const d = responde(ctx, 'sí');
  assert.equal(d.ambigua, true);
  assert.deepEqual(d.candidatas.map((p) => p.referencia).sort(),
    ['Agua de Horchata', 'Cafe de Olla']);
  assert(ctx.propuestas.every((p) => p.estado === PROPUESTO), 'se resolvió algo ambiguo');
});

// ── Y no se volvió sordo por el camino ──────────────────────────────────────

await t('C7. las aceptaciones legítimas siguen funcionando', async () => {
  for (const frase of ['sí', 'va', 'dale', 'sí porfa', 'ok', 'va el café', 'ponme el café de olla']) {
    const ctx = conUnaPropuesta();
    const d = responde(ctx, frase);
    assert.equal(d.aceptadas.length, 1, `"${frase}" dejó de aceptar`);
  }
});

await t('C8. nombrar UNA de dos con una afirmación sí desempata', async () => {
  const ctx = conDosPropuestas();
  const d = responde(ctx, 'va el café de olla');
  assert.equal(d.aceptadas.length, 1);
  assert.equal(d.aceptadas[0].referencia, 'Cafe de Olla');
});

console.log(`\n${fail === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${ok} pasadas, ${fail} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
process.exit(fail ? 1 : 0);
