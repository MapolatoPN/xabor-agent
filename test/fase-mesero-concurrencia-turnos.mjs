// ─── DOS TURNOS A LA VEZ SOBRE LA MISMA CONVERSACIÓN ──────────────────────
//
// La condición que se vio en el primer día de tráfico real, en Obispado:
//
//   turno A lee contexto N
//   turno B llega antes de que A termine
//   turno B también lee contexto N
//   A tarda ~800 ms en el modelo
//   B tarda ~800 ms en el modelo
//   A guarda N+1
//   B guarda OTRO N+1          ← el último escritor pisa al anterior
//
// El renglón de Chilaquiles y el texto de su ciclo desaparecían del contexto
// sombra, y a partir de ahí el modelo re-proponía un artículo sin respaldo: la
// «aclaración pegada» del log no era una pregunta guardada, era la misma
// pregunta REGENERADA cada turno.
//
// ── Qué prueba esta suite, y qué NO ──────────────────────────────────────
//
// No prueba que «el síntoma ya no aparece». Prueba el MECANISMO: que mientras
// un turno de una conversación está dentro del modelo, ningún otro turno de esa
// misma conversación llega a leer el estado. Eso se mide directamente —contando
// las llamadas al modelo mientras la primera sigue abierta— y no por el efecto.
//
// El solape es FORZADO, no provocado con esperas: el modelo de esta suite es
// una puerta que la prueba abre a mano. Sin eso, una prueba de concurrencia
// pasa o falla según lo ocupada que esté la máquina.
//
// ── Y la otra mitad: que NO se serialice a todo el mundo ─────────────────
//
// Un candado global también haría pasar todo lo de arriba, y sería una
// regresión grave: un cliente lento bloquearía a los demás. C7 lo comprueba.
import assert from 'node:assert/strict';
import {
  observarTurnoDelMesero, reiniciarSombraMesero, verEstadoSombra,
  TOPE_CONVERSACIONES, TOPE_TURNOS,
} from '../src/mesero-whatsapp/sombraDelMesero.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

