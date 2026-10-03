// ─── EL ADAPTADOR: donde el agente toca el mundo ──────────────────────────
//
// Esto es lo que faltaba el mes entero. El Mesero anterior estaba completo y
// probado como capa y NUNCA se conectó al canal: `atenderTurno` tenía un solo
// sitio de llamada en todo `src/` y era la sombra. Había cero código que un
// interruptor pudiera encender.
//
// Aquí está el camino real, en dos funciones:
//
//   atenderConAgente()    productivo. Devuelve el texto que se le manda al
//                         cliente. Efectos reales: registra el pedido y escala.
//   observarConAgente()   sombra. La misma lógica, sobre una copia, con
//                         efectos que solo graban. No responde a nadie.
//
// Las dos comparten TODO menos los efectos y dónde guardan el estado. Que no
// haya dos implementaciones es lo que hace que observar signifique algo.
import {
  pool, obtenerConfiguracion, guardarPedido, obtenerMetodosPagoDisponibles,
  obtenerReservaProgramadaPorFolio,
} from '../services/database.js';
import { obtenerCatalogoDelAgente } from '../services/catalogoWhatsapp.js';
import {
  claveDeSesion, claveDeTurno, leerEstadoVersionado, heredarIdentidad, respuestaDeTurnoAplicado,
  confirmarTurno, ConflictoDeVersionError,
} from './persistenciaDelTurno.js';
import { registrarAceptacionExterna } from './entregaDeRespuestas.js';
import { construirBotones, reservarBotones, autorizarBotonReservado, conciliarReservaBotones, interactivosActivos, barrerasDeBotones } from './interactivos.js';
import { construirFormulario, aplicarFormulario, ACCIONES_FLOW, flowsActivos, entradaFormulario, fotoFormulario } from './formularioAgrupado.js';
import { eleccionesActivas, opcionesInteractivas, textoDeElecciones, abrirGrupoDePregunta,
  respuestaDeEleccion, respuestaTextoGrupo } from './eleccionesInteractivas.js';
import { fijarPendiente, normalizarEstado, PENDIENTES } from './estadoCanonico.js';
import { betaHibridaActiva, consultaInformativaHibrida, borradorRetomable,
  entradaRetomarPedido, textoConsultaConCarrito, pedidoSinArmar } from './experienciaHibrida.js';
import { aplicarCarritoNativo, catalogoNativoActivo } from './catalogoNativo.js';
import { informacionDeConsultaMixta } from './consultaMixta.js';
import { sugerenciaPromocion } from './oportunidadPromocion.js';
import { leerEstadoOperativo } from './estadoOperativoDelPedido.js';
import { randomUUID } from 'node:crypto';
import { entradaMapo, construirInicioMapo, respuestaOpcionMapo, ACCIONES_SERVICIO,
  validarServicio, textoReciboServicio } from './inicioMapo.js';
import { motivoServicio } from './solicitudesServicio.js';
import { formularioFiscalDisponible, AYUDA_FOLIO, AYUDA_ARCHIVO_FISCAL } from './entradaFacturacion.js';
import { consultaFotografiaAmbigua } from './consultaFotografia.js';
import { hayMensajesEnEspera } from './mensajesEnEspera.js';
import { borradorCompatible } from './recuperarBorradorFlow.js';
import { direccionPorTexto, respuestaDeDireccion, direccionTextoActiva, RESPUESTAS_DE_DIRECCION } from './direccionPorTexto.js';
import { TIPOS } from './outbox.js';
import { esEfectoExterno } from './contratoDeHerramientas.js';
import { crearEnlacePago } from '../services/pagosService.js';
import { obtenerConfigTienda } from '../services/tiendaOnline.js';
import { TZ_DEFAULT } from '../services/zonaHoraria.js';
import {
  registrarPedido, emitirPedido, previsualizarPedido, convertirPedidoAProgramado,
  retirarProgramadoFallidoDeMemoria,
} from '../orders/orderManager.js';
import { esPagoPorEnlace } from '../orders/pagoPorEnlace.js';
import { atenderTurnoConHerramientas, CIERRE } from './agenteDelMesero.js';
import { estadoNuevo, estadoSerializable, crearEjecutor } from './ejecutorDeHerramientas.js';
import { libroDeOperaciones, almacenEnMemoria, almacenTransaccional } from './libroDeOperaciones.js';
import { buscarProductos, productosVendibles } from '../mesero-whatsapp/consultasDelMenu.js';
import { cicloParaTurno, limpiarFlujoVencido } from './cicloDelAgente.js';
import { acusarDialogo, fijarRecepcionDelTurno } from './contratoConversacional.js';
import { depurarPagoNoDisponible } from './politicaDePagos.js';
import { cargarReglas, obtenerEstadoRestaurante } from '../agent/prompts.js';
import {
  describirPromocionesVigentes, consultarPromocionesParaAgente,
} from '../services/tiendaPromociones.js';
import {
  depurarModalidadNoDisponible, etiquetaTipoModalidad, modalidadesDisponibles,
} from '../orders/modalidadesDelPedido.js';
import {
  analizarReferenciasTemporalesDePedido, esDiaNumericoDesnudoAmbiguo,
  autorizaNegacionDeProgramacionDesdeMensaje, autorizaProgramarParaDesdeMensaje,
  esConsultaDePosibilidadDePedido, esGestionTemporalAjenaAlPedido,
  esRechazoTersoDeFecha,
  horasExactasDePedido,
  esSolicitudDePedidoProgramado,
  respuestaAfirmaCambioSinAplicar,
  fusionarReferenciaProgramacion, pideQuitarProgramacion,
  referenciaProgramacionSegura,
  TEXTO_CAMBIO_NO_GUARDADO,
} from './seguridadConversacional.js';
import { construirAvisoFueraDeHorario } from './horarioDelAgente.js';
import { reglasDelAsistenteEnTexto, respuestaProhibidaEncontrada, respuestaSobreMesas } from './reglasDelAsistente.js';
import { fraseTiempoEstimado } from './tiempoEstimado.js';
import {
  MENSAJE_CATERING_ENTREGADO, MENSAJE_CATERING_REVISION,
  cancelaSolicitudCatering, esSolicitudCatering, cambiaCateringAPedido,
  motivoRespuestaCateringProhibida, preguntaSiguienteCatering, TEXTO_CATERING_CANCELADO,
} from '../agent/catering.js';
import {
  eventoCateringPublico, eventoCateringVerificado, filtrarDatosEventoCatering,
  retirarCamposEventoCatering,
} from '../agent/evidenciaCatering.js';

// Encabeza el formulario cuando el proveedor del modelo falló y el último
// mensaje del cliente no se aplicó: el cliente tiene que saber que lo repita.
export const AVISO_MENSAJE_SIN_APLICAR = 'Disculpa la demora. No pude completar tu último mensaje; '
  + 'si traía un cambio o un dato, escríbelo de nuevo, por favor.\n';
// Encabeza el formulario de pedido cuando el bot no pudo armar lo que el
// cliente escribió y el carrito sigue vacío.
export const AVISO_PEDIDO_SIN_ARMAR = 'No pude armar tu pedido con ese mensaje. Elige aquí tus platillos y sus opciones.\n';

// Un teléfono nunca sale de aquí entero hacia un log o una cola: se queda en
// los últimos cuatro dígitos, que bastan para cruzarlo con una conversación
// real si hace falta y no identifican a nadie por sí solos.
export const telefonoCorto = (t) => {
  const d = String(t ?? '').replace(/[^0-9]+/g, '');
  return d ? `…${d.slice(-4)}` : '';
};

// La lista informativa sale del mismo módulo que aplica las promociones,
// filtrada por negocio, canal, fecha, hora y carta PUBLICADA de WhatsApp. Si la
// consulta falla se conserva `null` para que el prompt no convierta un error de
// lectura en «no hay promo». Es también la lista de lo vigente AHORA: una
// oferta solo se puede aceptar si su promoción está en ella.
async function cargarPromocionesInformativas(negocioId, canal, timezone) {
  try {
    return await describirPromocionesVigentes(negocioId, {
      canal, timezone: timezone || TZ_DEFAULT, soloPublicadosWhatsapp: true,
    });
  } catch (e) {
    console.error(`[AGENTE] no se pudieron consultar promociones negocio=${negocioId}:`, e?.message);
    return null;
  }
}

export const esConsultaDePromociones = (mensaje) => {
  const t = String(mensaje || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!/\bpromo(?:s|cion(?:es)?)?\b/.test(t)) return false;
  // «Quiero una promoción» pide conocer/ofrecer la vigente y debe pasar por
  // la fuente oficial. Solo apartamos frases que expresan una mutación del
  // pedido («aplicarla», «usarla», «agregarla al pedido»); no confundimos el
  // verbo «quiero» con la intención de aplicar un descuento.
  if (/\b(?:usar|aplicar|aplicame|agrega|anade|añade|ponme)\b/.test(t)
    || /\bpromo(?:s|cion(?:es)?)?\b.*\b(?:pedido|orden)\b/.test(t)
    || /\b(?:pedido|orden)\b.*\bpromo(?:s|cion(?:es)?)?\b/.test(t)) return false;
  return /[¿?]/.test(t)
    || /^(?:que|cual|hay|tienen)\b/.test(t)
    || /\b(?:quiero|dame)\b.*\bpromo(?:s|cion(?:es)?)?\b/.test(t)
    || /^(?:(?:una|un|alguna|otra)\s+)?promo(?:s|cion(?:es)?)?$/.test(t)
    || /^dime\s+(?:(?:una|un)\s+)?promo(?:s|cion(?:es)?)?$/.test(t)
    || /\b(?:vigente|vigentes|disponible|disponibles)\b/.test(t)
    || /\bpromo(?:s|cion(?:es)?)?\s+(?:de|del)\s+(?:hoy|dia|manana)\b/.test(t);
};

const cuandoDeConsultaDePromociones = (mensaje) => {
  const t = String(mensaje || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\bpasado\s+manana\b/.test(t)) return 'pasado mañana';
  if (/\bmanana\b/.test(t)) return 'mañana';
  if (/\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(t)) return t;
  if (/\bsemana\b/.test(t)) return 'esta semana';
  return 'hoy';
};

