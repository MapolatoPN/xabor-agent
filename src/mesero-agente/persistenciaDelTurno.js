// ─── EL LÍMITE TRANSACCIONAL DEL TURNO ────────────────────────────────────
//
// Antes, ninguna escritura del agente compartía transacción: estado (upsert
// ciego, último en escribir gana), libro de operaciones, respuesta al cliente
// y traza iban cada una por su lado. Un crash o dos procesos a la vez podían
// dejar un renglón anotado sin estado, un estado sin su respuesta, o pisar un
// cambio sin que nadie lo notara.
//
// Aquí un turno termina con UN commit:
//
//   BEGIN
//     conversacion_estado   UPDATE … WHERE revision = <la que se leyó>
//                           (0 filas ⇒ otro proceso escribió: conflicto)
//     agente_operaciones    las mutaciones internas del turno
//     agente_outbox         la respuesta al cliente (+ eventos del turno)
//     agente_turnos         la traza del turno (única por lote de wamids)
//   COMMIT
//
// o están los cuatro, o no está ninguno. El envío a Meta ocurre DESPUÉS, fuera
// de la transacción: un error al enviar no revierte ni repite la mutación, y la
// respuesta queda en el outbox para el reintento.
//
// ── Idempotencia por lote de wamids ──────────────────────────────────────
//
// `turnoClave` sale de los wamid del lote. El estado guarda los últimos que se
// aplicaron (`turnosAplicados`): si el mismo lote vuelve a llegar —reentrega,
// reinicio, un segundo proceso— no se ejecuta otra vez; se devuelve la
// respuesta que ya se había comprometido.
import { createHash } from 'node:crypto';
import { pool as poolPorOmision } from '../services/database.js';
import { estadoNuevo, estadoSerializable } from './ejecutorDeHerramientas.js';
import { normalizarEstado, sellarEstado } from './estadoCanonico.js';
import { conciliarDialogoEntregado } from './entregaDeRespuestas.js';
import { redactarProfundo } from './trazas.js';

export const claveDeSesion = (telefono, { sombra = false } = {}) =>
  `${sombra ? 'agente-sombra' : 'agente'}:${telefono}`;

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

