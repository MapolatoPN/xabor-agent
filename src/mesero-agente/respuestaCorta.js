// ─── LAS RESPUESTAS CORTAS SE LEEN CONTRA LA PREGUNTA QUE SE HIZO ─────────
//
// «Sí», «no», «esa», «dos», «sin eso», «la segunda». Ninguna de esas palabras
// significa algo por sí sola: significa lo que contesta. Durante meses se
// interpretaron buscando palabras sueltas contra el carrito, la carta y lo
// último que devolvió una búsqueda del modelo, y cada frase nueva pedía otro
// parche («chipotle», «papas», «chorizo», «sí» que duplicaba un café).
//
// Aquí la única fuente es `estado.pendiente`: la pregunta ESTRUCTURADA que la
// última respuesta enviada le hizo al cliente. Si no hay pregunta pendiente, o
// el mensaje no es una respuesta corta a ELLA, este módulo no decide nada y el
// turno sigue su camino normal (continuidad de opciones o el modelo).
//
// Lo que devuelve son ACCIONES con el mismo formato que las herramientas del
// modelo: pasan por el mismo esquema, la misma legalidad, el mismo ejecutor, el
// mismo reconciliador y el mismo libro. La única diferencia es la
// `autorizacion`: un dato estructurado (el producto, la promoción, la cantidad
// o la forma de pago que la pregunta ofreció) que el ejecutor usa como
// evidencia SOLO para esa llamada. El modelo no puede fabricarla.
import { esConfirmacionVerbal, esMutacionDePedido } from '../agent/confirmacionVerbal.js';
import { normalizar } from '../agent/mencionesComerciales.js';
import { PENDIENTES } from './estadoCanonico.js';
import { evaluarModalidad, modalidadesDisponibles } from '../orders/modalidadesDelPedido.js';
import { evaluarFormaPago, tiposDePagoDisponibles } from './politicaDePagos.js';

const NEGATIVAS = new Set(['no', 'nop', 'nel', 'no gracias', 'no por ahora', 'ahorita no', 'asi no',
  'mejor no', 'no quiero', 'no lo quiero', 'no la quiero', 'no me interesa', 'paso', 'no gracias por ahora',
  'por ahora no', 'no asi esta bien', 'asi esta bien gracias']);
const DEMOSTRATIVAS = new Set(['esa', 'ese', 'eso', 'esa misma', 'ese mismo', 'la misma', 'el mismo',
  'esa por favor', 'ese por favor', 'esa porfa', 'ese porfa', 'esa esta bien', 'ese esta bien',
  'esa quiero', 'ese quiero', 'quiero esa', 'quiero ese']);
const AUSENCIAS = new Set(['sin eso', 'sin nada', 'nada', 'ninguna', 'ninguno', 'sin', 'no gracias',
  'ninguna gracias', 'ninguno gracias', 'nada gracias', 'asi sin nada']);
const ORDINALES = new Map([
  ['primera', 0], ['primero', 0], ['la primera', 0], ['el primero', 0], ['la 1', 0], ['el 1', 0],
  ['opcion 1', 0], ['la opcion 1', 0],
  ['segunda', 1], ['segundo', 1], ['la segunda', 1], ['el segundo', 1], ['la 2', 1], ['el 2', 1],
  ['opcion 2', 1], ['la opcion 2', 1],
  ['tercera', 2], ['tercero', 2], ['la tercera', 2], ['el tercero', 2], ['la 3', 2], ['el 3', 2],
  ['opcion 3', 2], ['la opcion 3', 2],
  ['cuarta', 3], ['cuarto', 3], ['la cuarta', 3], ['el cuarto', 3], ['la 4', 3], ['el 4', 3],
]);
const NUMEROS = new Map([['uno', 1], ['una', 1], ['dos', 2], ['tres', 3], ['cuatro', 4], ['cinco', 5],
  ['seis', 6], ['siete', 7], ['ocho', 8], ['nueve', 9], ['diez', 10]]);
