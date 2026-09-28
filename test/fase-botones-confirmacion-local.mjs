// Sin credenciales, base, red, modelo, pedido, pago ni impresión real.
import '../test/red-solo-local.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepararConfirmacion, leerToque, separarLote, prevalidarToque, ventanaAbierta }
  from '../experiments/botones-confirmacion/contrato.mjs';
import { huellaDelResumen } from '../src/mesero-whatsapp/resumenDelPedido.js';

const clonar = v => JSON.parse(JSON.stringify(v));
function caso() {
  const resumen = { items: [{ nombre: 'Chilaquiles de prueba', cantidad: 1,
    opciones: [{ grupo: 'Salsa', opcion: 'Roja' }], precio_unitario: 100 }],
  modalidad: 'recoger', pago: 'efectivo', cliente: { nombre: 'Cliente de prueba' },
  subtotal: 100, costo_envio: 0, total: 100 };
  const entrada = { negocioId: 'negocio-ficticio', clienteId: 'cliente-ficticio', ciclo: 'ciclo-1',
    dialogoId: 'pregunta-1', outboxClave: 'salida-1', resumen,
    texto: 'PRUEBA LOCAL — sin pedido real. Total ficticio: $100. ¿Confirmas?',
    pedidoConfirmable: true, ultimoMensajeClienteMs: 1_000, ahoraMs: 2_000 };
  const preparada = prepararConfirmacion(entrada);
  const mensaje = { type: 'interactive', from: entrada.clienteId, id: 'wamid.entrante-1',
    context: { id: 'wamid.salida-1' }, interactive: { type: 'button_reply',
      button_reply: { id: preparada.asociaciones[0].token, title: 'Confirmar' } } };
  const actual = { ...entrada, pendiente: 'confirmar_resumen', cicloAbierto: true, cartaVigente: true };
  const contexto = { toque: leerToque(mensaje), asociacion: preparada.asociaciones[0], actual,
    barreras: { botActivo: true, sinPausa: true, sinHumano: true, enCanario: true,
      interactivosProceso: true, interactivosNegocio: true },
    pregunta: { negocioId: entrada.negocioId, clienteId: entrada.clienteId,
      ciclo: entrada.ciclo, dialogoId: entrada.dialogoId, estado: 'disponible', respuestaRegistrada: false },
    salida: { clave: 'salida-1', estado: 'enviada', wamid: 'wamid.salida-1' } };
  return { entrada, preparada, mensaje, contexto };
}

test('mensaje de dos botones; tokens opacos únicos y snapshot completo separado', () => {
  const { preparada, entrada } = caso();
  assert.equal(preparada.interactivo.type, 'button');
  const botones = preparada.interactivo.action.buttons;
  assert.deepEqual(botones.map(b => b.reply.title), ['Confirmar', 'Cambiar algo']);
  assert.equal(new Set(botones.map(b => b.reply.id)).size, 2);
  for (const b of botones) { assert.match(b.reply.id, /^xb1:[A-Za-z0-9_-]{22}$/); assert.ok(b.reply.title.length <= 20); }
  assert.ok(!JSON.stringify(preparada.interactivo).includes(entrada.negocioId));
  assert.equal(preparada.asociaciones[0].huella, huellaDelResumen(entrada.resumen));
  entrada.resumen.total = 999;
  assert.equal(preparada.asociaciones[0].resumen.total, 100);
});

test('otra pregunta obtiene otros tokens', () => {
  const a = caso(), b = caso();
  assert.notEqual(a.preparada.asociaciones[0].token, b.preparada.asociaciones[0].token);
});

test('Confirmar válido solo solicita reserva; no muta carrito ni confirma', () => {
  const { contexto } = caso(); const antes = clonar(contexto);
  const r = prevalidarToque(contexto);
  assert.equal(r.estado, 'requiere_reserva_durable'); assert.equal(r.accion, 'confirmar');
  assert.deepEqual(contexto, antes);
});

test('el título recibido nunca autoriza: token Cambiar algo con título Confirmar', () => {
  const { contexto, mensaje, preparada } = caso();
  mensaje.interactive.button_reply.id = preparada.asociaciones[1].token;
  contexto.toque = leerToque(mensaje); contexto.asociacion = preparada.asociaciones[1];
  assert.equal(prevalidarToque(contexto).accion, 'cambiar_algo');
});

