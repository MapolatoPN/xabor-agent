// ─── EL ADAPTADOR: donde el agente toca el mundo ──────────────────────────
//
// Esto es lo que faltaba el mes entero. El Mesero anterior estaba completo y
// probado como capa y NUNCA se conectó al canal: `atenderTurno` tenía un solo
// sitio de llamada en todo `src/` y era la sombra. Había cero código que un
// interruptor pudiera encender.
//
// Aquí está el camino real, en dos funciones:
//
//   atenderConAgente()    productivo. Devuelve el texto que se le manda al
//                         cliente. Efectos reales: registra el pedido y escala.
//   observarConAgente()   sombra. La misma lógica, sobre una copia, con
//                         efectos que solo graban. No responde a nadie.
//
// Las dos comparten TODO menos los efectos y dónde guardan el estado. Que no
// haya dos implementaciones es lo que hace que observar signifique algo.
import {
  pool, obtenerMenuCompleto, obtenerConfiguracion, guardarPedido, obtenerMetodosPagoDisponibles,
} from '../services/database.js';
import { crearEnlacePago } from '../services/pagosService.js';
import { registrarPedido, emitirPedido } from '../orders/orderManager.js';
import { atenderTurnoConHerramientas, CIERRE } from './agenteDelMesero.js';
import { estadoNuevo, estadoSerializable } from './ejecutorDeHerramientas.js';
import { libroDeOperaciones, almacenEnPostgres, almacenEnMemoria } from './libroDeOperaciones.js';
import { productosVendibles } from '../mesero-whatsapp/consultasDelMenu.js';
import { cicloParaTurno } from './cicloDelAgente.js';
import { depurarPagoNoDisponible } from './politicaDePagos.js';

// Un teléfono nunca sale de aquí entero hacia un log o una cola: se queda en
// los últimos cuatro dígitos, que bastan para cruzarlo con una conversación
// real si hace falta y no identifican a nadie por sí solos.
export const telefonoCorto = (t) => {
  const d = String(t ?? '').replace(/[^0-9]+/g, '');
  return d ? `…${d.slice(-4)}` : '';
};

// ── DÓNDE VIVE EL ESTADO ENTRE TURNOS ────────────────────────────────────
//
// En `conversacion_estado`, la tabla que ya usa la sesión durable, con su
// propio espacio de nombres en `session_id`. No hace falta tabla nueva: ya
// tiene revisión, índice por fecha y el barrido de conversaciones viejas.
// Una tabla menos es una migración menos y un sitio menos donde el estado se
// puede quedar a medias.
const claveDeSesion = (telefono, { sombra = false } = {}) =>
  `${sombra ? 'agente-sombra' : 'agente'}:${telefono}`;

export async function leerEstado(negocioId, telefono, { sombra = false } = {}) {
  const sessionId = claveDeSesion(telefono, { sombra });
  // Solo una lectura exitosa sin filas significa conversación nueva. Si la
  // base falla, atender con un carrito vacío podría duplicar un pedido previo.
  const { rows } = await pool.query(
    'SELECT estado FROM conversacion_estado WHERE negocio_id = $1 AND session_id = $2',
    [negocioId, sessionId]);
  if (rows[0]?.estado) return rows[0].estado;
  return estadoNuevo({ negocioId, conversacionId: sessionId });
}

export async function guardarEstado(negocioId, telefono, estado, { sombra = false, cliente = null } = {}) {
  const sessionId = claveDeSesion(telefono, { sombra });
  const ejecutor = cliente || pool;
  await ejecutor.query(
    `INSERT INTO conversacion_estado (negocio_id, session_id, estado, revision)
     VALUES ($1,$2,$3::jsonb,1)
     ON CONFLICT (negocio_id, session_id) DO UPDATE
       SET estado = $3::jsonb, revision = conversacion_estado.revision + 1, actualizado_at = NOW()`,
    [negocioId, sessionId, JSON.stringify(estadoSerializable(estado))]);
}

/** Los precios por nombre canónico, como los espera el resumen. */
export function preciosDelCatalogo(catalogo) {
  const fuera = {};
  for (const p of productosVendibles(catalogo)) {
    if (p.precio !== null && p.precio !== undefined) fuera[p.nombre] = Number(p.precio);
  }
  return fuera;
}