const CORTESIA = new Set(['por', 'favor', 'porfa', 'gracias', 'si', 'va', 'ok', 'claro', 'pues', 'bueno',
  'para', 'a', 'al', 'en', 'el', 'la', 'lo', 'los', 'las', 'es', 'seria', 'sera', 'quiero', 'mejor',
  'con', 'de', 'que', 'sea', 'me', 'lo', 'voy', 'pagar', 'pago', 'pagare', 'pagaria', 'y']);

const limpiar = (m) => normalizar(m).replace(/^(?:ok|va|bueno|pues)\s+/, '').replace(/\s+(?:por favor|porfa|gracias)$/, '').trim();

/** Un número suelto («2», «dos», «dos por favor») o null. */
export function numeroSolo(mensaje) {
  const t = limpiar(mensaje);
  if (/^\d{1,2}$/.test(t)) return Number(t);
  return NUMEROS.get(t) ?? null;
}

export const esNegativaCorta = (mensaje) => NEGATIVAS.has(limpiar(mensaje)) || NEGATIVAS.has(normalizar(mensaje));

// ── ACEPTAR UNA OFERTA no es lo mismo que CONFIRMAR UN PEDIDO ────────────
//
// Confirmar un pedido usa la regla estricta de `esConfirmacionVerbal`
// (fail-closed: cualquier palabra con contenido la invalida). Aceptar lo que
// la pregunta ofreció —un producto, una promoción, una forma de pago— admite
// la cortesía normal de una respuesta («sí, me funciona», «claro, está bien»,
// «va, perfecto»): empieza afirmando y el resto son palabras de acuerdo o
// cortesía. Es una regla de VOCABULARIO, no una lista de frases, y cualquier
// señal de cambio («sí, pero sin cebolla») la anula.
const INICIO_AFIRMATIVO = new Set(['si', 'sip', 'sii', 'claro', 'va', 'sale', 'ok', 'okay', 'okey', 'dale',
  'perfecto', 'bueno', 'orale', 'correcto', 'exacto', 'listo', 'acepto', 'adelante', 'excelente', 'genial',
  'vale', 'simon', 'esta', 'me', 'de', 'porfa', 'por']);
const RELLENO_ACEPTACION = new Set([...INICIO_AFIRMATIVO, 'funciona', 'parece', 'bien', 'acuerdo', 'gracias',
  'favor', 'esa', 'ese', 'eso', 'la', 'el', 'lo', 'quiero', 'interesa', 'super', 'pues', 'asi', 'muy',
  'mucho', 'muchas', 'porfavor', 'aceptamos', 'y', 'tambien']);

export function esAceptacionCorta(mensaje) {
  if (/[?¿]/.test(String(mensaje || ''))) return false;
  if (esConfirmacionVerbal(mensaje)) return true;
  if (esMutacionDePedido(mensaje)) return false;
  const palabras = normalizar(mensaje).split(' ').filter(Boolean);
  if (!palabras.length || !INICIO_AFIRMATIVO.has(palabras[0])) return false;
  // «de» y «por» solo abren una aceptación como «de acuerdo» y «por favor».
  if (palabras[0] === 'de' && palabras[1] !== 'acuerdo') return false;
  if (palabras[0] === 'por' && palabras[1] !== 'favor') return false;
  if ((palabras[0] === 'me' && !['funciona', 'parece', 'interesa'].includes(palabras[1]))
    || (palabras[0] === 'esta' && palabras[1] !== 'bien')) return false;
  return palabras.every((w) => RELLENO_ACEPTACION.has(w));
}
const esDemostrativa = (mensaje) => DEMOSTRATIVAS.has(limpiar(mensaje));
const esAusencia = (mensaje) => AUSENCIAS.has(limpiar(mensaje)) || AUSENCIAS.has(normalizar(mensaje));
const ordinal = (mensaje) => (ORDINALES.has(limpiar(mensaje)) ? ORDINALES.get(limpiar(mensaje)) : null);

