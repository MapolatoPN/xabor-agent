// EL CONTEXTO DE LA ATENCIÓN, Y LO QUE EL BOT OFRECIÓ.
//
// Fases C y E del Mesero Digital. Módulos puros: esta suite no toca la base ni
// levanta servidor, así que corre en segundos y puede correrse mil veces.
//
// Lo que defiende:
//
//   · un contexto pertenece a UN negocio y UNA conversación, y prestarlo no es
//     una opción: si no coincide, se empieza de cero;
//   · sobrevive al viaje por JSON que hace el snapshot durable;
//   · el orden de aparición de los renglones no se recalcula, porque de él
//     dependen «el primero» y «el segundo»;
//   · una sugerencia del bot NO es un pedido, y un «sí» solo autoriza la cosa
//     concreta que se le ofreció al cliente;
//   · con dos propuestas abiertas, un «sí» pelado no elige: pregunta;
//   · el mesero no se enciende sin el reconciliador que lo frena.
import assert from 'node:assert/strict';

const ctxMod = await import('../src/mesero-whatsapp/contextoMesa.js');
const {
  contextoNuevo, contextoDeLaConversacion, sanearContexto, anotarTurno, sincronizarLineas,
  tocarLinea, anotarPendiente, resolverPendiente, tienePendiente, preguntadoRecientemente,
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

// ── FASE C — el contexto ────────────────────────────────────────────────────

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
  anotarTurno(c, 'bot', 'buenas, ¿qué le sirvo?');
  anotarTurno(c, 'cliente', 'unos chilaquiles');
  assert.equal(c.contador, 3);
  assert.equal(turnosDelCliente(c).length, 2);
  assert.equal(ultimoTurnoDelBot(c).texto, 'buenas, ¿qué le sirvo?');
});

await t('C3. otra conversación del mismo negocio NO hereda el contexto', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'quiero dos hamburguesas');
  const otro = contextoDeLaConversacion(c, { negocioId: 'n1', conversacionId: 'conv2' });
  assert.equal(otro.contador, 0, 'se coló el historial de otra conversación');
  assert.equal(otro.turnos.length, 0);
  assert.equal(otro.conversacionId, 'conv2');
});

await t('C4. otro NEGOCIO con el mismo id de conversación tampoco lo hereda', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'lo de siempre');
  const otro = contextoDeLaConversacion(c, { negocioId: 'n2', conversacionId: 'conv1' });
  assert.equal(otro.contador, 0, 'contexto prestado entre negocios');
  assert.equal(otro.negocioId, 'n2');
});

await t('C5. el mismo par negocio+conversación SÍ lo recupera', () => {
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
  anotarPendiente(c, 'modalidad', '¿para recoger o a domicilio?');
  proponer(c, { clase: 'producto', referencia: 'Café Americano' });

  const vuelto = contextoDeLaConversacion(JSON.parse(JSON.stringify(c)),
    { negocioId: 'n1', conversacionId: 'conv1' });
  assert.equal(vuelto.contador, 1);
  assert.equal(vuelto.lineas.length, 2);
  assert.equal(vuelto.foco, 'b');
  assert(tienePendiente(vuelto, 'modalidad'));
  assert.equal(vuelto.propuestas.length, 1);
  assert.equal(vuelto.propuestas[0].estado, PROPUESTO);
});

await t('C7. basura en el snapshot da un contexto nuevo, no una excepción', () => {
  for (const basura of [null, undefined, 'texto', 42, [], { lineas: 'no', turnos: 7, fase: 'inventada' }]) {
    const c = sanearContexto(basura, { negocioId: 'n1', conversacionId: 'conv1' });
    assert.equal(c.fase, 'inicio');
    assert(Array.isArray(c.lineas) && Array.isArray(c.turnos));
    assert.equal(c.negocioId, 'n1');
  }
});

