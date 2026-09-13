// EL CONTEXTO DE LA ATENCIÃN, Y LO QUE EL BOT OFRECIÃ.
//
// Fases C y E del Mesero Digital. MÃ³dulos puros: esta suite no toca la base ni
// levanta servidor, asÃ­ que corre en segundos y puede correrse mil veces.
//
// Lo que defiende:
//
//   Â· un contexto pertenece a UN negocio y UNA conversaciÃ³n, y prestarlo no es
//     una opciÃ³n: si no coincide, se empieza de cero;
//   Â· sobrevive al viaje por JSON que hace el snapshot durable;
//   Â· el orden de apariciÃ³n de los renglones no se recalcula, porque de Ã©l
//     dependen Â«el primeroÂ» y Â«el segundoÂ»;
//   Â· una sugerencia del bot NO es un pedido, y un Â«sÃ­Â» solo autoriza la cosa
//     concreta que se le ofreciÃ³ al cliente;
//   Â· con dos propuestas abiertas, un Â«sÃ­Â» pelado no elige: pregunta;
//   Â· el mesero no se enciende sin el reconciliador que lo frena.
import assert from 'node:assert/strict';

const ctxMod = await import('../src/mesero-whatsapp/contextoMesa.js');
const {
  contextoNuevo, contextoDeLaConversacion, sanearContexto, anotarTurno, sincronizarLineas,
  tocarLinea, sincronizarPendientes, anotarIntentoFallido, marcarPreguntado,
  tienePendiente, preguntadoRecientemente, clavePendiente,
  turnosDelCliente, ultimoTurnoDelBot, resumenDelContexto, TURNOS_RECORDADOS,
} = ctxMod;

const {
  proponer, leerRespuesta, aplicarDesenlace, propuestasVivas, fueRechazada, fueConfirmada,
  caducarViejas, evidenciaDeAceptacion, rechazadas, PROPUESTO, CONFIRMADO, RECHAZADO,
} = await import('../src/mesero-whatsapp/propuestasDelBot.js');

const { modoDelPedido } = await import('../src/orders/modoDelPedido.js');

let ok = 0, fail = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); ok++; console.log(`  OK  ${nombre}`); }
  catch (e) { fail++; fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}

const carrito = (...lids) => ({ items: lids.map((lid) => ({ lid, nombre: `p-${lid}`, cantidad: 1 })), datos: {} });

// â¬â¬ FASE C â¬ el contexto â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬

await t('C1. un contexto nuevo trae todos sus campos y no inventa ninguno', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  for (const campo of ['negocioId', 'conversacionId', 'fase', 'lineas', 'foco', 'referencias',
    'pendientes', 'modalidad', 'pago', 'propuestas', 'aclaraciones', 'turnos', 'contador']) {
    assert(campo in c, `falta ${campo}`);
  }
  assert.equal(c.fase, 'inicio');
  assert.deepEqual(c.lineas, []);
  assert.equal(c.foco, null);
  assert.equal(c.contador, 0);
});

await t('C2. el contexto persiste entre turnos: el contador es el reloj', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'hola');
  anotarTurno(c, 'bot', 'buenas, Â¿quÃ© le sirvo?');
  anotarTurno(c, 'cliente', 'unos chilaquiles');
  assert.equal(c.contador, 3);
  assert.equal(turnosDelCliente(c).length, 2);
  assert.equal(ultimoTurnoDelBot(c).texto, 'buenas, Â¿quÃ© le sirvo?');
});

await t('C3. otra conversaciÃ³n del mismo negocio NO hereda el contexto', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'quiero dos hamburguesas');
  const otro = contextoDeLaConversacion(c, { negocioId: 'n1', conversacionId: 'conv2' });
  assert.equal(otro.contador, 0, 'se colÃ³ el historial de otra conversaciÃ³n');
  assert.equal(otro.turnos.length, 0);
  assert.equal(otro.conversacionId, 'conv2');
});

await t('C4. otro NEGOCIO con el mismo id de conversaciÃ³n tampoco lo hereda', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'lo de siempre');
  const otro = contextoDeLaConversacion(c, { negocioId: 'n2', conversacionId: 'conv1' });
  assert.equal(otro.contador, 0, 'contexto prestado entre negocios');
  assert.equal(otro.negocioId, 'n2');
});

