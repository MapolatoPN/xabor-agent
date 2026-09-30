// Beta aislada: conversar nunca concede autoridad para modificar el pedido.
import { alcanceDePruebaPermite } from './alcanceDePrueba.js';
import { politicaDelTurno, normalizarEleccion, contieneDecisionDePedido } from './politicaDelTurno.js';
import { atencionGeneralActiva } from './inicioMapo.js';

export function betaHibridaActiva(cfg, telefono) {
  return String(cfg?.whatsapp_beta_hibrido_v1) === 'true'
    && (atencionGeneralActiva(cfg) || (String(cfg?.bot_whatsapp_solo_prueba) === 'true'
    && alcanceDePruebaPermite(cfg, telefono)
    && alcanceDePruebaPermite({bot_whatsapp_solo_prueba:'true',
      mesero_agente_telefonos:cfg?.whatsapp_beta_telefonos}, telefono)));
}

export function consultaInformativaHibrida(mensaje) {
  // Comparte la señal con la política del ejecutor. De lo contrario «añádeme»
  // o «pago en efectivo» se perdían al acompañarse de una pregunta de horario.
  if (contieneDecisionDePedido(mensaje)) return false;
  if (politicaDelTurno(mensaje).soloLectura) return true;
  const t=normalizarEleccion(mensaje);
  if (/\bsin\b/.test(t)) return false;
  return /\b(?:que horario|a que hora (?:abren|cierran)|estan abiertos|donde (?:estan|se encuentran)|cual es (?:su|la) direccion|cuanto (?:tarda|demora|cuesta el envio)|hacen entregas|tienen servicio a domicilio)\b/.test(t);
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
  if (!/^(?:seguir|continuar|retomar|ver|abrir|editar)(?: con)? (?:mi |el )?(?:pedido|carrito)$/.test(normalizarEleccion(mensaje))) return null;
  if (!estado.carrito?.items?.length) return {tipo:'retomar_pedido',acciones:[],sinSaludo:true,
    texto:'Abre el formulario para continuar. Solo recuperamos selecciones que llegaron al servidor y siguen vigentes.',
    pendiente:{tipo:'agregar_otro'}};
  return {tipo:'retomar_pedido',acciones:[],sinSaludo:true,
    texto:'Aquí está tu pedido guardado. Puedes editarlo o seguir agregando.',pendiente:{tipo:'editar_pedido'}};
}

// No recorta una respuesta ni esconde información para hacerla caber en Meta.
export function textoConsultaConCarrito(texto) {
  const cuerpo=`${String(texto || '').trim()}\n\n*Tu pedido guardado sigue aquí.*\nPuedes continuar cuando quieras.`;
  return cuerpo.length <= 1024 ? cuerpo : null;
}
