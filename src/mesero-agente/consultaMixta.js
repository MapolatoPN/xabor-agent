// Información complementaria para un turno que también cambia el pedido.
// No interpreta productos ni autoriza efectos; nunca reutiliza prosa del modelo.
import { contieneDecisionDePedido, normalizarEleccion } from './politicaDelTurno.js';
import { formatearHorarioTexto } from '../agent/prompts.js';
import { modalidadesDisponibles } from '../orders/modalidadesDelPedido.js';

const breve = v => typeof v === 'string' && v.trim().length <= 240
  ? v.trim().replace(/[\r\n]+/g, ' ') : '';
const positivo = v => v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0;

export function informacionDeConsultaMixta({mensaje, reglas = {}, cfg = {}, estadoRestaurante = {}, modalidades}) {
  if (!contieneDecisionDePedido(mensaje)) return '';
  const t = normalizarEleccion(mensaje), partes = [], p = reglas.pedidos || {};
  if (/\b(?:que horario|a que hora (?:abren|cierran)|estan abiertos)\b/.test(t)) {
    const dias = ['lunes','martes','miercoles','jueves','viernes','sabado','domingo'];
    const completo = dias.every(d => reglas.horarios?.[d]?.abierto === false
      || (reglas.horarios?.[d]?.abierto === true
        && /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(reglas.horarios[d].apertura)
        && /^(?:(?:[01]?\d|2[0-3]):[0-5]\d|24:00)$/.test(reglas.horarios[d].cierre)));
    partes.push(completo ? `*Horario habitual*\n${formatearHorarioTexto(reglas.horarios)}.`
      : 'No tengo un horario completo verificado para compartirte.');
    if (estadoRestaurante.cierreEspecial) {
      const hora = estadoRestaurante.cierreEspecial.hora_cierre;
      partes.push(/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(hora || '')
        ? `Hoy hay cierre especial a las ${hora}.` : 'Hoy hay un cierre especial.');
    }
  }
  if (/\b(?:donde (?:estan|se encuentran)|cual es (?:su|la) direccion)\b/.test(t)) {
    const direccion = breve(cfg.direccion);
    partes.push(direccion ? `*Ubicación*\n${direccion}${breve(cfg.ciudad) ? `, ${breve(cfg.ciudad)}` : ''}.`
      : 'No tengo una dirección del restaurante verificada para compartirte.');
  }
  if (/\b(?:cuanto cuesta (?:el )?envio|costo (?:del |de )?envio|hacen entregas|tienen servicio a domicilio)\b/.test(t)) {
    const disponibles = modalidades ?? p.modalidades;
    const domicilio = (modalidadesDisponibles(disponibles) || []).some(m => m.tipo === 'domicilio');
    partes.push(!Array.isArray(disponibles) || !disponibles.length
      ? 'No tengo modalidades de entrega verificadas para compartirte.'
      : domicilio
      ? '*Envío*\nLa cobertura y tarifa se validan con tu dirección y las reglas vigentes. Verás el importe antes de confirmar.'
      : 'El servicio a domicilio no está habilitado en las modalidades actuales.');
  }
  if (/\b(?:cuanto (?:tarda|demora)|tiempo (?:de )?(?:entrega|preparacion))\b/.test(t)) {
    const entrega = /\b(?:envio|entrega|domicilio)\b/.test(t);
    const min = entrega ? p.tiempo_entrega_min_minutos : p.tiempo_preparacion_minutos;
    const max = entrega ? p.tiempo_entrega_max_minutos : min;
    partes.push(positivo(min) && positivo(max) && Number(max) >= Number(min)
      ? `*Tiempo estimado de ${entrega ? 'entrega' : 'preparación'}*\n${Number(min) === Number(max) ? Number(min) : `${Number(min)}–${Number(max)}`} minutos; no es una hora de entrega garantizada.`
      : 'No tengo un tiempo estimado verificado en este momento.');
  }
  return partes.join('\n\n');
}
