// Transporte TCP crudo: abre un socket contra la impresora y le vuelca los
// bytes ESC/POS. Es como hablan casi todas las térmicas de red.
//
// ─── QUÉ SE PUEDE SABER DE VERDAD ───────────────────────────────────────────
//
// Con RAW TCP (el mal llamado "puerto 9100") NO existe protocolo de
// aplicación: se abre un socket, se vuelcan bytes y ya. La impresora no
// responde, no confirma, no dice si tiene papel y no está obligada a cerrar
// la conexión. Muchos modelos la mantienen abierta indefinidamente.
//
// Hay cinco cosas distintas y solo se pueden observar las tres primeras:
//
//   A) write() aceptó los bytes en Node          → observable
//   B) el buffer local se vació ('finish')        → observable
//   C) el TCP del otro extremo aceptó los datos   → observable solo por
//                                                   ausencia de error/RST
//   D) la impresora procesó los bytes             → NO observable
//   E) salió papel                                → NO observable
//
// Por eso este transporte NUNCA devuelve "impreso". Lo máximo que afirma es
// **enviado sin confirmar**: los bytes salieron y nadie protestó.
//
// ─── QUÉ HACÍA ANTES Y POR QUÉ ESTABA MAL ───────────────────────────────────
//
// La primera versión exigía recibir el FIN de la impresora para dar el envío
// por bueno. Eso funcionaba contra el simulador -- porque el simulador cierra
// -- pero **no es genérico**: una térmica que mantenga la conexión abierta
// habría hecho que TODOS los trabajos vencieran el timeout y quedaran
// inciertos. Habría sido diseñar contra el simulador, y el fallo solo se
// habría visto en Obispado, con el hardware delante.
//
// Ahora el FIN del otro extremo es una señal **bienvenida pero opcional**:
// acelera el cierre y nada más.
import net from 'node:net';

// Traduce el error de sistema a algo accionable sin buscar en Google. El
// código crudo se conserva para los logs.
const EXPLICACION = {
  ECONNREFUSED: 'la impresora rechazó la conexión: está encendida pero ese puerto no escucha',
  ETIMEDOUT: 'la impresora no respondió a tiempo: apagada, sin red o IP equivocada',
  EHOSTUNREACH: 'no hay ruta hasta esa IP: la impresora está en otra red',
  ENETUNREACH: 'la red local no es alcanzable desde este equipo',
  ECONNRESET: 'la impresora cortó la conexión',
  EPIPE: 'la conexión se cerró mientras se enviaban los datos',
  ENOTFOUND: 'ese nombre de host no existe: usa la IP',
};

// Tras vaciar el buffer local se espera un momento por si llega un RST
// tardío. Sin esta ventana, una impresora que rechaza los datos justo después
// de recibirlos pasaría por envío correcto. Con ella, un corte se detecta.
// Si no pasa nada en ese tiempo, se da por enviado y se cierra: es el caso
// normal de una impresora que mantiene la conexión abierta.
const GRACIA_CIERRE_MS = 1200;

