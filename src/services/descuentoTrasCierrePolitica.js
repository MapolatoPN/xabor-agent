/**
 * descuentoTrasCierrePolitica.js — a quién se le manda el descuento por no
 * haberlo atendido, y con qué texto. PURO: no lee la base ni el reloj.
 *
 * Decisión de Mario (10-nov-2026), empezando por Acuña: quien escribió en el
 * horario habitual de servicio un día en que el negocio estuvo cerrado (el
 * domingo de Acuña, o un día con cierre especial) recibe, al abrir, un código
 * de descuento para la tienda en línea. A los del 8-nov no se les manda: su
 * ventana de 24 h ya había vencido. Esto queda listo para los siguientes.
 *
 * Por qué al abrir y no después: WhatsApp solo deja escribirle a alguien sin
 * plantilla durante las 24 h siguientes a su último mensaje. Un mensaje del
 * domingo a las 10:00 todavía se puede contestar el lunes a las 7:30, no a las
 * 10:30.
 *
 * Todo nace APAGADO: sin `cerrado_descuento_codigo` en la configuración del
 * negocio no se manda nada.
 */
import { evaluarHorarioLocal, minutosDeHorario } from './horarioSemanal.js';
import { telefonoAvisable } from './avisosEstadoPedido.js';

export const CLAVE_CODIGO = 'cerrado_descuento_codigo';
export const VENTANA_CLIENTE_HORAS = 24;
// Con menos de esto por delante, el mensaje podría llegar a Meta con la
// ventana ya cerrada: mejor no mandarlo.
export const MARGEN_VENTANA_MIN = 10;
// El texto dice cuánto descuenta: solo los tipos que se pueden decir así.
export const TIPOS_QUE_SE_DICEN = Object.freeze(['porcentaje', 'monto_fijo']);
// Decisión de Mario (11-nov-2026): el código vence a los 7 días y el mensaje
// lo dice. Vale hasta el FINAL de ese día, en la zona del negocio.
export const DIAS_VIGENCIA_CODIGO = 7;
const MESES = Object.freeze(['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre']);

const DIAS = Object.freeze(['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']);
const NOMBRES_DIAS = Object.freeze({
  domingo: 'domingo', lunes: 'lunes', martes: 'martes', miercoles: 'miércoles',
  jueves: 'jueves', viernes: 'viernes', sabado: 'sábado',
});
const diaDeFecha = (fecha) => DIAS[new Date(`${fecha}T12:00:00Z`).getUTCDay()];

