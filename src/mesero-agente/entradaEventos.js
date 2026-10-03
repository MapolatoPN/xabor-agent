// Eventos por formulario (decisión del dueño, 3-oct-2026).
//
// Una solicitud de evento escrita («¿hacen eventos?», «para un evento»)
// abre el formulario «Datos del evento» en vez de la captura por chat. En
// Obispado, de 13 capturas por chat en 30 días solo 1 terminó completa; el
// 3-oct una quedó preguntando «¿para cuántas personas?» al día siguiente
// aunque el cliente escribió «hola» y «quiero ordenar». El formulario pide
// todo en una pantalla y valida nombre y número de personas.
//
// Se enciende por negocio con `whatsapp_eventos_formulario_v1`. Para que el
// mensaje llegue al Mesero, el negocio no debe tener la ruta de eventos del
// bot heredado (`cotizacion_perfil=catering` con el módulo comercial activo):
// esa ruta se decide antes, en el canal.
import { inicioMapoActivo } from './inicioMapo.js';
import { flowsActivos } from './formularioAgrupado.js';
import { interactivosActivos } from './interactivos.js';
import { eleccionesActivas } from './eleccionesInteractivas.js';
import { esSolicitudCatering } from '../agent/catering.js';

export const BANDERA_EVENTOS_FORMULARIO = 'whatsapp_eventos_formulario_v1';

/** El formulario de evento se puede mandar: mismas barreras que el de factura. */
export function formularioEventoDisponible({ cfg, estado, telefono }) {
  return inicioMapoActivo(cfg) && flowsActivos(cfg, telefono) && interactivosActivos(cfg)
    && eleccionesActivas(cfg) && /^\d{5,30}$/.test(cfg?.whatsapp_flow_evento_id || '')
    && !estado?.folio && !estado?.evento && !estado?.confirmacionIncierta && !estado?.programacionRequerida
    && !Object.values(estado?.hechos || {}).some(Boolean);
}

const solicitudEscrita = ({ cfg, estado, mensaje, interaccion }) => !interaccion && !estado?.evento
  && String(cfg?.[BANDERA_EVENTOS_FORMULARIO]) === 'true' && esSolicitudCatering(mensaje);

/** ¿Este texto debe abrir el formulario de evento en lugar de la captura por chat? */
export function eventoPorFormulario({ cfg, estado, telefono, mensaje, interaccion = null }) {
  return solicitudEscrita({ cfg, estado, mensaje, interaccion }) && !estado?.carrito?.items?.length
    && formularioEventoDisponible({ cfg, estado, telefono });
}

/**
 * Con platillos en el carrito, «es para un cumpleaños» casi siempre habla
 * del pedido (el 2-oct tres clientes querían una dedicatoria), y el detector
 * de eventos lo marca igual. Ahí no se abre ni el formulario ni la captura
 * por chat: el mensaje sigue como parte del pedido.
 */
export function eventoConCarrito({ cfg, estado, mensaje, interaccion = null }) {
  return solicitudEscrita({ cfg, estado, mensaje, interaccion }) && !!estado?.carrito?.items?.length;
}
