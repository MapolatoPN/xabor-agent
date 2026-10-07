// ─── LAS PAUSAS DEL BOT POR CONVERSACIÓN VENCEN (P3, 3-oct-2026) ─────────
//
// Obispado tenía 63 conversaciones con el bot en pausa y ninguna iba a volver
// sola: una pausa solo se quitaba con el botón del panel o con soltar()
// (whatsappContinuidad.js), y soltar() solo mira tres motivos de duda de
// catálogo. Un traspaso del agente, una solicitud de persona o una pausa
// manual olvidada dejaban al cliente sin bot PARA SIEMPRE: escribía días
// después y nadie le contestaba.
//
// El dueño decidió: la pausa vence a las 12 horas sin mensajes del personal,
// INCLUIDAS las manuales. Este archivo es la POLÍTICA, pura: sin base, sin
// red y sin reloj. Recibe hechos ya medidos (las edades se calculan en SQL con
// now(), porque `mensajes.timestamp` no tiene zona) y decide. Así se prueba
// cada guarda sin Postgres, y el job (vencimientoPausasWhatsapp.js) y la
// proyección del panel (estadoAtencionConversacion.js) leen las mismas claves.
//
// Todo nace APAGADO. Sin `whatsapp_pausa_vence_horas` en la configuración del
// negocio no se libera nada.

export const CLAVE_HORAS = 'whatsapp_pausa_vence_horas';
// 'true' = también vencen las pausas que puso una persona (o cuyo origen no se
// puede probar). Hasta la fase 2 del panel conviene dejarla apagada: la
// tarjeta del chat dice «Pausa manual: no vence automáticamente».
export const CLAVE_MANUALES = 'whatsapp_pausa_vence_manuales';
// 'true' = solo registra en la bitácora lo que liberaría; no toca ninguna pausa.
export const CLAVE_SIMULAR = 'whatsapp_pausa_vence_simular';
// 'true' = también vencen las peticiones explícitas de una persona que nadie
// del equipo llegó a contestar. Revierte la decisión escrita en
// whatsappContinuidad.js («una petición explícita de atención humana necesita
// revisión, aunque nadie haya entrado»), así que va aparte y apagada.
export const CLAVE_SIN_ATENDER = 'whatsapp_pausa_vence_sin_atender';
// 'true' = además, UN resumen por WhatsApp al encargado (`wa_admin_numero`)
// por negocio y corrida. El dueño prefiere revisar los avisos al entrar al
// sistema, no por WhatsApp (3-oct): sin esta bandera no sale ningún mensaje y
// lo liberado queda en la bitácora (113) y en /estado-bot.
export const CLAVE_AVISO_WHATSAPP = 'whatsapp_pausa_vence_aviso_whatsapp';

// Por debajo de 6 horas el agente retomaría un carrito viejo: es el mismo
// corte que HORAS_PARA_REABRIR (cicloDelAgente.js), a partir del cual el
// agente ya abre un ciclo nuevo. Una prueba exige que los dos coincidan; no
// se importa para no arrastrar el ejecutor entero a la proyección del panel.
export const HORAS_MINIMAS = 6;

// Mientras el último mensaje del cliente no tenga respuesta de una persona y
// la ventana de atención de Meta siga abierta, la conversación NO se libera:
// liberarla marcaría ese mensaje como revisado y el panel dejaría de mostrar
// que alguien espera, justo cuando todavía se le puede contestar.
export const VENTANA_CLIENTE_HORAS = 24;

/** Horas configuradas. Vacío, 0, negativo o inválido = APAGADO (null). */
export function horasDeVencimiento(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  if (!texto) return null;
  const n = Number(texto);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(n, HORAS_MINIMAS);
}

/** Solo la cadena 'true' enciende: cualquier otra cosa es apagado. */
export const banderaEncendida = (valor) => String(valor ?? '').trim() === 'true';

/**
 * ¿El negocio apagó soltar()? Espejo EXACTO de minutosDeEspera
 * (whatsappContinuidad.js): vacío o inválido = 30 min (encendido); un número
 * finito <= 0 = nunca soltar.
 */
export function soltarApagado(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') return false;
  const n = Number(String(valor).trim());
  return Number.isFinite(n) && n <= 0;
}