// ── La carta ─────────────────────────────────────────────────────────────
const grupo = (nombre, opciones, requerido = false) => ({
  nombre, requerido, minimo: requerido ? 1 : 0, maximo: 1,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
const CARTA = [
  { id: 1, nombre: 'Fuertes', productos: [
    { id: 11, nombre: 'Chilaquiles', precio: 130, disponible: true, agotado: false, modificadores: [
      grupo('Proteina', ['Pollo', 'Res']),
      grupo('Guarnicion', ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas naturales']),
    ] },
  ] },
  { id: 2, nombre: 'Bebidas', productos: [
    { id: 21, nombre: 'Licuado de fresa', precio: 60, disponible: true, agotado: false, modificadores: [] },
    { id: 22, nombre: 'Licuado de platano', precio: 60, disponible: true, agotado: false, modificadores: [] },
  ] },
];
const cargarCatalogo = async () => CARTA;
const it = (nombre, modificadores = []) => ({ nombre, cantidad: 1, modificadores, notas: '' });
const mod = (g, ...opciones) => ({ grupo: g, opciones });

/**
 * Un modelo con PUERTA.
 *
 * Cada llamada se registra y se queda esperando a que la prueba la suelte. Es
 * lo que convierte «dos turnos casi a la vez» en «dos turnos exactamente donde
 * yo quiero», sin un solo `setTimeout` de por medio.
 */
function modeloConPuertas() {
  const llamadas = [];
  const fn = async () => {
    let abrir;
    const espera = new Promise((r) => { abrir = r; });
    const registro = { abrir, espera, borrador: { items: [] } };
    llamadas.push(registro);
    await espera;
    return registro.borrador;
  };
  fn.llamadas = llamadas;
  // Espera activa sobre la cola de microtareas: determinista, sin reloj.
  fn.hastaQueHaya = async (n, vueltas = 200) => {
    for (let i = 0; i < vueltas && llamadas.length < n; i++) {
      await new Promise((r) => setImmediate(r));
    }
    return llamadas[n - 1];
  };
  /** Deja correr la cola de microtareas sin esperar nada en concreto. */
  fn.respirar = async (vueltas = 60) => {
    for (let i = 0; i < vueltas; i++) await new Promise((r) => setImmediate(r));
  };
  return fn;
}

const observar = (sessionId, mensaje, proponer, extra = {}) => observarTurnoDelMesero({
  sessionId, negocioId: 'n-conc', mensaje, cargarCatalogo, proponer, ...extra,
});

const itemsDe = (sessionId) => {
  const e = verEstadoSombra('n-conc', sessionId);
  return (e?.carrito?.items || []).map((i) => ({
    n: i.nombre,
    m: (i.modificadores || []).flatMap((g) => (g.opciones || [])
      .map((o) => (typeof o === 'string' ? o : o.nombre))).sort(),
  }));
};
const contextoDe = (sessionId) => verEstadoSombra('n-conc', sessionId)?.contexto || null;

/**
 * El caso mínimo del enunciado, y el corazón de toda la suite.
 *
 * Devuelve lo necesario para que cada prueba afirme lo suyo.
 */
async function dosTurnosSolapados(sessionId, textoA, borradorA, textoB, borradorB) {
  reiniciarSombraMesero();
  const proponer = modeloConPuertas();

  // A entra y se queda DENTRO del modelo, con el estado ya leído.
  const pA = observar(sessionId, textoA, proponer);
  const a = await proponer.hastaQueHaya(1);

  // B entra mientras A sigue dentro.
  const pB = observar(sessionId, textoB, proponer);
  await proponer.respirar();

  // LA AFIRMACIÓN QUE IMPORTA: B no ha leído nada todavía.
  const bEntroAntesDeTiempo = proponer.llamadas.length > 1;

  a.borrador = borradorA;
  a.abrir();
  const b = await proponer.hastaQueHaya(2);
  b.borrador = borradorB;
  b.abrir();

  const [rA, rB] = await Promise.all([pA, pB]);
  return { rA, rB, bEntroAntesDeTiempo, proponer };
}

// ═══════════════════════════════════════════════════════════════════════════
// FASE 5 — EL CASO MÍNIMO
// ═══════════════════════════════════════════════════════════════════════════

await t('K1. con A dentro del modelo, B NO llega a leer el estado', async () => {
  const { bEntroAntesDeTiempo } = await dosTurnosSolapados(
    's-k1',
    'Quiero unos chilaquiles', { items: [it('Chilaquiles')] },
    'Con pollo', { items: [it('Chilaquiles', [mod('Proteina', 'Pollo')])] },
  );
  assert.equal(bEntroAntesDeTiempo, false,
    'dos turnos de la misma conversación leyeron el estado a la vez');
});

await t('K2. no se pierde ni el renglón ni el modificador', async () => {
  const { rA, rB } = await dosTurnosSolapados(
    's-k2',
    'Quiero unos chilaquiles', { items: [it('Chilaquiles')] },
    'Con pollo', { items: [it('Chilaquiles', [mod('Proteina', 'Pollo')])] },
  );
  assert.equal(rA.ok, true, rA.motivo);
  assert.equal(rB.ok, true, rB.motivo);
  assert.deepEqual(itemsDe('s-k2'), [{ n: 'Chilaquiles', m: ['Pollo'] }],
    'se perdió el renglón o el «con pollo»');
});

await t('K3. el turno avanza DOS veces, y en el orden en que llegaron', async () => {
  await dosTurnosSolapados(
    's-k3',
    'Quiero unos chilaquiles', { items: [it('Chilaquiles')] },
    'Con pollo', { items: [it('Chilaquiles', [mod('Proteina', 'Pollo')])] },
  );
  const ctx = contextoDe('s-k3');
  assert.equal(ctx.contador, 2, `el contador quedó en ${ctx.contador}: un turno pisó al otro`);
  const dichos = ctx.turnos.filter((x) => x.rol === 'cliente').map((x) => x.texto);
  assert.deepEqual(dichos, ['Quiero unos chilaquiles', 'Con pollo'],
    `el orden de los turnos no es el de llegada: ${JSON.stringify(dichos)}`);
});

await t('K4. el segundo turno arranca del estado que dejó el primero, no del inicial', async () => {
  reiniciarSombraMesero();
  const proponer = modeloConPuertas();
  const pA = observar('s-k4', 'Quiero unos chilaquiles', proponer);
  const a = await proponer.hastaQueHaya(1);
  const pB = observar('s-k4', 'Con pollo', proponer);
  await proponer.respirar();
  a.borrador = { items: [it('Chilaquiles')] };
  a.abrir();
  await pA;
  const b = await proponer.hastaQueHaya(2);
  // Cuando B por fin entra, el estado YA tiene el renglón de A.
  assert.deepEqual(itemsDe('s-k4'), [{ n: 'Chilaquiles', m: [] }],
    'B arrancó de un estado sin el renglón de A');
  b.borrador = { items: [it('Chilaquiles', [mod('Proteina', 'Pollo')])] };
  b.abrir();
  await pB;
  assert.deepEqual(itemsDe('s-k4'), [{ n: 'Chilaquiles', m: ['Pollo'] }]);
});

await t('K5. no reaparece una aclaración por pérdida de estado', async () => {
  // Es el síntoma exacto del log: perdido el renglón, el modelo lo re-propone
  // sin respaldo y la MISMA pregunta vuelve a nacer turno tras turno.
  const { rB } = await dosTurnosSolapados(
    's-k5',
    'Quiero unos chilaquiles', { items: [it('Chilaquiles')] },
    'Frijolitos', { items: [it('Chilaquiles', [mod('Guarnicion', 'Frijolitos naturales')])] },
  );
  const pendientes = contextoDe('s-k5').pendientes || [];
  const dupes = pendientes.map((p) => p.clave).filter((c, i, a) => a.indexOf(c) !== i);
  assert.deepEqual(dupes, [], `hay pendientes duplicados: ${JSON.stringify(pendientes)}`);
  const guar = pendientes.find((p) => p.grupo === 'Guarnicion');
  assert(guar, 'se perdió la ambigüedad de los frijolitos');
  assert.equal(guar.turnoCreacion, 2, `la pregunta nació en el turno ${guar.turnoCreacion}`);
  assert.equal(rB.registro.pedido_hipotetico.length, 1, 'el pedido hipotético perdió su renglón');
});

// ═══════════════════════════════════════════════════════════════════════════
// FASE 6 — MÁS CASOS
// ═══════════════════════════════════════════════════════════════════════════

await t('C1. «unos chilaquiles» + «frijolitos»', async () => {
  const { bEntroAntesDeTiempo } = await dosTurnosSolapados(
    's-c1',
    'unos chilaquiles', { items: [it('Chilaquiles')] },
    'frijolitos', { items: [it('Chilaquiles', [mod('Guarnicion', 'Frijolitos naturales')])] },
  );
  assert.equal(bEntroAntesDeTiempo, false);
  // La palabra no separa las dos de frijolitos: NO se elige ninguna, y eso
  // tiene que sobrevivir al solape.
  assert.deepEqual(itemsDe('s-c1'), [{ n: 'Chilaquiles', m: [] }]);
  const p = (contextoDe('s-c1').pendientes || []).find((x) => x.grupo === 'Guarnicion');
  assert(p, 'la ambigüedad se perdió en el solape');
  assert.deepEqual(p.candidatos.slice().sort(), ['Frijolitos con chorizo', 'Frijolitos naturales']);
});

await t('C2. «frijolitos» + «con chorizo»: el segundo resuelve al primero', async () => {
  reiniciarSombraMesero();
  const proponer = modeloConPuertas();
  // Primero el platillo, ya asentado.
  const p0 = observar('s-c2', 'unos chilaquiles', proponer);
  (await proponer.hastaQueHaya(1)).borrador = { items: [it('Chilaquiles')] };
  proponer.llamadas[0].abrir();
  await p0;

  const pA = observar('s-c2', 'frijolitos', proponer);
  const a = await proponer.hastaQueHaya(2);
  const pB = observar('s-c2', 'con chorizo', proponer);
  await proponer.respirar();
  assert.equal(proponer.llamadas.length, 2, 'B leyó el estado mientras A seguía dentro');
  a.borrador = { items: [it('Chilaquiles', [mod('Guarnicion', 'Frijolitos naturales')])] };
  a.abrir();
  const b = await proponer.hastaQueHaya(3);
  b.borrador = { items: [it('Chilaquiles', [mod('Guarnicion', 'Frijolitos con chorizo')])] };
  b.abrir();
  await Promise.all([pA, pB]);
  assert.deepEqual(itemsDe('s-c2'), [{ n: 'Chilaquiles', m: ['Frijolitos con chorizo'] }],
    'el desempate se perdió en el solape');
  assert.equal((contextoDe('s-c2').pendientes || []).some((x) => x.grupo === 'Guarnicion'), false,
    'la pregunta sobrevivió a su respuesta');
});

await t('C3. «un licuado» + «de fresa»', async () => {
  const { bEntroAntesDeTiempo } = await dosTurnosSolapados(
    's-c3',
    'un licuado', { items: [] },
    'de fresa', { items: [it('Licuado de fresa')] },
  );
  assert.equal(bEntroAntesDeTiempo, false);
  assert.deepEqual(itemsDe('s-c3'), [{ n: 'Licuado de fresa', m: [] }]);
  assert.equal(contextoDe('s-c3').contador, 2);
});

await t('C4. «para domicilio» + la dirección: ni se pierde el turno ni se publica la calle', async () => {
  const { rB, bEntroAntesDeTiempo } = await dosTurnosSolapados(
    's-c4',
    'para domicilio', { items: [it('Chilaquiles')] },
    'Calle Nogal 900, col. Alamos', { items: [it('Chilaquiles')] },
  );
  assert.equal(bEntroAntesDeTiempo, false);
  assert.equal(contextoDe('s-c4').contador, 2);
  // La señal de entrega la fijó el turno A; el turno B tiene que verla, y eso
  // solo ocurre si B corrió DESPUÉS y sobre el mismo estado.
  assert(!/Nogal|Alamos/i.test(rB.linea), `se publicó la dirección: ${rB.linea}`);
  assert.equal(rB.registro.direccion_redactada, true, rB.registro.dijo);
});

await t('C5. terminar en orden inverso al de llegada es IMPOSIBLE, y eso es la garantía', async () => {
  // Con una cola por conversación, B no puede acabar antes que A porque ni
  // siquiera empieza. Se comprueba intentándolo: se mantiene A abierta y se
  // verifica que no hay ninguna segunda llamada que soltar.
  reiniciarSombraMesero();
  const proponer = modeloConPuertas();
  const pA = observar('s-c5', 'unos chilaquiles', proponer);
  const a = await proponer.hastaQueHaya(1);
  const pB = observar('s-c5', 'con pollo', proponer);
  await proponer.respirar(200);
  assert.equal(proponer.llamadas.length, 1,
    'B llegó al modelo con A todavía dentro: el orden de terminación no está protegido');
  let bTermino = false;
  pB.then(() => { bTermino = true; });
  await proponer.respirar();
  assert.equal(bTermino, false, 'B terminó antes que A');
  a.borrador = { items: [it('Chilaquiles')] };
  a.abrir();
  const b = await proponer.hastaQueHaya(2);
  b.borrador = { items: [it('Chilaquiles', [mod('Proteina', 'Pollo')])] };
  b.abrir();
  await Promise.all([pA, pB]);
  assert.deepEqual(itemsDe('s-c5'), [{ n: 'Chilaquiles', m: ['Pollo'] }]);
});

await t('C6. tres mensajes solapados se aplican los tres, en orden', async () => {
  reiniciarSombraMesero();
  const proponer = modeloConPuertas();
  const p1 = observar('s-c6', 'unos chilaquiles', proponer);
  const a = await proponer.hastaQueHaya(1);
  const p2 = observar('s-c6', 'con pollo', proponer);
  const p3 = observar('s-c6', 'y un licuado de fresa', proponer);
  await proponer.respirar();
  assert.equal(proponer.llamadas.length, 1, 'entraron varios turnos a la vez');

  a.borrador = { items: [it('Chilaquiles')] };
  a.abrir();
  const b = await proponer.hastaQueHaya(2);
  await proponer.respirar();
  assert.equal(proponer.llamadas.length, 2, 'el tercero se coló con el segundo dentro');
  b.borrador = { items: [it('Chilaquiles', [mod('Proteina', 'Pollo')])] };
  b.abrir();
  const c = await proponer.hastaQueHaya(3);
  c.borrador = { items: [it('Chilaquiles', [mod('Proteina', 'Pollo')]), it('Licuado de fresa')] };
  c.abrir();

  await Promise.all([p1, p2, p3]);
  assert.deepEqual(itemsDe('s-c6'),
    [{ n: 'Chilaquiles', m: ['Pollo'] }, { n: 'Licuado de fresa', m: [] }]);
  const ctx = contextoDe('s-c6');
  assert.equal(ctx.contador, 3, `el contador quedó en ${ctx.contador}`);
  assert.deepEqual(ctx.turnos.filter((x) => x.rol === 'cliente').map((x) => x.texto),
    ['unos chilaquiles', 'con pollo', 'y un licuado de fresa']);
});

await t('C7. dos conversaciones DISTINTAS sí corren a la vez', async () => {
  // La otra mitad de la garantía. Un candado global haría pasar C1–C6 y sería
  // una regresión grave: un cliente lento dejaría a los demás sin observar.
  reiniciarSombraMesero();
  const proponer = modeloConPuertas();
  const pX = observar('s-c7-x', 'unos chilaquiles', proponer);
  await proponer.hastaQueHaya(1);
  const pY = observar('s-c7-y', 'un licuado de fresa', proponer);
  const segunda = await proponer.hastaQueHaya(2, 400);
  assert(segunda, 'la segunda conversación se quedó esperando a la primera: el candado es GLOBAL');

  proponer.llamadas[0].borrador = { items: [it('Chilaquiles')] };
  proponer.llamadas[1].borrador = { items: [it('Licuado de fresa')] };
  // Se sueltan en orden inverso, para que ninguna dependa de la otra.
  proponer.llamadas[1].abrir();
  proponer.llamadas[0].abrir();
  await Promise.all([pX, pY]);
  assert.deepEqual(itemsDe('s-c7-x'), [{ n: 'Chilaquiles', m: [] }]);
  assert.deepEqual(itemsDe('s-c7-y'), [{ n: 'Licuado de fresa', m: [] }]);
});

await t('C8. un turno que revienta libera la cola: el siguiente no se queda colgado', async () => {
  // Si el candado no se soltara en un `finally`, un fallo del modelo dejaría la
  // conversación muda para siempre — y sería peor que la carrera original.
  reiniciarSombraMesero();
  let primera = true;
  const proponer = async () => {
    if (primera) { primera = false; throw new Error('el modelo explotó'); }
    return { items: [it('Chilaquiles')] };
  };
  const r1 = await observar('s-c8', 'unos chilaquiles', proponer);
  const r2 = await observar('s-c8', 'unos chilaquiles', proponer);
  assert.equal(r1.ok, true, 'el fallo del modelo debía contenerse, no tumbar la observación');
  assert.equal(r1.registro.handoff, 'ERROR', JSON.stringify(r1.registro.handoff));
  assert.equal(r2.ok, true, 'la conversación quedó bloqueada tras un fallo');
  assert.deepEqual(itemsDe('s-c8'), [{ n: 'Chilaquiles', m: [] }]);
});

await t('C9. una conversación OCUPADA no se desaloja por tope de conversaciones', async () => {
  // El desalojo a ciegas es la puerta de atrás del candado: si se tira del mapa
  // una conversación que tiene un turno dentro, su cola desaparece y el
  // siguiente mensaje de esa misma conversación arranca de cero EN PARALELO.
  reiniciarSombraMesero();
  const proponer = modeloConPuertas();

  // La víctima entra primero (es la más vieja) y se queda dentro del modelo.
  const pVictima = observar('s-c9-victima', 'unos chilaquiles', proponer);
  const dentro = await proponer.hastaQueHaya(1);

  // Se llena el mapa hasta el tope con conversaciones que terminan solas.
  const rapidito = async () => ({ items: [] });
  for (let i = 0; i < TOPE_CONVERSACIONES + 2; i++) {
    await observar(`s-c9-relleno-${i}`, 'hola', rapidito);
  }

  // La víctima TIENE que seguir ahí: estaba ocupada.
  assert(verEstadoSombra('n-conc', 's-c9-victima'),
    'se desalojó una conversación con un turno dentro');

  dentro.borrador = { items: [it('Chilaquiles')] };
  dentro.abrir();
  await pVictima;
  assert.deepEqual(itemsDe('s-c9-victima'), [{ n: 'Chilaquiles', m: [] }],
    'el turno en vuelo escribió en un estado ya desalojado');
});

await t('C10. el tope de turnos se respeta aunque lleguen todos de golpe', async () => {
  // La comprobación de fuera del candado la pasa una ráfaga entera antes de que
  // ninguno incremente. La de dentro es la que manda.
  reiniciarSombraMesero();
  const rapidito = async () => ({ items: [] });
  const enVuelo = [];
  for (let i = 0; i < TOPE_TURNOS + 5; i++) {
    enVuelo.push(observar('s-c10', `mensaje ${i}`, rapidito));
  }
  const rs = await Promise.all(enVuelo);
  const observados = rs.filter((r) => r.ok).length;
  const rechazados = rs.filter((r) => !r.ok && r.motivo === 'tope_de_turnos').length;
  assert.equal(observados, TOPE_TURNOS,
    `se observaron ${observados} turnos con el tope en ${TOPE_TURNOS}`);
  assert.equal(rechazados, 5, `${rechazados} rechazos por tope, esperaba 5`);
  assert.equal(verEstadoSombra('n-conc', 's-c10').turnos, TOPE_TURNOS);
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
