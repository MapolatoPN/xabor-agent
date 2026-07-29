// Maneja los pedidos confirmados
// Guarda en DB (persistente) y en memoria para el panel via WebSocket

import {
  guardarPedidoActivo,
  actualizarEstadoPedidoDB,
  archivarPedidoActivo,
  obtenerPedidosActivos,
  obtenerMaxFolioNum,
  obtenerNegocioIdPorSlug,
  eliminarPedido as eliminarPedidoDB
} from '../services/database.js';

// ✅ NUEVO (Fase 7) — dos canales de emisión, inyectados desde server.js:
//   - wsBroadcastNegocio(negocioId, data) → broadcastNegocio real, aislado
//     por negocio. Usado por nuevo_pedido, actualizar_estado, eliminar_pedido
//     (los tres ya tienen pedido.negocioId confiable — ver reporte de esta
//     fase). Fail closed: si el pedido no trae negocioId, NO se emite, se
//     loguea y punto — nunca se usa Nonna Maye como relleno aquí.
//   - wsBroadcastPrintAgentLegacy(data) → SOLO para nuevo_pedido, mantiene
//     temporalmente la impresión de Nonna Maye funcionando mientras
//     print-agent.js no migra a su propia ruta autenticada. ⚠ PENDIENTE DE
//     ELIMINAR — no se usa para actualizar_estado ni eliminar_pedido.
let wsBroadcastNegocio = null;
let wsBroadcastPrintAgentLegacy = null;
const pedidos = [];
let contadorPedidos = 1;

export function setWsBroadcast(fnNegocio, fnPrintAgentLegacy) {
  wsBroadcastNegocio = fnNegocio;
  wsBroadcastPrintAgentLegacy = fnPrintAgentLegacy;
}

// ─── Respaldo temporal de negocio (Fase 5 — threading operativo) ───────────
// WhatsApp y Voz todavía NO resuelven su propio negocioId en el borde del
// canal (a diferencia de Rappi, que ya lo hace vía obtenerIntegracionCanal
// en rappi.js) — sus pedidos siguen llegando a registrarPedido sin
// negocioId. Para no romper su funcionamiento actual mientras se migran,
// se cachea aquí UNA sola vez, al arrancar, el negocio por defecto (Nonna
// Maye) y se usa como respaldo SOLO para canales distintos de 'rappi'. Si
// no se puede resolver (p. ej. migraciones 003/004 aún no aplicadas),
// queda en null y esos canales simplemente siguen sin negocio_id, EXACTO
// el comportamiento de hoy — nunca se bloquea un pedido de WhatsApp/Voz
// por esto.
//
// Rappi NUNCA usa este respaldo: si un pedido de canal 'rappi' llega sin
// negocioId ya resuelto, registrarPedido lo rechaza explícitamente (ver
// abajo) en vez de adivinar un negocio.
//
// PENDIENTE DE ELIMINAR: cuando WhatsApp y Voz resuelvan su propio
// negocioId en el borde del canal (mismo patrón que Rappi), esta variable,
// su carga en cargarPedidosDesdeDB() y su uso en registrarPedido deben
// eliminarse por completo.
let _negocioFallbackId = null;