/** La orden canónica que espera `registrarPedido`, construida del carrito REAL. */
export function ordenDesdeElCarrito({ negocioId, carrito, telefono, nombre }) {
  const datos = carrito?.datos || {};
  const cli = datos.cliente || {};
  return {
    negocioId,
    telefono_conversacion: telefono,
    items: (carrito?.items || []).map((i) => ({
      nombre: i.nombre,
      cantidad: Number(i.cantidad) || 1,
      modificadores: (i.modificadores || []).flatMap((g) => (g.opciones || [])
        .map((o) => ({ grupo: g.grupo, opcion: typeof o === 'string' ? o : o?.nombre }))),
      ...(i.notas ? { notas: i.notas } : {}),
    })),
    cliente: {
      nombre: cli.nombre || nombre || null,
      telefono: cli.telefono || telefono || null,
      ...(cli.direccion ? { direccion: cli.direccion } : {}),
      ...(cli.referencias ? { referencias: cli.referencias } : {}),
    },
    modalidad: datos.modalidad || null,
    forma_pago: datos.forma_pago || null,
  };
}

/**
 * ATIENDE UN TURNO DE VERDAD.
 *
 * Devuelve `{ ok, texto, folio, escalado, pedido, operaciones }`. Quien llama
 * —el canal— manda `texto` por WhatsApp. Si `ok` es false, el canal sigue con
 * lo de siempre: **el agente nunca deja a un cliente sin respuesta por haber
 * fallado**; si no puede, no contesta él y contesta el bot de siempre.
 */
