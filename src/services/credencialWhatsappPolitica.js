/**
 * credencialWhatsappPolitica.js — cuándo Meta rechazó la credencial de
 * WhatsApp de un negocio y cuándo se avisa. Pura: sin base, sin red, sin
 * reloj propio (todo llega por parámetro), para probarse sola.
 *
 * 30-oct-2026: la credencial de Obispado venció a los 60 días de conectarse
 * («The token has expired on Thursday, 29-Oct-26 13:02:01 PDT») y el bot
 * quedó mudo un día entero sin que nadie lo supiera. Cada respuesta fallida
 * pasaba a una persona, y la alerta al administrador sale por WhatsApp con
 * esa misma credencial. Las credenciales que da el registro de Meta (usuario
 * del sistema) vencen a los 60 días: Acuña, reconectada el 9-oct, vence el
 * 8-dic. El job (vigilanciaCredencialWhatsapp.js) pregunta a Meta cada pocos
 * minutos y avisa por notificación del panel, nunca por WhatsApp.
 */

// Prefijo de integraciones_canal.ultimo_error_codigo para este rechazo
// (`credencial:190`, `credencial:401`), con el mismo criterio de los demás
// códigos controlados (`registro:…`, `verificacion:…`). La reconexión lo
// limpia (integracionesService pone NULL) y el job también, cuando la
// credencial vuelve a funcionar. Nunca borra un código de otro origen.
export const PREFIJO_RECHAZO = 'credencial:';

// Interruptor por negocio en `configuracion`: 'false' apaga la vigilancia.
// Nace ENCENDIDA a propósito: solo lee de Meta y avisa; no cambia el envío,
// la recepción ni el estado de la integración.
export const CLAVE_APAGAR = 'whatsapp_vigilancia_credencial';

export const HORAS_ENTRE_RECORDATORIOS = 4;
export const HORAS_ENTRE_CONSULTAS_VENCIMIENTO = 6;
// Días antes del vencimiento en que se avisa; cada uno, una sola vez.
export const UMBRALES_VENCE_DIAS = Object.freeze([7, 3, 1]);
// Los recordatorios y los avisos de vencimiento solo salen de día (hora del
// negocio). El PRIMER aviso de un rechazo sale a cualquier hora.
export const HORA_INICIO_AVISOS = 7;
export const HORA_FIN_AVISOS = 22;

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;

/**
 * Lo que dijo Meta al consultar el número con la credencial del negocio:
 *   'ok'        — la credencial sirve;
 *   'rechazada' — Meta no la acepta (401, o los códigos 190/102 de OAuth):
 *                 vencida o retirada, hace falta reconectar;
 *   'incierta'  — red, 5xx, límite de llamadas, permisos u otro error: no se
 *                 concluye nada y no se cambia nada.
 */
export function clasificarSonda(sonda) {
  if (sonda?.ok === true) return 'ok';
  const codigo = sonda?.resumen?.codigo ?? null;
  if (sonda?.status === 401 || codigo === 190 || codigo === 102) return 'rechazada';
  return 'incierta';
}

export const codigoDeRechazo = (sonda) => `${PREFIJO_RECHAZO}${sonda?.resumen?.codigo ?? sonda?.status ?? 'desconocido'}`;
export const esCodigoDeRechazo = (codigo) => typeof codigo === 'string' && codigo.startsWith(PREFIJO_RECHAZO);

/** Hora local (0–23) de `ahora` en la zona del negocio. */
export function horaLocal(ahora, zona) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: zona, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ahora));
  return Number(h) % 24;
}

export function dentroDeHorarioDeAvisos(ahora, zona) {
  const h = horaLocal(ahora, zona);
  return h >= HORA_INICIO_AVISOS && h < HORA_FIN_AVISOS;
}

const ms = (v) => (v instanceof Date ? v.getTime() : Date.parse(v || ''));

/**
 * ¿Sale ahora una notificación del rechazo? El primer aviso de cada rechazo
 * (no hay aviso posterior a `detectadoAt`) sale siempre; después, un
 * recordatorio cada HORAS_ENTRE_RECORDATORIOS, solo de día.
 */
