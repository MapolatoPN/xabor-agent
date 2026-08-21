// Maneja los pedidos confirmados
// Guarda en DB (persistente) y en memoria para el panel via WebSocket

import {
  guardarPedidoActivo,
  actualizarEstadoPedidoDB,
  archivarPedidoActivo,
  obtenerPedidosActivos,
  obtenerMaxFolioNum,
  eliminarPedido as eliminarPedidoDB,
  obtenerConfiguracion,
  reservarFolioPedido,
  reclamarEmisionPorPago,
  conEmisionExclusiva,
  saldarEmisionPorPago,
  pedidosConEmisionPendiente,
  guardarPedidoProgramado,
  obtenerCreadoAtPedidoActivo,
  registrarCompraReal,
  conEmisionOperacionalExclusiva,
  pedidosConEmisionOperacionalPendiente
} from '../services/database.js';
import { validarOrdenPropuesta, eventoTxn } from './validadorOrden.js';
import { emitirTrabajoImpresion } from '../printing/printRouter.js';
import { emitirComandaDePedidoPorEdge } from '../printing/edgeComanda.js';
import { esPedidoElegibleParaRedRepartidores } from '../utils/elegibilidadRepartidor.js';
import { conIdentidadDePedido } from '../services/eventosPanel.js';

// wsBroadcastNegocio(negocioId, data) → broadcastNegocio real, inyectado
// desde server.js, aislado por negocio. Usado por nuevo_pedido,
// actualizar_estado, eliminar_pedido (los tres ya tienen pedido.negocioId
// confiable). Fail closed: si el pedido no trae negocioId, NO se emite, se
// loguea y punto — nunca se usa Nonna Maye como relleno aquí.
//
// La impresión física (legacy vs. autenticado) ya no se decide aquí: vive
// por completo en printRouter.js, vía emitirTrabajoImpresion — ver
// emitirPedido más abajo.
let wsBroadcastNegocio = null;
const pedidos = [];

// Hotfix P0 folio: tope duro de reintentos al reservar folio en
// registrarPedido(). Un conflicto real es rarísimo (solo si otra instancia
// del deploy o una fila residual ya tomó ese número); 20 candidatos
// consecutivos ocupados significa que el contador quedó muy por detrás de la
// realidad, y en ese caso es preferible fallar explícito
// (FOLIO_NO_DISPONIBLE) que girar sin límite dentro de un webhook.
const MAX_REINTENTOS_FOLIO = 20;

// Canales cuya orden la redacta un LLM (P0): son los únicos que pasan por
// el validador transaccional dentro de registrarPedido. 'test' cubre el
// canal de simulación/chat de prueba y 'api' el endpoint /chat (hoy ese
// endpoint ni siquiera fija negocioId, así que ya fallaba cerrado por
// TENANT_CONTEXT_REQUIRED -- se incluye para que el gate no dependa de
// ese detalle).
const CANALES_ORDEN_LLM = new Set(['whatsapp', 'voz', 'test', 'api']);

export function setWsBroadcast(fnNegocio) {
  wsBroadcastNegocio = fnNegocio;
}

// Fase C (tiempo real, Red de Repartidores): eventos globales para
// Superadmin, inyectado por separado de wsBroadcastNegocio (que es
// por-negocio) -- mismo patrón de inyección ya usado en este archivo.
let wsBroadcastSuperadmin = null;
export function setWsBroadcastSuperadmin(fn) {
  wsBroadcastSuperadmin = fn;
}

// ─── Ex-respaldo temporal de negocio — ELIMINADO (Incidente P0, 2 de
// agosto de 2026) ────────────────────────────────────────────────────────
// Hasta esta corrección, WhatsApp y Voz confiaban en que registrarPedido()
// rellenara negocioId con un caché fijo al negocio Nonna Maye
// (_negocioFallbackId) si el pedido no lo traía ya resuelto. Ese fallback
// era la causa raíz confirmada del incidente real: una conversación de
// WhatsApp de Alora generó un pedido y una comanda que aparecieron en el
// panel de Nonna Maye, y un enlace de pago con las credenciales Clip de
// Nonna Maye, porque whatsapp-meta.js nunca copiaba el negocioId ya
// resuelto (disponible en su propio scope) hacia resultado.orden antes de
// llamar aquí -- el fallback lo disimulaba en vez de fallar.
//
// whatsapp-meta.js y voice.js ahora fijan orden.negocioId explícitamente
// ANTES de llamar a registrarPedido (mismo patrón que Rappi, que nunca
// tuvo este problema). registrarPedido ya no acepta ningún respaldo:
// negocioId ausente es siempre un error para TODOS los canales.
// Reconcilia el estado en memoria con la base. Devuelve cuántos pedidos
// quedaron en memoria (lo usa el arranque para su log).
//
// Hotfix carrera de arranque: antes hacía `pedidos.length = 0` y repoblaba
// con la fotografía leída de la base. Como server.listen aceptaba tráfico en
// paralelo a esta carga, un pedido creado durante la ventana quedaba
// persistido en pedidos_activos pero se BORRABA de memoria (la fotografía es
// anterior a él), y la API respondía después "Pedido no encontrado" sobre una
// fila que sí existía. La causa principal se corrigió en server.js (no se
// escucha hasta terminar el bootstrap); esto es la segunda barrera: lo que
// se creó después de la fotografía se conserva, nunca se descarta.
export async function cargarPedidosDesdeDB() {
  try {
    const [activos, maxFolio] = await Promise.all([
      obtenerPedidosActivos(),
      obtenerMaxFolioNum()
    ]);

    const foliosEnDB = new Set(activos.map(p => p.id));
    // Pedidos que esta instancia creó mientras se leía la base: no están en
    // la fotografía, pero su fila ya existe (registrarPedido solo agrega a
    // memoria después de un INSERT real), así que perderlos sería dejar
    // huérfano un pedido vivo.
    const creadosDuranteLaCarga = pedidos.filter(p => !foliosEnDB.has(p.id));

    pedidos.length = 0;
    for (const p of activos) {
      pedidos.push(p);
    }
    for (const p of creadosDuranteLaCarga) {
      pedidos.push(p);
    }
    if (creadosDuranteLaCarga.length) {
      console.log(`[OrderManager] ${creadosDuranteLaCarga.length} pedido(s) creados durante la carga inicial conservados en memoria`);
    }

    // YA NO SE SIEMBRA NINGÚN CONTADOR AQUÍ.
    //
    // Antes el arranque calculaba el próximo folio a partir del máximo de
    // `pedidos_activos`, y eso es exactamente lo que hacía que el número
    // retrocediera al purgar el tablero. El folio ahora lo entrega
    // `folio_pedido_seq` (migración 059), que es durable y monótona: no hay
    // nada que reconstruir al arrancar y no puede existir una segunda fuente de
    // verdad que compita con ella.
    //
    // `maxFolio` se sigue leyendo solo para dejar constancia en el log de la
    // distancia entre el tablero y la secuencia -- nunca para decidir folios.
    console.log(`[OrderManager] ${pedidos.length} pedidos activos cargados desde DB (max folio en tablero: ${maxFolio}; el folio lo entrega folio_pedido_seq)`);
    return pedidos.length;
  } catch (e) {
    console.error('[OrderManager] Error cargando pedidos desde DB:', e.message);
    throw e;
  }
}