export const esAceptacionBreveDePromocion = (mensaje) => {
  const t = String(mensaje || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  return /^(?:si|claro|va|dale|adelante|por favor|me interesa)(?:[.! ]*)$/.test(t);
};

/**
 * Última palabra sobre catering: el texto del modelo nunca puede cotizar ni
 * prometer agenda, aunque la herramienta se haya usado correctamente.
 */
export function prepararEstadoCatering(estado, mensaje, { nombreConfiable = null } = {}) {
  if (estado?.evento && cambiaCateringAPedido(mensaje)) {
    estado.evento = null;
    estado.pendiente = null;
    estado.foco = null;
    return false;
  }
  if (estado?.evento && cancelaSolicitudCatering(mensaje)) {
    estado.evento = null;
    Object.defineProperty(estado, '_eventoCanceladoEsteTurno', {
      value: true, writable: true, configurable: true, enumerable: false,
    });
    return false;
  }
  if (!estado || (!estado.evento && !esSolicitudCatering(mensaje))) return false;
  let evento = eventoCateringVerificado(estado.evento || {}, { nombreConfiable });
  // Esta invalidación ocurre ANTES de consultar al modelo. Si el cliente
  // rechaza una fecha ya capturada y el modelo omite la herramienta, Xabor de
  // todos modos retira el hecho y no puede completar luego con el valor viejo.
  const { invalidados } = filtrarDatosEventoCatering({}, {
    mensaje, eventoPrevio: evento,
  });
  evento = retirarCamposEventoCatering(evento, invalidados);
  estado.evento = evento;
  return true;
}

// Compatibilidad para consumidores que ya importaban el texto desde el
// adaptador. La fuente única vive con el resto de respuestas de catering.
export { TEXTO_CATERING_CANCELADO };

export function consumirCancelacionCatering(estado) {
  if (!estado?._eventoCanceladoEsteTurno) return null;
  delete estado._eventoCanceladoEsteTurno;
  return {
    texto: TEXTO_CATERING_CANCELADO,
    folio: null,
    escalado: false,
    confirmado: false,
    operaciones: [],
    motivoCierre: CIERRE.RESPONDIO,
    cateringCancelado: true,
  };
}

export function bloqueoPrevioDelAgente({
  eventoActivo = false, estadoRestaurante = {}, catalogo = [], estado = null,
  configTienda = null,
} = {}) {
  if (eventoActivo) return null;
  if (!estadoRestaurante.abierto && !puedeContinuarConLocalCerrado(estado, configTienda)) {
    return 'fuera_horario';
  }
  if (!Array.isArray(catalogo) || !catalogo.length) return 'sin_catalogo';
  return null;
}

const camposDeEvento = (evento = {}) => ({
  nombre: evento.nombre,
  numero_personas: evento.personas,
  lugar: evento.lugar,
  fecha_evento: evento.fecha_hora,
});

export function aplicarSalidaSeguraDeCatering(salida, {
  eventoActivo = false, evento = null,
} = {}) {
  if (!salida) return { salida, requiereHandoff: false, motivo: null };
  const op = [...(salida.operaciones || [])].reverse()
    .find((o) => o?.herramienta === 'registrar_solicitud_evento');
  if (!eventoActivo && op?.resultado?.registrado !== true) {
    return { salida, requiereHandoff: false, motivo: null };
  }
  if (op?.resultado?.registrado === true) {
    salida.texto = MENSAJE_CATERING_ENTREGADO;
    salida.escalado = true;
    salida.cateringSeguro = true;
    return { salida, requiereHandoff: false, motivo: 'datos_listos' };
  }
  if (salida.handoffPendiente) {
    // Un cierre técnico ya decidió pausar la conversación y el adaptador hará
    // el último intento de handoff. No lo conviertas en una pregunta de
    // captura: el cliente contestaría a un bot que acaba de quedar pausado.
    salida.cateringSeguro = true;
    return { salida, requiereHandoff: false, motivo: 'handoff_tecnico_pendiente' };
  }
  const ficha = eventoCateringPublico(evento || op?.resultado?.evento || {});
  const pregunta = preguntaSiguienteCatering(camposDeEvento(ficha));
  if (pregunta && !salida.escalado) {
    // La conversación de evento es autoridad, no la prosa del modelo. Aun si
    // ignora la herramienta, cotiza o promete agenda, el cliente solo recibe
    // la siguiente pregunta derivada de los datos verificados.
    salida.texto = pregunta;
    salida.cateringSeguro = true;
    salida.motivoCierre = CIERRE.RESPONDIO;
    return { salida, requiereHandoff: false, motivo: 'captura_incompleta' };
  }

  const prohibida = motivoRespuestaCateringProhibida(salida.texto);
  salida.texto = MENSAJE_CATERING_REVISION;
  salida.escalado = true;
  salida.cateringSeguro = true;
  salida.motivoCierre = CIERRE.ESCALADO;
  // Si ya estaba escalado, el efecto ocurrió dentro del bucle. Si la ficha
  // está completa pero la herramienta no confirmó el handoff, el adaptador
  // debe intentarlo ahora.
  const handoffYaAplicado = salida.operaciones?.some(
    (o) => o?.herramienta === 'pedir_humano' && o?.resultado?.aplicado) === true;
  return {
    salida,
    requiereHandoff: !handoffYaAplicado,
    motivo: prohibida || (pregunta ? 'escalado_durante_captura' : 'evento_completo_sin_registro'),
  };
}

// ── DÓNDE VIVE EL ESTADO ENTRE TURNOS ────────────────────────────────────
//
// En `conversacion_estado`, la tabla que ya usa la sesión durable, con su
// propio espacio de nombres en `session_id`. No hace falta tabla nueva: ya
// tiene revisión, índice por fecha y el barrido de conversaciones viejas.
// Una tabla menos es una migración menos y un sitio menos donde el estado se
// puede quedar a medias.
// Solo una lectura exitosa sin filas significa conversación nueva. Si la base
// falla, atender con un carrito vacío podría duplicar un pedido previo. La
// lectura trae además la REVISIÓN de la fila, que el commit del turno exige
// intacta (ver persistenciaDelTurno.js).
export const leerEstado = (negocioId, telefono, opciones = {}) =>
  leerEstadoVersionado(negocioId, telefono, opciones);

// Escritura directa, sin control de versión. Ya no la usa el turno productivo
// (que escribe con `confirmarTurno`); queda para herramientas y compatibilidad.
export async function guardarEstado(negocioId, telefono, estado, { sombra = false, cliente = null } = {}) {
  const sessionId = claveDeSesion(telefono, { sombra });
  const ejecutor = cliente || pool;
  await ejecutor.query(
    `INSERT INTO conversacion_estado (negocio_id, session_id, estado, revision)
     VALUES ($1,$2,$3::jsonb,1)
     ON CONFLICT (negocio_id, session_id) DO UPDATE
       SET estado = $3::jsonb, revision = conversacion_estado.revision + 1, actualizado_at = NOW()`,
    [negocioId, sessionId, JSON.stringify(estadoSerializable(estado))]);
}

/**
 * EL ACUSE DE UN TRANSPORTE EXTERNO (pruebas, replays): Meta —o quien haga sus
 * veces— aceptó la respuesta con este wamid. La fila del outbox queda
 * entregada y el diálogo, enviado —solo un resumen enviado autoriza a un «sí»
 * a confirmar—. El canal real no usa esto: entrega con `entregarRespuesta`,
 * que reclama la fila antes de enviar (entregaDeRespuestas.js).
 */
export async function registrarRespuestaEnviada(negocioId, telefono, salida, mensaje, wamid) {
  return registrarAceptacionExterna({
    negocioId, telefono, dialogoId: salida?.dialogoId || null, texto: salida?.texto,
    mensaje, wamidSalida: wamid, outboxClave: salida?.outbox?.clave || null,
  });
}

/** Los precios por nombre canónico, como los espera el resumen. */
export function preciosDelCatalogo(catalogo) {
  const fuera = {};
  for (const p of productosVendibles(catalogo)) {
    if (p.precio !== null && p.precio !== undefined) fuera[p.nombre] = Number(p.precio);
  }
  return fuera;
}

/**
 * Convierte la intención temporal del cliente en estado durable ANTES de
 * llamar al modelo. No decide la fecha: solo impide que un «sí» posterior
 * olvide que este pedido necesita una.
 */
export function marcarProgramacionRequerida(estado, mensaje, {
  fechaHoy = null, catalogo = [],
} = {}) {
  if (!estado) return false;
  const programadoAnterior = estado.carrito?.datos?.programado_para || null;
  const referenciaAnterior = referenciaProgramacionSegura(estado.referenciaProgramacion);
  const habiaProgramacion = estado.programacionRequerida === true
    || !!programadoAnterior || !!referenciaAnterior;
  const analisis = analizarReferenciasTemporalesDePedido(mensaje);
  const nuevas = { fecha: analisis.fecha, hora: analisis.hora };
  const hayPedidoEnCurso = (estado.carrito?.items || []).length > 0 || habiaProgramacion;
  const esperaFechaProgramacion = estado.programacionRequerida === true
    && !programadoAnterior
    && !referenciaAnterior?.fechaCliente
    && !referenciaAnterior?.fechaValidada
    && !referenciaAnterior?.isoValidado;
  const textoNormalizado = String(mensaje ?? '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const senalCambioExplicita = /\b(?:mejor|prefiero|cambia(?:lo)?|mueve(?:lo)?|pasalo|dejalo|ponlo)\b/.test(textoNormalizado);
  if (/[¿?]/.test(textoNormalizado)
      && !(habiaProgramacion && senalCambioExplicita)) return false;
  if (esRechazoTersoDeFecha(textoNormalizado)) return false;
  if (esGestionTemporalAjenaAlPedido(textoNormalizado)) return false;
  if (esConsultaDePosibilidadDePedido(textoNormalizado)) return false;
  if (!analisis.fechaNegada
      && esDiaNumericoDesnudoAmbiguo(mensaje, { esperaFechaProgramacion })
      && !analisis.ambiguaFecha
      && (!analisis.fecha
        || /^el\s+(?:[1-9]|[12]\d|3[01])$/.test(analisis.fecha))) return false;
  const detectada = esSolicitudDePedidoProgramado(mensaje, {
    // Una fecha pendiente ya ES un ciclo de pedido aunque todavía no tenga
    // renglones. Así «mañana» y, en el turno siguiente, «a las 10» no se
    // separan cuando el canal productivo no manda historial al modelo.
    hayPedidoEnCurso,
    hayProgramacionPrevia: habiaProgramacion,
    esperaFechaProgramacion,
  });
  const textoLiteral = ` ${String(mensaje ?? '').normalize('NFC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()} `;
  const productoLiteral = productosVendibles(catalogo || []).some((producto) => {
    const nombre = String(producto?.nombre ?? '').normalize('NFC').toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
    return nombre && textoLiteral.includes(` ${nombre} `);
  });
  const mencionaProducto = productoLiteral
    || buscarProductos(catalogo || [], mensaje, { limite: 1 }).length > 0;
  const referenciaAutorizada = autorizaProgramarParaDesdeMensaje(mensaje, {
    hayPedidoEnCurso,
    hayProgramacionPrevia: habiaProgramacion,
    esperaFechaProgramacion,
    mencionaProducto,
  });
  const negacionAutorizada = autorizaNegacionDeProgramacionDesdeMensaje(mensaje, {
    hayProgramacionPrevia: habiaProgramacion,
  });
  const quitaProgramacion = pideQuitarProgramacion(mensaje, {
    hayProgramacionPrevia: habiaProgramacion,
  });

  // Primero se resuelve cuál referencia quedó afirmada. Así «hoy no, mañana»
  // conserva futuro y «mañana, mejor hoy» sí desprograma. `ahora` en «quiero
  // ahora hacer un pedido para mañana» no es destino y no entra aquí.
  if (analisis.objetivoInmediato && referenciaAutorizada) {
    estado.programacionRequerida = false;
    estado.referenciaProgramacion = null;
    if (estado.carrito?.datos) delete estado.carrito.datos.programado_para;
    return false;
  }

  const cancelacionSinDestino = quitaProgramacion
    && !analisis.fecha && !analisis.hora
    && !analisis.fechaNegada && !analisis.horaNegada
    && (/^(?:por\s+favor\s*,?\s*)?ya\s+no\b/.test(textoNormalizado)
      || /^(?:por\s+favor\s*,?\s*)?no\s+(?:(?:lo|la)\s+)?(?:(?:quiero|necesito)\s+)?(?:programar|agendar|reservar)\b/.test(textoNormalizado));
  if (cancelacionSinDestino) {
    // Quitar «mañana» sin afirmar «hoy/ahora» no autoriza a meter el mismo
    // carrito en cocina de inmediato. Se invalida A y se conserva la barrera
    // hasta que el cliente elija otro destino o cancele el pedido completo.
    estado.programacionRequerida = true;
    estado.referenciaProgramacion = null;
    if (estado.carrito?.datos) delete estado.carrito.datos.programado_para;
    return true;
  }

  // El parser detecta correctamente una fecha/hora negada, pero esa señal no
  // basta para tocar la reserva: «no trabajo mañana» y «no tengo cita a las
  // 10» también contienen referencias negadas. Exigimos una frase temporal
  // tersa o contexto explícito de pedido/entrega/producto.
  if (habiaProgramacion && (analisis.fechaNegada || analisis.horaNegada)
      && !negacionAutorizada && !referenciaAutorizada) return false;

  // Una fecha negada no se adopta, pero tampoco convierte la reserva a hoy.
  // Si ya había programación, invalida solo el componente fecha y mantiene
  // la barrera para pedir una alternativa explícita.
  if (analisis.fechaNegada && !analisis.fecha) {
    if (!habiaProgramacion) return false;
    const pendienteBase = fusionarReferenciaProgramacion(
      referenciaAnterior,
      { hora: analisis.hora },
      { isoAnterior: programadoAnterior, fechaAncla: fechaHoy },
    ) || {};
    const pendiente = {
      ...pendienteBase,
      fechaCliente: null, fechaAncla: null, fechaValidada: null, fechaIntentada: null,
      isoValidado: null,
    };
    estado.programacionRequerida = true;
    estado.referenciaProgramacion = referenciaProgramacionSegura(pendiente);
    if (estado.carrito?.datos) delete estado.carrito.datos.programado_para;
    return true;
  }
  // Una hora negada nunca se adopta. Si no coincide con la vigente, se
  // conserva íntegra («no a las 11» con reserva a las 10). Si coincide, se
  // invalida solo la hora y se mantiene la barrera para pedir alternativa.
  // «no, a las 11» lleva coma y ya pasó como autocorrección afirmativa.
  if (analisis.horaNegada && !analisis.hora && !analisis.fecha) {
    if (!habiaProgramacion) return false;
    const horaAnterior = referenciaAnterior?.horaValidada
      || referenciaAnterior?.horaIntentada || null;
    const candidatasNegadas = [...new Set((analisis.horasNegadas || [])
      .flatMap((fragmento) => horasExactasDePedido(
        /^las?\s/.test(fragmento) ? `a ${fragmento}` : fragmento,
      )))];
    const rechazaLaVigente = analisis.rechazoDeHoraNombrada === true
      || !horaAnterior || candidatasNegadas.length === 0
      || candidatasNegadas.includes(horaAnterior);
    if (!rechazaLaVigente) return false;
    const pendiente = referenciaAnterior ? {
      ...referenciaAnterior,
      horaCliente: null, horaValidada: null, horaIntentada: null,
      isoValidado: null,
    } : null;
    estado.programacionRequerida = true;
    estado.referenciaProgramacion = referenciaProgramacionSegura(pendiente);
    if (estado.carrito?.datos) delete estado.carrito.datos.programado_para;
    return true;
  }

  const consultaInformativa = /\b(?:saber|preguntar|consultar|promociones?|horarios?|abren|abre|cierran|cierra|disponibilidad|disponible|hay|tienen|manejan)\b/.test(textoNormalizado)
    || (/[¿?]/.test(textoNormalizado) && !analisis.correccion && !quitaProgramacion);
  const referenciaAmbigua = analisis.ambiguaFecha || analisis.ambiguaHora;
  // Una alternativa también administra una reserva en curso, aunque sea una
  // respuesta tersa. Nunca la resolvemos escogiendo la primera: borramos la
  // programación aplicada y dejamos incompleto el componente dudoso.
  const gestionaTemporal = detectada || referenciaAutorizada
    || (hayPedidoEnCurso && analisis.tieneReferenciaTemporal
      && (analisis.correccion || referenciaAmbigua)
      // El analizador conserva `tieneReferenciaTemporal` aunque el último
      // candidato haya quedado negado. Sin una fecha/hora afirmada no hay
      // nada nuevo que fusionar. Las negaciones ya se resolvieron arriba:
      // ante una reserva vigente invalidan el componente rechazado y dejan
      // la barrera activa; sin reserva no fabrican intención futura.
      && (!!analisis.fecha || !!analisis.hora || referenciaAmbigua)
      && !consultaInformativa)
    // La alternativa prueba intención temporal pero no autoriza una fecha u
    // hora. Se conserva la barrera para preguntar aun en el primer turno.
    || (referenciaAmbigua && !consultaInformativa)
    // En un mismo turno «para hoy no, mejor mañana» ya expresa un destino
    // futuro completo aunque omita repetir «quiero pedir» tras corregirse.
    || (analisis.correccion && !!analisis.fecha && !consultaInformativa);
  if (referenciaAmbigua && gestionaTemporal) {
    let pendiente = fusionarReferenciaProgramacion(
      referenciaAnterior,
      nuevas,
      { isoAnterior: programadoAnterior, fechaAncla: fechaHoy },
    ) || {};
    pendiente = { ...pendiente, isoValidado: null };
    if (analisis.ambiguaFecha) {
      pendiente.fechaCliente = null;
      pendiente.fechaAncla = null;
      pendiente.fechaValidada = null;
      pendiente.fechaIntentada = null;
    }
    if (analisis.ambiguaHora) {
      pendiente.horaCliente = null;
      pendiente.horaValidada = null;
      pendiente.horaIntentada = null;
    }
    estado.programacionRequerida = true;
    estado.referenciaProgramacion = referenciaProgramacionSegura(pendiente);
    if (estado.carrito?.datos) delete estado.carrito.datos.programado_para;
    return true;
  }

  // El detector ancho también sirve como freno del turno: ante cualquier
  // mención temporal dudosa evita que confirmar convierta el pedido en uno de
  // hoy. Pero una referencia exacta solo puede sobrevivir al turno si pasa la
  // misma autoridad que usa `programar_para`. De otro modo una frase ajena
  // («quiero trabajar mañana») podría dejar `fechaCliente=mañana` y una hora
  // tersa del turno siguiente terminaría autorizando lo que hoy se rechazó.
  if (gestionaTemporal && !referenciaAutorizada) return false;

  if (gestionaTemporal) {
    estado.programacionRequerida = true;
    estado.referenciaProgramacion = fusionarReferenciaProgramacion(
      referenciaAnterior,
      nuevas,
      { isoAnterior: programadoAnterior, fechaAncla: fechaHoy },
    );
    // Una corrección puede afirmar una fecha y negar a la vez la hora vigente
    // ("viernes, no a las 10"). La fusión normal conserva componentes no
    // mencionados; aquí la hora sí fue mencionada y rechazada, por lo que no
    // debe revivir desde el turno anterior ni desde un ISO legacy.
    if (negacionAutorizada && analisis.horaNegada && !analisis.hora
        && estado.referenciaProgramacion) {
      const horaAnterior = referenciaAnterior?.horaValidada
        || referenciaAnterior?.horaIntentada || null;
      const candidatasNegadas = [...new Set((analisis.horasNegadas || [])
        .flatMap((fragmento) => horasExactasDePedido(
          /^las?\s/.test(fragmento) ? `a ${fragmento}` : fragmento,
        )))];
      const rechazaLaVigente = analisis.rechazoDeHoraNombrada === true
        || !horaAnterior || candidatasNegadas.length === 0
        || candidatasNegadas.includes(horaAnterior);
      if (rechazaLaVigente) {
        estado.referenciaProgramacion = referenciaProgramacionSegura({
          ...estado.referenciaProgramacion,
          horaCliente: null, horaValidada: null, horaIntentada: null,
          isoValidado: null,
        });
      }
    }
    // Una referencia temporal NUEVA autoriza una interpretación nueva. Sin
    // ella, un rechazo de horario queda ligado al primer par que propuso el
    // modelo y no puede convertirse en otra fecha/hora por iniciativa propia.
    if (estado.referenciaProgramacion) {
      if (nuevas.fecha) delete estado.referenciaProgramacion.fechaIntentada;
      if (nuevas.hora) delete estado.referenciaProgramacion.horaIntentada;
    }
    // Toda mención temporal nueva invalida A, incluso «el sábado a las 11»
    // sin verbos como "cámbialo". No podemos saber por texto si repite A o
    // solicita B; volver a exigir programar_para es el fail-safe: omitir la
    // herramienta registra cero en lugar de confirmar silenciosamente A.
    if (programadoAnterior) delete estado.carrito.datos.programado_para;
    return true;
  }
  // Se evalúa DESPUÉS del reemplazo. «Ya no mañana, mejor el viernes» no es
  // convertir el pedido a inmediato: es sustituir una programación por otra.
  if (quitaProgramacion) {
    estado.programacionRequerida = true;
    estado.referenciaProgramacion = null;
    if (estado.carrito?.datos) delete estado.carrito.datos.programado_para;
    return true;
  }
  return false;
}

/** Solo un pedido inequívocamente futuro puede seguir mientras el local cierra. */
export function puedeContinuarConLocalCerrado(estado, configTienda) {
  if (configTienda?.aceptaProgramados !== true) return false;
  return estado?.programacionRequerida === true
    || !!estado?.carrito?.datos?.programado_para
    || !!referenciaProgramacionSegura(estado?.referenciaProgramacion);
}

/** La orden canónica que espera `registrarPedido`, construida del carrito REAL. */
export function ordenDesdeElCarrito({ negocioId, carrito, telefono, nombre, conversacionId = null }) {
  const datos = carrito?.datos || {};
  const cli = datos.cliente || {};
  return {
    negocioId,
    telefono_conversacion: telefono,
    // La puerta final (`validarOrdenPropuesta`) vuelve a exigir que cada
    // producto esté publicado para WhatsApp: un artículo interno no existe
    // para el registro aunque se colara hasta aquí.
    catalogo_publicado: 'whatsapp',
    // Identidad del registro: una sola confirmación por ciclo de conversación.
    // Viaja dentro del pedido (pedidos_activos.datos) y permite conciliar un
    // registro cuya respuesta se perdió sin crear un segundo folio.
    ...(conversacionId ? { origen_agente: { conversacion_id: String(conversacionId) } } : {}),
    items: (carrito?.items || []).map((i) => ({
      nombre: i.nombre,
      cantidad: Number(i.cantidad) || 1,
      modificadores: (i.modificadores || []).flatMap((g) => (g.opciones || [])
        .map((o) => ({ grupo: g.grupo, opcion: typeof o === 'string' ? o : o?.nombre }))),
      ...(i.notas ? { notas: i.notas } : {}),
    })),
    cliente: {
      nombre: cli.nombre || nombre || null,
      telefono: cli.telefono || telefono || null,
      ...(cli.direccion ? { direccion: cli.direccion } : {}),
      ...(cli.referencias ? { referencias: cli.referencias } : {}),
    },
    modalidad: datos.modalidad || null,
    forma_pago: datos.forma_pago || null,
    // La nota del pedido (dedicatoria o indicaciones) que el cliente escribió
    // en el formulario (contrato nota_v1) y leyó en el resumen. Misma clave que
    // el POS y la tienda (`notas` del pedido); solo si existe, para que una
    // orden sin nota sea la de siempre.
    ...(typeof datos.notas === 'string' && datos.notas.trim() ? { notas: datos.notas.trim() } : {}),
    // El envío que el cliente LEYÓ en el resumen (tarifa base o de la zona que
    // `definir_entrega` validó). Sin él, el registro volvía a la tarifa base y
    // el total registrado no era el mostrado. La puerta final lo acepta solo si
    // es una tarifa configurada del negocio (`calcularCostoEnvio`).
    ...(Number.isFinite(Number(datos.costo_envio)) && datos.costo_envio !== null && datos.costo_envio !== undefined
      ? { costo_envio: Number(datos.costo_envio) } : {}),
    // Lo fija `programar_para`, ya validado contra el horario del negocio.
    // Viaja en la orden para que `confirmarYEmitir` lo convierta en reserva.
    ...(datos.programado_para ? { programado_para: datos.programado_para } : {}),

    // ── P0 INVARIANTE 4: SIN DINERO CONFIRMADO NO HAY COCINA ────────────
    //
    // `enlace_pago` significa que el dinero NO existe todavía: llega después,
    // por un webhook verificado. `registrarPedido` hace nacer el pedido en
    // `pendiente_pago` cuando ve esta bandera (orderManager.js), y
    // `emitirPedido` no emite comanda, impresión ni oferta a repartidores
    // mientras siga ahí. El webhook de Clip lo libera con
    // `confirmarPedidoPendientePago`, y el reconciliador de pagos recoge lo
    // que el webhook no haya cerrado.
    //
    // Sin esta línea el pedido nacía `nuevo`: la comanda salía a cocina en
    // cuanto el cliente decía «sí», ANTES de que existiera el enlace —que
    // `confirmarYEmitir` crea después de emitir— y mucho antes de que nadie
    // pagara. Lo declara esta función porque es la única que sabe con qué va
    // a pagar el cliente; `registrarPedido` solo obedece a la bandera.
    //
    // Solo `enlace_pago`. Efectivo, terminal y pago al recibir son compras
    // reales desde el «sí»: ahí el negocio ya se comprometió, no hay webhook
    // que esperar, y esperarlo sería esperar algo que nunca llega.
    ...(datos.forma_pago === 'enlace_pago' ? { requierePagoAnticipado: true } : {}),
  };
}

/**
 * El adaptador solo puede declarar atendido un turno que no deba un handoff.
 * El texto puede ser seguro, pero no se publica si promete una persona y la
 * pausa durable no quedó confirmada.
 */
export function resultadoDelCanalAgente(salida = null) {
  return { ...(salida || {}), ok: salida?.handoffPendiente !== true };
}

/**
 * La vista canónica del pedido para sellar el estado al final del turno. Es la
 * misma que construye el ejecutor (carta publicada, precios, programación).
 */
function vistaParaSellar(estado, { catalogo, requierePago, metodosPago, modalidades, reglas,
  promocionesActivas, zonaDelNegocio }) {
  return crearEjecutor({
    estado, catalogo, precios: preciosDelCatalogo(catalogo), requierePago, metodosPago, modalidades,
    reglas, promocionesActivas, zonaDelNegocio, mensaje: '', registrarOfrecido: false,
  }).vista();
}

/**
 * EL SELLADO DE LA RESPUESTA. Los post-procesadores del canal (confirmación,
 * pago, entrega, catering, desenlace) pueden cambiar el texto DESPUÉS de que
 * el bucle cerró el turno. Lo que se guarda como diálogo y como pregunta
 * pendiente tiene que ser lo que de verdad sale: si el texto cambió, la
 * pregunta es la que fije el post-procesador (`pendienteFinal`) o ninguna.
 */
export function sellarRespuesta(estado, salida) {
  if (!estado || !salida) return;
  const d = estado.dialogo;
  if (!d || d.id !== salida.dialogoId) return;
  const cambio = d.texto !== salida.texto;
  if (!cambio && salida.pendienteFinal === undefined) return;
  // Una frase informativa añadida AL FINAL (el costo de envío, por ejemplo) no
  // cambia lo que se preguntó: la pregunta pendiente sigue siendo la misma.
  const previo = String(d.texto || '');
  const anexo = String(salida.texto || '').startsWith(previo) ? String(salida.texto).slice(previo.length) : null;
  if (cambio && salida.pendienteFinal === undefined && previo && anexo !== null && !/[?¿]/.test(anexo)) {
    d.texto = salida.texto;
    salida.pendiente = estado.pendiente;
    return;
  }
  const pendiente = salida.pendienteFinal !== undefined ? salida.pendienteFinal : null;
  fijarPendiente(estado, pendiente);
  d.texto = salida.texto;
  d.tipo = pendiente?.tipo === PENDIENTES.CONFIRMAR_RESUMEN ? 'resumen' : (pendiente ? 'pregunta' : 'informacion');
  d.huella = pendiente?.tipo === PENDIENTES.CONFIRMAR_RESUMEN ? pendiente.huella : null;
  d.foco = estado.foco || null;
  if (estado.pendiente) estado.pendiente.dialogo_id = d.id;
  d.pendiente = estado.pendiente ? { ...estado.pendiente } : null;
  salida.pendiente = estado.pendiente;
}

/**
 * El resumen con el total del MOTOR. La vista del turno no conoce las
 * promociones de la tienda (`tienda_promociones`), que el registro sí aplica:
 * el cliente leía «Total: $420» y se registraban $225. Aquí se sustituye la
 * línea del total por las promociones y el total que calcula
 * `previsualizarPedido` —el mismo pipeline que `registrarPedido`—. Puro.
 */
export function resumenConPromociones(texto, preview) {
  const promos = (preview?.promociones || []).filter((p) => Number(p?.descuento) > 0);
  const total = Number(preview?.total);
  if (!promos.length || !Number.isFinite(total)) return null;
  const cierreLegible = /\n\*Total: \$[\d.,]+\*\n¿Confirmas este pedido\?$/;
  if(cierreLegible.test(String(texto || ''))) {
    const descuentos=promos.map(p=>`Promoción ${p.nombre}: -$${Number(p.descuento)}`).join('\n');
    return String(texto).replace(cierreLegible,`\n${descuentos}\n*Total: $${total}*\n¿Confirmas este pedido?`);
  }
  const cierre = /\nTotal: \$[\d.,]+\.\n¿Confirmas este pedido\?$/;
  if (!cierre.test(String(texto || ''))) return null;
  const lineas = promos.map((p) => `Promoción ${p.nombre}: -$${Number(p.descuento)}.`).join('\n');
  return String(texto).replace(cierre, `\n${lineas}\nTotal: $${total}.\n¿Confirmas este pedido?`);
}

/**
 * Si el turno termina en un resumen, su total sale del motor de registro. Lo
 * mostrado queda en el estado LIGADO A LA HUELLA (`totalMostrado`): la
 * confirmación compara contra lo que el cliente leyó, así que una promoción
 * que expira entre el resumen y el «sí» no puede cobrar más de lo mostrado.
 */
async function aplicarTotalDelMotorAlResumen({ salida, estado, negocioId, telefono, nombre, canal, cfg, promociones,
  previsualizar = previsualizarPedido }) {
  const d = estado?.dialogo;
  const p = estado?.pendiente;
  delete estado.totalMostrado;
  if (!d || d.id !== salida?.dialogoId || d.tipo !== 'resumen' || p?.tipo !== PENDIENTES.CONFIRMAR_RESUMEN
    || d.texto !== salida.texto) return;
  try {
    const orden = ordenDesdeElCarrito({ negocioId, carrito: estado.carrito, telefono, nombre,
      conversacionId: estado.conversacionId });
    const previa = await previsualizar(orden, negocioId, { canal });
    if (!previa?.ok) return;
    const ajustado=resumenConPromociones(salida.texto, previa.preview);
    let texto = ajustado || salida.texto;
    const sugerencia=cfg?.whatsapp_promociones_proactivas_v1==='true'
      ? sugerenciaPromocion(previa.orden,promociones,estado,p.huella):null;
    if(sugerencia) {
      // El resumen íntegro y sus botones deben caber sin recortar nada.
      const ampliado=texto.replace(/¿Confirmas este pedido\?$/,`${sugerencia.texto}\n\n¿Confirmas este pedido?`);
      if(ampliado!==texto && ampliado.length<=1024) {
        texto=ampliado;estado.sugerenciasPromocion=[...(estado.sugerenciasPromocion || []),sugerencia.clave].slice(-20);
      }
    }
    salida.texto = texto;
    d.texto = texto;
    if(ajustado)estado.totalMostrado = { huella: p.huella, total: Number(previa.preview.total) };
  } catch (e) {
    // Sin el motor, el resumen conserva el total de la vista (mayor o igual al
    // que se registraría): nunca se muestra menos de lo que se cobra.
    console.error(`[AGENTE] resumen sin total del motor negocio=${negocioId}: ${e?.message}`);
  }
}

/**
 * La transferencia a una persona, ESTRUCTURADA: qué pasó, en qué fase iba el
 * pedido y qué datos ya se recopilaron. Se guarda en el estado (la persona que
 * retoma no parte de cero) y viaja en el outbox dentro del mismo commit.
 */
function registrarTransferencia(estado, { motivo, pedido, faseAntes }) {
  const cliente = estado?.carrito?.datos?.cliente || {};
  estado.handoff = {
    motivo: String(motivo || estado.motivoEscalado || 'sin_motivo').slice(0, 200),
    en: new Date().toISOString(),
    fase_previa: faseAntes || null,
    pedido: {
      lineas: (pedido?.lineas || []).map((l) => ({ producto: l.producto, cantidad: l.cantidad,
        opciones: (l.opciones || []).map((o) => `${o.grupo}: ${o.opcion}`), nota: l.nota || null })),
      modalidad: pedido?.modalidad ?? null,
      forma_pago: pedido?.forma_pago ?? null,
      programado_para: pedido?.programado_para ?? null,
      total: pedido?.total ?? null,
      con_direccion: !!(cliente.direccion || cliente.calle),
      nombre: cliente.nombre || null,
    },
    evento: estado.evento ? eventoCateringPublico(estado.evento) : null,
    pendiente_previo: estado.pendiente ? { tipo: estado.pendiente.tipo } : null,
  };
  return {
    tipo: TIPOS.HANDOFF,
    carga: { ...estado.handoff, pedido: { ...estado.handoff.pedido, nombre: undefined } },
  };
}

// La hora de recepción más temprana del lote (reloj de la base), o null.
async function leerRecepcionDelLote(db, negocioId, wamids) {
  if (!Array.isArray(wamids) || !wamids.length) return null;
  try {
    const { rows: [lote] } = await db.query(
      `SELECT min(recibido_at) AS primero FROM whatsapp_entradas
        WHERE negocio_id = $1 AND wamid = ANY($2::text[])`, [negocioId, wamids.map(String)]);
    return lote?.primero || null;
  } catch (e) {
    console.error(`[AGENTE] no se pudo leer la recepción del lote negocio=${negocioId}: ${e?.message}`);
    return null;
  }
}

/**
 * ATIENDE UN TURNO DE VERDAD.
 *
 * Devuelve `{ ok, texto, folio, escalado, pedido, operaciones, outbox }`. Quien
 * llama —el canal— manda `texto` por WhatsApp y acusa el envío con
 * `registrarRespuestaEnviada` (que marca entregada la respuesta del outbox).
 * Si `ok` es false, el canal debe pausar la conversación y pedir revisión
 * humana. El agente nunca devuelve el mismo turno al bot legacy.
 *
 * `wamids`: los del lote que atiende este turno. Su identidad (`turnoClave`)
 * hace el turno idempotente: un lote ya aplicado devuelve la respuesta que se
 * comprometió, sin volver a ejecutar nada.
 */
export async function atenderConAgente({
  negocioId, telefono, mensaje, nombre = null, canal = 'whatsapp',
  llamarModelo, historial = [], textoCiclo = '', turnoId = null, wamids = [],
  escalarAHumano = null, enviarMenu = null, registrar = registrarPedido, emitir = emitirPedido,
  guardar = guardarPedido, crearPago = crearEnlacePago, traza = null, db = pool,
  intentoPorConflicto = 1,
  interaccion = null, pedidoCatalogo = false, servicioSolicitado = null,
} = {}) {
  const t0 = Date.now();
  const turnoClave = claveDeTurno({ wamids, turnoId });
  let estado = null;
  let salida = null;
  let confirmacionIntentada = false;
  let reservaBotones = null;
  let solicitudServicio = null;
  const eventosDelTurno = [];
  const argumentosDelTurno = {
    negocioId, telefono, mensaje, nombre, canal, llamarModelo, historial, textoCiclo, turnoId, wamids,
    escalarAHumano, enviarMenu, registrar, emitir, guardar, crearPago, traza, db, interaccion, pedidoCatalogo, servicioSolicitado,
  };
  try {
    const [catalogoAgente, cfg, metodosPago, reglas, configTienda, recepcionDelLote] = await Promise.all([
      obtenerCatalogoDelAgente(negocioId),
      obtenerConfiguracion(negocioId).catch(() => ({})),
      obtenerMetodosPagoDisponibles(negocioId, { paraBot: true }),
      cargarReglas(negocioId),
      obtenerConfigTienda(negocioId).catch((e) => {
        console.error(`[AGENTE] no se pudo resolver la política de programados: ${e?.message}`);
        return null;
      }),
      // Cuándo se RECIBIÓ el mensaje más temprano de este lote (reloj de la
      // base): una respuesta escrita antes de que llegara la pregunta
      // pendiente no la contesta (ver `escritoAntesDelAcuse`). Solo informa;
      // si no se puede leer, no se bloquea ni se inventa. Se lee ANTES que el
      // estado para no alargar la ventana entre leerlo y comprometerlo.
      leerRecepcionDelLote(db, negocioId, wamids),
    ]);
    if(pedidoCatalogo && (interaccion || mensaje || !catalogoNativoActivo(cfg,telefono)
      || !(await barrerasDeBotones(db,negocioId,telefono)).activo))return {ok:true,sinRespuesta:true};
    // La carta del agente es la PUBLICADA para WhatsApp. Lo oculto no existe
    // para el prompt, la búsqueda, las herramientas ni las promociones.
    const catalogo = Array.isArray(catalogoAgente?.carta) ? catalogoAgente.carta : [];
    const nombresOcultos = catalogoAgente?.nombresOcultos || [];
    const estadoRestaurante = obtenerEstadoRestaurante(reglas);
    // Lecturas independientes del mismo turno; no caché compartida entre
    // clientes ni reglas de precio antiguas. Mutaciones permanecen seriales.
    const [estadoAnterior,promocionesInformativas] = await Promise.all([
      leerEstadoVersionado(negocioId, telefono, { db }),
      cargarPromocionesInformativas(negocioId, canal, reglas?.timezone),
    ]);
    const lecturasMs=Date.now()-t0;
    if (estadoAnterior.botonesReserva) {
      await conciliarReservaBotones(db, negocioId, estadoAnterior);
      const entregado = await avisarAHumano(escalarAHumano, negocioId, telefono, 'AGENTE_ESTADO_INCIERTO');
      return { ok: entregado, sinRespuesta: true, handoffPendiente: !entregado, motivo: 'boton_reserva_incierta' };
    }

    // ── UN LOTE YA APLICADO NO SE VUELVE A EJECUTAR ──────────────────────
    if ((estadoAnterior.turnosAplicados || []).includes(turnoClave)) {
      const previa = await respuestaDeTurnoAplicado({ negocioId, telefono, turnoClave, db }).catch(() => null);
      console.log(`[AGENTE] evento=turno_repetido negocio=${negocioId} tel=${telefonoCorto(telefono)} `
        + `entregado=${previa?.estado === 'entregado'}`);
      return {
        ok: true, repetido: true, yaEntregado: previa?.estado === 'entregado',
        texto: previa?.texto || null, dialogoId: previa?.dialogo_id || null,
        outbox: previa ? { clave: previa.clave } : null,
        folio: estadoAnterior.folio ?? null, escalado: !!estadoAnterior.hechos?.escalado,
        confirmado: !!estadoAnterior.hechos?.confirmado,
        motivoCierre: CIERRE.RESPONDIO, operaciones: [],
      };
    }

    // ── SIN CARTA PUBLICADA NO HAY TURNO ─────────────────────────────────
    // Antes que CUALQUIER atajo (catering, consulta de promociones, horario):
    // sin carta no se habla de productos ni de promociones, y el menú
    // operativo no es un respaldo. Una carta ilegible cuenta como vacía. El
    // canal pasa la conversación a una persona (whatsapp-meta.js ya lo decide
    // antes de llamar aquí; esta es la misma regla para cualquier llamador).
    if (!catalogo.length || catalogoAgente?.error) {
      console.error(`[AGENTE] ALERTA sin_catalogo negocio=${negocioId}: la carta de WhatsApp `
        + `${catalogoAgente?.error ? `no se pudo leer (${catalogoAgente.error})` : 'está vacía'}`);
      return { ok: false, motivo: 'sin_catalogo' };
    }

    const faseAntes = estadoAnterior.fase || null;
    const versionAntes = estadoAnterior._revision ?? null;
    const pendienteAntes = estadoAnterior.pendiente ? { ...estadoAnterior.pendiente } : null;
    // Los toques no abren ciclo, pero un flujo de servicio vencido tampoco
    // debe tragárselos (la ficha de evento silencia todos los botones).
    const opcionesCiclo = { zona: reglas?.timezone, flujosCaducan: cfg?.whatsapp_flujos_caducan_v1 === 'true' };
    estado = pedidoCatalogo || (interaccion && !interaccion.mixto)
      ? (opcionesCiclo.flujosCaducan
        ? heredarIdentidad(limpiarFlujoVencido(estadoAnterior, opcionesCiclo), estadoAnterior) : estadoAnterior)
      : heredarIdentidad(cicloParaTurno(estadoAnterior, mensaje, opcionesCiclo), estadoAnterior);
    normalizarEstado(estado);
    fijarRecepcionDelTurno(estado, recepcionDelLote);
    if (estado.conversacionId !== estadoAnterior.conversacionId) {
      historial = [];
      textoCiclo = mensaje;
    }
    const eventoActivo = prepararEstadoCatering(estado, mensaje, { nombreConfiable: nombre });
    const cancelacionCatering = consumirCancelacionCatering(estado);

    const modalidades = Array.isArray(reglas?.pedidos?.modalidades) && reglas.pedidos.modalidades.length
      ? reglas.pedidos.modalidades : ['recoger en tienda', 'entrega a domicilio'];
    const promocionesActivas = estadoRestaurante.promocionesActivas || [];
    const requierePago = String(cfg?.pedido_requiere_pago ?? 'true').toLowerCase() !== 'false';
    const libro = libroDeOperaciones(almacenTransaccional(db, { esExterna: esEfectoExterno }));
    const contextoVista = { catalogo, requierePago, metodosPago, modalidades, reglas, promocionesActivas,
      zonaDelNegocio: reglas?.timezone };
    // reglas: las zonas de envío para la pantalla de dirección (contrato direccion_v1).
    const contextoElecciones = {estado,catalogo,modalidades,metodosPago,cfg,reglas,promociones:promocionesInformativas};
    const consultaHibrida = !interaccion && betaHibridaActiva(cfg,telefono) && consultaInformativaHibrida(mensaje);

    // ── EL COMMIT DEL TURNO ─────────────────────────────────────────────
    // Estado (con control de versión) + operaciones internas + respuesta en
    // el outbox + traza, en UNA transacción. Ver persistenciaDelTurno.js.
    const comprometer = async (s) => {
      // La respuesta a una duda tiene prioridad sobre la siguiente pregunta
      // comercial. Un botón de continuación NO es una confirmación.
      const protegerConsulta = s.respuestaDeSistema==='consulta_foto' || (consultaHibrida && !s.respuestaDeSistema);
      const continuarConsulta = protegerConsulta && s.respuestaDeSistema!=='consulta_foto' && !s.handoffPendiente
        && !s.fueraHorario && borradorRetomable(estado);
      // Una pregunta interactiva que nacería vieja no se manda: si el cliente
      // ya escribió otra cosa, el turno que lo atienda publicará la suya (ver
      // mensajesEnEspera.js). Sale el texto de este turno, completo y sin
      // depender de una lista. Las respuestas de sistema conservan su
      // formulario: sin él su texto no se entiende. La dirección capturada sin
      // el modelo no: es la respuesta a un texto libre, como la del modelo.
      const preguntaVieja = !interaccion && (!s.respuestaDeSistema || RESPUESTAS_DE_DIRECCION.includes(s.respuestaDeSistema))
        && await hayMensajesEnEspera(db, { negocioId, telefono, wamids });
      if (continuarConsulta) {
        fijarPendiente(estado,{tipo:PENDIENTES.EDITAR_PEDIDO},{dialogoId:estado.dialogo.id,avance:true});
        estado.dialogo.pendiente={...estado.pendiente};
        estado.dialogo.tipo='informacion';estado.dialogo.huella=null;
      }
      // Sin carrito y sin poder usar la respuesta: el formulario de pedido (ver
      // `pedidoSinArmar` en experienciaHibrida.js).
      const abrirPedido = pedidoSinArmar({ salida: s, interaccion, protegerConsulta, preguntaVieja, estado,
        formulariosActivos: flowsActivos(cfg,telefono) });
      if (abrirPedido) {
        fijarPendiente(estado,{tipo:PENDIENTES.AGREGAR_OTRO},{dialogoId:estado.dialogo.id});
        estado.dialogo.pendiente={...estado.pendiente};
        estado.dialogo.tipo='pregunta';
      }
      // Un mensaje a mitad de «Arma tu pedido», con el carrito aún vacío: la
      // respuesta sale completa y trae «Continuar pedido»; el formulario retoma
      // lo que el cliente ya eligió. Prueba del dueño, 1-oct: dos platillos se
      // quedaron atrás por salir a preguntar qué era el enlace de pago, y su
      // «Si» siguiente recibió un «¿qué se te antoja?» sin camino de vuelta.
      let retomarFormulario = false;
      const turnoSinPregunta = protegerConsulta ? s.respuestaDeSistema!=='consulta_foto'
        : !interaccion && !s.respuestaDeSistema && !estado.pendiente;
      if (turnoSinPregunta && !continuarConsulta && !s.handoffPendiente && !s.escalado
        && !s.fueraHorario && !preguntaVieja && !estado.carrito?.items?.length && betaHibridaActiva(cfg,telefono)
        && flowsActivos(cfg,telefono) && interactivosActivos(cfg) && eleccionesActivas(cfg)
        && !estado.folio && !estado.evento && !estado.confirmacionIncierta
        && !Object.values(estado.hechos || {}).some(Boolean)) {
        const antes = { pendiente: estado.pendiente, foco: estado.foco };
        fijarPendiente(estado,{tipo:PENDIENTES.AGREGAR_OTRO},{dialogoId:estado.dialogo.id,avance:true});
        const tentativo = construirFormulario({...contextoElecciones,pedido:vistaParaSellar(estado, contextoVista),texto:s?.texto,cfg,telefono});
        const previo = tentativo ? await borradorCompatible(db,{preparado:tentativo,negocioId,sessionId:`agente:${telefono}`})
          .catch(() => null) : null;
        if (previo?.contenido?.items?.length) {
          retomarFormulario = true;
          estado.dialogo.pendiente={...estado.pendiente};
          estado.dialogo.tipo='informacion';estado.dialogo.huella=null;
        } else {
          estado.pendiente = antes.pendiente; estado.foco = antes.foco;
        }
      }
      if (!protegerConsulta && interactivosActivos(cfg) && eleccionesActivas(cfg) && estado.pendiente
        && !estado.folio && !Object.values(estado.hechos || {}).some(Boolean)) {
        abrirGrupoDePregunta(estado,catalogo);
        const opciones = opcionesInteractivas(contextoElecciones);
        if (opciones.length) {
          const aviso = s.respuestaDeSistema === 'boton_desactualizado'
            ? reservaBotones?.motivo === 'decisiones_distintas'
              ? 'Recibí varias decisiones distintas juntas. No apliqué esos toques. Elige una opción para continuar.\n'
              : 'Ese botón ya no está vigente. No apliqué ese toque. Revisa la información actual.\n'
            : s.avisoEleccion || '';
          let textoElecciones = textoDeElecciones(estado,catalogo,opciones,s.texto,{compacto:!preguntaVieja && opciones.length <= 10});
          if ((aviso + textoElecciones).length > 1024)
            textoElecciones = textoDeElecciones(estado,catalogo,opciones,s.texto);
          // El formato de la lista nunca debe borrar el aviso de un toque
          // rechazado o de una selección textual que no pudo aplicarse.
          s.texto = textoElecciones === s.texto ? s.texto : aviso + textoElecciones;
          estado.dialogo.texto = s.texto;
        }
      }
      const pedidoActual = vistaParaSellar(estado, contextoVista);
      const avisoFlow=s.respuestaDeSistema==='boton_desactualizado'
        ? 'No apliqué esa respuesta: el formulario cambió, venció o contiene opciones inválidas. Revisa el formulario actual.\n'
        : abrirPedido ? AVISO_PEDIDO_SIN_ARMAR
        // El proveedor falló y el mensaje no se aplicó: el formulario lo dice
        // en vez de taparlo (incidente 1-oct: una dirección se perdió callada).
        : s.recuperacion==='fallo_proveedor_sin_efectos' ? AVISO_MENSAJE_SIN_APLICAR : '';
      let formulario=!s.fueraHorario && !preguntaVieja && (!protegerConsulta || continuarConsulta || retomarFormulario)
        && interactivosActivos(cfg) && eleccionesActivas(cfg)
        ? construirFormulario({...contextoElecciones,pedido:pedidoActual,texto:s?.texto,cfg,telefono,aviso:avisoFlow}) : null;
      if (formulario && (continuarConsulta || retomarFormulario)) {
        const cuerpo=textoConsultaConCarrito(s.texto);
        if (!cuerpo) formulario=null;
        else {
          formulario.texto=cuerpo;formulario.carga.body.text=cuerpo;
          formulario.carga.action.parameters.flow_cta='Continuar pedido';
          formulario.textoFallback=s.texto+'\n\nPara retomar tu pedido guardado, escribe «seguir pedido».';
        }
      }
      if(formulario) {
        formulario.retomarBorrador=betaHibridaActiva(cfg,telefono)
          && (continuarConsulta || retomarFormulario || s.respuestaDeSistema==='retomar_pedido'
            // Lo elegido en «Arma tu pedido» sigue al cliente: cualquier
            // formulario de pedido nuevo retoma su borrador compatible.
            || formulario.botones[0]?.accion==='flow_productos'
            // «Tu carrito» reenviado tras un texto conserva lo editado en el
            // anterior; borradorCompatible exige el mismo carrito y la misma foto.
            || formulario.botones[0]?.datos?.version==='carrito_v1');
        s.texto=formulario.texto;
        estado.dialogo.texto=s.texto;
        if(formulario.botones[0].accion==='flow_configurar') {
          fijarPendiente(estado,{tipo:['edicion_v1','carrito_v1'].includes(formulario.botones[0].datos.version)
            ? PENDIENTES.EDITAR_PEDIDO : PENDIENTES.CONFIGURAR_PEDIDO},{dialogoId:estado.dialogo.id,avance:!!s.operaciones?.length});
          estado.dialogo.pendiente={...estado.pendiente};
          estado.dialogo.tipo='pregunta';
          estado.dialogo.foco=null;
        }
      }
      // Se compone al final de las vistas para que ni la lista ni el Flow
      // borren la respuesta. El carrito sigue saliendo de su vista canónica.
      const complemento = !interaccion && betaHibridaActiva(cfg,telefono)
        && !s.fueraHorario && !s.escalado && !s.handoffPendiente && !estado.evento
        && !estado.confirmacionIncierta && !Object.values(estado.hechos || {}).some(Boolean)
        ? informacionDeConsultaMixta({mensaje,reglas,cfg,estadoRestaurante,modalidades}) : '';
      if (complemento && !respuestaProhibidaEncontrada(complemento,reglas)) {
        s.texto = `${complemento}\n\n${s.texto}`;
        estado.dialogo.texto = s.texto;
        if (formulario && s.texto.length <= 1024) {
          formulario.texto = s.texto;
          formulario.carga.body.text = s.texto;
          formulario.textoFallback = `${complemento}\n\n${formulario.textoFallback}`;
        } else formulario = null; // No truncar precios ni la consulta para caber.
      }
      const r = await confirmarTurno({
        db, negocioId, telefono, estado, pedido: pedidoActual,
        botones: preguntaVieja ? null : (!protegerConsulta && interactivosActivos(cfg) && eleccionesActivas(cfg)
          ? construirInicioMapo({estado,pedido:pedidoActual,texto:s.texto,cfg}) : null)
          || formulario || (!protegerConsulta ? construirBotones({ ...contextoElecciones, pedido: pedidoActual, texto: s?.texto, cfg }) : null), reservaBotones,
        solicitudServicio,
        turnoClave, wamids, libro, eventos: eventosDelTurno, salida: s,
        respuesta: s?.texto ? { texto: s.texto, dialogoId: s.dialogoId || null,
          ...(solicitudServicio ? {} : pedidoCatalogo ? {beta:'catalogo'} : betaHibridaActiva(cfg,telefono) ? {beta:'hibrida'} : {}) } : null,
        faseAntes, versionAntes, pendienteAntes,
        latencias: { total_ms: Date.now() - t0, lecturas_ms:lecturasMs, modelo_llamadas: s?.llamadasAlModelo ?? 0,
          modelo_ms:s?.modeloMs ?? null,herramientas_ms:s?.herramientasMs ?? null,modelo_intentos:s?.modeloIntentos ?? null,
          iteraciones: s?.iteraciones ?? 0, turno_ms: s?.duracionMs ?? null },
      });
      return { ...s, outbox: r.outboxClaves.length ? { clave: r.outboxClaves[0] } : null, version: r.version };
    };

    const baseDelTurno = {
      negocioId,
      conversacionId: estado.conversacionId,
      turnoId: turnoClave,
      mensaje,
      consultaInformativa:consultaHibrida,
      historial,
      catalogo,
      precios: preciosDelCatalogo(catalogo),
      requierePago,
      metodosPago,
      modalidades,
      reglas,
      configTienda,
      promocionesActivas,
      zonaDelNegocio: reglas?.timezone,
      estado,
      libro,
      llamarModelo,
      nombreDelCanal: nombre,
      nombresOcultos,
      promocionesVigentesIds: Array.isArray(promocionesInformativas)
        ? new Set(promocionesInformativas.map((p) => String(p.id))) : null,
      modo: 'productivo',
      traza,
    };

    if (interaccion) {
      reservaBotones = await reservarBotones({ ...contextoElecciones, db, negocioId, telefono,
        pedido: vistaParaSellar(estado, contextoVista), mensajes: interaccion.mensajes,
        mixto: interaccion.mixto, turnoClave });
      if (reservaBotones.retenerBotones) return { ok: true, retenerBotones: true };
      if (reservaBotones.ignorar) {
        reservaBotones = null;
        if (!interaccion.mixto) return { ok: true, sinRespuesta: true };
      }
    }

    // Inicio y captura de servicios no son una venta: también se pueden
    // solicitar fuera de horario. Ordenar conserva el bloqueo de horario
    // que está abajo. Los valores del formulario nunca llegan al modelo.
    if(servicioSolicitado && (!(await barrerasDeBotones(db,negocioId,telefono)).activo
      || servicioSolicitado.servicio!=='facturacion'
      || !formularioFiscalDisponible({cfg,estado,telefono})))return {ok:false,motivo:'formulario_fiscal_no_disponible'};
    const opcionMapo=respuestaOpcionMapo(servicioSolicitado
      ? {accion:'menu_mapo',datos:{valor:'facturacion'}} : reservaBotones);
    if(opcionMapo && servicioSolicitado?.ayuda) {
      const ayuda=servicioSolicitado.ayuda==='archivo'?AYUDA_ARCHIVO_FISCAL:AYUDA_FOLIO;
      opcionMapo.texto=ayuda+'\n\n'+opcionMapo.texto;
    }
    const abrirMapo=!interaccion ? entradaMapo({cfg,estado,mensaje,zona:reglas?.timezone,
      nombreNegocio:cfg?.nombre || cfg?.nombre_negocio || reglas?.restaurante}) : null;
    const captura=ACCIONES_SERVICIO.includes(reservaBotones?.accion)
      ? validarServicio(reservaBotones.accion,reservaBotones.respuestaFlow) : null;
    const aPersona=reservaBotones?.accion==='menu_mapo' && reservaBotones.datos?.valor==='humano';
    // Un toque vencido solo reabre lo de Mapo si lo tocado ERA de Mapo. El
    // 2-oct «Cambiar algo» de un resumen viejo reenvió el Flow de factura:
    // esto miraba el pendiente y nunca qué botón tocó el cliente. Con otro
    // botón vencido sigue la ruta general (aviso + su pedido actual).
    const tocados=reservaBotones?.accionesBoton || [];
    const claseTocada=tocados.length && tocados.every(a=>a==='menu_mapo') ? 'menu'
      : tocados.length && tocados.every(a=>ACCIONES_SERVICIO.includes(a)) ? 'servicio' : null;
    const pendienteMapo=estado.pendiente?.tipo;
    const menuDeNuevo=pendienteMapo==='inicio_mapo'
      || (pendienteMapo==='formulario_servicio' && claseTocada==='menu' && !estado.carrito?.items?.length);
    const servicioDeNuevo=pendienteMapo==='formulario_servicio' && claseTocada==='servicio'
      && flowsActivos(cfg,telefono);
    const reintentoMapo=interaccion && !interaccion.mixto && reservaBotones?.accion==='aviso'
      && (menuDeNuevo || servicioDeNuevo)
      ? {tipo:'mapo_reintento',sinSaludo:true,acciones:[],
        pendiente:pendienteMapo==='inicio_mapo' || servicioDeNuevo ? estado.pendiente : {tipo:'inicio_mapo'},
        texto:menuDeNuevo
          ? 'Ese menú cambió. Elige de nuevo cómo podemos ayudarte.'
          : 'No pude guardar esa respuesta. Abre este formulario actualizado y revisa los datos antes de enviarlo.'} : null;
    if (abrirMapo || opcionMapo?.tipo==='mapo_servicio' || captura || aPersona || reintentoMapo) {
      if (captura || aPersona) {
        solicitudServicio={id:randomUUID(),...(captura || {servicio:'humano',datos:{}})};
        estado.hechos.escalado=true;
        estado.motivoEscalado=motivoServicio(solicitudServicio.servicio);
        estado.solicitudServicioId=solicitudServicio.id;
        reservaBotones.formularioAplicado=!!captura;
      }
      salida=await atenderTurnoConHerramientas({...baseDelTurno,respuestaDeSistema:solicitudServicio
        ? {tipo:'servicio_recibido',texto:textoReciboServicio(solicitudServicio.servicio),acciones:[],sinSaludo:true,pendiente:null}
        : abrirMapo || opcionMapo || reintentoMapo});
      const resultado=await comprometer(salida);
      if(solicitudServicio) await avisarAHumano(escalarAHumano,negocioId,telefono,motivoServicio(solicitudServicio.servicio));
      return resultadoDelCanalAgente({ok:true,...resultado});
    }

    if(!interaccion && consultaFotografiaAmbigua(mensaje)) {
      salida=await atenderTurnoConHerramientas({...baseDelTurno,respuestaDeSistema:{
        tipo:'consulta_foto',sinSaludo:true,acciones:[],pendiente:null,
        texto:'Claro, ¿de qué necesitas la foto: del menú, de un platillo o de otra cosa?'}});
      return resultadoDelCanalAgente({ok:true,...(await comprometer(salida))});
    }

    // Cancelar la ficha de catering termina el turno ANTES del modelo: «ya no
    // quiero catering» jamás puede vaciar el carrito que exista debajo.
    if (cancelacionCatering) {
      salida = await atenderTurnoConHerramientas({ ...baseDelTurno,
        respuestaDeSistema: { texto: cancelacionCatering.texto, acciones: [], tipo: 'catering_cancelado', sinSaludo: true } });
      salida.cateringCancelado = true;
      return resultadoDelCanalAgente({ ok: true, ...(await comprometer(salida)) });
    }

    // ── CONSULTA DE PROMOCIONES: la contesta Xabor con sus datos ─────────
    //
    // Nunca cae al modelo: el modelo no es la fuente oficial de promociones.
    // La respuesta es el texto oficial; si hay UNA promoción vigente AHORA con
    // UN participante publicado, la acción de sistema `ofrecer_promocion` la
    // valida y deja la pregunta pendiente estructurada (qué promoción, qué
    // producto, cuántas unidades según su tipo). Aceptarla con un «sí» agrega
    // ese producto por el mismo ejecutor y reconciliador que todo lo demás.
    if (esConsultaDePromociones(mensaje)) {
      let texto = null;
      let estructuradas = [];
      let fallo = null;
      try {
        const consulta = await consultarPromocionesParaAgente(
          negocioId, cuandoDeConsultaDePromociones(mensaje),
          { canal, timezone: reglas?.timezone, soloPublicadosWhatsapp: true },
        );
        texto = consulta.texto;
        estructuradas = consulta.promociones || [];
        if (!texto && canal !== 'whatsapp') {
          const respaldo = await consultarPromocionesParaAgente(
            negocioId, cuandoDeConsultaDePromociones(mensaje),
            { canal: 'whatsapp', timezone: reglas?.timezone, soloPublicadosWhatsapp: true },
          );
          texto = respaldo.texto;
          estructuradas = respaldo.promociones || [];
        }
      } catch (e) {
        fallo = e;
        console.error(`[AGENTE] no se pudo responder consulta de promociones negocio=${negocioId}:`, e?.message);
      }
      // Una consulta cuyo dato oficial no se pudo leer no entra al modelo: el
      // modelo podría rellenar el hueco con la negativa falsa que este atajo
      // existe para impedir.
      const textoFinal = texto
        || 'No pude verificar las promociones en este momento. Si gustas, vuelve a preguntarme en un momento y lo reviso con el equipo.';
      const acciones = texto && estructuradas.length === 1
        ? [{ herramienta: 'ofrecer_promocion', argumentos: { promocion_id: String(estructuradas[0].id) },
          motivo: 'oferta_de_la_consulta_oficial' }]
        : [];
      salida = await atenderTurnoConHerramientas({ ...baseDelTurno, promocionesVerificadas: estructuradas,
        respuestaDeSistema: { texto: textoFinal, acciones, tipo: 'consulta_promociones', sinSaludo: true } });
      if (!texto) salida[fallo ? 'consultaPromosError' : 'consultaPromosSinResultado'] = true;
      return resultadoDelCanalAgente({ ok: true, ...(await comprometer(salida)) });
    }

    if (!eventoActivo) marcarProgramacionRequerida(estado, mensaje, {
      fechaHoy: estadoRestaurante.fechaHoy, catalogo,
    });
    const bloqueoPrevio = bloqueoPrevioDelAgente({
      eventoActivo, estadoRestaurante, catalogo, estado, configTienda,
    });

    // Cerrado sigue siendo un corte duro para pedidos inmediatos. La única
    // excepción es un ciclo que ya está identificado como futuro Y un negocio
    // que habilitó programados: ese sí necesita llegar al modelo para fijar la
    // fecha y armar el pedido que el scheduler imprimirá después.
    if (bloqueoPrevio === 'fuera_horario') {
      const texto = construirAvisoFueraDeHorario({ estadoRestaurante, reglas, configTienda });
      salida = await atenderTurnoConHerramientas({ ...baseDelTurno,
        respuestaDeSistema: { texto, acciones: [], tipo: 'fuera_horario', sinSaludo: true } });
      salida.fueraHorario = true;
      return resultadoDelCanalAgente({ ok: true, ...(await comprometer(salida)) });
    }
    if (bloqueoPrevio === 'sin_catalogo') {
      // Sin carta publicada no hay nada que el agente pueda hacer sin inventar.
      console.error(`[AGENTE] ALERTA sin_catalogo negocio=${negocioId}: la carta de WhatsApp está vacía`);
      return { ok: false, motivo: 'sin_catalogo' };
    }

    // ── EL DESVÍO DE PEDIDOS PROGRAMADOS SE RETIRÓ ─────────────────────
    //
    // El freno está en el paso irreversible: `confirmarYEmitir` se niega a
    // registrar si el cliente pidió otro día y no hay fecha fijada, así que
    // un modelo que se olvide de `programar_para` no puede meter en cocina un
    // pedido de mañana.
    const modalidadDescartada = depurarModalidadNoDisponible(estado, modalidades);
    const pagoDescartado = depurarPagoNoDisponible(estado, metodosPago);

    const efectos = {
      confirmar: async ({ pedido }) => {
        confirmacionIntentada = true;
        return confirmarYEmitir({
          negocioId, telefono, nombre, canal, estado, pedido, registrar, emitir, guardar, crearPago,
          previsualizar: previsualizarPedido,
          textoDelCiclo: textoCiclo || mensaje,
          totalExacto: reservaBotones?.accion === 'confirmar' ? reservaBotones.total : null,
        });
      },
      // Una confirmación anterior de ESTA conversación quedó sin desenlace:
      // se busca el pedido por su identidad antes de congelar nada.
      conciliarConfirmacion: async () => {
        const existente = await buscarPedidoDelAgente({ negocioId, conversacionId: estado.conversacionId, db });
        return existente ? { ok: true, folio: existente.id, total: existente.total ?? null } : { ok: false };
      },
      // El `ok` que sale de aquí es lo que hace que `pedir_humano` cuente como
      // aplicado. Si se diera por bueno sin comprobarlo, el agente creería
      // haber pasado la conversación a una persona que nunca fue llamada.
      escalar: async () => (
        await avisarAHumano(escalarAHumano, negocioId, telefono, 'AGENTE_PIDE_HUMANO')
          ? { ok: true }
          : { ok: false, motivo: escalarAHumano ? 'handoff_no_entregado' : 'handoff_sin_destino' }),

      // ── EL MENÚ ────────────────────────────────────────────────────────
      //
      // Lo manda el módulo que ya existe y que además VERIFICA el envío.
      enviarMenu: async () => {
        if (!enviarMenu) return { ok: false, motivo: 'sin_canal' };
        try {
          return resultadoDelEnvioDeMenu(await enviarMenu(negocioId, telefono));
        } catch (e) {
          return { ok: false, motivo: e?.message || 'error' };
        }
      },

      // ── UNA SOLICITUD DE EVENTO ────────────────────────────────────────
      //
      // La conversación pasa a revisión humana (aparece en el panel HOY) y el
      // evento queda en el outbox DENTRO del commit del turno: registro
      // durable aunque nadie mire el chat a tiempo. No se cotiza ni se agenda.
      registrarEvento: async ({ evento }) => {
        const entregado = await avisarAHumano(escalarAHumano, negocioId, telefono, 'SOLICITUD_EVENTO');
        eventosDelTurno.push({ tipo: TIPOS.SOLICITUD_EVENTO,
          carga: { ...evento, telefono: telefonoCorto(telefono), canal } });
        console.log(`[AGENTE] evento=solicitud_evento negocio=${negocioId} `
          + `tipo=${evento.tipo_servicio} personas=${evento.personas ?? '-'} handoff=${entregado}`);
        return entregado
          ? { ok: true }
          : { ok: false, motivo: escalarAHumano ? 'handoff_no_entregado' : 'handoff_sin_destino' };
      },
    };

    if(pedidoCatalogo) {
      if(!catalogoNativoActivo(cfg,telefono) || !(await barrerasDeBotones(db,negocioId,telefono)).activo)
        return {ok:true,sinRespuesta:true};
      // Solo datos que ingresaron por el webhook firmado y quedaron en SQL;
      // nunca acepta una selección comercial pasada como texto/argumento.
      const {rows}=await db.query(`SELECT payload->'message' AS mensaje FROM whatsapp_entradas
        WHERE negocio_id=$1 AND telefono=$2 AND wamid=ANY($3::text[]) ORDER BY id`,[negocioId,telefono,wamids]);
      const recibidos=rows.length===new Set(wamids).size && wamids.length ? rows.map(r=>r.mensaje) : [];
      const aplicada=await aplicarCarritoNativo({...contextoElecciones,...contextoVista,estado,cfg,telefono,mensajes:recibidos});
      salida=await atenderTurnoConHerramientas({...baseDelTurno,efectos,
        respuestaDeSistema:aplicada.ok
          ? {tipo:'catalogo_nativo_aplicado',desdePedido:true,sinSaludo:true,acciones:[]}
          : {tipo:'catalogo_nativo_rechazado',texto:aplicada.texto,acciones:[],sinSaludo:true,pendiente:null}});
      if(aplicada.ok)salida.operaciones=[...aplicada.operaciones,...(salida.operaciones || [])];
      await aplicarTotalDelMotorAlResumen({salida,estado,negocioId,telefono,nombre,canal,cfg,promociones:promocionesInformativas});
      sellarRespuesta(estado,salida);
      return resultadoDelCanalAgente({ok:true,...(await comprometer(salida))});
    }

    let formularioAplicado=null;
    if(ACCIONES_FLOW.includes(reservaBotones?.accion)) {
      formularioAplicado=await aplicarFormulario(reservaBotones,{...contextoElecciones,...contextoVista,estado});
      reservaBotones.formularioAplicado=formularioAplicado.ok===true;
      if(!formularioAplicado.ok)reservaBotones.accion='aviso';
    }
    // Texto del cliente: retomar el pedido, la dirección que se le pidió (sin
    // el modelo, ver direccionPorTexto.js), entrar al formulario o completar
    // un grupo abierto, en ese orden.
    const respuestaDeTexto = interaccion && !interaccion.mixto ? null
      : entradaRetomarPedido({estado,cfg,telefono,mensaje})
        || respuestaDeDireccion(!interaccion && direccionTextoActiva(cfg,telefono)
          ? direccionPorTexto({estado,mensaje,reglas,catalogo}) : null)
        || entradaFormulario({estado,cfg,telefono,mensaje})
        || respuestaTextoGrupo({estado,catalogo,mensaje});
    salida = await atenderTurnoConHerramientas({
      ...baseDelTurno,
      efectos,
      ...(interaccion && !interaccion.mixto ? { respuestaDeSistema: (() => {
        if(opcionMapo)return opcionMapo;
        if(formularioAplicado?.ok) {
          if(!estado.carrito.items.length && formularioAplicado.operaciones.some(o=>o.herramienta==='quitar_linea'))
            return {tipo:'flow_aplicado',sinSaludo:true,acciones:[],pendiente:{tipo:PENDIENTES.AGREGAR_OTRO},
              texto:'El platillo fue eliminado. Tu carrito está vacío. Puedes elegir otros platillos cuando quieras.'};
          return {tipo:'flow_aplicado',desdePedido:true,sinSaludo:true,acciones:[]};
        }
        if (reservaBotones?.accion === 'confirmar') {
          autorizarBotonReservado(estado, reservaBotones);
          return { tipo: 'boton_confirmar', desdePedido: true, sinSaludo: true,
            acciones: [{ herramienta: 'confirmar_pedido', argumentos: { huella_resumen: reservaBotones.huella } }] };
        }
        if (reservaBotones?.accion === 'cambiar_algo' && flowsActivos(cfg,telefono)) {
          const pendiente={tipo:cfg.whatsapp_flow_editar_id || cfg.whatsapp_flow_carrito_id ? PENDIENTES.EDITAR_PEDIDO : PENDIENTES.CONFIGURAR_PEDIDO};
          const disponible=fotoFormulario({...contextoElecciones,estado:{...estado,pendiente}},'flow_configurar');
          return disponible
            ? {tipo:'boton_cambiar',sinSaludo:true,texto:'Elige qué deseas cambiar. Conservo tu pedido sin confirmar.',acciones:[],pendiente}
            : {tipo:'boton_cambiar',sinSaludo:true,texto:'Conservo tu pedido sin confirmar. Dime qué platillo deseas cambiar y cómo lo prefieres; también puedes pedir ayuda a una persona.',acciones:[],pendiente:null};
        }
        if (reservaBotones?.accion === 'cambiar_algo') return { tipo: 'boton_cambiar', sinSaludo: true,
          texto: 'Conservo tu pedido sin confirmar. Escribe qué deseas cambiar.', acciones: [] };
        if (reservaBotones?.accion === 'agregar_otro') return { tipo: 'boton_agregar', sinSaludo: true,
          texto: '¿Qué te gustaría agregar? Conservo lo que ya elegiste.', acciones: [],
          pendiente: {tipo:PENDIENTES.AGREGAR_OTRO} };
        if (reservaBotones?.datos?.tipo && reservaBotones.accion !== 'aviso')
          return respuestaDeEleccion(reservaBotones,contextoElecciones);
        const aviso = reservaBotones?.motivo === 'decisiones_distintas'
          ? 'Recibí varias decisiones distintas juntas. No apliqué esos toques. Elige una opción para continuar.\n'
          : 'Ese botón ya no está vigente. No apliqué ese toque. Revisa la información actual.\n';
        if ((!estado.pendiente || estado.pendiente.tipo === PENDIENTES.AGREGAR_OTRO) && estado.dialogo?.texto)
          return {tipo:'boton_desactualizado',sinSaludo:true,acciones:[],pendiente:estado.pendiente,
            texto:aviso+estado.dialogo.texto};
        if (['elegir_producto','aceptar_producto','aceptar_promocion','aceptar_pago_ofrecido'].includes(estado.pendiente?.tipo)
          && opcionesInteractivas(contextoElecciones).length)
          return {tipo:'boton_desactualizado',sinSaludo:true,acciones:[],pendiente:estado.pendiente,
            texto:aviso+estado.dialogo.texto};
        return { tipo: 'boton_desactualizado', desdePedido: true, sinSaludo: true,
          texto: aviso, acciones: [] };
      })() } : {respuestaDeSistema:respuestaDeTexto}),
      contexto: {
        nombreNegocio: cfg?.nombre || cfg?.nombre_negocio || reglas?.restaurante || 'el restaurante',
        resolverEstadoOperativo:folio=>leerEstadoOperativo(db,{negocioId,telefono,folio}),
        textoCiclo: textoCiclo || mensaje,
        datosConocidos: [telefono && telefono !== '—' ? `Teléfono: ${telefono}` : null,
          nombre ? `Nombre: ${nombre}` : null].filter(Boolean),
        tono: reglas?.bot?.tono || cfg?.tono_bot || null,
        reglasDelNegocio: reglasDelAsistenteEnTexto(reglas, { esPrimerTurno: Number(estado.turno || 0) === 0 }),
        metodosPago,
        pagoDescartado,
        modalidades,
        modalidadDescartada,
        promocionesInformativas,
        estadoRestaurante,
      },
    });

    if(formularioAplicado?.ok) {
      salida.operaciones=[...formularioAplicado.operaciones,...(salida.operaciones || [])];
    }
    salida = aplicarRespuestaDeEntrega({ salida, modalidadDescartada, modalidades, reglas });
    salida = aplicarRespuestaDeConfirmacion({ salida, estado, zonaDelNegocio: reglas?.timezone, reglas });
    salida = aplicarRespuestaDePago({
      salida, estado, pagoDescartado, metodosPago, zonaDelNegocio: reglas?.timezone, reglas,
    });

    // Las respuestas automáticas posteriores al modelo (pago, modalidad y
    // confirmación) pasan por la misma barrera. La opción del panel dice
    // "nunca debe decir", así que no puede depender de quién armó el texto.
    const prohibidaFinal = respuestaProhibidaEncontrada(salida.texto, reglas);
    if (prohibidaFinal) {
      const entregado = await avisarAHumano(
        escalarAHumano, negocioId, telefono, 'AGENTE_RESPUESTA_PROHIBIDA');
      if (entregado) {
        estado.hechos.escalado = true;
        salida.escalado = true;
      } else {
        salida.handoffPendiente = true;
      }
      salida.texto = 'Permíteme un momento, te paso con alguien del equipo para atenderte bien.';
      salida.motivoCierre = CIERRE.ESCALADO;
      salida.motivoHandoff = 'AGENTE_RESPUESTA_PROHIBIDA';
    }

    // El prompt exige usar herramientas, pero la conversación de Tania
    // demostró que el modelo puede decir «apunto» o «anotamos» sin hacerlo.
    // La afirmación no sale al cliente: se reemplaza y se entrega el caso.
    if (respuestaAfirmaCambioSinAplicar(salida)) {
      const entregado = await avisarAHumano(
        escalarAHumano, negocioId, telefono, 'AGENTE_AFIRMO_CAMBIO_SIN_GUARDAR');
      if (entregado) {
        estado.hechos.escalado = true;
        salida.escalado = true;
      } else {
        salida.handoffPendiente = true;
      }
      salida.texto = TEXTO_CAMBIO_NO_GUARDADO;
      salida.motivoCierre = CIERRE.ESCALADO;
      salida.motivoHandoff = 'AGENTE_AFIRMO_CAMBIO_SIN_GUARDAR';
    }

    // Debe ser el ÚLTIMO postprocesador de texto: una solicitud completa
    // recibe siempre el mensaje determinista; una incompleta que el modelo
    // intentó cotizar/prometer se reemplaza y se entrega a una persona.
    const catering = aplicarSalidaSeguraDeCatering(salida, { eventoActivo, evento: estado.evento });
    if (catering.requiereHandoff) {
      const entregado = await avisarAHumano(
        escalarAHumano, negocioId, telefono, 'SOLICITUD_EVENTO_RESPUESTA_PROHIBIDA');
      if (entregado) estado.hechos.escalado = true;
      else salida.handoffPendiente = true;
    }
    const falloEnlace = resultadoConfirmacion(salida)?.enlace_pago_error;
    if (falloEnlace) {
      if (await avisarAHumano(escalarAHumano, negocioId, telefono, 'AGENTE_ENLACE_PAGO_FALLO')) {
        estado.hechos.escalado = true;
        salida.escalado = true;
      } else {
        salida.handoffPendiente = true;
      }
    }

    // ── EL TURNO VOLVIÓ BIEN; FALTA VER SI PROMETIÓ DE MÁS ───────────────
    //
    // El aviso va ANTES del commit a propósito: si la misma caída que rompió
    // el turno se lleva también el guardado, lo único que no se puede perder
    // es la llamada a la persona.
    const desenlace = desenlaceDelTurno({ salida, confirmacionIntentada });
    if (desenlace.motivoHandoff) {
      // `confirmacionIncierta` congela la conversación: `cicloDelAgente` no
      // abre un ciclo nuevo mientras esté puesta.
      if (desenlace.incierta) estado.confirmacionIncierta = true;
      if (await avisarAHumano(escalarAHumano, negocioId, telefono, desenlace.motivoHandoff)) {
        estado.hechos.escalado = true;
        salida.escalado = true;
        salida.handoffPendiente = false;
      } else {
        salida.handoffPendiente = true;
      }
      salida.motivoHandoff = desenlace.motivoHandoff;
      if (desenlace.texto) salida.texto = desenlace.texto;
    }

    // La transferencia a una persona queda ESTRUCTURADA en el estado y en el
    // outbox: motivo, fase previa, lo recopilado y lo que se preguntaba.
    if (estado.hechos.escalado || salida.escalado) {
      eventosDelTurno.push(registrarTransferencia(estado, {
        motivo: salida.motivoHandoff || estado.motivoEscalado,
        pedido: vistaParaSellar(estado, contextoVista), faseAntes,
      }));
    }

    await aplicarTotalDelMotorAlResumen({ salida, estado, negocioId, telefono, nombre, canal,cfg,promociones:promocionesInformativas });
    sellarRespuesta(estado, salida);
    const comprometida = await comprometer(salida);

    console.log(`[AGENTE] evento=turno negocio=${negocioId} cierre=${comprometida.motivoCierre} `
      + `fase=${estado.fase} version=${comprometida.version} ops=${comprometida.operaciones.length} `
      + `tipo=${comprometida.tipoTurno || 'pedido'} recuperacion=${comprometida.recuperacion || 'ninguna'} `
      + `reintentos=${comprometida.recuperacionesModelo || 0} iter=${comprometida.iteraciones} ms=${Date.now() - t0}`);

    return resultadoDelCanalAgente(comprometida);
  } catch (e) {
    // ── DOS PROCESOS SOBRE LA MISMA CONVERSACIÓN ──────────────────────────
    // El commit detectó que otro escribió primero. Nada de este intento quedó
    // persistido (salvo efectos externos, que el libro ya anotó): se repite el
    // turno UNA vez sobre el estado fresco. Un efecto externo repetido lo ataja
    // el libro; una confirmación, su guarda por conversación.
    if (!reservaBotones?.reservaId && (e instanceof ConflictoDeVersionError || e.message === 'BOTON_CONFLICTO_REVISION') && intentoPorConflicto < 2) {
      console.warn(`[AGENTE] evento=conflicto_de_version negocio=${negocioId} tel=${telefonoCorto(telefono)}: se repite el turno`);
      return atenderConAgente({ ...argumentosDelTurno, intentoPorConflicto: intentoPorConflicto + 1 });
    }
    console.error('[AGENTE] contenido en el adaptador:', e?.message);
    // Un efecto irreversible pudo ocurrir antes del error (por ejemplo,
    // registrarPedido hizo COMMIT y luego falló el commit del turno). En ese
    // caso el bot viejo NO debe volver a procesar este mismo mensaje.
    if (reservaBotones?.reservaId) {
      // Nunca reejecutar un comando que pudo haber producido efectos.
      await conciliarReservaBotones(db, negocioId, { ...estado,
        botonesReserva: reservaBotones }).catch(() => {});
      const entregado = await avisarAHumano(escalarAHumano, negocioId, telefono, 'AGENTE_ESTADO_INCIERTO');
      return { ok: entregado, sinRespuesta: true, handoffPendiente: !entregado, motivo: 'boton_reserva_incierta' };
    }
    if (confirmacionIntentada || estado?.hechos?.confirmado || estado?.hechos?.escalado) {
      const handoffConfirmado = !confirmacionIntentada
        || await avisarAHumano(escalarAHumano, negocioId, telefono, 'AGENTE_ESTADO_INCIERTO');
      return resultadoDelCanalAgente({
        texto: estado?.hechos?.confirmado && estado.folio
          ? (salida?.texto || `Tu pedido ${estado.folio} quedó registrado. El equipo lo revisará.`)
          : 'Estoy revisando tu pedido con el equipo para evitar registrarlo dos veces. Te responderemos en breve.',
        folio: estado?.folio ?? null,
        escalado: !!estado?.hechos?.escalado,
        estadoIncierto: true,
        handoffPendiente: !handoffConfirmado,
      });
    }
    return { ok: false, motivo: e?.message || 'error', ms: Date.now() - t0 };
  }
}

/**
 * OBSERVA UN TURNO, sin efectos de ninguna clase.
 *
 * Mismo bucle, mismo ejecutor, mismo reconciliador, misma carta publicada.
 * Lo que cambia:
 *
 *   · los efectos son grabadoras: no registra pedido, no escala, no imprime;
 *   · el estado vive en su propio espacio de nombres y no toca el productivo;
 *   · el libro de operaciones es de MEMORIA, así que ni siquiera escribe en la
 *     tabla de auditoría del agente productivo;
 *   · el commit no deja respuesta en el outbox (la sombra no contesta a nadie).
 *
 * Funciona con el bot apagado, que es exactamente cuando hace falta.
 */
export async function observarConAgente({
  negocioId, telefono, mensaje, nombre = null,
  llamarModelo, historial = [], textoCiclo = '', turnoId = null, traza = null, wamids = [],
} = {}) {
  const t0 = Date.now();
  try {
    const [catalogoAgente, cfg, metodosPago, reglas, configTienda] = await Promise.all([
      obtenerCatalogoDelAgente(negocioId),
      obtenerConfiguracion(negocioId).catch(() => ({})),
      obtenerMetodosPagoDisponibles(negocioId, { paraBot: true }),
      cargarReglas(negocioId),
      obtenerConfigTienda(negocioId).catch(() => null),
    ]);
    const catalogo = Array.isArray(catalogoAgente?.carta) ? catalogoAgente.carta : [];
    const estadoRestaurante = obtenerEstadoRestaurante(reglas);
    const promocionesInformativas = await cargarPromocionesInformativas(
      negocioId, 'whatsapp', reglas?.timezone,
    );
    const estadoAnterior = await leerEstadoVersionado(negocioId, telefono, { sombra: true });
    const turnoClave = claveDeTurno({ wamids, turnoId });
    const faseAntes = estadoAnterior.fase || null;
    const versionAntes = estadoAnterior._revision ?? null;
    const pendienteAntes = estadoAnterior.pendiente ? { ...estadoAnterior.pendiente } : null;
    const estado = heredarIdentidad(cicloParaTurno(estadoAnterior, mensaje,
      { zona: reglas?.timezone, flujosCaducan: cfg?.whatsapp_flujos_caducan_v1 === 'true' }), estadoAnterior);
    normalizarEstado(estado);
    if (estado.conversacionId !== estadoAnterior.conversacionId) {
      historial = [];
      textoCiclo = mensaje;
    }
    const eventoActivo = prepararEstadoCatering(estado, mensaje, { nombreConfiable: nombre });
    const cancelacionCatering = consumirCancelacionCatering(estado);
    const modalidades = Array.isArray(reglas?.pedidos?.modalidades) && reglas.pedidos.modalidades.length
      ? reglas.pedidos.modalidades : ['recoger en tienda', 'entrega a domicilio'];
    const promocionesActivas = estadoRestaurante.promocionesActivas || [];
    const requierePago = String(cfg?.pedido_requiere_pago ?? 'true').toLowerCase() !== 'false';
    const contextoVista = { catalogo, requierePago, metodosPago, modalidades, reglas, promocionesActivas,
      zonaDelNegocio: reglas?.timezone };
    const guardarSombra = async (s) => {
      try {
        await confirmarTurno({ negocioId, telefono, estado, pedido: vistaParaSellar(estado, contextoVista),
          sombra: true, turnoClave, wamids, salida: s, faseAntes, versionAntes, pendienteAntes,
          latencias: { total_ms: Date.now() - t0 } });
      } catch (e) {
        // La sombra no contesta a nadie: un conflicto o una invariante rota se
        // registra y se deja pasar, nunca se propaga al canal real.
        console.error(`[SOMBRA-AGENTE] no se guardó el estado de sombra: ${e?.message}`);
      }
    };
    if (cancelacionCatering) {
      await guardarSombra(null);
      return { ok: true, ...cancelacionCatering, grabadas: [], linea: null };
    }
    if (!eventoActivo) marcarProgramacionRequerida(estado, mensaje, {
      fechaHoy: estadoRestaurante.fechaHoy, catalogo,
    });
    const bloqueoPrevio = bloqueoPrevioDelAgente({
      eventoActivo, estadoRestaurante, catalogo, estado, configTienda,
    });
    if (bloqueoPrevio === 'fuera_horario') {
      const texto = construirAvisoFueraDeHorario({ estadoRestaurante, reglas, configTienda });
      console.log(`[SOMBRA-AGENTE] ${JSON.stringify({
        evt: 'agente_sombra', negocio: negocioId, cierre: 'fuera_horario',
        tienda_programados: !!configTienda?.aceptaProgramados,
      })}`);
      return {
        ok: true,
        texto,
        folio: null,
        escalado: false,
        fueraHorario: true,
        motivoCierre: CIERRE.RESPONDIO,
        operaciones: [],
      };
    }
    if (bloqueoPrevio === 'sin_catalogo') return { ok: false, motivo: 'sin_catalogo' };

    const modalidadDescartada = depurarModalidadNoDisponible(estado, modalidades);
    const pagoDescartado = depurarPagoNoDisponible(estado, metodosPago);
    const grabadas = [];
    const salida = await atenderTurnoConHerramientas({
      negocioId,
      conversacionId: estado.conversacionId,
      turnoId: turnoClave,
      mensaje,
      historial,
      catalogo,
      precios: preciosDelCatalogo(catalogo),
      requierePago,
      metodosPago,
      modalidades,
      reglas,
      configTienda,
      promocionesActivas,
      zonaDelNegocio: reglas?.timezone,
      estado,
      nombreDelCanal: nombre,
      nombresOcultos: catalogoAgente?.nombresOcultos || [],
      promocionesVigentesIds: Array.isArray(promocionesInformativas)
        ? new Set(promocionesInformativas.map((p) => String(p.id))) : null,
      // Memoria, no Postgres: la sombra no escribe ni en la auditoría.
      libro: libroDeOperaciones(almacenEnMemoria()),
      llamarModelo,
      efectos: {
        confirmar: async ({ pedido }) => {
          grabadas.push({ tipo: 'confirmar_hipotetico', pedido });
          return { ok: true, folio: null, simulado: true };
        },
        escalar: async ({ motivo }) => {
          grabadas.push({ tipo: 'handoff_hipotetico', motivo });
          return { ok: true, simulado: true };
        },
      },
      contexto: {
        nombreNegocio: cfg?.nombre || cfg?.nombre_negocio || reglas?.restaurante || 'el restaurante',
        textoCiclo: textoCiclo || mensaje,
        tono: reglas?.bot?.tono || cfg?.tono_bot || null,
        reglasDelNegocio: reglasDelAsistenteEnTexto(reglas, { esPrimerTurno: Number(estado.turno || 0) === 0 }),
        metodosPago,
        pagoDescartado,
        modalidades,
        modalidadDescartada,
        promocionesInformativas,
        estadoRestaurante,
      },
      modo: 'sombra',
      traza,
    });

    aplicarRespuestaDeEntrega({ salida, modalidadDescartada, modalidades, reglas });
    aplicarRespuestaDeConfirmacion({ salida, estado, zonaDelNegocio: reglas?.timezone, reglas });
    aplicarRespuestaDePago({
      salida, estado, pagoDescartado, metodosPago, zonaDelNegocio: reglas?.timezone, reglas,
    });
    const prohibidaFinal = respuestaProhibidaEncontrada(salida.texto, reglas);
    if (prohibidaFinal) {
      estado.hechos.escalado = true;
      salida.escalado = true;
      salida.texto = 'Permíteme un momento, te paso con alguien del equipo para atenderte bien.';
      salida.motivoCierre = CIERRE.ESCALADO;
      grabadas.push({ tipo: 'handoff_hipotetico', motivo: 'AGENTE_RESPUESTA_PROHIBIDA' });
    }
    const catering = aplicarSalidaSeguraDeCatering(salida, { eventoActivo, evento: estado.evento });
    if (catering.requiereHandoff) {
      estado.hechos.escalado = true;
      grabadas.push({ tipo: 'handoff_hipotetico', motivo: 'SOLICITUD_EVENTO_RESPUESTA_PROHIBIDA' });
    }

    sellarRespuesta(estado, salida);
    // La sombra no tiene transporte: su respuesta se da por «enviada» para que
    // el ciclo siguiente se comporte como el productivo tras el acuse.
    if (salida.dialogoId) acusarDialogo(estado, salida.dialogoId, salida.texto);
    await guardarSombra(salida);

    // Una línea por turno, sin PII y con el prefijo que ya se busca en Railway.
    const linea = JSON.stringify({
      evt: 'agente_sombra', negocio: negocioId, cierre: salida.motivoCierre,
      estado: salida.pedido?.estado, fase: estado.fase, renglones: salida.pedido?.lineas?.length ?? 0,
      total: salida.pedido?.total ?? null, falta: salida.pedido?.falta ?? [],
      herramientas: salida.operaciones.map((o) => o.herramienta),
      rechazos: salida.operaciones.filter((o) => o.resultado?.aplicado === false)
        .map((o) => ({ h: o.herramienta, motivo: String(o.resultado?.motivo || '').slice(0, 60) })),
      hipoteticos: grabadas.map((g) => g.tipo),
      iter: salida.iteraciones, ms: salida.duracionMs,
    });
    console.log(`[SOMBRA-AGENTE] ${linea}`);

    return { ok: true, ...salida, grabadas, linea };
  } catch (e) {
    console.error('[SOMBRA-AGENTE] contenida:', e?.message);
    return { ok: false, motivo: e?.message || 'error', ms: Date.now() - t0 };
  }
}

// ── SIMULADOR DEL MÓDULO ASISTENTE ──────────────────────────────────────
// Usa el mismo bucle, herramientas, prompt, reglas y carta publicada que
// WhatsApp. El estado y el libro viven solo en memoria; confirmar y escalar son
// efectos simulados. El panel es su transporte: cada respuesta mostrada se
// acusa como enviada, igual que el canal real tras aceptarla Meta.
const sesionesSimuladas = new Map();

/**
 * Traduce el resultado de `enviarMenuAutomatico` al contrato de la herramienta
 * `enviar_menu`. Si la imagen no estaba revisada contra la carta vigente, el
 * cliente YA recibió el menú en texto desde la carta: para el modelo eso es un
 * menú enviado (no debe decirle «no pude mandártelo» ni repetirlo).
 */
export function resultadoDelEnvioDeMenu(r) {
  if (r?.ok) return { ok: true, paginas: r.enviadas ?? null };
  // Solo si de verdad salió el menú en texto; si salió el aviso genérico («No
  // pude enviar el menú…»), para el modelo el menú NO se envió.
  if (r?.motivo === 'imagen_sin_revisar' && r?.menuEnTexto === true) return { ok: true, paginas: 0, comoTexto: true };
  return { ok: false, motivo: r?.motivo || 'envio_incompleto' };
}

export function limpiarSimulacionDelAgente(sessionId) {
  return sesionesSimuladas.delete(sessionId);
}

export async function simularConAgente({
  sessionId, negocioId, mensaje, llamarModelo,
} = {}) {
  if (!String(sessionId || '').startsWith('sim-')) throw new Error('sessionId de simulador inválido');
  if (!String(negocioId || '').trim()) throw new Error('negocioId de simulador inválido');
  if (!String(mensaje || '').trim()) throw new Error('mensaje de simulador vacío');

  let sesion = sesionesSimuladas.get(sessionId);
  if (!sesion) {
    sesion = {
      estado: estadoNuevo({ negocioId, conversacionId: sessionId }),
      historial: [],
      almacen: almacenEnMemoria(),
    };
    sesionesSimuladas.set(sessionId, sesion);
  }

  const [catalogoAgente, cfg, metodosPago, reglas, configTienda] = await Promise.all([
    obtenerCatalogoDelAgente(negocioId),
    obtenerConfiguracion(negocioId).catch(() => ({})),
    obtenerMetodosPagoDisponibles(negocioId, { paraBot: true }),
    cargarReglas(negocioId),
    obtenerConfigTienda(negocioId).catch(() => null),
  ]);
  const catalogo = Array.isArray(catalogoAgente?.carta) ? catalogoAgente.carta : [];
  const estadoRestaurante = obtenerEstadoRestaurante(reglas);
  const promocionesInformativas = await cargarPromocionesInformativas(
    negocioId, 'whatsapp', reglas?.timezone,
  );
  const idAnterior = sesion.estado.conversacionId;
  sesion.estado = cicloParaTurno(sesion.estado, mensaje);
  if (sesion.estado.conversacionId !== idAnterior) sesion.historial = [];
  const estado = sesion.estado;
  normalizarEstado(estado);
  const eventoActivo = prepararEstadoCatering(estado, mensaje);
  const cancelacionCatering = consumirCancelacionCatering(estado);
  if (!eventoActivo) marcarProgramacionRequerida(estado, mensaje, {
    fechaHoy: estadoRestaurante.fechaHoy, catalogo,
  });
  const bloqueoPrevio = bloqueoPrevioDelAgente({
    eventoActivo, estadoRestaurante, catalogo, estado, configTienda,
  });
  let salida = cancelacionCatering;

  if (cancelacionCatering) {
    // La cancelación de la ficha termina el turno antes del modelo. En
    // particular, "ya no quiero catering" jamás puede vaciar el carrito que
    // pudiera existir debajo de la ficha.
  } else if (bloqueoPrevio === 'fuera_horario') {
    salida = {
      texto: construirAvisoFueraDeHorario({ estadoRestaurante, reglas, configTienda }),
      confirmado: false, escalado: false, operaciones: [], fueraHorario: true,
    };
  } else {
    if (bloqueoPrevio === 'sin_catalogo') throw new Error('El negocio no tiene catálogo publicado para WhatsApp');
    const modalidades = Array.isArray(reglas?.pedidos?.modalidades) && reglas.pedidos.modalidades.length
      ? reglas.pedidos.modalidades : ['recoger en tienda', 'entrega a domicilio'];
    const promocionesActivas = estadoRestaurante.promocionesActivas || [];
    const modalidadDescartada = depurarModalidadNoDisponible(estado, modalidades);
    const pagoDescartado = depurarPagoNoDisponible(estado, metodosPago);

    salida = await atenderTurnoConHerramientas({
        negocioId,
        conversacionId: estado.conversacionId,
        turnoId: `sim-${Date.now()}`,
        mensaje,
        historial: sesion.historial,
        catalogo,
        precios: preciosDelCatalogo(catalogo),
        requierePago: String(cfg?.pedido_requiere_pago ?? 'true').toLowerCase() !== 'false',
        metodosPago,
        modalidades,
        reglas,
        configTienda,
        promocionesActivas,
        zonaDelNegocio: reglas?.timezone,
        estado,
        nombresOcultos: catalogoAgente?.nombresOcultos || [],
        promocionesVigentesIds: Array.isArray(promocionesInformativas)
          ? new Set(promocionesInformativas.map((p) => String(p.id))) : null,
        libro: libroDeOperaciones(sesion.almacen),
        llamarModelo,
        efectos: {
          confirmar: async ({ pedido }) => ({
            ok: true, folio: 'SIMULADO', simulado: true,
            total: pedido?.total, subtotal: pedido?.subtotal, costo_envio: pedido?.costo_envio,
          }),
          escalar: async () => ({ ok: true, simulado: true }),
        },
        contexto: {
          nombreNegocio: cfg?.nombre || cfg?.nombre_negocio || reglas?.restaurante || 'el restaurante',
          textoCiclo: mensaje,
          tono: reglas?.bot?.tono || cfg?.tono_bot || null,
          reglasDelNegocio: reglasDelAsistenteEnTexto(reglas, { esPrimerTurno: Number(estado.turno || 0) === 0 }),
          metodosPago,
          pagoDescartado,
          modalidades,
          modalidadDescartada,
          promocionesInformativas,
          estadoRestaurante,
        },
        modo: 'simulacion',
      });

    aplicarRespuestaDeEntrega({ salida, modalidadDescartada, modalidades, reglas });
    aplicarRespuestaDeConfirmacion({ salida, estado, zonaDelNegocio: reglas?.timezone, reglas });
    aplicarRespuestaDePago({
      salida, estado, pagoDescartado, metodosPago, zonaDelNegocio: reglas?.timezone, reglas,
    });
    const prohibidaFinal = respuestaProhibidaEncontrada(salida.texto, reglas);
    if (prohibidaFinal) {
      estado.hechos.escalado = true;
      salida.escalado = true;
      salida.texto = 'Permíteme un momento, te paso con alguien del equipo para atenderte bien.';
      salida.motivoCierre = CIERRE.ESCALADO;
    }
    if (respuestaAfirmaCambioSinAplicar(salida)) {
      estado.hechos.escalado = true;
      salida.escalado = true;
      salida.texto = TEXTO_CAMBIO_NO_GUARDADO;
      salida.motivoCierre = CIERRE.ESCALADO;
    }
    const catering = aplicarSalidaSeguraDeCatering(salida, { eventoActivo, evento: estado.evento });
    if (catering.requiereHandoff) estado.hechos.escalado = true;
    sellarRespuesta(estado, salida);
    // El panel es el transporte del simulador: lo que muestra, lo envió.
    if (salida.dialogoId) acusarDialogo(estado, salida.dialogoId, salida.texto);
  }

  sesion.estado._actualizadoAt = new Date().toISOString();
  sesion.historial.push(
    { rol: 'user', texto: String(mensaje) },
    { rol: 'assistant', texto: String(salida.texto || '') },
  );
  // Mantiene contexto suficiente sin dejar crecer el proceso por cada prueba.
  sesion.historial = sesion.historial.slice(-20);
  return {
    texto: String(salida.texto || ''),
    ordenDetectada: !!salida.confirmado,
    escalar: !!salida.escalado,
    fueraHorario: !!salida.fueraHorario,
    sessionId,
  };
}

/** El resultado durable de `confirmar_pedido`, si ocurrió en este turno. */
export function resultadoConfirmacion(salida) {
  const operaciones = Array.isArray(salida?.operaciones) ? salida.operaciones : [];
  return [...operaciones].reverse()
    .find((o) => o?.herramienta === 'confirmar_pedido')?.resultado || null;
}

/**
 * Los mensajes sobre dinero no se dejan a interpretación del modelo:
 * - una transferencia no habilitada siempre recibe la misma explicación;
 * - una URL devuelta por pagosService siempre llega al cliente;
 * - si Clip falla después del registro, se anuncia el folio sin inventar URL.
 */
export function describirProgramacion(programadoPara, zonaDelNegocio = TZ_DEFAULT) {
  const d = new Date(programadoPara);
  if (!programadoPara || Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone: zonaDelNegocio || TZ_DEFAULT,
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    }).format(d);
  } catch {
    return null;
  }
}

