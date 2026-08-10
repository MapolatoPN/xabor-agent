// Sincronizacion de operaciones locales del restaurante hacia la nube.
//
// ─── EL PROBLEMA QUE RESUELVE ───────────────────────────────────────────────
//
// El Edge opera sin internet y despues manda lo que hizo. Entre "el Edge lo
// mando" y "la nube lo guardo" hay una red que puede cortarse en cualquier
// punto. El Edge no puede distinguir "no llego" de "llego y se perdio la
// respuesta", asi que reintenta. Sin idempotencia real, un turno de 500
// operaciones puede acabar cobrado dos veces.
//
// La regla es: la respuesta a un reintento tiene que ser IDENTICA a la del
// original -- mismo folio, mismo id de cuenta, mismo todo. Por eso se guarda
// el `efecto` de cada operacion y se devuelve tal cual al duplicado, en vez
// de contestar un "ok" vacio que el Edge no sabria interpretar.
//
// ─── POR QUE NO BASTA ON CONFLICT DO NOTHING ────────────────────────────────
//
// `ON CONFLICT DO NOTHING` sin mirar el resultado es indistinguible de "se
// inserto". Aqui se usa RETURNING: si vuelve vacio es que YA EXISTIA, y
// entonces se busca la fila original y se devuelve su efecto. Es la misma
// leccion que costo el conflicto de folios del POS.
//
// ─── LOS CUATRO RESULTADOS ──────────────────────────────────────────────────
//
//   aceptada    primera vez, aplicada
//   duplicada   ya estaba; se devuelve el efecto original sin re-aplicar
//   conflicto   choca con algo que no se puede resolver solo -> revision
//   rechazada   invalida (tenant equivocado, payload corrupto, tipo
//               desconocido). No se reintenta: reintentar no la arregla.
//
// Nunca un "200" ambiguo: el Edge necesita saber cual de los cuatro fue para
// decidir si borra la operacion de su journal o la deja para revision.
import { pool } from './database.js';

// Operaciones que el Edge puede sincronizar. Un tipo desconocido se rechaza
// en vez de guardarse "por si acaso": aceptar algo que no sabemos aplicar es
// prometer una durabilidad que no existe.
export const TIPOS_OPERACION = new Set([
  'CUENTA_ABIERTA',
  'ITEM_AGREGADO',
  'ITEM_QUITADO',
  'RONDA_ENVIADA',
  'MESA_MOVIDA',
  'PAGO_REGISTRADO',
  'CUENTA_CERRADA',
]);

// Operaciones aditivas: dos dispositivos agregando platillos a la misma mesa
// no es un conflicto, es un turno normal. Se fusionan.
const ADITIVAS = new Set(['ITEM_AGREGADO', 'RONDA_ENVIADA', 'PAGO_REGISTRADO']);

// Operaciones que cierran o mueven algo. Dos dispositivos cerrando la misma
// cuenta SI es un conflicto, y con dinero de por medio no se resuelve con
// last-write-wins.
const EXCLUSIVAS = new Set(['CUENTA_CERRADA', 'MESA_MOVIDA']);

export function esAditiva(tipo) { return ADITIVAS.has(tipo); }
export function esExclusiva(tipo) { return EXCLUSIVAS.has(tipo); }

function validar(op) {
  if (!op || typeof op !== 'object') return 'operacion vacia';
  if (typeof op.operationId !== 'string' || op.operationId.length < 8) {
    return 'operationId ausente o demasiado corto';
  }
  // Un folio como identidad offline es exactamente el error que no se puede
  // cometer: dos dispositivos sin red generarian el mismo.
  if (/^XAB-\d+$/i.test(op.operationId)) {
    return 'operationId no puede ser un folio: dos dispositivos offline lo repetirian';
  }
  if (typeof op.dispositivoId !== 'string' || !op.dispositivoId.trim()) return 'dispositivoId ausente';
  if (!Number.isInteger(op.secuencia) || op.secuencia < 0) return 'secuencia invalida';
  if (!TIPOS_OPERACION.has(op.tipo)) return `tipo desconocido: ${op.tipo}`;
  if (!op.creadaEnLocal) return 'creadaEnLocal ausente';
  return null;
}

// Busca si esta misma operacion ya se registro. Es la consulta que convierte
// un reintento en un duplicado reconocido.
async function buscarExistente(cliente, negocioId, operationId) {
  const { rows } = await cliente.query(
    `SELECT operation_id, resultado, efecto, motivo, recibida_en
       FROM sync_operaciones WHERE negocio_id = $1 AND operation_id = $2`,
    [negocioId, operationId]);
  return rows[0] || null;
}