// ASYNC a propósito (segunda corrección de la carrera de asignación de
// repartidor, tras 12-PEDIDO-YA-ASIGNADO-NO-SE-REASIGNA): la persistencia
// inicial en pedidos_activos (guardarPedidoActivo) ahora se espera AQUÍ,
// antes de devolver el pedido -- ya no es fire-and-forget. Todo lo que
// depende del pedido devuelto (ofrecerlo a la red de repartidores, generar
// tokens de aceptación, emitir eventos WebSocket, confirmar al cliente que
// quedó registrado) pasa por callers que usan el valor de retorno de esta
// función, así que ninguno de ellos puede ocurrir antes de que la fila
// exista en la base de datos. Cierra la ventana residual que quedaba tras
// el primer fix (ON CONFLICT DO NOTHING): antes, si asignarRepartidor()
// corría antes de que este INSERT llegara a existir, su UPDATE condicionado
// afectaba cero filas y rechazaba una aceptación válida como si el pedido
// no existiera.
//
// TODOS los llamadores (whatsapp-meta.js, voice.js, rappi.js, whatsapp.js,
// server.js, chat-test.js) deben usar `await registrarPedido(...)` --
// llamarla sin await ahora devuelve una Promise, no el pedido, y
// pedido.id sería undefined.
export async function registrarPedido(orden, canal = 'test') {
  // Fail-closed universal (Incidente P0, Fase 0): TODO canal debe traer
  // orden.negocioId ya resuelto por el borde del canal (WhatsApp, Voz,
  // Rappi, presencial) -- nunca se rellena aquí con un negocio por
  // defecto. Antes de esta corrección, canales distintos de Rappi caían a
  // un caché fijo al negocio Nonna Maye (ver historial de este archivo);
  // esa fue la causa raíz confirmada de que un pedido real de WhatsApp de
  // Alora terminara como comanda de Nonna Maye.
  if (typeof orden.negocioId !== 'string' || !orden.negocioId.trim()) {
    throw new Error(`TENANT_CONTEXT_REQUIRED: registrarPedido sin negocioId resuelto (canal=${canal}) — se rechaza antes de persistir o emitir`);
  }
  const negocioId = orden.negocioId.trim();

  // ── P0 Seguridad transaccional: EL LLM PROPONE, XABOR AUTORIZA ──
  // Para los canales cuyo JSON de orden lo redacta el MODELO (WhatsApp,
  // voz y el canal de prueba), la orden es una PROPUESTA: aquí, dentro de
  // la única puerta de creación de pedidos, se valida contra el catálogo
  // real del negocio y se reemplaza por su forma canónica (producto_id,
  // precios y totales del backend). Este gate es independiente del caller
  // y del prompt: aunque el modelo invente productos, precios o
  // descuentos, no pasan de aquí. Rappi/POS/meseros NO entran por este
  // gate: sus items no los redacta un LLM (Rappi manda su propio payload
  // verificado; el POS construye items desde IDs reales del panel) y
  // tienen sus propias validaciones.
  let estadoInicial = 'nuevo';
  if (CANALES_ORDEN_LLM.has(canal)) {
    const cfg = await obtenerConfiguracion(negocioId).catch(() => ({}));

    // Invariante 7: un negocio en modo solicitud jamás llega a pedido
    // transaccional por el agente, emita lo que emita el modelo.
    if ((cfg.modo_pedidos || 'transaccional') === 'solicitud') {
      eventoTxn('pedido_bloqueado_modo_solicitud', negocioId, { canal });
      const err = new Error('MODO_SOLICITUD: este negocio no confirma pedidos por el agente — la orden se trata como solicitud');
      err.codigo = 'MODO_SOLICITUD';
      throw err;
    }

    const v = await validarOrdenPropuesta(orden, negocioId);
    if (!v.ok) {
      const err = new Error(`ORDEN_INVALIDA: ${v.rechazos.map((r) => r.codigo + (r.nombre ? `(${r.nombre})` : '')).join(', ')}`);
      err.codigo = 'ORDEN_INVALIDA';
      err.rechazos = v.rechazos;
      throw err;
    }
    // La orden canónica REEMPLAZA a la propuesta: de aquí en adelante los
    // nombres/precios/totales son los del backend, no los del modelo.
    orden = { ...v.orden, negocioId };
    orden.ajustesValidacion = v.ajustes.length ? v.ajustes : undefined;

    // Invariante 3: anticipo estructurado. Si el negocio lo exige, el
    // pedido NACE pendiente_pago y no puede confirmarse ni generar
    // comanda hasta que el pago se valide (ver emitirPedido y
    // confirmarPedidoPendientePago).
    if (String(cfg.pedido_requiere_anticipo || '').toLowerCase() === 'true') {
      estadoInicial = 'pendiente_pago';
      eventoTxn('pedido_nace_pendiente_pago', negocioId, { canal, total: orden.total });
    }
  }

  // ── Pago en línea: el pedido nace pendiente_pago ──
  // Misma puerta que el anticipo estructurado, por otro camino: cuando el
  // cliente eligió pagar EN LÍNEA, el pedido no puede entrar a cocina hasta
  // que el webhook verificado confirme el dinero. El gate vive en
  // emitirPedido; aquí solo se fija el estado inicial.
  //
  // La bandera la pone el checkout EN EL SERVIDOR, a partir del método de
  // pago que él mismo resolvió contra metodos_pago del negocio. Nunca llega
  // del navegador: el cuerpo de la petición no la lleva, y aunque la llevara,
  // construirOrdenPOS no la copia.
  if (orden.requierePagoAnticipado === true) {
    estadoInicial = 'pendiente_pago';
    eventoTxn('pedido_nace_pendiente_pago', negocioId, { canal, total: orden.total });
  }

  const base = {
    ...orden,
    negocioId,
    canal,
    timestamp: new Date().toISOString(),
    estado: estadoInicial
  };

  // Persistencia inicial ANTES de tocar el estado en memoria: si falla de
  // verdad (error de base de datos, no un simple conflicto de folio), no
  // se agrega nada a `pedidos` -- el llamador recibe un error explícito en
  // vez de un pedido "confirmado" que nunca quedó guardado.
  // guardarPedidoActivo() nunca lanza (ver su propio comentario en
  // database.js); su valor de retorno estructurado es la única señal.
  //
  // EL FOLIO SALE DE UNA SECUENCIA DURABLE (migración 059), no de un contador
  // en memoria.
  //
  // El contador anterior se sembraba con `obtenerMaxFolioNum()`, que mira
  // `pedidos_activos` Y NADA MÁS: en cuanto el tablero se purgaba y el proceso
  // reiniciaba, RETROCEDÍA y volvía a entregar folios ya usados. Medido en la
  // base local: MAX(pedidos_activos)=9578 contra MAX(pedidos)=10321 — 743
  // folios vivos que se habrían reemitido en el siguiente arranque. Y el folio
  // es la identidad de la que cuelgan el dedupe del panel, la idempotencia de
  // Edge, los pagos, las promociones y las compras reales.
  //
  // `nextval()` es atómico entre requests Y entre instancias, sobrevive al
  // reinicio y no depende de que ninguna fila siga existiendo. El bucle de
  // reintento se conserva para las filas residuales de la época del contador en
  // memoria: si el INSERT no escribió fila, ese folio es de OTRO pedido y se
  // pide el siguiente a la secuencia. NUNCA se adopta el pedido existente que
  // comparte folio ni se devuelve éxito sin fila propia.
  let pedido = null;
  let intento = 0;
  while (intento < MAX_REINTENTOS_FOLIO) {
    intento++;
    const folio = await reservarFolioPedido();
    const candidato = { ...base, id: folio };

    const r = await guardarPedidoActivo(candidato, negocioId);
    if (r.insertado) {
      pedido = candidato;
      break;
    }
    if (!r.ok) {
      // Error real de base de datos: no es un conflicto de folio, así que
      // reintentar con otro número no arregla nada y podría enmascararlo.
      throw new Error(`PEDIDO_NO_PERSISTIDO: no se pudo guardar ${folio} en pedidos_activos — pedido rechazado antes de ofrecerlo a repartidores o confirmarlo al cliente`);
    }
    console.warn(`[Pedido] Conflicto de folio ${folio}, reintentando (intento ${intento}/${MAX_REINTENTOS_FOLIO}, canal=${canal})`);
  }

  if (!pedido) {
    throw new Error(`FOLIO_NO_DISPONIBLE: ${MAX_REINTENTOS_FOLIO} folios consecutivos ya existían en pedidos_activos (canal=${canal}) — pedido rechazado sin confirmar al cliente`);
  }

  pedidos.push(pedido);

  console.log('\n' + '='.repeat(50));
  console.log(`🎉 NUEVO PEDIDO: ${pedido.id} [${canal}]`);
  console.log(`   Cliente: ${pedido.cliente?.nombre} — $${pedido.total} MXN`);
  console.log('='.repeat(50) + '\n');

  return pedido;
}

