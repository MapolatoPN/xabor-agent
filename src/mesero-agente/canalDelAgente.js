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
  pool, obtenerMenuCompleto, obtenerConfiguracion, guardarPedido, obtenerMetodosPagoDisponibles,
  obtenerReservaProgramadaPorFolio,
} from '../services/database.js';
import { crearEnlacePago } from '../services/pagosService.js';
import { obtenerConfigTienda } from '../services/tiendaOnline.js';
import { TZ_DEFAULT } from '../services/zonaHoraria.js';
import {
  registrarPedido, emitirPedido, previsualizarPedido, convertirPedidoAProgramado,
  retirarProgramadoFallidoDeMemoria,
} from '../orders/orderManager.js';
import { esPagoPorEnlace } from '../orders/pagoPorEnlace.js';
import { atenderTurnoConHerramientas, CIERRE } from './agenteDelMesero.js';
import { estadoNuevo, estadoSerializable } from './ejecutorDeHerramientas.js';
import { libroDeOperaciones, almacenEnPostgres, almacenEnMemoria } from './libroDeOperaciones.js';
import { productosVendibles } from '../mesero-whatsapp/consultasDelMenu.js';
import { cicloParaTurno } from './cicloDelAgente.js';
import { depurarPagoNoDisponible } from './politicaDePagos.js';
import { cargarReglas, obtenerEstadoRestaurante } from '../agent/prompts.js';
import {
  depurarModalidadNoDisponible, etiquetaTipoModalidad, modalidadesDisponibles,
} from '../orders/modalidadesDelPedido.js';
import {
  esSolicitudDePedidoProgramado, respuestaAfirmaCambioSinAplicar,
  fusionarReferenciaProgramacion, pideQuitarProgramacion,
  referenciaProgramacionSegura, referenciasTemporalesDePedido,
  TEXTO_CAMBIO_NO_GUARDADO,
} from './seguridadConversacional.js';
import { construirAvisoFueraDeHorario } from './horarioDelAgente.js';
import { reglasDelAsistenteEnTexto, respuestaProhibidaEncontrada } from './reglasDelAsistente.js';
import {
  MENSAJE_CATERING_ENTREGADO, MENSAJE_CATERING_REVISION,
  cancelaSolicitudCatering, esSolicitudCatering,
  motivoRespuestaCateringProhibida, preguntaSiguienteCatering, TEXTO_CATERING_CANCELADO,
} from '../agent/catering.js';
import {
  eventoCateringPublico, eventoCateringVerificado, filtrarDatosEventoCatering,
  retirarCamposEventoCatering,
} from '../agent/evidenciaCatering.js';

// Un teléfono nunca sale de aquí entero hacia un log o una cola: se queda en
// los últimos cuatro dígitos, que bastan para cruzarlo con una conversación
// real si hace falta y no identifican a nadie por sí solos.
export const telefonoCorto = (t) => {
  const d = String(t ?? '').replace(/[^0-9]+/g, '');
  return d ? `…${d.slice(-4)}` : '';
};

/**
 * Última palabra sobre catering: el texto del modelo nunca puede cotizar ni
 * prometer agenda, aunque la herramienta se haya usado correctamente.
 */
