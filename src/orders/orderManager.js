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
  reclamarEmisionPorPago,
  saldarEmisionPorPago,
  pedidosConEmisionPendiente
} from '../services/database.js';
import { validarOrdenPropuesta, eventoTxn } from './validadorOrden.js';
import { emitirTrabajoImpresion } from '../printing/printRouter.js';
import { emitirComandaDePedidoPorEdge } from '../printing/edgeComanda.js';
import { esPedidoElegibleParaRedRepartidores } from '../utils/elegibilidadRepartidor.js';

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
let contadorPedidos = 1;

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

    // El contador siempre arranca por encima del folio más alto en DB
    // Esto previene duplicados aunque haya pedidos entregados/archivados
    const maxDeLista = (lista) => lista.reduce((max, p) => {
      const num = parseInt(p.id?.replace('XAB-', '')) || 0;
      return num > max ? num : max;
    }, 0);
    // Los creados durante la carga también cuentan: el contador nunca debe
    // retroceder por debajo de un folio ya entregado a un cliente.
    contadorPedidos = Math.max(maxFolio, maxDeLista(activos), maxDeLista(creadosDuranteLaCarga), contadorPedidos - 1) + 1;

    console.log(`[OrderManager] ${pedidos.length} pedidos activos cargados desde DB — próximo folio: XAB-${String(contadorPedidos).padStart(4, '0')}`);
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
  // Hotfix P0 folio: el folio se RESERVA de forma síncrona (se toma el
  // contador y se incrementa en la misma vuelta del event loop, antes del
  // primer await), así dos creaciones concurrentes en este proceso ya no
  // pueden leer el mismo número. Contra la otra instancia del deploy (o
  // filas residuales) queda el conflicto real de base de datos: si el
  // INSERT no escribió fila, ese folio es de OTRO pedido y se reintenta con
  // el siguiente candidato. NUNCA se adopta el pedido existente que comparte
  // folio (podría ser de otro negocio) ni se devuelve éxito sin fila propia.
  let pedido = null;
  let intento = 0;
  while (intento < MAX_REINTENTOS_FOLIO) {
    intento++;
    const folio = `XAB-${String(contadorPedidos).padStart(4, '0')}`;
    contadorPedidos++;
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

  // PRIMERO Edge, DESPUÉS el panel. El orden no es estético: el evento que
  // recibe el panel tiene que decir la verdad sobre si el papel ya está en
  // camino, y eso solo se sabe cuando el trabajo existe. Avisar antes
  // obligaría al navegador a adivinar, que es exactamente lo que provocaba
  // el diálogo de Chrome sobre una comanda que Edge iba a imprimir sola.
  const edge = await emitirComandaDePedidoPorEdge(pedido);

  if (typeof pedido.negocioId === 'string' && pedido.negocioId.trim()) {
    if (wsBroadcastNegocio) {
      wsBroadcastNegocio(pedido.negocioId, { tipo: 'nuevo_pedido', pedido, impresionEdge: edge.seHizoCargo });
    }
  } else {
    // Fail closed: nunca se emite al panel sin negocioId ni se usa Nonna
    // Maye como relleno aquí — esto no debería pasar hoy (Rappi siempre lo
    // trae, WhatsApp/Voz/presencial usan el respaldo temporal), así que si
    // ocurre es una señal real de que algo quedó sin resolver.
    console.error(`[OrderManager] emitirPedido: pedido ${pedido.id} sin negocioId — no se emite al panel (fail closed)`);
  }

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

  // Notificar a repartidores -- única fuente de verdad: esPedidoElegibleParaRedRepartidores.
  if (esPedidoElegibleParaRedRepartidores(pedido)) {
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
    import('../channels/whatsapp-meta.js').then(({ notificarRepartidoresPorWA }) => {
      notificarRepartidoresPorWA(pedido).catch(() => {});
    }).catch(() => {});
  }
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

  // El pedido en memoria puede no existir (proceso nuevo tras el crash): se
  // reconstruye desde lo que la base guardó, que es la fuente de verdad.
  let pedido = pedidos.find(p => p.id === folio && p.negocioId === nid);
  if (!pedido) {
    pedido = { ...reclamo.datos, id: folio, negocioId: nid, estado: 'nuevo' };
    agregarPedidoAMemoria(pedido);
  } else {
    pedido.estado = 'nuevo';
  }

  await emitirPedido(pedido);
  // Sólo ahora se salda: al revés, un crash entre marcar y emitir dejaría el
  // pedido como "ya emitido" sin haberlo hecho, y nadie lo volvería a intentar.
  await saldarEmisionPorPago(folio, nid);
  return pedido;
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
