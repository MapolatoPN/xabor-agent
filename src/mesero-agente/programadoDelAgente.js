// ─── UN PEDIDO PARA OTRO DÍA ──────────────────────────────────────────────
//
// El requisito del dueño (23-sep-2026): «lo toma, pero es necesario que lo
// imprima al día siguiente, 1 hora antes de la entrega».
//
// La segunda mitad YA EXISTE y no hay que construir nada:
//
//     obtenerPedidosPorActivar()   database.js
//       WHERE activado = FALSE AND programado_para <= NOW() + INTERVAL '1 hour'
//
// El job de `server.js` corre cada cinco minutos, y activar un programado es
// meterlo en `pedidos_activos` → panel → auto-impresión. Una hora antes, tal
// cual. Lo que faltaba es que el agente supiera fijar `programado_para`.
//
// ── QUIÉN INTERPRETA Y QUIÉN VALIDA ──────────────────────────────────────
//
// Aquí NO se interpreta lenguaje. «Mañana a las 10» lo convierte el MODELO,
// que sabe qué día es hoy, y entrega `fecha` y `hora` en formato estricto.
// Este módulo solo dice sí o no, y por qué.
//
// No es purismo: el parser que ya existe (`normalizarFechaEvento`) solo
// entiende fechas SIN hora, y falla en casi todo lo que escribe una persona —
// «mañana a las 10», «el sábado a las 2» y «hoy a las 6» le salen las tres
// `no_reconocida`. Ampliarlo sería escribir un intérprete de español dentro de
// Xabor para hacer peor lo que el modelo ya hace bien.
//
// Lo que Xabor no delega es la DECISIÓN: que el negocio abra ese día, a esa
// hora, con tiempo para prepararlo y dentro de un horizonte razonable. Eso es
// dato del negocio, y de eso el modelo no opina.
import { desdeHoraLocal, TZ_DEFAULT } from '../services/zonaHoraria.js';

/** Las claves de `reglas.horarios`, en el orden de `Date.getUTCDay()`. */
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const NOMBRE = { domingo: 'domingo', lunes: 'lunes', martes: 'martes', miercoles: 'miércoles',
  jueves: 'jueves', viernes: 'viernes', sabado: 'sábado' };

export const MAX_DIAS_OMISION = 30;
export const MINUTOS_PREPARACION_OMISION = 25;

const aMinutos = (hhmm) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : null;
};

/** El día de la semana de una fecha `YYYY-MM-DD`, sin que la zona lo mueva. */
export function diaDeLaSemana(fecha) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fecha || ''));
  if (!m) return null;
  // Mediodía UTC: cualquier desplazamiento de zona razonable deja el día
  // intacto. Con medianoche, un offset negativo lo tiraría al día anterior.
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return Number.isNaN(d.getTime()) ? null : DIAS[d.getUTCDay()];
}

/** Los días que el negocio abre, en palabras, para poder ofrecerlos. */
export function diasQueAbre(reglas) {
  const h = reglas?.horarios || {};
  return DIAS.filter((d) => h[d]?.abierto).map((d) => NOMBRE[d]);
}

/**
 * ¿SE PUEDE PROGRAMAR UN PEDIDO PARA ESTE MOMENTO?
 *
 * Devuelve `{ ok:true, iso, dia, hora }` o `{ ok:false, motivo, mensaje }`.
 * El `mensaje` está escrito para que el modelo se lo pueda decir al cliente y
 * sepa qué preguntar a continuación: un «no» sin alternativa deja la
 * conversación muerta, que es lo que hacía el desvío anterior.
 */
export function validarProgramado({
  fecha, hora, reglas = null, zona = TZ_DEFAULT, ahora = new Date(),
  maxDias = MAX_DIAS_OMISION, minutosPreparacion = null,
} = {}) {
  const no = (motivo, mensaje) => ({ ok: false, motivo, mensaje });

  const instante = desdeHoraLocal(`${fecha}T${hora}`, zona);
  if (!instante) {
    // `desdeHoraLocal` ya rechaza el 31 de febrero y las 25:00: no enrolla,
    // devuelve null. Aquí no hace falta volver a comprobar el calendario.
    return no('fecha_invalida', 'Esa fecha u hora no existe. Pregúntale al cliente el día y la hora otra vez.');
  }

  const dia = diaDeLaSemana(fecha);
  const horario = reglas?.horarios?.[dia];
  const abre = diasQueAbre(reglas);

  if (!horario?.abierto) {
    return no('cerrado_ese_dia',
      `El negocio no abre en ${NOMBRE[dia] || 'ese día'}.`
      + (abre.length ? ` Abre ${abre.join(', ')}. Ofrécele otro día.` : ''));
  }

  const apertura = aMinutos(horario.apertura);
  const cierre = aMinutos(horario.cierre);
  const pedida = aMinutos(hora);
  if (apertura === null || cierre === null || pedida === null) {
    return no('horario_ilegible', 'No puedo leer el horario de ese día. Pásalo a una persona.');
  }
  if (pedida < apertura || pedida >= cierre) {
    return no('fuera_de_horario',
      `En ${NOMBRE[dia]} el horario es de ${horario.apertura} a ${horario.cierre}. `
      + 'Dile las horas y pregúntale cuál le queda.');
  }

  // ── EL ORDEN DE ESTAS DOS IMPORTA ──────────────────────────────────────
  //
  // Primero «ya pasó», después «muy pronto». Al revés, a un cliente que pide
  // para ayer se le contestaría «necesito 25 minutos», que es desconcertante.
  const minutosDeMargen = Number.isFinite(Number(minutosPreparacion)) && Number(minutosPreparacion) > 0
    ? Number(minutosPreparacion)
    : (Number(reglas?.pedidos?.tiempo_preparacion_minutos) || MINUTOS_PREPARACION_OMISION);

  if (instante.getTime() <= ahora.getTime()) {
    return no('pasada', 'Esa hora ya pasó. Pregúntale para cuándo lo quiere.');
  }
  if (instante.getTime() < ahora.getTime() + minutosDeMargen * 60000) {
    return no('muy_pronto',
      `Necesitamos al menos ${minutosDeMargen} minutos para prepararlo. Ofrécele un poco más tarde.`);
  }

  const DIA = 86400000;
  if (instante.getTime() > ahora.getTime() + maxDias * DIA) {
    return no('muy_lejos',
      `No se pueden programar pedidos con más de ${maxDias} días. Pásalo a una persona si insiste.`);
  }

  return { ok: true, iso: instante.toISOString(), dia: NOMBRE[dia], hora, fecha };
}