// ─── Elegibilidad para la red de repartidores de Xabor ──────────────────────
// Implementación movida a utils/elegibilidadRepartidor.js (leaf util, sin
// dependencias) para que database.js (Red de Repartidores Superadmin)
// pueda importarla también sin crear un ciclo (este módulo ya importa de
// forma estática desde database.js). Se re-exporta aquí para no romper a
// los consumidores existentes (whatsapp-meta.js, pruebas) que ya importan
// esPedidoElegibleParaRedRepartidores desde orderManager.js.
export { esPedidoDeRedExterna, esPedidoElegibleParaRedRepartidores } from '../utils/elegibilidadRepartidor.js';

// ── P0-11: núcleo idempotente de la emisión OPERACIONAL ─────────────────────
// Compra real + Edge + panel + impresión legacy + (solo si `intentarReparto`)
// notificación a repartidores. NO decide si debe correr (eso es de la deuda
// + el claim, ver `conEmisionOperacionalExclusiva`) ni marca nada como
// saldado -- solo ejecuta, y cada efecto trae su propia idempotencia (UNIQUE
// de compras_reales, eventId determinístico del panel, ledger de
// impresion_trabajos). ÚNICO lugar donde vive esta lógica: ni el scheduler
// de programados (server.js) ni el reconciliador la reimplementan, la
// llaman.
//
// P0-11B (auditoria independiente, corregido tras el checkpoint): esta
// misma funcion la invocan TANTO `emitirPedido` (foreground) COMO
// `reconciliarEmisionesOperacionalesPendientes` (recovery) -- el comentario
// original decia que reparto quedaba "fuera del retry", pero el codigo real
// lo dejaba DENTRO de la parte que las dos rutas comparten. Si el proceso
// moria despues de notificar a repartidores pero antes de saldar la deuda,
// el recovery volvia a correr TODO el nucleo, incluida la notificacion --
// sin ninguna idempotencia propia, una segunda oferta de WhatsApp. La
// bandera `intentarReparto` la fija el CALLER: solo `emitirPedido` la pasa
// en `true`. El reconciliador nunca la pasa (default `false`, fail closed).
// Perder una oferta de reparto si el proceso muere justo despues de
// mandarla es una limitacion aceptada a proposito -- duplicarla no lo es.
// P0-11 Fase 2: puntos de crash REAL inyectables, uno por frontera del
// nucleo, para la suite fase-emision-operacional-crash-real.mjs. Mismo
// candado de produccion que el resto del proyecto (inerte fuera de
// pruebas): con XABOR_PEDIDOS_MATAR_PROCESO='1' muere de verdad
// (process.exit(137), mismo codigo que P0-15E); sin ella, lanza (para
// pruebas mas ligeras que solo necesitan el throw, como
// fase-compra-operacional-critica.mjs).
function _puntoDeCrashOperacional(marca) {
  if (process.env.NODE_ENV !== 'production' && process.env.XABOR_PEDIDOS_FALLA_EN === marca) {
    if (process.env.XABOR_PEDIDOS_MATAR_PROCESO === '1') process.exit(137);
    const e = new Error(`Fallo inyectado en '${marca}'`);
    e.inyectado = true;
    throw e;
  }
}

