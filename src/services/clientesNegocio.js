// ─── Cliente canónico de la tienda en línea ───────────────────────────────
//
// UNA persona por (negocio, teléfono). Alrededor de ella: direcciones,
// consentimientos, Rewards y pedidos. Este archivo es el único que escribe
// en `clientes_negocio` y `cliente_direcciones`; la autenticación (OTP y
// sesiones) vive en clienteAuth.js y las rutas en tiendaCuentasRutas.js.
//
// LO QUE ESTE MÓDULO GARANTIZA:
//
//   · La identidad es el teléfono NORMALIZADO (los últimos 10 dígitos, la
//     misma regla que POS, tienda y repartidores: normalizarTelefonoMX).
//     "878 123 4567", "+52 878 123 4567" y "8781234567" son la misma persona.
//     La UNIQUE (negocio_id, telefono) de la base lo impone aunque el código
//     se equivoque.
//
//   · Aislamiento por negocio en cada consulta: toda lectura y escritura
//     lleva negocio_id, y las tablas hijas cuelgan con FK COMPUESTA
//     (negocio_id, cliente_id). Un cliente_id ajeno no encuentra nada.
//
//   · Rewards NO se reescribe. rewards_accounts sigue siendo el motor con su
//     identidad (telefono, tenant_id); aquí solo se le pone el puntero
//     cliente_id y se LEE. Ningún saldo se toca desde este archivo.
//
//   · Lo que se guarda aquí es la libreta del cliente. Lo que viaja en un
//     pedido es una COPIA (datos->'cliente'): editar el perfil o una
//     dirección hoy no cambia cómo se ve un pedido de hace seis meses.
import { pool, obtenerEstadoModulo } from './database.js';
import { normalizarTelefonoMX } from '../utils/telefono.js';
import { TiendaError } from './tiendaOnline.js';
import { obtenerConfig, obtenerMovimientosCliente, calcularNivel } from './rewardsService.js';

const CONTROLES = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
const ESPACIOS = new RegExp('\\s+', 'g');
export const limpiar = (v, max = 300) =>
  String(v == null ? '' : v).replace(CONTROLES, ' ').replace(ESPACIOS, ' ').trim().slice(0, max);

// ── Normalización de identidad ────────────────────────────────────────────
// Devuelve los 10 dígitos o null. Se rechaza lo que no pueda ser un
// teléfono mexicano real: menos de 10 dígitos, o más de 13 (52/521 + 10).
export function normalizarTelefonoCliente(valor) {
  const digitos = String(valor == null ? '' : valor).replace(/\D/g, '');
  if (digitos.length < 10 || digitos.length > 13) return null;
  return normalizarTelefonoMX(digitos);
}

export function normalizarEmail(valor) {
  const e = limpiar(valor, 160).toLowerCase();
  if (!e) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) {
    throw new TiendaError('Escribe un correo válido', 'EMAIL_INVALIDO');
  }
  return e;
}

function nombreValido(valor, { obligatorio = false } = {}) {
  const n = limpiar(valor, 80);
  if (!n) {
    if (obligatorio) throw new TiendaError('Escribe tu nombre', 'NOMBRE_REQUERIDO');
    return null;
  }
  if (n.length < 2) throw new TiendaError('Escribe tu nombre completo', 'NOMBRE_CORTO');
  return n;
}

// ── Alta / lectura del cliente ────────────────────────────────────────────
/**
 * Encuentra o crea al cliente de ESTE negocio para ese teléfono. Idempotente:
 * dos llamadas con el mismo teléfono (en cualquier formato) devuelven la
 * misma fila. El nombre y el correo solo se completan si venían vacíos o si
 * llegan nuevos -- nunca se borran por una llamada que no los trae.
 *
 * Devuelve la fila con `nuevo: true` cuando la acaba de crear.
 */
