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
import { pool, obtenerMenuCompleto, obtenerConfiguracion } from '../services/database.js';
import { registrarPedido } from '../orders/orderManager.js';
import { atenderTurnoConHerramientas, CIERRE } from './agenteDelMesero.js';
import { estadoNuevo, estadoSerializable } from './ejecutorDeHerramientas.js';
import { libroDeOperaciones, almacenEnPostgres, almacenEnMemoria } from './libroDeOperaciones.js';
import { encolarEnTransaccion, TIPOS } from './outbox.js';
import { productosVendibles } from '../mesero-whatsapp/consultasDelMenu.js';

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
  try {
    const { rows } = await pool.query(
      'SELECT estado FROM conversacion_estado WHERE negocio_id = $1 AND session_id = $2',
      [negocioId, sessionId]);
    if (rows[0]?.estado) return rows[0].estado;
  } catch (e) {
    // Sin estado previo no se inventa uno a medias: se arranca limpio y se
    // dice. Un carrito reconstruido a ojo es peor que uno vacío.
    console.error('[AGENTE] no se pudo leer el estado, se arranca limpio:', e.message);
  }
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
  escalarAHumano = null, registrar = registrarPedido, traza = null,
} = {}) {
  const t0 = Date.now();
  try {
    const [catalogo, cfg] = await Promise.all([
      obtenerMenuCompleto(negocioId),
      obtenerConfiguracion(negocioId).catch(() => ({})),
    ]);
    if (!Array.isArray(catalogo) || !catalogo.length) {
      // Sin carta no hay nada que el agente pueda hacer sin inventar.
      return { ok: false, motivo: 'sin_catalogo' };
    }

    const estado = await leerEstado(negocioId, telefono);
    const libro = libroDeOperaciones(almacenEnPostgres(pool));

    const efectos = {
      confirmar: async ({ pedido }) => confirmarYEncolar({
        negocioId, telefono, nombre, canal, estado, pedido, registrar,
      }),
      escalar: async ({ motivo }) => {
        try {
          if (escalarAHumano) await escalarAHumano(negocioId, telefono, 'AGENTE_PIDE_HUMANO');
          await encolar(negocioId, [{ tipo: TIPOS.HANDOFF,
            carga: { telefono: telefonoCorto(telefono), motivo, canal } }]);
          return { ok: true };
        } catch (e) {
          console.error('[AGENTE] no se pudo escalar:', e.message);
          return { ok: false, motivo: e.message };
        }
      },
    };

    const salida = await atenderTurnoConHerramientas({
      negocioId,
      conversacionId: claveDeSesion(telefono),
      turnoId: turnoId || `t${Date.now()}`,
      mensaje,
      historial,
      catalogo,
      precios: preciosDelCatalogo(catalogo),
      requierePago: String(cfg?.pedido_requiere_pago ?? 'true').toLowerCase() !== 'false',
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
      },
      modo: 'productivo',
      traza,
    });

    await guardarEstado(negocioId, telefono, estado);

    console.log(`[AGENTE] evento=turno negocio=${negocioId} cierre=${salida.motivoCierre} `
      + `estado=${salida.pedido?.estado} ops=${salida.operaciones.length} `
      + `iter=${salida.iteraciones} ms=${salida.duracionMs}`);

    return { ok: true, ...salida };
  } catch (e) {
    console.error('[AGENTE] contenido en el adaptador:', e?.message);
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
    const [catalogo, cfg] = await Promise.all([
      obtenerMenuCompleto(negocioId),
      obtenerConfiguracion(negocioId).catch(() => ({})),
    ]);
    if (!Array.isArray(catalogo) || !catalogo.length) return { ok: false, motivo: 'sin_catalogo' };

    const estado = await leerEstado(negocioId, telefono, { sombra: true });
    const grabadas = [];
    const salida = await atenderTurnoConHerramientas({
      negocioId,
      conversacionId: claveDeSesion(telefono, { sombra: true }),
      turnoId: turnoId || `t${Date.now()}`,
      mensaje,
      historial,
      catalogo,
      precios: preciosDelCatalogo(catalogo),
      requierePago: String(cfg?.pedido_requiere_pago ?? 'true').toLowerCase() !== 'false',
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
      },
      modo: 'sombra',
      traza,
    });

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

// ── CONFIRMAR: el pedido y su outbox, en la MISMA transacción ────────────
//
// `registrarPedido` es la única puerta de creación de pedidos y tiene su
// propio gate (revalida contra el catálogo real y rechaza lo que el modelo
// invente). No se rodea: se usa. Lo que se añade es que los efectos
// posteriores queden escritos como hechos, no lanzados al aire.
//
// El orden importa: primero el pedido —que es quien puede rechazar— y después,
// con su folio, los eventos. Si el pedido no se registra no hay eventos que
// encolar, y ese es justo el caso en que no debe haberlos.
async function confirmarYEncolar({ negocioId, telefono, nombre, canal, estado, pedido, registrar }) {
  const orden = ordenDesdeElCarrito({ negocioId, carrito: estado.carrito, telefono, nombre });
  let resultado;
  try {
    resultado = await registrar(orden, canal);
  } catch (e) {
    console.error('[AGENTE] registrarPedido lanzó:', e.message);
    return { ok: false, motivo: e.message };
  }
  if (!resultado || resultado.ok === false) {
    const motivo = (resultado?.rechazos || []).map((r) => r.codigo || r.motivo).join(', ') || 'rechazado';
    return { ok: false, motivo };
  }
  const folio = resultado.folio || resultado.pedido?.id || resultado.id || null;

  await encolar(negocioId, [
    { tipo: TIPOS.PEDIDO_CONFIRMADO, carga: { folio, canal, total: pedido?.total ?? null } },
    { tipo: TIPOS.ENVIAR_CONFIRMACION_WHATSAPP, carga: { folio, telefono } },
    { tipo: TIPOS.IMPRIMIR, carga: { folio } },
    { tipo: TIPOS.REWARDS, carga: { folio, telefono: telefonoCorto(telefono) } },
    { tipo: TIPOS.ANALYTICS, carga: { folio, canal, renglones: pedido?.lineas?.length ?? 0 } },
  ]);

  return { ok: true, folio };
}

/** Encola fuera de transacción cuando no hay una abierta. Ver `outbox.js`. */
async function encolar(negocioId, eventos) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await encolarEnTransaccion(cliente, negocioId, eventos);
    await cliente.query('COMMIT');
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    // Un outbox que no se pudo escribir NO tumba el pedido: el pedido ya
    // existe y el cliente ya lo pidió. Se deja dicho para que se vea.
    console.error('[AGENTE] no se pudo encolar el outbox:', e.message);
  } finally {
    cliente.release();
  }
}

export { CIERRE };