export function aplicarRespuestaDePago({
  salida, estado, pagoDescartado = null, metodosPago = [], zonaDelNegocio = undefined, reglas = null,
} = {}) {
  if (!salida) return salida;
  const confirmacion = resultadoConfirmacion(salida);
  if (confirmacion?.enlace_pago) {
    const url = String(confirmacion.enlace_pago);
    const folio = confirmacion.folio || salida.folio || '';
    const total = Number(confirmacion.total);
    const envio = Number(confirmacion.costo_envio);
    let base = Number.isFinite(total)
      ? `Tu pedido ${folio} quedó registrado por $${total} MXN.`
        + (envio > 0 ? ` Incluye $${envio} MXN de envío.` : '')
      : String(salida.texto || `Tu pedido ${folio} quedó registrado.`).trim();
    const programacion = describirProgramacion(
      confirmacion.programado_para || estado?.carrito?.datos?.programado_para,
      zonaDelNegocio,
    );
    if (programacion) base += ` Está programado para el ${programacion}.`;
    else {
      const tiempo = fraseTiempoEstimado(reglas, estado?.carrito?.datos?.modalidad, { desdePago: true });
      if (tiempo) base += ` ${tiempo}`;
    }
    salida.texto = base.includes(url) ? base : `${base}\n\nPaga aquí con el enlace seguro:\n${url}`;
    salida.enlacePago = url;
    return salida;
  }
  if (confirmacion?.enlace_pago_error) {
    const folio = confirmacion.folio || salida.folio || estado?.folio || '';
    const total = Number(confirmacion.total);
    const envio = Number(confirmacion.costo_envio);
    const importe = Number.isFinite(total)
      ? ` por $${total} MXN${envio > 0 ? ` (incluye $${envio} MXN de envío)` : ''}` : '';
    const programacion = describirProgramacion(
      confirmacion.programado_para || estado?.carrito?.datos?.programado_para,
      zonaDelNegocio,
    );
    salida.texto = `Tu pedido ${folio} quedó registrado${importe}`
      + (programacion ? ` para el ${programacion}` : '')
      + ', pero no pude generar el enlace de pago. '
      + 'Escríbeme “enlace de pago” en un momento para reintentarlo sin duplicar el cobro.';
    salida.enlacePagoError = confirmacion.enlace_pago_error;
    return salida;
  }

  const rechazos = (salida.operaciones || []).filter((o) =>
    o?.herramienta === 'definir_pago'
    && o?.resultado?.codigo === 'forma_pago_no_disponible'
    && o?.resultado?.metodo_solicitado === 'transferencia');
  const enlaceDisponible = (metodosPago || []).some((m) => (m?.tipo ?? m) === 'enlace_pago');
  const transferenciaDescartada = pagoDescartado === 'transferencia'
    && !estado?.carrito?.datos?.forma_pago;

  if (enlaceDisponible && (rechazos.length || transferenciaDescartada)) {
    // La oferta es una PREGUNTA PENDIENTE estructurada: el sellado final del
    // turno la fija con `fijarPendiente` junto al texto que de verdad sale.
    salida.pendienteFinal = { tipo: PENDIENTES.ACEPTAR_PAGO_OFRECIDO, forma_pago: 'enlace_pago' };
    salida.texto = 'No contamos con pagos por transferencia, pero podemos ofrecerte un enlace de pago; '
      + 'es muy similar a pagar con transferencia. ¿Te funciona?';
  }
  return salida;
}

