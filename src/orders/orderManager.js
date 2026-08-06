// Maneja los pedidos confirmados
// Guarda en DB (persistente) y en memoria para el panel via WebSocket

import {
  guardarPedidoActivo,
  actualizarEstadoPedidoDB,
  archivarPedidoActivo,
  obtenerPedidosActivos,
  obtenerMaxFolioNum,
  eliminarPedido as eliminarPedidoDB
} from '../services/database.js';
import { emitirTrabajoImpresion } from '../printing/printRouter.js';
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
export async function cargarPedidosDesdeDB() {
  try {
    const [activos, maxFolio] = await Promise.all([
      obtenerPedidosActivos(),
      obtenerMaxFolioNum()
    ]);

    pedidos.length = 0;
    for (const p of activos) {
      pedidos.push(p);
    }

    // El contador siempre arranca por encima del folio más alto en DB
    // Esto previene duplicados aunque haya pedidos entregados/archivados
    const maxDesdeActivos = activos.reduce((max, p) => {
      const num = parseInt(p.id?.replace('XAB-', '')) || 0;
      return num > max ? num : max;
    }, 0);
    contadorPedidos = Math.max(maxFolio, maxDesdeActivos) + 1;

    console.log(`[OrderManager] ${pedidos.length} pedidos activos cargados desde DB — próximo folio: XAB-${String(contadorPedidos).padStart(4, '0')}`);
  } catch (e) {
    console.error('[OrderManager] Error cargando pedidos desde DB:', e.message);
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

  const pedido = {
    ...orden,
    negocioId,
    id: `XAB-${String(contadorPedidos).padStart(4, '0')}`,
    canal,
    timestamp: new Date().toISOString(),
    estado: 'nuevo'
  };

  // Persistencia inicial ANTES de tocar el estado en memoria: si falla de
  // verdad (error de base de datos, no un simple conflicto de folio), no
  // se consume el folio ni se agrega nada a `pedidos` -- el llamador recibe
  // un error explícito en vez de un pedido "confirmado" que nunca quedó
  // guardado. guardarPedidoActivo() nunca lanza (ver su propio comentario
  // en database.js); su valor de retorno es la única señal de éxito/fallo.
  const persistido = await guardarPedidoActivo(pedido, negocioId);
  if (!persistido) {
    throw new Error(`PEDIDO_NO_PERSISTIDO: no se pudo guardar ${pedido.id} en pedidos_activos — pedido rechazado antes de ofrecerlo a repartidores o confirmarlo al cliente`);
  }

  pedidos.push(pedido);
  contadorPedidos++;

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
  if (typeof pedido.negocioId === 'string' && pedido.negocioId.trim()) {
    if (wsBroadcastNegocio) wsBroadcastNegocio(pedido.negocioId, { tipo: 'nuevo_pedido', pedido });
  } else {
    // Fail closed: nunca se emite al panel sin negocioId ni se usa Nonna
    // Maye como relleno aquí — esto no debería pasar hoy (Rappi siempre lo
    // trae, WhatsApp/Voz/presencial usan el respaldo temporal), así que si
    // ocurre es una señal real de que algo quedó sin resolver.
    console.error(`[OrderManager] emitirPedido: pedido ${pedido.id} sin negocioId — no se emite al panel (fail closed)`);
  }

  // Impresión física (legacy vs. autenticado, por sucursal, con
  // printJobId): decidida por completo dentro de printRouter.js. Nunca
  // lanza -- cualquier error de configuración/sucursal/broadcast ya se
  // captura ahí y se traduce en un resultado 'omitido', así que esperar su
  // resultado aquí no puede romper la creación del pedido.
  await emitirTrabajoImpresion(pedido);

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

// negocioId OBLIGATORIO y estricto. Sin él, siempre [] -- nunca el
// arreglo completo por accidente. Los únicos dos llamadores que hoy no
// pueden pasar un negocioId real (el handler legado de reconexión
// WebSocket y, antes de esta revisión, la deduplicación de Rappi) ya NO
// usan esta función: el WebSocket usa
// obtenerTodosPedidosParaWebSocketLegacy() (ver más abajo, documentado
// como deuda temporal) y Rappi ya resuelve su propio negocioId real vía
// integraciones_canal antes de llamar aquí.
export function obtenerPedidos(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  const negocioIdNorm = negocioId.trim();
  return pedidos.filter(p => p.negocioId === negocioIdNorm);
}

// ⚠ PENDIENTE DE ELIMINAR: WebSocket sin aislamiento multiempresa.
// Devuelve TODOS los pedidos de TODOS los negocios -- es una fuga de
// datos entre negocios documentada a propósito, no oculta. Existe
// ÚNICAMENTE porque el handler de conexión WebSocket (server.js) todavía
// no autentica ni segmenta la conexión por negocio, y print-agent.js
// depende de ese mismo canal sin filtrar. Uso exclusivo: el handler
// wss.on('connection') legado en server.js. NO debe usarse desde ninguna
// ruta HTTP, NO debe usarse desde Rappi, NO debe convertirse en fallback
// de obtenerPedidos, y NO acepta negocioId del cliente porque no filtra
// nada -- deliberadamente no tiene parámetros. Se elimina en cuanto el
// WebSocket tenga su propia fase de autenticación y segmentación por
// negocio (no autorizada todavía).
export function obtenerTodosPedidosParaWebSocketLegacy() {
  return [...pedidos]; // copia, nunca la referencia original al arreglo global
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