/** La identidad del turno: el lote de wamids (ordenado), o un id de respaldo. */
export function claveDeTurno({ wamids = [], turnoId = null } = {}) {
  const ids = [...new Set((Array.isArray(wamids) ? wamids : []).map(String).filter(Boolean))].sort();
  if (ids.length) return `wa:${sha(ids.join('|')).slice(0, 32)}`;
  return turnoId || `t${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

export const claveDeRespuesta = ({ negocioId, sessionId, turnoClave }) =>
  sha(`respuesta_cliente|${negocioId}|${sessionId}|${turnoClave}`);

export class ConflictoDeVersionError extends Error {
  constructor(detalle = '') {
    super(`conflicto_de_version: otro proceso escribió esta conversación ${detalle}`.trim());
    this.name = 'ConflictoDeVersionError';
    this.codigo = 'CONFLICTO_DE_VERSION';
  }
}

/**
 * Lee el estado CON su versión. Solo una lectura exitosa sin filas es una
 * conversación nueva: si la base falla, se lanza (atender con un carrito vacío
 * podría duplicar un pedido previo).
 */
export async function leerEstadoVersionado(negocioId, telefono, { sombra = false, db = poolPorOmision } = {}) {
  const sessionId = claveDeSesion(telefono, { sombra });
  const { rows } = await db.query(
    `SELECT estado, revision, actualizado_at,
            EXTRACT(EPOCH FROM (NOW() - actualizado_at)) * 1000 AS inactividad_ms
       FROM conversacion_estado WHERE negocio_id = $1 AND session_id = $2`,
    [negocioId, sessionId]);
  let estado;
  if (rows[0]?.estado) {
    estado = {
      ...rows[0].estado,
      _actualizadoAt: rows[0].actualizado_at?.toISOString?.() || null,
      _inactividadMs: rows[0].inactividad_ms == null ? null : Number(rows[0].inactividad_ms),
    };
    Object.defineProperty(estado, '_revision', {
      value: Number(rows[0].revision), writable: true, configurable: true, enumerable: false,
    });
  } else {
    estado = estadoNuevo({ negocioId, conversacionId: sessionId });
    Object.defineProperty(estado, '_revision', { value: null, writable: true, configurable: true, enumerable: false });
  }
  normalizarEstado(estado);
  // Si Meta aceptó la última respuesta pero el acuse del diálogo se perdió, el
  // outbox lo sabe: se concilia aquí (en memoria; lo persiste el commit).
  if (!sombra) {
    await conciliarDialogoEntregado(estado, { db, negocioId })
      .catch((e) => console.error(`[AGENTE] no se pudo conciliar el acuse del diálogo: ${e?.message}`));
  }
  return estado;
}

/** Copia la identidad de persistencia (versión e idempotencia) a un estado de ciclo nuevo. */
export function heredarIdentidad(nuevo, anterior) {
  if (!nuevo || !anterior || nuevo === anterior) return nuevo;
  Object.defineProperty(nuevo, '_revision', {
    value: anterior._revision ?? null, writable: true, configurable: true, enumerable: false,
  });
  nuevo.version = anterior.version ?? 0;
  nuevo.turnosAplicados = [...(anterior.turnosAplicados || [])];
  nuevo.ultimoWamid = anterior.ultimoWamid ?? null;
  return nuevo;
}

/** La respuesta que un turno ya aplicado comprometió en el outbox. */
export async function respuestaDeTurnoAplicado({ negocioId, telefono, turnoClave, db = poolPorOmision }) {
  const clave = claveDeRespuesta({ negocioId, sessionId: claveDeSesion(telefono), turnoClave });
  const { rows } = await db.query(
    'SELECT evento_clave, estado, carga FROM agente_outbox WHERE evento_clave = $1', [clave]);
  return rows[0] ? { clave, estado: rows[0].estado, ...rows[0].carga } : null;
}

const accionesDeLaTraza = (operaciones = []) => operaciones.map((o) => ({
  herramienta: o.herramienta,
  origen: o.origen || (o.determinista ? 'determinista' : 'modelo'),
  argumentos: redactarProfundo(o.argumentos ?? {}),
  aplicada: o.resultado?.aplicado === true,
  estado: o.resultado?.estado ?? null,
  motivo: o.resultado?.aplicado === true ? null : String(o.resultado?.motivo || '').slice(0, 160) || null,
  repetida: !!o.repetida,
  ...(o.forzada ? { forzada: true } : {}),
}));

/**
 * EL COMMIT DEL TURNO. Sella la fase, valida el estado y escribe todo en una
 * transacción. Lanza `EstadoInvalidoError` (el estado no cuadra: no se
 * persiste nada) o `ConflictoDeVersionError` (otro proceso escribió primero).
 */
export async function confirmarTurno({
  db = poolPorOmision, negocioId, telefono, estado, pedido, sombra = false, modo = 'productivo',
  turnoClave, wamids = [], respuesta = null, libro = null, eventos = [], salida = null,
  faseAntes = null, versionAntes = null, pendienteAntes = null, latencias = {},
} = {}) {
  const sessionId = claveDeSesion(telefono, { sombra });
  sellarEstado(estado, pedido, { modo: sombra ? 'sombra' : modo });
  const revisionLeida = estado._revision ?? null;
  const ids = [...new Set((wamids || []).map(String).filter(Boolean))];
  estado.ultimoWamid = ids.length ? ids[ids.length - 1] : (estado.ultimoWamid ?? null);
  estado.turnosAplicados = [...(estado.turnosAplicados || []).filter((k) => k !== turnoClave), turnoClave].slice(-20);
  estado.version = (revisionLeida ?? 0) + 1;

  const cliente = await db.connect();
  const claves = [];
  try {
    await cliente.query('BEGIN');
    const serializado = JSON.stringify(estadoSerializable(estado));
    let revisionNueva;
    if (revisionLeida == null) {
      const r = await cliente.query(
        `INSERT INTO conversacion_estado (negocio_id, session_id, estado, revision)
         VALUES ($1,$2,$3::jsonb,1)
         ON CONFLICT (negocio_id, session_id) DO NOTHING RETURNING revision`,
        [negocioId, sessionId, serializado]);
      if (!r.rows[0]) throw new ConflictoDeVersionError('(la conversación nació en paralelo)');
      revisionNueva = Number(r.rows[0].revision);
    } else {
      const r = await cliente.query(
        `UPDATE conversacion_estado SET estado = $3::jsonb, revision = revision + 1, actualizado_at = NOW()
          WHERE negocio_id = $1 AND session_id = $2 AND revision = $4
          RETURNING revision`,
        [negocioId, sessionId, serializado, revisionLeida]);
      if (!r.rows[0]) throw new ConflictoDeVersionError(`(se leyó la revisión ${revisionLeida})`);
      revisionNueva = Number(r.rows[0].revision);
    }

    if (libro?.almacen?.volcar) await libro.almacen.volcar(cliente);

    if (respuesta?.texto && !sombra) {
      const clave = claveDeRespuesta({ negocioId, sessionId, turnoClave });
      // Disponible para el despachador en 30 s: el canal lo envía en línea y
      // lo marca entregado; el despachador solo recoge lo que quedó colgado.
      await cliente.query(
        `INSERT INTO agente_outbox (negocio_id, evento_clave, tipo, carga, conversacion_id, turno_clave, disponible_at)
         VALUES ($1,$2,'respuesta_cliente',$3::jsonb,$4,$5, now() + interval '30 seconds')
         ON CONFLICT (evento_clave) DO NOTHING`,
        [negocioId, clave, JSON.stringify({
          telefono, texto: respuesta.texto, dialogo_id: respuesta.dialogoId || null,
          session_id: sessionId, turno_clave: turnoClave,
        }), sessionId, turnoClave]);
      claves.push(clave);
    }
    for (const ev of (eventos || [])) {
      const clave = sha(`${ev.tipo}|${negocioId}|${sessionId}|${turnoClave}|${JSON.stringify(ev.carga ?? {})}`);
      await cliente.query(
        `INSERT INTO agente_outbox (negocio_id, evento_clave, tipo, carga, conversacion_id, turno_clave)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT (evento_clave) DO NOTHING`,
        [negocioId, clave, ev.tipo, JSON.stringify(ev.carga ?? {}), sessionId, turnoClave]);
      claves.push(clave);
    }

    const operaciones = salida?.operaciones || [];
    await cliente.query(
      `INSERT INTO agente_turnos
         (negocio_id, conversacion_id, turno_clave, modo, wamids, fase_antes, fase_despues,
          version_antes, version_despues, pendiente_antes, pendiente_despues, acciones, rechazos,
          folio, outbox_claves, motivo_handoff, cierre, recuperacion, latencias, errores_proveedor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,
               $14,$15,$16,$17,$18,$19::jsonb,$20::jsonb)
       ON CONFLICT (negocio_id, conversacion_id, turno_clave) DO NOTHING`,
      [negocioId, estado.conversacionId, turnoClave, sombra ? 'sombra' : (modo === 'replay' ? 'replay' : 'productivo'),
        ids, faseAntes, estado.fase, versionAntes, revisionNueva,
        pendienteAntes ? JSON.stringify(redactarProfundo(pendienteAntes)) : null,
        estado.pendiente ? JSON.stringify(redactarProfundo(estado.pendiente)) : null,
        JSON.stringify(accionesDeLaTraza(operaciones)),
        JSON.stringify(accionesDeLaTraza(operaciones.filter((o) => o.resultado?.aplicado === false))),
        estado.folio ?? null, claves, salida?.motivoHandoff || (estado.hechos?.escalado ? (estado.motivoEscalado || null) : null),
        salida?.motivoCierre ?? null, salida?.recuperacion ?? null,
        JSON.stringify({ ...latencias }), JSON.stringify(salida?.erroresProveedor || [])]);

    await cliente.query('COMMIT');
    Object.defineProperty(estado, '_revision', { value: revisionNueva, writable: true, configurable: true, enumerable: false });
    estado.version = revisionNueva;
    return { version: revisionNueva, outboxClaves: claves };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

// La entrega de la respuesta comprometida (reclamo, aceptación de Meta, acuse
// del diálogo, despachador) vive en entregaDeRespuestas.js: allí se decide que
// una respuesta aceptada por Meta jamás vuelva a quedar disponible.
