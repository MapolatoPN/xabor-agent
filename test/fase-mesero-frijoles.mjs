// «FRIJOLES» NO ES UNA ELECCIÓN.
//
// El caso obligatorio. Es exactamente el error que originó todo este trabajo:
// el cliente dice una palabra que cubre dos opciones de la carta, y el sistema
// elige una. El reconciliador ya exigía respaldo para una opción, pero
// «frijoles» respalda igual de bien a las dos de frijoles, así que pasaba la
// que el modelo hubiera escrito — y cuál escribía dependía de la redacción, no
// del cliente.
//
// El desempate (`distingueLaEleccion`) existía desde la auditoría del 12-sep,
// pero corría en el validador, y el mesero no ejecuta el validador. Aquí se
// comprueba que corre en el camino del mesero, y que la conversación AVANZA:
// una vez preguntado «¿naturales o con chorizo?», la respuesta «con chorizo»
// se mide contra esas dos y no contra la carta entera.
import assert from 'node:assert/strict';

const { atenderTurno, contextoSerializable } = await import('../src/mesero-whatsapp/meseroDigital.js');

let ok = 0, fail = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); ok++; console.log(`  OK  ${nombre}`); }
  catch (e) { fail++; fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}

// ── La carta del enunciado ──────────────────────────────────────────────────
const OPCIONES = ['Frijoles naturales', 'Frijoles con chorizo', 'Papas naturales', 'Papas con chorizo'];
const CATALOGO = [{
  id: 1, nombre: 'Desayunos', productos: [{
    id: 11, nombre: 'Chilaquiles', precio: 150, disponible: true, agotado: false, descripcion: '',
    modificadores: [{
      nombre: 'Guarnicion', requerido: false, minimo: 0, maximo: 1,
      opciones: OPCIONES.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
    }],
  }],
}];

const it = (nombre, modificadores = []) => ({ nombre, cantidad: 1, modificadores, notas: '' });
const guarnicion = (...opciones) => ({ grupo: 'Guarnicion', opciones });

/**
 * Corre una conversación. `elige` simula al modelo: recibe el mensaje y
 * devuelve QUÉ opción cree que el cliente quiso — que es justo donde el modelo
 * se equivoca, y por eso es una entrada de la prueba y no parte del sistema.
 */
async function conversar(guion, { negocioId = 'nF', conversacionId = 'cF' } = {}) {
  let contexto = null, carrito = null;
  const turnos = [];
  for (const paso of guion) {
    const r = await atenderTurno({
      negocioId, conversacionId, mensaje: paso.cliente, contextoGuardado: contexto, carrito,
      catalogo: CATALOGO,
      proponer: async () => paso.borrador,
    });
    contexto = JSON.parse(JSON.stringify(contextoSerializable(r.contexto)));
    carrito = r.carrito;
    turnos.push(r);
  }
  return { turnos, carrito, ultimo: turnos.at(-1) };
}

const opcionesDe = (carrito) => (carrito?.items?.[0]?.modificadores || [])
  .flatMap((m) => m.opciones || []).sort();
const ambiguas = (r) => (r.aclaraciones || []).filter((a) => a.tipo === 'opcion_ambigua');

// ── EL CASO OBLIGATORIO, TURNO POR TURNO ────────────────────────────────────

await t('FR1. turno 1 «unos chilaquiles»: entra el platillo, sin guarnición', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
  ]);
  assert.deepEqual(carrito.items.map((i) => i.nombre), ['Chilaquiles']);
  assert.deepEqual(opcionesDe(carrito), []);
  assert.deepEqual(ambiguas(ultimo), []);
});

await t('FR2. turno 2 «frijoles»: NO elige, y produce la ambigüedad con sus dos candidatos', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    // El modelo resuelve por su cuenta y escribe una de las dos.
    { cliente: 'frijoles', borrador: { items: [it('Chilaquiles', [guarnicion('Frijoles naturales')])] } },
  ]);
  assert.deepEqual(opcionesDe(carrito), [],
    `se eligió una guarnición que el cliente no distinguió: ${JSON.stringify(opcionesDe(carrito))}`);

  const a = ambiguas(ultimo);
  assert.equal(a.length, 1, JSON.stringify(ultimo.aclaraciones));
  assert.equal(a[0].grupo, 'Guarnicion');
  assert.deepEqual(a[0].candidatos.slice().sort(), ['Frijoles con chorizo', 'Frijoles naturales']);
  assert.equal(a[0].candidatos.includes('Papas naturales'), false, 'la pregunta arrastró papas');

  // Y la pregunta de respaldo dice lo que tiene que decir.
  assert(/frijoles naturales/i.test(a[0].pregunta) && /frijoles con chorizo/i.test(a[0].pregunta),
    a[0].pregunta);
  assert(!/creo que/i.test(a[0].pregunta), 'el sistema adivinó en voz educada');
});

