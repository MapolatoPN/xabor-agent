import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { construirInstrucciones } from '../src/mesero-agente/instrucciones.js';
import {
  reglasDelAsistenteEnTexto, respuestaProhibidaEncontrada,
} from '../src/mesero-agente/reglasDelAsistente.js';
import { atenderTurnoConHerramientas, CIERRE } from '../src/mesero-agente/agenteDelMesero.js';
import { crearEjecutor, estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';

let ok = 0;
const t = async (nombre, fn) => {
  await fn();
  ok += 1;
  console.log(`  ✓ ${nombre}`);
};

const reglas = {
  restaurante: 'Mapolato Obispado',
  pedidos: {
    tiempo_preparacion_minutos: 25,
    tiempo_entrega_min_minutos: 35,
    tiempo_entrega_max_minutos: 50,
    costo_envio: 60,
    pedido_minimo_entrega: 200,
    entrega_gratis_desde: 800,
    notas: 'Solo recoger o domicilio.',
    pago_instrucciones: 'El enlace se genera al confirmar.',
    zonas_entrega: [{ nombre: 'UTNC', costo: 150 }],
  },
  politicas: ['Los cambios posteriores requieren revisión.'],
  bot: {
    saludo: 'Hola, muy buen día, ¿cómo podemos servirte?',
    tono: 'amable, cálido y respetuoso',
    personalidad: 'servicial y breve',
    informacion_importante: 'Tenemos estacionamiento propio.',
    faqs: [{ pregunta: '¿Facturan?', respuesta: 'Sí, con los datos fiscales.' }],
    respuestas_prohibidas: ['El sistema lo ajustará después'],
    transferir_a_humano: 'Si el cliente se queja del servicio.',
    palabras_criticas: ['alergia', 'doble cobro'],
  },
};

await t('incluye todas las opciones visibles de Asistente y Configuración', () => {
  const s = reglasDelAsistenteEnTexto(reglas, { esPrimerTurno: true });
  for (const esperado of [
    reglas.bot.saludo, reglas.bot.tono, reglas.bot.personalidad,
    reglas.bot.informacion_importante, reglas.bot.faqs[0].pregunta,
    reglas.bot.faqs[0].respuesta, reglas.bot.respuestas_prohibidas[0],
    reglas.bot.transferir_a_humano, ...reglas.bot.palabras_criticas,
    '$60 MXN', '$150 MXN', reglas.pedidos.notas,
    reglas.pedidos.pago_instrucciones, reglas.politicas[0],
  ]) assert.ok(s.includes(esperado), `faltó en las reglas: ${esperado}`);
  assert.match(s, /manda siempre el resultado actual de las herramientas de Xabor/);
});

await t('el saludo se incluye únicamente en el primer turno', () => {
  assert.match(reglasDelAsistenteEnTexto(reglas, { esPrimerTurno: true }), /SALUDO INICIAL/);
  assert.doesNotMatch(reglasDelAsistenteEnTexto(reglas, { esPrimerTurno: false }), /SALUDO INICIAL/);
});

await t('las reglas llegan al system prompt del agente nuevo', () => {
  const reglasDelNegocio = reglasDelAsistenteEnTexto(reglas, { esPrimerTurno: true });
  const prompt = construirInstrucciones({ nombreNegocio: reglas.restaurante, reglasDelNegocio });
  assert.match(prompt, /Eres el mesero de Mapolato Obispado/);
  assert.match(prompt, /REGLAS DEL NEGOCIO/);
  assert.match(prompt, /Tenemos estacionamiento propio/);
  assert.match(prompt, /El enlace se genera al confirmar/);
});

await t('detecta una respuesta prohibida aunque cambien acentos y puntuación', () => {
  assert.equal(
    respuestaProhibidaEncontrada('Sí: el SISTEMA lo ajustara después.', reglas),
    reglas.bot.respuestas_prohibidas[0],
  );
  assert.equal(respuestaProhibidaEncontrada('El total ya viene de Xabor.', reglas), null);
  assert.equal(respuestaProhibidaEncontrada('Qué bueno.', {
    bot: { respuestas_prohibidas: ['no'] },
  }), null, 'una sílaba dentro de otra palabra no puede bloquear una respuesta');
});

await t('bloquea la salida prohibida y entrega la conversación a una persona', async () => {
  const estado = estadoNuevo({ negocioId: 'n1', conversacionId: 'c1' });
  let handoffs = 0;
  const salida = await atenderTurnoConHerramientas({
    negocioId: 'n1', conversacionId: 'c1', turnoId: 't1', mensaje: '¿qué pasará?',
    estado, reglas,
    llamarModelo: async () => ({
      content: [{ type: 'text', text: 'El sistema lo ajustará después.' }],
      stop_reason: 'end_turn',
    }),
    efectos: { escalar: async () => { handoffs += 1; return { ok: true }; } },
  });
  assert.equal(handoffs, 1);
  assert.equal(salida.escalado, true);
  assert.equal(salida.motivoCierre, CIERRE.ESCALADO);
  assert.equal(respuestaProhibidaEncontrada(salida.texto, reglas), null);
});

await t('aplica una tarifa de zona solo con zona configurada y mencionada por el cliente', async () => {
  const estado = estadoNuevo({ negocioId: 'n1', conversacionId: 'zona-ok' });
  const ejecutor = crearEjecutor({
    estado, reglas, modalidades: ['recoger en tienda', 'entrega a domicilio'],
    mensaje: 'Es entrega a domicilio en UTNC, edificio principal.',
  });
  const r = await ejecutor.ejecutar('definir_entrega', {
    modalidad: 'entrega a domicilio', direccion: 'UTNC, edificio principal', zona_entrega: 'UTNC',
  });
  assert.equal(r.aplicado, true);
  assert.deepEqual(r.zona_entrega, { nombre: 'UTNC', costo: 150 });
  assert.equal(estado.carrito.datos.costo_envio, 150);
});

await t('rechaza una zona inventada o ausente del mensaje', async () => {
  const inventada = estadoNuevo({ negocioId: 'n1', conversacionId: 'zona-inventada' });
  inventada.carrito.datos.modalidad = 'entrega a domicilio';
  const r1 = await crearEjecutor({ estado: inventada, reglas,
    modalidades: ['recoger en tienda', 'entrega a domicilio'],
    mensaje: 'Es entrega a domicilio en Zona Norte.' })
    .ejecutar('definir_entrega', { zona_entrega: 'Zona Norte' });
  assert.equal(r1.aplicado, false);
  assert.match(r1.motivo, /zona_no_configurada/);
  assert.equal(inventada.carrito.datos.costo_envio, undefined);

  const noDicha = estadoNuevo({ negocioId: 'n1', conversacionId: 'zona-no-dicha' });
  noDicha.carrito.datos.modalidad = 'entrega a domicilio';
  const r2 = await crearEjecutor({ estado: noDicha, reglas,
    modalidades: ['recoger en tienda', 'entrega a domicilio'],
    mensaje: 'Es entrega a domicilio en el centro.' })
    .ejecutar('definir_entrega', { zona_entrega: 'UTNC' });
  assert.equal(r2.aplicado, false);
  assert.match(r2.motivo, /zona_sin_respaldo/);
  assert.equal(noDicha.carrito.datos.costo_envio, undefined);

  const parcial = estadoNuevo({ negocioId: 'n1', conversacionId: 'zona-parcial' });
  const r3 = await crearEjecutor({ estado: parcial, reglas,
    modalidades: ['recoger en tienda', 'entrega a domicilio'],
    mensaje: 'Es entrega a domicilio en Zona Norte, Calle 1.' })
    .ejecutar('definir_entrega', {
      modalidad: 'entrega a domicilio', direccion: 'Zona Norte, Calle 1', zona_entrega: 'Zona Norte',
    });
  assert.equal(r3.aplicado, true, 'una zona inválida no debe borrar la dirección válida');
  assert.equal(r3.parcial, true);
  assert.equal(r3.codigo, 'zona_no_configurada');
  assert.equal(parcial.carrito.datos.cliente.direccion, 'Zona Norte, Calle 1');
  assert.equal(parcial.carrito.datos.costo_envio, 60, 'la zona inválida debe conservar la tarifa base');
});

await t('cambiar a recoger elimina la tarifa anterior de zona', async () => {
  const estado = estadoNuevo({ negocioId: 'n1', conversacionId: 'zona-limpia' });
  estado.carrito.datos = { modalidad: 'entrega a domicilio', costo_envio: 150 };
  const r = await crearEjecutor({ estado, reglas,
    modalidades: ['recoger en tienda', 'entrega a domicilio'], mensaje: 'Mejor voy a recoger.' })
    .ejecutar('definir_entrega', { modalidad: 'recoger en tienda' });
  assert.equal(r.aplicado, true);
  assert.equal(estado.carrito.datos.costo_envio, 0);
});

await t('productivo, sombra y simulador usan el nombre y las reglas guardadas', () => {
  const raiz = fileURLToPath(new URL('..', import.meta.url));
  const canal = readFileSync(join(raiz, 'src', 'mesero-agente', 'canalDelAgente.js'), 'utf8');
  assert.ok((canal.match(/cfg\?\.nombre \|\| cfg\?\.nombre_negocio/g) || []).length >= 3,
    'alguna ruta todavía ignora configuracion.nombre');
  assert.ok((canal.match(/reglasDelAsistenteEnTexto\(reglas/g) || []).length >= 3,
    'alguna ruta todavía omite las reglas del módulo Asistente');
  const server = readFileSync(join(raiz, 'src', 'server.js'), 'utf8');
  assert.match(server, /simularConAgente\(\{/,
    'el panel todavía prueba el simulador del bot anterior');
  assert.doesNotMatch(server, /simularMensaje\(sessionId/,
    'el endpoint del panel todavía invoca el bot anterior');
});

console.log(`\n${ok}/${ok} pruebas de reglas del Asistente pasaron.`);