// ── Motivos de revisión. Lista CERRADA: lo que no está aquí no vence. ──────
//
// Los tres que ya libera soltar() a los 30 min, con su propia semántica. No
// se les pone un segundo dueño: solo entran si el negocio apagó soltar().
export const MOTIVOS_DE_SOLTAR = Object.freeze(new Set([
  'ESCALADA_MODELO', 'SIN_VERIFICAR_MENU', 'NEGATIVA_INTERCEPTADA',
]));
// El cliente (o el agente por él) pidió una persona o un servicio que solo
// atiende una persona, O el sistema le prometió una persona. Vencen solo si
// alguien del equipo llegó a escribir después de la revisión («atendida pero
// no cerrada»), salvo whatsapp_pausa_vence_sin_atender.
//
// Los tres del rescate (revisión del 3-oct) van AQUÍ y no como falla del
// sistema: en FORMULARIO_NO_CARGA y AGENTE_FALLO_REPETIDO el cliente leyó «te
// paso con alguien del equipo» (rescateHumano.js), y AGENTE_NO_PUDO_ATENDER es
// el catch del turno que reventó (whatsapp-meta.js, pasarAgenteARevision):
// liberarlos sin que nadie contestara dejaría la promesa sin cumplir.
export const MOTIVOS_PETICION = Object.freeze(new Set([
  'SOLICITUD_CLIENTE', 'AGENTE_PIDE_HUMANO', 'AGENTE_HANDOFF_PENDIENTE',
  'FACTURACION_REVISION_HUMANA', 'SOLICITUD_EVENTO', 'SOLICITUD_EVENTO_RESPUESTA_PROHIBIDA',
  'CATERING_DATOS_LISTOS', 'CATERING_REVISION_HUMANA', 'CATERING_CONFIGURACION_FALLIDA',
  'CATERING_SIN_RUTA_SEGURA',
  'AGENTE_NO_PUDO_ATENDER', 'AGENTE_FALLO_REPETIDO', 'FORMULARIO_NO_CARGA',
  // El modo formulario (recepcionista.js, MOTIVOS_RECEPCION en
  // frasesRecepcion.js): el cliente leyó «te paso con alguien». Todos menos
  // RECEPCION_QUEJA_PAGO, que habla de dinero y nunca vence.
  'RECEPCION_PEDIDO_ESCRITO', 'RECEPCION_FORMULARIO_NO_DISPONIBLE', 'RECEPCION_NO_PUEDE',
  'RECEPCION_PIDE_PERSONA', 'RECEPCION_INSISTE', 'RECEPCION_IMAGEN', 'RECEPCION_PEDIDO_EXTERNO',
  'RECEPCION_QUEJA', 'RECEPCION_RETRASO', 'RECEPCION_PROGRAMADO', 'RECEPCION_OTRO',
  'RECEPCION_TRAS_PERSONAL', 'RECEPCION_SIN_PRECONDICIONES',
]));
// Fallas del sistema sin promesa al cliente. Pasadas las horas, que el bot
// vuelva a atender. Que el turno no dejara nada por conciliar NO se supone por
// el motivo: lo comprueban `confirmacion_incierta` y
// `confirmacion_sin_resultado` (el libro de operaciones) en decidirVencimiento.
export const MOTIVOS_DE_SISTEMA = Object.freeze(new Set([
  'AGENTE_RESPUESTA_NO_ENTREGADA', 'AGENTE_RESPUESTA_VENCIDA',
  'RESPUESTA_TRUNCADA', 'SALIDA_INTERNA_NO_PUBLICABLE', 'SIN_CARTA_WHATSAPP',
]));
// NUNCA vencen: dinero o un efecto que nadie comprobó. Ya quedan fuera por no
// estar en la lista; se nombran para que la regla de «estado del agente»
// (abajo) los reconozca también en el texto del traspaso y en el outbox, donde
// SÍ pueden aparecer mezclados con un motivo que vence.
export const MOTIVOS_QUE_NUNCA_VENCEN = Object.freeze(new Set([
  'AGENTE_ESTADO_INCIERTO', 'AGENTE_CONFIRMACION_INCIERTA', 'AGENTE_RESPUESTA_INCIERTA',
  'AGENTE_HANDOFF_NO_CONFIRMADO', 'AGENTE_ENLACE_PAGO_FALLO', 'AGENTE_AFIRMO_CAMBIO_SIN_GUARDAR',
  'AGENTE_RESPUESTA_PROHIBIDA', 'EJECUCION_INTERRUMPIDA', 'EJECUCION_NO_VERIFICADA',
  'REENTREGA_LEGADA', 'SOBRE_LEGADO_INCOMPLETO', 'COMPROBANTE_PAGO',
  'PAGO_CONSULTA_PEDIDO_FALLIDA', 'PAGO_REVISION_NO_CONFIRMADA',
  'CATERING_PURGA_NO_PERSISTIDA', 'CATERING_CAMBIO_A_PEDIDO_NO_GUARDADO',
]));

