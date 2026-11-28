// Asistente del restaurante, Fase 3: las cifras y el texto del resumen por
// WhatsApp. Funciones PURAS (sin base, sin reloj, sin red).
//
// Pedido del dueño (5.1 b): al cierre del día, máximo 5 puntos — la venta del
// día contra el mismo día de la semana anterior, lo más relevante que cambió y
// una sugerencia para mañana. Los lunes, además, el de la semana.
//
//   · Las cifras salen de la misma cuenta que Reportes › Ventas (las ventas ya
//     normalizadas por datos.js con reporteVentas.js).
//   · El diario compara HASTA LA MISMA HORA del mismo día de la semana pasada
//     (a las 21:30 todavía puede haber cobros): el mensaje dice «hasta las …».
//   · Los pedidos grandes no entran en la comparación (5.4): se dicen aparte.
//   · «Lo más relevante» son los avisos que eligió la revisión de esa mañana
//     (ya pasaron los mínimos de 100 tickets y 30 por grupo).
//
// La plantilla de Meta (docs/asistente-resumen-whatsapp.md) tiene 7
// variables, en orden:
//   {{1}} sucursal · {{2}} periodo · {{3}} venta · {{4}} {{5}} {{6}} puntos ·
//   {{7}} sugerencia.
// Meta no acepta variables vacías ni con saltos de línea.
import { sumarDias, fechaCorta, dinero } from './reglas.js';
import { LARGOS, cifrasPermitidas, faltasDeTexto } from './redaccion.js';

export const TEXTO_PLANTILLA = [
  'Resumen de {{1}} ({{2}}):',
  '• Venta: {{3}}',
  '• {{4}}',
  '• {{5}}',
  '• {{6}}',
  'Sugerencia: {{7}}',
  'Mensaje automático de Xabor; el detalle está en Reportes.',
].join('\n');
export const MAXIMO_CUERPO = 1024;
export const SIN_MAS = 'Sin otros avisos que pasen los mínimos.';
export const NADA = '—';
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export const diaDeLaSemana = (fecha) => DIAS[new Date(`${fecha}T12:00:00Z`).getUTCDay()];
export const esLunes = (fecha) => new Date(`${fecha}T12:00:00Z`).getUTCDay() === 1;
const entero = (n) => Math.round(Number(n) || 0).toLocaleString('es-MX');
const tickets = (n) => `${entero(n)} ticket${Math.round(n) === 1 ? '' : 's'}`;

/** Una variable como la acepta Meta: sin saltos, sin espacios de más, nunca vacía. */
export function limpiarVariable(v, max = LARGOS.variable) {
  const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!s) return NADA;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** El cuerpo del mensaje con sus variables (para la vista previa y el largo). */
export function textoDelMensaje(variables) {
  return TEXTO_PLANTILLA.replace(/\{\{(\d)\}\}/g, (_, i) => String(variables[Number(i) - 1] ?? ''));
}

function sumar(ventas, filtro, umbralGrande) {
  let venta = 0; let n = 0; let grandes = 0; let grandesVenta = 0;
  for (const v of ventas) {
    if (v.clase !== 'venta' || !filtro(v)) continue;
    if (v.neta > umbralGrande) { grandes++; grandesVenta += v.neta; continue; }
    venta += v.neta; n++;
  }
  return { venta: Math.round(venta * 100) / 100, tickets: n, grandes, grandesVenta: Math.round(grandesVenta * 100) / 100 };
}

function cambio(actual, antes) {
  if (!(antes > 0)) return null;
  return Math.round(((actual - antes) / antes) * 1000) / 10;
}
const textoCambio = (pct) => (pct === null ? '' : ` (${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toLocaleString('es-MX')} %)`);

/**
 * Las cifras del resumen.
 *   tipo: 'diario' | 'semanal'
 *   ventas: las de datos.js (clase, neta, fecha, hora), de ESTA sucursal.
 *   hoy: fecha local del resumen. horaCorte: 'HH:MM' (solo el diario).
 *   umbralGrande: pesos (reglas.umbralPedidoGrande).
 *   elegidos: los avisos elegidos esa mañana [{ tipo, titulo, sugerencia, ia? }].
 */