export async function obtenerOCrearCliente({ negocioId, telefono, nombre = null, email = null, origen = 'tienda', telefonoOriginal = null }, ejecutor = pool) {
  const tel = normalizarTelefonoCliente(telefono);
  if (!tel) throw new TiendaError('El teléfono debe tener 10 dígitos', 'TELEFONO_INVALIDO');
  const nom = nombreValido(nombre);
  const mail = email ? normalizarEmail(email) : null;
  const { rows: [fila] } = await ejecutor.query(
    `INSERT INTO clientes_negocio (negocio_id, telefono, telefono_original, nombre, email, origen)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (negocio_id, telefono) DO UPDATE SET
       nombre = COALESCE(EXCLUDED.nombre, clientes_negocio.nombre),
       email = COALESCE(EXCLUDED.email, clientes_negocio.email),
       updated_at = NOW()
     RETURNING *, (xmax = 0) AS nuevo`,
    [negocioId, tel, limpiar(telefonoOriginal || telefono, 30) || null, nom, mail, origen]);
  await vincularRewards(fila, ejecutor).catch(e => console.error('[Clientes] No se pudo vincular Rewards:', e.message));
  return fila;
}

export async function obtenerClientePorId(negocioId, clienteId) {
  if (!negocioId || !clienteId) return null;
  const { rows } = await pool.query(
    'SELECT * FROM clientes_negocio WHERE negocio_id = $1 AND id = $2', [negocioId, clienteId]);
  return rows[0] || null;
}

// Solo nombre y correo. El teléfono es la identidad verificada por OTP: se
// cambia iniciando sesión con el número nuevo, nunca editando un campo.
export async function actualizarPerfil(negocioId, clienteId, { nombre, email } = {}) {
  const set = [];
  const valores = [negocioId, clienteId];
  if (nombre !== undefined) { valores.push(nombreValido(nombre, { obligatorio: true })); set.push(`nombre = $${valores.length}`); }
  if (email !== undefined) { valores.push(email === null || email === '' ? null : normalizarEmail(email)); set.push(`email = $${valores.length}`); }
  if (!set.length) return obtenerClientePorId(negocioId, clienteId);
  const { rows } = await pool.query(
    `UPDATE clientes_negocio SET ${set.join(', ')}, updated_at = NOW()
      WHERE negocio_id = $1 AND id = $2 RETURNING *`, valores);
  if (!rows[0]) throw new TiendaError('Cuenta no encontrada', 'CLIENTE_NO_EXISTE', 404);
  return rows[0];
}

export async function marcarCompra(negocioId, clienteId, ejecutor = pool) {
  await ejecutor.query(
    'UPDATE clientes_negocio SET ultima_compra_at = NOW(), updated_at = NOW() WHERE negocio_id = $1 AND id = $2',
    [negocioId, clienteId]);
}

// Lo que se le muestra al propio cliente. Nunca ids internos de otras
// tablas ni el negocio_id.
export function clientePublico(c) {
  if (!c) return null;
  return {
    id: c.id, nombre: c.nombre || null, telefono: c.telefono, email: c.email || null,
    desde: c.created_at, ultimaCompra: c.ultima_compra_at || null,
  };
}

// ── Rewards: puntero y lectura (el motor no se toca) ──────────────────────
// Toda cuenta de Rewards de este negocio cuyo teléfono normalizado sea el del
// cliente pasa a apuntarle. Cubre la que creó el POS (10 dígitos) y la que
// creó WhatsApp (52/521…): dos cuentas, una persona. No mueve puntos.
export async function vincularRewards(cliente, ejecutor = pool) {
  const { rowCount } = await ejecutor.query(
    `UPDATE rewards_accounts
        SET cliente_id = $1
      WHERE cliente_id IS NULL
        AND tenant_id = $2
        AND telefono IS NOT NULL AND telefono NOT LIKE 'rappi-%'
        AND length(regexp_replace(telefono, '\\D', '', 'g')) BETWEEN 10 AND 13
        AND right(regexp_replace(telefono, '\\D', '', 'g'), 10) = $3`,
    [cliente.id, String(cliente.negocio_id), cliente.telefono]);
  return rowCount;
}