await t('FR3. turno 3 «con chorizo»: resuelve EXACTAMENTE Frijoles con chorizo', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'frijoles', borrador: { items: [it('Chilaquiles', [guarnicion('Frijoles naturales')])] } },
    { cliente: 'con chorizo', borrador: { items: [it('Chilaquiles', [guarnicion('Frijoles con chorizo')])] } },
  ]);
  assert.deepEqual(opcionesDe(carrito), ['Frijoles con chorizo'],
    `no resolvió la respuesta a su propia pregunta: ${JSON.stringify(opcionesDe(carrito))}`);
  assert.deepEqual(ambiguas(ultimo), [], 'siguió preguntando después de que el cliente contestara');
  // Y no tocó nada más.
  assert.equal(carrito.items.length, 1);
  assert.equal(carrito.items[0].cantidad, 1);
});

await t('FR4. «con chorizo» SIN pregunta abierta sigue siendo ambiguo', async () => {
  // La misma frase, sin que nadie haya estrechado el grupo: en la carta entera
  // hay dos «con chorizo». Sin la pregunta previa no hay a qué agarrarse.
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'con chorizo', borrador: { items: [it('Chilaquiles', [guarnicion('Frijoles con chorizo')])] } },
  ]);
  assert.deepEqual(opcionesDe(carrito), [],
    'eligió entre frijoles y papas con chorizo sin que nadie lo dijera');
  assert.deepEqual(ambiguas(ultimo)[0].candidatos.slice().sort(),
    ['Frijoles con chorizo', 'Papas con chorizo']);
});

// ── LOS OTROS CUATRO CASOS DEL ENUNCIADO ────────────────────────────────────

await t('FR5. «papas» tampoco elige', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'papas', borrador: { items: [it('Chilaquiles', [guarnicion('Papas con chorizo')])] } },
  ]);
  assert.deepEqual(opcionesDe(carrito), []);
  assert.deepEqual(ambiguas(ultimo)[0].candidatos.slice().sort(), ['Papas con chorizo', 'Papas naturales']);
});

await t('FR6. «naturales» con dos candidatos tampoco elige', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'naturales', borrador: { items: [it('Chilaquiles', [guarnicion('Papas naturales')])] } },
  ]);
  assert.deepEqual(opcionesDe(carrito), []);
  assert.deepEqual(ambiguas(ultimo)[0].candidatos.slice().sort(), ['Frijoles naturales', 'Papas naturales']);
});

await t('FR7. «frijoles naturales» SÍ elige, a la primera', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'frijoles naturales', borrador: { items: [it('Chilaquiles', [guarnicion('Frijoles naturales')])] } },
  ]);
  assert.deepEqual(opcionesDe(carrito), ['Frijoles naturales']);
  assert.deepEqual(ambiguas(ultimo), [], 'preguntó algo que el cliente ya había dicho entero');
});

await t('FR8. «papas con chorizo» SÍ elige, a la primera', async () => {
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'papas con chorizo', borrador: { items: [it('Chilaquiles', [guarnicion('Papas con chorizo')])] } },
  ]);
  assert.deepEqual(opcionesDe(carrito), ['Papas con chorizo']);
  assert.deepEqual(ambiguas(ultimo), []);
});

// ── Y NO SE VUELVE PERMISIVO POR EL CAMINO ──────────────────────────────────

await t('FR9. el modelo no puede colar la OTRA opción aprovechando la pregunta abierta', async () => {
  // Se preguntó por los frijoles; el modelo contesta con unas papas.
  const { carrito, ultimo } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'frijoles', borrador: { items: [it('Chilaquiles', [guarnicion('Frijoles naturales')])] } },
    { cliente: 'con chorizo', borrador: { items: [it('Chilaquiles', [guarnicion('Papas con chorizo')])] } },
  ]);
  assert.equal(opcionesDe(carrito).includes('Papas con chorizo'), false,
    'la pregunta abierta sobre frijoles autorizó unas papas');
});

await t('FR10. la ambigüedad bloquea: no se puede confirmar con ella abierta', async () => {
  const { ultimo } = await conversar([
    { cliente: 'unos chilaquiles', borrador: { items: [it('Chilaquiles')] } },
    { cliente: 'frijoles, para recoger y pago en efectivo',
      borrador: { items: [it('Chilaquiles', [guarnicion('Frijoles naturales')])],
        modalidad: 'recoger', forma_pago: 'efectivo' } },
  ]);
  assert.equal(ultimo.listoParaConfirmar, false, 'se pudo cerrar el pedido con una guarnición sin decidir');
  assert.equal(ultimo.fase, 'completando_producto');
});

console.log(`\n${fail === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${ok} pasadas, ${fail} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
process.exit(fail ? 1 : 0);