await t('C8. el orden de aparición NO se recalcula al borrar un renglón', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'tres cosas');
  sincronizarLineas(c, carrito('a', 'b', 'c'));
  assert.deepEqual(c.lineas.map((l) => l.orden), [1, 2, 3]);
  // se va el segundo y entra uno nuevo: el primero sigue siendo el primero
  anotarTurno(c, 'cliente', 'quita el segundo y ponme otra cosa');
  sincronizarLineas(c, carrito('a', 'c', 'd'));
  const porLid = Object.fromEntries(c.lineas.map((l) => [l.lid, l.orden]));
  assert.equal(porLid.a, 1, 'el primero dejó de ser el primero');
  assert.equal(porLid.c, 3);
  assert.equal(porLid.d, 4, 'el nuevo reutilizó un orden ya usado');
});

await t('C9. el foco se suelta cuando su renglón desaparece', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'dos cosas');
  sincronizarLineas(c, carrito('a', 'b'));
  tocarLinea(c, 'b');
  assert.equal(c.foco, 'b');
  sincronizarLineas(c, carrito('a'));
  assert.equal(c.foco, null, 'el foco quedó apuntando a un fantasma');
});

await t('C10. los pendientes no se duplican, cuentan insistencias y se resuelven', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'bot', '¿para recoger o a domicilio?');
  anotarPendiente(c, 'modalidad', '¿para recoger?');
  anotarTurno(c, 'cliente', 'oye ¿y qué bebidas tienes?');
  anotarTurno(c, 'bot', '¿para recoger o a domicilio?');
  anotarPendiente(c, 'modalidad', '¿para recoger?');
  assert.equal(c.pendientes.length, 1);
  assert.equal(c.pendientes[0].veces, 2);
  assert(preguntadoRecientemente(c, 'modalidad'));
  resolverPendiente(c, 'modalidad');
  assert.equal(tienePendiente(c, 'modalidad'), false);
});

await t('C11. la memoria de turnos está acotada y no crece sin límite', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  for (let i = 0; i < TURNOS_RECORDADOS * 3; i++) anotarTurno(c, 'cliente', `t${i}`);
  assert.equal(c.turnos.length, TURNOS_RECORDADOS);
  assert.equal(c.contador, TURNOS_RECORDADOS * 3, 'el reloj no debe recortarse con la memoria');
  assert.equal(c.turnos.at(-1).texto, `t${TURNOS_RECORDADOS * 3 - 1}`);
});

await t('C12. el resumen para el log no lleva una palabra del cliente', () => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'me llamo Ana y vivo en Hidalgo 123');
  anotarPendiente(c, 'modalidad');
  const r = JSON.stringify(resumenDelContexto(c));
  assert(!/Ana|Hidalgo|123/.test(r), `el resumen filtró datos del cliente: ${r}`);
  assert(/modalidad/.test(r));
});

// ── FASE E — propuesto, confirmado, rechazado ───────────────────────────────

const conPropuesta = (...refs) => {
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'unos chilaquiles');
  anotarTurno(c, 'bot', 'va. ' + refs.map((r) => `¿te agrego ${r}?`).join(' '));
  for (const r of refs) proponer(c, { clase: 'producto', referencia: r });
  return c;
};

await t('E1. una sugerencia queda PROPUESTA y no autoriza nada', () => {
  const c = conPropuesta('Café Americano');
  assert.equal(c.propuestas[0].estado, PROPUESTO);
  assert.equal(fueConfirmada(c, 'Café Americano'), false);
  assert.equal(evidenciaDeAceptacion([]), '', 'una propuesta sin sí no produce evidencia');
});

await t('E2. un «sí» con UNA propuesta viva la confirma y produce su evidencia', () => {
  const c = conPropuesta('Café Americano');
  anotarTurno(c, 'cliente', 'sí');
  const d = leerRespuesta(c, 'sí');
  assert.equal(d.aceptadas.length, 1);
  assert.equal(d.ambigua, false);
  aplicarDesenlace(c, d);
  assert.equal(c.propuestas[0].estado, CONFIRMADO);
  assert.equal(evidenciaDeAceptacion(d.aceptadas), 'Café Americano');
});

