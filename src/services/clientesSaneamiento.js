/**
 * clientesSaneamiento.js — lo que separa a los clientes de verdad de lo que
 * no lo es (fase 1 del saneamiento de Clientes, 21-nov-2026).
 *
 *   Teléfonos del negocio   los WhatsApp de cada sucursal y los que agregue el
 *                           administrador. Nunca reciben una campaña, no
 *                           cuentan en segmentos y un pedido con uno de ellos
 *                           no da de alta a nadie (ver clientesCrm.js).
 *   Interno / empresa       marca por cliente y por negocio: lo saca de
 *                           segmentos, VIP y campañas.
 *
 * Reglas:
 *   - El negocio sale SIEMPRE de la sesión; cada consulta filtra por él.
 *   - Nada se borra: un teléfono se desactiva y cada cambio deja fila en
 *     clientes_bitacora con antes y después (se revierte con el cambio inverso).
 *   - Lo que se le pregunta a Meta corre en segundo plano o desde el panel,
 *     nunca en el camino de un pedido.
 */
import { pool, obtenerCredencialesWhatsappNegocio } from './database.js';
import { versionGraph } from './metaVersionGraph.js';

export class ErrorSaneamiento extends Error {
  constructor(mensaje, codigo, http = 400) { super(mensaje); this.codigo = codigo; this.http = http; }
}

/** Los 10 dígitos con los que se identifica a un cliente (como clientes_negocio). */
export function telefono10(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 10) return d;
  if (/^521\d{10}$/.test(d) || /^52\d{10}$/.test(d)) return d.slice(-10);
  return null;
}

const limpiar = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

