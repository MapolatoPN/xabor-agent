// Conexión del Edge con Xabor Cloud.
//
// SIEMPRE saliente: el Edge marca a la nube. La PC del restaurante no abre
// ningún puerto, no necesita IP pública, no necesita que nadie toque el
// router. Es la única topología que se puede instalar en un local ajeno sin
// pedirle nada a su proveedor de internet.
//
// Protocolo (sobre el WebSocket /ws/print-agent que ya existía):
//
//   Edge  → { tipo:'autenticar_terminal', terminalId, token, instalacionId }
//   Nube  → { tipo:'terminal_autenticada', terminalId, negocioId, sucursalId }
//   Nube  → { tipo:'trabajo_impresion', trabajo:{...} }
//   Edge  → { tipo:'ack_impresion', trabajoId, resultado, error? }
//   Edge  → { tipo:'latido', pendientes }
//   Nube  → { tipo:'solicitar_impresoras', solicitudId }
//   Edge  → { tipo:'impresoras_detectadas', solicitudId, ok, impresoras[], error? }
//
// `solicitar_impresoras` NO lleva parámetros: no es "ejecuta esto", es "dime
// qué impresoras tienes". El cómo (PowerShell, WMI) vive entero en el Edge y
// la nube no puede influir en él. Esa es la diferencia entre una capacidad
// cerrada y una ejecución remota.
//
// El `terminalId` del ACK lo pone el servidor a partir de la conexión
// autenticada, nunca este cliente: por eso un Edge no puede confirmar el
// trabajo de otro aunque mande su id.
import WebSocket from 'ws';
import { calcularEspera } from './config.js';

// Código de cierre acordado con el servidor: "otra conexión tomó esta
// terminal". Está en el rango 4000-4999, reservado para la aplicación.
export const CODIGO_DESPLAZADA = 4001;