for (const campo of ['negocioId', 'clienteId', 'ciclo', 'dialogoId']) {
  test(`identidad/pregunta distinta: ${campo}`, () => {
    const { contexto } = caso(); contexto.actual[campo] = 'otro';
    assert.notEqual(prevalidarToque(contexto).estado, 'requiere_reserva_durable');
  });
}
test('remitente ajeno no usa un token copiado', () => {
  const { contexto } = caso(); contexto.toque.remitente = 'intruso';
  assert.equal(prevalidarToque(contexto).motivo, 'identidad_ajena');
});
test('token desconocido no obtiene autoridad por el título', () => {
  const { contexto } = caso(); contexto.toque.token = caso().contexto.toque.token;
  assert.equal(prevalidarToque(contexto).motivo, 'token_desconocido');
});

for (const campo of ['botActivo', 'sinPausa', 'sinHumano', 'enCanario']) {
  test(`barrera ${campo} gana incluso con pregunta vieja`, () => {
    const { contexto } = caso(); contexto.barreras[campo] = false; contexto.actual.dialogoId = 'nueva';
    assert.deepEqual(prevalidarToque(contexto), { estado: 'ignorar', motivo: 'barrera_de_atencion' });
  });
}
test('barreras ausentes no se dan por abiertas', () => {
  const { contexto } = caso(); delete contexto.barreras;
  assert.equal(prevalidarToque(contexto).estado, 'ignorar');
});
test('ciclo terminado nunca se reactiva', () => {
  const { contexto } = caso(); contexto.actual.cicloAbierto = false;
  assert.equal(prevalidarToque(contexto).estado, 'ignorar');
});
for (const campo of ['interactivosProceso', 'interactivosNegocio']) {
  test(`llave ${campo} apagada: solo requiere aviso, ningún efecto`, () => {
    const { contexto } = caso(); contexto.barreras[campo] = false;
    assert.equal(prevalidarToque(contexto).motivo, 'funcion_apagada');
  });
}

for (const estado of ['reservada', 'aplicada', 'rechazada', 'incierta']) {
  test(`pregunta ${estado} impide otro toque incluso con wamid nuevo`, () => {
    const { contexto } = caso(); contexto.pregunta.estado = estado; contexto.toque.wamid = 'wamid.otro';
    assert.equal(prevalidarToque(contexto).motivo, 'pregunta_ocupada');
  });
}
test('aviso ya registrado impide otra respuesta lógica', () => {
  const { contexto } = caso(); contexto.pregunta.respuestaRegistrada = true;
  assert.equal(prevalidarToque(contexto).motivo, 'pregunta_ocupada');
});
test('no presumir consumo disponible si falta registro', () => {
  const { contexto } = caso(); delete contexto.pregunta;
  assert.equal(prevalidarToque(contexto).motivo, 'pregunta_ausente');
});
test('ambos botones comparten la misma clave de exclusión', () => {
  const { contexto, preparada } = caso(); const a = prevalidarToque(contexto);
  contexto.asociacion = preparada.asociaciones[1]; contexto.toque.token = contexto.asociacion.token;
  assert.deepEqual(prevalidarToque(contexto).clavePregunta, a.clavePregunta);
});

test('sin acuse solicita retención, nunca confirmación', () => {
  const { contexto } = caso(); contexto.salida.estado = 'pendiente'; delete contexto.salida.wamid;
  assert.equal(prevalidarToque(contexto).estado, 'requiere_retencion');
});
for (const estado of ['rechazada', 'incierta']) {
  test(`salida ${estado} no valida el toque`, () => {
    const { contexto } = caso(); contexto.salida.estado = estado;
    assert.equal(prevalidarToque(contexto).motivo, 'acuse_invalido');
  });
}
test('acuse de otro mensaje no valida', () => {
  const { contexto } = caso(); contexto.toque.contextoId = 'wamid.ajeno';
  assert.equal(prevalidarToque(contexto).motivo, 'acuse_invalido');
});
test('volver tras acuse revalida pausa y pregunta', () => {
  const { contexto } = caso(); contexto.salida.estado = 'pendiente';
  assert.equal(prevalidarToque(contexto).estado, 'requiere_retencion');
  contexto.salida.estado = 'enviada'; contexto.barreras.sinPausa = false;
  assert.equal(prevalidarToque(contexto).estado, 'ignorar');
  contexto.barreras.sinPausa = true; contexto.actual.dialogoId = 'nueva';
  assert.equal(prevalidarToque(contexto).motivo, 'pregunta_reemplazada');
});