await t('E3. un «sí» con DOS propuestas vivas no elige: queda ambiguo', () => {
  const c = conPropuesta('Café Americano', 'Pan Dulce');
  anotarTurno(c, 'cliente', 'sí');
  const d = leerRespuesta(c, 'sí');
  assert.equal(d.ambigua, true, 'eligió una de dos con un sí pelado');
  assert.equal(d.aceptadas.length, 0);
  assert.equal(d.candidatas.length, 2);
  aplicarDesenlace(c, d);
  assert(c.propuestas.every((p) => p.estado === PROPUESTO), 'se resolvió algo que era ambiguo');
});

await t('E4. un «no» con dos abiertas las cierra las dos, y eso no es ambiguo', () => {
  const c = conPropuesta('Café Americano', 'Pan Dulce');
  anotarTurno(c, 'cliente', 'no gracias');
  const d = leerRespuesta(c, 'no gracias');
  assert.equal(d.ambigua, false);
  assert.equal(d.rechazadas.length, 2);
  aplicarDesenlace(c, d);
  assert(c.propuestas.every((p) => p.estado === RECHAZADO));
});

await t('E5. nombrar la propuesta la resuelve aunque haya varias abiertas', () => {
  const c = conPropuesta('Café Americano', 'Pan Dulce');
  anotarTurno(c, 'cliente', 'va el café');
  const d = leerRespuesta(c, 'va el café');
  assert.equal(d.ambigua, false);
  assert.equal(d.aceptadas.length, 1);
  assert.equal(d.aceptadas[0].referencia, 'Café Americano');
  assert.equal(evidenciaDeAceptacion(d.aceptadas), 'Café Americano');
});

await t('E6. «el pan no» rechaza el nombrado y deja el otro abierto', () => {
  const c = conPropuesta('Café Americano', 'Pan Dulce');
  anotarTurno(c, 'cliente', 'no, el pan no');
  const d = leerRespuesta(c, 'no, el pan no');
  assert.equal(d.rechazadas.length, 1);
  assert.equal(d.rechazadas[0].referencia, 'Pan Dulce');
  aplicarDesenlace(c, d);
  assert.equal(fueRechazada(c, 'Pan Dulce'), true);
  assert.equal(propuestasVivas(c, 2).length, 1);
});

await t('E7. lo rechazado no se vuelve a ofrecer', () => {
  const c = conPropuesta('Café Americano');
  anotarTurno(c, 'cliente', 'no');
  aplicarDesenlace(c, leerRespuesta(c, 'no'));
  assert.deepEqual(rechazadas(c), ['Café Americano']);
  const repetida = proponer(c, { clase: 'producto', referencia: 'Café Americano' });
  assert.equal(repetida, null, 'el bot volvió a ofrecer lo que el cliente ya rechazó');
});

await t('E8. un «sí» de tres turnos después NO despierta una propuesta vieja', () => {
  const c = conPropuesta('Café Americano');
  anotarTurno(c, 'cliente', 'oye ¿tienes hotcakes?');
  anotarTurno(c, 'bot', 'sí, tenemos');
  caducarViejas(c);
  anotarTurno(c, 'cliente', 'sí');
  const d = leerRespuesta(c, 'sí');
  assert.equal(d.aceptadas.length, 0, 'un sí tardío revivió una propuesta caducada');
  assert.equal(d.ambigua, false);
});

await t('E9. «así está bien» cierra las propuestas abiertas sin agregar nada', () => {
  const c = conPropuesta('Café Americano', 'Pan Dulce');
  anotarTurno(c, 'cliente', 'así está bien');
  const d = leerRespuesta(c, 'así está bien');
  assert.equal(d.aceptadas.length, 0);
  assert.equal(d.rechazadas.length, 2);
});

await t('E10. la evidencia que produce un sí es SOLO la referencia aceptada', () => {
  const c = conPropuesta('Café Americano', 'Pan Dulce');
  anotarTurno(c, 'cliente', 'va el café');
  const d = leerRespuesta(c, 'va el café');
  const ev = evidenciaDeAceptacion(d.aceptadas);
  assert.equal(ev, 'Café Americano');
  assert(!/Pan/.test(ev), 'la aceptación de una cosa autorizó otra');
});

