// ─── Quitar o cambiar un platillo: motivo, autorización y bitácora ─────────
//
// Auditoría del 28-sep-2026 (Mapolato Obispado): las 55 cancelaciones de
// platillos las hizo la misma sesión de administrador, con el motivo en
// texto libre («x», «NO», «PRUEBA»; en 27 casos, algo con forma de
// contraseña). El mesero no podía pedir autorización desde su tablet, y lo
// que no había salido a cocina se borraba sin rastro.
//
// Reglas que viven aquí (el servidor las exige; la pantalla solo las pide):
//   · el motivo sale de una lista fija; «Otro» exige escribirlo;
//   · lo que ya salió a cocina lo autoriza una persona con su PIN personal
//     (admin o staff con PIN de autorización), no la sesión que esté abierta;
//   · mientras el negocio no tenga a nadie con PIN, solo la sesión de
//     administrador puede cancelar (la regla de antes), para no dejar al
//     restaurante sin forma de corregir una cuenta el día que se publique;
//   · cinco PIN equivocados seguidos bloquean unos minutos.
import { pool } from './database.js';
import { hashPin, verifyPinAsync, pinValido } from './password.js';
import { tomarLugares } from './limitesPersistentes.js';

export const MOTIVOS_CANCELACION = Object.freeze([
  { codigo: 'cambio', texto: 'Cambio de platillo' },
  { codigo: 'error_captura', texto: 'Error de captura' },
  { codigo: 'ya_no_lo_quiso', texto: 'El cliente ya no lo quiso' },
  { codigo: 'duplicado', texto: 'Duplicado' },
  { codigo: 'cortesia', texto: 'Cortesía' },
  { codigo: 'otro', texto: 'Otro' },
]);
const TEXTO_DE = new Map(MOTIVOS_CANCELACION.map(m => [m.codigo, m.texto]));

// Quién puede tener PIN de autorización. El mesero no: pide, no autoriza.
export const ROLES_QUE_AUTORIZAN = Object.freeze(['admin', 'staff']);
// Supervisor (candado de precuenta, 140): solo un administrador con su clave.
// Una clave de staff autoriza lo de siempre, pero no lo que se cambia después
// de imprimir la precuenta (ver candadoPrecuenta.js).
export const ROLES_SUPERVISOR = Object.freeze(['admin']);

export const INTENTOS_PIN = 5;
export const VENTANA_PIN_MS = 5 * 60 * 1000;

function errorCodigo(mensaje, code) {
  return Object.assign(new Error(mensaje), { code });
}

/**
 * Normaliza el motivo que llega de la pantalla. Devuelve { codigo, texto } o
 * lanza MOTIVO_REQUERIDO / MOTIVO_INVALIDO. Por compatibilidad, un cuerpo
 * viejo con solo `motivo` (texto) se toma como «Otro».
 */
export function resolverMotivo({ motivo_codigo: codigo, motivo } = {}) {
  const detalle = String(motivo ?? '').trim().slice(0, 200);
  if (codigo == null || codigo === '') {
    if (!detalle) throw errorCodigo('Elige el motivo', 'MOTIVO_REQUERIDO');
    return { codigo: 'otro', texto: detalle };
  }
  if (!TEXTO_DE.has(codigo)) throw errorCodigo('Motivo no válido', 'MOTIVO_INVALIDO');
  if (codigo === 'otro') {
    if (!detalle) throw errorCodigo('Escribe el motivo', 'MOTIVO_REQUERIDO');
    return { codigo, texto: detalle };
  }
  return { codigo, texto: detalle ? `${TEXTO_DE.get(codigo)}: ${detalle}` : TEXTO_DE.get(codigo) };
}

// ─── Autorizadores ──────────────────────────────────────────────────────────

async function autorizadoresConPin(negocioId, cliente = pool, roles = ROLES_QUE_AUTORIZAN) {
  const { rows } = await cliente.query(
    `SELECT u.id, u.nombre, un.rol, u.pin_autorizacion_hash
       FROM usuarios u
       JOIN usuario_negocios un ON un.usuario_id = u.id
      WHERE un.negocio_id = $1 AND un.activo = TRUE AND u.activo = TRUE
        AND un.rol = ANY($2::text[]) AND u.pin_autorizacion_hash IS NOT NULL`,
    [negocioId, roles]);
  return rows;
}

