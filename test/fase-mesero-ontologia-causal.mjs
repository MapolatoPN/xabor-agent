// ─── DOS COSAS QUE EL SMOKE REAL DEL 15-SEP DEJÓ AL DESCUBIERTO ───────────
//
// 1. ONTOLOGÍA. GPT devolvió grupos que no existen en la carta
//    —«acompañamientos», «complementos», «proteína»— y esos nombres libres
//    atravesaron el sistema hasta convertirse en pendientes y en preguntas al
//    cliente: «¿chorizo?», «¿frijoles?», «¿huevo estrellado?».
//
//    El modelo PROPONE una interpretación; la ontología del menú la pone el
//    catálogo. Un grupo sólo existe si está anclado a un grupo real.
//
// 2. CAUSALIDAD. En el mismo smoke, el turno «Con chorizo» propuso Chipotle y
//    huevo estrellado, que pertenecían a otros mensajes. La hipótesis era que
//    un turno veía mensajes POSTERIORES por haber esperado en cola.
//
//    Estas pruebas la miden en vez de suponerla: instrumentan exactamente qué
//    historial recibe cada llamada al modelo en una ráfaga.
import assert from 'node:assert/strict';
import {
  observarTurnoDelMesero, reiniciarSombraMesero, verEstadoSombra,
} from '../src/mesero-whatsapp/sombraDelMesero.js';
import { opcionesAmbiguas, grupoRealDeLaOpcion, fichaDeProducto } from '../src/mesero-whatsapp/consultasDelMenu.js';
import { recolectarAclaraciones } from '../src/mesero-whatsapp/aclaraciones.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

// ── LA CARTA REAL DE OBISPADO, la que produjo los defectos ───────────────
const g = (nombre, minimo, maximo, opciones, requerido = true) => ({
  nombre, requerido, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
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
  ] },
  { id: 40, nombre: 'LICUADOS', orden: 3, productos: [
    { id: 200, nombre: 'Licuado de fresa', orden: 0, precio: 60, disponible: true, modificadores: [] },
  ] },
];
const cargarCatalogo = async () => CARTA;

// ═══════════════════════════════════════════════════════════════════════════
// CAUSALIDAD — qué historial ve CADA llamada al modelo en una ráfaga
// ═══════════════════════════════════════════════════════════════════════════
//
// El observador encola por conversación y empuja el mensaje a su historial
// DENTRO del candado. Estas pruebas comprueban que ese orden se traduce en el
// prefijo correcto, que es lo único que el modelo puede ver.

/** Un modelo que anota el historial EXACTO de cada llamada y no decide nada. */
function modeloQueAnota() {
  const vistas = [];
  const fn = async (mensajes) => {
    vistas.push((mensajes || []).map((m) => m.content));
    return { items: [] };
  };
  fn.vistas = vistas;
  return fn;
}

const enRafaga = async (sessionId, textos, proponer) => {
  // TODAS a la vez, sin await entre medias: es como llega una ráfaga real.
  const enVuelo = textos.map((x) => observarTurnoDelMesero({
    sessionId, negocioId: 'n-causal', mensaje: x, cargarCatalogo, proponer,
  }));
  return Promise.all(enVuelo);
};

await t('C1. dos mensajes en ráfaga: el primero NO ve al segundo', async () => {
  reiniciarSombraMesero();
  const modelo = modeloQueAnota();
  await enRafaga('s-c1', ['Quiero chilaquiles suizos', 'Con frijolitos'], modelo);
  assert.equal(modelo.vistas.length, 2, `llamadas=${modelo.vistas.length}`);
  assert.deepEqual(modelo.vistas[0], ['Quiero chilaquiles suizos'],
    `M1 vio de más: ${JSON.stringify(modelo.vistas[0])}`);
  assert.deepEqual(modelo.vistas[1], ['Quiero chilaquiles suizos', 'Con frijolitos']);
});