/**
 * Anuncia una confirmación desde el resultado canónico de registrarPedido.
 * El texto libre del modelo fue redactado con la vista previa y puede quedar
 * viejo si el backend aplicó un extra o una promoción al registrar.
 */
export function aplicarRespuestaDeConfirmacion({ salida, estado, zonaDelNegocio = undefined, reglas = null } = {}) {
  if (!salida) return salida;
  const confirmacion = resultadoConfirmacion(salida);
  if (!confirmacion?.folio || confirmacion?.aplicado === false) return salida;

  const total = Number(confirmacion.total);
  const envio = Number(confirmacion.costo_envio);
  const datos = estado?.carrito?.datos || {};
  const cliente = datos.cliente || {};
  const pago = datos.forma_pago;
  const pagos = {
    efectivo: 'Pago en efectivo.',
    terminal: 'Pago con tarjeta en terminal.',
    enlace_pago: 'Pago mediante enlace.',
  };
  const partes = [
    `Tu pedido ${confirmacion.folio} quedó registrado${Number.isFinite(total) ? ` por $${total} MXN` : ''}.`,
  ];
  const programacion = describirProgramacion(
    confirmacion.programado_para || datos.programado_para,
    zonaDelNegocio,
  );
  if (programacion) partes.push(`Está programado para el ${programacion}.`);
  if (Number.isFinite(envio) && envio > 0) partes.push(`El total incluye $${envio} MXN de envío.`);
  if (datos.modalidad && String(datos.modalidad).toLowerCase().includes('domicilio') && cliente.direccion) {
    partes.push(`Entrega a domicilio en ${cliente.direccion}.`);
  }
  if (pagos[pago]) partes.push(pagos[pago]);
  // Un programado ya trae su fecha y hora; el tiempo estimado es para hoy.
  if (!programacion) {
    const tiempo = fraseTiempoEstimado(reglas, datos.modalidad, { desdePago: pago === 'enlace_pago' });
    if (tiempo) partes.push(tiempo);
  }
  salida.texto = partes.join(' ');
  return salida;
}

