// ─── LOS TEXTOS FIJOS DEL MODO FORMULARIO / RECEPCIONISTA ──────────────────
//
// Decisión del dueño (3-oct-2026): los pedidos SOLO en el formulario; la IA
// queda como recepcionista para dudas. Todo lo que el bot dice en ese modo
// sale de aquí (o de la configuración del Asistente, respuestasFijas.js):
// nunca prosa del modelo.
//
// Módulo HOJA, sin importaciones, a propósito: reciboHandoff.js arma su lista
// cerrada con TEXTOS_PERSONA al cargarse, y un ciclo de importaciones con
// recepcionista.js dejaría la lista sin inicializar. Lo reexporta
// recepcionista.js, que es donde lo buscan las pruebas y el chequeo.
//
// Reglas de redacción (check-modo-ia.mjs las exige): cálidos y cortos, sin
// invitar a escribir el pedido («dime», «escríbeme», «te lo anoto»…), sin
// afirmar un cambio y dentro de 1024 caracteres. Los que terminan en «\n» son
// el `aviso` de un formulario: se anteponen a su cuerpo fijo.

const PROGRAMADO_TIENDA = (url) => `Para un pedido de otro día, agéndalo en nuestra tienda en línea: ${url}. Ahí eliges el día y la hora.`;

export const FRASES = Object.freeze({
  // ── Avisos de formulario ───────────────────────────────────────────────
  PEDIR: '¡Con gusto te ayudamos! 🙂\n',
  // «no abre» es deliberado: casa con formularioNoCarga (rescateHumano.js) y
  // el rescate lo pasa a una persona. Es la única invitación a escribir y no
  // es el pedido.
  PEDIDO_ESCRITO: 'Gracias, recibimos los detalles de tu pedido. Todavía no está registrado: elige tus platillos en este formulario y revisa el total antes de confirmar. Si no te abre, respóndenos «no abre».\n',
  PEDIDO_ESCRITO_CERRADO: 'Recibimos los detalles de tu pedido. Este mensaje no confirma ni modifica un pedido.\n\n',
  CAMBIAR: 'Claro. Haz el cambio aquí, en tu pedido; nada se cobra hasta que confirmes.\n',
  CARTA: 'Aquí está nuestro menú con precios; desde ahí mismo puedes pedir.\n',
  RETOMAR: 'Aquí sigue tu pedido guardado.\n',
  SALUDO_CON_CARRITO: '¡Hola de nuevo! Tu pedido sigue guardado aquí.\n',
  DIRECCION_EN_FORMULARIO: 'Para que tu dirección llegue completa al repartidor, escríbela en el formulario, por favor.\n',
  USA_OPCIONES: 'Para que quede bien, elige una opción de la lista, por favor.\n',
  // La misma pregunta, cuando sale como formulario (no como lista).
  USA_FORMULARIO: 'Para que quede bien, elígelo en el formulario, por favor.\n',
  PRODUCTO_PIE: 'Puedes pedirlo desde el menú. 👇',

  // ── Respuestas con botones ────────────────────────────────────────────
  NO_RECONOCIDO: 'Perdón, no te entendí bien. 🙏 ¿Qué te gustaría hacer?',
  SALUDO: '¡Hola! 🙂 ¿Qué te gustaría hacer?',
  INFORMACION_MENU: '¿Sobre qué te gustaría saber? Elige un tema.',
  INFO_CAMBIO: 'Esa información cambió. Elige el tema de nuevo, por favor.',
  MENU_CAMBIO: 'Ese botón ya no está vigente. ¿Qué te gustaría hacer?',
  PRODUCTO_NO_ENCONTRADO: 'No lo encuentro en nuestro menú de WhatsApp. Si quieres confirmarlo, toca «Hablar con alguien».',
  PROMOS_NO_DISPONIBLES: 'Ahora no pude consultar las promociones. Las ves aplicadas en el menú al hacer tu pedido.',
  PROGRAMADO_TIENDA,
  COMO_PEDIR: '*Cómo pedir por aquí*\nToca «Hacer pedido», elige tus platillos y toca «Continuar» para elegir entrega y pago. Antes de confirmar ves el resumen con el total; nada se cobra hasta que confirmes.',
  // Variantes de textos de hoy (recuperacionDelTurno.js, con `recepcion`).
  ELIGE_EN_MENU: 'Elige tus platillos en el menú. 👇',
  REVISA_EN_FORMULARIO: 'Revisa tu pedido en el formulario. 👇',
  // Un «gracias», «ok», «Listo» o «👍» (R-cortesía): el mismo texto que la
  // cortesía tras el pedido de hoy (cortesiaPostPedido.js). Con un formulario
  // de pedido en curso, el aviso del formulario que se vuelve a mandar.
  CORTESIA: '¡Gracias a ti! Si necesitas algo más, aquí estamos para ayudarte.',
  CORTESIA_FORMULARIO: '¡Con gusto! 🙂\n',

  // ── Persona (cadenas EXACTAS: permiteReciboHandoff compara literal) ────
  PERSONA: 'Con gusto. Te paso con alguien del equipo; en un momento te escriben por aquí.',
  PERSONA_PEDIDO: 'Gracias por tu paciencia. Te paso con alguien del equipo para tomar tu pedido; en un momento te escriben por aquí.',
  PERSONA_IMAGEN: 'Recibido, gracias. Lo revisa el personal y te contesta por aquí en un momento.',
  PERSONA_PEDIDO_EXTERNO: 'Recibido, gracias. El personal confirma tu pedido y te escribe por aquí en un momento.',
  PERSONA_QUEJA: 'Lamentamos mucho lo ocurrido. Te paso con alguien del equipo para atenderte; en un momento te escriben por aquí.',
  PERSONA_RETRASO: 'Entiendo. Le aviso al equipo para que revise tu pedido y te escriba por aquí en un momento.',
  PERSONA_PROGRAMADO: 'Para agendar tu pedido de otro día te paso con alguien del equipo; en un momento te escriben por aquí.',
  PERSONA_EVENTO: 'Con gusto. Te paso con alguien del equipo para los detalles de tu evento; en un momento te escriben por aquí.',
  PERSONA_OTRO: 'Gracias por escribirnos. Lo revisa el personal y te contesta por aquí.',
  PERSONA_CONFIRMADO: 'Tu pedido ya está registrado. Para cambiarlo te paso con alguien del equipo; en un momento te escriben por aquí.',
  PERSONA_CERRADO: 'Recibimos tu mensaje. 🙂 Ahora estamos cerrados; el personal te contesta por aquí en cuanto abramos.',
});