/** 'continuidad' | 'peticion' | 'sistema' | null (no vence). */
export function grupoDelMotivo(motivo) {
  const m = String(motivo ?? '').trim();
  if (MOTIVOS_QUE_NUNCA_VENCEN.has(m)) return null;
  if (MOTIVOS_DE_SOLTAR.has(m)) return 'continuidad';
  if (MOTIVOS_PETICION.has(m)) return 'peticion';
  if (MOTIVOS_DE_SISTEMA.has(m)) return 'sistema';
  return null;
}

// El motivo que el modelo escribe en `pedir_humano` es texto libre («el
// cliente dice que ya pagó»). Un texto que habla de dinero se trata como
// dinero: fallo cerrado. Equivocarse aquí deja la pausa como está hoy, así
// que la lista es ANCHA a propósito: «cambio» también atrapa «un cambio en su
// pedido», y esa pausa simplemente no vence. Se compara sin acentos.
const PALABRAS_DE_DINERO = new RegExp(`\\b(?:${[
  'pag[oaue]\\w*',            // pago, pagó, pagué, pagar, paga
  'cobr\\w*',                 // cobro, cobraron, cobrar
  'reembols\\w*', 'devol\\w*', 'devuel\\w*', // reembolso, devolución, devolver, devuelvan
  'transf(?:er|ir|ier)\\w*',  // transferencia, transferí, transfirió, transfiero
  'tarjeta\\w*', 'enlace\\w*', 'dinero', 'efectivo', 'cambio\\w*', 'propina\\w*',
  'comprobante\\w*', 'voucher\\w*', 'ticket\\w*', 'deposit\\w*',
  'cargo\\w*', 'cargaron', 'cargad[oa]s?', // «cargo duplicado», «me cargaron dos veces»
  'spei', 'clabe', 'oxxo',
].join('|')})\\b`, 'i');

/**
 * ¿Este motivo (código o texto libre) es de dinero o de un efecto incierto?
 * Se usa con lo que guardó el AGENTE, no solo con el motivo de la revisión:
 * `whatsapp_conversaciones.motivo` conserva el PRIMER motivo, y un turno puede
 * pedir persona (AGENTE_PIDE_HUMANO) y después descubrir una confirmación
 * incierta o un enlace de pago fallido que ya no se anota en la revisión.
 */
export function motivoDeDineroOIncierto(motivo) {
  if (motivo === null || motivo === undefined) return false;
  const m = String(motivo).trim();
  if (!m) return false;
  if (MOTIVOS_QUE_NUNCA_VENCEN.has(m)) return true;
  if (/^[A-Z0-9_]+$/.test(m)) {
    // Un código que no conocemos pero habla de pago, cobro o incertidumbre.
    return /(?:^|_)(?:PAGO|PAGOS|COBRO|COMPROBANTE|ENLACE|SOBREPAGO)(?:_|$)/.test(m)
      || /INCIERT|NO_CONFIRMAD|NO_VERIFICAD|INTERRUMPID|NO_PERSISTID|SIN_GUARDAR/.test(m);
  }
  const plano = m.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return PALABRAS_DE_DINERO.test(plano) || /incierto|incierta/i.test(plano);
}

/**
 * De quién es la pausa, solo con evidencia POSITIVA.
 *  · 'manual'      — una persona la puso: `updated_by` con usuario, o la
 *                    última acción del panel sobre ese teléfono fue «Tomar
 *                    conversación» (el bot sobrescribe `updated_by` a NULL si
 *                    escala encima de una pausa manual).
 *  · 'automatica'  — hay revisión durable (`requiere_revision`), que solo pone
 *                    el sistema, y ninguna persona la tomó.
 *  · 'huerfana'    — sin revisión, pero nació con una solicitud de servicio
 *                    del menú (la pausa y la ficha van en la misma
 *                    transacción) cuyo aviso nunca marcó la revisión.
 *  · 'desconocida' — todo lo demás: el relleno de la migración 066 o un NULL
 *                    sin rastro. Se trata igual que una manual.
 * `updated_by` de una conversación NO pausada no prueba nada: «Devolver al
 * bot» también lo escribe.
 */