/** La política de entrega también se redacta en código cuando el modelo pide algo no permitido. */
export function aplicarRespuestaDeEntrega({
  salida, modalidadDescartada = null, modalidades = [], reglas = null,
} = {}) {
  if (!salida) return salida;
  const entregaAplicada = (salida.operaciones || []).find((o) =>
    o?.herramienta === 'definir_entrega' && o?.resultado?.aplicado === true);
  const pedidoEntrega = entregaAplicada?.resultado?.pedido;
  const costoEnvio = Number(pedidoEntrega?.costo_envio);
  if (pedidoEntrega?.cliente?.direccion && pedidoEntrega?.modalidad && pedidoEntrega.modalidad.toLowerCase().includes('domicilio')
      && costoEnvio > 0 && salida.texto && !/env[ií]o/i.test(salida.texto)) {
    salida.texto = `${salida.texto.trim()} El costo de envío es $${costoEnvio} MXN.`;
  }

  const rechazo = (salida.operaciones || []).find((o) =>
    o?.herramienta === 'definir_entrega'
    && o?.resultado?.codigo === 'modalidad_no_disponible');
  const solicitada = rechazo?.resultado?.modalidad_solicitada || modalidadDescartada;
  if (!solicitada) return salida;

  const disponibles = modalidadesDisponibles(modalidades) || [];
  const tipos = new Set(disponibles.map((m) => m.tipo));
  if (solicitada === 'consumo_sitio' && tipos.has('recoger') && tipos.has('domicilio')) {
    // No se afirma que el local no tenga mesas: Obispado las tiene y el 2-oct
    // el bot lo negó tres veces. Si el negocio configuró qué decir sobre
    // mesas (pregunta frecuente), eso va primero, con sus palabras.
    const mesas = respuestaSobreMesas(reglas);
    salida.texto = `${mesas ? `${mesas.replace(/[.!]?$/, '.')} ` : ''}`
      + 'Por WhatsApp tomamos pedidos para recoger en tienda o a domicilio. ¿Cuál prefieres?';
    return salida;
  }

  const alternativas = disponibles.map((m) => etiquetaTipoModalidad(m.tipo));
  salida.texto = `No contamos con ${etiquetaTipoModalidad(solicitada)} como forma de entrega. `
    + `Las opciones disponibles son: ${alternativas.join(', ') || 'ninguna'}. ¿Cuál prefieres?`;
  return salida;
}