const REWARDS_DISPONIBLE = ['activo', 'configurado'];

/**
 * Lo que el cliente ve de su programa de lealtad. Lectura pura sobre el motor
 * existente: cuentas vinculadas (o con su mismo teléfono), saldo, nivel y
 * movimientos. `puntosCanjeables` es lo que la TIENDA puede gastar: el saldo
 * de la cuenta que usa el checkout (la del teléfono en 10 dígitos). Si la
 * persona tiene además una cuenta con otro formato, esos puntos se muestran
 * en el total y se explican, pero no se inventa una fusión de saldos aquí.
 */
export async function rewardsDelCliente(negocioId, cliente) {
  const apagado = { activo: false };
  try {
    const estado = await obtenerEstadoModulo(negocioId, 'rewards');
    if (!REWARDS_DISPONIBLE.includes(estado)) return apagado;
    const config = await obtenerConfig(negocioId);
    if (!config || !config.activo) return apagado;

    const { rows: cuentas } = await pool.query(
      `SELECT * FROM rewards_accounts
        WHERE tenant_id = $1 AND activo = TRUE AND (cliente_id = $2 OR telefono = $3)
        ORDER BY (telefono = $3) DESC, created_at`,
      [String(negocioId), cliente.id, cliente.telefono]);
    const principal = cuentas.find(c => c.telefono === cliente.telefono) || null;
    const suma = (campo) => cuentas.reduce((s, c) => s + (parseInt(c[campo], 10) || 0), 0);

    let movimientos = [];
    for (const c of cuentas) {
      const m = await obtenerMovimientosCliente(c.id, String(negocioId), 50);
      movimientos.push(...m);
    }
    movimientos.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    movimientos = movimientos.slice(0, 50).map(m => ({
      id: m.id, tipo: m.tipo, puntos: parseInt(m.puntos, 10) || 0,
      balancePosterior: parseInt(m.balance_posterior, 10) || 0,
      folio: m.folio_venta || null, motivo: m.motivo || null, fecha: m.created_at,
    }));

    const canjeMinimo = parseInt(config.canje_minimo, 10) || 100;
    const valorPunto = parseFloat(config.puntos_por_peso) || 0;
    const canjeables = principal ? (parseInt(principal.puntos_balance, 10) || 0) : 0;
    return {
      activo: true,
      nombrePrograma: config.nombre_programa || 'Rewards',
      puntos: suma('puntos_balance'),
      puntosCanjeables: canjeables,
      canjeMinimo,
      valorPunto,
      // Cuánto vale hoy lo que puede canjear, en bloques de canje_minimo.
      valorCanjeable: Math.round(Math.floor(canjeables / canjeMinimo) * canjeMinimo * valorPunto * 100) / 100,
      montoPorPunto: parseFloat(config.monto_por_punto) || 0,
      canjeEnTienda: config.canal_tienda === true,
      acumuladoTotal: suma('puntos_acumulados_total'),
      canjeadoTotal: suma('puntos_canjeados_total'),
      nivel: calcularNivel(suma('puntos_acumulados_total')),
      cuentas: cuentas.length,
      movimientos,
    };
  } catch (e) {
    console.error(`[Clientes] Rewards no disponible para el cliente: ${e.message}`);
    return apagado;
  }
}

// ── Direcciones ───────────────────────────────────────────────────────────
export const ALIAS_DIRECCION = ['Casa', 'Trabajo', 'Otro'];

function numeroOpcional(v, min, max, codigo) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new TiendaError('Coordenadas inválidas', codigo);
  return n;
}