export function crearTransporteTcpRaw({ logger, timeoutMs = 10000, graciaMs = GRACIA_CIERRE_MS } = {}) {
  return {
    nombre: 'tcp_raw',

    async enviar(config, bytes, contexto = {}) {
      const host = config?.host;
      const puerto = Number(config?.puerto);
      const limite = Number(config?.timeoutMs) || timeoutMs;
      const gracia = Number(config?.graciaMs) || graciaMs;

      if (!host || !Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
        return { resultado: 'fallido', codigo: 'CONFIG_INVALIDA',
                 detalle: 'la impresora no tiene host o puerto válidos configurados' };
      }

      return new Promise((resolver) => {
        let resuelto = false;

        // Las tres fases observables. El estado final depende de hasta dónde
        // se llegó cuando algo salió mal.
        let conectado = false;      // hubo sesión TCP
        let escrito = false;        // write() aceptó todos los bytes
        let vaciado = false;        // el buffer local se vació ('finish')

        let temporizadorConexion = null;
        let temporizadorGracia = null;

        const limpiar = () => {
          if (temporizadorConexion) { clearTimeout(temporizadorConexion); temporizadorConexion = null; }
          if (temporizadorGracia) { clearTimeout(temporizadorGracia); temporizadorGracia = null; }
        };

        const terminar = (r) => {
          if (resuelto) return;
          resuelto = true;
          limpiar();
          socket.removeAllListeners();
          socket.destroy();
          resolver(r);
        };

        const enviado = (detalle) => {
          logger?.info('transporte.tcp.enviado', { host, puerto, jobId: contexto.jobId, bytes: bytes.length });
          terminar({ resultado: 'enviado', codigo: null, detalle });
        };

        // Se llega aquí cuando los bytes YA salieron y algo se torció después.
        // No se puede saber si la impresora los procesó.
        const incierto = (codigo, detalle) => {
          logger?.warn('transporte.tcp.incierto', { host, puerto, jobId: contexto.jobId, codigo });
          terminar({ resultado: 'incierto', codigo, detalle });
        };

        // Se llega aquí cuando se sabe que NO llegó nada: no hubo conexión, o
        // falló antes de escribir un solo byte. Es seguro reintentar.
        const fallido = (codigo, detalle) => {
          logger?.warn('transporte.tcp.fallido', { host, puerto, jobId: contexto.jobId, codigo });
          terminar({ resultado: 'fallido', codigo, detalle: detalle || EXPLICACION[codigo] || codigo });
        };

        const socket = new net.Socket();

        temporizadorConexion = setTimeout(() => {
          if (!escrito) return fallido('ETIMEDOUT', EXPLICACION.ETIMEDOUT);
          // Escribimos pero el buffer no se vació a tiempo: parte pudo salir.
          incierto('ETIMEDOUT', 'los datos no terminaron de salir antes del tiempo límite');
        }, limite);

        socket.on('error', (e) => {
          const codigo = e.code || 'ERROR_SOCKET';
          // Antes de escribir un solo byte no llegó nada: reintento seguro.
          if (!escrito) return fallido(codigo, EXPLICACION[codigo] || e.message);
          // Después de escribir, cualquier error es ambiguo.
          incierto(codigo, EXPLICACION[codigo] || e.message);
        });

        socket.on('timeout', () => {
          if (!escrito) return fallido('ETIMEDOUT', EXPLICACION.ETIMEDOUT);
          incierto('ETIMEDOUT', 'la impresora dejó de responder tras recibir los datos');
        });

        socket.connect(puerto, host, () => {
          conectado = true;
          socket.write(bytes, (err) => {
            if (err) return;                 // lo recoge el handler de 'error'
            escrito = true;
            // A partir de aquí ya salieron bytes hacia la impresora. Se avisa
            // ANTES de resolver para que el worker pueda dejarlo grabado: si
            // el proceso muere en este instante, al reiniciar hay que saber
            // que este trabajo pudo haber sacado papel y NO reintentarlo solo.
            try { contexto.alEscribir?.(); } catch { /* nunca frena el envío */ }
            // end() cierra NUESTRO lado. No se espera el FIN de la impresora:
            // no está obligada a mandarlo.
            socket.end();
          });
        });

        // El buffer local quedó vacío: todos los bytes están en manos del TCP.
        // Es lo más cerca que se puede estar de "se entregó".
        socket.on('finish', () => {
          vaciado = true;
          if (temporizadorConexion) { clearTimeout(temporizadorConexion); temporizadorConexion = null; }

          // Ventana corta por si la impresora contesta con un RST. Si no dice
          // nada, se da por enviado: la impresora que mantiene la conexión
          // abierta es el comportamiento normal, no un fallo.
          temporizadorGracia = setTimeout(() => {
            enviado(`${bytes.length} bytes enviados (la impresora mantuvo la conexión abierta)`);
          }, gracia);
          temporizadorGracia.unref?.();
        });

        socket.on('close', (huboError) => {
          if (resuelto) return;
          if (!conectado) return fallido('CONEXION_CERRADA', 'la conexión se cerró antes de establecerse');
          if (!escrito) return fallido('CONEXION_CERRADA', 'la conexión se cerró antes de poder enviar nada');
          if (huboError) return;             // el handler de 'error' ya decide

          // Cierre ordenado tras haber escrito todo: el mejor desenlace
          // posible con RAW TCP.
          if (vaciado) return enviado(`${bytes.length} bytes enviados y conexión cerrada por la impresora`);

          // Cerró antes de que se vaciara nuestro buffer: parte pudo perderse.
          incierto('CONEXION_CORTADA', 'la impresora cerró antes de que terminaran de salir los datos');
        });
      });
    },
  };
}