// Detecta choques contra operaciones exclusivas ya aplicadas por OTRO
// dispositivo. Solo mira operaciones aceptadas: un conflicto previo no
// bloquea, ya esta marcado para revision.
async function detectarConflicto(cliente, negocioId, op) {
  if (!esExclusiva(op.tipo)) return null;
  const objetivo = op.payload?.cuentaId || op.payload?.mesaId;
  if (!objetivo) return null;

  const { rows } = await cliente.query(
    `SELECT operation_id, dispositivo_id, tipo, payload, creada_en_local
       FROM sync_operaciones
      WHERE negocio_id = $1 AND tipo = $2 AND resultado = 'aceptada'
        AND dispositivo_id <> $3
        AND (payload->>'cuentaId' = $4 OR payload->>'mesaId' = $4)
      LIMIT 1`,
    [negocioId, op.tipo, op.dispositivoId, String(objetivo)]);

  if (!rows[0]) return null;
  return `${op.tipo} sobre ${objetivo} ya fue aplicada por el dispositivo ${rows[0].dispositivo_id}` +
         ` (operacion ${rows[0].operation_id}); dos cierres de la misma cuenta no se resuelven solos`;
}

/**
 * Registra UNA operacion. Idempotente por (negocioId, operationId).
 *
 * `aplicar` es la funcion que produce el efecto real en el dominio (crear la
 * cuenta, agregar el item...). Se invoca UNICAMENTE cuando la operacion es
 * nueva, dentro de la misma transaccion: si falla, no queda registrada como
 * aceptada y el Edge puede reintentar sin haber dejado un efecto a medias.
 */
export async function registrarOperacion(negocioId, op, aplicar = null) {
  const error = validar(op);
  if (error) {
    return { resultado: 'rechazada', operationId: op?.operationId ?? null, motivo: error };
  }

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    const conflicto = await detectarConflicto(cliente, negocioId, op);

    // El INSERT y el RETURNING vacio son la deteccion real del duplicado: no
    // se pregunta antes "existe?" porque entre la pregunta y el INSERT cabe
    // otra conexion haciendo lo mismo.
    const { rows } = await cliente.query(
      `INSERT INTO sync_operaciones
         (negocio_id, sucursal_id, operation_id, dispositivo_id, secuencia, tipo,
          payload, version, creada_en_local, resultado, motivo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (negocio_id, operation_id) DO NOTHING
       RETURNING id, resultado`,
      [negocioId, op.sucursalId || null, op.operationId, op.dispositivoId, op.secuencia,
       op.tipo, JSON.stringify(op.payload || {}), op.version || 1, op.creadaEnLocal,
       conflicto ? 'conflicto' : 'aceptada', conflicto]);

    if (!rows[0]) {
      // Ya existia. Se devuelve el MISMO efecto que la primera vez: un
      // reintento no puede recibir una respuesta distinta del original.
      const existente = await buscarExistente(cliente, negocioId, op.operationId);
      await cliente.query('COMMIT');
      return {
        resultado: 'duplicada',
        operationId: op.operationId,
        efecto: existente?.efecto ?? null,
        resultadoOriginal: existente?.resultado ?? null,
        motivo: existente?.motivo ?? null,
      };
    }

    if (conflicto) {
      // No se aplica y no se pisa nada. Queda esperando a una persona.
      await cliente.query('COMMIT');
      return { resultado: 'conflicto', operationId: op.operationId, motivo: conflicto, requiereRevision: true };
    }

    let efecto = null;
    if (aplicar) {
      // Dentro de la transaccion: o queda la operacion Y su efecto, o no
      // queda ninguno de los dos.
      efecto = await aplicar(cliente, op);
      await cliente.query(
        `UPDATE sync_operaciones SET efecto = $3 WHERE negocio_id = $1 AND operation_id = $2`,
        [negocioId, op.operationId, efecto === undefined ? null : JSON.stringify(efecto)]);
    }

    await cliente.query(
      `INSERT INTO sync_dispositivos (negocio_id, dispositivo_id, generacion, ultima_secuencia)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (negocio_id, dispositivo_id) DO UPDATE
         SET ultima_secuencia = GREATEST(sync_dispositivos.ultima_secuencia, EXCLUDED.ultima_secuencia),
             ultima_sync_en = NOW()`,
      [negocioId, op.dispositivoId, op.generacion || 'sin-generacion', op.secuencia]);

    await cliente.query('COMMIT');
    return { resultado: 'aceptada', operationId: op.operationId, efecto };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    // Un fallo de infraestructura NO es un rechazo: rechazar significaria
    // "no reintentes", y aqui el reintento es justo lo correcto.
    return { resultado: 'rechazada', operationId: op.operationId, motivo: `error al aplicar: ${e.message}`, reintentable: true };
  } finally {
    cliente.release();
  }
}

