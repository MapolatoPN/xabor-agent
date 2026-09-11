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
import { crearSalaLocal } from './sala/operacionLocal.js';
import { crearServidorLocal } from './sala/servidorLocal.js';
import { catalogoUtilizable } from '../src/services/catalogoParaEdge.js';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// El almacén guarda texto; lo que se lee de disco puede estar corrupto por un
// apagón a media escritura. Un JSON roto NO puede impedir que el Edge arranque:
// se descarta y se sigue, que es infinitamente mejor que un restaurante sin
// agente porque un archivo quedó a medias.
function leerJson(almacen, clave) {
  try {
    const crudo = almacen.leerEstado(clave);
    return crudo ? JSON.parse(crudo) : null;
  } catch { return null; }
}

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

  // ── Sala local ────────────────────────────────────────────────────────────
  // Se levanta ANTES de conectar, igual que la cola de impresión y por el mismo
  // motivo: si el Edge arranca durante un corte, tiene que poder atender la
  // sala sin haber hablado nunca con la nube. El estado sale del almacén, así
  // que un corte de luz a media mesa no pierde ni la cuenta ni lo que faltaba
  // por subir.
  const salaGuardada = leerJson(almacen, 'sala');
  const sala = crearSalaLocal({ uuid: randomUUID, estadoInicial: salaGuardada });
  if (salaGuardada) {
    log.info('sala.recuperada', {
      cuentas: salaGuardada.cuentas?.length || 0,
      pendientesDeSincronizar: salaGuardada.outbox?.length || 0,
    });
  }

  let catalogo = leerJson(almacen, 'catalogo');
  const servidorSala = crearServidorLocal({
    sala,
    obtenerCatalogo: () => catalogo,
    // La persistencia es síncrona sobre el almacén que ya existe: el servidor
    // no responde "ok" hasta que esto vuelve.
    alCambiar: (estado) => almacen.escribirEstado('sala', JSON.stringify(estado)),
    logger: log,
    puerto: cfg.puertoSala ?? undefined,
  });

  /**
   * Guarda la foto del catálogo y trae las mesas que ya estaban abiertas.
   *
   * Se valida ANTES de reemplazar: una foto vacía pisando a una buena dejaría
   * al restaurante sin poder capturar justo cuando más falta hace.
   */
  function aplicarCatalogo(nuevo) {
    const util = catalogoUtilizable(nuevo);
    if (!util.ok) {
      log.warn('catalogo.descartado', { motivo: util.motivo });
      return { aplicado: false, motivo: util.motivo };
    }
    catalogo = nuevo;
    almacen.escribirEstado('catalogo', JSON.stringify(nuevo));
    const hidratacion = sala.hidratarCuentas(nuevo.cuentasAbiertas || []);
    if (hidratacion.traidas) {
      almacen.escribirEstado('sala', JSON.stringify(sala.serializar()));
    }
    log.info('catalogo.aplicado', {
      productos: util.productos, meseros: util.meseros,
      mesasTraidas: hidratacion.traidas, mesasRespetadas: hidratacion.respetadas,
    });
    return { aplicado: true, ...hidratacion };
  }

  /**
   * Sube lo operado sin enlace. `enviarLote` lo inyecta quien tenga el
   * transporte (hoy, la nube por WebSocket): este módulo no sabe de red.
   *
   * Solo se descarta de la cola lo que la nube CONFIRMÓ. Si la respuesta se
   * pierde después de que allá se guardó, el reintento vuelve a mandar el
   * mismo lote y la ingesta —upsert por UUID— no duplica nada.
   */
  async function sincronizarSala(enviarLote) {
    if (typeof enviarLote !== 'function') return { intentado: false };
    if (!sala.pendientesDeSincronizar()) return { intentado: false, pendientes: 0 };
    const lote = sala.exportarLote();
    try {
      const r = await enviarLote(lote);
      const confirmados = Array.isArray(r?.eventosConfirmados) ? r.eventosConfirmados : [];
      const descartados = sala.marcarLoteSincronizado(confirmados);
      almacen.escribirEstado('sala', JSON.stringify(sala.serializar()));
      log.info('sala.sincronizada', {
        enviados: lote.eventos.length, confirmados: descartados,
        pendientes: sala.pendientesDeSincronizar(),
        conflictos: r?.conflictos ?? 0,
      });
      return { intentado: true, ...r, descartados, pendientes: sala.pendientesDeSincronizar() };
    } catch (e) {
      // No se descarta nada: lo pendiente sigue pendiente y se reintenta.
      log.warn('sala.sincronizacion.fallida', { error: e.message, pendientes: sala.pendientesDeSincronizar() });
      return { intentado: true, error: e.message, pendientes: sala.pendientesDeSincronizar() };
    }
  }

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
    alRecibirCatalogo: (c) => { try { aplicarCatalogo(c); } catch (e) { log.warn('catalogo.fallo', { error: e.message }); } },
    alAutenticar: () => {
      vaciarAcksPendientes();
      // Enlace nuevo: la espera larga se reinicia desde cero.
      cancelarReintentoLento();
      // Al recuperar el enlace: primero subir lo del corte, después refrescar
      // la foto. En ese orden a propósito -- si llegara antes un catálogo con
      // las mesas tal como las dejó la nube, no pisaría nada (hidratar respeta
      // lo local), pero el informe de reconciliación saldría más confuso.
      sincronizarConReintentos();
      conexion.pedirCatalogo();
    },
    // Capacidad cerrada: la nube pide la lista, el Edge la consulta con sus
    // propios medios. Nunca se recibe nada ejecutable desde la nube.
    alListarImpresoras: () => listarImpresorasWindows({ logger: log }),
  });

  /**
   * Sube lo pendiente reintentando, pero SIN insistir a ciegas.
   *
   * Los reintentos se espacian porque el caso típico de fallo es una nube que
   * todavía no está bien: machacarla cada segundo no la arregla y llena el log
   * de ruido. Y se para en cuanto no queda nada pendiente o la conexión se fue
   * -- al volver, `alAutenticar` lo dispara otra vez.
   *
   * Nunca corren dos a la vez: dos envíos del mismo lote no duplicarían nada
   * (la ingesta es idempotente), pero sí podrían confirmar y descartar eventos
   * dos veces sobre una cola que ya cambió.
   */
  let sincronizando = false;
  let reintentoLento = null;
  let esperaLentaMs = 0;
  // Techo de la espera larga. Cinco minutos: lo bastante para no machacar una
  // nube que está mal, lo bastante poco para que el dinero del corte no espere
  // media hora a subir cuando se recupere.
  const ESPERA_LENTA_MAX = 5 * 60 * 1000;

  function cancelarReintentoLento() {
    if (reintentoLento) { clearTimeout(reintentoLento); reintentoLento = null; }
    esperaLentaMs = 0;
  }

  /**
   * Vuelve a intentarlo MÁS TARDE aunque el WebSocket siga vivo.
   *
   * Sin esto quedaba un hueco real: los cuatro intentos iniciales se agotaban,
   * y si la conexión NO se caía —la nube contestando mal, o una base saturada—
   * nadie volvía a intentarlo nunca. El corte se quedaba sin subir hasta que
   * alguien reiniciara el Edge.
   *
   * La espera crece (30 s, 60 s, 120 s… hasta 5 min) porque el fallo típico es
   * una nube que todavía no está bien, y machacarla no la arregla.
   */
  function programarReintentoLento() {
    if (detenido || reintentoLento) return;
    esperaLentaMs = esperaLentaMs ? Math.min(esperaLentaMs * 2, ESPERA_LENTA_MAX) : 30000;
    log.info('sala.reintento.programado', { enMs: esperaLentaMs, pendientes: sala.pendientesDeSincronizar() });
    reintentoLento = setTimeout(() => {
      reintentoLento = null;
      sincronizarConReintentos().catch(() => {});
    }, esperaLentaMs);
    reintentoLento.unref?.();
  }

  async function sincronizarConReintentos({ intentos = 4, esperaMs = 3000 } = {}) {
    // Nunca dos a la vez: dos envíos del mismo lote no duplicarían nada (la
    // ingesta es idempotente), pero sí podrían confirmar y descartar eventos
    // dos veces sobre una cola que ya cambió.
    if (sincronizando) return { intentado: false, motivo: 'ya_en_curso' };
    sincronizando = true;
    try {
      for (let i = 0; i < intentos; i++) {
        if (detenido) return { intentado: false, motivo: 'detenido' };
        if (!conexion.conectado) {
          // Sin enlace no se reprograma: al volver, `alAutenticar` lo dispara.
          return { intentado: false, motivo: 'sin_conexion' };
        }
        if (!sala.pendientesDeSincronizar()) { cancelarReintentoLento(); return { intentado: false, pendientes: 0 }; }
        const r = await sincronizarSala((lote) => conexion.enviarLote(lote));
        // Un CONFLICTO no se arregla reintentando: hace falta que una persona
        // decida. Se deja de insistir con esos, pero lo demás ya subió -- la
        // ingesta trata cada cuenta por separado.
        if (!r.error && r.conflictos > 0) {
          log.warn('sala.conflictos', { conflictos: r.conflictos, pendientes: r.pendientes });
          cancelarReintentoLento();
          return r;
        }
        if (!r.error && !r.pendientes) { cancelarReintentoLento(); return r; }
        await new Promise((ok) => { const t = setTimeout(ok, esperaMs * (i + 1)); t.unref?.(); });
      }
      // Se agotaron los intentos rápidos y sigue habiendo cola con la conexión
      // viva: aquí es donde antes se abandonaba para siempre.
      if (sala.pendientesDeSincronizar() && conexion.conectado) programarReintentoLento();
      return { intentado: true, pendientes: sala.pendientesDeSincronizar(), agotadoRapido: true };
    } finally {
      sincronizando = false;
    }
  }

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
    sala,
    servidorSala,
    aplicarCatalogo,
    sincronizarSala,
    sincronizarConReintentos,

    async iniciar({ conectar = true } = {}) {
      const { valida, errores } = validarConfig(cfg);
      if (!valida && conectar) {
        for (const e of errores) log.error('config.invalida', { detalle: e });
        throw new Error(`configuración inválida: ${errores.join('; ')}`);
      }

      recuperarInterrumpidos(almacen, log);
      worker.iniciar();

      // El servidor de sala va ANTES de conectar, y a propósito: si el Edge
      // arranca durante un corte, las estaciones tienen que encontrarlo. Que
      // no pueda escuchar (puerto ocupado) no puede impedir que imprima: se
      // registra y se sigue.
      try {
        const p = await servidorSala.iniciar();
        log.info('sala.escuchando', { puerto: p });
      } catch (e) {
        log.error('sala.no_escucha', { error: e.message });
      }

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
      cancelarReintentoLento();
      if (anclaVida) { clearInterval(anclaVida); anclaVida = null; }
      conexion.cerrar();
      await servidorSala.detener().catch(() => {});
      await worker.detener();
      // Última foto antes de soltar el almacén: si alguien detuvo el Edge con
      // mesas abiertas, al encender tienen que seguir ahí.
      try { almacen.escribirEstado('sala', JSON.stringify(sala.serializar())); } catch {}
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