await t('C5. el mismo par negocio+conversaciÃ³n SÃ lo recupera', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'unos chilaquiles');
  const mismo = contextoDeLaConversacion(c, { negocioId: 'n1', conversacionId: 'conv1' });
  assert.equal(mismo.contador, 1);
  assert.equal(mismo.turnos[0].texto, 'unos chilaquiles');
});

await t('C6. sobrevive el viaje por JSON del snapshot durable', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'unos chilaquiles');
  sincronizarLineas(c, carrito('a', 'b'));
  tocarLinea(c, 'b');
  sincronizarPendientes(c, [{ tipo: 'dato', dato: 'modalidad' }]);
  proponer(c, { clase: 'producto', referencia: 'CafÃ© Americano' });

  const vuelto = contextoDeLaConversacion(JSON.parse(JSON.stringify(c)),
    { negocioId: 'n1', conversacionId: 'conv1' });
  assert.equal(vuelto.contador, 1);
  assert.equal(vuelto.lineas.length, 2);
  assert.equal(vuelto.foco, 'b');
  assert(tienePendiente(vuelto, 'dato:modalidad'));
  assert.equal(vuelto.pendientes[0].tipo, 'dato', 'el pendiente perdiÃ³ su forma al viajar');
  assert.equal(vuelto.propuestas.length, 1);
  assert.equal(vuelto.propuestas[0].estado, PROPUESTO);
});

await t('C7. basura en el snapshot da un contexto nuevo, no una excepciÃ³n', () => {
  for (const basura of [null, undefined, 'texto', 42, [], { lineas: 'no', turnos: 7, fase: 'inventada' }]) {
    const c = sanearContexto(basura, { negocioId: 'n1', conversacionId: 'conv1' });
    assert.equal(c.fase, 'inicio');
    assert(Array.isArray(c.lineas) && Array.isArray(c.turnos));
    assert.equal(c.negocioId, 'n1');
  }
});

await t('C8. el orden de apariciÃ³n NO se recalcula al borrar un renglÃ³n', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'tres cosas');
  sincronizarLineas(c, carrito('a', 'b', 'c'));
  assert.deepEqual(c.lineas.map((l) => l.orden), [1, 2, 3]);
  // se va el segundo y entra uno nuevo: el primero sigue siendo el primero
  anotarTurno(c, 'cliente', 'quita el segundo y ponme otra cosa');
  sincronizarLineas(c, carrito('a', 'c', 'd'));
  const porLid = Object.fromEntries(c.lineas.map((l) => [l.lid, l.orden]));
  assert.equal(porLid.a, 1, 'el primero dejÃ³ de ser el primero');
  assert.equal(porLid.c, 3);
  assert.equal(porLid.d, 4, 'el nuevo reutilizÃ³ un orden ya usado');
});

await t('C9. el foco se suelta cuando su renglÃ³n desaparece', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'dos cosas');
  sincronizarLineas(c, carrito('a', 'b'));
  tocarLinea(c, 'b');
  assert.equal(c.foco, 'b');
  sincronizarLineas(c, carrito('a'));
  assert.equal(c.foco, null, 'el foco quedÃ³ apuntando a un fantasma');
});

await t('C10. un pendiente se guarda por lo que pregunta, no por cÃ³mo se redacta', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'unos chilaquiles');
  const opcion = { tipo: 'opcion_ambigua', lid: 'L1', producto: 'Chilaquiles', grupo: 'Guarnicion',
    candidatos: ['Frijoles naturales', 'Frijoles con chorizo'] };

  const uno = sincronizarPendientes(c, [opcion], { lidsVivos: ['L1'] });
  assert.deepEqual(uno, { creados: 1, resueltos: 0, cancelados: 0, obsoletos: 0, vivos: 1 });
  const p = c.pendientes[0];
  assert.equal(p.clave, clavePendiente(opcion));
  assert.deepEqual(p.candidatos, ['Frijoles naturales', 'Frijoles con chorizo']);
  assert.equal(p.intentos, 0);
  // NO se guarda ninguna frase: la pregunta se redacta a partir de esto.
  assert.equal(p.pregunta, undefined, 'el pendiente guardÃ³ la frase redactada');

  // El mismo pendiente otra vez no se duplica ni se recrea.
  anotarTurno(c, 'cliente', 'oye Â¿y quÃ© bebidas tienes?');
  const dos = sincronizarPendientes(c, [opcion], { lidsVivos: ['L1'] });
  assert.deepEqual(dos, { creados: 0, resueltos: 0, cancelados: 0, obsoletos: 0, vivos: 1 });
  assert.equal(c.pendientes.length, 1);
  assert.equal(c.pendientes[0].turnoCreacion, 1, 'se recreÃ³ un pendiente que no habÃ­a cambiado');

  // Y cuando deja de hacer falta, se resuelve.
  const tres = sincronizarPendientes(c, [], { lidsVivos: ['L1'] });
  assert.deepEqual(tres, { creados: 0, resueltos: 1, cancelados: 0, obsoletos: 0, vivos: 0 });
  assert.equal(tienePendiente(c, 'opcion_ambigua:L1:Guarnicion'), false);
});