/**
 * Sincroniza un LOTE. Cada operacion se resuelve por separado: que la tercera
 * choque no puede impedir que la cuarta entre. El Edge recibe el veredicto de
 * cada una y decide que borra de su journal.
 */
export async function sincronizarLote(negocioId, operaciones, aplicar = null) {
  if (!Array.isArray(operaciones)) {
    return { resultados: [], resumen: { aceptadas: 0, duplicadas: 0, conflictos: 0, rechazadas: 0 } };
  }
  // Se ordenan por (dispositivo, secuencia) y no por reloj: dos tablets
  // pueden tener horas distintas, pero la secuencia de cada una es fiable.
  const ordenadas = [...operaciones].sort((a, b) => {
    const d = String(a?.dispositivoId ?? '').localeCompare(String(b?.dispositivoId ?? ''));
    return d !== 0 ? d : (a?.secuencia ?? 0) - (b?.secuencia ?? 0);
  });

  const resultados = [];
  for (const op of ordenadas) {
    resultados.push(await registrarOperacion(negocioId, op, aplicar));
  }

  const resumen = { aceptadas: 0, duplicadas: 0, conflictos: 0, rechazadas: 0 };
  for (const r of resultados) {
    if (r.resultado === 'aceptada') resumen.aceptadas++;
    else if (r.resultado === 'duplicada') resumen.duplicadas++;
    else if (r.resultado === 'conflicto') resumen.conflictos++;
    else resumen.rechazadas++;
  }
  return { resultados, resumen };
}

/** Conflictos sin resolver. Nunca deben quedarse invisibles. */
export async function conflictosPendientes(negocioId, { limite = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT operation_id, dispositivo_id, tipo, payload, motivo, recibida_en
       FROM sync_operaciones
      WHERE negocio_id = $1 AND resultado = 'conflicto' AND revisado_en IS NULL
      ORDER BY recibida_en DESC LIMIT $2`,
    [negocioId, limite]);
  return rows;
}

export async function marcarConflictoRevisado(negocioId, operationId, usuarioId = null) {
  const { rowCount } = await pool.query(
    `UPDATE sync_operaciones SET revisado_en = NOW(), revisado_por = $3
      WHERE negocio_id = $1 AND operation_id = $2 AND resultado = 'conflicto' AND revisado_en IS NULL`,
    [negocioId, operationId, usuarioId]);
  return rowCount === 1;
}

/**
 * Registra la generacion del almacen local de un dispositivo.
 *
 * Si cambia, el Edge perdio su journal. No se le puede dejar resincronizar a
 * ciegas: lo que ya subio esta en la nube y volver a mandarlo con operation_id
 * nuevos duplicaria el turno entero. Se le devuelve hasta donde habia llegado
 * para que entre en recuperacion en vez de fingir continuidad.
 */
export async function registrarGeneracion(negocioId, dispositivoId, generacion) {
  const { rows } = await pool.query(
    `SELECT generacion, ultima_secuencia, amnesias FROM sync_dispositivos
      WHERE negocio_id = $1 AND dispositivo_id = $2`,
    [negocioId, dispositivoId]);
  const previo = rows[0];

  if (!previo) {
    await pool.query(
      `INSERT INTO sync_dispositivos (negocio_id, dispositivo_id, generacion) VALUES ($1,$2,$3)
       ON CONFLICT (negocio_id, dispositivo_id) DO NOTHING`,
      [negocioId, dispositivoId, generacion]);
    return { conocido: false, amnesia: false, ultimaSecuencia: 0 };
  }

  if (previo.generacion === generacion) {
    await pool.query(
      `UPDATE sync_dispositivos SET ultima_sync_en = NOW() WHERE negocio_id = $1 AND dispositivo_id = $2`,
      [negocioId, dispositivoId]);
    return { conocido: true, amnesia: false, ultimaSecuencia: Number(previo.ultima_secuencia) };
  }

  await pool.query(
    `UPDATE sync_dispositivos
        SET generacion = $3, amnesias = amnesias + 1, ultima_sync_en = NOW()
      WHERE negocio_id = $1 AND dispositivo_id = $2`,
    [negocioId, dispositivoId, generacion]);
  return {
    conocido: true,
    amnesia: true,
    ultimaSecuencia: Number(previo.ultima_secuencia),
    amnesias: previo.amnesias + 1,
  };
}