// ── QUÉ PASÓ DE VERDAD EN ESTE TURNO ─────────────────────────────────────
//
// Tres desenlaces distintos piden lo mismo —una persona— y solo uno de los
// tres estaba cubierto:
//
//   · el libro devolvió `incierta`: un turno ANTERIOR confirmó y su desenlace
//     no se conoce. Este ya se miraba.
//
//   · ESTE turno intentó confirmar y reventó. `confirmarYEmitir` solo relanza
//     cuando el COMMIT pudo haber ocurrido —los rechazos previos al INSERT
//     vuelven como `ok: false`—, así que una excepción aquí significa «puede
//     haber un pedido y nadie sabe su folio». Este es el que se escapaba:
//     `atenderTurnoConHerramientas` NO relanza, devuelve con `error`, de modo
//     que el `catch` del adaptador jamás lo veía y el turno se cerraba como
//     si nada, con el pedido ya escrito en Postgres y fuera del panel.
//
//   · el agente quiso escalar y su `pedir_humano` no se aplicó
//     (`handoffPendiente`). El adaptador es el único que sabe a quién avisar,
//     así que es su último intento.
//
// Se separa del adaptador porque es una DECISIÓN, no un efecto: así se puede
// probar sin base, sin red y sin modelo, que es como se prueba una decisión.
export function desenlaceDelTurno({ salida = null, confirmacionIntentada = false } = {}) {
  // Un folio conocido no tiene nada de incierto. Si el turno reventó DESPUÉS
  // de una confirmación que sí devolvió folio, el accidente es otro —y ya lo
  // escaló el propio agente—: decirle al cliente «reviso para no registrarlo
  // dos veces» sería sembrar una duda que no existe sobre un pedido que está.
  const confirmacionConocida = !!salida?.confirmado && !!salida?.folio;
  const confirmacionRota = !!salida?.error && !!confirmacionIntentada && !confirmacionConocida;
  const inciertaPrevia = !!salida?.operaciones?.some((o) => o.resultado?.estado === 'incierta');
  const incierta = confirmacionRota || inciertaPrevia;
  const handoffPendiente = !!salida?.handoffPendiente;

  const motivoHandoff = confirmacionRota ? 'AGENTE_ESTADO_INCIERTO'
    : inciertaPrevia ? 'AGENTE_CONFIRMACION_INCIERTA'
      : handoffPendiente ? 'AGENTE_HANDOFF_PENDIENTE'
        : null;

  return {
    incierta,
    confirmacionRota,
    handoffPendiente,
    motivoHandoff,
    // Un pedido que quizá exista no se anuncia como registrado NI como
    // fallido: las dos cosas serían afirmar algo que nadie comprobó.
    texto: incierta
      ? 'Estoy revisando tu pedido con el equipo para evitar registrarlo dos veces. Te responderemos en breve.'
      : null,
  };
}