await t('C10b. si su lÃ­nea desaparece, el pendiente se CANCELA, no se resuelve', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'unos chilaquiles');
  sincronizarPendientes(c, [{ tipo: 'grupo_requerido', lid: 'L1', producto: 'Chilaquiles',
    grupo: 'Salsa', candidatos: ['Verde', 'Roja'] }], { lidsVivos: ['L1'] });
  anotarTurno(c, 'cliente', 'mejor quita los chilaquiles');
  const ciclo = sincronizarPendientes(c, [], { lidsVivos: [] });
  assert.deepEqual(ciclo, { creados: 0, resueltos: 0, cancelados: 1, obsoletos: 0, vivos: 0 },
    'una pregunta sobre un platillo que ya no existe no se Â«resolviÃ³Â»: se cayÃ³ con Ã©l');
  assert.deepEqual(c.pendientes, []);
});

await t('C10c. si cambian los candidatos, la pregunta vieja queda OBSOLETA', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'unos chilaquiles');
  const antes = { tipo: 'opcion_ambigua', lid: 'L1', grupo: 'Guarnicion',
    candidatos: ['Frijoles naturales', 'Frijoles con chorizo'] };
  sincronizarPendientes(c, [antes], { lidsVivos: ['L1'] });
  anotarIntentoFallido(c, c.pendientes[0].clave);
  assert.equal(c.pendientes[0].intentos, 1);

  anotarTurno(c, 'cliente', 'de papas');
  const despues = { ...antes, candidatos: ['Papas naturales', 'Papas a la mexicana'] };
  const ciclo = sincronizarPendientes(c, [despues], { lidsVivos: ['L1'] });
  assert.deepEqual(ciclo, { creados: 0, resueltos: 0, cancelados: 0, obsoletos: 1, vivos: 1 });
  assert.deepEqual(c.pendientes[0].candidatos, ['Papas naturales', 'Papas a la mexicana']);
  assert.equal(c.pendientes[0].intentos, 0, 'los intentos de la pregunta vieja se arrastraron a la nueva');
  assert.equal(c.pendientes[0].turnoCreacion, 2);
});

await t('C10d. solo un intento RELACIONADO sube el contador', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'unos chilaquiles');
  sincronizarPendientes(c, [{ tipo: 'dato', dato: 'modalidad' }]);
  const clave = 'dato::modalidad'.replace('::', '::');
  const p = c.pendientes[0];
  assert.equal(p.intentos, 0);
  // Tres turnos que no contestan a la modalidad: el contador NO se mueve,
  // porque quien llama solo anota el intento cuando el mensaje va dirigido a Ã©l.
  for (const _ of [1, 2, 3]) sincronizarPendientes(c, [{ tipo: 'dato', dato: 'modalidad' }]);
  assert.equal(c.pendientes[0].intentos, 0, 'el mero paso de los turnos subiÃ³ el contador');
  anotarIntentoFallido(c, c.pendientes[0].clave);
  assert.equal(c.pendientes[0].intentos, 1);
});

await t('C11. la memoria de turnos estÃ¡ acotada y no crece sin lÃ­mite', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  for (let i = 0; i < TURNOS_RECORDADOS * 3; i++) anotarTurno(c, 'cliente', `t${i}`);
  assert.equal(c.turnos.length, TURNOS_RECORDADOS);
  assert.equal(c.contador, TURNOS_RECORDADOS * 3, 'el reloj no debe recortarse con la memoria');
  assert.equal(c.turnos.at(-1).texto, `t${TURNOS_RECORDADOS * 3 - 1}`);
});

await t('C12. el resumen para el log no lleva una palabra del cliente', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'me llamo Ana y vivo en Hidalgo 123');
  sincronizarPendientes(c, [{ tipo: 'dato', dato: 'modalidad' }]);
  const r = JSON.stringify(resumenDelContexto(c));
  assert(!/Ana|Hidalgo|123/.test(r), `el resumen filtrÃ³ datos del cliente: ${r}`);
  assert(/modalidad/.test(r));
});