await t('C2. seis mensajes en ráfaga: cada uno ve SOLO su prefijo causal', async () => {
  reiniciarSombraMesero();
  const modelo = modeloQueAnota();
  const GUION = ['Quiero chilaquiles suizos', 'Con frijolitos', 'Con chorizo',
    'Y huevos estrellados', 'También chipotle porfa', 'Que licuados tienes?'];
  await enRafaga('s-c2', GUION, modelo);
  assert.equal(modelo.vistas.length, 6, `llamadas=${modelo.vistas.length}`);
  for (const [i, vista] of modelo.vistas.entries()) {
    assert.deepEqual(vista, GUION.slice(0, i + 1),
      `la llamada ${i + 1} vio ${JSON.stringify(vista)}`);
  }
  // Y el caso EXACTO del smoke: el turno de «Con chorizo» no puede haber visto
  // ni el chipotle ni los huevos, que llegaron después.
  const tercera = modelo.vistas[2].join(' | ');
  assert(!/chipotle/i.test(tercera), `«Con chorizo» vio chipotle: ${tercera}`);
  assert(!/huevo/i.test(tercera), `«Con chorizo» vio huevos: ${tercera}`);
});

await t('C3. la secuencia avanza 1..6 sin saltos ni sobrescritura', async () => {
  reiniciarSombraMesero();
  const modelo = modeloQueAnota();
  await enRafaga('s-c3', ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis'], modelo);
  const e = verEstadoSombra('n-causal', 's-c3');
  assert.equal(e.turnos, 6, `turnos=${e.turnos}`);
  assert.equal(e.contexto?.contador, 6, `contador=${e.contexto?.contador}`);
  assert.equal(e.mensajes.length, 6, `mensajes guardados=${e.mensajes.length}`);
});

await t('C4. aunque el turno espere mucho en cola, no incorpora posteriores', async () => {
  reiniciarSombraMesero();
  // El primer modelo se queda colgado a propósito: los otros cinco se apilan
  // detrás. Si el historial se construyera al SALIR de la cola en vez de al
  // entrar, el primero vería los cinco de después.
  const vistas = [];
  let soltar;
  const trabado = new Promise((r) => { soltar = r; });
  let n = 0;
  const modelo = async (mensajes) => {
    vistas.push((mensajes || []).map((m) => m.content));
    if (++n === 1) await trabado;
    return { items: [] };
  };
  const GUION = ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis'];
  const todo = enRafaga('s-c4', GUION, modelo);
  for (let i = 0; i < 80; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(vistas[0], ['uno'], `el primero vio ${JSON.stringify(vistas[0])}`);
  soltar();
  await todo;
  for (const [i, v] of vistas.entries()) {
    assert.deepEqual(v, GUION.slice(0, i + 1), `la llamada ${i + 1} vio ${JSON.stringify(v)}`);
  }
});

await t('C5. el orden lo fija la cola, no el reloj: sellos iguales no lo rompen', async () => {
  reiniciarSombraMesero();
  const modelo = modeloQueAnota();
  // Mismo `ahora` para los seis: si algo dependiera del timestamp para ordenar
  // o para cortar el historial, aquí empataría y elegiría mal.
  const fijo = new Date('2026-09-15T22:07:00.000Z');
  const GUION = ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis'];
  await Promise.all(GUION.map((x) => observarTurnoDelMesero({
    sessionId: 's-c5', negocioId: 'n-causal', mensaje: x, cargarCatalogo, proponer: modelo, ahora: fijo,
  })));
  for (const [i, v] of modelo.vistas.entries()) {
    assert.deepEqual(v, GUION.slice(0, i + 1), `la llamada ${i + 1} vio ${JSON.stringify(v)}`);
  }
});

await t('C6. la contaminación real: el historial arrastra la conversación anterior', async () => {
  // Esto es lo que DE VERDAD pasó en el smoke del 15-sep. No fue causalidad:
  // las dos tandas compartieron conversación, y la ventana de historial que
  // recibe el extractor —los últimos seis— seguía conteniendo los mensajes de
  // la tanda anterior. Por eso el turno «Con chorizo» propuso chipotle y
  // huevos: estaban DETRÁS, no delante.
  reiniciarSombraMesero();
  const modelo = modeloQueAnota();
  const TANDA1 = ['Quiero chilaquiles', 'Con frijolitos', 'Con chorizo',
    'También chipotle', 'Con huevo estrellado', 'Que licuados tienen?'];
  const TANDA2 = ['Quiero chilaquiles suizos', 'Con frijoles', 'Con chorizo'];
  await enRafaga('s-c6', TANDA1, modelo);
  await enRafaga('s-c6', TANDA2, modelo);

  const novena = modelo.vistas[8];
  assert.equal(novena.length, 9, `la novena llamada vio ${novena.length} mensajes`);
  // Sigue siendo un prefijo causal EXACTO: nada del futuro.
  assert.deepEqual(novena, [...TANDA1, ...TANDA2]);
  // Y aun así, los seis últimos —que es lo que el extractor mira— arrastran
  // chipotle y huevo de la tanda anterior.
  const ventana = novena.slice(-6).join(' | ');
  assert(/chipotle/i.test(ventana), `la ventana ya no arrastra chipotle: ${ventana}`);
  assert(/huevo/i.test(ventana), `la ventana ya no arrastra huevo: ${ventana}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// ONTOLOGÍA — el modelo propone; el catálogo decide qué grupos existen
// ═══════════════════════════════════════════════════════════════════════════

const SENCILLOS = 'Chilaquiles Sencillos';
const gruposReales = ['Salsa', 'Proteína', 'Guarniciones'];
const ambiguasDe = (grupo, opciones, texto) => opcionesAmbiguas({
  catalogo: CARTA, producto: SENCILLOS, grupo, opciones, texto,
}).ambiguas;

await t('G1. grupo inventado «acompañamientos» + «frijolitos» → Guarniciones', async () => {
  const [a] = ambiguasDe('acompañamientos', ['frijolitos'], 'Con frijolitos');
  assert(a, 'no detectó la ambigüedad');
  assert.equal(a.grupo, 'Guarniciones', `grupo=${a.grupo}`);
});

await t('G2. grupo inventado «complementos» + «chipotle» → Salsa', async () => {
  assert.equal(grupoRealDeLaOpcion(CARTA, SENCILLOS, 'complementos', 'chipotle'), 'Salsa');
});

await t('G3. grupo inventado «proteína» + «huevo estrellado» → Proteína canónica', async () => {
  assert.equal(grupoRealDeLaOpcion(CARTA, SENCILLOS, 'proteína', 'huevo estrellado'), 'Proteína');
});

await t('G4. grupo inventado + opción inexistente → ninguna ambigüedad libre', async () => {
  const a = ambiguasDe('complementos', ['aguacate'], 'con aguacate');
  for (const x of a) {
    assert(gruposReales.includes(x.grupo),
      `se coló un grupo libre «${x.grupo}» con candidatos ${JSON.stringify(x.candidatos || x.empatan)}`);
  }
});

await t('G5. dos nombres inventados para la MISMA duda → UN pendiente', async () => {
  // Es el caso exacto del smoke: «acompañamientos» y «complementos», los dos
  // hablando de lo mismo. Es UNA duda —las mismas dos guarniciones— y tiene
  // que salir UN pendiente.
  //
  // Lo que separa las dos entradas es EXACTAMENTE el nombre libre del grupo,
  // así que si la huella se calcula antes de canonizar, la duda se parte en
  // dos. Es la mitad «deduplicar en el orden equivocado» del defecto.
  const a1 = ambiguasDe('acompañamientos', ['frijolitos'], 'Con frijolitos');
  const a2 = ambiguasDe('complementos', ['frijolitos'], 'Con frijolitos');
  const todas = [...a1, ...a2].map((x) => ({ ...x, lid: 'L1' }));
  const fuera = recolectarAclaraciones({ opcionesAmbiguas: todas })
    .filter((x) => x.tipo === 'opcion_ambigua');
  assert.equal(fuera.length, 1, `${fuera.length} pendientes para una duda: ${JSON.stringify(fuera)}`);
  assert.equal(fuera[0].grupo, 'Guarniciones', `grupo=${fuera[0].grupo}`);
});

await t('G6. «frijolitos» pregunta con las entidades REALES, no con la palabra suelta', async () => {
  const [a] = ambiguasDe('acompañamientos', ['frijolitos'], 'Con frijolitos');
  const fuera = recolectarAclaraciones({ opcionesAmbiguas: [{ ...a, lid: 'L1' }] })
    .find((x) => x.tipo === 'opcion_ambigua');
  assert(fuera, 'no produjo aclaración');
  assert.deepEqual([...fuera.candidatos].sort(), ['Frijolitos con chorizo', 'Frijolitos naturales'],
    `candidatos=${JSON.stringify(fuera.candidatos)}`);
  // Y la pregunta no puede llevar la palabra cruda del modelo como si fuera
  // una opción de la carta.
  assert(!/¿frijolitos[?,]/i.test(fuera.pregunta || ''), `pregunta=${fuera.pregunta}`);
});

await t('G7. «queso azul» no se convierte por parecido débil en otro queso', async () => {
  const a = ambiguasDe('complementos', ['queso azul'], 'con queso azul');
  for (const x of a) {
    const cands = x.candidatos || x.empatan || [];
    assert(!cands.some((c) => /panela/i.test(c)),
      `un parecido débil lo llevó a ${JSON.stringify(cands)}`);
  }
});

await t('G10. una opción sin competencia se RETIRA, pero no se pregunta', async () => {
  // El otro origen de las preguntas de una palabra del smoke real. Cuando el
  // cliente dice «mejor chipotle» y el modelo propone además la Suiza que ya
  // estaba, la Suiza no tiene respaldo en el texto: sale de la propuesta —eso
  // es correcto y hay una suite entera que lo exige— pero no hay duda ninguna
  // que plantearle a nadie. Una duda necesita al menos dos entidades.
  const a = opcionesAmbiguas({
    catalogo: CARTA, producto: SENCILLOS, grupo: 'Salsa',
    opciones: ['Suiza', 'Chipotle'], texto: 'Mejor chipotle',
  });
  assert.deepEqual(a.claras, ['Chipotle'], `claras=${JSON.stringify(a.claras)}`);
  assert.equal(a.ambiguas.length, 1, 'la Suiza tiene que salir de la propuesta');
  assert.deepEqual(a.ambiguas[0].candidatos, [], 'no hay entre qué dudar');
  const fuera = recolectarAclaraciones({
    opcionesAmbiguas: a.ambiguas.map((x) => ({ ...x, lid: 'L1' })),
  }).filter((x) => x.tipo === 'opcion_ambigua');
  assert.equal(fuera.length, 0, `preguntó sin necesidad: ${JSON.stringify(fuera.map((x) => x.pregunta))}`);
});

await t('G9. dos dudas DISTINTAS siguen siendo dos: canonizar no las funde', async () => {
  // La otra mitad de la regla. Colapsar es correcto sólo cuando la duda es la
  // misma; «¿qué guarnición?» y «¿qué proteína?» son dos preguntas y tienen
  // que seguir siéndolo después de anclar los grupos.
  const guarn = ambiguasDe('acompañamientos', ['frijolitos'], 'Con frijolitos y huevo');
  const prot = ambiguasDe('proteína', ['huevos'], 'Con frijolitos y huevo');
  const todas = [...guarn, ...prot].map((x) => ({ ...x, lid: 'L1' }));
  assert(todas.length >= 2, `el caso no ejercita la regla: ${JSON.stringify(todas)}`);
  const fuera = recolectarAclaraciones({ opcionesAmbiguas: todas })
    .filter((x) => x.tipo === 'opcion_ambigua');
  assert.equal(fuera.length, 2, `fundió dudas distintas: ${JSON.stringify(fuera)}`);
  assert.deepEqual(fuera.map((x) => x.grupo).sort(), ['Guarniciones', 'Proteína']);
});

await t('G8. INVARIANTE: ningún pendiente lleva un grupo fuera del catálogo', async () => {
  const casos = [
    ['acompañamientos', ['frijolitos'], 'Con frijolitos'],
    ['complementos', ['frijolitos'], 'Con frijolitos'],
    ['complementos', ['chipotle'], 'También chipotle porfa'],
    ['proteína', ['huevo estrellado'], 'Y huevos estrellados'],
    ['acompañamientos', ['chorizo'], 'Con chorizo'],
    ['toppings', ['frijoles'], 'Con frijoles'],
  ];
  const todas = casos.flatMap(([gr, ops, txt]) => ambiguasDe(gr, ops, txt).map((x) => ({ ...x, lid: 'L1' })));
  const fuera = recolectarAclaraciones({ opcionesAmbiguas: todas })
    .filter((x) => x.tipo === 'opcion_ambigua');
  for (const x of fuera) {
    assert(gruposReales.includes(x.grupo),
      `pendiente con grupo fuera de la carta: «${x.grupo}» (${JSON.stringify(x.candidatos)})`);
  }
  // Y ningún candidato puede ser una palabra que no esté en la carta.
  const legales = new Set([...SALSAS, ...PROTS, ...GUARNS].map((s) => s.toLowerCase()));
  for (const x of fuera) {
    for (const c of x.candidatos) {
      assert(legales.has(String(c).toLowerCase()),
        `candidato inventado «${c}» en el grupo ${x.grupo}`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// EL SMOKE DEL 15-SEP, CON LOS BORRADORES QUE GPT DEVOLVIÓ DE VERDAD
// ═══════════════════════════════════════════════════════════════════════════
//
// Los grupos son los que escribió el modelo en producción —«acompañamientos»,
// «complementos», «proteína»—, no versiones amables. El pedido tiene que salir
// bien A PESAR de ellos, y ningún pendiente puede quedarse con uno.

const GUION_SMOKE = [
  ['Quiero chilaquiles suizos', { items: [{ nombre: 'chilaquiles suizos', cantidad: 1, modificadores: [], notas: '' }] }],
  ['Con frijolitos', { items: [{ nombre: 'chilaquiles', cantidad: 1, notas: '',
    modificadores: [{ grupo: 'acompañamientos', opciones: ['frijolitos'] }] }] }],
  ['Con chorizo', { items: [{ nombre: 'chilaquiles', cantidad: 1, notas: '',
    modificadores: [{ grupo: 'acompañamientos', opciones: ['chorizo'] }] }] }],
  ['Y huevos estrellados', { items: [{ nombre: 'chilaquiles', cantidad: 1, notas: '',
    modificadores: [{ grupo: 'proteína', opciones: ['huevo estrellado'] }] }] }],
  ['También chipotle porfa', { items: [{ nombre: 'chilaquiles', cantidad: 1, notas: '',
    modificadores: [{ grupo: 'complementos', opciones: ['chipotle'] }] }] }],
  ['Que licuados tienes?', { items: [{ nombre: 'chilaquiles suizos', cantidad: 1, modificadores: [], notas: '' }] }],
];

const modeloDelSmoke = () => {
  let i = 0;
  return async () => (GUION_SMOKE[i++] || [null, { items: [] }])[1];
};

const gruposDePendientes = (sessionId) =>
  (verEstadoSombra('n-causal', sessionId)?.contexto?.pendientes || [])
    .filter((p) => p.tipo === 'opcion_ambigua' || p.tipo === 'grupo_requerido')
    .map((p) => String(p.grupo || ''));

const opcionesDe = (sessionId, gr) => {
  const it = (verEstadoSombra('n-causal', sessionId)?.carrito?.items || [])[0];
  return (it?.modificadores || []).filter((m) => String(m.grupo).toLowerCase() === gr.toLowerCase())
    .flatMap((m) => (m.opciones || []).map((o) => (typeof o === 'string' ? o : o?.nombre))).sort();
};

await t('L. el smoke entero EN RÁFAGA: ningún turno ve el futuro', async () => {
  reiniciarSombraMesero();
  const vistas = [];
  const modelo = async (mensajes) => {
    vistas.push((mensajes || []).map((m) => m.content));
    return GUION_SMOKE[vistas.length - 1]?.[1] || { items: [] };
  };
  await enRafaga('s-rafaga', GUION_SMOKE.map(([x]) => x), modelo);

  // El caso exacto del smoke: el turno de «Con chorizo» es el tercero.
  const tercera = vistas[2].join(' | ');
  assert(!/chipotle/i.test(tercera), `«Con chorizo» vio chipotle: ${tercera}`);
  assert(!/huevo/i.test(tercera), `«Con chorizo» vio huevo: ${tercera}`);
  assert(!/licuados/i.test(tercera), `«Con chorizo» vio la consulta final: ${tercera}`);
  for (const [i, v] of vistas.entries()) {
    assert.deepEqual(v, GUION_SMOKE.slice(0, i + 1).map(([x]) => x),
      `la llamada ${i + 1} vio ${JSON.stringify(v)}`);
  }
});

await t('M. el smoke entero SECUENCIAL: un renglón, un lid, sin grupos inventados', async () => {
  reiniciarSombraMesero();
  const modelo = modeloDelSmoke();
  let lid = null;
  for (const [texto] of GUION_SMOKE) {
    await observarTurnoDelMesero({
      sessionId: 's-sec', negocioId: 'n-causal', mensaje: texto, cargarCatalogo, proponer: modelo,
    });
    const items = verEstadoSombra('n-causal', 's-sec')?.carrito?.items || [];
    assert.equal(items.length, 1, `«${texto}» dejó ${items.length} renglones`);
    lid = lid || items[0].lid;
    assert.equal(items[0].lid, lid, `«${texto}» cambió el lid`);
    // LA GUARDA, turno a turno: ningún pendiente puede nombrar un grupo que no
    // esté en la carta del producto.
    for (const g of gruposDePendientes('s-sec')) {
      assert(gruposReales.includes(g), `tras «${texto}» quedó un pendiente con grupo «${g}»`);
    }
  }
  // Y LO QUE EL GRUPO INVENTADO ESTABA ROBANDO: la resolución del pendiente.
  //
  // Sin canonizar, «Con frijolitos» abría DOS dudas —una con grupo
  // «acompañamientos» y otra con «Guarniciones»— y «Con chorizo» no resolvía
  // ninguna: el pedido acababa SIN guarnición y con el grupo requerido abierto
  // hasta el final. Medido lado a lado sobre este mismo guion. Anclar el grupo
  // no sólo limpia el nombre: es lo que deja que la respuesta del cliente
  // encuentre su pregunta.
  assert.deepEqual(opcionesDe('s-sec', 'Guarniciones'), ['Frijolitos con chorizo'],
    `Guarniciones=${JSON.stringify(opcionesDe('s-sec', 'Guarniciones'))}`);
  assert.deepEqual(opcionesDe('s-sec', 'Proteína'), ['Huevos Estrellados'],
    `Proteína=${JSON.stringify(opcionesDe('s-sec', 'Proteína'))}`);
});

await t('M2. DEUDA CONOCIDA (fuera de alcance): «también» con grupo parcial REEMPLAZA', async () => {
  // Esto NO es una garantía: es un defecto conocido, anclado aquí para que se
  // sepa que sigue vivo y para que esta prueba AVISE el día que se arregle.
  //
  // Cuando el borrador nombra el producto de forma que empareja con el renglón
  // y manda el grupo con SÓLO la opción nueva, el camino de siempre emite un
  // `cambiar_modificador` que sustituye el grupo entero: «También chipotle
  // porfa» se lleva por delante la Suiza que el cliente pidió en el primer
  // turno. Es del reconciliador, es anterior a este trabajo —medido con y sin
  // el arreglo de grupos, idéntico en los dos— y el mandato lo deja fuera.
  //
  // En el tráfico real del 15-sep no se vio porque GPT repitió los tres grupos
  // en su borrador; con un borrador parcial, se ve.
  assert.deepEqual(opcionesDe('s-sec', 'Salsa'), ['Chipotle'],
    `si esto falla, la deuda del reconciliador ya se arregló: actualiza esta prueba `
    + `(Salsa=${JSON.stringify(opcionesDe('s-sec', 'Salsa'))})`);
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
