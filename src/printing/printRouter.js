// Decisión central legacy/autenticado para la impresión de comandas.
// Único lugar donde se elige el modo de impresión de un pedido -- ningún
// canal ni el scheduler de pedidos programados debe repetir esta lógica.
//
// Los broadcasts WebSocket viven en server.js y se inyectan aquí (nunca se
// importan directamente) para evitar un ciclo de imports: server.js ya
// importa orderManager.js, que importará este módulo.
//
// resolverModoImpresion/resolverSucursalParaImpresion sí se importan
// directamente desde database.js (son consultas de solo lectura, sin
// relación con server.js, sin riesgo de ciclo). Para las pruebas de este
// módulo, que no deben depender de Postgres real, se agrega una segunda
// vía de inyección exclusiva para pruebas (setDependenciasImpresionParaPruebas)
// que sustituye esas dos funciones por mocks -- los imports nombrados de
// ESM son bindings de solo lectura y no se pueden parchear desde fuera del
// módulo sin un framework de mocking, que este proyecto no usa en ninguna
// otra parte. Esta vía nunca la invoca producción (server.js no la llama).
import {
  resolverModoImpresion as resolverModoImpresionReal,
  resolverSucursalParaImpresion as resolverSucursalParaImpresionReal,
  emitirUnaSolaVezLegacy as emitirUnaSolaVezLegacyReal
} from '../services/database.js';

let _resolverModo = resolverModoImpresionReal;
let _resolverSucursal = resolverSucursalParaImpresionReal;
let _emitirUnaSolaVez = emitirUnaSolaVezLegacyReal;

// Estado inicial: sin broadcasts configurados -- emitirTrabajoImpresion debe
// fallar cerrado (nunca simular éxito) si el modo elegido necesita uno que
// todavía no fue inyectado.
let _broadcastLegacy = null;
let _broadcastAutenticado = null;

// Se permite volver a llamar esta función en cualquier momento (no se
// bloquea tras la primera asignación): en producción server.js la invoca
// una sola vez al arrancar (mismo patrón que setWsBroadcast/
// setWsBroadcastRappi), y las pruebas necesitan poder reinyectar mocks
// frescos entre casos sin reiniciar el módulo.
export function setBroadcastsImpresion({ legacy, autenticado } = {}) {
  if (typeof legacy !== 'function' || typeof autenticado !== 'function') {
    throw new Error('setBroadcastsImpresion: se requieren ambas funciones (legacy y autenticado)');
  }
  _broadcastLegacy = legacy;
  _broadcastAutenticado = autenticado;
}

// Exclusiva para pruebas -- sustituye resolverModoImpresion/
// resolverSucursalParaImpresion por mocks. Nunca la invoca server.js ni
// ningún canal real. Ver comentario de imports arriba.
export function setDependenciasImpresionParaPruebas({ resolverModo, resolverSucursal, emitirUnaVez } = {}) {
  if (resolverModo !== undefined) {
    if (typeof resolverModo !== 'function') {
      throw new Error('setDependenciasImpresionParaPruebas: resolverModo debe ser función');
    }
    _resolverModo = resolverModo;
  }
  if (resolverSucursal !== undefined) {
    if (typeof resolverSucursal !== 'function') {
      throw new Error('setDependenciasImpresionParaPruebas: resolverSucursal debe ser función');
    }
    _resolverSucursal = resolverSucursal;
  }
  if (emitirUnaVez !== undefined) {
    if (typeof emitirUnaVez !== 'function') {
      throw new Error('setDependenciasImpresionParaPruebas: emitirUnaVez debe ser función');
    }
    _emitirUnaSolaVez = emitirUnaVez;
  }
}

// Determinista: solo depende del folio del pedido. Nunca terminalId,
// sucursalId ni negocioId -- el mismo pedido debe producir el mismo
// printJobId sin importar qué terminal termine imprimiéndolo (necesario
// para la deduplicación local que hará el print-agent reescrito, fuera de
// esta fase). Nunca Date.now()/randomUUID()/contador: no hay reintentos,
// se calcula una sola vez por llamada a partir de un valor ya estable.
export function construirPrintJobId(pedido) {
  if (pedido === null || typeof pedido !== 'object') return null;
  if (typeof pedido.id !== 'string' || pedido.id === '') return null;
  return `${pedido.id}:comanda`;
}

function resultadoOmitido(negocioId, sucursalId, razon) {
  return { modo: 'omitido', destinatarios: 0, negocioId, sucursalId, razon };
}

