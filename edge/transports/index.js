// Transportes de impresión.
//
// Contrato de un transporte (`PrinterTransport`):
//
//   async enviar(config, bytes, contexto)
//     -> { resultado: 'enviado' | 'incierto' | 'fallido', codigo, detalle }
//
//     'enviado'   los bytes salieron y nadie protestó. NO significa que haya
//                 salido papel: con RAW TCP eso no se puede saber.
//     'incierto'  salieron bytes y luego algo se torció. Puede haber papel o
//                 no. NO se reintenta solo.
//     'fallido'   se sabe que no llegó nada. Reintentar es seguro.
//
//     config   { host, puerto, timeoutMs, config }  -- lo que define el destino
//     bytes    Buffer ya renderizado
//     contexto { jobId, impresora, alEscribir }
//              `alEscribir()` DEBE llamarse en cuanto salga el primer byte
//              hacia la impresora, antes de resolver. El worker lo usa para
//              dejar grabado que a partir de ese punto ya no es seguro
//              reintentar sin que lo decida una persona.
//
// Un transporte NO sabe qué es una comanda, una mesa ni un negocio. Solo
// sabe mover bytes a un destino y decir si lo consiguió.
//
// Ningún transporte devuelve "impreso": con RAW TCP no existe forma de saber
// si salió papel. Reintentar un 'incierto' a ciegas duplicaría comandas;
// darlo por impreso perdería una. Se marca y lo decide una persona.
import { crearTransporteMock } from './mock.js';
import { crearTransporteTcpRaw } from './tcpRaw.js';
import { crearTransporteWindowsSpooler } from './windowsSpooler.js';

export function crearTransportes({ logger, timeoutMs } = {}) {
  const mock = crearTransporteMock({ logger });
  return {
    mock,
    tcp_raw: crearTransporteTcpRaw({ logger, timeoutMs }),
    // Impresoras instaladas en Windows (USB, Bluetooth emparejado, red del
    // sistema -- da igual: si Windows la ve, esto la usa). Entrega por la API
    // de impresión en modo RAW, para que el driver no reinterprete el ESC/POS.
    windows_spooler: crearTransporteWindowsSpooler({ logger, timeoutMs }),
  };
}

export function elegirTransporte(transportes, nombre) {
  return transportes[nombre] || null;
}