async function _ejecutarEfectosOperacionales(pedido, creadoAt, { intentarReparto = false } = {}) {
  // Punto de crash A: la deuda ya esta COMMIT (la creo el trigger de la 063
  // en el INSERT/UPDATE de pedidos_activos, antes de esta llamada) y el
  // proceso muere ANTES de que el nucleo intente nada.
  _puntoDeCrashOperacional('antes_emision');

  // COMPRA REAL para efectivo, terminal y pago al recibir. Aqui el negocio ya
  // se comprometio: la comanda sale a cocina. El dinero fisico se cobra despues
  // y no hay ningun webhook que esperar -- esperarlo seria esperar algo que
  // nunca llega.
  // La marca es CRITICA y va ANTES del primer efecto externo.
  //
  // Antes era `.catch(log)` y el flujo continuaba: un fallo de base dejaba el
  // pedido cocinado, impreso y en el tablero, pero sin compra durable -- y el
  // cliente volvia a parecer nuevo, con derecho a la promocion de primera
  // compra que ya habia gastado. Un efecto externo irreversible respaldado por
  // un registro que no existe.
  //
  // Idempotente por el UNIQUE (negocio, folio, creado_at): reemitir tras un
  // crash no crea una segunda compra.
  const marca = await registrarCompraReal(null, {
    negocioId: pedido.negocioId,
    folio: pedido.id,
    telefono: pedido.cliente?.telefono || null,
    origen: 'operacion',
    pedidoCreadoAt: creadoAt,
  });
  if (!marca.ok) {
    throw new Error(`COMPRA_NO_DURABLE: la compra real de ${pedido.id} no quedo registrada (${marca.razon}) — no se emite comanda ni ningun efecto externo`);
  }
  // Punto de crash B, DESPUES del COMMIT de la compra: el retry debe
  // reemitir la comanda sin duplicar la compra.
  _puntoDeCrashOperacional('despues_compra_real');

  // PRIMERO Edge, DESPUÉS el panel. El orden no es estético: el evento que
  // recibe el panel tiene que decir la verdad sobre si el papel ya está en
  // camino, y eso solo se sabe cuando el trabajo existe. Avisar antes
  // obligaría al navegador a adivinar, que es exactamente lo que provocaba
  // el diálogo de Chrome sobre una comanda que Edge iba a imprimir sola.
  const edge = await emitirComandaDePedidoPorEdge(pedido);

  // Punto de crash C: el job de Edge ya quedo creado (durable, con su
  // propio ledger de idempotencia) y el proceso muere ANTES de avisarle al
  // panel.
  _puntoDeCrashOperacional('despues_edge');

  if (wsBroadcastNegocio) {
    // Con identidad deterministica: el backend no puede prometer que este
    // evento salga una sola vez -- morir entre el envio y la marca durable
    // obliga al retry a reemitir --, pero si puede prometer que el mismo
    // pedido llegue siempre con la MISMA clave, para que el panel haga un
    // solo efecto logico.
    wsBroadcastNegocio(pedido.negocioId, conIdentidadDePedido(
      { tipo: 'nuevo_pedido', pedido, impresionEdge: edge.seHizoCargo }, pedido));
  }

  // Punto de crash D: el evento del panel ya salio (best-effort, sin ACK --
  // ver frontera documentada mas abajo) y el proceso muere ANTES de
  // terminar el resto del nucleo.
  _puntoDeCrashOperacional('despues_panel');

  // Impresión física por el camino anterior (print-agent legacy o
  // autenticado): decidida por completo dentro de printRouter.js. Nunca
  // lanza -- cualquier error de configuración/sucursal/broadcast ya se
  // captura ahí y se traduce en un resultado 'omitido'.
  //
  // Solo se dispara si Edge NO se hizo cargo. Un negocio que todavía usa
  // print-agent.js sigue igual que siempre; uno que ya migró a Edge no
  // recibe la misma comanda por dos vías. La exclusión vale para los tres
  // consumidores del camino viejo: print-agent legacy, print-agent
  // autenticado y el navegador.
  if (!edge.seHizoCargo) {
    await emitirTrabajoImpresion(pedido);
  }

  // Punto de crash E: el trabajo de impresion legacy (si corrio) ya quedo
  // durable en su propio ledger (impresion_trabajos) y el proceso muere
  // ANTES de saldar la deuda.
  _puntoDeCrashOperacional('despues_print');

  // Notificar a repartidores -- única fuente de verdad: esPedidoElegibleParaRedRepartidores.
  // Best-effort, y ahora GENUINAMENTE fuera del retry: `intentarReparto`
  // solo llega en `true` desde la llamada foreground de `emitirPedido`. El
  // reconciliador (recovery) nunca la activa, así que un crash justo
  // después de mandar la oferta no la duplica en el siguiente ciclo.
  if (intentarReparto && esPedidoElegibleParaRedRepartidores(pedido)) {
    // Fase C: el servicio ya existe como "buscando" desde este momento
    // (independiente de si la notificación por WhatsApp más abajo tiene
    // éxito o no -- ver derivarEstadoServicioReparto en database.js).
    // Payload mínimo, nunca datos del cliente ni del repartidor.
    try {
      wsBroadcastSuperadmin?.({ tipo: 'red_repartidores_nuevo_servicio', folio: pedido.id, negocioId: pedido.negocioId });
      wsBroadcastNegocio?.(pedido.negocioId, { tipo: 'red_repartidores_nuevo_servicio', folio: pedido.id }, { soloAdmin: true });
    } catch (e) {
      console.error('[WS] Error emitiendo red_repartidores_nuevo_servicio:', e.message);
    }
    const promesaReparto = import('../channels/whatsapp-meta.js').then(({ notificarRepartidoresPorWA }) => {
      return notificarRepartidoresPorWA(pedido).catch(() => {});
    }).catch(() => {});

    // Punto de muerte REAL inyectable, SOLO para pruebas (P0-11B): fuera de
    // pruebas esta rama nunca se toca y `promesaReparto` sigue sin esperarse
    // (fire-and-forget real, igual que antes). Bajo el fallo inyectado, se
    // espera a que el intento de notificacion salga de verdad ANTES de matar
    // el proceso -- para que la prueba de crash+recovery pueda contar con
    // precision cuantas veces se disparo la oferta, en vez de dejarlo a una
    // carrera entre el I/O y `process.exit`.
    if (process.env.NODE_ENV !== 'production'
        && process.env.XABOR_PEDIDOS_FALLA_EN === 'despues_notificar_reparto') {
      await promesaReparto;
      if (process.env.XABOR_PEDIDOS_MATAR_PROCESO === '1') process.exit(137);
    }
  }

  // Punto de crash F: TODOS los efectos externos ya corrieron (compra,
  // Edge, panel, print, reparto si aplicaba) y el proceso muere
  // INMEDIATAMENTE ANTES de que el caller (conEmisionOperacionalExclusiva)
  // haga el UPDATE que salda la deuda. Distinto de 'despues_notificar_reparto'
  // (que exige intentarReparto=true): este corre siempre.
  _puntoDeCrashOperacional('antes_saldar');
}