// Pie del texto de respaldo de los botones (si el teléfono no los muestra).
// Fuera de FRASES: invita a escribir, pero para llegar a una persona, nunca el pedido.
export const PIE_SIN_BOTONES = 'Si necesitas ayuda, escribe «hablar con alguien».';
// Un saludo tras el pedido (sin botones: el menú de inicio no vale con un
// folio). Fuera de FRASES por la misma razón que el pie.
export const SALUDO_SIN_BOTONES = '¡Hola! 🙂 Si necesitas algo de tu pedido, escribe «hablar con alguien».';

/** Los textos que prometen una persona: van a TEXTOS_RECIBO_HANDOFF (reciboHandoff.js). */
export const TEXTOS_PERSONA = Object.freeze([
  FRASES.PERSONA, FRASES.PERSONA_PEDIDO, FRASES.PERSONA_IMAGEN, FRASES.PERSONA_PEDIDO_EXTERNO,
  FRASES.PERSONA_QUEJA, FRASES.PERSONA_RETRASO, FRASES.PERSONA_PROGRAMADO, FRASES.PERSONA_EVENTO,
  FRASES.PERSONA_OTRO, FRASES.PERSONA_CONFIRMADO, FRASES.PERSONA_CERRADO,
]);

// Con el local cerrado, toda persona usa PERSONA_CERRADO salvo esta, que no
// promete una hora. (PERSONA_IMAGEN y PERSONA_PEDIDO_EXTERNO dicen «en un
// momento»: de noche sería la promesa sin dueño de ccca77514.)
export const PERSONA_SIN_HORA = Object.freeze([FRASES.PERSONA_OTRO]);