// â¬â¬ FASE E â¬ propuesto, confirmado, rechazado â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬

const conPropuesta = (...refs) => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'unos chilaquiles');
  anotarTurno(c, 'bot', 'va. ' + refs.map((r) => `Â¿te agrego ${r}?`).join(' '));
  for (const r of refs) proponer(c, { clase: 'producto', referencia: r });
  return c;
};

await t('E1. una sugerencia queda PROPUESTA y no autoriza nada', () => {
  const c = conPropuesta('CafÃ© Americano');
  assert.equal(c.propuestas[0].estado, PROPUESTO);
  assert.equal(fueConfirmada(c, 'CafÃ© Americano'), false);
  assert.equal(evidenciaDeAceptacion([]), '', 'una propuesta sin sÃ­ no produce evidencia');
});

await t('E2. un Â«sÃ­Â» con UNA propuesta viva la confirma y produce su evidencia', () => {
  const c = conPropuesta('CafÃ© Americano');
  anotarTurno(c, 'cliente', 'sÃ­');
  const d = leerRespuesta(c, 'sÃ­');
  assert.equal(d.aceptadas.length, 1);
  assert.equal(d.ambigua, false);
  aplicarDesenlace(c, d);
  assert.equal(c.propuestas[0].estado, CONFIRMADO);
  assert.equal(evidenciaDeAceptacion(d.aceptadas), 'CafÃ© Americano');
});

await t('E3. un Â«sÃ­Â» con DOS propuestas vivas no elige: queda ambiguo', () => {
  const c = conPropuesta('CafÃ© Americano', 'Pan Dulce');
  anotarTurno(c, 'cliente', 'sÃ­');
  const d = leerRespuesta(c, 'sÃ­');
  assert.equal(d.ambigua, true, 'eligiÃ³ una de dos con un sÃ­ pelado');
  assert.equal(d.aceptadas.length, 0);
  assert.equal(d.candidatas.length, 2);
  aplicarDesenlace(c, d);
  assert(c.propuestas.every((p) => p.estado === PROPUESTO), 'se resolviÃ³ algo que era ambiguo');
});

await t('E4. un Â«noÂ» con dos abiertas las cierra las dos, y eso no es ambiguo', () => {
  const c = conPropuesta('CafÃ© Americano', 'Pan Dulce');
  anotarTurno(c, 'cliente', 'no gracias');
  const d = leerRespuesta(c, 'no gracias');
  assert.equal(d.ambigua, false);
  assert.equal(d.rechazadas.length, 2);
  aplicarDesenlace(c, d);
  assert(c.propuestas.every((p) => p.estado === RECHAZADO));
});

await t('E5. nombrar la propuesta la resuelve aunque haya varias abiertas', () => {
  const c = conPropuesta('CafÃ© Americano', 'Pan Dulce');
  anotarTurno(c, 'cliente', 'va el cafÃ©');
  const d = leerRespuesta(c, 'va el cafÃ©');
  assert.equal(d.ambigua, false);
  assert.equal(d.aceptadas.length, 1);
  assert.equal(d.aceptadas[0].referencia, 'CafÃ© Americano');
  assert.equal(evidenciaDeAceptacion(d.aceptadas), 'CafÃ© Americano');
});

await t('E6. Â«el pan noÂ» rechaza el nombrado y deja el otro abierto', () => {
  const c = conPropuesta('CafÃ© Americano', 'Pan Dulce');
  anotarTurno(c, 'cliente', 'no, el pan no');
  const d = leerRespuesta(c, 'no, el pan no');
  assert.equal(d.rechazadas.length, 1);
  assert.equal(d.rechazadas[0].referencia, 'Pan Dulce');
  aplicarDesenlace(c, d);
  assert.equal(fueRechazada(c, 'Pan Dulce'), true);
  assert.equal(propuestasVivas(c, 2).length, 1);
});

await t('E7. lo rechazado no se vuelve a ofrecer', () => {
  const c = conPropuesta('CafÃ© Americano');
  anotarTurno(c, 'cliente', 'no');
  aplicarDesenlace(c, leerRespuesta(c, 'no'));
  assert.deepEqual(rechazadas(c), ['CafÃ© Americano']);
  const repetida = proponer(c, { clase: 'producto', referencia: 'CafÃ© Americano' });
  assert.equal(repetida, null, 'el bot volviÃ³ a ofrecer lo que el cliente ya rechazÃ³');
});