// `roles`: ROLES_SUPERVISOR para saber si el negocio tiene a quién pedirle
// la clave de supervisor (el candado de precuenta no se activa sin nadie).
export async function hayAutorizadores(negocioId, { roles = ROLES_QUE_AUTORIZAN, cliente = pool } = {}) {
  return (await autorizadoresConPin(negocioId, cliente, roles)).length > 0;
}

// Intentos (negocio + quien pide + IP), guardados en la base (Fase 1, bloque
// 2, limitesPersistentes.js): un despliegue ya no los reinicia. El lugar se
// toma antes de comparar y se devuelve si la clave fue correcta.

/**
 * Devuelve { id, nombre, rol } de quien autoriza con ese PIN en este negocio,
 * o lanza PIN_REQUERIDO / PIN_BLOQUEADO / PIN_INCORRECTO. No dice si el PIN
 * existe en otro negocio ni de quién es cuando falla. Con
 * `roles: ROLES_SUPERVISOR` solo vale la clave de un administrador.
 */
export async function verificarPinAutorizacion(negocioId, pin, claveIntentos, { roles = ROLES_QUE_AUTORIZAN } = {}) {
  if (!pin) throw errorCodigo('Falta la clave de quien autoriza', 'PIN_REQUERIDO');
  const clave = `autoriza:${negocioId}:${claveIntentos || ''}`;
  const devolver = await tomarLugares([{ clave, limite: INTENTOS_PIN, ventanaMs: VENTANA_PIN_MS }]);
  if (!devolver) throw errorCodigo('Demasiados intentos. Espera unos minutos.', 'PIN_BLOQUEADO');
  const texto = String(pin);
  if (pinValido(texto)) {
    for (const a of await autorizadoresConPin(negocioId, pool, roles)) {
      if (await verifyPinAsync(texto, a.pin_autorizacion_hash)) {
        await devolver();
        return { id: a.id, nombre: a.nombre, rol: a.rol };
      }
    }
  }
  throw errorCodigo('Clave incorrecta', 'PIN_INCORRECTO');
}

/**
 * Fija el PIN de autorización de una persona. Solo admin o staff activos del
 * negocio. Dos personas del mismo negocio no pueden tener el mismo PIN: el
 * PIN es lo que dice QUIÉN autorizó.
 */
export async function fijarPinAutorizacion(negocioId, usuarioId, pin) {
  if (!pinValido(String(pin ?? ''))) throw errorCodigo('La clave debe tener entre 4 y 6 dígitos', 'PIN_INVALIDO');
  const { rows: [miembro] } = await pool.query(
    `SELECT u.id, un.rol FROM usuarios u JOIN usuario_negocios un ON un.usuario_id = u.id
      WHERE u.id = $1 AND un.negocio_id = $2 AND un.activo = TRUE AND u.activo = TRUE`,
    [usuarioId, negocioId]);
  if (!miembro) throw errorCodigo('Usuario no encontrado', 'USUARIO_NO_ENCONTRADO');
  if (!ROLES_QUE_AUTORIZAN.includes(miembro.rol)) {
    throw errorCodigo('Solo un administrador o personal de staff puede autorizar', 'ROL_NO_AUTORIZA');
  }
  // El mismo usuario puede pertenecer a varios negocios: el PIN tiene que ser
  // único en cada uno donde autoriza.
  const { rows: otros } = await pool.query(
    `SELECT DISTINCT u.pin_autorizacion_hash
       FROM usuario_negocios mio
       JOIN usuario_negocios un ON un.negocio_id = mio.negocio_id
       JOIN usuarios u ON u.id = un.usuario_id
      WHERE mio.usuario_id = $1 AND mio.activo = TRUE AND mio.rol = ANY($2::text[])
        AND un.usuario_id <> $1 AND un.activo = TRUE AND u.activo = TRUE
        AND un.rol = ANY($2::text[]) AND u.pin_autorizacion_hash IS NOT NULL`,
    [usuarioId, ROLES_QUE_AUTORIZAN]);
  let repetido = false;
  for (const o of otros) {
    if (await verifyPinAsync(String(pin), o.pin_autorizacion_hash)) { repetido = true; break; }
  }
  if (repetido) {
    throw errorCodigo('Esa clave ya la usa otra persona del negocio: elige otra', 'PIN_REPETIDO');
  }
  await pool.query('UPDATE usuarios SET pin_autorizacion_hash = $2, updated_at = NOW() WHERE id = $1',
    [usuarioId, hashPin(String(pin))]);
  return { ok: true };
}