export async function emitirPedido(pedido) {
  // ── P0 Invariante 4: la comanda está detrás del gate de pago ──
  // Un pedido pendiente_pago NUNCA emite comanda, ni impresión, ni oferta
  // a repartidores, aunque un bug del prompt o un caller equivocado llame
  // aquí directo. El panel recibe un evento distinto para poder mostrarlo
  // como pendiente sin tratarlo como comanda.
  if (pedido.estado === 'pendiente_pago') {
    eventoTxn('comanda_bloqueada_pendiente_pago', pedido.negocioId || '(sin negocio)', { folio: pedido.id });
    if (typeof pedido.negocioId === 'string' && pedido.negocioId.trim() && wsBroadcastNegocio) {
      wsBroadcastNegocio(pedido.negocioId, { tipo: 'pedido_pendiente_pago', pedido });
    }
    return { seHizoCargo: false, bloqueadoPorPago: true };
  }

  if (typeof pedido.negocioId !== 'string' || !pedido.negocioId.trim()) {
    // Fail closed: sin negocioId no hay identidad que reclamar (ni panel al
    // que avisar). No debería pasar hoy (Rappi siempre lo trae,
    // WhatsApp/Voz/presencial lo fijan antes de llamar aquí), pero si
    // ocurre es señal real de que algo quedó sin resolver.
    console.error(`[OrderManager] emitirPedido: pedido ${pedido.id} sin negocioId — no se emite ningun efecto (fail closed)`);
    return { seHizoCargo: false, razon: 'sin_negocio' };
  }

  // El `created_at` se lee de la fila durable porque EL FOLIO SE RECICLA:
  // `obtenerMaxFolioNum()` solo mira `pedidos_activos`, asi que tras una purga
  // el contador retrocede y el mismo folio vuelve a salir para otro cliente.
  // Es tambien la identidad exacta de la DEUDA de emision (P0-11, 063).
  const creadoAt = await obtenerCreadoAtPedidoActivo(pedido.negocioId, pedido.id);
  if (!creadoAt) {
    throw new Error(`COMPRA_NO_DURABLE: no se pudo determinar la identidad del pedido ${pedido.id} (su fila ya no esta en pedidos_activos) — no se emite comanda ni ningun efecto externo`);
  }

  // P0-11: reclamar la deuda (creada por el trigger de la 063 al INSERT/
  // UPDATE de pedidos_activos -- nunca aqui) bajo advisory lock, releer el
  // pedido desde la base dentro del lock (nunca el `pedido` que llego como
  // parametro, que puede ser JSON viejo de memoria) y ejecutar el nucleo
  // UNA sola vez. Si otro proceso ya esta emitiendo, o ya lo hizo, o el
  // pedido ya no esta activo, no se ejecuta nada.
  const r = await conEmisionOperacionalExclusiva(pedido.negocioId, pedido.id, creadoAt, async (activo) => {
    const fresco = { ...activo.datos, id: activo.folio, negocioId: activo.negocio_id, estado: activo.estado };
    await _ejecutarEfectosOperacionales(fresco, creadoAt, { intentarReparto: true });
  });

  return { seHizoCargo: r.emitio === true, razon: r.razon };
}

