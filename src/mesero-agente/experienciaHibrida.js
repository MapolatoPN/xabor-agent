// Beta aislada: conversar nunca concede autoridad para modificar el pedido.
import { alcanceDePruebaPermite } from './alcanceDePrueba.js';
import { politicaDelTurno, normalizarEleccion, contieneDecisionDePedido } from './politicaDelTurno.js';
import { atencionGeneralActiva } from './inicioMapo.js';
import { solicitudDeEntrada } from './intencionDeEntrada.js';

export function betaHibridaActiva(cfg, telefono) {
  return String(cfg?.whatsapp_beta_hibrido_v1) === 'true'
    && (atencionGeneralActiva(cfg) || (String(cfg?.bot_whatsapp_solo_prueba) === 'true'
    && alcanceDePruebaPermite(cfg, telefono)
    && alcanceDePruebaPermite({bot_whatsapp_solo_prueba:'true',
      mesero_agente_telefonos:cfg?.whatsapp_beta_telefonos}, telefono)));
}

// Incidente 1-oct-2026: con el carrito abierto, «¿Qué es el enlace de pago?» y
// «¿Me podrían explicar?» recibieron solo el carrito, cuatro veces seguidas.
// Son preguntas sobre cómo pagar o peticiones de explicación. Un verbo de
// cambio las devuelve al pedido: «¿me ayudan a quitar el café?» no es consulta.
const PREGUNTA_DE_PAGO = /\b(?:(?:que|cual|cuales) (?:tipo|tipos|forma|formas|metodo|metodos|medio|medios|opcion|opciones) de pago|que es (?:el |la |un |una )?(?:enlace|link|liga)(?: de pago)?|como (?:funciona|se usa|le hago para pagar)|como (?:(?:lo|la|le|les) )?(?:pago|pagamos|puedo pagar|podemos pagar|se paga|se le paga)|(?:aceptan|reciben|toman) (?:pagos? (?:con|en|por) )?(?:tarjeta|tarjetas|transferencia|transferencias|efectivo|vales)|(?:puedo|se puede|podria) pagar (?:con|en|por))\b/;
const PETICION_DE_EXPLICACION = /\b(?:(?:me|nos) (?:podrian|podrias|podria|pueden|puedes|puede) (?:explicar|ayudar|apoyar|orientar|informar|aclarar)|explicame|expliqueme|explicanme|no (?:le )?entiendo|no entendi)\b/;
const VERBO_DE_CAMBIO = /\b(?:agregar|agregarle|anadir|poner|ponerle|quitar|quitarle|cambiar|eliminar|borrar|pedir|ordenar|encargar|cancelar|confirmar|modificar|aumentar)\b/;

export function consultaInformativaHibrida(mensaje) {
  // Comparte la señal con la política del ejecutor. De lo contrario «añádeme»
  // o «pago en efectivo» se perdían al acompañarse de una pregunta de horario.
  if (contieneDecisionDePedido(mensaje)) return false;
  if (politicaDelTurno(mensaje).soloLectura) return true;
  const t=normalizarEleccion(mensaje);
  if (/\bsin\b/.test(t)) return false;
  if (/\b(?:que horario|a que hora (?:abren|cierran)|estan abiertos|donde (?:estan|se encuentran)|cual es (?:su|la) direccion|cuanto (?:tarda|demora|cuesta el envio)|hacen entregas|tienen servicio a domicilio)\b/.test(t)) return true;
  if (VERBO_DE_CAMBIO.test(t)) return false;
  return PREGUNTA_DE_PAGO.test(t) || PETICION_DE_EXPLICACION.test(t);
}

// El bot no pudo usar su respuesta (falla del proveedor o redacción insegura)
// y el carrito está vacío: en vez de solo «¿Qué te gustaría pedir?» conviene
// abrir el formulario de pedido. Incidente 1-oct-2026: la clienta escribió su
// pedido completo y tuvo que repetirlo. Nunca con carrito, pregunta pendiente,
// consulta, toque, mensajes en espera, pedido cerrado o formularios apagados.
// Tampoco tras un rescate (rescateHumano.js): si su handoff falló, el turno
// sigue con el carrito vacío y sin hechos, y el formulario taparía el texto
// que ya dice «te paso con alguien» (revisión del 3-oct al incidente 2-oct).
export function pedidoSinArmar({ salida, interaccion, protegerConsulta, preguntaVieja, estado, formulariosActivos }) {
  return !interaccion && !salida?.respuestaDeSistema && !salida?.rescate && !protegerConsulta && !preguntaVieja
    && /^(?:redaccion_sustituida:|fallo_proveedor_sin_efectos$)/.test(salida?.recuperacion || '')
    && !estado?.carrito?.items?.length && !estado?.pendiente && !estado?.folio && !estado?.evento
    && !estado?.confirmacionIncierta && !Object.values(estado?.hechos || {}).some(Boolean)
    && formulariosActivos === true;
}

export function borradorRetomable(estado) {
  return !!estado?.carrito?.items?.length && !estado.folio && !estado.evento
    && !estado.programacionRequerida && !estado.confirmacionIncierta
    && !Object.values(estado.hechos || {}).some(Boolean);
}

export function entradaRetomarPedido({estado,cfg,telefono,mensaje}) {
  if (!betaHibridaActiva(cfg,telefono) || !estado || estado.folio || estado.evento
    || estado.programacionRequerida || estado.confirmacionIncierta
    || Object.values(estado.hechos || {}).some(Boolean)) return null;
  const solicitud=solicitudDeEntrada(mensaje);
  const volver=!!estado.carrito?.items?.length && solicitud?.intencion==='ordenar';
  if (!volver && !/^(?:(?:seguir|continuar|retomar|ver|abrir|editar)(?: con)? (?:mi |el )?(?:pedido|carrito|formulario)|(?:se vencio|vencio|caduco) (?:el |mi )?formulario)$/.test(normalizarEleccion(mensaje))) return null;
  if (!estado.carrito?.items?.length) return {tipo:'retomar_pedido',acciones:[],sinSaludo:true,
    texto:'Abre el formulario para continuar. Solo recuperamos selecciones que llegaron al servidor y siguen vigentes.',
    pendiente:{tipo:'agregar_otro'}};
  return {tipo:'retomar_pedido',acciones:solicitud?.modalidad
    ? [{herramienta:'definir_entrega',argumentos:{modalidad:solicitud.modalidad}}] : [],sinSaludo:true,
    texto:'Aquí está tu pedido guardado. Puedes editarlo o seguir agregando.',pendiente:{tipo:'editar_pedido'}};
}

// No recorta una respuesta ni esconde información para hacerla caber en Meta.
export function textoConsultaConCarrito(texto) {
  const cuerpo=`${String(texto || '').trim()}\n\n*Tu pedido guardado sigue aquí.*\nPuedes continuar cuando quieras.`;
  return cuerpo.length <= 1024 ? cuerpo : null;
}