/**
 * AVISAR A UNA PERSONA, y decir si se logró.
 *
 * Devuelve un booleano en vez de lanzar porque quien llama ya viene de un
 * fallo: lo que necesita es saber si el aviso salió, no otra excepción que
 * atender. Un aviso que no sale se grita con la palabra que se busca en los
 * logs de Railway, porque un handoff perdido no lo nota nadie hasta que un
 * cliente reclama.
 */
export async function avisarAHumano(escalarAHumano, negocioId, telefono, motivo) {
  const quien = `negocio=${negocioId} tel=${telefonoCorto(telefono)} motivo=${motivo}`;
  if (typeof escalarAHumano !== 'function') {
    console.error(`[AGENTE] ALERTA handoff_sin_destino ${quien}`);
    return false;
  }
  try {
    const entregado = await escalarAHumano(negocioId, telefono, motivo);
    // `enviarARevision` devuelve false tanto si ya estaba en revisión como si
    // falló al marcarla. En ningún caso podemos afirmar que ESTE aviso salió.
    if (entregado !== true) {
      console.error(`[AGENTE] ALERTA handoff_no_confirmado ${quien} resultado=${String(entregado).slice(0, 40)}`);
      return false;
    }
    console.log(`[AGENTE] evento=handoff ${quien}`);
    return true;
  } catch (e) {
    console.error(`[AGENTE] ALERTA handoff_no_entregado ${quien} error=${String(e?.message || e).slice(0, 120)}`);
    return false;
  }
}

