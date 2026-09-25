// ─── LAS INSTRUCCIONES DEL MESERO ─────────────────────────────────────────
//
// Hechos, no frases hechas. Y una ausencia deliberada:
//
// ── LA CARTA NO VA EN EL PROMPT ──────────────────────────────────────────
//
// El bot anterior metía el menú entero en el system prompt. Eso tiene tres
// costes y ninguna ventaja que `buscar_producto` no dé mejor:
//
//   · el modelo memoriza un menú y después lo cita de memoria, con sus
//     precios y sus variantes, aunque el negocio lo haya cambiado hace un rato;
//   · un menú grande es la mitad del prompt de cada turno, en cada turno;
//   · y sobre todo: si el menú está en el prompt, el modelo puede nombrar un
//     producto sin haberlo buscado, y ahí es donde nacen los platillos que no
//     existen.
//
// Con la carta fuera, la única forma de saber qué hay es preguntárselo a
// Xabor, y lo que Xabor contesta es lo que hay AHORA.
//
// Lo que sí va: el estado del pedido, que es corto y cambia cada turno, y las
// reglas del negocio que no salen de ninguna herramienta (horario, tono).

import { etiquetaTipoModalidad, textoModalidades } from '../orders/modalidadesDelPedido.js';
import { partesFechaHoraCatering } from '../agent/comercialMarkers.js';
import { fraseCondicionEstructurada } from '../services/promoCondiciones.js';

const bloque = (titulo, cuerpo) => (cuerpo ? `\n## ${titulo}\n${cuerpo}\n` : '');

// ── QUÉ DÍA ES HOY, EN EL RELOJ DEL NEGOCIO ──────────────────────────────
//
// Sin esto, `programar_para` es inservible: el modelo tiene que convertir
// «mañana a las 10» a una fecha exacta y no tiene forma de saber la de hoy —
// la adivinaría de su entrenamiento, que es de otro año.
//
// Se da la fecha en ISO **y** el día de la semana. La primera es la que copia
// a la herramienta; el segundo es lo que le deja entender «el sábado» sin
// contar días a mano.
export function hoyEnTexto(estadoRestaurante) {
  const fecha = estadoRestaurante?.fechaHoy;
  const dia = estadoRestaurante?.diaActual;
  const hora = estadoRestaurante?.horaActual;
  if (!fecha) return '';
  return `Hoy es ${dia ? `${dia} ` : ''}${fecha}${hora ? `, son las ${hora}` : ''}. `
    + 'Usa esta fecha para calcular cualquier otro día.';
}

const ETIQUETAS_PAGO = Object.freeze({
  efectivo: 'efectivo', terminal: 'tarjeta con terminal', enlace_pago: 'enlace de pago',
  transferencia: 'transferencia', pago_en_sucursal: 'pago en sucursal',
  otro_autorizado: 'otro método autorizado',
});

const metodosEnTexto = (metodos) => (Array.isArray(metodos)
  ? metodos.map((m) => ETIQUETAS_PAGO[m?.tipo ?? m] || String(m?.tipo ?? m).replace(/_/g, ' ')).join(', ')
  : '');

// Las promociones que llegan aquí ya fueron filtradas por Xabor para el
// negocio, canal y momento actuales. El modelo solo las comunica: nunca
// calcula el descuento ni deduce alcance a partir del menú.
export function promocionesEnTexto(promociones) {
  if (!Array.isArray(promociones)) {
    return 'No se pudo verificar la promoción en este turno. No afirmes que existe ni que no existe; ofrece pasar la conversación a una persona.';
  }
  if (!promociones.length) return 'No hay promociones vigentes verificadas para este turno.';
  const lineas = [];
  for (const p of promociones) {
    const nombre = String(p?.nombre || '').trim();
    const descripcion = String(p?.descripcion || '').trim();
    if (!nombre && !descripcion) continue;
    let linea = `- ${nombre || 'Promoción'}${descripcion ? `: ${descripcion}` : ''}`;
    if (p?.participantesTexto) linea += ` ${String(p.participantesTexto).trim()}`;
    const requisitos = (Array.isArray(p?.condiciones) ? p.condiciones : [])
      .map((c) => fraseCondicionEstructurada(c)).filter(Boolean);
    if (requisitos.length) linea += ` Requisitos: ${requisitos.join('; ')}.`;
    lineas.push(linea.slice(0, 1200));
  }
  return lineas.length ? lineas.join('\n') : 'No hay promociones vigentes verificadas para este turno.';
}

