// ─── Candado de precuenta y cobro identificado (migración 140) ──────────────
//
// Pedido de Mario (17-nov-2026) para Obispado: la precuenta que se lleva a la
// mesa tiene que poder ligarse con la cuenta que se cierra, y lo que se le
// quite a la cuenta después de imprimirla lo autoriza un supervisor (un
// administrador del negocio, con SU clave de autorización), no la sesión que
// esté abierta en la caja.
//
// Tres piezas:
//   · Registro de precuentas (siempre, con o sin banderas): cada precuenta
//     impresa queda en restaurante_precuentas con su número dentro de la
//     cuenta, lo que decía y la FIRMA del consumo en ese momento. El papel
//     lleva el folio PC-XXXXXXXX-N, con las mismas 8 letras que la venta
//     RM-XXXXXXXX-n que nace al cerrar: así se casa el papel con la venta.
//   · Candado ('restaurante_candado_precuenta' = 'true'): con una precuenta
//     impresa, bajar lo que ya salió en ella (quitar o rebajar un platillo,
//     cancelarlo, descontar) pide la clave de un supervisor; y cerrar una
//     cuenta que cambió desde su última precuenta pide imprimir otra o la
//     clave de un supervisor. Lo que se agregó DESPUÉS de la precuenta se
//     corrige libre, como siempre: el cliente no lo vio en el papel.
//   · Cobro identificado ('restaurante_cobro_identificado' = 'true'): cobrar
//     y cerrar piden el PIN de quien cobra, aunque la sesión de la caja sea
//     de otra persona. El pago queda a su nombre.
//
// Mientras el negocio no tenga ningún administrador con clave, el candado
// acepta la sesión de administrador (la misma regla de las cancelaciones),
// para que encender la bandera nunca deje a la caja sin forma de corregir.
import { createHash } from 'node:crypto';
import { pool } from './database.js';
import { verifyPin, pinValido } from './password.js';
import { hayAutorizadores, ROLES_SUPERVISOR, INTENTOS_PIN, VENTANA_PIN_MS } from './cancelacionesRestaurante.js';

export const BANDERA_CANDADO = 'restaurante_candado_precuenta';
export const BANDERA_COBRO_IDENTIFICADO = 'restaurante_cobro_identificado';

function errorCodigo(mensaje, code, detalle = null) {
  return Object.assign(new Error(mensaje), { code }, detalle ? { detalle } : {});
}

export async function banderasMesas(negocioId, cliente = pool) {
  const { rows } = await cliente.query(
    `SELECT clave, valor FROM configuracion WHERE negocio_id = $1 AND clave = ANY($2::text[])`,
    [negocioId, [BANDERA_CANDADO, BANDERA_COBRO_IDENTIFICADO]]);
  const valor = new Map(rows.map(r => [r.clave, String(r.valor ?? '').trim()]));
  return {
    candado: valor.get(BANDERA_CANDADO) === 'true',
    cobroIdentificado: valor.get(BANDERA_COBRO_IDENTIFICADO) === 'true',
  };
}

// ─── Firma del consumo ──────────────────────────────────────────────────────
// Lo que cambia el importe: los renglones vivos (id, cantidad, precio) y el
// descuento. Mandar a cocina, comentar o mover de mesa no cambian la firma;
// los pagos tampoco (cobrar no es cambiar la cuenta).
export function firmaDeConsumo(items, descuentoMonto) {
  const vivos = (items || [])
    .filter(i => i.estado !== 'cancelado')
    .map(i => `${i.id}:${Number(i.cantidad)}:${Number(i.precio_unitario ?? i.precioUnitario).toFixed(2)}`)
    .sort();
  const base = `v1|${(Number(descuentoMonto) || 0).toFixed(2)}|${vivos.join(',')}`;
  return createHash('sha256').update(base).digest('hex');
}

async function firmaActual(cliente, cuentaId) {
  const { rows: [c] } = await cliente.query(`SELECT descuento_monto FROM restaurante_cuentas WHERE id = $1`, [cuentaId]);
  const { rows: items } = await cliente.query(
    `SELECT id, cantidad, precio_unitario, estado FROM restaurante_cuenta_items WHERE cuenta_id = $1 AND estado <> 'cancelado'`,
    [cuentaId]);
  return firmaDeConsumo(items, c?.descuento_monto);
}

export function folioPrecuenta(cuentaId, numero) {
  return `PC-${String(cuentaId).replace(/-/g, '').slice(0, 8).toUpperCase()}-${numero}`;
}

