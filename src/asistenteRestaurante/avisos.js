// Asistente del restaurante, Fase 1: quién ve los avisos y qué contestó.
//
// Banderas (tabla configuracion, por sucursal):
//   asistente_restaurante_v1            'true' enciende la revisión de cada mañana.
//   asistente_restaurante_modo          'visible' los muestra; cualquier otra
//                                       cosa (o nada) es 'ensayo': se calcula y
//                                       se guarda, pero no lo ve nadie.
//   asistente_restaurante_destinatarios JSON con los id de usuario que lo ven.
//                                       Vacío o inválido = nadie (falla cerrado).
// Una sesión de soporte (superadmin) no es usuario del negocio: no lo ve.
import { TIPOS_CONTROL } from './reglas.js';

export const BANDERA = 'asistente_restaurante_v1';
export const CLAVE_MODO = 'asistente_restaurante_modo';
export const CLAVE_DESTINATARIOS = 'asistente_restaurante_destinatarios';
export const DIAS_EN_LA_LISTA = 14;
export const OPINIONES = Object.freeze(['util', 'no_util', 'no_avisar']);

const esUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const exigirNegocio = (nid) => { if (!esUuid(nid)) { const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e; } };

/** La configuración del asistente de UNA sucursal. Nunca lanza por un valor raro. */
export async function configuracionAsistente(db, negocioId) {
  exigirNegocio(negocioId);
  const { rows } = await db.query(
    `SELECT clave, valor FROM configuracion WHERE negocio_id = $1 AND clave = ANY($2::text[])`,
    [negocioId, [BANDERA, CLAVE_MODO, CLAVE_DESTINATARIOS]]);
  const v = Object.fromEntries(rows.map((r) => [r.clave, String(r.valor ?? '').trim()]));
  let destinatarios = [];
  try {
    const lista = JSON.parse(v[CLAVE_DESTINATARIOS] || '[]');
    if (Array.isArray(lista)) destinatarios = [...new Set(lista.filter(esUuid).map((x) => x.toLowerCase()))];
  } catch { destinatarios = []; }
  return { activo: v[BANDERA] === 'true', modo: v[CLAVE_MODO] === 'visible' ? 'visible' : 'ensayo', destinatarios };
}

/** ¿Este usuario ve los avisos del asistente en esta sucursal? */
export function puedeVer(cfg, { usuarioId, esSoporte } = {}) {
  return !!cfg && cfg.activo && cfg.modo === 'visible' && !esSoporte && esUuid(usuarioId) && cfg.destinatarios.includes(usuarioId.toLowerCase());
}

/**
 * Los avisos mostrados de los últimos 14 días, con la opinión de ESTE usuario.
 * Del día más nuevo al más viejo; dentro de cada día, primero los de control
 * y calidad (el mismo orden en que se eligieron) y luego por pesos.
 */
export async function listarAvisosAsistente(db, negocioId, usuarioId) {
  exigirNegocio(negocioId);
  const { rows } = await db.query(`
    SELECT h.id, h.tipo, h.impacto::float AS impacto, h.titulo, h.contenido, h.creado_en, h.visto_en,
           c.fecha::text AS fecha, o.opinion
      FROM asistente_restaurante_hallazgos h
      JOIN asistente_restaurante_corridas c ON c.negocio_id = h.negocio_id AND c.id = h.corrida_id
      LEFT JOIN asistente_restaurante_opiniones o ON o.hallazgo_id = h.id AND o.usuario_id = $2
     WHERE h.negocio_id = $1 AND h.mostrado
       AND h.creado_en > now() - make_interval(days => $3)
       AND NOT EXISTS (SELECT 1 FROM asistente_restaurante_silenciados s WHERE s.negocio_id = h.negocio_id AND s.firma = h.firma)
     ORDER BY c.fecha DESC, (h.tipo = ANY($4::text[])) DESC, h.impacto DESC, h.id DESC
     LIMIT 30`, [negocioId, usuarioId, DIAS_EN_LA_LISTA, [...TIPOS_CONTROL]]);
  return {
    activo: true,
    sinVer: rows.filter((r) => !r.visto_en).length,
    avisos: rows.map((r) => ({
      id: String(r.id), tipo: r.tipo, impacto: r.impacto, titulo: r.titulo, fecha: r.fecha,
      detalle: r.contenido?.detalle || null, sugerencia: r.contenido?.sugerencia || '', revisar: r.contenido?.revisar || null,
      creado_en: r.creado_en, visto: !!r.visto_en, opinion: r.opinion || null,
    })),
  };
}

/** Marca uno (id) o todos como vistos. Solo los de ESTA sucursal. */
export async function marcarVistosAsistente(db, negocioId, { id = null, usuarioId = null } = {}) {
  exigirNegocio(negocioId);
  if (id !== null && !/^\d{1,18}$/.test(String(id))) return { marcados: 0 };
  const quien = esUuid(usuarioId) ? usuarioId : null;
  const { rowCount } = await db.query(`
    UPDATE asistente_restaurante_hallazgos SET visto_en = now(), visto_por = $3
     WHERE negocio_id = $1 AND mostrado AND visto_en IS NULL AND ($2::bigint IS NULL OR id = $2::bigint)`,
  [negocioId, id === null ? null : String(id), quien]);
  return { marcados: rowCount };
}

/**
 * Útil / No útil / No avisar de esto. Una opinión por usuario y aviso (la
 * última gana). «No avisar» además calla esa firma en la sucursal.
 * Devuelve null si el aviso no es de esta sucursal o no se mostró.
 */
export async function opinarAviso(db, negocioId, { id, usuarioId, opinion }) {
  exigirNegocio(negocioId);
  if (!/^\d{1,18}$/.test(String(id)) || !esUuid(usuarioId) || !OPINIONES.includes(opinion)) return null;
  const { rows: [h] } = await db.query(
    `SELECT id, tipo, firma FROM asistente_restaurante_hallazgos WHERE negocio_id = $1 AND id = $2 AND mostrado`, [negocioId, String(id)]);
  if (!h) return null;
  await db.query(`
    INSERT INTO asistente_restaurante_opiniones (negocio_id, hallazgo_id, usuario_id, opinion, tipo, firma)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (hallazgo_id, usuario_id) DO UPDATE SET opinion = EXCLUDED.opinion, actualizado_en = now()`,
  [negocioId, h.id, usuarioId, opinion, h.tipo, h.firma]);
  if (opinion === 'no_avisar') {
    await db.query(`
      INSERT INTO asistente_restaurante_silenciados (negocio_id, firma, usuario_id) VALUES ($1, $2, $3)
      ON CONFLICT (negocio_id, firma) DO NOTHING`, [negocioId, h.firma, usuarioId]);
  }
  return { id: String(h.id), opinion };
}