for (const [nombre, cambiar] of Object.entries({
  precio: r => { r.items[0].precio_unitario = 101; },
  cantidad: r => { r.items[0].cantidad = 2; },
  salsa: r => { r.items[0].opciones[0].opcion = 'Verde'; },
  modalidad: r => { r.modalidad = 'domicilio'; },
  pago: r => { r.pago = 'transferencia'; },
  fecha: r => { r.programado_para = '2026-10-01T12:00:00Z'; },
  cliente: r => { r.cliente.nombre = 'Otro cliente'; },
  total: r => { r.total = 101; },
})) {
  test(`huella completa detecta cambio de ${nombre}, aunque coincide prefijo`, () => {
    const { contexto } = caso(); cambiar(contexto.actual.resumen);
    assert.equal(huellaDelResumen(contexto.actual.resumen).slice(0, 12), contexto.asociacion.huella.slice(0, 12));
    assert.equal(prevalidarToque(contexto).motivo, 'resumen_cambiado');
  });
}
for (const campo of ['cartaVigente', 'pedidoConfirmable']) {
  test(`${campo} requiere validación positiva del motor`, () => {
    const { contexto } = caso(); delete contexto.actual[campo];
    assert.equal(prevalidarToque(contexto).motivo, 'pedido_no_validado');
  });
}

test('texto y botón: mantiene eventos separados, texto gana y título no entra al texto', () => {
  const { contexto, mensaje } = caso();
  for (const body of ['mejor sin pollo', 'gracias']) {
    const lote = separarLote([mensaje, { type: 'text', text: { body } }]);
    assert.equal(lote.texto, body); assert.equal(lote.ejecutarToques, false);
    assert.equal(lote.toques.length, 1);
    assert.equal(prevalidarToque({ ...contexto, loteMixto: true }).estado, 'atender_texto');
  }
});
test('un lote solo de botones no fabrica texto', () => {
  const lote = separarLote([caso().mensaje]);
  assert.equal(lote.texto, ''); assert.equal(lote.ejecutarToques, true);
});
test('plantilla, medios o interactive inválido no se ejecutan como Confirmar', () => {
  for (const m of [{ type: 'button', button: { text: 'Confirmar', payload: 'confirmar' } },
    { type: 'image' }, { type: 'interactive', interactive: { type: 'nfm_reply' } }, null]) {
    assert.equal(leerToque(m), null); assert.equal(separarLote([caso().mensaje, m]).ejecutarToques, false);
  }
});
test('malformados: falta context, wamid, from o token válido', () => {
  for (const alterar of [m => { delete m.context; }, m => { delete m.id; }, m => { delete m.from; },
    m => { m.interactive.button_reply.id = 'Confirmar'; }]) {
    const { mensaje } = caso(); alterar(mensaje); assert.equal(leerToque(mensaje), null);
  }
});
test('límite de cuerpo: no truncar un resumen para hacerlo caber', () => {
  const { entrada } = caso(); entrada.texto = 'a'.repeat(1024);
  assert.ok(prepararConfirmacion(entrada)); entrada.texto += 'a';
  assert.equal(prepararConfirmacion(entrada), null);
});
test('ventana de servicio: vencida, desconocida o reloj futuro falla cerrado', () => {
  const dia = 24 * 60 * 60 * 1000;
  assert.equal(ventanaAbierta(0, dia - 1), true);
  for (const par of [[0, dia], [0, dia + 1], [undefined, 0], [2, 1]]) assert.equal(ventanaAbierta(...par), false);
  const { entrada } = caso(); entrada.ahoraMs = entrada.ultimoMensajeClienteMs + dia;
  assert.equal(prepararConfirmacion(entrada), null);
});
test('snapshot se puede serializar y el módulo sigue sin producir efectos', () => {
  const contexto = clonar(caso().contexto);
  assert.equal(prevalidarToque(contexto).estado, 'requiere_reserva_durable');
  assert.equal(contexto.pregunta.estado, 'disponible');
});