/**
 * El pedido que ESTA conversación ya registró, si existe (activo o programado).
 * La identidad `origen_agente.conversacion_id` viaja dentro del pedido; hay a
 * lo sumo uno por ciclo porque el libro solo permite una confirmación por
 * conversación (`uq_agente_confirmacion_conversacion`).
 */
export async function buscarPedidoDelAgente({ negocioId, conversacionId, db = pool } = {}) {
  if (!negocioId || !conversacionId) return null;
  const { rows } = await db.query(
    `SELECT folio, estado, datos FROM pedidos_activos
      WHERE negocio_id = $1 AND datos->'origen_agente'->>'conversacion_id' = $2
     UNION ALL
     SELECT folio, 'programado' AS estado, datos FROM pedidos_programados
      WHERE negocio_id = $1 AND datos->'origen_agente'->>'conversacion_id' = $2
     LIMIT 1`, [negocioId, String(conversacionId)]);
  if (!rows[0]) return null;
  // `negocioId` explícito: sin él `emitirPedido` falla cerrado y el pedido
  // adoptado no llegaría a cocina.
  return { ...(rows[0].datos || {}), id: rows[0].folio, negocioId,
    estado: rows[0].datos?.estado || rows[0].estado };
}

// ── CONFIRMAR: usar la misma ruta operacional durable que el bot legacy ──
//
// `registrarPedido` es la única puerta de creación de pedidos y tiene su
// propio gate (revalida contra el catálogo real y rechaza lo que el modelo
// invente). No se rodea: se usa. Lo que se añade es que los efectos
// posteriores queden escritos como hechos, no lanzados al aire.
//
// registrarPedido persiste el pedido y crea la deuda de emisión (trigger 063).
// emitirPedido reclama esa deuda y envía panel/impresión por la ruta existente.
// Igual que el bot legacy, la emisión se lanza después del registro; un fallo
// de emisión no convierte un pedido ya guardado en un pedido rechazado.
export async function confirmarYEmitir({
  negocioId, telefono, nombre, canal, estado, pedido, registrar, emitir,
  guardar = guardarPedido, crearPago = crearEnlacePago, previsualizar = null,
  convertir = convertirPedidoAProgramado,
  retirarProyeccionFallida = retirarProgramadoFallidoDeMemoria,
  resolverReserva = obtenerReservaProgramadaPorFolio,
  textoDelCiclo = null,
  totalExacto = null,
  buscarPedidoExistente = buscarPedidoDelAgente,
}) {
  const orden = ordenDesdeElCarrito({
    negocioId, carrito: estado.carrito, telefono, nombre, conversacionId: estado?.conversacionId,
  });
  // Última barrera ANTES del INSERT: el total canónico nunca puede superar el
  // que el cliente confirmó. Una promoción sí puede reducirlo; la respuesta
  // final informa ese importe menor. El incidente XAB-0481 mostró $470 y
  // registró $500 por un extra de bistec.
  if (typeof previsualizar === 'function') {
    const previa = await previsualizar(orden, negocioId, { canal });
    if (!previa?.ok) {
      const motivo = (previa?.rechazos || []).map((r) => r.codigo || r.motivo).join(', ')
        || 'preview_rechazado';
      return { ok: false, motivo, resumen_canonico: previa?.preview ?? null };
    }
    // Lo que el cliente LEYÓ: el total del motor si el resumen lo llevó (ligado
    // a la huella de ese resumen), si no, el de la vista.
    const leido = estado?.totalMostrado && estado.totalMostrado.huella === pedido?.huella
      ? Number(estado.totalMostrado.total) : NaN;
    const mostrado = Number.isFinite(leido) ? leido : Number(pedido?.total);
    const canonico = Number(previa?.preview?.total);
    if (totalExacto != null && (!Number.isFinite(canonico) || Math.abs(canonico - totalExacto) > 0.001)) {
      return { ok: false, motivo: 'precio_del_boton_cambio', resumen_canonico: previa?.preview ?? null };
    }
    if (Number.isFinite(mostrado) && Number.isFinite(canonico)
        && canonico - mostrado > 0.001) {
      return {
        ok: false,
        motivo: `total_cambio: el resumen mostrado fue $${mostrado} y el total canónico es $${canonico}. `
          + 'No registres todavía; muestra el resumen canónico y pide confirmación otra vez.',
        resumen_canonico: previa.preview,
      };
    }
  }
  // ── EL FRENO DE LOS PROGRAMADOS, EN EL PASO IRREVERSIBLE ───────────────
  //
  // Si el cliente pidió para otro día y nadie fijó la fecha, registrar aquí
  // metería en cocina HOY un pedido que es para mañana. Antes esto se frenaba
  // antes del modelo, lo que también le impedía hacerlo bien; ahora se frena
  // donde de verdad importa, y solo cuando de verdad falta.
  //
  // La autoridad principal es la marca durable que el adaptador escribe en el
  // primer turno. El detector de texto queda solo como defensa para estados
  // creados por un binario anterior o callers internos que todavía no la
  // traigan; la seguridad ya no depende de que el canal reconstruya el ciclo.
  const referenciaTemporalDelTurno = textoDelCiclo
    ? analizarReferenciasTemporalesDePedido(textoDelCiclo) : null;
  const barreraTemporalDelTurno = !!referenciaTemporalDelTurno
    && !referenciaTemporalDelTurno.objetivoInmediato
    && (!!referenciaTemporalDelTurno.fecha || referenciaTemporalDelTurno.ambiguaFecha
      || referenciaTemporalDelTurno.fechaNegada || referenciaTemporalDelTurno.horaNegada);
  const programacionRequerida = estado?.programacionRequerida === true
    || (!orden.programado_para && barreraTemporalDelTurno)
    || (!('programacionRequerida' in (estado || {})) && textoDelCiclo
      && esSolicitudDePedidoProgramado(textoDelCiclo, { hayPedidoEnCurso: true }));
  if (!orden.programado_para && programacionRequerida) {
    return {
      ok: false,
      motivo: 'falta_programar: el cliente pidió el pedido para otro día y no hay fecha fijada. '
        + 'Llama a programar_para con la fecha y la hora antes de confirmar.',
    };
  }

  let resultado;
  let conciliado = false;
  try {
    resultado = await registrar(orden, canal);
  } catch (e) {
    console.error('[AGENTE] registrarPedido lanzó:', e.message);
    // Solo estos rechazos ocurren antes de intentar el INSERT. Para cualquier
    // otro error el COMMIT pudo suceder aunque se perdiera la respuesta.
    if (['ORDEN_INVALIDA', 'MODO_SOLICITUD', 'TENANT_CONTEXT_REQUIRED'].includes(e?.codigo)
        || /^TENANT_CONTEXT_REQUIRED:/.test(String(e?.message || ''))) {
      return { ok: false, motivo: e.message };
    }
    // ── CONCILIAR POR IDENTIDAD, NO SUPONER ──────────────────────────────
    // El pedido lleva la identidad de esta conversación (`origen_agente`). Si
    // el INSERT hizo COMMIT y solo se perdió la respuesta, el pedido está en
    // la base con esa identidad: se ADOPTA su folio —uno solo, el que existe—
    // en vez de congelar la conversación. Si no está, el desenlace sigue
    // siendo incierto y se relanza para que una persona lo revise.
    let existente = null;
    try { existente = estado?.conversacionId ? await buscarPedidoExistente({ negocioId, conversacionId: estado.conversacionId }) : null; }
    catch (err) { console.error('[AGENTE] no se pudo conciliar el registro:', err?.message); }
    if (!existente) throw e;
    console.warn(`[AGENTE] ${existente.id} ya existía para esta conversación: se adopta el registro`);
    resultado = existente;
    conciliado = true;
  }
  if (!resultado || resultado.ok === false) {
    const motivo = (resultado?.rechazos || []).map((r) => r.codigo || r.motivo).join(', ') || 'rechazado';
    return { ok: false, motivo };
  }
  const folio = resultado.folio || resultado.pedido?.id || resultado.id || null;
  const programadoPara = orden?.programado_para || pedido?.programado_para || null;

  // Frontera de crash reproducible: el INSERT activo ya hizo COMMIT y todavía
  // no se invocó la conversión. Inerte en producción. La recuperación no
  // depende de repetir el mensaje: el bootstrap busca programado_para en la
  // fila y reanuda la transición atómica antes de cargar el panel.
  if (programadoPara
      && process.env.NODE_ENV !== 'production'
      && process.env.XABOR_PROGRAMADOS_FALLA_EN === 'despues_registrar_antes_convertir') {
    if (process.env.XABOR_PROGRAMADOS_MATAR_PROCESO === '1') process.exit(137);
    throw Object.assign(new Error("Fallo inyectado en 'despues_registrar_antes_convertir'"), {
      inyectado: true,
    });
  }

  // El enlace se crea desde la representación durable que corresponda (activo
  // o reserva programada). Para un programado primero se asegura la reserva y
  // solo después se llama al proveedor: así un webhook concurrente nunca puede
  // liberar como inmediato un pedido que todavía estaba entre registrar y
  // convertir. pagosService relee ambas tablas bajo la obligación del folio.
  let enlacePago = null;
  let enlacePagoError = null;
  const asegurarEnlacePago = async () => {
    if (!esPagoPorEnlace(resultado?.forma_pago_tipo || orden.forma_pago)) return;
    try {
      if (!folio) throw Object.assign(new Error('folio ausente después del registro'), { code: 'FOLIO_AUSENTE' });
      const enlace = await crearPago({
        negocioId, pedidoId: folio, actor: null, descripcion: `Pedido Xabor #${folio}`,
      });
      if (!enlace?.url) throw Object.assign(new Error('el proveedor no devolvió URL'), { code: 'ENLACE_SIN_URL' });
      enlacePago = { url: enlace.url, estado: enlace.estado ?? null, reutilizado: !!enlace.reutilizado };
    } catch (e) {
      const codigo = String(e?.code || 'ERROR_ENLACE_PAGO').slice(0, 80);
      console.error(`[AGENTE] crearEnlacePago(${folio || '-'}) falló codigo=${codigo}`);
      enlacePagoError = { codigo };
    }
  };

  const total = Number(resultado?.total ?? resultado?.pedido?.total ?? pedido?.total);
  const subtotal = Number(resultado?.subtotal ?? resultado?.pedido?.subtotal ?? pedido?.subtotal);
  const costoEnvio = Number(resultado?.costo_envio ?? resultado?.pedido?.costo_envio ?? pedido?.costo_envio);
  const desenlace = (extra = {}) => ({
    ok: true, folio,
    ...(conciliado ? { conciliado: true } : {}),
    ...(Number.isFinite(total) ? { total } : {}),
    ...(Number.isFinite(subtotal) ? { subtotal } : {}),
    ...(Number.isFinite(costoEnvio) ? { costo_envio: costoEnvio } : {}),
    ...(enlacePago ? { enlacePago } : {}),
    ...(enlacePagoError ? { enlacePagoError } : {}),
    ...extra,
  });

  // ── UN PEDIDO PROGRAMADO NO VA A COCINA AHORA ──────────────────────────
  //
  // Se convierte en RESERVA antes de emitir. `convertirPedidoAProgramado` hace
  // la transición durable en una sola llamada atómica (migración 062: asegura
  // la reserva, mueve el claim del folio y retira el activo). El job de
  // `server.js` lo activa `programado_para - 1 hora`, y activarlo es lo que lo
  // mete en el panel y lo imprime. Ese es el requisito: la comanda sale una
  // hora antes de la entrega, no al confirmar.
  //
  // Si la reserva NO queda asegurada, el pedido SIGUE siendo un activo normal
  // y no se le confirma al cliente una programación que no existe — es lo
  // mismo que hace el bot anterior, y por el mismo motivo.
  if (programadoPara) {
    const paraConvertir = resultado.pedido || resultado;
    let conv = await convertir(paraConvertir, programadoPara)
      .catch((e) => ({ ok: false, razon: e?.message || 'excepcion' }));
    if (!conv?.ok) {
      // La función SQL pudo hacer COMMIT y perder únicamente la respuesta.
      // Antes de declarar fallo se pregunta a la fuente de verdad por folio Y
      // tenant. Si la reserva existe con la misma fecha, se adopta el éxito y
      // el libro puede cerrar la confirmación como aplicada, sin duplicarla.
      let reserva = null;
      try { reserva = folio ? await resolverReserva(folio, negocioId) : null; }
      catch (e) { console.error(`[AGENTE] no se pudo conciliar la reserva ${folio || '-'}:`, e?.message); }
      const fechaReserva = reserva?.datos?.programado_para || reserva?.programado_para;
      const mismaFecha = fechaReserva
        && new Date(fechaReserva).getTime() === new Date(programadoPara).getTime();
      if (mismaFecha && reserva?.activado === false) {
        conv = { ok: true, reservado: true, recuperadoTrasRespuestaPerdida: true,
          programadoId: reserva.programado_id || null };
        console.warn(`[AGENTE] ${folio} ya estaba programado: se recuperó una respuesta perdida`);
      }
    }
    if (!conv?.ok) {
      console.error(`[AGENTE] ${folio || '-'} no se pudo conciliar como programado (${conv?.razon})`);
      // El activo conserva la evidencia durable para conciliación, pero jamás
      // se emite como pedido de HOY ni se deja en la proyección del panel.
      // La migración 063 tampoco crea deuda de emisión mientras tenga
      // `programado_para` sin `programado_id`.
      try { retirarProyeccionFallida?.(paraConvertir); }
      catch (e) { console.error(`[AGENTE] no se pudo retirar la proyección fallida de ${folio || '-'}:`, e?.message); }
      const error = new Error(`programacion_incierta: ${conv?.razon || 'desconocido'}`);
      error.codigo = 'PROGRAMACION_INCIERTA';
      error.folio = folio;
      throw error;
    }
    await asegurarEnlacePago();
    try { await guardar(telefono, resultado, negocioId); }
    catch (e) { console.error(`[AGENTE] guardarPedido(${folio || '-'}) falló:`, e?.message); }
    console.log(`[AGENTE] evento=pedido_programado negocio=${negocioId} folio=${folio} para=${programadoPara}`);
    return desenlace({ programado_para: programadoPara });
  }

  Promise.resolve().then(() => emitir(resultado)).catch((e) =>
    console.error(`[AGENTE] emitirPedido(${folio || '-'}) falló:`, e?.message));
  try { await guardar(telefono, resultado, negocioId); }
  catch (e) { console.error(`[AGENTE] guardarPedido(${folio || '-'}) falló:`, e?.message); }

  await asegurarEnlacePago();
  return desenlace();
}

export { CIERRE };
