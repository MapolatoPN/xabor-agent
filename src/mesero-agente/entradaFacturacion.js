import { inicioMapoActivo } from './inicioMapo.js';
import { flowsActivos } from './formularioAgrupado.js';
import { interactivosActivos } from './interactivos.js';
import { eleccionesActivas } from './eleccionesInteractivas.js';

export function formularioFiscalDisponible({cfg,estado,telefono}) {
  return inicioMapoActivo(cfg) && flowsActivos(cfg,telefono) && interactivosActivos(cfg)
    && eleccionesActivas(cfg) && /^\d{5,30}$/.test(cfg?.whatsapp_flow_facturacion_id || '')
    && !estado?.folio && !estado?.evento && !estado?.confirmacionIncierta && !estado?.programacionRequerida
    && !Object.values(estado?.hechos || {}).some(Boolean);
}

export const AYUDA_FOLIO='El folio es la referencia de tu compra, normalmente aparece como XAB seguido de números en el ticket. Si no lo encuentras, describe la fecha y lo que compraste en «Referencia de compra»; el equipo te ayudará a localizarla.';
export const AYUDA_ARCHIVO_FISCAL='Recibí tu archivo para facturación. No lo he validado ni he emitido una factura.';