async function emitirLegacy(pedido, negocioId, folio) {
  if (typeof _broadcastLegacy !== 'function') {
    console.error(`[Impresion] broadcast legacy no configurado — omitido (fail closed) negocio=${negocioId} folio=${folio ?? '-'}`);
    return resultadoOmitido(negocioId, null, 'broadcast_legacy_no_configurado');
  }

  // El camino legacy también lleva printJobId desde aquí. Antes salía sin él y
  // por eso NADA podía deduplicarlo: ni el servidor, ni un agente actualizado,
  // ni un humano leyendo logs. Es el mismo id determinista del camino
  // autenticado -- '<folio>:comanda' -- para que un agente que hable los dos
  // protocolos reconozca el mismo trabajo por cualquiera de las dos vías.
  const printJobId = construirPrintJobId(pedido);
  if (printJobId === null) {
    console.error(`[Impresion] pedido sin folio válido — no se imprime en modo legacy (fail closed) negocio=${negocioId}`);
    return resultadoOmitido(negocioId, null, 'folio_invalido');
  }

  const mensaje = { tipo: 'nuevo_pedido', printJobId, tipoDocumento: 'comanda', pedido };
  let resultado;
  try {
    // A lo sumo una vez por (negocio, printJobId), con memoria en Postgres:
    // sobrevive al reinicio del proceso y a varias instancias a la vez. Ver
    // emitirUnaSolaVezLegacy en database.js para el porqué de cada mecanismo.
    resultado = await _emitirUnaSolaVez(negocioId, printJobId, () => _broadcastLegacy(negocioId, mensaje));
  } catch (e) {
    console.error(`[Impresion] error en broadcast legacy negocio=${negocioId} folio=${folio ?? '-'}: ${e.message}`);
    return { modo: 'legacy', destinatarios: 0, negocioId, sucursalId: null, razon: 'error_broadcast' };
  }

  if (resultado.duplicado) {
    console.log(`[Impresion] legacy YA EMITIDO printJobId=${printJobId} negocio=${negocioId} — no se reimprime`);
    return { modo: 'legacy', destinatarios: 0, negocioId, sucursalId: null, razon: 'ya_emitido' };
  }
  if (resultado.pendiente) {
    // Nadie escuchando. NO es un fallo silencioso ni un trabajo perdido: queda
    // en cola y se le entrega al agente en cuanto se conecte.
    console.warn(`[Impresion] legacy SIN AGENTE conectado printJobId=${printJobId} negocio=${negocioId} — queda PENDIENTE`);
    return { modo: 'legacy', destinatarios: 0, negocioId, sucursalId: null, razon: 'pendiente_sin_agente' };
  }
  console.log(`[Impresion] legacy negocio=${negocioId} folio=${folio ?? '-'} destinatarios=${resultado.destinatarios}`);
  return { modo: 'legacy', destinatarios: resultado.destinatarios, negocioId, sucursalId: null, razon: null };
}

async function emitirAutenticado(pedido, negocioId, folio) {
  const printJobId = construirPrintJobId(pedido);
  if (printJobId === null) {
    console.error(`[Impresion] pedido sin folio válido — no se imprime en modo autenticado (fail closed) negocio=${negocioId}`);
    return resultadoOmitido(negocioId, null, 'folio_invalido');
  }

  let resolucionSucursal;
  try {
    resolucionSucursal = await _resolverSucursal(negocioId, pedido.sucursalId ?? null);
  } catch (e) {
    console.error(`[Impresion] error resolviendo sucursal negocio=${negocioId} folio=${folio}: ${e.message}`);
    return resultadoOmitido(negocioId, null, 'error_sucursal');
  }

  if (resolucionSucursal.sucursalId === null) {
    console.error(`[Impresion] sucursal no resuelta — omitido (fail closed) negocio=${negocioId} folio=${folio} razon=${resolucionSucursal.razon}`);
    return resultadoOmitido(negocioId, null, resolucionSucursal.razon);
  }
  const sucursalId = resolucionSucursal.sucursalId;

  if (typeof _broadcastAutenticado !== 'function') {
    console.error(`[Impresion] broadcast autenticado no configurado — omitido (fail closed) negocio=${negocioId} sucursal=${sucursalId} folio=${folio}`);
    return resultadoOmitido(negocioId, sucursalId, 'broadcast_autenticado_no_configurado');
  }

  const mensaje = { tipo: 'nuevo_pedido', printJobId, tipoDocumento: 'comanda', pedido };
  let destinatarios;
  try {
    destinatarios = await _broadcastAutenticado(negocioId, sucursalId, mensaje);
  } catch (e) {
    console.error(`[Impresion] error en broadcast autenticado negocio=${negocioId} sucursal=${sucursalId} folio=${folio}: ${e.message}`);
    return { modo: 'autenticado', destinatarios: 0, negocioId, sucursalId, razon: 'error_broadcast' };
  }
  console.log(`[Impresion] autenticado negocio=${negocioId} sucursal=${sucursalId} folio=${folio} destinatarios=${destinatarios}`);
  return { modo: 'autenticado', destinatarios, negocioId, sucursalId, razon: null };
}

// Único punto de decisión legacy vs. autenticado. Cada rama termina en un
// "return" propio -- no existe código posterior común que pueda disparar el
// otro broadcast, ni un finally que reactive legacy ante un error. Un
// resultado con destinatarios=0 (cero terminales conectadas) es válido y
// definitivo para el modo ya elegido; nunca se reintenta con el otro modo.
export async function emitirTrabajoImpresion(pedido) {
  if (pedido === null || typeof pedido !== 'object' || Array.isArray(pedido)) {
    console.error('[Impresion] pedido inválido (no es un objeto) — omitido (fail closed)');
    return resultadoOmitido(null, null, 'pedido_invalido');
  }
  if (typeof pedido.negocioId !== 'string' || pedido.negocioId === '') {
    console.error('[Impresion] pedido sin negocioId válido — omitido (fail closed)');
    return resultadoOmitido(null, null, 'sin_negocio');
  }

  const negocioId = pedido.negocioId;
  const folio = typeof pedido.id === 'string' ? pedido.id : null;

  let resolucionModo;
  try {
    resolucionModo = await _resolverModo(negocioId);
  } catch (e) {
    console.error(`[Impresion] error consultando configuración negocio=${negocioId} folio=${folio ?? '-'}: ${e.message}`);
    return resultadoOmitido(negocioId, null, 'error_configuracion');
  }

  if (resolucionModo.modo === null) {
    console.error(`[Impresion] modo no determinado negocio=${negocioId} folio=${folio ?? '-'} razon=${resolucionModo.razon}`);
    return resultadoOmitido(negocioId, null, resolucionModo.razon);
  }

  if (resolucionModo.modo === 'legacy') {
    return emitirLegacy(pedido, negocioId, folio);
  }

  return emitirAutenticado(pedido, negocioId, folio);
}