export async function atenderConAgente({
  negocioId, telefono, mensaje, nombre = null, canal = 'whatsapp',
  llamarModelo, historial = [], textoCiclo = '', turnoId = null,
  escalarAHumano = null, registrar = registrarPedido, emitir = emitirPedido,
  guardar = guardarPedido, crearPago = crearEnlacePago, traza = null,
} = {}) {
  const t0 = Date.now();
  let estado = null;
  let salida = null;
  let confirmacionIntentada = false;
  try {
    const [catalogo, cfg, metodosPago] = await Promise.all([
      obtenerMenuCompleto(negocioId),
      obtenerConfiguracion(negocioId).catch(() => ({})),
      obtenerMetodosPagoDisponibles(negocioId, { paraBot: true }),
    ]);
    if (!Array.isArray(catalogo) || !catalogo.length) {
      // Sin carta no hay nada que el agente pueda hacer sin inventar.
      return { ok: false, motivo: 'sin_catalogo' };
    }

    estado = cicloParaTurno(await leerEstado(negocioId, telefono), mensaje);
    const pagoDescartado = depurarPagoNoDisponible(estado, metodosPago);
    const libro = libroDeOperaciones(almacenEnPostgres(pool));

    const efectos = {
      confirmar: async ({ pedido }) => {
        confirmacionIntentada = true;
        return confirmarYEmitir({
          negocioId, telefono, nombre, canal, estado, pedido, registrar, emitir, guardar, crearPago,
        });
      },
      // El `ok` que sale de aquí es lo que hace que `pedir_humano` cuente como
      // aplicado. Si se diera por bueno sin comprobarlo, el agente creería
      // haber pasado la conversación a una persona que nunca fue llamada.
      escalar: async () => (
        await avisarAHumano(escalarAHumano, negocioId, telefono, 'AGENTE_PIDE_HUMANO')
          ? { ok: true }
          : { ok: false, motivo: escalarAHumano ? 'handoff_no_entregado' : 'handoff_sin_destino' }),
    };

    salida = await atenderTurnoConHerramientas({
      negocioId,
      conversacionId: estado.conversacionId,
      turnoId: turnoId || `t${Date.now()}`,
      mensaje,
      historial,
      catalogo,
      precios: preciosDelCatalogo(catalogo),
      requierePago: String(cfg?.pedido_requiere_pago ?? 'true').toLowerCase() !== 'false',
      metodosPago,
      estado,
      libro,
      llamarModelo,
      efectos,
      contexto: {
        nombreNegocio: cfg?.nombre_negocio || 'el restaurante',
        textoCiclo: textoCiclo || mensaje,
        datosConocidos: [telefono && telefono !== '—' ? `Teléfono: ${telefono}` : null,
          nombre ? `Nombre: ${nombre}` : null].filter(Boolean),
        tono: cfg?.tono_bot || null,
        metodosPago,
        pagoDescartado,
      },
      modo: 'productivo',
      traza,
    });

    salida = aplicarRespuestaDePago({ salida, estado, pagoDescartado, metodosPago });
    const falloEnlace = resultadoConfirmacion(salida)?.enlace_pago_error;
    if (falloEnlace) {
      if (await avisarAHumano(escalarAHumano, negocioId, telefono, 'AGENTE_ENLACE_PAGO_FALLO')) {
        estado.hechos.escalado = true;
        salida.escalado = true;
      } else {
        salida.handoffPendiente = true;
      }
    }

    // ── EL TURNO VOLVIÓ BIEN; FALTA VER SI PROMETIÓ DE MÁS ───────────────
    //
    // El aviso va ANTES de `guardarEstado` a propósito: si la misma caída que
    // rompió el turno se lleva también el guardado, lo único que no se puede
    // perder es la llamada a la persona.
    const desenlace = desenlaceDelTurno({ salida, confirmacionIntentada });

    // Si el agente YA escaló dentro del turno, este aviso es el segundo sobre
    // el mismo incidente, y se manda igual: dice algo que el primero no —«hay
    // un pedido que quizá exista y no está en el panel»— y suprimirlo pedía
    // llevar cuenta de lo enviado, que es un mecanismo más que puede fallar
    // callado. Fallar callado es justamente el defecto que se está cerrando.
    if (desenlace.motivoHandoff) {
      // `confirmacionIncierta` congela la conversación: `cicloDelAgente` no
      // abre un ciclo nuevo mientras esté puesta. Sin ella, un «quiero hacer
      // otro pedido» estrenaría `conversacion_id` y esquivaría la guardia del
      // libro, que es por conversación.
      if (desenlace.incierta) estado.confirmacionIncierta = true;
      if (await avisarAHumano(escalarAHumano, negocioId, telefono, desenlace.motivoHandoff)) {
        estado.hechos.escalado = true;
      }
      if (desenlace.texto) salida.texto = desenlace.texto;
    }

    await guardarEstado(negocioId, telefono, estado);

    console.log(`[AGENTE] evento=turno negocio=${negocioId} cierre=${salida.motivoCierre} `
      + `estado=${salida.pedido?.estado} ops=${salida.operaciones.length} `
      + `iter=${salida.iteraciones} ms=${salida.duracionMs}`);

    return { ok: true, ...salida };
  } catch (e) {
    console.error('[AGENTE] contenido en el adaptador:', e?.message);
    // Un efecto irreversible pudo ocurrir antes del error (por ejemplo,
    // registrarPedido hizo COMMIT y luego falló guardarEstado). En ese caso
    // el bot viejo NO debe volver a procesar este mismo mensaje.
    if (confirmacionIntentada || estado?.hechos?.confirmado || estado?.hechos?.escalado) {
      if (confirmacionIntentada) {
        await avisarAHumano(escalarAHumano, negocioId, telefono, 'AGENTE_ESTADO_INCIERTO');
      }
      return {
        ok: true,
        texto: estado?.hechos?.confirmado && estado.folio
          ? (salida?.texto || `Tu pedido ${estado.folio} quedó registrado. El equipo lo revisará.`)
          : 'Estoy revisando tu pedido con el equipo para evitar registrarlo dos veces. Te responderemos en breve.',
        folio: estado?.folio ?? null,
        escalado: !!estado?.hechos?.escalado,
        estadoIncierto: true,
      };
    }
    return { ok: false, motivo: e?.message || 'error', ms: Date.now() - t0 };
  }
}

/**
 * OBSERVA UN TURNO, sin efectos de ninguna clase.
 *
 * Mismo bucle, mismo ejecutor, mismo reconciliador. Lo que cambia:
 *
 *   · los efectos son grabadoras: no registra pedido, no escala, no imprime;
 *   · el estado vive en su propio espacio de nombres y no toca el productivo;
 *   · el libro de operaciones es de MEMORIA, así que ni siquiera escribe en la
 *     tabla de auditoría del agente productivo.
 *
 * Funciona con el bot apagado, que es exactamente cuando hace falta.
 */