await t('E11. la evidencia sale de la referencia del catálogo, NO de cómo lo dijo el bot', () => {
  // La etiqueta es la frase con la que el bot lo ofreció, y puede nombrar de
  // paso otras cosas: «un café, que va bien con el Pan Dulce». Si la evidencia
  // se construyera con ella, un «sí» al café acabaría autorizando el pan — el
  // bot se estaría dando permiso a sí mismo con su propia redacción.
  const c = contextoNuevo({ negocioId: 'n1', conversacionId: 'conv1' });
  anotarTurno(c, 'cliente', 'unos chilaquiles');
  anotarTurno(c, 'bot', '¿te agrego un Café Americano? va muy bien con el Pan Dulce');
  proponer(c, {
    clase: 'producto',
    referencia: 'Café Americano',
    etiqueta: 'un Café Americano, que va muy bien con el Pan Dulce',
  });
  anotarTurno(c, 'cliente', 'sí');
  const d = leerRespuesta(c, 'sí');
  assert.equal(d.aceptadas.length, 1);
  const ev = evidenciaDeAceptacion(d.aceptadas);
  assert.equal(ev, 'Café Americano');
  assert(!/Pan Dulce/.test(ev), `la redacción del bot se coló como evidencia: "${ev}"`);
});

// ── LOS INTERRUPTORES ───────────────────────────────────────────────────────

const lector = (cfg) => async () => cfg;

await t('F1. sin configuración, el mesero está apagado y el modo es legacy', async () => {
  const m = await modoDelPedido('n1', { leerConfiguracion: lector({}) });
  assert.equal(m.mesero, false);
  assert.equal(m.meseroSombra, false);
  assert.equal(m.modo, 'legacy');
});

await t('F2. mesero SIN reconciliador V2 no enciende: le faltaría el freno', async () => {
  const m = await modoDelPedido('n1', { leerConfiguracion: lector({ mesero_whatsapp_v1: 'true' }) });
  assert.equal(m.mesero, false, 'el mesero corrió sin el reconciliador que lo autoriza');
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
    assert.equal(sinGlobal.meseroSombra, false, 'observó sin el interruptor del proceso');

    process.env.MESERO_SHADOW_MODE = 'true';
    const sinNegocio = await modoDelPedido('n1', { leerConfiguracion: lector({}) });
    assert.equal(sinNegocio.meseroSombra, false, 'observó a un negocio que no lo pidió');

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
    assert.equal(m.meseroSombra, false, 'un experimento encendió el otro');
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
    assert.equal(m.meseroSombra, false, 'se observó a quien ya está siendo atendido por el mesero');
  } finally {
    if (antes === undefined) delete process.env.MESERO_SHADOW_MODE; else process.env.MESERO_SHADOW_MODE = antes;
  }
});

await t('F7. solo la palabra "true" enciende; "1", "yes" y "false" no', async () => {
  for (const v of ['1', 'yes', 'si', 'false', 'FALSE', '', 'TRUE!', 0, null]) {
    const m = await modoDelPedido('n1', {
      leerConfiguracion: lector({ mesero_whatsapp_v1: v, pedido_reconciliador_v2: 'true' }),
    });
    assert.equal(m.mesero, false, `"${v}" encendió el mesero`);
  }
  for (const v of ['true', 'TRUE', ' True ']) {
    const m = await modoDelPedido('n1', {
      leerConfiguracion: lector({ mesero_whatsapp_v1: v, pedido_reconciliador_v2: 'true' }),
    });
    assert.equal(m.mesero, true, `"${v}" no encendió el mesero`);
  }
});

await t('F8. un error leyendo la configuración deja todo apagado', async () => {
  const m = await modoDelPedido('n1', { leerConfiguracion: async () => { throw new Error('base caída'); } });
  assert.deepEqual(
    { v2: m.v2, shadow: m.shadow, mesero: m.mesero, meseroSombra: m.meseroSombra, modo: m.modo },
    { v2: false, shadow: false, mesero: false, meseroSombra: false, modo: 'legacy' },
  );
});

console.log(`\n${fail === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${ok} pasadas, ${fail} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
process.exit(fail ? 1 : 0);