export async function quitarPinAutorizacion(negocioId, usuarioId) {
  const { rowCount } = await pool.query(
    `UPDATE usuarios u SET pin_autorizacion_hash = NULL, updated_at = NOW()
      WHERE u.id = $1 AND EXISTS (SELECT 1 FROM usuario_negocios un WHERE un.usuario_id = u.id AND un.negocio_id = $2)`,
    [usuarioId, negocioId]);
  if (!rowCount) throw errorCodigo('Usuario no encontrado', 'USUARIO_NO_ENCONTRADO');
  return { ok: true };
}

/** Quién del negocio tiene PIN de autorización (sin hashes). */
export async function listarAutorizadores(negocioId) {
  const { rows } = await pool.query(
    `SELECT u.id, (u.pin_autorizacion_hash IS NOT NULL) AS con_pin
       FROM usuarios u JOIN usuario_negocios un ON un.usuario_id = u.id
      WHERE un.negocio_id = $1 AND un.activo = TRUE AND un.rol = ANY($2::text[])`,
    [negocioId, ROLES_QUE_AUTORIZAN]);
  return rows;
}

// ─── Reporte del día ────────────────────────────────────────────────────────

/**
 * Todo lo que se quitó de las cuentas en un rango UTC: cancelaciones de lo
 * que ya estaba en cocina (con quién pidió y quién autorizó) y lo que se
 * quitó o redujo antes de enviarse. Es el control contra abusos: cuánto
 * dinero salió de las cuentas, por qué motivo y con la clave de quién.
 */
export async function reporteCancelaciones(negocioId, inicio, fin) {
  const { rows } = await pool.query(
    `SELECT e.id, e.tipo, e.producto, e.modificadores, e.cantidad, e.precio_unitario::float AS precio_unitario,
            (e.cantidad * e.precio_unitario)::float AS importe, e.comanda_num, e.motivo_codigo, e.motivo,
            e.created_at, c.mesa_numero AS mesa,
            us.nombre AS solicitado_por_nombre, ua.nombre AS autorizado_por_nombre
       FROM restaurante_item_eventos e
       JOIN restaurante_cuentas c ON c.id = e.cuenta_id
       LEFT JOIN usuarios us ON us.id = e.solicitado_por
       LEFT JOIN usuarios ua ON ua.id = e.autorizado_por
      WHERE e.negocio_id = $1 AND e.created_at >= $2 AND e.created_at < $3
      ORDER BY e.created_at`,
    [negocioId, inicio, fin]);
  const cancelados = rows.filter(r => r.tipo === 'cancelado');
  const antes = rows.filter(r => r.tipo !== 'cancelado');
  const suma = (lista) => Math.round(lista.reduce((s, r) => s + r.importe, 0) * 100) / 100;
  const agrupar = (lista, clave) => {
    const m = new Map();
    for (const r of lista) {
      const k = clave(r) || '—';
      const a = m.get(k) || { clave: k, num: 0, importe: 0 };
      a.num += r.cantidad; a.importe = Math.round((a.importe + r.importe) * 100) / 100;
      m.set(k, a);
    }
    return [...m.values()].sort((x, y) => y.importe - x.importe);
  };
  return {
    cancelados: { num: cancelados.reduce((s, r) => s + r.cantidad, 0), importe: suma(cancelados) },
    antes_de_enviar: { num: antes.reduce((s, r) => s + r.cantidad, 0), importe: suma(antes) },
    por_motivo: agrupar(cancelados, r => TEXTO_DE.get(r.motivo_codigo) || 'Sin código'),
    por_autorizo: agrupar(cancelados, r => r.autorizado_por_nombre || 'Sin autorización registrada'),
    eventos: rows,
  };
}