// Barrido de reconciliación de EMISIÓN OPERACIONAL (P0-11): recoge lo que un
// crash dejó a medias cuando nadie reintenta desde fuera. Nombre distinto de
// `reconciliarEmisionesPendientes` (arriba, financiero) para no confundir
// los dos conceptos -- esta no depende de pago, esa no depende de cocina.
export async function reconciliarEmisionesOperacionalesPendientes(limite = 50) {
  const filas = await pedidosConEmisionOperacionalPendiente(limite).catch(() => []);
  let recuperados = 0;
  for (const f of filas) {
    try {
      const r = await conEmisionOperacionalExclusiva(f.negocio_id, f.folio, f.pedido_creado_at, async (activo) => {
        const fresco = { ...activo.datos, id: activo.folio, negocioId: activo.negocio_id, estado: activo.estado };
        // intentarReparto explicitamente false: el recovery NUNCA notifica
        // repartidores (P0-11B) -- ver el comentario de _ejecutarEfectosOperacionales.
        await _ejecutarEfectosOperacionales(fresco, f.pedido_creado_at, { intentarReparto: false });
      });
      if (r.emitio) recuperados++;
    } catch (e) {
      console.error(`[Emision] No se pudo recuperar la emision operacional de ${f.folio}: ${e.message}`);
    }
  }
  if (recuperados) console.log(`[Emision] Emisiones operacionales recuperadas tras crash: ${recuperados}`);
  return recuperados;
}

// Lógica de persistencia compartida entre actualizarEstadoPedido (seguro,
// exige negocioId) y actualizarEstadoPedidoLegacySinNegocio (repartidor,
// ver más abajo por qué no puede exigirlo todavía). Ninguna decisión de
// autorización vive en este helper -- cada función pública exportada
// decide si el pedido puede mutarse ANTES de llamarlo.
function _persistirCambioEstado(pedido, nuevoEstado) {
  pedido.estado = nuevoEstado;

  if (nuevoEstado === 'entregado') {
    archivarPedidoActivo(pedido.id);
    // Rewards — fire-and-forget, nunca bloquea el flujo crítico.
    // negocioId (Incidente P0): antes acumulaba SIEMPRE bajo el tenant
    // hardcodeado 'xabor-principal' sin importar de qué negocio era el
    // pedido -- si pedido.negocioId no se pudo resolver, se omite la
    // acumulación en vez de acumular puntos bajo el negocio equivocado.
    if (pedido.negocioId) {
      import('../services/rewardsService.js')
        .then(({ acumularPuntos }) => acumularPuntos(pedido.id, pedido, pedido.negocioId))
        .catch(e => console.error('[Rewards] Error en hook de acumulación:', e.message));
    } else {
      console.warn(`[Rewards] Pedido ${pedido.id} sin negocioId — acumulación de puntos omitida (fail closed)`);
    }
  } else {
    actualizarEstadoPedidoDB(pedido.id, nuevoEstado);
  }

  // Aislado por negocio (ver reporte de esta fase) -- nunca llega a
  // print-agent (legado) ni a otros negocios. pedido.negocioId es
  // confiable independientemente de qué caller invocó esta función
  // (actualizarEstadoPedido con sesión real, o
  // actualizarEstadoPedidoLegacySinNegocio vía repartidor): es una
  // propiedad del pedido en sí, fijada al crearlo, no del caller.
  if (typeof pedido.negocioId === 'string' && pedido.negocioId.trim()) {
    if (wsBroadcastNegocio) wsBroadcastNegocio(pedido.negocioId, { tipo: 'actualizar_estado', id: pedido.id, estado: nuevoEstado });
  } else {
    console.error(`[OrderManager] _persistirCambioEstado: pedido ${pedido.id} sin negocioId — no se emite (fail closed)`);
  }
}

// negocioId (Fase 6, revisión): OBLIGATORIO y estricto — nunca opcional.
// Sin un negocioId válido, se rechaza de inmediato (mismo criterio que
// obtenerPedidos: nunca operar "para cualquiera" por accidente). Un
// pedido inexistente y un pedido de otro negocio se tratan exactamente
// igual (ambos devuelven null) para que la ruta responda 404 genérico sin
// revelar cuál de los dos casos ocurrió.
//
// El único llamador que hoy NO tiene una sesión de negocio real
// (el flujo de repartidor, autenticado por token individual vía
// requireRepartidor, no por negocio) usa actualizarEstadoPedidoLegacySinNegocio
// en su lugar -- ver esa función más abajo para el diagnóstico completo.
export function actualizarEstadoPedido(id, nuevoEstado, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn(`[OrderManager] actualizarEstadoPedido: negocioId inválido u omitido — folio=${id}, rechazado`);
    return null;
  }
  const negocioIdNorm = negocioId.trim();

  const pedido = pedidos.find(p => p.id === id);
  if (!pedido) return null;

  if (pedido.negocioId !== negocioIdNorm) {
    // Log seguro: solo folio y negocioId de la sesión (ambos son
    // identificadores internos, no datos personales) — nunca cliente,
    // teléfono, dirección, items ni el pedido completo.
    console.warn(`[OrderManager] Acceso cruzado bloqueado — folio=${id} negocio_sesion=${negocioIdNorm}`);
    return null;
  }

  // ── Invariante tienda_online: sin dinero confirmado no hay cocina ──
  // Un pedido del canal tienda_online en pendiente_pago SOLO sale de ahí por
  // el flujo de pagos (confirmarPedidoPendientePago, que no pasa por aquí) o
  // por cancelación. Ningún cambio manual de estado —un clic del panel, un
  // llamador nuevo— puede meterlo a cocina sin pagar. Vive AQUÍ y no solo en
  // el PATCH para que cualquier llamador herede la regla. Otros canales
  // (anticipo estructurado de WhatsApp, POS, Rappi) conservan su
  // comportamiento: la condición exige canal tienda_online.
  if (pedido.estado === 'pendiente_pago' && pedido.canal === 'tienda_online'
      && nuevoEstado !== 'cancelado') {
    eventoTxn('transicion_bloqueada_pago_pendiente', negocioIdNorm, { folio: id, destino: nuevoEstado });
    const e = new Error(`El pedido ${id} de la tienda en línea aún no está pagado`);
    e.codigo = 'PAGO_PENDIENTE';
    throw e;
  }

  _persistirCambioEstado(pedido, nuevoEstado);
  return pedido;
}