function filaAPrecuenta(r, cuentaId) {
  return {
    id: r.id, numero: r.numero, folio: folioPrecuenta(cuentaId, r.numero), tipo: r.tipo,
    subtotal: Number(r.subtotal), descuento: Number(r.descuento), total: Number(r.total), pagado: Number(r.pagado),
    firma: r.firma, emitidoAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    solicitadaPor: r.solicitada_por || null, solicitadaPorNombre: r.solicitada_por_nombre || null,
  };
}

/**
 * Registra las precuentas de UNA impresión (una para la cuenta completa, o
 * una por papel de la cuenta dividida) bajo el lock de la cuenta. Devuelve
 * [{ numero, folio, emitidoAt, ... }] en el orden de `documentos`.
 *
 * `solicitudId` es la identidad por intención que ya manda la pantalla: un
 * reintento devuelve las MISMAS precuentas (mismo número y folio), y el Edge
 * deduplica el papel por su origenId.
 *
 * `firmaEsperada` (opcional): la firma del consumo que se va a imprimir. Si
 * la cuenta cambió entre que se leyó y que se registra, se rechaza: el papel
 * diría una cosa y el registro otra.
 */
export async function registrarPrecuentas(cuentaId, negocioId, { solicitudId, tipo, documentos, usuarioId = null, firmaEsperada = null }) {
  if (!['completa', 'division'].includes(tipo)) throw errorCodigo('Tipo de precuenta no válido', 'MODO_INVALIDO');
  if (!Array.isArray(documentos) || !documentos.length) throw errorCodigo('Sin precuentas que registrar', 'SIN_ITEMS');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [cta] } = await client.query(
      `SELECT id, estado FROM restaurante_cuentas WHERE id = $1 AND negocio_id = $2 FOR UPDATE`, [cuentaId, negocioId]);
    if (!cta) throw errorCodigo('Cuenta no encontrada', 'CUENTA_NO_ENCONTRADA');
    const claves = documentos.length === 1 && tipo === 'completa'
      ? [solicitudId] : documentos.map((_, i) => `${solicitudId}:${i + 1}`);
    const { rows: previas } = await client.query(
      `SELECT * FROM restaurante_precuentas WHERE cuenta_id = $1 AND solicitud_id = ANY($2::text[])`, [cuentaId, claves]);
    if (previas.length === claves.length) {
      await client.query('COMMIT');
      const porClave = new Map(previas.map(r => [r.solicitud_id, r]));
      return claves.map(k => ({ ...filaAPrecuenta(porClave.get(k), cuentaId), repetida: true }));
    }
    if (cta.estado !== 'abierta') throw errorCodigo('La cuenta ya no está abierta', 'CUENTA_NO_ABIERTA');
    const firma = await firmaActual(client, cuentaId);
    if (firmaEsperada && firmaEsperada !== firma) {
      throw errorCodigo('La cuenta cambió mientras se preparaba la precuenta: vuelve a imprimirla', 'CUENTA_CAMBIO');
    }
    const { rows: [m] } = await client.query(
      `SELECT COALESCE(MAX(numero), 0)::int AS n FROM restaurante_precuentas WHERE cuenta_id = $1`, [cuentaId]);
    const yaEstan = new Map(previas.map(r => [r.solicitud_id, r]));
    let siguiente = m.n;
    const salida = [];
    for (const [i, d] of documentos.entries()) {
      const previa = yaEstan.get(claves[i]);
      if (previa) { salida.push({ ...filaAPrecuenta(previa, cuentaId), repetida: true }); continue; }
      siguiente += 1;
      const { rows: [r] } = await client.query(
        `INSERT INTO restaurante_precuentas
           (negocio_id, cuenta_id, numero, tipo, solicitud_id, subtotal, descuento, total, pagado, firma, solicitada_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,(SELECT u.id FROM usuarios u WHERE u.id = $11::uuid)) RETURNING *`,
        [negocioId, cuentaId, siguiente, tipo, claves[i], Number(d.subtotal) || 0, Number(d.descuento) || 0,
         Number(d.total) || 0, Number(d.pagado) || 0, firma, usuarioId]);
      salida.push({ ...filaAPrecuenta(r, cuentaId), repetida: false });
    }
    await client.query('COMMIT');
    return salida;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Última precuenta de la cuenta (o null), con quién la pidió. */
