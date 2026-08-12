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
import { listarImpresorasWindows } from './impresorasWindows.js';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function crearEdge({ config, logger, transportes: transportesInyectados = null } = {}) {
  const cfg = config || cargarConfig();
  const log = logger || crearLogger({ nivel: cfg.nivelLog });

  const almacen = crearAlmacen({ almacen: cfg.almacen, rutaDatos: cfg.rutaDatos, logger: log });

  // Identidad de ESTA cola local, no del equipo ni de la terminal. Vive
  // dentro del propio almacén, así que si alguien borra la carpeta de datos
  // desaparece con ella -- que es exactamente lo que se quiere detectar: al
  // volver, el Edge presentará una identidad nueva y la nube sabrá que perdió
  // la memoria de lo que ya había mandado a las impresoras.
  let instalacionId = almacen.leerEstado('instalacion_id');
  if (!instalacionId) {
    instalacionId = randomUUID();
    almacen.escribirEstado('instalacion_id', instalacionId);
    log.info('edge.instalacion.nueva', { instalacionId });
  }
  const transportes = transportesInyectados || crearTransportes({ logger: log, timeoutMs: cfg.timeoutImpresoraMs });

  // ACKs que no se pudieron mandar (la nube estaba caída). Se guardan y se
  // reenvían al reconectar: sin esto, un trabajo impreso durante un corte de
  // internet se quedaría marcado como pendiente en la nube para siempre.
  const acksPendientes = new Map();

  // Un Edge detenido no toca nada más. Cerrar el WebSocket no cancela los
  // mensajes que ya venían en camino: sin esta bandera, uno que llegue justo
  // después de cerrar el almacén intenta escribir en una base cerrada y mata
  // el proceso. Lo encontró el chaos al reiniciar el Edge en caliente.
  let detenido = false;
  // Ver iniciar(): lo único que mantiene vivo el proceso mientras no haya
  // socket abierto. Sin esto, una caída de Cloud mata al agente.
  let anclaVida = null;

  const conexion = crearConexion({
    config: cfg, logger: log, instalacionId,
    alRecibirTrabajo: (trabajo) => recibirTrabajo(trabajo),
    alAutenticar: () => vaciarAcksPendientes(),
    // Capacidad cerrada: la nube pide la lista, el Edge la consulta con sus
    // propios medios. Nunca se recibe nada ejecutable desde la nube.
    alListarImpresoras: () => listarImpresorasWindows({ logger: log }),
  });

  function recibirTrabajo(trabajo) {
    if (detenido) return log.debug('trabajo.ignorado', { motivo: 'el Edge ya se detuvo', jobId: trabajo?.id });
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
      // Lo específico del destino según el transporte (para windows_spooler,
      // el nombre con el que Windows conoce la impresora). Esta lista es
      // explícita a propósito -- no se copia el sobre entero -- y por eso hay
      // que acordarse de añadir aquí cada campo nuevo. Cuando faltó, el dato
      // llegaba bien por el cable, se perdía justo aquí, y el transporte se
      // quedaba sin saber a qué impresora hablarle.
      config: trabajo.config ?? {},
      payload: trabajo.payload ?? {},
    });

    if (!nuevo) {
      const existente = almacen.obtener(trabajo.id);
      log.info('trabajo.duplicado', { jobId: trabajo.id, estado: existente?.estado });
      // Si ya terminó, se reafirma el resultado para que la nube pueda
      // cerrarlo. Si sigue en cola, no se dice nada: ya llegará su ACK.
      if (existente && ['enviado', 'agotado', 'incierto'].includes(existente.estado)) {
        const resultado = existente.estado === 'agotado' ? 'fallido' : existente.estado;
        enviarAck({ trabajoId: trabajo.id, resultado, error: existente.ultimoError });
      }
      return;
    }

    log.info('trabajo.recibido', { jobId: trabajo.id, documento: trabajo.documento, impresora: trabajo.impresoraNombre });
  }

  function enviarAck(ack) {
    if (detenido) return;
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
      const definitivo = resultado === 'enviado' || resultado === 'incierto' ||
                         (resultado === 'fallido' && trabajo.estado === 'agotado');
      if (!definitivo) return;
      enviarAck({ trabajoId: trabajo.id, resultado, error: error || trabajo.ultimoError || null });
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

      // El ancla: mientras el agente esté vivo, Node tiene que quedarse.
      //
      // Todos los temporizadores del Edge llevan .unref() -- el de la cola y
      // el de reconexión incluidos -- para no estorbar a las pruebas, que lo
      // embeben dentro de otro proceso. El efecto secundario, en producción,
      // era letal: cuando el WebSocket se cerraba, el socket dejaba de ser un
      // handle activo y NO QUEDABA NINGUNO. Node se daba por terminado y el
      // proceso salía con código 0 en el mismo instante en que acababa de
      // registrar "conexion.reintento intento=1". El reintento nunca llegaba
      // a ocurrir, y el restaurante se quedaba sin impresión hasta que
      // alguien volvía a arrancar el agente a mano. Fue exactamente lo que
      // pasó en Acuña tras el deploy del 11 de agosto.
      //
      // Este intervalo no hace nada y no se le pone .unref() a propósito: es
      // lo único que declara "este proceso todavía tiene trabajo pendiente".
      // Se apaga en detener(), así que las pruebas que detienen su Edge
      // siguen terminando solas.
      if (!anclaVida) anclaVida = setInterval(() => {}, 60000);

      log.info('edge.listo', { almacen: almacen.tipo, pendientes: almacen.pendientes().length });

      if (conectar) conexion.iniciar();

      // Precalentar el descubrimiento de impresoras, sin esperarlo.
      //
      // El primer PowerShell despues de un reboot paga el arranque en frio del
      // CLR y la inicializacion perezosa de WMI. Si ese coste se paga cuando
      // alguien abre Config -> Impresoras, el listado llega tarde o no llega.
      // Pagandolo aqui, en segundo plano, el primer clic encuentra todo
      // caliente.
      //
      // El resultado se DESCARTA a proposito: esto no alimenta ninguna cache
      // ni decide nada. Y no se hace await: el arranque, la autenticacion y la
      // cola no pueden esperar por esto. Si falla, no se entera nadie salvo el
      // log -- volvera a intentarse cuando alguien lo pida de verdad.
      if (conectar && process.platform === 'win32') {
        listarImpresorasWindows({ logger: log })
          .then((r) => log.debug('impresoras.precalentado', { ok: r.ok, n: r.impresoras.length }))
          .catch(() => { /* el precalentamiento nunca puede romper el arranque */ });
      }
    },

    async detener() {
      // El orden importa: primero se deja de aceptar nada nuevo, después se
      // corta la conexión, luego se espera a que termine el envío en curso, y
      // solo al final se cierra el almacén.
      detenido = true;
      if (anclaVida) { clearInterval(anclaVida); anclaVida = null; }
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
        instalacionId,
        trabajos: almacen.contarPorEstado(),
        acksPendientes: acksPendientes.size,
      };
    },

    // Expuesto para las pruebas de entrega duplicada y de reinicio.
    _recibirTrabajo: recibirTrabajo,
  };
}

// Arranque como proceso, solo si se ejecuta directamente.
//
// La URL se construye con pathToFileURL y NO a mano. Armarla concatenando
// `file://` + la ruta funciona en Linux por casualidad -- ahí la ruta absoluta
// ya empieza por `/` y salen las tres barras -- pero en Windows la ruta empieza
// por letra de unidad, así que quedaba `file://C:/...` (dos barras) frente al
// `file:///C:/...` real de import.meta.url. Nunca coincidían: en Windows este
// bloque no se ejecutaba y `node edge/index.js` salía con 0 sin imprimir nada,
// como si todo hubiera ido bien. Lo descubrió el primer arranque real en la
// Surface, no las pruebas: las suites importan crearEdge() como módulo y nunca
// lanzan el agente como proceso.
const esEjecucionDirecta = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
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