// ⚠ PENDIENTE DE SEGURIDAD — sin verificación de negocio, a propósito.
// Diagnóstico (ver reporte de esta tarea): el flujo de repartidor
// (requireRepartidor en server.js) autentica por un token individual del
// repartidor -- SELECT * FROM repartidores WHERE token=$1 -- no por
// sesión de negocio, y registrarRepartidor (whatsapp-meta.js, fuera del
// alcance de esta tarea) nunca puebla repartidores.negocio_id en su
// INSERT. Hoy no existe ninguna forma confiable de derivar un negocioId
// real desde la identidad del repartidor -- inventar uno (o usar Nonna
// Maye como relleno) sería exactamente el tipo de fallback silencioso que
// esta fase busca evitar. Por eso esta función queda SEPARADA y
// EXPLÍCITA en vez de volver opcional el parámetro de la función segura.
//
// Uso exclusivo: POST /api/repartidor/pedido/:folio/entregado (server.js).
// NO debe usarse desde GET/PATCH /pedidos, Rappi, ni ningún otro
// llamador. Conserva EXACTAMENTE el comportamiento previo a esta tarea
// (busca el pedido solo por folio, sin más verificación). Riesgo
// heredado, no introducido aquí: un repartidor con un token válido podría
// en teoría marcar como entregado un folio de cualquier negocio si lo
// conociera -- mismo riesgo que ya existía antes de este commit, ahora
// aislado en su propia función para que quede visible y no se mezcle con
// la ruta segura de negocios.
export function actualizarEstadoPedidoLegacySinNegocio(id, nuevoEstado) {
  const pedido = pedidos.find(p => p.id === id);
  if (!pedido) return null;
  _persistirCambioEstado(pedido, nuevoEstado);
  return pedido;
}

// negocioId OBLIGATORIO y estricto. Sin él, siempre [] -- nunca el arreglo
// completo por accidente. Ya no existe ninguna variante sin filtrar: la que
// había (obtenerTodosPedidosParaWebSocketLegacy, que devolvía los pedidos de
// TODOS los negocios para el volcado del WebSocket legado) está eliminada. El
// agente legado ahora recibe solo los trabajos pendientes de SU negocio, desde
// la cola de impresión, y no el tablero en memoria.
export function obtenerPedidos(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  const negocioIdNorm = negocioId.trim();
  return pedidos.filter(p => p.negocioId === negocioIdNorm);
}

// negocioId opcional pero VERIFICADO cuando se pasa (Incidente P0): folios
// son secuenciales y por tanto adivinables entre negocios (XAB-0001,
// XAB-0002...). Cuando el llamador YA conoce a qué negocio pertenece la
// conversación/sesión en curso (p. ej. WhatsApp resolviendo un pago
// pendiente para SU cliente), debe pasar negocioId -- un pedido de otro
// negocio se trata idéntico a uno inexistente (undefined), nunca se
// devuelve. Se omite (undefined) únicamente en los pocos llamadores que
// legítimamente todavía no saben el negocio y lo van a DESCUBRIR a partir
// del pedido devuelto (p. ej. el webhook de Clip, que solo trae el folio;
// ver server.js) -- esos siempre usan pedido.negocioId después, nunca
// asumen ni comparten datos entre negocios distintos.
export function obtenerPedidoPorId(id, negocioId) {
  const pedido = pedidos.find(p => p.id === id);
  if (!pedido) return undefined;
  if (typeof negocioId === 'string' && negocioId.trim() && pedido.negocioId !== negocioId.trim()) {
    return undefined;
  }
  return pedido;
}