export function debeAvisarRechazo({ detectadoAt, ultimoAvisoAt, ahora, zona }) {
  const aviso = ms(ultimoAvisoAt);
  const detectado = ms(detectadoAt);
  if (!Number.isFinite(aviso) || (Number.isFinite(detectado) && aviso < detectado)) return true;
  if (!dentroDeHorarioDeAvisos(ahora, zona)) return false;
  return ahora - aviso >= HORAS_ENTRE_RECORDATORIOS * HORA_MS;
}

/**
 * El umbral de vencimiento (7, 3 o 1 días antes) que toca avisar ahora, o
 * null. `avisado` = { para, umbral }: el vencimiento y el umbral del último
 * aviso. Un vencimiento distinto (se reconectó) vuelve a empezar.
 */
export function umbralDeVencimiento({ venceAt, ahora, avisado = {} }) {
  const vence = ms(venceAt);
  if (!Number.isFinite(vence) || vence <= ahora) return null; // vencida: la detecta la consulta del número
  const dias = (vence - ahora) / DIA_MS;
  const umbral = [...UMBRALES_VENCE_DIAS].sort((a, b) => a - b).find((u) => dias <= u);
  if (umbral === undefined) return null;
  const mismoVencimiento = Number.isFinite(ms(avisado?.para)) && ms(avisado.para) === vence;
  if (mismoVencimiento && Number(avisado?.umbral) <= umbral) return null;
  return umbral;
}

/** ¿Toca preguntarle a Meta el vencimiento? Cada 6 h, o si la credencial cambió. */
export function tocaConsultarVencimiento({ revisadoAt, credencialAt, ahora }) {
  const revisado = ms(revisadoAt);
  if (!Number.isFinite(revisado)) return true;
  const cambio = ms(credencialAt);
  if (Number.isFinite(cambio) && cambio > revisado) return true;
  return ahora - revisado >= HORAS_ENTRE_CONSULTAS_VENCIMIENTO * HORA_MS;
}

const RUTA = 'Configuración → Integraciones → WhatsApp';
const en = (nombre) => (typeof nombre === 'string' && nombre.trim() ? ` de ${nombre.trim()}` : '');

export function textoRechazo(nombreNegocio) {
  return {
    titulo: '⚠️ WhatsApp desconectado',
    cuerpo: `Meta rechazó el permiso de Xabor en el WhatsApp${en(nombreNegocio)}: el bot no puede contestar ni avisar a los clientes. `
      + `Un administrador debe entrar a ${RUTA} y pulsar «Reconectar».`,
  };
}

/** «martes 8 de diciembre a las 11:06 a.m.» en la zona del negocio. */
export function fechaLocal(fecha, zona) {
  const d = new Date(fecha);
  const dia = new Intl.DateTimeFormat('es-MX', { timeZone: zona, weekday: 'long', day: 'numeric', month: 'long' })
    .format(d).replace(',', '');
  const hora = new Intl.DateTimeFormat('es-MX', { timeZone: zona, hour: 'numeric', minute: '2-digit' }).format(d);
  return `${dia} a las ${hora}`;
}

export function textoVencimiento(venceAt, zona, nombreNegocio) {
  const fecha = fechaLocal(venceAt, zona);
  return {
    titulo: '⏳ El permiso de WhatsApp vence pronto',
    cuerpo: `El permiso de Xabor en el WhatsApp${en(nombreNegocio)} vence el ${fecha}${fecha.endsWith('.') ? '' : '.'} `
      + `Antes de esa hora, un administrador debe entrar a ${RUTA} y pulsar «Reconectar».`,
  };
}

// Lo que «Verificar conexión» le dice al administrador (mismo estilo, sin
// acentos, que los demás faltantes de esa ruta).
export const FALTANTE_CREDENCIAL = 'Meta rechazo el permiso de Xabor (vencio o fue retirado): pulsa Reconectar.';