function validarDireccion(datos = {}) {
  const alias = ALIAS_DIRECCION.includes(datos.alias) ? datos.alias : 'Otro';
  const calle = limpiar(datos.calle, 160);
  if (calle.length < 3) throw new TiendaError('Escribe la calle', 'CALLE_REQUERIDA');
  const lat = numeroOpcional(datos.latitud, -90, 90, 'COORDENADAS_INVALIDAS');
  const lng = numeroOpcional(datos.longitud, -180, 180, 'COORDENADAS_INVALIDAS');
  if ((lat === null) !== (lng === null)) throw new TiendaError('Coordenadas incompletas', 'COORDENADAS_INVALIDAS');
  return {
    alias, calle,
    numero_exterior: limpiar(datos.numeroExterior, 20) || null,
    numero_interior: limpiar(datos.numeroInterior, 20) || null,
    colonia: limpiar(datos.colonia, 120) || null,
    codigo_postal: limpiar(datos.codigoPostal, 10) || null,
    entre_calles: limpiar(datos.entreCalles, 160) || null,
    referencia: limpiar(datos.referencia, 200) || null,
    instrucciones_entrega: limpiar(datos.instruccionesEntrega, 240) || null,
    zona: limpiar(datos.zona, 80) || null,
    latitud: lat, longitud: lng,
  };
}

export function direccionPublica(d) {
  if (!d) return null;
  return {
    id: d.id, alias: d.alias, calle: d.calle,
    numeroExterior: d.numero_exterior, numeroInterior: d.numero_interior,
    colonia: d.colonia, codigoPostal: d.codigo_postal, entreCalles: d.entre_calles,
    referencia: d.referencia, instruccionesEntrega: d.instrucciones_entrega,
    zona: d.zona, latitud: d.latitud === null ? null : Number(d.latitud),
    longitud: d.longitud === null ? null : Number(d.longitud),
    predeterminada: d.predeterminada === true,
    // Una línea legible para listas y para el resumen del checkout.
    resumen: [d.calle, d.numero_exterior, d.numero_interior ? 'int. ' + d.numero_interior : null, d.colonia]
      .filter(Boolean).join(' '),
  };
}

// La forma que `direccionParaPedido` (tiendaCheckout) ya acepta: desde aquí
// la dirección guardada entra al pedido por el MISMO camino que una escrita
// a mano, y queda copiada en datos->'cliente' como snapshot.
export function direccionParaCheckout(d) {
  return {
    calle: d.calle, numeroExterior: d.numero_exterior, numeroInterior: d.numero_interior,
    colonia: d.colonia, entreCalles: d.entre_calles, referencia: d.referencia,
  };
}

export async function listarDirecciones(negocioId, clienteId) {
  const { rows } = await pool.query(
    `SELECT * FROM cliente_direcciones WHERE negocio_id = $1 AND cliente_id = $2
      ORDER BY predeterminada DESC, created_at`, [negocioId, clienteId]);
  return rows;
}

export async function obtenerDireccion(negocioId, clienteId, direccionId) {
  if (!direccionId || !/^[0-9a-f-]{36}$/i.test(String(direccionId))) return null;
  const { rows } = await pool.query(
    'SELECT * FROM cliente_direcciones WHERE negocio_id = $1 AND cliente_id = $2 AND id = $3',
    [negocioId, clienteId, direccionId]);
  return rows[0] || null;
}

const MAX_DIRECCIONES = 10;

/**
 * Crea (sin id) o edita (con id) una dirección del cliente. La propiedad se
 * exige en el WHERE: una dirección de otro cliente o de otro negocio es,
 * para esta función, inexistente. La primera dirección nace predeterminada;
 * marcar otra como predeterminada desmarca la anterior en la misma
 * transacción (el índice único parcial lo garantiza además desde la base).
 */