await t('E8. un Â«sÃ­Â» de tres turnos despuÃ©s NO despierta una propuesta vieja', () => {
  const c = conPropuesta('CafÃ© Americano');
  anotarTurno(c, 'cliente', 'oye Â¿tienes hotcakes?');
  anotarTurno(c, 'bot', 'sÃ­, tenemos');
  caducarViejas(c);
  anotarTurno(c, 'cliente', 'sÃ­');
  const d = leerRespuesta(c, 'sÃ­');
  assert.equal(d.aceptadas.length, 0, 'un sÃ­ tardÃ­o reviviÃ³ una propuesta caducada');
  assert.equal(d.ambigua, false);
});

await t('E9. Â«asÃ­ estÃ¡ bienÂ» cierra las propuestas abiertas sin agregar nada', () => {
  const c = conPropuesta('CafÃ© Americano', 'Pan Dulce');
  anotarTurno(c, 'cliente', 'asÃ­ estÃ¡ bien');
  const d = leerRespuesta(c, 'asÃ­ estÃ¡ bien');
  assert.equal(d.aceptadas.length, 0);
  assert.equal(d.rechazadas.length, 2);
});

await t('E10. la evidencia que produce un sÃ­ es SOLO la referencia aceptada', () => {
  const c = conPropuesta('CafÃ© Americano', 'Pan Dulce');
  anotarTurno(c, 'cliente', 'va el cafÃ©');
  const d = leerRespuesta(c, 'va el cafÃ©');
  const ev = evidenciaDeAceptacion(d.aceptadas);
  assert.equal(ev, 'CafÃ© Americano');
  assert(!/Pan/.test(ev), 'la aceptaciÃ³n de una cosa autorizÃ³ otra');
});

await t('E11. la evidencia sale de la referencia del catÃ¡logo, NO de cÃ³mo lo dijo el bot', () => {
  // La etiqueta es la frase con la que el bot lo ofreciÃ³, y puede nombrar de
  // paso otras cosas: Â«un cafÃ©, que va bien con el Pan DulceÂ». Si la evidencia
  // se construyera con ella, un Â«sÃ­Â» al cafÃ© acabarÃ­a autorizando el pan â¬ el
  // bot se estarÃ­a dando permiso a sÃ­ mismo con su propia redacciÃ³n.
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'unos chilaquiles');
  anotarTurno(c, 'bot', 'Â¿te agrego un CafÃ© Americano? va muy bien con el Pan Dulce');
  proponer(c, {
    clase: 'producto',
    referencia: 'CafÃ© Americano',
    etiqueta: 'un CafÃ© Americano, que va muy bien con el Pan Dulce',
  });
  anotarTurno(c, 'cliente', 'sÃ­');
  const d = leerRespuesta(c, 'sÃ­');
  assert.equal(d.aceptadas.length, 1);
  const ev = evidenciaDeAceptacion(d.aceptadas);
  assert.equal(ev, 'CafÃ© Americano');
  assert(!/Pan Dulce/.test(ev), `la redacciÃ³n del bot se colÃ³ como evidencia: "${ev}"`);
});

// â¬â¬ LOS INTERRUPTORES â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬â¬

const lector = (cfg) => async () => cfg;

await t('F1. sin configuraciÃ³n, el mesero estÃ¡ apagado y el modo es legacy', async () => {
  const m = await modoDelPedido('n1', { leerConfiguracion: lector({}) });
  assert.equal(m.mesero, false);
  assert.equal(m.meseroSombra, false);
  assert.equal(m.modo, 'legacy');
});

await t('F2. mesero SIN reconciliador V2 no enciende: le faltarÃ­a el freno', async () => {
  const m = await modoDelPedido('n1', { leerConfiguracion: lector({ mesero_whatsapp_v1: 'true' }) });
  assert.equal(m.mesero, false, 'el mesero corriÃ³ sin el reconciliador que lo autoriza');
  assert.equal(m.v2, false);
  assert.equal(m.modo, 'legacy');
});

await t('F3. mesero + V2 enciende y se ve en el modo', async () => {
  const m = await modoDelPedido('n1', {
    leerConfiguracion: lector({ mesero_whatsapp_v1: 'true', pedido_reconciliador_v2: 'true' }),
  });
  assert.equal(m.mesero, true);
  assert.equal(m.v2, true);
  assert.equal(m.modo, 'mesero');
});