async function anotar(ejecutor, { negocioId, entidad, entidadId, accion, antes, despues, quien }) {
  await ejecutor.query(
    `INSERT INTO clientes_bitacora (negocio_id, entidad, entidad_id, accion, antes, despues, ejecutor)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [negocioId, entidad, String(entidadId), accion, antes ? JSON.stringify(antes) : null,
      despues ? JSON.stringify(despues) : null, quien ? String(quien).slice(0, 80) : null]);
}

// ─── Teléfonos del negocio ───────────────────────────────────────────────────
function telefonoPublico(r) {
  return { id: Number(r.id), telefono: r.telefono, etiqueta: r.etiqueta || null, origen: r.origen, activo: r.activo === true,
    alta: r.created_at, cambio: r.updated_at };
}

export async function listarTelefonosPropios(negocioId) {
  const { rows } = await pool.query(
    `SELECT t.*,
            (SELECT count(*)::int FROM pedidos_activos pa
              WHERE pa.negocio_id = t.negocio_id AND pa.estado <> 'cancelado'
                AND right(regexp_replace(pa.datos->'cliente'->>'telefono', '\\D', '', 'g'), 10) = t.telefono) AS pedidos
       FROM negocio_telefonos_propios t WHERE t.negocio_id = $1
      ORDER BY t.activo DESC, t.origen = 'whatsapp' DESC, t.created_at`, [negocioId]);
  return rows.map((r) => ({ ...telefonoPublico(r), pedidos: r.pedidos }));
}

export async function agregarTelefonoPropio(negocioId, { telefono, etiqueta } = {}, quien = null) {
  const tel = telefono10(telefono);
  if (!tel) throw new ErrorSaneamiento('Escribe el teléfono a 10 dígitos.', 'TELEFONO_INVALIDO');
  const et = limpiar(etiqueta, 60) || null;
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows: [previo] } = await cliente.query(
      'SELECT * FROM negocio_telefonos_propios WHERE negocio_id = $1 AND telefono = $2 FOR UPDATE', [negocioId, tel]);
    let fila;
    if (previo) {
      if (previo.activo) throw new ErrorSaneamiento('Ese teléfono ya está en la lista del negocio.', 'YA_EXISTE', 409);
      ({ rows: [fila] } = await cliente.query(
        `UPDATE negocio_telefonos_propios SET activo = true, etiqueta = COALESCE($3, etiqueta), updated_at = now()
          WHERE negocio_id = $1 AND id = $2 RETURNING *`, [negocioId, previo.id, et]));
      await anotar(cliente, { negocioId, entidad: 'telefono_negocio', entidadId: fila.id, accion: 'reactivar',
        antes: telefonoPublico(previo), despues: telefonoPublico(fila), quien });
    } else {
      ({ rows: [fila] } = await cliente.query(
        `INSERT INTO negocio_telefonos_propios (negocio_id, telefono, etiqueta, origen, creado_por)
         VALUES ($1, $2, $3, 'manual', $4) RETURNING *`, [negocioId, tel, et, quien ? String(quien).slice(0, 80) : null]));
      await anotar(cliente, { negocioId, entidad: 'telefono_negocio', entidadId: fila.id, accion: 'agregar',
        antes: null, despues: telefonoPublico(fila), quien });
    }
    await cliente.query('COMMIT');
    return telefonoPublico(fila);
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { cliente.release(); }
}

/** Activa o desactiva (nunca borra). */
export async function cambiarTelefonoPropio(negocioId, id, { activo }, quien = null) {
  const num = Number(id);
  if (!Number.isSafeInteger(num) || num <= 0) throw new ErrorSaneamiento('Teléfono no encontrado.', 'NO_EXISTE', 404);
  if (typeof activo !== 'boolean') throw new ErrorSaneamiento('Indica si el teléfono queda activo.', 'DATO_INVALIDO');
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows: [previo] } = await cliente.query(
      'SELECT * FROM negocio_telefonos_propios WHERE negocio_id = $1 AND id = $2 FOR UPDATE', [negocioId, num]);
    if (!previo) throw new ErrorSaneamiento('Teléfono no encontrado.', 'NO_EXISTE', 404);
    if (previo.activo === activo) { await cliente.query('COMMIT'); return telefonoPublico(previo); }
    const { rows: [fila] } = await cliente.query(
      `UPDATE negocio_telefonos_propios SET activo = $3, updated_at = now() WHERE negocio_id = $1 AND id = $2 RETURNING *`,
      [negocioId, num, activo]);
    await anotar(cliente, { negocioId, entidad: 'telefono_negocio', entidadId: num, accion: activo ? 'reactivar' : 'desactivar',
      antes: telefonoPublico(previo), despues: telefonoPublico(fila), quien });
    await cliente.query('COMMIT');
    return telefonoPublico(fila);
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { cliente.release(); }
}

/**
 * Da de alta el número de WhatsApp conectado del negocio (origen 'whatsapp').
 * Idempotente. Si el administrador ya lo desactivó, se respeta: no se reactiva.
 */
export async function registrarTelefonoWhatsapp(negocioId, numeroMeta) {
  const tel = telefono10(numeroMeta);
  if (!tel) return null;
  const { rows: [fila] } = await pool.query(
    `INSERT INTO negocio_telefonos_propios (negocio_id, telefono, etiqueta, origen, creado_por)
     VALUES ($1, $2, 'WhatsApp del negocio', 'whatsapp', 'meta')
     ON CONFLICT (negocio_id, telefono) DO NOTHING RETURNING *`, [negocioId, tel]);
  if (fila) {
    await anotar(pool, { negocioId, entidad: 'telefono_negocio', entidadId: fila.id, accion: 'agregar',
      antes: null, despues: telefonoPublico(fila), quien: 'meta' });
  }
  return tel;
}

const graph = () => `${process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com'}/${versionGraph()}`;
const revisados = new Map(); // negocioId → ms de la última vez que se le preguntó a Meta
const CADA_CUANTO_MS = 6 * 60 * 60 * 1000;

/** El número que Meta tiene registrado para el WhatsApp conectado del negocio. */
export async function numeroWhatsappDeMeta(negocioId, { fetchImpl = fetch } = {}) {
  const cred = await obtenerCredencialesWhatsappNegocio(negocioId);
  if (!cred?.phoneNumberId || !cred?.accessToken) return null;
  const resp = await fetchImpl(`${graph()}/${encodeURIComponent(cred.phoneNumberId)}?fields=display_phone_number`, {
    headers: { Authorization: `Bearer ${cred.accessToken}` }, signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) return null;
  const datos = await resp.json().catch(() => ({}));
  return typeof datos?.display_phone_number === 'string' ? datos.display_phone_number : null;
}

/**
 * Trabajo en segundo plano: a cada negocio con WhatsApp conectado le registra
 * su número como teléfono del negocio. Pregunta a Meta a lo más una vez cada
 * 6 horas por negocio. Nunca lanza.
 */
export async function asegurarTelefonosWhatsapp({ fetchImpl = fetch, ahora = Date.now(), log = console } = {}) {
  let registrados = 0;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT negocio_id::text AS negocio_id FROM integraciones_canal
        WHERE canal = 'whatsapp' AND proveedor = 'meta' AND estado = 'activo' AND negocio_id IS NOT NULL`);
    for (const { negocio_id: negocioId } of rows) {
      if (ahora - (revisados.get(negocioId) || 0) < CADA_CUANTO_MS) continue;
      revisados.set(negocioId, ahora);
      try {
        const numero = await numeroWhatsappDeMeta(negocioId, { fetchImpl });
        if (numero && await registrarTelefonoWhatsapp(negocioId, numero)) registrados++;
      } catch (e) {
        log.error?.('[CLIENTES] número de WhatsApp del negocio:', e.message);
      }
    }
  } catch (e) {
    log.error?.('[CLIENTES] teléfonos del negocio:', e.message);
  }
  return registrados;
}

// ─── Interno / empresa ───────────────────────────────────────────────────────
export async function marcarInterno(negocioId, clienteId, { interno, motivo } = {}, quien = null) {
  if (typeof interno !== 'boolean') throw new ErrorSaneamiento('Indica si el cliente es interno.', 'DATO_INVALIDO');
  const mot = limpiar(motivo, 120) || null;
  if (interno && !mot) throw new ErrorSaneamiento('Escribe por qué es interno (por ejemplo «empleado» o «proveedor»).', 'MOTIVO_FALTA');
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows: [previo] } = await cliente.query(
      'SELECT id, es_interno, interno_motivo, interno_at, interno_por FROM clientes_negocio WHERE negocio_id = $1 AND id = $2 FOR UPDATE',
      [negocioId, clienteId]);
    if (!previo) throw new ErrorSaneamiento('Cliente no encontrado.', 'NO_EXISTE', 404);
    const estado = (r) => ({ esInterno: r.es_interno === true, motivo: r.interno_motivo || null });
    if (previo.es_interno === interno && (!interno || previo.interno_motivo === mot)) {
      await cliente.query('COMMIT');
      return estado(previo);
    }
    const { rows: [fila] } = await cliente.query(
      `UPDATE clientes_negocio SET es_interno = $3, interno_motivo = $4, interno_at = now(), interno_por = $5
        WHERE negocio_id = $1 AND id = $2
        RETURNING id, es_interno, interno_motivo, interno_at, interno_por`,
      [negocioId, clienteId, interno, interno ? mot : null, quien ? String(quien).slice(0, 80) : null]);
    await anotar(cliente, { negocioId, entidad: 'cliente', entidadId: clienteId, accion: interno ? 'marcar_interno' : 'quitar_interno',
      antes: estado(previo), despues: { ...estado(fila), ...(interno ? {} : { motivoQuitar: mot }) }, quien });
    await cliente.query('COMMIT');
    return estado(fila);
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { cliente.release(); }
}

export async function bitacoraDe(negocioId, entidad, entidadId, limite = 20) {
  const { rows } = await pool.query(
    `SELECT accion, antes, despues, ejecutor, created_at FROM clientes_bitacora
      WHERE negocio_id = $1 AND entidad = $2 AND entidad_id = $3 ORDER BY created_at DESC, id DESC LIMIT $4`,
    [negocioId, entidad, String(entidadId), limite]);
  return rows.map((r) => ({ accion: r.accion, antes: r.antes, despues: r.despues, quien: r.ejecutor, fecha: r.created_at }));
}