export async function ultimaPrecuenta(cliente, cuentaId) {
  const { rows: [r] } = await cliente.query(
    `SELECT p.*, u.nombre AS solicitada_por_nombre
       FROM restaurante_precuentas p LEFT JOIN usuarios u ON u.id = p.solicitada_por
      WHERE p.cuenta_id = $1 ORDER BY p.numero DESC LIMIT 1`, [cuentaId]);
  return r ? filaAPrecuenta(r, cuentaId) : null;
}

/**
 * ¿El renglón ya existía cuando se imprimió esa precuenta? Lo que se agregó
 * después no salió en el papel y se corrige sin clave. Se compara en la base
 * (microsegundos), no en JavaScript.
 */
export async function itemEnPrecuenta(cliente, itemId, precuentaId) {
  const { rows: [r] } = await cliente.query(
    `SELECT i.created_at <= p.created_at AS dentro
       FROM restaurante_cuenta_items i, restaurante_precuentas p
      WHERE i.id = $1 AND p.id = $2`, [itemId, precuentaId]);
  return Boolean(r?.dentro);
}

/**
 * Lo que la pantalla necesita saber del candado de una cuenta: si está
 * encendido, la última precuenta y si la cuenta sigue igual que en ella.
 */
export async function estadoCandado(negocioId, cuentaId, cliente = pool) {
  const banderas = await banderasMesas(negocioId, cliente);
  const precuenta = await ultimaPrecuenta(cliente, cuentaId);
  const vigente = precuenta ? (await firmaActual(cliente, cuentaId)) === precuenta.firma : null;
  const { firma, ...sinFirma } = precuenta || {};
  return {
    activo: banderas.candado,
    cobroIdentificado: banderas.cobroIdentificado,
    precuenta: precuenta ? sinFirma : null,
    // Sin precuenta no hay nada que comparar.
    vigente,
    bloqueada: Boolean(banderas.candado && precuenta),
  };
}

// ─── Bitácora ───────────────────────────────────────────────────────────────
// Los usuarios van por subconsulta: una sesión de soporte (superadmin) no es
// una fila de `usuarios`, y su acción no debe romper por la llave foránea.
export async function registrarBitacora(cliente, { negocioId, cuentaId, tipo, detalle = {}, solicitadoPor = null, autorizadoPor = null, sesionUsuarioId = null }) {
  await cliente.query(
    `INSERT INTO restaurante_cuenta_bitacora (negocio_id, cuenta_id, tipo, detalle, solicitado_por, autorizado_por, sesion_usuario_id)
     VALUES ($1,$2,$3,$4::jsonb,
             (SELECT u.id FROM usuarios u WHERE u.id = $5::uuid),
             (SELECT u.id FROM usuarios u WHERE u.id = $6::uuid),
             (SELECT u.id FROM usuarios u WHERE u.id = $7::uuid))`,
    [negocioId, cuentaId, tipo, JSON.stringify(detalle || {}), solicitadoPor, autorizadoPor, sesionUsuarioId]);
}

const TEXTO_ACCION = {
  quitar_platillo: 'quitar un platillo',
  reducir_cantidad: 'rebajar la cantidad',
  cancelar_platillo: 'quitar un platillo',
  descuento: 'aplicar un descuento',
  cerrar_vencida: 'cerrar una cuenta que cambió desde la precuenta',
};

/**
 * Decide, DENTRO de la transacción y con la cuenta ya bloqueada, si esta
 * acción necesita un supervisor. Devuelve null si no hace falta, o
 * { id, nombre } de quien autorizó (y lo deja en la bitácora). Lanza
 * CANDADO_PRECUENTA si hace falta y no vino una clave de supervisor.
 *
 *   afecta(precuenta) → ¿la acción toca algo que salió en esa precuenta?
 *   supervisor        → { id, nombre } ya verificado con ROLES_SUPERVISOR, o null
 *   sesion            → { usuarioId, rol } de la sesión que pide
 */