// ── P0: única transición autorizada pendiente_pago → confirmado ─────────────
// La invoca EXCLUSIVAMENTE el flujo de pagos (webhook de la pasarela ya
// re-verificado contra el proveedor, o conciliación) -- nunca el LLM, nunca
// el cliente. Es idempotente: un pedido que ya no está pendiente_pago no se
// re-emite. Al confirmar: estado 'nuevo' (entra al flujo normal de cocina)
// y AHORA SÍ se emite la comanda que el gate de emitirPedido venía
// bloqueando.
export async function confirmarPedidoPendientePago(folio, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const nid = negocioId.trim();

  // La autoridad es la BASE, no el arreglo en memoria. El reclamo mueve el
  // estado y escribe la deuda de emisión en el MISMO UPDATE; si otro proceso
  // ya la reclamó y la saldó, aquí no queda nada que hacer y se responde null
  // -- idempotente. Si un crash dejó la deuda escrita, este reclamo la
  // encuentra aunque el pedido ya esté en 'nuevo': eso es lo que hace que la
  // comanda perdida se recupere en vez de darse por procesada.
  const reclamo = await reclamarEmisionPorPago(folio, nid);
  if (!reclamo.reclamado) return null;

  eventoTxn('transicion_pendiente_pago_confirmado', nid, { folio });

  // Punto de fallo inyectable: EXACTAMENTE entre persistir la transición (con
  // su deuda de emisión) y emitir. Es la ventana que dejaba a la cocina sin
  // papel con el dinero ya cobrado. Mismo candado de producción que el resto
  // de la inyección de fallos del proyecto.
  if (process.env.NODE_ENV !== 'production'
      && process.env.XABOR_PAGOS_FALLA_EN === 'antes_de_emitir_por_pago') {
    const e = new Error("Fallo inyectado en 'antes_de_emitir_por_pago'");
    e.inyectado = true;
    throw e;
  }

  // Escribir la deuda es durable, pero NO da exclusividad: dos procesos pasan
  // los dos por ese UPDATE. El claim real es el lock, y quien no lo obtiene no
  // emite. Sin esto, veinte confirmaciones simultáneas entraban veinte veces a
  // emitirPedido y sólo la idempotencia de cada efecto tapaba el desastre.
  let pedido = null;
  const r = await conEmisionExclusiva(folio, nid, async (datos) => {
    // El pedido en memoria puede no existir (proceso nuevo tras el crash): se
    // reconstruye desde lo que la base guardó, que es la fuente de verdad.
    pedido = pedidos.find(p => p.id === folio && p.negocioId === nid);
    if (!pedido) {
      pedido = { ...datos, id: folio, negocioId: nid, estado: 'nuevo' };
      agregarPedidoAMemoria(pedido);
    } else {
      pedido.estado = 'nuevo';
    }
    await emitirPedido(pedido);
  });

  // Quien perdió el lock no emitió: devuelve null, igual que quien no tenía
  // deuda. Para el llamador, "no hice nada" es la misma respuesta.
  return r.emitio ? pedido : null;
}

// Red de seguridad: recoge las emisiones que un crash dejó a medias cuando
// nadie reintenta desde fuera. Reutiliza la MISMA transición -- no hay una
// segunda vía de confirmación que pudiera divergir.
export async function reconciliarEmisionesPendientes(limite = 50) {
  const filas = await pedidosConEmisionPendiente(limite).catch(() => []);
  let recuperados = 0;
  for (const f of filas) {
    try {
      const r = await confirmarPedidoPendientePago(f.folio, f.negocio_id);
      if (r) recuperados++;
    } catch (e) {
      console.error(`[Pagos] No se pudo recuperar la emisión de ${f.folio}: ${e.message}`);
    }
  }
  if (recuperados) console.log(`[Pagos] Emisiones recuperadas tras crash: ${recuperados}`);
  return recuperados;
}

// Agrega un pedido al array en memoria sin generar folio ni guardar en DB.
// Usado por el job de activación de pedidos programados.
export function agregarPedidoAMemoria(pedido) {
  if (!pedidos.find(p => p.id === pedido.id)) {
    pedidos.push(pedido);
  }
}

// negocioId OBLIGATORIO y estricto (Auditoría P0, mutaciones por folio) —
// mismo criterio que actualizarEstadoPedido: un folio de otro negocio se
// comporta idéntico a un folio inexistente (false), nunca se revela ni se
// toca. El único llamador que legítimamente no tiene negocioId de sesión
// (activación de pedidos programados, servidor mismo) sigue funcionando
// porque conoce el pedido.negocioId real de antemano.
export async function eliminarPedido(id, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn(`[OrderManager] eliminarPedido: negocioId inválido u omitido — folio=${id}, rechazado`);
    return false;
  }
  const negocioIdNorm = negocioId.trim();
  const idx = pedidos.findIndex(p => p.id === id);
  if (idx === -1) return false;
  const pedido = pedidos[idx]; // capturado ANTES del splice, para conservar negocioId

  if (pedido.negocioId !== negocioIdNorm) {
    console.warn(`[OrderManager] eliminarPedido: acceso cruzado bloqueado — folio=${id} negocio_sesion=${negocioIdNorm}`);
    return false;
  }

  pedidos.splice(idx, 1);
  await eliminarPedidoDB(id);
  if (wsBroadcastNegocio) wsBroadcastNegocio(pedido.negocioId, { tipo: 'eliminar_pedido', id });
  return true;
}

// ── P0-16: la conversión activo→programado es DURABLE (DB) Y en MEMORIA ────
// `guardarPedidoProgramado` (062) ya hace la transición atómica en la base:
// asegura la reserva, mueve el claim y retira `pedidos_activos` en una sola
// transacción. Pero `pedido` había entrado al arreglo `pedidos` por
// `registrarPedido()`, y desde que los canales dejaron de llamar
// `eliminarPedido()` por separado (para no duplicar el DELETE ni reabrir la
// ventana no atómica de P0-15E), nada volvía a sacarlo de ahí: el pedido
// quedaba fuera de la base pero seguía viéndose en el panel/snapshot de
// WebSocket, que se arma desde `obtenerPedidos()` (memoria), no desde la DB.
//
// Por eso la proyección en memoria se retira aquí, DESPUÉS de confirmar que
// la DB reservó de verdad — nunca antes, y nunca si `conv.ok` es falso: si la
// conversión no se aseguró, el pedido sigue siendo un pedido activo normal, y
// debe seguir viéndose como tal en el panel.
//
// Único punto de entrada para ambos canales (WhatsApp y Voz): evita que cada
// uno reimplemente su propia versión de "cuándo retirar de memoria".
export async function convertirPedidoAProgramado(pedido, programadoPara) {
  const conv = await guardarPedidoProgramado(pedido.id, pedido, programadoPara);
  if (conv.ok) {
    const idx = pedidos.findIndex(p => p.id === pedido.id && p.negocioId === pedido.negocioId);
    if (idx !== -1) {
      pedidos.splice(idx, 1);
      // Corrige una carrera de reconexión/F5: si un cliente del panel llegó a
      // ver el pedido en un snapshot antes de que esto corriera, este evento
      // lo retira igual que un eliminarPedido() normal.
      if (wsBroadcastNegocio) wsBroadcastNegocio(pedido.negocioId, { tipo: 'eliminar_pedido', id: pedido.id });
    }
  }
  return conv;
}