export function prepararEstadoCatering(estado, mensaje, { nombreConfiable = null } = {}) {
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
const claveDeSesion = (telefono, { sombra = false } = {}) =>
  `${sombra ? 'agente-sombra' : 'agente'}:${telefono}`;

export async function leerEstado(negocioId, telefono, { sombra = false } = {}) {
  const sessionId = claveDeSesion(telefono, { sombra });
  // Solo una lectura exitosa sin filas significa conversación nueva. Si la
  // base falla, atender con un carrito vacío podría duplicar un pedido previo.
  const { rows } = await pool.query(
    'SELECT estado, actualizado_at FROM conversacion_estado WHERE negocio_id = $1 AND session_id = $2',
    [negocioId, sessionId]);
  // La fecha del ULTIMO escrito viaja con el estado para que `cicloParaTurno`
  // pueda reabrir un ciclo terminado por antiguedad. Va con guion bajo porque
  // no es parte del estado: es un dato de la fila que lo guarda.
  if (rows[0]?.estado) {
    return { ...rows[0].estado, _actualizadoAt: rows[0].actualizado_at?.toISOString?.() || null };
  }
  return estadoNuevo({ negocioId, conversacionId: sessionId });
}

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
export function marcarProgramacionRequerida(estado, mensaje, { fechaHoy = null } = {}) {
  if (!estado) return false;
  const programadoAnterior = estado.carrito?.datos?.programado_para || null;
  const referenciaAnterior = referenciaProgramacionSegura(estado.referenciaProgramacion);
  const habiaProgramacion = estado.programacionRequerida === true
    || !!programadoAnterior || !!referenciaAnterior;
  const detectada = esSolicitudDePedidoProgramado(mensaje, {
    // Una fecha pendiente ya ES un ciclo de pedido aunque todavía no tenga
    // renglones. Así «mañana» y, en el turno siguiente, «a las 10» no se
    // separan cuando el canal productivo no manda historial al modelo.
    hayPedidoEnCurso: (estado.carrito?.items || []).length > 0 || habiaProgramacion,
    hayProgramacionPrevia: habiaProgramacion,
  });
  if (detectada) {
    const nuevas = referenciasTemporalesDePedido(mensaje);
    estado.programacionRequerida = true;
    estado.referenciaProgramacion = fusionarReferenciaProgramacion(
      referenciaAnterior,
      nuevas,
      { isoAnterior: programadoAnterior, fechaAncla: fechaHoy },
    );
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
  if (pideQuitarProgramacion(mensaje, {
    hayProgramacionPrevia: habiaProgramacion,
  })) {
    estado.programacionRequerida = false;
    estado.referenciaProgramacion = null;
    if (estado.carrito?.datos) delete estado.carrito.datos.programado_para;
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
export function ordenDesdeElCarrito({ negocioId, carrito, telefono, nombre }) {
  const datos = carrito?.datos || {};
  const cli = datos.cliente || {};
  return {
    negocioId,
    telefono_conversacion: telefono,
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
 * ATIENDE UN TURNO DE VERDAD.
 *
 * Devuelve `{ ok, texto, folio, escalado, pedido, operaciones }`. Quien llama
 * —el canal— manda `texto` por WhatsApp. Si `ok` es false, el canal debe
 * pausar la conversación y pedir revisión humana. El agente nunca debe
 * devolver el mismo turno al bot legacy después de un fallo.
 */
export async function atenderConAgente({
  negocioId, telefono, mensaje, nombre = null, canal = 'whatsapp',
  llamarModelo, historial = [], textoCiclo = '', turnoId = null,
  escalarAHumano = null, enviarMenu = null, registrar = registrarPedido, emitir = emitirPedido,
  guardar = guardarPedido, crearPago = crearEnlacePago, traza = null,
} = {}) {
  const t0 = Date.now();
  let estado = null;
  let salida = null;
  let confirmacionIntentada = false;
  try {
    const [catalogo, cfg, metodosPago, reglas, configTienda] = await Promise.all([
      obtenerMenuCompleto(negocioId),
      obtenerConfiguracion(negocioId).catch(() => ({})),
      obtenerMetodosPagoDisponibles(negocioId, { paraBot: true }),
      cargarReglas(negocioId),
      obtenerConfigTienda(negocioId).catch((e) => {
        console.error(`[AGENTE] no se pudo resolver la política de programados: ${e?.message}`);
        return null;
      }),
    ]);
    const estadoRestaurante = obtenerEstadoRestaurante(reglas);
    estado = cicloParaTurno(await leerEstado(negocioId, telefono), mensaje);
    const eventoActivo = prepararEstadoCatering(estado, mensaje, { nombreConfiable: nombre });
    const cancelacionCatering = consumirCancelacionCatering(estado);
    if (cancelacionCatering) {
      await guardarEstado(negocioId, telefono, estado);
      return { ok: true, ...cancelacionCatering };
    }
    if (!eventoActivo) marcarProgramacionRequerida(estado, mensaje, {
      fechaHoy: estadoRestaurante.fechaHoy,
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
    if (bloqueoPrevio === 'sin_catalogo') {
      // Sin carta no hay nada que el agente pueda hacer sin inventar.
      return { ok: false, motivo: 'sin_catalogo' };
    }

    // ── EL DESVÍO DE PEDIDOS PROGRAMADOS SE RETIRÓ ─────────────────────
    //
    // Este turno se detenía aquí porque el agente no tenía forma de escribir
    // la fecha, así que aceptar «mañana a las 10» en texto habría registrado
    // el pedido para HOY. Ya la tiene: `programar_para` valida la fecha
    // contra el horario del negocio y la confirmación la convierte en
    // reserva durable, que el job activa una hora antes de la entrega.
    //
    // El freno no desapareció, cambió de sitio: se movió al paso
    // irreversible. `confirmarYEmitir` se niega a registrar si el cliente
    // pidió otro día y no hay fecha fijada, así que un modelo que se olvide
    // de la herramienta no puede meter en cocina un pedido de mañana.
    // Frenar ANTES del modelo, además, le impedía hacerlo bien.
    const modalidades = Array.isArray(reglas?.pedidos?.modalidades) && reglas.pedidos.modalidades.length
      ? reglas.pedidos.modalidades : ['recoger en tienda', 'entrega a domicilio'];
    const promocionesActivas = estadoRestaurante.promocionesActivas || [];
    const modalidadDescartada = depurarModalidadNoDisponible(estado, modalidades);
    const pagoDescartado = depurarPagoNoDisponible(estado, metodosPago);
    const libro = libroDeOperaciones(almacenEnPostgres(pool));

    const efectos = {
      confirmar: async ({ pedido }) => {
        confirmacionIntentada = true;
        return confirmarYEmitir({
          negocioId, telefono, nombre, canal, estado, pedido, registrar, emitir, guardar, crearPago,
          previsualizar: previsualizarPedido,
          textoDelCiclo: textoCiclo || mensaje,
        });
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
      // Lo manda el módulo que ya existe y que además VERIFICA el envío: todas
      // las páginas en orden, un reintento, y su propio aviso honesto si algo
      // falla. Aquí no se reimplementa nada; se le pide y se le cree o no según
      // lo que conteste.
      enviarMenu: async () => {
        if (!enviarMenu) return { ok: false, motivo: 'sin_canal' };
        try {
          const r = await enviarMenu(negocioId, telefono);
          return r?.ok
            ? { ok: true, paginas: r.enviadas ?? null }
            : { ok: false, motivo: r?.motivo || 'envio_incompleto' };
        } catch (e) {
          return { ok: false, motivo: e?.message || 'error' };
        }
      },

      // ── UNA SOLICITUD DE EVENTO ────────────────────────────────────────
      //
      // El dato se queda en DOS sitios, y son dos a propósito:
      //
      //   · la conversación pasa a revisión humana, que es lo que hace que
      //     aparezca delante de alguien en el panel HOY;
      //   · y el evento se escribe en el outbox, que es el registro durable
      //     por si nadie mira el chat a tiempo.
      //
      // NO se mete en `sesiones_comerciales`: ese flujo existe para fabricar
      // una cotización con renglones y precios, y la decisión del dueño es la
      // contraria — se anotan cuatro datos y llama una persona. Meterlo ahí lo
      // pondría en manos de la maquinaria que sí cotiza.
      //
      // Límite conocido: `agente_outbox` todavía no tiene consumidor, así que
      // el registro durable no avisa por su cuenta. Quien se entera hoy es
      // quien abre el chat en el panel.
      registrarEvento: async ({ evento }) => {
        const entregado = await avisarAHumano(escalarAHumano, negocioId, telefono, 'SOLICITUD_EVENTO');
        try {
          await encolar(negocioId, [{
            tipo: TIPOS.SOLICITUD_EVENTO,
            carga: { ...evento, telefono: telefonoCorto(telefono), canal },
          }]);
        } catch (e) {
          console.error('[AGENTE] no se pudo encolar la solicitud de evento:', e.message);
        }
        console.log(`[AGENTE] evento=solicitud_evento negocio=${negocioId} `
          + `tipo=${evento.tipo_servicio} personas=${evento.personas ?? '-'} handoff=${entregado}`);
        return entregado
          ? { ok: true }
          : { ok: false, motivo: escalarAHumano ? 'handoff_no_entregado' : 'handoff_sin_destino' };
      },
    };

    salida = await atenderTurnoConHerramientas({
      negocioId,
      conversacionId: estado.conversacionId,
      turnoId: turnoId || `t${Date.now()}`,
      mensaje,
      historial,
      catalogo: Array.isArray(catalogo) ? catalogo : [],
      precios: preciosDelCatalogo(Array.isArray(catalogo) ? catalogo : []),
      requierePago: String(cfg?.pedido_requiere_pago ?? 'true').toLowerCase() !== 'false',
      metodosPago,
      modalidades,
      reglas,
      configTienda,
      promocionesActivas,
      zonaDelNegocio: reglas?.timezone,
      estado,
      libro,
      llamarModelo,
      efectos,
      contexto: {
        nombreNegocio: cfg?.nombre || cfg?.nombre_negocio || reglas?.restaurante || 'el restaurante',
        textoCiclo: textoCiclo || mensaje,
        datosConocidos: [telefono && telefono !== '—' ? `Teléfono: ${telefono}` : null,
          nombre ? `Nombre: ${nombre}` : null].filter(Boolean),
        tono: reglas?.bot?.tono || cfg?.tono_bot || null,
        reglasDelNegocio: reglasDelAsistenteEnTexto(reglas, { esPrimerTurno: Number(estado.turno || 0) === 0 }),
        metodosPago,
        pagoDescartado,
        modalidades,
        modalidadDescartada,
        estadoRestaurante,
      },
      modo: 'productivo',
      traza,
    });

    salida = aplicarRespuestaDeEntrega({ salida, modalidadDescartada, modalidades });
    salida = aplicarRespuestaDeConfirmacion({ salida, estado, zonaDelNegocio: reglas?.timezone });
    salida = aplicarRespuestaDePago({
      salida, estado, pagoDescartado, metodosPago, zonaDelNegocio: reglas?.timezone,
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
    // El aviso va ANTES de `guardarEstado` a propósito: si la misma caída que
    // rompió el turno se lleva también el guardado, lo único que no se puede
    // perder es la llamada a la persona.
    const desenlace = desenlaceDelTurno({ salida, confirmacionIntentada });

    // Si el agente YA escaló dentro del turno, este aviso es el segundo sobre
    // el mismo incidente, y se manda igual: dice algo que el primero no —«hay
    // un pedido que quizá exista y no está en el panel»— y suprimirlo pedía
    // llevar cuenta de lo enviado, que es un mecanismo más que puede fallar
    // callado. Fallar callado es justamente el defecto que se está cerrando.
    if (desenlace.motivoHandoff) {
      // `confirmacionIncierta` congela la conversación: `cicloDelAgente` no
      // abre un ciclo nuevo mientras esté puesta. Sin ella, un «quiero hacer
      // otro pedido» estrenaría `conversacion_id` y esquivaría la guardia del
      // libro, que es por conversación.
      if (desenlace.incierta) estado.confirmacionIncierta = true;
      if (await avisarAHumano(escalarAHumano, negocioId, telefono, desenlace.motivoHandoff)) {
        estado.hechos.escalado = true;
      }
      if (desenlace.texto) salida.texto = desenlace.texto;
    }

    await guardarEstado(negocioId, telefono, estado);

    console.log(`[AGENTE] evento=turno negocio=${negocioId} cierre=${salida.motivoCierre} `
      + `estado=${salida.pedido?.estado} ops=${salida.operaciones.length} `
      + `iter=${salida.iteraciones} ms=${salida.duracionMs}`);

    return { ok: true, ...salida };
  } catch (e) {
    console.error('[AGENTE] contenido en el adaptador:', e?.message);
    // Un efecto irreversible pudo ocurrir antes del error (por ejemplo,
    // registrarPedido hizo COMMIT y luego falló guardarEstado). En ese caso
    // el bot viejo NO debe volver a procesar este mismo mensaje.
    if (confirmacionIntentada || estado?.hechos?.confirmado || estado?.hechos?.escalado) {
      if (confirmacionIntentada) {
        await avisarAHumano(escalarAHumano, negocioId, telefono, 'AGENTE_ESTADO_INCIERTO');
      }
      return {
        ok: true,
        texto: estado?.hechos?.confirmado && estado.folio
          ? (salida?.texto || `Tu pedido ${estado.folio} quedó registrado. El equipo lo revisará.`)
          : 'Estoy revisando tu pedido con el equipo para evitar registrarlo dos veces. Te responderemos en breve.',
        folio: estado?.folio ?? null,
        escalado: !!estado?.hechos?.escalado,
        estadoIncierto: true,
      };
    }
    return { ok: false, motivo: e?.message || 'error', ms: Date.now() - t0 };
  }
}

/**
 * OBSERVA UN TURNO, sin efectos de ninguna clase.
 *
 * Mismo bucle, mismo ejecutor, mismo reconciliador. Lo que cambia:
 *
 *   · los efectos son grabadoras: no registra pedido, no escala, no imprime;
 *   · el estado vive en su propio espacio de nombres y no toca el productivo;
 *   · el libro de operaciones es de MEMORIA, así que ni siquiera escribe en la
 *     tabla de auditoría del agente productivo.
 *
 * Funciona con el bot apagado, que es exactamente cuando hace falta.
 */
export async function observarConAgente({
  negocioId, telefono, mensaje, nombre = null,
  llamarModelo, historial = [], textoCiclo = '', turnoId = null, traza = null,
} = {}) {
  const t0 = Date.now();
  try {
    const [catalogo, cfg, metodosPago, reglas, configTienda] = await Promise.all([
      obtenerMenuCompleto(negocioId),
      obtenerConfiguracion(negocioId).catch(() => ({})),
      obtenerMetodosPagoDisponibles(negocioId, { paraBot: true }),
      cargarReglas(negocioId),
      obtenerConfigTienda(negocioId).catch(() => null),
    ]);
    const estadoRestaurante = obtenerEstadoRestaurante(reglas);
    const estado = cicloParaTurno(await leerEstado(negocioId, telefono, { sombra: true }), mensaje);
    const eventoActivo = prepararEstadoCatering(estado, mensaje, { nombreConfiable: nombre });
    const cancelacionCatering = consumirCancelacionCatering(estado);
    if (cancelacionCatering) {
      await guardarEstado(negocioId, telefono, estado, { sombra: true });
      return { ok: true, ...cancelacionCatering, grabadas: [], linea: null };
    }
    if (!eventoActivo) marcarProgramacionRequerida(estado, mensaje, {
      fechaHoy: estadoRestaurante.fechaHoy,
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

    const modalidades = Array.isArray(reglas?.pedidos?.modalidades) && reglas.pedidos.modalidades.length
      ? reglas.pedidos.modalidades : ['recoger en tienda', 'entrega a domicilio'];
    const promocionesActivas = estadoRestaurante.promocionesActivas || [];
    const modalidadDescartada = depurarModalidadNoDisponible(estado, modalidades);
    const pagoDescartado = depurarPagoNoDisponible(estado, metodosPago);
    const grabadas = [];
    const salida = await atenderTurnoConHerramientas({
      negocioId,
      conversacionId: estado.conversacionId,
      turnoId: turnoId || `t${Date.now()}`,
      mensaje,
      historial,
      catalogo: Array.isArray(catalogo) ? catalogo : [],
      precios: preciosDelCatalogo(Array.isArray(catalogo) ? catalogo : []),
      requierePago: String(cfg?.pedido_requiere_pago ?? 'true').toLowerCase() !== 'false',
      metodosPago,
      modalidades,
      reglas,
      configTienda,
      promocionesActivas,
      zonaDelNegocio: reglas?.timezone,
      estado,
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
        estadoRestaurante,
      },
      modo: 'sombra',
      traza,
    });

    aplicarRespuestaDeEntrega({ salida, modalidadDescartada, modalidades });
    aplicarRespuestaDeConfirmacion({ salida, estado, zonaDelNegocio: reglas?.timezone });
    aplicarRespuestaDePago({
      salida, estado, pagoDescartado, metodosPago, zonaDelNegocio: reglas?.timezone,
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

    await guardarEstado(negocioId, telefono, estado, { sombra: true });

    // Una línea por turno, sin PII y con el prefijo que ya se busca en Railway.
    const linea = JSON.stringify({
      evt: 'agente_sombra', negocio: negocioId, cierre: salida.motivoCierre,
      estado: salida.pedido?.estado, renglones: salida.pedido?.lineas?.length ?? 0,
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
// Usa el mismo bucle, herramientas, prompt y reglas que WhatsApp. El estado y
// el libro viven solo en memoria; confirmar y escalar son efectos simulados.
const sesionesSimuladas = new Map();

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

  const [catalogo, cfg, metodosPago, reglas, configTienda] = await Promise.all([
    obtenerMenuCompleto(negocioId),
    obtenerConfiguracion(negocioId).catch(() => ({})),
    obtenerMetodosPagoDisponibles(negocioId, { paraBot: true }),
    cargarReglas(negocioId),
    obtenerConfigTienda(negocioId).catch(() => null),
  ]);
  const estadoRestaurante = obtenerEstadoRestaurante(reglas);
  sesion.estado = cicloParaTurno(sesion.estado, mensaje);
  const estado = sesion.estado;
  const eventoActivo = prepararEstadoCatering(estado, mensaje);
  const cancelacionCatering = consumirCancelacionCatering(estado);
  if (!eventoActivo) marcarProgramacionRequerida(estado, mensaje, {
    fechaHoy: estadoRestaurante.fechaHoy,
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
    if (bloqueoPrevio === 'sin_catalogo') throw new Error('El negocio no tiene catálogo disponible');
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
        catalogo: Array.isArray(catalogo) ? catalogo : [],
        precios: preciosDelCatalogo(Array.isArray(catalogo) ? catalogo : []),
        requierePago: String(cfg?.pedido_requiere_pago ?? 'true').toLowerCase() !== 'false',
        metodosPago,
        modalidades,
        reglas,
        configTienda,
        promocionesActivas,
        zonaDelNegocio: reglas?.timezone,
        estado,
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
          estadoRestaurante,
        },
        modo: 'simulacion',
      });

    aplicarRespuestaDeEntrega({ salida, modalidadDescartada, modalidades });
    aplicarRespuestaDeConfirmacion({ salida, estado, zonaDelNegocio: reglas?.timezone });
    aplicarRespuestaDePago({
      salida, estado, pagoDescartado, metodosPago, zonaDelNegocio: reglas?.timezone,
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
  }

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
  salida, estado, pagoDescartado = null, metodosPago = [], zonaDelNegocio = undefined,
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
    estado.pagoOfrecido = 'enlace_pago';
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
export function aplicarRespuestaDeConfirmacion({ salida, estado, zonaDelNegocio = undefined } = {}) {
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
  salida.texto = partes.join(' ');
  return salida;
}

/** La política de entrega también se redacta en código cuando el modelo pide algo no permitido. */
export function aplicarRespuestaDeEntrega({
  salida, modalidadDescartada = null, modalidades = [],
} = {}) {
  if (!salida) return salida;
  const entregaAplicada = (salida.operaciones || []).find((o) =>
    o?.herramienta === 'definir_entrega' && o?.resultado?.aplicado === true);
  const pedidoEntrega = entregaAplicada?.resultado?.pedido;
  const costoEnvio = Number(pedidoEntrega?.costo_envio);
  if (pedidoEntrega?.modalidad && pedidoEntrega.modalidad.toLowerCase().includes('domicilio')
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
    salida.texto = 'No contamos con servicio para comer aquí. Podemos preparar tu pedido para recoger '
      + 'o enviarlo a domicilio. ¿Cuál prefieres?';
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
}) {
  const orden = ordenDesdeElCarrito({ negocioId, carrito: estado.carrito, telefono, nombre });
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
    const mostrado = Number(pedido?.total);
    const canonico = Number(previa?.preview?.total);
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
  const programacionRequerida = estado?.programacionRequerida === true
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
    throw e;
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