/** ¿Todas las palabras del mensaje son vocabulario de la respuesta o cortesía? */
function soloVocabulario(mensaje, vocabulario) {
  const permitidas = new Set([...vocabulario].flatMap((v) => normalizar(v).split(' ')).filter(Boolean));
  const t = normalizar(mensaje);
  if (!t) return false;
  return t.split(' ').every((w) => CORTESIA.has(w) || permitidas.has(w));
}

const VOCABULARIO_MODALIDAD = ['recoger', 'recojo', 'paso', 'por', 'el', 'llevar', 'domicilio', 'entrega',
  'envio', 'enviar', 'mandar', 'mandamelo', 'tienda', 'aqui', 'comer', 'local', 'sucursal', 'en', 'para'];
const VOCABULARIO_PAGO = ['efectivo', 'cash', 'tarjeta', 'terminal', 'credito', 'debito', 'enlace', 'link',
  'liga', 'linea', 'transferencia', 'transferir', 'sucursal'];

/**
 * Interpreta un mensaje contra `estado.pendiente`.
 *
 * Devuelve `null` (no es una respuesta corta a la pregunta pendiente), o:
 *   { accion: { herramienta, argumentos, motivo, autorizacion?, opcionAceptada? } }
 *   { rechazo: 'resumen' | 'producto' | 'promocion' | 'pago' }
 */