/**
 * Los motivos de revisión del modo. Todos vencen como una petición (P3,
 * pausaVencePolitica.MOTIVOS_PETICION) salvo RECEPCION_QUEJA_PAGO: dinero,
 * nunca vence (motivoDeDineroOIncierto lo reconoce por «PAGO»).
 */
export const MOTIVOS_RECEPCION = Object.freeze({
  PEDIDO_ESCRITO: 'RECEPCION_PEDIDO_ESCRITO',
  FORMULARIO_NO_DISPONIBLE: 'RECEPCION_FORMULARIO_NO_DISPONIBLE',
  NO_PUEDE: 'RECEPCION_NO_PUEDE',
  PIDE_PERSONA: 'RECEPCION_PIDE_PERSONA',
  INSISTE: 'RECEPCION_INSISTE',
  IMAGEN: 'RECEPCION_IMAGEN',
  PEDIDO_EXTERNO: 'RECEPCION_PEDIDO_EXTERNO',
  QUEJA: 'RECEPCION_QUEJA',
  QUEJA_PAGO: 'RECEPCION_QUEJA_PAGO',
  RETRASO: 'RECEPCION_RETRASO',
  PROGRAMADO: 'RECEPCION_PROGRAMADO',
  OTRO: 'RECEPCION_OTRO',
  TRAS_PERSONAL: 'RECEPCION_TRAS_PERSONAL',
  SIN_PRECONDICIONES: 'RECEPCION_SIN_PRECONDICIONES',
});

/**
 * Lo que lee el encargado: `aviso` en el aviso al equipo (avisoRescateHumano.js)
 * y `pausa` en el resumen de pausas liberadas (pausaVencePolitica.js). Esos
 * dos archivos llevan las cadenas escritas (sin importar este módulo);
 * check-modo-ia.mjs exige que coincidan.
 */
export const ETIQUETAS_RECEPCION = Object.freeze({
  RECEPCION_PEDIDO_ESCRITO: { aviso: 'el cliente escribió su pedido otra vez en lugar de usar el formulario', pausa: 'escribió su pedido' },
  RECEPCION_FORMULARIO_NO_DISPONIBLE: { aviso: 'no se pudo abrir el formulario de pedido', pausa: 'no se pudo abrir el formulario de pedido' },
  RECEPCION_NO_PUEDE: { aviso: 'el cliente no pudo usar el formulario', pausa: 'el cliente no pudo usar el formulario' },
  RECEPCION_PIDE_PERSONA: { aviso: 'el cliente pidió hablar con una persona', pausa: 'el cliente pidió hablar con una persona' },
  RECEPCION_INSISTE: { aviso: 'el bot no entendió al cliente dos veces', pausa: 'el bot no entendió al cliente dos veces' },
  RECEPCION_IMAGEN: { aviso: 'el cliente mandó una imagen', pausa: 'el cliente mandó una imagen' },
  RECEPCION_PEDIDO_EXTERNO: { aviso: 'dice que ya hizo su pedido', pausa: 'dice que ya hizo su pedido' },
  RECEPCION_QUEJA: { aviso: 'queja del cliente', pausa: 'queja del cliente' },
  RECEPCION_QUEJA_PAGO: { aviso: 'queja sobre un cobro', pausa: 'queja sobre un cobro' },
  RECEPCION_RETRASO: { aviso: 'el cliente reclama por la espera', pausa: 'el cliente reclama por la espera' },
  RECEPCION_PROGRAMADO: { aviso: 'quiere un pedido para otro día', pausa: 'quiere un pedido para otro día' },
  RECEPCION_OTRO: { aviso: 'vacante o proveedor', pausa: 'vacante o proveedor' },
  RECEPCION_TRAS_PERSONAL: { aviso: 'el cliente escribió después del personal', pausa: 'el cliente escribió después del personal' },
  RECEPCION_SIN_PRECONDICIONES: { aviso: 'el modo formulario no pudo operar', pausa: 'el modo formulario no pudo operar' },
});