export async function observarConAgente({
  negocioId, telefono, mensaje, nombre = null,
  llamarModelo, historial = [], textoCiclo = '', turnoId = null, traza = null,
} = {}) {
  const t0 = Date.now();
  try {
    const [catalogo, cfg, metodosPago] = await Promise.all([
      obtenerMenuCompleto(negocioId),
      obtenerConfiguracion(negocioId).catch(() => ({})),
      obtenerMetodosPagoDisponibles(negocioId, { paraBot: true }),
    ]);
    if (!Array.isArray(catalogo) || !catalogo.length) return { ok: false, motivo: 'sin_catalogo' };

    const estado = cicloParaTurno(await leerEstado(negocioId, telefono, { sombra: true }), mensaje);
    const pagoDescartado = depurarPagoNoDisponible(estado, metodosPago);
    const grabadas = [];
    const salida = await atenderTurnoConHerramientas({
      negocioId,
      conversacionId: estado.conversacionId,
      turnoId: turnoId || `t${Date.now()}`,
      mensaje,
      historial,
      catalogo,
      precios: preciosDelCatalogo(catalogo),
      requierePago: String(cfg?.pedido_requiere_pago ?? 'true').toLowerCase() !== 'false',
      metodosPago,
      estado,
      // Memoria, no Postgres: la sombra no escribe ni en la auditoría.
      libro: libroDeOperaciones(almacenEnMemoria()),
      llamarModelo,
      efectos: {
        confirmar: async ({ pedido }) => {
          grabadas.push({ tipo: 'confirmar_hipotetico', pedido });
          return { ok: true, folio: null, simulado: true };
        },
        escalar: async ({ motivo }) => {
          grabadas.push({ tipo: 'handoff_hipotetico', motivo });
          return { ok: true, simulado: true };
        },
      },
      contexto: {
        nombreNegocio: cfg?.nombre_negocio || 'el restaurante',
        textoCiclo: textoCiclo || mensaje,
        tono: cfg?.tono_bot || null,
        metodosPago,
        pagoDescartado,
      },
      modo: 'sombra',
      traza,
    });

    aplicarRespuestaDePago({ salida, estado, pagoDescartado, metodosPago });

    await guardarEstado(negocioId, telefono, estado, { sombra: true });

    // Una línea por turno, sin PII y con el prefijo que ya se busca en Railway.
    const linea = JSON.stringify({
      evt: 'agente_sombra', negocio: negocioId, cierre: salida.motivoCierre,
      estado: salida.pedido?.estado, renglones: salida.pedido?.lineas?.length ?? 0,
      total: salida.pedido?.total ?? null, falta: salida.pedido?.falta ?? [],
      herramientas: salida.operaciones.map((o) => o.herramienta),
      rechazos: salida.operaciones.filter((o) => o.resultado?.aplicado === false)
        .map((o) => ({ h: o.herramienta, motivo: String(o.resultado?.motivo || '').slice(0, 60) })),
      hipoteticos: grabadas.map((g) => g.tipo),
      iter: salida.iteraciones, ms: salida.duracionMs,
    });
    console.log(`[SOMBRA-AGENTE] ${linea}`);

    return { ok: true, ...salida, grabadas, linea };
  } catch (e) {
    console.error('[SOMBRA-AGENTE] contenida:', e?.message);
    return { ok: false, motivo: e?.message || 'error', ms: Date.now() - t0 };
  }
}

/** El resultado durable de `confirmar_pedido`, si ocurrió en este turno. */
export function resultadoConfirmacion(salida) {
  const operaciones = Array.isArray(salida?.operaciones) ? salida.operaciones : [];
  return [...operaciones].reverse()
    .find((o) => o?.herramienta === 'confirmar_pedido')?.resultado || null;
}

/**
 * Los mensajes sobre dinero no se dejan a interpretación del modelo:
 * - una transferencia no habilitada siempre recibe la misma explicación;
 * - una URL devuelta por pagosService siempre llega al cliente;
 * - si Clip falla después del registro, se anuncia el folio sin inventar URL.
 */