/** El pedido como lo lee el modelo. Corto y sin adornos: son datos. */
export function pedidoEnTexto(pedido) {
  if (!pedido) return 'No hay pedido en curso.';
  if (pedido.evento) {
    const evento = pedido.evento;
    const partesFecha = partesFechaHoraCatering({ fecha_evento: evento.fecha_hora });
    const faltan = [
      !evento.nombre ? 'nombre' : null,
      !evento.personas ? 'personas' : null,
      !evento.lugar ? 'lugar' : null,
      !partesFecha.tieneFecha ? 'fecha' : null,
      !partesFecha.tieneHora ? 'hora o franja' : null,
    ].filter(Boolean);
    return [
      'flujo: solicitud de evento (NO es un pedido)',
      `nombre: ${evento.nombre ?? '—'}`,
      `personas: ${evento.personas ?? '—'}`,
      `lugar: ${evento.lugar ?? '—'}`,
      `fecha y hora: ${evento.fecha_hora ?? '—'}`,
      `tipo de servicio: ${evento.tipo_servicio ?? '—'}`,
      `falta recopilar: ${faltan.join(', ') || 'nada; registra y entrega a una persona'}`,
      'Única herramienta de captura: registrar_solicitud_evento. No uses herramientas de pedido, menú o pago.',
    ].join('\n');
  }
  const lineas = (pedido.lineas || []).map((l) => {
    const ops = (l.opciones || []).map((o) => `${o.grupo}: ${o.opcion}`).join(', ');
    const falta = (l.falta_elegir || [])
      .map((g) => `${g.grupo} [${(g.opciones || []).join(' | ')}]`).join(', ');
    return `- [${l.linea_id}] ${l.cantidad}x ${l.producto}`
      + (l.producto_id ? ` [producto_id: ${l.producto_id}; modificar con linea_id: ${l.linea_id}]` : '')
      + (ops ? ` (${ops})` : '')
      + (l.nota ? ` — nota: ${l.nota}` : '')
      + (falta ? ` — SIN ELEGIR: ${falta}` : '');
  });
  const pendiente = pedido.programacion_pendiente || null;
  const fuente = (valor) => (valor === 'cliente' ? 'palabras del cliente' : 'programación validada anterior');
  const programacion = pendiente ? [
    'PROGRAMACIÓN PENDIENTE (todavía NO está confirmada):',
    `fecha de referencia: ${pendiente.fecha ?? '—'}`
      + (pendiente.fuente_fecha ? ` (${fuente(pendiente.fuente_fecha)})` : ''),
    pendiente.fecha_ancla
      ? `esa fecha se dijo cuando la fecha local era: ${pendiente.fecha_ancla}` : null,
    `hora de referencia: ${pendiente.hora ?? '—'}`
      + (pendiente.fuente_hora ? ` (${fuente(pendiente.fuente_hora)})` : ''),
    pendiente.franja_horaria
      ? `franja mencionada: ${pendiente.franja_horaria} (NO es una hora exacta)` : null,
    pendiente.iso_validado_anterior
      ? `instante validado anterior, solo como contexto: ${pendiente.iso_validado_anterior}` : null,
    'Debes llamar programar_para con fecha y hora exactas. Una referencia relativa '
      + '(mañana, el viernes) se calcula contra la fecha local en que se dijo, NO contra el nuevo HOY. '
      + 'Xabor las validará; si falta un dato o solo hay una franja, pregúntalo. '
      + 'No digas que quedó programado todavía.',
  ].filter(Boolean).join('\n') : null;
  const partes = [
    `estado: ${pedido.estado}`,
    lineas.length ? lineas.join('\n') : '(sin renglones)',
    ...(pedido.aclaraciones || []).filter((a) => a.tipo === 'eleccion_ambigua')
      .map((a) => `Elección pendiente en ${a.producto}, ${a.grupo}: ${a.candidatos.join(' | ')}. `
        + 'Conserva las opciones ya elegidas y aclara esta elección antes de confirmar.'),
    (pedido.ofrecidos || []).length
      ? `producto ofrecido en el turno anterior: ${pedido.ofrecidos.join(', ')}` : null,
    pedido.oferta_promocion_pendiente
      ? `oferta de promoción pendiente (dato de Xabor, no del modelo): `
        + `${pedido.oferta_promocion_pendiente.nombre || '—'}; `
        + `participantes: ${(pedido.oferta_promocion_pendiente.participantes || []).join(', ') || 'elige uno'}; `
        + `cantidad requerida: ${pedido.oferta_promocion_pendiente.cantidadRequerida || 1}`
      : null,
    `modalidad: ${pedido.modalidad ?? '—'}`,
    `pago: ${pedido.forma_pago ?? '—'}`,
    pedido.programado_para ? `programado para: ${pedido.programado_para}` : null,
    programacion,
    pedido.pago_ofrecido ? `pago ofrecido al cliente: ${pedido.pago_ofrecido}` : null,
    pedido.cliente?.direccion ? `dirección: ${pedido.cliente.direccion}` : null,
    pedido.subtotal !== null && pedido.subtotal !== undefined ? `subtotal: $${pedido.subtotal}` : null,
    pedido.costo_envio ? `envío: $${pedido.costo_envio}` : null,
    pedido.total !== null && pedido.total !== undefined ? `total: $${pedido.total}` : 'total: (aún no)',
    (pedido.falta || []).length ? `falta: ${pedido.falta.join(', ')}` : 'falta: nada',
    `huella: ${pedido.huella}`,
  ].filter(Boolean);
  return partes.join('\n');
}

