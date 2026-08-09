// Transporte TCP crudo: abre un socket contra la impresora y le vuelca los
// bytes ESC/POS. Es como hablan casi todas las térmicas de red.
//
// Dos cosas deliberadas:
//
//   * NO hay puerto por defecto. El 9100 es el habitual, pero suponerlo es
//     justo el tipo de suposición que hace perder una tarde en sitio cuando
//     el modelo escucha en otro. El puerto se configura y punto.
//
//   * Este archivo SOLO existe en el Edge. La nube nunca lo importa: es la
//     línea que impide que Railway intente abrir un socket contra una IP
//     privada del restaurante (ver docs/xabor-edge-arquitectura.md).
import net from 'node:net';

// Traduce el error de sistema a algo que un técnico pueda accionar sin
// buscar en Google. El código crudo se conserva para los logs.
const EXPLICACION = {
  ECONNREFUSED: 'la impresora rechazó la conexión: está encendida pero ese puerto no escucha',
  ETIMEDOUT: 'la impresora no respondió a tiempo: apagada, sin red o IP equivocada',
  EHOSTUNREACH: 'no hay ruta hasta esa IP: la impresora está en otra red',
  ENETUNREACH: 'la red local no es alcanzable desde este equipo',
  ECONNRESET: 'la impresora cortó la conexión a media transmisión',
  EPIPE: 'la conexión se cerró mientras se enviaban los datos',
  ENOTFOUND: 'ese nombre de host no existe: usa la IP',
};

export function crearTransporteTcpRaw({ logger, timeoutMs = 10000 } = {}) {
  return {
    nombre: 'tcp_raw',

    async enviar(config, bytes, contexto = {}) {
      const host = config?.host;
      const puerto = Number(config?.puerto);
      const limite = Number(config?.timeoutMs) || timeoutMs;

      if (!host || !Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
        return { ok: false, codigo: 'CONFIG_INVALIDA',
                 detalle: 'la impresora no tiene host o puerto válidos configurados' };
      }

      return new Promise((resolver) => {
        let resuelto = false;
        // Se pone en true en cuanto el socket confirma que los bytes salieron
        // del proceso. A partir de ahí, un corte YA NO es un fallo limpio:
        // puede que la impresora los recibiera y sacara papel.
        let bytesEntregados = false;
        // La impresora cerró SU lado de la conexión de forma ordenada (FIN).
        // Es la señal más fuerte disponible de que recibió todo: una térmica
        // no confirma que salió papel, pero un cierre limpio sí distingue
        // "lo recibió entero" de "se cortó el cable a media transmisión".
        let finRemoto = false;

        const terminar = (resultado) => {
          if (resuelto) return;
          resuelto = true;
          clearTimeout(temporizador);
          socket.removeAllListeners();
          socket.destroy();
          resolver(resultado);
        };

        const socket = new net.Socket();

        const temporizador = setTimeout(() => {
          logger?.warn('transporte.tcp.timeout', { host, puerto, jobId: contexto.jobId, ms: limite });
          terminar({
            ok: false, codigo: 'ETIMEDOUT', detalle: EXPLICACION.ETIMEDOUT,
            // Si ya se habían escrito los bytes, el resultado es ambiguo.
            incierto: bytesEntregados,
          });
        }, limite);

        socket.setTimeout(limite);

        socket.on('error', (e) => {
          const codigo = e.code || 'ERROR_SOCKET';
          logger?.warn('transporte.tcp.error', { host, puerto, jobId: contexto.jobId, codigo });
          terminar({
            ok: false, codigo,
            detalle: EXPLICACION[codigo] || e.message,
            incierto: bytesEntregados && (codigo === 'ECONNRESET' || codigo === 'EPIPE'),
          });
        });

        socket.on('timeout', () => {
          terminar({ ok: false, codigo: 'ETIMEDOUT', detalle: EXPLICACION.ETIMEDOUT, incierto: bytesEntregados });
        });

        socket.connect(puerto, host, () => {
          socket.write(bytes, (err) => {
            if (err) return;                     // lo recoge el handler de 'error'
            bytesEntregados = true;
            // `end()` cierra nuestro lado y deja la conexión a la espera del
            // FIN de la impresora. No se resuelve aquí: escribir en el socket
            // solo prueba que los bytes salieron de este proceso.
            socket.end();
          });
        });

        // FIN de la impresora: cerró su lado después de recibirlo todo.
        socket.on('end', () => { finRemoto = true; });

        socket.on('close', (huboError) => {
          if (resuelto) return;

          if (bytesEntregados && finRemoto && !huboError) {
            logger?.info('transporte.tcp.enviado', { host, puerto, jobId: contexto.jobId, bytes: bytes.length });
            return terminar({ ok: true, detalle: `${bytes.length} bytes entregados` });
          }

          if (bytesEntregados) {
            // Los bytes salieron pero la impresora no cerró ordenadamente:
            // el cable se soltó, se apagó a media transmisión o cortó la
            // conexión. Puede haber salido papel y puede que no -- no se
            // reintenta a ciegas, se marca y lo revisa una persona.
            logger?.warn('transporte.tcp.incierto', { host, puerto, jobId: contexto.jobId });
            return terminar({ ok: false, codigo: 'CONEXION_CORTADA',
                              detalle: 'los datos salieron pero la impresora cortó sin cerrar: no se puede saber si imprimió',
                              incierto: true });
          }

          terminar({ ok: false, codigo: 'CONEXION_CERRADA',
                     detalle: 'la conexión se cerró antes de poder enviar nada', incierto: false });
        });
      });
    },
  };
}