export async function exigirSupervisor(client, {
  negocioId, cuentaId, accion, supervisor = null, sesion = {}, detalle = {}, afecta = () => true,
}) {
  const { candado } = await banderasMesas(negocioId, client);
  if (!candado) return null;
  const precuenta = await ultimaPrecuenta(client, cuentaId);
  if (!precuenta || !(await afecta(precuenta))) return null;
  let autoriza = supervisor;
  let sinClave = false;
  if (!autoriza) {
    const haySupervisores = await hayAutorizadores(negocioId, { roles: ROLES_SUPERVISOR, cliente: client });
    if (!haySupervisores && sesion.rol === 'admin' && sesion.usuarioId) {
      autoriza = { id: sesion.usuarioId, nombre: null };
      sinClave = true;
    } else {
      throw errorCodigo(
        haySupervisores
          ? `La precuenta ${precuenta.folio} ya se imprimió: para ${TEXTO_ACCION[accion] || 'cambiar la cuenta'} hace falta la clave de un supervisor.`
          : `La precuenta ${precuenta.folio} ya se imprimió: para ${TEXTO_ACCION[accion] || 'cambiar la cuenta'} hace falta un administrador. Registra una clave de autorización en Configuración › Usuarios.`,
        'CANDADO_PRECUENTA',
        { folio: precuenta.folio, numero: precuenta.numero, accion, sinSupervisores: !haySupervisores });
    }
  }
  await registrarBitacora(client, {
    negocioId, cuentaId, tipo: 'autorizacion_supervisor',
    detalle: { accion, precuenta: precuenta.folio, ...(sinClave ? { sin_clave: true } : {}), ...detalle },
    solicitadoPor: sesion.usuarioId || null, autorizadoPor: autoriza.id, sesionUsuarioId: sesion.usuarioId || null,
  });
  return autoriza;
}

/**
 * Al cerrar con el candado encendido: si la cuenta cambió desde su última
 * precuenta, el papel que tiene el cliente ya no dice lo que se cobra. Se
 * cierra solo imprimiendo otra (sin clave) o con la clave de un supervisor.
 */
export async function exigirPrecuentaVigente(client, { negocioId, cuentaId, supervisor = null, sesion = {}, totalActual = null }) {
  const { candado } = await banderasMesas(negocioId, client);
  if (!candado) return null;
  const precuenta = await ultimaPrecuenta(client, cuentaId);
  if (!precuenta) return null;
  if ((await firmaActual(client, cuentaId)) === precuenta.firma) return null;
  try {
    return await exigirSupervisor(client, {
      negocioId, cuentaId, accion: 'cerrar_vencida', supervisor, sesion,
      detalle: { total_precuenta: precuenta.total, total_actual: totalActual },
    });
  } catch (e) {
    if (e.code !== 'CANDADO_PRECUENTA') throw e;
    throw errorCodigo(
      `La cuenta cambió desde la precuenta ${precuenta.folio} ($${precuenta.total.toFixed(2)}${totalActual != null ? ` → $${Number(totalActual).toFixed(2)}` : ''}): imprime una precuenta nueva y entrégala, o pide la clave de un supervisor.`,
      'PRECUENTA_VENCIDA',
      { ...e.detalle, totalPrecuenta: precuenta.total, totalActual });
  }
}

// ─── Quién cobra ────────────────────────────────────────────────────────────
// Cualquier persona activa del negocio con PIN (el de mesero o su clave de
// autorización). Cinco fallos seguidos bloquean unos minutos, igual que la
// clave de autorización. No dice cuál de los dos datos falló.
const fallosCobro = new Map();

function cobroBloqueado(clave) {
  const ahora = Date.now();
  const lista = (fallosCobro.get(clave) || []).filter(t => ahora - t < VENTANA_PIN_MS);
  fallosCobro.set(clave, lista);
  return lista.length >= INTENTOS_PIN;
}

export async function verificarPersonaCobro(negocioId, usuarioId, pin, claveIntentos) {
  if (!usuarioId || !pin) throw errorCodigo('Elige quién cobra y escribe su PIN', 'COBRA_REQUERIDO');
  const clave = `${negocioId}:${claveIntentos || ''}`;
  if (cobroBloqueado(clave)) throw errorCodigo('Demasiados intentos. Espera unos minutos.', 'PIN_BLOQUEADO');
  const texto = String(pin);
  if (pinValido(texto) && typeof usuarioId === 'string') {
    const { rows: [u] } = await pool.query(
      `SELECT u.id, u.nombre, u.pin_hash, u.pin_autorizacion_hash
         FROM usuarios u JOIN usuario_negocios un ON un.usuario_id = u.id
        WHERE u.id::text = $1 AND un.negocio_id = $2 AND un.activo = TRUE AND u.activo = TRUE`,
      [usuarioId, negocioId]);
    if (u && (verifyPin(texto, u.pin_hash) || verifyPin(texto, u.pin_autorizacion_hash))) {
      fallosCobro.delete(clave);
      return { id: u.id, nombre: u.nombre };
    }
  }
  fallosCobro.get(clave).push(Date.now());
  throw errorCodigo('PIN incorrecto', 'COBRA_PIN_INCORRECTO');
}
