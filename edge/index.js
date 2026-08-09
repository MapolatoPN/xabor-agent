// Xabor Edge — punto de entrada.
//
//   node edge/index.js
//
// Junta las piezas y las arranca en el orden correcto:
//
//   1. Config validada. Un Edge mal configurado NO arranca a medias.
//   2. Almacén local abierto y trabajos interrumpidos recuperados. Esto va
//      ANTES de conectar: si hubo un corte de luz con comandas a medias, se
//      retoman aunque la nube tarde en responder.
//   3. Worker en marcha, procesando su cola.
//   4. Conexión saliente a la nube.
//
// El orden importa: el Edge es útil desde el segundo 2, sin haber hablado
// todavía con internet.
import { cargarConfig, validarConfig } from './config.js';
import { crearLogger } from './logger.js';
import { crearAlmacen } from './storage/index.js';
import { crearTransportes } from './transports/index.js';
import { crearWorker, recuperarInterrumpidos } from './worker.js';
import { crearConexion } from './connection.js';

export function crearEdge({ config, logger, transportes: transportesInyectados = null } = {}) {
  const cfg = config || cargarConfig();
  const log = logger || crearLogger({ nivel: cfg.nivelLog });

  const almacen = crearAlmacen({ almacen: cfg.almacen, rutaDatos: cfg.rutaDatos, logger: log });
  const transportes = transportesInyectados || crearTransportes({ logger: log, timeoutMs: cfg.timeoutImpresoraMs });

  // ACKs que no se pudieron mandar (la nube estaba caída). Se guardan y se
  // reenvían al reconectar: sin esto, un trabajo impreso durante un corte de
  // internet se quedaría marcado como pendiente en la nube para siempre.
  const acksPendientes = new Map();

  const conexion = crearConexion({
    config: cfg, logger: log,
    alRecibirTrabajo: (trabajo) => recibirTrabajo(trabajo),
    alAutenticar: () => vaciarAcksPendientes(),
  });

  function recibirTrabajo(trabajo) {
    if (!trabajo?.id) return log.warn('trabajo.invalido', { motivo: 'sin id' });

    // Deduplicación de ENTREGA: la nube puede reenviar el mismo trabajo si no
    // recibió el ACK. Aquí se detecta y se responde con lo que ya sabemos, en
    // vez de imprimirlo otra vez.
    const nuevo = almacen.registrarTrabajo({
      id: trabajo.id,
      documento: trabajo.documento,
      impresoraId: trabajo.impresoraId ?? null,
      impresoraNombre: trabajo.impresoraNombre ?? null,
      transporte: trabajo.transporte ?? 'mock',
      host: trabajo.host ?? null,
      puerto: trabajo.puerto ?? null,
      anchoColumnas: trabajo.anchoColumnas ?? 42,
      payload: trabajo.payload ?? {},
    });

    if (!nuevo) {
      const existente = almacen.obtener(trabajo.id);
      log.info('trabajo.duplicado', { jobId: trabajo.id, estado: existente?.estado });
      // Si ya terminó, se reafirma el resultado para que la nube pueda
      // cerrarlo. Si sigue en cola, no se dice nada: ya llegará su ACK.
      if (existente && ['impreso', 'agotado', 'incierto'].includes(existente.estado)) {
        enviarAck({ trabajoId: trabajo.id, resultado: existente.estado === 'impreso' ? 'impreso' : (existente.estado === 'incierto' ? 'incierto' : 'fallido'), error: existente.ultimoError });
      }
      return;
    }

    log.info('trabajo.recibido', { jobId: trabajo.id, documento: trabajo.documento, impresora: trabajo.impresoraNombre });
  }

  function enviarAck(ack) {
    const mandado = conexion.confirmar(ack);
    if (!mandado) acksPendientes.set(ack.trabajoId, ack);
    else acksPendientes.delete(ack.trabajoId);
  }

  function vaciarAcksPendientes() {
    if (!acksPendientes.size) return;
    log.info('ack.reenvio', { pendientes: acksPendientes.size });
    for (const ack of [...acksPendientes.values()]) enviarAck(ack);
  }

  const worker = crearWorker({
    almacen, transportes, config: cfg, logger: log,
    alResolver: ({ trabajo, resultado, error }) => {
      // Solo se confirma un desenlace definitivo. Un 'fallido' que todavía
      // tiene reintentos por delante no se reporta como fracaso: la nube no
      // debe pintar en rojo algo que va a salir en treinta segundos.
      const definitivo = resultado === 'impreso' || resultado === 'incierto' ||
                         (resultado === 'fallido' && trabajo.estado === 'agotado');
      if (!definitivo) return;
      enviarAck({
        trabajoId: trabajo.id,
        resultado: resultado === 'fallido' ? 'fallido' : resultado,
        error: error || trabajo.ultimoError || null,
      });
    },
  });

  return {
    config: cfg,
    logger: log,
    almacen,
    transportes,
    worker,
    conexion,

    async iniciar({ conectar = true } = {}) {
      const { valida, errores } = validarConfig(cfg);
      if (!valida && conectar) {
        for (const e of errores) log.error('config.invalida', { detalle: e });
        throw new Error(`configuración inválida: ${errores.join('; ')}`);
      }

      recuperarInterrumpidos(almacen, log);
      worker.iniciar();
      log.info('edge.listo', { almacen: almacen.tipo, pendientes: almacen.pendientes().length });

      if (conectar) conexion.iniciar();
    },

    async detener() {
      conexion.cerrar();
      await worker.detener();
      almacen.cerrar();
      log.info('edge.detenido', {});
    },

    // Para pruebas y para el runbook: qué tiene la cola ahora mismo.
    estado() {
      return {
        conectado: conexion.conectado,
        identidad: conexion.identidad,
        almacen: almacen.tipo,
        trabajos: almacen.contarPorEstado(),
        acksPendientes: acksPendientes.size,
      };
    },

    // Expuesto para las pruebas de entrega duplicada y de reinicio.
    _recibirTrabajo: recibirTrabajo,
  };
}

// Arranque como proceso, solo si se ejecuta directamente.
const esEjecucionDirecta = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (esEjecucionDirecta) {
  const edge = crearEdge();
  const apagar = async (senal) => {
    edge.logger.info('edge.apagando', { senal });
    await edge.detener();
    process.exit(0);
  };
  process.on('SIGINT', () => apagar('SIGINT'));
  process.on('SIGTERM', () => apagar('SIGTERM'));
  process.on('unhandledRejection', (e) => edge.logger.error('promesa.sin.capturar', { error: e?.message || String(e) }));

  edge.iniciar().catch((e) => {
    edge.logger.error('edge.arranque.fallo', { error: e.message });
    process.exit(1);
  });
}