export function interpretarRespuestaCorta({ estado, mensaje = '', modalidades = null, metodosPago = null } = {}) {
  const p = estado?.pendiente;
  if (!p || !String(mensaje).trim()) return null;
  // Una pregunta nunca es una respuesta: «¿sí incluye bebida?» no acepta nada.
  if (/[?¿]/.test(String(mensaje))) return null;
  // Un turno con varios mensajes agrupados solo es corto si TODAS sus líneas lo son.
  if (String(mensaje).split('\n').filter((l) => l.trim()).length > 1) return null;

  const afirma = esAceptacionCorta(mensaje) || esDemostrativa(mensaje);
  const niega = esNegativaCorta(mensaje);

  switch (p.tipo) {
    case PENDIENTES.CONFIRMAR_RESUMEN:
      // Solo la afirmación inequívoca confirma: «sí pero sin cebolla» es un
      // cambio y lo interpreta el turno normal (esConfirmacionVerbal ya lo
      // rechaza por la señal de mutación).
      if (esConfirmacionVerbal(mensaje)) {
        return { accion: { herramienta: 'confirmar_pedido', argumentos: { huella_resumen: p.huella },
          motivo: 'confirmacion_del_resumen_enviado' } };
      }
      if (niega) return { rechazo: 'resumen' };
      return null;

    case PENDIENTES.ACEPTAR_PRODUCTO: {
      const n = numeroSolo(mensaje);
      if (afirma || (n !== null && n >= 1 && n <= 20)) {
        return { accion: { herramienta: 'agregar_producto',
          argumentos: { producto_id: p.producto_id, cantidad: afirma ? 1 : n },
          motivo: 'aceptacion_del_producto_ofrecido',
          autorizacion: { tipo: 'producto_ofrecido', producto_id: p.producto_id, producto: p.producto,
            ...(afirma ? {} : { cantidad: n }) } } };
      }
      if (niega) return { rechazo: 'producto' };
      return null;
    }

    case PENDIENTES.ACEPTAR_PROMOCION: {
      const n = numeroSolo(mensaje);
      // La cantidad la fija la promoción, no el cliente ni el modelo. Un número
      // distinto al que la promoción exige no es aceptarla: lo resuelve el turno.
      if (afirma || n === Number(p.cantidad)) {
        return { accion: { herramienta: 'agregar_producto',
          argumentos: { producto_id: p.producto_id, cantidad: Number(p.cantidad) },
          motivo: 'aceptacion_de_promocion',
          autorizacion: { tipo: 'promocion', promocion_id: p.promocion_id, producto_id: p.producto_id,
            producto: p.producto, cantidad: Number(p.cantidad) } } };
      }
      if (niega) return { rechazo: 'promocion' };
      return null;
    }

    case PENDIENTES.ACEPTAR_PAGO_OFRECIDO:
      if (afirma) {
        return { accion: { herramienta: 'definir_pago', argumentos: { forma_pago: p.forma_pago },
          motivo: 'aceptacion_del_pago_ofrecido',
          autorizacion: { tipo: 'pago_ofrecido', forma_pago: p.forma_pago } } };
      }
      if (niega) return { rechazo: 'pago' };
      return null;

    case PENDIENTES.MODALIDAD: {
      const disponibles = modalidadesDisponibles(modalidades) || [];
      const pos = ordinal(mensaje);
      const lista = (p.opciones || []).length ? p.opciones : disponibles.map((m) => m.valor);
      if (pos !== null && lista[pos]) {
        return { accion: { herramienta: 'definir_entrega', argumentos: { modalidad: lista[pos] },
          motivo: 'modalidad_por_posicion', autorizacion: { tipo: 'opcion_de_la_pregunta', valor: lista[pos] } } };
      }
      if (!soloVocabulario(mensaje, VOCABULARIO_MODALIDAD)) return null;
      const elegidas = disponibles.filter((m) => evaluarModalidad({ modalidad: m.valor, modalidades, mensaje }).ok);
      if (elegidas.length !== 1) return null;
      return { accion: { herramienta: 'definir_entrega', argumentos: { modalidad: elegidas[0].valor },
        motivo: 'modalidad_de_la_pregunta' } };
    }

    case PENDIENTES.PAGO: {
      const tipos = tiposDePagoDisponibles(metodosPago) || [];
      const pos = ordinal(mensaje);
      const lista = (p.opciones || []).length ? p.opciones : tipos;
      if (pos !== null && lista[pos]) {
        return { accion: { herramienta: 'definir_pago', argumentos: { forma_pago: lista[pos] },
          motivo: 'pago_por_posicion', autorizacion: { tipo: 'pago_ofrecido', forma_pago: lista[pos] } } };
      }
      if (!soloVocabulario(mensaje, VOCABULARIO_PAGO)) return null;
      const elegidos = tipos.filter((tipo) => evaluarFormaPago({ formaPago: tipo, metodosPago, mensaje }).ok);
      if (elegidos.length !== 1) return null;
      return { accion: { herramienta: 'definir_pago', argumentos: { forma_pago: elegidos[0] },
        motivo: 'pago_de_la_pregunta' } };
    }

    case PENDIENTES.ELEGIR_OPCION: {
      // Las elecciones por nombre ya las resuelve `accionesParaOpcionesPendientes`
      // (con el foco, que es la proyección de este mismo pendiente). Aquí solo
      // las dos formas que no nombran ninguna opción: la posición en la lista
      // que se ofreció y la ausencia («sin eso», «ninguna»).
      const candidatos = p.candidatos || [];
      const pos = ordinal(mensaje);
      let opcion = pos !== null ? candidatos[pos] : null;
      if (!opcion && esAusencia(mensaje)) {
        const sinAlgo = candidatos.filter((c) => /^sin\b/i.test(normalizar(c)));
        const no = candidatos.find((c) => normalizar(c) === 'no');
        opcion = no || (sinAlgo.length === 1 ? sinAlgo[0] : null);
      }
      if (!opcion) return null;
      return { accion: { herramienta: 'modificar_linea',
        argumentos: { linea_id: p.linea_id, opciones: [{ grupo: p.grupo, opcion }] },
        motivo: pos !== null ? 'opcion_por_posicion' : 'ausencia_de_la_pregunta',
        opcionAceptada: { lid: p.linea_id, grupo: p.grupo, opcion } } };
    }

    default:
      return null;
  }
}