export function clasificarOrigen(f) {
  const pausada = f?.bot_pausado === true;
  if (pausada && (f.updated_by || f.ultima_accion === 'tomar_conversacion')) return 'manual';
  if (f?.requiere_revision === true) return 'automatica';
  if (f?.solicitud_servicio === true) return 'huerfana';
  return 'desconocida';
}

/**
 * LA DECISIÓN. `f` es una fila de la consulta del job (hechos medidos en SQL).
 * Devuelve { vence, razon, origen, grupo }. Cada `razon` de no vencer es una
 * guarda distinta, y cada una tiene su prueba de mordida.
 */
export function decidirVencimiento(f, { horas = null, incluirManuales = false, venceSinAtender = false } = {}) {
  const no = (razon, origen = null) => ({ vence: false, razon, origen, grupo: null });
  if (!horas) return no('apagado');
  if (!f) return no('sin_datos');
  // Con el interruptor maestro apagado ninguna automatización contesta:
  // liberar la pausa no le daría respuesta a nadie y borraría la señal.
  if (f.bot_whatsapp_activo !== true) return no('bot_del_negocio_apagado');
  const pausada = f.bot_pausado === true;
  const enRevision = f.requiere_revision === true;
  if (!pausada && !enRevision) return no('sin_pausa');

  const origen = clasificarOrigen(f);
  if (origen !== 'automatica' && !incluirManuales) return no('manual_excluida', origen);

  let grupo = null;
  if (enRevision) {
    grupo = grupoDelMotivo(f.motivo);
    if (!grupo) return no('motivo_no_vence', origen);
    // soltar() la libera a su hora y con su semántica (sin reiniciar el
    // agente). Solo si nadie la tomó, como el propio soltar() comprueba.
    if (grupo === 'continuidad' && !f.updated_by && !soltarApagado(f.minutos_soltar)) {
      return no('la_suelta_continuidad', origen);
    }
  }

  // Dinero y efectos inciertos, mirando lo que guardó el AGENTE.
  // `confirmacionIncierta` es lo único que impide abrir otro ciclo y registrar
  // el pedido dos veces (cicloDelAgente.js): solo la quita el acuse humano.
  if (f.confirmacion_incierta === true) return no('confirmacion_incierta', origen);
  // La marca anterior vive en el ESTADO del turno y se pierde si su commit
  // falla (el caso de AGENTE_NO_PUDO_ATENDER). El libro de operaciones no: la
  // reserva de confirmar_pedido es durable y ANTES del efecto. Una que quedó
  // 'pendiente' o 'error' en esta conversación es un pedido que pudo
  // registrarse; reiniciar el agente con identidad nueva saltaría su índice
  // único (uq_agente_confirmacion_conversacion) y su conciliación.
  if (f.confirmacion_sin_resultado === true) return no('confirmacion_sin_resultado', origen);
  if (motivoDeDineroOIncierto(f.handoff_motivo)) return no('traspaso_de_dinero_o_incierto', origen);
  if ((f.motivos_agente || []).some(motivoDeDineroOIncierto)) return no('agente_marco_dinero_o_incierto', origen);
  if (f.pedido_esperando_pago === true) return no('pedido_esperando_pago', origen);

  // Alguien atiende ahora mismo desde la Business App.
  if (f.takeover_vigente === true) return no('takeover_vigente', origen);
  // Un turno en vuelo nunca se pisa. Con revisión, lo 'pendiente' es lo que
  // el cliente escribió después del traspaso («ok», «gracias»): se marca
  // revisado al liberar, igual que el botón y soltar(). Sin revisión, un
  // 'pendiente' es un lote que el barrido todavía va a procesar.
  if (Number(f.entradas_procesando) > 0) return no('turno_en_curso', origen);
  if (!enRevision && Number(f.entradas_pendientes) > 0) return no('lote_por_procesar', origen);
  // El último mensaje es del cliente, nadie del equipo le contestó después y
  // todavía se le puede contestar (ventana de 24 h de Meta).
  if (f.cliente_esperando === true) return no('cliente_esperando', origen);
  // Petición explícita nunca contestada: se avisa, no se libera.
  if (grupo === 'peticion' && f.humano_tras_revision !== true && !venceSinAtender) {
    return no('peticion_sin_atender', origen);
  }

  const h = Number(f.horas_sin_personal);
  if (f.horas_sin_personal === null || f.horas_sin_personal === undefined || !Number.isFinite(h) || h < horas) {
    return no('reciente', origen);
  }
  return { vence: true, razon: 'vence', origen, grupo };
}