/** El código tal como se guarda en tienda_promociones; null = apagado. */
export function codigoConfigurado(cfg) {
  const codigo = String(cfg?.[CLAVE_CODIGO] ?? '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{1,29}$/.test(codigo) ? codigo : null;
}

function tramoDe(horario) {
  if (horario?.abierto !== true) return null;
  const inicio = minutosDeHorario(horario.apertura);
  const fin = minutosDeHorario(horario.cierre, { cierre: true });
  // Una jornada que cruza la medianoche no tiene un «horario habitual» que se
  // pueda comparar contra la hora de un mensaje: no se adivina.
  return inicio !== null && fin !== null && fin > inicio ? { inicio, fin } : null;
}

/**
 * El horario habitual de servicio de una fecha: el de ese día de la semana si
 * ese día abre (y aun así estuvo cerrado: un cierre especial); si no abre
 * nunca (el domingo de Acuña), de la apertura más temprana al cierre más tarde
 * de los días que sí abren. null si no hay uno confiable.
 */
export function horarioHabitual(reglas, fecha) {
  const horarios = reglas?.horarios || {};
  const abiertos = DIAS.map((d) => horarios[d]).filter((h) => h?.abierto === true);
  if (!abiertos.length) return null;
  const tramos = abiertos.map(tramoDe);
  if (tramos.some((t) => !t)) return null;
  const propio = tramoDe(horarios[diaDeFecha(fecha)]);
  if (propio) return propio;
  return { inicio: Math.min(...tramos.map((t) => t.inicio)), fin: Math.max(...tramos.map((t) => t.fin)) };
}

/** ¿Llegó en horario habitual de servicio con el negocio cerrado? */
export function llegoCerradoEnHorarioHabitual(reglas, fecha, minuto) {
  const habitual = horarioHabitual(reglas, fecha);
  if (!habitual || !(minuto >= habitual.inicio && minuto < habitual.fin)) return false;
  const e = evaluarHorarioLocal(reglas, fecha, minuto);
  return e.abierto === false && e.horarioInvalido !== true;
}

/** ¿El negocio estaba abierto en ese minuto? */
export function estabaAbierto(reglas, fecha, minuto) {
  return evaluarHorarioLocal(reglas, fecha, minuto).abierto === true;
}

/**
 * Lo que se decide sobre UN teléfono.
 *
 * `c`: {
 *   telefono,
 *   entrantes: [{ at: ms, fecha, minuto }]  // sus mensajes de las últimas 24 h, en orden
 *   humanoDespues, pedidoDespues, pausado, enRevision, yaEnviado,
 * }
 * Devuelve { enviar, razon, primero }: `primero` es el primer mensaje que
 * calificó (con él se calcula «ayer» y se miran respuestas y pedidos).
 */
export function decidirEnvio(c, { reglas, ahoraMs }) {
  if (!telefonoAvisable(c?.telefono)) return { enviar: false, razon: 'telefono_tecnico' };
  if (c.yaEnviado) return { enviar: false, razon: 'ya_enviado' };
  const entrantes = Array.isArray(c.entrantes) ? c.entrantes : [];
  const primero = entrantes.find((m) => llegoCerradoEnHorarioHabitual(reglas, m.fecha, m.minuto));
  if (!primero) return { enviar: false, razon: 'sin_mensaje_en_cierre' };
  // Si volvió a escribir con el negocio abierto, ya lo están atendiendo (el
  // bot o el personal): un «lamentamos no atenderte» en medio de esa
  // conversación no tiene sentido.
  if (entrantes.some((m) => m.at > primero.at && estabaAbierto(reglas, m.fecha, m.minuto))) {
    return { enviar: false, razon: 'ya_escribio_abierto', primero };
  }
  if (c.humanoDespues) return { enviar: false, razon: 'ya_lo_atendio_el_personal', primero };
  if (c.pedidoDespues) return { enviar: false, razon: 'ya_pidio', primero };
  // Una conversación en manos del personal la decide el personal.
  if (c.pausado || c.enRevision) return { enviar: false, razon: 'conversacion_con_el_personal', primero };
  const ultimo = entrantes[entrantes.length - 1];
  const quedanMin = (ultimo.at + VENTANA_CLIENTE_HORAS * 3600000 - ahoraMs) / 60000;
  if (!(quedanMin >= MARGEN_VENTANA_MIN)) return { enviar: false, razon: 'ventana_vencida', primero };
  return { enviar: true, razon: 'enviar', primero };
}

const conDosDecimales = (n) => {
  const v = Math.round(Number(n) * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
};

/** «ayer», «hace un rato» o «el domingo», según la fecha del primer mensaje. */
export function cuandoFue(fechaMensaje, fechaHoy) {
  if (fechaMensaje === fechaHoy) return 'hace un rato';
  const ayer = new Date(`${fechaHoy}T12:00:00Z`);
  ayer.setUTCDate(ayer.getUTCDate() - 1);
  if (ayer.toISOString().slice(0, 10) === fechaMensaje) return 'ayer';
  return `el ${NOMBRES_DIAS[diaDeFecha(fechaMensaje)]}`;
}

/** El último día en que vale el código que se manda hoy ('YYYY-MM-DD'). */
export function venceEl(fechaHoy, dias = DIAS_VIGENCIA_CODIGO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fechaHoy || ''))) return null;
  const d = new Date(`${fechaHoy}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** 'lunes 23 de noviembre'. */
export function fechaEnPalabras(fecha) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) return null;
  const [, m, d] = fecha.split('-').map(Number);
  return `${NOMBRES_DIAS[diaDeFecha(fecha)]} ${d} de ${MESES[m - 1]}`;
}

/**
 * El mensaje (texto de Mario del 10-nov, con el enlace directo a la tienda del
 * negocio: el código solo existe en ese negocio, y la fecha en que vence, en
 * su propia línea para que se vea). null si la promoción no se puede decir con
 * un número o si no hay fecha de vencimiento: no se promete sin fecha.
 */
export function textoDelDescuento({ codigo, tipo, valor, enlace, cuando = 'ayer', vence }) {
  if (!codigo || !enlace || !TIPOS_QUE_SE_DICEN.includes(tipo) || !(Number(valor) > 0)) return null;
  const hasta = fechaEnPalabras(vence);
  if (!hasta) return null;
  const cuanto = tipo === 'porcentaje' ? `${conDosDecimales(valor)} %` : `$${conDosDecimales(valor)}`;
  return `¡Hola! 👋 Lamentamos no haberte atendido ${cuando}: estábamos cerrados. `
    + `Para compensarte, aquí tienes un descuento de ${cuanto} en nuestra tienda en línea con el código ${codigo}:\n`
    + `${enlace}\n\n⏰ Válido hasta el ${hasta}.\n\n¡Ya estamos en servicio! ☀️`;
}

/** Para los logs: nunca el teléfono completo. */
export const telefonoEnmascarado = (t) => `***${String(t || '').slice(-4)}`;