export function calcularResumen({ tipo, negocio, ventas = [], hoy, horaCorte = '23:59', umbralGrande, elegidos = [] }) {
  let actual; let antes; let periodo; let comparado;
  if (tipo === 'semanal') {
    const desde = sumarDias(hoy, -7); const hasta = sumarDias(hoy, -1);
    const desdeA = sumarDias(hoy, -14); const hastaA = sumarDias(hoy, -8);
    actual = sumar(ventas, (v) => v.fecha >= desde && v.fecha <= hasta, umbralGrande);
    antes = sumar(ventas, (v) => v.fecha >= desdeA && v.fecha <= hastaA, umbralGrande);
    periodo = `semana del ${fechaCorta(desde)} al ${fechaCorta(hasta)}`;
    comparado = 'la semana anterior';
  } else {
    const pasada = sumarDias(hoy, -7);
    const hastaHora = (v) => typeof v.hora === 'string' && v.hora <= horaCorte;
    actual = sumar(ventas, (v) => v.fecha === hoy && hastaHora(v), umbralGrande);
    antes = sumar(ventas, (v) => v.fecha === pasada && hastaHora(v), umbralGrande);
    periodo = `${diaDeLaSemana(hoy)} ${fechaCorta(hoy)}, hasta las ${horaCorte}`;
    comparado = `el ${diaDeLaSemana(pasada)} pasado`;
  }
  const pct = cambio(actual.venta, antes.venta);
  const venta = antes.tickets
    ? `${dinero(actual.venta)} en ${tickets(actual.tickets)}; ${comparado}, ${dinero(antes.venta)} en ${tickets(antes.tickets)}${textoCambio(pct)}`
    : `${dinero(actual.venta)} en ${tickets(actual.tickets)}; ${comparado} no hubo ventas para comparar`;

  const puntos = [];
  for (const h of elegidos) {
    const t = h?.ia?.titulo || h?.titulo;
    if (t) puntos.push(t);
  }
  if (actual.grandes) {
    puntos.push(`Aparte, ${entero(actual.grandes)} pedido${actual.grandes === 1 ? '' : 's'} grande${actual.grandes === 1 ? '' : 's'} por ${dinero(actual.grandesVenta)} (no entra${actual.grandes === 1 ? '' : 'n'} en la comparación)`);
  }
  let sugerencia = '';
  for (const h of elegidos) { sugerencia = h?.ia?.sugerencia || h?.sugerencia || ''; if (sugerencia) break; }
  if (!sugerencia) {
    if (tipo === 'semanal') sugerencia = 'Revisa en Reportes › Ventas los días que más cambiaron.';
    else {
      const manana = sumarDias(hoy, 1);
      const ref = sumar(ventas, (v) => v.fecha === sumarDias(manana, -7), umbralGrande);
      sugerencia = ref.tickets
        ? `Mañana es ${diaDeLaSemana(manana)}: el ${diaDeLaSemana(manana)} pasado vendiste ${dinero(ref.venta)} en ${tickets(ref.tickets)}; prepárate para un ritmo parecido.`
        : `Revisa mañana en la campanita los avisos del asistente.`;
    }
  }
  return {
    tipo, hoy, periodo, sucursal: String(negocio?.nombre || '').trim() || 'tu sucursal',
    actual, antes, cambioPct: pct, venta, puntos: puntos.slice(0, 3), sugerencia,
  };
}

/** Las 7 variables de la plantilla, con el texto de las reglas. */
export function variablesDe(r, texto = {}) {
  const puntos = [...(texto.puntos || r.puntos)].slice(0, 3);
  if (puntos.length < 3) puntos.push(SIN_MAS);
  while (puntos.length < 3) puntos.push(NADA);
  return [r.sucursal, r.periodo, texto.venta || r.venta, ...puntos, texto.sugerencia || r.sugerencia].map((v) => limpiarVariable(v));
}

