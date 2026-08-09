// Transportes de impresión.
//
// Contrato de un transporte (`PrinterTransport`):
//
//   async enviar(config, bytes, contexto) -> { ok, detalle?, codigo?, incierto? }
//
//     config   { host, puerto, timeoutMs, config }  -- lo que define el destino
//     bytes    Buffer ya renderizado
//     contexto { jobId, impresora }                 -- solo para logging
//
// Un transporte NO sabe qué es una comanda, una mesa ni un negocio. Solo
// sabe mover bytes a un destino y decir si lo consiguió.
//
// `incierto: true` es la respuesta honesta al caso en que los bytes salieron
// pero la conexión murió antes de poder confirmarlo: puede que el papel haya
// salido y puede que no. Reintentar a ciegas duplicaría comandas; darlo por
// impreso perdería una. Se marca y lo decide una persona.
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
        return { ok: false, codigo: 'TRANSPORTE_NO_IMPLEMENTADO',
                 detalle: 'windows_spooler llega en la visita a sitio; usa tcp_raw o mock' };
      },
    },
  };
}

export function elegirTransporte(transportes, nombre) {
  return transportes[nombre] || null;
}