export function aplicarRespuestaDePago({ salida, estado, pagoDescartado = null, metodosPago = [] } = {}) {
  if (!salida) return salida;
  const confirmacion = resultadoConfirmacion(salida);
  if (confirmacion?.enlace_pago) {
    const url = String(confirmacion.enlace_pago);
    const base = String(salida.texto || `Tu pedido ${confirmacion.folio || salida.folio || ''} quedó registrado.`).trim();
    salida.texto = base.includes(url) ? base : `${base}\n\nPaga aquí con el enlace seguro:\n${url}`;
    salida.enlacePago = url;
    return salida;
  }
  if (confirmacion?.enlace_pago_error) {
    const folio = confirmacion.folio || salida.folio || estado?.folio || '';
    salida.texto = `Tu pedido ${folio} quedó registrado, pero no pude generar el enlace de pago. `
      + 'Escríbeme “enlace de pago” en un momento para reintentarlo sin duplicar el cobro.';
    salida.enlacePagoError = confirmacion.enlace_pago_error;
    return salida;
  }

  const rechazos = (salida.operaciones || []).filter((o) =>
    o?.herramienta === 'definir_pago'
    && o?.resultado?.codigo === 'forma_pago_no_disponible'
    && o?.resultado?.metodo_solicitado === 'transferencia');
  const enlaceDisponible = (metodosPago || []).some((m) => (m?.tipo ?? m) === 'enlace_pago');
  const transferenciaDescartada = pagoDescartado === 'transferencia'
    && !estado?.carrito?.datos?.forma_pago;

  if (enlaceDisponible && (rechazos.length || transferenciaDescartada)) {
    estado.pagoOfrecido = 'enlace_pago';
    salida.texto = 'No contamos con pagos por transferencia, pero podemos ofrecerte un enlace de pago; '
      + 'es muy similar a pagar con transferencia. ¿Te funciona?';
  }
  return salida;
}

// ── QUÉ PASÓ DE VERDAD EN ESTE TURNO ─────────────────────────────────────
//
// Tres desenlaces distintos piden lo mismo —una persona— y solo uno de los
// tres estaba cubierto:
//
//   · el libro devolvió `incierta`: un turno ANTERIOR confirmó y su desenlace
//     no se conoce. Este ya se miraba.
//
//   · ESTE turno intentó confirmar y reventó. `confirmarYEmitir` solo relanza
//     cuando el COMMIT pudo haber ocurrido —los rechazos previos al INSERT
//     vuelven como `ok: false`—, así que una excepción aquí significa «puede
//     haber un pedido y nadie sabe su folio». Este es el que se escapaba:
//     `atenderTurnoConHerramientas` NO relanza, devuelve con `error`, de modo
//     que el `catch` del adaptador jamás lo veía y el turno se cerraba como
//     si nada, con el pedido ya escrito en Postgres y fuera del panel.
//
//   · el agente quiso escalar y su `pedir_humano` no se aplicó
//     (`handoffPendiente`). El adaptador es el único que sabe a quién avisar,
//     así que es su último intento.
//
// Se separa del adaptador porque es una DECISIÓN, no un efecto: así se puede
// probar sin base, sin red y sin modelo, que es como se prueba una decisión.
export function desenlaceDelTurno({ salida = null, confirmacionIntentada = false } = {}) {
  // Un folio conocido no tiene nada de incierto. Si el turno reventó DESPUÉS
  // de una confirmación que sí devolvió folio, el accidente es otro —y ya lo
  // escaló el propio agente—: decirle al cliente «reviso para no registrarlo
  // dos veces» sería sembrar una duda que no existe sobre un pedido que está.
  const confirmacionConocida = !!salida?.confirmado && !!salida?.folio;
  const confirmacionRota = !!salida?.error && !!confirmacionIntentada && !confirmacionConocida;
  const inciertaPrevia = !!salida?.operaciones?.some((o) => o.resultado?.estado === 'incierta');
  const incierta = confirmacionRota || inciertaPrevia;
  const handoffPendiente = !!salida?.handoffPendiente;

  const motivoHandoff = confirmacionRota ? 'AGENTE_ESTADO_INCIERTO'
    : inciertaPrevia ? 'AGENTE_CONFIRMACION_INCIERTA'
      : handoffPendiente ? 'AGENTE_HANDOFF_PENDIENTE'
        : null;

  return {
    incierta,
    confirmacionRota,
    handoffPendiente,
    motivoHandoff,
    // Un pedido que quizá exista no se anuncia como registrado NI como
    // fallido: las dos cosas serían afirmar algo que nadie comprobó.
    texto: incierta
      ? 'Estoy revisando tu pedido con el equipo para evitar registrarlo dos veces. Te responderemos en breve.'
      : null,
  };
}

/**
 * AVISAR A UNA PERSONA, y decir si se logró.
 *
 * Devuelve un booleano en vez de lanzar porque quien llama ya viene de un
 * fallo: lo que necesita es saber si el aviso salió, no otra excepción que
 * atender. Un aviso que no sale se grita con la palabra que se busca en los
 * logs de Railway, porque un handoff perdido no lo nota nadie hasta que un
 * cliente reclama.
 */