/** Opciones de la decisión a partir de las claves crudas de configuración. */
export function opcionesDeConfiguracion(cfg = {}) {
  return {
    horas: horasDeVencimiento(cfg[CLAVE_HORAS]),
    incluirManuales: banderaEncendida(cfg[CLAVE_MANUALES]),
    venceSinAtender: banderaEncendida(cfg[CLAVE_SIN_ATENDER]),
    simular: banderaEncendida(cfg[CLAVE_SIMULAR]),
    avisoWhatsapp: banderaEncendida(cfg[CLAVE_AVISO_WHATSAPP]),
  };
}

// ── El resumen para el encargado ──────────────────────────────────────────

const ETIQUETA_ORIGEN = {
  automatica: 'revisión del bot',
  manual: 'pausa manual',
  huerfana: 'pausa de una solicitud del menú',
  desconocida: 'pausa sin origen registrado',
};
export const ETIQUETA_MOTIVO = {
  SOLICITUD_CLIENTE: 'el cliente pidió una persona',
  AGENTE_PIDE_HUMANO: 'el asistente pidió una persona',
  AGENTE_HANDOFF_PENDIENTE: 'el asistente pidió una persona',
  FACTURACION_REVISION_HUMANA: 'facturación',
  SOLICITUD_EVENTO: 'evento',
  SOLICITUD_EVENTO_RESPUESTA_PROHIBIDA: 'evento',
  AGENTE_NO_PUDO_ATENDER: 'el asistente no pudo atender',
  AGENTE_FALLO_REPETIDO: 'el asistente falló dos veces',
  FORMULARIO_NO_CARGA: 'el formulario no le cargó',
  // Modo formulario (frasesRecepcion.js, ETIQUETAS_RECEPCION[…].pausa).
  RECEPCION_PEDIDO_ESCRITO: 'escribió su pedido',
  RECEPCION_FORMULARIO_NO_DISPONIBLE: 'no se pudo abrir el formulario de pedido',
  RECEPCION_NO_PUEDE: 'el cliente no pudo usar el formulario',
  RECEPCION_PIDE_PERSONA: 'el cliente pidió hablar con una persona',
  RECEPCION_INSISTE: 'el bot no entendió al cliente dos veces',
  RECEPCION_IMAGEN: 'el cliente mandó una imagen',
  RECEPCION_PEDIDO_EXTERNO: 'dice que ya hizo su pedido',
  RECEPCION_QUEJA: 'queja del cliente',
  RECEPCION_QUEJA_PAGO: 'queja sobre un cobro',
  RECEPCION_RETRASO: 'el cliente reclama por la espera',
  RECEPCION_PROGRAMADO: 'quiere un pedido para otro día',
  RECEPCION_OTRO: 'vacante o proveedor',
  RECEPCION_TRAS_PERSONAL: 'el cliente escribió después del personal',
  RECEPCION_SIN_PRECONDICIONES: 'el modo formulario no pudo operar',
};

/** Los últimos 4 dígitos y nada más: un aviso no es sitio para un teléfono. */
export const telefonoEnmascarado = (t) => {
  const s = String(t ?? '').replace(/\D/g, '');
  return s.length >= 4 ? `***${s.slice(-4)}` : '***';
};

/**
 * UN mensaje por negocio y corrida, no uno por conversación: la primera
 * activación puede liberar muchas de golpe.
 */
export function textoDelResumen(liberadas, horas, { maximo = 15 } = {}) {
  const n = liberadas.length;
  const lineas = liberadas.slice(0, maximo).map((l) => {
    const partes = [telefonoEnmascarado(l.telefono)];
    const nombre = String(l.nombre ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (nombre) partes.push(nombre);
    const origen = ETIQUETA_ORIGEN[l.origen] || 'pausa';
    const motivo = l.motivo ? (ETIQUETA_MOTIVO[l.motivo] || l.motivo) : null;
    partes.push(motivo ? `${origen}: ${motivo}` : origen);
    const h = Number(l.horas_sin_personal);
    if (Number.isFinite(h)) partes.push(`${Math.floor(h)} h sin mensajes del equipo`);
    return `• ${partes.join(' · ')}`;
  });
  if (n > maximo) lineas.push(`… y ${n - maximo} más.`);
  return `⏱️ *Xabor*: el bot retomó ${n === 1 ? 'una conversación' : `${n} conversaciones`} `
    + `que llevaba${n === 1 ? '' : 'n'} más de ${horas} h sin mensajes del equipo.\n\n`
    + `${lineas.join('\n')}\n\n`
    + 'Si alguna sigue pendiente, tómenla otra vez desde el panel, en Chats.';
}
