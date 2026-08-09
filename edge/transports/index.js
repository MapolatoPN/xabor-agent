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
//     contexto { jobId, impresora }                 -- solo para logging
//
// Un transporte NO sabe qué es una comanda, una mesa ni un negocio. Solo
// sabe mover bytes a un destino y decir si lo consiguió.
//
// Ningún transporte devuelve "impreso": con RAW TCP no existe forma de saber
// si salió papel. Reintentar un 'incierto' a ciegas duplicaría comandas;
// darlo por impreso perdería una. Se marca y lo decide una persona.
import { crearTransporteMock } from './mock.js';
import { crearTransporteTcpRaw } from './tcpRaw.js';

export function crearTransportes({ logger, timeoutMs } = {}) {
  const mock = crearTransporteMock({ logger });
  return {
    mock,
    tcp_raw: crearTransporteTcpRaw({ logger, timeoutMs }),
    // El spooler de Windows sí existe hoy en print-agent.js, pero depende de
    // PowerShell y de un nombre de impresora instalada. No se porta aquí
    // hasta poder probarlo contra la PC real de Obispado: prometer un
    // transporte que no se ha ejecutado ni una vez sería falso.
    windows_spooler: {
      nombre: 'windows_spooler',
      async enviar() {
        // 'fallido' y no 'incierto': no se intentó nada, así que reintentar es
        // seguro (aunque volverá a fallar hasta que se implemente).
        return { resultado: 'fallido', codigo: 'TRANSPORTE_NO_IMPLEMENTADO',
                 detalle: 'windows_spooler llega en la visita a sitio; usa tcp_raw o mock' };
      },
    },
  };
}

export function elegirTransporte(transportes, nombre) {
  return transportes[nombre] || null;
}