export function crearConexion({ config, logger, alRecibirTrabajo, alAutenticar = null, instalacionId = null,
                               alListarImpresoras = async () => ({ ok: false, impresoras: [], error: 'no disponible' }) }) {
  let ws = null;
  let intentos = 0;
  let cerradoAdrede = false;
  let temporizadorReconexion = null;
  let temporizadorLatido = null;
  let identidad = null;

  const escuchas = { conectado: [], desconectado: [] };
  // Un escucha que falle no puede tumbar la conexión, pero tampoco debe
  // desaparecer sin dejar rastro.
  const avisar = (evento, dato) => {
    for (const fn of escuchas[evento] || []) {
      try { fn(dato); } catch (e) { logger?.warn('conexion.escucha.error', { evento, error: e.message }); }
    }
  };

  function limpiarTemporizadores() {
    if (temporizadorReconexion) { clearTimeout(temporizadorReconexion); temporizadorReconexion = null; }
    if (temporizadorLatido) { clearInterval(temporizadorLatido); temporizadorLatido = null; }
  }

  function programarReconexion() {
    if (cerradoAdrede || temporizadorReconexion) return;
    intentos += 1;
    const espera = calcularEspera(intentos, { baseMs: config.reconexionBaseMs, maximoMs: config.reconexionMaximaMs });
    logger?.warn('conexion.reintento', { intento: intentos, esperaMs: espera });
    temporizadorReconexion = setTimeout(() => { temporizadorReconexion = null; conectar(); }, espera);
    temporizadorReconexion.unref?.();
  }

  function conectar() {
    if (cerradoAdrede) return;
    logger?.info('conexion.abriendo', { url: config.urlNube.replace(/\/\/[^@]*@/, '//') });

    let socket;
    try {
      socket = new WebSocket(config.urlNube);
    } catch (e) {
      logger?.error('conexion.error', { error: e.message });
      return programarReconexion();
    }
    ws = socket;

    // TODOS los handlers usan `socket`, su propio WebSocket, y no la variable
    // `ws` del módulo. Con reconexiones rápidas (cerrar + iniciar seguidos)
    // `ws` ya apunta al socket NUEVO cuando llega el 'open' del anterior, y
    // enviar por él lanza "WebSocket is not open: readyState 0" -- una
    // excepción no capturada que mata el proceso del Edge. Lo encontró el
    // chaos con 500 rondas, no una prueba dirigida.
    const vigente = () => ws === socket;

    socket.on('open', () => {
      if (!vigente()) { try { socket.close(); } catch {} return; }
      // El token viaja aquí y en ningún otro sitio: no se loguea, no se
      // guarda en disco por el Edge, no se manda en ningún otro mensaje.
      try {
        socket.send(JSON.stringify({
          tipo: 'autenticar_terminal',
          terminalId: config.terminalId,
          token: config.terminalToken,
          // Identifica ESTA cola local. Si cambia, la nube sabe que el Edge
          // perdió la memoria de lo que ya mandó a las impresoras.
          instalacionId,
        }));
      } catch (e) {
        logger?.warn('conexion.autenticacion.fallo', { error: e.message });
      }
    });

    socket.on('message', (crudo) => {
      if (!vigente()) return;
      let msg;
      try { msg = JSON.parse(crudo.toString()); } catch {
        return logger?.warn('conexion.mensaje.invalido', { bytes: crudo.length });
      }

      if (msg.tipo === 'terminal_autenticada') {
        intentos = 0;
        identidad = { terminalId: msg.terminalId, negocioId: msg.negocioId, sucursalId: msg.sucursalId };
        logger?.info('conexion.autenticada', identidad);
        avisar('conectado', identidad);
        alAutenticar?.(identidad);

        limpiarTemporizadores();
        temporizadorLatido = setInterval(() => {
          if (vigente() && socket.readyState === WebSocket.OPEN) {
            try { socket.send(JSON.stringify({ tipo: 'latido' })); } catch {}
          }
        }, config.heartbeatMs);
        temporizadorLatido.unref?.();
        return;
      }

      if (msg.tipo === 'trabajo_impresion' && msg.trabajo) {
        return alRecibirTrabajo(msg.trabajo);
      }

      if (msg.tipo === 'solicitar_impresoras') {
        // Se responde SIEMPRE, también cuando falla: un panel esperando en
        // silencio es peor que uno que dice "no pude preguntarle al equipo".
        const solicitudId = typeof msg.solicitudId === 'string' ? msg.solicitudId.slice(0, 64) : null;
        alListarImpresoras()
          .then((r) => {
            if (!vigente() || socket.readyState !== WebSocket.OPEN) return;
            try {
              socket.send(JSON.stringify({
                tipo: 'impresoras_detectadas',
                solicitudId,
                ok: r.ok === true,
                impresoras: r.impresoras || [],
                error: r.error || null,
              }));
            } catch (e) { logger?.warn('impresoras.respuesta.error', { error: e.message }); }
          })
          .catch((e) => logger?.warn('impresoras.enumeracion.error', { error: e.message }));
        return;
      }

      if (msg.tipo === 'error') {
        // La nube no dice por qué falló la autenticación (a propósito, para
        // no ayudar a adivinar credenciales). Aquí se registra lo que se
        // sabe y se reintenta con backoff, sin bucle apretado.
        return logger?.error('conexion.rechazada', { mensaje: msg.mensaje });
      }
    });

    socket.on('close', (codigo) => {
      // Un 'close' de un socket ya reemplazado no debe tocar el estado ni
      // programar reconexiones: el vigente sigue su propio ciclo.
      if (!vigente()) return;
      logger?.warn('conexion.cerrada', { codigo, autenticada: !!identidad });
      identidad = null;
      limpiarTemporizadores();
      avisar('desconectado', { codigo });

      // 4001: otro proceso Edge tomó esta identidad. Reconectar sería entrar
      // en una guerra de reconexiones en la que los dos reciben trabajos por
      // turnos, cada uno en su cola local, y la comanda sale dos veces. Uno
      // tiene que perder y quedarse perdido.
      if (codigo === CODIGO_DESPLAZADA) {
        cerradoAdrede = true;
        logger?.error('conexion.desplazada', {
          motivo: 'otro proceso Xabor Edge se conectó con esta misma credencial',
          accion: 'este proceso deja de reconectar: cierra el Edge duplicado y vuelve a arrancar solo uno',
        });
        return;
      }

      programarReconexion();
    });

    socket.on('error', (e) => {
      if (!vigente()) return;
      logger?.warn('conexion.socket.error', { error: e.message });
      // 'close' llega siempre después de 'error': la reconexión se programa
      // allí una sola vez.
    });
  }

  return {
    iniciar() { cerradoAdrede = false; conectar(); },

    // El ACK es lo que cierra el círculo: sin él la nube no sabe si salió
    // papel y el trabajo se quedaría en 'entregado' para siempre.
    confirmar({ trabajoId, resultado, error = null }) {
      if (ws?.readyState !== WebSocket.OPEN) {
        logger?.debug('conexion.ack.aplazado', { jobId: trabajoId, resultado });
        return false;   // se reintentará cuando vuelva la conexión
      }
      try {
        ws.send(JSON.stringify({ tipo: 'ack_impresion', trabajoId, resultado, error }));
        logger?.debug('conexion.ack', { jobId: trabajoId, resultado });
        return true;
      } catch (e) {
        logger?.warn('conexion.ack.fallo', { jobId: trabajoId, error: e.message });
        return false;
      }
    },

    get conectado() { return ws?.readyState === WebSocket.OPEN && !!identidad; },
    get identidad() { return identidad; },

    al(evento, fn) { (escuchas[evento] ||= []).push(fn); },

    cerrar() {
      cerradoAdrede = true;
      limpiarTemporizadores();
      try { ws?.close(); } catch {}
      ws = null;
    },
  };
}