export async function guardarDireccion(negocioId, clienteId, datos = {}, direccionId = null) {
  const d = validarDireccion(datos);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serializa por cliente: dos altas simultáneas no pueden dejar dos
    // predeterminadas ni rebasar el tope.
    await client.query('SELECT 1 FROM clientes_negocio WHERE negocio_id = $1 AND id = $2 FOR UPDATE', [negocioId, clienteId]);
    const { rows: [{ n }] } = await client.query(
      'SELECT count(*)::int AS n FROM cliente_direcciones WHERE negocio_id = $1 AND cliente_id = $2', [negocioId, clienteId]);
    let fila;
    if (direccionId) {
      const { rows } = await client.query(
        `UPDATE cliente_direcciones SET alias=$4, calle=$5, numero_exterior=$6, numero_interior=$7, colonia=$8,
                codigo_postal=$9, entre_calles=$10, referencia=$11, instrucciones_entrega=$12, zona=$13,
                latitud=$14, longitud=$15, updated_at=NOW()
          WHERE negocio_id=$1 AND cliente_id=$2 AND id=$3 RETURNING *`,
        [negocioId, clienteId, direccionId, d.alias, d.calle, d.numero_exterior, d.numero_interior, d.colonia,
         d.codigo_postal, d.entre_calles, d.referencia, d.instrucciones_entrega, d.zona, d.latitud, d.longitud]);
      fila = rows[0];
      if (!fila) throw new TiendaError('Dirección no encontrada', 'DIRECCION_NO_EXISTE', 404);
    } else {
      if (n >= MAX_DIRECCIONES) throw new TiendaError(`Puedes guardar hasta ${MAX_DIRECCIONES} direcciones`, 'DIRECCIONES_TOPE');
      const { rows } = await client.query(
        `INSERT INTO cliente_direcciones (negocio_id, cliente_id, alias, calle, numero_exterior, numero_interior, colonia,
                codigo_postal, entre_calles, referencia, instrucciones_entrega, zona, latitud, longitud, predeterminada)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [negocioId, clienteId, d.alias, d.calle, d.numero_exterior, d.numero_interior, d.colonia,
         d.codigo_postal, d.entre_calles, d.referencia, d.instrucciones_entrega, d.zona, d.latitud, d.longitud, n === 0]);
      fila = rows[0];
    }
    if (datos.predeterminada === true && !fila.predeterminada) {
      await client.query('UPDATE cliente_direcciones SET predeterminada = FALSE WHERE negocio_id=$1 AND cliente_id=$2 AND predeterminada', [negocioId, clienteId]);
      const { rows } = await client.query(
        'UPDATE cliente_direcciones SET predeterminada = TRUE, updated_at = NOW() WHERE negocio_id=$1 AND cliente_id=$2 AND id=$3 RETURNING *',
        [negocioId, clienteId, fila.id]);
      fila = rows[0];
    }
    await client.query('COMMIT');
    return fila;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

export async function marcarPredeterminada(negocioId, clienteId, direccionId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM clientes_negocio WHERE negocio_id = $1 AND id = $2 FOR UPDATE', [negocioId, clienteId]);
    const { rows: existe } = await client.query(
      'SELECT id FROM cliente_direcciones WHERE negocio_id=$1 AND cliente_id=$2 AND id=$3', [negocioId, clienteId, direccionId]);
    if (!existe[0]) throw new TiendaError('Dirección no encontrada', 'DIRECCION_NO_EXISTE', 404);
    await client.query('UPDATE cliente_direcciones SET predeterminada = FALSE WHERE negocio_id=$1 AND cliente_id=$2 AND predeterminada', [negocioId, clienteId]);
    const { rows } = await client.query(
      'UPDATE cliente_direcciones SET predeterminada = TRUE, updated_at = NOW() WHERE negocio_id=$1 AND cliente_id=$2 AND id=$3 RETURNING *',
      [negocioId, clienteId, direccionId]);
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

// Borrado real: la libreta es del cliente y el pedido ya tiene su copia. Si
// se borra la predeterminada, la más antigua que quede hereda la marca para
// que el checkout siga teniendo una preselección.
export async function eliminarDireccion(negocioId, clienteId, direccionId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM clientes_negocio WHERE negocio_id = $1 AND id = $2 FOR UPDATE', [negocioId, clienteId]);
    const { rows } = await client.query(
      'DELETE FROM cliente_direcciones WHERE negocio_id=$1 AND cliente_id=$2 AND id=$3 RETURNING predeterminada',
      [negocioId, clienteId, direccionId]);
    if (!rows[0]) throw new TiendaError('Dirección no encontrada', 'DIRECCION_NO_EXISTE', 404);
    if (rows[0].predeterminada) {
      await client.query(
        `UPDATE cliente_direcciones SET predeterminada = TRUE
          WHERE id = (SELECT id FROM cliente_direcciones WHERE negocio_id=$1 AND cliente_id=$2 ORDER BY created_at LIMIT 1)`,
        [negocioId, clienteId]);
    }
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

// ── Consentimientos ───────────────────────────────────────────────────────
// Los datos para ENTREGAR un pedido (nombre, teléfono, dirección) no son
// consentimiento de marketing. Esto es lo otro, y es una bitácora: cada
// cambio deja fila con fecha y fuente; el checkout no escribe aquí nunca.
export const CANALES_CONSENTIMIENTO = ['whatsapp', 'email'];

export async function registrarConsentimiento(negocioId, clienteId, { canal, otorgado, fuente }, ejecutor = pool) {
  if (!CANALES_CONSENTIMIENTO.includes(canal)) throw new TiendaError('Canal inválido', 'CONSENTIMIENTO_CANAL');
  await ejecutor.query(
    `INSERT INTO cliente_consentimientos (negocio_id, cliente_id, canal, otorgado, fuente) VALUES ($1,$2,$3,$4,$5)`,
    [negocioId, clienteId, canal, otorgado === true, limpiar(fuente, 40) || 'desconocida']);
}

export async function consentimientosVigentes(negocioId, clienteId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (canal) canal, otorgado, fuente, created_at
       FROM cliente_consentimientos WHERE negocio_id = $1 AND cliente_id = $2
      ORDER BY canal, created_at DESC`, [negocioId, clienteId]);
  const salida = {};
  for (const c of CANALES_CONSENTIMIENTO) {
    const f = rows.find(r => r.canal === c);
    salida[c] = f ? { otorgado: f.otorgado === true, fecha: f.created_at, fuente: f.fuente } : { otorgado: false, fecha: null, fuente: null };
  }
  return salida;
}

// ── Pedidos del cliente ───────────────────────────────────────────────────
// Por cliente_id (pedidos con sesión) y, además, los de la tienda hechos con
// su mismo teléfono antes de tener cuenta: el teléfono lo acaba de verificar
// con un código, así que esos pedidos son suyos. Solo lo que él necesita ver.
export async function pedidosDelCliente(negocioId, cliente, limite = 20) {
  const { rows } = await pool.query(
    `SELECT pa.folio, pa.estado, pa.created_at, pa.datos, tp.tracking_token
       FROM pedidos_activos pa
       LEFT JOIN tienda_pedidos tp ON tp.negocio_id = pa.negocio_id AND tp.pedido_folio = pa.folio
      WHERE pa.negocio_id = $1
        AND (pa.cliente_id = $2
             OR (pa.datos->>'canal' = 'tienda_online' AND pa.datos->'cliente'->>'telefono' = $3))
      ORDER BY pa.created_at DESC
      LIMIT $4`, [negocioId, cliente.id, cliente.telefono, limite]);
  return rows.map(r => ({
    folio: r.folio,
    estado: r.estado,
    fecha: r.created_at,
    total: Number(r.datos?.total) || 0,
    modalidad: String(r.datos?.modalidad || '').includes('domicilio') ? 'domicilio' : 'recoger',
    items: (r.datos?.items || []).map(i => ({ nombre: i.nombre, cantidad: i.cantidad })),
    seguimiento: r.tracking_token ? `/seguimiento/${r.tracking_token}` : null,
  }));
}