// Carga pedidos activos desde la DB al arrancar el servidor
export async function cargarPedidosDesdeDB() {
  try {
    const [activos, maxFolio, negocioFallback] = await Promise.all([
      obtenerPedidosActivos(),
      obtenerMaxFolioNum(),
      obtenerNegocioIdPorSlug('nonna-maye')
    ]);
    _negocioFallbackId = negocioFallback;

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

export function registrarPedido(orden, canal = 'test') {
  // Rappi ya resuelve negocioId de forma confiable en el borde del canal
  // (rappi.js, vía obtenerIntegracionCanal, nunca desde datos manipulables
  // del payload) y SIEMPRE debe traerlo en orden.negocioId al llegar aquí.
  // Si falta, es un error real -- no un caso a rellenar -- y se rechaza
  // ANTES de tocar memoria, DB o WebSocket.
  if (canal === 'rappi' && !orden.negocioId) {
    throw new Error('registrarPedido: pedido de canal "rappi" sin negocioId resuelto — se rechaza antes de persistir o emitir');
  }

  // negocioId final: el que ya trae la orden (Rappi, siempre; otros
  // canales, cuando se migren) o el respaldo temporal solo para canales
  // no-Rappi todavía sin migrar (ver comentario junto a _negocioFallbackId).
  const negocioId = orden.negocioId || (canal !== 'rappi' ? _negocioFallbackId : null);

  const pedido = {
    ...orden,
    negocioId,
    id: `XAB-${String(contadorPedidos).padStart(4, '0')}`,
    canal,
    timestamp: new Date().toISOString(),
    estado: 'nuevo'
  };

  pedidos.push(pedido);
  contadorPedidos++;

  // Guardar en DB para que sobreviva reinicios
  guardarPedidoActivo(pedido, negocioId).catch(e =>
    console.error(`[OrderManager] ❌ Error guardando ${pedido.id} en DB:`, e.message)
  );

  console.log('\n' + '='.repeat(50));
  console.log(`🎉 NUEVO PEDIDO: ${pedido.id} [${canal}]`);
  console.log(`   Cliente: ${pedido.cliente?.nombre} — $${pedido.total} MXN`);
  console.log('='.repeat(50) + '\n');

  return pedido;
}

export function emitirPedido(pedido) {
  if (typeof pedido.negocioId === 'string' && pedido.negocioId.trim()) {
    if (wsBroadcastNegocio) wsBroadcastNegocio(pedido.negocioId, { tipo: 'nuevo_pedido', pedido });
  } else {
    // Fail closed: nunca se emite al panel sin negocioId ni se usa Nonna
    // Maye como relleno aquí — esto no debería pasar hoy (Rappi siempre lo
    // trae, WhatsApp/Voz/presencial usan el respaldo temporal), así que si
    // ocurre es una señal real de que algo quedó sin resolver.
    console.error(`[OrderManager] emitirPedido: pedido ${pedido.id} sin negocioId — no se emite al panel (fail closed)`);
  }
  // Print-agent legado (raíz "/", sin autenticar): sigue recibiendo TODO
  // nuevo_pedido sin filtrar, a propósito, para no interrumpir la impresión
  // actual de Nonna Maye mientras print-agent no migra. Nunca condicionado
  // a negocioId -- ver broadcastPrintAgentLegacy en server.js.
  if (wsBroadcastPrintAgentLegacy) wsBroadcastPrintAgentLegacy({ tipo: 'nuevo_pedido', pedido });

  // Notificar a repartidores si es entrega a domicilio (por WhatsApp) — excluir Rappi
  if (pedido.modalidad === 'entrega a domicilio' && pedido.canal !== 'rappi') {
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
    // Rewards — fire-and-forget, nunca bloquea el flujo crítico
    import('../services/rewardsService.js')
      .then(({ acumularPuntos }) => acumularPuntos(pedido.id, pedido, 'xabor-principal'))
      .catch(e => console.error('[Rewards] Error en hook de acumulación:', e.message));
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

export function obtenerPedidoPorId(id) {
  return pedidos.find(p => p.id === id);
}

// Agrega un pedido al array en memoria sin generar folio ni guardar en DB.
// Usado por el job de activación de pedidos programados.
export function agregarPedidoAMemoria(pedido) {
  if (!pedidos.find(p => p.id === pedido.id)) {
    pedidos.push(pedido);
  }
}

export async function eliminarPedido(id) {
  const idx = pedidos.findIndex(p => p.id === id);
  if (idx === -1) return false;
  const pedido = pedidos[idx]; // capturado ANTES del splice, para conservar negocioId
  pedidos.splice(idx, 1);
  await eliminarPedidoDB(id);
  if (typeof pedido.negocioId === 'string' && pedido.negocioId.trim()) {
    if (wsBroadcastNegocio) wsBroadcastNegocio(pedido.negocioId, { tipo: 'eliminar_pedido', id });
  } else {
    console.error(`[OrderManager] eliminarPedido: pedido ${id} sin negocioId — no se emite (fail closed)`);
  }
  return true;
}