/** Las cifras que la IA puede usar en el resumen: las del texto de las reglas. */
export function cifrasDeResumen(r) {
  return cifrasPermitidas([r.periodo, r.venta, ...r.puntos, r.sugerencia],
    [r.actual.venta, r.actual.tickets, r.antes.venta, r.antes.tickets, r.cambioPct, r.actual.grandes, r.actual.grandesVenta]);
}

// ─── La IA en el resumen: solo reescribe lo que ya está escrito ──────────
export const SISTEMA_RESUMEN = [
  'Eres el analista de un restaurante en México. Recibes el resumen del día (o de la semana) YA CALCULADO por el sistema del restaurante.',
  'Reescríbelo para el dueño en un WhatsApp claro y corto, en español de México, hablándole de tú.',
  'Reglas que no se rompen:',
  '1. No calcules ni inventes cifras: usa solo números que aparecen escritos en los datos, tal cual.',
  '2. Di qué cambió, nunca por qué: prohibido «porque», «debido a», «a causa de», «gracias a», «provocó», «hizo que», «se debe a».',
  '3. Nada de teléfonos, correos ni datos de pago.',
  '4. venta: una línea de hasta 190 letras con la venta y la comparación. puntos: cada uno de hasta 190 letras. sugerencia: UNA acción concreta para mañana (o para la semana), hasta 190 letras. Sin saltos de línea.',
  '5. puntos: exactamente uno por cada punto de los datos, en el mismo orden (no quites ninguno: el primero puede ser un aviso de control). Si no hay puntos en los datos, devuelve la lista vacía.',
].join('\n');

export const ESQUEMA_RESUMEN = Object.freeze({
  type: 'object',
  properties: {
    venta: { type: 'string' },
    puntos: { type: 'array', items: { type: 'string' } },
    sugerencia: { type: 'string' },
  },
  required: ['venta', 'puntos', 'sugerencia'],
  additionalProperties: false,
});

export function entradaResumen(r) {
  return { sucursal: r.sucursal, periodo: r.periodo, venta: r.venta, puntos: r.puntos, sugerencia: r.sugerencia };
}

/**
 * Lo que sirve de la respuesta de la IA. Cada parte se revisa sola; la que no
 * sirve se queda con el texto de las reglas. Devuelve { texto, conIa, faltas }.
 */
export function aplicarRespuestaResumen(r, respuesta) {
  const permitidas = cifrasDeResumen(r);
  const max = LARGOS.variable - 10;
  const faltas = [];
  const texto = {};
  let usadas = 0;
  if (respuesta && typeof respuesta === 'object') {
    const fv = faltasDeTexto(respuesta.venta, permitidas, max);
    if (fv.length) faltas.push(...fv.map((x) => `venta: ${x}`)); else { texto.venta = respuesta.venta.trim(); usadas++; }
    const ps = Array.isArray(respuesta.puntos) ? respuesta.puntos : null;
    // Uno por cada punto de las reglas: así la IA no puede quitar uno de control.
    if (!ps || ps.length !== r.puntos.length) faltas.push('puntos: lista inválida');
    else {
      const malos = ps.flatMap((p) => faltasDeTexto(p, permitidas, max));
      if (malos.length) faltas.push(...malos.slice(0, 2).map((x) => `puntos: ${x}`)); else if (ps.length) { texto.puntos = ps.map((p) => p.trim()); usadas++; }
    }
    const fs = faltasDeTexto(respuesta.sugerencia, permitidas, max);
    if (fs.length) faltas.push(...fs.map((x) => `sugerencia: ${x}`)); else { texto.sugerencia = respuesta.sugerencia.trim(); usadas++; }
  } else faltas.push('sin respuesta');
  return { texto, conIa: usadas > 0, faltas };
}

/** Las variables del botón «Enviar prueba» (sin cifras). */
export function variablesDePrueba(sucursal) {
  return [
    String(sucursal || '').trim() || 'tu sucursal', 'mensaje de prueba',
    'aquí irá la venta del día y la comparación con la semana pasada',
    'aquí irán hasta 3 puntos con lo más relevante', 'si te llegó este mensaje, la plantilla ya funciona', NADA,
    'nada por hacer: es solo una prueba',
  ].map((v) => limpiarVariable(v));
}