export async function avisarAHumano(escalarAHumano, negocioId, telefono, motivo) {
  const quien = `negocio=${negocioId} tel=${telefonoCorto(telefono)} motivo=${motivo}`;
  if (typeof escalarAHumano !== 'function') {
    console.error(`[AGENTE] ALERTA handoff_sin_destino ${quien}`);
    return false;
  }
  try {
    const entregado = await escalarAHumano(negocioId, telefono, motivo);
    // `enviarARevision` devuelve false tanto si ya estaba en revisión como si
    // falló al marcarla. En ningún caso podemos afirmar que ESTE aviso salió.
    if (entregado !== true) {
      console.error(`[AGENTE] ALERTA handoff_no_confirmado ${quien} resultado=${String(entregado).slice(0, 40)}`);
      return false;
    }
    console.log(`[AGENTE] evento=handoff ${quien}`);
    return true;
  } catch (e) {
    console.error(`[AGENTE] ALERTA handoff_no_entregado ${quien} error=${String(e?.message || e).slice(0, 120)}`);
    return false;
  }
}

// ── CONFIRMAR: usar la misma ruta operacional durable que el bot legacy ──
//
// `registrarPedido` es la única puerta de creación de pedidos y tiene su
// propio gate (revalida contra el catálogo real y rechaza lo que el modelo
// invente). No se rodea: se usa. Lo que se añade es que los efectos
// posteriores queden escritos como hechos, no lanzados al aire.
//
// registrarPedido persiste el pedido y crea la deuda de emisión (trigger 063).
// emitirPedido reclama esa deuda y envía panel/impresión por la ruta existente.
// Igual que el bot legacy, la emisión se lanza después del registro; un fallo
// de emisión no convierte un pedido ya guardado en un pedido rechazado.
export async function confirmarYEmitir({
  negocioId, telefono, nombre, canal, estado, pedido, registrar, emitir,
  guardar = guardarPedido, crearPago = crearEnlacePago,
}) {
  const orden = ordenDesdeElCarrito({ negocioId, carrito: estado.carrito, telefono, nombre });
  let resultado;
  try {
    resultado = await registrar(orden, canal);
  } catch (e) {
    console.error('[AGENTE] registrarPedido lanzó:', e.message);
    // Solo estos rechazos ocurren antes de intentar el INSERT. Para cualquier
    // otro error el COMMIT pudo suceder aunque se perdiera la respuesta.
    if (['ORDEN_INVALIDA', 'MODO_SOLICITUD', 'TENANT_CONTEXT_REQUIRED'].includes(e?.codigo)
        || /^TENANT_CONTEXT_REQUIRED:/.test(String(e?.message || ''))) {
      return { ok: false, motivo: e.message };
    }
    throw e;
  }
  if (!resultado || resultado.ok === false) {
    const motivo = (resultado?.rechazos || []).map((r) => r.codigo || r.motivo).join(', ') || 'rechazado';
    return { ok: false, motivo };
  }
  const folio = resultado.folio || resultado.pedido?.id || resultado.id || null;
  Promise.resolve().then(() => emitir(resultado)).catch((e) =>
    console.error(`[AGENTE] emitirPedido(${folio || '-'}) falló:`, e?.message));
  try { await guardar(telefono, resultado, negocioId); }
  catch (e) { console.error(`[AGENTE] guardarPedido(${folio || '-'}) falló:`, e?.message); }

  let enlacePago = null;
  let enlacePagoError = null;
  if (orden.forma_pago === 'enlace_pago') {
    try {
      if (!folio) throw Object.assign(new Error('folio ausente después del registro'), { code: 'FOLIO_AUSENTE' });
      const enlace = await crearPago({
        negocioId, pedidoId: folio, actor: null, descripcion: `Pedido Xabor #${folio}`,
      });
      if (!enlace?.url) throw Object.assign(new Error('el proveedor no devolvió URL'), { code: 'ENLACE_SIN_URL' });
      enlacePago = { url: enlace.url, estado: enlace.estado ?? null, reutilizado: !!enlace.reutilizado };
    } catch (e) {
      const codigo = String(e?.code || 'ERROR_ENLACE_PAGO').slice(0, 80);
      console.error(`[AGENTE] crearEnlacePago(${folio || '-'}) falló codigo=${codigo}`);
      enlacePagoError = { codigo };
    }
  }

  return { ok: true, folio, ...(enlacePago ? { enlacePago } : {}),
    ...(enlacePagoError ? { enlacePagoError } : {}) };
}

export { CIERRE };