await t('F4. la sombra del mesero necesita las DOS llaves', async () => {
  const antes = process.env.MESERO_SHADOW_MODE;
  try {
    delete process.env.MESERO_SHADOW_MODE;
    const sinGlobal = await modoDelPedido('n1', { leerConfiguracion: lector({ mesero_whatsapp_shadow: 'true' }) });
    assert.equal(sinGlobal.meseroSombra, false, 'observÃ³ sin el interruptor del proceso');

    process.env.MESERO_SHADOW_MODE = 'true';
    const sinNegocio = await modoDelPedido('n1', { leerConfiguracion: lector({}) });
    assert.equal(sinNegocio.meseroSombra, false, 'observÃ³ a un negocio que no lo pidiÃ³');

    const conLasDos = await modoDelPedido('n1', { leerConfiguracion: lector({ mesero_whatsapp_shadow: 'true' }) });
    assert.equal(conLasDos.meseroSombra, true);
  } finally {
    if (antes === undefined) delete process.env.MESERO_SHADOW_MODE;
    else process.env.MESERO_SHADOW_MODE = antes;
  }
});

await t('F5. el maestro del mesero es OTRO: PEDIDO_SHADOW_MODE no lo enciende', async () => {
  const antesM = process.env.MESERO_SHADOW_MODE, antesP = process.env.PEDIDO_SHADOW_MODE;
  try {
    delete process.env.MESERO_SHADOW_MODE;
    process.env.PEDIDO_SHADOW_MODE = 'true';
    const m = await modoDelPedido('n1', { leerConfiguracion: lector({ mesero_whatsapp_shadow: 'true' }) });
    assert.equal(m.meseroSombra, false, 'un experimento encendiÃ³ el otro');
  } finally {
    if (antesM === undefined) delete process.env.MESERO_SHADOW_MODE; else process.env.MESERO_SHADOW_MODE = antesM;
    if (antesP === undefined) delete process.env.PEDIDO_SHADOW_MODE; else process.env.PEDIDO_SHADOW_MODE = antesP;
  }
});

await t('F6. mesero productivo apaga su propia sombra', async () => {
  const antes = process.env.MESERO_SHADOW_MODE;
  try {
    process.env.MESERO_SHADOW_MODE = 'true';
    const m = await modoDelPedido('n1', {
      leerConfiguracion: lector({
        mesero_whatsapp_v1: 'true', pedido_reconciliador_v2: 'true', mesero_whatsapp_shadow: 'true',
      }),
    });
    assert.equal(m.mesero, true);
    assert.equal(m.meseroSombra, false, 'se observÃ³ a quien ya estÃ¡ siendo atendido por el mesero');
  } finally {
    if (antes === undefined) delete process.env.MESERO_SHADOW_MODE; else process.env.MESERO_SHADOW_MODE = antes;
  }
});

await t('F7. solo la palabra "true" enciende; "1", "yes" y "false" no', async () => {
  for (const v of ['1', 'yes', 'si', 'false', 'FALSE', '', 'TRUE!', 0, null]) {
    const m = await modoDelPedido('n1', {
      leerConfiguracion: lector({ mesero_whatsapp_v1: v, pedido_reconciliador_v2: 'true' }),
    });
    assert.equal(m.mesero, false, `"${v}" encendiÃ³ el mesero`);
  }
  for (const v of ['true', 'TRUE', ' True ']) {
    const m = await modoDelPedido('n1', {
      leerConfiguracion: lector({ mesero_whatsapp_v1: v, pedido_reconciliador_v2: 'true' }),
    });
    assert.equal(m.mesero, true, `"${v}" no encendiÃ³ el mesero`);
  }
});

await t('F8. un error leyendo la configuraciÃ³n deja todo apagado', async () => {
  const m = await modoDelPedido('n1', { leerConfiguracion: async () => { throw new Error('base caÃ­da'); } });
  assert.deepEqual(
    { v2: m.v2, shadow: m.shadow, mesero: m.mesero, meseroSombra: m.meseroSombra, modo: m.modo },
    { v2: false, shadow: false, mesero: false, meseroSombra: false, modo: 'legacy' },
  );
});

console.log(`\n${fail === 0 ? 'TODO VERDE' : 'CON FALLOS'} â¬ ${ok} pasadas, ${fail} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  Â· ${f}`);
process.exit(fail ? 1 : 0);