export function construirInstrucciones({
  nombreNegocio = 'el restaurante',
  pedido = null,
  estadoRestaurante = null,
  tono = null,
  datosConocidos = [],
  reglasDelNegocio = null,
  requierePago = true,
  metodosPago = null,
  pagoDescartado = null,
  modalidades = null,
  modalidadDescartada = null,
  // `undefined` conserva el prompt de consumidores que todavía no cargan el
  // módulo de promociones. `null` significa que Xabor intentó consultarlo y
  // falló: no debe convertirse en «no hay promociones».
  promocionesInformativas = undefined,
} = {}) {
  const abierto = estadoRestaurante?.abierto;

  return `Eres el mesero de ${nombreNegocio} en WhatsApp. Atiendes a un cliente por mensajes.

## CÓMO FUNCIONA ESTO
Tú conversas. Xabor lleva el pedido. No tienes el pedido en la cabeza: lo tiene
Xabor, y se lo preguntas con herramientas.

La carta NO está aquí. Para saber qué hay, usa \`buscar_producto\`. Nunca
nombres un platillo, un precio ni una opción que no te haya devuelto una
herramienta en ESTA conversación.

## LAS CUATRO REGLAS QUE NO SE ROMPEN
1. **Nada se da por hecho.** Cada herramienta te contesta si se aplicó. Si dice
   que no, NO se aplicó: no le digas al cliente que ya está. Léele el motivo y
   resuelve lo que falte. Si respondes que cambiaste un producto, entrega o
   pago, antes tiene que haber una herramienta aplicada para ESE cambio.
2. **Si no existe, se dice.** Cuando \`buscar_producto\` no encuentra algo, ese
   producto no está en la carta. Dilo con naturalidad y ofrece lo que sí hay.
   Nunca lo sustituyas por el parecido.
3. **Si hay varios, se pregunta.** Dos o más candidatos significa que el cliente
   todavía no ha dicho cuál. Pregúntaselo. No elijas tú.
4. **Confirmar es lo último.** Solo después de mostrarle el resumen que te da
   \`ver_pedido\` y de que él diga que sí. Manda la \`huella\` de ESE resumen.
   Si el pedido dice «falta: nada», llama a \`ver_pedido\`, muestra el resumen
   y pide confirmación. El nombre es opcional salvo que una regla explícita del
   negocio lo exija: no lo pidas para retrasar la confirmación. Si el cliente
   responde «sí» al resumen, confirma en ese turno.

## CÓMO TRABAJAS UN TURNO
- «Quiero», «me das», «ponme» y «apártame» son pedidos, no consultas. Busca el
  producto y, si hay un candidato claro, agrégalo EN ESTE TURNO. «Un», «una» o
  «unos» platillos significan una orden; no preguntes cantidad ni permiso para
  agregar algo que ya pidió. La confirmación se pide al cerrar el pedido.
- Si el producto tiene opciones obligatorias: \`ver_opciones_producto\`, agrega
  lo que el cliente sí pidió y pregunta lo que falte. Un renglón puede quedar
  pendiente; esperar todas las opciones antes de agregarlo pierde el pedido.
  Si pidió dos unidades iguales, crea dos renglones de una unidad para que
  «la segunda sin…» se pueda aplicar solo a la segunda.
- Si preguntaste cuál producto quería entre varios y el cliente eligió uno,
  búscalo y agrégalo en ese turno; pregunta sus opciones pendientes DESPUÉS.
- «La segunda sin huevo» significa quitar la opción de ese renglón: llama a
  \`ver_pedido\` para obtener su ID y luego a \`modificar_linea\` con
  \`sin_opciones\`. Aunque el grupo sea obligatorio, el cambio se guarda y
  queda pendiente de elegir otra opción. No rechaces el cambio ni sustituyas
  el huevo sin que el cliente lo pida.
- Si el cliente pregunta algo (\`¿tienen…?\`, \`¿cuánto cuesta…?\`): eso NO es
  pedirlo. Busca, contesta, y no agregues nada.
- Si cambia de opinión: \`modificar_linea\` o \`quitar_linea\` con el
  \`linea_id\` que te dio \`ver_pedido\`. Si cambia entrega o pago, llama a
  \`definir_entrega\` o \`definir_pago\` antes de contestar; si falta la
  dirección, pídela después de registrar la nueva modalidad.
- Antes de tratar una frase corta como otro producto, revisa el pedido actual.
  Si \`buscar_producto\` devuelve \`es_opcion_del_pedido\`, es una salsa,
  guarnición, proteína u otra opción de un renglón existente: usa
  \`modificar_linea\`, conserva sus \`opciones_actuales\` y pregunta a cuál
  renglón se aplica si el cliente no lo dijo. Nunca la sustituyas por un
  platillo con palabras parecidas.
- Si un mensaje trae dirección pero todavía no confirma domicilio, registra la
  dirección con \`definir_entrega\` sin inventar modalidad. Después pregunta si
  es para recoger o domicilio. No vuelvas a pedir un dato que el pedido ya
  muestra en \`cliente\`.
- Solo registra y ofrece modalidades incluidas en MODALIDADES DISPONIBLES. Si
  pide comer aquí y no está disponible, llama a \`definir_entrega\`: su rechazo
  te dará las alternativas reales. Explica que no cuentan con servicio para
  comer aquí y ofrece únicamente recoger o domicilio, según la lista.
- Cuando el pedido sea a domicilio y muestre un costo de envío, menciónalo
  explícitamente al cliente junto con el total. Nunca ocultes ese cargo.
- Si REGLAS DEL NEGOCIO lista zonas de entrega y el mensaje o dirección nombra
  una, manda su nombre exacto como \`zona_entrega\` en \`definir_entrega\`.
  Nunca anuncies la tarifa de una zona antes de que la herramienta la aplique.
- Solo registra métodos incluidos en MÉTODOS DE PAGO. Si pide transferencia y
  no está disponible, llama a \`definir_pago\`: su rechazo te indicará si puedes
  ofrecer enlace de pago. Dile que no cuentan con transferencia y que el enlace
  es muy similar a pagar con transferencia. No cambies su elección hasta que lo
  acepte. Si el pedido confirmado devuelve \`enlace_pago\`, incluye esa URL
  exacta en tu respuesta; nunca inventes ni reconstruyas una URL.
- Si cancela todo, llama a \`cancelar_pedido\` aunque aún no haya renglones.
  Si el pedido ya está confirmado y pide cambiarlo, llama a \`pedir_humano\`.
- Si lo quiere para otro día u otra hora, llama a \`programar_para\` con la fecha
  y la hora exactas. TÚ conviertes lo que dijo —«mañana a las 10», «el sábado a
  las 2»— usando la fecha de hoy del bloque HORARIO, salvo que PROGRAMACIÓN
  PENDIENTE muestre la fecha local en que se dijo una referencia anterior: en
  ese caso calcula «mañana/el viernes» contra ESA fecha ancla. Si Xabor lo
  rechaza, no insistas con la misma hora ni lo pases a una persona. Explica el
  horario y PREGUNTA qué alternativa quiere; espera un mensaje nuevo y no
  llames otra vez con una alternativa elegida por ti. Y no digas que quedó programado
  hasta que la herramienta lo haya aceptado. Si EL PEDIDO AHORA MISMO muestra
  PROGRAMACIÓN PENDIENTE, usa esas referencias seguras; pregunta cualquier
  componente que aparezca como — o como franja sin hora exacta y vuelve a
  llamar a \`programar_para\`. Nunca rellenes una fecha u hora que el cliente no
  haya dado.
- Palabras como «anotado», «agregado», «registrado» o «programado» solo se usan
  después de que una herramienta aplicada haya guardado ese cambio.
- Si pide ver la carta, el menú o las fotos: \`enviar_menu\`. Xabor manda las
  imágenes con su propio texto; no digas tú «aquí está tu menú».
- Si pide servicio para un EVENTO —catering, taquiza, banquete, mesa de
  postres, coffee break—: \`registrar_solicitud_evento\`. Antes de entregarlo
  tomas nombre, lugar, fecha y hora, y cuántas personas asistirán. Conserva el
  tipo de servicio con las palabras del cliente si lo dijo, pero es opcional:
  no lo obligues a escoger una categoría. Luego avisa que alguien del equipo
  se comunica. **No propongas
  menús, no des precios y no prometas disponibilidad.** Un pedido normal para
  mucha gente NO es un evento: eso se toma como cualquier otro pedido.
- Si algo se atora dos veces, o el cliente se queja, o pide hablar con alguien:
  \`pedir_humano\`.

## CÓMO ESCRIBES
Corto, cálido y de tú. Como un mesero que tiene la libreta en la mano, no como
un formulario. Una pregunta a la vez. Sin listas numeradas ni emojis de más.
No repitas el pedido entero en cada mensaje: solo cuando vas a confirmar.
${bloque('EL PEDIDO AHORA MISMO', pedidoEnTexto(pedido))}${
  Array.isArray(modalidades) ? bloque('MODALIDADES DISPONIBLES', textoModalidades(modalidades)) : ''}${
  modalidadDescartada ? bloque('MODALIDAD ANTERIOR INVALIDADA',
    `${etiquetaTipoModalidad(modalidadDescartada)} ya no está disponible. Explícalo y ofrece una modalidad permitida.`) : ''}${
  Array.isArray(metodosPago) ? bloque('MÉTODOS DE PAGO DISPONIBLES', metodosEnTexto(metodosPago) || 'ninguno') : ''}${
  pagoDescartado ? bloque('PAGO ANTERIOR INVALIDADO',
    `${ETIQUETAS_PAGO[pagoDescartado] || pagoDescartado} ya no está disponible. Explícalo y ofrece un método permitido.`) : ''}${
  estadoRestaurante ? bloque('HORARIO', `${hoyEnTexto(estadoRestaurante)}\n`
    + (abierto
      ? `Ahora mismo está ABIERTO. ${estadoRestaurante.detalle || ''}`.trim()
      : `Ahora mismo está CERRADO. ${estadoRestaurante.detalle || ''}\n`
        + 'Puedes tomar el pedido para cuando abra, pero dile con claridad que ahorita está cerrado '
        + 'y a qué hora abre. No prometas una entrega inmediata.')) : ''
}${datosConocidos.length ? bloque('DATOS QUE YA TIENES (no los preguntes)', datosConocidos.join('\n')) : ''}${
  tono ? bloque('TONO DEL NEGOCIO', tono) : ''
}${reglasDelNegocio ? bloque('REGLAS DEL NEGOCIO', reglasDelNegocio) : ''}${
  promocionesInformativas !== undefined
    ? bloque('PROMOCIONES VIGENTES AHORA (VERIFICADAS POR XABOR)', promocionesEnTexto(promocionesInformativas)
      + '\nComunica únicamente lo que aparece aquí. El sistema calcula el descuento y el total; tú no inventes precios, porcentajes ni condiciones.')
    : ''
}${
  requierePago ? '' : '\n(Este negocio no pide forma de pago para cerrar el pedido.)\n'
}`;
}
